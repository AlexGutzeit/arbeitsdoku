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
      ${legalLinksHtml()}
    </div>`;
  document.getElementById('login-form').addEventListener('submit', handleLogin);
}

// Dezente Impressum/Datenschutz-Links — nur zeigen, was hinterlegt ist (white-label: frischer Deploy bleibt sauber).
function legalLinksHtml() {
  const parts = [];
  if (S.hasLegal.impressum) parts.push('<a href="#/impressum">Impressum</a>');
  if (S.hasLegal.datenschutz) parts.push('<a href="#/datenschutz">Datenschutz</a>');
  return parts.length ? `<div class="login-legal">${parts.join(' · ')}</div>` : '';
}

// Öffentlich abrufbare Flags (auch ausgeloggt), damit Login-Seite + Nav wissen, ob Rechtstexte existieren.
async function loadLegalFlags() {
  try {
    const d = await api('GET', '/api/legal');
    if (!d) return;
    S.hasLegal = {
      impressum: !!(d.impressum && d.impressum.trim()),
      datenschutz: !!(d.datenschutz && d.datenschutz.trim()),
    };
    if (S.hasLegal.impressum || S.hasLegal.datenschutz) render(); // Links/Nav nachziehen
  } catch (_) {}
}

// Rechtsseite (Impressum/Datenschutz). Funktioniert eingeloggt UND ausgeloggt (Impressumspflicht).
async function renderLegal(kind) {
  const title = kind === 'datenschutz' ? 'Datenschutzerklärung' : 'Impressum';
  let data = null;
  try { data = await api('GET', '/api/legal'); } catch (_) {}
  const raw = data ? (kind === 'datenschutz' ? data.datenschutz : data.impressum) : '';
  const body = (raw && raw.trim())
    ? esc(raw).replace(/\n/g, '<br>')
    : `<p class="legal-empty">Für diese Seite wurde noch kein Inhalt hinterlegt.${(S.user && canSeeSettings()) ? ' Du kannst ihn unter <a href="#/settings">Einstellungen → Rechtliches</a> eintragen.' : ''}</p>`;
  const back = (S.token && S.user) ? `<a href="#${S._lastRoute || '/welcome'}">← Zurück</a>` : '<a href="#/login">← Zurück zur Anmeldung</a>';
  const card = `<div class="legal-page"><h1>${esc(title)}</h1><div class="legal-body">${body}</div><p class="legal-back">${back}</p></div>`;
  if (S.token && S.user) {
    $app().innerHTML = layout(card, kind);
    bindLayout();
  } else {
    $app().innerHTML = `<div class="login-container"><div class="login-card legal-standalone">${card}</div></div>`;
  }
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
    syncPushSubscription();
  } catch (err) {
    const el = document.getElementById('login-error');
    el.textContent = err.message;
    el.style.display = 'block';
  }
}

async function logout(manual) {
  // Nur der bewusste „Abmelden"-Klick: Push-Abo dieses Geraets abmelden (wichtig auf geteilten
  // Geraeten) und serverseitig fuers Audit-Log abmelden — beides MUSS passieren, solange das Token
  // noch gueltig ist, daher VOR dem Loeschen. Der automatische Logout (401/abgelaufenes Token) ruft
  // logout() ohne Argument — dort wird serverseitig bereits 'session_expired' protokolliert.
  if (manual && S.token) {
    try { await disablePush(); } catch (_) { /* Push bleibt zur Not aktiv — kein Logout-Blocker */ }
    api('POST', '/api/auth/logout').catch(() => {});
  }
  stopSSE();
  entwurfAllesLoeschen();   // Entwuerfe enthalten Kunde/Adresse/Notiz — auf geteilten Geraeten nichts stehen lassen
  S.token = null;
  S.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  navigate('/login');
}

// Holt den aktuellen Nutzer (inkl. Rechte wie can_plan) frisch vom Server und aktualisiert S.user.
// Nötig, weil S.user aus der Login-Antwort gecacht ist — ändert ein Admin z.B. das Planungsrecht,
// soll das ohne erneutes Login (nach F5 / Tab-Rückkehr) greifen. Re-Render nur bei echter Rechte-Änderung.
async function refreshUser() {
  if (!S.token) return;
  try {
    const d = await api('GET', '/api/auth/me');
    if (!d || !d.user) return;
    const norm = u => u ? [u.role, !!u.can_plan, !!u.can_plan_all, !!u.can_bulletin, !!u.can_upload].join('|') : '';
    const changed = norm(S.user) !== norm(d.user);
    S.user = d.user;
    localStorage.setItem('user', JSON.stringify(d.user));
    if (changed) render();
  } catch (_) { /* offline o.ä.: alter Stand bleibt bestehen */ }
}

// Echtzeit-Updates (SSE). Statt des langen Login-Tokens haengt der Client ein nur 60 s gueltiges
// Ticket an die URL und holt fuer JEDE (Wieder-)Verbindung ein frisches. Wiederverbinden uebernehmen
// wir selbst (EventSource wuerde sonst stur die alte, abgelaufene URL erneut verwenden).
let _sseStopped = false;
let _sseReconnectTimer = null;
let _sseBackoff = 1000;

// Tippt der Nutzer gerade, oder hat er ein Eingabeformular offen? Dann NICHT live neu aufbauen — sonst
// verschwindet das halb ausgefüllte Formular, sobald ein Kollege etwas speichert (Datenverlust).
// Die Änderung des Kollegen sieht er beim nächsten eigenen Seitenwechsel.
function _editorBusy(...areaSelectors) {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return true;
  for (const sel of areaSelectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null && el.innerHTML.trim() !== '') return true;
  }
  return false;
}

function _sseOnMessage(e) {
  let p; try { p = JSON.parse(e.data); } catch (_) { return; }
  // Bestellungs-Badge immer aktualisieren (live-Zähler, auch eigene Aktionen)
  if (p.type === 'orders') loadBadges();
  if (p.originTab === S.tabId) return;
  const route = getRoute();
  if (p.type === 'orders'   && route === '/orders' && !_editorBusy('#order-form-area'))   renderOrders();
  if (p.type === 'notes'    && route === '/notes' && !_editingNoteLockId && !_editorBusy('#note-form-area')) renderNotizen();
  if (p.type === 'bulletin' && route === '/bulletin')                            renderBulletin();
  if (p.type === 'planning' && route === '/planning' && !_editorBusy())          renderPlanningContent();
  if (p.type === 'tools'    && route === '/tools' && !_editorBusy('.tool-checkout-form[style*="block"]')) renderTools();
  // Das Projekt-Formular liegt INNERHALB der Hauptfläche (kein Overlay) und hat keine eigene Route — ohne
  // den Selektor würde es beim Speichern eines Kollegen weggerissen, sobald man gerade nicht tippt.
  if (p.type === 'projects' && route === '/projects' && !_editorBusy('#pf2-save')) renderProjects();
  if (p.type === 'entries') {
    if (route === '/statistics')                       renderStatistics();
    else if (route === '/' || route === '/dashboard')  renderDashboardContent();  // #1: Dashboard-Zeitliste live
  }
  if ((p.type === 'planning' || p.type === 'bulletin') && route === '/welcome')  renderWelcome();
  if (p.type === 'bulletin'  && route !== '/bulletin')  loadBadges();
  if (p.type === 'notes'     && route !== '/notes')     loadBadges();
  if (p.type === 'absences') {
    loadBadges();  // immer, damit Nav-Badge auf jeder Route live aktualisiert wird
    if (route.startsWith('/absences'))       renderAbsences();
    else if (route === '/' || route === '/dashboard')  renderDashboardContent(); // /dashboard fehlte hier
    else if (route === '/welcome')           renderWelcome();
    else if (route === '/planning')          renderPlanningContent();
    else if (route === '/statistics')        renderStatistics();
  }
}

function scheduleSSEReconnect() {
  if (_sseStopped || _sseReconnectTimer) return;
  const delay = _sseBackoff;
  _sseBackoff = Math.min(_sseBackoff * 2, 30000); // exponentiell, max. 30 s
  _sseReconnectTimer = setTimeout(() => { _sseReconnectTimer = null; connectSSE(); }, delay);
}

async function connectSSE() {
  if (_sseStopped || !S.token) return;
  if (S.sse) { try { S.sse.close(); } catch (_) {} S.sse = null; }
  let ticket;
  try {
    const r = await api('GET', '/api/events/ticket');
    if (!r || !r.ticket) return;        // null = 401/abgemeldet (api() hat schon ausgeloggt) → nicht erneut versuchen
    ticket = r.ticket;
  } catch (_) {
    scheduleSSEReconnect();             // Netzwerkfehler → spaeter erneut versuchen
    return;
  }
  if (_sseStopped || !S.token) return;
  const es = new EventSource('/api/events?ticket=' + encodeURIComponent(ticket));
  S.sse = es;
  es.onopen = () => { _sseBackoff = 1000; }; // erfolgreiche Verbindung → Backoff zuruecksetzen
  es.onmessage = _sseOnMessage;
  es.onerror = () => {                  // getrennt / Ticket abgelaufen / Server-Force-Close → frisch verbinden
    try { es.close(); } catch (_) {}
    if (S.sse === es) S.sse = null;
    scheduleSSEReconnect();
  };
}

function initSSE() {
  _sseStopped = false;
  _sseBackoff = 1000;
  if (S.sse) return;
  connectSSE();
}

function stopSSE() {
  _sseStopped = true;
  if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
  if (S.sse) { try { S.sse.close(); } catch (_) {} S.sse = null; }
}

// --- Layout ---
function layout(content, activeNav) {
  const showUsers = canManageUsers();
  const showProjects = true; // Auftrags-Board für alle sichtbar (Verwaltung bleibt rollengated)
  const showSettings = canSeeSettings();
  const showAudit = isAdmin();
  const showNewEntry = canCreateEntries();

  return `
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <div class="sidebar" id="sidebar" role="navigation" aria-label="Hauptmenü">
      <div class="sidebar-header">
        <h2>${esc(S.user.name)}</h2>
        <span class="role-badge">${roleName(S.user.role)}</span>
      </div>
      <nav aria-label="Bereiche">
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
          ${(S.user.role === 'chef' || S.user.role === 'admin') ? `<span class="nav-badge" id="nav-badge-orders"${S.badges.orders ? '' : ' style="display:none"'}>${S.badges.orders || ''}</span>` : ''}
        </a>
        <a href="#/notes" class="${activeNav === 'notes' ? 'active' : ''}">
          <span class="icon">&#128221;</span> Notizen
          <span class="nav-badge" id="nav-badge-notes"${S.badges.notes ? '' : ' style="display:none"'}>${S.badges.notes || ''}</span>
        </a>
        <a href="#/documents" class="${activeNav === 'documents' ? 'active' : ''}">
          <span class="icon">&#128193;</span> Dokumente
        </a>
        <a href="#/absences" class="${activeNav === 'absences' ? 'active' : ''}">
          <span class="icon">&#128197;</span> Abwesenheit
          <span class="nav-badge" id="nav-badge-absences"${S.badges.absences ? '' : ' style="display:none"'}>${S.badges.absences || ''}</span>
        </a>
        <a href="#/statistics" class="${activeNav === 'statistics' ? 'active' : ''}">
          <span class="icon">&#128200;</span> Statistik
        </a>
        <div class="sidebar-divider"></div>
        <a href="#/notifications" class="${activeNav === 'notifications' ? 'active' : ''}">
          <span class="icon">&#128276;</span> Benachrichtigungen
        </a>
        <a href="#/pdf" class="${activeNav === 'pdf' ? 'active' : ''}">
          <span class="icon">&#128196;</span> Export
        </a>
        ${showSettings ? `<a href="#/settings" class="${activeNav === 'settings' ? 'active' : ''}">
          <span class="icon">&#9881;</span> Einstellungen
        </a>` : ''}
        ${showAudit ? `<a href="#/audit" class="${activeNav === 'audit' ? 'active' : ''}">
          <span class="icon">&#128220;</span> Audit-Log
        </a>` : ''}
        <div class="nav-group${(activeNav === 'deleted-entries' || activeNav === 'deleted-absences' || activeNav === 'deleted-projects' || activeNav === 'deleted-users') ? ' open' : ''}" id="nav-papierkorb">
          <div class="nav-group-label" id="nav-papierkorb-label">
            <span class="icon">&#128465;</span> Papierkorb
            <span class="nav-caret">&#9656;</span>
          </div>
          <a href="#/deleted-entries" class="nav-subitem ${activeNav === 'deleted-entries' ? 'active' : ''}">Einträge</a>
          <a href="#/deleted-absences" class="nav-subitem ${activeNav === 'deleted-absences' ? 'active' : ''}">Abwesenheiten</a>
          ${isChefOrAdmin() ? `<a href="#/deleted-projects" class="nav-subitem ${activeNav === 'deleted-projects' ? 'active' : ''}">Projekte</a>` : ''}
          ${showUsers ? `<a href="#/deleted-users" class="nav-subitem ${activeNav === 'deleted-users' ? 'active' : ''}">Mitarbeiter</a>` : ''}
        </div>
        ${(S.hasLegal.impressum || S.hasLegal.datenschutz) ? `<div class="sidebar-divider"></div>
        ${S.hasLegal.impressum ? `<a href="#/impressum" class="${activeNav === 'impressum' ? 'active' : ''}">
          <span class="icon">&#167;</span> Impressum
        </a>` : ''}
        ${S.hasLegal.datenschutz ? `<a href="#/datenschutz" class="${activeNav === 'datenschutz' ? 'active' : ''}">
          <span class="icon">&#128274;</span> Datenschutz
        </a>` : ''}` : ''}
      </nav>
    </div>
    <div class="header" role="banner">
      <button class="menu-btn" id="menu-btn" aria-label="Menü öffnen" aria-controls="sidebar" aria-expanded="false">&#9776;</button>
      <span class="title">Arbeitsdoku</span>
      <div class="user-info">
        <span class="user-name">${esc(S.user.name)}</span>
        <button class="logout-btn" id="logout-btn">Abmelden</button>
      </div>
    </div>
    <div class="main" role="main" id="hauptbereich">${content}</div>
    ${activeNav === 'planning' ? (canEditPlanning() ? '<button class="fab" id="fab-new" title="Neue Planung">+</button>' : '')
    : activeNav === 'projects' ? (isChefOrAdmin() ? '<button class="fab" id="fab-new" title="Neues Projekt">+</button>' : '')
    : activeNav === 'bulletin' ? (canEditBulletin() ? '<button class="fab" id="fab-new" title="Neuer Eintrag">+</button>' : '')
    : activeNav === 'notes' ? '<button class="fab" id="fab-new" title="Neue Notiz">+</button>'
    : activeNav === 'absences' ? '<button class="fab" id="fab-new" title="Neue Abwesenheit">+</button>'
    : activeNav === 'dashboard' ? (showNewEntry ? '<button class="fab" id="fab-new" title="Neuer Eintrag">+</button>' : '')
    : ''}
  `;
}

function bindLayout() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const menuBtn = document.getElementById('menu-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const fab = document.getElementById('fab-new');

  // Der aktive Menuepunkt ist bisher nur farblich markiert — eine CSS-Klasse sagt einem
  // Screenreader nichts. aria-current benennt ihn als „aktuelle Seite" (B8b). Zentral hier statt
  // in ~20 Vorlagen einzeln.
  if (sidebar) sidebar.querySelectorAll('nav a').forEach(a => {
    if (a.classList.contains('active')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const menueAuf = (auf) => {
    sidebar.classList.toggle('open', auf);
    overlay.classList.toggle('open', auf);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', auf ? 'true' : 'false');
  };
  if (menuBtn) menuBtn.addEventListener('click', () => menueAuf(true));
  if (overlay) overlay.addEventListener('click', () => menueAuf(false));
  // Close sidebar on nav click
  if (sidebar) sidebar.querySelectorAll('nav a').forEach(a => {
    a.addEventListener('click', () => menueAuf(false));
  });
  // Escape schliesst das ausgeklappte Menue (auf dem Handy liegt es ueber dem Inhalt).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open')) {
      menueAuf(false);
      if (menuBtn) menuBtn.focus();
    }
  });
  // Papierkorb-Gruppe per Tippen auf-/zuklappen (Touch-Geraete; Desktop nutzt zusaetzlich Hover via CSS)
  const pkLabel = document.getElementById('nav-papierkorb-label');
  if (pkLabel) pkLabel.addEventListener('click', () => {
    document.getElementById('nav-papierkorb')?.classList.toggle('open');
  });

  if (logoutBtn) logoutBtn.addEventListener('click', () => logout(true));
  if (fab) fab.addEventListener('click', () => {
    const route = getRoute();
    if (route === '/planning') navigate('/planning/new');
    else if (route === '/projects') renderProjectForm(null);
    else if (route === '/bulletin') navigate('/bulletin/new');
    else if (route === '/notes') showNoteForm();
    else if (route === '/absences') showAbsenceForm(null, 'krank', null, null, null);
    else navigate('/entry/new');
  });
}

