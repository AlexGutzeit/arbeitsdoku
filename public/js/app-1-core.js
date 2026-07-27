// ================================================================
// Arbeitsdokumentation - Frontend Application
// ================================================================

// --- State ---
// Beschädigter localStorage (abgestürzter Tab, voller Speicher) darf die App NICHT komplett lahmlegen:
// Ohne Absicherung wirft JSON.parse hier auf Modulebene → kein Skript läuft mehr → weiße Seite, man kann
// sich nicht einmal abmelden. Im Zweifel lieber ausloggen als abstürzen.
function _readStoredUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); }
  catch (_) {
    try { localStorage.removeItem('user'); localStorage.removeItem('token'); } catch (__) {}
    return null;
  }
}

const S = {
  token: localStorage.getItem('token'),
  user: _readStoredUser(),
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
  hasLegal: { impressum: false, datenschutz: false }, // ob Impressum/Datenschutz hinterlegt sind (für Links)
  _lastRoute: '/welcome', // letzte Seite vor Impressum/Datenschutz (für den „Zurück"-Link)
  // Woher kam das Übernehmen einer Planung? Der „Zurück"-Knopf im Zeiteintrag soll dorthin
  // zurückführen — von der Willkommensseite aus also zur Willkommensseite und nicht zur Planung.
  // Nach einem Neuladen der Seite ist der Merker leer; dann gilt wie bisher die Planung.
  _uebernahmeVon: null,
  // Arbeitszeit-Vorgaben der Firma (Beginn, Stunden/Tag, Pause). Einmal je Sitzung geladen und
  // hier gemerkt — sie ändern sich selten und werden an mehreren Stellen zur Vorbelegung gebraucht.
  arbeitszeit: null,
};

// --- API Helper ---
// Doppel-Submit-Schutz (app-weit): identische, GLEICHZEITIG laufende Schreib-Anfragen werden zu EINER
// zusammengefasst. Klickt jemand bei wackeligem Netz 5× auf „Speichern", startet nur der erste Klick einen
// echten fetch; die weiteren erhalten dasselbe Promise → real geht nur EIN Request/Insert raus. Nach dem
// Abschluss wird der Schlüssel wieder freigegeben, sodass ein bewusster erneuter Versuch normal funktioniert.
const _inflightApi = new Map();
async function api(method, url, body, isFormData) {
  const mutating = /^(POST|PUT|PATCH|DELETE)$/i.test(method);
  // Nur JSON-Schreibanfragen deduplizieren; GETs (idempotent) und FormData-Uploads bleiben unberührt.
  const dedupKey = (mutating && !isFormData) ? `${method} ${url} ${body ? JSON.stringify(body) : ''}` : null;
  if (dedupKey && _inflightApi.has(dedupKey)) return _inflightApi.get(dedupKey);

  const run = (async () => {
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
  })();

  if (dedupKey) {
    _inflightApi.set(dedupKey, run);
    run.finally(() => _inflightApi.delete(dedupKey));
  }
  return run;
}

// --- Utilities ---
// HTML-escapen für Text UND Attribute. Wichtig: textContent→innerHTML escapt " und ' NICHT — in
// `value="${esc(x)}"`/`data-x="${esc(x)}"` könnte ein Anführungszeichen sonst aus dem Attribut ausbrechen.
// Deshalb werden Quotes zusätzlich ersetzt (im Textkontext unschädlich, der Browser zeigt sie normal an).
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Zahl aus einem Eingabefeld lesen. Leer → Default; Komma erlaubt; UNGÜLTIG → null, damit der Aufrufer eine
// Meldung zeigen kann statt still 0 zu speichern. Wichtig: Ein <input type="number"> mit unlesbarem Inhalt
// liefert value==="" — das erkennt man nur an validity.badInput, sonst sähe es wie „leer gelassen" aus.
function numFromField(idOrEl, def, min, max) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (!el) return def;
  if (el.validity && el.validity.badInput) return null;
  const raw = String(el.value).trim().replace(',', '.');
  if (raw === '') return def;
  const n = parseFloat(raw);
  if (!isFinite(n)) return null;
  // Bereichsgrenzen (ersetzen die frühere min/max-Prüfung der type=number-Felder)
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

// Zahl für die Anzeige in einem Eingabefeld: deutsches Dezimalkomma (7.5 → „7,5").
function numDe(v) { return String(v ?? 0).replace('.', ','); }

// --- Ansicht über Neuaufbauten hinweg erhalten (Scrollposition + aufgeklappte Bereiche) --------
// Jede Aktion (Speichern, Live-Update eines Kollegen, Filter) baut die Seite komplett neu auf. Ohne Hilfe
// springt man dabei nach ganz oben, aufgeklappte Verläufe schließen sich und seitlich gescrollte Bereiche
// stehen wieder links. Wir merken den Zustand fortlaufend PRO SEITE und stellen ihn nach dem Neuaufbau
// wieder her — bei einem echten Seitenwechsel wird bewusst oben gestartet.
const _viewState = { route: null, scroll: 0, open: new Set(), boxes: {}, frisch: false };
// Waehrend die Seite neu aufgebaut wird, springt der Browser von selbst (der Inhalt ist kurz weg,
// die Seite schrumpft, die Position wird auf 0 geklemmt). Dieses Springen darf NICHT als
// „der Nutzer hat gescrollt" verbucht werden — sonst merkt sich die App 0 und die muehsam
// gescrollte Position ist verloren.
let _imNeuaufbau = false;
const _SCROLLBOX_SEL = '.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll';

