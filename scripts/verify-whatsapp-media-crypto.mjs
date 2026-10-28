// Account-free acceptance against the exact Baileys installed on the remote host.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createCipheriv, createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = process.argv[2];
const { getMediaKeys, downloadMediaMessage, proto } = await import(pathToFileURL(path.join(root, 'whatsapp/node_modules/@whiskeysockets/baileys/lib/index.js')));
const { MediaFiles } = await import(pathToFileURL(path.join(root, 'whatsapp/media.mjs')));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-codex-media-crypto-'));
const files = new MediaFiles(dir), routes = new Map();
const server = createServer((req, res) => { const data = routes.get(req.url); if (!data) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' }); res.end(data); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const kind of ['image', 'video', 'audio', 'document']) {
    const plain = Buffer.concat([Buffer.from('account-free-' + kind), randomBytes(4096)]), mediaKey = randomBytes(32);
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, kind);
    const cipher = createCipheriv('aes-256-cbc', cipherKey, iv), encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const mac = createHmac('sha256', macKey).update(Buffer.concat([iv, encrypted])).digest().subarray(0, 10);
    routes.set('/' + kind, Buffer.concat([encrypted, mac]));
    const raw = { key: { remoteJid: '123@g.us', id: kind }, message: { [kind + 'Message']: { url: 'https://mmg.whatsapp.net/' + kind, mediaKey, fileLength: plain.length, mimetype: kind === 'document' ? 'text/plain' : kind + '/test' } } };
    const id = randomUUID(), source = Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString('base64');
    const result = await files.download({ id, source, externalId: '123@g.us', messageId: kind }, bytes => proto.WebMessageInfo.decode(bytes), (message, ...args) => { message.message[kind + 'Message'].url = `http://127.0.0.1:${server.address().port}/${kind}`; return downloadMediaMessage(message, ...args); }, { updateMediaMessage: () => { throw new Error('unexpected reupload'); } });
    assert.deepEqual(await files.checked(id, result.size, result.sha256), plain);
    assert.equal(result.sha256, createHash('sha256').update(plain).digest('hex'));
  }
  process.stdout.write(JSON.stringify({ installedBaileys: true, encryptedRoundTrip: ['image', 'video', 'audio', 'document'], whatsappConnections: 0, contactSends: 0 }) + '\n');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
