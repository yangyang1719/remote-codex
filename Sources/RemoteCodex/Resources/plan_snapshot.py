"""Read-only projection of accepted update_plan calls from an official rollout.

Executed briefly over SSH. No app-server resume, log writes, database writes,
resident service, credentials or unrelated transcript content are returned.
"""
import hashlib
import json
import os
import stat
import sys
import time
import uuid
from pathlib import Path

BATCH = 8 * 1024 * 1024
LINE = 1024 * 1024


def normalize(value):
    if not isinstance(value, dict) or not isinstance(value.get('plan'), list) or len(value['plan']) > 100:
        return None
    rows = []
    for row in value['plan']:
        if not isinstance(row, dict): return None
        text, status = row.get('step'), row.get('status')
        status = {'in_progress': 'inProgress'}.get(status, status)
        if not isinstance(text, str) or len(text) > 4000 or status not in ('pending', 'inProgress', 'completed'): return None
        rows.append({'step': text, 'status': status})
    explanation = value.get('explanation')
    if explanation is not None and (not isinstance(explanation, str) or len(explanation) > 8000): return None
    return {'plan': rows, 'explanation': explanation}


def output_succeeded(value):
    if isinstance(value, str): return value == 'Plan updated'
    if isinstance(value, dict):
        if value.get('success') is False: return False
        value = value.get('body', value.get('content'))
        if isinstance(value, str): return value == 'Plan updated'
    return isinstance(value, list) and value == [{'type': 'input_text', 'text': 'Plan updated'}]


def anchor(file, position):
    file.seek(max(0, position-256))
    return hashlib.sha256(file.read(min(position, 256))).hexdigest()


def checkpoint(identifier):
    path = Path.home()/'.local/state/remote-codex/plan-progress'/(identifier+'.json')
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode): return None
            value = json.loads(file.read(1_000_001))
        if value.get('threadId') != identifier or value.get('source') != 'postToolUse': return None
        plan = normalize(value)
        if plan is None: return None
        return dict(plan, threadId=identifier, turnId=value['turnId'], revision=value['recordedAtNS'])
    except (OSError, ValueError, KeyError): return None


def snapshot(path, identifier, cursor=None, batch=BATCH, latest_turn=None):
    uuid.UUID(identifier)
    path = Path(path)
    if not path.is_absolute() or not path.name.startswith('rollout-') or path.suffix != '.jsonl':
        raise ValueError('Invalid official rollout path')
    roots = [p for p in path.parents if p.name in ('sessions', 'archived_sessions')]
    if not roots or not path.resolve(strict=True).is_relative_to(roots[0].resolve(strict=True)):
        raise ValueError('Rollout is outside its sessions directory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode): raise ValueError('Rollout must be a regular file')
        header = file.readline(LINE+1)
        if not header.endswith(b'\n') or len(header) > LINE: raise ValueError('Invalid rollout identity')
        identity = json.loads(header)
        if identity.get('type') != 'session_meta' or identity.get('payload', {}).get('id') != identifier:
            raise ValueError('Rollout thread identity mismatch')
        saved = checkpoint(identifier)
        if saved and latest_turn is not None and saved['turnId'] == latest_turn:
            return {'threadId': identifier, 'plan': saved, 'turnId': latest_turn, 'hasMore': False, 'cursor': None}
        key = [str(path), info.st_dev, info.st_ino, hashlib.sha256(header).hexdigest()]
        valid = isinstance(cursor, dict) and cursor.get('key') == key
        offset = cursor.get('offset', -1) if valid else -1
        valid = valid and isinstance(offset, int) and len(header) <= offset <= info.st_size
        if valid:
            valid = anchor(file, offset) == cursor.get('anchor')
            if offset == info.st_size and info.st_mtime_ns != cursor.get('mtimeNS'): valid = False
        state = dict(cursor) if valid else {'key': key, 'offset': len(header), 'turnId': None, 'plan': None, 'pending': {}, 'skipping': False}
        pending = state['pending']
        file.seek(state['offset']); began = file.tell(); deadline = time.monotonic()+.75
        # Work is bounded per request, even for large image/tool-output lines.
        # Only complete records advance the cursor; partial appends are retried.
        while file.tell() < info.st_size and file.tell()-began < batch and time.monotonic() < deadline:
            start = file.tell(); line = file.readline(min(LINE+1, info.st_size-start))
            if state['skipping']:
                state['offset'] = file.tell()
                if line.endswith(b'\n'): state['skipping'] = False
                continue
            if len(line) > LINE:
                state['skipping'] = not line.endswith(b'\n'); state['offset'] = file.tell(); continue
            if not line.endswith(b'\n'):
                file.seek(start); break
            state['offset'] = file.tell()
            try: record = json.loads(line)
            except (ValueError, UnicodeDecodeError): continue
            kind, payload = record.get('type'), record.get('payload') or {}
            if not isinstance(payload, dict): continue
            if kind == 'turn_context' or (kind == 'event_msg' and payload.get('type') in ('task_started', 'turn_started')):
                turn = payload.get('turn_id')
                if isinstance(turn, str) and turn != state['turnId']:
                    state.update(turnId=turn, plan=None, pending={}); pending = state['pending']
            if kind != 'response_item': continue
            item_type = payload.get('type')
            if item_type == 'function_call' and payload.get('name') in ('update_plan', 'functions.update_plan'):
                call = payload.get('call_id')
                try: value = normalize(json.loads(payload.get('arguments', '')))
                except (ValueError, TypeError): value = None
                if value is not None and isinstance(call, str) and len(call) <= 256 and len(pending) < 100:
                    pending[call] = dict(value, turnId=state['turnId'])
            elif item_type == 'function_call_output':
                value = pending.pop(payload.get('call_id'), None)
                if value is not None and output_succeeded(payload.get('output')):
                    state['plan'] = dict(value, threadId=identifier, revision=state['offset'])
        state['anchor'] = anchor(file, state['offset']); state['mtimeNS'] = info.st_mtime_ns
        # A partial trailing line is caught up for now. Do not spin on it.
        more = state['offset'] < info.st_size and (file.tell()-began >= batch or time.monotonic() >= deadline or state['skipping'])
        plan = state['plan']
        if saved and saved['turnId'] == state['turnId']: plan = saved
        if latest_turn is not None and state['turnId'] != latest_turn: plan = None
        return {'threadId': identifier, 'plan': plan, 'turnId': latest_turn or state['turnId'], 'hasMore': more, 'cursor': state}


def main():
    value = json.loads(sys.stdin.buffer.read(2_000_001))
    result = snapshot(value['path'], value['threadId'], value.get('cursor'), latest_turn=value.get('latestTurnId'))
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded.encode()) > 4_000_000: raise ValueError('Plan snapshot is too large')
    print(encoded)


if __name__ == '__main__': main()
