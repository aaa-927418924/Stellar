const $ = id => document.getElementById(id);
function loadOrganizedSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem('study-organized-seen') || '[]');
    const ids = Array.isArray(raw) ? raw.filter(id => typeof id === 'string').slice(-200) : [];
    return new Set(ids);
  } catch { return new Set(); }
}

function saveOrganizedSeen() {
  try {
    localStorage.setItem('study-organized-seen', JSON.stringify([...state.organizedSeen].slice(-200)));
  } catch { /* ignore */ }
}

const state = { chats: [], current: null, chatMenuTarget: null, organizedSeen: loadOrganizedSeen(), organizeArmed: [], submitting: false, polling: false, attachments: [], mobileTab: 'chat', previewOpen: true, model: '', previewUrl: '', progressOpen: true };

function clampPane(value, min, max) { return Math.min(max, Math.max(min, value)); }

function storedPaneWidth(key) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

function applyPaneWidths() {
  const doc = document.documentElement;
  const sidebar = storedPaneWidth('study-sidebar-width');
  if (window.innerWidth > 1100 && sidebar) doc.style.setProperty('--sidebar-w', `${clampPane(sidebar, 200, 420)}px`);
  else doc.style.removeProperty('--sidebar-w');
  const preview = storedPaneWidth('study-preview-width');
  if (window.innerWidth > 900 && preview) doc.style.setProperty('--preview-w', `${clampPane(preview, 320, 900)}px`);
  else doc.style.removeProperty('--preview-w');
}

function makePaneResizable(handleId, targetId, config) {
  const handle = $(handleId);
  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startW = $(targetId).getBoundingClientRect().width;
    handle.classList.add('dragging');
    try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    const width = clampPane(Math.round(startW + config.direction * (event.clientX - startX)), config.min, config.max);
    document.documentElement.style.setProperty(config.varName, `${width}px`);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    try { localStorage.setItem(config.key, String(Math.round($(targetId).getBoundingClientRect().width))); } catch { /* ignore */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', event => {
    const delta = event.key === 'ArrowRight' ? 12 : event.key === 'ArrowLeft' ? -12 : 0;
    if (!delta) return;
    event.preventDefault();
    const base = storedPaneWidth(config.key) || $(targetId).getBoundingClientRect().width;
    const width = clampPane(Math.round(base + config.direction * delta), config.min, config.max);
    document.documentElement.style.setProperty(config.varName, `${width}px`);
    try { localStorage.setItem(config.key, String(width)); } catch { /* ignore */ }
  });
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 4600);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    let error;
    try { error = (await response.json()).error; } catch { /* ignore */ }
    throw new Error(error || `通信に失敗しました (${response.status})`);
  }
  return response.json();
}

async function loadChats() {
  state.chats = await api('/api/chats');
  renderChatList();
}

