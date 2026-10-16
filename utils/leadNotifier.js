const tracker = require('./leadTracker');
const handover = require('./humanHandover');
const { toWhatsApp } = require('./formatReply');
const { checkReply } = require('./priceGuard');

// AI reply-la indha tag irundha = customer genuinely interested
const LEAD_TAG = '[LEAD_READY]';

// Leads anuppura number: 0786070020 → Sri Lanka format 94786070020
// .env-la OWNER_NUMBER=94786070020 nu vechchaa adhai edukkum
function normalizeNumber(raw) {
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('0')) n = '94' + n.slice(1);
  return n;
}
const OWNER_NUMBER = normalizeNumber(process.env.OWNER_NUMBER || '0786070020');
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;

const WATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 min-ku oru thadava incomplete leads & follow-ups check

const CATEGORY_LABELS = {
  AI_REEL: '🎬 AI Reel',
  REEL: '🎥 Reel / Video',
  POSTER: '🖼️ Poster / Post design',
  ADS: '📢 Meta Ads',
  PACKAGE: '📦 Package',
  PAGE_SETUP: '🛠️ Page setup',
  OTHER: '💬 Other',
};

const EXTRACT_PROMPT = `
You extract sales lead details from a WhatsApp conversation between a Customer and a Bot of Flux Media (a digital marketing agency in Sri Lanka).

Return ONLY one JSON object and nothing else, with exactly these keys:
name, business_name, business_type, page_link, category, interested_in, goal, ad_budget, preferred_time, level, summary

Rules:
- Use ONLY information the Customer actually said. Never guess.
- If something was not given, use "Not given".
- category = the MAIN service the customer wants. Must be exactly one of: AI_REEL, REEL, POSTER, ADS, PACKAGE, PAGE_SETUP, OTHER.
- interested_in = the exact package or service the customer wants (example: "STARTER package", "AI reel", "single poster", "Meta Ads"). If they want several things, list them here.
- preferred_time = the free time / best time the Customer said the team can call or message them (example: "after 6pm", "tomorrow morning", "anytime"). Copy it as the Customer said it.
- level = "HOT" if the customer wants to start, proceed, pay, or asked for the team to contact them. Otherwise "WARM".
- summary = one short simple English sentence about what the customer wants.
`;

function isOwner(jid = '') {
  return jid.split('@')[0] === OWNER_NUMBER;
}

// Customer-oda real phone number (WhatsApp sila time hidden "LID" kudukkum)
function getPhone(msg, from) {
  const jid = (msg && msg.key && msg.key.remoteJidAlt) || from;
  return jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
}

const given = (x) => x && String(x).trim() && !/^not given$/i.test(String(x).trim());

function pickDetails(lead) {
  const out = {};
  if (!lead) return out;
  for (const k of ['name', 'business_name', 'business_type', 'interested_in', 'preferred_time']) {
    if (given(lead[k])) out[k] = String(lead[k]).trim();
  }
  const cat = String(lead.category || '').toUpperCase();
  if (CATEGORY_LABELS[cat]) out.category = cat;
  return out;
}

async function extractLead(groq, history) {
  if (!history || history.length === 0) return null;

  const convo = history
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
    .join('\n');

  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    temperature: 0,
    max_tokens: 1000,
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: convo },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}

// kind: 'new' | 'update' | 'incomplete'
function buildMessage({ lead, history, st, phone, pushName, kind }) {
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' });
  const v = (x) => (x && String(x).trim() ? String(x).trim() : 'Not given');

  const leadCat = lead && String(lead.category || '').toUpperCase();
  const catKey = CATEGORY_LABELS[leadCat] ? leadCat : (st && st.category) || 'OTHER';
  const catLabel = CATEGORY_LABELS[catKey] || CATEGORY_LABELS.OTHER;

  const title =
    kind === 'incomplete' ? 'Incomplete Lead (customer stopped replying)'
    : kind === 'update' ? 'Lead Update'
    : 'New Lead';
  const emoji = kind === 'incomplete' ? '⚠️' : lead && lead.level === 'HOT' ? '🔥' : '⭐';
  const level = lead && lead.level ? ` (${v(lead.level)})` : '';

  const lines = [`${emoji} *${title}${level} - Flux Media Bot*`, '', `🏷️ Service: ${catLabel}`];

  if (lead) {
    lines.push(
      `👤 Name: ${v(lead.name)}`,
      `🏪 Business: ${v(lead.business_name)}`,
      `📌 Type: ${v(lead.business_type)}`,
      `📦 Interested in: ${v(lead.interested_in)}`,
      `⏰ Free time to contact: ${v(lead.preferred_time)}`,
      `🔗 Page: ${v(lead.page_link)}`,
      `🎯 Goal: ${v(lead.goal)}`,
      `💰 Ad budget: ${v(lead.ad_budget)}`,
      `📝 Summary: ${v(lead.summary)}`
    );
  } else {
    // Extraction fail aanaa, last customer messages-a anuppu
    const lastMsgs = (history || [])
      .filter((m) => m.role === 'user')
      .slice(-4)
      .map((m) => `- ${m.content}`)
      .join('\n');
    lines.push('(Auto-summary fail aachu. Customer last messages:)', lastMsgs || '- (no messages)');
  }

  if (kind === 'incomplete') {
    lines.push('', 'ℹ️ Customer details complete aagala. WhatsApp-la follow up pannunga.');
  }

  lines.push('');
  if (pushName) lines.push(`💬 WhatsApp name: ${pushName}`);
  if (phone) {
    lines.push(`📱 Number: +${phone}`, `👉 wa.me/${phone}`);
  } else {
    lines.push('📱 Number: WhatsApp hidden (open the chat in the bot account)');
  }
  lines.push(`🕒 ${when}`);
  lines.push('', '💡 Nee customer-kitta direct-a reply pannaa bot auto-pause aagum.');

  return lines.join('\n');
}

