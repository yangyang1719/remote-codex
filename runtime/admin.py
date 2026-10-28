#!/usr/bin/env python3
"""Explicit user controls for this managed runtime service only."""
import argparse
import json
import socket
import subprocess
import time
from pathlib import Path

UNIT = 'remote-codex-runtime.service'
STATE = Path.home() / '.local/state/remote-codex-runtime'


def rpc(operation):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(90); sock.connect(str(STATE / 'control.sock'))
        sock.sendall(json.dumps({'id': 'admin', 'method': 'runtime/admin', 'params': {'operation': operation}}).encode() + b'\n')
        with sock.makefile('rb') as reader:
            result = json.loads(reader.readline())
        if 'error' in result:
            raise RuntimeError(result['error']['message'])
        return result.get('result', {})


def status():
    active = subprocess.run(['systemctl', 'is-active', UNIT], capture_output=True, text=True).stdout.strip()
    enabled = subprocess.run(['systemctl', 'is-enabled', UNIT], capture_output=True, text=True).stdout.strip()
    result = {'running': active == 'active', 'enabled': enabled == 'enabled', 'installed': Path('/etc/systemd/system/' + UNIT).exists()}
    if result['running']:
        result.update(rpc('status'))
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('operation', choices=['status', 'start', 'stop']); args = parser.parse_args()
    if args.operation == 'start':
        subprocess.run(['systemctl', 'enable', '--now', UNIT], check=True, stdout=subprocess.DEVNULL)
        for _ in range(30):
            try:
                rpc('status'); break
            except OSError:
                time.sleep(.2)
    elif args.operation == 'stop':
        if status()['running']:
            rpc('prepareStop')
        subprocess.run(['systemctl', 'disable', '--now', UNIT], check=True, stdout=subprocess.DEVNULL)
    print(json.dumps(status()))


if __name__ == '__main__':
    main()
