"""Offline fake Codex; no network, accounts, shell commands, or file edits."""
import asyncio
import json
import sys
import uuid

goals, threads, tasks, approvals = {}, {}, {}, {}


def send(value):
    print(json.dumps(value), flush=True)


def event(method, params):
    send({'method': method, 'params': params})


async def run_goal(thread):
    turn = uuid.uuid4().hex
    event('turn/started', {'threadId': thread, 'turn': {'id': turn, 'status': 'inProgress'}})
    event('turn/plan/updated', {'threadId': thread, 'turnId': turn, 'plan': [{'step': '离线完成验收', 'status': 'inProgress'}]})
    if goals[thread]['objective'] == 'approval':
        future = asyncio.get_running_loop().create_future(); approvals[thread] = future
        send({'id': 'approval-' + thread, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread, 'turnId': turn, 'command': 'fixture-only'}})
        await future
    else:
        await asyncio.sleep(.3)
    goals[thread]['status'] = 'complete'
    event('thread/goal/updated', {'threadId': thread, 'goal': goals[thread]})
    event('turn/completed', {'threadId': thread, 'turn': {'id': turn, 'status': 'completed'}})


async def main():
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line); method = request.get('method'); params = request.get('params', {})
        if not method:
            thread = str(request['id']).removeprefix('approval-')
            if thread in approvals:
                approvals[thread].set_result(True)
            continue
        ident = request.get('id'); result = {}
        if method == 'initialize':
            result = {'userAgent': 'fixture'}
        elif method == 'thread/start':
            thread = uuid.uuid4().hex; threads[thread] = {'id': thread}; result = {'thread': threads[thread], 'model': 'fixture'}
        elif method == 'thread/resume':
            if params['threadId'] == 'external':
                send({'id': ident, 'error': {'code': -32000, 'message': 'already has an active writer'}}); continue
            result = {'thread': threads[params['threadId']], 'model': 'fixture'}
        elif method == 'thread/goal/set':
            thread = params['threadId']; goal = goals.setdefault(thread, {'threadId': thread})
            goal.update({k: v for k, v in params.items() if k in ('objective', 'status', 'tokenBudget')}); result = {'goal': goal}
            event('thread/goal/updated', {'threadId': thread, 'goal': goal})
            if goal.get('status') == 'active' and (thread not in tasks or tasks[thread].done()):
                tasks[thread] = asyncio.create_task(run_goal(thread))
        elif method == 'thread/goal/get':
            result = {'goal': goals.get(params['threadId'])}
        elif method == 'turn/interrupt':
            thread = params['threadId']
            if thread in tasks:
                tasks[thread].cancel()
            event('turn/completed', {'threadId': thread, 'turn': {'id': params['turnId'], 'status': 'interrupted'}})
        if ident is not None:
            send({'id': ident, 'result': result})


asyncio.run(main())