function renderChatList() {
  const list = $('chatList');
  list.replaceChildren();
  for (const chat of state.chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-link${state.current?.id === chat.id ? ' active' : ''}`;
    button.textContent = chat.jobStatus === 'running' ? `${chat.title} · 生成中` : chat.title;
    button.title = chat.title;
    button.addEventListener('click', () => openChat(chat.id));
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      openChatMenu(event.clientX, event.clientY, chat.id, chat.title);
    });
    list.append(button);
  }
}

function openChatMenu(x, y, id, title) {
  const menu = $('chatMenu');
  state.chatMenuTarget = { id, title };
  menu.hidden = false;
  const width = 160, height = 44;
  menu.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  $('deleteChatButton').textContent = `「${title.slice(0, 12)}${title.length > 12 ? '…' : ''}」を削除`;
}

function closeChatMenu() {
  $('chatMenu').hidden = true;
  state.chatMenuTarget = null;
}

import { cleanAiText, renderMarkdown } from './md.js';

function appendMessageText(container, raw) {
  const text = cleanAiText(raw);
  const emphasis = /\*\*([^*\n]+)\*\*/g;
  let offset = 0;
  for (const match of text.matchAll(emphasis)) {
    container.append(document.createTextNode(text.slice(offset, match.index)));
    const strong = document.createElement('strong');
    strong.textContent = match[1];
    container.append(strong);
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function thumbnailUrl(message, file) {
  if (!message.image || !state.current) return null;
  const target = file || {};
  const type = String(target.type ?? message.fileType ?? '');
  const name = String(target.name ?? message.file ?? '');
  const known = type.startsWith('image/') ? type : '';
  const extension = (/\.([A-Za-z0-9]{1,10})$/.exec(name) || [])[1]?.toLowerCase() || '';
  const image = known === '' ? ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(known);
  if (!image) return null;
  return `/api/chats/${state.current.id}/attachment/${target.id || message.id}`;
}

function openLightbox(src, alt) {
  closeLightbox();
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', alt);
  const image = document.createElement('img');
  image.src = src;
  image.alt = alt;
  overlay.append(image);
  overlay.addEventListener('click', closeLightbox);
  document.body.append(overlay);
  document.body.classList.add('lightbox-open');
  overlay.tabIndex = -1;
  overlay.focus();
}

function closeLightbox() {
  document.querySelector('.lightbox')?.remove();
  document.body.classList.remove('lightbox-open');
}

function paintQuizResult(box, message, index) {
  box.replaceChildren();
  const state = message.quiz.results[index];
  if (!state || !state.attempts) return;
  const status = document.createElement('div');
  status.className = state.lastOk ? 'quiz-ok' : 'quiz-ng';
  status.textContent = state.lastOk ? `○ 正解（${state.attempts}回目）` : `× 不正解（${state.attempts}回挑戦中）`;
  box.append(status);
  const item = message.quiz.items[index];
  if (state.lastOk && item.explanation) {
    const explanation = document.createElement('div');
    explanation.className = 'quiz-explanation';
    renderMarkdown(explanation, item.explanation);
    box.append(explanation);
  }
}

function quizElement(message) {
  const wrap = document.createElement('div');
  wrap.className = 'quiz';
  message.quiz.items.forEach((item, index) => {
    const block = document.createElement('div');
    block.className = 'quiz-item';
    const head = document.createElement('div');
    head.className = 'quiz-q';
    head.textContent = `Q${index + 1}`;
    const body = document.createElement('div');
    renderMarkdown(body, item.q);
    block.append(head, body);
    if (item.hint) {
      const hint = document.createElement('details');
      hint.className = 'quiz-hint';
      const summary = document.createElement('summary');
      summary.textContent = 'ヒント';
      const text = document.createElement('div');
      text.textContent = item.hint;
      hint.append(summary, text);
      block.append(hint);
    }
    const row = document.createElement('div');
    row.className = 'quiz-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = '答えを入力してEnter';
    input.setAttribute('aria-label', `問題${index + 1}の回答`);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '判定';
    const result = document.createElement('div');
    result.className = 'quiz-result';
    paintQuizResult(result, message, index);
    const judge = async () => {
      const value = input.value;
      if (!value.trim() || input.disabled) return;
      input.disabled = true;
      button.disabled = true;
      try {
        const response = await api(`/api/chats/${state.current.id}/messages/${message.id}/answer`, {
          method: 'POST',
          body: JSON.stringify({ index, text: value })
        });
        const entry = { attempts: response.attempts, correct: (message.quiz.results[index]?.correct || 0) + (response.ok ? 1 : 0), lastOk: response.ok };
        message.quiz.results[index] = entry;
        paintQuizResult(result, message, index);
        input.disabled = response.ok;
      } catch (error) {
        showToast(error.message);
        input.disabled = false;
      } finally {
        button.disabled = false;
        input.focus();
      }
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) judge();
    });
    button.addEventListener('click', judge);
    row.append(input, button);
    block.append(row, result);
    wrap.append(block);
  });
  return wrap;
}

function messageElement(message) {
  const element = document.createElement('div');
  element.className = `message ${message.role}`;
  if (message.failed) element.classList.add('failed');
  if (message.role === 'assistant') {
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'OpenCode';
    element.append(label);
  }
  if (message.image) {
    const files = Array.isArray(message.attachments) && message.attachments.length > 0
      ? message.attachments
      : [{ id: message.id, name: message.file, type: message.fileType }];
    const wrap = document.createElement('div');
    wrap.className = 'message-files';
    for (const file of files) {
      const chip = document.createElement('span');
      chip.className = 'message-image';
      const thumbnail = thumbnailUrl(message, file);
      if (thumbnail) {
        const image = document.createElement('img');
        image.className = 'message-thumb';
        image.src = thumbnail;
        image.alt = file.name || '添付画像';
        image.loading = 'lazy';
        image.tabIndex = 0;
        const open = () => openLightbox(thumbnail, file.name || '添付画像');
        image.addEventListener('click', open);
        image.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
        chip.append(image);
      }
      const name = document.createElement('span');
      name.className = 'message-filename';
      name.textContent = file.name || 'ファイルを添付';
      chip.append(name);
      wrap.append(chip);
    }
    element.append(wrap, document.createElement('br'));
  }
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'assistant') renderMarkdown(body, message.text);
  else appendMessageText(body, message.text);
  element.append(body);
  if (message.quiz?.items?.length) element.append(quizElement(message));
  if (message.pending && message.progress?.length) {
    const details = document.createElement('details');
    details.className = 'progress-log';
    details.open = !!message.pending && state.progressOpen;
    if (message.pending) details.addEventListener('toggle', () => { state.progressOpen = details.open; });
    const heading = document.createElement('summary');
    heading.textContent = `生成の経過 (${message.progress.length})`;
    details.append(heading);
    const list = document.createElement('ol');
    for (const entry of message.progress) {
      const item = document.createElement('li');
      item.className = `progress-${entry.type}`;
      const label = entry.type === 'thought' ? '思考' : entry.type === 'tool' ? 'ツール' : entry.type === 'step' ? '手順' : '状態';
      item.textContent = `${label} · ${entry.text}`;
      if (entry.detail) {
        const detail = document.createElement('pre');
        detail.className = 'progress-detail';
        detail.textContent = entry.detail;
        item.append(detail);
      }
      list.append(item);
    }
    details.append(list);
    element.append(details);
  }
  return element;
}

const composerHome = { parent: null, next: null };

function placeComposer(empty) {
  const composer = document.querySelector('.composer-wrap');
  if (!composer) return;
  if (empty) {
    if (!composerHome.parent) {
      composerHome.parent = composer.parentNode;
      composerHome.next = composer.nextSibling;
    }
    $('emptyComposerSlot').append(composer);
  } else if (composerHome.parent) {
    composerHome.parent.insertBefore(composer, composerHome.next);
  }
}
function renderMessages() {
  const messages = $('messages');
  const pane = $('conversation');
  const shouldScroll = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 130;
  messages.replaceChildren();
  const items = state.current?.messages || [];
  const empty = items.length === 0 && !state.current?.job;
  $('main').classList.toggle('is-empty', empty);
  placeComposer(empty);
  for (const item of items) messages.append(messageElement(item));
  const job = state.current?.job;
  if (job) {
    const askLike = job.action === 'ask' || job.action === 'question' || job.action === 'organize';
    const busyText = job.action === 'organize' ? 'プロンプトを考えています…' : askLike ? '回答を考えています…' : '教材を作成しています…';
    const received = !askLike && job.outputChars > 0 ? `（受信 ${(job.outputChars / 1024).toFixed(1)}KB）` : '';
    const pending = messageElement({ role: 'assistant', text: job.partialAnswer || `${busyText}${received}`, progress: job.progress, pending: true });
    pending.classList.add('pending');
    const elapsed = document.createElement('div');
    elapsed.className = 'elapsed';
    elapsed.textContent = `経過 ${Math.floor((Date.now() - Date.parse(job.startedAt)) / 60000)} 分 · 完了まで自動で更新します`;
    pending.append(elapsed);
    messages.append(pending);
  }
  if (shouldScroll && (items.length || job)) pane.scrollTop = pane.scrollHeight;
  const last = items.at(-1);
  if (last?.organizePrompt && state.current && state.organizeArmed.includes(state.current.id) && !state.organizedSeen.has(last.id)) {
    state.organizeArmed = state.organizeArmed.filter(id => id !== state.current.id);
    state.organizedSeen.add(last.id);
    saveOrganizedSeen();
    const promptText = last.text;
    newChat();
    $('actionSelect').value = 'create';
    $('messageInput').value = promptText;
    $('messageInput').focus();
    showToast('教材用プロンプトを新しいチャットに入れました。内容を確認して送信してください。');
  }
}

function lessonUrl(download = false) {
  if (!state.current) return '#';
  return `/api/chats/${state.current.id}/lesson${download ? '?download=1' : ''}`;
}

function renderPreview() {
  const hasLesson = !!state.current?.lesson;
  $('previewToggle').classList.toggle('visible', hasLesson);
  $('previewToggle').setAttribute('aria-pressed', String(hasLesson && state.previewOpen));
  $('previewPane').hidden = !hasLesson || !state.previewOpen;
  $('mobileTabs').hidden = !hasLesson;
  $('contentGrid').classList.toggle('mobile-preview', hasLesson && state.mobileTab === 'preview');
  for (const tab of document.querySelectorAll('.mobile-tab')) {
    const active = tab.dataset.tab === state.mobileTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
  if (hasLesson) {
    $('downloadLesson').href = lessonUrl(true);
    const url = `${lessonUrl()}?v=${encodeURIComponent(state.current.lessonUpdatedAt || 'initial')}`;
    if (state.previewUrl !== url) { $('lessonFrame').src = url; state.previewUrl = url; }
  } else { $('lessonFrame').removeAttribute('src'); state.previewUrl = ''; }
}

function render() {
  $('topTitle').textContent = state.current?.title || '新しいチャット';
  const selectedAction = $('actionSelect').value;
  $('actionSelect').innerHTML = '';
  const questionMode = state.current?.mode === 'question';
  const hasMessages = (state.current?.messages.length || 0) > 0;
  let actions;
  if (questionMode) actions = [['question', '質問する']];
  else if (state.current?.lesson) actions = [['ask', '教材について質問'], ['revise', '教材を更新']];
  else if (hasMessages) actions = [['create', '教材を作る']];
  else actions = [['create', '教材を作る'], ['question', '質問する']];
  for (const [value, label] of actions) $('actionSelect').add(new Option(label, value));
  if (actions.some(([value]) => value === selectedAction)) $('actionSelect').value = selectedAction;
  $('messageInput').placeholder = questionMode ? '質問を入力して…' : state.current?.lesson ? '教材について質問して…' : '学びたいことを入力して…';
  renderChatList();
  renderMessages();
  renderPreview();
  const busy = !!state.current?.job || state.submitting;
  $('organizeButton').hidden = state.current?.mode !== 'question' || busy;
  $('sendButton').disabled = busy;
  $('sendButton').hidden = busy;
  $('stopButton').hidden = !state.current?.job;
  $('messageInput').disabled = busy;
  $('actionSelect').disabled = busy;
}

async function openChat(id) {
  state.current = await api(`/api/chats/${id}`);
  state.mobileTab = 'chat';
  state.previewOpen = true;
  state.progressOpen = true;
  $('sidebar').classList.remove('open');
  render();
}

function newChat() {
  state.current = null;
  document.title = 'Study App';
  state.mobileTab = 'chat';
  state.previewOpen = true;
  state.progressOpen = true;
  $('messageInput').value = '';
  $('sidebar').classList.remove('open');
  clearImage();
  render();
  $('messageInput').focus();
}

function clearImage() {
  state.attachments = [];
  $('fileInput').value = '';
  renderAttachmentChips();
}

function renderAttachmentChips() {
  const wrap = $('attachmentChips');
  wrap.replaceChildren();
  wrap.hidden = state.attachments.length === 0;
  for (const file of state.attachments) {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    if (file.type.startsWith('image/')) {
      const thumb = document.createElement('img');
      thumb.className = 'attachment-thumb';
      thumb.src = file.data;
      thumb.alt = `${file.name}のプレビュー`;
      thumb.addEventListener('click', () => openLightbox(file.data, file.name));
      chip.append(thumb);
    }
    const name = document.createElement('span');
    name.textContent = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${file.name}の添付を削除`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter(item => item !== file);
      renderAttachmentChips();
    });
    chip.append(name, remove);
    wrap.append(chip);
  }
}