async function sendToOwner(sock, text) {
  // Lazy require: circular dependency problem varaama irukka
  const { enqueue, waitForGap, markSent } = require('./helpers');
  await enqueue(async () => {
    await waitForGap();
    await sock.sendMessage(OWNER_JID, { text });
    markSent();
  });
}

// ===== Complete lead: customer details kudutthaanga / hand-over aachu =====
async function notifyLead({ sock, groq, msg, from, history }) {
  if (tracker.isRecentlyHandedOver(from)) {
    console.log('ℹ️ Lead already sent recently, skipping:', from);
    return;
  }

  const before = tracker.snapshot(from);
  const wasHandedBefore = Boolean(before && before.handedAt);

  // Extraction-ku MUNNAADIYE mark pannu (customer udane reply panninaalum bot-ku theriyum)
  tracker.markHandedOver(from);

  let lead = null;
  try {
    lead = await extractLead(groq, history);
  } catch (err) {
    console.error('Lead extract error:', err.message);
  }

  tracker.setDetails(from, pickDetails(lead));
  const st = tracker.get(from);

  const text = buildMessage({
    lead,
    history,
    st,
    phone: st.phone || getPhone(msg, from),
    pushName: (msg && msg.pushName) || st.pushName,
    kind: wasHandedBefore ? 'update' : 'new',
  });

  try {
    await sendToOwner(sock, text);
    console.log('✅ Lead sent to owner:', from);
  } catch (err) {
    tracker.restore(from, before); // fail aanaa revert, thirumba try pannalaam
    throw err;
  }
}

// ===== Incomplete lead: interest kaattitu silent aanavanga =====
async function notifyIncomplete({ sock, groq, from, history }) {
  const st0 = tracker.get(from);
  if (!st0 || st0.stage !== 'interested' || st0.incompleteSent) return;

  tracker.markIncompleteSent(from, true);

  let lead = null;
  try {
    lead = await extractLead(groq, history);
  } catch (err) {
    console.error('Incomplete lead extract error:', err.message);
  }

  tracker.setDetails(from, pickDetails(lead));
  const st = tracker.get(from);

  const text = buildMessage({
    lead,
    history,
    st,
    phone: st.phone,
    pushName: st.pushName,
    kind: 'incomplete',
  });

  try {
    await sendToOwner(sock, text);
    console.log('⚠️ Incomplete lead sent to owner:', from);
  } catch (err) {
    tracker.markIncompleteSent(from, false);
    throw err;
  }
}

// ===== Customer complaint / "human venum" nu sonnaa owner-ku urgent alert =====
async function notifyHumanNeeded({ sock, from, text, reason, pushName }) {
  const st = tracker.get(from);
  const phone = (st && st.phone) || (from.endsWith('@s.whatsapp.net') ? from.split('@')[0] : null);
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' });
  const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);

  const lines = [
    '🚨 *Customer needs a human - Flux Media Bot*',
    '',
    `❗ Reason: ${reason === 'complaint' ? 'Complaint / serious issue' : 'Asked to talk to a person'}`,
    `💬 Customer said: "${snippet}"`,
    '',
  ];
  if (pushName || (st && st.pushName)) lines.push(`👤 WhatsApp name: ${pushName || st.pushName}`);
  if (phone) lines.push(`📱 Number: +${phone}`, `👉 wa.me/${phone}`);
  else lines.push('📱 Number: WhatsApp hidden (open the chat in the bot account)');
  lines.push(`🕒 ${when}`, '', '⏸️ Indha chat-ku bot pause aagiduchu. Nee reply pannu.');
  if (phone) lines.push(`Bot thirumba on panna: /resume ${phone}`);

  await sendToOwner(sock, lines.join('\n'));
  console.log('🚨 Human-needed alert sent to owner:', from);
}

