'use strict';
window.RemoteCodexUsage = ({ root, state, q, make, request }) => {
  const dialog = make('dialog', 'workspace-dialog usage-dialog'); dialog.id = 'usage-dialog'; dialog.setAttribute('aria-labelledby', 'usage-title');
  const heading = make('h3', '', '用量'); heading.id = 'usage-title';
  const context = make('div', 'usage-context'), content = make('div', 'usage-content'), status = make('div', 'usage-status'); status.setAttribute('role', 'status');
  const actions = make('div', 'workspace-dialog-actions'), refresh = make('button', 'small-button cursor-interaction', '刷新'), close = make('button', 'small-button cursor-interaction', '关闭'); refresh.type = close.type = 'button'; refresh.id = 'usage-refresh'; close.onclick = () => dialog.close(); actions.append(refresh, close);
  dialog.append(heading, context, content, status, actions); root.append(dialog);
  let scope, threadId, snapshot, loading = false, generation = 0, timer;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = value => numeric(value) ? Math.round(value).toLocaleString() : '暂无数据';
  function time(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '暂无数据'; }
  function windowName(value, fallback) { if (!numeric(value) || !value) return fallback; return value % 1440 === 0 ? (value / 1440) + ' 天额度' : value % 60 === 0 ? (value / 60) + ' 小时额度' : value + ' 分钟额度'; }
  function section(title) { const node = make('section', 'usage-section'); node.append(make('h4', '', title)); content.append(node); return node; }
  function metric(node, label, value) { const row = make('div', 'usage-metric'); row.append(make('span', '', label), make('strong', '', value)); node.append(row); }
  function render() {
    content.replaceChildren(); if (!snapshot) return;
    const limits = section('账号额度'), response = snapshot.rateLimits;
    const map = response?.rateLimitsByLimitId;
    const buckets = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length ? Object.entries(map).sort(([a], [b]) => a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b)) : response?.rateLimits ? [[response.rateLimits.limitId || 'codex', response.rateLimits]] : [];
    let windows = 0;
    for (const [id, bucket] of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const block = make('div', 'usage-limit-bucket'); block.dataset.limitId = id;
      block.append(make('div', 'usage-limit-name', [bucket.limitName || (id === 'codex' ? 'Codex' : id), bucket.planType?.toUpperCase()].filter(Boolean).join(' · ')));
      for (const [type, label] of [['primary', '主额度'], ['secondary', '次额度']]) {
        const value = bucket[type]; if (!value || typeof value !== 'object') continue; windows++;
        const used = numeric(value.usedPercent) ? value.usedPercent : null, remaining = used === null ? null : Math.max(0, 100 - used);
        const row = make('div', 'usage-window'); row.dataset.window = type;
        metric(row, windowName(value.windowDurationMins, label), used === null ? '暂无数据' : `已用 ${used.toLocaleString()}% · 剩余 ${remaining.toLocaleString()}%`);
        if (used !== null) { const bar = make('progress', 'usage-progress'); bar.max = 100; bar.value = Math.min(100, used); bar.setAttribute('aria-label', windowName(value.windowDurationMins, label) + '已用'); row.append(bar); }
        row.append(make('div', 'usage-reset', '重置：' + (numeric(value.resetsAt) && value.resetsAt > 0 ? time(value.resetsAt * 1000) : '暂无数据'))); block.append(row);
      }
      if (bucket.credits?.unlimited) metric(block, '附加额度', '不限量');
      else if (bucket.credits?.hasCredits && bucket.credits.balance != null) metric(block, '附加额度余额', String(bucket.credits.balance) + ' credits');
      limits.append(block);
    }
    if (!windows) limits.append(make('p', 'usage-muted', snapshot.errors?.rateLimits ? '远端额度暂时无法读取，可稍后刷新。' : '远端没有提供额度窗口数据。'));
    const account = section('账号 Token 活动'), stats = snapshot.accountUsage?.summary;
    metric(account, '累计 Token', count(stats?.lifetimeTokens)); metric(account, '单日最高 Token', count(stats?.peakDailyTokens));
    const days = snapshot.accountUsage?.dailyUsageBuckets;
    if (Array.isArray(days) && days.length) {
      const latest = [...days].filter(d => typeof d.startDate === 'string').sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
      if (latest) metric(account, '最近统计日 ' + latest.startDate, count(latest.tokens));
    }
    const thread = section('当前会话 Token'), record = snapshot.threadTokenSnapshot;
    if (record?.total) {
      const total = record.total;
      metric(thread, '累计 Token', count(total.total_tokens)); metric(thread, '输入', count(total.input_tokens)); metric(thread, '其中缓存输入', count(total.cached_input_tokens)); metric(thread, '输出', count(total.output_tokens));
      thread.append(make('p', 'usage-muted', (record.source === 'live' ? '来源：实时会话通知' : '来源：会话记录快照') + (record.recordedAt ? ' · ' + time(record.recordedAt) : '')));
    } else if (snapshot.threadUsage?.groups?.length) {
      const groups = snapshot.threadUsage.groups;
      for (const group of groups) { const block = make('div', 'usage-thread-group'); block.append(make('div', 'usage-limit-name', group.model || '远端模型')); metric(block, '合计（预估）', count(group.totalTokens)); metric(block, '输入 / 输出', count(group.inputTokens) + ' / ' + count(group.outputTokens)); thread.append(block); }
      thread.append(make('p', 'usage-muted', '来源：远端会话预估统计'));
    } else thread.append(make('p', 'usage-muted', threadId ? '远端暂未提供此会话的 Token 统计。' : '选择一个会话后可查看会话用量。'));
    content.append(make('p', 'usage-muted', '额度由同一远端账号共享。Token 数不等同于额度百分比；统计可能有延迟。'));
    if (numeric(snapshot.fetchedAt)) content.append(make('div', 'usage-updated', '更新于 ' + time(snapshot.fetchedAt * 1000) + '（本地时间）'));
  }
  async function load() {
    if (loading || !dialog.open) return;
    const token = generation;
    if (!state.connected) { status.textContent = snapshot ? '已断开，显示上次数据。' : '请先连接远端 Codex。'; return; }
    loading = true; refresh.disabled = true; status.textContent = '正在读取远端用量…';
    try {
      const value = await request('usageRead', { threadId, draftScope: scope });
      if (!dialog.open || token !== generation || scope !== state.draftScope || threadId !== (state.active || null)) return;
      snapshot = value; render(); status.textContent = Object.values(value.errors || {}).some(Boolean) ? '部分统计暂不可用，已显示可读取的数据。' : '';
    } catch (error) { if (dialog.open && token === generation) status.textContent = (snapshot ? '刷新失败，显示上次数据。' : '') + error.message; }
    finally { if (token === generation) { loading = false; refresh.disabled = false; } }
  }
  function open() {
    if (dialog.open) return;
    scope = state.draftScope; threadId = state.active || null; snapshot = null; generation++; loading = false;
    context.textContent = '远端账号 · ' + state.host; content.replaceChildren(); status.textContent = ''; dialog.showModal(); load(); timer = setInterval(load, 60000);
  }
  refresh.onclick = load;
  dialog.addEventListener('close', () => { generation++; loading = false; refresh.disabled = false; clearInterval(timer); });
  return { open, receive(event) {
    if (!dialog.open) return;
    if ((event.type === 'draftSnapshot' && event.scope !== scope) || (event.type === 'thread' && event.thread?.id !== threadId) || event.type === 'projectOpened' || event.type === 'loadingThread') { dialog.close(); return; }
    if (event.type === 'usageChanged') load();
    if (event.type === 'connection' && event.status === 'connected') status.textContent = snapshot ? '连接已恢复，可刷新最新数据。' : '';
    if (event.type === 'connection' && event.status !== 'connected') status.textContent = snapshot ? '已断开，显示上次数据。' : '请先连接远端 Codex。';
    if (event.type === 'threadTokenUsage' && event.threadId === threadId && snapshot && event.tokenUsage?.total) {
      const fields = ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'], names = ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
      snapshot.threadTokenSnapshot = { source: 'live', total: Object.fromEntries(fields.map((field, i) => [names[i], event.tokenUsage.total[field]])), recordedAt: new Date().toISOString() }; render();
    }
  } };
};
