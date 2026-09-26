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
    .replace(/\$\$([^$\n]+)\$\$/g, (_, math) => formatMath(math))
    .replace(/\$([^$\n]+)\$/g, (_, math) => formatMath(math))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return formatted.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

const LATEX_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'Ω',
  infty: '∞', sum: 'Σ', int: '∫', times: '×', div: '÷', cdot: '·',
  pm: '±', leq: '≤', geq: '≥', neq: '≠', approx: '≈', to: '→',
  log: 'log', sin: 'sin', cos: 'cos', tan: 'tan'
};

export function convertLatexMath(text) {
  let out = String(text || '');
  out = out.replace(/\\begin\{[^}]*\}/g, '').replace(/\\end\{[^}]*\}/g, '');
  out = out.replace(/\\\\/g, '\n');
  out = out.replace(/\\(d?frac)\{([^{}]*)\}\{([^{}]*)\}/g, '($2)/($3)');
  out = out.replace(/\\sqrt(?:\[[^\]]*\])?\{([^{}]*)\}/g, '√($1)');
  out = out.replace(/\\(text|mathrm|mathbf|mathit|boldsymbol)\{([^{}]*)\}/g, '$2');
  out = out.replace(/\\(left|right)\b/g, '');
  out = out.replace(/\\&amp;/g, '&');
  out = out.replace(/&amp;/g, ' ');
  out = out.replace(/\\([ ,:;])/g, ' ').replace(/\\!/g, '');
  out = out.replace(/\\([\\^_%${}#])/g, '$1');
  out = out.replace(/\\([a-zA-Z]+)/g, (match, name) => LATEX_SYMBOLS[name] ?? match);
  out = out.replace(/\\([0-9])/g, '$1');
  return out.split('\n').map(line => line.trim()).filter(line => line).join('\n');
}

function formatMath(math) {
  return `<code class="md-math">${convertLatexMath(math)}</code>`;
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

export function splitTableRow(line) {
  let cells = line.trim().split('|');
  if (cells.length > 0 && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  return cells.map(cell => cell.trim());
}

export function parseTableBlock(lines) {
  const rows = lines.filter(line => line.trim());
  if (rows.length < 2) return null;
  const delim = splitTableRow(rows[1]);
  if (delim.length === 0 || !delim.every(cell => /^:?-+:?$/.test(cell))) return null;
  const header = splitTableRow(rows[0]);
  if (header.length !== delim.length) return null;
  const body = [];
  for (let index = 2; index < rows.length; index++) {
    const cells = splitTableRow(rows[index]);
    if (cells.length !== delim.length) return null;
    body.push(cells);
  }
  const align = delim.map(cell => {
    if (cell.startsWith(':') && cell.endsWith(':') && cell.length > 2) return 'center';
    if (cell.endsWith(':')) return 'right';
    if (cell.startsWith(':')) return 'left';
    return '';
  });
  return { header, align, body };
}

export function appendTableBlock(container, table) {
  const element = document.createElement('table');
  element.className = 'md-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  table.header.forEach((cell, index) => {
    const th = document.createElement('th');
    if (table.align[index]) th.setAttribute('align', table.align[index]);
    th.innerHTML = renderInlineHtml(cell);
    headRow.append(th);
  });
  head.append(headRow);
  element.append(head);
  const body = document.createElement('tbody');
  for (const row of table.body) {
    const tr = document.createElement('tr');
    row.forEach((cell, index) => {
      const td = document.createElement('td');
      if (table.align[index]) td.setAttribute('align', table.align[index]);
      td.innerHTML = renderInlineHtml(cell);
      tr.append(td);
    });
    body.append(tr);
  }
  element.append(body);
  container.append(element);
}

export function emitHeading(container, match) {
  const level = Math.min(match[1].length, 4);
  const element = document.createElement(`h${level}`);
  element.innerHTML = renderInlineHtml(match[2]);
  container.append(element);
}

export function appendTextBlock(container, lines) {
  if (lines.every(line => !line.trim())) return;
  const table = parseTableBlock(lines);
  if (table) {
    appendTableBlock(container, table);
    return;
  }
  let para = [];
  let listRun = [];
  const flushPara = () => {
    if (para.length === 0) return;
    if (para.every(line => /^\s*&gt;/.test(line))) {
      const quote = document.createElement('blockquote');
      quote.innerHTML = para
        .map(line => line.replace(/^\s*&gt;\s?/, ''))
        .map(renderInlineHtml).join('<br>');
      container.append(quote);
    } else appendParagraph(container, para);
    para = [];
  };
  const flushList = () => {
    if (listRun.length === 0) return;
    appendListBlock(container, listRun);
    listRun = [];
  };
  for (const line of lines) {
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushPara(); flushList(); emitHeading(container, heading); continue; }
    if (/^---+$/.test(line.trim())) {
      flushPara(); flushList();
      container.append(document.createElement('hr'));
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { flushPara(); listRun.push(line); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
}

export function renderMarkdown(container, raw) {
  const lines = escapeHtml(cleanAiText(raw)).split('\n');
  const segments = [];
  let text = [];
  for (let index = 0; index < lines.length; index++) {
    const mathOpen = /^\$\$(.*)$/.exec(lines[index]);
    if (mathOpen) {
      if (text.length > 0) { segments.push({ type: 'text', lines: text }); text = []; }
      const rest = mathOpen[1];
      const closeAt = rest.indexOf('$$');
      if (closeAt >= 0) {
        segments.push({ type: 'math', text: rest.slice(0, closeAt) });
        const after = rest.slice(closeAt + 2);
        if (after.trim()) text.push(after);
      } else {
        const body = [];
        index++;
        while (index < lines.length && lines[index].indexOf('$$') < 0) { body.push(lines[index]); index++; }
        if (index < lines.length) {
          const closing = lines[index];
          const head = closing.slice(0, closing.indexOf('$$'));
          if (head.trim()) body.push(head);
          const after = closing.slice(closing.indexOf('$$') + 2);
          segments.push({ type: 'math', text: body.join('\n') });
          text = after.trim() ? [after] : [];
        } else {
          segments.push({ type: 'math', text: body.join('\n') });
        }
      }
      continue;
    }
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
    if (segment.type === 'math') {
      const pre = document.createElement('pre');
      pre.className = 'md-math-block';
      const code = document.createElement('code');
      code.textContent = convertLatexMath(segment.text);
      pre.append(code);
      container.append(pre);
      continue;
    }
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
