import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DisappearingSettings, sendWithDisappearing } from '../disappearing.mjs';

const jid = '123@s.whatsapp.net', alternate = '456@lid';
const message = (seconds, at = 100) => ({ key: { remoteJid: jid }, messageTimestamp: at,
  message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'fixture', contextInfo: { expiration: seconds } } } } } });

test('text and attachments inherit the observed timer without changing chat settings', async () => {
  for (const seconds of [86400, 604800, 7776000]) {
    const settings = new DisappearingSettings(); settings.observeMessage(message(seconds));
    const calls = [], socket = { sendMessage: async (...args) => { calls.push(args); return { key: { id: 'sent' } }; } };
    for (const content of [{ text: 'fixture' }, { document: Buffer.from('fixture'), mimetype: 'text/plain', fileName: 'fixture.txt' }]) {
      await sendWithDisappearing(socket, settings, jid, content);
      assert.deepEqual(calls.at(-1), [jid, content, { ephemeralExpiration: seconds }]);
    }
    assert.equal(calls.length, 2);
  }
});

test('a newer disabled setting wins over older history and partial contact updates', async () => {
  const settings = new DisappearingSettings(); settings.observeMessage(message(86400));
  settings.observeChat({ id: jid, ephemeralExpiration: null, ephemeralSettingTimestamp: 200 });
  settings.observeMessage(message(86400, 150));
  settings.observeChat({ id: jid, name: 'fixture' });
  assert.deepEqual(await settings.options({}, jid), {});
});

test('protocol settings work through wrappers including explicit off', async () => {
  const settings = new DisappearingSettings();
  for (const [at, expiration] of [[100, 604800], [200, 0]]) {
    settings.observeMessage({ key: { remoteJid: jid }, messageTimestamp: at,
      message: { ephemeralMessage: { message: { protocolMessage: { type: 3, ephemeralExpiration: expiration } } } } });
    assert.equal(settings.get(jid).duration, expiration);
  }
});

test('incomplete updates and stale history snapshots do not clear a known setting', () => {
  const settings = new DisappearingSettings(); settings.observeMessage(message(604800));
  settings.observeChat({ id: jid }, true);
  settings.observeChat({ id: jid, ephemeralExpiration: undefined });
  assert.equal(settings.get(jid).duration, 604800);
});

test('history contact mappings connect phone and LID settings before first send', async () => {
  const settings = new DisappearingSettings();
  settings.observeChat({ id: alternate, ephemeralExpiration: 604800, ephemeralSettingTimestamp: 100 });
  settings.observeChat({ id: alternate, phoneNumber: jid });
  assert.deepEqual(await settings.options({}, jid), { ephemeralExpiration: 604800 });
});

test('phone and LID aliases share the newest setting and survive a restart privately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'disappearing-test-'));
  try {
    const file = path.join(root, 'private', 'settings.json');
    const settings = new DisappearingSettings(file); await settings.load();
    settings.observeMessage({ ...message(86400), key: { remoteJid: jid, remoteJidAlt: alternate } });
    settings.observeChat({ id: alternate, ephemeralExpiration: null, ephemeralSettingTimestamp: 200 });
    await settings.writes;
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    const restored = new DisappearingSettings(file); await restored.load();
    assert.deepEqual(await restored.options({}, jid), {});
    restored.observeChat({ id: alternate, ephemeralExpiration: 7776000, ephemeralSettingTimestamp: 300 });
    assert.deepEqual(await restored.options({}, jid), { ephemeralExpiration: 7776000 });
    assert.equal((await fs.readFile(file, 'utf8')).includes('fixture'), false);
    await restored.writes;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('group sends query the current group timer including turning it off', async () => {
  const settings = new DisappearingSettings(), group = '123-456@g.us';
  const socket = { groupMetadata: async () => ({ ephemeralDuration: 604800 }) };
  assert.deepEqual(await settings.options(socket, group), { ephemeralExpiration: 604800 });
  socket.groupMetadata = async () => ({});
  assert.deepEqual(await settings.options(socket, group), {});
});

test('an explicit settings probe requests history and the next send uses its timer', async () => {
  const settings = new DisappearingSettings(), calls = [];
  const anchor = { id: 'oldest-fixture', fromMe: true, timestampMs: 1794805200123 };
  const socket = {
    fetchMessageHistory: async (...args) => { calls.push(args); queueMicrotask(() => settings.observeMessage(message(7776000))); },
    sendMessage: async (...args) => { calls.push(args); }
  };
  await settings.options(socket, jid, anchor);
  await sendWithDisappearing(socket, settings, jid, { text: 'fixture' }, anchor);
  assert.deepEqual(calls[0], [20, { remoteJid: jid, id: anchor.id, fromMe: true }, 1794805200123]);
  assert.deepEqual(calls[1][2], { ephemeralExpiration: 7776000 });
  assert.equal(settings.waiters.size, 0);
});

test('unknown private timers send text and media immediately without requesting phone history', async () => {
  const settings = new DisappearingSettings(); const calls = [];
  const socket = {
    fetchMessageHistory: async () => { throw new Error('phone history must not be requested'); },
    sendMessage: async (...args) => { calls.push(args); return { key: { id: 'sent' } }; }
  };
  for (const content of [{ text: 'fixture' }, { document: Buffer.from('fixture'), fileName: 'fixture.txt' }]) {
    await sendWithDisappearing(socket, settings, jid, content, { id: 'fixture', timestampMs: 1794805200123 });
    assert.deepEqual(calls.at(-1), [jid, content, {}]);
  }
  assert.equal(calls.length, 2);
  assert.equal(settings.get(jid), undefined);
  settings.observeChat({ id: jid, ephemeralExpiration: 86400, ephemeralSettingTimestamp: 200 });
  await sendWithDisappearing(socket, settings, jid, { text: 'fixture' });
  assert.deepEqual(calls.at(-1)[2], { ephemeralExpiration: 86400 });
});

test('a failed group timer query sends using a cached timer when present or normal options when absent', async () => {
  const settings = new DisappearingSettings(), group = '123-456@g.us', calls = [];
  const socket = { groupMetadata: async () => { throw new Error('offline metadata'); }, sendMessage: async (...args) => { calls.push(args); } };
  await sendWithDisappearing(socket, settings, group, { text: 'fixture' });
  assert.deepEqual(calls.at(-1)[2], {});
  settings.set(group, 604800, 100);
  await sendWithDisappearing(socket, settings, group, { text: 'fixture' });
  assert.deepEqual(calls.at(-1)[2], { ephemeralExpiration: 604800 });
});

test('an explicit read-only settings probe still reports unknown without sending a message', async () => {
  const settings = new DisappearingSettings(); let sent = 0;
  const socket = { sendMessage: async () => { sent++; }, fetchMessageHistory: async () => { throw new Error('offline'); } };
  await assert.rejects(settings.options(socket, jid), /消息未发送/);
  await assert.rejects(settings.options(socket, jid, { id: 'fixture', timestampMs: 1794805200123 }), /offline/);
  assert.equal(settings.waiters.size, 0); assert.equal(sent, 0);
});
