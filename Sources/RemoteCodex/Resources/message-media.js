'use strict';
window.RemoteCodexMessageMedia = ({ state, root, q, make, icon, request, post, current, key, drafts, quoteMessage, renderAttachments, renderControls, renderConversation, cancelReply }) => {
  state.replyAttachments ||= {};
  const cards = new Map(); let queue = Promise.resolve();
  const note = text => { q('#cmsg-message-status').textContent = text || ''; };
  const context = (message, conversation) => ({ mediaId: message.media.id, conversationId: conversation.id });
  const size = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil((n || 0) / 1024) + ' KB';
  const button = (text, action) => { const b = make('button', 'message-media-action cursor-interaction', text); b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { note(e.message); } finally { b.disabled = false; } }; return b; };
  function card(message, conversation) {
    const media = message.media;
    if (!media) {
      if (/^\[(图片|文件|视频|语音|贴纸)\]/.test(message.text || '')) return make('div', 'message-media-legacy', '旧记录未保存附件内容，需从手机重新发送。');
      return null;
    }
    const cardKey = [state.host, state.draftScope, conversation.id, message.id, media.id, message.status].join(':');
    if (cards.has(cardKey)) return cards.get(cardKey);
    const node = make('div', 'message-media'); node.dataset.kind = media.kind; node.dataset.mediaId = media.id;
    node.append(make('div', 'message-media-name', media.name || '附件'), make('div', 'message-media-meta', `${media.kind === 'audio' ? '音频' : media.kind === 'video' ? '视频' : media.kind === 'image' ? '图片' : '文件'} · ${size(media.size)}`));
    if (!media.available || message.status === 'deleted') { node.append(make('div', 'message-media-meta', media.reason || '媒体已失效')); return node; }
    const view = make('div', 'message-media-view'), actions = make('div', 'message-media-actions'); node.append(view, actions);
    const load = button(media.kind === 'audio' || media.kind === 'video' ? '加载并播放' : media.kind === 'image' ? '加载图片' : '预览文件', async () => {
      note('正在下载附件…');
      const result = await request('messageMediaLoad', context(message, conversation)); note(''); view.replaceChildren();
      if (media.kind === 'image' && result.thumbnail) { const img = make('img', 'message-media-image'); img.src = result.thumbnail; img.alt = media.name; img.onclick = () => request('messageMediaPreview', context(message, conversation)).catch(e => note(e.message)); view.append(img); }
      else if (media.kind === 'audio' || media.kind === 'video') {
        const player = make(media.kind); player.controls = true; player.preload = 'metadata'; player.src = result.url;
        player.onerror = () => note('此格式无法内嵌播放，可点“系统预览”播放或保存文件。');
        view.append(player); player.play().catch(() => {});
      } else await request('messageMediaPreview', context(message, conversation));
      load.textContent = '重新加载';
    });
    actions.append(load, button('系统预览', () => request('messageMediaPreview', context(message, conversation))), button('保存…', () => request('messageMediaSave', context(message, conversation))));
    cards.set(cardKey, node); if (cards.size > 500) { const first = cards.keys().next().value; if (!cards.get(first).isConnected) cards.delete(first); }
    return node;
  }
  async function quote(message, conversation) {
    const draft = key(), scope = state.draftScope;
    if (!message.media) { quoteMessage(message, conversation); return; }
    if ((state.attachments[draft] || []).length >= 10) { note('每条 Codex 消息最多 10 个附件。'); return; }
    note('正在准备引用的附件…');
    try {
      const result = await request('messageMediaQuote', { ...context(message, conversation), draftKey: draft, draftScope: scope });
      if (key() !== draft || state.draftScope !== scope) { post('attachmentRemove', { id: result.attachment.id }); throw new Error('Codex 会话已切换，请重新引用。'); }
      (state.attachments[draft] ||= []).push(result.attachment); quoteMessage(message, conversation); drafts().codex(draft);
      renderAttachments(); renderControls(); note('附件已加入 Codex 草稿，点击发送后才交给 Codex。');
    } catch (error) { note(error.message); }
  }
  const fileInput = make('input'); fileInput.type = 'file'; fileInput.id = 'message-file-input'; fileInput.hidden = true; root.append(fileInput);
  const add = make('button', 'message-add cursor-interaction'); add.type = 'button'; add.id = 'message-attachment-add'; add.title = '添加图片、文件、视频或音频'; add.append(icon('plus'));
  add.onclick = () => { const c = current(); if (c?.platform === 'whatsapp' && !state.pendingReply?.sending) fileInput.click(); };
  q('.reply-footer').prepend(add);
  const draftList = make('div', 'message-draft-attachments'); draftList.id = 'message-draft-attachments'; q('.reply-box').prepend(draftList);
  const accountHint = make('div', 'message-account-status'); accountHint.hidden = true; q('.conversation-switcher').after(accountHint);
  const rows = cid => state.replyAttachments[cid] || [];
  async function addFile(file, conversation = current()) {
    if (!file || !conversation || conversation.platform !== 'whatsapp') return;
    const cid = conversation.id, scope = state.draftScope;
    if (rows(cid).length || state.pendingReply?.sending) { note('每条回复可添加一个附件，发送后可继续添加。'); return; }
    const row = { id: crypto.randomUUID(), name: file.name || '图片.png', size: file.size, status: 'adding' };
    (state.replyAttachments[cid] ||= []).push(row); renderDraft();
    queue = queue.then(async () => {
      try {
        if (file.size > 25 * 1024 * 1024 || !file.size) throw new Error('请选择 25 MB 以内的非空文件。');
        await request('attachmentBegin', { id: row.id, draftScope: scope, draftKey: 'message', conversationId: cid, name: row.name, size: file.size });
        for (let offset = 0; offset < file.size; offset += 65536) {
          if (row.cancelled) return;
          const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer()); let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          await request('attachmentChunk', { id: row.id, offset, data: btoa(binary) });
        }
        if (row.cancelled) return;
        Object.assign(row, await request('attachmentFinish', { id: row.id }));
      } catch (error) { row.status = 'error'; row.message = error.message; post('attachmentRemove', { id: row.id }); }
      finally { if (row.cancelled) post('attachmentRemove', { id: row.id }); drafts()?.reply(cid, scope); renderDraft(); }
    });
    return queue;
  }
  fileInput.onchange = () => { addFile(fileInput.files[0]); fileInput.value = ''; };
  q('.reply-box').ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  q('.reply-box').ondrop = e => { e.preventDefault(); e.stopPropagation(); addFile(e.dataTransfer.files[0]); };
  q('#cmsg-reply').addEventListener('paste', e => { const file = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file')?.getAsFile(); if (file) { e.preventDefault(); addFile(file); } });
  function renderDraft() {
    const c = current(); draftList.replaceChildren();
    for (const row of c ? rows(c.id) : []) {
      const line = make('div', 'message-draft-file'); line.append(make('span', '', row.name + (row.status === 'adding' ? ' · 添加中…' : row.status === 'error' ? ' · ' + row.message : ' · ' + size(row.size))));
      const remove = button('移除', () => { row.cancelled = true; state.replyAttachments[c.id] = rows(c.id).filter(f => f !== row); post('attachmentRemove', { id: row.id }); drafts()?.reply(c.id); renderDraft(); });
      remove.disabled = !!state.pendingReply?.sending; line.append(remove); draftList.append(line);
    }
    add.disabled = !c || c.platform !== 'whatsapp' || rows(c.id).length > 0 || !!state.pendingReply?.sending;
    q('#cmsg-reply-preview').disabled = !c || c.platform !== 'whatsapp' || !state.gateway || !!state.pendingReply?.sending;
  }
  function sendDirect() {
    const c = current(), text = q('#cmsg-reply').value.trim(), attachments = c ? rows(c.id) : [];
    if (!c || c.platform !== 'whatsapp' || !state.gateway) { note('请先连接当前消息平台。'); return; }
    if (!c || (!text && !attachments.length) || attachments.some(f => f.status !== 'ready')) { note('请等待附件添加完成，或移除失败的附件。'); return; }
    if (state.pendingReply?.sending) return;
    state.replyDrafts[c.id] = q('#cmsg-reply').value; drafts()?.reply(c.id);
    const ids = attachments.map(f => f.id), pending = state.pendingReply;
    if (!pending || pending.conversationId !== c.id || pending.text !== text || JSON.stringify(pending.attachmentIds || []) !== JSON.stringify(ids)) state.pendingReply = { conversationId: c.id, text, draft: q('#cmsg-reply').value, attachmentIds: ids, draftScope: state.draftScope, idempotencyKey: crypto.randomUUID() };
    const outgoing = state.pendingReply;
    outgoing.sending = true; q('#cmsg-confirm').hidden = true; renderDraft(); note('正在发送…'); post('sendMessage', outgoing);
  }
  q('#cmsg-reply-preview').onclick = sendDirect;
  q('#cmsg-reply-preview').setAttribute('aria-label', '发送消息');
  let composing = false, ended = -Infinity;
  q('#cmsg-reply').addEventListener('compositionstart', () => { composing = true; });
  q('#cmsg-reply').addEventListener('compositionend', () => { composing = false; ended = performance.now(); });
  q('#cmsg-reply').onkeydown = event => {
    if (event.isComposing || composing || event.keyCode === 229 || (event.key === 'Enter' && performance.now() - ended < 80)) return;
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault(); const input = q('#cmsg-reply'); input.focus({ preventScroll: true });
      if (!document.execCommand('insertText', false, '\n')) { input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) { event.preventDefault(); sendDirect(); }
  };
  function receive(event) {
    const provider = event.type === 'gateway' ? event.providers?.find(p => p.platform === 'whatsapp') : event.type === 'gatewayEvent' && event.event?.type === 'providerStatus' && event.event.platform === 'whatsapp' ? event.event : null;
    if (provider) {
      accountHint.hidden = provider.status === 'connected';
      accountHint.textContent = ['needs_relink', 'logged_out', 'idle', 'standby'].includes(provider.status) ? 'WhatsApp 设备尚未连接，重新关联后可收发。' : 'WhatsApp 连接状态：' + provider.status;
    }
    if (event.type === 'messageSent' && state.pendingReply?.idempotencyKey === event.idempotencyKey) {
      const p = state.pendingReply;
      state.replyAttachments[event.conversationId] = rows(event.conversationId).filter(f => !(p.attachmentIds || []).includes(f.id));
      drafts()?.reply(event.conversationId);
      q('#cmsg-reply-cancel').disabled = false;
    }
    if (event.type === 'error' && event.action === 'sendMessage' && state.pendingReply?.idempotencyKey === event.requestId) { state.pendingReply.sending = false; renderDraft(); }
    if (event.type === 'draftSnapshot' || event.type === 'conversations' || event.type === 'gateway') renderDraft();
  }
  return { card, quote, renderDraft, receive, addFile };
};
