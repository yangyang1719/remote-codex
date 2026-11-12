import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock
from server import Gateway, handler
import json
import urllib.request
import urllib.error


class TelegramGatewayTests(unittest.TestCase):
    def test_method_allowlist_and_live_ignore_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            gateway = Gateway(Path(folder) / 'messages.sqlite3', {})
            provider = Mock(platform='telegram')
            provider.call.return_value = {'status': 'connected', 'ignoredConversationIds': ['-100123']}
            gateway.providers['tg'] = provider
            gateway.telegram('setIgnored', {'ids': ['-100123']})
            self.assertEqual(provider.ignored_conversations, frozenset(['-100123']))
            with self.assertRaises(ValueError):
                gateway.telegram('send')
            gateway.store.db.close()
    def test_login_and_settings_are_desktop_only(self):
        with tempfile.TemporaryDirectory() as folder:
            gateway = Gateway(Path(folder) / 'messages.sqlite3', {})
            gateway.telegram = Mock(return_value={'status': 'standby'})
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler(gateway))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for method in ('GET', 'POST'):
                    data = json.dumps({'method': 'setIgnored', 'params': {'ids': []}}).encode() if method == 'POST' else None
                    for role in ('desktop', 'mcp'):
                        request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/telegram/auth', data=data,
                                                         headers={'X-Remote-Codex': role, 'Content-Type': 'application/json'})
                        if role == 'mcp':
                            with self.assertRaises(urllib.error.HTTPError) as error:
                                urllib.request.urlopen(request)
                            self.assertEqual(error.exception.code, 403)
                        else:
                            with urllib.request.urlopen(request) as response:
                                self.assertEqual(response.status, 200)
                self.assertEqual(gateway.telegram.call_count, 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
                gateway.store.db.close()
