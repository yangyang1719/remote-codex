import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MEDIA_LIMIT, mediaInfo, safeName, usableJid, unwrap } from './core.mjs';

export class MediaFiles {
  constructor(root) { this.root = path.resolve(root); }
  location(id) {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new Error('MEDIA_ID_INVALID');
    return path.join(this.root, id, 'content');
  }
  async checked(id, size, digest) {
    const target = this.location(id), info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MEDIA_LIMIT || info.size !== size) throw new Error('MEDIA_FILE_INVALID');
    const real = await fs.realpath(target);
    if (!real.startsWith((await fs.realpath(this.root)) + path.sep)) throw new Error('MEDIA_PATH_INVALID');
    const bytes = await fs.readFile(target);
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('MEDIA_CHECKSUM_INVALID');
    return bytes;
  }
  async download(params, decode, download, socket) {
    if (typeof params.source !== 'string' || params.source.length > 4 * 1024 * 1024) throw new Error('MEDIA_SOURCE_MISSING');
    const raw = decode(Buffer.from(params.source, 'base64')), info = mediaInfo(raw.message);
    if (!info?.available || !usableJid(raw.key?.remoteJid) || raw.key.remoteJid !== params.externalId || raw.key.id !== params.messageId) throw new Error('MEDIA_SOURCE_INVALID');
    const content = unwrap(raw.message), value = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage || content.stickerMessage;
    // Chat-supplied metadata cannot turn the remote media worker into a general URL fetcher.
    if (value.url) {
      const url = new URL(value.url);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !['whatsapp.net', 'whatsapp.com', 'fbcdn.net', 'fbsbx.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) throw new Error('MEDIA_HOST_INVALID');
    }
    if ((!value.url && !value.directPath) || (value.directPath && (!value.directPath.startsWith('/') || value.directPath.includes('\\')))) throw new Error('MEDIA_PATH_INVALID');
    const target = this.location(params.id), directory = path.dirname(target), temp = target + '.' + randomUUID() + '.part';
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stream = await download(raw, 'stream', { options: { timeout: 60000 } }, { logger: { info() {}, warn() {}, error() {}, debug() {} }, reuploadRequest: msg => socket.updateMediaMessage(msg) });
    const file = await fs.open(temp, 'wx', 0o600), hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of stream) { size += chunk.length; if (size > MEDIA_LIMIT) throw new Error('MEDIA_TOO_LARGE'); await file.write(chunk); hash.update(chunk); }
      await file.close(); await fs.rename(temp, target);
      return { size, sha256: hash.digest('hex') };
    } catch (error) { stream.destroy?.(); await file.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); throw error; }
  }
  async content(params) {
    const media = params.media;
    if (!media || !['image', 'video', 'audio', 'document'].includes(media.kind)) throw new Error('MEDIA_KIND_INVALID');
    const bytes = await this.checked(media.id, media.size, media.sha256);
    const text = params.text || '';
    if (typeof text !== 'string' || text.length > 4000) throw new Error('MEDIA_CAPTION_INVALID');
    const content = { [media.kind]: bytes, mimetype: media.mime || 'application/octet-stream' };
    if (media.kind === 'document') content.fileName = safeName(media.name);
    // Audio captions are unsupported by WhatsApp. Send as a named file when a caption is present.
    if (media.kind === 'audio' && text) return { document: bytes, fileName: safeName(media.name), mimetype: content.mimetype, caption: text };
    if (media.kind !== 'audio') content.caption = text;
    return content;
  }
}
