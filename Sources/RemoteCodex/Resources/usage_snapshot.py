"""Read only the latest token-count event; never return transcript text or change a rollout."""
import json
import os
from pathlib import Path
import stat
import sys
import uuid
from datetime import datetime

LIMIT = 8 * 1024 * 1024
LINE = 1024 * 1024
FIELDS = ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'cache_write_input_tokens')

def counts(value):
    if not isinstance(value, dict): return None
    return {key: number for key, number in value.items() if key in FIELDS and type(number) is int and number >= 0}

def snapshot(path, identifier):
    uuid.UUID(identifier); path = Path(path)
    roots = [p for p in path.parents if p.name in ('sessions', 'archived_sessions')]
    if not path.is_absolute() or not path.name.startswith('rollout-') or path.suffix != '.jsonl' or not roots or not path.resolve(strict=True).is_relative_to(roots[0].resolve(strict=True)):
        raise ValueError('Invalid rollout path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        meta = os.fstat(file.fileno())
        if not stat.S_ISREG(meta.st_mode): raise ValueError('Not a regular rollout')
        header = file.readline(LINE + 1)
        if len(header) > LINE or not header.endswith(b'\n'): raise ValueError('Invalid rollout header')
        first = json.loads(header)
        if first.get('type') != 'session_meta' or first.get('payload', {}).get('id') != identifier: raise ValueError('Thread identity mismatch')
        offset = max(len(header), meta.st_size - LIMIT)
        file.seek(offset)
        if offset > len(header): file.readline(LINE + 1)
        raw = file.read(LIMIT)
        result = None
        for line in raw.splitlines(keepends=True):
            if not line.endswith(b'\n') or len(line) > LINE: continue
            try: row = json.loads(line)
            except (ValueError, UnicodeDecodeError): continue
            if not isinstance(row, dict): continue
            value = row.get('payload')
            if row.get('type') != 'event_msg' or not isinstance(value, dict) or value.get('type') != 'token_count': continue
            info = value.get('info')
            if not isinstance(info, dict): continue
            total = counts(info.get('total_token_usage'))
            if not total: continue
            timestamp = row.get('timestamp')
            try:
                if not isinstance(timestamp, str) or len(timestamp) > 64: raise ValueError('invalid timestamp')
                datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            except (ValueError, TypeError): timestamp = None
            result = {'threadId': identifier, 'source': 'rollout', 'total': total, 'last': counts(info.get('last_token_usage')), 'recordedAt': timestamp}
        return {'threadId': identifier, 'snapshot': result}

if __name__ == '__main__':
    value = json.load(sys.stdin)
    print(json.dumps(snapshot(value['path'], value['threadId'])))
