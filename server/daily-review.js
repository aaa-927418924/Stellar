import { randomUUID } from 'node:crypto';
import { legacyAttempt } from './quiz.js';

export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dayGap(at, now) {
  const time = Date.parse(at || '');
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 86_400_000) : 0;
}

export function reviewCandidates(chats, now = new Date()) {
  const candidates = [];
  for (const chat of chats) for (const message of chat.messages || []) {
    const quiz = message.quiz;
    if (!quiz?.items?.length) continue;
    const attempts = quiz.attempts?.length ? quiz.attempts : [legacyAttempt(message)].filter(Boolean);
    const latest = attempts.at(-1);
    const age = dayGap(latest?.at || message.at, now);
    const lastAnswered = quiz.items.map((_, index) => {
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (typeof attempts[i].items?.[index] === 'boolean') return attempts[i].items[index];
      }
      return null;
    });
    const wrong = lastAnswered.filter(result => result === false).length;
    const recentComplete = [...attempts].reverse().filter(entry => entry.items?.length === quiz.items.length && entry.items.every(value => typeof value === 'boolean'));
    let fullStreak = 0;
    for (const entry of recentComplete) { if (!entry.items.every(Boolean)) break; fullStreak++; }
    const consecutiveWrong = quiz.items.some((_, index) => {
      const lastTwo = [...attempts].reverse().map(entry => entry.items?.[index]).filter(result => typeof result === 'boolean').slice(0, 2);
      return lastTwo.length === 2 && lastTwo.every(result => !result);
    });
    let score = 4 + wrong * 5 + (wrong > 0 && wrong < quiz.items.length ? 3 : 0) + (consecutiveWrong ? 7 : 0);
    if (age >= 30) score += 12;
    else if (age >= 14) score += 8;
    else if (age >= 7) score += 4;
    if (latest?.items?.some(value => value === false)) score += 5;
    if (fullStreak) score -= fullStreak >= 2 ? 12 : 5;
    if (!attempts.length) score += 2;
    const summary = quiz.summary || chat.title;
    const category = String(quiz.category || summary).trim().toLowerCase().slice(0, 70);
    quiz.items.forEach((item, index) => candidates.push({
      kind: 'existing', chatId: chat.id, messageId: message.id, index,
      title: chat.title, summary, category, score: score + (lastAnswered[index] === false ? 4 : 0),
      quiz: { q: item.q, answers: item.answers, hint: item.hint || '', explanation: item.explanation || '' }
    }));
  }
  return candidates;
}

export function selectReview(candidates, limit) {
  const pool = [...candidates];
  const selected = [];
  const topics = new Map();
  while (pool.length && selected.length < limit) {
    pool.sort((a, b) => (b.score - Math.min(3, (topics.get(b.category) || 0) * 2)) - (a.score - Math.min(3, (topics.get(a.category) || 0) * 2)) || b.score - a.score);
    const picked = pool.shift();
    selected.push(picked);
    topics.set(picked.category, (topics.get(picked.category) || 0) + 1);
  }
  return selected;
}

export function generatedCount(existingCount, includeAi) {
  if (!includeAi || existingCount < 1) return 0;
  if (existingCount >= 8) return existingCount >= 11 ? 3 : 2;
  return Math.min(5, 8 - existingCount);
}

export function newPlan({ candidates, includeAi, now = new Date() }) {
  const existingLimit = includeAi ? 10 : 12;
  const selected = selectReview(candidates, existingLimit);
  return { id: randomUUID(), day: localDay(now), includeAi, createdAt: now.toISOString(),
    items: selected, results: {}, explanation: '', status: 'preparing' };
}

export function publicPlan(plan) {
  if (!plan) return null;
  return { id: plan.id, day: plan.day, includeAi: plan.includeAi, explanation: plan.explanation,
    items: plan.items.map(({ quiz, ...item }) => ({ ...item, quiz: { q: quiz.q, hint: quiz.hint, explanation: quiz.explanation } })),
    results: plan.results };
}

export function similarBases(selected, count) {
  const bases = [];
  const seen = new Set();
  const distinct = new Set(selected.map(item => `${item.chatId}:${item.messageId}`)).size;
  for (const item of selected) {
    const key = `${item.chatId}:${item.messageId}`;
    if (seen.has(key) && seen.size < Math.min(count, distinct)) continue;
    seen.add(key);
    bases.push(item);
    if (bases.length === count) break;
  }
  for (const item of selected) { if (bases.length === count) break; if (!bases.includes(item)) bases.push(item); }
  while (bases.length < count) bases.push(selected[bases.length % selected.length]);
  return bases;
}

export function similarPrompt(selected, count) {
  const bases = similarBases(selected, count);
  return `次の保存済み問題と要約だけを根拠に、同じ知識で解ける類題を正確に${count}問作ってください。元問題にない単元・知識は追加しない。数値・条件・状況を変え、答えの暗記では解けない問題にする。答えが一意になるように検算する。各問題は順に対応する元問題の知識を使い、分野を偏らせない。JSONのみを返す。形式: {"quiz":[{"q":"問題文","answer":["正答"],"hint":"ヒント","explanation":"解説"}],"summary":"内容の要約"}\n\n${bases.map((item, i) => `${i + 1}. 要約: ${item.summary.slice(0, 200)}\n元問題: ${item.quiz.q.slice(0, 1500)}\n正答: ${item.quiz.answers.join(' / ').slice(0, 300)}`).join('\n\n')}`;
}

export function explanationPrompt(items) {
  const summaries = [...new Set(items.map(item => item.summary).filter(Boolean))].slice(0, 12);
  return `今日復習する内容を学習者向けの自然な日本語で4～5行にまとめてください。以下の要約に含まれる内容だけを使い、新しい単元・知識・学習内容を足さない。問題の答えや解法は明かさず、前置きや箇条書きの記号なしで説明文だけを返す。\n\n保存済み問題の要約:\n${summaries.map((summary, i) => `${i + 1}. ${summary.slice(0, 200)}`).join('\n')}`;
}

export function formatReviewExplanation(raw, items) {
  const lines = String(raw || '').trim().split(/\r?\n/).flatMap(line => line.split(/(?<=。)/)).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const summaries = [...new Set(items.map(item => item.summary).filter(Boolean))];
  let index = 0;
  while (lines.length < 4 && summaries.length) {
    lines.push(summaries[index % summaries.length]);
    index++;
  }
  return lines.slice(0, 5).join('\n');
}
