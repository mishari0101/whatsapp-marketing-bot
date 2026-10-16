// ====================== SAFETY HELPERS ======================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

let queue = Promise.resolve();
let lastSent = 0;
const MIN_GAP_MS = 4000;

function enqueue(task) {
  queue = queue.then(task).catch((e) => console.error('Queue error:', e));
  return queue;
}

async function waitForGap() {
  const gap = Date.now() - lastSent;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
}

function markSent() {
  lastSent = Date.now();
}

const userHits = new Map();
function isRateLimited(userId) {
  const now = Date.now();
  const hits = (userHits.get(userId) || []).filter((t) => now - t < 60000);
  hits.push(now);
  userHits.set(userId, hits);
  return hits.length > 5;
}

const DAILY_LIMIT_PER_USER = 15;
const DAILY_LIMIT_TOTAL = 100;

let currentDay = new Date().toDateString();
const dailyCount = new Map();
const limitNotified = new Set();
let totalToday = 0;

function resetIfNewDay() {
  const d = new Date().toDateString();
  if (d !== currentDay) {
    currentDay = d;
    dailyCount.clear();
    limitNotified.clear();
    totalToday = 0;
  }
}

function dailyStatus(userId) {
  resetIfNewDay();
  const n = dailyCount.get(userId) || 0;
  if (n >= DAILY_LIMIT_PER_USER || totalToday >= DAILY_LIMIT_TOTAL) {
    if (limitNotified.has(userId)) return 'silent';
    limitNotified.add(userId);
    return 'notify';
  }
  return 'ok';
}

function countReply(userId) {
  dailyCount.set(userId, (dailyCount.get(userId) || 0) + 1);
  totalToday++;
}

module.exports = {
  sleep,
  rand,
  enqueue,
  waitForGap,
  markSent,
  MIN_GAP_MS,
  isRateLimited,
  dailyStatus,
  countReply,
};
