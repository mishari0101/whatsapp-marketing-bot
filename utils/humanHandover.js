const fs = require('fs');
const path = require('path');

// ====================== HUMAN HANDOVER ======================
// Oru chat "paused" na bot AI reply anuppaadhu (nee / team handle pannuvanga).
// Auto-resume: HUMAN_PAUSE_HOURS (.env) kazhichu, default 6 hours.

const DB_DIR = path.join(__dirname, '..', 'database');
const FILE = path.join(DB_DIR, 'human_takeover.json');

const PAUSE_HOURS = Number(process.env.HUMAN_PAUSE_HOURS) || 6;
const DEFAULT_MS = PAUSE_HOURS * 60 * 60 * 1000;

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('Handover load error (starting fresh):', err.message);
  }
  return {};
}

const state = load(); // { jid: { until, reason, at } }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DB_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.error('Handover save error:', err.message);
    }
  }, 500);
}

// Pause pannu (already paused-na timer extend aagum)
function pause(jid, { reason = 'manual', ms } = {}) {
  state[jid] = { until: Date.now() + (ms > 0 ? ms : DEFAULT_MS), reason, at: Date.now() };
  save();
}

function resume(jid) {
  const had = Boolean(state[jid]);
  delete state[jid];
  save();
  return had;
}

function resumeAll() {
  const n = Object.keys(state).length;
  for (const k of Object.keys(state)) delete state[k];
  save();
  return n;
}

function isPaused(jid) {
  const e = state[jid];
  if (!e) return false;
  if (e.until <= Date.now()) {
    delete state[jid];
    save();
    return false;
  }
  return true;
}

function list() {
  const now = Date.now();
  return Object.entries(state)
    .filter(([, e]) => e.until > now)
    .map(([jid, e]) => ({ jid, until: e.until, reason: e.reason }));
}

// ===== Customer-ae "human venum" / complaint nu sonnaa =====
const COMPLAINT = /\b(complaint|complain|scam|scammer|fraud|cheat(?:ed|ing)?|refund|lawyer|legal\s+action|police|consumer\s+affairs)\b/i;
const HUMAN_REQUEST = new RegExp(
  [
    '\\b(talk|speak|chat)\\s+(to|with)\\s+(a\\s+|the\\s+|your\\s+)?(human|person|someone|real\\s+person|owner|manager|staff)\\b',
    '\\b(real|actual)\\s+(person|human)\\b',
    '\\bhuman\\b.{0,10}\\b(venum|vendum|please|plz)\\b',
    '\\b(bot|robot)\\b.{0,15}\\b(vendaam|venaam|venam)\\b',
    '(owner|manager)\\s*(kooda|kitta|kitte)\\s*pes',
  ].join('|'),
  'i'
);

// 'complaint' | 'human-request' | null
function needsHuman(text = '') {
  const t = String(text);
  if (COMPLAINT.test(t)) return 'complaint';
  if (HUMAN_REQUEST.test(t)) return 'human-request';
  return null;
}

module.exports = { pause, resume, resumeAll, isPaused, list, needsHuman, PAUSE_HOURS };