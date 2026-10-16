const fs = require('fs');
const path = require('path');
const db = require('../database/db');

// ====================== LEAD TRACKER (In-Memory + SQLite Sync) ======================
// Code-level-la ovvoru customer-oda interest-a track pannum (AI tag-a mattum nambaadhu).
// Stage: browsing -> interested -> handed_over

const DB_DIR = path.join(__dirname, '..', 'database');
const STATE_FILE = path.join(DB_DIR, 'lead_state.json');
const LEGACY_FILE = path.join(DB_DIR, 'leads_sent.json'); // pazhaya file (auto-import aagum)

const RESEND_AFTER_MS = 12 * 60 * 60 * 1000;       // same customer-ku 12h-ku munnaadi thirumba lead anuppaadhu
const INCOMPLETE_AFTER_MS = 40 * 60 * 1000;        // interest kaatti 40 min silent -> incomplete lead alert
const INCOMPLETE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h-ku mela pazhaya chat-ku alert vendaam
const FORCE_HANDOVER_AT = 4;                       // interest vandhu 4 customer messages-kulla hand-over

// Automated Follow-up Timers
const FOLLOWUP_1_MS = 2 * 60 * 60 * 1000;          // 2 hours silent -> 1st follow-up (Test panna 2 * 60 * 1000 vechukonga)
const FOLLOWUP_2_MS = 20 * 60 * 60 * 1000;         // 1st follow-up aprom 20 hours silent -> 2nd follow-up
const FOLLOWUP_MAX_AGE_MS = 48 * 60 * 60 * 1000;   // 48h-ku mela pazhaya chat-ku follow-up vendaam

// Order mukkiyam: mudhalla match aagura category edukkum
const CATEGORY_RULES = [
  // "AI evlo", "AI reel", "reel AI", "AI video" ellam AI_REEL ('AI poster' mattum POSTER-ku pogum)
  ['AI_REEL', /\bai\b(?![\s\S]{0,15}\b(posters?|posts?|logos?|designs?|flyers?|banners?)\b)|ஏ\.?\s?ஐ/i],
  ['PACKAGE', /\b(packages?|plans?|monthly|weekly|mini|starter|growth|pro)\b|பேக்கேஜ்|பிளான்/i],
  ['PAGE_SETUP', /page\s*set\s*up|set\s*up[\s\S]{0,12}page|(create|open|make)[\s\S]{0,12}page/i],
  ['ADS', /\b(ads?|meta|boost(ing)?|campaigns?|promotions?)\b|விளம்பரம்|ஆட்ஸ்|மெட்டா/i],
  ['REEL', /\b(reels?|videos?)\b|ரீல்|வீடியோ/i],
  ['POSTER', /\b(posters?|flyers?|banners?|posts?|designs?|logos?)\b|போஸ்டர்|டிசைன்|போஸ்ட்/i],
];

function detectCategory(text = '') {
  const t = String(text);
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(t)) return cat;
  }
  return null;
}

function blank() {
  return {
    stage: 'browsing',
    category: null,
    interestTurns: 0,
    firstInterestAt: null,
    lastMsgAt: 0,
    handedAt: 0,
    incompleteSent: false,
    followupCount: 0,
    lastFollowupAt: 0,
    phone: null,
    pushName: null,
    details: {},
  };
}

