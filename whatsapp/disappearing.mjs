import fs from 'node:fs/promises';
import path from 'node:path';
import { usableJid, unwrap } from './core.mjs';

const number = value => Number(value?.toNumber?.() ?? value);
const duration = value => value === null ? 0 : number(value);
const validDuration = value => Number.isSafeInteger(value) && value >= 0 && value <= 365 * 86400;

// Stores only chat IDs, timers and timestamps, never message bodies or account keys.
export class DisappearingSettings {
  constructor(file) { this.file = file; this.rows = new Map(); this.aliases = new Map(); this.writes = Promise.resolve(); this.waiters = new Set(); }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.rows)) throw new Error('invalid format');
      for (const [jid, row] of data.rows) if (usableJid(jid) && validDuration(row?.duration) && Number.isFinite(row.at) && Number.isInteger(row.rank)) this.rows.set(jid, row);
      for (const group of data.aliases || []) if (Array.isArray(group) && group.every(usableJid)) this.link(group, false);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('自动消失设置缓存无法读取，请检查消息服务。'); }
  }
  peers(jid) { return this.aliases.get(jid) || [jid]; }
  get(jid) { return this.rows.get(jid); }
  link(ids, save = true) {
    const peers = [...new Set(ids.filter(usableJid).flatMap(jid => this.peers(jid)))];
    if (peers.length < 2) return;
    if (peers.every(jid => this.peers(jid).length === peers.length && this.peers(jid).every(peer => peers.includes(peer)))) return;
    const best = peers.map(jid => this.rows.get(jid)).filter(Boolean).sort((a,b) => b.at - a.at || b.rank - a.rank)[0];
    for (const jid of peers) { this.aliases.set(jid, peers); if (best) this.rows.set(jid, best); }
    if (save) this.persist();
  }
  set(jid, seconds, at, rank = 2) {
    seconds = duration(seconds); at = number(at);
    if (!usableJid(jid) || !validDuration(seconds) || !Number.isFinite(at) || at < 0) return;
    const old = this.get(jid);
    if (old && (old.at > at || old.at === at && old.rank > rank)) return;
    if (old && old.at === at && old.rank === rank && old.duration === seconds) return;
    const row = { duration: seconds, at, rank };
    for (const peer of this.peers(jid)) this.rows.set(peer, row);
    this.persist();
    for (const notify of this.waiters) notify(jid);
  }
  observeChat(chat, snapshot = false) {
    if (!usableJid(chat?.id)) return;
    this.link([chat.id, chat.lid, chat.phoneNumber, chat.lidJid, chat.pnJid]);
    // Missing fields in a partial chat update must never turn a timer off.
    if (Object.hasOwn(chat, 'ephemeralExpiration') && chat.ephemeralExpiration !== undefined) this.set(chat.id, chat.ephemeralExpiration, chat.ephemeralSettingTimestamp ?? 0);
    else if (snapshot) this.set(chat.id, 0, chat.ephemeralSettingTimestamp ?? 0, 0);
  }
  observeMessage(raw, ephemeralSettingType = 3) {
    const jid = raw?.key?.remoteJid;
    if (!usableJid(jid)) return;
    this.link([jid, raw.key.remoteJidAlt]);
    const content = unwrap(raw.message);
    if (!content) return;
    const protocol = content.protocolMessage;
    if (protocol?.type === ephemeralSettingType) {
      this.set(jid, protocol.ephemeralExpiration ?? 0, raw.messageTimestamp ?? 0);
      return;
    }
    for (const value of Object.values(content)) {
      const context = value?.contextInfo;
      if (context && Object.hasOwn(context, 'expiration')) {
        this.set(jid, context.expiration, context.ephemeralSettingTimestamp || raw.messageTimestamp || 0, 1);
        break;
      }
    }
  }
  persist() {
    if (!this.file) return;
    const data = JSON.stringify({ version: 1, rows: [...this.rows], aliases: [...new Set(this.aliases.values())] });
    this.writes = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.new';
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.chmod(temporary, 0o600); await fs.rename(temporary, this.file);
    });
    // The next send/close observes the error; do not leak private data in logs.
    this.writes.catch(() => {});
  }
  async options(socket, jid, anchor, { allowUnknown = false } = {}) {
    if (jid.endsWith('@g.us')) {
      // Query current group metadata rather than inferring a group timer from a participant.
      try {
        const metadata = await socket.groupMetadata(jid);
        this.set(jid, metadata.ephemeralDuration ?? 0, Date.now()/1000);
      } catch (error) { if (!allowUnknown) throw error; }
    } else if (!allowUnknown && !this.get(jid) && anchor && typeof socket.fetchMessageHistory === 'function') {
      const key = { remoteJid: jid, id: anchor.id, fromMe: anchor.fromMe === true };
      if (!key.id || !Number.isSafeInteger(anchor.timestampMs) || anchor.timestampMs <= 0) throw new Error('无法确认此聊天的自动消失设置。');
      // History is delivered by events. Register the waiter before asking the phone.
      let timer, notify;
      const ready = new Promise(resolve => {
        notify = id => { if (this.peers(id).includes(jid) || id === jid) resolve(); };
        this.waiters.add(notify); timer = setTimeout(resolve, 20000);
      });
      try {
        await socket.fetchMessageHistory(20, key, anchor.timestampMs);
        if (!this.get(jid)) await ready;
      } finally { clearTimeout(timer); this.waiters.delete(notify); }
    }
    if (!allowUnknown) await this.writes;
    const row = this.get(jid);
    if (!row) {
      if (allowUnknown) return {};
      throw new Error('尚未同步到此聊天的自动消失设置，请在手机 WhatsApp 中重新确认该聊天的自动消失时长后重试。消息未发送。');
    }
    return row.duration > 0 ? { ephemeralExpiration: row.duration } : {};
  }
}

export async function sendWithDisappearing(socket, settings, jid, content, anchor) {
  // Missing timer metadata must not block sending or wait for the primary phone.
  // Do not persist an unknown timer as explicitly disabled.
  const options = await settings.options(socket, jid, anchor, { allowUnknown: true });
  return socket.sendMessage(jid, content, options);
}
