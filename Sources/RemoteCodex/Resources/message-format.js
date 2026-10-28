'use strict';
window.RemoteCodexMessageFormat = state => {
  let source, signature, revision = 0, exact = new Map(), short = new Map();
  function index() {
    if (source === state.conversations) return;
    source = state.conversations;
    const contacts = (source || []).filter(c => c.platform === 'whatsapp' && c.type !== 'group');
    const nextSignature = JSON.stringify(contacts.map(c => [c.externalId, c.name]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (signature === nextSignature) return;
    signature = nextSignature; exact = new Map(); short = new Map(); revision++;
    const candidates = new Map();
    for (const c of contacts) {
      const match = /^([0-9]+)(?::[0-9]+)?@(lid|s\.whatsapp\.net)$/.exec(c.externalId || '');
      const name = String(c.name || '').trim();
      if (!match || !name || /^[+0-9\s()-]+$/.test(name) || name === c.externalId || /@(lid|s\.whatsapp\.net)$/.test(name)) continue;
      const jid = match[1] + '@' + match[2]; exact.set(jid, name);
      if (!candidates.has(match[1])) candidates.set(match[1], new Set()); candidates.get(match[1]).add(name);
    }
    for (const [id, names] of candidates) if (names.size === 1) short.set(id, [...names][0]);
  }
  function parts(text, platform) {
    text = String(text || '');
    if (platform !== 'whatsapp') return [{ text }];
    index();
    // Whole mention tokens only: leave email addresses, ordinary numbers and unknown identities alone.
    const pattern = /(^|[^\p{L}\p{N}_.%+@-])@([0-9]{5,20})(?:@(lid|s\.whatsapp\.net))?(?![\p{L}\p{N}_.@-])/gu;
    const result = []; let offset = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[3] ? exact.get(match[2] + '@' + match[3]) : short.get(match[2]);
      if (!name) continue;
      const start = match.index + match[1].length, end = match.index + match[0].length;
      if (start > offset) result.push({ text: text.slice(offset, start) });
      result.push({ text: '@' + name, original: text.slice(start, end) }); offset = end;
    }
    if (offset < text.length) result.push({ text: text.slice(offset) });
    return result;
  }
  function plain(text, platform) { return parts(text, platform).map(p => p.text).join(''); }
  function render(node, text, platform) {
    node.replaceChildren();
    for (const part of parts(text, platform)) {
      if (!part.original) { node.append(document.createTextNode(part.text)); continue; }
      const mention = document.createElement('span'); mention.className = 'message-mention'; mention.textContent = part.text; mention.title = part.original; node.append(mention);
    }
  }
  return { plain, render, revision: () => { index(); return revision; } };
};
