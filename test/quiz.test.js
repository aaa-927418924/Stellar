import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeAnswer, normalizeAnswer, parseQuiz } from '../server/quiz.js';

test('回答の表記ゆれを吸収する', () => {
  assert.equal(normalizeAnswer('  2  '), '2');
  assert.equal(normalizeAnswer('２'), '2');
  assert.equal(normalizeAnswer('ABC'), 'abc');
  assert.ok(judgeAnswer(' 2 ', ['2', '二']));
  assert.ok(!judgeAnswer('', ['2']));
  assert.ok(!judgeAnswer('3', ['2']));
});

test('問題JSONを取り出す', () => {
  const items = parseQuiz('```json\n{"quiz": [{"q": "1+1は？", "answer": ["2"], "hint": "指で数える", "explanation": "1に1を足すと2"}]}\n```');
  assert.equal(items.length, 1);
  assert.equal(items[0].q, '1+1は？');
  assert.deepEqual(items[0].answers, ['2']);
  assert.equal(items[0].hint, '指で数える');
  const raw = parseQuiz('{"quiz": [{"q": "a", "answer": ["b", "c"]}]}');
  assert.deepEqual(raw[0].answers, ['b', 'c']);
  assert.equal(parseQuiz('ただの文章です'), null);
  assert.equal(parseQuiz('{"quiz": []}'), null);
  assert.equal(parseQuiz('{"quiz": [{"q": "", "answer": ["b"]}]}'), null);
  assert.equal(parseQuiz('{"quiz": [{"q": "a", "answer": []}]}'), null);
});
