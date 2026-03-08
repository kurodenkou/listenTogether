'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const AVATAR_COLORS = ['#7c6eff','#e94560','#4caf7d','#ff9800','#00bcd4','#e91e63','#2196f3'];
function avatarColor(i) { return AVATAR_COLORS[i % AVATAR_COLORS.length]; }

// Must match the server-side roomDbName() exactly.
function roomDbName(roomId) {
  return 'room_' + roomId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const joinScreen       = $('join-screen');
const mainScreen       = $('main-screen');
const usernameInput    = $('username-input');
const roomInput        = $('room-input');
const joinBtn          = $('join-btn');
const roomBadge        = $('room-badge');
const listenersWrap    = $('listeners-wrap');
const leaveBtn         = $('leave-btn');

const syncBtn          = $('sync-btn');
const uploadToggleBtn  = $('upload-toggle-btn');
const uploadPanel      = $('upload-panel');
const uploadFile       = $('upload-file');
const fileLabelText    = $('file-label-text');
const uploadConfirmBtn = $('upload-confirm-btn');
const uploadCancelBtn  = $('upload-cancel-btn');
const uploadStatus     = $('upload-status');

const trackListEl      = $('track-list');
const albumArt         = $('album-art');
const coverImg         = $('cover-img');
const albumArtIcon     = $('album-art-icon');
const trackTitleEl     = $('track-title-display');
const trackArtistEl    = $('track-artist-display');
const playPauseBtn     = $('play-pause-btn');
const prevBtn          = $('prev-btn');
const nextBtn          = $('next-btn');
const progressWrap     = $('progress-wrap');
const progressFill     = $('progress-fill');
const progressThumb    = $('progress-thumb');
const timeCurrent      = $('time-current');
const timeTotal        = $('time-total');
const volumeSlider     = $('volume-slider');
const audioEl          = $('audio-el');

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  username:       '',
  roomId:         '',
  currentTrackId: null,
  tracks:         new Map(),   // _id → doc
  blobUrls:       new Map(),   // _id → object URL
  isSeeking:      false,
};

// ── PouchDB ───────────────────────────────────────────────────────────────────
// Local replica that live-syncs with the server's PouchDB via express-pouchdb.
// Audio files are stored as binary attachments — once a track is uploaded
// the server's change feed propagates it to every connected client.
let db = null;
let dbSync = null;

function initDB() {
  // Use a room-scoped local DB so each room starts with a clean slate.
  db = new PouchDB(roomDbName(state.roomId));

  dbSync = db.sync(`${location.origin}/db/${roomDbName(state.roomId)}`, {
    live: true,
    retry: true,
  }).on('change', () => {
    loadTracks();
  }).on('error', err => {
    console.warn('[PouchDB sync error]', err);
  });
}

