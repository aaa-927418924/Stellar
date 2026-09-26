import test from 'node:test';
import assert from 'node:assert/strict';
import { appendProgress, progressFromEvent } from '../server/progress.js';

test('OpenCodeの公開思考とツール利用だけを経過に変換する', () => {
  assert.deepEqual(progressFromEvent({ type: 'reasoning', part: { type: 'reasoning', text: '図で比べる' } }), { type: 'thought', text: '図で比べる' });
  assert.deepEqual(progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'websearch', state: { input: { query: 'private' } } } }), { type: 'tool', text: 'websearch' });
  assert.equal(progressFromEvent({ type: 'text', part: { type: 'text', text: '<!doctype html>' } }), null);
});

test('思考履歴は保存できるサイズに制限する', () => {
  const chat = { job: { progress: [], updatedAt: '' } };
  for (let index = 0; index < 150; index++) appendProgress(chat, 'thought', `考え ${index}`);
  assert.equal(chat.job.progress.length, 120);
  assert.equal(chat.job.progress[0].text, '考え 30');
  assert.ok(chat.job.updatedAt);
});
