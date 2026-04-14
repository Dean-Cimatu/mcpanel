// ── State ─────────────────────────────────────────────
let token = localStorage.getItem('mcpanel_token');
let user = null;
let socket = null;
let currentServerId = null;
let currentPath = 'C:/MinecraftServer';
let serverStatuses = [];
let logSearchTimeout = null;
let backupStates = {};

// ── World History State ────────────────────────────────
let historyServerId = null;
let historySnapshots = [];
let calendarDate = new Date();
let selectedSnapshot = null;
let timelapseTimer = null;
let timelapseIndex = 0;
let timelapseDates = [];
let savedCameraHash = '';
const PC_TILE_BASE = '/snapshots';
const BLUEMAP_URL = '/bluemap/';

// ── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (token) verifyAndLoad(); else showScreen('auth');
  initAuth();
  updateClock();
  setInterval(updateClock, 1000);
});

function updateClock() {
  const el = document.getElementById('header-time');
  if (el) el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// ── Auth ──────────────────────────────────────────────
function initAuth() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}-form`).classList.add('active');
    });
  });
  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('register-btn').addEventListener('click', register);
  document.getElementById('login-password').addEventListener('keydown', e => e.key === 'Enter' && login());
  document.getElementById('reg-code').addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
  document.getElementById('logout-btn').addEventListener('click', logout);
}

async function login() {
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  err.textContent = '';
  btn.textContent = 'Signing in…'; btn.disabled = true;
  const res = await api('/api/auth/login', 'POST', { username, password });
  btn.textContent = 'Sign In'; btn.disabled = false;
  if (res.error) { err.textContent = res.error; return; }
  token = res.token; user = res.user;
  localStorage.setItem('mcpanel_token', token);
  loadPanel();
}

async function register() {
  const btn = document.getElementById('register-btn');
  const err = document.getElementById('register-error');
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const invite_code = document.getElementById('reg-code').value.trim().toUpperCase();
  err.textContent = '';
  btn.textContent = 'Creating account…'; btn.disabled = true;
  const res = await api('/api/auth/register', 'POST', { username, password, invite_code });
  btn.textContent = 'Create Account'; btn.disabled = false;
  if (res.error) { err.textContent = res.error; return; }
  token = res.token; user = res.user;
  localStorage.setItem('mcpanel_token', token);
  loadPanel();
}

async function verifyAndLoad() {
  const res = await api('/api/auth/me');
  if (res.error) { logout(); return; }
  user = res; loadPanel();
}

function logout() {
  localStorage.removeItem('mcpanel_token');
  token = null; user = null;
  if (socket) { socket.disconnect(); socket = null; }
  showScreen('auth');
}

// ── Panel Load ────────────────────────────────────────
function loadPanel() {
  showScreen('panel');
  document.getElementById('user-name').textContent = user.username;
  document.getElementById('user-avatar').textContent = user.username[0].toUpperCase();
  const pill = document.getElementById('user-role-pill');
  pill.textContent = user.role;
  pill.className = `role-pill ${user.role}`;

  if (user.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }

  initSocket();
  initNav();
  initServerPage();
  initFilePage();
  initUsersPage();
  initInvitesPage();
  initBackupsPage();
  loadStats();
  setInterval(loadStats, 30000);
  updateInfraStatus();
  setInterval(updateInfraStatus, 30000);
}

// ── Socket ────────────────────────────────────────────
function initSocket() {
  socket = io({ auth: { token } });

  socket.on('server_status', (statuses) => {
    serverStatuses = statuses;
    renderDashboard(statuses);
    updateServerNav(statuses);
    updateServerPage(statuses);
    updateBackupGrid(statuses);
  });

  socket.on('log', ({ serverId, line }) => {
    if (serverId !== currentServerId) return;
    appendLogLine(line, true);
  });

  socket.on('log_history', ({ serverId, logs }) => {
    if (serverId !== currentServerId) return;
    const output = document.getElementById('console-output');
    output.innerHTML = '';
    logs.forEach(l => appendLogLine(l.line, false));
    output.scrollTop = output.scrollHeight;
    document.getElementById('log-count').textContent = `${logs.length} lines`;
  });

  socket.on('chat', ({ serverId, player, message, timestamp }) => {
    if (serverId !== currentServerId) return;
    appendChatMsg(player, message, timestamp);
  });

  socket.on('chat_history', ({ serverId, messages }) => {
    if (serverId !== currentServerId) return;
    const output = document.getElementById('chat-output');
    if (!output || !messages.length) return;
    output.innerHTML = '';
    messages.forEach(m => appendChatMsg(m.player, m.message, m.timestamp));
    output.scrollTop = output.scrollHeight;
  });
}

// ── Navigation ────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
  });
}

function navigateTo(page, serverId = null) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  if (serverId) {
    if (currentServerId && currentServerId !== serverId) {
      socket?.emit('unsubscribe_server', currentServerId);
    }
    currentServerId = serverId;
    document.getElementById('page-server').classList.add('active');
    const navItem = document.querySelector(`.nav-item[data-server="${serverId}"]`);
    if (navItem) navItem.classList.add('active');
    loadServerPage(serverId);
  } else {
    if (currentServerId) {
      socket?.emit('unsubscribe_server', currentServerId);
      currentServerId = null;
    }
    document.getElementById(`page-${page}`)?.classList.add('active');
    const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navItem) navItem.classList.add('active');
    if (page === 'users') loadUsers();
    if (page === 'files') loadFiles(currentPath);
    if (page === 'backups') renderBackupGrid();
    if (page === 'history') initHistoryPage();
  }
}

// ── Infra Status ──────────────────────────────────────
async function updateInfraStatus() {
  const res = await api('/api/pc/status');
  if (!res || res.error) return;
  const piDot = document.getElementById('pi-status-dot');
  const pcDot = document.getElementById('pc-status-dot');
  const piLabel = document.getElementById('pi-status-label');
  const pcLabel = document.getElementById('pc-status-label');
  const wakeBtn = document.getElementById('wake-pc-btn');
  if (piDot) piDot.className = `status-dot ${res.pi ? 'online' : 'offline'}`;
  if (piLabel) piLabel.textContent = res.pi ? 'Pi Online' : 'Pi Offline';
  if (pcDot) pcDot.className = `status-dot ${res.pc ? 'online' : 'offline'}`;
  if (pcLabel) pcLabel.textContent = res.pc ? 'PC Online' : 'PC Offline';
  if (wakeBtn) wakeBtn.disabled = res.pc;
}

async function wakePc() {
  const btn = document.getElementById('wake-pc-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const res = await api('/api/pc/wake', 'POST');
  if (res.error) {
    showToast(res.error, 'error');
    btn.disabled = false;
    btn.textContent = 'Wake PC';
    return;
  }
  showToast('WoL packet sent — PC booting in ~30s', 'success');
  btn.textContent = 'Waking…';
  setTimeout(updateInfraStatus, 35000);
}

// ── World History ─────────────────────────────────────
async function initHistoryPage() {
  const srvs = await api('/api/servers');
  if (!srvs || srvs.error || !srvs.length) return;

  const tabs = document.getElementById('history-server-tabs');
  tabs.innerHTML = srvs.map((s, i) => `
    <button class="history-server-tab ${i === 0 ? 'active' : ''}" onclick="switchHistoryServer('${s.id}', this)">${s.name}</button>
  `).join('');

  document.querySelectorAll('.history-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.history-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.history-view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`history-${tab.dataset.view}-view`).classList.add('active');
    });
  });

  document.getElementById('cal-prev').addEventListener('click', () => {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
    renderCalendar();
  });

  await switchHistoryServer(srvs[0].id, tabs.querySelector('.history-server-tab'));
}

async function switchHistoryServer(serverId, btn) {
  historyServerId = serverId;
  document.querySelectorAll('.history-server-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const res = await api(`/api/snapshots/${serverId}/manifest`);
  historySnapshots = res?.snapshots || [];
  selectedSnapshot = null;

  renderCalendar();
  renderTimeline();
  updateTimelapseRange();

  document.getElementById('history-viewer-wrap').style.display = 'none';
  document.getElementById('history-snapshot-info').innerHTML =
    `<div style="color:var(--text3);font-size:13px;text-align:center;padding:40px 0">${historySnapshots.length} snapshot${historySnapshots.length !== 1 ? 's' : ''} available — select a date</div>`;
}

function renderCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const label = calendarDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  document.getElementById('cal-month-label').textContent = label;

  const snapshotDates = new Set(historySnapshots.map(s => s.date));
  const today = new Date().toISOString().slice(0, 10);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  let html = days.map(d => `<div class="cal-day-header">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hasSnap = snapshotDates.has(dateStr);
    const isToday = dateStr === today;
    const isSelected = selectedSnapshot?.date === dateStr;
    const cls = ['cal-day', hasSnap ? 'has-snapshot' : '', isToday ? 'today' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ');
    const click = hasSnap ? `onclick="selectSnapshot('${dateStr}')"` : '';
    html += `<div class="${cls}" ${click}>${d}</div>`;
  }

  document.getElementById('calendar-grid').innerHTML = html;
}