// Stabile Kennung eines aufklappbaren Bereichs (ohne die kann er nicht wiedererkannt werden).
function _viewKey(el, i) {
  return el.id || el.dataset.id || el.dataset.absKey || el.dataset.uiKey || (el.className ? el.className + '#' + i : null);
}

function viewStateSave() {
  _viewState.route = getRoute();
  _viewState.scroll = window.scrollY || document.documentElement.scrollTop || 0;
  const open = new Set();
  document.querySelectorAll('details[open]').forEach((d, i) => { const k = _viewKey(d, i); if (k) open.add(k); });
  _viewState.open = open;
  const boxes = {};
  document.querySelectorAll(_SCROLLBOX_SEL).forEach((b, i) => {
    if (b.scrollLeft || b.scrollTop) boxes[(b.className || 'box') + '#' + i] = { l: b.scrollLeft, t: b.scrollTop };
  });
  _viewState.boxes = boxes;
}

function viewStateRestore() {
  if (_viewState.route !== getRoute()) {
    // Neue Seite → EINMAL nach oben. Das „einmal" ist entscheidend: ohne es riss jede spätere
    // DOM-Änderung die Seite erneut hoch — auf der Willkommensseite tickt die Uhr im Sekundentakt,
    // man scrollte also nach unten und wurde jede Sekunde wieder nach oben geworfen.
    if (_viewState.frisch) { _viewState.frisch = false; window.scrollTo(0, 0); }
    return;
  }
  document.querySelectorAll('details').forEach((d, i) => {
    const k = _viewKey(d, i);
    if (k && _viewState.open.has(k)) d.open = true;
  });
  document.querySelectorAll(_SCROLLBOX_SEL).forEach((b, i) => {
    const s = _viewState.boxes[(b.className || 'box') + '#' + i];
    if (s) { b.scrollLeft = s.l; b.scrollTop = s.t; }
  });
  // Die senkrechte Position nur anfassen, wenn sie wirklich abweicht. Da beim Scrollen sofort
  // mitgeschrieben wird, stimmen Merker und Wirklichkeit im Normalfall ueberein — es passiert also
  // gar nichts und die Wiederherstellung kann nicht gegen den Finger kaempfen.
  const jetzt = window.scrollY || document.documentElement.scrollTop || 0;
  if (_viewState.scroll > 0 && Math.abs(jetzt - _viewState.scroll) > 4) window.scrollTo(0, _viewState.scroll);
}

// Beim echten Seitenwechsel verwerfen, damit die neue Seite oben startet (und nicht die Position der alten erbt).
function viewStateReset() {
  _viewState.route = null; _viewState.scroll = 0; _viewState.open = new Set(); _viewState.boxes = {};
  _viewState.frisch = true;   // der EINE Sprung nach oben steht noch aus
}

// Zustand fortlaufend mitschreiben …
let _saveTimer = null;
const _scheduleSave = () => { clearTimeout(_saveTimer); _saveTimer = setTimeout(viewStateSave, 120); };
// Beim Scrollen NUR die Position merken — sofort und ohne die Seite zu durchsuchen.
// Vorher lief hier alle 120 ms ein querySelectorAll über sämtliche <details> und Scrollboxen; das
// kostete waehrend des Scrollens spuerbar Zeit. Und weil der Wert dadurch bis zu 120 ms alt war,
// stellte ein zwischenzeitlicher Neuaufbau eine veraltete Position wieder her → Rueckwaerts-Sprung.
window.addEventListener('scroll', () => {
  if (_imNeuaufbau) return;   // vom Neuaufbau verursacht, nicht vom Nutzer
  _viewState.route = getRoute();
  _viewState.scroll = window.scrollY || document.documentElement.scrollTop || 0;
  _viewState.frisch = false;   // der Nutzer hat die Seite selbst positioniert
}, { passive: true });
document.addEventListener('toggle', (e) => { if (e.target && e.target.tagName === 'DETAILS') viewStateSave(); }, true);
document.addEventListener('scroll', (e) => {
  if (_imNeuaufbau) return;
  if (e.target && e.target.matches && e.target.matches(_SCROLLBOX_SEL)) _scheduleSave();
}, true);