function destroyDBSync() {
  if (dbSync) { dbSync.cancel(); dbSync = null; }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect',    () => console.log('[socket] connected', socket.id));
socket.on('disconnect', () => console.log('[socket] disconnected'));

// Server sends this when we first join — brings us up to the current state
socket.on('room-state', async ({ currentTrack, position, playing, listeners }) => {
  renderListeners(listeners);
  if (currentTrack) {
    await loadTrackIntoPlayer(currentTrack, position);
    if (playing) audioEl.play().catch(() => {});
  }
});

socket.on('listeners', renderListeners);

// Another client started playing
socket.on('play', async ({ trackId, position, timestamp }) => {
  const drift = (Date.now() - timestamp) / 1000;
  if (trackId !== state.currentTrackId) {
    await loadTrackIntoPlayer(trackId, position + drift);
  } else {
    audioEl.currentTime = position + drift;
  }
  audioEl.play().catch(() => {});
});

// Another client paused
socket.on('pause', ({ position }) => {
  audioEl.currentTime = position;
  audioEl.pause();
});

// Another client seeked
socket.on('seek', async ({ trackId, position, timestamp }) => {
  const drift = (Date.now() - timestamp) / 1000;
  if (trackId !== state.currentTrackId) {
    await loadTrackIntoPlayer(trackId, position + drift);
  } else {
    audioEl.currentTime = position + drift;
  }
});

// Another client changed the track
socket.on('track-change', async ({ trackId, timestamp }) => {
  const drift = (Date.now() - timestamp) / 1000;
  await loadTrackIntoPlayer(trackId, drift);
  audioEl.play().catch(() => {});
});

// ── Track library ─────────────────────────────────────────────────────────────
async function loadTracks() {
  if (!db) return;
  try {
    const result = await db.allDocs({ include_docs: true });
    state.tracks.clear();
    result.rows
      .filter(r => r.doc && r.doc.type === 'track' && !r.id.startsWith('_design'))
      .forEach(r => state.tracks.set(r.doc._id, r.doc));
    renderTrackList();
  } catch (err) {
    console.error('[loadTracks]', err);
  }
}

function renderTrackList() {
  if (state.tracks.size === 0) {
    trackListEl.innerHTML = '<li class="track-empty">No tracks yet — upload some music!</li>';
    return;
  }

  trackListEl.innerHTML = '';
  state.tracks.forEach(track => {
    const li = document.createElement('li');
    li.className = 'track-item' + (track._id === state.currentTrackId ? ' active' : '');
    li.dataset.id = track._id;
    li.innerHTML = `
      <span class="track-item-title">${escHtml(track.title)}</span>
      <span class="track-item-artist">${escHtml(track.artist)}</span>
    `;
    li.addEventListener('click', () => userSelectTrack(track._id));
    trackListEl.appendChild(li);
  });
}

// ── Audio loading ─────────────────────────────────────────────────────────────
async function getBlobUrl(trackId) {
  if (state.blobUrls.has(trackId)) return state.blobUrls.get(trackId);
  try {
    const blob = await db.getAttachment(trackId, 'audio');
    const url = URL.createObjectURL(blob);
    state.blobUrls.set(trackId, url);
    return url;
  } catch (err) {
    // Attachment may not have synced yet
    console.warn('[getBlobUrl] not yet available:', trackId);
    return null;
  }
}

async function loadTrackIntoPlayer(trackId, startAt = 0) {
  state.currentTrackId = trackId;

  // Update metadata display
  const track = state.tracks.get(trackId);
  trackTitleEl.textContent  = track ? track.title  : 'Loading…';
  trackArtistEl.textContent = track ? track.artist : '';
  renderTrackList(); // update active highlight

  // Load cover art if available
  if (track && track.hasCover) {
    try {
      const blob = await db.getAttachment(trackId, 'cover');
      const url  = URL.createObjectURL(blob);
      coverImg.src = url;
      coverImg.classList.remove('hidden');
      albumArtIcon.classList.add('hidden');
    } catch (_) {
      coverImg.classList.add('hidden');
      albumArtIcon.classList.remove('hidden');
    }
  } else {
      coverImg.classList.add('hidden');
    albumArtIcon.classList.remove('hidden');
  }

  // Load audio from PouchDB attachment
  const url = await getBlobUrl(trackId);
  if (!url) {
    trackTitleEl.textContent = 'Track not synced yet…';
    return;
  }

  audioEl.src = url;
  audioEl.currentTime = startAt;
}

// ── User-initiated track selection ────────────────────────────────────────────
async function userSelectTrack(trackId) {
  await loadTrackIntoPlayer(trackId, 0);
  audioEl.play().catch(() => {});
  socket.emit('track-change', { trackId });
}

function advanceTrack(dir) {
  const ids = [...state.tracks.keys()];
  if (!ids.length) return;
  const idx = ids.indexOf(state.currentTrackId);
  const next = ids[(idx + dir + ids.length) % ids.length];
  userSelectTrack(next);
}

// ── Playback controls ─────────────────────────────────────────────────────────
playPauseBtn.addEventListener('click', () => {
  if (!state.currentTrackId) return;
  if (audioEl.paused) {
    audioEl.play().then(() => {
      socket.emit('play', { trackId: state.currentTrackId, position: audioEl.currentTime });
    }).catch(() => {});
  } else {
    audioEl.pause();
    socket.emit('pause', { position: audioEl.currentTime });
  }
});

prevBtn.addEventListener('click', () => advanceTrack(-1));
nextBtn.addEventListener('click', () => advanceTrack(1));

// ── Audio element events ──────────────────────────────────────────────────────
audioEl.addEventListener('timeupdate', () => {
  if (state.isSeeking) return;
  const cur = audioEl.currentTime;
  const dur = audioEl.duration || 0;
  const pct = dur ? (cur / dur) * 100 : 0;

  progressFill.style.width  = pct + '%';
  progressThumb.style.left  = pct + '%';
  timeCurrent.textContent   = formatTime(cur);
  if (!isNaN(dur)) timeTotal.textContent = formatTime(dur);
});

audioEl.addEventListener('play',  () => {
  playPauseBtn.innerHTML = '&#9646;&#9646;';
  albumArt.classList.add('playing');
});
audioEl.addEventListener('pause', () => {
  playPauseBtn.innerHTML = '&#9654;';
  albumArt.classList.remove('playing');
});
audioEl.addEventListener('ended', () => advanceTrack(1));

// ── Seek via progress bar ─────────────────────────────────────────────────────
let dragging = false;

function applySeek(clientX) {
  const rect = progressWrap.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  audioEl.currentTime = pct * (audioEl.duration || 0);
  progressFill.style.width = (pct * 100) + '%';
  progressThumb.style.left = (pct * 100) + '%';
}

progressWrap.addEventListener('mousedown', e => {
  dragging = true;
  state.isSeeking = true;
  applySeek(e.clientX);
});
document.addEventListener('mousemove', e => { if (dragging) applySeek(e.clientX); });
document.addEventListener('mouseup',   e => {
  if (!dragging) return;
  dragging = false;
  state.isSeeking = false;
  applySeek(e.clientX);
  socket.emit('seek', { trackId: state.currentTrackId, position: audioEl.currentTime });
});

// Touch support for mobile
progressWrap.addEventListener('touchstart', e => {
  dragging = true;
  state.isSeeking = true;
  applySeek(e.touches[0].clientX);
}, { passive: true });
document.addEventListener('touchmove',  e => { if (dragging) applySeek(e.touches[0].clientX); }, { passive: true });
document.addEventListener('touchend',   e => {
  if (!dragging) return;
  dragging = false;
  state.isSeeking = false;
  socket.emit('seek', { trackId: state.currentTrackId, position: audioEl.currentTime });
});

// ── Volume ────────────────────────────────────────────────────────────────────
volumeSlider.addEventListener('input', () => { audioEl.volume = volumeSlider.value; });
audioEl.volume = 0.8;

// ── Upload ────────────────────────────────────────────────────────────────────
uploadToggleBtn.addEventListener('click', () => {
  uploadPanel.classList.toggle('hidden');
});

uploadFile.addEventListener('change', () => {
  const n = uploadFile.files.length;
  fileLabelText.textContent = n === 0
    ? 'Choose audio file…'
    : n === 1 ? uploadFile.files[0].name : `${n} files selected`;
});

uploadCancelBtn.addEventListener('click', resetUploadForm);

uploadConfirmBtn.addEventListener('click', async () => {
  const files = [...uploadFile.files];
  if (!files.length) { showUploadStatus('Please choose at least one audio file.'); return; }

  uploadConfirmBtn.disabled = true;

  let ok = 0;
  for (const [i, file] of files.entries()) {
    showUploadStatus(`Uploading ${i + 1}/${files.length}…`);
    const fd = new FormData();
    fd.append('audio', file);
    fd.append('roomId', state.roomId);
    try {
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      ok++;
    } catch (err) {
      showUploadStatus(`Failed "${file.name}": ${err.message}`);
      uploadConfirmBtn.disabled = false;
      return;
    }
  }

  showUploadStatus(`${ok} track${ok !== 1 ? 's' : ''} uploaded!`);
  setTimeout(resetUploadForm, 1500);
  uploadConfirmBtn.disabled = false;
});

function showUploadStatus(msg) {
  uploadStatus.textContent = msg;
  uploadStatus.classList.remove('hidden');
}

function resetUploadForm() {
  uploadPanel.classList.add('hidden');
  uploadStatus.classList.add('hidden');
  uploadFile.value = '';
  fileLabelText.textContent = 'Choose audio file…';
}

// ── Sync button ───────────────────────────────────────────────────────────────
syncBtn.addEventListener('click', async () => {
  if (!db) return;
  syncBtn.classList.add('syncing');
  syncBtn.disabled = true;
  try {
    await db.replicate.from(`${location.origin}/db/${roomDbName(state.roomId)}`);
    await loadTracks();
  } catch (err) {
    console.warn('[manual sync error]', err);
  } finally {
    syncBtn.classList.remove('syncing');
    syncBtn.disabled = false;
  }
});

// ── Listeners display ─────────────────────────────────────────────────────────
function renderListeners(listeners) {
  listenersWrap.innerHTML = '';
  listeners.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'listener-avatar';
    div.style.background = avatarColor(i);
    div.textContent = l.username.charAt(0).toUpperCase();
    div.title = l.username;
    listenersWrap.appendChild(div);
  });
}

