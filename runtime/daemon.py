#!/usr/bin/env python3
"""Private SSH-accessed, persistent owner of Codex app-server processes."""
import argparse
import asyncio
import fcntl
import json
import os
import signal
import stat
import uuid
from pathlib import Path

LIMIT = 32 * 1024 * 1024
READS = {'thread/read', 'thread/list', 'thread/goal/get', 'thread/turns/list',
         'thread/items/list', 'thread/backgroundTerminals/list'}


class RPCError(Exception):
    def __init__(self, message, code=-32000):
        super().__init__(message)
        self.code = code


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'


class Registry:
    def __init__(self, path):
        self.path = Path(path)
        self.entries = json.loads(self.path.read_text()) if self.path.exists() else {}

    def save(self):
        temp = self.path.with_suffix('.new')
        temp.write_bytes(encoded(self.entries))
        os.chmod(temp, 0o600)
        os.replace(temp, self.path)


class Backend:
    def __init__(self, server, project, executable, command=None):
        self.server, self.project, self.executable = server, project, executable
        self.command = command or [executable, 'app-server', '--listen', 'stdio://']
        self.pending, self.leases, self.clients, self.active, self.plans, self.approvals = {}, {}, set(), {}, {}, {}
        self.owned = set()
        self.process = self.reader_task = None
        self.initialized = None
        self.write_lock = asyncio.Lock()

    async def start(self):
        self.process = await asyncio.create_subprocess_exec(*self.command, cwd=self.project, stdin=asyncio.subprocess.PIPE,
                                                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=LIMIT)
        self.reader_task = asyncio.create_task(self.read())
        self.initialized = await self.call('initialize', {'clientInfo': {'name': 'remote_codex_runtime', 'title': 'Remote Codex', 'version': '0.2.0'}, 'capabilities': {'experimentalApi': True}})
        await self.write({'method': 'initialized', 'params': {}})
        return self

    async def write(self, value):
        async with self.write_lock:
            if not self.process or self.process.returncode is not None:
                raise RPCError('远端 Codex 执行进程不可用。')
            self.process.stdin.write(encoded(value))
            await self.process.stdin.drain()

    async def call(self, method, params):
        ident = 'runtime-' + uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self.write({'id': ident, 'method': method, 'params': params})
            return await asyncio.wait_for(future, 90)
        finally:
            self.pending.pop(ident, None)

    def register(self, thread):
        self.owned.add(thread)
        entry = self.server.registry.entries.setdefault(thread, {})
        entry.update(project=self.project, executable=self.executable)
        self.server.registry.save()

    def snapshot(self, thread, client):
        entry = self.server.registry.entries.get(thread, {})
        managed = entry.get('project') == self.project and entry.get('executable') == self.executable
        return {'threadId': thread, 'managed': managed, 'controlled': self.leases.get(thread) is client,
                'activeTurn': self.active.get(thread), 'plan': self.plans.get(thread, entry.get('plan')),
                'pendingApprovals': sum(p['thread'] == thread for p in self.approvals.values()), 'persistent': True}

    async def state_changed(self, thread):
        for client in list(self.clients):
            if thread in client.watches:
                await client.send({'method': 'runtime/stateChanged', 'params': self.snapshot(thread, client)})

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                value = json.loads(line)
                if 'method' not in value and value.get('id') in self.pending:
                    future = self.pending[value['id']]
                    if not future.done():
                        if 'error' in value:
                            future.set_exception(RPCError(value['error'].get('message', '远端协议错误'), value['error'].get('code', -32000)))
                        else:
                            future.set_result(value.get('result', {}))
                    continue
                method, params = value.get('method', ''), value.get('params', {})
                thread = params.get('threadId') or params.get('thread', {}).get('id')
                if 'id' in value:
                    proxy = 'runtime-request-' + uuid.uuid4().hex
                    self.approvals[proxy] = {'id': value['id'], 'thread': thread, 'message': {**value, 'id': proxy}}
                    owner = self.leases.get(thread)
                    if owner:
                        await owner.send(self.approvals[proxy]['message'])
                    await self.state_changed(thread)
                    continue
                changed = False
                if method == 'turn/started':
                    self.active[thread] = params['turn']['id']; changed = True
                elif method == 'turn/completed':
                    self.active.pop(thread, None); changed = True
                    for ident in [i for i, item in self.approvals.items() if item['thread'] == thread]:
                        self.approvals.pop(ident)
                elif method == 'turn/plan/updated':
                    self.plans[thread] = params; changed = True
                    if thread in self.server.registry.entries:
                        self.server.registry.entries[thread]['plan'] = params
                        self.server.registry.save()
                elif method in ('thread/goal/updated', 'thread/goal/cleared'):
                    self.register(thread)
                    self.server.registry.entries[thread]['goalStatus'] = params.get('goal', {}).get('status') if method.endswith('updated') else None
                    self.server.registry.save(); changed = True
                elif method == 'serverRequest/resolved':
                    for ident in [i for i, item in self.approvals.items() if item['id'] == params.get('requestId')]:
                        self.approvals.pop(ident)
                    changed = True
                for client in list(self.clients):
                    # Only the controller gets writable runtime events; observers
                    # use persisted history and explicit progress snapshots.
                    if not thread or self.leases.get(thread) is client or (thread in client.watches and method.startswith('thread/goal/')):
                        await client.send(value)
                if changed and thread:
                    await self.state_changed(thread)
        except (ValueError, ConnectionError, asyncio.CancelledError):
            pass
        finally:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(RPCError('远端执行进程已结束，目标状态保留。'))
            for client in list(self.clients):
                await client.send({'method': 'runtime/unavailable', 'params': {'message': '远端执行进程已结束，请重新连接。'}})
                client.writer.close()
            if not self.server.closing:
                self.server.failure.set()

    async def replay(self, client, thread):
        for item in list(self.approvals.values()):
            if item['thread'] == thread:
                await client.send(item['message'])

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 10)
            except asyncio.TimeoutError:
                self.process.kill(); await self.process.wait()
        if self.reader_task:
            await self.reader_task


