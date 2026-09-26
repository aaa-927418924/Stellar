import test from 'node:test';
import assert from 'node:assert/strict';
import { appendProgress, progressFromEvent } from '../server/progress.js';

test('OpenCodeの公開思考とツール利用だけを経過に変換する', () => {
  assert.deepEqual(progressFromEvent({ type: 'reasoning', part: { type: 'reasoning', text: '図で比べる' } }), { type: 'thought', text: '図で比べる' });
  assert.deepEqual(progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'websearch', state: { input: { query: 'private' } } } }), { type: 'tool', text: 'WebSearch「private」' });
  assert.equal(progressFromEvent({ type: 'text', part: { type: 'text', text: '<!doctype html>' } }), null);
});

test('個々のツール呼び出しを内容付きで記録する', () => {
  assert.deepEqual(
    progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'server/index.js' } } } }),
    { type: 'tool', text: 'Read server/index.js' }
  );
  assert.deepEqual(
    progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, metadata: { exit: 0 }, output: 'ok\n' } } }),
    { type: 'tool', text: '$ npm test → exit 0', detail: 'ok' }
  );
  assert.deepEqual(
    progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'interactive-study' } } } }),
    { type: 'tool', text: 'Skill「interactive-study」' }
  );
  assert.deepEqual(
    progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'exit 1' }, error: 'boom' } } }),
    { type: 'tool', text: '$ exit 1 → 失敗：boom' }
  );
  assert.deepEqual(
    progressFromEvent({ type: 'tool_use', part: { type: 'tool', tool: 'mystery', state: { status: 'completed', input: { a: 1 } } } }),
    { type: 'tool', text: 'mystery [a=1]' }
  );
});

test('思考履歴は保存できるサイズに制限する', () => {
  const chat = { job: { progress: [], updatedAt: '' } };
  for (let index = 0; index < 150; index++) appendProgress(chat, 'thought', `考え ${index}`);
  assert.equal(chat.job.progress.length, 120);
  assert.equal(chat.job.progress[0].text, '考え 30');
  assert.ok(chat.job.updatedAt);
});

test('ツール結果の詳細は上限付きで残る', () => {
  const chat = { job: { progress: [], updatedAt: '' } };
  appendProgress(chat, 'tool', '$ npm test → exit 0', 'x'.repeat(5000));
  assert.equal(chat.job.progress[0].detail.length, 2000);
  appendProgress(chat, 'tool', 'Read a');
  assert.equal(chat.job.progress[1].detail, undefined);
});
