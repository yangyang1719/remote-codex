#!/usr/bin/env python3
"""SSH JSONL relay. Exiting this relay never stops the remote worker."""
import argparse
import json
import os
import select
import socket
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True); parser.add_argument('--executable', required=True)
    parser.add_argument('--state', default=str(Path.home() / '.local/state/remote-codex-runtime'))
    args = parser.parse_args()
    sock = socket.socket(socket.AF_UNIX); sock.settimeout(30)
    try:
        sock.connect(str(Path(args.state) / 'control.sock'))
    except OSError:
        raise SystemExit('远端常驻服务已关闭或未安装。请在连接设置中开启远端常驻。')
    hello = {'id': 'attach', 'method': 'runtime/attach', 'params': {'project': args.project, 'executable': args.executable}}
    sock.sendall(json.dumps(hello).encode() + b'\n'); data = b''
    while b'\n' not in data:
        chunk = sock.recv(65536)
        if not chunk:
            raise SystemExit('远端常驻服务连接已结束。')
        data += chunk
    line, remainder = data.split(b'\n', 1); reply = json.loads(line)
    if not reply.get('result', {}).get('attached'):
        raise SystemExit(reply.get('error', {}).get('message', '远端常驻服务未就绪。'))
    sock.settimeout(None)
    if remainder:
        sys.stdout.buffer.write(remainder); sys.stdout.buffer.flush()
    while True:
        ready, _, _ = select.select([sock, 0], [], [])
        if sock in ready:
            chunk = sock.recv(65536)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            sock.sendall(chunk)
    sock.close()


if __name__ == '__main__':
    main()
