import tempfile
import unittest
from pathlib import Path
from server import Gateway, Provider
from mcp_server import TOOLS


class FakeProvider:
    status = 'connected'
    def __init__(self):
        self.count = 0
        self.timeout = False
    def send(self, external, text, key):
        self.count += 1
        if self.timeout:
            raise TimeoutError('unconfirmed')
        return 'platform-' + key


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.gateway = Gateway(Path(self.temp.name)/'test.sqlite', {})
        self.store = self.gateway.store
        self.cid = self.store.conversation('one', 'whatsapp', {'externalId': 'group', 'name': 'Group', 'type': 'group'})
        self.provider = FakeProvider()
        self.gateway.providers['one'] = self.provider
    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()
    def test_replayed_inbound_message_deduplicates_and_updates(self):
        self.store.ingest(self.cid, {'externalId': 'm1', 'text': 'before', 'timestamp': 1000})
        self.store.ingest(self.cid, {'externalId': 'm1', 'text': 'edited', 'timestamp': 1000})
        self.assertEqual([m['text'] for m in self.store.messages(self.cid)], ['edited'])
    def test_out_of_order_event_does_not_rewind_preview(self):
        self.store.ingest(self.cid, {'externalId': 'new', 'text': 'new', 'timestamp': 2000})
        self.store.ingest(self.cid, {'externalId': 'old', 'text': 'old', 'timestamp': 1000})
        self.assertEqual(self.store.get_conversation(self.cid)['lastMessage'], 'new')
    def test_inbox_counts_are_incoming_only_deduplicated_and_match_message_snapshot(self):
        self.store.ingest(self.cid, {'externalId': 'incoming', 'text': 'first', 'timestamp': 1000})
        self.store.ingest(self.cid, {'externalId': 'incoming', 'text': 'edited', 'timestamp': 1000})
        self.store.ingest(self.cid, {'externalId': 'outgoing', 'text': 'reply', 'direction': 'outgoing', 'timestamp': 3000})
        self.store.ingest(self.cid, {'externalId': 'older', 'text': 'older', 'timestamp': 500})
        row = self.store.get_conversation(self.cid)
        self.assertEqual((row['incomingCount'], row['messageCount'], row['lastMessageAt']), (2, 3, 3000))
        snapshot = self.store.message_snapshot(self.cid)
        self.assertEqual(snapshot['incomingCount'], 2)
        self.assertEqual(len(snapshot['messages']), 3)
        empty = self.store.conversation('one', 'whatsapp', {'externalId': 'empty', 'updatedAt': 999999})
        self.assertEqual(self.store.conversations()[-1]['id'], empty)
        self.assertEqual(self.store.get_conversation(empty)['messageCount'], 0)
    def test_duplicate_click_sends_once(self):
        body = {'conversationId': self.cid, 'text': 'hello', 'idempotencyKey': 'key'}
        first = self.gateway.send(body)
        self.assertEqual(self.gateway.send(body), first)
        self.assertEqual(self.provider.count, 1)
    def test_same_key_cannot_change_recipient_or_text(self):
        self.gateway.send({'conversationId': self.cid, 'text': 'hello', 'idempotencyKey': 'key'})
        with self.assertRaises(ValueError):
            self.gateway.send({'conversationId': self.cid, 'text': 'different', 'idempotencyKey': 'key'})
        self.assertEqual(self.provider.count, 1)
    def test_timeout_is_not_automatically_retried(self):
        self.provider.timeout = True
        body = {'conversationId': self.cid, 'text': 'hello', 'idempotencyKey': 'uncertain'}
        with self.assertRaises(TimeoutError):
            self.gateway.send(body)
        with self.assertRaises(RuntimeError):
            self.gateway.send(body)
        self.assertEqual(self.provider.count, 1)
    def test_mcp_prepares_without_sending(self):
        self.store.prepare(self.cid, 'review this')
        self.assertEqual(self.provider.count, 0)
        self.assertEqual(len(self.store.drafts(self.cid)), 1)
        self.assertFalse(any(tool['name'].endswith('_send') for tool in TOOLS))
    def test_unconnected_account_cannot_report_send_success(self):
        self.gateway.providers.clear()
        with self.assertRaises(RuntimeError):
            self.gateway.send({'conversationId': self.cid, 'text': 'hello', 'idempotencyKey': 'no'})
        self.assertEqual(self.store.messages(self.cid), [])

    def test_whatsapp_history_anchor_uses_latest_message_in_the_target_chat(self):
        provider = Provider.__new__(Provider)
        provider.platform, provider.account, provider.store = 'whatsapp', 'one', self.store
        self.assertIsNone(provider.message_anchor('group'))
        self.store.ingest(self.cid, {'externalId': 'new', 'text': 'fixture', 'direction': 'outgoing', 'timestamp': 3500})
        self.store.ingest(self.cid, {'externalId': 'old', 'text': 'fixture', 'timestamp': 1000})
        self.assertEqual(provider.message_anchor('group'), {'id': 'new', 'fromMe': True, 'timestampMs': 3500})
        self.assertIsNone(provider.message_anchor('other'))
        provider.platform = 'telegram'
        self.assertIsNone(provider.message_anchor('group'))

    def test_read_only_settings_query_uses_server_anchor_without_reserving_a_send(self):
        provider = Provider.__new__(Provider)
        provider.platform, provider.account, provider.store = 'whatsapp', 'one', self.store
        self.store.ingest(self.cid, {'externalId': 'fixture', 'text': 'fixture', 'timestamp': 1794805200123})
        calls = []
        def call(method, params, timeout):
            calls.append((method, params))
            return {'known': True, 'ephemeralExpiration': 86400}
        provider.call = call
        self.gateway.providers['one'] = provider
        self.assertEqual(self.gateway.whatsapp('chatSettings', {'externalId': 'group', 'anchor': {'timestampMs': 1}}),
                         {'known': True, 'ephemeralExpiration': 86400})
        self.assertEqual(calls, [('chatSettings', {'externalId': 'group',
                         'anchor': {'id': 'fixture', 'fromMe': False, 'timestampMs': 1794805200123}})])
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM sends').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
