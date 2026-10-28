import fs from 'node:fs/promises';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { WhatsAppPrRuntime, readDisconnectInfo } from './vendor/runtime.mjs';
import { authDir } from './vendor/paths.mjs';
import { allowedRPC, normalizedMessage, usableJid } from './core.mjs';
import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';
import { MediaFiles } from './media.mjs';
import path from 'node:path';
import os from 'node:os';
import { WhatsAppLink } from './auth.mjs';

process.umask(0o077);
// Library diagnostics may contain session details. Only our JSON protocol goes to stdout.
console.log = console.info = console.warn = () => {};
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const names = new Map();
let stopping = false;
let activated = false;
let reconnectAttempts = 0;
const mediaFiles = new MediaFiles(process.env.WHATSAPP_MEDIA_DIR || path.join(os.homedir(), '.local/state/remote-codex/media'));
function publishMessage(raw, type = 'message') {
  const value = normalizedMessage(raw, names);
  if (!value) return;
  if (value.message.media?.available) value.message._mediaSource = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString('base64');
  emit({ ...value, type });
}

class ServiceRuntime extends WhatsAppPrRuntime {
  // Preserve the existing session even when the platform reports logout. Relinking is a human action.
  async clearInvalidCredentials() {}

  async startInternal() {
    if (this.retired || !activated || stopping) throw new Error('WHATSAPP_SERVICE_STANDBY');
    emit({ type: 'status', status: 'connecting' });
    const socket = await super.startInternal();
    socket.ev.on('connection.update', update => {
      if (this.retired) return;
      if (update.connection === 'open') {
        reconnectAttempts = 0;
        emit({ type: 'ready' });
        if (process.env.WHATSAPP_AUTOCONNECT_MARKER) void fs.writeFile(process.env.WHATSAPP_AUTOCONNECT_MARKER, 'linked\n', { mode: 0o600 }).catch(() => {});
        void this.publishGroups().catch(() => emit({ type: 'status', status: 'connected', warning: 'groups_refresh_failed' }));
      } else if (update.qr) {
        emit({ type: 'status', status: 'needs_relink' });
      } else if (update.connection === 'close') {
        const info = readDisconnectInfo(update.lastDisconnect?.error);
        if (info.code === 401 && process.env.WHATSAPP_AUTOCONNECT_MARKER) void fs.unlink(process.env.WHATSAPP_AUTOCONNECT_MARKER).catch(() => {});
        emit({ type: 'status', status: info.code === 401 ? 'needs_relink' : info.code === 440 ? 'session_conflict' : 'disconnected', code: info.code });
      }
    });
    const contacts = values => {
      for (const value of values) {
        if (!usableJid(value.id)) continue;
        const name = value.name || value.notify || value.verifiedName || names.get(value.id) || value.id;
        names.set(value.id, name);
        emit({ type: 'conversation', conversation: { externalId: value.id, name, type: value.id.endsWith('@g.us') ? 'group' : 'contact' } });
      }
    };
    socket.ev.on('contacts.upsert', contacts);
    socket.ev.on('contacts.update', contacts);
    socket.ev.on('chats.upsert', contacts);
    socket.ev.on('chats.update', contacts);
    socket.ev.on('groups.update', values => contacts(values.map(value => ({ ...value, name: value.subject }))));
    socket.ev.on('messages.upsert', ({ messages }) => {
      for (const raw of messages) publishMessage(raw);
    });
    socket.ev.on('messaging-history.set', ({ chats = [], contacts: roster = [], messages = [] }) => {
      contacts(roster); contacts(chats);
      for (const raw of messages) publishMessage(raw);
    });
    socket.ev.on('messages.update', values => {
      for (const value of values) {
        if (!usableJid(value.key?.remoteJid)) continue;
        const normalized = normalizedMessage({ key: value.key, ...value.update }, names);
        if (normalized) emit({ ...normalized, type: 'messageUpdate' });
      }
    });
    socket.ev.on('messages.delete', value => {
      for (const key of value.keys || []) {
        if (!usableJid(key.remoteJid) || !key.id) continue;
        emit({ type: 'messageUpdate', conversation: { externalId: key.remoteJid, name: names.get(key.remoteJid) || key.remoteJid, type: key.remoteJid.endsWith('@g.us') ? 'group' : 'contact' }, message: { externalId: key.id, text: '[此消息已撤回]', status: 'deleted' } });
      }
    });
    return socket;
  }

  async handleDisconnect(socket, error) {
    if (this.retired) return;
    const code = readDisconnectInfo(error).code;
    await super.handleDisconnect(socket, error);
    if (stopping || !activated || [401, 440, 515].includes(code)) return;
    reconnectAttempts += 1;
    if (reconnectAttempts > 10) { emit({ type: 'status', status: 'connection_failed' }); return; }
    if (!this.reconnectPromise) {
      this.reconnectPromise = (async () => {
        await delay(Math.min(3000 * 2 ** (reconnectAttempts - 1), 60000));
        if (!stopping && activated) await this.startInternal();
      })().catch(() => emit({ type: 'status', status: 'disconnected' })).finally(() => { this.reconnectPromise = null; });
    }
  }

