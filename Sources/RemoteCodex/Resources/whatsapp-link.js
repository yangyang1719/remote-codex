'use strict';
window.RemoteCodexWhatsAppLink = ({ root, q, make, state, request, post }) => {
  const openButton = make('button', 'whatsapp-link-open cursor-interaction', '关联 WhatsApp'); openButton.type = 'button'; openButton.id = 'whatsapp-link-open';
  q('.platforms').after(openButton);
  let dialog, timer, generation = 0, busy = false, mode = 'qr', status, phone, result, start, close, tabs;
  const labels = { idle: '尚未关联', standby: '尚未关联', connected: '已连接', connecting: '正在连接…', awaiting_qr_scan: '请用手机扫描二维码', awaiting_pairing_code: '请在手机中输入配对码', pairing_socket_ready: '正在准备配对码…', logged_out: '设备已登出，可重新关联', disconnected: '连接已断开，可重新关联', restarting: '正在完成关联…', credential_save_failed: '远端登录资料保存失败，请检查服务' };
  function clearChallenge() { result?.replaceChildren(); }
  function render(value) {
    if (!dialog?.open) return;
    status.textContent = labels[value.status] || value.status || '正在检查连接…';
    const connected = value.status === 'connected'; openButton.textContent = connected ? 'WhatsApp 已连接' : '关联 WhatsApp';
    start.hidden = connected; phone.hidden = connected || mode !== 'phone'; tabs.hidden = connected;
    result.replaceChildren();
    if (mode === 'qr' && value.qrImage && value.status === 'awaiting_qr_scan') { const img = make('img', 'whatsapp-link-qr'); img.alt = 'WhatsApp 设备关联二维码'; img.src = 'data:image/svg+xml;base64,' + value.qrImage; result.append(img); }
    if (mode === 'phone' && value.pairingCode && value.status === 'awaiting_pairing_code') { result.append(make('div', 'whatsapp-pairing-code', value.pairingCode)); result.append(make('p', '', '在手机 WhatsApp → 已关联设备 → 关联设备 → 改用电话号码关联，输入上面的配对码。')); }
    if (connected) { phone.value = ''; result.append(make('p', '', '关联完成，可以收取消息和发送附件。')); post('listConversations'); }
  }
  async function poll(token) {
    if (!dialog?.open || token !== generation) return;
    if (!busy) {
      try { const value = await request('whatsappLinkStatus', {}); if (dialog.open && token === generation && !busy) { render(value); if (value.status === 'connected') return; } }
      catch (error) { if (dialog.open && token === generation) status.textContent = error.message; }
    }
    if (dialog?.open && token === generation) timer = setTimeout(() => poll(token), 2000);
  }
  function create() {
    dialog = make('dialog', 'workspace-dialog whatsapp-link-dialog'); dialog.id = 'whatsapp-link-dialog';
    dialog.append(make('h3', '', '关联 WhatsApp'));
    dialog.append(make('p', 'workspace-dialog-note', '登录资料只保存在远端。重新关联会先备份旧设备登录资料；关闭此窗口不会退出账号。'));
    tabs = make('div', 'whatsapp-link-tabs');
    for (const [id, text] of [['qr', '扫描二维码'], ['phone', '电话号码关联']]) {
      const tab = make('button', 'cursor-interaction', text); tab.type = 'button'; tab.dataset.mode = id;
      tab.onclick = () => { if (busy) return; mode = id; tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === id))); phone.hidden = mode !== 'phone'; clearChallenge(); };
      tab.setAttribute('aria-selected', String(id === mode)); tabs.append(tab);
    }
    phone = make('input'); phone.id = 'whatsapp-link-phone'; phone.type = 'tel'; phone.autocomplete = 'off'; phone.placeholder = '国家区号和手机号，例如 +86 13800138000'; phone.setAttribute('aria-label', 'WhatsApp 手机号，含国家区号'); phone.hidden = true;
    status = make('div', 'whatsapp-link-status'); status.setAttribute('role', 'status');
    result = make('div', 'whatsapp-link-result');
    const actions = make('div', 'workspace-dialog-actions');
    close = make('button', 'cursor-interaction', '关闭'); close.type = 'button'; close.onclick = () => dialog.close();
    start = make('button', 'cursor-interaction', '开始关联'); start.id = 'whatsapp-link-start'; start.type = 'button';
    start.onclick = async () => {
      if (busy) return;
      if (mode === 'phone' && !/^[1-9][0-9]{7,14}$/.test(phone.value.replace(/[ +()-]/g, ''))) { status.textContent = '请输入含国家区号的手机号。'; return; }
      const token = generation; busy = true; start.disabled = true; tabs.querySelectorAll('button').forEach(b => b.disabled = true); phone.disabled = true; status.textContent = '正在准备关联…'; clearChallenge();
      try { const value = await request('whatsappLinkStart', { mode, phoneNumber: mode === 'phone' ? phone.value : '' }); if (dialog.open && token === generation) render(value); }
      catch (error) { if (dialog.open && token === generation) status.textContent = error.message; }
      finally { busy = false; start.disabled = false; tabs.querySelectorAll('button').forEach(b => b.disabled = false); phone.disabled = false; }
    };
    actions.append(close, start); dialog.append(tabs, phone, status, result, actions); root.append(dialog);
    dialog.addEventListener('close', () => { generation++; clearTimeout(timer); phone.value = ''; clearChallenge(); });
  }
  function open() { if (!dialog) create(); if (dialog.open) return; dialog.showModal(); status.textContent = '正在检查远端设备状态…'; poll(++generation); }
  openButton.onclick = open;
  return { open };
};