function selectSnapshot(dateStr) {
  selectedSnapshot = historySnapshots.find(s => s.date === dateStr);
  if (!selectedSnapshot) return;
  renderCalendar();

  const players = Array.isArray(selectedSnapshot.playersOnline) && selectedSnapshot.playersOnline.length
    ? selectedSnapshot.playersOnline.join(', ')
    : 'None recorded';

  document.getElementById('history-snapshot-info').innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:12px">${new Date(selectedSnapshot.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <div class="snapshot-info-row"><span class="snapshot-info-label">Tiles</span><span class="snapshot-info-value">${selectedSnapshot.tileCount?.toLocaleString() || '—'}</span></div>
    <div class="snapshot-info-row"><span class="snapshot-info-label">Size</span><span class="snapshot-info-value">${selectedSnapshot.sizeMB || '—'} MB</span></div>
    <div class="snapshot-info-row"><span class="snapshot-info-label">Players online</span><span class="snapshot-info-value">${escHtml(players)}</span></div>
    <div class="snapshot-info-row"><span class="snapshot-info-label">Taken at</span><span class="snapshot-info-value">${selectedSnapshot.timestamp?.slice(11, 16) || '—'}</span></div>
    <button class="btn-primary" style="width:100%;margin-top:12px;justify-content:center" onclick="loadSnapshotViewer('${dateStr}')">🗺 View Map</button>
  `;

  document.getElementById('history-viewer-wrap').style.display = 'none';
}

function loadSnapshotViewer(dateStr) {
  const wrap = document.getElementById('history-viewer-wrap');
  const iframe = document.getElementById('history-bluemap-iframe');
  const label = document.getElementById('history-viewer-label');
  label.textContent = `World on ${dateStr}`;
  iframe.src = `/snapshots/${historyServerId}/${dateStr}/`;
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth' });
}

function toggleFullscreenViewer() {
  const iframe = document.getElementById('history-bluemap-iframe');
  if (iframe.requestFullscreen) iframe.requestFullscreen();
}

function renderTimeline() {
  const scroll = document.getElementById('timeline-scroll');
  if (!historySnapshots.length) {
    scroll.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px">No snapshots available</div>';
    return;
  }
  scroll.innerHTML = [...historySnapshots].reverse().map(s => `
    <div class="timeline-card" onclick="loadTimelineSnapshot('${s.date}', this)">
      <div class="timeline-card-thumb">🗺</div>
      <div class="timeline-card-date">${s.date}</div>
      <div class="timeline-card-meta">${s.sizeMB || '?'} MB · ${Array.isArray(s.playersOnline) ? s.playersOnline.length : 0} players</div>
    </div>
  `).join('');
}

function loadTimelineSnapshot(dateStr, card) {
  document.querySelectorAll('.timeline-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  const wrap = document.getElementById('timeline-viewer-wrap');
  const iframe = document.getElementById('timeline-bluemap-iframe');
  iframe.src = `/snapshots/${historyServerId}/${dateStr}/`;
  wrap.style.display = 'block';
}

function updateTimelapseRange() {
  if (!historySnapshots.length) return;
  const dates = historySnapshots.map(s => s.date);
  document.getElementById('timelapse-from').value = dates[0];
  document.getElementById('timelapse-to').value = dates[dates.length - 1];
}





function loadCompareA() {
  const date = document.getElementById('compare-date-a').value;
  if (!date) return;
  document.getElementById('compare-label-a').textContent = date;
  document.getElementById('compare-iframe-a').src = `/snapshots/${historyServerId}/${date}/`;
}

function loadCompareB() {
  const date = document.getElementById('compare-date-b').value;
  if (!date) return;
  document.getElementById('compare-label-b').textContent = date;
  document.getElementById('compare-iframe-b').src = `/snapshots/${historyServerId}/${date}/`;
}

// ── Dashboard ─────────────────────────────────────────
function renderDashboard(statuses) {
  const grid = document.getElementById('server-grid');
  if (!grid) return;

  grid.innerHTML = statuses.map(s => {
    const tpsClass = !s.tps ? 'muted' : s.tps.m1 >= 18 ? 'good' : s.tps.m1 >= 14 ? 'warn' : 'bad';
    const tpsVal = s.tps ? s.tps.m1.toFixed(1) : '—';
    const playerChips = s.players.length
      ? s.players.map(p => `<span class="player-chip">${escHtml(p)}</span>`).join('')
      : `<span style="font-size:12px;color:var(--text3)">No players online</span>`;

    const adminActions = user?.role === 'admin' ? `
      <div class="server-card-footer">
        <button class="card-action-btn" onclick="event.stopPropagation();runBackup('${s.id}',this)" ${!s.online ? 'disabled' : ''}>Backup</button>
        <button class="card-action-btn danger" onclick="event.stopPropagation();confirmStop('${s.id}')" ${!s.online ? 'disabled' : ''}>Stop</button>
      </div>` : '';

    return `
      <div class="server-card" onclick="navigateTo('server','${s.id}')">
        <div class="server-card-top">
          <div class="server-card-name">${s.name}</div>
          <div class="server-status-badge ${s.online ? 'online' : 'offline'}">
            <span class="status-dot ${s.online ? 'online' : 'offline'}"></span>
            ${s.online ? 'Online' : 'Offline'}
          </div>
        </div>
        <div class="server-card-body">
          <div class="server-stats-grid">
            <div class="server-stat">
              <div class="server-stat-label">Players</div>
              <div class="server-stat-value">${s.online ? s.players.length : '—'}</div>
            </div>
            <div class="server-stat">
              <div class="server-stat-label">TPS</div>
              <div class="server-stat-value ${tpsClass}">${s.online ? tpsVal : '—'}</div>
            </div>
            <div class="server-stat">
              <div class="server-stat-label">Address</div>
              <div class="server-stat-value" style="font-size:10.5px">${s.address || '—'}</div>
            </div>
          </div>
          <div class="server-players-list">${playerChips}</div>
        </div>
        ${adminActions}
      </div>`;
  }).join('');
}

function updateServerNav(statuses) {
  const nav = document.getElementById('servers-nav');
  statuses.forEach(s => {
    let item = nav.querySelector(`[data-server="${s.id}"]`);
    if (!item) {
      item = document.createElement('a');
      item.className = 'nav-item';
      item.dataset.server = s.id;
      item.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3z"/></svg>${s.name}<span class="server-dot ${s.online ? 'online' : ''}"></span>`;
      item.addEventListener('click', () => navigateTo('server', s.id));
      nav.appendChild(item);
    } else {
      const dot = item.querySelector('.server-dot');
      if (dot) { dot.className = `server-dot ${s.online ? 'online' : ''}`; }
    }
  });
}

