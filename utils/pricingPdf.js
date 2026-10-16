const fs = require('fs');
const path = require('path');

const PDF_PATH = path.join(__dirname, '..', 'assets', 'flux-media-pricing.pdf');
const PDF_TAG = '[SEND_PRICING_PDF]';

// "Full list" kekkura patterns
const FULL_LIST_PATTERNS = [
  /price\s*list/,
  /rate\s*card/,
  /pricing\s*(pdf|list|details|packages?)/,
  /\ball\s*(the\s*)?(packages?|prices?|plans?|rates?)\b/,
  /\bfull\s*(details|packages?|pricing|price)\b/,
  /\bpackages?\s*(details|list|pdf)\b/,
  /\b(send|anuppu\w*|share|venum|vendum)\b.*\b(packages?|pricing)\b/,
  /\b(packages?|pricing)\b.*\b(send|anuppu\w*|share|venum|vendum)\b/,
  /\bpdf\b/,
];

// Idhu irundha customer oru SPECIFIC service/package kekkuraan → PDF vendaam
const SPECIFIC_WORDS =
  /\b(mini|starter|growth|pro|weekly|extra|reels?|posts?|posters?|ads?|meta|setup|add[- ]?on)\b/;

function isPackageRequest(text = '') {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  if (SPECIFIC_WORDS.test(t)) return false;
  return FULL_LIST_PATTERNS.some((re) => re.test(t));
}

function pricingPdfExists() {
  return fs.existsSync(PDF_PATH);
}

async function sendPricingPdf(sock, jid) {
  await sock.sendMessage(jid, {
    document: fs.readFileSync(PDF_PATH),
    mimetype: 'application/pdf',
    fileName: 'Flux Media - Pricing Packages.pdf',
    caption: 'Flux Media pricing packages 📄 Doubt irundha kelunga! 😊',
  });
}

module.exports = { isPackageRequest, pricingPdfExists, sendPricingPdf, PDF_TAG };