function saveOneToSQLite(jid, s) {
  if (!s) return;
  const query = `
    INSERT INTO lead_state (
      jid, stage, category, interestTurns, firstInterestAt, lastMsgAt,
      handedAt, incompleteSent, followupCount, lastFollowupAt, phone, pushName, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      stage=excluded.stage,
      category=excluded.category,
      interestTurns=excluded.interestTurns,
      firstInterestAt=excluded.firstInterestAt,
      lastMsgAt=excluded.lastMsgAt,
      handedAt=excluded.handedAt,
      incompleteSent=excluded.incompleteSent,
      followupCount=excluded.followupCount,
      lastFollowupAt=excluded.lastFollowupAt,
      phone=excluded.phone,
      pushName=excluded.pushName,
      details=excluded.details
  `;
  db.run(
    query,
    [
      jid,
      s.stage || 'browsing',
      s.category || null,
      s.interestTurns || 0,
      s.firstInterestAt || null,
      s.lastMsgAt || 0,
      s.handedAt || 0,
      s.incompleteSent ? 1 : 0,
      s.followupCount || 0,
      s.lastFollowupAt || 0,
      s.phone || null,
      s.pushName || null,
      JSON.stringify(s.details || {}),
    ],
    (err) => {
      if (err) console.error('SQLite lead_state upsert error:', err.message);
    }
  );
}

function load() {
  let data = {};
  try {
    if (fs.existsSync(STATE_FILE)) data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    console.error('Lead state load error (starting fresh):', err.message);
  }

  // Pazhaya leads_sent.json irundha import pannu (already hand-over aana customers)
  try {
    if (fs.existsSync(LEGACY_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      for (const [jid, v] of Object.entries(legacy)) {
        if (data[jid]) continue;
        const at = typeof v === 'number' ? v : v && v.at;
        if (!at) continue;
        const details = v && typeof v === 'object' ? { ...v } : {};
        delete details.at;
        data[jid] = { ...blank(), stage: 'handed_over', handedAt: at, lastMsgAt: at, details };
      }
    }
  } catch (err) {
    console.error('Legacy leads import error:', err.message);
  }

  // SQLite-la irukkura rows load pannu + JSON data irundha SQLite-ku sync pannu
  db.all(`SELECT * FROM lead_state`, [], (err, rows) => {
    if (err) {
      console.error('SQLite lead_state load error:', err.message);
      return;
    }
    const dbJids = new Set();
    if (rows && rows.length > 0) {
      for (const r of rows) {
        dbJids.add(r.jid);
        let parsedDetails = {};
        try {
          parsedDetails = JSON.parse(r.details || '{}');
        } catch (_) {}
        data[r.jid] = {
          stage: r.stage || 'browsing',
          category: r.category || null,
          interestTurns: Number(r.interestTurns) || 0,
          firstInterestAt: r.firstInterestAt ? Number(r.firstInterestAt) : null,
          lastMsgAt: Number(r.lastMsgAt) || 0,
          handedAt: Number(r.handedAt) || 0,
          incompleteSent: Boolean(r.incompleteSent),
          followupCount: Number(r.followupCount) || 0,
          lastFollowupAt: Number(r.lastFollowupAt) || 0,
          phone: r.phone || null,
          pushName: r.pushName || null,
          details: parsedDetails,
        };
      }
      console.log(`✅ Loaded ${rows.length} leads from SQLite.`);
    }
    // JSON-la mattum irundha pazhaya leads-ah SQLite-ku migrate pannu
    for (const [jid, s] of Object.entries(data)) {
      if (!dbJids.has(jid)) saveOneToSQLite(jid, s);
    }
  });

  return data;
}

const state = load();

let saveTimer = null;
function save(targetJid = null) {
  if (targetJid && state[targetJid]) {
    saveOneToSQLite(targetJid, state[targetJid]);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DB_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('Lead state save error:', err.message);
    }
  }, 500);
}

function get(from) {
  return state[from] || null;
}

function ensure(from) {
  if (!state[from]) state[from] = blank();
  return state[from];
}