async function readFile(file) {
  if (!file) return;
  if (state.attachments.length >= 5) return showToast('添付は5件までにしてください。');
  if (file.size > 8_000_000) return showToast('ファイルは8MB以下にしてください。');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  state.attachments.push({ name: file.name, type: file.type || 'application/octet-stream', data });
  $('fileInput').value = '';
  renderAttachmentChips();
}

async function submit(event) {
  event.preventDefault();
  if (state.submitting || state.current?.job) return;
  const text = $('messageInput').value.trim();
  if (!text) return $('messageInput').focus();
  const action = $('actionSelect').value;
  const images = state.attachments;
  state.submitting = true;
  render();
  try {
    if (!state.current) {
      state.current = await api('/api/chats', { method: 'POST', body: '{}' });
      await loadChats();
    }
    state.current = await api(`/api/chats/${state.current.id}/send`, { method: 'POST', body: JSON.stringify({ text, action, model: state.model, images }) });
    $('messageInput').value = '';
    clearImage();
    await loadChats();
    render();
  } catch (error) {
    showToast(error.message);
    if (state.current) {
      try { state.current = await api(`/api/chats/${state.current.id}`); render(); } catch { /* keep current view */ }
    }
  } finally {
    state.submitting = false;
    render();
    $('messageInput').focus();
  }
}

