#!/usr/bin/env python3
"""Mac-owned stdio MCP manager and authenticated SSH reverse bridge. No preset tools."""
import argparse
import base64
import fcntl
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

LIMIT = 2 * 1024 * 1024
OUTPUT_LOCK = threading.Lock()
TERMINATE_LOCK = threading.Lock()


def emit(value):
    with OUTPUT_LOCK:
        print(json.dumps(value, ensure_ascii=False), flush=True)


def private_write(path, data):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('配置路径不能是符号链接。')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False)
        os.replace(str(temp), str(path))
    finally:
        temp.unlink(missing_ok=True)


def terminate(process):
    # EOF and an explicit stop can race. Reap each owned process only once.
    with TERMINATE_LOCK:
        if process is None or process.poll() is not None:
            return
        def send(sig):
            try:
                if os.getpgid(process.pid) == process.pid:
                    os.killpg(process.pid, sig)
                else:
                    process.send_signal(sig)
            except PermissionError:
                process.send_signal(sig)
        try:
            send(signal.SIGTERM)
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                send(signal.SIGKILL)
                process.wait(timeout=2)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
        except ProcessLookupError:
            pass


def validate(value):
    if not isinstance(value, dict) or set(value) != {'mcpServers'} or not isinstance(value['mcpServers'], dict) or len(value['mcpServers']) > 16:
        raise ValueError('请提供包含 mcpServers 的 JSON，最多 16 个 stdio 服务。')
    clean = {}
    for name, row in value['mcpServers'].items():
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', name) or not isinstance(row, dict) or set(row) - {'command', 'args', 'env', 'cwd', 'enabled'}:
            raise ValueError('服务名称或字段无效；第一版支持 command、args、env、cwd。')
        command, args, env, cwd = row.get('command'), row.get('args', []), row.get('env', {}), row.get('cwd')
        if not isinstance(command, str) or not command.strip() or '\0' in command or '\n' in command:
            raise ValueError('请填写有效的 MCP 可执行文件路径或命令名。')
        if not isinstance(args, list) or len(args) > 128 or any(not isinstance(x, str) or '\0' in x for x in args):
            raise ValueError('args 必须是字符串数组。')
        if not isinstance(env, dict) or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) or not isinstance(v, str) or '\0' in v for k, v in env.items()):
            raise ValueError('env 必须是环境变量名称到字符串的映射。')
        if cwd is not None and (not isinstance(cwd, str) or not os.path.isabs(os.path.expanduser(cwd))):
            raise ValueError('cwd 必须是 Mac 上的绝对目录。')
        clean[name] = {'command': command, 'args': args, 'env': env}
        if cwd is not None:
            clean[name]['cwd'] = cwd
    if len(json.dumps(clean).encode()) > 65536:
        raise ValueError('配置不能超过 64 KiB。')
    return clean


