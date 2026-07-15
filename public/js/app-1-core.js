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

// --- Navigation: Dienst-/App-Auswahl statt fester Google-Maps-Bindung ---
// Web-Apps koennen die installierten Apps NICHT auflisten (kein Web-API). Daher: kuratierte Auswahl je
// Plattform + auf Android die native Geraete-Auswahl via geo:-Link. Jede URL nimmt q = encodeURIComponent(adresse).
const NAV_SERVICES = {
  device: { label: 'Geräte-Auswahl (installierte Apps)', scheme: true, url: q => 'geo:0,0?q=' + q },
  google: { label: 'Google Maps',    url: q => 'https://www.google.com/maps/dir/?api=1&destination=' + q },
  apple:  { label: 'Apple Karten',   url: q => 'https://maps.apple.com/?daddr=' + q },
  waze:   { label: 'Waze',           url: q => 'https://waze.com/ul?q=' + q + '&navigate=yes' },
  osm:    { label: 'OpenStreetMap',  url: q => 'https://www.openstreetmap.org/search?query=' + q },
  bing:   { label: 'Bing Maps',      url: q => 'https://www.bing.com/maps?q=' + q },
};
const NAV_PREF_KEY = 'navApp';

function navPlatform() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}
function navOptionsFor(platform) {
  if (platform === 'android') return ['device', 'google', 'waze'];
  if (platform === 'ios') return ['apple', 'google', 'waze'];
  return ['google', 'osm', 'apple', 'bing'];
}
function navPref() { try { return localStorage.getItem(NAV_PREF_KEY); } catch (_) { return null; } }

// Öffnet die Navigation zu einem gewählten Dienst. MUSS synchron im Klick-Handler laufen (sonst
// blockt der Browser window.open). geo: per location.href (OS-Übergabe), https per neuem Tab.
function launchNav(id, address) {
  const svc = NAV_SERVICES[id];
  if (!svc || !address) return;
  const url = svc.url(encodeURIComponent(address));
  if (svc.scheme) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}

// Einstieg von allen Navigations-Buttons. Gemerkte Wahl wird direkt verwendet, sonst Auswahl-Dialog.
// opts.force erzwingt den Dialog (zum Ändern der gemerkten Wahl).
function openNav(address, opts = {}) {
  if (!address) return;
  const options = navOptionsFor(navPlatform());
  const pref = navPref();
  if (!opts.force && pref && options.includes(pref)) { launchNav(pref, address); return; }
  chooseNavModal(address, options);
}