$('composer').addEventListener('submit', submit);
$('organizeButton').addEventListener('click', async () => {
  if (!state.current || state.current.mode !== 'question' || state.current.job || state.submitting) return;
  if (!state.organizeArmed.includes(state.current.id)) state.organizeArmed.push(state.current.id);
  try {
    state.current = await api(`/api/chats/${state.current.id}/send`, { method: 'POST', body: JSON.stringify({ text: '教材用のプロンプトを作って', action: 'organize', model: state.model }) });
    await loadChats();
    render();
  } catch (error) { showToast(error.message); }
});
$('stopButton').addEventListener('click', async () => {
  if (!state.current?.job) return;
  try { await api(`/api/chats/${state.current.id}/cancel`, { method: 'POST', body: '{}' }); showToast('停止を依頼しました。'); }
  catch (error) { showToast(error.message); }
});
$('messageInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('newChat').addEventListener('click', newChat);
$('fileInput').addEventListener('change', event => {
  const files = [...(event.target.files || [])];
  (async () => {
    for (const file of files) {
      try { await readFile(file); }
      catch (error) { showToast(error.message); }
    }
  })().catch(error => showToast(error.message));
});
$('previewToggle').addEventListener('click', () => { state.previewOpen = !state.previewOpen; renderPreview(); });
$('reloadPreview').addEventListener('click', () => { $('lessonFrame').src = `${lessonUrl()}?v=${Date.now()}`; });
$('menuButton').addEventListener('click', () => $('sidebar').classList.add('open'));
$('closeSidebar').addEventListener('click', () => $('sidebar').classList.remove('open'));
$('deleteChatButton').addEventListener('click', async () => {
  const target = state.chatMenuTarget;
  closeChatMenu();
  if (!target) return;
  if (!window.confirm(`「${target.title}」を削除しますか？教材も一緒に消えます。`)) return;
  try {
    await api(`/api/chats/${target.id}`, { method: 'DELETE' });
    if (state.current?.id === target.id) newChat();
    else await loadChats();
    render();
    showToast('チャットを削除しました。');
  } catch (error) { showToast(error.message); }
});
document.addEventListener('click', event => {
  if (!event.target.closest('#chatMenu')) closeChatMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeLightbox(); closeChatMenu(); $('sidebar').classList.remove('open'); }
});
for (const button of document.querySelectorAll('.mobile-tab')) button.addEventListener('click', () => { state.mobileTab = button.dataset.tab; renderPreview(); });
async function refreshModelOptions() {
  const select = $('modelInput');
  select.replaceChildren();
  const preset = document.createElement('option');
  preset.value = '';
  preset.textContent = 'Muse Spark 1.3 Free（既定）';
  select.append(preset);
  try {
    const data = await api('/api/models');
    for (const id of data.models.filter(id => id !== data.default)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      select.append(option);
    }
  } catch (error) { showToast(error.message); }
  const listed = [...select.options].some(option => option.value === state.model);
  select.value = listed ? state.model : '';
  $('modelInputFallback').value = listed ? '' : state.model;
}
$('settingsButton').addEventListener('click', async () => { await refreshModelOptions(); $('settingsDialog').showModal(); });
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('closeOpencodeDialog').addEventListener('click', () => $('opencodeDialog').close());
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const manual = $('modelInputFallback').value.trim();
  const value = manual || $('modelInput').value;
  if (value && !/^[\w.-]+\/[\w.-]+$/.test(value)) return showToast('モデル名は provider/model 形式で入力してください。');
  try {
    const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ model: value }) });
    state.model = settings.model;
    $('settingsDialog').close();
  } catch (error) { showToast(error.message); }
});

