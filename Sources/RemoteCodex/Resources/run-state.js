'use strict';
window.RemoteCodexRunState = ({ root, q, make, state, key, session }) => {
  const records = new Map();
  const notice = make('section', 'run-notice'); notice.id = 'run-notice'; notice.hidden = true; notice.setAttribute('role', 'alert'); q('#app-banner').after(notice);
  const activity = make('div', 'run-activity'); activity.id = 'run-activity'; activity.hidden = true; activity.setAttribute('role', 'status');
  const dot = make('span', 'thinking-dot'), label = make('span', 'run-activity-label'), preview = make('span', 'run-activity-preview'); activity.append(dot, label, preview); q('.compose-wrap').before(activity);
  const picker = make('dialog', 'workspace-dialog run-model-picker'); picker.id = 'run-model-picker'; picker.setAttribute('aria-label', '切换模型');
  const title = make('h3', '', '切换模型'), description = make('p', 'workspace-dialog-note', '选择远端可用的模型。保存后请手动重新发送，消息不会自动重发。'), select = make('select'); select.id = 'run-model-select'; select.setAttribute('aria-label', '可用模型');
  const error = make('p', 'workspace-dialog-error'), actions = make('div', 'workspace-dialog-actions'), cancel = make('button', 'small-button', '取消'), save = make('button', 'small-button strong', '保存模型'); cancel.type = save.type = 'button'; save.id = 'run-model-save'; actions.append(cancel, save); picker.append(title, description, select, error, actions); root.append(picker);
  let stamp = '', pickerKey = null;
  const scopeKey = id => state.host + ':' + id;
  const record = id => { const scoped = scopeKey(id); if (!records.has(scoped)) records.set(scoped, {}); return records.get(scoped); };
  const codeOf = failure => typeof failure.codexErrorInfo === 'string' ? failure.codexErrorInfo : Object.keys(failure.codexErrorInfo || {})[0] || '';
  function classify(failure) {
    const text = failure.message || '远端运行失败。', code = codeOf(failure).toLowerCase();
    if (/at capacity|model.{0,60}(?:capacity|overloaded)|模型.{0,12}(?:满载|拥挤)/i.test(text)) return { kind: 'capacity', text: '上次请求的模型当前满载，请稍后重试或切换模型。', changeModel: true };
    if (code === 'serveroverloaded') return { kind: 'capacity', text: '模型服务当前繁忙，请稍后重试或切换模型。', changeModel: true };
    if (code === 'modelnotfound') return { kind: 'model', text: '当前模型不可用，请切换其他模型。', changeModel: true };
    if (code === 'usagelimitexceeded') return { kind: 'usage', text: '当前账号额度受限，请查看用量或等待额度恢复。' };
    if (code.includes('responsestream') || /stream disconnected|stream.*before completion/i.test(text)) return { kind: 'stream', text: '回复连接中断。' };
    return { kind: 'error', text: '本次运行出现问题：' + text };
  }
  function setError(id, failure, turnId = '', retry = false) {
    const row = record(id), safe = { message: String(failure.message || '远端运行失败。'), additionalDetails: String(failure.additionalDetails || ''), codexErrorInfo: failure.codexErrorInfo };
    const signature = JSON.stringify([turnId, safe]);
    row.error = { ...safe, turnId, retry, signature }; row.liveError = true; if (retry) row.stage = 'retrying';
  }
  function turn(id, value, snapshot = false) {
    const row = record(id);
    if (snapshot && (row.liveError || (row.turn && row.turn.id === value.id && row.live))) return;
    const fresh = row.turn?.id !== value.id;
    row.turn = value; row.live = !snapshot;
    if (value.status === 'inProgress') { if (fresh) { delete row.error; row.liveError = false; row.preview = ''; row.stage = snapshot ? 'working' : 'thinking'; } }
    else { row.stage = ''; if (value.error) setError(id, value.error, value.id); else if (value.status === 'failed') { if (row.error) row.error.retry = false; else setError(id, {}, value.id); } else { delete row.error; row.liveError = false; } }
  }
  function showModels() {
    session.controls(); const model = q('#app-model');
    if (model.disabled) return;
    select.replaceChildren();
    for (const entry of session.models().filter(m => !m.hidden || m.model === session.selectedModel())) { const option = make('option', '', entry.displayName || entry.model); option.value = entry.model; select.append(option); }
    select.value = session.selectedModel(); pickerKey = scopeKey(key()); error.textContent = ''; save.disabled = !select.options.length; if (!picker.open) picker.showModal(); select.focus();
  }
  cancel.onclick = () => picker.close();
  save.onclick = async () => {
    if (pickerKey !== scopeKey(key())) { picker.close(); return; }
    if (select.value === session.selectedModel()) { picker.close(); return; }
    save.disabled = select.disabled = true;
    try { if (await session.chooseModel(select.value)) picker.close(); else error.textContent = q('#session-settings-note').textContent || '设置未保存，请稍后重试。'; }
    finally { save.disabled = select.disabled = false; }
  };
  function render() {
    const row = records.get(scopeKey(key())) || {}, failure = row.error, info = failure && classify(failure);
    const signature = JSON.stringify([scopeKey(key()), failure, row.dismissed, state.connected, state.access[key()], q('#app-model')?.disabled]);
    if (stamp !== signature) {
      stamp = signature; notice.hidden = !failure || row.dismissed === failure.signature;
      if (!notice.hidden) {
        notice.dataset.kind = info.kind; notice.replaceChildren();
        notice.append(make('div', 'run-notice-message', info.text + (failure.retry ? ' 远端正在自动重试，请稍候。' : '')));
        const controls = make('div', 'run-notice-actions');
        if (info.changeModel) { const button = make('button', 'small-button', '切换模型'); button.id = 'run-change-model'; button.type = 'button'; button.disabled = !!q('#app-model')?.disabled; button.onclick = showModels; controls.append(button); }
        const dismiss = make('button', 'small-button', '关闭提示'); dismiss.type = 'button'; dismiss.id = 'run-notice-dismiss'; dismiss.onclick = () => { row.dismissed = failure.signature; render(); }; controls.append(dismiss);
        const details = make('details', 'run-error-details'), summary = make('summary', '', '查看详情'), content = make('pre');
        content.textContent = [failure.message, failure.additionalDetails, failure.codexErrorInfo ? JSON.stringify(failure.codexErrorInfo) : ''].filter(Boolean).join('\n\n'); details.append(summary, content); notice.append(controls, details);
      }
    }
    activity.hidden = !state.active || (!row.stage && row.turn?.status !== 'inProgress');
    label.textContent = !state.connected ? '连接已断开，进度待同步' : ({ thinking: '思考中…', command: '正在执行命令…', tool: '正在使用工具…', responding: '正在回复…', waiting: '等待你的处理…', retrying: '正在重试…' }[row.stage] || '运行中…');
    const hasSummary = (state.items[state.active] || []).some(item => item.type === 'reasoning' && item.summary?.some(text => text.trim()));
    activity.classList.toggle('is-active', state.connected && !activity.hidden); preview.textContent = hasSummary ? '' : row.preview || ''; preview.title = preview.textContent;
    if (picker.open && pickerKey !== scopeKey(key())) picker.close();
  }
  return { render, receive(event) {
    const id = event.threadId || key(), row = record(id), canProgress = !row.turn || row.turn.status === 'inProgress';
    if (event.type === 'turn' && event.turn) turn(id, event.turn);
    if (event.type === 'runSnapshot' && event.turn) turn(id, event.turn, true);
    if (event.type === 'runError' && (!event.turnId || !row.turn?.id || row.turn.status !== 'inProgress' || event.turnId === row.turn.id)) setError(id, event.error || {}, event.turnId, event.willRetry);
    if (event.type === 'error' && ['send', 'shellCommand'].includes(event.action)) setError(id, { message: event.message }, event.requestId || row.turn?.id);
    if (event.type === 'runtimeState' && !row.turn) row.stage = event.running ? 'working' : '';
    if (event.type === 'reasoningSummary') {
      if (row.turn?.id && event.turnId && row.turn.id !== event.turnId) return;
      if (canProgress) row.stage = 'thinking'; row.preview = (row.preview || '') + (event.delta || ''); row.preview = row.preview.slice(-1000); if (row.error?.retry) { delete row.error; row.liveError = false; }
    }
    if (event.type === 'item' && canProgress) {
      if (event.item?.type === 'reasoning') { if (event.item.status === 'inProgress') row.stage = 'thinking'; row.preview = (event.item.summary || []).join(' ').slice(-1000); }
      else if (event.item?.status === 'inProgress') { row.stage = event.item.type === 'commandExecution' ? 'command' : 'tool'; row.preview = ''; }
      if (event.item?.type === 'agentMessage') { row.stage = 'responding'; row.preview = ''; }
      if (row.error?.retry && event.item) { delete row.error; row.liveError = false; }
    }
    if (event.type === 'delta' && canProgress) { row.stage = 'responding'; row.preview = ''; if (row.error?.retry) { delete row.error; row.liveError = false; } }
    if (event.type === 'history' && row.turn?.status === 'inProgress' && !row.preview) row.preview = (event.items || []).filter(item => item.type === 'reasoning').at(-1)?.summary?.join(' ').slice(-1000) || '';
    if (event.type === 'approval' && event.params?.threadId === state.active) row.stage = 'waiting';
    if (event.type === 'connection' && event.status === 'connecting') for (const value of records.values()) { value.live = false; value.liveError = false; }
    render();
  }};
};
