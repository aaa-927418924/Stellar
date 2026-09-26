export function progressFromEvent(event) {
  const kind = event.part?.type || event.type;
  if (kind === 'reasoning' && typeof event.part?.text === 'string' && event.part.text.trim()) {
    return { type: 'thought', text: event.part.text };
  }
  if ((kind === 'tool' || event.type === 'tool_use') && event.part?.tool) {
    return { type: 'tool', text: event.part.tool };
  }
  return null;
}

export function appendProgress(chat, type, text) {
  const value = String(text || '').trim();
  if (!value || !chat.job) return;
  const item = { type, text: value.slice(0, 10000), at: new Date().toISOString() };
  chat.job.progress.push(item);
  if (chat.job.progress.length > 120) chat.job.progress.shift();
  while (chat.job.progress.reduce((total, entry) => total + entry.text.length, 0) > 100000) chat.job.progress.shift();
  chat.job.updatedAt = item.at;
}
