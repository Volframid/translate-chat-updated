'use strict';
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function decodeText(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return map[entity.toLowerCase()] || whole;
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function prepare(message, names = []) {
  if (typeof message !== 'string' || message.length > 6000) return null;
  if (/ZXQ\s*TERA\s*\d+\s*QXZ/i.test(decodeText(message))) return null;
  const tokens = [], marker = index => 'ZXQTERA' + index + 'QXZ';
  const protect = (text, markup = false) => { const value = marker(tokens.length); tokens.push({ text, markup }); return value; };
  let text = message.replace(/<ChatLinkAction\b[^>]*>[\s\S]*?<\/ChatLinkAction>/gi, part => protect(part, true));
  text = decodeText(text.replace(/<\/?[A-Za-z][^>]*>/g, '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (!text || text.length > 1200) return null;
  text = text.replace(/https?:\/\/[^\s<>]+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi, address => {
    const trimmed = address.replace(/[.,!?;:]+$/, '');
    return protect(trimmed) + address.slice(trimmed.length);
  });
  const words = [...new Set(names.filter(name => typeof name === 'string' && name.length > 1 && name.length <= 100 &&
    !/ZXQ\s*TERA\s*\d+\s*QXZ/i.test(name)))].sort((a, b) => b.length - a.length);
  if (words.length) {
    const pattern = new RegExp('(^|[^\\p{L}\\p{N}_])(' + words.map(escapeRegex).join('|') + ')(?=$|[^\\p{L}\\p{N}_])', 'giu');
    text = text.replace(pattern, (_, boundary, word) => boundary + protect(word));
  }
  const translatable = /\p{L}/u.test(text.replace(/ZXQTERA\d+QXZ/g, ''));
  return { text, tokens, translatable, restore(translated) {
    if (typeof translated !== 'string' || !translated.trim() || translated.length > 6000) return null;
    const markerPattern = /ZXQ\s*TERA\s*(\d+)\s*QXZ/gi;
    const seen = new Array(tokens.length).fill(0);
    let valid = true;
    translated.replace(markerPattern, (whole, id) => {
      const index = Number(id);
      if (String(index) !== id || !tokens[index] || ++seen[index] !== 1) valid = false;
      return whole;
    });
    if (!valid || seen.some(count => count !== 1)) return null;
    let result = escapeText(translated.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
    // One pass avoids interpreting restored original link contents again.
    return result.replace(markerPattern, (whole, id) => {
      const token = tokens[Number(id)];
      return token.markup ? token.text : escapeText(token.text);
    });
  } };
}
module.exports = { prepare, escapeText, decodeText };