// ── Server Page ───────────────────────────────────────
function initServerPage() {
  document.querySelectorAll('.console-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.console-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.console-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}-panel`).classList.add('active');
    });
  });

  document.getElementById('console-send')?.addEventListener('click', sendConsoleCmd);
  document.getElementById('console-cmd')?.addEventListener('keydown', e => e.key === 'Enter' && sendConsoleCmd());

  document.getElementById('log-search')?.addEventListener('input', e => {
    clearTimeout(logSearchTimeout);
    logSearchTimeout = setTimeout(() => searchLogs(e.target.value), 400);
  });

  document.getElementById('server-backup-btn')?.addEventListener('click', () => {
    if (!currentServerId) return;
    runBackupFromPage(currentServerId);
  });

  document.getElementById('server-stop-btn')?.addEventListener('click', () => {
    if (!currentServerId) return;
    confirmStop(currentServerId);
  });
}

function loadServerPage(serverId) {
  const srv = serverStatuses.find(s => s.id === serverId);
  document.getElementById('server-page-title').textContent = srv?.name || serverId;
  document.getElementById('server-page-subtitle').textContent = srv?.address || '';
  document.getElementById('console-output').innerHTML = '';
  document.getElementById('chat-output').innerHTML = '<div class="chat-empty">No messages yet — chat will appear here live</div>';

  if (user?.role === 'admin') {
    document.getElementById('console-input-bar')?.classList.remove('hidden');
    document.getElementById('server-admin-actions')?.classList.remove('hidden');
  }

  socket?.emit('subscribe_server', serverId);
  updateServerInfoPanel(srv);
}

