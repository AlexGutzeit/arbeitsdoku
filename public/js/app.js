// ================================================================
// Arbeitsdokumentation - Frontend Application
// ================================================================

// --- State ---
const S = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
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
  welcomeWeekOffset: 0,
};

// --- API Helper ---
async function api(method, url, body, isFormData) {
  const opts = { method, headers: {} };
  if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
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

function fmtH(val) {
  const neg = val < 0;
  const abs = Math.abs(val);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
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

// Globaler Tooltip
let tooltipEl = null;
function initTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'entry-tooltip';
  tooltipEl.style.display = 'none';
  document.body.appendChild(tooltipEl);
}
function showTooltip(html, x, y) {
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
  else if (route.startsWith('/planning/edit/')) renderPlanningForm(route.split('/').pop());
  else if (route.startsWith('/planning/replan/')) renderPlanningForm(null, route.split('/').pop());
  else if (route.startsWith('/planning/accept/')) renderEntryForm(null, null, route.split('/').pop());
  else if (route === '/tools') renderTools();
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
  } catch (err) {
    const el = document.getElementById('login-error');
    el.textContent = err.message;
    el.style.display = 'block';
  }
}

function logout() {
  S.token = null;
  S.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  navigate('/login');
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
        </a>
        <a href="#/tools" class="${activeNav === 'tools' ? 'active' : ''}">
          <span class="icon">&#128295;</span> Werkzeugliste
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
    : activeNav === 'welcome' ? ''
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
        api('GET', '/api/statistics/overtime'),
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

  // Filter (nur Projekt + Suche, Mitarbeiter werden per Chips gesteuert)
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

  // Entscheidung: Timeline (Tag), Wochenraster, Monatsraster
  let contentHtml = '';
  if (S.view === 'day') {
    contentHtml = renderTimelineHtml(visibleEntries);
  } else if (S.view === 'week') {
    contentHtml = renderWeekGridHtml(visibleEntries, range);
  } else {
    contentHtml = renderMonthGridHtml(visibleEntries, range);
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
  // Filters
  document.getElementById('filter-project')?.addEventListener('change', (e) => { S.filterProjectId = e.target.value; renderDashboardContent(); });
  document.getElementById('filter-regie')?.addEventListener('change', (e) => { S.filterRegie = e.target.value; renderDashboardContent(); });
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
function renderTimelineHtml(entries) {
  if (entries.length === 0) {
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
    });

    const headerLabel = isSingle ? 'Meine Einträge' : esc(col.name);
    colsHtml += `<div class="timeline-column">
      <div class="tl-col-header" style="${!isSingle ? 'color:' + colColor : ''}">${headerLabel}</div>
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
function renderWeekGridHtml(entries, range) {
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
      bodyHtml += `<td class="grid-cell" data-jump-date="${day}">`;
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
function renderMonthGridHtml(entries, range) {
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
      bodyHtml += `<td class="grid-cell" data-jump-date="${w.from}">`;
      if (cellEntries.length > 0) {
        // Gruppiere nach Tag für kompakte Darstellung
        const byDay = {};
        cellEntries.forEach(e => {
          if (!byDay[e.date]) byDay[e.date] = [];
          byDay[e.date].push(e);
        });
        Object.keys(byDay).sort().forEach(day => {
          const dayEntries = byDay[day];
          const dn = getDayNameShort(day);
          const dayH = calcActualHours(dayEntries);
          bodyHtml += `<div class="grid-kw-day" data-jump-date="${day}">
            <span class="grid-kw-dayname">${dn}</span>
            <span class="grid-kw-dayhours">${fmtH(dayH)}</span>
          </div>`;
        });
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
    const uData = await api('GET', '/api/users');
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

  // Click handlers for planning entries
  mainEl.querySelectorAll('.tl-plan-entry[data-planning-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.plan-action-btn')) return;
      navigate('/planning/accept/' + el.dataset.planningId);
    });
  });
  mainEl.querySelectorAll('.plan-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); navigate('/planning/edit/' + btn.dataset.id); });
  });
  mainEl.querySelectorAll('.plan-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Planung wirklich löschen?')) return;
      try {
        await api('DELETE', '/api/planning/' + btn.dataset.id);
        toast('Planung gelöscht', 'success');
        renderPlanningContent();
      } catch (e2) { toast(e2.message, 'error'); }
    });
  });
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
      if (canEdit && height > 30) {
        actionsHtml = `${e.address ? `<button type="button" class="plan-action-btn nav-to-addr" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''}<button type="button" class="plan-action-btn plan-edit-btn" data-id="${e.id}" title="Bearbeiten">&#9998;</button><button type="button" class="plan-action-btn plan-del-btn" data-id="${e.id}" title="Löschen">&#10005;</button>`;
      } else if (e.address) {
        actionsHtml = `<button type="button" class="plan-action-btn nav-to-addr" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>`;
      }

      bodyHtml += `<div class="tl-plan-entry" data-planning-id="${e.id}" style="top:${top}px;height:${height}px;left:${leftPct}%;width:${widthPct}%;right:auto;" title="Klicken zum Übernehmen">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="tl-e-time">${esc(e.time_from)} - ${esc(e.time_to)}</span>
          <span>${actionsHtml}</span>
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
          bodyHtml += `<div class="grid-plan-entry">${e.time_from}-${e.time_to} ${e.address ? `<button class="nav-to-addr grid-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''} ${esc(proj)}${proj && e.client ? ' – ' : ''}${esc(e.client || '')}</div>`;
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
          bodyHtml += `<div class="grid-kw-day grid-plan-entry" data-plan-jump="${day}">
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
async function renderPlanningForm(editId, replanId) {
  let entry = null;
  let replanEntry = null;

  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    const uData = await api('GET', '/api/users');
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

  const isEdit = !!entry;
  const source = replanEntry;
  const title = isEdit ? 'Planung bearbeiten' : (source ? 'Auftrag erneut planen' : 'Neue Planung');
  const assignedIds = entry ? entry.assigned_users.map(u => u.user_id) : (source ? source.assigned_users.map(u => u.user_id) : []);
  const workers = getWorkerUsers();

  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
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
        <div class="form-group">
          <label>Datum</label>
          <input type="date" class="form-control" id="pf-date" value="${entry ? entry.date : (source ? '' : formatDateISO(new Date()))}" ${!source ? 'required' : ''}>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Von</label>
            <input type="time" class="form-control" id="pf-from" value="${entry ? entry.time_from : '07:00'}" required>
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="time" class="form-control" id="pf-to" value="${entry ? entry.time_to : '15:30'}" required>
          </div>
        </div>
        <div class="form-group">
          <label>Pause (Minuten)</label>
          <input type="number" class="form-control" id="pf-break" value="${entry ? entry.break_minutes : 30}" min="0" step="5">
        </div>
        <div class="form-group">
          <label>Adresse / Arbeitsort</label>
          <div class="input-with-btn">
            <input type="text" class="form-control" id="pf-address" value="${esc(entry?.address || source?.address || '')}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
            <button type="button" class="btn btn-outline btn-sm btn-nav" id="pf-nav" title="Navigation starten">&#128506;</button>
          </div>
        </div>
        <div class="form-group">
          <label>Kunde</label>
          <input type="text" class="form-control" id="pf-client" value="${esc(entry?.client || source?.client || '')}" placeholder="Kundenname">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Projekt (Auswahl)</label>
            <select class="form-control" id="pf-project">
              <option value="">-- Kein Projekt --</option>
              ${S.projects.map(p => `<option value="${p.id}" ${p.id == (entry?.project_id || source?.project_id || '') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Oder Freitext</label>
            <input type="text" class="form-control" id="pf-project-text" value="${(entry?.project_id || source?.project_id) ? '' : esc(entry?.project_text || source?.project_text || '')}" placeholder="Projektname" ${(entry?.project_id || source?.project_id) ? 'disabled' : ''}>
          </div>
        </div>
        <div class="form-group">
          <label>Beschreibung</label>
          <textarea class="form-control" id="pf-desc" rows="3" placeholder="Was soll gemacht werden?">${esc(entry?.description || source?.description || '')}</textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Speichern' : 'Planung erstellen'}</button>
        ${isEdit ? `<button type="button" class="btn btn-outline btn-block" id="replan-entry" style="margin-top:0.5rem">Auftrag erneut planen</button>` : ''}
        ${isEdit ? '<button type="button" class="btn btn-danger btn-block" id="delete-planning" style="margin-top:0.5rem">Planung löschen</button>' : ''}
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'planning');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  document.getElementById('back-btn').addEventListener('click', () => navigate('/planning'));

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

    const body = {
      date: document.getElementById('pf-date').value,
      time_from: document.getElementById('pf-from').value,
      time_to: document.getElementById('pf-to').value,
      break_minutes: parseInt(document.getElementById('pf-break').value) || 0,
      address: document.getElementById('pf-address').value,
      client: document.getElementById('pf-client').value,
      project_id: document.getElementById('pf-project').value || null,
      project_text: document.getElementById('pf-project-text').value,
      description: document.getElementById('pf-desc').value,
      assigned_user_ids: checked,
    };

    try {
      if (isEdit) {
        await api('PUT', '/api/planning/' + editId, body);
        toast('Planung aktualisiert', 'success');
      } else {
        await api('POST', '/api/planning', body);
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
      await api('DELETE', '/api/planning/' + editId);
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
  try {
    const data = await api('GET', '/api/tools');
    if (data) tools = data.tools;
  } catch (e) {}

  const canManage = S.user.role === 'admin' || S.user.role === 'chef';

  const fmtDT = (dt) => {
    if (!dt) return '';
    const [d, t] = dt.split(' ');
    const [y, m, dd] = d.split('-');
    return `${dd}.${m}.${y} ${t ? t.slice(0, 5) : ''}`;
  };

  let toolsHtml = '';
  if (tools.length === 0) {
    toolsHtml = '<p style="color:var(--text-light)">Noch keine Werkzeuge angelegt.</p>';
  } else {
    toolsHtml = tools.map(t => {
      const isOut = !!t.checkout_id;
      const isMine = isOut && t.checked_out_by === S.user.id;
      const statusClass = isOut ? 'tool-out' : 'tool-in';
      const statusText = isOut
        ? `${esc(t.checked_out_by_name)} seit ${fmtDT(t.checked_out_at)}`
        : 'Im Lager';

      let actions = '';
      if (!isOut) {
        actions = `<button class="btn btn-sm btn-primary tool-checkout" data-id="${t.id}">Entnehmen</button>`;
      } else if (isMine) {
        actions = `<button class="btn btn-sm btn-success tool-return" data-id="${t.id}">Zurückgeben</button>`;
      } else {
        actions = `<button class="btn btn-sm btn-outline tool-takeover" data-id="${t.id}">Übernehmen</button>`;
      }

      return `<div class="tool-item ${statusClass}">
        <div class="tool-info">
          <strong>${esc(t.name)}</strong>
          <span class="tool-status">${statusText}</span>
        </div>
        <div class="tool-actions">
          ${actions}
          <button class="btn btn-sm btn-outline tool-history" data-id="${t.id}" data-name="${esc(t.name)}">Historie</button>
          ${canManage ? `<button class="btn btn-sm btn-outline tool-edit" data-id="${t.id}" data-name="${esc(t.name)}">&#9998;</button>` : ''}
          ${canManage ? `<button class="btn btn-sm btn-danger tool-delete" data-id="${t.id}">&#10005;</button>` : ''}
        </div>
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

  // Entnehmen
  mainEl.querySelectorAll('.tool-checkout').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/tools/${btn.dataset.id}/checkout`);
        toast('Werkzeug entnommen', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
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

  // Übernehmen
  mainEl.querySelectorAll('.tool-takeover').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Werkzeug von anderem Mitarbeiter übernehmen?')) return;
      try {
        await api('POST', `/api/tools/${btn.dataset.id}/takeover`);
        toast('Werkzeug übernommen', 'success');
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
          document.getElementById('history-content').innerHTML = `<table class="table" style="font-size:0.85rem;width:100%;border-collapse:separate;border-spacing:0;">
            <thead><tr><th style="text-align:left;padding:0.5rem 0.75rem;border-bottom:2px solid var(--border);">Wer</th><th style="text-align:left;padding:0.5rem 0.75rem;border-bottom:2px solid var(--border);">Entnommen</th><th style="text-align:left;padding:0.5rem 0.75rem;border-bottom:2px solid var(--border);">Zurück</th></tr></thead>
            <tbody>${data.history.map(h => `<tr>
              <td style="padding:0.4rem 0.75rem;border-bottom:1px solid var(--border);">${esc(h.user_name)}</td>
              <td style="padding:0.4rem 0.75rem;border-bottom:1px solid var(--border);white-space:nowrap;">${fmtDT(h.checked_out_at)}</td>
              <td style="padding:0.4rem 0.75rem;border-bottom:1px solid var(--border);white-space:nowrap;">${h.returned_at ? fmtDT(h.returned_at) : '<em>unterwegs</em>'}</td>
            </tr>`).join('')}</tbody>
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
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'bulletin');
  bindLayout();

  let entries = [];
  try {
    const data = await api('GET', '/api/bulletin');
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
      return `<div class="bulletin-card">
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

  const showPw = S.user.role === 'admin' || S.user.role === 'chef';

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
              ${showPw ? '<th>Passwort</th>' : ''}
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
                ${showPw ? `<td class="pw-cell"><span class="pw-text">••••••</span><span class="pw-plain" style="display:none">${esc(u.password_plain || '')}</span><button type="button" class="pw-toggle" title="Passwort anzeigen">&#128065;</button></td>` : ''}
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

  // Passwort anzeigen/verstecken per Auge-Toggle
  mainEl.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const cell = btn.closest('.pw-cell');
      const dots = cell.querySelector('.pw-text');
      const plain = cell.querySelector('.pw-plain');
      const visible = plain.style.display !== 'none';
      dots.style.display = visible ? '' : 'none';
      plain.style.display = visible ? 'none' : '';
      btn.innerHTML = visible ? '&#128065;' : '&#128064;';
      btn.title = visible ? 'Passwort anzeigen' : 'Passwort verbergen';
    });
  });

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
        <div class="form-group">
          <label>Passwort${isEdit ? ' (leer lassen = unverändert)' : ''}</label>
          <div class="pw-input-wrap">
            <input type="password" class="form-control" id="um-password" value="${isEdit ? (user?.password_plain || '') : ''}" ${isEdit ? '' : 'required'}>
            <button type="button" class="pw-toggle-btn" id="um-pw-toggle" title="Passwort anzeigen">&#128065;</button>
          </div>
        </div>
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

  // Passwort-Toggle im Modal
  document.getElementById('um-pw-toggle')?.addEventListener('click', () => {
    const inp = document.getElementById('um-password');
    const btn = document.getElementById('um-pw-toggle');
    if (inp.type === 'password') {
      inp.type = 'text';
      btn.innerHTML = '&#128064;';
    } else {
      inp.type = 'password';
      btn.innerHTML = '&#128065;';
    }
  });

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
    const pw = document.getElementById('um-password').value;
    if (pw) body.password = pw;

    try {
      if (isEdit) {
        await api('PUT', '/api/users/' + user.id, body);
        toast('Mitarbeiter aktualisiert', 'success');
      } else {
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
    </div>`;

  // Diagramme zeichnen
  drawPieChart(document.getElementById('pie-chart'), c);
  drawTimeChart(document.getElementById('time-chart'), stats.combinedTimeline, stats.users.length > 1 ? null : stats.users);

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

function drawTimeChart(canvas, timeline, users) {
  if (!canvas || !timeline || timeline.length === 0) return;
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

  function showTooltip(clientX) {
    const idx = findNearest(clientX);
    const t = timeline[idx];
    const diff = t.ist - t.soll;
    const prefix = diff >= 0 ? '+' : '';
    tooltip.innerHTML = `<strong>${t.label}</strong><br>Ist: ${fmtH(t.ist)}<br>Soll: ${fmtH(t.soll)}<br>Diff: ${prefix}${fmtH(diff)}`;
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

  canvas.addEventListener('mousemove', e => showTooltip(e.clientX));
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  canvas.addEventListener('touchstart', e => { showTooltip(e.touches[0].clientX); }, { passive: true });
  canvas.addEventListener('touchmove', e => { showTooltip(e.touches[0].clientX); }, { passive: true });
  canvas.addEventListener('touchend', () => { setTimeout(() => { tooltip.style.display = 'none'; }, 2000); });
}

// --- Init ---
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  if (!S.token) navigate('/login');
  render();
});
