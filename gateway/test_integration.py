import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from server import Gateway, handler


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        fixture = Path(__file__).resolve().parents[1]/'whatsapp/test/provider-fixture.py'
        self.gateway = Gateway(Path(self.temp.name)/'test.sqlite', {'providers': [{'id': 'offline', 'platform': 'whatsapp', 'command': [sys.executable, str(fixture)]}]})
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.gateway))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        for p in self.gateway.providers.values():
            p.proc.terminate()
            p.proc.wait(timeout=5)
        self.gateway.store.db.close()
        self.temp.cleanup()
    def api(self, path, body=None, origin=None, role='desktop'):
        headers = {'X-Remote-Codex': role, 'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}'+path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    def connect(self):
        self.api('/whatsapp/call', {'method': 'connect'})
        for _ in range(50):
            rows = self.api('/conversations')['conversations']
            if rows:
                return rows[0]['id']
            time.sleep(.01)
        self.fail('worker event did not persist')
    def test_standby_status_then_message_ingest_and_idempotent_send(self):
        self.assertEqual(self.api('/whatsapp/status')['status'], 'standby')
        cid = self.connect()
        self.assertEqual(self.api('/messages?conversation_id='+cid)['messages'][0]['text'], 'offline-only')
        body = {'conversationId': cid, 'text': 'test reply', 'idempotencyKey': 'fixture-key'}
        self.assertEqual(self.api('/messages/send', body), self.api('/messages/send', body))
        self.assertEqual(len(self.api('/messages?conversation_id='+cid)['messages']), 2)
    def test_browser_origins_and_unknown_runtime_methods_are_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.api('/conversations', origin='https://untrusted.example')
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.api('/whatsapp/call', {'method': 'clearInvalidCredentials'})
        self.assertEqual(error.exception.code, 400)
    def test_websocket_receives_persisted_event_notification(self):
        key = base64.b64encode(b'0123456789abcdef').decode()
        with socket.create_connection(('127.0.0.1', self.port), timeout=5) as client:
            client.sendall((f'GET /events HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nX-Remote-Codex: desktop\r\n\r\n').encode())
            headers = b''
            while b'\r\n\r\n' not in headers:
                headers += client.recv(1)
            self.assertIn(b'101 Switching Protocols', headers)
            self.connect()
            frame = client.recv(2)
            self.assertEqual(frame[0], 0x81)
            length = frame[1] & 127
            if length == 126:
                length = int.from_bytes(client.recv(2), 'big')
            payload = b''
            while len(payload) < length:
                payload += client.recv(length-len(payload))
            event = json.loads(payload)
            self.assertIn(event['type'], ('message', 'providerStatus'))

    def test_mcp_cannot_bypass_route_using_legacy_send_or_create_desktop_context(self):
        for path, body in [('/messages/send', {'conversationId':'wrong','text':'never send'}),
                           ('/whatsapp/call', {'method':'sendText','text':'never send'}),
                           ('/routing/context/create', {})]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.api(path, body, role='mcp')
            self.assertEqual(error.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.api('/routing/current', {}, role='desktop')
        self.assertEqual(error.exception.code, 403)


class LifecycleTests(unittest.TestCase):
    def test_sigterm_stops_and_reaps_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(__file__).resolve().parents[1]
            pid_file, config = Path(folder)/'worker.pid', Path(folder)/'config.json'
            config.write_text(json.dumps({'providers': [{'id': 'offline', 'platform': 'whatsapp',
                'command': [sys.executable, str(root/'whatsapp/test/provider-fixture.py')],
                'environment': {'FIXTURE_PID_PATH': str(pid_file)}}]}))
            with socket.socket() as reserve:
                reserve.bind(('127.0.0.1', 0))
                port = reserve.getsockname()[1]
            proc = subprocess.Popen([sys.executable, str(root/'gateway/server.py'), '--port', str(port),
                '--state', folder, '--config', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                for _ in range(100):
                    try:
                        request = urllib.request.Request(f'http://127.0.0.1:{port}/health', headers={'X-Remote-Codex': 'desktop'})
                        with urllib.request.urlopen(request, timeout=.1):
                            pass
                        if pid_file.exists():
                            break
                    except (OSError, urllib.error.URLError):
                        pass
                    time.sleep(.02)
                self.assertTrue(pid_file.exists(), 'fixture did not start')
                worker_pid = int(pid_file.read_text())
                proc.terminate()
                _, error = proc.communicate(timeout=6)
                self.assertEqual(proc.returncode, 0, error.decode())
                with self.assertRaises(ProcessLookupError):
                    os.kill(worker_pid, 0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                proc.stderr.close()


if __name__ == '__main__':
    unittest.main()