class Client:
    def __init__(self, server, reader, writer):
        self.server, self.reader, self.writer = server, reader, writer
        self.backend = None
        self.watches, self.tasks = set(), set()
        self.connected = True

    async def send(self, value):
        if not self.connected or self.writer.is_closing():
            return
        try:
            self.writer.write(encoded(value))
            # Disconnect a stalled display without stopping the worker.
            await asyncio.wait_for(self.writer.drain(), 5)
        except (ConnectionError, asyncio.TimeoutError):
            self.writer.close()

    async def handle(self, value):
        ident, method, params = value.get('id'), value.get('method'), value.get('params', {})
        try:
            if method == 'initialize':
                result = {**self.backend.initialized, 'remoteRuntime': {'persistent': True, 'version': 1}}
            elif method == 'initialized':
                return
            elif not method and ident in self.backend.approvals:
                item = self.backend.approvals[ident]
                if self.backend.leases.get(item['thread']) is not self:
                    raise RPCError('此会话由其他客户端控制，不能审批。')
                self.backend.approvals.pop(ident)
                await self.backend.write({**value, 'id': item['id']})
                await self.backend.state_changed(item['thread']); return
            elif method == 'runtime/state':
                thread = params['threadId']; self.watches.add(thread)
                result = self.backend.snapshot(thread, self)
                if result['controlled']:
                    await self.backend.replay(self, thread)
            elif method == 'runtime/status':
                result = self.server.status()
            elif method == 'thread/loaded/list':
                result = {'data': [t for t, c in self.backend.leases.items() if c is self], 'nextCursor': None}
            elif method == 'thread/unsubscribe':
                thread = params['threadId']
                if self.backend.leases.get(thread) is self:
                    self.backend.leases.pop(thread)
                self.watches.discard(thread)
                result = {'status': 'unsubscribed'}
            else:
                thread = params.get('threadId')
                mutating = method not in READS and (thread or method in ('thread/start', 'thread/fork'))
                if mutating and self.server.stopping:
                    raise RPCError('远端常驻服务正在关闭，请稍后重新开启。')
                if mutating:
                    self.server.mutations.add(asyncio.current_task())
                claimed = False
                if method == 'thread/resume':
                    owner = self.backend.leases.get(thread)
                    if owner and owner is not self:
                        raise RPCError(f'thread {thread} already has an active writer')
                    if not owner:
                        self.backend.leases[thread] = self; claimed = True
                elif thread and method not in READS and self.backend.leases.get(thread) is not self:
                    raise RPCError(f'thread {thread} already has an active writer; continue this chat before modifying it')
                try:
                    result = await self.backend.call(method, params)
                except Exception:
                    if claimed and self.backend.leases.get(thread) is self:
                        self.backend.leases.pop(thread, None)
                    raise
                if method in ('thread/start', 'thread/resume', 'thread/fork'):
                    thread = result['thread']['id']; self.backend.register(thread)
                    if self.connected:
                        self.backend.leases[thread] = self; self.watches.add(thread)
                    elif self.backend.leases.get(thread) is self:
                        self.backend.leases.pop(thread)
                if method in ('thread/goal/set', 'thread/goal/clear'):
                    self.backend.register(thread)
                    self.server.registry.entries[thread]['goalStatus'] = result.get('goal', {}).get('status')
                    self.server.registry.save()
            if ident is not None:
                await self.send({'id': ident, 'result': result})
            if method == 'thread/resume':
                await self.backend.replay(self, params['threadId'])
        except (RPCError, KeyError, ValueError, asyncio.TimeoutError) as error:
            if ident is not None:
                await self.send({'id': ident, 'error': {'code': getattr(error, 'code', -32000), 'message': str(error)}})
        finally:
            self.server.mutations.discard(asyncio.current_task())

    async def run(self):
        try:
            hello = json.loads(await asyncio.wait_for(self.reader.readline(), 15))
            if hello.get('method') == 'runtime/admin':
                operation = hello.get('params', {}).get('operation')
                result = await self.server.prepare_stop() if operation == 'prepareStop' else self.server.status()
                await self.send({'id': hello.get('id'), 'result': result}); return
            if hello.get('method') != 'runtime/attach' or self.server.stopping:
                raise RPCError('远端常驻服务未就绪。')
            params = hello['params']; project, executable = params['project'], params['executable']
            if not all(isinstance(p, str) and p.startswith('/') and '\0' not in p and '\n' not in p for p in (project, executable)):
                raise RPCError('工作目录和程序必须使用远端绝对路径。')
            self.backend = await self.server.backend(project, executable)
            self.backend.clients.add(self)
            await self.send({'id': hello.get('id'), 'result': {'attached': True}})
            while line := await self.reader.readline():
                value = json.loads(line)
                if len(self.tasks) >= 200:
                    raise RPCError('请求过多，请稍后重试。')
                task = asyncio.create_task(self.handle(value)); self.tasks.add(task); task.add_done_callback(self.tasks.discard)
        except (ValueError, ConnectionError, RPCError, asyncio.TimeoutError) as error:
            await self.send({'error': {'message': str(error)}})
        finally:
            self.connected = False
            if self.backend:
                self.backend.clients.discard(self)
                for thread in [t for t, c in self.backend.leases.items() if c is self]:
                    self.backend.leases.pop(thread)
            self.writer.close()


