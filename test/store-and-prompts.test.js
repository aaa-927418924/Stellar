import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { buildPrompt, extractHtml } from '../server/prompts.js';

test('教材HTMLだけを取り出し、不完全な応答は拒否する', () => {
  const source = '```html\n<!doctype html><html><head><title>学習</title></head><body><h1>教材</h1></body></html>\n```';
  assert.equal(extractHtml(source), '<!doctype html><html><head><title>学習</title></head><body><h1>教材</h1></body></html>');
  assert.throws(() => extractHtml('<html><body>途中'), /完成したHTML/);
});

test('会話と教材を再読込でき、別のチャットは混ざらない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-app-test-'));
  try {
    const store = new Store(root);
    await store.init();
    const first = await store.create();
    const second = await store.create();
    first.title = '一次関数';
    first.messages.push({ role: 'user', text: '傾き' });
    first.lesson = true;
    await store.save(first);
    await store.saveLesson(first.id, '<!doctype html><html>教材</html>');
    assert.equal((await store.get(first.id)).messages[0].text, '傾き');
    assert.equal(await store.lesson(first.id), '<!doctype html><html>教材</html>');
    assert.equal(await store.lesson(second.id), null);
    assert.equal((await store.list()).length, 2);
    assert.throws(() => store.chatPath('../outside'), /不正/);
    await store.saveSettings({ model: 'opencode/example' });
    assert.equal((await store.settings()).model, 'opencode/example');
    await store.saveSettings({ model: 'openai/example' });
    await store.saveLesson(first.id, '<!doctype html><html>更新版</html>');
    assert.equal((await store.settings()).model, 'openai/example');
    assert.equal(await store.lesson(first.id), '<!doctype html><html>更新版</html>');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('質問の指示には現在の教材が含まれる', () => {
  const chat = { messages: [{ role: 'user', text: '一次関数' }] };
  const prompt = buildPrompt({ chat, text: '傾きは？', action: 'ask', lesson: '<html><style>x</style><body><p>y=ax+b</p></body></html>' });
  assert.match(prompt, /y=ax\+b/);
  assert.doesNotMatch(prompt, /<style>/);
  assert.match(prompt, /傾きは？/);
});

test('添付ファイルをバイナリのまま保存・取得・削除する', async () => {
  const { randomUUID } = await import('node:crypto');
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-app-attach-'));
  try {
    const store = new Store(root);
    await store.init();
    const chatId = randomUUID();
    const messageId = randomUUID();
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    await store.saveAttachment(chatId, messageId, 'png', bytes);
    assert.deepEqual(await store.attachment(chatId, messageId, 'png'), bytes);
    assert.equal(await store.attachment(chatId, messageId, 'jpg'), null);
    assert.throws(() => store.attachmentName('../x', messageId, 'png'), /不正/);
    await store.delete(chatId);
    assert.equal(await store.attachment(chatId, messageId, 'png'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('質問専用と整理用の指示が作れる', () => {
  const chat = { messages: [{ role: 'user', text: '分数が苦手' }] };
  const question = buildPrompt({ chat, text: '通分とは？', action: 'question', lesson: null });
  assert.match(question, /通分とは？/);
  assert.match(question, /分数が苦手/);
  const organize = buildPrompt({ chat, text: '教材用のプロンプトを作って', action: 'organize', lesson: null });
  assert.match(organize, /1～2行/);
  assert.match(organize, /分数が苦手/);
});
