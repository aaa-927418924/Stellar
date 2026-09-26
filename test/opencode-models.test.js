import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, findOpenCode, parseModelList } from '../server/opencode.js';

test('既定モデルはMuse Sparkである', () => {
  assert.equal(DEFAULT_MODEL, 'opencode/muse-spark-1.3-contributor-free');
  assert.match(DEFAULT_MODEL, /^[\w.-]+\/[\w.-]+$/);
});

test('モデル一覧からprovider/modelだけを取り出す', () => {
  const raw = 'opencode/big-pickle\n\nopenai/gpt-5.4\nただの説明文\nopencode/big-pickle\n';
  assert.deepEqual(parseModelList(raw), ['opencode/big-pickle', 'openai/gpt-5.4']);
  assert.deepEqual(parseModelList(''), []);
});

test('OpenCode実行ファイルの有無を判定する', () => {
  const saved = { exe: process.env.STUDY_OPENCODE_EXE, path: process.env.PATH, appdata: process.env.APPDATA };
  try {
    process.env.STUDY_OPENCODE_EXE = process.execPath;
    assert.equal(findOpenCode(), process.execPath);
    process.env.STUDY_OPENCODE_EXE = 'C:\\definitely\\not\\here\\opencode.exe';
    process.env.APPDATA = 'C:\\definitely\\not\\here';
    process.env.PATH = '';
    assert.equal(findOpenCode(), null);
  } finally {
    if (saved.exe === undefined) delete process.env.STUDY_OPENCODE_EXE;
    else process.env.STUDY_OPENCODE_EXE = saved.exe;
    process.env.PATH = saved.path;
    process.env.APPDATA = saved.appdata;
  }
});
