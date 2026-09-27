// Gästeseite einer Notiz (Etappe C, 27.09.2026) — Link: /gast#<Kennung>.
//
// Eine eigene, schlanke Seite: keine App, kein Menü, keine Daten der Firma außer dieser einen Notiz.
// Die Kennung steht hinter dem #: Sie geht nie an einen Server (auch nicht ins Protokoll eines
// Proxys) und steht in keiner Vorschau, die ein Messenger vom Link baut. Zum Server geht sie nur
// zusammen mit dem Passwort, einmal, beim Anmelden.
//
// Gemerkt wird nur die Anmeldung (7 Tage, solange das Passwort gleich bleibt), nie das Passwort.
// Die gemeinsame Bearbeitung ist DIESELBE wie in der App (notiz-sitzung.js) — nur über andere Wege
// (/api/gast/…) und ohne Titel ändern, Projekt, Kopie.
//
// Die kleinen Helfer unten (esc, toast, Dialoge, Download) entsprechen denen der App (app-1-core.js),
// die hier bewusst NICHT geladen wird: Sie liest die Anmeldung eines Mitarbeiters und hängt die
// ganze App mit an — ein Gast auf einem Firmen-Handy wäre sonst plötzlich halb in der App.
'use strict';

// ─── Kleine Helfer (wie in der App) ──────────────────────────────────────────────────────────

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, type, dauer, aktion) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); t.setAttribute('aria-atomic', 'true');
    t.addEventListener('click', (ev) => { if (ev.target.closest('.toast-aktion')) return; clearTimeout(t._zu); t.classList.remove('show'); });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  if (aktion && aktion.text) {
    const k = document.createElement('button');
    k.type = 'button'; k.className = 'toast-aktion'; k.textContent = aktion.text;
    k.addEventListener('click', () => { clearTimeout(t._zu); t.classList.remove('show'); aktion.beiKlick(); }, { once: true });
    t.appendChild(k);
  }
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._zu);
  t._zu = setTimeout(() => t.classList.remove('show'), dauer || (type === 'error' ? 8000 : 4000));
}

function dialog(html, beiKlick) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  const box = overlay.querySelector('.modal');
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  const zu = (wert) => { document.removeEventListener('keydown', taste); overlay.remove(); beiKlick(wert); };
  const taste = (e) => { if (e.key === 'Escape') zu(null); };
  document.addEventListener('keydown', taste);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) zu(null); });
  overlay.querySelectorAll('[data-val]').forEach(b => b.addEventListener('click', () => zu(b.dataset.val)));
  const erster = overlay.querySelector('[data-val]'); if (erster) erster.focus();
}
function choiceModal(message, choices, opts = {}) {
  return new Promise((fertig) => dialog(`<div class="modal" style="max-width:460px">
      <div class="modal-header"><h3>${esc(opts.title || 'Aktion wählen')}</h3></div>
      <div class="modal-body">${message ? `<p>${esc(message)}</p>` : ''}${choices.map(c =>
        `<button class="btn btn-outline" data-val="${esc(c.value)}" style="width:100%;margin-bottom:0.5rem;text-align:left">${esc(c.label)}</button>`).join('')}</div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem"><button class="btn btn-outline" data-val="">Abbrechen</button></div>
    </div>`, (w) => fertig(w || null)));
}
function confirmModal(message, opts = {}) {
  return new Promise((fertig) => dialog(`<div class="modal" style="max-width:440px">
      <div class="modal-header"><h3>${esc(opts.title || 'Bestätigen')}</h3></div>
      <div class="modal-body"><p>${esc(message)}</p></div>
      <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-val="">Abbrechen</button>
        <button class="btn btn-primary" data-val="ja">${esc(opts.okLabel || 'OK')}</button></div>
    </div>`, (w) => fertig(w === 'ja')));
}

