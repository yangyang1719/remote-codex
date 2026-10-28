import hashlib
import io
import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path
from server import Gateway, handler
from media import LIMIT


class MediaProvider:
    status = 'connected'
    def __init__(self, cache):
        self.cache, self.calls = cache, []
        self.timeout = False
    def call(self, method, params, timeout=0):
        self.calls.append((method, params))
        if method == 'downloadMedia':
            target = self.cache.path(params['id']); target.parent.mkdir(mode=0o700, exist_ok=True)
            data = b'remote decoded media'; target.write_bytes(data)
            return {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        if self.timeout: raise TimeoutError('unknown send')
        return {'messageId': 'sent-' + str(len(self.calls))}


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.g = Gateway(Path(self.temp.name)/'messages.sqlite', {})
        self.cid = self.g.store.conversation('a', 'whatsapp', {'externalId': '1@g.us'})
        self.provider = MediaProvider(self.g.store.media)
        self.g.providers['a'] = self.provider
    def tearDown(self):
        self.g.store.db.close(); self.temp.cleanup()
    def upload(self, name='movie.mp4', mime='video/mp4', data=b'video'):
        return self.g.store.media.upload(self.cid, name, mime, io.BytesIO(data), len(data))
    def test_descriptor_persists_without_leaking_keys_and_download_is_cached(self):
        message = self.g.store.ingest(self.cid, {'externalId': 'one', 'text': '[图片]', 'media': {'kind': 'image', 'name': '../image.jpg', 'mime': 'image/jpeg', 'available': True}, '_mediaSource': 'SECRET_REMOTE_DESCRIPTOR'})
        self.assertNotIn('SECRET', json.dumps(message))
        self.assertNotIn('/', message['media']['name'])
        for _ in range(2):
            row, file = self.g.store.media.ready(message['media']['id'], self.g.providers)
            self.assertEqual(file.read_bytes(), b'remote decoded media')
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(self.g.store.media.row(row['id'])['source'], 'SECRET_REMOTE_DESCRIPTOR')
        self.assertEqual(self.g.store.media.root.stat().st_mode & 0o777, 0o700)
    def test_send_attachment_once_and_bind_key_to_bytes_and_recipient(self):
        media = self.upload(); body = {'conversationId': self.cid, 'text': '', 'mediaId': media['id'], 'idempotencyKey': 'one'}
        first = self.g.send(body)
        self.assertEqual(first, self.g.send(body)); self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(first['message']['media']['kind'], 'video')
        other = self.upload(data=b'changed')
        with self.assertRaises(ValueError): self.g.send({**body, 'mediaId': other['id']})
        cid = self.g.store.conversation('a', 'whatsapp', {'externalId': '2@g.us'})
        with self.assertRaises(ValueError): self.g.send({**body, 'conversationId': cid, 'idempotencyKey': 'two'})
    def test_unconfirmed_send_never_retries(self):
        self.provider.timeout = True
        body = {'conversationId': self.cid, 'text': '', 'mediaId': self.upload()['id'], 'idempotencyKey': 'unknown'}
        with self.assertRaises(TimeoutError): self.g.send(body)
        with self.assertRaises(RuntimeError): self.g.send(body)
        self.assertEqual(len(self.provider.calls), 1)
    def test_old_missing_view_once_revoked_or_modified_media_cannot_download(self):
        for available in [False, True]:
            m = self.g.store.ingest(self.cid, {'externalId': str(available), 'media': {'kind': 'audio', 'available': available}})
            with self.assertRaises(ValueError): self.g.store.media.ready(m['media']['id'], self.g.providers)
        media = self.upload(); row, file = self.g.store.media.ready(media['id'], self.g.providers); file.write_bytes(b'bad')
        with self.assertRaises(ValueError): self.g.store.media.ready(media['id'], self.g.providers)
        m = self.g.store.ingest(self.cid, {'externalId': 'revoke', 'media': {'kind': 'image'}, '_mediaSource': 'x'})
        self.g.store.patch(self.cid, {'externalId': 'revoke', 'text': '[撤回]', 'status': 'deleted'})
        with self.assertRaises(ValueError): self.g.store.media.ready(m['media']['id'], self.g.providers)
    def test_size_and_paths_are_limited(self):
        with self.assertRaises(ValueError): self.g.store.media.upload(self.cid, 'big', '', io.BytesIO(), LIMIT + 1)
        with self.assertRaises(ValueError): self.g.store.media.upload(self.cid, 'short', '', io.BytesIO(b'a'), 2)
        with self.assertRaises(ValueError): self.g.store.media.row('../../etc/passwd')
        media = self.upload(); target = self.g.store.media.path(media['id']); target.unlink(); target.symlink_to('/etc/passwd')
        with self.assertRaises(ValueError): self.g.store.media.ready(media['id'], self.g.providers)
    def test_binary_http_upload_download_and_browser_rejection(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.g))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def api(path, body=None, headers=None):
            request = urllib.request.Request('http://127.0.0.1:' + str(server.server_port) + path, data=body, headers={'X-Remote-Codex': 'desktop', **(headers or {})})
            return urllib.request.urlopen(request, timeout=5)
        try:
            data = b'binary\x00\xff'
            with api('/media/upload?conversation_id=' + self.cid + '&name=audio.ogg', data, {'Content-Type': 'audio/ogg'}) as response:
                media = json.load(response)['media']
            with api('/media/' + media['id']) as response:
                self.assertEqual(response.read(), data)
                self.assertEqual(response.headers['X-Content-SHA256'], hashlib.sha256(data).hexdigest())
            with self.assertRaises(urllib.error.HTTPError) as error:
                api('/media/' + media['id'], headers={'Origin': 'https://untrusted.invalid'})
            self.assertEqual(error.exception.code, 403)
        finally:
            server.shutdown(); server.server_close()


if __name__ == '__main__': unittest.main()