function updateServerPage(statuses) {
  if (!currentServerId) return;
  const srv = statuses.find(s => s.id === currentServerId);
  if (srv) updateServerInfoPanel(srv);
}

function updateServerInfoPanel(srv) {
  if (!srv) return;
  const stateEl = document.getElementById('info-state');
  if (stateEl) {
    stateEl.textContent = srv.online ? 'Online' : 'Offline';
    stateEl.className = `info-row-value ${srv.online ? 'good' : 'muted'}`;
  }
  const tpsEl = document.getElementById('info-tps');
  if (tpsEl && srv.tps) {
    tpsEl.textContent = `${srv.tps.m1.toFixed(1)} / ${srv.tps.m5.toFixed(1)} / ${srv.tps.m15.toFixed(1)}`;
    tpsEl.className = `info-row-value ${srv.tps.m1 >= 18 ? 'good' : srv.tps.m1 >= 14 ? 'warn' : 'bad'}`;
  } else if (tpsEl) { tpsEl.textContent = '—'; tpsEl.className = 'info-row-value muted'; }
  const playersEl = document.getElementById('info-players');
  if (playersEl) playersEl.textContent = srv.online ? `${srv.players.length}` : '—';
  const addrEl = document.getElementById('info-address');
  if (addrEl) addrEl.textContent = srv.address || '—';

  const list = document.getElementById('online-players-list');
  if (list) {
    if (srv.players.length) {
      list.innerHTML = srv.players.map(p => `<div class="online-player-item">${escHtml(p)}</div>`).join('');
    } else {
      list.innerHTML = '<div style="font-size:12px;color:var(--text3)">No players online</div>';
    }
  }
}