  async publishGroups() {
    const groups = await super.listGroups();
    for (const group of groups) {
      names.set(group.id, group.name);
      emit({ type: 'conversation', conversation: { externalId: group.id, name: group.name, type: 'group' } });
    }
    return groups;
  }

  async sendContent(jid, content) {
    if (!usableJid(jid)) throw new Error('WHATSAPP_CHAT_ID_INVALID');
    const socket = await this.ensureConnected();
    const sent = await socket.sendMessage(jid, content);
    if (!sent?.key?.id) throw new Error('WHATSAPP_SEND_RESULT_UNCONFIRMED');
    const value = normalizedMessage({ ...sent, key: { ...sent.key, fromMe: true, remoteJid: jid }, messageTimestamp: sent.messageTimestamp || Date.now()/1000 }, names);
    if (value) emit(value);
    return sent.key.id;
  }

  async sendConfiguredGroupMessage(content) {
    const config = await this.readConfig();
    if (!/^[0-9-]+@g\.us$/u.test(config.groupJid || '')) throw new Error('WHATSAPP_NOTIFICATION_GROUP_NOT_CONFIGURED');
    return { groupJid: config.groupJid, groupName: config.groupName, messageId: await this.sendContent(config.groupJid, content) };
  }
}

let runtime = new ServiceRuntime();
const link = new WhatsAppLink({ authDir, getRuntime: () => runtime, replaceRuntime: () => { activated = true; runtime = new ServiceRuntime(); return runtime; } });
async function call(method, params) {
  if (!allowedRPC(method)) throw new Error('WHATSAPP_METHOD_NOT_ALLOWED');
  if (method === 'authStatus') return link.snapshot();
  if (method === 'linkDevice') return link.begin(params.mode, params.phoneNumber);
  if (method === 'status') return { ...await runtime.status(), sessionMode: 'existing_remote_session', activated };
  if (method === 'connect') {
    if (!runtime.hasCredentials()) throw new Error('WHATSAPP_EXISTING_SESSION_MISSING');
    activated = true;
    await runtime.ensureConnected();
    return runtime.status();
  }
  if (method === 'send') {
    if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 4000) throw new Error('WHATSAPP_TEXT_MESSAGE_INVALID');
    return { messageId: await runtime.sendContent(params.externalId, { text: params.text }) };
  }
  if (method === 'downloadMedia') {
    const socket = await runtime.ensureConnected();
    return mediaFiles.download(params, bytes => proto.WebMessageInfo.decode(bytes), downloadMediaMessage, socket);
  }
  if (method === 'sendMedia') {
    return { messageId: await runtime.sendContent(params.externalId, await mediaFiles.content(params)) };
  }
  if (method === 'listGroups') return runtime.publishGroups();
  if (method === 'selectGroup') return runtime.selectGroup(params.groupJid);
  if (method === 'startAuth') { activated = true; return runtime.startAuth(); }
  if (method === 'startPairingCode') { activated = true; return runtime.startPairingCode(params.phoneNumber); }
  if (method === 'sendToConfiguredGroup' || method === 'sendTextToConfiguredGroup') return runtime.sendTextToConfiguredGroup(params.text);
  if (method === 'sendMarkdownFileToConfiguredGroup') return runtime.sendMarkdownFileToConfiguredGroup(params.filePath, params.caption);
}

async function shutdown() {
  if (stopping) return;
  stopping = true; activated = false;
  runtime.socket?.end(new Error('service_stop'));
  await runtime.credentialsSavePromise.catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', () => emit({ type: 'status', status: 'error' }));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', shutdown);
input.on('line', line => {
  void (async () => {
    let request;
    try {
      request = JSON.parse(line);
      const result = await call(request.method, request.params || {});
      emit({ id: request.id, result });
    } catch (error) {
      emit({ id: request?.id ?? null, error: error?.message || 'WHATSAPP_SERVICE_FAILED' });
    }
  })();
});

// Session must be a directory, never a symlink to a local/Mac credential store.
const stat = await fs.lstat(authDir).catch(() => null);
if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('WHATSAPP_SESSION_DIRECTORY_INVALID');
emit({ type: 'status', status: 'standby' });
if (process.env.WHATSAPP_SERVICE_AUTOCONNECT === 'true' || (process.env.WHATSAPP_AUTOCONNECT_MARKER && await fs.stat(process.env.WHATSAPP_AUTOCONNECT_MARKER).catch(() => null))) {
  void call('connect', {}).catch(error => emit({ type: 'status', status: error.message === 'WHATSAPP_EXISTING_SESSION_MISSING' ? 'session_missing' : 'connection_failed' }));
}
