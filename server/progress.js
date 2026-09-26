function str(value) {
  return typeof value === 'string' ? value : '';
}

function head(value, length = 160) {
  return str(value).replace(/\s+/g, ' ').trim().slice(0, length);
}

function inputPairs(input) {
  return Object.entries(input)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`);
}

function summarizeTool(part) {
  const name = part.tool || 'tool';
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const meta = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const status = state.status || '';
  let title = name;
  switch (name) {
    case 'read': title = `Read ${head(input.filePath) || '(不明)'}`; break;
    case 'bash': title = str(input.command) ? `$ ${head(input.command, 200)}` : 'Bash'; break;
    case 'edit': title = `Edit ${head(input.filePath) || '(不明)'}`; break;
    case 'write': title = `Write ${head(input.filePath) || '(不明)'}`; break;
    case 'apply_patch': {
      const files = Array.isArray(meta.files) ? meta.files.length : 0;
      title = files > 0 ? `Patch ${files}件` : 'Patch';
      break;
    }
    case 'glob': title = `Glob「${head(input.pattern)}」${input.path ? `（${head(input.path)}）` : ''}`; break;
    case 'grep': title = `Grep「${head(input.pattern)}」${input.path ? `（${head(input.path)}）` : ''}`; break;
    case 'list': title = input.path ? `List ${head(input.path)}` : 'List'; break;
    case 'lsp': title = `LSP ${head(input.operation) || 'request'}${input.filePath ? ` ${head(input.filePath)}` : ''}`; break;
    case 'webfetch': title = `WebFetch ${head(input.url, 200) || '(不明)'}`; break;
    case 'websearch': title = str(input.query) ? `WebSearch「${head(input.query, 200)}」` : 'WebSearch'; break;
    case 'skill': title = `Skill「${head(input.name) || '(不明)'}」`; break;
    case 'task': title = head(input.description, 200) || 'Task'; break;
    case 'todowrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const done = todos.filter(item => item && item.status === 'completed').length;
      title = todos.length > 0 ? `Todo ${done}/${todos.length}完了` : 'Todo';
      break;
    }
    case 'question': {
      const questions = Array.isArray(input.questions) ? input.questions.length : 0;
      title = `質問 ${questions}件`;
      break;
    }
    default: {
      const pairs = inputPairs(input);
      title = pairs.length > 0 ? `${name} [${pairs.join(', ')}]` : name;
      break;
    }
  }
  if (status === 'error') {
    const error = head(state.error, 300);
    return { text: `${title} → 失敗${error ? `：${error}` : ''}` };
  }
  const bits = [];
  const exitCode = meta.exit ?? state.exitCode ?? state.exit_code;
  if (typeof exitCode === 'number') bits.push(`exit ${exitCode}`);
  if (typeof meta.count === 'number') bits.push(`${meta.count}件`);
  if (typeof meta.matches === 'number') bits.push(`${meta.matches}件`);
  const text = bits.length > 0 ? `${title} → ${bits.join(' ')}` : title;
  const output = str(state.output).trim() || (name === 'edit' ? str(meta.diff).trim() : '');
  if (!output) return { text };
  return { text, detail: output.slice(0, 1500) };
}

export function progressFromEvent(event, chat) {
  const kind = event.part?.type || event.type;
  if (kind === 'reasoning' && typeof event.part?.text === 'string' && event.part.text.trim()) {
    return { type: 'thought', text: event.part.text };
  }
  if ((kind === 'tool' || event.type === 'tool_use') && event.part?.tool) {
    return { type: 'tool', ...summarizeTool(event.part) };
  }
  if (event.type === 'step_start' || kind === 'step-start') {
    const step = chat?.job ? chat.job.progress.filter(entry => entry.type === 'step').length + 1 : 1;
    return { type: 'step', text: `ステップ${step}を開始しました。` };
  }
  return null;
}

export function appendProgress(chat, type, text, detail) {
  const value = String(text || '').trim();
  if (!value || !chat.job) return;
  const item = { type, text: value.slice(0, 10000), at: new Date().toISOString() };
  const extra = String(detail || '').trim().slice(0, 2000);
  if (extra) item.detail = extra;
  chat.job.progress.push(item);
  if (chat.job.progress.length > 120) chat.job.progress.shift();
  while (chat.job.progress.reduce((total, entry) => total + entry.text.length + (entry.detail || '').length, 0) > 100000) chat.job.progress.shift();
  chat.job.updatedAt = item.at;
}
