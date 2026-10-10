const $ = id => document.getElementById(id);
const csrf = document.querySelector('meta[name="image-blaster-token"]').content;
const viewerOrigin = document.querySelector('meta[name="viewer-origin"]').content;
let state, busy = false, submitting = false, connected = false, ready = false, files = [], loadedAccount = null;
const items = new Map();
let lastEvent = 0, noticeTimer, streamController;
function notice(text, error = false) {
  $('notice').textContent = text; $('notice').className = error ? 'error' : ''; $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 15_000 : 7000);
}
async function api(route, body, options = {}) {
  const response = await fetch(`/api/${route}`, { ...options, method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-image-blaster-token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function controls() {
  $('send').disabled = !connected || !ready || busy || submitting || !files.every(f => f.id);
  $('stop').hidden = !busy && !submitting;
  $('login').disabled = busy || submitting;
  $('logout').disabled = submitting;
  $('account').disabled = busy || submitting;
  $('model').disabled = !connected || busy || submitting;
  $('refresh-models').disabled = !connected || busy || submitting;
  $('world').disabled = busy || submitting;
  $('fresh').disabled = busy || submitting;
  $('files').disabled = busy || submitting;
  $('run-state').textContent = busy || submitting ? 'Working' : connected ? 'Ready' : 'Disconnected';
  $('run-state').dataset.busy = String(busy || submitting);
}
function message(kind, text, key, status) {
  $('intro')?.remove();
  let element = key ? items.get(key) : null;
  if (!element) {
    element = document.createElement('article'); element.className = `message ${kind}`;
    const label = document.createElement('strong'); label.textContent = kind === 'user' ? 'You' : kind === 'assistant' ? 'ChatGPT' : kind;
    const content = document.createElement('div'); element.append(label, content); $('messages').append(element);
    if (key) items.set(key, element);
    while ($('messages').children.length > 300) {
      const removed = $('messages').firstElementChild; removed.remove();
      for (const [k, v] of items) if (v === removed) items.delete(k);
    }
  }
  element.lastElementChild.textContent = text;
  if (status) element.dataset.status = status;
  $('messages').scrollTop = $('messages').scrollHeight;
  return element;
}
function approvals(requests) {
  $('approvals').replaceChildren(); $('approvals').hidden = !requests.length;
  for (const request of requests) {
    const card = document.createElement('div'); card.className = 'approval';
    const heading = document.createElement('strong'); heading.textContent = 'Review this action';
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(request, null, 2);
    const hint = document.createElement('p'); hint.textContent = 'Generation commands can charge World Labs or FAL. Approval is for this action only; inspect the entire command.';
    const buttons = document.createElement('div'); buttons.className = 'buttons';
    for (const [title, decision] of [['Approve once', 'accept'], ['Decline', 'decline']]) {
      const button = document.createElement('button'); button.textContent = title;
      button.addEventListener('click', async () => {
        for (const b of buttons.children) b.disabled = true;
        try { await api('approval', { id: request.id, decision }); card.remove(); if (!$('approvals').children.length) $('approvals').hidden = true; }
        catch (error) { notice(error.message, true); for (const b of buttons.children) b.disabled = false; }
      });
      buttons.append(button);
    }
    card.append(heading, pre, hint, buttons); $('approvals').append(card);
  }
}
let pendingApprovals = new Map();
function event(data) {
  if (data.type === 'snapshot') {
    items.clear(); if (data.value.events?.length || !$('intro')) $('messages').replaceChildren(); lastEvent = 0;
    pendingApprovals.clear();
    for (const entry of data.value.events || []) event(entry);
    for (const request of data.value.approvals || []) pendingApprovals.set(String(request.id), request);
    approvals([...pendingApprovals.values()]); busy = data.value.busy; controls(); return;
  }
  if (data.id <= lastEvent) return;
  lastEvent = data.id;
  const value = data.value || {};
  if (data.type === 'reset') { $('messages').replaceChildren(); items.clear(); pendingApprovals.clear(); approvals([]); }
  else if (data.type === 'user') { busy = true; message('user', value.text); }
  else if (data.type === 'delta') {
    const key = `assistant:${value.itemId}`;
    message('assistant', (items.get(key)?.lastElementChild.textContent || '') + value.text, key);
  } else if (data.type === 'message') message('assistant', value.text, `assistant:${value.itemId}`);
  else if (data.type === 'activity' || data.type === 'notice') message(data.type, value.text);
  else if (data.type === 'approval') { pendingApprovals.set(String(value.id), value); approvals([...pendingApprovals.values()]); }
  else if (data.type === 'resolved') { pendingApprovals.delete(String(value.id)); approvals([...pendingApprovals.values()]); }
  else if (data.type === 'complete') {
    busy = false; pendingApprovals.clear(); approvals([]);
    message('complete', value.status === 'completed' ? 'Turn completed.' : value.status === 'interrupted' ? 'Turn interrupted. Submitted provider jobs may still run.' : `Turn failed. ${value.error || 'Review the error and try again.'}`, undefined, value.status);
  }
  controls();
}
async function stream() {
  while (true) {
    try {
      streamController = new AbortController();
      const response = await fetch('/api/events', { headers: { 'x-image-blaster-token': csrf }, signal: streamController.signal });
      if (!response.ok) throw new Error('Event connection failed. Reload if the server restarted.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 25_000_000) throw new Error('Event stream exceeded its size limit.');
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) if (line.startsWith('data: ')) event(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { if (error.name === 'AbortError') return; notice('Reconnecting to the local agent…', true); }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
}
async function models() {
  ready = false; controls();
  const previous = $('model').value;
  try {
    const data = await api('models'); $('model').replaceChildren();
    for (const model of data) $('model').add(new Option(model.name, model.id));
    if (data.some(m => m.id === previous)) $('model').value = previous;
    if (!data.length) { $('model').add(new Option('No models available for this plan', '')); notice('No models were returned for this account. Check Manage usage.', true); }
    ready = data.length > 0;
  } catch (error) { notice(error.message, true); }
  controls();
}
async function status() {
  state = await api('status');
  const active = state.auth.accounts.find(a => a.id === state.auth.active);
  $('cancel-login').hidden = !state.pendingLogin;
  connected = Boolean(active?.planEnabled); busy = state.agent.busy;
  $('account').replaceChildren();
  for (const account of state.auth.accounts) $('account').add(new Option(`${account.label}${account.email ? ` · ${account.email}` : ''}${account.id === state.auth.active ? ' (active)' : ''}`, account.id));
  $('account').add(new Option('Add a ChatGPT account', '')); $('account').value = active?.id || '';
  $('login').textContent = active ? 'Reconnect / switch' : 'Sign in with ChatGPT'; $('logout').hidden = !active?.connected;
  $('plan-status').textContent = connected ? 'Using ChatGPT plan' : active?.connected ? 'Signed in · plan permission missing' : 'Not connected to a ChatGPT plan';
  $('provider-status').textContent = `World Labs: ${state.providers.worldLabs ? 'key configured' : 'key missing'}  ·  FAL: ${state.providers.fal ? 'key configured' : 'key missing'}`;
  $('viewer-message').textContent = state.viewerAvailable ? 'Viewer launched locally. Load a world once assets exist.' : 'Install the existing app dependencies and restart to launch the viewer, or open your separately running viewer.';
  if (active?.planEnabled && !active.welcomed && !$('welcome').open) $('welcome').showModal();
  if (connected && loadedAccount !== state.auth.active) { loadedAccount = state.auth.active; await models(); }
  if (!connected) { loadedAccount = null; ready = false; $('model').replaceChildren(new Option('Sign in to load models', '')); }
  controls();
}
$('login').addEventListener('click', async () => {
  try { const data = await api('login', { accountId: $('account').value || null }); const url = new URL(data.url); if (url.origin !== 'https://auth.openai.com') throw new Error('Unexpected authorization origin.'); location.assign(url.href); }
  catch (error) { notice(error.message, true); }
});
$('logout').addEventListener('click', async () => {
  if (!confirm('Sign out of this ChatGPT account? Running local work will be stopped.')) return;
  try { const data = await api('logout', {}); loadedAccount = null; files = []; attachments(); await status(); notice(data.revoked ? 'Signed out.' : 'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.', !data.revoked); }
  catch (error) { notice(error.message, true); }
});
$('cancel-login').addEventListener('click', async () => { try { await api('login/cancel', {}); await status(); } catch (error) { notice(error.message, true); } });
$('refresh-models').addEventListener('click', () => void models());
$('welcome-dismiss').addEventListener('click', async () => { try { await api('welcome', {}); $('welcome').close(); } catch (error) { notice(error.message, true); } });
$('welcome').addEventListener('cancel', e => e.preventDefault());
$('stop').addEventListener('click', async () => { try { await api('stop', {}); } catch (error) { notice(error.message, true); } });
function attachments() {
  $('attachments').replaceChildren();
  for (const file of files) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = `${file.name}${file.id ? ' ×' : ' · uploading…'}`;
    button.title = 'Remove attachment from this turn (the local input file is kept)'; button.disabled = !file.id;
    button.addEventListener('click', () => { files = files.filter(f => f !== file); attachments(); controls(); }); $('attachments').append(button);
  }
  controls();
}
$('files').addEventListener('change', async () => {
  const selected = [...$('files').files]; $('files').value = '';
  if (files.length + selected.length > 8) return notice('Attach at most eight images per turn.', true);
  for (const file of selected) {
    if (file.size > 20 * 1024 * 1024) { notice(`${file.name} exceeds 20 MB.`, true); continue; }
    const item = { name: file.name }; files.push(item); attachments();
    try {
      const response = await fetch('/api/upload', { method: 'POST', headers: { 'x-image-blaster-token': csrf, 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Upload failed.'); item.id = data.id;
    } catch (error) { files = files.filter(f => f !== item); notice(error.message, true); }
    attachments();
  }
});
$('composer').addEventListener('submit', async e => {
  e.preventDefault(); if ($('send').disabled) return;
  const text = $('prompt').value.trim(); if (!text) return;
  submitting = true; controls();
  try {
    await api('turn', { model: $('model').value, world: $('world').value, text, images: files.map(f => f.id), fresh: $('fresh').checked });
    $('prompt').value = ''; $('fresh').checked = false; files = []; attachments();
  } catch (error) { notice(error.message, true); }
  finally { submitting = false; try { await status(); } catch {} controls(); }
});
function loadViewer() {
  const world = $('world').value;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(world)) return notice('Use a valid world name first.', true);
  const url = `${viewerOrigin}/${encodeURIComponent(world)}`;
  $('viewer').src = url; $('open-viewer').href = url; $('viewer-placeholder').hidden = true; $('viewer').hidden = false;
}
$('load-viewer').addEventListener('click', loadViewer);
for (const pane of ['chat', 'viewer']) $(`${pane}-tab`).addEventListener('click', () => {
  document.body.dataset.pane = pane;
  for (const tab of ['chat', 'viewer']) $(`${tab}-tab`).setAttribute('aria-pressed', String(tab === pane));
});
window.addEventListener('pagehide', () => streamController?.abort());
try { await status(); void stream(); }
catch (error) { notice(error.message, true); }