// … und nach jedem Neuaufbau der Hauptfläche automatisch wiederherstellen. Zentral per Beobachter, damit es
// für JEDE Seite gilt und nicht an ~19 Render-Stellen einzeln gepflegt werden muss.
let _restorePending = false;
function initViewStateKeeper() {
  const app = document.getElementById('app');
  if (!app || app._viewKeeper) return;
  app._viewKeeper = true;
  new MutationObserver((eintraege) => {
    // Reine Text-Änderungen sind KEIN Neuaufbau und dürfen nichts auslösen. Wichtigstes Beispiel:
    // die Uhr auf der Willkommensseite schreibt jede Sekunde ihren Text neu — dabei wird nur ein
    // Textknoten getauscht. Das löste bisher jede Sekunde eine Wiederherstellung aus.
    const strukturell = eintraege.some(m =>
      [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1));
    if (!strukturell) return;
    if (_restorePending) return;
    _restorePending = true;
    _imNeuaufbau = true;
    requestAnimationFrame(() => {
      _restorePending = false;
      try { viewStateRestore(); } catch (_) {}
      // Kurzer Nachlauf: das vom Umbau ausgeloeste Scroll-Ereignis trifft teils erst danach ein.
      setTimeout(() => { _imNeuaufbau = false; }, 80);
    });
  }).observe(app, { childList: true, subtree: true });
}

// --- Render-Wettlauf verhindern ---------------------------------------------------------------
// Render-Funktionen laden erst Daten (await) und schreiben danach in .main. Kommt eine langsame Antwort
// verspätet an, würde sie den Inhalt der inzwischen geöffneten Seite überschreiben. Jede Render-Funktion
// zieht darum zu Beginn eine Marke; vor dem Schreiben wird geprüft, ob sie noch die aktuelle ist.
let _renderSeq = 0;
function renderToken() { return ++_renderSeq; }
function renderStale(tok) { return tok !== _renderSeq; }

// Ladefehler sichtbar machen statt den Spinner ewig drehen zu lassen (Baustelle ohne Empfang!).
// Zeigt Meldung + „Erneut versuchen"; der Knopf ruft die übergebene Funktion erneut auf.
function renderLoadError(target, msg, retryFn) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  const id = 'retry-' + Math.random().toString(36).slice(2);
  el.innerHTML = `<div class="load-error">
      <p><strong>&#9888; Konnte nicht geladen werden</strong></p>
      <p class="load-error-msg">${esc(msg || 'Keine Verbindung zum Server.')}</p>
      <button class="btn btn-outline" id="${id}">Erneut versuchen</button>
    </div>`;
  const btn = document.getElementById(id);
  if (btn && typeof retryFn === 'function') btn.addEventListener('click', () => retryFn());
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
  const regieText = rv === 0 ? 'Nein' : rv === 1 ? ('Ja – ' + esc(e.regie_user_name || '')) : REGIE_LABELS[rv] || 'Ja';
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

// Langer Druck zeigt die Details eines Eintrags (B7).
// Am Rechner erscheinen sie beim Drueberfahren mit der Maus — auf dem Handy gibt es kein
// „Drueberfahren", dort waere der einzige Weg, den Eintrag zum Bearbeiten zu oeffnen und wieder
// abzubrechen. Deshalb: gedrueckt halten = nachschauen, kurz tippen = wie bisher oeffnen.
// `htmlFor` wird erst beim Ausloesen aufgerufen, damit immer die aktuellen Daten gezeigt werden.
const LP_DAUER_MS = 500;      // ab hier gilt es als „gehalten"
const LP_WACKEL_PX = 8;       // Scrollen/Wischen bricht ab
const LP_SICHTBAR_MS = 4000;  // danach blendet die Sprechblase von selbst aus

// Nach dem Loslassen feuert der Browser noch einen Klick. Der darf nach einem langen Druck NICHT
// durchgehen, sonst zeigt die App die Details und oeffnet gleichzeitig das Bearbeiten-Formular.
// Der Riegel haengt am DOKUMENT: liegt der Finger auf dem Eintrag selbst (nicht auf einem
// Kind-Element), laufen Capture- und Bubble-Listener desselben Elements in REGISTRIERUNGS-
// reihenfolge — ein Riegel am Eintrag kaeme dann zu spaet, weil der vorhandene Klick-Handler
// frueher angemeldet wurde. Am Dokument greift Capture immer zuerst.
// Chrome schickt nach jeder Beruehrung zusaetzlich Maus-Ersatzereignisse (mouseover/mousemove),
// damit alte Seiten ohne Touch-Unterstuetzung funktionieren. Die duerfen den Hover-Tooltip NICHT
// ausloesen — sonst blitzt er auf dem Handy bei jedem Antippen und sogar beim Scrollen auf.
// Kurz nach einer Beruehrung gilt ein Mausereignis daher als unecht. Geraete mit Maus UND
// Touch (Convertible) behalten den Hover-Tooltip, sobald sie wirklich die Maus benutzen.
let _letzteBeruehrung = 0;
document.addEventListener('touchstart', () => { _letzteBeruehrung = Date.now(); }, { passive: true, capture: true });
document.addEventListener('touchend', () => { _letzteBeruehrung = Date.now(); }, { passive: true, capture: true });
function istMauszeiger() { return Date.now() - _letzteBeruehrung > 700; }

