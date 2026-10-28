'use strict';
window.RemoteCodexViewedImages = ({ state, make, icon, request }) => {
  const loaded = new Map(), jobs = new Map(), expanded = new Map(), queue = []; let running = 0;
  function drain() {
    while (running < 2 && queue.length) {
      const job = queue.shift(); running++;
      job().finally(() => { running--; drain(); });
    }
  }
  function fetch(key, body, scope, context) {
    if (loaded.has(key)) return Promise.resolve(loaded.get(key));
    if (jobs.has(key)) return jobs.get(key);
    const promise = new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          if (scope !== state.draftScope || context !== state.active) throw new Error('会话已切换，请重新打开图片。');
          const value = await request('viewedImageLoad', body);
          if (!value.thumbnail?.startsWith('data:image/png;base64,')) throw new Error('没有可用的缩略图。');
          loaded.set(key, value); if (loaded.size > 128) loaded.delete(loaded.keys().next().value);
          resolve(value);
        } catch (error) { reject(error); }
        finally { jobs.delete(key); }
      });
    });
    jobs.set(key, promise); drain(); return promise;
  }
  function render(item, thread) {
    const scope = state.draftScope, context = state.active, key = JSON.stringify([scope, thread, item.id, item.path]);
    const body = { threadId: thread, itemId: item.id, contextThreadId: context };
    const node = make('details', 'viewed-images'); node.dataset.imageItemId = item.id; node.open = expanded.get(key) !== false;
    const summary = make('summary'); summary.append(icon('image'), make('span', '', item.status === 'inProgress' ? '正在查看 1 张图像' : '已查看 1 张图像')); node.append(summary);
    const content = make('div', 'viewed-image-content'), button = make('button', 'viewed-image-thumb'), status = make('span', 'viewed-image-status');
    button.type = 'button'; button.title = item.path || ''; button.setAttribute('aria-label', '预览已查看的图片');
    const name = (item.path || '').split('/').pop() || '图片'; button.append(make('span', '', '加载缩略图…')); content.append(button, status); node.append(content);
    let ready = false, loading = false;
    const load = async () => {
      if (loading || ready || !node.open || item.status === 'inProgress') return;
      loading = true; button.disabled = true; status.textContent = '';
      try {
        const value = await fetch(key, body, scope, context), img = make('img'); img.src = value.thumbnail; img.alt = value.name || name;
        button.replaceChildren(img); ready = true;
      } catch (error) { button.replaceChildren(make('span', '', '图片暂不可用\n点击重试')); status.textContent = error.message; }
      finally { loading = false; button.disabled = false; }
    };
    button.onclick = async () => {
      if (!ready) { await load(); return; }
      button.disabled = true;
      try { await request('viewedImagePreview', body); }
      catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    node.addEventListener('toggle', () => { expanded.set(key, node.open); if (node.open && node.isConnected) load(); });
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { load(); observer.disconnect(); } }); observer.observe(node);
    if (loaded.has(key)) load();
    return node;
  }
  return { render };
};
