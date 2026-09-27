import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { buildPrompt, extractHtml } from './prompts.js';
import { aggregateAttempts, judgeAnswer, legacyAttempt, parseQuiz } from './quiz.js';
import { runOpenCode, listModels, findOpenCode, installOfficialOpenCode, DEFAULT_MODEL } from './opencode.js';
import { appendProgress, progressFromEvent } from './progress.js';
import { explanationPrompt, formatReviewExplanation, generatedCount, localDay, moreCandidates, moreGeneratedCount, newPlan, publicPlan, reviewCandidates, similarBases, similarPrompt } from './daily-review.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const packaged = /[\\/]caxa[\\/]/.test(process.argv[1] || '') || /[\\/]caxa[\\/]/.test(process.execPath);
const dataRoot = packaged && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Stellar', 'data')
  : path.join(root, 'data');
const store = new Store(dataRoot);
const instancePath = path.join(store.root, 'instance.json');
let appVersion = '';
try { appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; } catch { /* ignore */ }
const launchSecret = randomBytes(32).toString('hex');
const active = new Map();
const liveJobs = new Map();
const preparingReviews = new Map();

function completedReview(plan) {
  return !!plan?.items?.length && Object.keys(plan.results || {}).length === plan.items.length;
}
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
  return { id: chat.id, title: chat.title, pinned: !!chat.pinned, createdAt: chat.createdAt, updatedAt: chat.updatedAt, lesson: chat.lesson, mode: chat.mode || null, messageCount: chat.messages.length, jobStatus: chat.job?.status || null, lastMessageFailed: !!chat.messages.at(-1)?.failed };
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

async function reviewAi(prompt) {
  const promptFile = path.join(store.tmpDir, `${randomUUID()}.txt`);
  await writeFile(promptFile, prompt, 'utf8');
  try {
    const model = (await store.settings()).model || DEFAULT_MODEL;
    return await runOpenCode({ promptFile, model, cwd: root, signal: AbortSignal.timeout(180_000) });
  } catch (error) {
    throw Object.assign(new Error(`AIによる復習の準備に失敗しました。${String(error.message || '').slice(0, 250)}`), { status: 502 });
  } finally { await unlink(promptFile).catch(() => {}); }
}

async function fillReviewPlan(plan, count) {
  if (count) {
    const parsed = parseQuiz(await reviewAi(similarPrompt(plan.items, count)));
    if (!parsed || parsed.items.length !== count || parsed.items.some(item => plan.items.some(original => original.quiz.q === item.q))) {
      throw Object.assign(new Error('類題を確認できませんでした。もう一度準備してください。'), { status: 502 });
    }
    const bases = similarBases(plan.items, count);
    parsed.items.forEach((quiz, index) => {
      const base = bases[index % bases.length];
      plan.items.splice(Math.min(plan.items.length, 2 + index * 4), 0, { kind: 'ai_review', source: 'ai_review', id: randomUUID(), title: base.title,
        summary: base.summary, category: base.category, origin: { chatId: base.chatId, messageId: base.messageId, index: base.index }, quiz });
    });
  }
  const description = formatReviewExplanation(await reviewAi(explanationPrompt(plan.items)), plan.items);
  if (!description) throw Object.assign(new Error('復習内容の説明を生成できませんでした。'), { status: 502 });
  plan.explanation = description;
  plan.status = 'ready';
  return plan;
}

async function prepareReview(includeAi) {
  const day = localDay();
  const cached = await store.dailyReview(day);
  if (cached) return cached;
  const key = `today:${day}`;
  if (preparingReviews.has(key)) return preparingReviews.get(key);
  const task = (async () => {
    const candidates = reviewCandidates(await store.list());
    if (!candidates.length) throw Object.assign(new Error('まだ復習できる問題がありません。まずは問題を作成して解いてみましょう。'), { status: 409 });
    const plan = newPlan({ candidates, includeAi });
    await fillReviewPlan(plan, generatedCount(plan.items.length, includeAi));
    await store.saveReview(plan);
    return plan;
  })();
  preparingReviews.set(key, task);
  try { return await task; }
  finally { preparingReviews.delete(key); }
}

async function prepareMoreReview(id, includeAi) {
  const existing = await store.moreReview(id);
  if (existing) return existing;
  const key = `more:${id}`;
  if (preparingReviews.has(key)) return preparingReviews.get(key);
  const task = (async () => {
    if (!completedReview(await store.dailyReview(localDay()))) {
      throw Object.assign(new Error('今日の復習を終えてから利用できます。'), { status: 409 });
    }
    const candidates = moreCandidates(await store.list());
    if (!candidates.length) throw Object.assign(new Error('まだ復習できる問題がありません。まずは問題を作成して解いてみましょう。'), { status: 409 });
    const plan = newPlan({ candidates, includeAi, kind: 'more' });
    plan.id = id;
    await fillReviewPlan(plan, moreGeneratedCount(plan.items.length, includeAi));
    await store.saveMoreReview(plan);
    return plan;
  })();
  preparingReviews.set(key, task);
  try { return await task; }
  finally { preparingReviews.delete(key); }
}

