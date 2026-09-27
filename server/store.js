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
    this.attachmentsDir = path.join(root, 'attachments');
    this.reviewsDir = path.join(root, 'reviews');
    this.moreReviewsDir = path.join(this.reviewsDir, 'more');
  }

  async init() {
    await Promise.all([this.chatsDir, this.lessonsDir, this.tmpDir, this.attachmentsDir, this.reviewsDir, this.moreReviewsDir].map(dir => mkdir(dir, { recursive: true })));
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

  async delete(id) {
    this.chatPath(id);
    this.lessonPath(id);
    await unlink(this.chatPath(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(this.lessonPath(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const prefix = `${id}-`;
    const files = await readdir(this.attachmentsDir).catch(() => []);
    await Promise.all(files.filter(name => name.startsWith(prefix)).map(name => unlink(path.join(this.attachmentsDir, name)).catch(() => {})));
  }

  attachmentName(chatId, messageId, extension) {
    if (!idPattern.test(chatId) || !idPattern.test(messageId) || !/^[A-Za-z0-9]{1,10}$/.test(extension || '')) {
      throw new Error('添付ファイルの指定が不正です。');
    }
    return `${chatId}-${messageId}.${extension}`;
  }

  async saveAttachment(chatId, messageId, extension, bytes) {
    const target = path.join(this.attachmentsDir, this.attachmentName(chatId, messageId, extension));
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      try { await writeFile(target, bytes); }
      finally { await unlink(temporary).catch(() => {}); }
    }
  }

  async attachment(chatId, messageId, extension) {
    try { return await readFile(path.join(this.attachmentsDir, this.attachmentName(chatId, messageId, extension))); }
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

  reviewPath(day, includeAi) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('復習日が不正です。');
    return path.join(this.reviewsDir, `${day}-${includeAi ? 'ai' : 'existing'}.json`);
  }

  async review(day, includeAi) {
    try { return JSON.parse(await readFile(this.reviewPath(day, includeAi), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async saveReview(plan) {
    await writeDocument(this.reviewPath(plan.day, plan.includeAi), JSON.stringify(plan, null, 2));
  }

  async dailyReview(day) {
    const plans = (await Promise.all([this.review(day, true), this.review(day, false)])).filter(Boolean);
    return plans.find(plan => plan.items?.length && Object.keys(plan.results || {}).length === plan.items.length)
      || plans.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
  }

  moreReviewPath(id) {
    if (!idPattern.test(id)) throw new Error('復習IDが不正です。');
    return path.join(this.moreReviewsDir, `${id}.json`);
  }

  async moreReview(id) {
    try { return JSON.parse(await readFile(this.moreReviewPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async saveMoreReview(plan) {
    await writeDocument(this.moreReviewPath(plan.id), JSON.stringify(plan, null, 2));
  }
}
