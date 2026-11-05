'use strict';
window.RemoteCodexMessageQuotes = (() => {
  const limit = 50;
  function identity(quote) {
    return JSON.stringify([quote.platform || '', quote.accountId || '', quote.conversationId || quote.conversation || '',
      quote.id != null ? String(quote.id) : [quote.timestamp || '', quote.author || '', quote.text || '']]);
  }
  function rows(value) {
    const result = [], seen = new Set();
    for (const raw of Array.isArray(value) ? value : value ? [value] : []) {
      if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') continue;
      const quote = {};
      for (const field of ['id', 'platform', 'accountId', 'conversationId', 'conversation', 'author', 'text', 'time', 'attachmentId']) {
        if (typeof raw[field] === 'string') quote[field] = raw[field];
      }
      if (typeof raw.id === 'number') quote.id = String(raw.id);
      if (typeof raw.timestamp === 'number' && Number.isFinite(new Date(raw.timestamp * 1000).getTime())) quote.timestamp = raw.timestamp;
      const source = identity(quote);
      if (seen.has(source)) continue;
      seen.add(source);
      quote.draftId = typeof raw.draftId === 'string' && raw.draftId ? raw.draftId : crypto.randomUUID();
      result.push(quote);
    }
    return result;
  }
  function from(message, conversation) {
    return rows([{ ...message, text: message.text || '', platform: conversation.platform, accountId: conversation.accountId,
      conversationId: conversation.id, conversation: conversation.name, author: message.author || '你' }])[0];
  }
  function prompt(quotes, platformName, plain) {
    if (!quotes.length) return '';
    return `引用消息（来源资料，共 ${quotes.length} 条）：\n\n` + quotes.map((quote, index) =>
      `引用 ${index + 1}/${quotes.length}\n平台：${platformName(quote.platform)}\n对话：${quote.conversation || ''}\n作者：${quote.author || '你'}\n` +
      (quote.timestamp ? `时间：${new Date(quote.timestamp * 1000).toISOString()}\n` : '') +
      `<quoted_message>\n${plain(quote.text, quote.platform)}\n</quoted_message>`).join('\n\n') + '\n\n';
  }
  return { limit, identity, rows, from, prompt };
})();