async function recordQuizAnswer(chat, message, payload) {
  const index = Number(payload.index);
  const text = String(payload.text || '');
  const source = ['initial', 'library', 'review', 'more_review'].includes(payload.source) ? payload.source : 'initial';
  const session = /^[0-9a-f-]{36}$/i.test(payload.session || '') ? payload.session : null;
  const item = message.quiz.items[index];
  if (!Number.isInteger(index) || !item || !text.trim() || text.length > 500) throw Object.assign(new Error('回答は1～500文字で入力してください。'), { status: 400 });
  const ok = judgeAnswer(text, item.answers);
  const current = message.quiz.results[index] || { attempts: 0, correct: 0 };
  const entry = { attempts: current.attempts + 1, correct: current.correct + (ok ? 1 : 0), lastOk: ok, lastAnswer: text };
  const attempts = Array.isArray(message.quiz.attempts) ? [...message.quiz.attempts] : [];
  if (attempts.length === 0) {
    const migrated = legacyAttempt(message);
    if (migrated) attempts.push(migrated);
  }
  const ongoing = session && attempts.find(attempt => attempt.session === session && attempt.source === source);
  if (ongoing) {
    ongoing.items = message.quiz.items.map((_, i) => i === index ? ok : (ongoing.items?.[i] ?? null));
    ongoing.at = new Date().toISOString();
    ongoing.correct = ongoing.items.filter(value => value === true).length;
  } else {
    const items = message.quiz.items.map((_, i) => i === index ? ok : null);
    attempts.push({ n: attempts.length + 1, at: new Date().toISOString(), source, session: session || undefined,
      total: message.quiz.items.length, correct: items.filter(value => value === true).length, items });
  }
  message.quiz = { ...message.quiz, results: { ...message.quiz.results, [index]: entry }, attempts };
  await store.save(chat);
  return { ok, attempts: entry.attempts, lastOk: ok, explanation: item.explanation, answer: item.answers[0] };
}

