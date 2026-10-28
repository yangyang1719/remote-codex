'use strict';
window.RemoteCodexAsyncQuestions = ({ state, make, request, selection, changed }) => {
  const cards = new Map(), replies = new Map();
  const identity = (item, index) => JSON.stringify(['request_user_input_async', item, index]);
  const key = (thread, id) => JSON.stringify([state.draftScope, thread, id]);
  function parse(text) {
    const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
    if (!match) return null;
    try {
      const raw = JSON.parse(match[1]), rows = Array.isArray(raw) ? raw : [raw];
      return rows.length && rows.every(row => row && ['questionItemId', 'question', 'answer'].every(field => typeof row[field] === 'string')) ? rows : null;
    } catch { return null; }
  }
  function history(text) {
    const rows = parse(text); if (!rows) return null;
    const node = make('div', 'question-reply-history');
    for (const row of rows) { const section = make('section'); section.append(make('div', 'question-reply-label', '已回答 Codex 的问题'), make('div', 'question-reply-title', row.question), make('div', 'question-reply-answer', row.answer)); node.append(section); }
    return node;
  }
  function controls(entry) {
    const { card, thread, id, options, custom, submit, status } = entry, answer = replies.get(key(thread, id));
    const disabled = !state.connected || !!state.sendPending || !!state.commandPending || state.asyncQuestionPending != null || ['busy', 'resuming'].includes(state.access[thread]);
    card.dataset.answered = String(answer != null);
    if (answer != null) { status.textContent = '已回答：' + answer; submit.hidden = true; }
    options.forEach(({ radio }) => radio.disabled = disabled || answer != null);
    custom.disabled = disabled || answer != null; submit.disabled = disabled || answer != null;
  }
  function sync(items, textOf) {
    for (const item of items) if (item.type === 'userMessage') for (const reply of parse(textOf(item)) || []) replies.set(key(state.active, reply.questionItemId), reply.answer);
    for (const entry of cards.values()) controls(entry);
  }
  function render(item, thread) {
    return (item.questions || []).map((question, index) => {
      const id = identity(item.id, index), address = key(thread, id);
      if (cards.has(address)) { const entry = cards.get(address); controls(entry); return entry.card; }
      const card = make('section', 'async-question'); card.dataset.questionId = id;
      card.append(make('strong', '', question.title));
      const options = [], choices = make('div', 'async-question-options');
      for (const choice of question.options || []) {
        const label = make('label', 'question-option'), radio = make('input'); radio.type = 'radio'; radio.name = address; radio.value = choice;
        label.append(radio, make('span', '', choice)); choices.append(label); options.push({ radio });
      }
      const other = make('label', 'question-option'), otherRadio = make('input'); otherRadio.type = 'radio'; otherRadio.name = address;
      other.append(otherRadio, make('span', '', '其他回答')); if (options.length) choices.append(other);
      const custom = make('textarea', 'question-text'); custom.rows = 2; custom.maxLength = 8000; custom.placeholder = options.length ? '也可以填写其他回答' : '填写你的回答';
      custom.oninput = () => { otherRadio.checked = true; }; options.push({ radio: otherRadio, custom: true });
      const submit = make('button', 'small-button strong', '提交回答'); submit.type = 'button';
      const status = make('div', 'async-question-status'); status.setAttribute('role', 'status');
      const entry = { card, thread, id, options, custom, submit, status }; cards.set(address, entry);
      submit.onclick = async () => {
        const chosen = options.find(option => option.radio.checked), answer = (chosen?.custom || !question.options?.length ? custom.value : chosen?.radio.value || '').trim();
        if (!answer) { status.textContent = '请选择一个选项或填写回答。'; return; }
        if (state.active !== thread || state.asyncQuestionPending != null || replies.has(address)) return;
        state.asyncQuestionPending = thread; status.textContent = '正在提交…'; for (const value of cards.values()) controls(value); changed();
        try {
          await request('answerAsyncQuestion', { threadId: thread, sourceItemId: item.id, questionIndex: index, question: question.title, answer, messageSelection: selection() });
          replies.set(address, answer);
        } catch (error) { status.textContent = error.message + '；如结果未确认，请先刷新记录核对，勿重复提交。'; }
        finally { state.asyncQuestionPending = null; for (const value of cards.values()) controls(value); changed(); }
      };
      card.append(choices, custom, submit, status); controls(entry); return card;
    });
  }
  return { render, history, sync, parse };
};
