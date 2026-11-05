'use strict';
window.RemoteCodexLocalMCP = ({ root, state, q, make, icon, icons, request }) => {
  const entry = make('button', 'nav-button'), dialog = make('dialog', 'workspace-dialog local-mcp-dialog');
  entry.id = 'local-mcp-entry'; entry.type = 'button'; entry.append(icon('terminal'), document.createTextNode('本地 MCP')); q('.nav-bottom').prepend(entry); icons(entry);
  dialog.id = 'local-mcp-dialog';
  const title = make('h3', '', '本地 MCP'), help = make('p', '', '添加运行在这台 Mac 上的 MCP 服务，通过 SSH 提供给明确允许的 Codex 会话。第一版支持 stdio；不预装工具，不自动启动已保存的服务。');
  const sharing = make('p', 'local-mcp-sharing'), list = make('div', 'local-mcp-servers'), status = make('p', 'local-mcp-status'); status.id = 'local-mcp-status'; status.setAttribute('role', 'status');
  const editor = make('section'), label = make('label', '', 'MCP 配置 JSON'), text = make('textarea'); text.id = 'local-mcp-config'; text.spellcheck = false; text.setAttribute('aria-label', '本地 MCP 配置 JSON'); label.htmlFor = text.id;
  const note = make('p', '', '格式：{"mcpServers":{"名称":{"command":"/绝对路径/mcp-server","args":[],"env":{},"cwd":"/工作目录"}}}。保存后手动启动。环境变量可能包含密钥，仅保存在本机私有配置，不上传远端。');
  const save = make('button', 'small-button strong', '保存配置'), discard = make('button', 'small-button', '取消编辑'); save.id = 'local-mcp-save'; discard.id = 'local-mcp-discard'; editor.append(label, text, note, save, discard); editor.hidden = true;
  const tools = make('pre', 'local-mcp-tools'); tools.id = 'local-mcp-tools'; tools.hidden = true;
  const actions = make('div', 'workspace-dialog-actions'), edit = make('button', 'small-button', '添加 / 编辑配置'), refresh = make('button', 'small-button', '刷新'), allow = make('button', 'small-button strong', '允许当前会话'), revoke = make('button', 'small-button', '撤销当前会话'), stop = make('button', 'small-button', '关闭远端访问'), close = make('button', 'small-button', '关闭');
  edit.id = 'local-mcp-edit'; allow.id = 'local-mcp-allow'; revoke.id = 'local-mcp-revoke'; stop.id = 'local-mcp-stop-bridge'; close.id = 'local-mcp-close';
  actions.append(edit, refresh, allow, revoke, stop, close); dialog.append(title, help, sharing, list, editor, tools, status, actions); root.append(dialog); dialog.querySelectorAll('button').forEach(button => button.type = 'button');
  let snapshot = { servers: [], sharing: false, authorizedThreads: [] }, busy = false;
  function controls() {
    const authorized = snapshot.host === state.host && (snapshot.authorizedThreads || []).includes(state.active);
    sharing.textContent = snapshot.reconnecting ? 'SSH 通道中断，正在自动重连；工具调用不会自动重试。' : snapshot.sharing ? `${snapshot.host} · 远端访问已开启 · 已允许 ${(snapshot.authorizedThreads || []).length} 个会话${authorized ? '（含当前会话）' : ''}` : '远端访问已关闭';
    for (const button of [edit, refresh, save, discard, close]) button.disabled = busy;
    allow.disabled = busy || !state.connected || !state.active || authorized; revoke.disabled = busy || !authorized; stop.disabled = busy || (!snapshot.sharing && !snapshot.reconnecting);
  }
  function show(value) {
    snapshot = value; list.replaceChildren();
    if (!snapshot.servers?.length) list.append(make('p', 'empty-state', '还没有本地 MCP。以后选定功能时，在这里添加对应配置。'));
    for (const server of snapshot.servers || []) {
      const row = make('section', 'local-mcp-server'), name = make('strong', '', server.id), detail = make('span', '', server.running ? `运行中 · ${server.toolCount || 0} 个工具` : '未启动');
      const start = make('button', 'small-button', server.running ? '停止' : '启动'), inspect = make('button', 'small-button', '查看工具'), remove = make('button', 'small-button', '移除');
      for (const button of [start, inspect, remove]) { button.type = 'button'; button.disabled = busy; } inspect.disabled ||= !server.running;
      start.onclick = () => act(server.running ? 'stop' : 'start', { server: server.id }); remove.onclick = () => act('remove', { server: server.id });
      inspect.onclick = async () => { const result = await act('tools', { server: server.id }, false); if (result) { tools.textContent = JSON.stringify(result.tools || [], null, 2); tools.hidden = false; } };
      row.append(name, detail, start, inspect, remove); list.append(row);
    }
    if (value.message) status.textContent = value.message; controls();
  }
  async function act(operation, params = {}, update = true) {
    if (busy) return null;
    busy = true; status.textContent = '正在处理…'; controls(); list.querySelectorAll('button').forEach(button => button.disabled = true);
    try {
      const value = await request('localMCP', { operation, ...params }); if (update) show(value);
      status.textContent = operation === 'share' ? '已连接。远端 MCP 配置已刷新，会话在安全边界更新工具，无需重启。' : '已完成。'; return value;
    } catch (error) { status.textContent = error.message; return null; }
    finally { busy = false; show(snapshot); }
  }
  entry.onclick = () => { if (!dialog.open) dialog.showModal(); tools.hidden = true; tools.textContent = ''; act('snapshot'); }; refresh.onclick = () => act('snapshot');
  edit.onclick = async () => { const value = await act('readConfig', {}, false); if (value) { text.value = JSON.stringify(value, null, 2); editor.hidden = false; text.focus(); } };
  save.onclick = async () => { let config; try { config = JSON.parse(text.value); } catch { status.textContent = 'JSON 格式有误，请检查逗号和引号。'; return; } if (await act('save', { config })) { text.value = ''; editor.hidden = true; tools.hidden = true; tools.textContent = ''; } };
  discard.onclick = () => { text.value = ''; editor.hidden = true; }; allow.onclick = () => act('share'); revoke.onclick = () => act('revoke'); stop.onclick = () => act('stopBridge');
  function dismiss() { if (busy) return; text.value = ''; tools.textContent = ''; tools.hidden = true; editor.hidden = true; dialog.close(); }
  close.onclick = dismiss; dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  return { receive(event) { if (event.type === 'localMCPSnapshot') show(event); else if (dialog.open) controls(); } };
};