function appendLogLine(line, scroll = true) {
  const output = document.getElementById('console-output');
  if (!output) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('exception')) div.classList.add('log-error');
  else if (lower.includes('warn')) div.classList.add('log-warn');
  else if (lower.includes('/info')) div.classList.add('log-info');
  div.textContent = line;
  output.appendChild(div);
  if (scroll && output.scrollHeight - output.scrollTop < output.clientHeight + 120) {
    output.scrollTop = output.scrollHeight;
  }
}

function appendChatMsg(player, message, timestamp) {
  const output = document.getElementById('chat-output');
  if (!output) return;
  const empty = output.querySelector('.chat-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
  div.innerHTML = `<span class="chat-time">${time}</span><span class="chat-player">${escHtml(player)}</span><span class="chat-text">${escHtml(message)}</span>`;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

async function sendConsoleCmd() {
  const input = document.getElementById('console-cmd');
  const command = input?.value.trim();
  if (!command || !currentServerId) return;
  input.value = '';
  const res = await api(`/api/servers/${currentServerId}/command`, 'POST', { command });
  if (res.error) showToast(res.error, 'error');
}

async function searchLogs(query) {
  if (!currentServerId) return;
  const res = await api(`/api/logs/${currentServerId}?limit=500&search=${encodeURIComponent(query)}`);
  if (!res || res.error) return;
  const output = document.getElementById('console-output');
  output.innerHTML = '';
  res.logs.forEach(l => appendLogLine(l.line, false));
  document.getElementById('log-count').textContent = `${res.total} results`;
}

// ── Backup ────────────────────────────────────────────
function initBackupsPage() {
  renderBackupGrid();
}

function renderBackupGrid() {
  const grid = document.getElementById('backup-grid');
  if (!grid || !serverStatuses.length) return;
  updateBackupGrid(serverStatuses);
}

async function updateBackupGrid(statuses) {
  const grid = document.getElementById('backup-grid');
  if (!grid) return;

  if (!grid.children.length) {
    grid.innerHTML = statuses.map(s => `
      <div class="backup-server-card" id="backup-card-${s.id}">
        <div class="backup-server-header">
          <div class="backup-server-name">${s.name}</div>
          ${user?.role === 'admin' ? `<button class="backup-trigger-btn" id="backup-btn-${s.id}" onclick="runBackup('${s.id}',this)" ${!s.online ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:#fff"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg>
            Run Backup
          </button>` : ''}
        </div>
        <div class="backup-status-bar idle" id="backup-status-${s.id}">Ready</div>
        <div class="backup-archives" id="backup-archives-${s.id}">
          <div style="padding:16px;text-align:center;font-size:12px;color:var(--text3)">Loading archives…</div>
        </div>
      </div>`).join('');

    statuses.forEach(s => loadBackupArchives(s.id));
  }
}

async function loadBackupArchives(serverId) {
  const container = document.getElementById(`backup-archives-${serverId}`);
  if (!container) return;

  const res = await api(`/api/backups/${serverId}`);
  if (!res || res.error || !res.archives?.length) {
    container.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:var(--text3)">No archives found</div>';
    return;
  }

  container.innerHTML = res.archives.map(a => `
    <div class="backup-archive-item">
      <span class="backup-archive-icon">🗜️</span>
      <div class="backup-archive-info">
        <div class="backup-archive-name">${a.name}</div>
        <div class="backup-archive-meta">${a.size} · ${a.date}</div>
      </div>
      <div class="backup-archive-actions">
        <a href="/api/backups/${serverId}/download?file=${encodeURIComponent(a.name)}" class="file-action-btn download" download>↓ Download</a>
      </div>
    </div>`).join('');
}

async function runBackup(serverId, btn) {
  const statusEl = document.getElementById(`backup-status-${serverId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> Running…`; btn.classList.add('running'); }
  if (statusEl) { statusEl.className = 'backup-status-bar running'; statusEl.innerHTML = '<div class="spinner"></div> Backup running — this may take a few minutes…'; }

  const res = await api(`/api/servers/${serverId}/backup`, 'POST');

  if (btn) { btn.disabled = false; btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:#fff"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg> Run Backup`; btn.classList.remove('running'); }

  if (res.success) {
    if (statusEl) { statusEl.className = 'backup-status-bar running'; statusEl.innerHTML = '<div class="spinner"></div> Backup running in background — check back in a few minutes'; }
    showToast('Backup started', 'success');
    setTimeout(() => loadBackupArchives(serverId), 3 * 60 * 1000);
  } else {
    if (statusEl) { statusEl.className = 'backup-status-bar error'; statusEl.textContent = `✗ ${res.error || 'Backup failed'}`; }
    showToast(res.error || 'Backup failed', 'error');
  }
}

async function runBackupFromPage(serverId) {
  const btn = document.getElementById('server-backup-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running backup…'; }
  const res = await api(`/api/servers/${serverId}/backup`, 'POST');
  if (btn) { btn.disabled = false; btn.textContent = 'Run Backup'; }
  if (res.success) showToast('Backup complete!', 'success');
  else showToast(res.error || 'Backup failed', 'error');
}

function confirmStop(serverId) {
  const srv = serverStatuses.find(s => s.id === serverId);
  showConfirm(
    `Stop ${srv?.name || serverId}?`,
    `This will save the world, run a backup, then stop the server.`,
    async () => {
      showToast('Stopping server…', 'warning');
      const res = await api(`/api/servers/${serverId}/stop`, 'POST');
      if (res.success || res.output?.includes('stopped')) showToast('Server stopped', 'success');
      else showToast(res.error || 'Stop failed', 'error');
    }
  );
}

// ── Stats ─────────────────────────────────────────────
async function loadStats() {
  const stats = await api('/api/stats');
  if (!stats || stats.error) return;

  const pi = stats.pi || {};
  const pc = stats.pc || {};

  const pi_cpu = Math.min(100, pi.cpu || 0);
  const pi_ram = pi.ram_total > 0 ? (pi.ram_used / pi.ram_total) * 100 : 0;
  const pi_disk = pi.disk_total > 0 ? (pi.disk_used / pi.disk_total) * 100 : 0;

  setRing('cpu-circle', pi_cpu, 238.76);
  setRing('ram-circle', pi_ram, 238.76);
  setRing('disk-circle', pi_disk, 238.76);
  setText('cpu-value', `${pi_cpu.toFixed(0)}%`);
  setText('ram-value', `${pi_ram.toFixed(0)}%`);
  setText('disk-value', `${pi_disk.toFixed(0)}%`);
  setText('ram-sub', `${fmtBytes(pi.ram_used)} / ${fmtBytes(pi.ram_total)}`);
  setText('disk-sub', `${fmtBytes(pi.disk_used)} / ${fmtBytes(pi.disk_total)}`);

  const pc_cpu = Math.min(100, pc.cpu || 0);
  const pc_ram = pc.ram_total > 0 ? (pc.ram_used / pc.ram_total) * 100 : 0;
  const pc_disk = pc.disk_c_total > 0 ? (pc.disk_c_used / pc.disk_c_total) * 100 : 0;

  setRing('pc-cpu-circle', pc_cpu, 238.76);
  setRing('pc-ram-circle', pc_ram, 238.76);
  setRing('pc-disk-circle', pc_disk, 238.76);
  setText('pc-cpu-value', `${pc_cpu.toFixed(0)}%`);
  setText('pc-ram-value', `${pc_ram.toFixed(0)}%`);
  setText('pc-disk-value', `${pc_disk.toFixed(0)}%`);
  setText('pc-ram-sub', `${fmtBytes(pc.ram_used)} / ${fmtBytes(pc.ram_total)}`);
  setText('pc-disk-sub', `C: ${fmtBytes(pc.disk_c_used)}/${fmtBytes(pc.disk_c_total)}\nD: ${fmtBytes(pc.disk_d_used)}/${fmtBytes(pc.disk_d_total)}`);
}

function setRing(id, pct, circumference = 238.76) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.strokeDashoffset = circumference * (1 - Math.min(100, pct) / 100);
}

// ── File Manager ──────────────────────────────────────
function initFilePage() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('file-upload-input');

  zone?.addEventListener('click', () => input?.click());
  zone?.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone?.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone?.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    handleUpload(Array.from(e.dataTransfer.files));
  });
  input?.addEventListener('change', e => handleUpload(Array.from(e.target.files)));

  document.getElementById('file-up-btn')?.addEventListener('click', () => {
    const parts = currentPath.replace(/\\/g, '/').split('/');
    if (parts.length > 1) { parts.pop(); loadFiles(parts.join('/')); }
  });

  document.querySelectorAll('.file-shortcut[data-path]').forEach(el => {
    el.addEventListener('click', () => {
      const srv = el.dataset.server || getFirstServerId();
      if (srv) loadFiles(`C:/MinecraftServer/${srv}/${el.dataset.path}`);
    });
  });

  const shortcutContainer = document.getElementById('file-server-shortcuts');
  if (shortcutContainer) {
    api('/api/servers').then(servers => {
      if (!servers || servers.error) return;
      shortcutContainer.innerHTML = servers.map(s => `
        <div class="file-shortcut" onclick="loadFiles('C:/MinecraftServer/${s.id}')">
          <span class="file-shortcut-icon">🖥️</span> ${s.name}
        </div>`).join('');
    });
  }
}

