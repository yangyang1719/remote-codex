import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function pairingPhone(value) {
  const number = typeof value === 'string' ? value.replace(/[ +()-]/gu, '') : '';
  if (!/^[1-9][0-9]{7,14}$/u.test(number)) throw new Error('请输入含国家区号的手机号，例如 +86 13800138000。');
  return number;
}
export async function backupSession(authDir) {
  const info = await fs.lstat(authDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WHATSAPP_SESSION_DIRECTORY_INVALID');
  const backups = path.join(path.dirname(authDir), 'auth-backups');
  await fs.mkdir(backups, { recursive: true, mode: 0o700 }); await fs.chmod(backups, 0o700);
  await fs.rename(authDir, path.join(backups, new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID()));
}

// Owns one login operation. Challenges are memory-only and never become drafts or logs.
export class WhatsAppLink {
  constructor({ getRuntime, replaceRuntime, authDir }) { Object.assign(this, { getRuntime, replaceRuntime, authDir }); this.busy = false; this.code = null; }
  snapshot() {
    const state = this.getRuntime().state;
    if (state.status === 'connected') this.code = null;
    return { status: state.status, authMode: state.authMode, qrImage: state.status === 'awaiting_qr_scan' ? state.qrImage : null, pairingCode: state.status === 'awaiting_pairing_code' ? this.code : null };
  }
  async begin(mode, phone) {
    if (!['qr', 'phone'].includes(mode)) throw new Error('关联方式无效。');
    const number = mode === 'phone' ? pairingPhone(phone) : null;
    const old = this.getRuntime();
    if (old.state.status === 'connected') return this.snapshot();
    if (this.busy) throw new Error('正在准备关联，请稍候。');
    if ((mode === 'qr' && old.state.status === 'awaiting_qr_scan') || (mode === 'phone' && old.state.status === 'awaiting_pairing_code' && this.code && this.phone === number)) return this.snapshot();
    this.busy = true;
    try {
      old.retired = true;
      await old.startPromise?.catch(() => {});
      // Detach save listeners before moving the old directory; delayed old saves cannot overwrite new keys.
      for (const event of ['creds.update', 'connection.update', 'messages.upsert', 'messages.update', 'messaging-history.set', 'contacts.upsert', 'contacts.update', 'chats.upsert', 'chats.update', 'groups.update', 'messages.delete']) old.socket?.ev.removeAllListeners(event);
      old.socket?.end(new Error('desktop_relink')); old.socket = null;
      await old.credentialsSavePromise;
      await backupSession(this.authDir);
      const runtime = this.replaceRuntime(); this.code = null; this.phone = number;
      const result = mode === 'qr' ? await runtime.startAuth() : await runtime.startPairingCode(number);
      if (result.pairingCode) this.code = result.pairingCode;
      return this.snapshot();
    } finally { this.busy = false; }
  }
}