class Server:
    def __init__(self, state, backend_command=None):
        self.state = Path(state); self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.registry = Registry(self.state / 'threads.json')
        self.backends, self.creating = {}, {}
        self.backend_command = backend_command
        self.failure = asyncio.Event(); self.closing = self.stopping = False
        self.mutations = set()
        self.restore_task = None
        self.socket = self.state / 'control.sock'
        self.listener = None

    async def backend(self, project, executable):
        key = (project, executable)
        if key not in self.backends:
            if key not in self.creating:
                self.creating[key] = asyncio.create_task(Backend(self, project, executable, self.backend_command).start())
            self.backends[key] = await self.creating[key]
        return self.backends[key]

    def status(self):
        return {'persistent': True, 'stopping': self.stopping, 'clients': sum(len(b.clients) for b in self.backends.values()),
                'workers': len(self.backends), 'activeTurns': sum(len(b.active) for b in self.backends.values()),
                'activeGoals': sum(self.registry.entries.get(t, {}).get('goalStatus') == 'active' for b in self.backends.values() for t in b.owned),
                'pendingApprovals': sum(len(b.approvals) for b in self.backends.values()),
                'workerPIDs': [b.process.pid for b in self.backends.values()]}

    async def prepare_stop(self):
        self.stopping = True
        if self.restore_task:
            await self.restore_task
        if self.mutations:
            await asyncio.gather(*list(self.mutations), return_exceptions=True)
        for backend in list(self.backends.values()):
            for thread, entry in list(self.registry.entries.items()):
                if (entry.get('project'), entry.get('executable')) != (backend.project, backend.executable):
                    continue
                if thread not in backend.owned:
                    continue
                if entry.get('goalStatus') == 'active':
                    result = await backend.call('thread/goal/set', {'threadId': thread, 'status': 'paused', 'origin': 'user'})
                    entry['goalStatus'] = result.get('goal', {}).get('status')
            for thread, turn in list(backend.active.items()):
                try:
                    await backend.call('turn/interrupt', {'threadId': thread, 'turnId': turn})
                except RPCError:
                    if backend.active.get(thread) == turn:
                        raise
        self.registry.save()
        return self.status()

    async def restore(self):
        for thread, entry in list(self.registry.entries.items()):
            if self.stopping:
                return
            if entry.get('goalStatus') != 'active':
                continue
            backend = await self.backend(entry['project'], entry['executable'])
            try:
                goal = (await backend.call('thread/goal/get', {'threadId': thread})).get('goal')
            except RPCError:
                continue
            if not goal or goal['status'] != 'active':
                entry['goalStatus'] = goal.get('status') if goal else None; self.registry.save(); continue
            try:
                await backend.call('thread/resume', {'threadId': thread, 'excludeTurns': True})
                backend.register(thread)
            except RPCError:
                # External writers retain their lock. Never clear or steal it.
                continue

    async def start(self):
        if self.socket.exists():
            if not stat.S_ISSOCK(self.socket.stat().st_mode):
                raise RuntimeError('Refusing to replace a non-socket control path')
            self.socket.unlink()
        self.listener = await asyncio.start_unix_server(lambda r, w: Client(self, r, w).run(), str(self.socket), limit=LIMIT)
        os.chmod(self.socket, 0o600)

    async def close(self):
        self.closing = True
        if self.listener:
            self.listener.close(); await self.listener.wait_closed()
        await asyncio.gather(*(b.close() for b in self.backends.values()), return_exceptions=True)
        self.socket.unlink(missing_ok=True)


async def main(state):
    server = Server(state)
    lock = open(server.state / 'daemon.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    loop = asyncio.get_running_loop(); done = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, done.set)
    await server.start(); server.restore_task = asyncio.create_task(server.restore()); await server.restore_task
    stop = asyncio.create_task(done.wait()); failure = asyncio.create_task(server.failure.wait())
    await asyncio.wait([stop, failure], return_when=asyncio.FIRST_COMPLETED)
    await server.close()
    if server.failure.is_set():
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--state', default=str(Path.home() / '.local/state/remote-codex-runtime'))
    asyncio.run(main(parser.parse_args().state))
