'use strict';
window.RemoteCodexTelegramLink = ({ root, q, make, state, request, post }) => {
  const button = make('button', 'whatsapp-link-open cursor-interaction', 'Telegram 登录与忽略名单');
  button.type = 'button'; q('.platforms').after(button);
  let dialog, status, qr, phone, code, password, ignored, timer, generation = 0, busy = false, lastStatus = '';
  const labels = { standby: '尚未登录', connected: '已连接', awaiting_qr_scan: '请用手机 Telegram → 设置 → 设备 → 关联桌面设备扫码', awaiting_code: '请输入 Telegram 发送的验证码', awaiting_password: '请输入两步验证密码', qr_expired: '二维码已过期，请重新生成', auth_failed: '登录失败，请重新开始', disconnected: '连接已断开' };
  function render(value, loadIgnored = false) {
    status.textContent = labels[value.status] || value.status || '正在连接…';
    qr.replaceChildren();
    if (value.status === 'awaiting_qr_scan' && value.qrImage) {
      const image = make('img', 'whatsapp-link-qr'); image.alt = 'Telegram 登录二维码';
      image.src = 'data:image/svg+xml;base64,' + value.qrImage; qr.append(image);
    }
    code.hidden = value.status !== 'awaiting_code'; password.hidden = value.status !== 'awaiting_password';
    dialog.querySelector('[data-action="signIn"]').hidden = code.hidden;
    dialog.querySelector('[data-action="password"]').hidden = password.hidden;
    if (loadIgnored) ignored.value = (value.ignoredConversationIds || []).join('\n');
    if (value.status === 'connected') { phone.value = code.value = password.value = ''; if (lastStatus !== 'connected') post('listConversations'); }
    lastStatus = value.status;
  }
  async function poll(token) {
    if (!dialog?.open || token !== generation) return;
    if (!busy) {
      try { const value = await request('telegramStatus', {}); if (dialog.open && token === generation && !busy) render(value); }
      catch (error) { if (dialog.open && token === generation) status.textContent = error.message; }
    }
    if (dialog.open && token === generation) timer = setTimeout(() => poll(token), 2500);
  }
  async function call(method) {
    if (busy) return;
    const token = generation;
    const params = method === 'sendCode' ? { phone: phone.value.replace(/[ ()-]/g, '') } : method === 'signIn' ? { code: code.value.trim() } : method === 'password' ? { password: password.value } : method === 'setIgnored' ? { ids: ignored.value.split(/[\s,，]+/).filter(Boolean) } : {};
    busy = true; dialog.querySelectorAll('button,input,textarea').forEach(el => el.disabled = true);
    try {
      const value = await request('telegramCall', { method, params });
      if (dialog.open && token === generation) { render(value, method === 'setIgnored'); if (method === 'setIgnored') status.textContent = '忽略名单已保存，立即生效。'; }
    } catch (error) { if (dialog.open && token === generation) status.textContent = error.message; }
    finally { code.value = password.value = ''; busy = false; dialog.querySelectorAll('button,input,textarea').forEach(el => el.disabled = false); }
  }
  function create() {
    dialog = make('dialog', 'workspace-dialog whatsapp-link-dialog'); dialog.id = 'telegram-link-dialog';
    dialog.append(make('h3', '', 'Telegram 登录与忽略名单'), make('p', 'workspace-dialog-note', '登录资料保存在远端。关闭窗口不会退出账号，验证码和密码不保存为草稿。'));
    status = make('div', 'whatsapp-link-status'); status.setAttribute('role', 'status'); qr = make('div');
    function input(type, label) { const el = make('input'); el.type = type; el.placeholder = label; el.setAttribute('aria-label', label); el.autocomplete = 'off'; dialog.append(el); return el; }
    phone = input('tel', '手机号，含国家区号，例如 +8613800138000');
    code = input('text', '登录验证码'); code.inputMode = 'numeric';
    password = input('password', '两步验证密码');
    const actions = make('div', 'workspace-dialog-actions');
    for (const [method, label] of [['startQR', '生成二维码'], ['sendCode', '获取验证码'], ['signIn', '提交验证码'], ['password', '提交密码']]) {
      const el = make('button', 'cursor-interaction', label); el.type = 'button'; el.dataset.action = method; el.onclick = () => call(method); actions.append(el);
    }
    dialog.append(actions, status, qr, make('h3', '', '忽略的聊天 ID'));
    ignored = make('textarea'); ignored.rows = 4; ignored.placeholder = '每行一个聊天 ID，例如 -1001234567890'; ignored.setAttribute('aria-label', '忽略的 Telegram 聊天 ID');
    dialog.append(ignored, make('p', 'workspace-dialog-note', '停止保存这些聊天的新消息和下载媒体，保留已有记录。移出后恢复后续同步，不补忽略期间历史。'));
    const save = make('button', 'cursor-interaction', '保存忽略名单'); save.type = 'button'; save.onclick = () => call('setIgnored'); dialog.append(save);
    const list = make('div'); dialog.append(list);
    dialog.refreshIDs = () => { list.replaceChildren(); for (const c of state.conversations.filter(c => c.platform === 'telegram')) list.append(make('div', '', c.name + '：' + c.externalId)); };
    const close = make('button', 'cursor-interaction', '关闭'); close.type = 'button'; close.onclick = () => dialog.close(); dialog.append(close);
    dialog.addEventListener('close', () => { generation++; clearTimeout(timer); phone.value = code.value = password.value = ''; qr.replaceChildren(); });
    root.append(dialog);
  }
  button.onclick = async () => {
    if (!dialog) create(); if (dialog.open) return;
    dialog.showModal(); dialog.refreshIDs(); code.hidden = password.hidden = true;
    const token = ++generation;
    try { const value = await request('telegramStatus', {}); if (dialog.open && token === generation) render(value, true); }
    catch (error) { if (dialog.open && token === generation) status.textContent = error.message; }
    if (dialog.open && token === generation) timer = setTimeout(() => poll(token), 2500);
  };
};