// Auswahl-Dialog im vorhandenen Modal-Stil (wie confirmModal). Klick auf eine Option startet die
// Navigation; „merken" speichert die Wahl (bzw. löscht sie, wenn abgewählt).
function chooseNavModal(address, options) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  const remembered = !!navPref();
  const btns = options.map(id =>
    `<button class="btn btn-outline nav-choose-btn" data-nav="${id}">${esc(NAV_SERVICES[id].label)}</button>`
  ).join('');
  overlay.innerHTML = `
    <div class="modal" style="max-width:380px">
      <div class="modal-header"><h3>Navigation öffnen mit …</h3></div>
      <div class="modal-body">
        <div class="nav-choose-list">${btns}</div>
        <label class="nav-choose-remember"><input type="checkbox" id="nav-remember"${remembered ? ' checked' : ''}> Auswahl merken</label>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const finish = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') finish(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(); });
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', finish);
  overlay.querySelectorAll('.nav-choose-btn').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.nav;
      const remember = overlay.querySelector('#nav-remember').checked;
      try { if (remember) localStorage.setItem(NAV_PREF_KEY, id); else localStorage.removeItem(NAV_PREF_KEY); } catch (_) {}
      launchNav(id, address);
      finish();
    });
  });
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

// --- Farb-Hilfen fuer den eigenen Farbwaehler (HSV <-> Hex) ---
// Normalisiert eine Hex-Eingabe auf '#RRGGBB' (Grossschreibung) oder gibt null zurueck.
// Akzeptiert mit/ohne '#' und die 3-stellige Kurzform (#abc -> #AABBCC).
function normalizeHex(str) {
  if (typeof str !== 'string') return null;
  let s = str.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return '#' + s.toUpperCase();
}
// Hex '#RRGGBB' -> { h:0..360, s:0..100, v:0..100 }. Bei ungueltig: null.
function hexToHsv(hex) {
  const n = normalizeHex(hex);
  if (!n) return null;
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  const v = Math.round(max * 100);
  return { h, s, v };
}
// { h, s, v } -> '#RRGGBB' (h 0..360, s/v 0..100).
function hsvToHex(h, s, v) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; v = Math.max(0, Math.min(100, v)) / 100;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hx = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return ('#' + hx(r) + hx(g) + hx(b)).toUpperCase();
}

// Markup eines eigenen Farbwaehlers. Das Hex-Textfeld traegt die uebergebene id (z.B. 'b-theme'),
// damit der bestehende Speichern-Handler unveraendert dessen .value (Hex) lesen kann.
function colorPickerHtml(id, label, value) {
  const hex = normalizeHex(value) || '#000000';
  return `
    <div class="form-group color-picker" data-cp="${id}">
      <label>${label}</label>
      <div class="cp-top">
        <span class="cp-swatch" data-cp-swatch></span>
        <input type="text" class="form-control cp-hex" id="${id}" value="${hex}" maxlength="7" spellcheck="false"
               autocapitalize="off" autocomplete="off" inputmode="text" aria-label="${label} Hex-Wert">
      </div>
      <div class="cp-sliders">
        <label class="cp-slabel">Farbton</label>
        <input type="range" class="cp-range cp-hue" data-cp-h min="0" max="360" step="1">
        <label class="cp-slabel">Sättigung</label>
        <input type="range" class="cp-range cp-sat" data-cp-s min="0" max="100" step="1">
        <label class="cp-slabel">Wert</label>
        <input type="range" class="cp-range cp-val" data-cp-v min="0" max="100" step="1">
      </div>
    </div>`;
}

// Verdrahtet einen Farbwaehler (HSV-Regler <-> Hex-Feld <-> Vorschau, beidseitig live).
function bindColorPicker(id) {
  const root = document.querySelector(`.color-picker[data-cp="${id}"]`);
  if (!root) return;
  const hexEl = root.querySelector('.cp-hex');
  const swatch = root.querySelector('[data-cp-swatch]');
  const hEl = root.querySelector('[data-cp-h]');
  const sEl = root.querySelector('[data-cp-s]');
  const vEl = root.querySelector('[data-cp-v]');

  const init = hexToHsv(hexEl.value) || { h: 0, s: 0, v: 0 };
  const st = { h: init.h, s: init.s, v: init.v, lastHue: init.h };

  function paintGradients() {
    // Farbton: statischer Regenbogen; Saettigung: Grau->Vollfarbe; Wert: Schwarz->Vollfarbe (beim akt. Farbton)
    hEl.style.background = 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';
    const pure = hsvToHex(st.h, 100, 100);
    sEl.style.background = `linear-gradient(to right, ${hsvToHex(st.h, 0, st.v || 50)}, ${pure})`;
    vEl.style.background = `linear-gradient(to right, #000, ${hsvToHex(st.h, st.s, 100)})`;
  }
  function applyToUi(updateHexField = true) {
    hEl.value = st.h; sEl.value = st.s; vEl.value = st.v;
    const hex = hsvToHex(st.h, st.s, st.v);
    if (updateHexField) hexEl.value = hex;
    swatch.style.background = hex;
    paintGradients();
  }

  // Regler -> State -> Hex
  function onSlider() {
    st.h = parseInt(hEl.value, 10); st.s = parseInt(sEl.value, 10); st.v = parseInt(vEl.value, 10);
    if (st.s > 0) st.lastHue = st.h;
    applyToUi(true);
  }
  [hEl, sEl, vEl].forEach(el => el.addEventListener('input', onSlider));

  // Hex-Feld -> Regler (nur bei gueltiger Eingabe; Grau/Weiss: Farbton beibehalten)
  hexEl.addEventListener('input', () => {
    const hsv = hexToHsv(hexEl.value);
    if (!hsv) return; // ungueltig -> Regler stehen lassen, kein Crash
    st.s = hsv.s; st.v = hsv.v;
    st.h = hsv.s === 0 ? st.lastHue : hsv.h;
    if (hsv.s > 0) st.lastHue = hsv.h;
    applyToUi(false); // Hex-Feld waehrend des Tippens nicht ueberschreiben
  });
  hexEl.addEventListener('blur', () => {
    const n = normalizeHex(hexEl.value) || hsvToHex(st.h, st.s, st.v);
    hexEl.value = n;
  });

  // Initial: Regler + Vorschau aus gespeichertem Hex ableiten, das Hex-Feld selbst aber NICHT
  // ueberschreiben (sonst Rundungsdrift beim blossen Oeffnen). Swatch zeigt den echten Hex-Wert.
  hEl.value = st.h; sEl.value = st.s; vEl.value = st.v;
  swatch.style.background = normalizeHex(hexEl.value) || hsvToHex(st.h, st.s, st.v);
  paintGradients();
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

