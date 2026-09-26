import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { buildPrompt, extractHtml } from './prompts.js';
import { runOpenCode, listModels, findOpenCode, DEFAULT_MODEL } from './opencode.js';
import { appendProgress, progressFromEvent } from './progress.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const packaged = /[\\/]caxa[\\/]/.test(process.argv[1] || '') || /[\\/]caxa[\\/]/.test(process.execPath);
const dataRoot = packaged && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'StudyApp', 'data')
  : path.join(root, 'data');
const store = new Store(dataRoot);
const instancePath = path.join(store.root, 'instance.json');
let appVersion = '';
try { appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; } catch { /* ignore */ }
const launchSecret = randomBytes(32).toString('hex');
const active = new Map();
const MAX_BODY = 60_000_000;
const MAX_ATTACHMENTS = 5;
let modelCache = { at: 0, models: [] };
let opencodeStatus = { ok: false, path: null };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function thumbnailExtension(message) {
  if (!message?.image) return null;
  const fromType = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[message.fileType];
  if (fromType) return fromType;
  const fromName = /\.([A-Za-z0-9]{1,10})$/.exec(message.file || '');
  const extension = (fromName || [])[1]?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? extension : null;
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
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, lesson: chat.lesson, mode: chat.mode || null, messageCount: chat.messages.length, jobStatus: chat.job?.status || null, lastMessageFailed: !!chat.messages.at(-1)?.failed };
}

export function attachmentFromPayload(payload) {
  if (!payload) return null;
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(payload.data || '');
  if (!match) throw Object.assign(new Error('ファイルを読み取れませんでした。'), { status: 400 });
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > 8_000_000) throw Object.assign(new Error('ファイルは8MB以下にしてください。'), { status: 413 });
  const name = String(payload.name || 'file').slice(0, 120);
  const extension = ((/\.([A-Za-z0-9]{1,10})$/.exec(name) || [])[1] || 'bin').toLowerCase();
  return { bytes, extension, name, type: String(payload.type || '') };
}

