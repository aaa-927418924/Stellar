import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { buildPrompt, extractHtml } from './prompts.js';
import { runOpenCode } from './opencode.js';
import { appendProgress, progressFromEvent } from './progress.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const packaged = /[\\/]caxa[\\/]/.test(process.argv[1] || '') || /[\\/]caxa[\\/]/.test(process.execPath);
const dataRoot = packaged && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'StudyApp', 'data')
  : path.join(root, 'data');
const store = new Store(dataRoot);
const instancePath = path.join(store.root, 'instance.json');
const launchSecret = randomBytes(32).toString('hex');
const active = new Map();
const MAX_BODY = 12_000_000;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function fail(res, status, message) { json(res, status, { error: message }); }

async function body(req) {
  let chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('送信できるサイズを超えました。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('送信データを読み取れませんでした。'), { status: 400 }); }
}

function cookie(req) {
  return req.headers.cookie?.split(';').map(part => part.trim()).includes(`study_session=${launchSecret}`);
}

function setHeaders(res, preview = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', preview
    ? "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'");
}

async function staticFile(res, name, type) {
  const file = path.join(publicDir, name);
  setHeaders(res);
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(await readFile(file));
}

function summary(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, lesson: chat.lesson, messageCount: chat.messages.length, jobStatus: chat.job?.status || null, lastMessageFailed: !!chat.messages.at(-1)?.failed };
}

function attachmentFromPayload(payload) {
  if (!payload) return null;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(payload.type)) throw Object.assign(new Error('PNG、JPEG、WebP、GIF画像だけ添付できます。'), { status: 400 });
  const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(payload.data || '');
  if (!match) throw Object.assign(new Error('画像を読み取れませんでした。'), { status: 400 });
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > 8_000_000) throw Object.assign(new Error('画像は8MB以下にしてください。'), { status: 413 });
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[payload.type];
  return { bytes, extension };
}

async function runJob({ chat, text, action, model, attachment, lesson, controller }) {
  let promptFile;
  let imageFile;
  let writes = Promise.resolve();
  const persist = () => { writes = writes.catch(() => {}).then(() => store.save(chat)); return writes; };
  const record = (type, value) => { appendProgress(chat, type, value); void persist().catch(error => console.error('進行履歴の保存に失敗:', error)); };
  try {
    const prompt = buildPrompt({ chat: { ...chat, messages: chat.messages.slice(0, -1) }, text, action, lesson });
    promptFile = path.join(store.tmpDir, `${randomUUID()}.txt`);
    await writeFile(promptFile, prompt, 'utf8');
    if (attachment) {
      imageFile = path.join(store.tmpDir, `${randomUUID()}.${attachment.extension}`);
      await writeFile(imageFile, attachment.bytes);
    }
    record('status', 'OpenCodeを起動しました。');
    const result = await runOpenCode({ promptFile, attachment: imageFile, model, cwd: root, signal: controller.signal,
      onText: fragment => {
        if (action === 'ask' && chat.job) {
          chat.job.partialAnswer = (chat.job.partialAnswer + fragment).slice(0, 80000);
          chat.job.updatedAt = new Date().toISOString();
          void persist().catch(error => console.error('回答途中の保存に失敗:', error));
        } else if (chat.job) {
          chat.job.outputChars += fragment.length;
          chat.job.updatedAt = new Date().toISOString();
          void persist().catch(error => console.error('生成状態の保存に失敗:', error));
        }
      },
      onEvent: event => {
        const progress = progressFromEvent(event);
        if (chat.job && progress) record(progress.type, progress.text);
      }
    });
    await writes;
    let response = result.trim();
    if (action !== 'ask') {
      const html = extractHtml(result);
      await store.saveLesson(chat.id, html);
      chat.lesson = true;
      chat.lessonUpdatedAt = new Date().toISOString();
      response = action === 'create' ? '教材を作成しました。右側のプレビューで学習・問題モードを試せます。' : '教材を更新しました。右側のプレビューに反映しました。';
    }
    appendProgress(chat, 'status', '完了しました。');
    chat.messages.push({ id: randomUUID(), role: 'assistant', text: response, progress: chat.job.progress, at: new Date().toISOString() });
    chat.job = null;
    await store.save(chat);
  } catch (error) {
    await writes.catch(() => {});
    const message = controller.signal.aborted ? '生成を中止しました。' : `生成できませんでした。${(error.message || '処理に失敗しました。').slice(0, 700)}`;
    appendProgress(chat, 'status', message);
    chat.messages.push({ id: randomUUID(), role: 'assistant', text: message, failed: true, progress: chat.job?.progress || [], at: new Date().toISOString() });
    chat.job = null;
    await store.save(chat);
  } finally {
    active.delete(chat.id);
    await Promise.allSettled([promptFile, imageFile].filter(Boolean).map(file => unlink(file)));
  }
}

async function send(req, res, id) {
  const chat = await store.get(id);
  if (!chat) return fail(res, 404, 'チャットが見つかりません。');
  if (active.has(id) || chat.job) return fail(res, 409, 'このチャットでは処理が進行中です。');
  const payload = await body(req);
  const text = String(payload.text || '').trim();
  const action = payload.action;
  const model = String(payload.model || '').trim();
  if (!text || text.length > 5000) return fail(res, 400, 'メッセージは1～5000文字で入力してください。');
  if (!['create', 'ask', 'revise'].includes(action)) return fail(res, 400, '操作を選択してください。');
  if (action !== 'create' && !chat.lesson) return fail(res, 400, '先に教材を作成してください。');
  if (model && (!/^[\w.-]+\/[\w.-]+$/.test(model) || model.length > 120)) return fail(res, 400, 'モデル名は provider/model の形式で入力してください。');
  const attachment = attachmentFromPayload(payload.image);
  const lesson = chat.lesson ? await store.lesson(id) : null;
  chat.messages.push({ id: randomUUID(), role: 'user', text, action, image: !!attachment, at: new Date().toISOString() });
  if (chat.messages.length === 1) chat.title = text.slice(0, 36);
  const now = new Date().toISOString();
  chat.job = { id: randomUUID(), status: 'running', action, model, startedAt: now, updatedAt: now, outputChars: 0, partialAnswer: '', progress: [{ type: 'status', text: '生成を開始しました。', at: now }] };
  await store.save(chat);
  const controller = new AbortController();
  active.set(id, controller);
  void runJob({ chat, text, action, model, attachment, lesson, controller }).catch(error => console.error('生成ジョブが停止しました:', error));
  return json(res, 202, chat);
}

