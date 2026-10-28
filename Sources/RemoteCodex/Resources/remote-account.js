'use strict';
window.RemoteCodexAccount = ({ root, make, icon, icons, state, request }) => {
  const entry = make('button', 'nav-button cursor-interaction'); entry.id = 'remote-account-entry'; entry.type = 'button'; entry.append(icon('user-round'), make('span', '', '远端账号')); root.querySelector('.nav-bottom').prepend(entry);
  const dialog = make('dialog', 'workspace-dialog remote-account-dialog'); dialog.id = 'remote-account-dialog'; dialog.setAttribute('aria-labelledby', 'remote-account-title');
  const title = make('h3', '', '远端 Codex 账号'); title.id = 'remote-account-title';
  const scope = make('p', 'remote-account-scope'), summary = make('div', 'remote-account-summary', '正在读取…'); summary.id = 'remote-account-summary';
  const info = make('p', '', '通过官方设备授权码登录目标账号。凭据由远端 CLI 保存，Mac 客户端不保存密码或登录令牌。');
  const impact = make('p', 'remote-account-impact', '切换时先退出旧账号，再获取新授权码。取消或登录失败后需要重新登录，旧账号不会自动恢复。请先让共用该登录的任务（包括独立终端）空闲。');
  const codeBox = make('section', 'remote-account-code'); codeBox.hidden = true;
  const code = make('strong'); code.id = 'remote-account-code';
  const link = make('p'); link.id = 'remote-account-link';
  const help = make('p', '', '打开官方授权页，登录要切换的账号，然后输入此代码。请核对网页当前账号；代码失效后可重新获取。');
  const codeActions = make('div', 'remote-account-actions'), copy = make('button', 'small-button', '复制授权码'), browser = make('button', 'small-button strong', '打开官方授权页'); copy.type = browser.type = 'button'; copy.id = 'remote-account-copy'; browser.id = 'remote-account-browser'; codeActions.append(copy, browser); codeBox.append(code, link, help, codeActions);
  const status = make('p', 'remote-account-status'); status.id = 'remote-account-status'; status.setAttribute('role', 'status');
  const actions = make('div', 'workspace-dialog-actions'), refresh = make('button', 'small-button', '刷新账号'), start = make('button', 'small-button strong', '获取授权码'), cancel = make('button', 'small-button', '取消授权'), done = make('button', 'small-button', '关闭');
  for (const button of [refresh, start, cancel, done]) button.type = 'button';
  start.id = 'remote-account-start'; cancel.id = 'remote-account-cancel'; done.id = 'remote-account-close';
  actions.append(refresh, start, cancel, done); dialog.append(title, scope, summary, info, impact, codeBox, status, actions); root.append(dialog); icons(entry);
  let ready = false, pending = null, busy = false, version = 0, snapshot = null;
  function controls() {
    scope.textContent = (state.host || '远端') + ' · 共用远端登录';
    start.disabled = !ready || busy || !!pending; refresh.disabled = !ready || busy; cancel.hidden = !pending; cancel.disabled = !ready || busy; done.disabled = busy; copy.disabled = browser.disabled = !ready || busy || !pending;
    start.textContent = snapshot?.account ? '退出并登录其他账号' : '登录 · 获取授权码';
    codeBox.hidden = !pending; code.textContent = pending?.userCode || ''; link.textContent = pending?.verificationUrl || '';
  }
  function showAccount(value) {
    snapshot = value;
    const account = value.account;
    summary.textContent = account?.type === 'chatgpt' ? `${account.email || 'ChatGPT 账号'}${account.planType ? ' · ' + account.planType : ''}` : account?.type === 'apiKey' ? '当前使用 API Key' : account ? '当前认证方式：' + account.type : value.requiresOpenaiAuth === false ? '远端当前使用其他模型提供商' : '远端尚未登录';
  }
  async function act(operation) {
    if (busy) return null;
    busy = true; const current = version; controls();
    try {
      const result = await request('remoteAccount', { operation });
      return current === version ? result : null;
    } catch (error) { if (current === version) status.textContent = error.message; return null; }
    finally { if (current === version) { busy = false; controls(); } }
  }
  async function read() {
    const value = await act('read'); if (!value) return;
    showAccount(value); pending = value.login || null; controls();
  }
  async function close() {
    if (busy) return;
    if (pending && !(await act('cancel'))) return;
    pending = null; controls(); dialog.close();
  }
  entry.onclick = () => { if (!dialog.open) dialog.showModal(); status.textContent = ready ? '' : '请先连接远端 SSH。'; controls(); if (ready) read(); };
  refresh.onclick = read;
  start.onclick = async () => { status.textContent = '正在退出旧账号并申请设备授权码…'; const value = await act('start'); if (!value) return; pending = value; status.textContent = '旧账号已退出，等待你在浏览器完成新授权。'; controls(); };
  cancel.onclick = async () => { if (await act('cancel')) { pending = null; status.textContent = '已取消本次授权；旧账号不会自动恢复。'; controls(); } };
  copy.onclick = async () => { if (await act('copyCode')) status.textContent = '授权码已复制。'; };
  browser.onclick = () => act('openBrowser'); done.onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return { receive(event) {
    if (event.type === 'remoteAccountReady') { ready = event.ready; if (dialog.open && ready) { status.textContent = ''; read(); } }
    if (event.type === 'remoteAccountSnapshot') showAccount(event);
    if (event.type === 'remoteAccountLogin') {
      if (event.status === 'signedOut') showAccount({ account: null, requiresOpenaiAuth: true });
      if (['completed', 'failed', 'canceled', 'disconnected'].includes(event.status)) { pending = null; code.textContent = ''; }
      if (event.status === 'disconnected') { version++; busy = false; ready = false; snapshot = null; summary.textContent = '远端连接已断开'; status.textContent = event.pending === false ? '请等待远端连接后刷新账号。' : '连接中断，无法确认尚未完成的授权结果；重连后请刷新账号。'; }
      else status.textContent = event.message || (event.status === 'canceled' ? '已取消本次授权。' : '');
      if (event.status === 'completed' && dialog.open) read();
    }
    if (event.type === 'projectOpened') { version++; busy = false; snapshot = null; summary.textContent = '正在读取…'; if (dialog.open && ready) read(); }
    controls();
  }};
};
