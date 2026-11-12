import asyncio
import datetime
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from worker import Worker, chat_id


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.client = SimpleNamespace(is_user_authorized=AsyncMock(return_value=False),
                                      send_code_request=AsyncMock(return_value=SimpleNamespace(phone_code_hash='private')),
                                      sign_in=AsyncMock(), qr_login=AsyncMock())
        self.worker = Worker(self.client, self.root, self.root / 'media')
        self.emitter = patch('worker.emit')
        self.emit = self.emitter.start()
    async def asyncTearDown(self):
        await self.worker.cancel_qr()
        self.emitter.stop()
        self.temp.cleanup()
    async def test_phone_code_then_password_then_authorized(self):
        from telethon.errors import SessionPasswordNeededError
        await self.worker.call('sendCode', {'phone': '+8613800138000'})
        self.assertEqual(self.worker.status, 'awaiting_code')
        self.client.sign_in.side_effect = SessionPasswordNeededError(None)
        await self.worker.call('signIn', {'code': '12345'})
        self.assertEqual(self.worker.status, 'awaiting_password')
        self.client.sign_in.side_effect = None
        with patch.object(self.worker, 'sync', new_callable=AsyncMock):
            result = await self.worker.call('password', {'password': 'secret'})
            await self.worker.sync_task
        self.assertEqual(result['status'], 'connected')
        self.assertIsNone(self.worker.phone)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('secret', json.dumps(result))
    async def test_sign_in_requires_prior_challenge(self):
        with self.assertRaises(ValueError):
            await self.worker.call('signIn', {'code': '12345'})
        self.client.sign_in.assert_not_awaited()
    async def test_qr_image_and_expiration(self):
        qr = SimpleNamespace(url='tg://login?token=offline-test', wait=AsyncMock(side_effect=asyncio.TimeoutError))
        self.client.qr_login.return_value = qr
        await self.worker.call('startQR', {})
        await self.worker.auth_task
        self.assertEqual(self.worker.status, 'qr_expired')
        self.assertIsNone(self.worker.qr_image)
    async def test_qr_requires_password(self):
        from telethon.errors import SessionPasswordNeededError
        qr = SimpleNamespace(url='tg://login?token=offline-test', wait=AsyncMock(side_effect=SessionPasswordNeededError(None)))
        self.client.qr_login.return_value = qr
        await self.worker.call('startQR', {})
        await self.worker.auth_task
        self.assertEqual(self.worker.status, 'awaiting_password')
    async def test_ignored_message_returns_before_fetching_entity(self):
        await self.worker.call('setIgnored', {'ids': ['-100123']})
        message = SimpleNamespace(chat_id=-100123, get_chat=AsyncMock())
        await self.worker.publish(message)
        message.get_chat.assert_not_awaited()
        self.emit.assert_not_called()
    async def test_ignore_survives_restart_and_removal_blocks_old_history(self):
        await self.worker.call('setIgnored', {'ids': ['-100123']})
        restored = Worker(self.client, self.root, self.root / 'media')
        self.assertEqual(restored.ignored, {'-100123'})
        await restored.call('setIgnored', {'ids': []})
        restored = Worker(self.client, self.root, self.root / 'media')
        message = SimpleNamespace(chat_id=-100123, date=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc), get_chat=AsyncMock())
        await restored.publish(message)
        message.get_chat.assert_not_awaited()
    async def test_ignore_download_before_any_api_call(self):
        self.worker.status = 'connected'
        self.worker.ignored.add('-100123')
        with self.assertRaises(ValueError):
            await self.worker.call('downloadMedia', {'externalId': '-100123'})
    async def test_ignore_validation_does_not_overwrite_file(self):
        await self.worker.call('setIgnored', {'ids': ['-100123']})
        before = (self.root / 'ignored.json').read_text()
        with self.assertRaises(ValueError):
            await self.worker.call('setIgnored', {'ids': ['not-an-id']})
        self.assertEqual((self.root / 'ignored.json').read_text(), before)
    async def test_auth_only_never_publishes_messages_or_starts_history(self):
        self.worker.auth_only = True
        await self.worker.publish(object())
        self.emit.assert_not_called()
        with patch.object(self.worker, 'sync', new_callable=AsyncMock) as sync:
            await self.worker.authorized()
            self.assertIsNone(self.worker.sync_task)
            sync.assert_not_awaited()
        self.assertEqual(self.worker.status, 'connected')

    async def test_send_reuses_random_id_and_preserves_plain_text(self):
        from telethon.tl.types import UpdateShortSentMessage
        requests = []
        class Client:
            async def get_input_entity(self, cid):
                from telethon.tl.types import InputPeerUser
                return InputPeerUser(cid, 0)
            async def __call__(self, request):
                requests.append(request)
                return UpdateShortSentMessage(id=7, pts=1, pts_count=1,
                                              date=datetime.datetime.now(datetime.timezone.utc), out=True)
        self.worker.client = Client()
        self.worker.status = 'connected'
        params = {'externalId': '123', 'idempotencyKey': 'same-key', 'text': '**literal**'}
        self.assertEqual(await self.worker.call('send', params), {'messageId': '7'})
        await self.worker.call('send', params)
        self.assertEqual(requests[0].random_id, requests[1].random_id)
        self.assertEqual(requests[0].message, '**literal**')

    async def test_media_is_described_without_downloading(self):
        from telethon.tl.types import User
        message = SimpleNamespace(chat_id=123, id=8, sender_id=123, out=False,
                                  message='caption', date=datetime.datetime.now(datetime.timezone.utc),
                                  file=SimpleNamespace(mime_type='image/jpeg', name=None, size=1024, ext='.jpg'),
                                  photo=object(), document=None)
        await self.worker.publish(message, User(id=123, first_name='Test'))
        event = self.emit.call_args.args[0]
        self.assertEqual(event['message']['media']['kind'], 'image')
        self.assertEqual(event['message']['_mediaSource'], '{"chat": "123", "message": 8}')
        self.assertEqual(event['conversation']['externalId'], '123')

    async def test_bootstrap_skips_ignored_history(self):
        self.worker.ignored.add('-100123')
        async def dialogs():
            yield SimpleNamespace(id=-100123, entity=object())
            yield SimpleNamespace(id=-100456, entity=object())
        async def messages(entity, limit):
            self.assertEqual(limit, 50)
            if False:
                yield
        self.client.iter_dialogs = dialogs
        self.client.iter_messages = __import__('unittest.mock', fromlist=['Mock']).Mock(side_effect=messages)
        with patch.object(self.worker, 'conversation', return_value={}):
            await self.worker.sync()
        self.assertEqual(self.client.iter_messages.call_count, 1)


class IdTests(unittest.TestCase):
    def test_ids_normalize(self):
        self.assertEqual(chat_id('-100123'), '-100123')
        for value in ('0', '', 'group', '--1'):
            with self.assertRaises(ValueError):
                chat_id(value)
