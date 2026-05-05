// ================================================================
// Arbeitsdokumentation - Frontend Application
// ================================================================

// --- State ---
const S = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  tabId: Math.random().toString(36).slice(2),
  sse: null,
  entries: [],
  users: [],
  projects: [],
  settings: {},
  view: 'day',
  currentDate: new Date(),
  filterUserId: '',
  filterProjectId: '',
  filterSearch: '',
  filterRegie: '',
  filterAbsenceType: '',
  welcomeWeekOffset: 0,
  badges: { bulletin: 0, notes: 0, orders: 0 },
};

// --- Cross-Tab Broadcast für Abwesenheitsänderungen ---
const _absenceBroadcast = new BroadcastChannel('arbeitsdoku-absences');
_absenceBroadcast.onmessage = () => {
  const h = location.hash;
  if (h === '#/' || h === '#' || h === '') renderDashboardContent();
};
function broadcastAbsenceChange() {
  try { _absenceBroadcast.postMessage(1); } catch(e) {}
}

// --- API Helper ---
async function api(method, url, body, isFormData) {
  const opts = { method, headers: {} };
  if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
  opts.headers['X-Tab-Id'] = S.tabId;
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isFormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.includes('/auth/login')) { logout(); return null; }
  if (res.headers.get('content-type')?.includes('json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fehler');
    return data;
  }
  if (!res.ok) throw new Error('Fehler');
  return res;
}

// --- Utilities ---
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

async function loadBadges() {
  if (!S.token) return;
  try {
    const data = await api('GET', '/api/badges');
    if (!data) return;
    Object.assign(S.badges, data);
    refreshBadges();
  } catch (_) {}
}

function markSeen(topic) {
  if (!S.token) return;
  api('POST', '/api/badges/' + topic).catch(() => {});
}

function refreshBadges() {
  for (const key of ['bulletin', 'notes', 'orders', 'absences']) {
    const el = document.getElementById('nav-badge-' + key);
    if (!el) continue;
    const n = S.badges[key] || 0;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n ? '' : 'none';
  }
  const total = (S.badges.bulletin || 0) + (S.badges.notes || 0) + (S.badges.orders || 0) + (S.badges.absences || 0);
  if ('setAppBadge' in navigator) {
    if (total > 0) navigator.setAppBadge(total).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  }
}

function fmtH(val) {
  const neg = val < 0;
  const totalMin = Math.round(Math.abs(val) * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return (neg ? '-' : '') + h + ':' + String(m).padStart(2, '0');
}

const REGIE_LABELS = { 0: 'Nein', 1: 'Ja', 2: 'pauschal', 3: 'Büro', 4: 'Lager', 5: 'Intern' };

// Tatsächliche Arbeitszeit berechnen (überlappende Einträge nicht doppelt zählen)
function calcActualHours(entries) {
  // Gruppieren nach User + Datum
  const groups = {};
  for (const e of entries) {
    const key = `${e.user_id}_${e.date}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  let total = 0;
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    // Intervalle als Minuten ab Mitternacht + Pausenminuten
    const intervals = group.map(e => {
      const [fh, fm] = e.time_from.split(':').map(Number);
      const [th, tm] = e.time_to.split(':').map(Number);
      return { from: fh * 60 + fm, to: th * 60 + tm, breakMin: e.break_minutes || 0 };
    }).filter(i => i.to > i.from).sort((a, b) => a.from - b.from);
    if (!intervals.length) continue;
    // Intervalle mergen
    const merged = [{ from: intervals[0].from, to: intervals[0].to }];
    let totalBreak = intervals[0].breakMin;
    for (let i = 1; i < intervals.length; i++) {
      const cur = intervals[i];
      const last = merged[merged.length - 1];
      totalBreak += cur.breakMin;
      if (cur.from <= last.to) {
        last.to = Math.max(last.to, cur.to);
      } else {
        merged.push({ from: cur.from, to: cur.to });
      }
    }
    const bruttoMin = merged.reduce((s, i) => s + (i.to - i.from), 0);
    const netMin = Math.max(0, bruttoMin - totalBreak);
    total += netMin / 60;
  }
  return Math.round(total * 100) / 100;
}

function entryTooltipHtml(e) {
  const rv = e.has_regie || 0;
  const regieText = rv === 0 ? 'Nein' : rv === 1 ? ('Ja – ' + (e.regie_user_name || '')) : REGIE_LABELS[rv] || 'Ja';
  const lines = [
    `<strong>${esc(e.project_name || e.project_text || 'Kein Projekt')}</strong>`,
    `Zeit: ${esc(e.time_from)} - ${esc(e.time_to)} (${fmtH(e.net_hours)} netto)`,
    e.break_minutes ? `Pause: ${e.break_minutes} min` : '',
    e.address ? `Ort: ${esc(e.address)}` : '',
    e.client ? `Kunde: ${esc(e.client)}` : '',
    e.description ? `Beschreibung: ${esc(e.description)}` : '',
    `Regie: ${regieText}`,
    e.user_name ? `Mitarbeiter: ${esc(e.user_name)}` : '',
  ];
  return lines.filter(l => l).join('<br>');
}

function planEntryTooltipHtml(e) {
  const lines = [
    `<strong>${esc(e.project_name || e.project_text || 'Kein Projekt')}</strong>`,
    `Zeit: ${esc(e.time_from)} - ${esc(e.time_to)}`,
    e.client ? `Kunde: ${esc(e.client)}` : '',
    e.address ? `Ort: ${esc(e.address)}` : '',
    e.description ? `Beschreibung: ${esc(e.description)}` : '',
    (e.assigned && e.assigned.length) ? `Mitarbeiter: ${e.assigned.map(a => esc(a.user_name)).join(', ')}` : '',
    e.created_by_name ? `Erstellt von: ${esc(e.created_by_name)}` : '',
  ];
  return lines.filter(l => l).join('<br>');
}

// Globaler Tooltip
let tooltipEl = null;
let _tooltipSuppressed = false;
function initTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'entry-tooltip';
  tooltipEl.style.display = 'none';
  document.body.appendChild(tooltipEl);
}
function showTooltip(html, x, y) {
  if (_tooltipSuppressed) return;
  initTooltip();
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = '';
  const rect = tooltipEl.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 10;
  const maxY = window.innerHeight - rect.height - 10;
  tooltipEl.style.left = Math.max(5, Math.min(x + 12, maxX)) + 'px';
  tooltipEl.style.top = Math.max(5, Math.min(y + 12, maxY)) + 'px';
}
function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}
function suppressTooltip() {
  hideTooltip();
  _tooltipSuppressed = true;
  setTimeout(() => { _tooltipSuppressed = false; }, 500);
}

function regieHtmlBadge(entry, extraStyle) {
  const v = entry.has_regie || 0;
  if (v === 0) return `<span class="regie-badge regie-no"${extraStyle ? ' style="' + extraStyle + '"' : ''}>&#10008; Nein</span>`;
  if (v === 1) return `<span class="regie-badge regie-yes"${extraStyle ? ' style="' + extraStyle + '"' : ''}>&#10004; ${esc(entry.regie_user_name || '')}</span>`;
  return `<span class="regie-badge regie-yes"${extraStyle ? ' style="' + extraStyle + '"' : ''}>&#10004; ${REGIE_LABELS[v] || ''}</span>`;
}

function openNav(address) {
  const q = encodeURIComponent(address);
  // iOS/Android native Apps bevorzugen, Fallback auf Google Maps
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    window.open('maps://maps.apple.com/?daddr=' + q, '_blank');
  } else {
    window.open('https://www.google.com/maps/dir/?api=1&destination=' + q, '_blank');
  }
}

function formatDateDE(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}
function formatDateTimeDE(dt) {
  if (!dt) return '';
  const d = new Date(dt.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return dt;
  const berlin = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const pad = n => String(n).padStart(2, '0');
  return `${pad(berlin.getDate())}.${pad(berlin.getMonth() + 1)}.${berlin.getFullYear()}, ${pad(berlin.getHours())}:${pad(berlin.getMinutes())}`;
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function calcNetHours(from, to, brk) {
  if (!from || !to) return 0;
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const mins = (th * 60 + tm) - (fh * 60 + fm) - (brk || 0);
  return Math.max(0, Math.round(mins / 60 * 100) / 100);
}

function getWeekRange(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d.setDate(diff));
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return { from: formatDateISO(mon), to: formatDateISO(sun) };
}

function getMonthRange(date) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  return { from: formatDateISO(first), to: formatDateISO(last) };
}

function countWeekdays(from, to) {
  let count = 0;
  const s = new Date(from);
  const e = new Date(to);
  const c = new Date(s);
  while (c <= e) {
    const day = c.getDay();
    if (day !== 0 && day !== 6) count++;
    c.setDate(c.getDate() + 1);
  }
  return count;
}

function roleName(role) {
  const map = { admin: 'Administrator', chef: 'Chef', buchhalter: 'Buchhalter', mitarbeiter: 'Mitarbeiter' };
  return map[role] || role;
}

// Farbpalette für Projekte/Mitarbeiter
const PALETTE = ['#4f46e5','#059669','#d97706','#dc2626','#7c3aed','#2563eb','#db2777','#65a30d','#0891b2','#ea580c','#6d28d9','#0d9488'];
function colorFor(id, fallback) { return id ? PALETTE[(id - 1) % PALETTE.length] : (fallback || '#64748b'); }

// Timeline-Konstanten
const TL_HOUR_PX = 50;
const TL_START_HOUR = 0;
const TL_END_HOUR = 24;
const TL_SCROLL_TO_HOUR = 6; // Scroll-Position: 6 Uhr oben sichtbar

function isChefOrAdmin() {
  return S.user && (S.user.role === 'admin' || S.user.role === 'chef');
}

function canManageProjects() {
  return S.user && (S.user.role === 'admin' || S.user.role === 'chef');
}

function canManageUsers() {
  return isChefOrAdmin();
}

function canViewAll() {
  return S.user && S.user.role !== 'mitarbeiter';
}

function canSeeSettings() {
  return isChefOrAdmin();
}

function canCreateEntries() {
  return S.user != null;
}

function isAdmin() {
  return S.user && S.user.role === 'admin';
}

function canEditPlanning() {
  return isChefOrAdmin() || (S.user && S.user.can_plan);
}

function canEditBulletin() {
  return isChefOrAdmin() || (S.user && S.user.can_bulletin);
}

// Filtere Admin-User aus Listen (Admin taucht nirgends als Mitarbeiter auf)
function getWorkerUsers() {
  return S.users.filter(u => u.role !== 'admin');
}

function toast(msg, type) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => t.classList.remove('show'), 3000);
}

// --- Router ---
function navigate(hash) {
  window.location.hash = hash;
}

function getRoute() {
  return window.location.hash.slice(1) || '/welcome';
}

// --- Render Engine ---
const $app = () => document.getElementById('app');

function render() {
  if (!S.token || !S.user) { renderLogin(); return; }
  const route = getRoute();
  if (route.startsWith('/entry/new')) renderEntryForm();
  else if (route.startsWith('/entry/continue/')) renderEntryForm(null, route.split('/').pop());
  else if (route.startsWith('/entry/')) renderEntryForm(route.split('/').pop());
  else if (route === '/users') renderUsers();
  else if (route === '/projects') renderProjects();
  else if (route === '/settings') renderSettings();
  else if (route === '/pdf') renderPdfExport();
  else if (route === '/statistics') renderStatistics();
  else if (route === '/planning') renderPlanning();
  else if (route === '/planning/new') renderPlanningForm();
  else if (route.startsWith('/planning/edit-group/')) renderPlanningForm(null, null, route.split('/').pop());
  else if (route.startsWith('/planning/edit/')) renderPlanningForm(route.split('/').pop());
  else if (route.startsWith('/planning/replan/')) renderPlanningForm(null, route.split('/').pop());
  else if (route.startsWith('/planning/accept/')) renderEntryForm(null, null, route.split('/').pop());
  else if (route === '/tools') renderTools();
  else if (route === '/orders') renderOrders();
  else if (route === '/notes') renderNotizen();
  else if (route === '/absences') renderAbsences();
  else if (route.startsWith('/absences/')) renderAbsenceType(route.split('/')[2]);
  else if (route === '/bulletin') renderBulletin();
  else if (route === '/bulletin/new') renderBulletinForm();
  else if (route.startsWith('/bulletin/edit/')) renderBulletinForm(route.split('/').pop());
  else if (route === '/welcome') renderWelcome();
  else if (route === '/' || route === '/dashboard') renderDashboard();
  else renderWelcome();
}

