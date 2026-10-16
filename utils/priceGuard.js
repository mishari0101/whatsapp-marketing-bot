// ====================== PRICE GUARD ======================
// AI thaanaa multiply / add panni total solla koodaadhu.
// Reply-la listed price illaadha amount irundha block pannitu safe reply anuppum.

// Official listed prices mattum (LKR)
const ALLOWED_AMOUNTS = new Set([
  800, 1500, 5000, 7000, 7500, 8000, 12500, 14500, 15000, 20000, 24500, 39500, 65000,
]);

// Quantity request-na, andha service-oda single-unit price mattum allowed
const CATEGORY_AMOUNTS = {
  AI_REEL: [1500],
  REEL: [5000],
  POSTER: [],
  ADS: [7500, 12500],
  PAGE_SETUP: [8000, 15000],
};

const UNIT_LINES = {
  AI_REEL: 'AI reel Rs. 1,500-la irundhu start aagudhu.',
  REEL: 'Extra reel Rs. 5,000 per reel.',
  POSTER: 'Poster price requirement-a poruthu maarum.',
  ADS: 'Meta Ads setup Rs. 7,500 (1 campaign + 7 days management).',
  PAGE_SETUP: 'Page setup Rs. 8,000–15,000.',
};

// "4 reel", "10 posters", "3 months", "reel 4", "4 AI reels", "bulk", "total"
const SERVICE = '(?:ai\\s*)?(?:reels?|videos?|posters?|posts?|designs?|ads?|campaigns?|pages?|months?|weeks?|logos?|flyers?|banners?)';
const QTY_BEFORE = new RegExp(`\\b\\d{1,3}\\s*(?:x\\s*)?${SERVICE}\\b`, 'i');
const QTY_AFTER = new RegExp(`\\b${SERVICE}\\s*(?:x|-|:)?\\s*\\d{1,3}\\b`, 'i');
const QTY_WORDS = /\b(bulk|total|mothama|motham|all\s*together)\b/i;

function isQuantityRequest(text = '') {
  const t = String(text);
  return QTY_BEFORE.test(t) || QTY_AFTER.test(t) || QTY_WORDS.test(t);
}

// Reply-la irukkura amounts-a edukkum (phone numbers, years ignore)
function extractAmounts(str = '') {
  const cleaned = String(str)
    .replace(/\b0\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, ' ') // 078 607 0020
    .replace(/\+?94[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, ' ');

  const out = new Set();
  const re = /\d{1,3}(?:,\d{3})+|\d{4,7}/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const n = parseInt(m[0].replace(/,/g, ''), 10);
    if (n >= 1990 && n <= 2100 && !m[0].includes(',')) continue; // year
    out.add(n);
  }
  // "Rs. 800" maadhiri 3-digit amounts
  const re2 = /(?:rs\.?|lkr)\s*(\d{3})\b/gi;
  while ((m = re2.exec(cleaned))) out.add(parseInt(m[1], 10));
  return [...out];
}

// ok:false na reply-a anuppa koodaadhu
function checkReply(reply, customerText, topic, isQty) {
  const amounts = extractAmounts(reply);
  if (amounts.length === 0) return { ok: true, bad: [] };

  const fromCustomer = new Set(extractAmounts(customerText));
  const allowed =
    isQty && CATEGORY_AMOUNTS[topic] ? new Set(CATEGORY_AMOUNTS[topic]) : ALLOWED_AMOUNTS;

  const bad = amounts.filter((a) => !allowed.has(a) && !fromCustomer.has(a));
  return { ok: bad.length === 0, bad };
}

// Block aana reply-ku badhilaa anuppura safe message
function safePriceReply(topic, askLead = true) {
  const parts = [];
  if (UNIT_LINES[topic]) parts.push(UNIT_LINES[topic]);
  parts.push('Indha quantity-ku exact total-a team confirm pannuvaanga. 😊');
  if (askLead) parts.push('Unga business enna type, team call panna free time eppo sollunga?');
  return parts.join(' ');
}

module.exports = { isQuantityRequest, extractAmounts, checkReply, safePriceReply };