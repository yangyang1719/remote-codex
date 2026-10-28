'use strict';
window.RemoteCodexInbox = ({ root, state, q, make, icon, icons, post, choose, format }) => {
  let scope = '', seen = {}, initialized = false, openIDs = [], openPlatform = '';
  const loadedCounts = new Map(), rows = new Map();
  const picker = q('#cmsg-conversation-picker'), options = q('#cmsg-conversation-options'), feed = q('#cmsg-feed');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const time = c => Number(c.lastMessageAt ?? c.updatedAt) || 0;
  const unread = c => Math.max(0, count(c.incomingCount) !== null ? c.incomingCount - (seen[c.id] ?? c.incomingCount) : count(c.unread) || 0);
  const save = () => { try { localStorage.setItem(scope, JSON.stringify({ version: 1, initialized, seen })); } catch {} };
  function context() {
    const key = 'remoteCodex.inbox:' + state.host + ':' + (state.gatewayPort || 18765);
    if (scope === key) return;
    open(false); scope = key; seen = {}; initialized = false; loadedCounts.clear();
    try { const stored = JSON.parse(localStorage.getItem(scope)); if (stored?.version === 1) { initialized = stored.initialized === true; for (const [id, value] of Object.entries(stored.seen || {})) if (count(value) !== null) seen[id] = value; } } catch {}
  }
  function sorted() {
    return state.conversations.filter(c => c.platform === state.platform).map((c, index) => ({ c, index })).sort((a, b) =>
      Number(b.c.unread > 0) - Number(a.c.unread > 0) ||
      Number((b.c.messageCount ?? (b.c.lastMessage ? 1 : 0)) > 0) - Number((a.c.messageCount ?? (a.c.lastMessage ? 1 : 0)) > 0) ||
      time(b.c) - time(a.c) || a.index - b.index).map(row => row.c);
  }
  function badge(node, value) { node.textContent = value > 99 ? '99+' : String(value); node.hidden = !value; node.setAttribute('aria-label', value + ' 条未读消息'); }
  function badges() {
    badge(q('#cmsg-toggle .unread'), state.conversations.reduce((n, c) => n + (c.unread || 0), 0));
    root.querySelectorAll('[data-platform]').forEach(button => {
      const pill = button.querySelector('.unread');
      if (pill) badge(pill, state.conversations.filter(c => c.platform === (button.dataset.platform === 'wa' ? 'whatsapp' : 'telegram')).reduce((n, c) => n + (c.unread || 0), 0));
    });
  }
  function patch() {
    if (picker.hidden) return;
    const conversations = new Map(state.conversations.filter(c => c.platform === openPlatform).map(c => [c.id, c]));
    // During this open, existing rows never move. New conversations append at the end.
    for (const id of conversations.keys()) if (!openIDs.includes(id)) openIDs.push(id);
    for (const id of openIDs) {
      const c = conversations.get(id); if (!c) continue;
      let row = rows.get(id);
      if (!row) {
        row = make('button', 'conversation-option cursor-interaction'); row.type = 'button'; row.dataset.conversationId = id;
        const avatar = make('span', 'option-avatar'); avatar.append(icon(c.type === 'group' ? 'users' : 'user-round'));
        const copy = make('span', 'option-copy'); copy.append(make('div', 'option-name'), make('div', 'option-preview'));
        const tail = make('span', 'option-tail'); tail.append(make('time', 'option-time'), make('span', 'conversation-unread'));
        const selected = icon('check'); selected.classList.add('option-check');
        row.append(avatar, copy, tail, selected); row.onclick = () => { choose(id); };
        rows.set(id, row); options.append(row);
      }
      row.querySelector('.option-name').textContent = c.name;
      row.hidden = false;
      row.querySelector('.option-preview').textContent = format(c.lastMessage, c.platform) || (c.type === 'group' ? '群聊' : '联系人');
      const date = new Date(time(c)); row.querySelector('.option-time').textContent = time(c) ? (date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })) : '';
      badge(row.querySelector('.conversation-unread'), c.unread || 0);
      const selected = c.id === state.selected[state.platform]; row.setAttribute('aria-pressed', String(selected)); row.querySelector('.option-check').hidden = !selected;
      row.classList.toggle('has-unread', c.unread > 0); row.setAttribute('aria-label', c.name + '，' + (c.type === 'group' ? '群聊' : '联系人') + (c.unread ? '，' + c.unread + ' 条未读消息' : ''));
    }
    for (const [id, row] of rows) if (!conversations.has(id)) row.hidden = true;
    icons();
  }
  function open(value) {
    picker.hidden = !value; q('#cmsg-picker-toggle').setAttribute('aria-expanded', String(value));
    if (!value) { openIDs = []; rows.clear(); return; }
    openPlatform = state.platform; openIDs = sorted().map(c => c.id); rows.clear(); options.replaceChildren(); options.scrollTop = 0;
    if (!openIDs.length) options.append(make('div', 'picker-title', '当前平台暂无对话'));
    else options.append(make('div', 'picker-title', '未读优先 · 最新消息在前'));
    patch();
  }
  function decorate(values) {
    context();
    const baseline = !initialized;
    for (const c of values) {
      if (count(c.incomingCount) !== null && seen[c.id] === undefined) seen[c.id] = baseline ? c.incomingCount : 0;
    }
    if (values.some(c => count(c.incomingCount) !== null)) initialized = true;
    save();
    return values.map(c => ({ ...c, unread: unread(c) }));
  }
  function viewed() {
    const c = state.conversations.find(c => c.id === state.selected[state.platform]);
    if (!c || picker.hidden === false || q('#cmsg-sidebar').hidden || state.messageAppActive !== true || root.querySelector('dialog[open]') || feed.scrollHeight - feed.scrollTop - feed.clientHeight > 32) return;
    const through = loadedCounts.get(c.id); if (count(through) === null || (seen[c.id] ?? 0) >= through) return;
    seen[c.id] = through; save();
    state.conversations.forEach(row => { row.unread = unread(row); }); badges(); patch();
  }
  feed.addEventListener('scroll', viewed, { passive: true }); window.addEventListener('focus', () => setTimeout(viewed, 0)); document.addEventListener('visibilitychange', viewed);
  return { open, badges, viewed, changed: () => { badges(); patch(); }, decorate,
    loaded(id, value) { if (count(value) === null) return true; if ((loadedCounts.get(id) ?? -1) > value) return false; loadedCounts.set(id, value); return true; },
    visibility(active) { state.messageAppActive = active === true; viewed(); }
  };
};