// --- Login ---
function renderLogin() {
  $app().innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <h1>Arbeitsdoku</h1>
        <p class="subtitle">Melden Sie sich an</p>
        <div class="error-msg" id="login-error"></div>
        <form id="login-form">
          <div class="form-group">
            <label>Benutzername</label>
            <input type="text" class="form-control" id="login-user" autocomplete="username" required>
          </div>
          <div class="form-group">
            <label>Passwort</label>
            <input type="password" class="form-control" id="login-pass" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block">Anmelden</button>
        </form>
      </div>
    </div>`;
  document.getElementById('login-form').addEventListener('submit', handleLogin);
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  try {
    const data = await api('POST', '/api/auth/login', { username, password });
    if (!data) return;
    S.token = data.token;
    S.user = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    navigate('/welcome');
    initSSE();
    loadBadges();
  } catch (err) {
    const el = document.getElementById('login-error');
    el.textContent = err.message;
    el.style.display = 'block';
  }
}

function logout() {
  if (S.sse) { S.sse.close(); S.sse = null; }
  S.token = null;
  S.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  navigate('/login');
}

function initSSE() {
  if (S.sse) return;
  S.sse = new EventSource('/api/events?token=' + encodeURIComponent(S.token));
  S.sse.onmessage = function(e) {
    let p; try { p = JSON.parse(e.data); } catch (_) { return; }
    // Bestellungs-Badge immer aktualisieren (live-Zähler, auch eigene Aktionen)
    if (p.type === 'orders') loadBadges();
    if (p.originTab === S.tabId) return;
    const route = getRoute();
    if (p.type === 'orders'   && route === '/orders')                              renderOrders();
    if (p.type === 'notes'    && route === '/notes' && !_editingNoteLockId)        renderNotizen();
    if (p.type === 'bulletin' && route === '/bulletin')                            renderBulletin();
    if (p.type === 'planning' && route === '/planning')                            renderPlanningContent();
    if (p.type === 'tools'    && route === '/tools')                               renderTools();
    if (p.type === 'entries'  && route === '/statistics')                          renderStatistics();
    if ((p.type === 'planning' || p.type === 'bulletin') && route === '/welcome')  renderWelcome();
    if (p.type === 'bulletin'  && route !== '/bulletin')  loadBadges();
    if (p.type === 'notes'     && route !== '/notes')     loadBadges();
    if (p.type === 'absences'  && route.startsWith('/absences')) renderAbsences();
    if (p.type === 'absences'  && !route.startsWith('/absences')) loadBadges();
  };
}

// --- Layout ---
function layout(content, activeNav) {
  const showUsers = canManageUsers();
  const showProjects = canManageProjects();
  const showSettings = canSeeSettings();
  const showNewEntry = canCreateEntries();

  return `
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <div class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2>${esc(S.user.name)}</h2>
        <span class="role-badge">${roleName(S.user.role)}</span>
      </div>
      <nav>
        <a href="#/welcome" class="${activeNav === 'welcome' ? 'active' : ''}">
          <span class="icon">&#127968;</span> Willkommen
        </a>
        <a href="#/" class="${activeNav === 'dashboard' ? 'active' : ''}">
          <span class="icon">&#128202;</span> Zeitnachweis
        </a>
        ${showUsers ? `<a href="#/users" class="${activeNav === 'users' ? 'active' : ''}">
          <span class="icon">&#128101;</span> Mitarbeiter
        </a>` : ''}
        ${showProjects ? `<a href="#/projects" class="${activeNav === 'projects' ? 'active' : ''}">
          <span class="icon">&#128193;</span> Projekte
        </a>` : ''}
        <a href="#/planning" class="${activeNav === 'planning' ? 'active' : ''}">
          <span class="icon">&#128197;</span> Planung
        </a>
        <a href="#/bulletin" class="${activeNav === 'bulletin' ? 'active' : ''}">
          <span class="icon">&#128204;</span> Schwarzes Brett
          <span class="nav-badge" id="nav-badge-bulletin"${S.badges.bulletin ? '' : ' style="display:none"'}>${S.badges.bulletin || ''}</span>
        </a>
        <a href="#/tools" class="${activeNav === 'tools' ? 'active' : ''}">
          <span class="icon">&#128295;</span> Werkzeugliste
        </a>
        <a href="#/orders" class="${activeNav === 'orders' ? 'active' : ''}">
          <span class="icon">&#128722;</span> Bestellungen
          ${S.user.role === 'chef' ? `<span class="nav-badge" id="nav-badge-orders"${S.badges.orders ? '' : ' style="display:none"'}>${S.badges.orders || ''}</span>` : ''}
        </a>
        <a href="#/notes" class="${activeNav === 'notes' ? 'active' : ''}">
          <span class="icon">&#128221;</span> Notizen
          <span class="nav-badge" id="nav-badge-notes"${S.badges.notes ? '' : ' style="display:none"'}>${S.badges.notes || ''}</span>
        </a>
        <a href="#/absences" class="${activeNav === 'absences' ? 'active' : ''}">
          <span class="icon">&#128197;</span> Abwesenheit
          <span class="nav-badge" id="nav-badge-absences"${S.badges.absences ? '' : ' style="display:none"'}>${S.badges.absences || ''}</span>
        </a>
        <a href="#/statistics" class="${activeNav === 'statistics' ? 'active' : ''}">
          <span class="icon">&#128200;</span> Statistik
        </a>
        <div class="sidebar-divider"></div>
        <a href="#/pdf" class="${activeNav === 'pdf' ? 'active' : ''}">
          <span class="icon">&#128196;</span> PDF-Export
        </a>
        ${showSettings ? `<a href="#/settings" class="${activeNav === 'settings' ? 'active' : ''}">
          <span class="icon">&#9881;</span> Einstellungen
        </a>` : ''}
      </nav>
    </div>
    <div class="header">
      <button class="menu-btn" id="menu-btn">&#9776;</button>
      <span class="title">Arbeitsdoku</span>
      <div class="user-info">
        <span class="user-name">${esc(S.user.name)}</span>
        <button class="logout-btn" id="logout-btn">Abmelden</button>
      </div>
    </div>
    <div class="main">${content}</div>
    ${activeNav === 'planning' ? (canEditPlanning() ? '<button class="fab" id="fab-new" title="Neue Planung">+</button>' : '')
    : activeNav === 'bulletin' ? (canEditBulletin() ? '<button class="fab" id="fab-new" title="Neuer Eintrag">+</button>' : '')
    : activeNav === 'notes' ? '<button class="fab" id="fab-new" title="Neue Notiz">+</button>'
    : activeNav === 'welcome' || activeNav === 'orders' || activeNav === 'statistics' ? ''
    : (showNewEntry ? '<button class="fab" id="fab-new" title="Neuer Eintrag">+</button>' : '')}
  `;
}

function bindLayout() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const menuBtn = document.getElementById('menu-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const fab = document.getElementById('fab-new');

  if (menuBtn) menuBtn.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('open');
  });
  if (overlay) overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });
  // Close sidebar on nav click
  if (sidebar) sidebar.querySelectorAll('nav a').forEach(a => {
    a.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    });
  });
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  if (fab) fab.addEventListener('click', () => {
    const route = getRoute();
    if (route === '/planning') navigate('/planning/new');
    else if (route === '/bulletin') navigate('/bulletin/new');
    else if (route === '/notes') showNoteForm();
    else navigate('/entry/new');
  });
}

// --- Dashboard ---
async function renderDashboard() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'dashboard');
  bindLayout();

  try {
    const projData = await api('GET', '/api/projects');
    if (projData) S.projects = projData.projects;

    if (canViewAll()) {
      const userData = await api('GET', '/api/users');
      if (userData) S.users = userData.users;
    }
  } catch (e) {}

  renderDashboardContent();
}

async function renderDashboardContent() {
  const range = getDateRange();
  const params = new URLSearchParams({ date_from: range.from, date_to: range.to });
  if (S.filterProjectId) params.set('project_id', S.filterProjectId);
  if (S.filterSearch) params.set('search', S.filterSearch);
  if (S.filterRegie !== '') params.set('regie', S.filterRegie);

  // Ungefilterte Einträge für Soll/Ist-Berechnung laden
  const allParams = new URLSearchParams({ date_from: range.from, date_to: range.to });
  const hasFilter = S.filterProjectId || S.filterSearch || S.filterRegie !== '';

  try {
    const data = await api('GET', '/api/entries?' + params.toString());
    if (!data) return;
    S.entries = data.entries;
    if (hasFilter) {
      const allData = await api('GET', '/api/entries?' + allParams.toString());
      S.allEntries = allData ? allData.entries : S.entries;
    } else {
      S.allEntries = S.entries;
    }
  } catch (e) { toast(e.message, 'error'); return; }

  // Summenstunden: gefilterte Ansicht für Anzeige
  let visibleEntries = S.entries;
  if (canViewAll() && S.hiddenEmployees && S.hiddenEmployees.size > 0) {
    visibleEntries = S.entries.filter(e => !S.hiddenEmployees.has(e.user_id));
  }
  const totalNet = calcActualHours(visibleEntries);
  const weekdays = countWeekdays(range.from, range.to);

  // Soll/Ist: immer auf Basis ALLER Einträge (ohne Projekt-/Suchfilter)
  let allVisibleEntries = S.allEntries;
  if (canViewAll() && S.hiddenEmployees && S.hiddenEmployees.size > 0) {
    allVisibleEntries = S.allEntries.filter(e => !S.hiddenEmployees.has(e.user_id));
  }
  const totalNetAll = calcActualHours(allVisibleEntries);

  let targetHours = 0;
  let cumulativeOvertime = 0;
  if (S.user.role === 'mitarbeiter') {
    try {
      const [th, ot] = await Promise.all([
        api('GET', `/api/statistics/target-hours?date_from=${range.from}&date_to=${range.to}`),
        api('GET', `/api/statistics/overtime?date_to=${range.to}`),
      ]);
      if (th) targetHours = th.target_hours;
      if (ot) cumulativeOvertime = ot.overtime;
    } catch (e) {}
  }

  const diff = totalNetAll - targetHours;
  const diffClass = diff >= 0 ? 'positive' : 'negative';
  const diffSign = diff >= 0 ? '+' : '';
  const otClass = cumulativeOvertime >= 0 ? 'positive' : 'negative';

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;
  mainEl.classList.add('main-wide');

  // Filter (nur Projekt + Suche + Abwesenheitstyp, Mitarbeiter werden per Chips gesteuert)
  const absenceTypeOptions = [
    ['', 'Abwesenheit: Alle'],
    ['krank', '🏥 Krank'],
    ['urlaub', '🌴 Urlaub'],
    ['freizeitausgleich', '⏱️ Freizeitausgleich'],
    ['sonderurlaub', '🎁 Sonderurlaub'],
    ['feiertag', '🎉 Feiertag'],
    ['berufsschule', '🏫 Berufsschule'],
    ['innung', '🔧 Innung'],
    ['dienstreise', '🚗 Dienstreise'],
  ];
  const filtersHtml = `
    <div class="filters">
      <select id="filter-project">
        <option value="">Alle Projekte</option>
        ${S.projects.map(p => `<option value="${p.id}" ${S.filterProjectId == p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <select id="filter-regie">
        <option value="" ${S.filterRegie === '' ? 'selected' : ''}>Regie: Alle</option>
        <option value="1" ${S.filterRegie === '1' ? 'selected' : ''}>Regie: Ja</option>
        <option value="0" ${S.filterRegie === '0' ? 'selected' : ''}>Regie: Nein</option>
      </select>
      <select id="filter-absence-type">
        ${absenceTypeOptions.map(([v, l]) => `<option value="${v}" ${S.filterAbsenceType === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input type="search" id="filter-search" placeholder="Suchen..." value="${esc(S.filterSearch)}">
    </div>`;

  // Mitarbeiter-Chips für Chef/Admin/Buchhalter
  let chipsHtml = '';
  if (canViewAll()) {
    if (!S.hiddenEmployees) S.hiddenEmployees = new Set();
    const workers = getWorkerUsers().filter(u => u.role === 'mitarbeiter' || u.role === 'chef' || u.role === 'buchhalter');
    chipsHtml = `<div class="employee-chips">
      ${workers.map((u, i) => {
        const c = PALETTE[i % PALETTE.length];
        const active = !S.hiddenEmployees.has(u.id);
        return `<span class="emp-chip ${active ? '' : 'inactive'}" data-uid="${u.id}" style="background:${c}">${esc(u.name)}</span>`;
      }).join('')}
    </div>`;
  }

  // Abwesenheiten für Timeline/Wochenraster
  let absencesForPeriod = [];
  try {
    const absData = await api('GET', `/api/absences/by-date?from=${range.from}&to=${range.to}`);
    if (absData) absencesForPeriod = absData.absences;
  } catch (e) {}

  // Abwesenheiten nach Typ filtern
  const filteredAbsences = S.filterAbsenceType
    ? absencesForPeriod.filter(a => a.type === S.filterAbsenceType)
    : absencesForPeriod;

  // Abwesenheitssummary für Mitarbeiter (oder eigene Ansicht)
  let absenceSummary = null;
  if (S.user.role === 'mitarbeiter') {
    try {
      const sd = await api('GET', `/api/absences/summary?from=${range.from}&to=${range.to}`);
      if (sd) absenceSummary = sd;
    } catch(e) {}
  }

  // Entscheidung: Timeline (Tag), Wochenraster, Monatsraster
  let contentHtml = '';
  if (S.view === 'day') {
    contentHtml = renderTimelineHtml(visibleEntries, filteredAbsences);
  } else if (S.view === 'week') {
    contentHtml = renderWeekGridHtml(visibleEntries, range, filteredAbsences);
  } else {
    contentHtml = renderMonthGridHtml(visibleEntries, range, filteredAbsences);
  }

  mainEl.innerHTML = `
    <div class="view-toggle">
      <button class="${S.view === 'day' ? 'active' : ''}" data-view="day">Tag</button>
      <button class="${S.view === 'week' ? 'active' : ''}" data-view="week">Woche</button>
      <button class="${S.view === 'month' ? 'active' : ''}" data-view="month">Monat</button>
    </div>
    <div class="date-nav">
      <button id="date-prev">&#8249;</button>
      <span class="current-period">${getPeriodLabel()}</span>
      <button id="date-next">&#8250;</button>
      <button id="date-today" class="date-today-btn">Jetzt</button>
    </div>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${fmtH(totalNet)}</div>
        <div class="label">Nettostunden</div>
      </div>
      ${S.user.role === 'mitarbeiter' ? `
      <div class="summary-card">
        <div class="value">${fmtH(targetHours)}</div>
        <div class="label">Soll-Stunden</div>
      </div>
      <div class="summary-card ${diffClass}">
        <div class="value">${diff >= 0 ? '+' : ''}${fmtH(diff)}</div>
        <div class="label">${diff >= 0 ? 'Über' : 'Unter'} (Zeitraum)</div>
      </div>
      <div class="summary-card ${otClass}">
        <div class="value">${cumulativeOvertime >= 0 ? '+' : ''}${fmtH(cumulativeOvertime)}</div>
        <div class="label">Überstunden gesamt</div>
      </div>` : `
      <div class="summary-card">
        <div class="value">${visibleEntries.length}</div>
        <div class="label">Einträge</div>
      </div>
      <div class="summary-card">
        <div class="value">${new Set(visibleEntries.map(e => e.user_id)).size}</div>
        <div class="label">Mitarbeiter</div>
      </div>`}
      ${(() => {
        if (!absenceSummary || S.user.role !== 'mitarbeiter') return '';
        const sum = absenceSummary.summary || {};
        if (Object.keys(sum).length === 0) return '';
        const typeLabels = { krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'FZA', sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag', berufsschule: 'Berufsschule', innung: 'Innung', dienstreise: 'Dienstreise' };
        const totalDays = Object.values(sum).reduce((s, v) => s + v, 0);
        const details = Object.entries(sum).map(([t, d]) => `${typeLabels[t] || t}: ${d}`).join(', ');
        return `<div class="summary-card">
          <div class="value">${totalDays}</div>
          <div class="label">Abwesenheitstage<br><small>${details}</small></div>
        </div>`;
      })()}
    </div>
    ${filtersHtml}
    ${chipsHtml}
    ${contentHtml}
  `;

  // --- Event Bindings ---
  // View toggle
  mainEl.querySelectorAll('.view-toggle button').forEach(btn => {
    btn.addEventListener('click', () => { S.view = btn.dataset.view; renderDashboardContent(); });
  });
  // Date nav
  document.getElementById('date-prev')?.addEventListener('click', () => { navDate(-1); renderDashboardContent(); });
  document.getElementById('date-next')?.addEventListener('click', () => { navDate(1); renderDashboardContent(); });
  document.getElementById('date-today')?.addEventListener('click', () => { S.currentDate = new Date(); renderDashboardContent(); });
  // Filters
  document.getElementById('filter-project')?.addEventListener('change', (e) => { S.filterProjectId = e.target.value; renderDashboardContent(); });
  document.getElementById('filter-regie')?.addEventListener('change', (e) => { S.filterRegie = e.target.value; renderDashboardContent(); });
  document.getElementById('filter-absence-type')?.addEventListener('change', (e) => { S.filterAbsenceType = e.target.value; renderDashboardContent(); });
  let searchTimeout;
  document.getElementById('filter-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { S.filterSearch = e.target.value; renderDashboardContent(); }, 300);
  });
  // Employee chips
  mainEl.querySelectorAll('.emp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const uid = Number(chip.dataset.uid);
      if (S.hiddenEmployees.has(uid)) S.hiddenEmployees.delete(uid);
      else S.hiddenEmployees.add(uid);
      renderDashboardContent();
    });
  });
  // Entry clicks (timeline blocks → edit)
  mainEl.querySelectorAll('.tl-entry[data-entry-id]').forEach(el => {
    el.addEventListener('click', () => { hideTooltip(); navigate('/entry/' + el.dataset.entryId); });
  });
  // Tooltip für Einträge (Tag + Woche)
  const entryMap = {};
  visibleEntries.forEach(e => { entryMap[e.id] = e; });
  mainEl.querySelectorAll('[data-entry-id]').forEach(el => {
    el.addEventListener('mouseenter', (ev) => {
      const e = entryMap[el.dataset.entryId];
      if (e) showTooltip(entryTooltipHtml(e), ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => {
      if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });
  // Nav-Buttons in Übersichten
  mainEl.querySelectorAll('.nav-to-addr').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); hideTooltip(); openNav(btn.dataset.addr); });
  });
  // Grid-Zellen klick → Tagansicht (innerstes data-jump-date gewinnt)
  mainEl.querySelectorAll('[data-jump-date]').forEach(el => {
    el.addEventListener('click', (e) => {
      const closest = e.target.closest('[data-jump-date]');
      if (closest) {
        e.stopPropagation();
        S.currentDate = new Date(closest.dataset.jumpDate + 'T12:00:00');
        S.view = 'day';
        renderDashboardContent();
      }
    });
  });
  mainEl.querySelectorAll('.btn-continue').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); navigate('/entry/continue/' + btn.dataset.id); });
  });
  // Timeline zur Kernarbeitszeit scrollen
  if (S.view === 'day') {
    const scrollContainer = mainEl.querySelector('.timeline-scroll');
    if (scrollContainer) {
      const scrollY = (TL_SCROLL_TO_HOUR - TL_START_HOUR) * TL_HOUR_PX - 20;
      scrollContainer.scrollTop = Math.max(0, scrollY);
    }
  }
}

// --- Timeline Rendering (Tagansicht) ---
function renderTimelineHtml(entries, absences) {
  if (entries.length === 0 && !(absences || []).length) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge an diesem Tag</p></div>';
  }

  const totalH = (TL_END_HOUR - TL_START_HOUR) * TL_HOUR_PX;
  const isSingle = S.user.role === 'mitarbeiter';

  // Stundenleiste
  let hoursHtml = '<div class="timeline-hours-body" style="height:' + totalH + 'px">';
  for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
    const y = (h - TL_START_HOUR) * TL_HOUR_PX;
    hoursHtml += `<span class="tl-hour-label" style="top:${y}px">${String(h).padStart(2,'0')}:00</span>`;
  }
  hoursHtml += '</div>';

  // Spalten bestimmen
  let columns = [];
  if (isSingle) {
    columns = [{ id: S.user.id, name: S.user.name, entries: entries }];
  } else {
    // Gruppiere nach Mitarbeiter
    const byUser = {};
    entries.forEach(e => {
      if (!byUser[e.user_id]) byUser[e.user_id] = { id: e.user_id, name: e.user_name, entries: [] };
      byUser[e.user_id].entries.push(e);
    });
    // Sortiere alphabetisch nach Name
    columns = Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));
  }

  if (columns.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge an diesem Tag</p></div>';
  }

  // Jetzt-Linie berechnen
  const now = new Date();
  const today = formatDateISO(now);
  const currentDay = formatDateISO(S.currentDate);
  let nowLineHtml = '';
  if (today === currentDay) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMin = TL_START_HOUR * 60;
    const y = ((nowMinutes - startMin) / 60) * TL_HOUR_PX;
    if (y >= 0 && y <= totalH) {
      nowLineHtml = `<div class="tl-now-line" style="top:${y}px"></div>`;
    }
  }

  // Spalten-HTML
  let colsHtml = '';
  columns.forEach((col, ci) => {
    const colColor = PALETTE[ci % PALETTE.length];
    let bodyHtml = '';
    // Stundenlinien
    for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
      const y = (h - TL_START_HOUR) * TL_HOUR_PX;
      bodyHtml += `<div class="tl-hour-line" style="top:${y}px"></div>`;
      if (h < TL_END_HOUR) {
        bodyHtml += `<div class="tl-hour-line half" style="top:${y + TL_HOUR_PX / 2}px"></div>`;
      }
    }
    bodyHtml += nowLineHtml;
    // Einträge - Überlappungen nebeneinander anordnen
    const sorted = [...col.entries].sort((a, b) => a.time_from.localeCompare(b.time_from));
    // Spalten für Überlappungen berechnen
    const lanes = []; // [{end: minuten, entries: [...]}]
    sorted.forEach(e => {
      const [fh, fm] = e.time_from.split(':').map(Number);
      const [th, tm] = e.time_to.split(':').map(Number);
      e._startMin = fh * 60 + fm;
      e._endMin = th * 60 + tm;
      // Finde freie Spur
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].end <= e._startMin) {
          lanes[i].end = e._endMin;
          e._lane = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e._lane = lanes.length;
        lanes.push({ end: e._endMin });
      }
    });
    const totalLanes = Math.max(1, lanes.length);
    sorted.forEach(e => {
      const top = ((e._startMin - TL_START_HOUR * 60) / 60) * TL_HOUR_PX;
      const height = Math.max(20, ((e._endMin - e._startMin) / 60) * TL_HOUR_PX);
      const bg = e.project_id ? colorFor(e.project_id) : colColor;
      const projLabel = e.project_name || e.project_text || '';
      const laneW = (100 - 6) / totalLanes; // 6% padding gesamt
      const leftPct = 3 + e._lane * laneW;
      const widthPct = laneW - 1; // 1% gap

      const regieTag = regieHtmlBadge(e, 'font-size:0.65rem;');
      const projClientLabel = projLabel + (projLabel && e.client ? ' – ' : '') + (e.client || '');
      const navBtn = e.address ? `<button class="nav-to-addr tl-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : '';
      const isCompact = height < 50;
      if (isCompact) {
        // Kompakt-Horizontallayout: alles in einer Zeile
        const parts = [
          `<span class="tl-e-time" style="white-space:nowrap;flex-shrink:0">${esc(e.time_from)}-${esc(e.time_to)}</span>`
        ];
        if (projClientLabel) parts.push(`<span class="tl-e-sep" style="opacity:0.5;flex-shrink:0">·</span><span class="tl-e-project" style="white-space:nowrap;flex-shrink:1;overflow:hidden;text-overflow:ellipsis">${esc(projClientLabel)}</span>`);
        if (e.description) parts.push(`<span class="tl-e-sep" style="opacity:0.5;flex-shrink:0">·</span><span class="tl-e-desc" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.description)}</span>`);
        bodyHtml += `<div class="tl-entry" data-entry-id="${e.id}" style="top:${top}px;height:${height}px;background:${bg};left:${leftPct}%;width:${widthPct}%;right:auto;flex-direction:row;align-items:center;gap:4px;">
          ${parts.join('')}
          ${navBtn}
        </div>`;
      } else {
        bodyHtml += `<div class="tl-entry" data-entry-id="${e.id}" style="top:${top}px;height:${height}px;background:${bg};left:${leftPct}%;width:${widthPct}%;right:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="tl-e-time">${esc(e.time_from)} - ${esc(e.time_to)}</span>
            ${navBtn}
          </div>
          ${projClientLabel ? `<span class="tl-e-project">${esc(projClientLabel)}</span>` : ''}
          ${e.description && height > 50 ? `<span class="tl-e-desc">${esc(e.description)}</span>` : ''}
          ${e.break_minutes > 0 && height > 40 ? `<span class="tl-e-break">Pause: ${e.break_minutes} min</span>` : ''}
          ${height > 35 ? regieTag : ''}
        </div>`;
      }
    });

    const headerLabel = isSingle ? 'Meine Einträge' : esc(col.name);
    const dayAbsences = getAbsencesForDay(col.id, currentDay, absences);
    const absenceBanners = dayAbsences.map(a => {
      const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
      const pendingCls = a.status === 'pending' ? ' tl-absence-banner--pending' : '';
      return `<div class="tl-absence-banner tl-absence-banner--${a.type}${pendingCls}">${t.icon} ${t.label}</div>`;
    }).join('');
    colsHtml += `<div class="timeline-column">
      <div class="tl-col-header" style="${!isSingle ? 'color:' + colColor : ''}">${headerLabel}</div>
      ${absenceBanners}
      <div class="tl-col-body" style="height:${totalH}px">${bodyHtml}</div>
    </div>`;
  });

  return `<div class="timeline-wrapper">
    <div class="timeline-scroll">
      <div class="timeline-container">
        <div class="timeline-hours"><div class="tl-col-header" style="visibility:hidden">.</div>${hoursHtml}</div>
        ${colsHtml}
      </div>
    </div>
  </div>`;
}