let _lpKlickSperren = false, _lpSperrTimer = null, _lpRiegelDa = false;
function _lpRiegelAnmelden() {
  if (_lpRiegelDa) return;
  _lpRiegelDa = true;
  document.addEventListener('click', ev => {
    if (!_lpKlickSperren) return;
    _lpKlickSperren = false;
    clearTimeout(_lpSperrTimer);
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
}

function attachLongPressTooltip(el, htmlFor) {
  _lpRiegelAnmelden();
  let timer = null, x = 0, y = 0, verrutscht = false;
  const stop = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchstart', ev => {
    if (!ev.touches || ev.touches.length !== 1) return;   // Zwei Finger = Zoomen, nicht halten
    verrutscht = false;
    x = ev.touches[0].clientX; y = ev.touches[0].clientY;
    stop();
    timer = setTimeout(() => {
      if (verrutscht) return;
      const html = htmlFor();
      if (!html) return;
      hideTooltip();
      showTooltip(html, x, y);
      setTimeout(hideTooltip, LP_SICHTBAR_MS);
      // Klick sperren. Falls doch keiner kommt (Finger wandert weg), nach kurzer Zeit loesen —
      // sonst schluckt der Riegel spaeter einen voellig unbeteiligten Klick.
      _lpKlickSperren = true;
      clearTimeout(_lpSperrTimer);
      _lpSperrTimer = setTimeout(() => { _lpKlickSperren = false; }, 1000);
    }, LP_DAUER_MS);
  }, { passive: true });
  el.addEventListener('touchmove', ev => {
    if (!ev.touches || !ev.touches.length) return;
    if (Math.abs(ev.touches[0].clientX - x) > LP_WACKEL_PX || Math.abs(ev.touches[0].clientY - y) > LP_WACKEL_PX) {
      verrutscht = true; stop();
    }
  }, { passive: true });
  el.addEventListener('touchend', stop, { passive: true });
  el.addEventListener('touchcancel', () => { stop(); _lpKlickSperren = false; }, { passive: true });
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
  const aufraeumen = dialogBarrierefrei(overlay);
  const finish = () => { document.removeEventListener('keydown', onKey); overlay.remove(); aufraeumen(); };
  const onKey = (e) => { if (e.key === 'Escape') finish(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(); });
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', finish);
  const ersteWahl = overlay.querySelector('.nav-choose-btn');
  if (ersteWahl) ersteWahl.focus();
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

let _letzteMeldung = 0;   // wann zuletzt etwas eingeblendet wurde (siehe Entwurfs-Hinweis)
function toast(msg, type, duration) {
  _letzteMeldung = Date.now();
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    // Ohne diese drei Angaben bleibt jede Rueckmeldung („gespeichert", „Bis-Zeit muss nach
    // Von-Zeit liegen") fuer einen Screenreader unsichtbar — sie taucht nur optisch auf.
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.setAttribute('aria-atomic', 'true');
    document.body.appendChild(t);
  }
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
// ================================================================
// Dialoge barrierefrei machen (B8b)
// ================================================================
// Bisher konnte man mit der Tabulatortaste AUS einem offenen Dialog heraus in die Seite dahinter
// wandern — man tippt dann blind in ein Formular, das man gar nicht sieht. Screenreader lasen die
// Seite dahinter ebenfalls weiter vor, und nach dem Schliessen landete der Fokus am Seitenanfang
// statt beim ausloesenden Knopf.
// Diese Funktion ergaenzt: Rolle + Beschriftung, Fokus bleibt im Dialog, Hintergrund wird fuer
// Screenreader ausgeblendet, und beim Schliessen kehrt der Fokus dorthin zurueck, wo er herkam.
// Rueckgabe: Aufraeum-Funktion, die NACH dem Entfernen des Overlays aufgerufen werden muss.
let _dialogNr = 0;
const FOKUSIERBAR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function dialogBarrierefrei(overlay) {
  const vorher = document.activeElement;
  const box = overlay.querySelector('.modal, .absence-form-card, .card') || overlay.firstElementChild || overlay;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const titel = box.querySelector('h2, h3, h4');
  if (titel) {
    if (!titel.id) titel.id = 'dlg-titel-' + (++_dialogNr);
    box.setAttribute('aria-labelledby', titel.id);
  }
  const felder = () => [...box.querySelectorAll(FOKUSIERBAR)]
    .filter(el => el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
  const onTab = (e) => {
    if (e.key !== 'Tab') return;
    const f = felder();
    if (!f.length) { e.preventDefault(); return; }
    const erster = f[0], letzter = f[f.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); erster.focus(); return; }
    if (e.shiftKey && document.activeElement === erster) { e.preventDefault(); letzter.focus(); }
    else if (!e.shiftKey && document.activeElement === letzter) { e.preventDefault(); erster.focus(); }
  };
  document.addEventListener('keydown', onTab, true);
  const app = document.getElementById('app');
  if (app) app.setAttribute('aria-hidden', 'true');
  return () => {
    document.removeEventListener('keydown', onTab, true);
    // Erst freigeben, wenn wirklich KEIN Dialog mehr offen ist (Dialog auf Dialog kommt vor).
    if (app && !document.querySelector('[role="dialog"]')) app.removeAttribute('aria-hidden');
    if (vorher && document.contains(vorher) && typeof vorher.focus === 'function') {
      try { vorher.focus(); } catch (_) {}
    }
  };
}

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
    const aufraeumen = dialogBarrierefrei(overlay);
    const finish = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); aufraeumen(); resolve(val); };
    // Enter bestätigt NUR harmlose Dialoge. Bei destruktiven (danger) würde ein versehentliches Enter —
    // etwa direkt nach dem Tippen in einem Formular — sonst „Löschen" auslösen. Dort ist bewusst ein Klick nötig.
    const onKey = (e) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter' && !danger) finish(true); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
    // Fokus bei destruktiven Dialogen auf „Abbrechen" (sichere Vorauswahl), sonst auf OK.
    overlay.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]').focus();
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
    const aufraeumen = dialogBarrierefrei(overlay);
    const finish = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); aufraeumen(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll('[data-val]').forEach(b => b.addEventListener('click', () => finish(b.dataset.val)));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    const ersterKnopf = overlay.querySelector('[data-val]') || overlay.querySelector('[data-act="cancel"]');
    if (ersterKnopf) ersterKnopf.focus();   // Fokus MUSS in den Dialog, sonst greift die Falle nicht
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
    const aufraeumen = dialogBarrierefrei(overlay);
    const input = overlay.querySelector('#pm-input');
    const errEl = overlay.querySelector('#pm-error');
    const finish = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); aufraeumen(); resolve(val); };
    const submit = () => {
      if (opts.required && !input.value.trim()) {
        errEl.textContent = opts.requiredMsg || 'Pflichtfeld – bitte ausfüllen.';
        errEl.style.display = '';
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'pm-error');
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

// Arbeitszeit-Vorgaben der Firma holen (einmal je Sitzung). Eigener, schmaler Endpunkt: die
// vollständigen Einstellungen darf nur Chef/Admin lesen, diese drei Werte braucht aber jeder —
// sonst wäre die Vorbelegung für Mitarbeiter falsch.
// Bei Netzproblemen gelten dieselben Rückfallwerte wie im Backend (07:00 / 8 h / 30 min), damit die
// Vorbelegung nie leer bleibt.
const ARBEITSZEIT_RUECKFALL = { work_start_default: '07:00', work_hours_per_day: 8, break_minutes_default: 30 };
async function ladeArbeitszeit() {
  if (S.arbeitszeit) return S.arbeitszeit;
  try {
    const d = await api('GET', '/api/settings/arbeitszeit');
    S.arbeitszeit = (d && d.arbeitszeit) || ARBEITSZEIT_RUECKFALL;
  } catch (_) { S.arbeitszeit = ARBEITSZEIT_RUECKFALL; }
  return S.arbeitszeit;
}
function arbeitszeitJetzt() { return S.arbeitszeit || ARBEITSZEIT_RUECKFALL; }

// ── Abrechnungs-Abschluss ────────────────────────────────────────────────────────────────────
// Der Stichtag, bis zu dem alles abgerechnet und damit schreibgeschützt ist (null = nichts
// abgeschlossen, dann verhält sich die App wie vorher).
//
// Die Anzeige ist NUR Höflichkeit — gesperrt wird serverseitig. Ein ausgegrauter Knopf ist keine
// Sperre; deshalb ist es auch unkritisch, wenn dieser Wert einmal veraltet ist.
async function ladeAbschluss(frisch) {
  if (S.abschluss && !frisch) return S.abschluss;
  try {
    const d = await api('GET', '/api/closure');
    S.abschluss = d || { bis: null, perioden: [] };
  } catch (_) { S.abschluss = { bis: null, perioden: [] }; }
  return S.abschluss;
}
function abgerechnetBisJetzt() { return (S.abschluss && S.abschluss.bis) || null; }
function istAbgerechnet(datum) {
  const bis = abgerechnetBisJetzt();
  return !!(bis && datum && String(datum).slice(0, 10) <= bis);
}
// „2026-06-30" → „30.06.2026"
function datumDe(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}
const ABGERECHNET_HINWEIS = (bis) =>
  `Dieser Zeitraum ist abgerechnet (bis ${datumDe(bis)}) und kann nicht mehr geändert werden.`;

// Standard-Tagesspanne aus den Firmenvorgaben: von = Arbeitsbeginn, bis = Beginn + Arbeitszeit + Pause.
// Mit den Vorgabewerten kommt genau 07:00–15:30 / 30 min heraus — also exakt das, was bisher fest
// im Code stand.
function standardTag() {
  const a = arbeitszeitJetzt();
  const [h, m] = String(a.work_start_default).split(':').map(Number);
  const startMin = h * 60 + m;
  const endeMin = startMin + Math.round(Number(a.work_hours_per_day) * 60) + Number(a.break_minutes_default);
  const fmt = (min) => {
    const g = ((min % 1440) + 1440) % 1440;                 // über Mitternacht hinaus umbrechen
    return String(Math.floor(g / 60)).padStart(2, '0') + ':' + String(g % 60).padStart(2, '0');
  };
  return { von: fmt(startMin), bis: fmt(endeMin), pause: Number(a.break_minutes_default) };
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

// ================================================================
// Suchfeld fuer Listen (B6)
// ================================================================
// Werkzeuge, Mitarbeiter, Dokumente, Bestellungen und der Papierkorb hatten keine Suche —
// man scrollte. Der Papierkorb waechst wegen der Revisionssicherheit sogar dauerhaft.
// Gefiltert wird IM BROWSER: die Listen sind ohnehin schon vollstaendig geladen, eine neue
// Server-Abfrage waere nur Wartezeit. Der Suchbegriff liegt neben der Liste (nicht im DOM),
// damit er einen Neuaufbau ueberlebt — z. B. wenn ein Kollege etwas speichert und das
// Live-Update die Liste neu zeichnet.
const _listenSuche = {};

function sucheBegriff(key) { return (_listenSuche[key] || '').trim().toLowerCase(); }
// Alle eingegebenen Woerter muessen vorkommen (egal in welchem Feld und in welcher Reihenfolge)
// — „bohr gross" findet die grosse Bohrmaschine.
function sucheTrifft(key, ...texte) {
  const q = sucheBegriff(key);
  if (!q) return true;
  const heu = texte.filter(t => t != null && t !== '').join(' ').toLowerCase();
  return q.split(/\s+/).every(w => heu.includes(w));
}
function listenSucheHtml(key, platzhalter) {
  return `<div class="list-search">
    <input type="search" class="form-control list-search-input" id="ls-${esc(key)}"
      placeholder="${esc(platzhalter || 'Suchen …')}" value="${esc(_listenSuche[key] || '')}"
      autocomplete="off" data-kein-entwurf="1" aria-label="${esc(platzhalter || 'Liste durchsuchen')}">
    <span class="list-search-count" id="ls-count-${esc(key)}"></span>
  </div>`;
}
// Gefiltert wird durch AUSBLENDEN einzelner Zeilen, nicht durch Neubauen der Liste.
// Damit bleiben alle bereits verdrahteten Knoepfe funktionsfaehig, das Suchfeld behaelt den
// Fokus, und es entsteht kein neuer Wettlauf mit den Live-Updates.
// Jede durchsuchbare Zeile traegt dafuer ein data-suchtext mit ihren sichtbaren Angaben.
function listenSucheAnwenden(key, containerSel) {
  const c = document.querySelector(containerSel);
  if (!c) return;
  const zeilen = [...c.querySelectorAll('[data-suchtext]')];
  let sichtbar = 0;
  zeilen.forEach(el => {
    const treffer = sucheTrifft(key, el.dataset.suchtext);
    el.style.display = treffer ? '' : 'none';
    if (treffer) sichtbar++;
  });
  sucheAnzahl(key, sichtbar, zeilen.length);
  // Der Hinweis kommt HINTER die Liste, nicht hinein: in einem <tbody> waere ein <div> ungueltiges
  // HTML, und der Browser wuerde es aus der Tabelle heraussortieren.
  const anker = c.closest('table') || c;
  let leer = anker.parentNode && anker.parentNode.querySelector(':scope > .list-search-empty');
  if (sucheBegriff(key) && sichtbar === 0 && zeilen.length) {
    if (!leer && anker.parentNode) {
      leer = document.createElement('div');
      leer.className = 'empty-state list-search-empty';
      anker.parentNode.insertBefore(leer, anker.nextSibling);
    }
    if (leer) {
      leer.textContent = 'Kein Treffer für „' + (_listenSuche[key] || '') + '".';
      leer.style.display = '';
    }
  } else if (leer) leer.style.display = 'none';
}
function bindListenSuche(key, containerSel) {
  const el = document.getElementById('ls-' + key);
  if (!el) return;
  const anwenden = () => { _listenSuche[key] = el.value; listenSucheAnwenden(key, containerSel); };
  el.addEventListener('input', anwenden);
  el.addEventListener('search', anwenden);        // das „x" im Suchfeld
  listenSucheAnwenden(key, containerSel);         // gemerkten Begriff nach einem Neuaufbau anwenden
}
function sucheAnzahl(key, sichtbar, gesamt) {
  const el = document.getElementById('ls-count-' + key);
  if (!el) return;
  el.textContent = sucheBegriff(key) ? `${sichtbar} von ${gesamt}` : '';
}

// ================================================================
// Entwurfs-Sicherung fuer Formulare (B4)
// ================================================================
// Warum ueberhaupt: Kommt waehrend des Ausfuellens ein Anruf, geht die App in den Hintergrund.
// Hat das Handy zu wenig Speicher, BEENDET das Betriebssystem sie — ohne Vorwarnung und ohne
// Gelegenheit fuer eine Rueckfrage ('beforeunload' feuert auf Mobilgeraeten dabei nicht).
// Der einzige verlaessliche Zeitpunkt ist 'visibilitychange' → hidden: der feuert bei Anruf,
// Home-Taste und Bildschirm-Aus. Genau dort (und nebenbei beim Tippen) sichern wir.
const ENTWURF_PRAEFIX = 'entwurf:';
const ENTWURF_MAX_ALTER_MS = 24 * 60 * 60 * 1000;   // aeltere Entwuerfe nicht mehr anbieten
const ENTWURF_SPEICHER_MS = 400;                    // Tippen entschaerfen
let _entwuerfe = [];                                // gerade offene Formulare

function _entwurfSchluessel(name) {
  return ENTWURF_PRAEFIX + ((S.user && S.user.id) || 'anon') + ':' + name;
}
// Nur echte Eingabefelder mit stabiler Kennung. Dateien und Passwoerter bleiben aussen vor:
// Dateien lassen sich ohnehin nicht wiederherstellen, Passwoerter haben in localStorage nichts verloren.
function _entwurfFelder(container) {
  return [...container.querySelectorAll('input, textarea, select')]
    .filter(el => (el.id || el.name) && el.type !== 'file' && el.type !== 'password' && !el.dataset.keinEntwurf);
}
function _entwurfLesen(container) {
  const daten = {};
  _entwurfFelder(container).forEach(el => {
    const k = el.id || el.name;
    if (el.type === 'checkbox' || el.type === 'radio') daten[k] = el.checked;
    else if (el.multiple) daten[k] = [...el.selectedOptions].map(o => o.value);
    else daten[k] = el.value;
  });
  return daten;
}
// Reihenfolge ist hier entscheidend:
//   1. Auswahlfelder/Haken setzen und ihre Aenderung melden — an ihnen haengt das Ein-/Ausblenden
//      abhaengiger Bloecke (Regie-Empfaenger, Freitextfeld) UND Automatik, die andere Felder
//      ueberschreibt: die Projekt-Auswahl traegt z. B. Adresse, Kunde und Notiz des Projekts ein.
//   2. ERST DANACH die uebrigen Felder schreiben. Andersherum wuerde genau diese Automatik das
//      gerade Wiederhergestellte wieder zerstoeren.
// Bei Text-/Datums-/Zeitfeldern wird bewusst KEIN 'change' gemeldet — daran haengt u. a. der
// Startzeit-Vorschlag, der die wiederhergestellte Uhrzeit ueberschreiben wuerde.
function _entwurfSchreiben(container, daten) {
  const istAuswahl = el => el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio';
  const setzen = el => {
    const k = el.id || el.name;
    if (!(k in daten)) return;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!daten[k];
    else if (el.multiple) [...el.options].forEach(o => { o.selected = (daten[k] || []).includes(o.value); });
    else el.value = daten[k];
  };
  const felder = _entwurfFelder(container);
  felder.filter(istAuswahl).forEach(el => { setzen(el); el.dispatchEvent(new Event('change', { bubbles: true })); });
  felder.filter(el => !istAuswahl(el)).forEach(el => {
    setzen(el);
    if (el.disabled) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));   // Anzeigen wie „netto Stunden" nachziehen
  });
}
function entwurfLoeschen(name) {
  try { localStorage.removeItem(_entwurfSchluessel(name)); } catch (_) {}
  _entwuerfe = _entwuerfe.filter(e => e.name !== name);
}
function entwurfAllesLoeschen() {   // beim Abmelden: auf geteilten Geraeten darf nichts stehen bleiben
  try {
    Object.keys(localStorage).filter(k => k.startsWith(ENTWURF_PRAEFIX)).forEach(k => localStorage.removeItem(k));
  } catch (_) {}
  _entwuerfe = [];
}
function _entwurfAufraeumen() {     // abgelaufene Entwuerfe stillschweigend entsorgen
  try {
    Object.keys(localStorage).filter(k => k.startsWith(ENTWURF_PRAEFIX)).forEach(k => {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(k)); } catch (_) {}
      if (!d || !d.t || Date.now() - d.t > ENTWURF_MAX_ALTER_MS) localStorage.removeItem(k);
    });
  } catch (_) {}
}
// Speichert alle offenen Formulare, deren Inhalt sich seit dem Oeffnen geaendert hat.
// Rueckgabe: Anzahl gesicherter Entwuerfe (fuer den Hinweis beim Verlassen).
function entwuerfeSichern() {
  let n = 0;
  _entwuerfe = _entwuerfe.filter(e => document.contains(e.container));   // geschlossene Formulare raus
  _entwuerfe.forEach(e => {
    const jetzt = JSON.stringify(e.lesen());
    if (jetzt === e.ausgangswert) return;   // unveraendert → kein Entwurf
    try {
      localStorage.setItem(_entwurfSchluessel(e.name), JSON.stringify({ t: Date.now(), ...JSON.parse(jetzt) }));
      n++;
    } catch (_) { /* Speicher voll: lieber nichts sichern als abstuerzen */ }
  });
  return n;
}

