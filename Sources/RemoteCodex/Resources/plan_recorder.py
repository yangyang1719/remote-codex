"""Official PostToolUse callback: save only an executed update_plan snapshot.
No stdout feedback, model steering, approvals, network or transcript changes.
"""
import fcntl
import json
import os
import tempfile
import time
import uuid
from pathlib import Path


def record(value, root=None):
    if value.get('hook_event_name') != 'PostToolUse' or value.get('tool_name') not in ('update_plan','functions.update_plan'):
        return False
    response = value.get('tool_response')
    if response not in ('Plan updated', [{'type':'input_text','text':'Plan updated'}]): return False
    identifier, turn = value.get('session_id'), value.get('turn_id')
    uuid.UUID(identifier);uuid.UUID(turn)
    args = value.get('tool_input')
    if isinstance(args,str): args=json.loads(args)
    if not isinstance(args,dict) or not isinstance(args.get('plan'),list) or len(args['plan']) > 100: return False
    rows=[]
    for row in args['plan']:
        if not isinstance(row,dict): return False
        text,status=row.get('step'),row.get('status');status={'in_progress':'inProgress'}.get(status,status)
        if not isinstance(text,str) or len(text)>4000 or status not in ('pending','inProgress','completed'):return False
        rows.append({'step':text,'status':status})
    explanation=args.get('explanation')
    if explanation is not None and (not isinstance(explanation,str) or len(explanation)>8000):return False
    result={'threadId':identifier,'turnId':turn,'plan':rows,'explanation':explanation,'toolUseId':value.get('tool_use_id'),'source':'postToolUse','recordedAtNS':time.time_ns()}
    encoded=json.dumps(result,ensure_ascii=False).encode()
    if len(encoded)>1_000_000:return False
    root=Path(root) if root else Path.home()/'.local/state/remote-codex/plan-progress'
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if root.is_symlink():raise ValueError('Plan directory must not be a symlink')
    os.chmod(root,0o700)
    lock=os.open(root/(identifier+'.lock'),os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX)
        fd,temp=tempfile.mkstemp(prefix='.'+identifier+'-',dir=root)
        try:
            with os.fdopen(fd,'wb') as file:file.write(encoded);file.flush();os.fsync(file.fileno())
            os.replace(temp,root/(identifier+'.json'))
        finally:
            if os.path.exists(temp):os.unlink(temp)
    finally:os.close(lock)
    return True


if __name__=='__main__':
    record(json.loads(__import__('sys').stdin.buffer.read(2_000_001)))