// --- Wochenraster ---
function renderWeekGridHtml(entries, range, absences) {
  const dayNames = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
  const dayNamesShort = ['Mo','Di','Mi','Do','Fr','Sa','So'];

  // 7 Tage der Woche ermitteln (Mo-So)
  const weekStart = new Date(range.from + 'T12:00:00');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(formatDateISO(d));
  }

  // Spalten (Mitarbeiter) bestimmen
  const columns = getGridColumns(entries);
  if (columns.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge in dieser Woche</p></div>';
  }

  // Einträge nach Tag+User gruppieren
  const lookup = {};
  entries.forEach(e => {
    const key = e.date + '_' + e.user_id;
    if (!lookup[key]) lookup[key] = [];
    lookup[key].push(e);
  });

  let headerHtml = '<th class="grid-row-header">Tag</th>';
  columns.forEach((col, i) => {
    const c = PALETTE[i % PALETTE.length];
    headerHtml += `<th class="grid-col-header" style="color:${c}">${esc(col.name)}</th>`;
  });

  let bodyHtml = '';
  days.forEach((day, di) => {
    const isWeekend = di >= 5;
    const today = formatDateISO(new Date());
    const isToday = day === today;
    bodyHtml += `<tr class="${isWeekend ? 'grid-weekend' : ''} ${isToday ? 'grid-today' : ''}">`;
    bodyHtml += `<td class="grid-row-header"><strong>${dayNamesShort[di]}</strong><br><span class="grid-date">${formatDateDE(day)}</span></td>`;
    columns.forEach((col) => {
      const cellEntries = lookup[day + '_' + col.id] || [];
      const totalH = calcActualHours(cellEntries);
      const dayAbsences = getAbsencesForDay(col.id, day, absences);
      bodyHtml += `<td class="grid-cell" data-jump-date="${day}">`;
      if (dayAbsences.length > 0) {
        bodyHtml += `<div class="grid-absence-chips">${dayAbsences.map(a => {
          const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
          const pendCls = a.status === 'pending' ? ' grid-absence-chip--pending' : '';
          return `<span class="grid-absence-chip grid-absence-chip--${a.type}${pendCls}">${t.icon} ${t.label}</span>`;
        }).join('')}</div>`;
      }
      if (cellEntries.length > 0) {
        cellEntries.forEach(e => {
          const bg = e.project_id ? colorFor(e.project_id) : '#64748b';
          const regieHtml = regieHtmlBadge(e);
          bodyHtml += `<div class="grid-entry" data-entry-id="${e.id}" style="border-left-color:${bg}">
            <span class="grid-e-time">${esc(e.time_from)}-${esc(e.time_to)} ${e.address ? `<button class="nav-to-addr grid-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''}</span>
            <span class="grid-e-proj">${esc(e.project_name || e.project_text || '')}${e.client ? ' – ' + esc(e.client) : ''}</span>
            <span class="grid-e-hours">${fmtH(e.net_hours)}</span>
            <span class="grid-e-regie">${regieHtml}</span>
          </div>`;
        });
        bodyHtml += `<div class="grid-cell-total">${fmtH(totalH)}</div>`;
      }
      bodyHtml += '</td>';
    });
    bodyHtml += '</tr>';
  });

  return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table></div></div>`;
}

// --- Monatsraster ---
function renderMonthGridHtml(entries, range, absences = []) {
  // Kalenderwochen des Monats ermitteln
  const weeks = getCalendarWeeks(range.from, range.to);
  const columns = getGridColumns(entries);

  if (columns.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge in diesem Monat</p></div>';
  }

  // Einträge nach KW+User gruppieren
  const lookup = {};
  entries.forEach(e => {
    const kw = getISOWeek(e.date);
    const key = kw + '_' + e.user_id;
    if (!lookup[key]) lookup[key] = [];
    lookup[key].push(e);
  });

  let headerHtml = '<th class="grid-row-header">KW</th>';
  columns.forEach((col, i) => {
    const c = PALETTE[i % PALETTE.length];
    headerHtml += `<th class="grid-col-header" style="color:${c}">${esc(col.name)}</th>`;
  });

  let bodyHtml = '';
  weeks.forEach(w => {
    bodyHtml += '<tr>';
    bodyHtml += `<td class="grid-row-header"><strong>KW ${w.kw}</strong><br><span class="grid-date">${formatDateDE(w.from)} -<br>${formatDateDE(w.to)}</span></td>`;
    columns.forEach(col => {
      const cellEntries = lookup[w.kw + '_' + col.id] || [];
      const totalH = calcActualHours(cellEntries);
      const days = new Set(cellEntries.map(e => e.date)).size;
      // Klick auf Zelle → erster Tag der KW
      // Alle Arbeitstage der KW im Monatsbereich für Abwesenheits-Anzeige sammeln
      const kwStart = new Date(Math.max(new Date(w.from + 'T12:00:00'), new Date(range.from + 'T12:00:00')));
      const kwEnd   = new Date(Math.min(new Date(w.to   + 'T12:00:00'), new Date(range.to   + 'T12:00:00')));
      const allDaysInKW = [];
      for (let d = new Date(kwStart); d <= kwEnd; d.setDate(d.getDate() + 1)) {
        const wd = d.getDay();
        if (wd !== 0 && wd !== 6) allDaysInKW.push(formatDateISO(d));
      }

      bodyHtml += `<td class="grid-cell" data-jump-date="${w.from}">`;
      // Gruppiere Einträge nach Tag
      const byDay = {};
      cellEntries.forEach(e => {
        if (!byDay[e.date]) byDay[e.date] = [];
        byDay[e.date].push(e);
      });
      // Zeige alle Tage mit Eintrag ODER Abwesenheit
      const daysToShow = new Set([...Object.keys(byDay), ...allDaysInKW.filter(d => getAbsencesForDay(col.id, d, absences).length > 0)]);
      const sortedDays = [...daysToShow].sort();
      sortedDays.forEach(day => {
        const dayEntries = byDay[day] || [];
        const dn = getDayNameShort(day);
        const dayH = calcActualHours(dayEntries);
        const dayAbsences = getAbsencesForDay(col.id, day, absences);
        const absChips = dayAbsences.map(a => {
          const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
          const pendingCls = a.status === 'pending' ? ' grid-absence-chip--pending' : '';
          return `<span class="grid-absence-chip grid-absence-chip--${a.type}${pendingCls}" title="${t.label}">${t.icon}</span>`;
        }).join('');
        bodyHtml += `<div class="grid-kw-day" data-jump-date="${day}">
          <span class="grid-kw-dayname">${dn}</span>
          ${absChips ? `<span class="grid-month-abs-chips">${absChips}</span>` : ''}
          ${dayH > 0 ? `<span class="grid-kw-dayhours">${fmtH(dayH)}</span>` : ''}
        </div>`;
      });
      if (cellEntries.length > 0) {
        const days = new Set(cellEntries.map(e => e.date)).size;
        bodyHtml += `<div class="grid-cell-total">${fmtH(totalH)} / ${days} Tage</div>`;
      }
      bodyHtml += '</td>';
    });
    bodyHtml += '</tr>';
  });

  return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table></div></div>`;
}

// --- Grid-Hilfsfunktionen ---
function getGridColumns(entries) {
  if (S.user.role === 'mitarbeiter') {
    return [{ id: S.user.id, name: S.user.name }];
  }
  const byUser = {};
  entries.forEach(e => {
    if (!byUser[e.user_id]) byUser[e.user_id] = { id: e.user_id, name: e.user_name };
  });
  // Auch Mitarbeiter ohne Einträge anzeigen wenn bekannt
  getWorkerUsers().forEach(u => {
    if (!byUser[u.id] && (!S.hiddenEmployees || !S.hiddenEmployees.has(u.id))) {
      byUser[u.id] = { id: u.id, name: u.name };
    }
  });
  return Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));
}

function getCalendarWeeks(fromStr, toStr) {
  const weeks = [];
  const seen = new Set();
  const start = new Date(fromStr + 'T12:00:00');
  const end = new Date(toStr + 'T12:00:00');
  const cur = new Date(start);
  while (cur <= end) {
    const kw = getISOWeek(formatDateISO(cur));
    if (!seen.has(kw)) {
      seen.add(kw);
      // Montag der KW
      const d = new Date(cur);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diff));
      const sun = new Date(mon);
      sun.setDate(sun.getDate() + 6);
      weeks.push({ kw, from: formatDateISO(mon), to: formatDateISO(sun) });
    }
    cur.setDate(cur.getDate() + 1);
  }
  return weeks;
}

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 4);
  yearStart.setDate(yearStart.getDate() + 3 - ((yearStart.getDay() + 6) % 7));
  return Math.round((d - yearStart) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function getDayNameShort(dateStr) {
  const names = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  return names[new Date(dateStr + 'T12:00:00').getDay()];
}

function getDateRange() {
  if (S.view === 'day') {
    const d = formatDateISO(S.currentDate);
    return { from: d, to: d };
  } else if (S.view === 'week') {
    return getWeekRange(S.currentDate);
  } else {
    return getMonthRange(S.currentDate);
  }
}

function getPeriodLabel() {
  const months = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const days = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  if (S.view === 'day') {
    return `${days[S.currentDate.getDay()]}, ${formatDateDE(formatDateISO(S.currentDate))}`;
  } else if (S.view === 'week') {
    const r = getWeekRange(S.currentDate);
    return `KW ${getISOWeek(formatDateISO(S.currentDate))} | ${formatDateDE(r.from)} - ${formatDateDE(r.to)}`;
  } else {
    return `${months[S.currentDate.getMonth()]} ${S.currentDate.getFullYear()}`;
  }
}

function navDate(dir) {
  if (S.view === 'day') S.currentDate.setDate(S.currentDate.getDate() + dir);
  else if (S.view === 'week') S.currentDate.setDate(S.currentDate.getDate() + dir * 7);
  else S.currentDate.setMonth(S.currentDate.getMonth() + dir);
}

// --- Entry Form ---
async function renderEntryForm(editId, continueId, planningId) {
  let entry = null;
  let continueEntry = null;
  let planningEntry = null;

  if (editId) {
    try {
      const data = await api('GET', '/api/entries/' + editId);
      if (data) entry = data.entry;
    } catch (e) { toast(e.message, 'error'); navigate('/'); return; }
  }

  if (continueId) {
    try {
      const data = await api('GET', '/api/entries/' + continueId);
      if (data) continueEntry = data.entry;
    } catch (e) {}
  }

  if (planningId) {
    try {
      const data = await api('GET', '/api/planning/' + planningId);
      if (data) planningEntry = data.entry;
    } catch (e) {}
  }

  // Projekte und Benutzerliste laden
  let regieUsers = [];
  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    if (canViewAll()) {
      const uData = await api('GET', '/api/users');
      if (uData) S.users = uData.users;
    }
    // Regie-Dropdown: alle Non-Admin-User für jeden Benutzer
    const rData = await api('GET', '/api/users/list');
    if (rData) regieUsers = rData.users;
  } catch (e) {}

  const isEdit = !!entry;
  const source = continueEntry || planningEntry;
  const today = formatDateISO(new Date());
  const title = isEdit ? 'Eintrag bearbeiten' : (planningEntry ? 'Eintrag aus Planung erstellen' : (continueEntry ? 'Weiter arbeiten' : 'Neuer Eintrag'));

  const nowTime = `${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`;
  const date = isEdit ? entry.date : today;
  const timeFrom = isEdit ? entry.time_from : (planningEntry ? planningEntry.time_from : '07:00');
  const timeTo = isEdit ? entry.time_to : nowTime;
  const breakMin = isEdit ? entry.break_minutes : (planningEntry ? planningEntry.break_minutes : 30);
  const address = isEdit ? entry.address : (source ? source.address : '');
  const client = isEdit ? entry.client : (source ? source.client : '');
  const projectId = isEdit ? (entry.project_id || '') : (source ? (source.project_id || '') : '');
  const projectText = isEdit ? (entry.project_text || '') : (source ? (source.project_text || '') : '');
  const description = isEdit ? entry.description : (planningEntry ? planningEntry.description : '');
  const personalNote = isEdit ? (entry.personal_note || '') : '';
  const regieVal = isEdit ? (entry.has_regie || 0) : 0;
  const regieUserId = isEdit ? (entry.regie_user_id || S.user.id) : S.user.id;

  const netHours = isEdit ? entry.net_hours : 0;

  const allUsers = regieUsers.length > 0 ? regieUsers : [{ id: S.user.id, name: S.user.name }];
  const showNotes = S.user.role === 'admin' || S.user.role === 'mitarbeiter';
  const canDelete = isEdit && (S.user.role === 'admin' || entry.user_id === S.user.id);

  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <div class="card-header">
        <h2>${title}</h2>
        <button class="btn btn-outline btn-sm" id="back-btn">Zurück</button>
      </div>
      <form id="entry-form">
        ${isAdmin() && !isEdit ? `
        <div class="form-group">
          <label>Mitarbeiter</label>
          <select class="form-control" id="ef-user" required>
            <option value="">-- Mitarbeiter wählen --</option>
            ${getWorkerUsers().map(u => `<option value="${u.id}" ${entry?.user_id == u.id ? 'selected' : ''}>${esc(u.name)} (${roleName(u.role)})</option>`).join('')}
          </select>
        </div>
        ` : ''}
        ${isAdmin() && isEdit ? `
        <div class="form-group">
          <label>Mitarbeiter</label>
          <input type="text" class="form-control" value="${esc(entry?.user_name || '')}" disabled>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Datum</label>
          <input type="date" class="form-control" id="ef-date" value="${date}" ${!planningEntry && !isAdmin() && S.user.role !== 'chef' ? `max="${today}"` : ''} required>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Von</label>
            <input type="time" class="form-control" id="ef-from" value="${timeFrom}" required>
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="time" class="form-control" id="ef-to" value="${timeTo}" required>
          </div>
        </div>
        <div class="form-group">
          <label>Pause (Minuten)</label>
          <input type="number" class="form-control" id="ef-break" value="${breakMin}" min="0" step="5">
        </div>
        <div class="net-hours-display" id="ef-net">Netto: ${fmtH(netHours)}</div>
        <div class="form-group">
          <label>Adresse / Arbeitsort</label>
          <div class="input-with-btn">
            <input type="text" class="form-control" id="ef-address" value="${esc(address)}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
            <button type="button" class="btn btn-outline btn-sm btn-nav" id="ef-nav" title="Navigation starten">&#128506;</button>
          </div>
        </div>
        <div class="form-group">
          <label>Kunde</label>
          <input type="text" class="form-control" id="ef-client" value="${esc(client)}" placeholder="Kundenname">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Projekt (Auswahl)</label>
            <select class="form-control" id="ef-project">
              <option value="">-- Kein Projekt --</option>
              ${S.projects.map(p => `<option value="${p.id}" ${p.id == projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Oder Freitext</label>
            <input type="text" class="form-control" id="ef-project-text" value="${projectId ? '' : esc(projectText)}" placeholder="Projektname" ${projectId ? 'disabled' : ''}>
          </div>
        </div>
        <div class="form-group">
          <label>Arbeitsbeschreibung</label>
          <textarea class="form-control" id="ef-desc" rows="3" placeholder="Kurze Beschreibung der Arbeit">${esc(description)}</textarea>
        </div>
        <div class="form-group">
          <label>Regiezettel</label>
          <div class="form-row" style="align-items:center;">
            <select class="form-control" id="ef-regie" style="max-width:120px;">
              <option value="0" ${regieVal === 0 ? 'selected' : ''}>Nein</option>
              <option value="1" ${regieVal === 1 ? 'selected' : ''}>Ja</option>
              <option value="2" ${regieVal === 2 ? 'selected' : ''}>pauschal</option>
              <option value="3" ${regieVal === 3 ? 'selected' : ''}>Büro</option>
              <option value="4" ${regieVal === 4 ? 'selected' : ''}>Lager</option>
              <option value="5" ${regieVal === 5 ? 'selected' : ''}>Intern</option>
            </select>
            <select class="form-control" id="ef-regie-user" style="${regieVal === 1 ? '' : 'display:none;'}">
              ${allUsers.map(u => `<option value="${u.id}" ${u.id == regieUserId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        ${showNotes ? `
        <div class="form-group">
          <label>Persönliche Notiz (nur für Sie sichtbar)</label>
          <textarea class="form-control" id="ef-note" rows="2" placeholder="Private Notiz...">${esc(personalNote)}</textarea>
        </div>` : ''}
        <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Speichern' : 'Eintrag erstellen'}</button>
        ${isEdit ? `<button type="button" class="btn btn-outline btn-block" id="continue-entry" style="margin-top:0.5rem">Auftrag fortsetzen</button>` : ''}
        ${canDelete ? '<button type="button" class="btn btn-danger btn-block" id="delete-entry" style="margin-top:0.5rem">Eintrag löschen</button>' : ''}
      </form>
    </div>`;

  $app().innerHTML = layout(content, '');
  bindLayout();
  // Hide FAB on form
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  // Netto-Stunden live berechnen
  const updateNet = () => {
    const f = document.getElementById('ef-from').value;
    const t = document.getElementById('ef-to').value;
    const b = parseInt(document.getElementById('ef-break').value) || 0;
    const net = calcNetHours(f, t, b);
    document.getElementById('ef-net').textContent = `Netto: ${fmtH(net)}`;
  };
  document.getElementById('ef-from').addEventListener('change', updateNet);
  document.getElementById('ef-to').addEventListener('change', updateNet);
  updateNet();

  // Regie-Toggle
  document.getElementById('ef-regie').addEventListener('change', (e) => {
    document.getElementById('ef-regie-user').style.display = e.target.value === '1' ? '' : 'none';
  });

  document.getElementById('ef-break').addEventListener('input', updateNet);

  // Projekt-Auswahl: Adresse übernehmen + Freitext steuern
  document.getElementById('ef-project').addEventListener('change', (e) => {
    const proj = S.projects.find(p => p.id == e.target.value);
    if (proj && proj.address) {
      document.getElementById('ef-address').value = proj.address;
    }
    const ft = document.getElementById('ef-project-text');
    if (e.target.value) {
      ft.value = '';
      ft.disabled = true;
    } else {
      ft.disabled = false;
    }
  });

  document.getElementById('ef-nav').addEventListener('click', () => {
    const addr = document.getElementById('ef-address').value.trim();
    if (addr) openNav(addr); else toast('Keine Adresse eingetragen', 'error');
  });

  document.getElementById('back-btn').addEventListener('click', () => navigate(planningEntry ? '/planning' : '/'));

  // Form submit
  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      date: document.getElementById('ef-date').value,
      time_from: document.getElementById('ef-from').value,
      time_to: document.getElementById('ef-to').value,
      break_minutes: parseInt(document.getElementById('ef-break').value) || 0,
      address: document.getElementById('ef-address').value,
      client: document.getElementById('ef-client').value,
      project_id: document.getElementById('ef-project').value || null,
      project_text: document.getElementById('ef-project-text').value,
      description: document.getElementById('ef-desc').value,
      personal_note: document.getElementById('ef-note')?.value || '',
      has_regie: Number(document.getElementById('ef-regie').value),
      regie_user_id: document.getElementById('ef-regie').value === '1' ? Number(document.getElementById('ef-regie-user').value) : null,
    };
    // Admin muss Mitarbeiter auswählen
    const userSelect = document.getElementById('ef-user');
    if (userSelect) {
      if (!userSelect.value) { toast('Bitte einen Mitarbeiter auswählen', 'error'); return; }
      body.user_id = Number(userSelect.value);
    }

    try {
      if (isEdit) {
        await api('PUT', '/api/entries/' + editId, body);
        toast('Eintrag aktualisiert', 'success');
      } else {
        await api('POST', '/api/entries', body);
        toast('Eintrag erstellt', 'success');
      }
      navigate('/');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Continue
  document.getElementById('continue-entry')?.addEventListener('click', () => {
    navigate('/entry/continue/' + editId);
  });

  // Delete
  document.getElementById('delete-entry')?.addEventListener('click', async () => {
    if (!confirm('Eintrag wirklich löschen?')) return;
    try {
      await api('DELETE', '/api/entries/' + editId);
      toast('Eintrag gelöscht', 'success');
      navigate('/');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Planning ---
async function renderPlanning() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'planning');
  bindLayout();

  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    const uData = await api('GET', '/api/users/list');
    if (uData) S.users = uData.users;
  } catch (e) {}

  renderPlanningContent();
}

async function renderPlanningContent() {
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;
  mainEl.classList.add('main-wide');

  const view = S.planningView || 'day';
  const d = S.planningDate || new Date();
  let r, label;
  if (view === 'day') {
    const iso = formatDateISO(d);
    r = { from: iso, to: iso };
    const dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
    label = `${dayNames[d.getDay()]}, ${formatDateDE(iso)}`;
  } else if (view === 'week') {
    r = getWeekRange(d);
    label = `KW ${getISOWeek(formatDateISO(d))} | ${formatDateDE(r.from)} - ${formatDateDE(r.to)}`;
  } else {
    r = getMonthRange(d);
    const mNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    label = `${mNames[d.getMonth()]} ${d.getFullYear()}`;
  }

  let entries = [];
  try {
    const data = await api('GET', `/api/planning?date_from=${r.from}&date_to=${r.to}`);
    if (data) entries = data.entries;
  } catch (e) {}

  const canEdit = canEditPlanning();

  // Timeline für Tagesansicht
  let contentHtml = '';
  if (view === 'day') {
    contentHtml = renderPlanningTimeline(entries, canEdit);
  } else {
    contentHtml = renderPlanningGrid(entries, r, view, canEdit);
  }

  mainEl.innerHTML = `
    <div class="view-toggle">
      <button class="${view === 'day' ? 'active' : ''}" data-pview="day">Tag</button>
      <button class="${view === 'week' ? 'active' : ''}" data-pview="week">Woche</button>
      <button class="${view === 'month' ? 'active' : ''}" data-pview="month">Monat</button>
    </div>
    <div class="date-nav">
      <button id="plan-prev">&#8249;</button>
      <span class="current-period">${label}</span>
      <button id="plan-next">&#8250;</button>
      <button id="plan-today" class="date-today-btn">Jetzt</button>
    </div>
    ${contentHtml}`;

  // View toggle
  mainEl.querySelectorAll('.view-toggle button[data-pview]').forEach(btn => {
    btn.addEventListener('click', () => { S.planningView = btn.dataset.pview; renderPlanningContent(); });
  });

  // Date nav
  document.getElementById('plan-prev')?.addEventListener('click', () => {
    const dd = S.planningDate || new Date();
    const v = S.planningView || 'day';
    if (v === 'day') dd.setDate(dd.getDate() - 1);
    else if (v === 'week') dd.setDate(dd.getDate() - 7);
    else dd.setMonth(dd.getMonth() - 1);
    S.planningDate = new Date(dd);
    renderPlanningContent();
  });
  document.getElementById('plan-next')?.addEventListener('click', () => {
    const dd = S.planningDate || new Date();
    const v = S.planningView || 'day';
    if (v === 'day') dd.setDate(dd.getDate() + 1);
    else if (v === 'week') dd.setDate(dd.getDate() + 7);
    else dd.setMonth(dd.getMonth() + 1);
    S.planningDate = new Date(dd);
    renderPlanningContent();
  });
  document.getElementById('plan-today')?.addEventListener('click', () => {
    S.planningDate = new Date();
    renderPlanningContent();
  });

  // Tooltip + Long-Press für Planning-Einträge
  const planEntryMap = {};
  entries.forEach(e => { planEntryMap[e.id] = e; });

  mainEl.querySelectorAll('.tl-plan-entry[data-planning-id]').forEach(el => {
    const e = planEntryMap[el.dataset.planningId];

    // Desktop: Hover-Tooltip
    el.addEventListener('mouseenter', (ev) => {
      if (e) showTooltip(planEntryTooltipHtml(e), ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => {
      if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
    });
    el.addEventListener('mouseleave', hideTooltip);

    // Mobile: Long-Press (500ms)
    let pressTimer = null;
    let pressX = 0, pressY = 0, moved = false;
    el.addEventListener('touchstart', (ev) => {
      moved = false;
      pressX = ev.touches[0].clientX;
      pressY = ev.touches[0].clientY;
      pressTimer = setTimeout(() => {
        if (!moved && e) {
          hideTooltip();
          showTooltip(planEntryTooltipHtml(e), pressX, pressY);
          // Tooltip nach 4 Sekunden automatisch ausblenden
          setTimeout(hideTooltip, 4000);
        }
      }, 500);
    }, { passive: true });
    el.addEventListener('touchmove', (ev) => {
      const dx = ev.touches[0].clientX - pressX;
      const dy = ev.touches[0].clientY - pressY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        moved = true;
        clearTimeout(pressTimer);
      }
    }, { passive: true });
    el.addEventListener('touchend', () => {
      clearTimeout(pressTimer);
    });

    // Click → Eintrag übernehmen (nur ohne Long-Press)
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.plan-action-btn') || ev.target.closest('.plan-menu-btn') || ev.target.closest('.plan-action-menu')) return;
      hideTooltip();
      navigate('/planning/accept/' + el.dataset.planningId);
    });
  });

  // ⋮ Kontextmenü für Planung
  function closePlanMenus() {
    document.querySelectorAll('.plan-action-menu').forEach(m => m.remove());
  }
  mainEl.querySelectorAll('.plan-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      const existingMenu = document.querySelector('.plan-action-menu[data-for="' + btn.dataset.id + '"]');
      closePlanMenus();
      if (existingMenu) return; // Toggle: war offen → schließen

      const menu = document.createElement('div');
      menu.className = 'plan-action-menu';
      menu.dataset.for = btn.dataset.id;
      menu.innerHTML = `
        <button class="plan-menu-edit" data-id="${btn.dataset.id}" data-group="${btn.dataset.group || ''}">&#9998; Bearbeiten</button>
        <button class="plan-menu-del" data-id="${btn.dataset.id}">&#10005; L\u00f6schen</button>
      `;
      // Positionierung: unterhalb des Buttons, relativ zum Viewport
      document.body.appendChild(menu);
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 2) + 'px';
      menu.style.left = Math.max(4, rect.right + window.scrollX - menu.offsetWidth) + 'px';

      menu.querySelector('.plan-menu-edit').addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTooltip();
        closePlanMenus();
        if (btn.dataset.group) {
          navigate('/planning/edit-group/' + btn.dataset.group);
        } else {
          navigate('/planning/edit/' + btn.dataset.id);
        }
      });
      menu.querySelector('.plan-menu-del').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        closePlanMenus();
        if (!confirm('Planung wirklich l\u00f6schen?')) return;
        try {
          await api('DELETE', '/api/planning/' + btn.dataset.id);
          toast('Planung gel\u00f6scht', 'success');
          renderPlanningContent();
        } catch (e2) { toast(e2.message, 'error'); }
      });
    });
  });
  // Schließen via globalem document-Listener (einmalig im Init registriert)
  // Nav-Buttons in Planungsübersicht
  mainEl.querySelectorAll('.nav-to-addr').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openNav(btn.dataset.addr); });
  });
  // Grid cell click → jump to day
  mainEl.querySelectorAll('[data-plan-jump]').forEach(el => {
    el.addEventListener('click', (e) => {
      const closest = e.target.closest('[data-plan-jump]');
      if (closest) {
        e.stopPropagation();
        S.planningDate = new Date(closest.dataset.planJump + 'T12:00:00');
        S.planningView = 'day';
        renderPlanningContent();
      }
    });
  });

  // Timeline zur Kernarbeitszeit scrollen
  if (view === 'day') {
    const scrollContainer = mainEl.querySelector('.timeline-scroll');
    if (scrollContainer) {
      const scrollY = (TL_SCROLL_TO_HOUR - TL_START_HOUR) * TL_HOUR_PX - 20;
      scrollContainer.scrollTop = Math.max(0, scrollY);
    }
  }
}

function renderPlanningTimeline(entries, canEdit) {
  if (entries.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128197;</div><p>Keine Planungen für diesen Tag</p></div>';
  }

  const totalH = (TL_END_HOUR - TL_START_HOUR) * TL_HOUR_PX;

  // Stundenleiste
  let hoursHtml = '<div class="timeline-hours-body" style="height:' + totalH + 'px">';
  for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
    const y = (h - TL_START_HOUR) * TL_HOUR_PX;
    hoursHtml += `<span class="tl-hour-label" style="top:${y}px">${String(h).padStart(2,'0')}:00</span>`;
  }
  hoursHtml += '</div>';

  // Gruppiere nach zugewiesenem Mitarbeiter
  const byUser = {};
  entries.forEach(e => {
    e.assigned_users.forEach(u => {
      if (!byUser[u.user_id]) byUser[u.user_id] = { id: u.user_id, name: u.user_name, entries: [] };
      byUser[u.user_id].entries.push(e);
    });
  });
  const columns = Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));

  if (columns.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128197;</div><p>Keine Planungen für diesen Tag</p></div>';
  }

  let colsHtml = '';
  columns.forEach((col, ci) => {
    const colColor = PALETTE[ci % PALETTE.length];
    let bodyHtml = '';
    for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
      const y = (h - TL_START_HOUR) * TL_HOUR_PX;
      bodyHtml += `<div class="tl-hour-line" style="top:${y}px"></div>`;
      if (h < TL_END_HOUR) bodyHtml += `<div class="tl-hour-line half" style="top:${y + TL_HOUR_PX / 2}px"></div>`;
    }

    // Überlappungen berechnen
    const sorted = [...col.entries].sort((a, b) => a.time_from.localeCompare(b.time_from));
    const lanes = [];
    sorted.forEach(e => {
      const [fh, fm] = e.time_from.split(':').map(Number);
      const [th, tm] = e.time_to.split(':').map(Number);
      e._startMin = fh * 60 + fm;
      e._endMin = th * 60 + tm;
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].end <= e._startMin) { lanes[i].end = e._endMin; e._lane = i; placed = true; break; }
      }
      if (!placed) { e._lane = lanes.length; lanes.push({ end: e._endMin }); }
    });
    const totalLanes = Math.max(1, lanes.length);
    sorted.forEach(e => {
      const top = ((e._startMin - TL_START_HOUR * 60) / 60) * TL_HOUR_PX;
      const height = Math.max(20, ((e._endMin - e._startMin) / 60) * TL_HOUR_PX);
      const projLabel = e.project_name || e.project_text || '';
      const laneW = (100 - 6) / totalLanes;
      const leftPct = 3 + e._lane * laneW;
      const widthPct = laneW - 1;

      let actionsHtml = '';
      if (e.address) {
        actionsHtml += `<button type="button" class="plan-action-btn nav-to-addr" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>`;
      }
      if (canEdit) {
        actionsHtml += `<button type="button" class="plan-menu-btn" data-id="${e.id}" data-group="${e.group_id || ''}" title="Aktionen">&#8942;</button>`;
      }

      const entryColor = e.color || '#f59e0b';
      bodyHtml += `<div class="tl-plan-entry" data-planning-id="${e.id}" style="top:${top}px;height:${height}px;left:${leftPct}%;width:${widthPct}%;right:auto;background:${entryColor}28;border-color:${entryColor};color:#374151;" title="Klicken zum \u00dcbernehmen">
        <div style="display:flex;justify-content:space-between;align-items:center;min-width:0;">
          <span class="tl-e-time" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.time_from)} - ${esc(e.time_to)}</span>
          <span style="display:flex;gap:2px;flex-shrink:0;">${actionsHtml}</span>
        </div>
        ${projLabel || e.client ? `<span class="tl-e-project">${esc(projLabel)}${projLabel && e.client ? ' – ' : ''}${esc(e.client || '')}</span>` : ''}
        ${e.description && height > 50 ? `<span class="tl-e-desc">${esc(e.description)}</span>` : ''}
      </div>`;
    });

    colsHtml += `<div class="timeline-column">
      <div class="tl-col-header" style="color:${colColor}">${esc(col.name)}</div>
      <div class="tl-col-body" style="height:${totalH}px">${bodyHtml}</div>
    </div>`;
  });

  return `<div class="timeline-wrapper">
    <div class="timeline-scroll">
      <div class="timeline-container">
        <div class="timeline-hours"><div class="tl-col-header" style="visibility:hidden">.</div>${hoursHtml}</div>
        ${colsHtml}
      </div>
    </div>
  </div>`;
}

function renderPlanningGrid(entries, range, view, canEdit) {
  const dayNamesShort = ['Mo','Di','Mi','Do','Fr','Sa','So'];

  // Spalten = zugewiesene Mitarbeiter (alle die in Planungen vorkommen)
  const colMap = {};
  entries.forEach(e => {
    e.assigned_users.forEach(u => {
      if (!colMap[u.user_id]) colMap[u.user_id] = { id: u.user_id, name: u.user_name };
    });
  });
  const columns = Object.values(colMap).sort((a, b) => a.name.localeCompare(b.name));

  if (columns.length === 0) {
    return `<div class="empty-state"><div class="icon">&#128197;</div><p>Keine Planungen für diesen Zeitraum</p></div>`;
  }

  // Einträge nach Tag+User gruppieren (ein Eintrag kann mehreren Usern zugewiesen sein)
  const lookup = {};
  entries.forEach(e => {
    e.assigned_users.forEach(u => {
      const key = e.date + '_' + u.user_id;
      if (!lookup[key]) lookup[key] = [];
      lookup[key].push(e);
    });
  });

  if (view === 'week') {
    const weekStart = new Date(range.from + 'T12:00:00');
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(formatDateISO(d));
    }

    let headerHtml = '<th class="grid-row-header">Tag</th>';
    columns.forEach((col, i) => {
      const c = PALETTE[i % PALETTE.length];
      headerHtml += `<th class="grid-col-header" style="color:${c}">${esc(col.name)}</th>`;
    });

    let bodyHtml = '';
    days.forEach((day, di) => {
      const isWeekend = di >= 5;
      const today = formatDateISO(new Date());
      const isToday = day === today;
      bodyHtml += `<tr class="${isWeekend ? 'grid-weekend' : ''} ${isToday ? 'grid-today' : ''}">`;
      bodyHtml += `<td class="grid-row-header"><strong>${dayNamesShort[di]}</strong><br><span class="grid-date">${formatDateDE(day)}</span></td>`;
      columns.forEach(col => {
        const cellEntries = lookup[day + '_' + col.id] || [];
        bodyHtml += `<td class="grid-cell" data-plan-jump="${day}">`;
        cellEntries.forEach(e => {
          const proj = e.project_name || e.project_text || '';
          const ec = e.color || '#f59e0b';
          bodyHtml += `<div class="grid-plan-entry" style="background:${ec}28;border-left-color:${ec};color:#374151;">${e.time_from}-${e.time_to} ${e.address ? `<button class="nav-to-addr grid-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''} ${esc(proj)}${proj && e.client ? ' – ' : ''}${esc(e.client || '')}</div>`;
        });
        bodyHtml += '</td>';
      });
      bodyHtml += '</tr>';
    });

    return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table></div></div>`;
  }

  // Monatsansicht — nach KW gruppiert
  const weeks = getCalendarWeeks(range.from, range.to);
  const kwLookup = {};
  entries.forEach(e => {
    const kw = getISOWeek(e.date);
    e.assigned_users.forEach(u => {
      const key = kw + '_' + u.user_id;
      if (!kwLookup[key]) kwLookup[key] = [];
      kwLookup[key].push(e);
    });
  });

  let headerHtml = '<th class="grid-row-header">KW</th>';
  columns.forEach((col, i) => {
    const c = PALETTE[i % PALETTE.length];
    headerHtml += `<th class="grid-col-header" style="color:${c}">${esc(col.name)}</th>`;
  });

  let bodyHtml = '';
  weeks.forEach(w => {
    bodyHtml += '<tr>';
    bodyHtml += `<td class="grid-row-header"><strong>KW ${w.kw}</strong><br><span class="grid-date">${formatDateDE(w.from)} -<br>${formatDateDE(w.to)}</span></td>`;
    columns.forEach(col => {
      const cellEntries = kwLookup[w.kw + '_' + col.id] || [];
      bodyHtml += `<td class="grid-cell" data-plan-jump="${w.from}">`;
      if (cellEntries.length > 0) {
        const byDay = {};
        cellEntries.forEach(e => { if (!byDay[e.date]) byDay[e.date] = []; byDay[e.date].push(e); });
        Object.keys(byDay).sort().forEach(day => {
          const dn = getDayNameShort(day);
          const dayCount = byDay[day].length;
          const firstColor = byDay[day][0]?.color || '#f59e0b';
          bodyHtml += `<div class="grid-kw-day grid-plan-entry" data-plan-jump="${day}" style="background:${firstColor}28;border-left-color:${firstColor};color:#374151;">
            <span class="grid-kw-dayname">${dn}</span>
            <span class="grid-kw-dayhours">${dayCount} Planung${dayCount > 1 ? 'en' : ''}</span>
          </div>`;
        });
      }
      bodyHtml += '</td>';
    });
    bodyHtml += '</tr>';
  });

  return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table></div></div>`;
}

// --- Planning Form ---
async function renderPlanningForm(editId, replanId, editGroupId) {
  suppressTooltip();
  let entry = null;
  let replanEntry = null;
  let groupEntries = null;
  let groupAssigned = null;

  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    const uData = await api('GET', '/api/users/list');
    if (uData) S.users = uData.users;
  } catch (e) {}

  if (editId) {
    try {
      const data = await api('GET', '/api/planning/' + editId);
      if (data) entry = data.entry;
    } catch (e) { toast(e.message, 'error'); navigate('/planning'); return; }
  }

  if (replanId) {
    try {
      const data = await api('GET', '/api/planning/' + replanId);
      if (data) replanEntry = data.entry;
    } catch (e) { toast(e.message, 'error'); navigate('/planning'); return; }
  }

  if (editGroupId) {
    try {
      const data = await api('GET', '/api/planning/group/' + editGroupId);
      if (data) { groupEntries = data.entries; groupAssigned = data.assigned_users; }
    } catch (e) { toast(e.message, 'error'); navigate('/planning'); return; }
  }

  const isEdit = !!entry;
  const isGroupEdit = !!groupEntries;
  const source = replanEntry;
  const ref = entry || (groupEntries && groupEntries[0]) || source;
  const title = isEdit ? 'Planung bearbeiten' : (isGroupEdit ? 'Planungsgruppe bearbeiten' : (source ? 'Auftrag erneut planen' : 'Neue Planung'));
  const assignedIds = entry ? entry.assigned_users.map(u => u.user_id) : (groupAssigned ? groupAssigned.map(u => u.user_id) : (source ? source.assigned_users.map(u => u.user_id) : []));
  const workers = getWorkerUsers();

  // Tage-State für dynamische Liste
  let planDays = [];
  if (isGroupEdit) {
    planDays = groupEntries.map(e => ({ date: e.date, time_from: e.time_from, time_to: e.time_to, break_minutes: e.break_minutes }));
  } else if (isEdit) {
    planDays = [{ date: entry.date, time_from: entry.time_from, time_to: entry.time_to, break_minutes: entry.break_minutes }];
  } else if (!source) {
    const today = formatDateISO(S.planningDate || new Date());
    planDays = [{ date: today, time_from: '07:00', time_to: '15:30', break_minutes: 30 }];
  }

  function renderDayRows() {
    if (!planDays.length) return '<div class="empty-state" style="padding:1rem;font-size:0.85rem;">Keine Tage ausgewählt</div>';
    const dayNames = ['So','Mo','Di','Mi','Do','Fr','Sa'];
    return planDays.map((d, i) => {
      const dt = new Date(d.date + 'T12:00:00');
      const dn = dayNames[dt.getDay()];
      return `<div class="plan-day-row" data-idx="${i}">
        <button type="button" class="btn btn-danger btn-sm plan-day-del" data-idx="${i}" title="Tag entfernen">&#10005;</button>
        <span class="plan-day-label">${dn}, ${formatDateDE(d.date)}</span>
        <input type="time" class="form-control plan-day-from" data-idx="${i}" value="${d.time_from}">
        <span>–</span>
        <input type="time" class="form-control plan-day-to" data-idx="${i}" value="${d.time_to}">
        <span>Pause</span>
        <input type="number" class="form-control plan-day-break" data-idx="${i}" value="${d.break_minutes}" min="0" step="5" style="width:60px">
        <span>min</span>
      </div>`;
    }).join('');
  }

  function getDateRange() {
    if (!planDays.length) return { from: formatDateISO(new Date()), to: formatDateISO(new Date()) };
    const sorted = planDays.map(d => d.date).sort();
    return { from: sorted[0], to: sorted[sorted.length - 1] };
  }

  function generateWeekdays(from, to) {
    const days = [];
    const start = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    const cur = new Date(start);
    const maxDays = 100; // ~3 Monate Sicherheit
    let count = 0;
    while (cur <= end && count < maxDays) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) {
        days.push(formatDateISO(cur));
      }
      cur.setDate(cur.getDate() + 1);
      count++;
    }
    return days;
  }

  function rebuildDaysFromRange() {
    const from = document.getElementById('pf-date-from').value;
    const to = document.getElementById('pf-date-to').value;
    if (!from || !to || from > to) return;
    // Prüfe 3-Monats-Limit
    const diffMs = new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00');
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays > 93) { toast('Maximaler Zeitraum: 3 Monate', 'error'); return; }
    const newDates = generateWeekdays(from, to);
    // Bestehende Zeiten beibehalten wenn Tag schon existiert
    const existing = {};
    planDays.forEach(d => { existing[d.date] = d; });
    planDays = newDates.map(date => existing[date] || { date, time_from: '07:00', time_to: '15:30', break_minutes: 30 });
    refreshDayList();
  }

  function refreshDayList() {
    const container = document.getElementById('plan-days-list');
    if (container) container.innerHTML = renderDayRows();
    bindDayEvents();
  }

  function bindDayEvents() {
    document.querySelectorAll('.plan-day-del').forEach(btn => {
      btn.addEventListener('click', () => {
        planDays.splice(Number(btn.dataset.idx), 1);
        refreshDayList();
      });
    });
    document.querySelectorAll('.plan-day-from').forEach(inp => {
      inp.addEventListener('change', () => { planDays[Number(inp.dataset.idx)].time_from = inp.value; });
    });
    document.querySelectorAll('.plan-day-to').forEach(inp => {
      inp.addEventListener('change', () => { planDays[Number(inp.dataset.idx)].time_to = inp.value; });
    });
    document.querySelectorAll('.plan-day-break').forEach(inp => {
      inp.addEventListener('change', () => { planDays[Number(inp.dataset.idx)].break_minutes = parseInt(inp.value) || 0; });
    });
  }

  const dateRange = getDateRange();
  let multiMode = isGroupEdit || planDays.length > 1;

  function renderSingleDaySection() {
    const day = planDays[0] || { date: formatDateISO(new Date()), time_from: '07:00', time_to: '15:30', break_minutes: 30 };
    return `
      <div class="form-row">
        <div class="form-group">
          <label>Datum</label>
          <input type="date" class="form-control" id="pf-single-date" value="${day.date}">
        </div>
        <div class="form-group">
          <label>Von</label>
          <input type="time" class="form-control" id="pf-single-from" value="${day.time_from}">
        </div>
        <div class="form-group">
          <label>Bis</label>
          <input type="time" class="form-control" id="pf-single-to" value="${day.time_to}">
        </div>
        <div class="form-group">
          <label>Pause (min)</label>
          <input type="number" class="form-control" id="pf-single-break" value="${day.break_minutes}" min="0" step="5" style="width:80px">
        </div>
      </div>`;
  }

  function renderMultiDaySection() {
    const dr = getDateRange();
    return `
      <div class="form-row">
        <div class="form-group">
          <label>Von-Datum</label>
          <input type="date" class="form-control" id="pf-date-from" value="${dr.from}">
        </div>
        <div class="form-group">
          <label>Bis-Datum</label>
          <input type="date" class="form-control" id="pf-date-to" value="${dr.to}">
        </div>
        <div class="form-group" style="display:flex;align-items:flex-end;">
          <button type="button" class="btn btn-outline btn-sm" id="pf-gen-days">Tage generieren</button>
        </div>
      </div>
      <div class="form-group">
        <label>Tage</label>
        <div id="plan-days-list" class="plan-days-list">
          ${renderDayRows()}
        </div>
        <div class="plan-day-add" style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:center;">
          <input type="date" class="form-control" id="pf-add-day" style="width:auto;">
          <button type="button" class="btn btn-outline btn-sm" id="pf-add-day-btn">+ Tag hinzufügen</button>
        </div>
      </div>`;
  }

  function refreshDateSection() {
    const container = document.getElementById('plan-date-section');
    if (!container) return;
    container.innerHTML = multiMode ? renderMultiDaySection() : renderSingleDaySection();
    bindDateSectionEvents();
  }

  function bindDateSectionEvents() {
    if (multiMode) {
      document.getElementById('pf-gen-days')?.addEventListener('click', rebuildDaysFromRange);
      document.getElementById('pf-date-from')?.addEventListener('change', rebuildDaysFromRange);
      document.getElementById('pf-date-to')?.addEventListener('change', rebuildDaysFromRange);
      document.getElementById('pf-add-day-btn')?.addEventListener('click', () => {
        const dateInput = document.getElementById('pf-add-day');
        const newDate = dateInput.value;
        if (!newDate) { toast('Bitte Datum auswählen', 'error'); return; }
        if (planDays.some(d => d.date === newDate)) { toast('Tag bereits vorhanden', 'error'); return; }
        planDays.push({ date: newDate, time_from: '07:00', time_to: '15:30', break_minutes: 30 });
        planDays.sort((a, b) => a.date.localeCompare(b.date));
        dateInput.value = '';
        refreshDayList();
      });
      bindDayEvents();
    } else {
      // Einzeltag-Inputs live in planDays[0] syncen
      const syncSingle = () => {
        const d = document.getElementById('pf-single-date')?.value;
        const f = document.getElementById('pf-single-from')?.value;
        const t = document.getElementById('pf-single-to')?.value;
        const b = parseInt(document.getElementById('pf-single-break')?.value) || 0;
        planDays = [{ date: d, time_from: f, time_to: t, break_minutes: b }];
      };
      document.getElementById('pf-single-date')?.addEventListener('change', syncSingle);
      document.getElementById('pf-single-from')?.addEventListener('change', syncSingle);
      document.getElementById('pf-single-to')?.addEventListener('change', syncSingle);
      document.getElementById('pf-single-break')?.addEventListener('change', syncSingle);
    }
  }

  const content = `
    <div class="card" style="max-width:700px;margin:0 auto;">
      <div class="card-header">
        <h2>${title}</h2>
        <button class="btn btn-outline btn-sm" id="back-btn">Zurück</button>
      </div>
      <form id="planning-form">
        <div class="form-group">
          <label>Mitarbeiter zuweisen</label>
          <div class="planning-user-checkboxes">
            ${workers.map(u => `
              <label><input type="checkbox" name="assigned" value="${u.id}" ${assignedIds.includes(u.id) ? 'checked' : ''}> ${esc(u.name)} (${roleName(u.role)})</label>
            `).join('')}
          </div>
        </div>
        <div class="plan-mode-toggle">
          <span class="${!multiMode ? 'active' : ''}" id="lbl-single">Einzeltag</span>
          <label class="toggle-switch">
            <input type="checkbox" id="pf-multi-toggle" ${multiMode ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span class="${multiMode ? 'active' : ''}" id="lbl-multi">Mehrere Tage</span>
        </div>
        <div id="plan-date-section">
          ${multiMode ? renderMultiDaySection() : renderSingleDaySection()}
        </div>
        <div class="form-group">
          <label>Adresse / Arbeitsort</label>
          <div class="input-with-btn">
            <input type="text" class="form-control" id="pf-address" value="${esc(ref?.address || '')}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
            <button type="button" class="btn btn-outline btn-sm btn-nav" id="pf-nav" title="Navigation starten">&#128506;</button>
          </div>
        </div>
        <div class="form-group">
          <label>Kunde</label>
          <input type="text" class="form-control" id="pf-client" value="${esc(ref?.client || '')}" placeholder="Kundenname">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Projekt (Auswahl)</label>
            <select class="form-control" id="pf-project">
              <option value="">-- Kein Projekt --</option>
              ${S.projects.map(p => `<option value="${p.id}" ${p.id == (ref?.project_id || '') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Oder Freitext</label>
            <input type="text" class="form-control" id="pf-project-text" value="${ref?.project_id ? '' : esc(ref?.project_text || '')}" placeholder="Projektname" ${ref?.project_id ? 'disabled' : ''}>
          </div>
        </div>
        <div class="form-group">
          <label>Beschreibung</label>
          <textarea class="form-control" id="pf-desc" rows="3" placeholder="Was soll gemacht werden?">${esc(ref?.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Farbe</label>
          <div class="color-picker-row">
            <input type="color" id="pf-color" class="color-picker-input" value="${ref?.color || '#f59e0b'}">
            <span class="color-swatches">
              <span class="color-swatch" data-color="#f59e0b" style="background:#f59e0b" title="Orange"></span>
              <span class="color-swatch" data-color="#3b82f6" style="background:#3b82f6" title="Blau"></span>
              <span class="color-swatch" data-color="#22c55e" style="background:#22c55e" title="Gr\u00fcn"></span>
              <span class="color-swatch" data-color="#ef4444" style="background:#ef4444" title="Rot"></span>
              <span class="color-swatch" data-color="#a855f7" style="background:#a855f7" title="Lila"></span>
              <span class="color-swatch" data-color="#14b8a6" style="background:#14b8a6" title="T\u00fcrkis"></span>
            </span>
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">${(isEdit || isGroupEdit) ? 'Speichern' : 'Planung erstellen'}</button>
        ${isEdit ? `<button type="button" class="btn btn-outline btn-block" id="replan-entry" style="margin-top:0.5rem">Auftrag erneut planen</button>` : ''}
        ${(isEdit || isGroupEdit) ? '<button type="button" class="btn btn-danger btn-block" id="delete-planning" style="margin-top:0.5rem">Planung löschen</button>' : ''}
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'planning');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';
  bindDateSectionEvents();

  document.querySelectorAll('.color-swatch').forEach(s => {
    s.addEventListener('click', () => {
      document.getElementById('pf-color').value = s.dataset.color;
    });
  });

  document.getElementById('back-btn').addEventListener('click', () => navigate('/planning'));

  // Toggle Einzeltag / Mehrere Tage
  document.getElementById('pf-multi-toggle').addEventListener('change', (e) => {
    multiMode = e.target.checked;
    document.getElementById('lbl-single').classList.toggle('active', !multiMode);
    document.getElementById('lbl-multi').classList.toggle('active', multiMode);
    if (multiMode && planDays.length === 0) {
      planDays = [{ date: formatDateISO(new Date()), time_from: '07:00', time_to: '15:30', break_minutes: 30 }];
    }
    refreshDateSection();
  });

  // Projekt-Auswahl: Adresse übernehmen + Freitext steuern
  document.getElementById('pf-project').addEventListener('change', (e) => {
    const proj = S.projects.find(p => p.id == e.target.value);
    if (proj && proj.address) {
      document.getElementById('pf-address').value = proj.address;
    }
    const ft = document.getElementById('pf-project-text');
    if (e.target.value) {
      ft.value = '';
      ft.disabled = true;
    } else {
      ft.disabled = false;
    }
  });

  document.getElementById('pf-nav').addEventListener('click', () => {
    const addr = document.getElementById('pf-address').value.trim();
    if (addr) openNav(addr); else toast('Keine Adresse eingetragen', 'error');
  });

  document.getElementById('planning-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const checked = [...document.querySelectorAll('input[name="assigned"]:checked')].map(cb => Number(cb.value));
    if (!checked.length) { toast('Mindestens einen Mitarbeiter zuweisen', 'error'); return; }
    if (!planDays.length) { toast('Mindestens einen Tag hinzufügen', 'error'); return; }

    const common = {
      address: document.getElementById('pf-address').value,
      client: document.getElementById('pf-client').value,
      project_id: document.getElementById('pf-project').value || null,
      project_text: document.getElementById('pf-project-text').value,
      description: document.getElementById('pf-desc').value,
      color: document.getElementById('pf-color').value,
      assigned_user_ids: checked,
    };

    try {
      if (isEdit) {
        // Einzeleintrag bearbeiten
        const day = planDays[0];
        await api('PUT', '/api/planning/' + editId, { ...common, date: day.date, time_from: day.time_from, time_to: day.time_to, break_minutes: day.break_minutes });
        toast('Planung aktualisiert', 'success');
      } else if (isGroupEdit) {
        // Gruppe aktualisieren
        await api('PUT', '/api/planning/group/' + editGroupId, { ...common, days: planDays });
        toast('Planungsgruppe aktualisiert', 'success');
      } else {
        // Neue Planung (einzeln oder Gruppe)
        if (planDays.length === 1) {
          const day = planDays[0];
          await api('POST', '/api/planning', { ...common, date: day.date, time_from: day.time_from, time_to: day.time_to, break_minutes: day.break_minutes });
        } else {
          await api('POST', '/api/planning', { ...common, days: planDays });
        }
        toast('Planung erstellt', 'success');
      }
      navigate('/planning');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('replan-entry')?.addEventListener('click', () => {
    navigate('/planning/replan/' + editId);
  });

  document.getElementById('delete-planning')?.addEventListener('click', async () => {
    if (!confirm('Planung wirklich löschen?')) return;
    try {
      if (isGroupEdit) {
        await api('DELETE', '/api/planning/group/' + editGroupId);
      } else {
        await api('DELETE', '/api/planning/' + editId);
      }
      toast('Planung gelöscht', 'success');
      navigate('/planning');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Werkzeugliste ---
async function renderTools() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'tools');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  let tools = [];
  let projects = [];
  try {
    const data = await api('GET', '/api/tools');
    if (data) tools = data.tools;
    const pData = await api('GET', '/api/projects');
    if (pData) projects = pData.projects;
  } catch (e) {}

  const canManage = S.user.role === 'admin' || S.user.role === 'chef';

  const fmtDT = (dt) => {
    if (!dt) return '';
    const [d, t] = dt.split(' ');
    const [y, m, dd] = d.split('-');
    return `${dd}.${m}.${y} ${t ? t.slice(0, 5) : ''}`;
  };

  const projectOptions = `<option value="">-- Kein Projekt --</option>` +
    projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  function checkoutFormHtml(toolId, confirmLabel, endpoint) {
    return `<div class="tool-checkout-form" id="tcf-${toolId}" style="display:none;">
      <div class="form-row">
        <div class="form-group" style="flex:1;min-width:140px;">
          <label>Projekt</label>
          <select class="form-control" id="tcf-proj-${toolId}">${projectOptions}</select>
        </div>
        <div class="form-group" style="flex:1;min-width:120px;">
          <label>Oder Freitext</label>
          <input type="text" class="form-control" id="tcf-text-${toolId}" placeholder="Projektname">
        </div>
        <div class="form-group" style="flex:2;min-width:160px;">
          <label>Adresse</label>
          <input type="text" class="form-control" id="tcf-addr-${toolId}" placeholder="Adresse (optional)">
        </div>
        <div style="display:flex;gap:0.4rem;align-items:flex-end;padding-bottom:0.1rem;">
          <button class="btn btn-outline btn-sm tcf-cancel" data-id="${toolId}">Abbrechen</button>
          <button class="btn btn-primary btn-sm tcf-confirm" data-id="${toolId}" data-endpoint="${endpoint}">${confirmLabel}</button>
        </div>
      </div>
    </div>`;
  }

  let toolsHtml = '';
  if (tools.length === 0) {
    toolsHtml = '<p style="color:var(--text-light)">Noch keine Werkzeuge angelegt.</p>';
  } else {
    toolsHtml = tools.map(t => {
      const isOut = !!t.checkout_id;
      const isMine = isOut && t.checked_out_by === S.user.id;
      const statusClass = isOut ? 'tool-out' : 'tool-in';

      const locationParts = [
        t.checkout_project_name || t.checkout_project_text || '',
        t.checkout_address || ''
      ].filter(Boolean);
      const locationHtml = isOut && locationParts.length
        ? `<span style="font-size:0.78rem;color:var(--text-light);">&#128205; ${esc(locationParts.join(' / '))}</span>`
        : '';

      const statusText = isOut
        ? `${esc(t.checked_out_by_name)} seit ${fmtDT(t.checked_out_at)}`
        : 'Im Lager';

      let actions = '';
      let inlineForm = '';
      if (!isOut) {
        actions = `<button class="btn btn-sm btn-primary tool-checkout" data-id="${t.id}">Entnehmen</button>`;
        inlineForm = checkoutFormHtml(t.id, '&#10003; Entnehmen', 'checkout');
      } else if (isMine) {
        actions = `<button class="btn btn-sm btn-success tool-return" data-id="${t.id}">Zurückgeben</button>`;
      } else {
        actions = `<button class="btn btn-sm btn-outline tool-takeover" data-id="${t.id}">Übernehmen</button>`;
        inlineForm = checkoutFormHtml(t.id, '&#10003; Übernehmen', 'takeover');
      }

      return `<div class="tool-item ${statusClass}">
        <div class="tool-info">
          <strong>${esc(t.name)}</strong>
          <span class="tool-status">${statusText}</span>
          ${locationHtml}
        </div>
        <div class="tool-actions">
          ${actions}
          <button class="btn btn-sm btn-outline tool-history" data-id="${t.id}" data-name="${esc(t.name)}">Historie</button>
          ${canManage ? `<button class="btn btn-sm btn-outline tool-edit" data-id="${t.id}" data-name="${esc(t.name)}">&#9998;</button>` : ''}
          ${canManage ? `<button class="btn btn-sm btn-danger tool-delete" data-id="${t.id}">&#10005;</button>` : ''}
        </div>
        ${inlineForm}
      </div>`;
    }).join('');
  }

  mainEl.innerHTML = `
    <div class="card" style="max-width:800px;margin:0 auto;">
      <div class="card-header">
        <h2>&#128295; Werkzeugliste</h2>
      </div>
      ${canManage ? `
      <div class="form-row" style="margin-bottom:1rem;gap:0.5rem;">
        <input type="text" class="form-control" id="tool-name" placeholder="Werkzeugname" style="flex:1;">
        <button class="btn btn-primary" id="tool-add">Hinzufügen</button>
      </div>` : ''}
      <div id="tools-list">${toolsHtml}</div>
    </div>
    <div id="tool-history-modal" class="modal-overlay" style="display:none;">
      <div class="card" style="max-width:500px;margin:2rem auto;max-height:80vh;overflow-y:auto;">
        <div class="card-header">
          <h3 id="history-title">Historie</h3>
          <button class="btn btn-outline btn-sm" id="history-close">Schließen</button>
        </div>
        <div id="history-content"></div>
      </div>
    </div>`;

  // Werkzeug hinzufügen
  document.getElementById('tool-add')?.addEventListener('click', async () => {
    const nameEl = document.getElementById('tool-name');
    const name = nameEl.value.trim();
    if (!name) { toast('Bitte einen Namen eingeben', 'error'); return; }
    try {
      await api('POST', '/api/tools', { name });
      toast('Werkzeug hinzugefügt', 'success');
      renderTools();
    } catch (e) { toast(e.message, 'error'); }
  });

  document.getElementById('tool-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('tool-add')?.click();
  });

  // Entnehmen / Übernehmen — Inline-Form öffnen
  mainEl.querySelectorAll('.tool-checkout, .tool-takeover').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById(`tcf-${btn.dataset.id}`);
      if (!form) return;
      form.style.display = form.style.display === 'none' ? '' : 'none';
      // Projekt-Dropdown und Freitext verknüpfen
      const projSel = document.getElementById(`tcf-proj-${btn.dataset.id}`);
      const projText = document.getElementById(`tcf-text-${btn.dataset.id}`);
      const addrInp = document.getElementById(`tcf-addr-${btn.dataset.id}`);
      if (projSel && !projSel._bound) {
        projSel._bound = true;
        projSel.addEventListener('change', () => {
          const proj = projects.find(p => p.id == projSel.value);
          if (proj) {
            if (proj.address) addrInp.value = proj.address;
            projText.value = '';
            projText.disabled = true;
          } else {
            projText.disabled = false;
          }
        });
      }
    });
  });

  // Inline-Form Bestätigen
  mainEl.querySelectorAll('.tcf-confirm').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const endpoint = btn.dataset.endpoint;
      const project_id = document.getElementById(`tcf-proj-${id}`)?.value || null;
      const project_text = document.getElementById(`tcf-text-${id}`)?.value || null;
      const address = document.getElementById(`tcf-addr-${id}`)?.value || null;
      try {
        await api('POST', `/api/tools/${id}/${endpoint}`, { project_id: project_id || null, project_text, address });
        toast(endpoint === 'checkout' ? 'Werkzeug entnommen' : 'Werkzeug übernommen', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // Inline-Form Abbrechen
  mainEl.querySelectorAll('.tcf-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById(`tcf-${btn.dataset.id}`);
      if (form) form.style.display = 'none';
    });
  });

  // Zurückgeben
  mainEl.querySelectorAll('.tool-return').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/tools/${btn.dataset.id}/return`);
        toast('Werkzeug zurückgegeben', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // Bearbeiten
  mainEl.querySelectorAll('.tool-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const newName = prompt('Werkzeug umbenennen:', btn.dataset.name);
      if (newName === null || !newName.trim()) return;
      api('PUT', `/api/tools/${btn.dataset.id}`, { name: newName.trim() })
        .then(() => { toast('Werkzeug umbenannt', 'success'); renderTools(); })
        .catch(e => toast(e.message, 'error'));
    });
  });

  // Löschen
  mainEl.querySelectorAll('.tool-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Werkzeug wirklich löschen?')) return;
      try {
        await api('DELETE', `/api/tools/${btn.dataset.id}`);
        toast('Werkzeug gelöscht', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // Historie
  mainEl.querySelectorAll('.tool-history').forEach(btn => {
    btn.addEventListener('click', async () => {
      const modal = document.getElementById('tool-history-modal');
      const toolId = btn.dataset.id;
      document.getElementById('history-title').textContent = `Historie: ${btn.dataset.name}`;
      document.getElementById('history-content').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      modal.style.display = '';
      try {
        const data = await api('GET', `/api/tools/${toolId}/history`);
        if (data && data.history.length > 0) {
          const th = `<th style="text-align:left;padding:0.5rem 0.75rem;border-bottom:2px solid var(--border);">`;
          const td = `padding:0.4rem 0.75rem;border-bottom:1px solid var(--border);`;
          document.getElementById('history-content').innerHTML = `<table class="table" style="font-size:0.85rem;width:100%;border-collapse:separate;border-spacing:0;">
            <thead><tr>${th}Wer</th>${th}Entnommen</th>${th}Zurück</th>${th}Projekt / Ort</th></tr></thead>
            <tbody>${data.history.map(h => {
              const loc = [h.project_name || h.project_text || '', h.address || ''].filter(Boolean).join(' / ');
              return `<tr>
                <td style="${td}">${esc(h.user_name)}</td>
                <td style="${td}white-space:nowrap;">${fmtDT(h.checked_out_at)}</td>
                <td style="${td}white-space:nowrap;">${h.returned_at ? fmtDT(h.returned_at) : '<em>unterwegs</em>'}</td>
                <td style="${td}font-size:0.8rem;color:var(--text-light);">${loc ? esc(loc) : '–'}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
          ${isAdmin() ? `<button class="btn btn-danger btn-sm" id="clear-history" data-id="${toolId}" style="margin-top:0.5rem;">Historie zurücksetzen</button>` : ''}`;
          document.getElementById('clear-history')?.addEventListener('click', async () => {
            if (!confirm('Komplette Historie dieses Werkzeugs wirklich löschen?')) return;
            try {
              await api('DELETE', `/api/tools/${toolId}/history`);
              toast('Historie zurückgesetzt', 'success');
              modal.style.display = 'none';
              renderTools();
            } catch (e) { toast(e.message, 'error'); }
          });
        } else {
          document.getElementById('history-content').innerHTML = '<p style="color:var(--text-light);padding:1rem;">Noch keine Einträge.</p>';
        }
      } catch (e) { document.getElementById('history-content').innerHTML = '<p>Fehler beim Laden.</p>'; }
    });
  });

  // Modal schließen
  document.getElementById('history-close')?.addEventListener('click', () => {
    document.getElementById('tool-history-modal').style.display = 'none';
  });
  document.getElementById('tool-history-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'tool-history-modal') e.target.style.display = 'none';
  });
}

// --- Welcome Page ---
async function renderWelcomeWeek() {
  const container = document.getElementById('welcome-week-container');
  if (!container) return;

  const today = formatDateISO(new Date());
  const now = new Date();
  const baseDate = new Date(now);
  baseDate.setDate(baseDate.getDate() + S.welcomeWeekOffset * 7);
  const kwDay = baseDate.getDay();
  const monOff = kwDay === 0 ? -6 : 1 - kwDay;
  const kwMon = new Date(baseDate); kwMon.setDate(baseDate.getDate() + monOff);
  const kwSun = new Date(kwMon); kwSun.setDate(kwMon.getDate() + 6);
  const kwFrom = formatDateISO(kwMon);
  const kwTo = formatDateISO(kwSun);

  let plannings = [];
  try {
    const data = await api('GET', `/api/planning?date_from=${kwFrom}&date_to=${kwTo}`);
    if (data) {
      plannings = data.entries.filter(e =>
        e.assigned_users.some(u => u.user_id === S.user.id)
      );
      plannings.sort((a, b) => a.date.localeCompare(b.date) || a.time_from.localeCompare(b.time_from));
    }
  } catch (e) {}

  let planHtml = '';
  if (plannings.length === 0) {
    planHtml = '<p style="color:var(--text-light)">Keine Planungen diese Woche.</p>';
  } else {
    const shortDays = ['So','Mo','Di','Mi','Do','Fr','Sa'];
    planHtml = plannings.map(e => {
      const d = new Date(e.date + 'T12:00:00');
      const dayLabel = `${shortDays[d.getDay()]}, ${formatDateDE(e.date)}`;
      const isToday = e.date === today;
      const proj = e.project_name || e.project_text || '';
      const colleagues = e.assigned_users.filter(u => u.user_id !== S.user.id).map(u => u.user_name);
      return `<div class="welcome-task${isToday ? ' welcome-task-today' : ''}">
        <div class="welcome-task-time"><strong>${dayLabel}</strong> ${e.time_from} - ${e.time_to}</div>
        <div class="welcome-task-details">
          ${proj ? `<span>&#128193; ${esc(proj)}</span>` : ''}
          ${e.address ? `<span>&#128205; ${esc(e.address)}</span>` : ''}
          ${e.description ? `<span>${esc(e.description)}</span>` : ''}
          ${colleagues.length ? `<span>&#128101; mit ${esc(colleagues.join(', '))}</span>` : ''}
        </div>
        <div class="welcome-task-actions">
          ${e.address ? `<button class="btn btn-sm btn-outline btn-nav nav-to-addr" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''}
          <button class="btn btn-sm btn-success accept-welcome-plan" data-id="${e.id}">Übernehmen</button>
        </div>
      </div>`;
    }).join('');
  }

  container.innerHTML = `
    <h3 style="display:flex;align-items:center;gap:0.5rem;">
      ${S.welcomeWeekOffset !== 0 ? '<button class="btn btn-sm btn-outline" id="welcome-week-prev">&#8249;</button>' : ''}
      <span>&#128197; ${S.welcomeWeekOffset === 0 ? 'Deine Woche' : 'KW ' + getISOWeek(kwFrom)} (${formatDateDE(kwFrom)} - ${formatDateDE(kwTo)})</span>
      <button class="btn btn-sm btn-outline" id="welcome-week-next">&#8250;</button>
    </h3>
    ${planHtml}`;

  document.getElementById('welcome-week-prev')?.addEventListener('click', () => { S.welcomeWeekOffset--; renderWelcomeWeek(); });
  document.getElementById('welcome-week-next')?.addEventListener('click', () => { S.welcomeWeekOffset++; renderWelcomeWeek(); });
}

async function renderWelcome() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'welcome');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const today = formatDateISO(new Date());
  const dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const mNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const now = new Date();
  const dateStr = `${dayNames[now.getDay()]}, ${now.getDate()}. ${mNames[now.getMonth()]} ${now.getFullYear()}`;

  // Schwarzes Brett laden
  let newBulletins = [];
  let eventBulletins = [];
  try {
    const data = await api('GET', '/api/bulletin');
    if (data) {
      newBulletins = data.entries.filter(b => b.created_at && b.created_at.slice(0, 10) === today);
      const in3 = new Date(now); in3.setDate(in3.getDate() + 3);
      const day3 = formatDateISO(in3);
      eventBulletins = data.entries.filter(b => b.event_date && b.event_date >= today && b.event_date <= day3);
    }
  } catch (e) {}

  const bulletinCard = b => `<div class="welcome-bulletin">
    <div class="welcome-bulletin-header">
      <strong>${esc(b.title)}</strong>
      ${b.event_date ? `<span class="welcome-bulletin-event">&#128197; ${formatDateDE(b.event_date)}</span>` : ''}
    </div>
    ${b.text ? `<div class="welcome-bulletin-text">${esc(b.text)}</div>` : ''}
    <div class="welcome-bulletin-meta">von ${esc(b.author_name)} am ${formatDateDE(b.created_at?.slice(0, 10) || '')}</div>
  </div>`;

  let newBulletinHtml = '';
  if (newBulletins.length > 0) {
    newBulletinHtml = `<div class="welcome-section">
      <h3>&#128204; Neu auf dem Schwarzen Brett</h3>
      ${newBulletins.map(bulletinCard).join('')}
    </div>`;
  }

  let eventBulletinHtml = '';
  if (eventBulletins.length > 0) {
    eventBulletinHtml = `<div class="welcome-section">
      <h3>&#127937; Ereignisse in den nächsten 3 Tagen</h3>
      ${eventBulletins.map(bulletinCard).join('')}
    </div>`;
  }

  mainEl.innerHTML = `
    <div class="welcome-page">
      <div class="welcome-header">
        <div class="welcome-date">${dateStr}</div>
        <div class="welcome-clock" id="welcome-clock"></div>
        <h1>Willkommen, ${esc(S.user.name)}!</h1>
      </div>
      <div class="welcome-section" id="welcome-week-container">
        <div class="loading"><div class="spinner"></div></div>
      </div>
      ${eventBulletinHtml}
      ${newBulletinHtml}
      <div class="welcome-section" id="welcome-weather">
        <h3>&#9925; Wetter</h3>
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>`;

  // Live-Uhr
  function updateClock() {
    const el = document.getElementById('welcome-clock');
    if (!el) return;
    const n = new Date();
    el.textContent = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
  }
  updateClock();
  const clockInterval = setInterval(() => {
    if (!document.getElementById('welcome-clock')) { clearInterval(clockInterval); return; }
    updateClock();
  }, 1000);

  // Wetter laden: komplett serverseitig (Geocoding + Wetter)
  try {
    const w = await api('GET', '/api/settings/weather');
    const wDiv = document.getElementById('welcome-weather');
    if (!wDiv) throw new Error();
    if (w.error) {
      wDiv.innerHTML = `<h3>&#9925; Wetter</h3><p style="color:var(--text-light)">${esc(w.error)}. Bitte Ort in den Einstellungen hinterlegen.</p>`;
    } else if (w.current && w.hourly) {
      const c = w.current;
      const d = w.daily;
      const h = w.hourly;
      const nowHour = new Date().getHours();

      // Stündlichen Verlauf bauen (nur 6-22 Uhr)
      let hourlyHtml = '';
      const tempMin = Math.min(...h.temperature_2m.slice(6, 23));
      const tempMax = Math.max(...h.temperature_2m.slice(6, 23));
      const tempRange = tempMax - tempMin || 1;
      for (let i = 6; i <= 22; i++) {
        const temp = h.temperature_2m[i];
        const code = h.weather_code[i];
        const rain = h.precipitation_probability[i];
        const barPct = Math.round(((temp - tempMin) / tempRange) * 100);
        const isNow = i === nowHour;
        hourlyHtml += `<div class="wh-col${isNow ? ' wh-now' : ''}">
          <div class="wh-temp">${Math.round(temp)}°</div>
          <div class="wh-bar-wrap"><div class="wh-bar" style="height:${Math.max(barPct, 8)}%"></div></div>
          <div class="wh-icon">${weatherIcon(code)}</div>
          ${rain > 0 ? `<div class="wh-rain">${rain}%</div>` : '<div class="wh-rain">&nbsp;</div>'}
          <div class="wh-time">${i}h</div>
        </div>`;
      }

      wDiv.innerHTML = `<h3>&#9925; Wetter in ${esc(w.city)}</h3>
        <div class="weather-current">
          <div class="weather-icon">${weatherIcon(c.weather_code)}</div>
          <div class="weather-info">
            <span class="weather-temp">${c.temperature_2m}°C</span>
            <span class="weather-desc">${weatherDescription(c.weather_code)}</span>
          </div>
          <div class="weather-minmax">
            &#9650; ${d.temperature_2m_max[0]}° &nbsp; &#9660; ${d.temperature_2m_min[0]}°
          </div>
          <div class="weather-extra">
            &#128168; ${c.wind_speed_10m} km/h &nbsp; &#128167; ${c.relative_humidity_2m}%
          </div>
        </div>
        <div class="wh-scroll"><div class="wh-timeline">${hourlyHtml}</div></div>`;
    }
  } catch (e) {
    const wDiv = document.getElementById('welcome-weather');
    if (wDiv) wDiv.innerHTML = '<h3>&#9925; Wetter</h3><p style="color:var(--text-light)">Wetterdaten nicht verfügbar.</p>';
  }

  // Wochen-Planung laden
  await renderWelcomeWeek();

  // Navigation starten (delegiert, da Inhalt dynamisch)
  mainEl.addEventListener('click', (e) => {
    const navBtn = e.target.closest('.nav-to-addr');
    if (navBtn) { openNav(navBtn.dataset.addr); return; }
    const acceptBtn = e.target.closest('.accept-welcome-plan');
    if (acceptBtn) { navigate('/planning/accept/' + acceptBtn.dataset.id); return; }
  });
}

function weatherDescription(code) {
  const map = {0:'Klar',1:'Überwiegend klar',2:'Teilweise bewölkt',3:'Bewölkt',45:'Nebel',48:'Nebel mit Reif',
    51:'Leichter Nieselregen',53:'Nieselregen',55:'Starker Nieselregen',61:'Leichter Regen',63:'Regen',65:'Starker Regen',
    71:'Leichter Schneefall',73:'Schneefall',75:'Starker Schneefall',77:'Schneekörner',80:'Leichte Regenschauer',
    81:'Regenschauer',82:'Starke Regenschauer',85:'Leichte Schneeschauer',86:'Starke Schneeschauer',
    95:'Gewitter',96:'Gewitter mit Hagel',99:'Starkes Gewitter mit Hagel'};
  return map[code] || 'Unbekannt';
}

function weatherIcon(code) {
  if (code === 0) return '&#9728;&#65039;';
  if (code <= 2) return '&#9925;';
  if (code === 3) return '&#9729;&#65039;';
  if (code <= 48) return '&#127787;&#65039;';
  if (code <= 55) return '&#127782;&#65039;';
  if (code <= 65) return '&#127783;&#65039;';
  if (code <= 77) return '&#127784;&#65039;';
  if (code <= 82) return '&#127783;&#65039;';
  if (code <= 86) return '&#127784;&#65039;';
  return '&#9889;';
}

// --- Bulletin Board (Schwarzes Brett) ---
async function renderBulletin() {
  S.badges.bulletin = 0;
  refreshBadges();
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'bulletin');
  bindLayout();

  let entries = [];
  try {
    const data = await api('GET', '/api/bulletin');
    markSeen('bulletin');
    if (data) entries = data.entries;
  } catch (e) {}

  const canEdit = canEditBulletin();
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  let cardsHtml = '';
  if (entries.length === 0) {
    cardsHtml = '<div class="empty-state"><div class="icon">&#128204;</div><p>Keine Einträge am Schwarzen Brett.</p></div>';
  } else {
    cardsHtml = entries.map(b => {
      const createdDate = formatDateDE(b.created_at?.slice(0, 10) || '');
      return `<div class="bulletin-card${b.is_unread ? ' bulletin-card--unread' : ''}">
        <div class="bulletin-header">
          <h3 class="bulletin-title">${esc(b.title)}</h3>
          ${canEdit ? `<div class="bulletin-actions">
            <button class="btn btn-sm btn-outline edit-bulletin" data-id="${b.id}">Bearbeiten</button>
            <button class="btn btn-sm btn-danger del-bulletin" data-id="${b.id}">Löschen</button>
          </div>` : ''}
        </div>
        ${b.text ? `<div class="bulletin-text">${esc(b.text).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="bulletin-meta">
          <span>&#128100; ${esc(b.author_name)}</span>
          <span>&#128197; Erstellt: ${createdDate}</span>
          ${b.event_date ? `<span>&#127937; Event: ${formatDateDE(b.event_date)}</span>` : ''}
          ${b.auto_delete_date ? `<span>&#128465; Läuft ab: ${formatDateDE(b.auto_delete_date)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  mainEl.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>&#128204; Schwarzes Brett</h2>
      </div>
      <div class="bulletin-list">${cardsHtml}</div>
    </div>`;

  mainEl.querySelectorAll('.edit-bulletin').forEach(btn => {
    btn.addEventListener('click', () => navigate('/bulletin/edit/' + btn.dataset.id));
  });
  mainEl.querySelectorAll('.del-bulletin').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Eintrag wirklich löschen?')) return;
      try {
        await api('DELETE', '/api/bulletin/' + btn.dataset.id);
        toast('Eintrag gelöscht', 'success');
        renderBulletin();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function renderBulletinForm(editId) {
  let entry = null;
  if (editId) {
    try {
      const data = await api('GET', '/api/bulletin');
      if (data) entry = data.entries.find(e => e.id === Number(editId));
    } catch (e) { toast(e.message, 'error'); navigate('/bulletin'); return; }
  }

  const isEdit = !!entry;
  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <div class="card-header">
        <h2>${isEdit ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</h2>
        <button class="btn btn-outline btn-sm" id="back-btn">Zurück</button>
      </div>
      <form id="bulletin-form">
        <div class="form-group">
          <label>Überschrift *</label>
          <input type="text" class="form-control" id="bf-title" value="${esc(entry?.title || '')}" required>
        </div>
        <div class="form-group">
          <label>Text</label>
          <textarea class="form-control" id="bf-text" rows="5" placeholder="Nachricht...">${esc(entry?.text || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Event-Datum (optional)</label>
            <input type="date" class="form-control" id="bf-event-date" value="${entry?.event_date || ''}">
          </div>
          <div class="form-group">
            <label>Automatisch löschen am (optional)</label>
            <input type="date" class="form-control" id="bf-auto-delete" value="${entry?.auto_delete_date || ''}">
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Speichern' : 'Erstellen'}</button>
        ${isEdit ? '<button type="button" class="btn btn-danger btn-block" id="delete-bulletin" style="margin-top:0.5rem">Eintrag löschen</button>' : ''}
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'bulletin');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  document.getElementById('back-btn').addEventListener('click', () => navigate('/bulletin'));

  document.getElementById('bulletin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: document.getElementById('bf-title').value,
      text: document.getElementById('bf-text').value,
      event_date: document.getElementById('bf-event-date').value || null,
      auto_delete_date: document.getElementById('bf-auto-delete').value || null,
    };
    try {
      if (isEdit) {
        await api('PUT', '/api/bulletin/' + editId, body);
        toast('Eintrag aktualisiert', 'success');
      } else {
        await api('POST', '/api/bulletin', body);
        toast('Eintrag erstellt', 'success');
      }
      navigate('/bulletin');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('delete-bulletin')?.addEventListener('click', async () => {
    if (!confirm('Eintrag wirklich löschen?')) return;
    try {
      await api('DELETE', '/api/bulletin/' + editId);
      toast('Eintrag gelöscht', 'success');
      navigate('/bulletin');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Users Management ---
async function renderUsers() {
  if (!canManageUsers()) { navigate('/'); return; }

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'users');
  bindLayout();

  try {
    const data = await api('GET', '/api/users');
    if (!data) return;
    S.users = data.users;
  } catch (e) { toast(e.message, 'error'); return; }

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>Mitarbeiter</h2>
        <button class="btn btn-primary btn-sm" id="add-user-btn">+ Neuer Mitarbeiter</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Benutzername</th>
              <th>Rolle</th>
              <th>Soll h/Woche</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            ${S.users.map(u => `
              <tr>
                <td>${esc(u.name)}</td>
                <td>${esc(u.username)}</td>
                <td><span class="badge badge-${u.role}">${roleName(u.role)}</span></td>
                <td>${u.target_hours_per_week}</td>
                <td class="actions">
                  <button class="btn btn-sm btn-outline edit-user" data-id="${u.id}">Bearbeiten</button>
                  ${u.id !== S.user.id ? `<button class="btn btn-sm btn-danger del-user" data-id="${u.id}">Löschen</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('add-user-btn').addEventListener('click', () => showUserModal());

  mainEl.querySelectorAll('.edit-user').forEach(btn => {
    btn.addEventListener('click', () => {
      const user = S.users.find(u => u.id === Number(btn.dataset.id));
      if (user) showUserModal(user);
    });
  });

  mainEl.querySelectorAll('.del-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const user = S.users.find(u => u.id === Number(btn.dataset.id));
      if (!confirm(`"${user?.name}" wirklich löschen? Alle Einträge werden ebenfalls gelöscht.`)) return;
      try {
        await api('DELETE', '/api/users/' + btn.dataset.id);
        toast('Mitarbeiter gelöscht', 'success');
        renderUsers();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function showUserModal(user) {
  const isEdit = !!user;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide">
      <h2>${isEdit ? 'Mitarbeiter bearbeiten' : 'Neuer Mitarbeiter'}</h2>
      <form id="user-modal-form">
        <div class="form-group">
          <label>Name</label>
          <input type="text" class="form-control" id="um-name" value="${esc(user?.name || '')}" required>
        </div>
        <div class="form-group">
          <label>Benutzername</label>
          <input type="text" class="form-control" id="um-username" value="${esc(user?.username || '')}" required>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <button type="button" class="btn btn-outline btn-sm" id="um-reset-pw-btn">&#128274; Passwort zurücksetzen</button>
          <div id="um-reset-pw-form" style="display:none;margin-top:0.5rem;">
            <input type="password" class="form-control" id="um-pw-new" placeholder="Neues Passwort" style="margin-bottom:0.4rem;">
            <input type="password" class="form-control" id="um-pw-repeat" placeholder="Wiederholen">
            <div style="display:flex;gap:0.5rem;margin-top:0.4rem;">
              <button type="button" class="btn btn-primary btn-sm" id="um-pw-save">Speichern</button>
              <button type="button" class="btn btn-outline btn-sm" id="um-pw-cancel">Abbrechen</button>
            </div>
          </div>
        </div>` : `
        <div class="form-group">
          <label>Passwort</label>
          <input type="password" class="form-control" id="um-password" required>
        </div>`}
        <div class="form-row">
          <div class="form-group">
            <label>Rolle</label>
            <select class="form-control" id="um-role">
              <option value="mitarbeiter" ${user?.role === 'mitarbeiter' ? 'selected' : ''}>Mitarbeiter</option>
              <option value="buchhalter" ${user?.role === 'buchhalter' ? 'selected' : ''}>Buchhalter</option>
              <option value="chef" ${user?.role === 'chef' ? 'selected' : ''}>Chef</option>
              ${S.user.role === 'admin' ? `<option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>` : ''}
            </select>
          </div>
          <div class="form-group">
            <label>Start-Überstunden (h)</label>
            <input type="number" class="form-control" id="um-start-overtime" value="${user?.start_overtime ?? 0}" step="0.01">
          </div>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
            <input type="checkbox" id="um-can-plan" ${user?.can_plan ? 'checked' : ''}>
            Planungsrecht (darf Planungen erstellen/bearbeiten)
          </label>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-top:0.3rem;">
            <input type="checkbox" id="um-can-bulletin" ${user?.can_bulletin ? 'checked' : ''}>
            Schwarzes-Brett-Recht (darf Einträge erstellen/bearbeiten)
          </label>
        </div>
        ${isEdit ? `
        <div class="form-section">
          <label class="form-section-title">Soll-Stunden pro Tag</label>
          <div id="um-targets-list"><div class="loading"><div class="spinner"></div></div></div>
          <div class="targets-add-days">
            <div class="day-hours-row">
              <label>Mo <input type="number" id="um-target-mon" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Di <input type="number" id="um-target-tue" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Mi <input type="number" id="um-target-wed" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Do <input type="number" id="um-target-thu" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Fr <input type="number" id="um-target-fri" step="0.01" min="0" max="24" value="6" class="form-control form-control-sm"></label>
            </div>
            <div class="targets-add-bottom">
              <input type="date" id="um-target-from" class="form-control">
              <button type="button" class="btn btn-primary btn-sm" id="um-target-add">Hinzufügen</button>
            </div>
          </div>
        </div>` : `
        <div class="form-section">
          <label class="form-section-title">Soll-Stunden pro Tag</label>
          <div class="day-hours-row">
            <label>Mo <input type="number" class="form-control form-control-sm" id="um-h-mon" value="8" min="0" max="24" step="0.01"></label>
            <label>Di <input type="number" class="form-control form-control-sm" id="um-h-tue" value="8" min="0" max="24" step="0.01"></label>
            <label>Mi <input type="number" class="form-control form-control-sm" id="um-h-wed" value="8" min="0" max="24" step="0.01"></label>
            <label>Do <input type="number" class="form-control form-control-sm" id="um-h-thu" value="8" min="0" max="24" step="0.01"></label>
            <label>Fr <input type="number" class="form-control form-control-sm" id="um-h-fri" value="6" min="0" max="24" step="0.01"></label>
          </div>
        </div>`}
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" id="um-cancel">Abbrechen</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Speichern' : 'Erstellen'}</button>
        </div>
      </form>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('um-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Passwort zurücksetzen (nur bei Bearbeitung)
  if (isEdit) {
    document.getElementById('um-reset-pw-btn').addEventListener('click', () => {
      document.getElementById('um-reset-pw-form').style.display = '';
      document.getElementById('um-pw-new').focus();
    });
    document.getElementById('um-pw-cancel').addEventListener('click', () => {
      document.getElementById('um-reset-pw-form').style.display = 'none';
      document.getElementById('um-pw-new').value = '';
      document.getElementById('um-pw-repeat').value = '';
    });
    document.getElementById('um-pw-save').addEventListener('click', async () => {
      const pw1 = document.getElementById('um-pw-new').value;
      const pw2 = document.getElementById('um-pw-repeat').value;
      if (!pw1) { toast('Passwort eingeben', 'error'); return; }
      if (pw1 !== pw2) { toast('Passwörter stimmen nicht überein', 'error'); return; }
      try {
        await api('POST', `/api/users/${user.id}/reset-password`, { password: pw1 });
        toast('Passwort gesetzt', 'success');
        document.getElementById('um-reset-pw-form').style.display = 'none';
        document.getElementById('um-pw-new').value = '';
        document.getElementById('um-pw-repeat').value = '';
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // Soll-Stunden-Verlauf laden (nur bei Bearbeitung)
  if (isEdit) {
    await loadUserTargets(user.id);

    document.getElementById('um-target-add')?.addEventListener('click', async () => {
      const from = document.getElementById('um-target-from').value;
      if (!from) { toast('Gültig-ab-Datum eingeben', 'error'); return; }
      const body = {
        hours_mon: parseFloat(document.getElementById('um-target-mon').value) || 0,
        hours_tue: parseFloat(document.getElementById('um-target-tue').value) || 0,
        hours_wed: parseFloat(document.getElementById('um-target-wed').value) || 0,
        hours_thu: parseFloat(document.getElementById('um-target-thu').value) || 0,
        hours_fri: parseFloat(document.getElementById('um-target-fri').value) || 0,
        valid_from: from,
      };
      try {
        await api('POST', `/api/statistics/targets/${user.id}`, body);
        toast('Soll-Stunden gespeichert', 'success');
        await loadUserTargets(user.id);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  document.getElementById('user-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('um-name').value,
      username: document.getElementById('um-username').value,
      role: document.getElementById('um-role').value,
      start_overtime: parseFloat(document.getElementById('um-start-overtime').value) || 0,
      can_plan: document.getElementById('um-can-plan').checked,
      can_bulletin: document.getElementById('um-can-bulletin').checked,
    };
    // Bei neuem User Tages-Stunden setzen
    if (!isEdit) {
      body.hours_mon = parseFloat(document.getElementById('um-h-mon').value) || 0;
      body.hours_tue = parseFloat(document.getElementById('um-h-tue').value) || 0;
      body.hours_wed = parseFloat(document.getElementById('um-h-wed').value) || 0;
      body.hours_thu = parseFloat(document.getElementById('um-h-thu').value) || 0;
      body.hours_fri = parseFloat(document.getElementById('um-h-fri').value) || 0;
      body.target_hours_per_week = body.hours_mon + body.hours_tue + body.hours_wed + body.hours_thu + body.hours_fri;
    }
    try {
      if (isEdit) {
        await api('PUT', '/api/users/' + user.id, body);
        toast('Mitarbeiter aktualisiert', 'success');
      } else {
        const pw = document.getElementById('um-password').value;
        if (!pw) { toast('Passwort erforderlich', 'error'); return; }
        body.password = pw;
        await api('POST', '/api/users', body);
        toast('Mitarbeiter erstellt', 'success');
      }
      overlay.remove();
      renderUsers();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function loadUserTargets(userId) {
  const container = document.getElementById('um-targets-list');
  if (!container) return;
  try {
    const data = await api('GET', `/api/statistics/targets/${userId}`);
    if (!data) return;
    container.innerHTML = `<table class="data-table targets-table targets-days-table">
      <tr><th>Gültig ab</th><th>Mo</th><th>Di</th><th>Mi</th><th>Do</th><th>Fr</th><th>Summe</th><th></th></tr>
      ${data.targets.map(t => {
        const sum = ((t.hours_mon||0)+(t.hours_tue||0)+(t.hours_wed||0)+(t.hours_thu||0)+(t.hours_fri||0)).toFixed(2);
        return `
        <tr data-target-id="${t.id}">
          <td><input type="date" class="form-control form-control-sm target-from" value="${t.valid_from}"></td>
          <td><input type="number" class="form-control form-control-sm t-mon" value="${t.hours_mon||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-tue" value="${t.hours_tue||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-wed" value="${t.hours_wed||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-thu" value="${t.hours_thu||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-fri" value="${t.hours_fri||0}" step="0.01" min="0" max="24"></td>
          <td class="target-sum">${sum}h</td>
          <td class="actions target-actions">
            <button type="button" class="btn btn-sm btn-outline save-target" title="Speichern">&#10003;</button>
            ${data.targets.length > 1 ? `<button type="button" class="btn btn-sm btn-danger del-target" title="Löschen">&#10005;</button>` : ''}
          </td>
        </tr>`;
      }).join('')}
    </table>`;
    // Live-Summe aktualisieren
    container.querySelectorAll('tr[data-target-id]').forEach(tr => {
      tr.querySelectorAll('input[type="number"]').forEach(inp => {
        inp.addEventListener('input', () => {
          const m = parseFloat(tr.querySelector('.t-mon').value)||0;
          const t2 = parseFloat(tr.querySelector('.t-tue').value)||0;
          const w = parseFloat(tr.querySelector('.t-wed').value)||0;
          const t4 = parseFloat(tr.querySelector('.t-thu').value)||0;
          const f = parseFloat(tr.querySelector('.t-fri').value)||0;
          tr.querySelector('.target-sum').textContent = (m+t2+w+t4+f).toFixed(2) + 'h';
        });
      });
    });
    container.querySelectorAll('.save-target').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const id = tr.dataset.targetId;
        const from = tr.querySelector('.target-from').value;
        if (!from) { toast('Datum eingeben', 'error'); return; }
        const body = {
          hours_mon: parseFloat(tr.querySelector('.t-mon').value)||0,
          hours_tue: parseFloat(tr.querySelector('.t-tue').value)||0,
          hours_wed: parseFloat(tr.querySelector('.t-wed').value)||0,
          hours_thu: parseFloat(tr.querySelector('.t-thu').value)||0,
          hours_fri: parseFloat(tr.querySelector('.t-fri').value)||0,
          valid_from: from,
        };
        try {
          await api('PUT', `/api/statistics/targets/${userId}/${id}`, body);
          toast('Gespeichert', 'success');
          await loadUserTargets(userId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    container.querySelectorAll('.del-target').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('tr').dataset.targetId;
        try {
          await api('DELETE', `/api/statistics/targets/${userId}/${id}`);
          toast('Eintrag gelöscht', 'success');
          await loadUserTargets(userId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) {}
}

// --- Projects ---
async function renderProjects() {
  if (!canManageProjects()) { navigate('/'); return; }

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'projects');
  bindLayout();

  try {
    const data = await api('GET', '/api/projects');
    if (!data) return;
    S.projects = data.projects;
  } catch (e) { toast(e.message, 'error'); return; }

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <div class="card-header">
        <h2>Projekte</h2>
      </div>
      <form id="add-project-form" style="display:flex;gap:0.5rem;margin-bottom:1rem;">
        <input type="text" class="form-control" id="new-project-name" placeholder="Neues Projekt..." required>
        <button type="submit" class="btn btn-primary">+</button>
      </form>
      <div id="projects-list">
        ${S.projects.map(p => `
          <div class="project-item" data-id="${p.id}">
            <div class="project-header">
              <span style="font-weight:500">${esc(p.name)}</span>
              <div style="display:flex;gap:0.25rem;">
                <button class="btn btn-sm btn-outline toggle-project-details" data-id="${p.id}" title="Bearbeiten">&#9998;</button>
                <button class="btn btn-sm btn-danger del-project" data-id="${p.id}">Löschen</button>
              </div>
            </div>
            <div class="project-details" id="project-details-${p.id}" style="display:none;">
              <div class="form-group" style="margin:0.5rem 0 0;">
                <label style="font-size:0.8rem">Adresse</label>
                <input type="text" class="form-control form-control-sm project-address" data-id="${p.id}" value="${esc(p.address || '')}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
              </div>
              <button class="btn btn-sm btn-primary save-project" data-id="${p.id}" style="margin-top:0.4rem">Speichern</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;

  document.getElementById('add-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-project-name').value.trim();
    if (!name) return;
    try {
      await api('POST', '/api/projects', { name });
      toast('Projekt erstellt', 'success');
      renderProjects();
    } catch (err) { toast(err.message, 'error'); }
  });

  mainEl.querySelectorAll('.toggle-project-details').forEach(btn => {
    btn.addEventListener('click', () => {
      const det = document.getElementById('project-details-' + btn.dataset.id);
      det.style.display = det.style.display === 'none' ? 'block' : 'none';
    });
  });

  mainEl.querySelectorAll('.save-project').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const address = mainEl.querySelector(`.project-address[data-id="${id}"]`).value;
      const p = S.projects.find(p => p.id == id);
      try {
        await api('PUT', '/api/projects/' + id, { name: p.name, address });
        toast('Projekt gespeichert', 'success');
        renderProjects();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  mainEl.querySelectorAll('.del-project').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Projekt wirklich löschen?')) return;
      try {
        await api('DELETE', '/api/projects/' + btn.dataset.id);
        toast('Projekt gelöscht', 'success');
        renderProjects();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// --- Settings ---
async function renderSettings() {
  if (!canSeeSettings()) { navigate('/'); return; }

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'settings');
  bindLayout();

  try {
    const data = await api('GET', '/api/settings');
    if (data) S.settings = data.settings;
  } catch (e) {}

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:600px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:1rem;">Firmen-Einstellungen</h2>
        <form id="settings-form">
          <div class="form-group">
            <label>Firmenname</label>
            <input type="text" class="form-control" id="s-company" value="${esc(S.settings.company_name || '')}">
          </div>
          <div class="form-group">
            <label>Straße + Hausnummer</label>
            <input type="text" class="form-control" id="s-street" value="${esc(S.settings.company_street || '')}" placeholder="Musterstraße 1">
          </div>
          <div class="form-row" style="grid-template-columns:120px 1fr;">
            <div class="form-group">
              <label>PLZ</label>
              <input type="text" class="form-control" id="s-zip" value="${esc(S.settings.company_zip || '')}" placeholder="97491">
            </div>
            <div class="form-group">
              <label>Ort</label>
              <input type="text" class="form-control" id="s-city" value="${esc(S.settings.company_city || '')}" placeholder="Aidhausen">
            </div>
          </div>
          <button type="submit" class="btn btn-primary">Speichern</button>
        </form>
        <hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--border);">
        <div class="form-group">
          <label>Firmenlogo (PNG/JPG)</label>
          ${S.settings.company_logo ? `
            <div style="margin-bottom:0.75rem;">
              <img src="${S.settings.company_logo}" style="max-height:60px;border-radius:4px;" alt="Logo">
              <button class="btn btn-sm btn-danger" id="delete-logo" style="margin-left:0.5rem;">Entfernen</button>
            </div>
          ` : ''}
          <input type="file" class="form-control" id="s-logo" accept=".png,.jpg,.jpeg">
          <button type="button" class="btn btn-outline btn-sm" id="upload-logo" style="margin-top:0.5rem;">Logo hochladen</button>
        </div>
      </div>

      <div class="card">
        <h2 style="margin-bottom:1rem;">Datenbank-Backup</h2>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="btn btn-success" id="backup-download">Backup herunterladen</button>
          <button class="btn btn-outline" id="backup-restore-btn">Backup einspielen</button>
        </div>
        <div id="restore-area" style="display:none;margin-top:1rem;">
          <div class="warning-box">
            <strong>Achtung!</strong> Beim Einspielen eines Backups werden alle aktuellen Daten überschrieben.
            Ein Sicherungs-Backup der aktuellen Datenbank wird automatisch erstellt.
          </div>
          <input type="file" class="form-control" id="backup-file" accept=".zip,.sqlite,.db">
          <button class="btn btn-danger" id="restore-confirm" style="margin-top:0.5rem;">Backup jetzt einspielen</button>
        </div>
      </div>
    </div>`;

  // Settings form
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        company_name: document.getElementById('s-company').value,
        company_street: document.getElementById('s-street').value,
        company_zip: document.getElementById('s-zip').value,
        company_city: document.getElementById('s-city').value,
      });
      toast('Einstellungen gespeichert', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Logo upload
  document.getElementById('upload-logo').addEventListener('click', async () => {
    const fileInput = document.getElementById('s-logo');
    if (!fileInput.files.length) { toast('Bitte eine Datei auswählen', 'error'); return; }
    const fd = new FormData();
    fd.append('logo', fileInput.files[0]);
    try {
      await api('POST', '/api/settings/logo', fd, true);
      toast('Logo hochgeladen', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Logo delete
  document.getElementById('delete-logo')?.addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/settings/logo');
      toast('Logo entfernt', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Backup download
  document.getElementById('backup-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/backup/download';
    a.style.display = 'none';
    // Add auth header via fetch
    fetch('/api/backup/download', { headers: { 'Authorization': 'Bearer ' + S.token } })
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = 'arbeitsdoku_backup.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast('Backup heruntergeladen', 'success');
      })
      .catch(() => toast('Backup-Download fehlgeschlagen', 'error'));
  });

  // Backup restore
  document.getElementById('backup-restore-btn').addEventListener('click', () => {
    document.getElementById('restore-area').style.display = 'block';
  });

  document.getElementById('restore-confirm').addEventListener('click', async () => {
    const fileInput = document.getElementById('backup-file');
    if (!fileInput.files.length) { toast('Bitte eine Backup-Datei auswählen', 'error'); return; }
    if (!confirm('ACHTUNG: Alle aktuellen Daten werden durch das Backup ersetzt!\n\nEin Sicherungs-Backup wird automatisch erstellt.\n\nFortfahren?')) return;

    const fd = new FormData();
    fd.append('backup', fileInput.files[0]);
    try {
      const result = await api('POST', '/api/backup/restore', fd, true);
      toast('Backup erfolgreich wiederhergestellt! Seite wird neu geladen...', 'success');
      setTimeout(() => {
        logout();
        location.reload();
      }, 2000);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- PDF Export ---
async function renderPdfExport() {
  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    if (canViewAll()) {
      const uData = await api('GET', '/api/users');
      if (uData) S.users = uData.users;
    }
  } catch (e) {}

  const now = new Date();
  const weekRange = getWeekRange(now);
  const monthRange = getMonthRange(now);

  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <h2 style="margin-bottom:1rem;">PDF-Export</h2>
      <form id="pdf-form">
        ${canViewAll() ? `
        <div class="form-group">
          <label>Mitarbeiter</label>
          <select class="form-control" id="pdf-user">
            <option value="">Alle Mitarbeiter</option>
            ${getWorkerUsers().map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
          </select>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Projekt</label>
          <select class="form-control" id="pdf-project">
            <option value="">Alle Projekte</option>
            ${S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Zeitraum</label>
          <select class="form-control" id="pdf-period">
            <option value="week">Aktuelle Woche</option>
            <option value="month" selected>Aktueller Monat</option>
            <option value="custom">Benutzerdefiniert</option>
          </select>
        </div>
        <div class="form-row" id="pdf-custom-dates" style="display:none;">
          <div class="form-group">
            <label>Von</label>
            <input type="date" class="form-control" id="pdf-from" value="${monthRange.from}">
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="date" class="form-control" id="pdf-to" value="${monthRange.to}">
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">PDF herunterladen</button>
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'pdf');
  bindLayout();

  document.getElementById('pdf-period').addEventListener('change', (e) => {
    document.getElementById('pdf-custom-dates').style.display = e.target.value === 'custom' ? 'grid' : 'none';
    if (e.target.value === 'week') {
      document.getElementById('pdf-from').value = weekRange.from;
      document.getElementById('pdf-to').value = weekRange.to;
    } else if (e.target.value === 'month') {
      document.getElementById('pdf-from').value = monthRange.from;
      document.getElementById('pdf-to').value = monthRange.to;
    }
  });

  document.getElementById('pdf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const period = document.getElementById('pdf-period').value;
    let dateFrom, dateTo;
    if (period === 'week') { dateFrom = weekRange.from; dateTo = weekRange.to; }
    else if (period === 'month') { dateFrom = monthRange.from; dateTo = monthRange.to; }
    else { dateFrom = document.getElementById('pdf-from').value; dateTo = document.getElementById('pdf-to').value; }

    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    const userId = document.getElementById('pdf-user')?.value;
    if (userId) params.set('user_id', userId);
    const projectId = document.getElementById('pdf-project').value;
    if (projectId) params.set('project_id', projectId);

    try {
      const res = await fetch('/api/pdf/export?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + S.token }
      });
      if (!res.ok) throw new Error('PDF-Export fehlgeschlagen');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `arbeitsdoku_${dateFrom}_${dateTo}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('PDF heruntergeladen', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Statistik ---
async function renderStatistics() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'statistics');
  bindLayout();

  // State für Statistik
  if (!S.statsPeriod) S.statsPeriod = 'month';
  if (!S.statsDate) S.statsDate = new Date();
  if (!S.statsSelectedUsers) S.statsSelectedUsers = new Set();

  try {
    if (canViewAll()) {
      const ud = await api('GET', '/api/users');
      if (ud) S.users = ud.users;
    }
  } catch (e) {}

  renderStatisticsContent();
}

async function renderStatisticsContent() {
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const period = S.statsPeriod;
  const refDate = S.statsDate;

  // User-IDs bestimmen
  let userIds = [];
  if (S.user.role === 'mitarbeiter') {
    userIds = [S.user.id];
  } else if (S.statsSelectedUsers.size > 0) {
    userIds = [...S.statsSelectedUsers];
  } else {
    userIds = getWorkerUsers().map(u => u.id);
  }

  const dateStr = formatDateISO(refDate);
  const params = new URLSearchParams({ period, date: dateStr });
  if (userIds.length > 0) params.set('user_ids', userIds.join(','));

  let stats;
  try {
    stats = await api('GET', '/api/statistics?' + params.toString());
    if (!stats) return;
  } catch (e) { toast(e.message, 'error'); return; }

  // Period-Label
  const periodLabels = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr', total: 'Gesamt' };

  // Navigation
  function navStatsDate(dir) {
    if (period === 'day') S.statsDate.setDate(S.statsDate.getDate() + dir);
    else if (period === 'week') S.statsDate.setDate(S.statsDate.getDate() + dir * 7);
    else if (period === 'month') S.statsDate.setMonth(S.statsDate.getMonth() + dir);
    else if (period === 'year') S.statsDate.setFullYear(S.statsDate.getFullYear() + dir);
  }

  // Mitarbeiter-Chips
  let chipsHtml = '';
  if (canViewAll()) {
    const workers = getWorkerUsers();
    chipsHtml = '<div class="emp-chips stats-chips">';
    workers.forEach((u, i) => {
      const active = S.statsSelectedUsers.size === 0 || S.statsSelectedUsers.has(u.id);
      const color = colorFor(u.id);
      chipsHtml += `<button class="emp-chip ${active ? '' : 'inactive'}" data-uid="${u.id}" style="background:${color}">${esc(u.name)}</button>`;
    });
    chipsHtml += '</div>';
  }

  const c = stats.combined;
  const showNav = period !== 'total';

  mainEl.innerHTML = `
    <div class="stats-page">
      <div class="view-toggle stats-periods">
        ${['day','week','month','year','total'].map(p =>
          `<button class="${period === p ? 'active' : ''}" data-period="${p}">${periodLabels[p]}</button>`
        ).join('')}
      </div>
      ${showNav ? `
      <div class="date-nav">
        <button id="stats-prev">&#8249;</button>
        <span class="current-period">${stats.range.label}</span>
        <button id="stats-next">&#8250;</button>
        <button id="stats-today" class="date-today-btn">Jetzt</button>
      </div>` : `<div class="date-nav"><span class="current-period">${stats.range.label}</span></div>`}
      ${chipsHtml}
      <div class="stats-summary">
        <div class="summary-card">
          <div class="value">${fmtH(c.ist)}</div>
          <div class="label">Ist-Stunden</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmtH(c.soll)}</div>
          <div class="label">Soll-Stunden</div>
        </div>
        <div class="summary-card ${c.ueber >= 0 ? 'positive' : 'negative'}">
          <div class="value">${c.ueber >= 0 ? '+' : ''}${fmtH(c.ueber)}</div>
          <div class="label">Zeitraum +/-</div>
        </div>
        ${c.start_overtime ? `<div class="summary-card ${c.ueber_gesamt >= 0 ? 'positive' : 'negative'}">
          <div class="value">${c.ueber_gesamt >= 0 ? '+' : ''}${fmtH(c.ueber_gesamt)}</div>
          <div class="label">Gesamt (inkl. Start)</div>
        </div>` : ''}
      </div>
      <div class="stats-charts">
        <div class="stats-chart-card">
          <h3>Ist / Soll / Überstunden</h3>
          <canvas id="pie-chart" width="300" height="300"></canvas>
        </div>
        <div class="stats-chart-card stats-chart-wide">
          <h3>Zeitverlauf</h3>
          <canvas id="time-chart" width="800" height="300"></canvas>
        </div>
      </div>
      ${stats.users.length > 1 ? `
      <div class="stats-user-details">
        <h3>Pro Mitarbeiter</h3>
        <table class="data-table">
          <tr><th>Name</th><th>Ist</th><th>Soll</th><th>+/-</th><th>Start-Ü.</th><th>Gesamt</th></tr>
          ${stats.users.map(u => `
            <tr>
              <td>${esc(u.user_name)}</td>
              <td>${fmtH(u.ist)}</td>
              <td>${fmtH(u.soll)}</td>
              <td class="${u.ueber >= 0 ? 'positive' : 'negative'}">${u.ueber >= 0 ? '+' : ''}${fmtH(u.ueber)}</td>
              <td>${u.start_overtime ? fmtH(u.start_overtime) : '-'}</td>
              <td class="${u.ueber_gesamt >= 0 ? 'positive' : 'negative'}">${u.ueber_gesamt >= 0 ? '+' : ''}${fmtH(u.ueber_gesamt)}</td>
            </tr>
          `).join('')}
        </table>
      </div>` : ''}
      <div id="stats-absences-block"></div>
    </div>`;

  // Diagramme zeichnen
  drawPieChart(document.getElementById('pie-chart'), c);
  drawTimeChart(document.getElementById('time-chart'), stats.combinedTimeline, stats.users.length > 1 ? null : stats.users);

  // Abwesenheitsblock nachladen (nur für Mitarbeiter oder Einzeluser-Ansicht)
  if (period !== 'total' && userIds.length === 1) {
    try {
      const uid_param = userIds[0] !== S.user.id ? `&user_id=${userIds[0]}` : '';
      const [sd, byDate] = await Promise.all([
        api('GET', `/api/absences/summary?from=${stats.range.from}&to=${stats.range.to}${uid_param}`),
        api('GET', `/api/absences/by-date?from=${stats.range.from}&to=${stats.range.to}${uid_param ? `&user_id=${userIds[0]}` : ''}`),
      ]);

      // Abwesenheitsbänder für Chart vorbereiten (nur approved/active)
      const absenceColors = {
        krank: '#dc2626', urlaub: '#1d4ed8', freizeitausgleich: '#7c3aed',
        sonderurlaub: '#9a3412', berufsschule: '#0369a1', innung: '#0f766e',
        dienstreise: '#374151', feiertag: '#b45309',
      };
      const chartAbsences = (byDate?.absences || [])
        .filter(a => a.status === 'active' || a.status === 'approved')
        .map(a => ({ type: a.type, from: a.date_from, to: a.date_to, color: absenceColors[a.type] || '#64748b' }));

      // Chart neu zeichnen mit Abwesenheitsbändern
      const canvas = document.getElementById('time-chart');
      const highlightFn = drawTimeChart(canvas, stats.combinedTimeline, stats.users.length > 1 ? null : stats.users, chartAbsences, null);
      window._statsChartHighlight = highlightFn;

      if (sd && Object.keys(sd.summary || {}).length > 0) {
        const typeLabels = { krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'FZA', sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag', berufsschule: 'Berufsschule', innung: 'Innung', dienstreise: 'Dienstreise' };
        const rows = Object.entries(sd.summary).map(([t, d]) =>
          `<tr class="abs-hover-row" data-abs-type="${t}" style="cursor:pointer">
            <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${absenceColors[t]||'#64748b'};margin-right:6px"></span>${typeLabels[t] || t}</td>
            <td>${d} ${d === 1 ? 'Tag' : 'Tage'}</td>
          </tr>`
        ).join('');
        const absBlock = document.getElementById('stats-absences-block');
        if (absBlock) {
          absBlock.innerHTML = `<div class="stats-user-details" style="margin-top:1rem">
            <h3>&#128197; Abwesenheiten im Zeitraum</h3>
            <table class="data-table">
              <tr><th>Typ</th><th>Arbeitstage</th></tr>
              ${rows}
            </table>
            ${sd.urlaubTageJahr > 0 ? `<p style="margin-top:0.5rem;font-size:0.9rem">Urlaubstage genommen (${new Date().getFullYear()}): <strong>${sd.urlaubTageJahr} Arbeitstage</strong></p>` : ''}
          </div>`;

          // Bidirektionales Hover: Tabellenzeile → Chart hervorheben
          absBlock.querySelectorAll('.abs-hover-row').forEach(row => {
            row.addEventListener('mouseenter', () => {
              if (window._statsChartHighlight) window._statsChartHighlight(row.dataset.absType);
            });
            row.addEventListener('mouseleave', () => {
              if (window._statsChartHighlight) window._statsChartHighlight(null);
            });
          });
        }
      }
    } catch(e) {}
  }

  // Events
  mainEl.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.statsPeriod = btn.dataset.period;
      if (S.statsPeriod === 'total') S.statsDate = new Date();
      renderStatisticsContent();
    });
  });

  if (showNav) {
    document.getElementById('stats-prev')?.addEventListener('click', () => {
      navStatsDate(-1);
      renderStatisticsContent();
    });
    document.getElementById('stats-next')?.addEventListener('click', () => {
      navStatsDate(1);
      renderStatisticsContent();
    });
    document.getElementById('stats-today')?.addEventListener('click', () => {
      S.statsDate = new Date();
      renderStatisticsContent();
    });
  }

  // Mitarbeiter-Chips
  mainEl.querySelectorAll('.stats-chips .emp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const uid = Number(chip.dataset.uid);
      if (S.statsSelectedUsers.has(uid)) {
        S.statsSelectedUsers.delete(uid);
        if (S.statsSelectedUsers.size === 0) { /* alle wieder sichtbar */ }
      } else {
        S.statsSelectedUsers.add(uid);
      }
      renderStatisticsContent();
    });
  });

}

// --- Canvas-Diagramme ---
function drawPieChart(canvas, data) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 30;

  ctx.clearRect(0, 0, w, h);

  const soll = Math.max(data.soll, 0.01);
  const ist = Math.max(data.ist, 0);
  const ueber = Math.max(data.ueber, 0);
  const unter = Math.max(-data.ueber, 0);

  let slices = [];
  if (data.ueber >= 0) {
    // Ist besteht aus Soll + Überstunden
    const sollAnteil = Math.max(ist - ueber, 0);
    slices = [
      { value: sollAnteil, color: '#3b82f6', label: `Soll: ${fmtH(sollAnteil)}` },
      { value: ueber, color: '#22c55e', label: `Über: +${fmtH(ueber)}` },
    ];
  } else {
    // Ist < Soll
    slices = [
      { value: ist, color: '#3b82f6', label: `Ist: ${fmtH(ist)}` },
      { value: unter, color: '#ef4444', label: `Unter: -${fmtH(unter)}` },
    ];
  }

  slices = slices.filter(s => s.value > 0);
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) {
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Keine Daten', cx, cy);
    return;
  }

  let startAngle = -Math.PI / 2;
  slices.forEach(sl => {
    const sliceAngle = (sl.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = sl.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    const midAngle = startAngle + sliceAngle / 2;
    const lx = cx + Math.cos(midAngle) * r * 0.65;
    const ly = cy + Math.sin(midAngle) * r * 0.65;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (sliceAngle > 0.3) ctx.fillText(sl.label, lx, ly);

    startAngle += sliceAngle;
  });

  // Legende unten
  let lx = 10;
  ctx.font = '12px system-ui';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  slices.forEach(sl => {
    ctx.fillStyle = sl.color;
    ctx.fillRect(lx, h - 16, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.fillText(sl.label, lx + 16, h - 4);
    lx += ctx.measureText(sl.label).width + 30;
  });
}

function drawTimeChart(canvas, timeline, users, absences = [], highlightType = null) {
  if (!canvas || !timeline || timeline.length === 0) return null;

  // Alte Event-Listener entfernen (AbortController)
  if (canvas._chartAC) canvas._chartAC.abort();
  const ac = new AbortController();
  canvas._chartAC = ac;
  const sig = ac.signal;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Canvas-Größe an Container anpassen
  const rect = canvas.parentElement.getBoundingClientRect();
  const displayW = rect.width - 20;
  const displayH = 280;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const cw = displayW - pad.left - pad.right;
  const ch = displayH - pad.top - pad.bottom;

  ctx.clearRect(0, 0, displayW, displayH);

  // Max-Wert
  let maxVal = 0;
  timeline.forEach(t => { maxVal = Math.max(maxVal, t.ist, t.soll); });
  maxVal = Math.ceil(maxVal * 1.15) || 10;

  const xStep = cw / Math.max(timeline.length - 1, 1);

  // Achsen
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;

  // Y-Achse Linien
  const ySteps = 5;
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxVal / ySteps) * i;
    const y = pad.top + ch - (val / maxVal) * ch;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + cw, y);
    ctx.stroke();
    ctx.fillText(fmtH(val), pad.left - 5, y);
  }

  // X-Achse Labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelEvery = timeline.length > 20 ? Math.ceil(timeline.length / 15) : 1;
  timeline.forEach((t, i) => {
    if (i % labelEvery !== 0 && i !== timeline.length - 1) return;
    const x = pad.left + i * xStep;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(t.label, x, pad.top + ch + 8);
  });

  // Abwesenheitsbänder im Hintergrund zeichnen
  if (absences.length > 0 && timeline.length > 1) {
    absences.forEach(ab => {
      const isHL = highlightType === ab.type;
      const isDimmed = highlightType !== null && !isHL;
      const alpha = isDimmed ? 0.05 : (isHL ? 0.35 : 0.15);

      // Finde die Timeline-Indizes die den Abwesenheitszeitraum überschneiden
      let startX = null, endX = null;
      timeline.forEach((t, i) => {
        const tFrom = t.from || t.label;
        const tTo   = t.to   || t.from || t.label;
        if (tTo >= ab.from && tFrom <= ab.to) {
          const x = pad.left + i * xStep;
          if (startX === null) startX = x - xStep / 2;
          endX = x + xStep / 2;
        }
      });
      if (startX !== null && endX !== null) {
        ctx.fillStyle = ab.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
        ctx.fillRect(Math.max(startX, pad.left), pad.top, Math.min(endX, pad.left + cw) - Math.max(startX, pad.left), ch);
        if (isHL) {
          ctx.strokeStyle = ab.color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(Math.max(startX, pad.left), pad.top, Math.min(endX, pad.left + cw) - Math.max(startX, pad.left), ch);
          ctx.setLineDash([]);
        }
      }
    });
  }

  // Soll-Linie (grün, gestrichelt)
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + ch - (t.soll / maxVal) * ch;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Ist-Linie (blau, durchgezogen)
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + ch - (t.ist / maxVal) * ch;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fläche unter Ist
  ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + ch);
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + ch - (t.ist / maxVal) * ch;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (timeline.length - 1) * xStep, pad.top + ch);
  ctx.closePath();
  ctx.fill();

  // Datenpunkte
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    // Soll-Punkt
    const ys = pad.top + ch - (t.soll / maxVal) * ch;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(x, ys, 3, 0, Math.PI * 2);
    ctx.fill();
    // Ist-Punkt
    const yi = pad.top + ch - (t.ist / maxVal) * ch;
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(x, yi, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legende
  const legY = 8;
  ctx.font = '12px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pad.left, legY); ctx.lineTo(pad.left + 25, legY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#334155';
  ctx.fillText('Soll', pad.left + 30, legY);

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(pad.left + 80, legY); ctx.lineTo(pad.left + 105, legY); ctx.stroke();
  ctx.fillStyle = '#334155';
  ctx.fillText('Ist', pad.left + 110, legY);

  // Tooltip
  let tooltip = canvas.parentElement.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(tooltip);
  }

  function findNearest(clientX) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    let closest = 0, minDist = Infinity;
    for (let i = 0; i < timeline.length; i++) {
      const x = pad.left + i * xStep;
      const d = Math.abs(mx - x);
      if (d < minDist) { minDist = d; closest = i; }
    }
    return closest;
  }

  // Abwesenheitstypen für ein Timeline-Datum ermitteln
  function getAbsencesAtIndex(idx) {
    const t = timeline[idx];
    if (!t || !absences.length) return [];
    const tFrom = t.from || t.label;
    const tTo   = t.to   || t.from || t.label;
    return absences.filter(ab => ab.to >= tFrom && ab.from <= tTo);
  }

  function showTooltip(clientX) {
    const idx = findNearest(clientX);
    const t = timeline[idx];
    const diff = t.ist - t.soll;
    const prefix = diff >= 0 ? '+' : '';
    const absHere = getAbsencesAtIndex(idx);
    const absHtml = absHere.map(ab => {
      const info = ABSENCE_TYPES[ab.type] || { label: ab.type, icon: '' };
      return `<br><span style="color:${ab.color}">${info.icon} ${info.label}</span>`;
    }).join('');
    tooltip.innerHTML = `<strong>${t.label}</strong><br>Ist: ${fmtH(t.ist)}<br>Soll: ${fmtH(t.soll)}<br>Diff: ${prefix}${fmtH(diff)}${absHtml}`;
    tooltip.style.display = 'block';

    const rect = canvas.getBoundingClientRect();
    const x = pad.left + idx * xStep;
    const tooltipW = tooltip.offsetWidth;
    let left = x - tooltipW / 2;
    if (left < 0) left = 0;
    if (left + tooltipW > rect.width) left = rect.width - tooltipW;
    tooltip.style.left = left + 'px';
    tooltip.style.top = '30px';
  }

  canvas.addEventListener('mousemove', e => showTooltip(e.clientX), { signal: sig });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; }, { signal: sig });
  canvas.addEventListener('touchstart', e => { showTooltip(e.touches[0].clientX); }, { passive: true, signal: sig });
  canvas.addEventListener('touchmove', e => { showTooltip(e.touches[0].clientX); }, { passive: true, signal: sig });
  canvas.addEventListener('touchend', () => { setTimeout(() => { tooltip.style.display = 'none'; }, 2000); }, { signal: sig });

  // Gibt eine Highlight-Funktion zurück (Typ hervorheben, null = Reset)
  return (type) => {
    drawTimeChart(canvas, timeline, users, absences, type);
  };
}

// --- Bestellungen ---
async function renderOrders() {
  $app().innerHTML = layout('<div class="loading">Laden…</div>', 'orders');
  bindLayout();

  const manage = isChefOrAdmin() || S.user.role === 'buchhalter';
  let orders = [];
  try {
    const [oData, pData] = await Promise.all([
      api('GET', '/api/orders'),
      api('GET', '/api/projects')
    ]);
    if (!oData) return;
    orders = oData.orders;
    if (pData) S.projects = pData.projects;
  } catch (e) { toast(e.message, 'error'); return; }

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="card" style="max-width:900px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2>Bestellungen</h2>
        <button class="btn btn-primary" id="order-add-btn">+ Hinzuf&uuml;gen</button>
      </div>
      <div id="order-form-area"></div>
      <div id="order-list">${renderOrderList(orders, manage)}</div>
      <div style="margin-top:2rem">
        <button class="btn btn-outline" id="toggle-ordered" style="width:100%">Letzte Bestellungen anzeigen</button>
        <div id="ordered-list" style="display:none;margin-top:1rem"></div>
      </div>
    </div>
  `;

  document.getElementById('order-add-btn').addEventListener('click', () => {
    showOrderForm(null, orders, manage);
  });

  const toggleBtn = document.getElementById('toggle-ordered');
  let orderedLoaded = false;
  toggleBtn.addEventListener('click', async () => {
    const area = document.getElementById('ordered-list');
    if (area.style.display !== 'none') {
      area.style.display = 'none';
      toggleBtn.textContent = 'Letzte Bestellungen anzeigen';
      return;
    }
    if (!orderedLoaded) {
      area.innerHTML = '<div class="loading">Laden…</div>';
      try {
        const data = await api('GET', '/api/orders/ordered');
        if (!data) return;
        area.innerHTML = renderOrderedList(data.orders);
        bindOrderedEvents(data.orders);
        orderedLoaded = true;
      } catch (e) { toast(e.message, 'error'); return; }
    }
    area.style.display = 'block';
    toggleBtn.textContent = 'Letzte Bestellungen ausblenden';
  });

  bindOrderEvents(orders, manage);
}

function fmtOrderQty(o) {
  if (!o.quantity) return '';
  if (o.unit) return `<strong>${esc(String(o.quantity))} ${esc(o.unit)}</strong> `;
  return `<strong>${esc(String(o.quantity))}x</strong> `;
}

function fmtOrderLocation(o) {
  if (!o.location_text || o.location_text === 'Lager') return '';
  return ` <span class="order-location">&rarr; ${esc(o.location_text)}</span>`;
}

function renderOrderList(orders, manage) {
  if (!orders.length) return '<p style="color:#94a3b8;text-align:center">Keine offenen Bestellungen</p>';
  return orders.map(o => {
    const isOwn = o.user_id === S.user.id;
    const canEdit = isOwn || manage;
    const created = o.created_at ? formatDateTimeDE(o.created_at) : '';
    return `<div class="order-item" data-id="${o.id}">
      <div class="order-content">
        <div class="order-product">${fmtOrderQty(o)}${esc(o.product)}${fmtOrderLocation(o)}</div>
        ${o.comment ? `<div class="order-comment">${esc(o.comment)}</div>` : ''}
        <div class="order-meta">von ${esc(o.user_name)} am ${created}</div>
      </div>
      <div class="order-actions">
        ${canEdit ? `<button class="btn btn-sm order-edit-btn" data-id="${o.id}" title="Bearbeiten">&#9998;</button>` : ''}
        ${canEdit ? `<button class="btn btn-sm btn-danger order-del-btn" data-id="${o.id}" title="L&ouml;schen">&times;</button>` : ''}
        ${manage ? `<button class="btn btn-sm btn-primary order-mark-btn" data-id="${o.id}">Bestellt</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderOrderedList(orders) {
  if (!orders.length) return '<p style="color:#94a3b8;text-align:center">Keine Bestellungen im letzten Monat</p>';
  const isAdmin = S.user.role === 'admin';
  return orders.map(o => {
    const orderedDate = o.ordered_at ? formatDateTimeDE(o.ordered_at) : '';
    return `<div class="order-item order-done" data-id="${o.id}">
      <div class="order-content">
        <div class="order-product">${fmtOrderQty(o)}${esc(o.product)}${fmtOrderLocation(o)}</div>
        ${o.comment ? `<div class="order-comment">${esc(o.comment)}</div>` : ''}
        <div class="order-meta">bestellt am ${orderedDate}${o.ordered_by_name ? ' von ' + esc(o.ordered_by_name) : ''}</div>
      </div>
      ${isAdmin ? `<div class="order-actions"><button class="btn btn-sm btn-danger ordered-del-btn" data-id="${o.id}">&times;</button></div>` : ''}
    </div>`;
  }).join('');
}


function showOrderForm(editOrder, orders, manage) {
  const area = document.getElementById('order-form-area');
  const qty = editOrder && editOrder.quantity ? editOrder.quantity : '';
  const unit = editOrder ? (editOrder.unit || '') : '';
  const product = editOrder ? editOrder.product : '';
  const comment = editOrder ? (editOrder.comment || '') : '';
  const projId = editOrder ? (editOrder.project_id || '') : '';
  const projectOptions = (S.projects || []).map(p =>
    `<option value="${p.id}" ${p.id === projId ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
  area.innerHTML = `
    <form id="order-form" class="order-form" style="margin-bottom:1rem">
      <div class="form-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Produkt *</label>
          <input type="text" id="of-product" class="form-control" value="${esc(product)}" required>
        </div>
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Kommentar</label>
          <input type="text" id="of-comment" class="form-control" value="${esc(comment)}">
        </div>
      </div>
      <div class="form-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-top:0.25rem">
        <div class="form-group" style="width:70px">
          <label>Anzahl</label>
          <input type="number" id="of-qty" class="form-control" value="${qty}" min="0" placeholder="-">
        </div>
        <div class="form-group" style="width:100px">
          <label>Einheit</label>
          <input type="text" id="of-unit" class="form-control" value="${esc(unit)}" placeholder="Stk, Bund…">
        </div>
        <div class="form-group" style="flex:1;min-width:140px">
          <label>Verwendungsort</label>
          <select id="of-location" class="form-control">
            <option value="" ${!projId ? 'selected' : ''}>Lager</option>
            ${projectOptions}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
        <button type="submit" class="btn btn-primary">${editOrder ? 'Speichern' : 'Hinzuf\u00fcgen'}</button>
        <button type="button" class="btn btn-outline" id="of-cancel">Abbrechen</button>
      </div>
    </form>
  `;

  document.getElementById('of-product').focus();
  document.getElementById('of-cancel').addEventListener('click', () => { area.innerHTML = ''; });

  document.getElementById('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const qtyVal = document.getElementById('of-qty').value.trim();
    const qtyNum = qtyVal ? parseInt(qtyVal, 10) : 0;
    const locVal = document.getElementById('of-location').value;
    const body = {
      quantity: qtyNum > 0 ? qtyNum : null,
      unit: document.getElementById('of-unit').value.trim(),
      product: document.getElementById('of-product').value.trim(),
      comment: document.getElementById('of-comment').value.trim(),
      project_id: locVal ? Number(locVal) : null
    };
    try {
      if (editOrder) {
        await api('PUT', '/api/orders/' + editOrder.id, body);
        toast('Aktualisiert', 'success');
      } else {
        await api('POST', '/api/orders', body);
        toast('Hinzugef\u00fcgt', 'success');
      }
      renderOrders();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindOrderEvents(orders, manage) {
  // Bearbeiten
  document.querySelectorAll('.order-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const o = orders.find(x => x.id === Number(btn.dataset.id));
      if (o) showOrderForm(o, orders, manage);
    });
  });
  // Löschen
  document.querySelectorAll('.order-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Eintrag l\u00f6schen?')) return;
      try {
        await api('DELETE', '/api/orders/' + btn.dataset.id);
        toast('Gel\u00f6scht', 'success');
        renderOrders();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  // Bestellt markieren
  document.querySelectorAll('.order-mark-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/orders/' + btn.dataset.id + '/order');
        await loadBadges();
        toast('Als bestellt markiert', 'success');
        renderOrders();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function bindOrderedEvents(orders) {
  document.querySelectorAll('.ordered-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Eintrag endg\u00fcltig l\u00f6schen?')) return;
      try {
        await api('DELETE', '/api/orders/' + btn.dataset.id);
        toast('Gel\u00f6scht', 'success');
        btn.closest('.order-item').remove();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// --- Notizen ---
let _notizen = [];
let _notizenFilter = { projectId: '', search: '' };
let _expandedNoteId = null;
let _editingNoteLockId = null;

async function renderNotizen() {
  S.badges.notes = 0;
  refreshBadges();
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'notes');
  bindLayout();

  let notes = [], offers = [];
  try {
    const [nData, pData, oData] = await Promise.all([
      api('GET', '/api/notes'),
      api('GET', '/api/projects'),
      api('GET', '/api/notes/offers')
    ]);
    markSeen('notes');
    if (!nData) return;
    notes = nData.notes || [];
    if (pData) S.projects = pData.projects;
    offers = (oData && oData.offers) || [];
  } catch (e) { toast(e.message, 'error'); return; }

  _notizen = notes;
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  // Eingehende Angebote
  let offersHtml = '';
  if (offers.length) {
    offersHtml = `<div class="note-offers-section">
      <h3>Eingehende Notizen</h3>
      ${offers.map(o => `
        <div class="note-offer-item" data-offer-id="${o.id}">
          <div>
            <strong>${esc(o.title)}</strong>
            <span class="note-meta">von ${esc(o.from_user_name)}</span>
          </div>
          <div class="note-actions">
            <button class="btn btn-sm btn-primary offer-accept-btn" data-id="${o.id}">Annehmen</button>
            <button class="btn btn-sm btn-outline offer-decline-btn" data-id="${o.id}">Ablehnen</button>
          </div>
        </div>
      `).join('')}
    </div>`;
  }

  // Projekte für Filter
  const projOpts = (S.projects || []).map(p =>
    `<option value="${p.id}" ${_notizenFilter.projectId == p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  mainEl.innerHTML = `
    <div class="card" style="max-width:900px;margin:0 auto">
      <h2 style="margin-bottom:1rem">Notizen</h2>
      ${offersHtml}
      <div class="note-filters">
        <select id="note-filter-project" class="form-control">
          <option value="">Alle Projekte</option>
          <option value="none" ${_notizenFilter.projectId === 'none' ? 'selected' : ''}>Kein Projekt</option>
          ${projOpts}
        </select>
        <input type="text" id="note-filter-search" class="form-control" placeholder="Suche..." value="${esc(_notizenFilter.search)}">
      </div>
      <div id="note-form-area"></div>
      <div id="note-list">${renderNoteList(notes)}</div>
    </div>
  `;

  // Filter-Events
  document.getElementById('note-filter-project').addEventListener('change', (e) => {
    _notizenFilter.projectId = e.target.value;
    document.getElementById('note-list').innerHTML = renderNoteList(filterNotizen());
    bindNoteEvents();
  });
  document.getElementById('note-filter-search').addEventListener('input', (e) => {
    _notizenFilter.search = e.target.value;
    document.getElementById('note-list').innerHTML = renderNoteList(filterNotizen());
    bindNoteEvents();
  });

  // Offer-Events
  document.querySelectorAll('.offer-accept-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/notes/offers/' + btn.dataset.id + '/accept');
        toast('Notiz angenommen', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll('.offer-decline-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/notes/offers/' + btn.dataset.id + '/decline');
        toast('Abgelehnt', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  bindNoteEvents();
}

function filterNotizen() {
  let list = _notizen;
  const pf = _notizenFilter.projectId;
  if (pf === 'none') {
    list = list.filter(n => !n.project_id && !n.project_text);
  } else if (pf) {
    list = list.filter(n => n.project_id == pf);
  }
  const sf = _notizenFilter.search.toLowerCase().trim();
  if (sf) {
    list = list.filter(n =>
      (n.title || '').toLowerCase().includes(sf) ||
      (n.body || '').toLowerCase().includes(sf) ||
      (n.project_text || '').toLowerCase().includes(sf)
    );
  }
  return list;
}

function renderNoteList(notes) {
  if (!notes.length) return '<p style="color:#94a3b8;margin-top:1rem">Keine Notizen</p>';
  const uid = S.user.id;
  return notes.map(n => {
    const isOwner = n.user_id === uid;
    const canWrite = isOwner || n.access_level === 'write';
    const projDisplay = n.project_text ? `<div class="note-project">${esc(n.project_text)}</div>` : '';
    const preview = (n.body || '').length > 120 ? esc(n.body.substring(0, 120)) + '...' : esc(n.body || '');
    const ownerInfo = !isOwner ? `<span>von ${esc(n.owner_name)}</span>` : '';
    const sharesInfo = (n.shares && n.shares.length)
      ? `<span>Geteilt mit: ${n.shares.map(s => esc(s.user_name)).join(', ')}</span>` : '';
    const accessBadge = !isOwner ? `<span class="badge badge-${n.access_level === 'write' ? 'chef' : 'mitarbeiter'}">${n.access_level === 'write' ? 'Schreibzugriff' : 'Lesezugriff'}</span>` : '';
    const isExpanded = _expandedNoteId === n.id;
    const lockBadge = (n.editing_by && n.editing_by !== uid)
      ? `<span class="badge badge-lock">&#128274; ${esc(n.editing_by_name || '')}</span>` : '';

    return `<div class="note-card${n.is_unread ? ' note-card--unread' : ''}${isExpanded ? ' note-card-expanded' : ''}" data-id="${n.id}">
      <div class="note-card-row">
        <div class="note-content" style="flex:1;min-width:0">
          <div class="note-title">${esc(n.title)} ${accessBadge} ${lockBadge}</div>
          ${projDisplay}
          ${isExpanded
            ? `<div class="note-body-full">${esc(n.body || '')}</div>`
            : `<div class="note-preview">${preview}</div>`}
          <div class="note-meta">
            ${ownerInfo}
            ${sharesInfo}
            <span>${formatDateTimeDE(n.updated_at)}</span>
          </div>
        </div>
        <div class="note-actions">
          ${canWrite ? `<button class="btn btn-sm note-edit-btn" data-id="${n.id}" title="Bearbeiten">&#9998;</button>` : ''}
          ${isOwner ? `<button class="btn btn-sm note-share-btn" data-id="${n.id}" title="Freigabe">&#128101;</button>` : ''}
          ${isOwner ? `<button class="btn btn-sm note-offer-btn" data-id="${n.id}" title="Weitergeben">&#10145;</button>` : ''}
          ${isOwner ? `<button class="btn btn-sm btn-danger note-del-btn" data-id="${n.id}" title="L\u00f6schen">&times;</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function bindNoteEvents() {
  // Expand/Collapse auf Kachel-Klick
  document.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.note-actions')) return;
      const noteId = Number(card.dataset.id);
      _expandedNoteId = (_expandedNoteId === noteId) ? null : noteId;
      const listEl = document.getElementById('note-list');
      if (listEl) {
        listEl.innerHTML = renderNoteList(filterNotizen());
        bindNoteEvents();
      }
    });
  });
  document.querySelectorAll('.note-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = _notizen.find(x => x.id === Number(btn.dataset.id));
      if (n) acquireLockAndEdit(n);
    });
  });
  document.querySelectorAll('.note-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Notiz wirklich l\u00f6schen?')) return;
      try {
        await api('DELETE', '/api/notes/' + btn.dataset.id);
        toast('Gel\u00f6scht', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll('.note-share-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = _notizen.find(x => x.id === Number(btn.dataset.id));
      if (n) showShareDialog(n);
    });
  });
  document.querySelectorAll('.note-offer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = _notizen.find(x => x.id === Number(btn.dataset.id));
      if (n) showOfferDialog(n);
    });
  });
}

async function acquireLockAndEdit(note) {
  const isShared = note.shares && note.shares.length > 0;
  if (isShared) {
    try {
      await api('POST', '/api/notes/' + note.id + '/lock');
      _editingNoteLockId = note.id;
    } catch (err) {
      toast(err.message || 'Notiz ist gerade in Bearbeitung', 'error');
      return;
    }
  }
  showNoteForm(note);
}

function showNoteForm(editNote) {
  const area = document.getElementById('note-form-area');
  if (!area) return;

  const projId = editNote ? editNote.project_id : null;
  const projText = editNote ? (editNote.project_text || '') : '';
  const hasProject = !!projId;

  const projOpts = (S.projects || []).map(p =>
    `<option value="${p.id}" ${p.id === projId ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  area.innerHTML = `
    <form id="note-form" class="note-form" style="margin-bottom:1rem;padding:1rem;border:1px solid var(--border);border-radius:8px;background:#f8fafc">
      <div class="form-group">
        <label>Titel *</label>
        <input type="text" id="nf-title" class="form-control" value="${editNote ? esc(editNote.title) : ''}" required>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Projekt</label>
          <select id="nf-project" class="form-control">
            <option value="">-- Kein Projekt --</option>
            ${projOpts}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Projekt (Freitext)</label>
          <input type="text" id="nf-project-text" class="form-control" value="${!hasProject ? esc(projText) : ''}" placeholder="z.B. Baustelle XY" ${hasProject ? 'disabled' : ''}>
        </div>
      </div>
      <div class="form-group">
        <label>Notiz</label>
        <textarea id="nf-body" class="form-control note-body-textarea" rows="8">${editNote ? esc(editNote.body || '') : ''}</textarea>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
        <button type="submit" class="btn btn-primary">${editNote ? 'Speichern' : 'Erstellen'}</button>
        <button type="button" class="btn btn-outline" id="nf-cancel">Abbrechen</button>
      </div>
    </form>
  `;

  // Projekt-Dropdown / Freitext gegenseitig ausschließen
  const projSelect = document.getElementById('nf-project');
  const projTextInput = document.getElementById('nf-project-text');
  projSelect.addEventListener('change', () => {
    if (projSelect.value) {
      projTextInput.value = '';
      projTextInput.disabled = true;
    } else {
      projTextInput.disabled = false;
    }
  });
  projTextInput.addEventListener('input', () => {
    if (projTextInput.value.trim()) {
      projSelect.value = '';
    }
  });

  document.getElementById('nf-cancel').addEventListener('click', async () => {
    if (_editingNoteLockId) {
      try { await api('POST', '/api/notes/' + _editingNoteLockId + '/unlock'); } catch(e) {}
      _editingNoteLockId = null;
    }
    renderNotizen();
  });
  document.getElementById('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: document.getElementById('nf-title').value.trim(),
      body: document.getElementById('nf-body').value,
      project_id: projSelect.value ? Number(projSelect.value) : null,
      project_text: projSelect.value ? '' : projTextInput.value.trim()
    };
    try {
      if (editNote) {
        await api('PUT', '/api/notes/' + editNote.id, body);
        _editingNoteLockId = null;
        toast('Gespeichert', 'success');
      } else {
        await api('POST', '/api/notes', body);
        toast('Erstellt', 'success');
      }
      renderNotizen();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('nf-title').focus();
}

async function showShareDialog(note) {
  let users = [], shares = [];
  try {
    const [uData, sData] = await Promise.all([
      api('GET', '/api/users/list'),
      api('GET', '/api/notes/' + note.id + '/shares')
    ]);
    users = (uData && uData.users) || [];
    shares = (sData && sData.shares) || [];
  } catch (e) { toast(e.message, 'error'); return; }

  // Owner aus Liste entfernen
  users = users.filter(u => u.id !== note.user_id);
  if (!users.length) { toast('Keine anderen Benutzer vorhanden', 'info'); return; }

  const shareMap = {};
  for (const s of shares) shareMap[s.user_id] = s.permission;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div class="modal-header">
        <h3>Freigabe: ${esc(note.title)}</h3>
      </div>
      <div class="modal-body">
        <table class="share-matrix">
          <thead><tr><th>Benutzer</th><th style="text-align:center">Lesen</th><th style="text-align:center">Schreiben</th></tr></thead>
          <tbody>
            ${users.map(u => {
              const perm = shareMap[u.id] || '';
              return `<tr data-uid="${u.id}">
                <td>${esc(u.name)}</td>
                <td style="text-align:center"><input type="checkbox" class="share-read" data-uid="${u.id}" ${perm === 'read' || perm === 'write' ? 'checked' : ''}></td>
                <td style="text-align:center"><input type="checkbox" class="share-write" data-uid="${u.id}" ${perm === 'write' ? 'checked' : ''}></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" id="share-cancel">Abbrechen</button>
        <button class="btn btn-primary" id="share-save">Speichern</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Write angehakt → Read automatisch mit
  overlay.querySelectorAll('.share-write').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        overlay.querySelector(`.share-read[data-uid="${cb.dataset.uid}"]`).checked = true;
      }
    });
  });
  // Read abgehakt → Write automatisch aus
  overlay.querySelectorAll('.share-read').forEach(cb => {
    cb.addEventListener('change', () => {
      if (!cb.checked) {
        overlay.querySelector(`.share-write[data-uid="${cb.dataset.uid}"]`).checked = false;
      }
    });
  });

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#share-cancel').addEventListener('click', close);
  overlay.querySelector('#share-save').addEventListener('click', async () => {
    const newShares = [];
    overlay.querySelectorAll('.share-read').forEach(cb => {
      if (cb.checked) {
        const uid = Number(cb.dataset.uid);
        const isWrite = overlay.querySelector(`.share-write[data-uid="${uid}"]`).checked;
        newShares.push({ user_id: uid, permission: isWrite ? 'write' : 'read' });
      }
    });
    try {
      await api('PUT', '/api/notes/' + note.id + '/shares', { shares: newShares });
      toast('Freigaben gespeichert', 'success');
      close();
      renderNotizen();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function showOfferDialog(note) {
  let users = [];
  try {
    const uData = await api('GET', '/api/users/list');
    users = (uData && uData.users) || [];
  } catch (e) { toast(e.message, 'error'); return; }

  users = users.filter(u => u.id !== note.user_id);
  if (!users.length) { toast('Keine anderen Benutzer vorhanden', 'info'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <h3>Notiz weitergeben</h3>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:0.75rem;color:#64748b;font-size:0.85rem">W\u00e4hle Empf\u00e4nger f\u00fcr eine Kopie von "${esc(note.title)}":</p>
        ${users.map(u => `
          <label style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;cursor:pointer">
            <input type="checkbox" class="offer-user-cb" value="${u.id}">
            <span>${esc(u.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" id="offer-cancel">Abbrechen</button>
        <button class="btn btn-primary" id="offer-send">Senden</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#offer-cancel').addEventListener('click', close);
  overlay.querySelector('#offer-send').addEventListener('click', async () => {
    const userIds = [];
    overlay.querySelectorAll('.offer-user-cb:checked').forEach(cb => userIds.push(Number(cb.value)));
    if (!userIds.length) { toast('Bitte mindestens einen Empf\u00e4nger w\u00e4hlen', 'error'); return; }
    try {
      await api('POST', '/api/notes/' + note.id + '/offer', { user_ids: userIds });
      toast('Notiz angeboten', 'success');
      close();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Abwesenheit ---

const ABSENCE_TYPES = {
  krank:             { label: 'Krank',              icon: '🏥', workflow: 'notify' },
  urlaub:            { label: 'Urlaub',             icon: '🌴', workflow: 'approve' },
  freizeitausgleich: { label: 'Freizeitausgleich',  icon: '⏱️', workflow: 'approve' },
  sonderurlaub:      { label: 'Sonderurlaub',       icon: '🎁', workflow: 'approve' },
  berufsschule:      { label: 'Berufsschule',       icon: '🏫', workflow: 'notify' },
  innung:            { label: 'Innung',             icon: '🔧', workflow: 'notify' },
  dienstreise:       { label: 'Dienstreise',        icon: '🚗', workflow: 'none' },
  feiertag:          { label: 'Feiertag',           icon: '🎉', workflow: 'none' },
};

function absenceStatusClass(status) {
  if (status === 'pending')  return 'absence-card--pending';
  if (status === 'rejected') return 'absence-card--rejected';
  return 'absence-card--active';
}

function absenceStatusLabel(status) {
  if (status === 'pending')  return '<span class="absence-status absence-status--pending">Offen</span>';
  if (status === 'rejected') return '<span class="absence-status absence-status--rejected">Abgelehnt</span>';
  if (status === 'approved') return '<span class="absence-status absence-status--approved">Genehmigt</span>';
  return '<span class="absence-status absence-status--active">Aktiv</span>';
}

function formatDateRange(from, to) {
  if (from === to) return formatDateDE(from);
  return formatDateDE(from) + ' – ' + formatDateDE(to);
}

function getAbsencesForDay(userId, date, absences) {
  return (absences || []).filter(a => {
    if (a.date_from > date || a.date_to < date) return false;
    if (a.user_id === null) return true;
    return a.user_id === userId;
  });
}

function isManagerRole() {
  return S.user && (S.user.role === 'admin' || S.user.role === 'chef' || S.user.role === 'buchhalter');
}

function renderAbsenceCard(a, opts = {}) {
  const type = ABSENCE_TYPES[a.type] || { label: a.type, icon: '📋' };
  const canEdit = isManagerRole() || a.user_id === S.user?.id;
  // Manager-Approve nur wenn NICHT Manager-für-MA-pending (das ist der MA-Akzeptanzflow)
  const isManagerEntry = a.created_by && a.created_by !== a.user_id;
  const canApprove = isManagerRole() && a.status === 'pending' && !isManagerEntry;
  const canAcknowledge = isManagerRole() && a.status === 'active' && ['krank','berufsschule','innung'].includes(a.type) && !a.notified_at;
  // MA-Akzeptanz/Ablehnung: nur wenn eigener Eintrag vom Manager, noch pending
  const canMaAccept = !isManagerRole() && a.user_id === S.user?.id && isManagerEntry && a.status === 'pending';
  const extraClass = '';

  return `<div class="absence-card ${absenceStatusClass(a.status)}${extraClass}" data-id="${a.id}">
    <div class="absence-card-header">
      <span class="absence-type-icon">${type.icon}</span>
      <strong>${esc(type.label)}</strong>
      ${isManagerRole() && a.user_name ? `<span class="absence-user">${esc(a.user_name)}</span>` : ''}
      ${absenceStatusLabel(a.status)}
    </div>
    <div class="absence-card-dates">${formatDateRange(a.date_from, a.date_to)}</div>
    ${a.comment ? `<div class="absence-card-comment">${esc(a.comment)}</div>` : ''}
    ${isManagerEntry && a.created_by_name ? `<div class="absence-created-by">Eingetragen von: ${esc(a.created_by_name)}</div>` : ''}
    ${a.processed_by_name ? `<div class="absence-card-meta">Bearbeitet von ${esc(a.processed_by_name)}</div>` : ''}
    <div class="absence-card-timestamps">
      Erstellt: ${formatDateTimeDE(a.created_at)}${a.updated_at && a.updated_at !== a.created_at ? ` &nbsp;·&nbsp; Bearbeitet: ${formatDateTimeDE(a.updated_at)}` : ''}
    </div>
    <div class="absence-card-actions">
      ${canApprove ? `<button class="btn btn-sm btn-primary absence-approve" data-id="${a.id}">Genehmigen</button>
                      <button class="btn btn-sm btn-danger absence-reject" data-id="${a.id}">Ablehnen</button>` : ''}
      ${canMaAccept ? `<button class="btn btn-sm btn-primary absence-accept" data-id="${a.id}">Akzeptieren</button>
                       <button class="btn btn-sm btn-danger absence-reject-ma" data-id="${a.id}">Ablehnen</button>` : ''}
      ${canAcknowledge ? `<button class="btn btn-sm btn-primary absence-acknowledge" data-id="${a.id}">Quittieren</button>` : ''}
      ${canEdit ? `<button class="btn btn-sm btn-outline absence-edit" data-id="${a.id}" data-type="${a.type}" data-from="${a.date_from}" data-to="${a.date_to}" data-comment="${esc(a.comment||'')}">Bearbeiten</button>` : ''}
      ${(isManagerRole() || a.user_id === S.user?.id) ? `<button class="btn btn-sm btn-danger absence-delete" data-id="${a.id}">Löschen</button>` : ''}
    </div>
  </div>`;
}

function bindAbsenceCardActions(container) {
  container.querySelectorAll('.absence-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/approve'); broadcastAbsenceChange(); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-reject').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/reject'); broadcastAbsenceChange(); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-accept').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/accept', {}); broadcastAbsenceChange(); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-reject-ma').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/reject-ma', {}); broadcastAbsenceChange(); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-acknowledge').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/acknowledge'); broadcastAbsenceChange(); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Abwesenheit wirklich löschen?')) return;
      try { await api('DELETE', '/api/absences/' + btn.dataset.id); broadcastAbsenceChange(); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      showAbsenceForm(btn.dataset.id, btn.dataset.type, btn.dataset.from, btn.dataset.to, btn.dataset.comment);
    });
  });
}

function showAbsenceForm(editId, preType, preFrom, preTo, preComment) {
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const role = S.user?.role;
  const managerOnly = ['feiertag'];
  const availableTypes = Object.entries(ABSENCE_TYPES).filter(([t]) => {
    if (managerOnly.includes(t)) return isManagerRole();
    return true;
  });

  const typeOpts = availableTypes.map(([t, info]) =>
    `<option value="${t}" ${preType === t ? 'selected' : ''}>${info.icon} ${info.label}</option>`
  ).join('');

  // Mitarbeiterauswahl für Manager
  let userSelectHtml = '';
  if (isManagerRole() && !editId) {
    const workers = getWorkerUsers().filter(u => u.id !== S.user.id);
    userSelectHtml = `
      <div class="form-group">
        <label>Für</label>
        <select id="abs-user" class="form-control">
          <option value="${S.user.id}">Für mich selbst</option>
          ${workers.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
        </select>
      </div>`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const formHtml = `
    <div class="absence-form-overlay" id="absence-form-overlay">
      <div class="absence-form-card">
        <h3>${editId ? 'Abwesenheit bearbeiten' : 'Abwesenheit eintragen'}</h3>
        ${userSelectHtml}
        <div class="form-group">
          <label>Typ</label>
          <select id="abs-type" class="form-control" ${editId ? 'disabled' : ''}>
            ${typeOpts || `<option value="${preType}">${preType}</option>`}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Von</label>
            <input type="date" id="abs-from" class="form-control" value="${preFrom || today}">
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="date" id="abs-to" class="form-control" value="${preTo || today}">
          </div>
        </div>
        <div class="form-group">
          <label>Kommentar (optional)</label>
          <textarea id="abs-comment" class="form-control" rows="2">${preComment || ''}</textarea>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" id="abs-save">${editId ? 'Speichern' : 'Eintragen'}</button>
          <button class="btn btn-outline" id="abs-cancel">Abbrechen</button>
        </div>
      </div>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.innerHTML = formHtml;
  document.body.appendChild(overlay.firstElementChild);

  document.getElementById('abs-cancel').addEventListener('click', () => {
    document.getElementById('absence-form-overlay')?.remove();
  });

  document.getElementById('abs-save').addEventListener('click', async () => {
    const type = editId ? preType : document.getElementById('abs-type').value;
    const date_from = document.getElementById('abs-from').value;
    const date_to   = document.getElementById('abs-to').value;
    const comment   = document.getElementById('abs-comment').value;
    const target_user_id = document.getElementById('abs-user')?.value
      ? Number(document.getElementById('abs-user').value)
      : S.user.id;

    if (!date_from || !date_to) { toast('Datum erforderlich', 'error'); return; }
    if (date_from > date_to) { toast('Datum von muss vor bis liegen', 'error'); return; }

    try {
      // Überlappungsprüfung für den gewählten User
      const existingParams = `from=${date_from}&to=${date_to}` + (target_user_id !== S.user.id ? `&user_id=${target_user_id}` : '');
      const existing = await api('GET', `/api/absences?${existingParams}`);
      const overlaps = (existing?.absences || []).filter(a => String(a.id) !== String(editId) && a.user_id === target_user_id);
      if (overlaps.length > 0) {
        const proceed = confirm(`Für diesen Zeitraum existiert bereits eine Abwesenheit (${ABSENCE_TYPES[overlaps[0].type]?.label || overlaps[0].type}).\nTrotzdem speichern?`);
        if (!proceed) return;
      }

      if (editId) {
        await api('PUT', '/api/absences/' + editId, { date_from, date_to, comment });
      } else {
        await api('POST', '/api/absences', { type, date_from, date_to, comment, target_user_id });
      }
      document.getElementById('absence-form-overlay')?.remove();
      toast(editId ? 'Abwesenheit aktualisiert' : 'Abwesenheit eingetragen', 'success');
      broadcastAbsenceChange();
      renderAbsences();
    } catch(e) { toast(e.message, 'error'); }
  });
}

async function renderAbsences() {
  const topicToMark = isManagerRole() ? 'absences' : 'absence_status';
  S.badges.absences = 0;
  refreshBadges();
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'absences');
  bindLayout();

  let absences = [];
  try {
    const data = await api('GET', '/api/absences');
    markSeen(topicToMark);
    if (data) absences = data.absences;
  } catch(e) {}

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  // Urlaubs-Zähler: genehmigte/offene Urlaubstage dieses Jahr
  const thisYear = new Date().getFullYear().toString();
  const urlaubTage = absences.filter(a =>
    a.type === 'urlaub' && (a.status === 'approved' || a.status === 'pending') &&
    a.date_from.startsWith(thisYear) && (!isManagerRole() || a.user_id === S.user?.id)
  ).reduce((sum, a) => {
    const from = new Date(a.date_from + 'T12:00:00');
    const to   = new Date(a.date_to   + 'T12:00:00');
    let days = 0;
    const cur = new Date(from);
    while (cur <= to) { const d = cur.getDay(); if (d > 0 && d < 6) days++; cur.setDate(cur.getDate()+1); }
    return sum + days;
  }, 0);

  // Posteingang für Manager
  let inboxHtml = '';
  if (isManagerRole()) {
    const pending = absences.filter(a =>
      a.status === 'pending' ||
      (a.status === 'active' && ['krank','berufsschule','innung'].includes(a.type) && !a.notified_at)
    );
    if (pending.length > 0) {
      inboxHtml = `<div class="absence-inbox">
        <h3>📬 Posteingang (${pending.length})</h3>
        ${pending.map(a => renderAbsenceCard(a)).join('')}
      </div>`;
    }
  }

  // Cutoff: alles was vor mehr als einem Monat zuletzt bearbeitet wurde → Verlauf
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 1);
  const cutoff = cutoffDate.toISOString().substring(0, 10);

  // Alle Abwesenheiten, gruppiert nach Typ, dann nach aktuell/alt
  const grouped = {};
  for (const a of absences) {
    if (!grouped[a.type]) grouped[a.type] = { recent: [], history: {} };
    const updDate = (a.updated_at || a.created_at || '').substring(0, 10);
    if (updDate >= cutoff) {
      grouped[a.type].recent.push(a);
    } else {
      // Gruppierung im Verlauf nach Monat/Jahr von date_from
      const mk = a.date_from.substring(0, 7); // "2026-03"
      if (!grouped[a.type].history[mk]) grouped[a.type].history[mk] = [];
      grouped[a.type].history[mk].push(a);
    }
  }

  const monthNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  function monthLabel(ym) {
    const [y, m] = ym.split('-');
    return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
  }

  const listHtml = Object.entries(ABSENCE_TYPES).map(([type, info]) => {
    if (type === 'feiertag' && !isManagerRole()) return '';
    const g = grouped[type] || { recent: [], history: {} };
    const totalCount = g.recent.length + Object.values(g.history).reduce((s, v) => s + v.length, 0);
    if (totalCount === 0 && !isManagerRole()) return '';

    const recentHtml = g.recent.length > 0
      ? g.recent.map(a => renderAbsenceCard(a)).join('')
      : (Object.keys(g.history).length === 0 ? '<p class="absence-empty">Keine Einträge</p>' : '');

    const historyKeys = Object.keys(g.history).sort().reverse(); // neueste zuerst
    const historyCount = Object.values(g.history).reduce((s, v) => s + v.length, 0);
    const historyHtml = historyKeys.length > 0 ? `
      <details class="absence-history">
        <summary class="absence-history-summary">Verlauf (${historyCount})</summary>
        <div class="absence-history-body">
          ${historyKeys.map(mk => `
            <div class="absence-history-month">
              <div class="absence-history-month-label">${monthLabel(mk)}</div>
              ${g.history[mk].map(a => renderAbsenceCard(a)).join('')}
            </div>
          `).join('')}
        </div>
      </details>` : '';

    return `<div class="absence-section">
      <div class="absence-section-header">
        <span>${info.icon} ${info.label}</span>
        <button class="btn btn-sm btn-outline absence-new" data-type="${type}">+ Eintragen</button>
      </div>
      ${recentHtml}
      ${historyHtml}
    </div>`;
  }).join('');

  mainEl.innerHTML = `
    <div class="card" style="max-width:900px;margin:0 auto">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <h2>&#128197; Abwesenheit</h2>
        ${!isManagerRole() ? `<span class="absence-counter">Urlaub ${thisYear}: <strong>${urlaubTage} Arbeitstage</strong></span>` : ''}
        <button class="btn btn-primary" id="absence-new-btn">+ Eintragen</button>
      </div>
      ${inboxHtml}
      ${listHtml || '<p class="absence-empty">Keine Abwesenheiten eingetragen.</p>'}
    </div>`;

  mainEl.querySelectorAll('.absence-new').forEach(btn => {
    btn.addEventListener('click', () => showAbsenceForm(null, btn.dataset.type, null, null, null));
  });
  document.getElementById('absence-new-btn')?.addEventListener('click', () => showAbsenceForm(null, 'krank', null, null, null));
  bindAbsenceCardActions(mainEl);
}

function renderAbsenceType(type) {
  if (!ABSENCE_TYPES[type]) { renderAbsences(); return; }
  showAbsenceForm(null, type, null, null, null);
  renderAbsences();
}

// --- Init ---
async function releaseCurrentLock() {
  if (_editingNoteLockId) {
    try { await api('POST', '/api/notes/' + _editingNoteLockId + '/unlock'); } catch(e) {}
    _editingNoteLockId = null;
  }
}
// Planungs-Kontextmenü global schließen (einmalig registriert)
document.addEventListener('click', () => {
  document.querySelectorAll('.plan-action-menu').forEach(m => m.remove());
});
window.addEventListener('hashchange', () => { releaseCurrentLock(); render(); });
window.addEventListener('beforeunload', () => {
  if (_editingNoteLockId && S.token) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/notes/' + _editingNoteLockId + '/unlock', false);
    xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    try { xhr.send('{}'); } catch(e) {}
    _editingNoteLockId = null;
  }
});
window.addEventListener('DOMContentLoaded', () => {
  if (!S.token) navigate('/login');
  render();
  if (S.token) { initSSE(); loadBadges(); }
});
