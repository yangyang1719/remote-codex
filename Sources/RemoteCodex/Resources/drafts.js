'use strict';
window.RemoteCodexDrafts = ({ state, request, restored, failed }) => {
  const dirty = new Map(), desired = new Map(), saved = new Map(), contexts = new Map(), initialized = new Set();
  let timer, chain = Promise.resolve();
  const fields = ['drafts', 'quotes', 'attachments', 'replyDrafts', 'replyAttachments', 'selected', 'platform', 'draftModes'];
  const address = (scope, kind, key) => JSON.stringify([scope, kind, key]);
  function remember(kind, key, value, scope = state.draftScope) {
    if (!scope || state.demo) return;
    const id = address(scope, kind, key), signature = JSON.stringify(value);
    desired.set(id, signature);
    if (saved.get(id) === signature) return;
    dirty.set(id, { scope, kind, key, value: JSON.parse(signature), signature });
    clearTimeout(timer); timer = setTimeout(flush, 180);
  }
  function codex(key, scope = state.draftScope) {
    const source = scope === state.draftScope ? state : contexts.get(scope);
    if (!source) return;
    remember('codex', key, { text: source.drafts[key] || '', quote: source.quotes[key] || null,
      attachmentIds: (source.attachments[key] || []).filter(f => ['ready', 'uploading', 'uploaded'].includes(f.status) && !f.cancelled).map(f => f.id), mode: source.draftModes?.[key] || 'default' }, scope);
  }
  function reply(key, scope = state.draftScope) { const source = scope === state.draftScope ? state : contexts.get(scope); if (key && source) remember('reply', key, { text: source.replyDrafts[key] || '', attachmentIds: (source.replyAttachments?.[key] || []).filter(f => f.status === 'ready' && !f.cancelled).map(f => f.id) }, scope); }
  function preferences() { remember('preferences', 'messages', { platform: state.platform, selected: state.selected }); }
  function flush() {
    clearTimeout(timer);
    const batch = [...dirty]; dirty.clear();
    chain = chain.then(async () => {
      for (const [id, value] of batch) {
        if (desired.get(id) !== value.signature) continue;
        try {
          await request('draftSave', { draftScope: value.scope, kind: value.kind, key: value.key, value: value.value });
          saved.set(id, value.signature);
        } catch (error) {
          if (desired.get(id) !== value.signature) continue;
          if (!dirty.has(id)) dirty.set(id, value);
          failed('草稿暂未保存：' + error.message);
        }
      }
    });
    return chain;
  }
  function prepare(scope) { if (scope && !state.draftScope) { state.draftScope = scope; state.draftsReady = false; } }
  function receive(event) {
    if (event.type !== 'draftSnapshot') return;
    const scope = event.scope, changed = state.draftScope && state.draftScope !== scope;
    if (changed) {
      flush(); contexts.set(state.draftScope, Object.fromEntries(fields.map(key => [key, state[key]])));
      const cached = contexts.get(scope) || { drafts: {}, quotes: {}, attachments: {}, replyDrafts: {}, replyAttachments: {}, selected: {}, platform: 'whatsapp', draftModes: {} };
      Object.assign(state, cached); state.active = null; state.threads = []; state.items = {}; state.cursors = {};
    }
    state.draftScope = scope; state.draftsReady = true;
    if (!initialized.has(scope)) {
      for (const [record, value] of Object.entries(event.records || {})) {
        const separator = record.indexOf(':'), kind = record.slice(0, separator), key = record.slice(separator + 1);
        if (desired.has(address(scope, kind, key))) continue;
        if (kind === 'codex') {
          state.drafts[key] = value.text || ''; (state.draftModes ||= {})[key] = value.mode || 'default'; if (value.quote) state.quotes[key] = value.quote; state.attachments[key] = value.attachments || [];
          saved.set(address(scope, kind, key), JSON.stringify({ text: state.drafts[key], quote: state.quotes[key] || null, attachmentIds: state.attachments[key].filter(f => f.status === 'ready').map(f => f.id), mode: state.draftModes[key] }));
        }
        if (kind === 'reply') { state.replyDrafts[key] = value.text || ''; (state.replyAttachments ||= {})[key] = value.attachments || []; saved.set(address(scope, kind, key), JSON.stringify({ text: state.replyDrafts[key], attachmentIds: state.replyAttachments[key].filter(f => f.status === 'ready').map(f => f.id) })); }
        if (kind === 'preferences') { state.platform = value.platform || 'whatsapp'; state.selected = value.selected || {}; saved.set(address(scope, kind, key), JSON.stringify({ platform: state.platform, selected: state.selected })); }
      }
      initialized.add(scope);
    }
    restored();
    if (event.warnings?.length) failed('部分附件未能恢复，请检查附件卡片。');
  }
  return { codex, reply, preferences, flush, prepare, receive };
};
