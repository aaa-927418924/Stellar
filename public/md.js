export function cleanAiText(raw) {
  return String(raw || '').replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2').replace(/\\\((.*?)\\\)/g, '$1').replace(/\\\[|\\\]/g, '').replace(/\\times|\\cdot/g, '×').replace(/\\div/g, '÷').replace(/ {2}\n/g, '\n');
}

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function unescapeHtml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export function renderInlineHtml(text) {
  const codes = [];
  const stashed = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const formatted = stashed
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return formatted.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

export function appendListBlock(container, lines) {
  const stack = [];
  const listTag = ordered => (ordered ? 'ol' : 'ul');
  for (const line of lines) {
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!match) continue;
    const level = Math.floor(match[1].replace(/\t/g, '  ').length / 2);
    const ordered = /^\d/.test(match[2]);
    while (stack.length > 0 && stack[stack.length - 1].level > level) stack.pop();
    if (stack.length === 0 || stack[stack.length - 1].level < level || stack[stack.length - 1].list.tagName !== listTag(ordered).toUpperCase()) {
      if (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      const list = document.createElement(listTag(ordered));
      if (stack.length > 0 && stack[stack.length - 1].li) stack[stack.length - 1].li.append(list);
      else container.append(list);
      stack.push({ list, level, li: null });
    }
    const item = document.createElement('li');
    item.innerHTML = renderInlineHtml(match[3]);
    stack[stack.length - 1].list.append(item);
    stack[stack.length - 1].li = item;
  }
}

export function appendParagraph(container, lines) {
  const paragraph = document.createElement('p');
  paragraph.innerHTML = lines.map(renderInlineHtml).join('<br>');
  container.append(paragraph);
}

export function appendTextBlock(container, lines) {
  if (lines.every(line => !line.trim())) return;
  const first = lines.find(line => line.trim());
  const heading = /^(#{1,6})\s+(.*)$/.exec(first);
  if (heading && lines.every(line => !line.trim() || line === first)) {
    const level = Math.min(heading[1].length, 4);
    const element = document.createElement(`h${level}`);
    element.innerHTML = renderInlineHtml(heading[2]);
    container.append(element);
    return;
  }
  if (lines.length === 1 && /^---+$/.test(first.trim())) {
    container.append(document.createElement('hr'));
    return;
  }
  if (lines.every(line => !line.trim() || /^\s*&gt;/.test(line))) {
    const quote = document.createElement('blockquote');
    quote.innerHTML = lines
      .map(line => line.replace(/^\s*&gt;\s?/, ''))
      .filter((line, index, all) => line.trim() || (all[index - 1] && all[index - 1].trim()) || (all[index + 1] && all[index + 1].trim()))
      .map(renderInlineHtml).join('<br>');
    container.append(quote);
    return;
  }
  if (lines.some(line => /^\s*([-*+]|\d+[.)])\s+/.test(line))) {
    let run = [];
    const flushRun = () => {
      if (run.length === 0) return;
      if (run.some(line => /^\s*([-*+]|\d+[.)])\s+/.test(line))) appendListBlock(container, run);
      else appendParagraph(container, run);
      run = [];
    };
    for (const line of lines) {
      const isList = /^\s*([-*+]|\d+[.)])\s+/.test(line);
      const wasList = run.length > 0 && /^\s*([-*+]|\d+[.)])\s+/.test(run[run.length - 1]);
      if (run.length > 0 && isList !== wasList) flushRun();
      run.push(line);
    }
    flushRun();
    return;
  }
  appendParagraph(container, lines);
}

export function renderMarkdown(container, raw) {
  const lines = escapeHtml(cleanAiText(raw)).split('\n');
  const segments = [];
  let text = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^```/.test(lines[index])) {
      if (text.length > 0) { segments.push({ type: 'text', lines: text }); text = []; }
      const code = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index])) { code.push(lines[index]); index++; }
      segments.push({ type: 'code', text: code.join('\n').replace(/^\n+|\n+$/g, '') });
    } else text.push(lines[index]);
  }
  if (text.length > 0) segments.push({ type: 'text', lines: text });
  for (const segment of segments) {
    if (segment.type === 'code') {
      const pre = document.createElement('pre');
      pre.className = 'md-code';
      const code = document.createElement('code');
      code.textContent = unescapeHtml(segment.text);
      pre.append(code);
      container.append(pre);
      continue;
    }
    let block = [];
    const flush = () => { if (block.length > 0) { appendTextBlock(container, block); block = []; } };
    for (const line of segment.lines) {
      if (!line.trim()) flush();
      else block.push(line);
    }
    flush();
  }
}