function dateiHerunterladen(blob, dateiname) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = dateiname; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);   // Safari liest die Datei erst danach
}
function dateinameAus(antwort, ersatz) {
  const kopf = antwort.headers.get('Content-Disposition') || '';
  const utf8 = (kopf.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
  if (utf8) { try { return decodeURIComponent(utf8); } catch (_) { /* weiter */ } }
  return (kopf.match(/filename="([^"]+)"/) || [])[1] || ersatz;
}

// ─── Anmeldung ───────────────────────────────────────────────────────────────────────────────

const GAST = { kennung: decodeURIComponent((location.hash || '').slice(1)).trim(), token: null, sitzung: null };
const merkKey = () => 'notiz-gast:' + GAST.kennung.slice(0, 16);
function gemerkt() { try { return localStorage.getItem(merkKey()); } catch (_) { return null; } }
function merken(t) { try { localStorage.setItem(merkKey(), t); } catch (_) { /* privates Fenster: dann eben nur jetzt */ } }
function vergessen() { GAST.token = null; try { localStorage.removeItem(merkKey()); } catch (_) {} }

const bereich = () => document.getElementById('gast');

/** Anfrage an einen Gast-Weg. Wirft wie api() in der App: e.code vom Server, e.gastAbgemeldet, e.verbindung. */
async function gastApi(methode, url, daten) {
  let res;
  try {
    res = await fetch(url, { method: methode, headers: { 'Content-Type': 'application/json', ...(GAST.token ? { Authorization: 'Bearer ' + GAST.token } : {}) },
      body: daten ? JSON.stringify(daten) : undefined });
  } catch (_) {
    const e = new Error('Keine Verbindung zum Server. Sobald wieder Empfang da ist, noch einmal versuchen.'); e.verbindung = true; throw e;
  }
  let d = {};
  try { d = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = new Error(d.error || 'Das hat nicht geklappt.');
    e.code = d.code; e.status = res.status;
    // Anmeldung nicht mehr gültig (neues Passwort, entfernt, abgeschaltet, abgelaufen, Notiz weg) —
    // „nur lesen" dagegen ist eine normale Abweisung einer Änderung.
    if (res.status === 401 || (res.status === 403 && d.code !== 'NUR_LESEN')) e.gastAbgemeldet = true;
    throw e;
  }
  return d;
}

const GRUND = {
  'passwort-geaendert': 'Das Passwort wurde geändert. Bitte gib das neue Passwort ein.',
  'gast-passwort-geaendert': 'Das Passwort wurde geändert. Bitte gib das neue Passwort ein.',
  'gast-nicht-angemeldet': null,
  'gast-entfernt': 'Dein Zugang zu dieser Notiz wurde entfernt.',
  'gaeste-aus': 'Gastzugänge sind derzeit abgeschaltet.',
  'gast-abgelaufen': 'Dein Zugang zu dieser Notiz ist abgelaufen.',
  'geloescht': 'Diese Notiz gibt es nicht mehr.',
};
const grundVon = (x) => String(x || '').toLowerCase().replace(/_/g, '-');
// Mit dem Passwort wieder hinein? Nur, wenn es am Passwort bzw. an der fehlenden Anmeldung lag.
const mitPasswortWieder = (g) => g === 'passwort-geaendert' || g === 'gast-passwort-geaendert' || g === 'gast-nicht-angemeldet';

function gastRaus(grund) {
  const g = grundVon(grund);
  if (GAST.sitzung) { GAST.sitzung.beenden({ verwerfen: !mitPasswortWieder(g) }); GAST.sitzung = null; }
  if (g === 'zurueckgespielt') { setTimeout(gastStart, 1000); return; }   // neu öffnen, Anmeldung gilt weiter
  vergessen();
  if (mitPasswortWieder(g)) anmeldeMaske(GRUND[g]);
  else hinweis(GRUND[g] || 'Kein Zugang zu dieser Notiz.');
}

function hinweis(text) {
  document.title = 'Notiz';
  bereich().innerHTML = `<div class="card gast-karte"><h1>Notiz</h1><p>${esc(text)}</p>
    <p class="gast-klein">Wende dich an den, der dir den Link geschickt hat.</p></div>`;
}

function anmeldeMaske(meldung) {
  document.title = 'Notiz öffnen';
  bereich().innerHTML = `
    <form class="card gast-karte" id="gast-anmelden" autocomplete="off">
      <h1>Notiz öffnen</h1>
      <p>Du wurdest als Gast zu einer Notiz eingeladen. Bitte gib das Passwort ein, das du dazu bekommen hast.</p>
      ${meldung ? `<p class="gast-meldung" role="alert">${esc(meldung)}</p>` : ''}
      <label for="gast-pw">Passwort</label>
      <input type="password" id="gast-pw" class="form-control" autocomplete="current-password" required>
      <button type="submit" class="btn btn-primary" id="gast-los">Öffnen</button>
      <p class="gast-klein">Dieses Gerät merkt sich den Zugang 7 Tage lang. Auf einem fremden Gerät danach „Abmelden" tippen.</p>
    </form>`;
  const feld = document.getElementById('gast-pw');
  feld.focus();
  document.getElementById('gast-anmelden').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const knopf = document.getElementById('gast-los');
    knopf.disabled = true;
    try {
      const r = await gastApi('POST', '/api/gast/anmelden', { token: GAST.kennung, passwort: feld.value });
      GAST.token = r.token; merken(r.token);
      notizZeigen({ titel: r.titel, name: r.name, zugriff: r.zugriff });
    } catch (e) {
      knopf.disabled = false;
      if (e.status === 404 || (e.status === 403 && e.code !== 'GAST_GESPERRT')) { hinweis(e.message); return; }
      const alt = document.querySelector('.gast-meldung');
      if (alt) alt.textContent = e.message;
      else feld.insertAdjacentHTML('beforebegin', `<p class="gast-meldung" role="alert">${esc(e.message)}</p>`);
      feld.select();
    }
  });
}

// ─── Die Notiz ───────────────────────────────────────────────────────────────────────────────

