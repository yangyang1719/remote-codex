'use strict';
window.RemoteCodexProjects = ({ root, state, q, make, icon, icons, request, selectThread, flush, controls }) => {
  let workspace, menu, busy = false;
  const pages = new Map(), archiveViews = new Map(), loadStates = new Map();
  const feedback = make('div', 'workspace-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true; q('.nav-bottom').before(feedback);
  const dialog = document.createElement('dialog'); dialog.id = 'workspace-dialog'; dialog.className = 'workspace-dialog'; root.append(dialog);
  function notice(text = '') { feedback.textContent = text; feedback.hidden = !text; }
  function closeMenu() { menu?.remove(); menu = null; }
  async function perform(action, values) {
    if (busy) return null;
    busy = true; state.workspaceBusy = true; controls(); render(); notice();
    try { return await request(action, values); }
    catch (error) { notice(error.message); throw error; }
    finally { busy = false; state.workspaceBusy = false; controls(); render(); }
  }
  async function openProject(id, threadId) {
    if (id === workspace.activeProjectId) { if (threadId) selectThread(threadId); return; }
    await flush(); await perform('projectAction', { operation: 'select', projectId: id, threadId });
  }
  function form(title, fields, submitLabel, submit, message = '') {
    closeMenu(); dialog.replaceChildren();
    const form = make('form'); form.method = 'dialog'; const heading = make('h3', '', title); form.append(heading);
    if (message) form.append(make('p', 'workspace-dialog-note', message));
    const inputs = {};
    for (const field of fields) {
      const label = make('label', '', field.label), input = make('input'); input.id = 'workspace-' + field.key; label.htmlFor = input.id;
      input.value = field.value || ''; input.placeholder = field.placeholder || ''; input.maxLength = field.key === 'path' ? 4096 : 128; input.required = !!field.required;
      if (field.key === 'host') {
        const list = make('datalist'); list.id = 'workspace-hosts';
        for (const alias of workspace.aliases || []) { const option = make('option'); option.value = alias; list.append(option); }
        input.setAttribute('list', list.id); form.append(list);
      }
      inputs[field.key] = input; form.append(label, input);
    }
    const error = make('p', 'workspace-dialog-error'); error.id = 'workspace-dialog-error'; error.setAttribute('role', 'alert');
    const actions = make('div', 'workspace-dialog-actions'), cancel = make('button', 'small-button', '取消'), save = make('button', 'small-button strong', submitLabel);
    cancel.type = 'button'; cancel.onclick = () => dialog.close(); save.type = 'submit'; save.id = 'workspace-save'; actions.append(cancel, save); form.append(error, actions); dialog.append(form);
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try { await submit(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]))); dialog.close(); }
      catch (failure) { error.textContent = failure.message; }
      finally { save.disabled = false; }
    };
    if (!dialog.open) dialog.showModal(); const first = Object.values(inputs)[0]; if (first) { first.focus(); first.select(); } else save.focus();
  }
  function popup(anchor, entries) {
    closeMenu(); menu = make('div', 'workspace-menu'); menu.setAttribute('role', 'menu');
    for (const entry of entries) {
      const button = make('button', '', entry.label); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = busy || entry.disabled;
      button.onclick = () => { closeMenu(); Promise.resolve(entry.run()).catch(() => {}); }; menu.append(button);
    }
    root.append(menu); const bounds = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(bounds.right - 185, innerWidth - 200)) + 'px';
    menu.style.top = Math.max(8, Math.min(bounds.bottom + 3, innerHeight - menu.offsetHeight - 12)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  function threadMenu(anchor, project, thread) {
    const pinned = project.pinned.includes(thread.id), archived = project.archived.includes(thread.id);
    popup(anchor, [
      { label: pinned ? '取消置顶' : '置顶会话', run: () => perform('threadAction', { operation: 'pin', projectId: project.id, threadId: thread.id, value: !pinned }) },
      { label: '重命名…', disabled: !state.connected, run: () => form('重命名会话', [{ key: 'name', label: '会话名称', value: thread.name || '', required: true }], '保存', value => perform('threadAction', { operation: 'rename', projectId: project.id, threadId: thread.id, name: value.name })) },
      { label: '从已结束的回合分叉', disabled: !state.connected || project.id !== workspace.activeProjectId, run: () => perform('threadAction', { operation: 'fork', projectId: project.id, threadId: thread.id }) },
      { label: archived ? '恢复到会话列表' : '移入归档（本地）', run: () => perform('threadAction', { operation: 'archive', projectId: project.id, threadId: thread.id, value: !archived }).then(() => notice(archived ? '已恢复到列表' : '已移入本地归档，远端任务继续执行。')) }
    ]);
  }
  function projectMenu(anchor, project) {
    popup(anchor, [
      { label: '刷新会话', disabled: !state.connected, run: () => perform('refreshProjectThreads', { projectId: project.id }) },
      { label: '重命名项目…', run: () => form('重命名项目', [{ key: 'name', label: '项目名称', value: project.name, required: true }], '保存', value => perform('projectAction', { operation: 'rename', projectId: project.id, name: value.name })) },
      { label: archiveViews.get(project.id) ? '查看普通会话' : '查看归档会话', run: () => { archiveViews.set(project.id, !archiveViews.get(project.id)); render(); } },
      { label: '从项目列表移除…', run: () => form('移除项目', [], '移出列表', () => perform('projectAction', { operation: 'remove', projectId: project.id }), `将“${project.name}”移出本地列表。远端文件、聊天记录和运行任务均会保留。`) }
    ]);
  }
  function threadRow(project, thread) {
    const row = make('div', 'workspace-thread-row'), button = make('button', 'session cursor-interaction' + (thread.id === state.active ? ' active' : ''));
    button.type = 'button'; button.dataset.threadId = thread.id; button.disabled = busy;
    const title = thread.name || thread.preview?.slice(0, 28) || '未命名会话'; button.title = title;
    if (project.pinned.includes(thread.id)) button.append(make('span', 'workspace-pin', '⌖'));
    if (thread.forkedFromId) { const fork = make('span', 'workspace-pin', '↳'); fork.title = '分叉会话'; button.append(fork); } button.append(make('span', 'workspace-thread-name', title));
    const count = state.approvals.filter(a => a.params.threadId === thread.id || a.ownerThreadId === thread.id).length;
    if (count) button.append(make('span', 'question-badge', `待回答 ${count}`));
    else if (thread.status?.type === 'active') button.append(make('span', 'workspace-running', '•'));
    button.onclick = () => openProject(project.id, thread.id).catch(() => {});
    const more = make('button', 'workspace-more cursor-interaction', '⋯'); more.type = 'button'; more.setAttribute('aria-label', '管理会话 ' + title); more.disabled = busy; more.onclick = () => threadMenu(more, project, thread);
    row.oncontextmenu = event => { event.preventDefault(); threadMenu(more, project, thread); };
    button.onkeydown = event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); threadMenu(more, project, thread); } };
    row.append(button, more); return row;
  }
  function render() {
    if (!workspace) return false;
    const list = q('#app-thread-list'); list.replaceChildren();
    const add = make('button', 'workspace-add cursor-interaction', '+ 添加远端项目'); add.type = 'button'; add.disabled = busy;
    add.onclick = () => form('添加远端项目', [{ key: 'host', label: 'SSH 主机别名', value: state.host || 'my-dev-server', required: true }, { key: 'path', label: '远端项目目录', placeholder: '/srv/projects/my-project', required: true }, { key: 'name', label: '项目名称（可选）' }], '添加并打开', async value => {
      const added = await perform('projectAction', { operation: 'add', ...value }); if (added) await openProject(added.projectId);
    }, '使用远端已有目录，沿用 SSH 认证。');
    list.append(add);
    for (const project of workspace.projects) {
      const section = make('section', 'workspace-project'); section.dataset.projectId = project.id;
      const header = make('div', 'workspace-project-heading' + (project.id === workspace.activeProjectId ? ' current' : ''));
      const toggle = make('button', 'workspace-disclosure', project.collapsed ? '›' : '⌄'); toggle.type = 'button'; toggle.setAttribute('aria-label', (project.collapsed ? '展开' : '收起') + '项目 ' + project.name); toggle.setAttribute('aria-expanded', String(!project.collapsed)); toggle.disabled = busy;
      toggle.onclick = () => perform('projectAction', { operation: 'collapse', projectId: project.id, collapsed: !project.collapsed }).catch(() => {});
      const open = make('button', 'workspace-project-open cursor-interaction'); open.type = 'button'; open.disabled = busy; open.title = project.host + ':' + project.path; open.append(icon('folder'), make('span', '', project.name)); open.onclick = () => openProject(project.id).catch(() => {});
      const more = make('button', 'workspace-more', '⋯'); more.type = 'button'; more.setAttribute('aria-label', '管理项目 ' + project.name); more.disabled = busy; more.onclick = () => projectMenu(more, project);
      header.append(toggle, open, more); section.append(header);
      if (!project.collapsed) {
        const page = pages.get(project.id), archived = !!archiveViews.get(project.id), loading = loadStates.get(project.id);
        if (archived) { const back = make('button', 'workspace-archive-toggle', '← 普通会话 · 当前为本地归档'); back.type = 'button'; back.onclick = () => { archiveViews.set(project.id, false); render(); }; section.append(back); }
        const rows = (page?.threads || []).filter(t => !t.parentThreadId && project.archived.includes(t.id) === archived);
        const sorted = [...rows.filter(t => project.pinned.includes(t.id)), ...rows.filter(t => !project.pinned.includes(t.id))];
        for (const thread of sorted) section.append(threadRow(project, thread));
        if (!sorted.length && loading?.status !== 'error') section.append(make('div', 'workspace-empty', page ? archived ? '暂无归档会话' : '暂无会话' : project.id === workspace.activeProjectId ? state.connected ? '正在读取会话…' : '连接后显示会话' : '点击项目名称打开'));
        if (loading?.status === 'error') {
          section.append(make('div', 'workspace-empty', loading.message || '会话列表暂时无法读取。'));
          const retry = make('button', 'workspace-load-more workspace-retry', '重试读取会话'); retry.type = 'button'; retry.disabled = busy || !state.connected;
          retry.onclick = () => perform('refreshProjectThreads', { projectId: project.id }).catch(() => {}); section.append(retry);
        }
        if (page?.cursor) { const older = make('button', 'workspace-load-more', '加载更多会话'); older.type = 'button'; older.disabled = busy || !state.connected; older.onclick = () => perform('loadThreadPage', { projectId: project.id }).catch(() => {}); section.append(older); }
      }
      list.append(section);
    }
    if (!workspace.projects.length) list.append(make('div', 'workspace-empty', '添加远端项目后开始使用。'));
    icons(list); return true;
  }
  function receive(event) {
    if (event.type === 'workspace') {
      workspace = event; state.projectName = event.projects.find(p => p.id === event.activeProjectId)?.name; state.projectId = event.activeProjectId; state.workspaceEmpty = !event.activeProjectId;
      render(); controls();
    }
    if (event.type === 'threads' && event.projectId) {
      const previous = pages.get(event.projectId)?.threads || [], all = event.append ? [...previous, ...event.threads] : event.threads;
      const unique = new Map(); for (const thread of all || []) { const old = unique.get(thread.id); if (!old || Number(thread.updatedAt || thread.createdAt || 0) > Number(old.updatedAt || old.createdAt || 0)) unique.set(thread.id, thread); }
      pages.set(event.projectId, { threads: [...unique.values()], cursor: event.nextCursor }); loadStates.delete(event.projectId); render();
    }
    if (event.type === 'threadListState' && event.projectId) { loadStates.set(event.projectId, { status: event.status, message: event.message }); render(); }
    if (event.type === 'threadManaged') {
      const page = pages.get(event.projectId) || { threads: [], cursor: null };
      const index = page.threads.findIndex(t => t.id === event.thread.id); if (index < 0) page.threads.unshift(event.thread); else page.threads[index] = event.thread;
      pages.set(event.projectId, page); render();
    }
    if (event.type === 'thread' && workspace?.activeProjectId) {
      const page = pages.get(workspace.activeProjectId) || { threads: [], cursor: null };
      if (!event.thread.parentThreadId && !page.threads.some(t => t.id === event.thread.id)) page.threads.unshift(event.thread);
      pages.set(workspace.activeProjectId, page); render();
    }
    if (event.type === 'threadStatus') { for (const page of pages.values()) { const thread = page.threads.find(t => t.id === event.threadId); if (thread) thread.status = event.status; } render(); }
    if (event.type === 'connection' && event.status !== 'connected') { closeMenu(); render(); }
  }
  root.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) closeMenu(); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  return { render, receive, currentProject: () => workspace?.activeProjectId, hasWorkspace: () => !!workspace };
};
