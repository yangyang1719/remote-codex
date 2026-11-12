import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from server import Provider, Store, Events


class IgnoreTests(unittest.TestCase):
    def test_ignored_telegram_events_never_reach_storage_or_notifications(self):
        with tempfile.TemporaryDirectory() as directory:
            store, events = Store(Path(directory) / 'messages.sqlite3'), Events()
            provider = Provider.__new__(Provider)
            provider.account, provider.platform = 'one', 'telegram'
            provider.store, provider.events = store, events
            provider.pending, provider.lock = {}, threading.Lock()
            provider.ignored_conversations = frozenset(['-100123'])
            values = []
            for kind in ('conversation', 'message', 'messageUpdate'):
                values.append({'type': kind, 'conversation': {'externalId': '-100123'},
                               'message': {'externalId': 'm1', 'text': 'ignored secret',
                                           'media': {'kind': 'image'}}})
            values.append({'type': 'message', 'conversation': {'externalId': '-100456'},
                           'message': {'externalId': 'm2', 'text': 'keep'}})
            provider.proc = SimpleNamespace(stdout=io.StringIO('\n'.join(map(json.dumps, values))))
            with patch.object(events, 'publish') as publish:
                provider.read()
                notifications = [call.args[0] for call in publish.call_args_list if call.args[0]['type'] != 'providerStatus']
                self.assertEqual(len(notifications), 1)
                self.assertEqual(notifications[0]['conversationId'], 'telegram:one:-100456')
            self.assertEqual([c['externalId'] for c in store.conversations()], ['-100456'])
            self.assertEqual(store.db.execute('SELECT text FROM messages').fetchall()[0][0], 'keep')
            store.db.close()

    def test_configuration_is_account_scoped_and_whatsapp_unaffected(self):
        for platform, expected in [('telegram', frozenset(['123'])), ('whatsapp', frozenset())]:
            with patch('server.subprocess.Popen'), patch('server.threading.Thread'):
                provider = Provider({'id': 'one', 'platform': platform, 'command': ['fixture'],
                                     'ignoredConversationIds': ['123']},
                                    SimpleNamespace(media=SimpleNamespace(root=Path('/tmp/media'))), Events())
                self.assertEqual(provider.ignored_conversations, expected)
        with self.assertRaises(ValueError), patch('server.subprocess.Popen') as spawn:
            Provider({'id': 'one', 'platform': 'telegram', 'ignoredConversationIds': '123'}, None, None)
        spawn.assert_not_called()
