#!/usr/bin/env python3
"""Explicit controls for our private official app-server unit; no resident Python."""
import argparse
import json
import subprocess
import time
from pathlib import Path
from official_rpc import RPC

UNIT = 'remote-codex-runtime.service'
STATE = Path.home()/'.local/state/remote-codex-runtime'
SOCKET = STATE/'official.sock'


def system_value(operation):
    return subprocess.run(['systemctl', operation, UNIT], capture_output=True, text=True, check=False).stdout.strip()


def clients():
    # Codex may symlink a long socket path into /tmp/codex-daemon-UID/.
    actual = str(SOCKET.resolve(strict=True))
    return sum(1 for line in Path('/proc/net/unix').read_text().splitlines()[1:]
               if len(parts := line.split(maxsplit=7)) == 8 and parts[7] == actual and parts[5] == '03')


def snapshot(rpc):
    ids = rpc.request('thread/loaded/list').get('data', [])
    threads = []
    for identifier in ids:
        thread = rpc.request('thread/read', {'threadId': identifier, 'includeTurns': False}).get('thread', {})
        goal = rpc.request('thread/goal/get', {'threadId': identifier}).get('goal') or {}
        threads.append((identifier,thread,goal))
    return threads


def status():
    running = system_value('is-active') == 'active'
    result = {'running': running, 'enabled': system_value('is-enabled') == 'enabled', 'installed': Path('/etc/systemd/system/'+UNIT).exists(), 'official': True, 'persistent': True}
    if running:
        count = clients()  # Before our short-lived admin connection is added.
        with RPC(SOCKET) as rpc:
            diagnostics = rpc.request('server/diagnostics')
            threads = snapshot(rpc)
        gauges = {g['name']:g['value'] for g in diagnostics.get('gauges',[])}
        pid = diagnostics.get('process',{}).get('id')
        result.update(clients=count, workers=1, workerPIDs=[pid] if pid else [], loadedThreads=len(threads),
                      activeTurns=int(gauges.get('core.turns.active',0)), activeGoals=sum(g.get('status')=='active' for _,_,g in threads),
                      pendingApprovals=sum('waitingOnApproval' in t.get('status',{}).get('activeFlags',[]) for _,t,_ in threads))
    return result


def prepare_stop():
    with RPC(SOCKET) as rpc:
        # Only threads actually loaded by this private app-server are eligible.
        # Never scan global history, revive old registry entries or touch the shared official daemon.
        for identifier,thread,goal in snapshot(rpc):
            if goal.get('status') == 'active':
                rpc.request('thread/goal/set', {'threadId': identifier, 'status': 'paused', 'origin': 'user'})
            if thread.get('status',{}).get('type') == 'active':
                turns = rpc.request('thread/turns/list', {'threadId': identifier, 'limit': 3, 'itemsView': 'summary'}).get('data',[])
                for turn in turns:
                    if turn.get('status') == 'inProgress': rpc.request('turn/interrupt', {'threadId': identifier, 'turnId': turn['id']})


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('operation', choices=['status','start','stop']); args = parser.parse_args()
    if args.operation == 'start':
        subprocess.run(['systemctl','enable','--now',UNIT], check=True, stdout=subprocess.DEVNULL)
        for _ in range(50):
            try:
                result = status()
                if result['running']: print(json.dumps(result)); return
            except (OSError, RuntimeError): pass
            time.sleep(.2)
        raise RuntimeError('Official app-server did not become ready')
    elif args.operation == 'stop':
        if system_value('is-active') == 'active': prepare_stop()
        subprocess.run(['systemctl','disable','--now',UNIT], check=True, stdout=subprocess.DEVNULL)
    print(json.dumps(status()))


if __name__ == '__main__': main()