export async function createServer() {
  await store.init();
  for (const chat of await store.list()) {
    if (chat.job?.status === 'running') {
      appendProgress(chat, 'status', 'アプリが終了したため生成が中断しました。');
      chat.messages.push({ id: randomUUID(), role: 'assistant', text: 'アプリが終了したため生成が中断しました。もう一度送信してください。', failed: true, progress: chat.job.progress, at: new Date().toISOString() });
      chat.job = null;
      await store.save(chat);
    }
  }
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host)) return fail(res, 403, 'ローカル接続だけ利用できます。');
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/' && url.searchParams.get('launch') === launchSecret) {
        res.writeHead(302, { 'Set-Cookie': `study_session=${launchSecret}; HttpOnly; SameSite=Strict; Path=/`, 'Location': '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (!cookie(req)) return fail(res, 403, 'アプリの起動ウィンドウから開いてください。');
      if (req.method !== 'GET' && req.headers.origin !== `http://${host}`) return fail(res, 403, 'この画面からの操作だけ受け付けます。');
      if (req.method === 'GET' && url.pathname === '/') return staticFile(res, 'index.html', 'text/html');
      if (req.method === 'GET' && url.pathname === '/style.css') return staticFile(res, 'style.css', 'text/css');
      if (req.method === 'GET' && url.pathname === '/app.js') return staticFile(res, 'app.js', 'text/javascript');
      if (req.method === 'GET' && url.pathname === '/api/chats') return json(res, 200, (await store.list()).map(summary));
      if (req.method === 'POST' && url.pathname === '/api/chats') return json(res, 201, await store.create());
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, await store.settings());
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const settings = await body(req);
        const model = String(settings.model || '').trim();
        if (model && (!/^[\w.-]+\/[\w.-]+$/.test(model) || model.length > 120)) return fail(res, 400, 'モデル名は provider/model の形式で入力してください。');
        await store.saveSettings({ model });
        return json(res, 200, { model });
      }
      const chatMatch = /^\/api\/chats\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && chatMatch) {
        const chat = await store.get(chatMatch[1]);
        return chat ? json(res, 200, chat) : fail(res, 404, 'チャットが見つかりません。');
      }
      const sendMatch = /^\/api\/chats\/([0-9a-f-]{36})\/send$/.exec(url.pathname);
      if (req.method === 'POST' && sendMatch) return send(req, res, sendMatch[1]);
      const cancelMatch = /^\/api\/chats\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
      if (req.method === 'POST' && cancelMatch) {
        const controller = active.get(cancelMatch[1]);
        if (!controller) return fail(res, 404, '進行中の生成はありません。');
        controller.abort();
        return json(res, 202, { status: 'stopping' });
      }
      const lessonMatch = /^\/api\/chats\/([0-9a-f-]{36})\/lesson$/.exec(url.pathname);
      if (req.method === 'GET' && lessonMatch) {
        const html = await store.lesson(lessonMatch[1]);
        if (!html) return fail(res, 404, '教材が見つかりません。');
        const download = url.searchParams.has('download');
        setHeaders(res, !download);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          ...(download ? { 'Content-Disposition': `attachment; filename="study-${lessonMatch[1]}.html"` } : {}) });
        return res.end(html);
      }
      return fail(res, 404, 'ページが見つかりません。');
    } catch (error) {
      if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : '内部エラーが起きました。');
      else res.end();
      console.error(error);
    }
  });
}

function openWindow(url) {
  if (process.env.STUDY_NO_BROWSER === '1') { console.log(`起動URL: ${url}`); return; }
  if (process.platform === 'win32') {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (existsSync(edge)) return spawn(edge, [`--app=${url}`, '--window-size=1320,850'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function runningInstance() {
  try {
    const instance = JSON.parse(await readFile(instancePath, 'utf8'));
    if (!Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65535 || !/^[0-9a-f]{64}$/.test(instance.secret)) return null;
    const url = `http://127.0.0.1:${instance.port}/?launch=${instance.secret}`;
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1200) });
    return response.status === 302 ? url : null;
  } catch { return null; }
}

function cleanupInstance() {
  try {
    const current = JSON.parse(readFileSync(instancePath, 'utf8'));
    if (current.secret === launchSecret) unlinkSync(instancePath);
  } catch { /* 他プロセスの起動情報は消さない */ }
}

async function main() {
  await store.init();
  const existing = await runningInstance();
  if (existing) {
    console.log('Study App は既に起動しています。既存のウィンドウを開きます。');
    openWindow(existing);
    return;
  }
  process.on('exit', cleanupInstance);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  const server = await createServer();
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/?launch=${launchSecret}`;
    await writeFile(instancePath, JSON.stringify({ pid: process.pid, port: address.port, secret: launchSecret }), { mode: 0o600 });
    console.log(`Study App: http://127.0.0.1:${address.port}/`);
    openWindow(url);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