makePaneResizable('sidebarHandle', 'sidebar', { key: 'study-sidebar-width', min: 200, max: 420, varName: '--sidebar-w', direction: 1 });
makePaneResizable('previewHandle', 'previewPane', { key: 'study-preview-width', min: 320, max: 900, varName: '--preview-w', direction: -1 });
applyPaneWidths();
window.addEventListener('resize', applyPaneWidths);

const hostView = !!(window.chrome && window.chrome.webview);
function postHostMessage(message) {
  try { if (hostView) window.chrome.webview.postMessage(message); } catch { /* ignore */ }
}
if (hostView) {
  $('windowControls').hidden = false;
  $('winMin').addEventListener('click', () => postHostMessage({ type: 'min' }));
  $('winMax').addEventListener('click', () => postHostMessage({ type: 'max' }));
  $('winClose').addEventListener('click', () => postHostMessage({ type: 'close' }));
  const topbar = document.querySelector('.topbar');
  topbar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button,a,input,select,textarea,dialog')) return;
    postHostMessage({ type: 'drag' });
  });
  topbar.addEventListener('dblclick', event => {
    if (event.target.closest('button,a,input,select,textarea,dialog')) return;
    postHostMessage({ type: 'max' });
  });
  window.chrome.webview.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type !== 'maxstate') return;
    const maximized = !!data.maximized;
    $('winMax').setAttribute('aria-label', maximized ? '元に戻す' : '最大化');
    $('winMax').setAttribute('title', maximized ? '元に戻す' : '最大化');
    $('winMaxIcon').innerHTML = maximized
      ? '<rect x="6" y="7" width="11" height="11" rx="1"/><path d="M9 7V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1"/>'
      : '<rect x="4" y="4" width="15" height="15" rx="2"/>';
  });
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    const previous = new Map(state.chats.map(chat => [chat.id, chat]));
    await loadChats();
    const id = state.current?.id;
    const finishedElsewhere = state.chats.find(chat => chat.id !== id && previous.get(chat.id)?.jobStatus === 'running' && chat.jobStatus !== 'running');
    if (finishedElsewhere) {
      const outcome = finishedElsewhere.lastMessageFailed ? '生成が終了しました。履歴を確認してください。' : '処理が完了しました。';
      showToast(`「${finishedElsewhere.title}」${outcome}`);
      document.title = `${finishedElsewhere.lastMessageFailed ? '!' : '✓'} ${outcome} · Study App`;
    }
    const listing = state.chats.find(chat => chat.id === id);
    if (id && listing?.updatedAt !== state.current.updatedAt) {
      const wasRunning = !!state.current.job;
      const previousAction = state.current.job?.action;
      const next = await api(`/api/chats/${id}`);
      if (state.current?.id !== id) return;
      state.current = next;
      render();
      if (wasRunning && !next.job) {
        const last = next.messages.at(-1);
        if (last?.failed) showToast(last.text);
        else {
          document.title = `✓ ${previousAction === 'ask' ? '回答' : '教材'}が完成しました · Study App`;
          showToast(previousAction === 'ask' ? '回答が届きました。' : '教材が完成しました。');
        }
      }
    } else if (state.current?.job) renderMessages();
  } catch (error) { showToast(error.message); }
  finally { state.polling = false; }
}

Promise.all([loadChats(), api('/api/settings')]).then(async ([, settings]) => {
  state.model = settings.model || '';
  $('appVersion').textContent = settings.version ? `バージョン ${settings.version}` : '';
  if (!settings.opencodeOk) $('opencodeDialog').showModal();
  const running = state.chats.find(chat => chat.jobStatus === 'running');
  if (running) state.current = await api(`/api/chats/${running.id}`);
  render();
  setInterval(poll, 2500);
}).catch(error => showToast(error.message));
