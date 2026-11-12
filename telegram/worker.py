#!/usr/bin/env python3
"""Private Telegram user-account worker. stdout is gateway JSON only."""
import asyncio
import contextlib
import hashlib
import io
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

LIMIT = 25 * 1024 * 1024


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class WorkerError(ValueError):
    pass


def chat_id(value):
    value = str(value)
    if not value.lstrip('-').isdigit() or value in ('', '-', '0'):
        raise WorkerError('聊天 ID 必须是非零数字。')
    return str(int(value))


class Worker:
    def __init__(self, client, root, media):
        self.client, self.root, self.media = client, root, media
        self.auth_only = os.environ.get('TELEGRAM_AUTH_ONLY') == '1'
        self.status, self.phone, self.code_hash = 'standby', None, None
        self.qr_image, self.auth_task, self.sync_task = None, None, None
        self.auth_lock = asyncio.Lock()
        config = root / 'ignored.json'
        settings = json.loads(config.read_text()) if config.exists() else {}
        if config.exists():
            ids = settings.get('ids', []) if isinstance(settings, dict) else settings
        else:
            ids = json.loads(os.environ.get('TELEGRAM_IGNORED_CONVERSATIONS', '[]'))
        self.resume_after = settings.get('resumeAfter', {}) if isinstance(settings, dict) else {}
        if not isinstance(ids, list):
            raise WorkerError('忽略名单格式无效。')
        self.ignored = {chat_id(x) for x in ids}

    def snapshot(self):
        return {'status': self.status, 'qrImage': self.qr_image,
                'ignoredConversationIds': sorted(self.ignored)}

    def state(self, status):
        self.status = status
        emit({'type': 'status', 'status': status, 'ignoredConversationIds': sorted(self.ignored)})

    def conversation(self, entity):
        from telethon import utils
        return {'externalId': str(utils.get_peer_id(entity)),
                'name': utils.get_display_name(entity),
                'type': 'channel' if getattr(entity, 'broadcast', False) else
                        'group' if getattr(entity, 'megagroup', False) or entity.__class__.__name__ == 'Chat' else 'contact'}

    async def publish(self, message, entity=None, kind='message'):
        if self.auth_only:
            return
        cid = str(message.chat_id)
        if cid in self.ignored or message.date.timestamp() <= self.resume_after.get(cid, 0):
            return
        entity = entity or await message.get_chat()
        if cid in self.ignored:
            return
        value = {'externalId': str(message.id), 'text': message.message or '',
                 'author': str(message.sender_id or ''),
                 'direction': 'outgoing' if message.out else 'incoming',
                 'timestamp': int(message.date.timestamp() * 1000),
                 'status': 'edited' if kind == 'messageUpdate' else 'sent' if message.out else 'received'}
        file = message.file
        if file and (message.photo or message.document):
            mime = file.mime_type or 'application/octet-stream'
            media_kind = next((x for x in ('image', 'video', 'audio') if mime.startswith(x + '/')), 'document')
            value['media'] = {'kind': media_kind, 'name': file.name or ('telegram-' + str(message.id) + (file.ext or '')),
                              'mime': mime, 'size': file.size or 0,
                              'available': bool(file.size and file.size <= LIMIT)}
            value['_mediaSource'] = json.dumps({'chat': cid, 'message': message.id})
        emit({'type': kind, 'conversation': self.conversation(entity), 'message': value})

    async def sync(self):
        # Limit bootstrap to 50 messages per non-ignored dialog; never download media here.
        try:
            async for dialog in self.client.iter_dialogs():
                cid = str(dialog.id)
                emit({'type': 'conversation', 'conversation': self.conversation(dialog.entity)})
                if cid in self.ignored:
                    continue
                async for message in self.client.iter_messages(dialog.entity, limit=50):
                    if message.date.timestamp() > self.resume_after.get(cid, 0):
                        await self.publish(message, dialog.entity)
        except asyncio.CancelledError:
            raise
        except Exception:
            emit({'type': 'status', 'status': self.status, 'syncError': '历史同步未完成，可重新连接后重试。'})

    async def authorized(self):
        self.phone = self.code_hash = self.qr_image = None
        self.state('connected')
        if not self.auth_only and (not self.sync_task or self.sync_task.done()):
            self.sync_task = asyncio.create_task(self.sync())

    async def qr_wait(self, qr):
        from telethon.errors import SessionPasswordNeededError
        try:
            await qr.wait()
            await self.authorized()
        except SessionPasswordNeededError:
            self.qr_image = None
            self.state('awaiting_password')
        except asyncio.TimeoutError:
            self.qr_image = None
            self.state('qr_expired')
        except asyncio.CancelledError:
            raise
        except Exception:
            self.qr_image = None
            self.state('auth_failed')

    async def cancel_qr(self):
        if self.auth_task and not self.auth_task.done():
            self.auth_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.auth_task
        self.qr_image = None

    async def call(self, method, params):
        if method == 'status':
            return self.snapshot()
        if method == 'setIgnored':
            ids = params.get('ids')
            if not isinstance(ids, list) or len(ids) > 10000:
                raise WorkerError('忽略名单必须是聊天 ID 列表。')
            ignored = {chat_id(x) for x in ids}
            target = self.root / 'ignored.json'
            temp = self.root / 'ignored.json.tmp'
            resume_after = dict(self.resume_after)
            for cid in self.ignored - ignored:
                resume_after[cid] = time.time()
            temp.write_text(json.dumps({'ids': sorted(ignored), 'resumeAfter': resume_after}))
            temp.replace(target)
            self.ignored = ignored
            self.resume_after = resume_after
            return self.snapshot()
        if method in ('startQR', 'sendCode', 'signIn', 'password'):
            async with self.auth_lock:
                if await self.client.is_user_authorized():
                    await self.authorized()
                    return self.snapshot()
                if method in ('startQR', 'sendCode'):
                    await self.cancel_qr()
                    self.phone = self.code_hash = None
                if method == 'startQR':
                    import qrcode
                    import base64
                    qr = await self.client.qr_login()
                    output = io.BytesIO()
                    from qrcode.image.svg import SvgPathImage
                    qrcode.make(qr.url, image_factory=SvgPathImage).save(output)
                    self.qr_image = base64.b64encode(output.getvalue()).decode()
                    self.state('awaiting_qr_scan')
                    self.auth_task = asyncio.create_task(self.qr_wait(qr))
                    # Register the token listener before returning the image.
                    await asyncio.sleep(0)
                elif method == 'sendCode':
                    phone = params.get('phone', '')
                    if not isinstance(phone, str) or not phone.startswith('+') or not phone[1:].isdigit() or not 8 <= len(phone[1:]) <= 15:
                        raise WorkerError('请输入含国家区号的手机号。')
                    sent = await self.client.send_code_request(phone)
                    self.phone, self.code_hash = phone, sent.phone_code_hash
                    self.state('awaiting_code')
                else:
                    from telethon.errors import SessionPasswordNeededError
                    if method == 'signIn' and self.status != 'awaiting_code':
                        raise WorkerError('请先获取验证码。')
                    if method == 'password' and self.status != 'awaiting_password':
                        raise WorkerError('当前无需两步验证密码。')
                    try:
                        if method == 'signIn':
                            await self.client.sign_in(self.phone, params.get('code', ''), phone_code_hash=self.code_hash)
                        else:
                            await self.client.sign_in(password=params.get('password', ''))
                        await self.authorized()
                    except SessionPasswordNeededError:
                        self.state('awaiting_password')
                return self.snapshot()
        if self.status != 'connected':
            raise WorkerError('Telegram 尚未登录。')
        if method == 'send':
            # Explicit random_id ties retries to the gateway's existing idempotency key.
            from telethon.tl.functions.messages import SendMessageRequest
            random_id = int.from_bytes(hashlib.sha256(params['idempotencyKey'].encode()).digest()[:8], 'big', signed=True)
            result = await self.client(SendMessageRequest(await self.client.get_input_entity(int(params['externalId'])),
                                                         params['text'], random_id=random_id))
            from telethon.tl import types
            if isinstance(result, types.UpdateShortSentMessage):
                return {'messageId': str(result.id)}
            for update in getattr(result, 'updates', []):
                if isinstance(update, types.UpdateMessageID) and update.random_id == random_id:
                    return {'messageId': str(update.id)}
            raise TimeoutError('发送结果未确认，请核查记录。')
        if method == 'downloadMedia':
            cid = chat_id(params['externalId'])
            if cid in self.ignored:
                raise WorkerError('该聊天已忽略，停止下载媒体。')
            ident = str(uuid.UUID(params['id']))
            message = await self.client.get_messages(int(cid), ids=int(params['messageId']))
            if not message or not message.file or not message.file.size or message.file.size > LIMIT:
                raise WorkerError('媒体已失效或超过 25 MB。')
            target = self.media / ident / 'content'
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                with target.open('wb') as output:
                    async for chunk in self.client.iter_download(message.media):
                        if cid in self.ignored or output.tell() + len(chunk) > LIMIT:
                            raise WorkerError('下载已停止。')
                        output.write(chunk)
                return {'size': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
            except BaseException:
                target.unlink(missing_ok=True)
                raise
        if method == 'sendMedia':
            media = params['media']
            ident = str(uuid.UUID(media['id']))
            path = self.media / ident / 'content'
            if path.is_symlink() or not path.resolve().is_relative_to(self.media.resolve()):
                raise WorkerError('附件路径无效。')
            if not path.is_file() or path.stat().st_size > LIMIT or hashlib.sha256(path.read_bytes()).hexdigest() != media['sha256']:
                raise WorkerError('附件校验失败。')
            # File name is metadata only; it never becomes a filesystem path.
            from telethon.tl.types import DocumentAttributeFilename
            message = await self.client.send_file(int(params['externalId']), path, caption=params.get('text', ''),
                                                  parse_mode=None, force_document=True,
                                                  attributes=[DocumentAttributeFilename(media.get('name', 'attachment'))])
            return {'messageId': str(message.id)}
        raise WorkerError('不支持此 Telegram 操作。')


async def main():
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    from telethon import TelegramClient, events
    root = Path(os.environ['TELEGRAM_DATA_DIR']).expanduser().resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    client = TelegramClient(str(root / 'account'), int(os.environ['TELEGRAM_API_ID']), os.environ['TELEGRAM_API_HASH'],
                            request_retries=1, flood_sleep_threshold=0, catch_up=True)
    worker = Worker(client, root, Path(os.environ['WHATSAPP_MEDIA_DIR']))

    async def new(event):
        await worker.publish(event.message)

    async def edit(event):
        await worker.publish(event.message, kind='messageUpdate')

    async def deleted(event):
        # Private-chat deletion events may lack chat_id; never guess across chats.
        if worker.auth_only or event.chat_id is None or str(event.chat_id) in worker.ignored:
            return
        entity = await event.get_chat()
        if str(event.chat_id) in worker.ignored:
            return
        for mid in event.deleted_ids:
            emit({'type': 'messageUpdate', 'conversation': worker.conversation(entity),
                  'message': {'externalId': str(mid), 'text': '', 'status': 'deleted'}})

    client.add_event_handler(new, events.NewMessage())
    client.add_event_handler(edit, events.MessageEdited())
    client.add_event_handler(deleted, events.MessageDeleted())
    await client.connect()
    if await client.is_user_authorized():
        await worker.authorized()
    else:
        worker.state('standby')
    tasks = set()

    async def request(line):
        rid = None
        try:
            body = json.loads(line)
            rid = body['id']
            result = await worker.call(body['method'], body.get('params') or {})
            emit({'id': rid, 'result': result})
        except Exception as error:
            # Never echo provider exceptions which may include login secrets or message content.
            name = type(error).__name__
            safe = str(error) if isinstance(error, WorkerError) else {
                'PhoneCodeInvalidError': '验证码错误。', 'PhoneCodeExpiredError': '验证码已过期，请重新获取。',
                'PasswordHashInvalidError': '两步验证密码错误。', 'FloodWaitError': '操作过于频繁，请稍后再试。',
                'TimeoutError': '操作超时，结果未确认，请先核查状态。'}.get(name, 'Telegram 操作失败，请检查网络或登录状态。')
            emit({'id': rid, 'error': safe})
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            task = asyncio.create_task(request(line))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        await worker.cancel_qr()
        for task in [*tasks, worker.sync_task]:
            if task:
                task.cancel()
        await asyncio.gather(*tasks, *([worker.sync_task] if worker.sync_task else []), return_exceptions=True)
        await client.disconnect()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, Exception):
        sys.exit(1)
