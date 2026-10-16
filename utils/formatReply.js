function toWhatsApp(text = '') {
  return text
    .replace(/^\s*#{1,6}\s*/gm, '')                       // ## Heading → Heading
    .replace(/^\s*[*•]\s+/gm, '- ')                       // * item → - item
    .replace(/\*\*(.+?)\*\*/g, '*$1*')                    // **bold** → *bold*
    .replace(/__(.+?)__/g, '_$1_')                        // __italic__ → _italic_
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2') // [text](url) → text: url
    .replace(/^\s*---+\s*$/gm, '')                        // --- lines remove
    .replace(/\n{3,}/g, '\n\n')                           // extra blank lines
    .trim();
}

module.exports = { toWhatsApp };