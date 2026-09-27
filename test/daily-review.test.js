import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewExplanation, generatedCount, localDay, moreCandidates, moreGeneratedCount, newPlan, publicPlan, reviewCandidates, selectReview, similarPrompt } from '../server/daily-review.js';

function chat(title, attempts, at = '2026-09-01T00:00:00.000Z') {
  return { id: title, title, messages: [{ id: `${title}-quiz`, at, quiz: {
    summary: title, items: [{ q: '1+1', answers: ['2'] }, { q: '2+2', answers: ['4'] }], results: {}, attempts
  } }] };
}

test('誤答の連続・経過日数・全問正解で問題セットの復習優先度が変わる', () => {
  const now = new Date('2026-09-27T00:00:00.000Z');
  const wrong = chat('苦手', [
    { at: '2026-09-01T00:00:00.000Z', items: [false, true], total: 2 },
    { at: '2026-09-10T00:00:00.000Z', items: [false, false], total: 2 }
  ]);
  const mastered = chat('得意', [
    { at: '2026-09-25T00:00:00.000Z', items: [true, true], total: 2 },
    { at: '2026-09-26T00:00:00.000Z', items: [true, true], total: 2 }
  ]);
  const candidates = reviewCandidates([mastered, wrong], now);
  assert.equal(candidates.length, 4);
  assert.ok(candidates.find(x => x.title === '苦手').score > candidates.find(x => x.title === '得意').score);
  assert.ok(candidates.some(x => x.title === '得意'));
  assert.equal(selectReview(candidates, 2)[0].title, '苦手');
});

test('類題数は保存済み問題数とチェックボックスに従い、最大5問', () => {
  assert.equal(generatedCount(0, true), 0);
  assert.equal(generatedCount(1, true), 5);
  assert.equal(generatedCount(4, true), 4);
  assert.equal(generatedCount(10, true), 2);
  assert.equal(generatedCount(12, false), 0);
  assert.equal(moreGeneratedCount(1, true), 5);
  assert.equal(moreGeneratedCount(7, true), 2);
  assert.equal(moreGeneratedCount(10, false), 0);
});

test('追加復習の短時間の正答は今日の復習の優先度・連続正解に影響しない', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const original = chat('数学', [{ source: 'initial', at: '2026-09-10T00:00:00.000Z', items: [false, true], total: 2 }]);
  const initialScore = reviewCandidates([original], now)[0].score;
  original.messages[0].quiz.attempts.push(
    { source: 'more_review', at: '2026-09-27T11:40:00.000Z', items: [true, null], total: 2 },
    { source: 'more_review', at: '2026-09-27T11:50:00.000Z', items: [true, null], total: 2 }
  );
  assert.equal(reviewCandidates([original], now)[0].score, initialScore);
  assert.ok(moreCandidates([original], now)[0].score < initialScore);
  assert.equal(moreCandidates([original], new Date('2026-10-01T12:00:00.000Z'))[0].score, reviewCandidates([original], new Date('2026-10-01T12:00:00.000Z'))[0].score);
});

test('今日の復習は日付が変わると新しいセッションになる', () => {
  const candidates = reviewCandidates([chat('数学', [])]);
  const today = newPlan({ candidates, includeAi: false, now: new Date(2026, 8, 27) });
  const tomorrow = newPlan({ candidates, includeAi: false, now: new Date(2026, 8, 28) });
  assert.equal(today.day, localDay(new Date(2026, 8, 27)));
  assert.notEqual(today.day, tomorrow.day);
  assert.notEqual(today.id, tomorrow.id);
  assert.equal(newPlan({ candidates, includeAi: true, kind: 'more' }).items.length, 2);
});

test('同程度の優先度なら異なる内容を選び、強い優先度差は維持する', () => {
  const candidates = [
    { category: '数学', score: 20 }, { category: '数学', score: 20 },
    { category: '英語', score: 20 }, { category: '理科', score: 29 }
  ];
  const selected = selectReview(candidates, 3);
  assert.deepEqual(selected.map(item => item.category), ['理科', '数学', '英語']);
});

test('AI類題の元は複数の問題セットから選び、公開計画に正答を含めない', () => {
  const candidates = reviewCandidates([chat('A', []), chat('B', [])]);
  const plan = newPlan({ candidates, includeAi: true });
  const prompt = similarPrompt(plan.items, 2);
  assert.match(prompt, /要約: A/);
  assert.match(prompt, /要約: B/);
  assert.equal(publicPlan(plan).items[0].quiz.answers, undefined);
});

test('復習の説明は要約の範囲で4～5行に整える', () => {
  const items = [{ summary: '分数の大小を比べる。' }];
  const text = formatReviewExplanation('今日は分数を確認します。大小を比べます。', items);
  assert.equal(text.split('\n').length, 4);
  assert.match(text, /分数の大小/);
});
