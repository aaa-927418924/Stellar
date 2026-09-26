const $ = id => document.getElementById(id);
const state = { chats: [], current: null, submitting: false, polling: false, image: null, mobileTab: 'chat', previewOpen: true, model: '', previewUrl: '', progressOpen: true };

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
    list.append(button);
  }
}

function appendMessageText(container, raw) {
  const text = String(raw || '').replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2').replace(/\\\((.*?)\\\)/g, '$1').replace(/\\\[|\\\]/g, '').replace(/\\times|\\cdot/g, '×').replace(/\\div/g, '÷').replace(/ {2}\n/g, '\n');
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
    label.textContent = 'Study App';
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
  appendMessageText(body, message.text);
  element.append(body);
  if (message.progress?.length) {
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
      const label = entry.type === 'thought' ? '思考' : entry.type === 'tool' ? '調査・ツール' : '状態';
      item.textContent = `${label} · ${entry.text}`;
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
    const pending = messageElement({ role: 'assistant', text: job.partialAnswer || (job.action === 'ask' ? '回答を考えています…' : '教材を作成しています…'), progress: job.progress, pending: true });
    pending.classList.add('pending');
    const elapsed = document.createElement('div');
    elapsed.className = 'elapsed';
    elapsed.textContent = `経過 ${Math.floor((Date.now() - Date.parse(job.startedAt)) / 60000)} 分 · 完了まで自動で更新します`;
    pending.append(elapsed);
    messages.append(pending);
  }
  if (shouldScroll && (items.length || job)) pane.scrollTop = pane.scrollHeight;
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
  $('modelLabel').textContent = state.model || 'OpenCode 既定モデル';
  const selectedAction = $('actionSelect').value;
  $('actionSelect').innerHTML = '';
  const actions = state.current?.lesson ? [['ask', '教材について質問'], ['revise', '教材を更新']] : [['create', '教材を作る']];
  for (const [value, label] of actions) $('actionSelect').add(new Option(label, value));
  if (actions.some(([value]) => value === selectedAction)) $('actionSelect').value = selectedAction;
  $('messageInput').placeholder = state.current?.lesson ? '教材について質問して…' : '学びたいことを入力して…';
  renderChatList();
  renderMessages();
  renderPreview();
  const busy = !!state.current?.job || state.submitting;
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
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('sidebar').classList.remove('open'); });
for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => { $('messageInput').value = button.dataset.example; $('messageInput').focus(); });
for (const button of document.querySelectorAll('.mobile-tab')) button.addEventListener('click', () => { state.mobileTab = button.dataset.tab; renderPreview(); });
$('settingsButton').addEventListener('click', () => { $('modelInput').value = state.model; $('settingsDialog').showModal(); });
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const value = $('modelInput').value.trim();
  if (value && !/^[\w.-]+\/[\w.-]+$/.test(value)) return showToast('モデル名は provider/model 形式で入力してください。');
  try {
    const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ model: value }) });
    state.model = settings.model;
    $('modelLabel').textContent = value || 'OpenCode 既定モデル';
    $('settingsDialog').close();
  } catch (error) { showToast(error.message); }
});

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
  const running = state.chats.find(chat => chat.jobStatus === 'running');
  if (running) state.current = await api(`/api/chats/${running.id}`);
  render();
  setInterval(poll, 2500);
}).catch(error => showToast(error.message));
