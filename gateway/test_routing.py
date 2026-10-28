import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from server import Gateway
import routed_mcp_server as mcp


class Provider:
    status = 'connected'
    def __init__(self, platform):
        self.platform, self.calls, self.timeout = platform, [], False
    def send(self, external, text, key):
        self.calls.append((external, text, key))
        if self.timeout:
            raise TimeoutError('result unknown')
        return 'sent-' + key


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.gateway = Gateway(Path(self.temp.name)/'messages.sqlite3', {})
        self.wa, self.other, self.tg = Provider('whatsapp'), Provider('whatsapp'), Provider('telegram')
        self.gateway.providers.update({'wa': self.wa, 'other': self.other, 'tg': self.tg})
        self.chat = self.gateway.store.conversation('wa', 'whatsapp', {'externalId': 'one', 'name': '选中的群', 'type': 'group'})
        self.another = self.gateway.store.conversation('other', 'whatsapp', {'externalId': 'one', 'name': '同名另一账号', 'type': 'group'})
        self.telegram = self.gateway.store.conversation('tg', 'telegram', {'externalId': 'one', 'name': '另一平台', 'type': 'contact'})
        self.thread, self.turn = str(uuid.uuid4()), str(uuid.uuid4())
        self.caller = {'threadId': self.thread, 'turnId': self.turn}
    def tearDown(self):
        self.gateway.store.db.close(); self.temp.cleanup()
    def context(self, cid=None, platform='whatsapp', thread=None, turn=None):
        body = {'contextId': str(uuid.uuid4()), 'threadId': thread or self.thread, 'expectedTurnId': turn or self.turn,
                'platform': platform, 'conversationId': cid or self.chat, 'projectRoot': self.temp.name}
        return self.gateway.routes.create(body)['contextId']
    def body(self, context, **values):
        return {'contextId': context, 'caller': self.caller, **values}
    def test_route_is_immutable_and_account_platform_and_thread_are_exact(self):
        context = self.context(self.another)
        prepared = self.gateway.routes.prepare(self.body(context, text='仅发到当前账号'))
        self.gateway.routes.send(self.body(context, preparedId=prepared['preparedId'], conversationId=self.chat, text='wrong override'))
        self.assertEqual(self.wa.calls, [])
        self.assertEqual(self.other.calls[0][:2], ('one', '仅发到当前账号'))
        with self.assertRaises(ValueError):
            self.gateway.routes.read({'contextId': context, 'caller': {**self.caller, 'threadId': str(uuid.uuid4())}})
        with self.assertRaises(ValueError):
            self.gateway.routes.read({'contextId': context, 'caller': {**self.caller, 'turnId': str(uuid.uuid4())}})
    def test_later_request_blocks_old_prepared_message_and_telegram_never_falls_back(self):
        context = self.context()
        prepared = self.gateway.routes.prepare(self.body(context, text='旧请求'))
        new = self.gateway.routes.create({'contextId': str(uuid.uuid4()), 'threadId': self.thread,
               'expectedTurnId': self.turn, 'platform': 'telegram', 'conversationId': None, 'projectRoot': self.temp.name})
        self.assertFalse(new['target']['available'])
        with self.assertRaises(ValueError):
            self.gateway.routes.send(self.body(context, preparedId=prepared['preparedId']))
        with self.assertRaises(ValueError):
            self.gateway.routes.prepare(self.body(new['contextId'], text='不能转发到 WhatsApp'))
        self.assertEqual(self.wa.calls, [])
    def test_two_codex_threads_do_not_share_a_global_recipient(self):
        first = self.context()
        second_thread, second_turn = str(uuid.uuid4()), str(uuid.uuid4())
        second = self.context(self.telegram, 'telegram', second_thread, second_turn)
        a = self.gateway.routes.prepare(self.body(first, text='WA'))
        bbody = {'contextId': second, 'caller': {'threadId': second_thread, 'turnId': second_turn}}
        b = self.gateway.routes.prepare({**bbody, 'text': 'TG'})
        self.gateway.routes.send(self.body(first, preparedId=a['preparedId']))
        self.gateway.routes.send({**bbody, 'preparedId': b['preparedId']})
        self.assertEqual(self.wa.calls[0][1], 'WA'); self.assertEqual(self.tg.calls[0][1], 'TG')
    def test_prepare_and_send_are_idempotent_and_unknown_is_never_retried(self):
        context = self.context()
        first = self.gateway.routes.prepare(self.body(context, text='one'))
        again = self.gateway.routes.prepare(self.body(context, text='one'))
        self.assertEqual(first['preparedId'], again['preparedId'])
        sent = self.gateway.routes.send(self.body(context, preparedId=first['preparedId']))
        self.assertEqual(sent, self.gateway.routes.send(self.body(context, preparedId=first['preparedId'])))
        self.assertEqual(len(self.wa.calls), 1)
        self.wa.timeout = True
        other = self.gateway.routes.prepare(self.body(context, text='timeout'))
        with self.assertRaises(TimeoutError):
            self.gateway.routes.send(self.body(context, preparedId=other['preparedId']))
        with self.assertRaises(ValueError):
            self.gateway.routes.send(self.body(context, preparedId=other['preparedId']))
        self.assertEqual(len(self.wa.calls), 2)
        self.assertEqual(self.gateway.routes.send_status(self.body(context, preparedId=other['preparedId']))['state'], 'unknown')
    def test_early_mcp_can_bind_only_the_new_turn_started_after_snapshot(self):
        created = self.gateway.routes.create({'contextId': str(uuid.uuid4()), 'threadId': self.thread, 'platform': 'whatsapp',
                   'conversationId': self.chat, 'projectRoot': self.temp.name})
        context = created['contextId']
        with self.assertRaises(ValueError):
            self.gateway.routes.resolve(context, {**self.caller, 'turnStartedAt': 0})
        result = self.gateway.routes.resolve(context, {**self.caller, 'turnStartedAt': self.gateway.routes.now()})
        self.assertEqual(result['turnId'], self.turn)
        with self.assertRaises(ValueError):
            self.gateway.routes.resolve(context, {**self.caller, 'turnId': str(uuid.uuid4()), 'turnStartedAt': self.gateway.routes.now()})
    def test_mcp_uses_transport_identity_and_refuses_argument_recipient_or_identity(self):
        context = self.context()
        params = {'name': 'messages_current_context', 'arguments': {'contextId': context},
                  '_meta': {'threadId': self.thread, 'x-codex-turn-metadata': {'thread_id': self.thread, 'turn_id': self.turn}}}
        def api(path, body=None, **unused):
            return self.gateway.routes.resolve(body['contextId'], body['caller'], False)
        with patch.object(mcp, 'api', api):
            self.assertEqual(mcp.call(params)['target']['conversationId'], self.chat)
            for extra in ({'conversationId': self.telegram}, {'caller': self.caller}, {'_meta': params['_meta']}):
                with self.assertRaises(ValueError):mcp.call({**params, 'arguments': {**params['arguments'], **extra}})
            with self.assertRaises(ValueError):mcp.call({**params, '_meta': {}})
    def test_route_and_prepared_expiry_fail_without_sending(self):
        context = self.context()
        prepared = self.gateway.routes.prepare(self.body(context, text='expiry'))
        self.gateway.store.db.execute('UPDATE message_route_sends SET expires_at=0'); self.gateway.store.db.commit()
        with self.assertRaises(ValueError):self.gateway.routes.send(self.body(context, preparedId=prepared['preparedId']))
        self.gateway.store.db.execute('UPDATE message_route_contexts SET expires_at=0'); self.gateway.store.db.commit()
        with self.assertRaises(ValueError):self.gateway.routes.read(self.body(context))
        self.assertEqual(self.wa.calls, [])

    def test_automatic_context_lookup_is_bound_to_real_thread_turn_and_latest_request(self):
        context = self.context()
        self.assertEqual(self.gateway.routes.current({'caller': self.caller})['contextId'], context)
        with self.assertRaises(ValueError):
            self.gateway.routes.current({'caller': {**self.caller, 'turnId': str(uuid.uuid4())}})
        with self.assertRaises(ValueError):
            self.gateway.routes.current({'caller': {**self.caller, 'threadId': str(uuid.uuid4())}})
        self.gateway.routes.create({'contextId':str(uuid.uuid4()), 'threadId':self.thread, 'expectedTurnId':str(uuid.uuid4()), 'platform':'telegram', 'projectRoot':self.temp.name})
        with self.assertRaises(ValueError):
            self.gateway.routes.current({'caller': self.caller})


if __name__ == '__main__':
    unittest.main()