async function runJob({ chat, text, action, model, attachments, lesson, controller }) {
  let promptFile;
  const attachmentFiles = (attachments || []).map(item =>
    path.join(store.attachmentsDir, store.attachmentName(chat.id, item.messageId, item.extension)));
  let writes = Promise.resolve();
  const persist = () => { writes = writes.catch(() => {}).then(() => store.save(chat)); return writes; };
  const record = (type, value) => { appendProgress(chat, type, value); void persist().catch(error => console.error('進行履歴の保存に失敗:', error)); };
  try {
    const prompt = buildPrompt({ chat: { ...chat, messages: chat.messages.slice(0, -1) }, text, action, lesson });
    promptFile = path.join(store.tmpDir, `${randomUUID()}.txt`);
    await writeFile(promptFile, prompt, 'utf8');
    record('status', 'OpenCodeを起動しました。');
    const result = await runOpenCode({ promptFile, attachments: attachmentFiles, model: model || DEFAULT_MODEL, cwd: root, signal: controller.signal,
      onText: fragment => {
        if ((action === 'ask' || action === 'question' || action === 'organize') && chat.job) {
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
        const progress = progressFromEvent(event, chat);
        if (chat.job && progress) record(progress.type, progress.text, progress.detail);
      }
    });
    await writes;
    let response = result.trim();
    let organizePrompt = false;
    if (action === 'create' || action === 'revise') {
      const html = extractHtml(result);
      await store.saveLesson(chat.id, html);
      chat.lesson = true;
      chat.lessonUpdatedAt = new Date().toISOString();
      response = action === 'create' ? '教材を作成しました。右側のプレビューで学習・問題モードを試せます。' : '教材を更新しました。右側のプレビューに反映しました。';
    } else if (action === 'organize') {
      response = response.slice(0, 500);
      organizePrompt = true;
    }
    appendProgress(chat, 'status', '完了しました。');
    chat.messages.push({ id: randomUUID(), role: 'assistant', text: response, ...(organizePrompt ? { organizePrompt: true } : {}), progress: chat.job.progress, at: new Date().toISOString() });
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
    if (promptFile) await unlink(promptFile).catch(() => {});
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
  if (!['create', 'ask', 'revise', 'question', 'organize'].includes(action)) return fail(res, 400, '操作を選択してください。');
  if (action === 'question' && chat.messages.length > 0 && chat.mode !== 'question') return fail(res, 400, 'この操作は新規チャットでのみ選べます。');
  if (action === 'organize' && chat.mode !== 'question') return fail(res, 400, 'この操作は質問用チャットでのみ使えます。');
  if ((action === 'ask' || action === 'revise') && !chat.lesson) return fail(res, 400, '先に教材を作成してください。');
  if (action === 'create' && chat.mode === 'question') return fail(res, 400, '質問用チャットでは教材を作れません。');
  if (model && (!/^[\w.-]+\/[\w.-]+$/.test(model) || model.length > 120)) return fail(res, 400, 'モデル名は provider/model の形式で入力してください。');
  const rawAttachments = [];
  if (payload.image) rawAttachments.push(payload.image);
  if (Array.isArray(payload.images)) rawAttachments.push(...payload.images);
  if (rawAttachments.length > MAX_ATTACHMENTS) return fail(res, 400, '添付は5件までにしてください。');
  const attachments = rawAttachments.map(item => attachmentFromPayload(item));
  const lesson = chat.lesson ? await store.lesson(id) : null;
  const messageId = randomUUID();
  const files = [];
  for (const attachment of attachments) {
    const fileId = randomUUID();
    await store.saveAttachment(id, fileId, attachment.extension, attachment.bytes);
    files.push({ id: fileId, name: attachment.name, type: String(attachment.type || ''), ext: attachment.extension });
    attachment.messageId = fileId;
  }
  chat.messages.push({ id: messageId, role: 'user', text, action, image: files.length > 0, file: files[0]?.name || null, fileType: files[0]?.type || null, attachments: files, at: new Date().toISOString() });
  if (chat.messages.length === 1) {
    chat.title = text.slice(0, 36);
    if (!chat.mode) chat.mode = action === 'question' ? 'question' : 'lesson';
  }
  const now = new Date().toISOString();
  chat.job = { id: randomUUID(), status: 'running', action, model, startedAt: now, updatedAt: now, outputChars: 0, partialAnswer: '', progress: [{ type: 'status', text: '生成を開始しました。', at: now }] };
  await store.save(chat);
  const controller = new AbortController();
  active.set(id, controller);
  void runJob({ chat, text, action, model, attachments, lesson, controller }).catch(error => console.error('生成ジョブが停止しました:', error));
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
      if (req.method === 'GET' && url.pathname === '/md.js') return staticFile(res, 'md.js', 'text/javascript');
      if (req.method === 'GET' && url.pathname === '/api/chats') return json(res, 200, (await store.list()).map(summary));
      if (req.method === 'POST' && url.pathname === '/api/chats') return json(res, 201, await store.create());
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return json(res, 200, { ...(await store.settings()), opencodeOk: opencodeStatus.ok, opencodePath: opencodeStatus.path, version: appVersion });
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        if (Date.now() - modelCache.at > 600_000) {
          modelCache = { at: Date.now(), models: await listModels({ cwd: root }) };
        }
        return json(res, 200, { default: DEFAULT_MODEL, models: modelCache.models });
      }
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
      if (req.method === 'DELETE' && chatMatch) {
        const chat = await store.get(chatMatch[1]);
        if (!chat) return fail(res, 404, 'チャットが見つかりません。');
        if (active.has(chatMatch[1]) || chat.job) return fail(res, 409, '処理中のチャットは削除できません。');
        await store.delete(chatMatch[1]);
        return json(res, 200, { status: 'deleted' });
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
      const attachmentMatch = /^\/api\/chats\/([0-9a-f-]{36})\/attachment\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && attachmentMatch) {
        const chat = await store.get(attachmentMatch[1]);
        let extension = null;
        if (chat) {
          for (const item of chat.messages) {
            const found = (item.attachments || []).find(file => file.id === attachmentMatch[2]);
            if (found && /^[A-Za-z0-9]{1,10}$/.test(found.ext || '')) {
              extension = found.ext.toLowerCase();
              break;
            }
          }
          if (!extension) {
            const legacy = chat.messages.find(item => item.id === attachmentMatch[2]);
            extension = thumbnailExtension(legacy);
          }
        }
        const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
        if (!extension || !imageTypes[extension]) return fail(res, 404, '添付ファイルが見つかりません。');
        const bytes = await store.attachment(attachmentMatch[1], attachmentMatch[2], extension);
        if (!bytes) return fail(res, 404, '添付ファイルが見つかりません。');
        res.writeHead(200, { 'Content-Type': imageTypes[extension], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(bytes);
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
    // 初回起動時のウェルカム画面が --app ウィンドウを空白にするため抑止する。
    const edgeArgs = [`--app=${url}`, '--window-size=1320,850', '--no-first-run', '--no-default-browser-check'];
    if (existsSync(edge)) return spawn(edge, edgeArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
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
  const found = findOpenCode();
  opencodeStatus = { ok: !!found, path: found };
  if (!found) console.error('OpenCode CLIが見つかりません。教材生成には `npm install -g opencode-ai` が必要です。');
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
