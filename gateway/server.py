#!/usr/bin/env python3
"""Single-user, loopback-only remote message gateway. No account credentials leave here."""
import argparse
import base64
import hashlib
import json
import os
import queue
import select
import signal
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from media import MediaStore, LIMIT
from routing import MessageRoutes


class Store:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, platform TEXT NOT NULL,
          account TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
          last_message TEXT DEFAULT '', updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
          external_id TEXT NOT NULL, author TEXT, text TEXT NOT NULL, direction TEXT NOT NULL,
          timestamp INTEGER NOT NULL, status TEXT NOT NULL,
          UNIQUE(conversation_id, external_id));
        CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(conversation_id,timestamp);
        CREATE TABLE IF NOT EXISTS sends(key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
          text_hash TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
          text TEXT NOT NULL, state TEXT NOT NULL, timestamp INTEGER NOT NULL);
        ''')
        self.media = MediaStore(self, path.parent/'media')

    def conversation(self, account, platform, value):
        external = str(value['externalId'])
        cid = platform + ':' + account + ':' + external
        with self.lock, self.db:
            self.db.execute('''INSERT INTO conversations(id,platform,account,external_id,name,type,updated_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type''',
                            (cid, platform, account, external, value.get('name') or external,
                             value.get('type', 'contact'), int(value.get('updatedAt', 0))))
        return cid

    def ingest(self, cid, value):
        external = str(value['externalId'])
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, cid + ':' + external))
        timestamp = int(value.get('timestamp', int(time.time()*1000)))
        with self.lock, self.db:
            self.db.execute('''INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(conversation_id,external_id) DO UPDATE SET text=excluded.text,status=excluded.status''',
                            (mid, cid, external, value.get('author', ''), value.get('text', ''),
                             value.get('direction', 'incoming'), timestamp, value.get('status', 'received')))
            self.db.execute('''UPDATE conversations SET last_message=CASE WHEN ?>=updated_at THEN ? ELSE last_message END,
                              updated_at=MAX(updated_at,?) WHERE id=?''',
                            (timestamp, value.get('text', '')[:160], timestamp, cid))
        self.media.ingest(mid, cid, value)
        return self.message(mid)

    def message(self, mid):
        with self.lock:
            row = self.db.execute('SELECT * FROM messages WHERE id=?', (mid,)).fetchone()
            if not row:
                return None
            return {'id': row['id'], 'conversationId': row['conversation_id'], 'platformMessageId': row['external_id'],
                    'author': row['author'], 'text': row['text'], 'direction': row['direction'],
                    'timestamp': row['timestamp'], 'status': row['status'], 'media': self.media.for_message(mid)}

    def patch(self, cid, value):
        with self.lock, self.db:
            row = self.db.execute('SELECT id FROM messages WHERE conversation_id=? AND external_id=?', (cid, str(value['externalId']))).fetchone()
            if not row:
                return None
            self.db.execute('UPDATE messages SET text=?,status=? WHERE id=?', (value.get('text', ''), value.get('status', 'edited'), row['id']))
            message = self.message(row['id'])
            latest = self.db.execute('SELECT id FROM messages WHERE conversation_id=? ORDER BY timestamp DESC,rowid DESC LIMIT 1', (cid,)).fetchone()
            if latest and latest['id'] == row['id']:
                self.db.execute('UPDATE conversations SET last_message=? WHERE id=?', (value.get('text', '')[:160], cid))
            return message

    def conversations(self):
        with self.lock:
            return [{'id': r['id'], 'platform': r['platform'], 'accountId': r['account'], 'externalId': r['external_id'],
                     'name': r['name'], 'type': r['type'], 'lastMessage': r['last_message'], 'updatedAt': r['updated_at'],
                     'incomingCount': r['incoming_count'] or 0, 'messageCount': r['message_count'] or 0,
                     'lastMessageAt': r['last_message_at'] or 0}
                    for r in self.db.execute('''SELECT c.*, m.incoming_count, m.message_count, m.last_message_at
                      FROM conversations c LEFT JOIN (SELECT conversation_id, COUNT(*) message_count,
                        SUM(CASE WHEN direction='incoming' THEN 1 ELSE 0 END) incoming_count,
                        MAX(timestamp) last_message_at FROM messages GROUP BY conversation_id) m
                      ON m.conversation_id=c.id ORDER BY COALESCE(m.last_message_at,0) DESC,c.id''')]

    def message_snapshot(self, cid, before=None):
        # A read watermark must describe the same snapshot as the displayed messages.
        with self.lock:
            count = self.db.execute("SELECT COUNT(*) FROM messages WHERE conversation_id=? AND direction='incoming'", (cid,)).fetchone()[0]
            return {'messages': self.messages(cid, before), 'drafts': self.drafts(cid), 'incomingCount': count}

    def get_conversation(self, cid):
        return next((c for c in self.conversations() if c['id'] == cid), None)

    def messages(self, cid, before=None):
        with self.lock:
            rows = list(self.db.execute('''SELECT id FROM messages WHERE conversation_id=? AND timestamp<?
                 ORDER BY timestamp DESC,rowid DESC LIMIT 200''', (cid, before or 9_223_372_036_854_775_807)))
            return [self.message(r['id']) for r in reversed(rows)]

    def reserve_send(self, key, cid, text):
        digest = hashlib.sha256(text.encode()).hexdigest()
        with self.lock, self.db:
            row = self.db.execute('SELECT * FROM sends WHERE key=?', (key,)).fetchone()
            if row:
                if row['conversation_id'] != cid or row['text_hash'] != digest:
                    raise ValueError('幂等键已绑定其他收件人或正文。')
                return dict(row)
            self.db.execute('INSERT INTO sends(key,conversation_id,text_hash,state) VALUES(?,?,?,?)', (key, cid, digest, 'sending'))
            return None

    def finish_send(self, key, state, mid=None, error=None):
        with self.lock, self.db:
            self.db.execute('UPDATE sends SET state=?,message_id=?,error=? WHERE key=?', (state, mid, error, key))

    def prepare(self, cid, text):
        did = str(uuid.uuid4())
        with self.lock, self.db:
            self.db.execute('INSERT INTO drafts VALUES(?,?,?,?,?)', (did, cid, text, 'pending', int(time.time()*1000)))
        return {'id': did, 'conversationId': cid, 'text': text, 'needsConfirmation': True}

    def drafts(self, cid):
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM drafts WHERE conversation_id=? AND state='pending' ORDER BY timestamp DESC LIMIT 5", (cid,))]


class Events:
    def __init__(self):
        self.lock = threading.Lock()
        self.listeners = set()

    def publish(self, event):
        with self.lock:
            for listener in list(self.listeners):
                try:
                    listener.put_nowait(event)
                except queue.Full:
                    # A slow client must re-read persisted state; never silently claim it is caught up.
                    self.listeners.remove(listener)
                    try:
                        listener.get_nowait()
                        listener.put_nowait({'type': 'resyncRequired'})
                    except queue.Empty:
                        pass


class Provider:
    def __init__(self, config, store, events):
        self.account = config['id']
        self.platform = config['platform']
        self.store, self.events = store, events
        self.pending = {}
        self.lock = threading.Lock()
        self.status = 'starting'
        self.proc = subprocess.Popen(config['command'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                     env={**os.environ, **config.get('environment', {}), 'WHATSAPP_MEDIA_DIR': str(store.media.root), 'WHATSAPP_AUTOCONNECT_MARKER': str(store.media.root.parent/'whatsapp-linked')})
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        try:
            for line in self.proc.stdout:
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if 'id' in value:
                    with self.lock:
                        waiter = self.pending.get(value['id'])
                    if waiter:
                        waiter.put(value)
                elif value.get('type') == 'ready':
                    self.status = 'connected'
                    self.events.publish({'type': 'providerStatus', 'platform': self.platform, 'status': self.status})
                elif value.get('type') in ('conversation', 'message', 'messageUpdate'):
                    cid = self.store.conversation(self.account, self.platform, value['conversation'])
                    if value['type'] == 'message':
                        self.store.ingest(cid, value['message'])
                    elif value['type'] == 'messageUpdate':
                        self.store.patch(cid, value['message'])
                    self.events.publish({'type': value['type'], 'conversationId': cid})
                elif value.get('type') == 'status':
                    self.status = value.get('status', 'disconnected')
                    self.events.publish({'type': 'providerStatus', 'platform': self.platform, 'status': self.status})
        except (ValueError, OSError, KeyError):
            self.status = 'error'
        finally:
            self.status = 'disconnected'
            with self.lock:
                for waiter in self.pending.values():
                    try:
                        waiter.put_nowait({'error': '远端账号连接进程已退出。'})
                    except queue.Full:
                        pass
            self.events.publish({'type': 'providerStatus', 'platform': self.platform, 'status': self.status})

    def call(self, method, params=None, timeout=75):
        if self.proc.poll() is not None:
            raise RuntimeError('远端账号连接进程未运行。')
        rid, waiter = str(uuid.uuid4()), queue.Queue(maxsize=1)
        with self.lock:
            self.pending[rid] = waiter
            self.proc.stdin.write(json.dumps({'id': rid, 'method': method, 'params': params or {}}) + '\n')
            self.proc.stdin.flush()
        try:
            result = waiter.get(timeout=timeout)
            if result.get('error'):
                raise RuntimeError(str(result['error']))
            return result.get('result')
        except queue.Empty:
            raise TimeoutError('平台未确认发送结果，请先核对原聊天，勿重复发送。')
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    def send(self, external, text, key):
        if self.status != 'connected':
            raise RuntimeError('远端消息账号尚未连接。')
        return self.call('send', {'externalId': external, 'text': text, 'idempotencyKey': key}, timeout=35)['messageId']


class Gateway:
    def __init__(self, path, config):
        self.store, self.events = Store(path), Events()
        self.providers = {}
        self.routes = MessageRoutes(self)
        for provider in config.get('providers', []):
            if provider['platform'] not in ('whatsapp', 'telegram'):
                raise ValueError('unsupported provider')
            self.providers[provider['id']] = Provider(provider, self.store, self.events)

    def whatsapp(self, method, params=None):
        allowed = {'status', 'connect', 'listGroups', 'selectGroup', 'startAuth', 'startPairingCode', 'sendToConfiguredGroup', 'sendTextToConfiguredGroup', 'sendMarkdownFileToConfiguredGroup', 'authStatus', 'linkDevice'}
        if method not in allowed:
            raise ValueError('WhatsApp method not allowed')
        provider = next((p for p in self.providers.values() if p.platform == 'whatsapp'), None)
        if provider is None:
            raise RuntimeError('WhatsApp 独立服务未配置。')
        return provider.call(method, params, timeout=75)

    def send(self, body):
        cid, text, key = body.get('conversationId'), body.get('text'), body.get('idempotencyKey')
        media_id = body.get('mediaId')
        if not all(isinstance(x, str) and x for x in (cid, key)) or not isinstance(text, str) or (not text.strip() and not media_id) or len(text) > 4000 or len(key) > 120:
            raise ValueError('收件人、正文或幂等键无效。')
        conversation = self.store.get_conversation(cid)
        if not conversation:
            raise ValueError('未找到指定对话。')
        provider = self.providers.get(conversation['accountId'])
        if not provider or provider.status != 'connected':
            raise RuntimeError('该远端账号尚未接入，未发送任何消息。')
        media = None
        if media_id:
            media, _ = self.store.media.ready(media_id, self.providers)
            if media['conversation_id'] != cid or media['message_id']:
                raise ValueError('附件不属于当前发送对话，请重新添加。')
        signature = text if not media else json.dumps([text, media_id, media['sha256'], media['kind']], ensure_ascii=False)
        existing = self.store.reserve_send(key, cid, signature)
        if existing:
            if existing['state'] == 'sent':
                return {'message': self.store.message(existing['message_id'])}
            raise RuntimeError(existing.get('error') or '该消息已提交，请核对发送状态。')
        try:
            if media:
                # The worker receives the cache identity, never a client-controlled file path or URL.
                external = provider.call('sendMedia', {'externalId': conversation['externalId'], 'text': text, 'media': {**self.store.media.public(media), 'id': media['cache_id']}}, timeout=100)['messageId']
            else:
                external = provider.send(conversation['externalId'], text, key)
            message = self.store.ingest(cid, {'externalId': external, 'author': '你', 'text': text, 'direction': 'outgoing', 'status': 'sent'})
            if media:
                self.store.media.attach_upload(message['id'], media_id)
                message = self.store.message(message['id'])
            self.store.finish_send(key, 'sent', message['id'])
            with self.store.lock, self.store.db:
                self.store.db.execute("UPDATE drafts SET state='sent' WHERE conversation_id=? AND text=? AND state='pending'", (cid, text))
            self.events.publish({'type': 'message', 'conversationId': cid})
            return {'message': message}
        except Exception as error:
            self.store.finish_send(key, 'unknown' if isinstance(error, TimeoutError) else 'failed', error=str(error))
            raise


def handler(gateway):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def authorized(self):
            return not self.headers.get('Origin') and self.headers.get('X-Remote-Codex') in ('desktop', 'mcp')

        def json(self, code, payload):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self.authorized():
                return self.json(403, {'error': 'Forbidden'})
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query)
            if parsed.path == '/health':
                return self.json(200, {'status': 'ok', 'capabilities': ['media-v1', 'inbox-v1', 'desktop-routing-v1'], 'mediaLimit': LIMIT, 'providers': [{'accountId': p.account, 'platform': p.platform, 'status': p.status} for p in gateway.providers.values()]})
            if parsed.path.startswith('/media/'):
                try:
                    row, target = gateway.store.media.ready(parsed.path.removeprefix('/media/'), gateway.providers)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(row['size']))
                    self.send_header('X-Content-SHA256', row['sha256'])
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    with open(target, 'rb') as file:
                        while chunk := file.read(65536): self.wfile.write(chunk)
                    return
                except (ValueError, FileNotFoundError) as error:
                    return self.json(400, {'error': str(error)})
                except Exception:
                    return self.json(503, {'error': '媒体下载失败，请检查设备连接或附件是否已过期。'})
            if parsed.path == '/conversations':
                return self.json(200, {'conversations': gateway.store.conversations()})
            if parsed.path == '/messages':
                cid = params.get('conversation_id', [''])[0]
                before = params.get('before', [None])[0]
                try:
                    before = int(before) if before else None
                except ValueError:
                    return self.json(400, {'error': 'Invalid history cursor'})
                return self.json(200, gateway.store.message_snapshot(cid, before))
            if parsed.path == '/whatsapp/status':
                try:
                    return self.json(200, gateway.whatsapp('status'))
                except RuntimeError as error:
                    return self.json(503, {'error': str(error)})
            if parsed.path == '/whatsapp/auth':
                try:
                    return self.json(200, gateway.whatsapp('authStatus'))
                except Exception:
                    return self.json(503, {'error': '无法读取 WhatsApp 关联状态。'})
            if parsed.path == '/events':
                return self.websocket()
            return self.json(404, {'error': 'Not found'})

        def do_POST(self):
            if not self.authorized():
                return self.json(403, {'error': 'Forbidden'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                parsed = urlsplit(self.path)
                if parsed.path == '/media/upload':
                    if not 0 < size <= LIMIT:
                        self.close_connection = True
                        return self.json(413, {'error': '单个附件最多 25 MB。'})
                    params = parse_qs(parsed.query)
                    media = gateway.store.media.upload(params.get('conversation_id', [''])[0], params.get('name', [''])[0], self.headers.get('Content-Type'), self.rfile, size)
                    return self.json(201, {'media': media})
                if not 0 < size <= 256000:
                    self.close_connection = True
                    return self.json(413, {'error': 'Invalid body size'})
                body = json.loads(self.rfile.read(size))
                if parsed.path.startswith('/routing/'):
                    desktop = parsed.path in ('/routing/context/create', '/routing/context/bind')
                    if self.headers.get('X-Remote-Codex') != ('desktop' if desktop else 'mcp'):
                        return self.json(403, {'error': 'This routing operation is unavailable to this client'})
                    if parsed.path == '/routing/context/create':
                        return self.json(200, gateway.routes.create(body))
                    if parsed.path == '/routing/context/bind':
                        return self.json(200, gateway.routes.bind(body))
                    if parsed.path == '/routing/current':
                        return self.json(200, gateway.routes.current(body))
                    if parsed.path == '/routing/read':
                        return self.json(200, gateway.routes.read(body))
                    if parsed.path == '/routing/media':
                        return self.json(200, gateway.routes.media(body))
                    if parsed.path == '/routing/prepare':
                        return self.json(200, gateway.routes.prepare(body))
                    if parsed.path == '/routing/send':
                        return self.json(200, gateway.routes.send(body))
                    if parsed.path == '/routing/send-status':
                        return self.json(200, gateway.routes.send_status(body))
                    return self.json(404, {'error': 'Unknown routing operation'})
                if self.path == '/whatsapp/auth':
                    if body.get('mode') not in ('qr', 'phone'):
                        raise ValueError('关联方式无效。')
                    return self.json(200, gateway.whatsapp('linkDevice', {'mode': body['mode'], 'phoneNumber': body.get('phoneNumber')}))
                if self.path == '/whatsapp/call':
                    if self.headers.get('X-Remote-Codex') == 'mcp' and body.get('method') not in ('status', 'authStatus', 'listGroups'):
                        return self.json(403, {'error': 'Legacy plugin writes are disabled. Refresh desktop-messages and use its bound routing context.'})
                    return self.json(200, {'result': gateway.whatsapp(body.get('method'), body.get('params', {}))})
                if self.path == '/messages/send':
                    if self.headers.get('X-Remote-Codex') == 'mcp':
                        return self.json(403, {'error': 'MCP sends require an immutable prepared message through /routing/send'})
                    return self.json(200, gateway.send(body))
                if self.path == '/drafts':
                    cid, text = body.get('conversationId'), body.get('text')
                    if not isinstance(text, str) or not 0 < len(text) <= 16000 or not gateway.store.get_conversation(cid):
                        raise ValueError('对话或草稿内容无效。')
                    draft = gateway.store.prepare(cid, text)
                    gateway.events.publish({'type': 'draftPrepared', 'conversationId': cid, 'draft': draft})
                    return self.json(201, draft)
                return self.json(404, {'error': 'Not found'})
            except (ValueError, KeyError) as error:
                return self.json(400, {'error': str(error)})
            except Exception as error:
                return self.json(503, {'error': str(error)})

        def websocket(self):
            key = self.headers.get('Sec-WebSocket-Key', '')
            try:
                valid_key = len(base64.b64decode(key, validate=True)) == 16
            except ValueError:
                valid_key = False
            if self.headers.get('Upgrade', '').lower() != 'websocket' or not valid_key:
                return self.json(400, {'error': 'Invalid websocket handshake'})
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            listener = queue.Queue(maxsize=100)
            with gateway.events.lock:
                gateway.events.listeners.add(listener)
            try:
                while True:
                    try:
                        event = listener.get(timeout=1)
                    except queue.Empty:
                        if select.select([self.connection], [], [], 0)[0]:
                            # URLSession only sends close/control frames on this receive-only stream.
                            frame = self.connection.recv(4096)
                            if not frame or frame[0] & 15 == 8:
                                break
                        continue
                    data = json.dumps(event, ensure_ascii=False).encode()
                    frame = b'\x81' + (bytes([len(data)]) if len(data) < 126 else b'\x7e' + struct.pack('!H', len(data)) if len(data) < 65536 else b'\x7f' + struct.pack('!Q', len(data))) + data
                    self.wfile.write(frame)
                    self.wfile.flush()
                    if event.get('type') == 'resyncRequired':
                        break
            except (OSError, ConnectionError):
                pass
            finally:
                with gateway.events.lock:
                    gateway.events.listeners.discard(listener)
                self.close_connection = True

        def log_message(self, format, *args):
            pass  # Avoid logging message contents, chat IDs, or login material.

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18765)
    parser.add_argument('--state', default=str(Path.home()/'.local/state/remote-codex'))
    parser.add_argument('--config')
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text()) if args.config else {}
    service = Gateway(Path(args.state)/'messages.sqlite3', config)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(service))
    stopping, failed = threading.Event(), threading.Event()

    def supervise():
        while not stopping.wait(2):
            if any(provider.proc.poll() is not None for provider in service.providers.values()):
                failed.set()
                print('Message provider exited; service will restart.', file=sys.stderr, flush=True)
                server.shutdown()
                return

    threading.Thread(target=supervise, daemon=True).start()
    # systemd sends SIGTERM to the gateway first. Let the worker close its socket
    # and finish pending credential writes before systemd's stop deadline.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stopping.set()
        server.server_close()
        for provider in service.providers.values():
            provider.proc.terminate()
        for provider in service.providers.values():
            try:
                provider.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                provider.proc.kill()
    if failed.is_set():
        raise SystemExit(1)


if __name__ == '__main__':
    main()
