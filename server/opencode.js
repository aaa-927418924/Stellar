import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function command() {
  return findOpenCodeSync() || 'opencode';
}

function candidatePaths() {
  const paths = [];
  if (process.env.STUDY_OPENCODE_EXE) paths.push(process.env.STUDY_OPENCODE_EXE);
  if (process.platform === 'win32') {
    paths.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
  }
  return paths;
}

function findOpenCodeSync() {
  for (const candidate of candidatePaths()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

export function findOpenCode() {
  const direct = findOpenCodeSync();
  if (direct) return direct;
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(probe, ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const first = found.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch { /* ignore */ }
  return null;
}

export const DEFAULT_MODEL = 'opencode/muse-spark-1.3-contributor-free';

export function parseModelList(text) {
  const clean = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const ids = [];
  for (const line of clean.split('\n')) {
    const match = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.exec(line);
    if (match && !ids.includes(match[0])) ids.push(match[0]);
  }
  return ids;
}

export async function listModels({ cwd, timeoutMs = 20000 } = {}) {
  const child = spawn(command(), ['models'], { cwd, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('モデル一覧の取得がタイムアウトしました。')); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', value => { clearTimeout(timer); resolve(value); });
  });
  const models = parseModelList(output);
  if (code !== 0 || models.length === 0) throw new Error(stderr.trim() || 'モデル一覧を取得できませんでした。OpenCodeの認証を確認してください。');
  return models;
}

export async function runOpenCode({ promptFile, attachments, attachment, model, onText, onEvent, signal, cwd }) {
  const args = ['run', '--pure', '--format', 'json', '--thinking', '--agent', 'study', '--dir', cwd];
  if (model) args.push('--model', model);
  args.push('添付した指示テキストを読み、その依頼を実行してください。');
  args.push('--file', promptFile);
  const files = [...(attachments || [])];
  if (attachment) files.push(attachment);
  for (const file of files) args.push('--file', file);
  const child = spawn(command(), args, {
    cwd,
    windowsHide: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal
  });
  let output = '';
  let stderr = '';
  let buffer = '';
  let seenText = false;
  const handleLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    onEvent?.(event);
    if (event.type === 'error') {
      stderr += `\n${event.error?.data?.message || event.error?.message || 'OpenCodeエラー'}`;
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      const fragment = event.part.text;
      if (!fragment) return;
      seenText = true;
      output += fragment;
      if (output.length > 2_500_000) child.kill();
      onText?.(fragment);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  handleLine(buffer);
  if (code !== 0 || !seenText) throw new Error(stderr.trim() || `OpenCodeが応答を返せませんでした (終了コード ${code})。認証とモデル設定を確認してください。`);
  return output;
}