// ── Join / Leave ──────────────────────────────────────────────────────────────
function joinRoom() {
  const username = usernameInput.value.trim();
  const roomId   = roomInput.value.trim();
  if (!username || !roomId) return;

  state.username = username;
  state.roomId   = roomId;

  joinScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  roomBadge.textContent = roomId;

  initDB();
  loadTracks();
  socket.emit('join-room', { roomId, username });
}

function leaveRoom() {
  destroyDBSync();

  audioEl.pause();
  audioEl.removeAttribute('src');
  state.currentTrackId = null;
  state.tracks.clear();
  state.blobUrls.forEach(url => URL.revokeObjectURL(url));
  state.blobUrls.clear();

  trackTitleEl.textContent  = 'No track selected';
  trackArtistEl.textContent = '—';
  albumArt.classList.remove('playing');
  playPauseBtn.innerHTML = '&#9654;';
  progressFill.style.width  = '0%';
  progressThumb.style.left  = '0%';
  timeCurrent.textContent   = '0:00';
  timeTotal.textContent     = '0:00';

  renderListeners([]);
  resetUploadForm();
  renderTrackList();

  mainScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  usernameInput.focus();
}

joinBtn.addEventListener('click', joinRoom);
leaveBtn.addEventListener('click', leaveRoom);

usernameInput.addEventListener('keypress', e => { if (e.key === 'Enter') roomInput.focus(); });
roomInput.addEventListener('keypress',     e => { if (e.key === 'Enter') joinRoom(); });

// ── Init ──────────────────────────────────────────────────────────────────────
usernameInput.focus();
