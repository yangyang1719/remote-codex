'use strict';
window.createSessionFeatures = ({ q, make, icon, icons, state, key, request, post, render, selectThread, richText, renderViewedImage }) => {
  state.agentParents ||= {};
  const catalog = [], settings = {}, desired = {}, pending = new Set(), contexts = {}, agents = {}, more = {}, sync = {}, cards = new Map();
  const names = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: 'Max', ultra: 'Ultra' };
  const model = q('#app-model'), effort = make('select', 'model-select effort-select'); effort.id = 'app-effort'; effort.setAttribute('aria-label', '思考等级'); model.after(effort);
  const fast = make('button', 'fast-toggle cursor-interaction'); fast.id = 'app-fast'; fast.type = 'button'; effort.after(fast);
  const note = make('span', 'settings-note'); note.id = 'session-settings-note'; note.setAttribute('role', 'status'); effort.after(note);
  const panel = make('section', 'subagent-panel'); panel.id = 'subagent-panel'; panel.hidden = true; q('.chat-header').after(panel);
  let selectorStamp = '';
  const current = () => desired[key()] || settings[key()] || (key() === 'new' ? { model: catalog.find(m => m.isDefault)?.model || '', effort: catalog.find(m => m.isDefault)?.defaultReasoningEffort || '' } : {});
  const isChild = () => !!contexts[key()]?.parentThreadId;
  const option = (value, text) => { const o = make('option', '', text); o.value = value; return o; };
  const effortOptions = value => catalog.find(m => m.model === value || m.id === value)?.supportedReasoningEfforts || [];
  const fastTier = () => { const entry = catalog.find(m => m.model === current().model || m.id === current().model); return entry?.serviceTiers?.find(t => ['fast', 'priority'].includes(t.id))?.id || entry?.additionalSpeedTiers?.find(t => ['fast', 'priority'].includes(t)); };
  const fastEnabled = () => ['fast', 'priority'].includes(current().serviceTier);
  function controls() {
    const value = current(), disabled = !state.connected || state.workspaceBusy || state.workspaceEmpty || state.loading || isChild() || pending.has(key()) || !!state.sendPending || !!state.commandPending || ['busy', 'resuming'].includes(state.access[key()]);
    const stamp = JSON.stringify([key(), value, catalog]);
    if (selectorStamp !== stamp) {
      selectorStamp = stamp;
      model.replaceChildren(option('', key() === 'new' ? '远端默认模型' : '读取模型中…'));
      for (const entry of catalog.filter(m => !m.hidden || m.model === value.model)) model.append(option(entry.model || entry.id, entry.displayName || entry.model));
      if (value.model && !Array.from(model.options).some(o => o.value === value.model)) model.append(option(value.model, value.model));
      model.firstChild.disabled = !!value.model; model.value = value.model || '';
      effort.replaceChildren(option('', value.effort == null ? '默认思考' : '思考等级'));
      for (const entry of effortOptions(value.model)) { const o = option(entry.reasoningEffort, '思考 · ' + (names[entry.reasoningEffort] || entry.reasoningEffort)); o.title = entry.description || ''; effort.append(o); }
      if (value.effort && !Array.from(effort.options).some(o => o.value === value.effort)) effort.append(option(value.effort, '思考 · ' + (names[value.effort] || value.effort)));
      effort.firstChild.disabled = !!value.effort; effort.value = value.effort || '';
    }
    model.disabled = disabled || !catalog.length; effort.disabled = disabled || !effortOptions(value.model).length;
    fast.replaceChildren(icon('zap')); if (fastEnabled()) fast.append(document.createTextNode('Fast')); icons(fast); fast.classList.toggle('enabled', fastEnabled()); fast.setAttribute('aria-pressed', String(fastEnabled()));
    fast.disabled = disabled || !value.model || (!fastEnabled() && !fastTier());
    fast.setAttribute('aria-label', fastEnabled() ? '关闭 Fast 模式' : '开启 Fast 模式');
    fast.dataset.tier = value.serviceTier || 'unknown';
    fast.title = fastEnabled() ? 'Fast 已开启，点击关闭；后续回合生效' : fastTier() ? (value.serviceTier ? '开启 Fast，更快响应，额度消耗更高' : '尚未读取此会话的速度设置；点击显式开启 Fast') : '远端未提供此模型的 Fast 模式';
    if (pending.has(key())) note.textContent = '正在保存…';
    for (const [token, card] of cards) {
      const a = state.approvals.find(a => a.token === token);
      if (!a) { cards.delete(token); continue; }
      const access = card.querySelector('.question-access-note'); if (access) { access.hidden = a.canAnswer !== false; access.textContent = '原会话正在等待回答，请在原写入连接中处理。'; }
      card.querySelectorAll('fieldset,button').forEach(el => el.disabled = !state.connected || a.canAnswer === false || card.dataset.pending === 'true');
    }
    renderAgents();
  }
  async function change(next) {
    const id = state.active, k = key(); desired[k] = { ...current(), ...next }; note.textContent = '';
    if (!id) { controls(); return true; }
    pending.add(k); controls();
    try {
      const result = await request('updateThreadSettings', { threadId: id, ...next });
      settings[id] = result; delete desired[k];
      if (key() === k) note.textContent = '后续回合生效';
      return true;
    } catch (error) { delete desired[k]; if (key() === k) note.textContent = error.message; return false; }
    finally { pending.delete(k); selectorStamp = ''; controls(); }
  }
  async function chooseModel(value) {
    controls(); if (model.disabled) { note.textContent = '当前无法切换模型，请确认连接和会话状态。'; return false; }
    const entry = catalog.find(m => m.model === value); if (!entry) return false;
    const next = { model: entry.model, effort: entry.defaultReasoningEffort || '' };
    if (fastEnabled() && !entry.serviceTiers?.some(t => ['fast', 'priority'].includes(t.id)) && !entry.additionalSpeedTiers?.some(t => ['fast', 'priority'].includes(t))) next.serviceTier = 'default';
    return change(next);
  }
  model.onchange = () => chooseModel(model.value);
  effort.onchange = () => { if (effort.value) change({ model: model.value, effort: effort.value }); };
  async function setFast(enabled = !fastEnabled()) {
    controls();
    if (fast.disabled) { note.textContent = !state.connected ? '请先连接远端 Codex。' : '当前无法切换 Fast，请确认模型支持且会话可操作。'; return false; }
    return change({ serviceTier: enabled ? fastTier() || 'fast' : 'default' });
  }
  fast.onclick = () => setFast();
  const subagents = window.RemoteCodexSubagents({ panel, make, state, post, request, selectThread, richText, renderViewedImage });
  function renderAgents() {
    const context = contexts[key()], root = context?.rootThreadId || key();
    subagents.render({ context, agents: agents[root] || [], more: more[root], sync: sync[root] });
  }
  function approval(a) {
    if (cards.has(a.token)) return cards.get(a.token);
    const card = make('section', 'approval'), p = a.params, question = a.method.endsWith('requestUserInput'); card.dataset.token = a.token;
    card.append(make('strong', '', question ? 'Codex 需要你的回答' : '需要审批'));
    if (p.threadId && p.threadId !== state.active) card.append(make('div', 'subagent-role', '来自子代理'));
    const access = make('p', 'question-access-note'); access.hidden = a.canAnswer !== false; card.append(access);
    if (question && p.isBlocking === false) card.append(make('p', 'subagent-role', '可稍后回答，Codex 会继续执行。'));
    if (p.command) card.append(make('pre', '', p.command)); if (p.reason) card.append(make('p', '', p.reason));
    const fields = [], actions = make('div', 'approval-actions'), error = make('div', 'question-error'); error.setAttribute('role', 'alert');
    if (question) for (const item of p.questions || []) {
      const group = make('fieldset', 'question-field'); group.dataset.questionId = item.id; group.append(make('legend', '', item.header || '问题'), make('p', '', item.question));
      const choices = item.options || [], name = a.token + '-' + item.id, field = { id: item.id, value: () => '' };
      if (choices.length && !item.isSecret) {
        const radios = [];
        for (const choice of [...choices, ...(item.isOther ? [{ label: '其他回答', description: '', custom: true }] : [])]) {
          const label = make('label', 'question-option'), radio = make('input'); radio.type = 'radio'; radio.name = name; radio.value = choice.label;
          label.append(radio, make('span', '', choice.label)); if (choice.description) label.append(make('small', '', choice.description)); group.append(label); radios.push({ radio, custom: choice.custom });
        }
        let custom;
        if (item.isOther) { custom = make('textarea', 'question-text'); custom.placeholder = '填写你的回答'; custom.rows = 2; custom.maxLength = 8000; group.append(custom); custom.oninput = () => { radios.at(-1).radio.checked = true; }; }
        field.value = () => { const selected = radios.find(r => r.radio.checked); return selected?.custom ? custom.value.trim() : selected?.radio.value || ''; };
      } else {
        const input = make(item.isSecret ? 'input' : 'textarea', 'question-text'); if (item.isSecret) { input.type = 'password'; input.autocomplete = 'off'; } else input.rows = 2;
        input.maxLength = 8000; input.placeholder = item.isSecret ? '填写私密回答' : '填写你的回答'; input.setAttribute('aria-label', item.question || item.header); group.append(input); field.value = () => input.value.trim();
      }
      fields.push(field); card.append(group);
    }
    async function submit(values) {
      card.dataset.pending = 'true'; error.textContent = ''; controls();
      try { await request('approval', { token: a.token, ...values }); }
      catch (e) { error.textContent = e.message; }
      finally { card.dataset.pending = 'false'; controls(); }
    }
    if (question) {
      const button = make('button', 'small-button strong', '提交回答'); button.type = 'button';
      button.onclick = () => { const values = fields.map(f => [f.id, { answers: [f.value()] }]); if (!values.length || values.some(([,v]) => !v.answers[0])) { error.textContent = '请回答每个问题后提交。'; return; } submit({ answers: Object.fromEntries(values) }); }; actions.append(button);
    } else for (const [text, decision] of [['拒绝', 'decline'], ['允许本次', 'accept']]) { const button = make('button', 'small-button' + (decision === 'accept' ? ' strong' : ''), text); button.type = 'button'; button.onclick = () => submit({ decision }); actions.append(button); }
    card.append(error, actions); cards.set(a.token, card); controls(); return card;
  }
  return {
    controls, approval, isChild, setFast, chooseModel, models: () => catalog.slice(), selectedModel: () => current().model || '', values: () => ({ model: current().model || '', effort: current().effort || undefined, serviceTier: key() === 'new' ? current().serviceTier : undefined }),
    visible: a => !a.params.threadId || a.params.threadId === state.active || a.ownerThreadId === state.active,
    receive(event) {
      if (event.type === 'models') { catalog.splice(0, catalog.length, ...(event.data || [])); selectorStamp = ''; }
      if (event.type === 'threadSettings') { settings[event.threadId] = { model: event.model, effort: event.effort, serviceTier: event.serviceTier }; selectorStamp = ''; }
      if (event.type === 'thread') { note.textContent = ''; if (event.thread.parentThreadId) { state.agentParents[event.thread.id] = event.thread.parentThreadId; contexts[event.thread.id] = { parentThreadId: event.thread.parentThreadId, rootThreadId: event.thread.parentThreadId }; } }
      if (event.type === 'agentContext') { contexts[event.threadId] = event; if (event.parentThreadId) state.agentParents[event.threadId] = event.parentThreadId; }
      if (event.type === 'subagents') { agents[event.rootThreadId] = event.agents || []; more[event.rootThreadId] = event.hasMore; }
      if (event.type === 'subagentSync') sync[event.rootThreadId] = event.status;
      if (event.type === 'threadStatus') for (const rows of Object.values(agents)) { const row = rows.find(a => a.id === event.threadId); if (row) row.status = event.status; }
      if (event.type === 'approvalAnswered') cards.delete(event.token);
      if (event.type === 'connection' && event.status !== 'connected') { cards.clear(); pending.clear(); for (const id of Object.keys(desired)) if (id !== 'new') delete desired[id]; }
      controls();
      subagents.receive(event);
      if (['agentContext', 'thread'].includes(event.type)) render();
    }
  };
};
