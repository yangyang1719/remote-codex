"""Private media index/cache. Crypto descriptors never appear in public message JSON."""
import hashlib
import mimetypes
import os
import re
import uuid
from pathlib import Path

LIMIT = 25 * 1024 * 1024
KINDS = ('image', 'video', 'audio', 'document')


def filename(value):
    name = re.sub(r'[\\/\x00-\x1f\x7f]', '_', str(value or 'attachment'))[:180]
    return name if name not in ('', '.', '..') else 'attachment'


class MediaStore:
    def __init__(self, store, root):
        self.store, self.root = store, Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        store.db.execute('''CREATE TABLE IF NOT EXISTS media(
          id TEXT PRIMARY KEY, message_id TEXT UNIQUE, conversation_id TEXT NOT NULL,
          kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
          sha256 TEXT, source TEXT, cache_id TEXT, available INTEGER NOT NULL, reason TEXT)''')
        store.db.commit()
        self.download_lock = __import__('threading').RLock()

    def ingest(self, mid, cid, value):
        media = value.get('media')
        if not isinstance(media, dict) or media.get('kind') not in KINDS:
            return
        ident = str(uuid.uuid5(uuid.NAMESPACE_URL, mid + ':media'))
        source = value.get('_mediaSource')
        if not isinstance(source, str) or len(source) > 4 * 1024 * 1024:
            source = None
        size = max(0, int(media.get('size') or 0))
        available = bool(media.get('available', True)) and size <= LIMIT and bool(source)
        reason = media.get('reason') or (None if available else '此历史消息未保存媒体源，请从手机重新发送')
        with self.store.lock, self.store.db:
            self.store.db.execute('''INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(message_id) DO UPDATE SET source=COALESCE(excluded.source,media.source),
              available=CASE WHEN media.cache_id IS NOT NULL OR media.source IS NOT NULL THEN media.available ELSE excluded.available END''',
                (ident, mid, cid, media['kind'], filename(media.get('name')), str(media.get('mime') or 'application/octet-stream')[:128], size, None, source, None, int(available), reason))

    def row(self, ident):
        try:
            uuid.UUID(ident)
        except (ValueError, TypeError, AttributeError):
            raise ValueError('附件标识无效。')
        with self.store.lock:
            row = self.store.db.execute('SELECT * FROM media WHERE id=?', (ident,)).fetchone()
            if row is None:
                raise ValueError('附件不存在。旧记录可能没有保存媒体源。')
            return dict(row)

    @staticmethod
    def public(row):
        return {key: row[key] for key in ('id', 'kind', 'name', 'mime', 'size', 'sha256', 'available', 'reason')}

    def for_message(self, mid):
        with self.store.lock:
            row = self.store.db.execute('SELECT * FROM media WHERE message_id=?', (mid,)).fetchone()
            return self.public(dict(row)) if row else None

    def path(self, cache_id):
        uuid.UUID(cache_id)
        target = self.root / cache_id / 'content'
        if target.is_symlink() or not target.resolve().is_relative_to(self.root.resolve()):
            raise ValueError('附件缓存路径无效。')
        return target

    def upload(self, cid, name, mime, stream, size):
        if not self.store.get_conversation(cid) or not 0 < size <= LIMIT:
            raise ValueError('对话或文件大小无效，单个附件最多 25 MB。')
        name = filename(name)
        mime = mime if isinstance(mime, str) and re.fullmatch(r'[\w.+-]+/[\w.+-]+', mime) else mimetypes.guess_type(name)[0] or 'application/octet-stream'
        kind = next((kind for kind in KINDS[:3] if mime.startswith(kind + '/')), 'document')
        ident = str(uuid.uuid4()); target = self.path(ident)
        target.parent.mkdir(mode=0o700)
        digest, remaining = hashlib.sha256(), size
        try:
            with open(target, 'xb') as file:
                os.chmod(target, 0o600)
                while remaining:
                    data = stream.read(min(65536, remaining))
                    if not data:
                        raise ValueError('附件数据不完整。')
                    file.write(data); digest.update(data); remaining -= len(data)
            with self.store.lock, self.store.db:
                self.store.db.execute('INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                    (ident, None, cid, kind, name, mime, size, digest.hexdigest(), None, ident, 1, None))
            return self.public(self.row(ident))
        except Exception:
            target.unlink(missing_ok=True)
            target.parent.rmdir()
            raise

    def ready(self, ident, providers):
        with self.download_lock:
            row = self.row(ident)
            if not row['available']:
                raise ValueError(row['reason'] or '此媒体无法下载。')
            if not row['cache_id']:
                message = self.store.message(row['message_id'])
                if not message or message['status'] == 'deleted':
                    raise ValueError('此消息已撤回。')
                conversation = self.store.get_conversation(row['conversation_id'])
                provider = providers.get(conversation['accountId']) if conversation else None
                if not provider or provider.status != 'connected':
                    raise RuntimeError('WhatsApp 尚未连接，请先重新关联设备。')
                result = provider.call('downloadMedia', {'id': ident, 'source': row['source'], 'externalId': conversation['externalId'], 'messageId': message['platformMessageId']}, timeout=100)
                size, digest = int(result['size']), result['sha256']
                target = self.path(ident)
                if not 0 <= size <= LIMIT or target.stat().st_size != size or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                    raise ValueError('媒体下载校验失败。')
                with self.store.lock, self.store.db:
                    self.store.db.execute('UPDATE media SET cache_id=?,size=?,sha256=? WHERE id=?', (ident, size, digest, ident))
                row = self.row(ident)
            if row['message_id']:
                message = self.store.message(row['message_id'])
                if message and message['status'] == 'deleted':
                    raise ValueError('此消息已撤回。')
            target = self.path(row['cache_id'])
            if not target.is_file() or target.stat().st_size > LIMIT:
                raise ValueError('附件缓存已失效。')
            # Check bytes every time: truncated or modified caches must not masquerade as valid media.
            if target.stat().st_size != row['size'] or hashlib.sha256(target.read_bytes()).hexdigest() != row['sha256']:
                raise ValueError('附件缓存校验失败。')
            return row, target

    def attach_upload(self, mid, ident):
        row = self.row(ident); new_id = str(uuid.uuid5(uuid.NAMESPACE_URL, mid + ':media'))
        with self.store.lock, self.store.db:
            self.store.db.execute('''INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(message_id) DO UPDATE SET cache_id=excluded.cache_id,sha256=excluded.sha256,size=excluded.size,available=1,reason=NULL''',
                (new_id, mid, row['conversation_id'], row['kind'], row['name'], row['mime'], row['size'], row['sha256'], None, row['cache_id'], 1, None))
