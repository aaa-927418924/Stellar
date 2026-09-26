import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, parseModelList } from '../server/opencode.js';

test('既定モデルはMuse Sparkである', () => {
  assert.equal(DEFAULT_MODEL, 'opencode/muse-spark-1.3-contributor-free');
  assert.match(DEFAULT_MODEL, /^[\w.-]+\/[\w.-]+$/);
});

test('モデル一覧からprovider/modelだけを取り出す', () => {
  const raw = 'opencode/big-pickle\n\nopenai/gpt-5.4\nただの説明文\nopencode/big-pickle\n';
  assert.deepEqual(parseModelList(raw), ['opencode/big-pickle', 'openai/gpt-5.4']);
  assert.deepEqual(parseModelList(''), []);
});
