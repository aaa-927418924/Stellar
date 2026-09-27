export function normalizeAnswer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '');
}

export function judgeAnswer(input, answers) {
  const normalized = normalizeAnswer(input);
  if (!normalized) return false;
  return (answers || []).some(answer => normalizeAnswer(answer) === normalized);
}

function cleanString(value, max) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function parseQuiz(result) {
  const source = String(result || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(source);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(source);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    let data;
    try { data = JSON.parse(candidate.slice(start, end + 1)); }
    catch { continue; }
    const list = Array.isArray(data?.quiz) ? data.quiz : null;
    if (!list || list.length === 0 || list.length > 10) continue;
    const items = [];
    let valid = true;
    for (const entry of list) {
      const q = cleanString(entry?.q, 2000);
      const answers = Array.isArray(entry?.answer) ? entry.answer : [entry?.answer];
      const cleaned = answers.map(answer => cleanString(answer, 200)).filter(Boolean).slice(0, 5);
      if (!q || cleaned.length === 0) { valid = false; break; }
      items.push({
        q,
        answers: cleaned,
        hint: cleanString(entry?.hint, 500) || '',
        explanation: cleanString(entry?.explanation, 2000) || ''
      });
    }
    if (valid && items.length > 0) return items;
  }
  return null;
}