// Darf ALLE verplanen (Chef/Admin oder „alle"-Recht). Self-Planer (nur can_plan) → false.
function canPlanAll() {
  return isChefOrAdmin() || (S.user && S.user.can_plan_all);
}

// Darf diesen konkreten Planungseintrag bearbeiten/löschen: „alle"-Planer immer; Self-Planer nur, wenn er
// selbst zugewiesen ist (Backend regelt Ausklinken/Aufteilen bei geteilten Einträgen).
function canEditEntry(e) {
  if (canPlanAll()) return true;
  if (!(S.user && S.user.can_plan)) return false;
  return !!(e && e.assigned_users && e.assigned_users.some(a => a.user_id === S.user.id));
}

function canEditBulletin() {
  return isChefOrAdmin() || (S.user && S.user.can_bulletin);
}

// Filtere Admin-User aus Listen (Admin taucht nirgends als Mitarbeiter auf).
// Enthält auch ausgestellte (inaktive) Mitarbeiter — wichtig für Historien-Filter (Statistik/PDF).
function getWorkerUsers() {
  return S.users.filter(u => u.role !== 'admin');
}
// Nur aktive Mitarbeiter — für Picker neuer Arbeit (neue Einträge, neue Planung).
function getActiveWorkerUsers() {
  return getWorkerUsers().filter(u => u.active !== 0);
}
// Anzeigename mit Kennzeichnung ausgestellter Mitarbeiter.
function workerLabel(u) {
  return esc(u.name) + (u.active === 0 ? ' (ausgestellt)' : '');
}
// War der Mitarbeiter im Zeitraum [from,to] (irgendwann) angestellt? Nutzt user.employment ([{s,e}]).
// Ohne Employment-Daten (alter Server/Stand) -> true, damit nichts faelschlich verschwindet.
function employedInRange(user, from, to) {
  const periods = user && user.employment;
  if (!Array.isArray(periods) || periods.length === 0) return true;
  return periods.some(p => p.s <= to && (!p.e || p.e >= from));
}

function toast(msg, type, duration) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), duration || 3000);
}

// Passwort-Policy (spiegelt routes/users.js passwordPolicyError) — für die Live-Anzeige beim Setzen.
function passwordChecks(pw) {
  pw = pw || '';
  return [
    { ok: pw.length >= 8, text: 'Mindestens 8 Zeichen' },
    { ok: /[a-z]/.test(pw), text: 'Kleinbuchstabe' },
    { ok: /[A-Z]/.test(pw), text: 'Großbuchstabe' },
    { ok: /[0-9]/.test(pw), text: 'Ziffer' },
    { ok: /[^A-Za-z0-9]/.test(pw), text: 'Sonderzeichen' },
  ];
}
function passwordAllOk(pw) { return (pw || '').length <= 72 && passwordChecks(pw).every(c => c.ok); }
// Hängt Live-Feedback an ein Passwortfeld: färbt das Feld rot/grün und rendert die Checkliste (grün ✓ / rot ✗).
function wirePwField(input, list) {
  if (!input) return;
  const render = () => {
    const pw = input.value;
    if (list) list.innerHTML = passwordChecks(pw).map(c => `<li class="${c.ok ? 'ok' : 'bad'}">${esc(c.text)}</li>`).join('');
    input.classList.remove('pw-valid', 'pw-invalid');
    if (pw) input.classList.add(passwordAllOk(pw) ? 'pw-valid' : 'pw-invalid');
  };
  input.addEventListener('input', render);
  render();
}