// opt.zusatzLesen/zusatzSchreiben: fuer Zustand, der NICHT in Eingabefeldern mit Kennung steht.
// Beispiel Planung: die ausgewaehlten Tage liegen in einer JS-Liste, ihre Zeilen haben nur
// data-idx. Ohne diesen Haken wuerde ein Entwurf die Mehrtages-Auswahl verlieren.
function initDraftKeeper(container, name, opt) {
  if (!container) return;
  opt = opt || {};
  _entwurfAufraeumen();
  const lesen = () => ({ f: _entwurfLesen(container), z: opt.zusatzLesen ? opt.zusatzLesen() : null });
  const ausgangswert = JSON.stringify(lesen());
  _entwuerfe = _entwuerfe.filter(e => e.name !== name && document.contains(e.container));
  _entwuerfe.push({ container, name, ausgangswert, lesen, opt });

  let timer = null;
  container.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(entwuerfeSichern, ENTWURF_SPEICHER_MS); });
  container.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(entwuerfeSichern, ENTWURF_SPEICHER_MS); });

  // Liegt ein Entwurf vor, der sich vom gerade geladenen Stand unterscheidet? Dann anbieten —
  // nicht stillschweigend einsetzen, sonst stehen ploetzlich Werte da, die man nicht getippt hat.
  let gespeichert = null;
  try { gespeichert = JSON.parse(localStorage.getItem(_entwurfSchluessel(name)) || 'null'); } catch (_) {}
  if (!gespeichert || !gespeichert.f) return;
  if (Date.now() - (gespeichert.t || 0) > ENTWURF_MAX_ALTER_MS) { entwurfLoeschen(name); return; }
  if (JSON.stringify({ f: gespeichert.f, z: gespeichert.z || null }) === ausgangswert) { entwurfLoeschen(name); return; }

  const zeit = new Date(gespeichert.t);
  const heute = zeit.toDateString() === new Date().toDateString();
  const wann = (heute ? '' : zeit.toLocaleDateString('de-DE') + ', ')
    + zeit.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const leiste = document.createElement('div');
  leiste.className = 'draft-bar';
  leiste.innerHTML = `<span>Nicht gespeicherter Entwurf von ${esc(wann)} gefunden.</span>
    <span class="draft-bar-actions">
      <button type="button" class="btn btn-sm btn-primary" id="entwurf-uebernehmen">Wiederherstellen</button>
      <button type="button" class="btn btn-sm btn-outline" id="entwurf-verwerfen">Verwerfen</button>
    </span>`;
  container.insertBefore(leiste, container.firstChild);
  leiste.querySelector('#entwurf-uebernehmen').addEventListener('click', () => {
    // Zusatz-Zustand ZUERST (er baut z. B. die Tageszeilen neu auf), dann die Felder.
    if (opt.zusatzSchreiben && gespeichert.z) opt.zusatzSchreiben(gespeichert.z);
    _entwurfSchreiben(container, gespeichert.f);
    leiste.remove();
    toast('Entwurf wiederhergestellt', 'success');
  });
  leiste.querySelector('#entwurf-verwerfen').addEventListener('click', () => {
    entwurfLoeschen(name);
    leiste.remove();
    // Formular bleibt registriert, damit ab jetzt neu Getipptes wieder gesichert wird.
    _entwuerfe.push({ container, name, ausgangswert, lesen, opt });
  });
}