function kollabLaden() {
  if (window.Kollab) return Promise.resolve(true);
  const laden = (el) => new Promise((fertig) => { el.onload = () => fertig(true); el.onerror = () => { el.remove(); fertig(false); }; document.head.appendChild(el); });
  const stil = document.createElement('link'); stil.rel = 'stylesheet'; stil.href = '/vendor/kollab.css';
  const skript = document.createElement('script'); skript.src = '/vendor/kollab.min.js';
  return Promise.all([laden(stil), laden(skript)]).then(([a, b]) => a && b && !!window.Kollab);
}

function gastWege() {
  return {
    speicherKey: 'notiz-live:gast:' + GAST.kennung.slice(0, 16),
    ticket: async () => (await gastApi('GET', '/api/gast/ticket')).ticket,
    stromUrl: (ticket) => `/api/gast/live?ticket=${encodeURIComponent(ticket)}`,
    senden: (art, daten) => gastApi('POST', `/api/gast/live/${art}`, daten),
    zumSchluss: () => (GAST.token ? { url: '/api/gast/live/aenderung', token: GAST.token } : null),
    // kein kopfSpeichern: Gäste ändern den Titel nicht
    herunterladen: async (format) => {
      let antwort;
      try { antwort = await fetch(`/api/gast/export/${format}`, { headers: { Authorization: 'Bearer ' + GAST.token } }); }
      catch (_) { toast('Keine Verbindung zum Server — die Datei konnte nicht geholt werden.', 'error'); return; }
      if (!antwort.ok) {
        let d = {}; try { d = await antwort.json(); } catch (_) {}
        if (antwort.status === 401 || antwort.status === 403) { gastRaus(d.code); return; }
        toast(d.error || 'Die Datei konnte nicht erstellt werden.', 'error'); return;
      }
      dateiHerunterladen(await antwort.blob(), dateinameAus(antwort, 'Notiz.' + format));
    },
    menue: NOTIZ_MENUE_DATEI,
    neuOeffnen: () => gastStart(),
    raus: gastRaus,
    nochDa: async () => {
      try { await gastApi('GET', '/api/gast/notiz'); return true; }
      catch (e) { if (e.gastAbgemeldet) { gastRaus(e.code); return false; } throw e; }
    },
    fertig: () => {},
  };
}

async function notizZeigen(info) {
  document.title = info.titel || 'Notiz';
  bereich().innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  if (!(await kollabLaden())) {
    bereich().innerHTML = '';
    hinweis('Das Schreibfeld konnte nicht geladen werden. Sobald wieder Empfang da ist, die Seite neu laden.');
    return;
  }
  bereich().innerHTML = `
    <div class="card notiz-editor gast-editor">
      <div class="notiz-editor-kopf">
        <div class="notiz-kopf-knoepfe">
          <button type="button" class="btn btn-outline btn-sm notiz-mehr" id="notiz-mehr" title="Drucken und Speichern als" aria-label="Drucken und Speichern als">&#8943;</button>
          <button type="button" class="btn btn-outline btn-sm" id="gast-abmelden">Abmelden</button>
        </div>
        <span class="notiz-status" id="notiz-status" role="status" aria-live="polite">Verbinde …</span>
      </div>
      <p class="gast-du">Du bist als Gast dabei: <strong>${esc(info.name)}</strong></p>
      <label class="sr-only" for="notiz-titel">Titel</label>
      <input type="text" id="notiz-titel" class="form-control notiz-titel" value="${esc(info.titel)}" disabled>
      ${notizFeldHtml()}
    </div>`;
  notizNamenSchalterBinden(bereich().querySelector('.notiz-editor'));
  document.getElementById('gast-abmelden').addEventListener('click', async () => {
    if (!(await confirmModal('Von dieser Notiz abmelden? Zum Wiederkommen brauchst du das Passwort.', { title: 'Abmelden', okLabel: 'Abmelden' }))) return;
    if (GAST.sitzung) { GAST.sitzung.beenden(); GAST.sitzung = null; }
    vergessen();
    anmeldeMaske('Du bist abgemeldet.');
  });
  if (GAST.sitzung) GAST.sitzung.beenden();
  GAST.sitzung = notizSitzungStarten('gast', gastWege());
  _notizSitzung = GAST.sitzung;   // wie in der App — Tests und Fähnchen finden die Sitzung dort
}

async function gastStart() {
  if (!GAST.kennung) { hinweis('Dieser Link ist unvollständig. Bitte öffne ihn genau so, wie du ihn bekommen hast.'); return; }
  GAST.token = gemerkt();
  if (!GAST.token) { anmeldeMaske(); return; }
  try {
    notizZeigen(await gastApi('GET', '/api/gast/notiz'));
  } catch (e) {
    if (e.gastAbgemeldet) { gastRaus(e.code); return; }
    hinweis(e.message);
  }
}

// Kommt die Seite aus dem Zwischenspeicher des Browsers zurück, ist die Sitzung beendet worden
window.addEventListener('pageshow', (e) => { if (e.persisted && !GAST.sitzung) gastStart(); });
window.addEventListener('hashchange', () => { if (GAST.sitzung) { GAST.sitzung.beenden(); GAST.sitzung = null; } location.reload(); });
gastStart();
