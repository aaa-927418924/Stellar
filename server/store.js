import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const idPattern = /^[0-9a-f-]{36}$/i;

async function writeDocument(target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, target);
  } catch (error) {
    // Windows can deny replacement of an existing file while a reader has it open.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    try { await writeFile(target, content, 'utf8'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
}

export class Store {
  constructor(root) {
    this.root = root;
    this.chatsDir = path.join(root, 'chats');
    this.lessonsDir = path.join(root, 'lessons');
    this.tmpDir = path.join(root, 'tmp');
  }

  async init() {
    await Promise.all([this.chatsDir, this.lessonsDir, this.tmpDir].map(dir => mkdir(dir, { recursive: true })));
  }

  chatPath(id) {
    if (!idPattern.test(id)) throw new Error('チャットIDが不正です。');
    return path.join(this.chatsDir, `${id}.json`);
  }

  lessonPath(id) {
    if (!idPattern.test(id)) throw new Error('チャットIDが不正です。');
    return path.join(this.lessonsDir, `${id}.html`);
  }

  async list() {
    const files = (await readdir(this.chatsDir)).filter(name => name.endsWith('.json'));
    const chats = await Promise.all(files.map(async name => {
      try { return JSON.parse(await readFile(path.join(this.chatsDir, name), 'utf8')); }
      catch { return null; }
    }));
    return chats.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create() {
    const now = new Date().toISOString();
    const chat = { id: randomUUID(), title: '新しいチャット', createdAt: now, updatedAt: now, lesson: false, mode: null, messages: [] };
    await this.save(chat);
    return chat;
  }

  async get(id) {
    try { return JSON.parse(await readFile(this.chatPath(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(chat) {
    chat.updatedAt = new Date().toISOString();
    await writeDocument(this.chatPath(chat.id), JSON.stringify(chat, null, 2));
  }

  async saveLesson(id, html) {
    await writeDocument(this.lessonPath(id), html);
  }

  async lesson(id) {
    try { return await readFile(this.lessonPath(id), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async settings() {
    try { return JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { model: '' };
      throw error;
    }
  }

  async saveSettings(settings) {
    await writeDocument(path.join(this.root, 'settings.json'), JSON.stringify(settings, null, 2));
  }
}
