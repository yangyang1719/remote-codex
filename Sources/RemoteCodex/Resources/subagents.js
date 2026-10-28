'use strict';
window.RemoteCodexSubagents = ({ panel, make, state, post, request, selectThread, richText, renderViewedImage }) => {
  const views = new Map(), messages = new Map(), selected = new Map(), expanded = new Set(), filters = new Map();
  let context, agents = [], root, more, sync, contextID, ready = false, watchStamp = '';
  const key = id => root + ':' + id;
  const record = id => { const k = key(id); if (!messages.has(k)) messages.set(k, { items: [], status: 'loading', nodes: new Map(), visible: 80 }); return messages.get(k); };
  const active = agent => agent.status?.type === 'active' || agent.lastTurnStatus === 'inProgress';
  const finished = agent => !active(agent) && ['completed', 'interrupted', 'failed'].includes(agent.lastTurnStatus);
  const label = agent => { const flags = agent.status?.activeFlags || []; return flags.includes('waitingOnUserInput') ? '等待回答' : flags.includes('waitingOnApproval') ? '等待审批' : agent.status?.type === 'systemError' ? '异常' : active(agent) ? (agent.status?.type === 'active' ? '运行中' : '执行中 · 远端记录') : ({completed:'已完成',interrupted:'已中断',failed:'失败'}[agent.lastTurnStatus] || ({idle:'空闲',notLoaded:'未加载',systemError:'异常'}[agent.status?.type]) || '读取状态中'); };
  const reconcile = (parent, rows) => { let next = parent.firstChild; for (const row of rows) { if (row === next) next = next.nextSibling; else parent.insertBefore(row, next); } while (next) { const old = next; next = next.nextSibling; old.remove(); } };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function watch() {
    const id = expanded.has(root) && selected.get(root), visible = agents.some(a => a.id === id && (filters.get(root) !== 'active' || active(a)) && (filters.get(root) !== 'done' || finished(a)));
    const stamp = ready && state.connected && id && visible ? [contextID, root, id].join(':') : '';
    if (stamp === watchStamp) return; watchStamp = stamp;
    post('watchSubagent', { contextThreadId: contextID, rootThreadId: root, threadId: stamp ? id : null });
  }
  function createView(id) {
    const box = make('details', 'subagents'), summary = make('summary'), toolbar = make('div', 'subagent-filters'), list = make('div', 'subagent-list');
    box.open = expanded.has(id); box.append(summary, toolbar, list);
    const view = { box, summary, toolbar, list, rows: new Map(), filterButtons: new Map() };
    for (const [value, title] of [['all','全部'],['active','进行中'],['done','已完成']]) {
      const button = make('button', 'subagent-filter', title); button.type = 'button'; button.onclick = () => { filters.set(id, value); renderRows(); watch(); }; toolbar.append(button); view.filterButtons.set(value, button);
    }
    box.ontoggle = () => { if (box.open) expanded.add(id); else expanded.delete(id); if (root === id) { renderRows(); watch(); } };
    return view;
  }
  function createRow(id) {
    const box = make('div', 'subagent-entry'), button = make('button', 'subagent-row'); button.type = 'button'; button.dataset.agentId = id;
    const title = make('div', 'subagent-title'), caret = make('span', 'subagent-caret'), name = make('strong'), status = make('span', 'work-state'), preview = make('div', 'subagent-preview'); title.append(caret, name, status); button.append(title, preview);
    const detail = make('div', 'subagent-inline'); detail.hidden = true; detail.dataset.agentMessages = id;
    const heading = make('div', 'subagent-message-heading'), statusText = make('span', 'subagent-sync-status'), full = make('button', 'work-action', '打开完整聊天'); full.type = 'button'; full.onclick = () => selectThread(id); heading.append(statusText, full);
    const meta = make('span', 'subagent-model'); heading.insertBefore(meta, full);
    const task = make('div', 'subagent-task'), feed = make('div', 'subagent-feed'); feed.setAttribute('role', 'log'); feed.setAttribute('aria-label', '子代理消息'); feed.tabIndex = 0;
    const latest = make('button', 'subagent-latest', '有新消息 · 跳到最新'); latest.type = 'button'; latest.hidden = true; latest.onclick = () => { feed.scrollTop = feed.scrollHeight; latest.hidden = true; };
    feed.onscroll = () => { if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 35) latest.hidden = true; };
    detail.append(heading, task, feed, latest); box.append(button, detail);
    button.onclick = () => { if (views.get(root)?.box.open) expanded.add(root); const current = selected.get(root); if (current === id) selected.delete(root); else selected.set(root, id); renderRows(); watch(); };
    return { box, button, caret, name, status, preview, detail, statusText, full, meta, task, feed, latest };
  }
  function renderRows() {
    const view = views.get(root); if (!view) return;
    setText(view.summary, `子代理 ${agents.length}${agents.some(active) ? ` · ${agents.filter(active).length} 个运行中` : ''}${sync === 'retrying' ? ' · 同步重试中' : !state.connected ? ' · 已断开' : ''}`);
    view.toolbar.hidden = agents.length < 5;
    for (const [value, button] of view.filterButtons) { const count = value === 'all' ? agents.length : value === 'active' ? agents.filter(active).length : agents.filter(finished).length; const title = {all:'全部',active:'进行中',done:'已完成'}[value]; setText(button, `${title} ${count}`); button.setAttribute('aria-pressed', String((filters.get(root) || 'all') === value)); }
    const filter = filters.get(root), visible = agents.filter(a => filter === 'active' ? active(a) : filter === 'done' ? finished(a) : true);
    const ordered = [...visible.filter(active), ...visible.filter(a => !active(a))], rows = [];
    for (const agent of ordered) {
      let row = view.rows.get(agent.id); if (!row) { row = createRow(agent.id); view.rows.set(agent.id, row); }
      const isSelected = selected.get(root) === agent.id, name = agent.agentNickname || agent.name || agent.agentRole || agent.id.slice(0, 8);
      row.button.disabled = !state.connected; row.button.setAttribute('aria-expanded', String(isSelected)); row.button.setAttribute('aria-controls', 'agent-inline-' + agent.id); row.detail.id = 'agent-inline-' + agent.id;
      setText(row.name, name); setText(row.status, label(agent)); setText(row.caret, isSelected ? '▾' : '▸');
      const cached = record(agent.id), replies = cached.items.filter(i => i.type === 'agentMessage'), serverIsOlder = replies.some(i => i.id === agent.latestReply?.id) && replies.at(-1)?.id !== agent.latestReply?.id;
      const latest = serverIsOlder || (isSelected && expanded.has(root)) ? cached.latest || agent.latestReply?.text : agent.latestReply?.text || cached.latest;
      setText(row.preview, latest || (active(agent) ? '正在处理任务…' : '展开查看消息')); row.preview.title = latest || '';
      let depth = 0, parent = agent.parentThreadId, seen = new Set(); while (parent && parent !== root && !seen.has(parent) && depth < 8) { seen.add(parent); depth++; parent = agents.find(a => a.id === parent)?.parentThreadId; }
      row.box.style.marginLeft = (depth * 12) + 'px'; row.box.dataset.parentAgent = agent.parentThreadId || ''; row.box.dataset.expanded = String(isSelected);
      row.detail.hidden = !isSelected; row.full.disabled = !state.connected;
      setText(row.meta, [agent.agentRole, agent.model, agent.reasoningEffort].filter(Boolean).join(' · ')); row.meta.hidden = !row.meta.textContent;
      setText(row.task, agent.preview ? '任务：' + agent.preview.slice(0, 300) : ''); row.task.hidden = !agent.preview;
      if (isSelected && expanded.has(root)) renderFeed(agent.id, row);
      rows.push(row.box);
    }
    if (more) rows.push(make('div', 'subagent-role', '当前显示前 2000 个子代理。'));
    if (!rows.length) rows.push(make('div', 'subagent-empty', '这里暂时没有子代理。'));
    const scroll = view.list.scrollTop; reconcile(view.list, rows); view.list.scrollTop = scroll;
  }
  function renderFeed(id, row) {
    const value = record(id), feed = row.feed, bottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 35;
    setText(row.statusText, !state.connected ? '已断开 · 显示上次消息' : ({loading:'读取消息中…',retrying:'同步暂时中断，正在重试…',active:'自动同步 · 只读'}[value.status] || '自动同步 · 只读'));
    const items = value.items.slice(-value.visible), rows = [];
    if (value.hasOlder || value.items.length > value.visible) {
      const older = make('button', 'work-action subagent-older', value.olderLoading ? '正在读取…' : '更早的消息'); older.type = 'button'; older.disabled = value.olderLoading || !state.connected;
      older.onclick = async () => {
        if (value.items.length > value.visible) { value.visible += 30; renderFeed(id, row); return; }
        value.olderLoading = true; renderFeed(id, row);
        try { await request('subagentOlder', { contextThreadId: contextID, threadId: id }); } catch (e) { value.error = e.message; }
        finally { value.olderLoading = false; if (selected.get(root) === id) renderFeed(id, row); }
      }; rows.push(older);
    }
    for (const item of items) {
      let cached = value.nodes.get(item.id), stamp = JSON.stringify(item);
      if (!cached || cached.stamp !== stamp) {
        const node = make('div', 'subagent-message'); node.dataset.messageId = item.id;
        if (item.type === 'imageView') node.append(renderViewedImage(item, id));
        else if (['agentMessage','userMessage'].includes(item.type)) { node.append(make('div', 'subagent-author', item.type === 'agentMessage' ? '子代理' : '任务消息')); const body = make('div', 'subagent-message-text'); richText(body, item.text || '', true); node.append(body); if (item.truncated) node.append(make('div', 'subagent-role', '较长内容请在完整聊天中查看。')); }
        else { const title = item.type === 'commandExecution' ? item.command || '运行命令' : item.type === 'fileChange' ? '更新文件：' + (item.paths || []).join('、') : [item.server, item.tool].filter(Boolean).join(' · '); node.classList.add('subagent-tool'); node.append(make('span', '', `${item.status === 'completed' ? '✓' : '›'} ${title}`)); }
        cached = { stamp, node }; value.nodes.set(item.id, cached);
      }
      rows.push(cached.node);
    }
    if (!items.length) rows.push(make('div', 'subagent-empty', value.status === 'loading' ? '正在读取子代理消息…' : value.status === 'retrying' ? '暂时读不到消息，将自动重试。' : '还没有可显示的消息。'));
    if (value.error) rows.push(make('div', 'question-error', value.error));
    const anchor = Array.from(feed.children).find(node => node.dataset.messageId && node.getBoundingClientRect().bottom > feed.getBoundingClientRect().top), top = anchor?.getBoundingClientRect().top;
    const oldHeight = feed.scrollHeight, oldScroll = feed.scrollTop;
    reconcile(feed, rows);
    if (value.prepended) { feed.scrollTop = oldScroll + feed.scrollHeight - oldHeight; value.prepended = false; }
    else if (bottom || !value.rendered) { feed.scrollTop = feed.scrollHeight; row.latest.hidden = true; }
    else if (anchor?.isConnected) feed.scrollTop = oldScroll + anchor.getBoundingClientRect().top - top;
    value.rendered = true;
    const visibleIDs = new Set(items.map(i => i.id)); for (const k of value.nodes.keys()) if (!visibleIDs.has(k)) value.nodes.delete(k);
  }
  function merge(value, items, prepend) {
    const byID = new Map(value.items.map(i => [i.id, i]));
    for (const item of items) { const old = byID.get(item.id); if (old?.type === 'agentMessage' && old.text?.length > (item.text || '').length && old.text.startsWith(item.text || '')) continue; byID.set(item.id, item); }
    const incoming = new Set(items.map(i => i.id));
    value.items = prepend ? [...items.map(i => byID.get(i.id)), ...value.items.filter(i => !incoming.has(i.id))] : [...value.items.map(i => byID.get(i.id)), ...items.filter(i => !value.items.some(old => old.id === i.id))];
    value.latest = [...value.items].reverse().find(i => i.type === 'agentMessage' && i.text)?.text?.slice(0, 500); value.prepended = prepend && value.rendered;
  }
  return {
    render(options) {
      ({ context, agents, more, sync } = options); root = context?.rootThreadId || state.active || 'new';
      if (contextID !== state.active) { contextID = state.active; ready = false; watchStamp = ''; }
      panel.hidden = !context?.parentThreadId && !agents.length;
      let view = views.get(root); if (!view) { view = createView(root); views.set(root, view); }
      const rows = [];
      if (context?.parentThreadId) { const back = make('button', 'work-action', '← 返回父会话'); back.type = 'button'; back.dataset.parentThread = context.parentThreadId; back.onclick = () => selectThread(context.parentThreadId); rows.push(back, make('span', 'subagent-readonly', '子代理 · 只读查看')); }
      if (agents.length) rows.push(view.box);
      reconcile(panel, rows); renderRows();
    },
    receive(event) {
      if (event.type === 'connection' && event.status !== 'connected') { ready = false; watchStamp = ''; }
      if (event.type === 'subagents' && event.rootThreadId === root) { ready = true; watch(); }
      if (['item', 'delta'].includes(event.type) && agents.some(a => a.id === event.threadId)) {
        const raw = event.type === 'item' ? event.item : (state.items[event.threadId] || []).find(i => i.id === event.itemId);
        if (raw?.type === 'agentMessage') {
          const value = record(event.threadId), row = views.get(root)?.rows.get(event.threadId), bottom = !row || row.feed.scrollHeight - row.feed.scrollTop - row.feed.clientHeight < 35;
          const previous = value.items.find(i => i.id === raw.id);
          const text = event.type === 'delta' && previous ? (previous.text || '') + (event.delta || '') : raw.text || '';
          merge(value, [{ id: raw.id, type: 'agentMessage', text: text.slice(0,64000) }], false);
          if (!bottom && row) row.latest.hidden = false;
          renderRows();
        }
      }
      if (event.type === 'subagentMessageSync' && event.rootThreadId === root) { const value = record(event.agentId); value.status = event.status; if (event.status === 'loading') { value.initial = true; value.latest = undefined; } renderRows(); }
      if (event.type === 'subagentMessages' && event.rootThreadId === root) {
        const value = record(event.agentId), row = views.get(root)?.rows.get(event.agentId), bottom = !row || row.feed.scrollHeight - row.feed.scrollTop - row.feed.clientHeight < 35;
        if (value.initial) { value.items = []; value.rendered = false; value.initial = false; }
        merge(value, event.items || [], event.prepend); value.hasOlder = event.hasOlder; value.status = 'active';
        if (!bottom && !event.prepend && row) row.latest.hidden = false;
        renderRows();
      }
    }
  };
};
