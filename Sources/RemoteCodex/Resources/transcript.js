'use strict';
window.RemoteCodexTranscript = ({ make, icon, inline, pagedText, request, connected }) => {
  const views = new WeakMap(), reasoningViews = new WeakMap(), running = new Set();
  const languages = { sh: 'Shell', bash: 'Shell', zsh: 'Shell', shell: 'Shell', console: 'Shell', js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', py: 'Python', python: 'Python', json: 'JSON', cpp: 'C++', c: 'C', css: 'CSS', html: 'HTML', sql: 'SQL', swift: 'Swift', rust: 'Rust', go: 'Go', text: '文本', plaintext: '文本', yaml: 'YAML', yml: 'YAML' };
  function copyButton(value) {
    const button = make('button', 'code-copy cursor-interaction', '复制'); button.type = 'button'; button.setAttribute('aria-label', '复制代码');
    button.onclick = async () => { try { await request('copyText', { text: value() }); button.textContent = '已复制'; } catch { button.textContent = '复制失败'; } };
    return button;
  }
  function codeBlock(text, language = '') {
    const box = make('div', 'code-card'), header = make('div', 'code-header'), pre = make('pre'), code = make('code');
    header.append(make('span', '', languages[language.toLowerCase()] || language || '代码'), copyButton(() => text));
    pagedText(code, text); pre.append(code); box.append(header, pre); return box;
  }
  function prose(node, value) {
    for (const paragraph of value.split(/\n\n+/)) {
      if (!paragraph.trim()) continue;
      if (/^#{1,6}\s/.test(paragraph)) { const h = make('h3'); inline(h, paragraph.replace(/^#+\s*/, '')); node.append(h); }
      else if (/^[-*] /.test(paragraph)) { const ul = make('ul'); for (const line of paragraph.split('\n')) { const li = make('li'); inline(li, line.replace(/^[-*]\s*/, '')); ul.append(li); } node.append(ul); }
      else { const p = make('p'); p.style.whiteSpace = 'pre-wrap'; inline(p, paragraph); node.append(p); }
    }
  }
  function tableCells(line) {
    if (!line.includes('|')) return null;
    const value = line.trim(), cells = []; let cell = '', ticks = 0, pipes = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '\\' && i + 1 < value.length) { const next = value[++i]; cell += next === '|' ? '|' : char + next; continue; }
      if (char === '`') { let count = 1; while (value[i + 1] === '`') { count++; i++; } if (!ticks) ticks = count; else if (ticks === count) ticks = 0; cell += '`'.repeat(count); continue; }
      if (char === '|' && !ticks) { cells.push(cell.trim()); cell = ''; pipes++; } else cell += char;
    }
    if (!pipes) return null;
    cells.push(cell.trim()); if (value.startsWith('|')) cells.shift(); if (value.endsWith('|') && cells.at(-1) === '') cells.pop();
    return cells;
  }
  function textBlocks(text, blocks) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n'); let pending = '';
    const flush = () => { for (let i = 0; i < pending.length; i += 12000) blocks.push({ text: pending.slice(i, i + 12000) }); pending = ''; };
    for (let i = 0; i < lines.length; i++) {
      const header = tableCells(lines[i]);
      if (!header?.length || header.length > 64) { pending += lines[i] + '\n'; continue; }
      let separator = i + 1;
      while (separator < lines.length && !lines[separator].trim()) separator++;
      const divider = header && tableCells(lines[separator] || '');
      if (divider?.length !== header.length || !divider.every(cell => /^:?-{3,}:?$/.test(cell))) { pending += lines[i] + '\n'; continue; }
      flush(); const rows = [], align = divider.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      let end = separator + 1;
      while (end < lines.length) {
        let rowIndex = end; while (rowIndex < lines.length && !lines[rowIndex].trim()) rowIndex++;
        const row = rowIndex < lines.length ? tableCells(lines[rowIndex]) : null;
        if (!row) break;
        rows.push(row); end = rowIndex + 1;
      }
      blocks.push({ table: { header, align, rows } }); i = end - 1;
    }
    flush();
  }
  function tableBlock(value) {
    const box = make('div', 'markdown-table-block'), scroll = make('div', 'markdown-table-scroll'), table = make('table', 'markdown-table'), head = make('thead'), body = make('tbody'), row = make('tr');
    scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '表格，可横向滚动'); table.style.minWidth = value.header.length * 140 + 'px';
    for (const [index, text] of value.header.entries()) { const cell = make('th'); cell.scope = 'col'; cell.style.textAlign = value.align[index]; inline(cell, text); row.append(cell); }
    head.append(row); table.append(head, body); scroll.append(table); box.append(scroll);
    let index = 0; const more = make('button', 'small-button table-more'); more.type = 'button'; box.append(more);
    const append = () => {
      let size = 0, count = 0;
      while (index < value.rows.length && count < 80 && size < 12000) {
        const values = value.rows[index++], row = make('tr'); count++; size += values.join('').length;
        for (let column = 0; column < value.header.length; column++) {
          const cell = make('td'); cell.style.textAlign = value.align[column];
          inline(cell, column === value.header.length - 1 ? values.slice(column).join(' | ') : values[column] || ''); row.append(cell);
        }
        body.append(row);
      }
      more.hidden = index >= value.rows.length; more.textContent = `显示更多行（${index} / ${value.rows.length}）`;
    };
    more.onclick = append; append(); return box;
  }
  function markdown(node, value) {
    // Tokenize fences before paging. A page boundary can never turn code into prose.
    const text = String(value || ''), blocks = []; let offset = 0;
    while (offset < text.length) {
      const from = text.indexOf('```', offset); if (from < 0) { textBlocks(text.slice(offset), blocks); break; }
      textBlocks(text.slice(offset, from), blocks);
      const fence = /^`{3,}/.exec(text.slice(from))[0], begin = from + fence.length, end = text.indexOf(fence, begin);
      let code = text.slice(begin, end < 0 ? text.length : end), language = '';
      const hint = /^([a-zA-Z0-9_+#.-]+)([ \t]*\r?\n|[ \t]+)/.exec(code);
      if (hint && (hint[2].includes('\n') || languages[hint[1].toLowerCase()])) { language = hint[1]; code = code.slice(hint[0].length); }
      else code = code.replace(/^\r?\n/, '');
      blocks.push({ code: code.replace(/\r?\n$/, ''), language }); offset = end < 0 ? text.length : end + fence.length;
    }
    let index = 0; const more = make('button', 'small-button text-more', '显示更多'); more.type = 'button'; node.append(more);
    const append = () => {
      let size = 0;
      while (index < blocks.length && size < 12000) { const part = blocks[index++]; const box = make('div'); if (part.table) box.append(tableBlock(part.table)); else if (part.code !== undefined) box.append(codeBlock(part.code, part.language)); else prose(box, part.text); size += part.table ? Math.min(12000, part.table.header.join('').length + part.table.rows.slice(0, 80).reduce((sum, row) => sum + row.join('').length, 0)) : Math.min(12000, (part.code ?? part.text).length); node.insertBefore(box, more); }
      more.hidden = index >= blocks.length;
    };
    more.onclick = append; append();
  }
  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }
  function label(view) {
    const item = view.item, active = ['inProgress', 'pending', 'running'].includes(item.status), stopped = active && !connected();
    const observed = active && typeof item.startedAtMs !== 'number' && typeof item.observedAtMs === 'number';
    const ms = active && typeof item.startedAtMs === 'number' ? Date.now() - item.startedAtMs : observed ? Date.now() - item.observedAtMs : typeof item.durationMs === 'number' ? item.durationMs : null;
    const state = ({ completed: '命令已完成', failed: '命令执行失败', declined: '命令未获批准', interrupted: '命令已中断' }[item.status]) || (stopped ? '命令状态待同步' : '命令运行中');
    view.title.textContent = state + (ms === null || stopped ? '' : ' · ' + (observed ? '已观察 ' : '') + duration(ms));
    view.node.dataset.status = item.status || 'inProgress'; view.node.classList.toggle('command-running', active && !stopped);
    view.result.textContent = active ? (stopped ? '连接恢复后更新状态' : '运行中…') : item.status === 'completed' && (item.exitCode === 0 || item.exitCode == null) ? '✓ 成功' : item.status === 'declined' ? '未执行' : item.status === 'interrupted' ? '已中断' : item.exitCode != null ? '退出码 ' + item.exitCode : '执行失败';
  }
  function updateCommand(node, item) {
    const view = views.get(node); if (!view) return command(item);
    view.item = item; label(view);
    if (['inProgress', 'pending', 'running'].includes(item.status)) running.add(node);
    const display = item.commandActions?.length === 1 && typeof item.commandActions[0].command === 'string' ? item.commandActions[0].command : item.command || '运行命令';
    view.command.textContent = '$ ' + display; view.command.title = item.cwd || '';
    view.preview.textContent = display; view.preview.title = display; node.dataset.command = item.command || '';
    if (item.exitCode != null) node.dataset.exitCode = String(item.exitCode); else delete node.dataset.exitCode;
    if (node.open) { if (view.box.parentNode !== node) node.append(view.box); output(view); }
    return node;
  }
  function output(view) {
    const value = view.item.aggregatedOutput || '';
    if (view.outputValue === value) return;
    const following = view.pre.scrollHeight - view.pre.scrollTop - view.pre.clientHeight < 24, scroll = view.pre.scrollTop;
    view.log.replaceChildren(); pagedText(view.log, value); view.outputValue = value;
    view.pre.scrollTop = following ? view.pre.scrollHeight : scroll;
  }
  function command(item) {
    const node = make('details', 'tool-detail command-detail'), summary = make('summary'), title = make('span', 'command-title'), preview = make('span', 'command-preview'), caret = make('span', 'command-caret', '⌄');
    summary.append(icon('terminal'), title, preview, caret);
    const box = make('div', 'code-card command-card'), header = make('div', 'code-header'), pre = make('pre'), commandText = make('code', 'command-source'), log = make('code', 'command-output'), result = make('div', 'command-result');
    const view = { node, box, title, preview, command: commandText, pre, log, result, item, outputValue: null }; views.set(node, view);
    header.append(make('span', '', 'Shell'), copyButton(() => view.item.command || '')); pre.append(commandText, log); box.append(header, pre, result); node.append(summary);
    node.ontoggle = () => { if (node.open) { if (box.parentNode !== node) node.append(box); output(view); } };
    updateCommand(node, item); return node;
  }
  function hasReasoningSummary(item) {
    return Array.isArray(item.summary) && item.summary.some(text => typeof text === 'string' && text.trim());
  }
  function updateReasoning(node, item) {
    const view = reasoningViews.get(node); if (!view) return reasoning(item);
    const text = (Array.isArray(item.summary) ? item.summary : []).filter(text => typeof text === 'string' && text.trim()).join('\n\n'); node.dataset.status = item.status || 'completed'; node.hidden = !hasReasoningSummary(item);
    view.label.textContent = item.status === 'inProgress' ? '思考中' : '思考摘要'; view.preview.textContent = text.replace(/\s+/g, ' '); view.preview.title = view.preview.textContent;
    if (view.text !== text) { view.text = text; if (node.open) { view.body.replaceChildren(); pagedText(view.body, text); } }
    return node;
  }
  function reasoning(item) {
    const node = make('details', 'reasoning-summary'), summary = make('summary'), label = make('span', 'reasoning-label'), preview = make('span', 'reasoning-preview'), body = make('div', 'reasoning-body');
    summary.append(label, preview); node.append(summary, body);
    const view = { label, preview, body, text: '' }; reasoningViews.set(node, view);
    node.ontoggle = () => { if (node.open) { body.replaceChildren(); pagedText(body, view.text); } };
    return updateReasoning(node, item);
  }
  setInterval(() => { for (const node of running) { if (!node.isConnected) { running.delete(node); continue; } const view = views.get(node); label(view); if (!['inProgress', 'pending', 'running'].includes(view.item.status)) running.delete(node); } }, 1000);
  return { markdown, command, updateCommand, reasoning, updateReasoning, hasReasoningSummary };
};