class Child:
    def __init__(self, config):
        self.lock, self.write_lock = threading.RLock(), threading.Lock()
        self.sequence, self.pending = 0, {}
        environment = dict(os.environ)
        environment['PATH'] = os.pathsep.join([environment.get('PATH', ''), '/opt/homebrew/bin', '/usr/local/bin'])
        environment.update(config.get('env', {}))
        command = os.path.expanduser(config['command'])
        executable = command if os.path.isabs(command) else shutil.which(command, path=environment.get('PATH'))
        if not executable:
            raise ValueError('未找到本地 MCP 命令，请使用绝对路径或配置 PATH。')
        try:
            self.process = subprocess.Popen([executable] + config.get('args', []), cwd=os.path.expanduser(config['cwd']) if config.get('cwd') else None, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            raise ValueError('无法启动本地 MCP，请检查命令路径、参数和工作目录。')
        threading.Thread(target=self.read, daemon=True).start()
        try:
            result = self.request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'remote-codex-desktop', 'version': '0.1.0'}}, timeout=20)
            if not isinstance(result.get('protocolVersion'), str):
                raise ValueError('MCP initialize 返回无效。')
            self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        except BaseException:
            self.close()
            if sys.exc_info()[0] in (SystemExit, KeyboardInterrupt):
                raise
            raise ValueError('本地 MCP 握手失败或超时；请检查 stdio 配置。')

    def send(self, value):
        data = json.dumps(value).encode() + b'\n'
        with self.write_lock:
            self.process.stdin.write(data)
            self.process.stdin.flush()

    def read(self):
        try:
            while True:
                line = self.process.stdout.readline(LIMIT + 1)
                if not line or len(line) > LIMIT:
                    break
                value = json.loads(line)
                if 'method' in value:
                    if 'id' in value:
                        self.send({'jsonrpc': '2.0', 'id': value['id'], 'error': {'code': -32601, 'message': 'Client requests are not supported'}})
                    continue
                with self.lock:
                    waiting = self.pending.get(value.get('id'))
                    if waiting:
                        waiting[1].append(value)
                        waiting[0].set()
        except Exception:
            pass
        finally:
            with self.lock:
                for event, values in self.pending.values():
                    values.append({'error': True})
                    event.set()
            terminate(self.process)

    def request(self, method, params, timeout=30):
        with self.lock:
            self.sequence += 1
            ident = self.sequence
            event, values = threading.Event(), []
            self.pending[ident] = (event, values)
        try:
            if self.process.poll() is not None:
                raise ValueError('本地 MCP 已退出，请在面板中重新启动。')
            self.send({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
            if not event.wait(timeout):
                try:
                    self.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': ident, 'reason': 'Client timeout'}})
                except Exception:
                    pass
                raise ValueError('本地 MCP 超时；执行结果可能未知，请勿自动重试。')
            if not values or 'error' in values[0] or not isinstance(values[0].get('result'), dict):
                raise ValueError('本地 MCP 请求失败；执行结果可能未知，请勿自动重试。')
            return values[0]['result']
        finally:
            with self.lock:
                self.pending.pop(ident, None)

    def tools(self):
        result, cursor, tools, cursors = {}, None, [], set()
        while True:
            result = self.request('tools/list', {'cursor': cursor} if cursor else {})
            rows = result.get('tools')
            if not isinstance(rows, list) or any(not isinstance(t, dict) or not isinstance(t.get('name'), str) or not isinstance(t.get('inputSchema'), dict) for t in rows):
                raise ValueError('本地 MCP 返回的工具列表无效。')
            tools.extend(rows)
            if len(tools) > 500 or len(json.dumps(tools).encode()) > LIMIT // 2:
                raise ValueError('工具目录超过数量或大小限制。')
            next_cursor = result.get('nextCursor')
            if not next_cursor:
                return tools
            if not isinstance(next_cursor, str) or next_cursor in cursors or len(cursors) >= 32:
                raise ValueError('工具列表游标无效。')
            cursors.add(next_cursor)
            cursor = next_cursor

    def close(self):
        terminate(getattr(self, 'process', None))
        with self.lock:
            for event, values in self.pending.values():
                values.append({'error': True})
                event.set()
        for stream in (getattr(self.process, 'stdin', None), getattr(self.process, 'stdout', None)):
            if stream:
                stream.close()


INSTALL = r'''
import base64,json,os,pathlib,re,sys
os.umask(0o077)
p=json.load(sys.stdin)
assert re.fullmatch('[a-f0-9]{32}',p['device']) and re.fullmatch('[a-f0-9]{32}',p['nonce'])
base=pathlib.Path.home()/'.local/share/remote-codex/local-mcp'/p['device']
state=pathlib.Path.home()/'.local/state/remote-codex/local-mcp'/p['device']
sockets=pathlib.Path.home()/'.cache/rcmcp'
for folder in (base,state,sockets):
 if folder.is_symlink():raise ValueError('Unexpected symlink')
 folder.mkdir(parents=True,exist_ok=True,mode=0o700);folder.chmod(0o700)
socket=str(sockets/(p['device'][:8]+'-'+p['nonce'][:8]+'.sock'))
assert len(socket.encode())<100 and not pathlib.Path(socket).exists()
proxy=base/'proxy.py';endpoint=state/'endpoint.json'
for path,data in ((proxy,base64.b64decode(p['proxy'])),(endpoint,json.dumps({'socket':socket,'token':p['token']}).encode())):
 temp=path.with_name(path.name+'.'+p['nonce'])
 fd=os.open(str(temp),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data)
 os.replace(str(temp),str(path))
print(json.dumps({'socket':socket,'proxy':str(proxy),'endpoint':str(endpoint)}))
'''


class Manager:
    def __init__(self, state):
        os.umask(0o077)
        self.state, self.lock = Path(state), threading.RLock()
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state.chmod(0o700)
        self.state_lock = open(self.state/'manager.lock', 'a')
        try:
            fcntl.flock(self.state_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.state_lock.close()
            raise ValueError('本地 MCP 正由另一个客户端窗口管理。')
        device_file = self.state/'device.json'
        if not device_file.exists():
            private_write(device_file, {'id': uuid.uuid4().hex})
        self.device = json.loads(device_file.read_text())['id']
        if not re.fullmatch('[a-f0-9]{32}', self.device):
            raise ValueError('本地设备标识无效。')
        self.config_file = self.state/'servers.json'
        self.config = validate(json.loads(self.config_file.read_text())) if self.config_file.exists() else {}
        self.children, self.tool_counts = {}, {}
        self.allowed, self.target, self.remote = set(), None, None
        self.tunnel, self.active, self.reconnecting, self.generation = None, False, False, 0
        self.active_calls = 0
        self.token = secrets.token_urlsafe(32)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), self.handler())
        self.http.daemon_threads = True
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def snapshot(self):
        with self.lock:
            return {'servers': [{'id': name, 'running': name in self.children and self.children[name].process.poll() is None, 'toolCount': self.tool_counts.get(name, 0)} for name in self.config], 'sharing': self.active, 'reconnecting': self.reconnecting, 'host': self.target or '', 'authorizedThreads': sorted(self.allowed), 'serverName': 'mac_local_' + self.device[:12]}

    def notify(self):
        emit({'event': 'snapshot', 'value': self.snapshot()})

    def save(self, value):
        clean = validate(value)
        with self.lock:
            if self.active_calls:
                raise ValueError('本地工具仍在运行，请等待结束后再修改配置。')
            for child in self.children.values():
                child.close()
            self.children.clear()
            self.tool_counts.clear()
            private_write(self.config_file, {'mcpServers': clean})
            self.config = clean
        return self.snapshot()

    def start(self, name):
        with self.lock:
            if name not in self.config:
                raise ValueError('本地 MCP 配置不存在。')
            old = self.children.get(name)
            if old and old.process.poll() is None:
                return self.snapshot()
            if old:
                old.close()
            child = Child(self.config[name])
            try:
                count = len(child.tools())
            except BaseException:
                child.close()
                if sys.exc_info()[0] in (SystemExit, KeyboardInterrupt):
                    raise
                raise ValueError('无法读取本地 MCP 工具列表。')
            self.children[name], self.tool_counts[name] = child, count
        return self.snapshot()

    def stop_server(self, name, remove=False):
        with self.lock:
            child = self.children.pop(name, None)
            self.tool_counts.pop(name, None)
            if child:
                child.close()
            if remove:
                self.config.pop(name, None)
                private_write(self.config_file, {'mcpServers': self.config})
        return self.snapshot()

    def remote_request(self, value):
        operation = value.get('operation')
        with self.lock:
            if not self.active:
                raise ValueError('本地 MCP 远端访问已关闭或正在重新连接。')
            if operation == 'health':
                return {'available': True}
            if value.get('threadId') not in self.allowed:
                raise ValueError('请先在 Mac 客户端允许当前 Codex 会话。')
            if operation == 'list':
                children = list(self.children.items())
            elif operation == 'call':
                child = self.children.get(value.get('server'))
                if not child or not isinstance(value.get('tool'), str) or not isinstance(value.get('arguments'), dict):
                    raise ValueError('工具、参数或本地服务无效。')
                self.active_calls += 1
            else:
                raise ValueError('不支持的远端操作。')
        if operation == 'list':
            return {'servers': [{'server': name, 'tools': child.tools()} for name, child in children if child.process.poll() is None]}
        try:
            if value['tool'] not in {tool['name'] for tool in child.tools()}:
                raise ValueError('本地服务未提供这个工具。')
            return child.request('tools/call', {'name': value['tool'], 'arguments': value['arguments']}, timeout=120)
        finally:
            with self.lock:
                self.active_calls -= 1

    def handler(self):
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if self.path != '/mcp' or self.headers.get('Origin') or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + owner.token):
                    self.send_error(403)
                    return
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if length <= 0 or length > LIMIT:
                        raise ValueError('请求大小无效。')
                    self.connection.settimeout(135)
                    value = json.loads(self.rfile.read(length))
                    if not isinstance(value, dict):
                        raise ValueError('请求无效。')
                    result = owner.remote_request(value)
                    status = 200
                except ValueError as error:
                    status, result = 400, {'error': str(error)}
                except Exception:
                    status, result = 503, {'error': '本地 MCP 请求未完成，执行结果可能未知，请勿自动重试。'}
                body = json.dumps(result, ensure_ascii=False).encode()
                if len(body) > LIMIT:
                    status, body = 413, b'{"error":"Local MCP result exceeds limit; do not retry"}'
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass
        return Handler

    def connect_tunnel(self, host, generation):
        token = secrets.token_urlsafe(32)
        payload = {'device': self.device, 'nonce': uuid.uuid4().hex, 'token': token, 'proxy': base64.b64encode(Path(__file__).with_name('local_mcp_proxy.py').read_bytes()).decode()}
        try:
            result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'python3 -c ' + shlex.quote(INSTALL)], input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25, check=True)
            remote = json.loads(result.stdout)
            for key in ('socket', 'proxy', 'endpoint'):
                if not isinstance(remote.get(key), str) or not os.path.isabs(remote[key]) or '\n' in remote[key]:
                    raise ValueError('远端返回无效路径。')
            tunnel = subprocess.Popen(['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-R', remote['socket'] + ':127.0.0.1:' + str(self.http.server_address[1]), host], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            with self.lock:
                if generation != self.generation:
                    terminate(tunnel)
                    raise ValueError('连接操作已取消。')
                self.token, self.remote, self.tunnel, self.active = token, remote, tunnel, True
            command = shlex.join(['python3', remote['proxy'], '--endpoint', remote['endpoint'], '--probe'])
            for attempt in range(5):
                if tunnel.poll() is not None:
                    break
                probe = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, command], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
                if probe.returncode == 0 and json.loads(probe.stdout).get('available'):
                    return remote
                time.sleep(.2)
            raise ValueError('SSH 反向转发不可用，请确认远端允许 Unix socket 转发。')
        except Exception:
            with self.lock:
                if generation == self.generation:
                    self.active = False
                    terminate(self.tunnel)
                    self.tunnel = None
            raise ValueError('本地 MCP 通道连接失败，请检查 SSH、远端 Python 和反向转发权限。')

    def share(self, host, thread):
        if not isinstance(host, str) or not re.fullmatch('[A-Za-z0-9._-]+', host) or host.startswith('-') or not isinstance(thread, str) or not thread or len(thread) > 200:
            raise ValueError('请选择有效的远端主机和已建立的 Codex 会话。')
        with self.lock:
            same = self.target == host and self.active
            if self.target and self.target != host:
                raise ValueError('请先关闭原主机的远端访问，再连接其他主机。')
            self.allowed.add(thread)
            self.target = host
            if same:
                return self.registration()
            self.generation += 1
            generation = self.generation
        try:
            self.connect_tunnel(host, generation)
        except Exception:
            self.stop_bridge()
            raise
        threading.Thread(target=self.monitor, args=(host, generation), daemon=True).start()
        return self.registration()

    def registration(self):
        return {'snapshot': self.snapshot(), 'serverName': 'mac_local_' + self.device[:12], 'config': {'command': 'python3', 'args': [self.remote['proxy'], '--endpoint', self.remote['endpoint']], 'enabled': True}}

    def monitor(self, host, generation):
        attempt = 0
        while generation == self.generation:
            time.sleep(1)
            with self.lock:
                tunnel = self.tunnel
            if tunnel and tunnel.poll() is None:
                attempt = 0
                continue
            with self.lock:
                if generation != self.generation:
                    return
                self.active, self.reconnecting = False, True
            self.notify()
            time.sleep([1, 2, 4, 8, 15, 30][min(attempt, 5)])
            if generation != self.generation:
                return
            try:
                self.connect_tunnel(host, generation)
                with self.lock:
                    self.reconnecting = False
            except Exception:
                attempt += 1
            self.notify()

    def stop_bridge(self):
        with self.lock:
            self.generation += 1
            self.active = self.reconnecting = False
            self.allowed.clear()
            self.target = None
            self.token = secrets.token_urlsafe(32)
            tunnel, self.tunnel = self.tunnel, None
        terminate(tunnel)
        return self.snapshot()

    def operation(self, name, params):
        if name == 'snapshot':
            return self.snapshot()
        if name == 'readConfig':
            return {'mcpServers': self.config}
        if name == 'save':
            return self.save(params.get('config'))
        if name == 'start':
            return self.start(params.get('server'))
        if name in ('stop', 'remove'):
            return self.stop_server(params.get('server'), name == 'remove')
        if name == 'tools':
            child = self.children.get(params.get('server'))
            if not child:
                raise ValueError('请先启动本地 MCP。')
            return {'tools': child.tools()}
        if name == 'share':
            return self.share(params.get('host'), params.get('threadId'))
        if name == 'stopBridge':
            return self.stop_bridge()
        if name == 'revoke':
            with self.lock:
                self.allowed.discard(params.get('threadId'))
            return self.snapshot()
        raise ValueError('不支持的本地 MCP 操作。')

    def close(self):
        self.stop_bridge()
        for child in list(self.children.values()):
            child.close()
        self.http.shutdown()
        self.http.server_close()
        self.state_lock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    args = parser.parse_args()
    manager = Manager(args.state)
    def interrupted(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        for raw in sys.stdin.buffer:
            if len(raw) > LIMIT:
                break
            message = {}
            try:
                message = json.loads(raw)
                value = manager.operation(message.get('operation'), message.get('params') or {})
                emit({'id': message.get('id'), 'result': value})
                manager.notify()
            except ValueError as error:
                emit({'id': message.get('id'), 'error': str(error)})
            except Exception:
                emit({'id': message.get('id'), 'error': '本地 MCP 操作未完成，请检查配置；不会自动重试工具调用。'})
    finally:
        manager.close()


if __name__ == '__main__':
    main()
