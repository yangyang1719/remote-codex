import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

from daemon import Server, encoded


class Peer:
    @classmethod
    async def connect(cls, server):
        self = cls(); self.reader, self.writer = await asyncio.open_unix_connection(str(server.socket))
        self.writer.write(encoded({'id': 'attach', 'method': 'runtime/attach', 'params': {'project': '/tmp', 'executable': '/fixture'}})); await self.writer.drain()
        assert json.loads(await self.reader.readline())['result']['attached']
        self.futures, self.events, self.sequence = {}, [], 0
        self.task = asyncio.create_task(self.read())
        await self.call('initialize', {})
        return self

    async def read(self):
        while line := await self.reader.readline():
            message = json.loads(line)
            if message.get('id') in self.futures and 'method' not in message:
                future = self.futures.pop(message['id'])
                if 'error' in message:
                    future.set_exception(RuntimeError(message['error']['message']))
                else:
                    future.set_result(message['result'])
            else:
                self.events.append(message)

    async def call(self, method, params):
        self.sequence += 1; ident = str(self.sequence)
        future = asyncio.get_running_loop().create_future(); self.futures[ident] = future
        self.writer.write(encoded({'id': ident, 'method': method, 'params': params})); await self.writer.drain()
        return await asyncio.wait_for(future, 3)

    async def close(self):
        self.writer.close(); await self.writer.wait_closed(); await self.task


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.peers = []
        self.server = Server(self.temp.name, [sys.executable, str(Path(__file__).with_name('fixture.py'))]); await self.server.start()

    async def peer(self):
        peer = await Peer.connect(self.server); self.peers.append(peer); return peer

    async def until(self, predicate):
        for _ in range(100):
            if predicate():
                return
            await asyncio.sleep(.02)
        self.fail('Runtime condition timed out')

    async def asyncTearDown(self):
        for peer in self.peers:
            await peer.close()
        await self.server.close(); self.temp.cleanup()

    async def testDisconnectKeepsWorkerRunningAndProgressCanBeReattached(self):
        peer = await self.peer(); thread = (await peer.call('thread/start', {}))['thread']['id']
        await peer.call('thread/goal/set', {'threadId': thread, 'objective': 'finish', 'status': 'active'})
        pid = self.server.status()['workerPIDs'][0]
        await self.until(lambda: self.server.status()['activeTurns'] == 1)
        await peer.close(); await self.until(lambda: self.server.status()['clients'] == 0)
        await self.until(lambda: self.server.registry.entries[thread].get('goalStatus') == 'complete')
        self.assertEqual(self.server.status()['workerPIDs'], [pid])
        next_peer = await self.peer(); snapshot = await next_peer.call('runtime/state', {'threadId': thread})
        self.assertTrue(snapshot['managed']); self.assertFalse(snapshot['controlled']); self.assertTrue(snapshot['plan'])
        self.assertEqual((await next_peer.call('thread/goal/get', {'threadId': thread}))['goal']['status'], 'complete')

    async def testControllerLeaseSurvivesConflictsAndReleasesOnDisconnect(self):
        owner, viewer = await self.peer(), await self.peer()
        thread = (await owner.call('thread/start', {}))['thread']['id']
        self.assertEqual((await viewer.call('thread/loaded/list', {}))['data'], [])
        with self.assertRaisesRegex(RuntimeError, 'active writer'):
            await viewer.call('thread/resume', {'threadId': thread})
        with self.assertRaisesRegex(RuntimeError, 'active writer'):
            await viewer.call('thread/goal/set', {'threadId': thread, 'status': 'active'})
        await owner.close(); await self.until(lambda: self.server.status()['clients'] == 1)
        await viewer.call('thread/resume', {'threadId': thread})
        self.assertTrue((await viewer.call('runtime/state', {'threadId': thread}))['controlled'])
        with self.assertRaisesRegex(RuntimeError, 'active writer'):
            await viewer.call('thread/resume', {'threadId': 'external'})

    async def testOfflineApprovalWaitsAndReplaysAfterControlIsAcquired(self):
        owner = await self.peer(); thread = (await owner.call('thread/start', {}))['thread']['id']
        await owner.call('thread/goal/set', {'threadId': thread, 'objective': 'approval', 'status': 'active'})
        await self.until(lambda: self.server.status()['pendingApprovals'] == 1)
        await owner.close(); viewer = await self.peer()
        await asyncio.sleep(.05)
        self.assertFalse(any('id' in e for e in viewer.events), 'An observer must not get actionable approvals')
        await viewer.call('thread/resume', {'threadId': thread})
        await self.until(lambda: any(e.get('method') == 'item/commandExecution/requestApproval' for e in viewer.events))
        request = next(e for e in viewer.events if e.get('method') == 'item/commandExecution/requestApproval')
        viewer.writer.write(encoded({'id': request['id'], 'result': {'decision': 'approved'}})); await viewer.writer.drain()
        await self.until(lambda: self.server.registry.entries[thread].get('goalStatus') == 'complete')

    async def testExplicitStopPausesBeforeShutdownAndDoesNotAutoResumePausedGoals(self):
        owner = await self.peer(); thread = (await owner.call('thread/start', {}))['thread']['id']
        await owner.call('thread/goal/set', {'threadId': thread, 'objective': 'approval', 'status': 'active'})
        await self.until(lambda: self.server.status()['activeTurns'] == 1)
        await self.server.prepare_stop()
        self.assertEqual(self.server.registry.entries[thread]['goalStatus'], 'paused')
        await self.until(lambda: self.server.status()['activeTurns'] == 0)
        with self.assertRaisesRegex(RuntimeError, '关闭'):
            await owner.call('thread/goal/set', {'threadId': thread, 'status': 'active'})
        await owner.close(); await self.server.close()
        self.server = Server(self.temp.name, [sys.executable, str(Path(__file__).with_name('fixture.py'))]); await self.server.start(); await self.server.restore()
        self.assertEqual(self.server.status()['workers'], 0, 'Starting the service must not automatically resume explicitly paused work')

    async def testStopIgnoresHistoricalThreadsOwnedByAnotherProcess(self):
        owner = await self.peer()
        self.server.registry.entries['external'] = {'project': '/tmp', 'executable': '/fixture', 'goalStatus': 'active'}
        self.server.registry.save()
        self.assertEqual(self.server.status()['activeGoals'], 0)
        await self.server.prepare_stop()
        self.assertEqual(self.server.registry.entries['external']['goalStatus'], 'active', 'An external goal must not be paused by this service')


if __name__ == '__main__':
    unittest.main()
