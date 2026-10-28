// Transport-independent WhatsApp normalization; session keys never pass through this module.
export function usableJid(jid) {
  return typeof jid === 'string' && /^[0-9A-Za-z:_-]+@(g\.us|s\.whatsapp\.net|lid)$/u.test(jid);
}

export function unwrap(message) {
  let current = message;
  for (let n = 0; n < 8; n += 1) {
    const nested = current?.ephemeralMessage?.message ?? current?.viewOnceMessage?.message ??
      current?.viewOnceMessageV2?.message ?? current?.viewOnceMessageV2Extension?.message ?? current?.documentWithCaptionMessage?.message;
    if (!nested) return current;
    current = nested;
  }
  return current;
}

export function messageText(message) {
  const content = unwrap(message);
  if (!content) return null;
  if (typeof content.conversation === 'string') return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  for (const [key, label] of [['imageMessage', '图片'], ['videoMessage', '视频'],
    ['audioMessage', '语音'], ['documentMessage', '文件'], ['stickerMessage', '贴纸'],
    ['contactMessage', '联系人'], ['locationMessage', '位置']]) {
    const value = content[key];
    if (value) return '[' + label + ']' + [value.fileName, value.displayName, value.caption].filter(Boolean).map(v => ' ' + v).join('');
  }
  return null;
}

export function normalizedMessage(raw, names = new Map()) {
  const key = raw?.key;
  if (!usableJid(key?.remoteJid) || !key?.id) return null;
  const text = messageText(raw.message);
  if (text === null) return null;
  const jid = key.remoteJid;
  const seconds = Number(raw.messageTimestamp?.toNumber?.() ?? raw.messageTimestamp ?? Date.now()/1000);
  const name = names.get(jid) || (!jid.endsWith('@g.us') && raw.pushName) || jid;
  return {
    type: 'message',
    conversation: { externalId: jid, name, type: jid.endsWith('@g.us') ? 'group' : 'contact' },
    message: { externalId: key.id, author: key.fromMe ? '你' : raw.pushName || names.get(key.participant) || key.participant || name,
      text, direction: key.fromMe ? 'outgoing' : 'incoming', timestamp: Number.isFinite(seconds) ? seconds*1000 : Date.now(),
      status: key.fromMe ? 'sent' : 'received', ...(mediaInfo(raw.message) ? { media: mediaInfo(raw.message) } : {}) }
  };
}

export function allowedRPC(method) {
  return ['status', 'connect', 'listGroups', 'selectGroup', 'startAuth', 'startPairingCode',
    'sendToConfiguredGroup', 'sendTextToConfiguredGroup', 'sendMarkdownFileToConfiguredGroup', 'send', 'sendMedia', 'downloadMedia', 'authStatus', 'linkDevice'].includes(method);
}

export const MEDIA_LIMIT = 25 * 1024 * 1024;
export function safeName(value, fallback = 'attachment') {
  return String(value || fallback).replace(/[\\/\x00-\x1f\x7f]/gu, '_').slice(0, 180).replace(/^\.+$/u, '_') || fallback;
}
export function mediaInfo(message) {
  const content = unwrap(message);
  for (const [key, kind, extension] of [['imageMessage', 'image', 'jpg'], ['videoMessage', 'video', 'mp4'], ['audioMessage', 'audio', 'ogg'], ['documentMessage', 'document', 'bin'], ['stickerMessage', 'image', 'webp']]) {
    const value = content?.[key]; if (!value) continue;
    const size = Number(value.fileLength?.toNumber?.() ?? value.fileLength ?? 0);
    let current = message, once = value.viewOnce === true;
    for (let n = 0; n < 8 && current; n += 1) { once ||= !!(current.viewOnceMessage || current.viewOnceMessageV2 || current.viewOnceMessageV2Extension); current = current.ephemeralMessage?.message ?? current.viewOnceMessage?.message ?? current.viewOnceMessageV2?.message ?? current.viewOnceMessageV2Extension?.message ?? current.documentWithCaptionMessage?.message; }
    return { kind, name: safeName(value.fileName, `${kind}.${extension}`), mime: String(value.mimetype || 'application/octet-stream').split(';')[0],
      size: Number.isFinite(size) && size >= 0 ? size : 0, duration: Number(value.seconds || 0),
      available: !once && size <= MEDIA_LIMIT, reason: once ? '阅后即焚媒体不保存' : size > MEDIA_LIMIT ? '附件超过 25 MB' : null };
  }
  return null;
}
