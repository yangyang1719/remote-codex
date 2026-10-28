'use strict';
(() => {
  const root = document.getElementById('codex-message-concept');
  const q = s => root.querySelector(s);
  const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const state = { demo: false, connected: false, loading: false, host: 'my-dev-server', project: '', threads: [], active: null, items: {}, cursors: {}, historyLoading: {}, visibleCounts: {}, sync: {}, access: {}, approvals: [], drafts: {}, quotes: {}, attachments: {}, remotePreviews: {}, platform: 'whatsapp', conversations: [], selected: {}, messages: {}, replyDrafts: {}, seenDrafts: {}, pendingReply: null, sendPending: null, running: {}, icons: {}, gateway: false, gatewayText: '正在检查远端消息服务…' };
  const messageFormat = window.RemoteCodexMessageFormat(state);
  let commands, session, drafts, workspaceNavigation, messageMedia, whatsappLink, sendHelp, inbox, appearance, asyncQuestions, remoteAccount, runState; state.remoteRuns = {};
  const post = (action, data = {}) => {
    if (action === 'send') { const conversation = current(); data = { ...data, messageSelection: { platform: state.platform, conversationId: conversation?.id || null } }; }
    if (state.demo && action !== 'settings') { demoAction(action, data); return; }
    window.webkit?.messageHandlers?.native?.postMessage({ action, draftScope: state.draftScope, ...data });
  };
  function icons(scope = root) { scope.querySelectorAll('[data-lucide]').forEach(el => { const src = state.icons[el.dataset.lucide]; if (src && el.dataset.iconReady !== src) { el.style.webkitMaskImage = `url("${src}")`; el.style.maskImage = `url("${src}")`; el.dataset.iconReady = src; } }); }
  function icon(name) { const el = make('i', 'icon'); el.dataset.lucide = name; el.setAttribute('aria-hidden', 'true'); return el; }
  const key = () => state.active || 'new';
  const bridgeRequests = new Map(); let fileQueue = Promise.resolve();
  function attachmentRequest(action, data) {
    if (state.demo) return Promise.reject(new Error('请在实际客户端中添加附件。'));
    const bridgeId = crypto.randomUUID();
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { bridgeRequests.delete(bridgeId); reject(new Error(action === 'usageRead' ? '查询用量超时，请稍后刷新。' : '操作结果未确认，请先查看最新记录。')); }, (['answerAsyncQuestion','projectAction','threadAction','loadThreadPage','refreshProjectThreads','usageRead'].includes(action) || action.startsWith('messageMedia') || action.startsWith('whatsappLink') || action.startsWith('viewedImage')) ? 120000 : 30000); bridgeRequests.set(bridgeId, { resolve, reject, timer }); post(action, { ...data, bridgeId }); });
  }
  const viewedImages = window.RemoteCodexViewedImages({ state, make, icon, request: attachmentRequest });
  const attachmentRows = () => state.attachments[key()] || [];
  function attachmentNote(message = '') { q('#attachment-status').textContent = message; q('#attachment-status').hidden = !message; }
  const sizeLabel = size => size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.ceil(size / 1024)) + ' KB';
  function attachmentCard(file, draft = false) {
    const card = make('div', 'attachment-card' + (file.isImage ? ' image-attachment' : '')); card.dataset.attachmentId = file.id || ''; card.dataset.status = file.status || 'ready';
    const preview = make('button', 'attachment-preview cursor-interaction'); preview.type = 'button'; preview.setAttribute('aria-label', '预览 ' + file.name); preview.disabled = ['adding', 'error'].includes(file.status) || (!file.id && !file.path);
    const thumb = file.thumbnail || state.remotePreviews[file.path];
    if (thumb) { const img = make('img', 'attachment-thumb'); img.src = thumb; img.alt = file.name; preview.append(img); } else preview.append(icon(file.isImage ? 'image' : 'file-text'));
    const copy = make('span', 'attachment-copy'); copy.append(make('span', 'attachment-name', file.name));
    const detail = file.status === 'adding' ? '正在添加 ' + Math.round((file.progress || 0) * 100) + '%' : file.status === 'uploading' ? '正在上传…' : file.status === 'uploaded' ? '已上传 · 正在发送' : file.status === 'error' ? file.message : file.message || (file.source === 'project' ? '远端项目' : file.size != null ? sizeLabel(file.size) : '图片');
    copy.append(make('span', 'attachment-meta', detail)); preview.append(copy);
    preview.onclick = async () => { preview.disabled = true; try { await attachmentRequest('attachmentPreview', file.id ? { id: file.id } : { path: file.path }); } catch (error) { attachmentNote(error.message); } finally { preview.disabled = false; } };
    card.append(preview);
    if (draft) { const remove = make('button', 'attachment-remove cursor-interaction'); remove.type = 'button'; remove.setAttribute('aria-label', '移除 ' + file.name); remove.append(icon('x')); remove.disabled = !!state.sendPending || !!state.commandPending; remove.onclick = () => { file.cancelled = true; state.attachments[key()] = attachmentRows().filter(row => row !== file); post('attachmentRemove', { id: file.id }); drafts?.codex(key()); renderAttachments(); renderControls(); }; card.append(remove); }
    return card;
  }
  function renderAttachments() {
    const list = q('#attachment-list'); if (!list) return;
    list.replaceChildren(...attachmentRows().map(file => attachmentCard(file, true))); list.hidden = !attachmentRows().length; icons(list);
    q('#attachment-add').disabled = !!state.sendPending || !!state.commandPending;
  }
  function addFiles(files) {
    if (state.sendPending || state.commandPending) { attachmentNote('当前操作完成后可继续添加附件。'); return; }
    const draftKey = key(), draftScope = state.draftScope, rows = state.attachments[draftKey] ||= [];
    attachmentNote();
    for (const file of files) {
      if (rows.length >= 10) { attachmentNote('每条消息最多 10 个附件。'); break; }
      const row = { id: crypto.randomUUID(), name: file.name || '粘贴图片.png', size: file.size, isImage: file.type.startsWith('image/'), status: 'adding', progress: 0 };
      rows.push(row);
      fileQueue = fileQueue.then(async () => {
        if (row.cancelled) return;
        try {
          if (file.size > 25 * 1024 * 1024) throw new Error('单个附件最多 25 MB');
          await attachmentRequest('attachmentBegin', { id: row.id, draftScope, draftKey, name: row.name, size: file.size });
          for (let offset = 0; offset < file.size; offset += 65536) {
            if (row.cancelled) return;
            const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer()); let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            await attachmentRequest('attachmentChunk', { id: row.id, offset, data: btoa(binary) });
            row.progress = (offset + bytes.length) / Math.max(file.size, 1); if (key() === draftKey) renderAttachments();
          }
          if (row.cancelled) return;
          const value = await attachmentRequest('attachmentFinish', { id: row.id });
          if (!row.cancelled) Object.assign(row, value);
        } catch (error) { if (!row.cancelled) { row.status = 'error'; row.message = error.message; } post('attachmentRemove', { id: row.id }); }
        finally { if (row.cancelled) post('attachmentRemove', { id: row.id }); drafts?.codex(draftKey, draftScope); if (key() === draftKey) { renderAttachments(); renderControls(); } }
      });
    }
    renderAttachments(); renderControls();
  }
  let projectQueryTimer, projectQueryEpoch = 0, projectOptions = [], projectChoice = 0;
  function closeProjectPicker() { clearTimeout(projectQueryTimer); projectQueryEpoch++; const picker = q('#project-file-picker'); if (picker) picker.hidden = true; projectOptions = []; }
  function searchProjectFiles() {
    clearTimeout(projectQueryTimer);
    const input = q('#cmsg-input'), prefix = input.value.slice(0, input.selectionStart), match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
    if (!match || !state.connected || state.sendPending || state.commandPending) { closeProjectPicker(); return; }
    const query = match[1], draftKey = key(), start = input.selectionStart - query.length - 1, end = input.selectionStart, generation = ++projectQueryEpoch;
    const picker = q('#project-file-picker'); picker.hidden = false; picker.replaceChildren(make('div', 'project-picker-note', '搜索远端项目文件…'));
    projectQueryTimer = setTimeout(async () => {
      try {
        const result = await attachmentRequest('attachmentSearch', { query, draftKey });
        if (generation !== projectQueryEpoch || key() !== draftKey) return;
        projectOptions = []; projectChoice = 0; picker.replaceChildren(make('div', 'project-picker-note', '远端项目文件'));
        for (const file of result.files || []) {
          const button = make('button', 'project-file-option cursor-interaction'); button.type = 'button'; button.setAttribute('role', 'option'); button.dataset.path = file.path; button.setAttribute('aria-selected', String(!projectOptions.length));
          button.append(icon('file-text'), make('span', '', file.relative || file.name));
          button.onclick = async () => {
            if ((state.attachments[draftKey] || []).length >= 10) { attachmentNote('每条消息最多 10 个附件。'); return; }
            closeProjectPicker(); const row = { id: crypto.randomUUID(), name: file.name, status: 'adding', source: 'project' };
            (state.attachments[draftKey] ||= []).push(row); renderAttachments(); renderControls();
            try {
              const value = await attachmentRequest('attachmentReference', { id: row.id, path: file.path, token: result.token, draftKey });
              if (row.cancelled) { post('attachmentRemove', { id: row.id }); return; }
              Object.assign(row, value); drafts?.codex(draftKey);
              if (key() === draftKey && input.value.slice(start, end) === '@' + query) { input.value = input.value.slice(0, start) + input.value.slice(end); input.setSelectionRange(start, start); saveCodexDraft(); }
            } catch (error) { if (!row.cancelled) { row.status = 'error'; row.message = error.message; } }
            finally { if (key() === draftKey) { renderAttachments(); renderControls(); input.focus({ preventScroll: true }); } }
          };
          projectOptions.push(button); picker.append(button);
        }
        if (!projectOptions.length) picker.append(make('div', 'project-picker-note', '没有找到匹配文件'));
        icons(picker);
      } catch (error) { if (generation === projectQueryEpoch) picker.replaceChildren(make('div', 'project-picker-note', error.message)); }
    }, 250);
  }
  function saveCodexDraft(force = false) { const value = q('#cmsg-input').value, changed = (state.drafts[key()] || '') !== value; state.drafts[key()] = value; if (changed || force) drafts?.codex(key()); }
  const current = () => state.conversations.find(c => c.id === state.selected[state.platform]);
  const platformName = value => value === 'whatsapp' ? 'WhatsApp' : 'Telegram';
  function banner(text = '', actions = [], kind = 'info') { const node = q('#app-banner'); node.hidden = !text; node.dataset.kind = kind; node.replaceChildren(document.createTextNode(text)); for (const action of actions) { const button = make('button', 'cursor-interaction', action.label); button.type = 'button'; button.disabled = !!action.disabled; button.onclick = action.run; node.append(button); } }
  function requestHistory(id, cursor = null) {
    if (state.historyLoading[id]) return;
    state.historyLoading[id] = true; renderTranscript();
    post(cursor ? 'loadHistory' : 'refreshThread', { threadId: id, ...(cursor ? { cursor } : {}) });
  }
  function accessBanner() {
    if (!state.connected) return;
    if (state.uncertainSend) { banner('上次发送结果未确认，草稿已保留。请先查看最新记录，再决定是否重新发送。', [{ label: '知道了', run: () => { state.uncertainSend = false; renderControls(); } }]); return; }
    const id = state.active, mode = state.access[id];
    if (session?.isChild()) { banner('子代理只读查看。返回父会话后继续交流。'); return; }
    if (!id || mode === 'writable' || state.demo) { banner(); return; }
    if (mode === 'resuming') { banner('正在尝试继续此会话…'); return; }
    const remote = state.remoteRuns[id];
    const sync = state.sync[id], status = sync === 'active' ? '正在自动跟进新回复。' : sync === 'retrying' ? '同步暂时中断，正在自动重试。' : sync === 'unavailable' ? '自动同步暂不可用，可手动刷新。' : '';
    if (remote?.managed && mode !== 'busy') { banner((remote.pendingApprovals ? '远端正在等待审批。继续此会话后可处理。' : (remote.running || remote.activeTurn) ? '任务正在远端执行，关闭客户端后仍会继续。' : '远端会话已保留，可查看记录或继续操作。') + status, [{ label: '刷新记录', run: () => requestHistory(id) }, { label: '继续此会话', run: () => post('continueThread', { threadId: id }) }]); return; }
    const text = (mode === 'busy' ? '该会话由另一个独立服务持有，暂时只能查看。草稿已保留，可稍后重试。' : '当前只读查看历史记录。继续或发送时加入会话，其他客户端可继续使用。') + status;
    banner(text, [{ label: state.historyLoading[id] ? '正在读取…' : '刷新记录', disabled: state.historyLoading[id], run: () => requestHistory(id) }, { label: '继续此会话', run: () => post('continueThread', { threadId: id }) }]);
  }
  function sidebar(open) { root.classList.toggle('is-collapsed', !open); q('#cmsg-sidebar').hidden = !open; q('#cmsg-toggle').setAttribute('aria-expanded', String(open)); if (!open) picker(false); else inbox?.viewed(); localStorage.setItem('messagesOpen', String(open)); }
  function navigation(open) { root.classList.toggle('is-nav-collapsed', !open); q('#cmsg-navigation').hidden = !open; q('#cmsg-navigation-toggle').setAttribute('aria-expanded', String(open)); q('#cmsg-navigation-toggle').setAttribute('aria-label', open ? '收起左侧项目栏' : '展开左侧项目栏'); localStorage.setItem('navigationOpen', String(open)); }
  function referenceTarget(raw) {
    let value = raw.trim();
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
    value = value.replace(/\\([\\()[\] ])/g, '$1');
    if (/^https?:\/\//i.test(value)) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? { url: url.href } : null; } catch { return null; } }
    if (!value.startsWith('/') || value.startsWith('//')) return null;
    try { value = decodeURIComponent(value); } catch { return null; }
    if (/[\0\r\n]/.test(value) || value.split('/').includes('..')) return null;
    const location = /(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*)(?:C[1-9]\d*)?)$/.exec(value);
    const line = location ? Number(location[1] || location[2]) : null;
    if (line !== null && !Number.isSafeInteger(line)) return null;
    return { path: location ? value.slice(0, location.index) : value, line };
  }
  function referenceNode(label, target) {
    if (target.url) { const link = make('a', '', label); link.href = target.url; return link; }
    const link = make('button', 'file-reference cursor-interaction'); link.type = 'button'; link.dataset.filePath = target.path;
    link.title = target.path + (target.line ? ':' + target.line : '');
    link.setAttribute('aria-label', '预览远端文件 ' + label + (target.line ? '（引用第 ' + target.line + ' 行）' : ''));
    link.append(icon('file-text'), document.createTextNode(label));
    if (target.line) { link.dataset.line = target.line; link.append(make('span', 'file-reference-line', ':' + target.line)); }
    link.onclick = async () => {
      link.disabled = true;
      try { await attachmentRequest('attachmentPreview', { path: target.path }); }
      catch (error) { attachmentNote(error.message); }
      finally { link.disabled = false; }
    };
    return link;
  }
  function inline(parent, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\](?:\\)?\()/g; let start = 0, match;
    while ((match = re.exec(text))) {
      const value = match[0]; let node, end = re.lastIndex;
      if (value.startsWith('`')) node = make('code', '', value.slice(1, -1));
      else if (value.startsWith('**')) node = make('strong', '', value.slice(2, -2));
      else {
        const from = end, limit = Math.min(text.length, from + 8192); let depth = 1;
        for (; end < limit; end++) {
          const char = text[end];
          if (char === '\n') break;
          if (char === '\\') { end++; continue; }
          if (char === '(') depth++;
          if (char === ')' && --depth === 0) break;
        }
        if (depth !== 0) continue;
        const target = referenceTarget(text.slice(from, end)); re.lastIndex = ++end;
        if (!target) continue;
        node = referenceNode(/^\[([^\]]+)\]/.exec(value)[1], target);
      }
      parent.append(document.createTextNode(text.slice(start, match.index)), node); start = end;
    }
    parent.append(document.createTextNode(text.slice(start)));
  }
  const transcript = window.RemoteCodexTranscript({ make, icon, inline, pagedText, request: attachmentRequest, connected: () => state.connected });
  function itemText(item) {
    const text = typeof item.text === 'string' ? item.text : (item.content || []).filter(c => c.type !== 'image' && c.type !== 'localImage').map(c => c.text || '').join('\n');
    if (item.type !== 'userMessage') return text;
    return text.replace(/\n\n<desktop_message_context>\n([^\n]+)\n<\/desktop_message_context>\s*$/, (whole, raw) => { try { const value = JSON.parse(raw); return value.version === 1 && value.client === 'remote-codex-desktop' && typeof value.contextId === 'string' ? '' : whole; } catch { return whole; } });
  }
  function pagedText(node, text, rich = false) {
    const value = String(text || ''); let offset = 0;
    if (rich) { transcript.markdown(node, value); return; }
    const more = make('button', 'small-button text-more'); more.type = 'button';
    const append = () => { const part = value.slice(offset, offset + 12000); offset += part.length; node.insertBefore(document.createTextNode(part), more); more.hidden = offset >= value.length; more.textContent = `显示更多（剩余 ${value.length - offset} 字符）`; };
    more.onclick = append; node.append(more); append();
  }
  function toolDetail(label, content, className = '') {
    const node = make('details', 'tool-detail'); node.append(make('summary', className, label));
    // Closed tools contain no output nodes. Expanding one tool reads its output
    // in chunks, so a megabyte-sized log never blocks the whole conversation.
    node.addEventListener('toggle', () => { if (!node.open || node.dataset.loaded) return; node.dataset.loaded = 'true'; const pre = make('pre'); pagedText(pre, content()); node.append(pre); });
    return node;
  }
  function renderItem(item) {
    if (item.type === 'reasoning') return (item.summary || []).some(text => text.trim()) || item.status === 'inProgress' ? transcript.reasoning(item) : null;
    if (item.type === 'userMessage') {
      const node = make('div', 'user-message'); let text = itemText(item), files = [];
      const answered = asyncQuestions?.history(text); if (answered) { node.append(answered); return node; }
      const intro = ['\n\n本次附件位于远端，可按需读取：\n<remote_codex_attachments>\n', '\n\n附件已上传到远端，下面是用户选择的文件资料，可按需读取：\n<remote_codex_attachments>\n'].find(value => text.includes(value)) || '', end = '\n</remote_codex_attachments>', index = intro ? text.lastIndexOf(intro) : -1;
      if (index >= 0 && text.endsWith(end)) { try { const parsed = JSON.parse(text.slice(index + intro.length, -end.length)); if (Array.isArray(parsed)) { files = parsed.filter(f => typeof f.path === 'string' && typeof f.name === 'string').slice(0, 10); text = text.slice(0, index); } } catch {} }
      for (const part of item.content || []) if (part.type === 'localImage' || part.type === 'image') { const path = part.path || (part.url?.startsWith('file:') ? decodeURIComponent(new URL(part.url).pathname) : ''); if (!files.some(f => f.path === path)) files.push({ name: path.split('/').pop() || '图片', path, isImage: true }); }
      if (text.trim()) pagedText(node, text, true);
      if (files.length) { const list = make('div', 'attachment-list sent-attachments'); files.forEach(file => list.append(attachmentCard(file))); node.append(list); }
      return node;
    }
    if (item.type === 'plan' && commands) return commands.planCard(item);
    if (item.type === 'imageView') return viewedImages.render(item, state.active);
    if (item.type === 'agentMessage') {
      const node = make('div', 'assistant-message'); pagedText(node, itemText(item), true);
      for (const card of asyncQuestions?.render(item, state.active) || []) node.append(card);
      return node;
    }
    if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
      const titles = { spawnAgent: '创建子代理', sendInput: '向子代理同步', wait: '等待子代理', closeAgent: '关闭子代理', resumeAgent: '继续子代理', started: '启动', interacted: '同步', interrupted: '中断', completed: '完成' };
      return toolDetail('子代理 · ' + (titles[item.tool || item.kind] || item.tool || item.kind || ''), () => item.prompt || item.agentPath || Object.entries(item.agentsStates || {}).map(([id, value]) => id + ' · ' + value.status + '\n' + (value.message || '')).join('\n\n'));
    }
    if (item.type === 'fileChange') { const node = make('div', 'file-change'); for (const change of item.changes || []) node.append(toolDetail(change.path || '文件改动', () => change.diff || JSON.stringify(change.kind), 'file-row')); return node; }
    if (item.type === 'commandExecution') return transcript.command(item);
    if (item.type === 'mcpToolCall') {
      let label = `${item.server || ''} · ${item.tool || '工具'} · ${item.status || ''}`;
      if (item.server === 'desktop-messages' && ['messages_current_context', 'messages_prepare_send', 'messages_send_prepared'].includes(item.tool)) {
        try {
          const value = item.result?.structuredContent || JSON.parse(item.result?.content?.find(part => part.type === 'text')?.text || '{}');
          const target = value.route?.target || value.target;
          if (target) label = (item.tool === 'messages_send_prepared' ? '发送消息' : item.tool === 'messages_prepare_send' ? '准备发送' : '本次消息会话') + ' · ' + platformName(target.platform) + ' · ' + (target.name || '未选择会话') + ' · ' + (item.status || '');
        } catch {}
      }
      return toolDetail(label, () => JSON.stringify(item.result || item.error || {}, null, 2));
    }
    return null;
  }
  let transcriptFrame = null, renderGeneration = 0, renderedThread, scrollToLatest = false;
  const itemNodes = new Map();
  function scheduleRender(callback) {
    // WebKit pauses animation frames for occluded/inactive windows. A timer
    // fallback must still finish loading data while the app is in the background.
    let fired = false;
    const run = () => { if (fired) return; fired = true; clearTimeout(timer); cancelAnimationFrame(frame); callback(); };
    const timer = setTimeout(run, 32), frame = requestAnimationFrame(run);
    return { timer, frame };
  }
  function renderTranscript() {
    renderControls();
    renderGeneration += 1;
    q('#cmsg-transcript').setAttribute('aria-busy', 'true');
    if (transcriptFrame === null) transcriptFrame = scheduleRender(flushTranscript);
  }
  function flushTranscript() {
    asyncQuestions?.sync(state.items[state.active] || [], itemText);
    transcriptFrame = null;
    const node = q('#cmsg-transcript'), id = state.active, generation = renderGeneration;
    if (renderedThread !== id) { itemNodes.clear(); renderedThread = id; scrollToLatest = true; }
    const items = (state.items[id] || []).filter(item => ['userMessage', 'agentMessage', 'reasoning', 'plan', 'fileChange', 'commandExecution', 'mcpToolCall', 'imageView', 'collabAgentToolCall', 'subAgentActivity'].includes(item.type));
    const start = Math.max(0, items.length - (state.visibleCounts[id] || 80)), visible = items.slice(start), rows = [];
    if (!id) { const empty = make('div', 'empty-state'); empty.append(make('h3', '', '从这里开始'), make('div', '', state.workspaceEmpty ? '从左侧添加远端项目后开始使用。' : state.connected ? '选择左侧的远端会话，或发送消息开始新的对话。' : '正在连接远端 Codex…')); rows.push(empty); }
    else if (start || state.cursors[id]) {
      const older = make('button', 'small-button', start ? `显示更早的记录（本页还有 ${start} 项）` : state.historyLoading[id] ? '正在读取…' : '加载更早的记录'); older.type = 'button'; older.dataset.older = 'true'; older.disabled = !start && !!state.historyLoading[id];
      older.onclick = () => { if (start) { state.visibleCounts[id] = (state.visibleCounts[id] || 80) + 60; renderTranscript(); } else requestHistory(id, state.cursors[id]); }; rows.push(older);
    }
    if (id && !items.length) rows.push(make('div', 'empty-state', state.loading ? '正在读取远端记录…' : '这个会话还没有消息。'));
    let index = 0;
    function batch() {
      if (generation !== renderGeneration) return;
      const began = performance.now(); let count = 0;
      while (index < visible.length && count < 8 && performance.now() - began < 6) {
        const item = visible[index++], cached = itemNodes.get(item.id); let el;
        if (cached?.item === item) el = cached.node;
        else { count++; el = cached && item.type === 'commandExecution' ? transcript.updateCommand(cached.node, item) : cached && item.type === 'reasoning' ? transcript.updateReasoning(cached.node, item) : renderItem(item); if (el) { el.dataset.itemId = item.id; itemNodes.set(item.id, { item, node: el }); } }
        if (el) rows.push(el);
      }
      if (index < visible.length) { scheduleRender(batch); return; }
      for (const approval of state.approvals.filter(a => session?.visible(a))) rows.push(renderApproval(approval));
      const anchor = Array.from(node.children).find(el => el.dataset.itemId && el.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
      const anchorTop = anchor?.getBoundingClientRect().top, anchorID = anchor?.dataset.itemId, atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 50;
      // Reuse unchanged message nodes instead of rebuilding the transcript for
      // every token, access-state change or refresh notification.
      let next = node.firstChild; for (const row of rows) { if (row === next) next = next.nextSibling; else node.insertBefore(row, next); } while (next) { const stale = next; next = next.nextSibling; stale.remove(); }
      const ids = new Set(visible.map(item => item.id)); for (const cachedID of itemNodes.keys()) if (!ids.has(cachedID)) itemNodes.delete(cachedID);
      icons(node);
      const focus = state.explicitQuestionFocus;
      const requested = focus?.threadId === id && rows.find(row => row.dataset.token === focus.token);
      const question = state.questionAttention && rows.find(row => row.dataset.token === state.questionAttention);
      if (requested) {
        node.scrollTop += requested.getBoundingClientRect().top - node.getBoundingClientRect().top;
        node.querySelectorAll('.question-highlight').forEach(el => el.classList.remove('question-highlight'));
        requested.classList.add('question-highlight'); requested.tabIndex = -1; requested.focus({ preventScroll: true });
        state.explicitQuestionFocus = null; state.questionAttention = null; scrollToLatest = false;
      }
      else if (question && (scrollToLatest || atBottom)) { node.scrollTop += question.getBoundingClientRect().top - node.getBoundingClientRect().top; state.questionAttention = null; scrollToLatest = false; }
      else if (scrollToLatest || atBottom) { node.scrollTop = node.scrollHeight; scrollToLatest = false; }
      else { const replacement = itemNodes.get(anchorID)?.node; if (replacement?.isConnected) node.scrollTop += replacement.getBoundingClientRect().top - anchorTop; }
      node.setAttribute('aria-busy', String(!!state.historyLoading[id]));
    }
    batch();
  }
  function sendBlockReason(forDraft = true) {
    if (state.asyncQuestionPending != null) return '正在提交问题回答，请稍候。';
    if (session?.isChild()) return '子代理由父会话管理，请返回父会话继续交流。';
    if (state.workspaceEmpty) return '请先添加或打开远端项目。';
    if (!state.connected) return '远端 Codex 尚未连接，文字和附件已保留。';
    if (state.sendPending) return '上一条消息正在提交，请等待确认，不要重复发送。';
    if (state.commandPending || state.workspaceBusy) return '正在处理当前操作，请稍后发送。';
    if (state.loading || state.draftsReady === false) return '正在恢复会话或草稿，请稍后发送。';
    if (state.access[state.active] === 'busy') return '暂未能加入会话所在服务。可稍后点击“继续此会话”重试。文字和附件已保留。';
    if (state.access[state.active] === 'resuming') return '正在申请此会话的写入权，请稍候。';
    if (forDraft && attachmentRows().some(file => file.status === 'adding')) return '附件正在添加，请等待完成后发送。';
    if (forDraft && attachmentRows().some(file => file.status === 'error')) return '有附件添加失败，请移除或重新添加后发送。';
    return '';
  }
  function explainSendBlock(reason = sendBlockReason()) {
    if (!reason) return;
    state.sendBlockNote = true; attachmentNote('未发送：' + reason);
  }
  function hasCodexDraft() { return !!(q('#cmsg-input').value.trim() || state.quotes[key()] || attachmentRows().length); }
  function renderControls() {
    const title = state.threads.find(t => t.id === state.active); q('.chat-heading h2').textContent = title ? title.name || title.preview?.slice(0, 30) || '远端会话' : '新对话'; q('.location').replaceChildren(icon('git-branch'), document.createTextNode(state.projectName || state.project.split('/').pop() || '远端工作区'));
    q('.location').replaceChildren(icon('git-branch'), document.createTextNode(state.project.split('/').pop() || state.host));
    const mode = state.access[state.active], running = mode === 'writable' && !!state.running[state.active], canStop = running && !hasCodexDraft(); q('#cmsg-send-codex').setAttribute('aria-label', canStop ? '停止当前任务' : running ? '发送补充消息' : '发送给 Codex'); q('#cmsg-send-codex').replaceChildren(icon(canStop ? 'x' : 'arrow-up'));
    q('.chat').dataset.access = mode || 'viewing';
    q('#cmsg-send-codex').disabled = !!state.sendPending || !!state.commandPending || state.loading || state.workspaceBusy || state.workspaceEmpty || state.draftsReady === false || mode === 'resuming' || mode === 'busy' || !state.connected || (!canStop && attachmentRows().some(file => ['adding', 'error'].includes(file.status)));
    if (q('#attachment-add')) { q('#attachment-add').disabled = !!state.sendPending || !!state.commandPending; q('#attachment-list').querySelectorAll('.attachment-remove').forEach(button => button.disabled = !!state.sendPending || !!state.commandPending); }
    q('#cmsg-input').disabled = !!state.workspaceEmpty; q('#cmsg-input').placeholder = mode === 'busy' ? '可先写草稿，稍后点击“继续此会话”重试…' : '继续提问，或从右侧引用一条消息…';
    accessBanner();
    commands?.render();
    session?.controls();
    runState?.render();
    if (session?.isChild()) { q('#cmsg-send-codex').disabled = true; q('#plan-mode').disabled = true; q('#cmsg-input').placeholder = '子代理由父会话管理，可返回父会话继续交流。'; }
    const block = sendBlockReason(!canStop);
    if (sendHelp) { sendHelp.hidden = !q('#cmsg-send-codex').disabled; sendHelp.title = block; sendHelp.setAttribute('aria-label', '查看无法发送的原因：' + block); }
    q('#cmsg-send-codex').title = q('#cmsg-send-codex').disabled ? block : canStop ? '停止当前任务；输入内容后可发送补充消息' : '回车发送 · Ctrl＋回车换行';
    if (state.sendBlockNote && !sendBlockReason()) { state.sendBlockNote = false; attachmentNote(); }
    icons();
  }
  function renderThreads() {
    renderQuestionAlerts();
    if (workspaceNavigation?.render()) return;
    const list = q('#app-thread-list'); list.replaceChildren();
    const project = make('div', 'project'); project.append(icon('chevron-down'), icon('folder'), document.createTextNode(state.project.split('/').pop() || '远端项目')); list.append(project);
    for (const thread of state.threads.filter(t => !t.parentThreadId)) { const button = make('button', 'session cursor-interaction' + (thread.id === state.active ? ' active' : ''), thread.name || thread.preview?.slice(0, 28) || '未命名会话'); button.type = 'button'; button.dataset.threadId = thread.id; const count = state.approvals.filter(a => a.params.threadId === thread.id || a.ownerThreadId === thread.id).length; if (count) button.append(make('span', 'question-badge', `待回答 ${count}`)); button.onclick = () => selectConversation(thread.id); list.append(button); }
    if (!state.threads.length) list.append(make('div', 'session inactive', state.connected ? '暂无远端会话' : '连接后显示会话'));
    icons();
  }
  function uniqueThreads(threads) {
    const byID = new Map(), recency = t => Number(t.updatedAt || t.createdAt || 0);
    for (const thread of threads) { if (!thread.id) continue; const old = byID.get(thread.id); if (!old || recency(thread) > recency(old)) byID.set(thread.id, thread); }
    return [...byID.values()];
  }
  function restoreCodexDraft() { q('#cmsg-input').value = state.drafts[key()] || ''; closeProjectPicker(); commands?.restore(); renderQuote(); renderAttachments(); attachmentNote(); }
  function renderQuote() { const quote = state.quotes[key()]; q('#cmsg-source').hidden = !quote; if (quote) { q('#cmsg-source-label').textContent = [platformName(quote.platform), quote.conversation, quote.author].filter(Boolean).join(' · '); messageFormat.render(q('#cmsg-source-text'), quote.text, quote.platform); } }
  function quoteMessage(message, conversation) { saveCodexDraft(); state.quotes[key()] = { ...message, platform: conversation.platform, conversation: conversation.name, author: message.author || '你' }; drafts?.codex(key()); renderQuote(); renderControls(); q('#cmsg-input').focus({ preventScroll: true }); }
  function saveReplyDraft() { const c = current(); if (c) { const value = q('#cmsg-reply').value, changed = (state.replyDrafts[c.id] || '') !== value; state.replyDrafts[c.id] = value; if (changed) drafts?.reply(c.id); } }
  function picker(open) {
    inbox?.open(open);
  }
  function renderConversation() {
    const c = current(), list = q('#cmsg-items'), nodes = [], feedKey = state.host + ':' + state.draftScope + ':' + (c?.id || '');
    const scrollFeed = q('#cmsg-feed'), changedFeed = list.dataset.feedKey !== feedKey, atBottom = scrollFeed.scrollHeight - scrollFeed.scrollTop - scrollFeed.clientHeight < 32;
    if (changedFeed) { list.querySelectorAll('video,audio').forEach(p => p.pause()); list.replaceChildren(); list.dataset.feedKey = feedKey; }
    const existing = new Map([...list.children].map(node => [node.dataset.feedId, node]));
    inbox?.badges();
    root.querySelectorAll('[data-platform]').forEach(el => el.setAttribute('aria-selected', String(el.dataset.platform === (state.platform === 'whatsapp' ? 'wa' : 'tg'))));
    q('#cmsg-contact').textContent = c?.name || (state.gateway ? '选择对话' : '消息服务未连接'); q('#cmsg-avatar').textContent = c?.name?.[0] || '…'; q('#cmsg-contact-meta').textContent = c ? (c.type === 'group' ? '群聊' : '联系人') + ' · ' + platformName(c.platform) : state.gateway ? '点击切换联系人或群聊' : '账号与消息保存在远端';
    q('#cmsg-reply').placeholder = c ? '回复' + c.name + '…' : '连接消息服务后可回复'; q('#cmsg-reply').value = c ? state.replyDrafts[c.id] || '' : ''; q('#cmsg-reply').disabled = !c; q('#cmsg-reply-preview').disabled = !c;
    q('#cmsg-reply-label').textContent = '发送至 ' + platformName(state.platform);
    if (!c) nodes.push(make('div', 'empty-state', state.gatewayText));
    let lastDate = '';
    for (const msg of c ? state.messages[c.id] || [] : []) {
      const date = new Date(msg.timestamp).toLocaleDateString();
      if (date !== lastDate) { const id = 'date:' + date, divider = existing.get(id) || make('div', 'day-divider', date === new Date().toLocaleDateString() ? '今天' : date); divider.dataset.feedId = id; nodes.push(divider); lastDate = date; }
      const signature = JSON.stringify(msg), mentionRevision = String(messageFormat.revision()), id = 'message:' + msg.id;
      let item = existing.get(id);
      if (!item || item.dataset.signature !== signature) {
        const mine = msg.direction === 'outgoing'; item = make('article', mine ? 'outgoing' : 'message-item'); item.dataset.feedId = id; item.dataset.signature = signature;
        if (!mine) item.append(make('div', 'message-author', `${msg.author || c.name} · ${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
        const body = make('div', 'message-text'); messageFormat.render(body, msg.text || (msg.media ? '' : '[非文本消息]'), c.platform); item.append(body);
        const mediaCard = messageMedia?.card(msg, c); if (mediaCard) item.append(mediaCard);
        if (mine) item.append(make('div', 'outgoing-meta', msg.status || '已发送'));
        const bottom = make('div', 'message-bottom'), button = make('button', 'quote-button cursor-interaction'); button.type = 'button'; button.append(icon('corner-up-left'), document.createTextNode('引用到 Codex'));
        button.onclick = () => messageMedia ? messageMedia.quote(msg, c) : quoteMessage(msg, c); bottom.append(button); item.append(bottom);
      } else if (item.dataset.mentionRevision !== mentionRevision) {
        messageFormat.render(item.querySelector('.message-text'), msg.text || (msg.media ? '' : '[非文本消息]'), c.platform);
      }
      item.dataset.mentionRevision = mentionRevision;
      nodes.push(item);
    }
    let cursor = list.firstChild;
    for (const node of nodes) { if (node === cursor) cursor = cursor.nextSibling; else list.insertBefore(node, cursor); }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    icons(); messageMedia?.renderDraft();
    if (changedFeed || atBottom) scrollFeed.scrollTop = scrollFeed.scrollHeight;
    inbox?.viewed();
  }
  function cancelReply() { if (state.pendingReply?.sending) return; state.pendingReply = null; q('#cmsg-confirm').hidden = true; q('#cmsg-reply-send').disabled = false; q('#cmsg-message-status').textContent = ''; }
  function renderApproval(a) { return session.approval(a); }
  function selectConversation(id) {
    if (id === state.active) return;
    if (state.explicitQuestionFocus?.threadId !== id) state.explicitQuestionFocus = null;
    saveCodexDraft(); state.active = id; state.loading = true; restoreCodexDraft(); renderThreads(); renderTranscript(); post('selectThread', { id });
  }
  const liveItems = new Map();
  function updateItem(thread, item) { state.items[thread] ||= []; if (!liveItems.has(thread)) liveItems.set(thread, new Set()); liveItems.get(thread).add(item.id); const index = state.items[thread].findIndex(i => i.id === item.id); if (index >= 0) state.items[thread][index] = { ...state.items[thread][index], ...item }; else state.items[thread].push(item); if (thread === state.active) renderTranscript(); }
  function receive(event) {
    appearance?.receive(event);
    if (event.type === 'bootstrap' && !event.demo) drafts?.prepare(event.draftScope);
    drafts?.receive(event);
    workspaceNavigation?.receive(event);
    messageMedia?.receive(event);
    switch (event.type) {
      case 'reconnecting': banner(event.delay ? `连接已断开，${event.delay} 秒后自动重连…` : '正在恢复连接…', [{ label: '立即重连', run: () => post('reconnect') }]); break;
      case 'draftError': attachmentNote(event.message); break;
      case 'bootstrap': state.icons = event.icons || {}; state.host = event.settings.host; state.gatewayPort = event.settings.gatewayPort || 18765; state.project = event.settings.project; state.demo = event.demo; q('.chrome-end').textContent = state.host + ' · 远程工作区'; if (state.demo) { q('.chrome-title').append(make('span', 'demo-label', '示例预览')); hydrateDemo(); } icons(); renderThreads(); renderTranscript(); renderConversation(); if (event.showWhatsAppLink) whatsappLink?.open(); break;
      case 'runtimeState': state.remoteRuns[event.threadId] = event; if (event.threadId === state.active) renderControls(); break;
      case 'selectionUnavailable': state.active = null; state.loading = false; restoreCodexDraft(); renderThreads(); renderTranscript(); banner(event.message); break;
      case 'notificationPermission': state.notificationPermission = event.status; renderQuestionAlerts(); break;
      case 'focusQuestion': {
        if (!state.approvals.some(a => a.token === event.token)) { banner('这个问题已处理，请查看最新回复。'); break; }
        state.explicitQuestionFocus = { token: event.token, threadId: event.threadId };
        selectConversation(event.threadId); renderTranscript(); break;
      }
      case 'questionUnavailable': banner(event.message); break;
      case 'attachmentReply': { const pending = bridgeRequests.get(event.bridgeId); if (pending) { clearTimeout(pending.timer); bridgeRequests.delete(event.bridgeId); if (event.ok) pending.resolve(event.value); else pending.reject(new Error(event.message)); } break; }
      case 'attachmentProgress': { const draftKey = state.sendPending?.key === event.draftKey ? state.sendPending.threadId || event.draftKey : event.draftKey; const row = (state.attachments[draftKey] || []).find(file => file.id === event.id); if (row) Object.assign(row, event); if (event.path && event.thumbnail) state.remotePreviews[event.path] = event.thumbnail; if (key() === draftKey) renderAttachments(); break; }
      case 'connection': state.connected = event.status === 'connected'; if (!state.connected) { if (state.sendPending) { state.uncertainSend = true; state.sendPending = null; for (const rows of Object.values(state.attachments)) for (const row of rows) if (['uploading', 'uploaded'].includes(row.status)) row.status = 'ready'; } state.loading = false; state.access = {}; state.running = {}; state.historyLoading = {}; state.sync = {}; state.approvals = []; } state.host = event.host || state.host; state.project = event.project || state.project; q('.chrome-end').textContent = state.host + ' · 远程工作区'; q('.account').replaceChildren(icon('server'), make('span', '', state.host + (state.connected ? ' · 已连接' : ' · 未连接'))); renderThreads(); renderTranscript(); if (event.status === 'connecting') banner('正在通过 SSH 连接远端 Codex…'); else if (!state.connected) banner(event.message || '', event.status === 'error' ? [{ label: '重连', run: () => post('reconnect') }] : [], 'error'); break;
      case 'threads': if (event.projectId && workspaceNavigation?.currentProject() !== event.projectId) break; state.threads = uniqueThreads(event.append ? [...state.threads, ...(event.threads || [])] : event.threads || []); renderThreads(); renderControls(); break;
      case 'threadManaged': if (!event.projectId || event.projectId === workspaceNavigation?.currentProject()) { const i = state.threads.findIndex(t => t.id === event.thread.id); if (i < 0) state.threads.unshift(event.thread); else state.threads[i] = event.thread; renderThreads(); renderControls(); } break;
      case 'projectOpened': state.active = null; state.loading = false; state.host = event.host || state.host; state.project = event.project || state.project; restoreCodexDraft(); renderThreads(); renderTranscript(); renderConversation(); break;
      case 'loadingThread': state.loading = true; break;
      case 'historyLoading': state.historyLoading[event.threadId] = event.loading; if (event.threadId === state.active) renderTranscript(); break;
      case 'threadSync': state.sync[event.threadId] = event.status; if (event.threadId === state.active) renderControls(); break;
      case 'threadAccess': state.access[event.threadId] = event.mode; if (event.mode !== 'writable') delete state.running[event.threadId]; if (event.threadId === state.active) renderTranscript(); break;
      case 'sendBlocked': if (state.sendPending?.key === event.threadId) state.sendPending = null; if (event.threadId === state.active) renderTranscript(); break;
      case 'thread': { const old = key(); state.active = event.thread.id; if ((state.sendPending?.key === 'new' && !state.sendPending.threadId) || event.draftFrom === 'new') { state.drafts[state.active] = state.drafts.new; state.quotes[state.active] = state.quotes.new; state.attachments[state.active] = state.attachments.new || []; delete state.drafts.new; delete state.quotes.new; delete state.attachments.new; if (state.sendPending) state.sendPending.threadId = state.active; commands?.migrate('new', state.active); drafts?.codex('new'); drafts?.codex(state.active); } if (!state.threads.some(t => t.id === event.thread.id)) state.threads.unshift(event.thread); state.loading = false; if (old !== key()) restoreCodexDraft(); renderThreads(); renderTranscript(); break; }
      case 'history': { const incoming = event.items || [], old = state.items[event.threadId] || [], ids = new Set(incoming.map(i => i.id)); state.items[event.threadId] = event.prepend ? [...incoming, ...old.filter(i => !ids.has(i.id))] : [...incoming, ...old.filter(i => !ids.has(i.id) && liveItems.get(event.threadId)?.has(i.id))]; for (const id of ids) liveItems.get(event.threadId)?.delete(id); if (event.prepend) state.visibleCounts[event.threadId] = (state.visibleCounts[event.threadId] || 80) + Math.min(incoming.length, 60); state.cursors[event.threadId] = event.nextCursor; state.historyLoading[event.threadId] = false; if (event.threadId === state.active) { state.loading = false; renderTranscript(); } break; }
      case 'historyUpdate': {
        const items = state.items[event.threadId] ||= [], positions = new Map(items.map((item, index) => [item.id, index]));
        let appended = 0;
        for (const item of event.items || []) { const index = positions.get(item.id); if (index !== undefined) items[index] = item; else { positions.set(item.id, items.length); items.push(item); appended++; } }
        if (event.threadId === state.active) { const node = q('#cmsg-transcript'); if (node.scrollHeight - node.scrollTop - node.clientHeight >= 50) state.visibleCounts[event.threadId] = (state.visibleCounts[event.threadId] || 80) + appended; renderTranscript(); }
        break;
      }
      case 'item': if (event.item) updateItem(event.threadId, event.item); break;
      case 'reasoningSummary': {
        if (!Number.isInteger(event.summaryIndex) || event.summaryIndex < 0 || event.summaryIndex > 63 || !event.itemId) break;
        const old = (state.items[event.threadId] || []).find(item => item.id === event.itemId), summary = [...(old?.summary || [])];
        summary[event.summaryIndex] = ((summary[event.summaryIndex] || '') + (event.delta || '')).slice(0, 32000);
        updateItem(event.threadId, { id: event.itemId, type: 'reasoning', status: 'inProgress', summary }); break;
      }
      case 'delta': { const items = state.items[event.threadId] ||= [], index = items.findIndex(i => i.id === event.itemId), old = items[index] || { id: event.itemId, type: 'agentMessage', text: '' }, item = { ...old, text: (old.text || '') + event.delta }; if (index < 0) items.push(item); else items[index] = item; if (event.threadId === state.active) renderTranscript(); break; }
      case 'commandOutput': { const items = state.items[event.threadId] ||= [], index = items.findIndex(i => i.id === event.itemId), item = items[index] || {id:event.itemId,type:'commandExecution',status:'inProgress',startedAtMs:Date.now()}; const updated = { ...item, aggregatedOutput: (item.aggregatedOutput || '') + event.delta }; if (index < 0) items.push(updated); else items[index] = updated; if (event.threadId === state.active) renderTranscript(); break; }
      case 'turn': state.running[event.threadId] = state.access[event.threadId] === 'writable' && event.turn?.status === 'inProgress'; if (event.turn?.status !== 'inProgress') state.items[event.threadId] = (state.items[event.threadId] || []).map(item => item.type === 'reasoning' && item.status === 'inProgress' ? { ...item, status: 'completed' } : item); if (event.threadId === state.active) renderTranscript(); break;
      case 'sendAccepted': { const pending = state.sendPending; if (pending && (!event.requestId || pending.requestId === event.requestId)) { const sent = new Set(pending.attachmentIds || []), source = pending.threadId || pending.key; for (const draftKey of new Set([source, event.threadId])) { state.attachments[draftKey] = (state.attachments[draftKey] || []).filter(file => !sent.has(file.id)); if (state.drafts[draftKey] === pending.draft) delete state.drafts[draftKey]; if (state.quotes[draftKey] === pending.quote) delete state.quotes[draftKey]; drafts?.codex(draftKey); } if (key() === source || key() === event.threadId) restoreCodexDraft(); state.sendPending = null; } renderAttachments(); renderControls(); break; }
      case 'models': break;
      case 'approval': { const index = state.approvals.findIndex(a => a.token === event.token); if (index >= 0) state.approvals[index] = event; else { state.approvals.push(event); state.questionAttention = event.token; } renderThreads(); renderTranscript(); break; }
      case 'approvalAnswered': state.approvals = state.approvals.filter(a => a.token !== event.token); if (state.explicitQuestionFocus?.token === event.token) state.explicitQuestionFocus = null; renderThreads(); renderTranscript(); break;
      case 'gateway': state.gateway = event.connected; state.gatewayText = event.connected ? '当前平台尚未接入账号。请在远端配置消息连接。' : event.message; renderConversation(); break;
      case 'conversations': state.conversations = inbox ? inbox.decorate(event.conversations || []) : event.conversations || []; renderQuote(); for (const platform of ['whatsapp', 'telegram']) if (!state.conversations.some(c => c.id === state.selected[platform])) state.selected[platform] = state.conversations.find(c => c.platform === platform)?.id; inbox?.changed(); renderConversation(); if (current()) post('getMessages', { conversationId: current().id }); break;
      case 'messageVisibility': inbox?.visibility(event.active); break;
      case 'messages': { if (inbox && !inbox.loaded(event.conversationId, event.incomingCount)) break; state.messages[event.conversationId] = event.messages || []; const draft = event.drafts?.[0]; if (draft && !state.seenDrafts[draft.id] && !state.replyDrafts[event.conversationId]) { state.replyDrafts[event.conversationId] = draft.text; state.seenDrafts[draft.id] = true; drafts?.reply(event.conversationId); } if (current()?.id === event.conversationId) renderConversation(); break; }
      case 'gatewayEvent': if (current() && (event.event?.conversationId === current().id || event.event?.type === 'resyncRequired')) post('getMessages', { conversationId: current().id }); break;
      case 'messageSent': { const pending = state.pendingReply; if (pending?.idempotencyKey === event.idempotencyKey) pending.sending = false; if (pending?.idempotencyKey === event.idempotencyKey) { if (state.replyDrafts[event.conversationId] === (pending.draft ?? pending.text)) { state.replyDrafts[event.conversationId] = ''; drafts?.reply(event.conversationId); } cancelReply(); } renderConversation(); post('getMessages', { conversationId: event.conversationId }); break; }
      case 'error': if (event.action === 'sendMessage') { if (state.pendingReply?.idempotencyKey === event.requestId) { q('#cmsg-message-status').textContent = event.message; q('#cmsg-reply-send').disabled = false; } } else { if (event.action === 'send' && event.requestId && state.sendPending?.requestId !== event.requestId) break; if (event.action === 'send') { for (const row of state.attachments[state.sendPending?.threadId || state.sendPending?.key] || []) { if (['uploading', 'uploaded'].includes(row.status)) { row.status = 'ready'; row.message = row.path ? '已上传，可重试发送' : '可重试发送'; } } state.sendPending = null; renderAttachments(); renderControls(); } if (event.threadId) state.historyLoading[event.threadId] = false; if (event.threadId && event.threadId !== state.active) break; state.loading = false; state.sendPending = null; renderTranscript(); banner(event.message, [], 'error'); } break;
      default: break;
    }
    session?.receive(event);
    commands?.receive(event);
    remoteAccount?.receive(event);
    runState?.receive(event);
  }
  function hydrateDemo() {
    state.connected = true; state.gateway = true; state.gatewayText = ''; state.project = '/srv/projects/example-project'; state.threads = [{ id: 'demo', name: '修复登录后的状态切换' }]; state.active = 'demo'; state.access.demo = 'writable'; state.items.demo = [{ id: 'd1', type: 'userMessage', content: [{ type: 'text', text: '看下登录成功后，为什么偶尔仍停留在登录页。' }] }, { id: 'd2', type: 'agentMessage', text: '我会沿着登录回调和会话恢复检查，先定位触发条件。\n\n路由跳转发生在会话状态更新之前，可以先调整这两个操作的顺序。' }];
    state.conversations = [{ id: 'demo-wa-group', name: '产品协作群', type: 'group', platform: 'whatsapp', lastMessage: '是不是会话状态更新得太晚？' }, { id: 'demo-wa-lin', name: '小林', type: 'contact', platform: 'whatsapp', lastMessage: '报错截图晚点发你' }, { id: 'demo-tg-alex', name: 'Alex', type: 'contact', platform: 'telegram', lastMessage: '先别发布，等验证完成。' }, { id: 'demo-tg-group', name: '开发讨论', type: 'group', platform: 'telegram', lastMessage: '接口文档已更新' }];
    state.messages['demo-wa-group'] = [{ id: 'wm1', author: '小林', text: '登录成功后页面没跳转，但刷新就正常。', direction: 'incoming', timestamp: Date.now() }, { id: 'wm2', author: '阿周', text: '是不是会话状态更新得太晚？', direction: 'incoming', timestamp: Date.now() }];
    for (const c of state.conversations) state.messages[c.id] ||= [{ id: c.id + '-1', author: c.name, text: c.lastMessage, direction: 'incoming', timestamp: Date.now() }];
    state.selected = { whatsapp: 'demo-wa-group', telegram: 'demo-tg-alex' }; state.quotes.demo = { ...state.messages['demo-wa-group'][1], platform: 'whatsapp', conversation: '产品协作群' }; state.drafts.demo = '结合这条回复，检查登录状态更新和路由跳转的先后顺序。'; restoreCodexDraft();
  }
  function demoAction(action, data) { if (action === 'getMessages') renderConversation(); if (action === 'send') { state.items.demo.push({ id: 'demo-' + Date.now(), type: 'userMessage', content: [{ type: 'text', text: data.text }] }); receive({ type: 'sendAccepted', threadId: 'demo' }); renderTranscript(); } if (action === 'sendMessage') { state.messages[data.conversationId].push({ id: data.idempotencyKey, text: data.text, author: '你', direction: 'outgoing', timestamp: Date.now(), status: '示例发送' }); receive({ type: 'messageSent', conversationId: data.conversationId, idempotencyKey: data.idempotencyKey }); renderConversation(); } }
  // Replace presentation-only placeholders with functional controls and empty real data.
  const nav = q('#cmsg-navigation'); const bottom = q('.nav-bottom');
  q('.day-divider').hidden = true; q('.account').textContent = 'codex · 未连接';
  nav.replaceChildren();
  const newThread = make('button', 'nav-button cursor-interaction'); newThread.type = 'button'; newThread.append(icon('square-pen'), document.createTextNode('新对话')); newThread.onclick = () => { saveCodexDraft(); state.active = null; restoreCodexDraft(); renderThreads(); renderTranscript(); post('leaveThread'); };
  nav.append(newThread, make('div', 'nav-label', '项目')); const threads = make('div'); threads.id = 'app-thread-list'; nav.append(threads, bottom);
  const settings = q('.nav-bottom .nav-button'); settings.id = 'connection-settings'; settings.textContent = ''; settings.append(icon('settings-2'), document.createTextNode('连接设置')); settings.setAttribute('role', 'button'); settings.tabIndex = 0; settings.onclick = () => post('settings'); settings.onkeydown = e => { if (e.key === 'Enter') post('settings'); };
  const appBanner = make('div', 'app-banner'); appBanner.id = 'app-banner'; appBanner.hidden = true; q('.chat-header').after(appBanner);
  const questionAlerts = make('div', 'question-alerts'); questionAlerts.id = 'question-alerts'; questionAlerts.hidden = true; questionAlerts.setAttribute('aria-live', 'polite'); appBanner.after(questionAlerts);
  function renderQuestionAlerts() {
    if (!questionAlerts) return;
    const pending = state.approvals.filter(a => a.params.threadId !== state.active && a.ownerThreadId !== state.active);
    const denied = state.approvals.length && ['denied', 'error'].includes(state.notificationPermission);
    const nodes = pending.map(a => {
      const threadId = a.ownerThreadId || a.params.threadId, thread = state.threads.find(t => t.id === threadId);
      const button = make('button', 'question-alert cursor-interaction'); button.type = 'button'; button.dataset.token = a.token;
      button.append(icon('message-circle'), make('span', '', `${thread?.name || '其他会话'} · ${a.method.endsWith('requestUserInput') ? '等待你的回答' : '等待审批'}`), make('span', 'question-alert-open', '查看 →'));
      button.onclick = () => post('openQuestion', { token: a.token }); return button;
    });
    if (denied) {
      const hint = make('div', 'question-notification-hint', state.notificationPermission === 'denied' ? '系统通知未开启' : '系统通知暂不可用');
      const settings = make('button', 'small-button', '通知设置'); settings.type = 'button'; settings.onclick = () => post('notificationSettings'); hint.append(settings); nodes.push(hint);
    }
    questionAlerts.replaceChildren(...nodes); questionAlerts.hidden = !nodes.length; icons(questionAlerts);
  }
  const model = make('select', 'model-select'); model.id = 'app-model'; model.setAttribute('aria-label', '模型'); const defaultModel = make('option', '', '默认模型'); defaultModel.value = ''; model.append(defaultModel); q('.model').replaceChildren(model);
  const attachmentList = make('div', 'attachment-list'); attachmentList.id = 'attachment-list'; attachmentList.hidden = true;
  const attachmentStatus = make('div', 'attachment-status'); attachmentStatus.id = 'attachment-status'; attachmentStatus.hidden = true; attachmentStatus.setAttribute('role', 'status'); attachmentStatus.setAttribute('aria-live', 'polite'); q('#cmsg-input').before(attachmentList); q('#cmsg-input').after(attachmentStatus);
  const attachmentAction = make('div', 'attachment-action'), add = make('button', 'icon-button cursor-interaction'); add.id = 'attachment-add'; add.type = 'button'; add.setAttribute('aria-label', '添加图片或文件'); add.setAttribute('aria-expanded', 'false'); add.append(icon('plus'));
  const menu = make('div', 'attachment-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
  const fileInput = document.createElement('input'); fileInput.id = 'attachment-file-input'; fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true;
  for (const [label, accept, symbol] of [['添加图片', 'image/*', 'image'], ['添加文件', '', 'file-text']]) { const button = make('button', 'cursor-interaction'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.append(icon(symbol), document.createTextNode(label)); button.onclick = () => { menu.hidden = true; add.setAttribute('aria-expanded', 'false'); fileInput.accept = accept; fileInput.click(); }; menu.append(button); }
  add.onclick = () => { menu.hidden = !menu.hidden; add.setAttribute('aria-expanded', String(!menu.hidden)); }; fileInput.onchange = () => { addFiles(Array.from(fileInput.files || [])); fileInput.value = ''; };
  const projectFile = make('button', 'cursor-interaction'); projectFile.type = 'button'; projectFile.setAttribute('role', 'menuitem'); projectFile.append(icon('folder'), document.createTextNode('引用远端项目文件')); projectFile.onclick = () => { menu.hidden = true; add.setAttribute('aria-expanded', 'false'); const input = q('#cmsg-input'); input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + '@'; input.focus(); input.setSelectionRange(input.value.length, input.value.length); saveCodexDraft(); searchProjectFiles(); }; menu.append(projectFile);
  const projectPicker = make('div', 'project-file-picker'); projectPicker.id = 'project-file-picker'; projectPicker.hidden = true; projectPicker.setAttribute('role', 'listbox'); projectPicker.setAttribute('aria-label', '远端项目文件'); q('.composer').append(projectPicker);
  attachmentAction.append(add, menu, fileInput); q('.composer-footer > .icon').replaceWith(attachmentAction);
  root.addEventListener('pointerdown', event => { if (!attachmentAction.contains(event.target)) { menu.hidden = true; add.setAttribute('aria-expanded', 'false'); } });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.hidden = true; add.setAttribute('aria-expanded', 'false'); closeProjectPicker(); } });
  root.addEventListener('pointerdown', event => { if (!q('.composer').contains(event.target)) closeProjectPicker(); });
  const composer = q('.composer'); let dragDepth = 0;
  composer.addEventListener('dragenter', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); dragDepth++; composer.classList.add('is-file-drag'); } });
  composer.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  composer.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) composer.classList.remove('is-file-drag'); });
  composer.addEventListener('drop', event => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); event.stopPropagation(); dragDepth = 0; composer.classList.remove('is-file-drag'); addFiles(Array.from(event.dataTransfer.files)); });
  root.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); }); root.addEventListener('drop', event => { if (event.dataTransfer?.files.length) event.preventDefault(); });
  q('#cmsg-input').addEventListener('paste', event => { const files = Array.from(event.clipboardData?.files || []); if (files.length) { event.preventDefault(); addFiles(files); } });
  q('#cmsg-navigation-toggle').onclick = () => navigation(q('#cmsg-navigation').hidden); q('#cmsg-toggle').onclick = () => sidebar(q('#cmsg-sidebar').hidden); q('#cmsg-picker-toggle').onclick = () => picker(q('#cmsg-conversation-picker').hidden);
  root.addEventListener('pointerdown', e => { if (!q('#cmsg-switcher').contains(e.target)) picker(false); }); root.addEventListener('keydown', e => { if (e.key === 'Escape') picker(false); });
  root.querySelectorAll('[data-platform]').forEach(button => button.onclick = () => { saveReplyDraft(); state.platform = button.dataset.platform === 'wa' ? 'whatsapp' : 'telegram'; drafts?.preferences(); cancelReply(); picker(false); renderConversation(); if (current()) post('getMessages', { conversationId: current().id }); });
  q('#cmsg-remove').onclick = () => { delete state.quotes[key()]; drafts?.codex(key()); renderQuote(); renderControls(); };
  commands = window.RemoteCodexCommands({ root, state, q, make, icon, icons, key, request: attachmentRequest, saveDraft: () => saveCodexDraft(true), restoreDraft: restoreCodexDraft, controls: renderControls, send: sendCodexDraft, richText: pagedText, setFast: enabled => session.setFast(enabled), sessionValues: () => session.values() });
  q('#cmsg-input').title = '回车发送 · Ctrl＋回车换行';
  q('#cmsg-input').oninput = () => { saveCodexDraft(); searchProjectFiles(); commands.input(); renderControls(); };
  session = window.createSessionFeatures({ q, make, icon, icons, state, key, request: attachmentRequest, post, render: renderControls, selectThread: selectConversation, richText: pagedText, renderViewedImage: viewedImages.render });
  remoteAccount = window.RemoteCodexAccount({ root, make, icon, icons, state, request: attachmentRequest });
  runState = window.RemoteCodexRunState({ root, q, make, state, key, session });
  function sendCodexDraft() {
    const block = sendBlockReason(); if (block) { explainSendBlock(block); return; }
    if (commands.handleSend()) return;
    saveCodexDraft(); const draft = state.drafts[key()] || '', quote = state.quotes[key()], attachmentIds = attachmentRows().map(file => file.id); if (!draft.trim() && !quote && !attachmentIds.length) return;
    const shell = /^\s*!/.test(draft);
    if (shell && (quote || attachmentIds.length)) { attachmentNote('执行 ! 命令时请先移除引用和附件；草稿已保留。'); return; }
    if (shell && !draft.trimStart().slice(1).trim()) { attachmentNote('请在 ! 后输入远端命令，例如 ! ls'); return; }
    const quoted = quote ? `引用消息（来源资料，仅此一条）：\n平台：${platformName(quote.platform)}\n对话：${quote.conversation}\n作者：${quote.author || '你'}\n<quoted_message>\n${messageFormat.plain(quote.text, quote.platform)}\n</quoted_message>\n\n` : '';
    state.sendBlockNote = false; attachmentNote();
    const requestId = crypto.randomUUID(); state.sendPending = { key: key(), draft, quote, attachmentIds, requestId }; closeProjectPicker(); renderControls(); post(shell ? 'shellCommand' : 'send', { threadId: state.active, text: quoted + draft, ...session.values(), mode: commands.mode(), attachmentIds, requestId });
  }
  const sendButton = q('#cmsg-send-codex'), sendControl = make('span', 'send-control');
  sendButton.replaceWith(sendControl); sendControl.append(sendButton);
  sendHelp = make('button', 'send-help'); sendHelp.id = 'send-help'; sendHelp.type = 'button'; sendHelp.hidden = true; sendHelp.onclick = () => explainSendBlock(); sendControl.append(sendHelp);
  sendButton.onclick = () => {
    if (state.access[state.active] === 'writable' && state.running[state.active] && !hasCodexDraft()) { post('interrupt', { threadId: state.active }); return; }
    sendCodexDraft();
  };
  let composerComposing = false, compositionEndedAt = -Infinity;
  q('#cmsg-input').addEventListener('compositionstart', () => { composerComposing = true; });
  q('#cmsg-input').addEventListener('compositionend', () => { composerComposing = false; compositionEndedAt = performance.now(); });
  q('#cmsg-input').onkeydown = e => {
    if (e.isComposing || composerComposing || e.keyCode === 229 || (e.key === 'Enter' && performance.now() - compositionEndedAt < 80)) return;
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault(); const input = q('#cmsg-input'); input.focus({ preventScroll: true });
      if (!document.execCommand('insertText', false, '\n')) { input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }
      return;
    }
    if (commands.handleKey(e)) return;
    if (!projectPicker.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeProjectPicker(); return; }
      if (projectOptions.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); projectChoice = (projectChoice + (e.key === 'ArrowDown' ? 1 : projectOptions.length - 1)) % projectOptions.length; projectOptions.forEach((button, i) => button.setAttribute('aria-selected', String(i === projectChoice))); projectOptions[projectChoice].scrollIntoView({ block: 'nearest' }); return; }
      if (projectOptions.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey))) { e.preventDefault(); projectOptions[projectChoice].click(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); sendCodexDraft(); }
  };
  q('#cmsg-reply').oninput = saveReplyDraft;
  q('#cmsg-reply-cancel').onclick = () => { if (!state.pendingReply?.sending) { cancelReply(); messageMedia?.renderDraft(); } };
  asyncQuestions = window.RemoteCodexAsyncQuestions({ state, make, request: attachmentRequest, selection: () => ({ platform: state.platform, conversationId: current()?.id || null }), changed: renderControls });
  whatsappLink = window.RemoteCodexWhatsAppLink({ root, q, make, state, request: attachmentRequest, post });
  messageMedia = window.RemoteCodexMessageMedia({ state, root, q, make, icon, request: attachmentRequest, post, current, key, drafts: () => drafts, quoteMessage, renderAttachments, renderControls, renderConversation, cancelReply });
  appearance = window.RemoteCodexAppearance({ root, make });
  inbox = window.RemoteCodexInbox({ root, state, q, make, icon, icons, format: (text, platform) => messageFormat.plain(text, platform), choose: id => { saveReplyDraft(); state.selected[state.platform] = id; drafts?.preferences(); cancelReply(); picker(false); renderConversation(); post('getMessages', { conversationId: id }); } });
  sidebar(localStorage.getItem('messagesOpen') !== 'false'); navigation(localStorage.getItem('navigationOpen') !== 'false'); renderThreads(); renderTranscript(); renderConversation();
  window.RemoteCodexSplitLayout(root);
  workspaceNavigation = window.RemoteCodexProjects({ root, state, q, make, icon, icons, request: attachmentRequest, selectThread: selectConversation, flush: () => window.RemoteCodex.flushDrafts(), controls: renderControls });
  drafts = window.RemoteCodexDrafts({ state, request: attachmentRequest, restored: () => { restoreCodexDraft(); renderThreads(); renderTranscript(); renderConversation(); }, failed: attachmentNote });
  window.RemoteCodex = { receive, flushDrafts: () => { if (state.draftsReady !== false) { saveCodexDraft(); saveReplyDraft(); } return drafts.flush(); } };
})();
