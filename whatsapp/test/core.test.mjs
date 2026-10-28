import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRPC, normalizedMessage, usableJid } from '../core.mjs';

test('does not import status/broadcast/newsletter events into private conversations', () => {
  for (const jid of ['status@broadcast', 'news@newsletter', '', 'x;command']) assert.equal(usableJid(jid), false);
});
test('unwraps one reply and preserves its platform id, sender, chat and direction', () => {
  const result = normalizedMessage({ key: { remoteJid: '123@g.us', id: 'm1', participant: '5@s.whatsapp.net' }, pushName: 'Alice', messageTimestamp: 1000, message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'one reply' } } } } }, new Map([['123@g.us', 'Team']]));
  assert.equal(result.message.text, 'one reply'); assert.equal(result.message.externalId, 'm1'); assert.equal(result.message.author, 'Alice'); assert.equal(result.message.timestamp, 1000000); assert.equal(result.conversation.name, 'Team'); assert.equal(result.message.direction, 'incoming');
});
test('own outgoing messages are stored as outgoing', () => {
  const result = normalizedMessage({ key: { remoteJid: '5@s.whatsapp.net', id: 'm2', fromMe: true }, message: { conversation: 'sent' } });
  assert.equal(result.message.direction, 'outgoing'); assert.equal(result.message.author, '你');
});
test('media content is labeled without downloading or executing attachments', () => {
  const result = normalizedMessage({ key: { remoteJid: '1@lid', id: 'm3' }, message: { imageMessage: { caption: 'look' } } });
  assert.equal(result.message.text, '[图片] look');
});
test('protocol-only messages do not create fake chat messages', () => {
  assert.equal(normalizedMessage({ key: { remoteJid: '1@g.us', id: 'm4' }, message: { protocolMessage: {} } }), null);
});
test('RPC dispatch does not allow arbitrary runtime method access', () => {
  assert.equal(allowedRPC('send'), true); assert.equal(allowedRPC('clearInvalidCredentials'), false); assert.equal(allowedRPC('__proto__'), false);
});
