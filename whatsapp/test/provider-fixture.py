"""Offline worker fixture; never contacts a messaging platform."""
import json
import os
import sys
from pathlib import Path
if os.environ.get('FIXTURE_PID_PATH'):
    Path(os.environ['FIXTURE_PID_PATH']).write_text(str(os.getpid()))
print(json.dumps({'type': 'status', 'status': 'standby'}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    if method == 'status':
        result = {'status': 'standby', 'hasCredentials': True}
    elif method == 'connect':
        print(json.dumps({'type': 'ready'}), flush=True)
        print(json.dumps({'type': 'message', 'conversation': {'externalId': 'fixture@g.us', 'name': 'Offline fixture', 'type': 'group'}, 'message': {'externalId': 'm1', 'author': 'fixture', 'text': 'offline-only', 'timestamp': 1000}}), flush=True)
        result = {'status': 'connected'}
    elif method == 'listGroups':
        result = [{'id': 'fixture@g.us', 'name': 'Offline fixture'}]
    elif method == 'send':
        result = {'messageId': 'fixture-sent-' + request['params']['idempotencyKey']}
    else:
        print(json.dumps({'id': request['id'], 'error': 'NOT_ALLOWED'}), flush=True)
        continue
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
