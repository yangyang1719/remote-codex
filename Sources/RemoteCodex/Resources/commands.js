'use strict';
window.RemoteCodexCommands = function ({ root, state, q, make, icon, icons, key, request, saveDraft, restoreDraft, controls, send, richText, setFast, sessionValues }) {
  const usage = window.RemoteCodexUsage({ root, state, q, make, request });
  state.draftModes ||= {};
  const chosenModes = new Set(), goals = {}, progress = {}, progressSync = {}, expanded = {}, goalDrafts = {};
  let options = [], choice = 0, editingKey, planAvailable = true;
  const input = q('#cmsg-input');
  const palette = make('div', 'command-palette'); palette.id = 'command-palette'; palette.hidden = true; palette.setAttribute('role', 'listbox'); palette.setAttribute('aria-label', '聊天命令'); q('.composer').append(palette);
  const work = make('div', 'thread-work'); work.id = 'thread-work'; q('.composer').before(work);
  const entry = make('button', 'command-entry cursor-interaction', '/'); entry.id = 'command-entry'; entry.type = 'button'; entry.setAttribute('aria-label', '打开命令菜单'); q('.attachment-action').after(entry);
  const modeButton = make('button', 'plan-mode-button cursor-interaction'); modeButton.id = 'plan-mode'; modeButton.type = 'button'; modeButton.setAttribute('aria-label', '切换计划模式'); q('.composer-footer .model').before(modeButton);
  const note = make('div', 'command-note'); note.id = 'command-note'; note.hidden = true; note.setAttribute('role', 'status'); input.after(note);
  const dialog = document.createElement('dialog'); dialog.id = 'goal-editor'; dialog.className = 'goal-editor';
  const form = document.createElement('form'); form.method = 'dialog';
  const title = make('h3', '', '设置目标'), description = make('p', 'goal-editor-description', '说明希望达成的结果与验收标准。开始后，Codex 会持续工作，直到完成、暂停或触及预算。');
  const objectiveLabel = make('label', '', '目标'), objective = document.createElement('textarea'); objective.id = 'goal-objective'; objective.maxLength = 4000; objective.rows = 5; objective.required = true; objective.placeholder = '例如：完成附件上传并通过真实远端验收，保持原会话不受影响。'; objectiveLabel.htmlFor = objective.id;
  const budgetLabel = make('label', '', 'Token 预算（可选）'), budget = document.createElement('input'); budget.id = 'goal-budget'; budget.type = 'number'; budget.min = '1'; budget.step = '1'; budget.placeholder = '留空，不设预算'; budgetLabel.htmlFor = budget.id;
  const error = make('div', 'goal-editor-error'); error.id = 'goal-editor-error'; error.setAttribute('role', 'alert');
  const actions = make('div', 'goal-editor-actions'), cancel = make('button', 'small-button', '取消'), save = make('button', 'small-button strong', '设定并开始'); cancel.type = 'button'; save.type = 'submit'; save.id = 'goal-save'; cancel.onclick = () => dialog.close(); actions.append(cancel, save);
  form.append(title, description, objectiveLabel, objective, budgetLabel, budget, error, actions); dialog.append(form); root.append(dialog);
  const statusText = { active: '进行中', paused: '已暂停', blocked: '等待处理', usageLimited: '额度受限', budgetLimited: '已达预算', complete: '已完成' };
  const mode = () => state.draftModes[key()] || 'default';
  function message(text = '') { note.textContent = text; note.hidden = !text; }
  function closePalette() { palette.hidden = true; options = []; }
  function setMode(value) { if (state.running[state.active] || state.sendPending || state.commandPending) { message('当前任务结束后可切换模式。'); return false; } if (value === 'plan' && !planAvailable) { message('远端暂不支持计划模式。'); return false; } state.draftModes[key()] = value; chosenModes.add(key()); saveDraft(); controls(); input.focus({ preventScroll: true }); return true; }
  function stripCommand() { if (/^\s*\/[\w ]*$/.test(input.value)) { input.value = ''; saveDraft(); } }
  function openEditor(value) {
    editingKey = key(); const goal = goals[editingKey], draft = goalDrafts[editingKey];
    objective.value = value ?? draft?.objective ?? goal?.objective ?? ''; budget.value = draft?.budget ?? goal?.tokenBudget ?? '';
    title.textContent = goal ? '编辑目标' : '设置目标'; save.textContent = goal ? '保存修改' : '设定并开始'; error.textContent = '';
    closePalette(); if (!dialog.open) dialog.showModal(); objective.focus();
  }
  function rememberEditor() { if (editingKey) goalDrafts[editingKey] = { objective: objective.value, budget: budget.value }; }
  objective.oninput = budget.oninput = rememberEditor; dialog.addEventListener('cancel', rememberEditor);
  async function mutate(operation, values = {}, clearText = null) {
    if (state.agentParents?.[state.active]) { message('子代理只读查看，请返回父会话操作。'); return false; }
    if (state.commandPending || state.sendPending) return false;
    if (!state.connected) { message('请先连接远端 Codex。'); return false; }
    if (['busy', 'resuming'].includes(state.access[state.active])) { message('当前只读。原连接释放并继续此会话后，才能修改目标。'); return false; }
    if (!state.active && (state.attachments.new || []).some(file => file.status !== 'ready')) { message('请先等待附件添加完成，或移除添加失败的附件。'); return false; }
    const draftKey = key(), pending = { key: draftKey }; state.commandPending = pending; closePalette(); message(); controls();
    try {
      const result = await request('command', { operation, threadId: state.active, ...sessionValues(), attachmentIds: (state.attachments[draftKey] || []).map(f => f.id), ...values });
      const target = result.threadId || pending.threadId || draftKey;
      if (clearText !== null && state.drafts[target] === clearText) { delete state.drafts[target]; if (key() === target) restoreDraft(); }
      delete goalDrafts[target]; error.textContent = ''; return true;
    } catch (failure) { if (key() === (pending.threadId || draftKey)) message(failure.message); if (dialog.open) error.textContent = failure.message; return false; }
    finally { state.commandPending = null; controls(); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (editingKey !== key()) { error.textContent = '对话已切换，请回到目标所属对话重试。'; return; }
    const text = objective.value.trim(), amount = budget.value ? Number(budget.value) : null;
    if (!text || Array.from(text).length > 4000 || (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0))) { error.textContent = '请填写目标，预算需为正整数或留空。'; return; }
    rememberEditor(); const goal = goals[key()], current = input.value, clear = /^\s*\/goal(?:\s|$)/.test(current) ? current : null;
    save.disabled = true;
    if (await mutate('setGoal', { objective: text, tokenBudget: amount, status: goal?.status === 'active' || !goal ? 'active' : 'paused' }, clear)) { dialog.close(); }
    save.disabled = false;
  };
  function action(label, operation, values) { const button = make('button', 'work-action cursor-interaction', label); button.type = 'button'; button.disabled = !!state.agentParents?.[state.active] || !state.connected || !!state.commandPending || !!state.sendPending || ['busy', 'resuming'].includes(state.access[state.active]); button.onclick = () => operation === 'edit' ? openEditor() : mutate(operation, values); return button; }
  function render() {
    root.querySelectorAll('.implement-plan').forEach(button => { button.disabled = !!state.agentParents?.[state.active] || !state.connected || !!state.running[state.active] || !!state.sendPending || !!state.commandPending || ['busy', 'resuming'].includes(state.access[state.active]); });
    const planning = mode() === 'plan'; modeButton.hidden = !planning; modeButton.replaceChildren(icon('list-checks'), document.createTextNode('计划模式'), icon('x')); modeButton.setAttribute('aria-pressed', String(planning));
    modeButton.disabled = !!state.agentParents?.[state.active] || !!state.running[state.active] || !!state.sendPending || !!state.commandPending; entry.disabled = !!state.agentParents?.[state.active] || !!state.commandPending || !!state.sendPending;
    if (planning && state.access[state.active] !== 'busy') input.placeholder = '描述你想先规划的任务…';
    work.replaceChildren(); const goal = goals[key()];
    if (goal) {
      const card = make('section', 'goal-card'); card.id = 'goal-card'; card.dataset.status = goal.status;
      const heading = make('div', 'work-heading'); heading.append(icon('target'), make('strong', '', '目标'), make('span', 'work-state', statusText[goal.status] || goal.status));
      if (state.remoteRuns[key()]?.managed && goal.status === 'active') heading.querySelector('.work-state').textContent = '远端运行中';
      const text = make('div', 'goal-summary', goal.objective); text.title = goal.objective;
      const footer = make('div', 'work-footer'), used = Number(goal.tokensUsed || 0).toLocaleString(), usage = goal.tokenBudget ? used + ' / ' + Number(goal.tokenBudget).toLocaleString() + ' tokens' : used + ' tokens';
      footer.append(make('span', 'goal-usage', usage + (goal.timeUsedSeconds ? ' · ' + Math.floor(goal.timeUsedSeconds / 60) + '分' + (goal.timeUsedSeconds % 60) + '秒' : '')));
      const buttons = make('div', 'work-actions');
      if (goal.status === 'active') { const pause = action('暂停', 'pauseGoal'); pause.title = '暂停目标，并停止本客户端正在执行的当前回合'; buttons.append(pause); }
      else if (['paused', 'blocked', 'usageLimited'].includes(goal.status)) buttons.append(action('继续', 'resumeGoal'));
      buttons.append(action('编辑', 'edit'), action('清除', 'clearGoal')); footer.append(buttons); card.append(heading, text, footer); work.append(card);
    }
    const plan = progress[key()];
    if (plan?.plan?.length) {
      const draftKey = key(), card = document.createElement('details'); card.className = 'plan-progress'; card.id = 'plan-progress'; card.dataset.source = plan.source || 'live'; card.dataset.sync = progressSync[draftKey] || 'current'; card.dataset.turnId = plan.turnId || ''; card.open = !!expanded[draftKey]; card.ontoggle = () => { expanded[draftKey] = card.open; };
      const complete = plan.plan.filter(step => step.status === 'completed').length, summary = make('summary'); summary.append(icon('list-checks'), make('span', '', '计划进度'), make('span', 'work-state', complete + ' / ' + plan.plan.length)); card.append(summary);
      const steps = make('ol'); for (const step of plan.plan) { const li = make('li'); li.dataset.status = step.status; li.append(make('span', 'step-state', step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◉' : '○'), make('span', '', step.step)); steps.append(li); } if (plan.explanation) card.append(make('p', 'plan-explanation', plan.explanation)); card.append(steps); work.append(card);
    }
    if (['loading', 'retrying'].includes(progressSync[key()]) || (plan && progressSync[key()] === 'disconnected')) { const notice = make('div', 'plan-sync-note', progressSync[key()] === 'loading' ? '正在恢复计划进度…' : progressSync[key()] === 'disconnected' ? '已断开，显示上次计划进度' : '计划进度同步暂时中断，正在自动重试…'); notice.setAttribute('role', 'status'); work.append(notice); }
    work.hidden = !work.childElementCount; icons(work); icons(modeButton);
  }
  function entries() {
    const goal = goals[key()]; return [
      { command: '/plan', title: mode() === 'plan' ? '退出计划模式' : '计划模式', description: '先讨论方案，再开始实施', run: () => { stripCommand(); setMode(mode() === 'plan' ? 'default' : 'plan'); } },
      { command: '/goal', title: goal ? '查看目标' : '设置目标', description: '持续工作直到达成结果', run: () => { stripCommand(); if (goal) { expanded[key()] = true; render(); q('#goal-card')?.scrollIntoView({ block: 'nearest' }); } else openEditor(); } },
      { command: '/usage', title: '用量', description: '远端账号额度、重置时间与 Token 用量', run: () => { stripCommand(); closePalette(); usage.open(); } },
      { command: '/fast', title: '切换 Fast 模式', description: '更快响应，额度消耗更高；后续回合生效', run: () => runFast() },
      ...(goal ? [
        { command: '/goal edit', title: '编辑目标', description: '修改目标和预算', run: () => { stripCommand(); openEditor(); } },
        ...(goal.status === 'active' ? [{ command: '/goal pause', title: '暂停目标', description: '停止当前回合，暂停自动继续', run: () => mutate('pauseGoal', {}, input.value) }] : [{ command: '/goal resume', title: '继续目标', description: '继续朝目标工作', run: () => mutate('resumeGoal', {}, input.value) }]),
        { command: '/goal clear', title: '清除目标', description: '移除目标，保留聊天记录', run: () => mutate('clearGoal', {}, input.value) }
      ] : [])
    ];
  }
  async function runFast(enabled) {
    const draftKey = key(), text = input.value; closePalette();
    if (await setFast(enabled)) {
      if (key() === draftKey && input.value === text && /^\s*\/fast(?:\s+(?:on|off))?\s*$/i.test(text)) { input.value = ''; saveDraft(); }
    }
  }
  function showPalette(all = false) {
    const text = input.value.trimStart(); if (!all && (!text.startsWith('/') || text.includes('\n'))) { closePalette(); return; }
    options = entries().filter(row => all || row.command.startsWith(text)); choice = 0; palette.replaceChildren();
    for (const [i, item] of options.entries()) { const button = make('button', 'command-option cursor-interaction'); button.type = 'button'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(i === 0)); const copy = make('span'); copy.append(make('strong', '', item.title), make('small', '', item.description)); button.append(copy, make('code', '', item.command)); button.onclick = () => { closePalette(); item.run(); }; palette.append(button); }
    palette.hidden = !options.length;
  }
  function handleSend() {
    const text = input.value.trimStart();
    if (/^\/fast(?:\s|$)/i.test(text)) { const match = /^\/fast(?:\s+(on|off))?\s*$/i.exec(text); if (match) runFast(match[1] ? match[1].toLowerCase() === 'on' : undefined); else message('使用 /fast、/fast on 或 /fast off。'); return true; }
    if (/^\/(usage|status)\s*$/i.test(text)) { stripCommand(); closePalette(); usage.open(); return true; }
    const plan = /^\/plan(?:\s+([\s\S]*))?$/.exec(text), goal = /^\/goal(?:\s+([\s\S]*))?$/.exec(text);
    if (plan) { if (!setMode(plan[1]?.trim() ? 'plan' : mode() === 'plan' ? 'default' : 'plan')) return true; input.value = plan[1] || ''; saveDraft(); closePalette(); return !input.value.trim(); }
    if (goal) { const argument = goal[1]?.trim(); closePalette(); if (!argument) { if (goals[key()]) render(); else openEditor(); } else if (argument === 'edit') openEditor(); else if (['pause', 'resume', 'clear'].includes(argument)) mutate(argument + 'Goal', {}, input.value); else mutate('setGoal', { objective: argument, status: 'active' }, input.value); return true; }
    if (/^\/[a-z]/i.test(text)) { message('此命令尚未接入。输入 / 查看可用命令。'); return true; }
    return false;
  }
  function handleKey(event) {
    if (event.isComposing || event.keyCode === 229 || (event.key === 'Enter' && event.ctrlKey)) return false;
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && /^\/fast(?:\s|$)/i.test(input.value.trimStart())) { event.preventDefault(); handleSend(); return true; }
    if (event.key === 'Enter' && !event.shiftKey && /^\/(usage|status)\s*$/i.test(input.value.trimStart())) { event.preventDefault(); handleSend(); return true; }
    if (!palette.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closePalette(); return true; }
      if (options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); choice = (choice + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length; [...palette.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === choice))); palette.children[choice].scrollIntoView({ block: 'nearest' }); return true; }
      if (options.length && ['Enter', 'Tab'].includes(event.key) && !event.metaKey && !event.shiftKey) { event.preventDefault(); const selected = options[choice]; closePalette(); selected.run(); return true; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && /^\/(plan|goal|usage|status)(?:\s|$)/.test(input.value.trimStart())) { event.preventDefault(); send(); return true; }
    return false;
  }
  modeButton.onclick = () => setMode('default'); entry.onclick = () => { input.focus(); showPalette(true); };
  root.addEventListener('pointerdown', event => { if (!q('.composer').contains(event.target)) closePalette(); });
  return {
    mode, render, handleSend, handleKey, input: () => { message(); showPalette(); },
    restore: () => { closePalette(); message(); if (dialog.open && editingKey !== key()) dialog.close(); render(); },
    migrate: (from, to) => { if (state.draftModes[from]) { state.draftModes[to] = state.draftModes[from]; delete state.draftModes[from]; } if (chosenModes.has(from)) { chosenModes.add(to); chosenModes.delete(from); } if (goalDrafts[from]) { goalDrafts[to] = goalDrafts[from]; delete goalDrafts[from]; } if (editingKey === from) editingKey = to; if (state.commandPending?.key === from) state.commandPending.threadId = to; },
    receive(event) {
      usage.receive(event);
      if (event.type === 'draftSnapshot') { chosenModes.clear(); for (const id of Object.keys(state.draftModes || {})) chosenModes.add(id); }
      if (event.type === 'goal') { goals[event.threadId] = event.goal; if (event.threadId === key()) render(); }
      if (event.type === 'goalUnavailable' && event.threadId === key() && state.commandPending) message('目标暂不可用：' + event.message);
      if (event.type === 'collaborationMode' && (event.force || !chosenModes.has(event.threadId))) { state.draftModes[event.threadId] = event.mode; if (event.threadId === key()) render(); }
      if (event.type === 'commandCapabilities') planAvailable = event.plan;
      if (event.type === 'planProgress') { progress[event.threadId] = event; progressSync[event.threadId] = 'current'; if (event.threadId === key()) render(); }
      if (event.type === 'planSnapshot') { if (event.plan) progress[event.threadId] = { ...event.plan, source: 'history' }; else delete progress[event.threadId]; if (event.threadId === key()) render(); }
      if (event.type === 'planSync') { progressSync[event.threadId] = event.status; if (event.threadId === key()) render(); }
      if (event.type === 'turn' && event.turn?.status === 'inProgress' && progress[event.threadId]?.turnId !== event.turn.id) { delete progress[event.threadId]; if (event.threadId === key()) render(); }
      if (event.type === 'connection' && event.status !== 'connected') { for (const id of Object.keys(progress)) progressSync[id] = 'disconnected'; closePalette(); render(); }
    },
    planCard(item) {
      const card = make('section', 'assistant-message proposed-plan'); card.dataset.planItem = item.id; card.append(make('div', 'work-heading', '实施计划')); richText(card, item.text || '', true);
      const implement = make('button', 'small-button strong implement-plan', '实施此计划'); implement.type = 'button'; implement.disabled = !!state.agentParents?.[state.active] || !state.connected || !!state.running[state.active] || !!state.sendPending || !!state.commandPending || ['busy', 'resuming'].includes(state.access[state.active]);
      implement.onclick = () => { if (!setMode('default')) return; input.value = input.value.trim() || '按上面的计划开始实施。'; saveDraft(); send(); }; card.append(implement); return card;
    }
  };
};
