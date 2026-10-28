import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { MediaFiles } from '../media.mjs';
import { mediaInfo, MEDIA_LIMIT } from '../core.mjs';

test('all four media types retain metadata but view-once and oversized sources are unavailable', () => {
  for (const [name, kind] of [['imageMessage', 'image'], ['documentMessage', 'document'], ['videoMessage', 'video'], ['audioMessage', 'audio']]) {
    assert.equal(mediaInfo({ [name]: { fileName: '../bad\nname', fileLength: 12, mimetype: kind + '/test' } }).kind, kind);
    assert.equal(mediaInfo({ viewOnceMessageV2: { message: { [name]: { fileLength: 12 } } } }).available, false);
    assert.equal(mediaInfo({ [name]: { fileLength: MEDIA_LIMIT + 1 } }).available, false);
    assert.ok(!mediaInfo({ [name]: { fileName: '../bad\nname' } }).name.includes('/'));
  }
});
test('streamed media is checked, bounded, and forwarded with correct fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-media-test-')), media = new MediaFiles(root), id = randomUUID();
  const raw = { key: { remoteJid: '1@g.us', id: 'm' }, message: { imageMessage: { fileLength: 6, url: 'https://mmg.whatsapp.net/file' } } };
  const params = { id, source: 'eA==', externalId: '1@g.us', messageId: 'm' };
  try {
    const result = await media.download(params, () => raw, async () => Readable.from([Buffer.from('image!')]), {});
    assert.equal(result.size, 6);
    for (const kind of ['image', 'video', 'audio', 'document']) {
      const content = await media.content({ text: '', media: { id, kind, name: 'clip', mime: kind + '/test', ...result } });
      assert.ok(Buffer.isBuffer(content[kind]));
    }
    const captioned = await media.content({ text: 'caption', media: { id, kind: 'audio', name: 'voice.ogg', ...result } });
    assert.ok(captioned.document); assert.equal(captioned.caption, 'caption');
    await assert.rejects(() => media.download(params, () => ({ ...raw, message: { imageMessage: { url: 'http://127.0.0.1/private' } } }), () => {}, {}));
    await assert.rejects(() => media.download({ ...params, externalId: '2@g.us' }, () => raw, () => {}, {}));
    await assert.rejects(() => media.content({ media: { id, kind: 'video', size: 6, sha256: 'invalid' } }));
    await assert.rejects(() => media.download({ ...params, id: randomUUID() }, () => raw, async () => Readable.from([Buffer.alloc(MEDIA_LIMIT + 1)]), {}));
    assert.equal((await fs.readdir(path.join(root, id))).includes('content'), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