async function recordReviewPlanAnswer(plan, payload) {
  const index = Number(payload.index);
  const text = String(payload.text || '');
  if (!plan || payload.planId !== plan.id || !Number.isInteger(index) || !plan.items[index]) {
    throw Object.assign(new Error('復習セッションが見つかりません。'), { status: 404 });
  }
  if (plan.results[index]) throw Object.assign(new Error('この問題は回答済みです。'), { status: 409 });
  if (!text.trim() || text.length > 500) throw Object.assign(new Error('回答は1～500文字で入力してください。'), { status: 400 });
  const item = plan.items[index];
  let result;
  if (item.kind === 'existing') {
    const chat = await store.get(item.chatId);
    const message = chat?.messages.find(entry => entry.id === item.messageId && entry.quiz);
    if (!message?.quiz.items[item.index]) throw Object.assign(new Error('元の問題が見つかりません。'), { status: 404 });
    result = await recordQuizAnswer(chat, message, { index: item.index, text, source: plan.kind === 'more' ? 'more_review' : 'review', session: plan.id });
  } else {
    const ok = judgeAnswer(text, item.quiz.answers);
    result = { ok, answer: item.quiz.answers[0], explanation: item.quiz.explanation };
  }
  plan.results[index] = { ok: result.ok, text, at: new Date().toISOString(), source: item.kind === 'ai_review' ? 'ai_review' : plan.kind === 'more' ? 'more_review' : 'review' };
  if (plan.kind === 'more') await store.saveMoreReview(plan);
  else await store.saveReview(plan);
  return result;
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
    } else if (action === 'ask' || action === 'question') {
      const parsed = parseQuiz(result);
      if (parsed) {
        response = `問題を${parsed.items.length}問作成しました。下の入力欄に答えてください。`;
        chat.messages.push({ id: randomUUID(), role: 'assistant', text: response, quiz: { items: parsed.items, results: {}, attempts: [], summary: parsed.summary }, progress: chat.job.progress, at: new Date().toISOString() });
        appendProgress(chat, 'status', '完了しました。');
        chat.job = null;
        await store.save(chat);
        return;
      }
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
    liveJobs.delete(chat.id);
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
  liveJobs.set(id, chat);
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
      if (req.method === 'POST' && url.pathname === '/api/opencode/install') {
        const installed = await installOfficialOpenCode();
        opencodeStatus = { ok: true, path: installed.path };
        modelCache = { at: 0, models: [] };
        return json(res, 200, installed);
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        if (Date.now() - modelCache.at > 600_000) {
          modelCache = { at: Date.now(), models: await listModels({ cwd: root }) };
        }
        return json(res, 200, { default: DEFAULT_MODEL, models: modelCache.models });
      }
      if (req.method === 'GET' && url.pathname === '/api/library') {
        const items = [];
        for (const chat of await store.list()) {
          if (chat.lesson) {
            items.push({ kind: 'lesson', chatId: chat.id, messageId: null, title: chat.title, at: chat.lessonUpdatedAt || chat.updatedAt, summary: '', stats: null, total: 0 });
          }
          for (const message of chat.messages) {
            if (message.quiz?.items?.length) {
              const attempts = Array.isArray(message.quiz.attempts) ? message.quiz.attempts : [];
               const display = attempts.length > 0 ? attempts.filter(entry => !['review', 'more_review'].includes(entry.source)) : (() => { const legacy = legacyAttempt(message); return legacy ? [legacy] : []; })();
              items.push({
                kind: 'quiz', chatId: chat.id, messageId: message.id, title: chat.title,
                at: message.at, summary: message.quiz.summary || '',
                stats: aggregateAttempts(display), total: message.quiz.items.length
              });
            }
          }
        }
        items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return json(res, 200, items);
      }
      if (req.method === 'GET' && url.pathname === '/api/review') {
        const candidates = reviewCandidates(await store.list());
        return json(res, 200, { existingCount: candidates.length, day: localDay(), dailyCompleted: completedReview(await store.dailyReview(localDay())) });
      }
      if (url.pathname === '/api/review/today' && req.method === 'GET') {
        const plan = await store.dailyReview(localDay());
        return json(res, 200, { plan: publicPlan(plan) });
      }
      if (url.pathname === '/api/review/today' && req.method === 'POST') {
        const payload = await body(req);
        const plan = await prepareReview(payload.includeAi !== false);
        return json(res, 200, { plan: publicPlan(plan) });
      }
      if (url.pathname === '/api/review/today/answer' && req.method === 'POST') {
        const payload = await body(req);
        return json(res, 200, await recordReviewPlanAnswer(await store.dailyReview(localDay()), payload));
      }
      if (url.pathname === '/api/review/more' && req.method === 'POST') {
        const payload = await body(req);
        if (!/^[0-9a-f-]{36}$/i.test(payload.id || '')) return fail(res, 400, '復習IDが不正です。');
        return json(res, 200, { plan: publicPlan(await prepareMoreReview(payload.id, payload.includeAi !== false)) });
      }
      const moreMatch = /^\/api\/review\/more\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && moreMatch) {
        return json(res, 200, { plan: publicPlan(await store.moreReview(moreMatch[1])) });
      }
      const moreAnswerMatch = /^\/api\/review\/more\/([0-9a-f-]{36})\/answer$/.exec(url.pathname);
      if (req.method === 'POST' && moreAnswerMatch) {
        return json(res, 200, await recordReviewPlanAnswer(await store.moreReview(moreAnswerMatch[1]), await body(req)));
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const settings = await body(req);
        const model = String(settings.model || '').trim();
        if (model && (!/^[\w.-]+\/[\w.-]+$/.test(model) || model.length > 120)) return fail(res, 400, 'モデル名は provider/model の形式で入力してください。');
        await store.saveSettings({ model });
        return json(res, 200, { model });
      }
      const chatMatch = /^\/api\/chats\/([0-9a-f-]{36})$/.exec(url.pathname);
      const pinMatch = /^\/api\/chats\/([0-9a-f-]{36})\/pin$/.exec(url.pathname);
      if (req.method === 'PATCH' && pinMatch) {
        const payload = await body(req);
        if (typeof payload.pinned !== 'boolean') return fail(res, 400, 'ピン留め状態が不正です。');
        const chat = liveJobs.get(pinMatch[1]) || await store.get(pinMatch[1]);
        if (!chat) return fail(res, 404, 'チャットが見つかりません。');
        chat.pinned = payload.pinned;
        await store.save(chat);
        return json(res, 200, summary(chat));
      }
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
      const answerMatch = /^\/api\/chats\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/answer$/.exec(url.pathname);
      if (req.method === 'POST' && answerMatch) {
        const chat = await store.get(answerMatch[1]);
        const message = chat?.messages.find(item => item.id === answerMatch[2] && item.quiz);
        if (!message) return fail(res, 404, '問題が見つかりません。');
        return json(res, 200, await recordQuizAnswer(chat, message, await body(req)));
      }
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
    if (instance.version !== appVersion) return null;
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
    console.log('Stellar は既に起動しています。既存のウィンドウを開きます。');
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
    await writeFile(instancePath, JSON.stringify({ pid: process.pid, port: address.port, secret: launchSecret, version: appVersion }), { mode: 0o600 });
    console.log(`Stellar: http://127.0.0.1:${address.port}/`);
    openWindow(url);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