function getFirstServerId() {
  return serverStatuses[0]?.id || '';
}

async function loadFiles(path) {
  currentPath = path;
  document.getElementById('file-breadcrumb').textContent = path;

  const res = await api(`/api/files?path=${encodeURIComponent(path)}`);
  const body = document.getElementById('file-list-body');
  if (!body) return;

  if (!res || res.error) {
    body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">${res?.error || 'Failed to load'}</div>`;
    return;
  }

  if (!res.files.length) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Empty folder</div>';
    return;
  }

  body.innerHTML = res.files.map(f => {
    const icon = f.type === 'directory' ? '📁' : fileIcon(f.name);
    const size = f.type === 'file' ? fmtBytes(f.size) : '—';
    const date = f.modifyTime ? new Date(f.modifyTime * 1000).toLocaleDateString('en-GB') : '—';
    const filePath = `${path}/${f.name}`;
    const downloadBtn = f.type === 'file' ? `<a href="/api/files/download?path=${encodeURIComponent(filePath)}" class="file-action-btn download" download onclick="event.stopPropagation()">↓</a>` : '';
    const deleteBtn = user?.role === 'admin' ? `<button class="file-action-btn delete" onclick="event.stopPropagation();deleteFile('${filePath.replace(/'/g, "\\'")}')">✕</button>` : '';

    return `
      <div class="file-item" onclick="${f.type === 'directory' ? `loadFiles('${filePath.replace(/'/g, "\\'")}')` : ''}">
        <div class="file-item-name"><span class="file-icon">${icon}</span><span>${escHtml(f.name)}</span></div>
        <div class="file-size">${size}</div>
        <div class="file-date">${date}</div>
        <div class="file-actions">${downloadBtn}${deleteBtn}</div>
      </div>`;
  }).join('');
}

async function handleUpload(files) {
  const progressList = document.getElementById('upload-progress-list');
  if (!progressList) return;

  for (const file of files) {
    const id = `upload-${Date.now()}-${Math.random()}`;
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.id = id;
    item.innerHTML = `
      <div class="upload-item-header">
        <span class="upload-item-name">${escHtml(file.name)}</span>
        <span class="upload-item-status">Uploading…</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>`;
    progressList.appendChild(item);

    const fill = item.querySelector('.progress-fill');
    const status = item.querySelector('.upload-item-status');

    let prog = 0;
    const interval = setInterval(() => { prog = Math.min(prog + 5, 90); fill.style.width = `${prog}%`; }, 100);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('remotePath', currentPath + '/');

    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      clearInterval(interval);
      if (data.success) {
        fill.style.width = '100%'; fill.classList.add('done');
        status.textContent = 'Done ✓';
        setTimeout(() => { item.remove(); loadFiles(currentPath); }, 2000);
      } else {
        fill.classList.add('error'); status.textContent = `Failed: ${data.error}`;
        setTimeout(() => item.remove(), 4000);
      }
    } catch {
      clearInterval(interval);
      fill.classList.add('error'); status.textContent = 'Upload failed';
      setTimeout(() => item.remove(), 4000);
    }
  }
}

async function deleteFile(filePath) {
  showConfirm('Delete file?', filePath.split('/').pop(), async () => {
    const res = await api('/api/files', 'DELETE', { path: filePath });
    if (res.success) { showToast('Deleted', 'success'); loadFiles(currentPath); }
    else showToast(res.error, 'error');
  });
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = { jar: '⚙️', zip: '🗜️', gz: '🗜️', yml: '📄', yaml: '📄', json: '📄', toml: '📄', txt: '📝', log: '📋', properties: '⚙️', sh: '📜', ps1: '📜' };
  return icons[ext] || '📄';
}

// ── Users ─────────────────────────────────────────────
function initUsersPage() {}

async function loadUsers() {
  const res = await api('/api/users');
  if (!res || res.error) return;
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = res.map(u => `
    <tr>
      <td><strong>${escHtml(u.username)}</strong></td>
      <td><span class="role-pill ${u.role}">${u.role}</span></td>
      <td style="color:var(--text3);font-size:12px">${new Date(u.created_at).toLocaleDateString('en-GB')}</td>
      <td>
        <button class="action-btn" onclick="toggleRole(${u.id},'${u.role}')">${u.role === 'admin' ? 'Demote' : 'Promote'}</button>
        <button class="action-btn danger" onclick="deleteUser(${u.id},'${escHtml(u.username)}')">Remove</button>
      </td>
    </tr>`).join('');
}

async function toggleRole(id, current) {
  const newRole = current === 'admin' ? 'player' : 'admin';
  const res = await api(`/api/users/${id}/role`, 'PATCH', { role: newRole });
  if (res.success) { showToast(`Role updated to ${newRole}`, 'success'); loadUsers(); }
  else showToast(res.error, 'error');
}

async function deleteUser(id, name) {
  showConfirm(`Remove ${name}?`, 'This will permanently delete their account.', async () => {
    const res = await api(`/api/users/${id}`, 'DELETE');
    if (res.success) { showToast('User removed', 'success'); loadUsers(); }
    else showToast(res.error, 'error');
  });
}

// ── Invites ───────────────────────────────────────────
function initInvitesPage() {
  document.getElementById('gen-invite-btn')?.addEventListener('click', async () => {
    const res = await api('/api/invites/generate', 'POST');
    if (res.error) { showToast(res.error, 'error'); return; }
    const div = document.getElementById('invite-result');
    div.innerHTML = `
      <div class="invite-result">
        <div style="font-size:11px;font-weight:600;color:var(--text3);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px">Invite Code</div>
        <div class="invite-code">${res.code}</div>
        <div class="invite-expire">Expires ${new Date(res.expires).toLocaleString('en-GB')}</div>
        <div class="invite-url mt-8">Register at: <strong>${window.location.origin}</strong></div>
        <div class="mt-8" style="font-size:12px;color:var(--text2)">Share via Discord bot: <code style="background:var(--bg3);padding:2px 6px;border-radius:4px">panel</code></div>
      </div>`;
  });
}

// ── Confirm Modal ─────────────────────────────────────
let confirmCallback = null;

function showConfirm(title, subtitle, callback) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-subtitle').textContent = subtitle;
  confirmCallback = callback;
  document.getElementById('confirm-modal').classList.add('active');
}

document.getElementById('modal-cancel')?.addEventListener('click', () => {
  document.getElementById('confirm-modal').classList.remove('active');
  confirmCallback = null;
});

document.getElementById('modal-confirm')?.addEventListener('click', () => {
  document.getElementById('confirm-modal').classList.remove('active');
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
});

// ── Utils ─────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return await res.json();
  } catch (err) { return { error: err.message }; }
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`${name}-screen`).classList.add('active');
}

function showToast(msg, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', warning: '⚠', '': 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escHtml(msg)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes >= 1e12) return `${(bytes/1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes/1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes/1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes/1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}
