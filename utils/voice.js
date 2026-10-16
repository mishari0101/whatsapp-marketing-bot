const fs = require('fs');
const os = require('os');
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// ====================== VOICE NOTE → TEXT (Groq Whisper) ======================
// Pass 1: language auto-detect.
// Pass 2: Whisper Tanglish-a thappa language-nu detect pannaa (malay, indonesian...) -> Tamil force + hint prompt.
// Pass 3: LLM cleanup (context vechchu obvious errors fix pannum, UNCLEAR na customer-ku type panna sollum).

const MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3'; // Tamil / Sinhala-ku large-v3 nalladhu
const CLEANUP_MODEL = process.env.VOICE_CLEANUP_MODEL || 'openai/gpt-oss-20b';
const CLEANUP_ENABLED = process.env.VOICE_CLEANUP !== 'off';
const MAX_SECONDS = 180;       // idha vida neelam-na type panna sollu
const MAX_PER_HOUR = 10;       // oru customer-ku oru manikku max voice notes (abuse / cost)
const logger = pino({ level: 'silent' });

// Idhu Whisper-ku "Tamil + English business words kalandha" style-a kaattum
const TAMIL_HINT =
  'எனக்கு pricing details அனுப்புங்க. AI reel, poster, reels, Meta ads, package price என்ன? Boutique-க்கு post design வேணும். Free time இருக்கு, call பண்ணுங்க.';

const CLEANUP_PROMPT = `You fix speech-to-text errors.
Context: a WhatsApp voice note from a customer of Flux Media, a social media marketing agency in Sri Lanka (services: social media posts, reels, AI reels, single posters, Meta ads, page setup, monthly and weekly packages, pricing, and a team call at the customer's free time). The customer speaks Tamil, English, Sinhala or a Tanglish mix. The transcript was made automatically and may be garbled.
Task: rewrite what the customer most likely said as short, simple Tanglish using ENGLISH LETTERS (or plain English if they spoke English).
Rules:
- Fix obvious recognition errors using the context above.
- NEVER add information the customer did not say. Keep numbers, names and prices exactly as in the transcript.
- Output ONLY the rewritten sentence(s), nothing else.
- If you cannot tell what the customer said, output exactly: UNCLEAR`;

const usage = new Map(); // jid -> [timestamps]

function getAudio(msg) {
  return msg && msg.message && msg.message.audioMessage ? msg.message.audioMessage : null;
}

function overLimit(jid) {
  const now = Date.now();
  const arr = (usage.get(jid) || []).filter((t) => now - t < 60 * 60 * 1000);
  usage.set(jid, arr);
  return arr.length >= MAX_PER_HOUR;
}

function record(jid) {
  const arr = usage.get(jid) || [];
  arr.push(Date.now());
  usage.set(jid, arr);
}

// Silent audio-ku Whisper sila time idhu maadhiri hallucinate pannum
const JUNK = /^(thank you|thanks|thanks for watching|thank you for watching|bye|you)[.!\s]*$/i;

// Oru Whisper call (ovvoru call-kum pudhu stream)
async function whisper(groq, file, extra = {}) {
  const stream = fs.createReadStream(file);
  stream.on('error', () => {}); // stream error bot-a crash pannaadhu
  try {
    return await groq.audio.transcriptions.create({
      file: stream,
      model: MODEL,
      response_format: 'verbose_json',
      temperature: 0,
      ...extra,
    });
  } finally {
    stream.destroy();
  }
}

function noSpeechScore(res) {
  const segs = Array.isArray(res.segments) ? res.segments : [];
  return segs.length ? segs.reduce((a, s) => a + (s.no_speech_prob || 0), 0) / segs.length : 0;
}

function usable(res) {
  const text = String((res && res.text) || '').trim();
  return text.length >= 2 && !JUNK.test(text) && noSpeechScore(res) <= 0.6;
}

// LLM cleanup: null = fail / use raw text, 'UNCLEAR' = puriyala
async function cleanTranscript(groq, raw) {
  try {
    const completion = await groq.chat.completions.create({
      model: CLEANUP_MODEL,
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: CLEANUP_PROMPT },
        { role: 'user', content: raw },
      ],
    });
    let out = String(completion.choices[0]?.message?.content || '').trim();
    out = out.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!out) return null;
    if (/^UNCLEAR\b/i.test(out)) return 'UNCLEAR';
    if (out.length > raw.length * 3 + 100) return null; // hallucinate panni neelama ezhudhina ignore
    return out;
  } catch (err) {
    console.error('Voice cleanup error:', err.message);
    return null;
  }
}

// status: 'ok' | 'too_long' | 'limit' | 'empty' | 'error'
async function transcribeVoice({ sock, groq, msg }) {
  const jid = msg.key.remoteJid;
  const audio = getAudio(msg);
  if (!audio) return { status: 'error' };

  const secs = Number(audio.seconds) || 0;
  if (secs > MAX_SECONDS) return { status: 'too_long' };
  if (overLimit(jid)) return { status: 'limit' };
  record(jid);

  let tmp = null;
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    tmp = path.join(os.tmpdir(), `flux_voice_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);
    fs.writeFileSync(tmp, buffer);

    // ---- Pass 1: auto-detect ----
    let res = await whisper(groq, tmp);
    const lang = String(res.language || '').toLowerCase();
    const isEnglish = lang === 'english' || lang === 'en';
    const isSinhala = lang === 'sinhala' || lang === 'si';

    // ---- Pass 2: English / Sinhala illa-na Tamil-nu assume pannu ----
    if (!isEnglish && !isSinhala) {
      try {
        const res2 = await whisper(groq, tmp, { language: 'ta', prompt: TAMIL_HINT });
        if (usable(res2)) res = res2;
      } catch (err) {
        console.error('Whisper pass 2 error:', err.message); // pass 1 result-a vechchiko
      }
    }

    if (!usable(res)) return { status: 'empty' };

    const raw = String(res.text).trim().slice(0, 1500);

    // ---- Pass 3: cleanup (English-na thevai illa) ----
    if (isEnglish || !CLEANUP_ENABLED) return { status: 'ok', text: raw, raw, language: lang };

    const cleaned = await cleanTranscript(groq, raw);
    if (cleaned === 'UNCLEAR') return { status: 'empty', raw };
    return { status: 'ok', text: cleaned || raw, raw, language: lang };
  } catch (err) {
    console.error('Voice transcription error:', err.message);
    return { status: 'error' };
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
}

module.exports = { getAudio, transcribeVoice };