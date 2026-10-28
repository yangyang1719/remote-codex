import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WhatsAppLink, pairingPhone } from '../auth.mjs';

test('phone numbers require country prefix and never trigger login on invalid input', () => {
  assert.equal(pairingPhone('+86 138-0013-8000'), '8613800138000');
  for (const value of ['123', '+00123456789', '86138abc123', '', null]) assert.throws(() => pairingPhone(value));
});
test('relink backs up old keys, waits saves, and keeps challenges only in memory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-auth-test-')), authDir = path.join(root, 'auth');
  await fs.mkdir(authDir); await fs.writeFile(path.join(authDir, 'creds.json'), 'old secret');
  let current = { state: { status: 'logged_out' }, credentialsSavePromise: Promise.resolve() }, replacements = 0;
  const link = new WhatsAppLink({ authDir, getRuntime: () => current, replaceRuntime: () => {
    replacements++;
    current = { state: { status: 'idle' }, credentialsSavePromise: Promise.resolve(), async startAuth() { this.state = { status: 'awaiting_qr_scan', authMode: 'qr', qr: 'RAW_NOT_EXPOSED', qrImage: 'displayOnly' }; return {}; }, async startPairingCode(number) { assert.equal(number, '8613800138000'); this.state = { status: 'awaiting_pairing_code', authMode: 'pairing_code' }; return { pairingCode: 'ABCD-1234' }; } };
    return current;
  } });
  try {
    const qr = await link.begin('qr'); assert.equal(qr.qrImage, 'displayOnly'); assert.ok(!JSON.stringify(qr).includes('RAW_NOT_EXPOSED'));
    await link.begin('qr'); assert.equal(replacements, 1, 'polling/repeated clicks do not reset pending login');
    const backup = (await fs.readdir(path.join(root, 'auth-backups')))[0];
    assert.equal(await fs.readFile(path.join(root, 'auth-backups', backup, 'creds.json'), 'utf8'), 'old secret');
    assert.equal((await fs.stat(path.join(root, 'auth-backups'))).mode & 0o777, 0o700);
    const phone = await link.begin('phone', '+86 13800138000'); assert.equal(phone.pairingCode, 'ABCD-1234');
    await link.begin('phone', '+86 13800138000'); assert.equal(replacements, 2);
    current.state.status = 'connected'; assert.equal(link.snapshot().pairingCode, null);
    await link.begin('qr'); assert.equal(replacements, 2, 'connected accounts must never be reset');
    assert.ok(!(await fs.readdir(root)).includes('phoneNumber'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('busy auth serializes rotation and a pending old save is archived before new auth', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-auth-lock-')), authDir = path.join(root, 'auth'); await fs.mkdir(authDir);
  let finish;
  let current = { state: { status: 'idle' }, credentialsSavePromise: new Promise(resolve => finish = resolve) };
  const link = new WhatsAppLink({ authDir, getRuntime: () => current, replaceRuntime: () => current = { state: { status: 'idle' }, async startAuth() { this.state.status = 'awaiting_qr_scan'; return {}; } } });
  try {
    const first = link.begin('qr'); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => link.begin('phone', '8613800138000'));
    await fs.writeFile(path.join(authDir, 'creds.json'), 'last old save'); finish(); await first;
    const dir = (await fs.readdir(path.join(root, 'auth-backups')))[0]; assert.equal(await fs.readFile(path.join(root, 'auth-backups', dir, 'creds.json'), 'utf8'), 'last old save');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