// --- Gestylte Dialoge (ersetzen native confirm()/prompt()) ---
// confirmModal: Promise<boolean> — true bei OK, false bei Abbrechen/Esc/Outside-Klick.
function confirmModal(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog-modal';
    const danger = opts.danger !== false; // Bestätigungen sind meist destruktiv → rote OK-Taste
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><h3>${esc(opts.title || 'Bestätigen')}</h3></div>
        <div class="modal-body"><p style="margin:0;white-space:pre-line">${esc(message)}</p></div>
        <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
          <button class="btn btn-outline" data-act="cancel">${esc(opts.cancelLabel || 'Abbrechen')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(opts.okLabel || 'OK')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter') finish(true); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
    overlay.querySelector('[data-act="ok"]').focus();
  });
}
// choiceModal: Mehrfach-Auswahl. choices: [{ value, label, danger?, primary? }]. Liefert value oder null (Abbruch).
function choiceModal(message, choices, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog-modal';
    const btns = choices.map(c => `<button class="btn ${c.danger ? 'btn-danger' : (c.primary ? 'btn-primary' : 'btn-outline')}" data-val="${esc(c.value)}" style="width:100%;margin-bottom:0.5rem;text-align:left">${esc(c.label)}</button>`).join('');
    overlay.innerHTML = `
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><h3>${esc(opts.title || 'Aktion wählen')}</h3></div>
        <div class="modal-body">${message ? `<p style="margin:0 0 0.9rem;white-space:pre-line">${esc(message)}</p>` : ''}${btns}</div>
        <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
          <button class="btn btn-outline" data-act="cancel">${esc(opts.cancelLabel || 'Abbrechen')}</button>
        </div>`;
    document.body.appendChild(overlay);
    const finish = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll('[data-val]').forEach(b => b.addEventListener('click', () => finish(b.dataset.val)));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
  });
}
// promptModal: Promise<string|null> — String bei OK, null bei Abbrechen/Esc (wie natives prompt()).
// opts: { title, defaultValue, multiline (default true), required, requiredMsg, okLabel, placeholder }
function promptModal(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog-modal';
    const multiline = opts.multiline !== false;
    const def = opts.defaultValue != null ? String(opts.defaultValue) : '';
    const ph = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
    const field = multiline
      ? `<textarea id="pm-input" class="form-control" rows="3" style="width:100%"${ph}>${esc(def)}</textarea>`
      : `<input id="pm-input" type="${esc(opts.inputType || 'text')}" class="form-control" style="width:100%"${ph} value="${esc(def)}">`;
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><h3>${esc(opts.title || 'Eingabe')}</h3></div>
        <div class="modal-body">
          <p style="margin:0 0 0.6rem;white-space:pre-line">${esc(message)}</p>
          ${field}
          <div id="pm-error" style="color:#dc2626;font-size:0.85rem;margin-top:0.4rem;display:none"></div>
        </div>
        <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
          <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
          <button class="btn btn-primary" data-act="ok">${esc(opts.okLabel || 'OK')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#pm-input');
    const errEl = overlay.querySelector('#pm-error');
    const finish = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const submit = () => {
      if (opts.required && !input.value.trim()) {
        errEl.textContent = opts.requiredMsg || 'Pflichtfeld – bitte ausfüllen.';
        errEl.style.display = '';
        input.focus();
        return;
      }
      finish(input.value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', submit);
    input.focus();
    if (!multiline) input.select();
  });
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
  else if (route.startsWith('/entry/from-project/')) renderEntryForm(null, null, null, route.split('/').pop());
  else if (route.startsWith('/entry/')) renderEntryForm(route.split('/').pop());
  else if (route === '/users') renderUsers();
  else if (route === '/projects') renderProjects();
  else if (route === '/settings') renderSettings();
  else if (route === '/audit') renderAudit();
  else if (route === '/deleted-entries') renderDeletedEntries();
  else if (route === '/deleted-absences') renderDeletedAbsences();
  else if (route === '/documents' || route.startsWith('/documents/')) renderDocuments();
  else if (route === '/pdf') renderPdfExport();
  else if (route === '/statistics') renderStatistics();
  else if (route === '/planning') renderPlanning();
  else if (route === '/planning/new') renderPlanningForm();
  else if (route.startsWith('/planning/edit-group/')) renderPlanningForm(null, null, route.split('/').pop());
  else if (route.startsWith('/planning/edit/')) renderPlanningForm(route.split('/').pop());
  else if (route.startsWith('/planning/replan/')) renderPlanningForm(null, route.split('/').pop());
  else if (route.startsWith('/planning/accept/')) renderEntryForm(null, null, route.split('/').pop());
  else if (route.startsWith('/planning/from-project/')) renderPlanningForm(null, null, null, route.split('/').pop());
  else if (route.startsWith('/entry/from-project/')) renderEntryForm(null, null, null, route.split('/').pop());
  else if (route === '/tools') renderTools();
  else if (route === '/orders') renderOrders();
  else if (route === '/notes') renderNotizen();
  else if (route === '/absences') renderAbsences();
  else if (route.startsWith('/absences/')) renderAbsenceType(route.split('/')[2]);
  else if (route === '/bulletin') renderBulletin();
  else if (route === '/bulletin/new') renderBulletinForm();
  else if (route.startsWith('/bulletin/edit/')) renderBulletinForm(route.split('/').pop());
  else if (route === '/welcome') renderWelcome();
  else if (route === '/notifications') renderNotifications();
  else if (route === '/deleted-projects') renderDeletedProjects();
  else if (route === '/deleted-users') renderDeletedUsers();
  else if (route === '/' || route === '/dashboard') renderDashboard();
  else renderWelcome();
}