// App geht in den Hintergrund (Anruf, Home-Taste, Bildschirm aus) → der verlaessliche Moment.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') entwuerfeSichern(); });
window.addEventListener('pagehide', entwuerfeSichern);
// Seitenwechsel: sichern und kurz Bescheid geben. Dieser Listener wird VOR dem render()-Listener
// in app-8 angemeldet (Datei laedt frueher) und laeuft daher noch am alten Formular.
window.addEventListener('hashchange', () => {
  if (entwuerfeSichern() === 0) return;
  // Der Hinweis ist die unwichtigste Meldung der App — er darf NIE eine andere ueberdecken.
  // Beispiel: ein inzwischen geloeschter Aushang meldet „existiert nicht mehr" und springt
  // zurueck; dabei feuert ein zweites hashchange. Ohne diese Sperre haette der Entwurfs-Hinweis
  // die Erklaerung ueberschrieben und der Nutzer haette nie erfahren, warum er wieder in der
  // Liste steht. Es gibt nur EIN Meldungsfeld, jede Meldung ersetzt die vorherige.
  if (Date.now() - _letzteMeldung < 3000) return;
  toast('Entwurf gesichert', 'success');
});

function render() {
  const r0 = getRoute();
  // Rechtsseiten sind bewusst OHNE Login erreichbar (Impressumspflicht) → vor dem Auth-Guard behandeln.
  if (r0 === '/impressum' || r0 === '/datenschutz') { renderLegal(r0.slice(1)); return; }
  S._lastRoute = r0; // letzte „echte" Seite merken → „Zurück" aus Impressum/Datenschutz kehrt dorthin zurück
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