// Ovvoru customer message-um (debounce aana aprom) idha call pannanum
function onCustomerMessage(from, text, meta = {}) {
  const s = ensure(from);
  const now = Date.now();

  s.lastMsgAt = now;
  s.followupCount = 0; // Customer reply pannitaanga, so follow-up count reset
  if (meta.phone) s.phone = meta.phone;
  if (meta.pushName) s.pushName = meta.pushName;

  const cat = detectCategory(text);

  // Hand-over aagi 12h kazhichu thirumba vandhu service kekkaraanga -> pudhu lead round
  if (s.stage === 'handed_over' && cat && now - s.handedAt >= RESEND_AFTER_MS) {
    s.stage = 'interested';
    s.interestTurns = 0;
    s.firstInterestAt = now;
    s.incompleteSent = false;
  }

  if (cat) {
    s.category = cat;
    if (s.stage === 'browsing') {
      s.stage = 'interested';
      s.interestTurns = 0;
      s.firstInterestAt = now;
      s.incompleteSent = false;
    }
  }

  if (s.stage === 'interested') s.interestTurns += 1;

  save(from);
  return { state: s, forceHandover: s.stage === 'interested' && s.interestTurns >= FORCE_HANDOVER_AT };
}

function isRecentlyHandedOver(from) {
  const s = state[from];
  return Boolean(s && s.stage === 'handed_over' && Date.now() - s.handedAt < RESEND_AFTER_MS);
}

function snapshot(from) {
  return state[from] ? JSON.parse(JSON.stringify(state[from])) : null;
}

function restore(from, snap) {
  if (snap) {
    state[from] = snap;
    save(from);
  } else {
    delete state[from];
    db.run(`DELETE FROM lead_state WHERE jid = ?`, [from], () => {});
    save();
  }
}

function markHandedOver(from) {
  const s = ensure(from);
  s.stage = 'handed_over';
  s.handedAt = Date.now();
  save(from);
  return s;
}

function setDetails(from, details = {}) {
  const s = ensure(from);
  s.details = { ...(s.details || {}), ...details };
  save(from);
  return s;
}

function markIncompleteSent(from, value = true) {
  const s = ensure(from);
  s.incompleteSent = value;
  save(from);
}

function markFollowupSent(from) {
  const s = ensure(from);
  s.followupCount = (s.followupCount || 0) + 1;
  s.lastFollowupAt = Date.now();
  save(from);
}

// Interest kaatti, hand-over aagaama, 40 min+ silent-a irukkura customers
function getStaleLeads() {
  const now = Date.now();
  return Object.entries(state)
    .filter(([, s]) => {
      if (s.stage !== 'interested' || s.incompleteSent || !s.lastMsgAt) return false;
      const idle = now - s.lastMsgAt;
      return idle >= INCOMPLETE_AFTER_MS && idle <= INCOMPLETE_MAX_AGE_MS;
    })
    .map(([jid]) => jid);
}

// Customer-ku Automated Follow-up anuppa vendiya candidates list
function getFollowupCandidates() {
  const now = Date.now();
  return Object.entries(state)
    .filter(([, s]) => {
      if (s.stage !== 'interested' || !s.lastMsgAt) return false;
      if (now - s.lastMsgAt > FOLLOWUP_MAX_AGE_MS) return false;

      const count = s.followupCount || 0;
      if (count === 0) {
        return now - s.lastMsgAt >= FOLLOWUP_1_MS;
      }
      if (count === 1) {
        const refTime = s.lastFollowupAt || s.lastMsgAt;
        return now - refTime >= FOLLOWUP_2_MS;
      }
      return false;
    })
    .map(([jid, s]) => ({ jid, stage: (s.followupCount || 0) + 1, state: s }));
}

// Owner command-ku: phone number-a vechchu customer jid-a kandupidi
function findJidByPhone(phone) {
  const n = String(phone || '').replace(/\D/g, '');
  if (!n) return null;
  for (const [jid, s] of Object.entries(state)) {
    if (s.phone === n || jid.split('@')[0] === n) return jid;
  }
  return null;
}

module.exports = {
  findJidByPhone,
  detectCategory,
  onCustomerMessage,
  get,
  ensure,
  snapshot,
  restore,
  markHandedOver,
  setDetails,
  markIncompleteSent,
  markFollowupSent,
  isRecentlyHandedOver,
  getStaleLeads,
  getFollowupCandidates,
  RESEND_AFTER_MS,
  FORCE_HANDOVER_AT,
};