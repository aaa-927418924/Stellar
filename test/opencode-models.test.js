import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test('npmがなくてもStellar専用の公式CLI配置を検出する', async () => {
  const previous = { exe: process.env.STUDY_OPENCODE_EXE, appdata: process.env.APPDATA, local: process.env.LOCALAPPDATA, path: process.env.PATH };
  const root = await mkdtemp(path.join(os.tmpdir(), 'stellar-opencode-path-'));
  try {
    const executable = path.join(root, 'Stellar', 'tools', 'opencode', 'opencode.exe');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'test executable');
    delete process.env.STUDY_OPENCODE_EXE;
    process.env.APPDATA = path.join(root, 'no-appdata');
    process.env.LOCALAPPDATA = root;
    process.env.PATH = '';
    assert.equal(findOpenCode(), executable);
  } finally {
    if (previous.exe === undefined) delete process.env.STUDY_OPENCODE_EXE; else process.env.STUDY_OPENCODE_EXE = previous.exe;
    if (previous.appdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous.appdata;
    if (previous.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.local;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    await rm(root, { recursive: true, force: true });
  }
});
