'use strict';
window.RemoteCodexSplitLayout = root => {
  const workspace = root.querySelector('.workspace'), messages = root.querySelector('#cmsg-sidebar'), navigation = root.querySelector('#cmsg-navigation');
  if (!workspace || !messages) return;
  const storageKey = 'messageSidebarWidth';
  const read = () => { try { const value = Number(localStorage.getItem(storageKey)); return Number.isFinite(value) && value >= 240 && value <= 10000 ? value : null; } catch { return null; } };
  let preferred = read(), drag = null;
  const handle = document.createElement('div'); handle.id = 'workspace-splitter'; handle.className = 'workspace-splitter'; handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', '调整 Codex 聊天区与消息侧栏宽度'); handle.setAttribute('aria-controls', 'cmsg-sidebar');
  handle.title = '左右拖动调整宽度，双击恢复默认；也可用左右方向键调整'; workspace.append(handle);
  function bounds() {
    const nav = navigation.hidden ? 0 : navigation.getBoundingClientRect().width;
    return { min: 240, max: Math.max(240, Math.floor(workspace.getBoundingClientRect().width - nav - 400)) };
  }
  function sync() {
    handle.hidden = messages.hidden || root.classList.contains('is-collapsed') || window.matchMedia('(max-width:710px)').matches;
    if (handle.hidden) { if (drag) finish(); return; }
    if (preferred == null) root.style.removeProperty('--message-width');
    const limits = bounds(), initial = preferred ?? (parseFloat(getComputedStyle(root).getPropertyValue('--message-width')) || 302), width = Math.min(limits.max, Math.max(limits.min, initial));
    if (preferred != null || width !== initial) root.style.setProperty('--message-width', width + 'px');
    handle.setAttribute('aria-valuemin', String(limits.min)); handle.setAttribute('aria-valuemax', String(limits.max)); handle.setAttribute('aria-valuenow', String(Math.round(width))); handle.setAttribute('aria-valuetext', '消息区域 ' + Math.round(width) + ' 像素');
  }
  function save() { try { if (preferred == null) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, String(preferred)); } catch {} }
  function resize(width) { const limits = bounds(); preferred = Math.round(Math.min(limits.max, Math.max(limits.min, width))); sync(); }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag; drag = null;
    if (cancel) preferred = previous.preferred;
    root.classList.remove('is-resizing-panels');
    try { if (handle.hasPointerCapture(previous.pointer)) handle.releasePointerCapture(previous.pointer); } catch {}
    sync(); save();
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || handle.hidden || drag) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, x: event.clientX, width: messages.getBoundingClientRect().width, preferred };
    handle.setPointerCapture(event.pointerId); root.classList.add('is-resizing-panels');
  });
  handle.addEventListener('pointermove', event => { if (drag?.pointer === event.pointerId) { event.preventDefault(); resize(drag.width + drag.x - event.clientX); } });
  handle.addEventListener('pointerup', event => { if (drag?.pointer === event.pointerId) finish(); });
  handle.addEventListener('pointercancel', event => { if (drag?.pointer === event.pointerId) finish(true); });
  handle.addEventListener('lostpointercapture', () => finish());
  handle.addEventListener('dblclick', event => { event.preventDefault(); preferred = null; sync(); save(); });
  handle.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter') { preferred = null; sync(); }
    else { const limits = bounds(), width = messages.getBoundingClientRect().width; resize(event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : width + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 10)); }
    save();
  });
  new ResizeObserver(sync).observe(workspace);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('storage', event => { if (event.key === storageKey && !drag) { preferred = read(); sync(); } });
  sync();
};