// ===== Automated Customer Follow-up Engine =====
function isColomboDaytime() {
  const hourStr = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    hour12: false,
  });
  const hour = Number(hourStr);
  return hour >= 9 && hour < 21; // 9 AM to 9 PM Colombo time mattum
}

async function sendCustomerFollowup({ sock, groq, jid, stage, st, history, pushHistoryOne }) {
  if (handover.isPaused(jid) || isOwner(jid) || tracker.isRecentlyHandedOver(jid)) return;

  const { sleep, rand, enqueue, waitForGap, markSent, dailyStatus, countReply } = require('./helpers');
  if (dailyStatus(jid) !== 'ok') return;

  const convo = (history || [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
    .join('\n');

  const catLabel = CATEGORY_LABELS[st.category] || 'digital marketing service';
  const stageGoal =
    stage === 1
      ? `Customer asked about ${catLabel} earlier and stopped replying. Send a very short, warm, casual 1-sentence check-in asking for their business type and free time so the team can help.`
      : `This is our final polite follow-up regarding ${catLabel}. In 1 short sentence, let them know there is no rush and they can message anytime when they are ready to start.`;

  const prompt = `
You are the WhatsApp AI Assistant of Flux Media (Sri Lanka).
Read the recent conversation and write a natural follow-up message.

Rules:
- Match the customer's language from the history (Tanglish in English letters, simple English, or Tamil script). Default to casual Tanglish in English letters.
- Maximum 1 or 2 short sentences.
- Do NOT mention any prices or numbers in the follow-up.
- Do NOT repeat "Welcome to Flux Media".
- Goal: ${stageGoal}
`;

  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    temperature: 0.5,
    max_tokens: 120,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: convo || `Customer was interested in ${catLabel}` },
    ],
  });

  let reply = toWhatsApp(completion.choices[0]?.message?.content || '');
  if (!reply) return;

  if (!checkReply(reply, '', st.category, false).ok) return;

  tracker.markFollowupSent(jid);

  await enqueue(async () => {
    const latestState = tracker.get(jid);
    if (handover.isPaused(jid) || !latestState || latestState.followupCount === 0) return;

    await sock.sendPresenceUpdate('composing', jid);
    await sleep(rand(2500, 4500));
    await waitForGap();

    await sock.sendMessage(jid, { text: reply });
    await sock.sendPresenceUpdate('paused', jid);
    markSent();
    countReply(jid);

    if (pushHistoryOne) pushHistoryOne(jid, 'assistant', reply);
    console.log(`⏰ [Follow-up #${stage}] Sent to customer:`, jid);
  });
}

// ===== Background watcher (oru thadava mattum start aagum) =====
let watcherStarted = false;
function startIncompleteWatcher({ getSock, groq, getHistory, pushHistoryOne }) {
  if (watcherStarted) return;
  watcherStarted = true;

  setInterval(async () => {
    const sock = getSock();
    if (!sock) return;

    // 1. Owner-ku Incomplete Lead Alert (40 mins silent)
    for (const jid of tracker.getStaleLeads()) {
      try {
        if (handover.isPaused(jid)) continue;
        await notifyIncomplete({ sock, groq, from: jid, history: await getHistory(jid) });
      } catch (err) {
        console.error('Incomplete lead notify error:', err.message);
      }
    }

    // 2. Customer-ku Automated Follow-up (Colombo daytime 9 AM - 9 PM mattum)
    if (isColomboDaytime()) {
      for (const { jid, stage, state: st } of tracker.getFollowupCandidates()) {
        try {
          await sendCustomerFollowup({
            sock,
            groq,
            jid,
            stage,
            st,
            history: await getHistory(jid),
            pushHistoryOne,
          });
        } catch (err) {
          console.error(`Follow-up #${stage} error (${jid}):`, err.message);
        }
      }
    }
  }, WATCH_INTERVAL_MS);

  console.log('👀 Incomplete lead watcher & Follow-up engine started');
}

module.exports = {
  LEAD_TAG,
  notifyLead,
  notifyIncomplete,
  notifyHumanNeeded,
  startIncompleteWatcher,
  isOwner,
  getPhone,
};