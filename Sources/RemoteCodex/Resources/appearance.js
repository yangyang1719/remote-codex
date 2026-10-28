'use strict';
window.RemoteCodexAppearance = ({ root, make }) => {
  const storageKey = 'remoteCodex.fontSize', defaultSize = 16;
  let size = defaultSize;
  try { const saved = Number(localStorage.getItem(storageKey)); if (saved >= 12 && saved <= 24) size = Math.round(saved); } catch {}
  const entry = make('button', 'nav-button font-settings cursor-interaction'); entry.type = 'button'; entry.id = 'font-settings';
  entry.append(make('span', 'font-setting-glyph', 'Aa'), make('span', 'font-setting-label'));
  root.querySelector('.nav-bottom').prepend(entry);
  const dialog = make('dialog', 'workspace-dialog font-dialog'); dialog.id = 'font-dialog'; dialog.setAttribute('aria-labelledby', 'font-title');
  const title = make('h3', '', '字体大小'); title.id = 'font-title';
  const description = make('p', '', '聊天、消息与输入框同步调整，自动记住你的选择。');
  const controls = make('div', 'font-size-controls'), less = make('button', 'small-button', '−'), more = make('button', 'small-button', '+');
  less.type = more.type = 'button'; less.id = 'font-smaller'; more.id = 'font-larger'; less.setAttribute('aria-label', '缩小字体'); more.setAttribute('aria-label', '放大字体');
  const select = make('select'); select.id = 'font-size-select'; select.setAttribute('aria-label', '正文字号');
  for (let value = 12; value <= 24; value++) { const option = make('option', '', value + ' px'); option.value = value; select.append(option); }
  controls.append(less, select, more);
  const sample = make('div', 'font-size-sample', '文字清晰一些，阅读轻松一点。\nCodex · WhatsApp · 1234567890');
  const actions = make('div', 'workspace-dialog-actions'), reset = make('button', 'small-button', '恢复默认'), done = make('button', 'small-button', '完成'); reset.type = done.type = 'button';
  actions.append(reset, done); dialog.append(title, description, controls, sample, actions); root.append(dialog);
  function apply(value) {
    const number = Number(value); if (!Number.isFinite(number)) return;
    size = Math.max(12, Math.min(24, Math.round(number)));
    root.style.setProperty('--font-scale', String(size / 12)); root.dataset.fontSize = size;
    select.value = size; entry.querySelector('.font-setting-label').textContent = '字体大小'; entry.title = '当前正文字号：' + size + ' px';
    less.disabled = size === 12; more.disabled = size === 24;
    try { localStorage.setItem(storageKey, String(size)); } catch {}
    root.dispatchEvent(new CustomEvent('fontSizeChanged', { detail: { size } }));
  }
  function open() { if (!dialog.open) dialog.showModal(); }
  entry.onclick = open; less.onclick = () => apply(size - 1); more.onclick = () => apply(size + 1); reset.onclick = () => apply(defaultSize); done.onclick = () => dialog.close(); select.onchange = () => apply(select.value);
  apply(size);
  return { receive(event) { if (event.type !== 'appearanceCommand') return; if (event.command === 'open') open(); else if (event.command === 'increase') apply(size + 1); else if (event.command === 'decrease') apply(size - 1); else if (event.command === 'reset') apply(defaultSize); } };
};
