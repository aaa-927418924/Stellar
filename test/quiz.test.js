import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAttempts, judgeAnswer, legacyAttempt, normalizeAnswer, parseQuiz } from '../server/quiz.js';

test('回答の表記ゆれを吸収する', () => {
  assert.equal(normalizeAnswer('  2  '), '2');
  assert.equal(normalizeAnswer('２'), '2');
  assert.equal(normalizeAnswer('ABC'), 'abc');
  assert.ok(judgeAnswer(' 2 ', ['2', '二']));
  assert.ok(!judgeAnswer('', ['2']));
  assert.ok(!judgeAnswer('3', ['2']));
});

test('問題JSONを取り出す', () => {
  const parsed = parseQuiz('```json\n{"quiz": [{"q": "1+1は？", "answer": ["2"], "hint": "指で数える", "explanation": "1に1を足すと2"}], "summary": "足し算の基礎"}\n```');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].q, '1+1は？');
  assert.deepEqual(parsed.items[0].answers, ['2']);
  assert.equal(parsed.items[0].hint, '指で数える');
  assert.equal(parsed.summary, '足し算の基礎');
  const raw = parseQuiz('{"quiz": [{"q": "a", "answer": ["b", "c"]}]}');
  assert.deepEqual(raw.items[0].answers, ['b', 'c']);
  assert.equal(raw.summary, '');
  assert.equal(parseQuiz('ただの文章です'), null);
  assert.equal(parseQuiz('{"quiz": []}'), null);
  assert.equal(parseQuiz('{"quiz": [{"q": "", "answer": ["b"]}]}'), null);
  assert.equal(parseQuiz('{"quiz": [{"q": "a", "answer": []}]}'), null);
});

test('履歴の集計と移行ができる', () => {
  const message = {
    at: '2026-09-27T00:00:00.000Z',
    quiz: {
      items: [{ q: 'a', answers: ['1'] }, { q: 'b', answers: ['2'] }],
      results: { 0: { attempts: 2, correct: 1, lastOk: true }, 1: { attempts: 1, correct: 0, lastOk: false } }
    }
  };
  const migrated = legacyAttempt(message);
  assert.equal(migrated.n, 1);
  assert.equal(migrated.source, 'initial');
  assert.deepEqual(migrated.items, [true, false]);
  assert.equal(migrated.correct, 1);
  const stats = aggregateAttempts([migrated, { n: 2, at: '2026-09-28T00:00:00.000Z', source: 'library', total: 2, correct: 2, items: [true, true] }]);
  assert.equal(stats.count, 2);
  assert.equal(stats.lastOk, true);
  assert.equal(stats.lastCorrect, 2);
  assert.equal(stats.lastTotal, 2);
  assert.equal(stats.lastAt, '2026-09-28T00:00:00.000Z');
  assert.deepEqual(aggregateAttempts([]), { count: 0, lastOk: false, lastCorrect: 0, lastTotal: 0, lastAt: null });
  assert.equal(legacyAttempt({ quiz: { items: [], results: {} } }), null);
});
