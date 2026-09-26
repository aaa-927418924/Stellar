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

const state = { chats: [], current: null, chatMenuTarget: null, organizedSeen: loadOrganizedSeen(), organizeArmed: [], submitting: false, polling: false, image: null, mobileTab: 'chat', previewOpen: true, model: '', previewUrl: '', progressOpen: true };

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
    const chip = document.createElement('span');
    chip.className = 'message-image';
    chip.textContent = '画像を添付';
    element.append(chip, document.createElement('br'));
  }
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'assistant') renderMarkdown(body, message.text);
  else appendMessageText(body, message.text);
  element.append(body);
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

function renderMessages() {
  const messages = $('messages');
  const pane = $('conversation');
  const shouldScroll = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 130;
  messages.replaceChildren();
  const items = state.current?.messages || [];
  $('welcome').hidden = items.length > 0;
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
  state.image = null;
  $('imageInput').value = '';
  $('attachmentChip').hidden = true;
}

async function readImage(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return showToast('PNG、JPEG、WebP、GIF画像を選んでください。');
  if (file.size > 8_000_000) return showToast('画像は8MB以下にしてください。');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  state.image = { name: file.name, type: file.type, data };
  $('attachmentName').textContent = file.name;
  $('attachmentChip').hidden = false;
}

async function submit(event) {
  event.preventDefault();
  if (state.submitting || state.current?.job) return;
  const text = $('messageInput').value.trim();
  if (!text) return $('messageInput').focus();
  const action = $('actionSelect').value;
  const image = state.image;
  state.submitting = true;
  render();
  try {
    if (!state.current) {
      state.current = await api('/api/chats', { method: 'POST', body: '{}' });
      await loadChats();
    }
    state.current = await api(`/api/chats/${state.current.id}/send`, { method: 'POST', body: JSON.stringify({ text, action, model: state.model, image }) });
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
$('imageInput').addEventListener('change', event => readImage(event.target.files?.[0]).catch(error => showToast(error.message)));
$('removeAttachment').addEventListener('click', clearImage);
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
  if (event.key === 'Escape') { closeChatMenu(); $('sidebar').classList.remove('open'); }
});
for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => { $('messageInput').value = button.dataset.example; $('messageInput').focus(); });
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
  if (!settings.opencodeOk) $('opencodeDialog').showModal();
  const running = state.chats.find(chat => chat.jobStatus === 'running');
  if (running) state.current = await api(`/api/chats/${running.id}`);
  render();
  setInterval(poll, 2500);
}).catch(error => showToast(error.message));
