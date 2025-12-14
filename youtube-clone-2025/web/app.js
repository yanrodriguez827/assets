const API = '';

function setToken(t){ localStorage.setItem('accessToken', t); }
function getToken(){ return localStorage.getItem('accessToken'); }
function clearToken(){ localStorage.removeItem('accessToken'); }
function authHeaders(){
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function api(path, opts={}){
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData) && opts.body !== undefined && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(API + path, { ...opts, headers, credentials: 'include' });
  const text = await res.text();
  let json;
  try{ json = text ? JSON.parse(text) : null; } catch { json = null; }
  if(!res.ok) throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status, json });
  return json;
}

function el(id){ return document.getElementById(id); }

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function wireHeader(){
  const f = el('searchForm');
  if(!f) return;
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const q = el('q').value.trim();
    location.href = q ? `/?q=${encodeURIComponent(q)}` : '/';
  };
}

async function refreshIfNeeded(){
  // If token missing, try refresh.
  if (getToken()) return;
  try{
    const r = await api('/api/auth/refresh', { method: 'POST' });
    if (r?.accessToken) setToken(r.accessToken);
  } catch {
    // ignore
  }
}

async function renderHome(){
  await refreshIfNeeded();
  const q = new URLSearchParams(location.search).get('q') || '';
  el('q').value = q;

  try{
    const me = await api('/api/me', { headers: { ...authHeaders() } });
    el('me').textContent = me?.user ? `Signed in as ${me.user.username}` : '';
  } catch {
    el('me').textContent = '';
  }

  const data = await api(`/api/videos${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const grid = el('grid');
  grid.innerHTML = '';
  for(const v of data.items){
    const a = document.createElement('a');
    a.href = `/watch.html?id=${encodeURIComponent(v.id)}`;
    a.className = 'card';
    a.innerHTML = `
      <div class="thumb">${escapeHtml(v.status || 'video')}</div>
      <div class="meta">
        <p class="title">${escapeHtml(v.title)}</p>
        <div class="small">${escapeHtml(v.channel_username)} • ${Number(v.views||0)} views • ${new Date(v.created_at).toLocaleString()}</div>
        <div class="small">❤ ${Number(v.like_count||0)} • ${escapeHtml(v.status)}</div>
      </div>
    `;
    grid.appendChild(a);
  }
}

async function renderWatch(){
  await refreshIfNeeded();
  const id = new URLSearchParams(location.search).get('id');
  if(!id) return;

  const data = await api(`/api/videos/${encodeURIComponent(id)}`);
  const v = data.video;

  el('title').textContent = v.title;
  el('channel').textContent = v.channel_username;
  el('desc').textContent = v.description;
  el('stats').textContent = `${Number(v.views||0)} views • ${new Date(v.created_at).toLocaleString()} • ❤ ${Number(v.like_count||0)} • ${v.status}`;

  const up = await api(`/api/videos?limit=10`);
  el('upnext').innerHTML = up.items.map(x => `<div class="small"><a href="/watch.html?id=${encodeURIComponent(x.id)}">${escapeHtml(x.title)}</a></div>`).join('');

  const videoEl = el('video');
  if (v.status !== 'ready') {
    videoEl.outerHTML = `<div class="panel"><div class="small">Video is ${escapeHtml(v.status)}. Refresh in a moment.</div></div>`;
  } else {
    const manifest = v.hls_manifest_url;
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(manifest);
      hls.attachMedia(videoEl);
    } else {
      videoEl.src = manifest;
    }
  }

  await loadComments(id);

  el('likeBtn').onclick = async () => {
    try{
      const r = await api(`/api/videos/${encodeURIComponent(id)}/like`, { method:'POST', headers: { ...authHeaders() } });
      el('likeState').textContent = r.liked ? 'liked' : 'unliked';
      await refreshMeta(id);
    } catch {
      alert('Login required to like');
    }
  };

  el('commentForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = el('commentBody').value.trim();
    if(!body) return;
    try{
      await api(`/api/videos/${encodeURIComponent(id)}/comments`, { method:'POST', headers: { ...authHeaders() }, body: JSON.stringify({ body }) });
      el('commentBody').value = '';
      await loadComments(id);
    } catch {
      alert('Login required to comment');
    }
  };
}

async function refreshMeta(id){
  const data = await api(`/api/videos/${encodeURIComponent(id)}`);
  const v = data.video;
  el('stats').textContent = `${Number(v.views||0)} views • ${new Date(v.created_at).toLocaleString()} • ❤ ${Number(v.like_count||0)} • ${v.status}`;
}

async function loadComments(id){
  const data = await api(`/api/videos/${encodeURIComponent(id)}/comments`);
  const list = el('comments');
  list.innerHTML = '';
  for(const c of data.items){
    const div = document.createElement('div');
    div.className = 'panel';
    div.innerHTML = `<div class="small"><b>${escapeHtml(c.username)}</b> • ${new Date(c.created_at).toLocaleString()}</div><div style="margin-top:8px;white-space:pre-wrap">${escapeHtml(c.body)}</div>`;
    list.appendChild(div);
  }
}

function renderAuth(){
  el('registerForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const email = el('rEmail').value.trim();
    const username = el('rUsername').value.trim();
    const password = el('rPassword').value;
    const r = await api('/api/auth/register', { method:'POST', body: JSON.stringify({ email, username, password }) });
    setToken(r.accessToken);
    location.href = '/';
  };

  el('loginForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const email = el('lEmail').value.trim();
    const password = el('lPassword').value;
    const r = await api('/api/auth/login', { method:'POST', body: JSON.stringify({ email, password }) });
    setToken(r.accessToken);
    location.href = '/';
  };

  el('logout').onclick = async () => {
    try{ await api('/api/auth/logout', { method:'POST', headers: { ...authHeaders() } }); } catch {}
    clearToken();
    alert('Logged out');
  };
}

function renderUpload(){
  el('uploadForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const title = el('uTitle').value.trim();
    const description = el('uDesc').value.trim();
    const file = el('uFile').files?.[0];
    if(!file) return alert('Choose a video file');

    el('status').textContent = 'Uploading...';

    const fd = new FormData();
    fd.append('title', title);
    fd.append('description', description);
    fd.append('file', file);

    try{
      const res = await fetch('/api/videos/upload', { method:'POST', headers: { ...authHeaders() }, body: fd, credentials: 'include' });
      const json = await res.json().catch(() => null);
      if(!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      el('status').textContent = 'Uploaded. Processing...';
      location.href = `/watch.html?id=${encodeURIComponent(json.id)}`;
    } catch(e){
      el('status').textContent = 'Upload failed.';
      alert('Upload failed (are you logged in?)');
    }
  };
}

wireHeader();

if (location.pathname === '/' || location.pathname === '/index.html') {
  renderHome().catch(e => console.error(e));
}
if (location.pathname === '/watch.html') {
  renderWatch().catch(e => console.error(e));
}
if (location.pathname === '/auth.html') {
  renderAuth();
}
if (location.pathname === '/upload.html') {
  renderUpload();
}
