// --- Notizen live: Vorschau und gemeinsame Bearbeitung (Etappe A, Schritt 4 — 26.09.2026) ---
//
// Zwei Wege zu einer Notiz, bewusst getrennt (Alex, 26.09.2026):
//   * VORSCHAU in der Übersicht (Karte antippen): formatiert, aus dem zuletzt gespeicherten Stand.
//     Man ist damit NICHT „drin" — niemand sieht einen, und die eigenen Meldungen laufen weiter.
//   * ÖFFNEN (#/notes/<id>): gemeinsame Bearbeitung mit Cursorn, Anwesenheit und Knopfleiste.
//     „← Fertig" (oder jeder andere Seitenwechsel) beendet die Sitzung; es gibt kein Speichern.
//
// Der Draht: ein Ereignisstrom je Notiz (EventSource, 60-Sekunden-Ticket), Änderungen und Cursor als
// kurze POSTs — siehe notizen-live.js auf dem Server. Das Schreibfeld (Yjs + Quill) kommt aus
// /vendor/kollab.min.js und wird erst beim Öffnen geladen (notizEditorLaden, app-8).

let _notizSitzung = null;
// Rückweg in die Übersicht: Scrollposition und aufgeklappte Vorschau von vor dem Öffnen
let _notizListeZurueck = null;

const NOTIZ_FORMATE = ['bold', 'italic', 'underline', 'list'];
// So lange im Hintergrund, dann aus der Notiz abmelden. Als Objekt, damit ein Test die Minute
// verkürzen kann (tests/notizen-live-ui.js).
const notizZeiten = { hintergrundMs: 60 * 1000 };

// Base64 für die Yjs-Bytes (btoa kann nur Zeichenketten; in Stücken, sonst sprengt ein großer
// Stand die Argumentliste von fromCharCode).
function notizB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function notizAusB64(t) { return Uint8Array.from(atob(t), c => c.charCodeAt(0)); }

// ─── Vorschau: Formatierung sicher als HTML ─────────────────────────────────────────────────
//
// Aus dem Quill-Delta (`body_delta`, vom SERVER abgeleitet) wird HTML gebaut — Text immer über
// esc(), Formate nur aus einer festen Liste. Kein HTML vom Browser eines anderen landet je 1:1 in
// der Seite (Lehre aus A1, XSS).
function notizHtml(deltaJson, klartext) {
  let ops = null;
  try { ops = JSON.parse(deltaJson || ''); } catch (_) { /* Rückfall auf Klartext */ }
  if (!Array.isArray(ops)) {
    return `<div class="notiz-inhalt"><p>${esc(klartext || '').replace(/\n/g, '<br>')}</p></div>`;
  }
  const zeilen = []; let teile = [];
  for (const op of ops) {
    if (typeof op.insert !== 'string') continue;
    const a = op.attributes || {};
    const stuecke = op.insert.split('\n');
    stuecke.forEach((t, i) => {
      if (t) teile.push({ t, a });
      if (i < stuecke.length - 1) { zeilen.push({ teile, liste: a.list || null }); teile = []; }
    });
  }
  if (teile.length) zeilen.push({ teile, liste: null });
  const inline = (teile) => teile.map(({ t, a }) => {
    let h = esc(t);
    if (a.underline) h = `<u>${h}</u>`;
    if (a.italic) h = `<em>${h}</em>`;
    if (a.bold) h = `<strong>${h}</strong>`;
    return h;
  }).join('') || '<br>';
  let html = '', offen = null;
  const schliessen = () => { if (offen) { html += offen === 'ordered' ? '</ol>' : '</ul>'; offen = null; } };
  for (const z of zeilen) {
    const art = z.liste === 'ordered' ? 'ordered' : z.liste === 'bullet' ? 'bullet'
      : (z.liste === 'checked' || z.liste === 'unchecked') ? 'check' : null;
    if (art !== offen) {
      schliessen();
      if (art) { html += art === 'ordered' ? '<ol>' : art === 'check' ? '<ul class="notiz-check">' : '<ul>'; offen = art; }
    }
    if (art === 'check') {
      const erledigt = z.liste === 'checked';
      html += `<li class="${erledigt ? 'erledigt' : ''}"><span class="notiz-haken" aria-hidden="true">${erledigt ? '☑' : '☐'}</span>`
        + `<span class="sr-only">${erledigt ? 'erledigt: ' : 'offen: '}</span>${inline(z.teile)}</li>`;
    } else if (art) html += `<li>${inline(z.teile)}</li>`;
    else html += `<p>${inline(z.teile)}</p>`;
  }
  schliessen();
  return `<div class="notiz-inhalt">${html}</div>`;
}

// ─── Seite „Notiz geöffnet" ─────────────────────────────────────────────────────────────────

// opts.projektId: die Projektnotiz eines Projekts (28.09.2026) — Öffnen legt sie beim ersten Mal an
async function renderNotizEditor(id, opts = {}) {
  const projektId = opts.projektId ? Number(opts.projektId) : null;
  id = Number(id);
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', projektId ? 'projects' : 'notes');
  bindLayout();
  const fab = document.getElementById('fab-new'); if (fab) fab.remove();   // „+" gehört zur Übersicht

  const geladen = await seiteLaden(async () => {
    const [ok, pData, pn] = await Promise.all([notizEditorLaden(), api('GET', '/api/projects'),
      projektId ? api('POST', `/api/projects/${projektId}/notiz`) : null]);
    if (!ok) throw new Error('Das Schreibfeld konnte nicht geladen werden. Sobald wieder Empfang da ist, noch einmal versuchen.');
    return pData ? { pData, pn } : null;
  }, () => renderNotizEditor(id, opts));
  if (!geladen) return;
  if (geladen.pData) S.projects = geladen.pData.projects;
  if (projektId) {
    if (!geladen.pn || !geladen.pn.notiz) return;
    id = geladen.pn.notiz.id;
  }
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const projOpts = (S.projects || []).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  mainEl.innerHTML = `
    <div class="card notiz-editor">
      <div class="notiz-editor-kopf">
        <div class="notiz-kopf-knoepfe">
          <button type="button" class="btn btn-outline btn-sm" id="notiz-fertig">&larr; Fertig</button>
          <button type="button" class="btn btn-outline btn-sm notiz-mehr" id="notiz-mehr" title="Drucken und Speichern als" aria-label="Drucken und Speichern als">&#8943;</button>
        </div>
        <span class="notiz-status" id="notiz-status" role="status" aria-live="polite">Verbinde …</span>
      </div>
      <label class="sr-only" for="notiz-titel">Titel</label>
      <input type="text" id="notiz-titel" class="form-control notiz-titel" placeholder="Titel" autocomplete="off" disabled>
      ${projektId ? `<p class="notiz-projekt-hinweis">&#128221; Projektnotiz — lesen alle, schreiben Chef, Admin und die Zugeteilten</p>` : `<details class="notiz-projekt" id="notiz-projekt">
        <summary id="notiz-projekt-zeile">Projekt: –</summary>
        <div class="notiz-projekt-felder">
          <select id="notiz-projekt-wahl" class="form-control"><option value="">-- Kein Projekt --</option>${projOpts}</select>
          <input type="text" id="notiz-projekt-text" class="form-control" placeholder="Projekt (Freitext), z.B. Baustelle XY">
        </div>
      </details>`}
      ${notizFeldHtml()}
    </div>`;
  notizNamenSchalterBinden(mainEl.querySelector('.notiz-editor'));

  if (_notizSitzung) _notizSitzung.beenden();
  _notizSitzung = notizSitzungStarten(id, notizWegeApp(id, projektId));
}

// Der Teil des Editors, den App und Gästeseite (gast.js) gemeinsam haben: wer drin ist, Namensschilder,
// Hinweis bei Leserecht, Knopfleiste, Schreibfeld. Die Sitzung findet alles über diese Kennungen.
function notizFeldHtml() {
  return `
      <div class="notiz-anwesend" id="notiz-anwesend" aria-label="Gerade in der Notiz"></div>
      <label class="notiz-namen-schalter" for="notiz-namen"><input type="checkbox" id="notiz-namen" ${notizNamenZeigen() ? 'checked' : ''}> Namensschilder anzeigen</label>
      <p class="notiz-nur-lesen" id="notiz-nur-lesen" hidden>&#128065; Du kannst diese Notiz nur lesen — Änderungen der anderen siehst du live.</p>
      <div class="notiz-leiste" id="notiz-leiste" role="toolbar" aria-label="Formatierung">
        <span class="ql-formats">
          <button type="button" class="ql-bold" title="Fett" aria-label="Fett"></button>
          <button type="button" class="ql-italic" title="Kursiv" aria-label="Kursiv"></button>
          <button type="button" class="ql-underline" title="Unterstrichen" aria-label="Unterstrichen"></button>
        </span>
        <span class="ql-formats">
          <button type="button" class="ql-list" value="bullet" title="Aufzählung" aria-label="Aufzählung"></button>
          <button type="button" class="ql-list" value="ordered" title="Nummerierte Liste" aria-label="Nummerierte Liste"></button>
          <button type="button" class="ql-list" value="check" title="Checkliste" aria-label="Checkliste"></button>
        </span>
      </div>
      <div id="notiz-feld" class="notiz-feld"></div>`;
}

// Namensschilder ein/aus (Alex, 27.09.2026: sie verdecken kurz den Text dahinter). Aus = nur der
// farbige Cursor-Strich; wer es ist, verrät die Farbe in der Anwesenheit. Gemerkt je Gerät.
function notizNamenSchalterBinden(editorEl) {
  editorEl.classList.toggle('ohne-namen', !notizNamenZeigen());
  document.getElementById('notiz-namen').addEventListener('change', (e) => {
    try { localStorage.setItem('notiz-namen-zeigen', e.target.checked ? 'ja' : 'nein'); } catch (_) {}
    editorEl.classList.toggle('ohne-namen', !e.target.checked);
  });
}

function notizNamenZeigen() {
  try { return localStorage.getItem('notiz-namen-zeigen') !== 'nein'; } catch (_) { return true; }
}

// Kommt die Seite aus dem Zwischenspeicher des Browsers zurück (Handy: weg- und wieder hergewischt),
// ist die Sitzung beim Verlassen beendet worden — auf der Editor-Seite dann neu aufbauen.
window.addEventListener('pageshow', (e) => {
  if (typeof getRoute !== 'function') return;   // Gästeseite (gast.js) — dort gibt es keinen Router
  if (e.persisted && !_notizSitzung && /^\/notes\/\d+$/.test(getRoute())) render();
});

// Wird bei JEDEM Seitenwechsel aufgerufen (render(), app-1). Wer die Notiz verlässt, ist draußen.
function notizSitzungVerlassen() {
  if (_notizSitzung) _notizSitzung.beenden();
}

function notizZurueckZurListe() {
  // Kam man aus der Übersicht, ist „zurück" der richtige Weg — sonst stünde der Editor im Verlauf,
  // und die Zurück-Taste des Handys öffnete die Notiz gleich wieder.
  if (_notizListeZurueck && _notizListeZurueck.ausListe && history.length > 1) history.back();
  else navigate('/notes');
}

// ─── Drucken und „Speichern als" (Etappe B, 27.09.2026) ──────────────────────────────────────
//
// Drucken geschieht im Browser, aus dem Stand, der gerade im Schreibfeld steht: nur die Notiz, kein
// Menü, keine fremden Cursor. PDF, Word und ODT baut der Server (notiz-export.js), aus dem Stand
// von eben. Kopf überall gleich (Alex): Titel und darunter klein „Stand: TT.MM.JJJJ, HH:MM".

function notizStandText(d = new Date()) {
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function notizDrucken(titel, deltaJson, alsPdf) {
  document.getElementById('notiz-druck')?.remove();
  const bereich = document.createElement('div');
  bereich.id = 'notiz-druck';
  bereich.innerHTML = `<h1>${esc(titel)}</h1><p class="druck-stand">Stand: ${esc(notizStandText())}</p>${notizHtml(deltaJson)}`;
  document.body.appendChild(bereich);
  document.body.classList.add('notiz-druckt');
  const aufraeumen = () => { document.body.classList.remove('notiz-druckt'); bereich.remove(); window.removeEventListener('afterprint', aufraeumen); };
  window.addEventListener('afterprint', aufraeumen);
  // Nicht jeder Browser öffnet auf window.print() ein Druckfenster (als App vom Startbildschirm ist
  // das nicht überall sicher) — dann passierte einfach nichts. Kam kein Druckfenster, sagt die App
  // es und bietet das PDF an. Das Aufräumen bleibt bei „afterprint": Ist das Fenster doch offen,
  // darf der Druckbereich nicht verschwinden.
  let fensterKam = false;
  const kam = () => { fensterKam = true; };
  const druckMedium = window.matchMedia ? window.matchMedia('print') : null;
  const medium = (e) => { if (e.matches) kam(); };
  window.addEventListener('beforeprint', kam);
  if (druckMedium && druckMedium.addEventListener) druckMedium.addEventListener('change', medium);
  window.print();
  setTimeout(() => {
    window.removeEventListener('beforeprint', kam);
    if (druckMedium && druckMedium.removeEventListener) druckMedium.removeEventListener('change', medium);
    if (fensterKam) return;
    toast('Falls sich kein Druckfenster geöffnet hat: als PDF speichern und die Datei drucken.', 'warning', 15000,
      alsPdf ? { text: 'Als PDF speichern', beiKlick: alsPdf } : undefined);
  }, 2500);
  // Manche Handy-Browser melden „afterprint" nicht — spätestens nach einer Minute aufräumen
  setTimeout(() => { if (document.body.contains(bereich)) aufraeumen(); }, 60000);
}

async function notizHerunterladen(id, format) {
  let antwort;
  try {
    antwort = await fetch(`/api/notes/${id}/export/${format}`, { headers: { Authorization: 'Bearer ' + S.token } });
  } catch (_) { toast('Keine Verbindung zum Server — die Datei konnte nicht geholt werden.', 'error'); return; }
  if (!antwort.ok) {
    let text = 'Die Datei konnte nicht erstellt werden.';
    try { const d = await antwort.json(); if (d && d.error) text = d.error; } catch (_) {}
    toast(text, 'error'); return;
  }
  dateiHerunterladen(await antwort.blob(), dateinameAus(antwort, 'Notiz.' + format));
}

async function notizKopieAnlegen(id) {
  try {
    const r = await api('POST', `/api/notes/${id}/kopie`);
    if (!r || !r.note) return;
    toast('Eigene Notiz angelegt: ' + r.note.title, 'success');
    navigate('/notes/' + r.note.id);
  } catch (e) { toast(e.message, 'error'); }
}

// Drucken und Dateien — für Mitarbeiter UND Gäste
const NOTIZ_MENUE_DATEI = [
  { value: 'drucken', label: '🖨  Drucken' },
  { value: 'pdf', label: '📄  Als PDF speichern' },
  { value: 'docx', label: '📝  Als Word-Datei (.docx) speichern' },
  { value: 'odt', label: '📝  Als OpenDocument (.odt) speichern' },
];

// ─── Die Wege einer Sitzung ─────────────────────────────────────────────────────────────────
//
// Dieselbe Sitzung läuft in der App (Mitarbeiter) und auf der Gästeseite (gast.js, Etappe C). Alles,
// was zwischen beiden verschieden ist — Adressen, Anmeldung, wohin es nach einem Rauswurf geht —,
// steckt in diesem Objekt. Hier die Wege der App; gast.js baut seine eigenen.
function notizWegeApp(id, projektId = null) {
  const seite = projektId ? `/projects/${projektId}/notiz` : '/notes/' + id;
  const aufSeite = () => getRoute() === seite;
  // Zurück: aus der Übersicht bzw. vom Board gekommen → dorthin zurück (Scrollstelle bleibt)
  const zurueck = () => (projektId
    ? ((_notizListeZurueck && _notizListeZurueck.ausBoard && history.length > 1) ? history.back() : navigate('/projects'))
    : notizZurueckZurListe());
  return {
    speicherKey: 'notiz-live:' + id,
    ticket: async () => { const t = await api('GET', '/api/events/ticket'); return t && t.ticket; },
    stromUrl: (ticket) => `/api/notes/${id}/live?ticket=${encodeURIComponent(ticket)}`,
    senden: (art, daten) => api('POST', `/api/notes/${id}/live/${art}`, daten),
    // Letzter Versuch beim Verlassen (fetch mit keepalive, ohne api()): Adresse und Anmeldung
    zumSchluss: () => (S.token ? { url: `/api/notes/${id}/live/aenderung`, token: S.token } : null),
    // Projektnotiz: der Titel ist der Projektname (ändern nur beim Projekt)
    kopfSpeichern: projektId ? undefined : (daten) => api('PUT', `/api/notes/${id}`, daten),
    herunterladen: (format) => notizHerunterladen(id, format),
    menue: (zugriff) => [
      ...NOTIZ_MENUE_DATEI,
      { value: 'kopie', label: '📋  Stand als eigene Notiz' },
      // Gäste: eigene Notiz → die Eigentümerin; Projektnotiz → Chef und Admin
      ...((projektId ? ['chef', 'admin'].includes(S.user && S.user.role) : zugriff === 'owner') ? [{ value: 'gaeste', label: '🔗  Gäste verwalten' }] : []),
    ],
    menueExtra: (wahl) => { if (wahl === 'kopie') { notizKopieAnlegen(id); return true; } return false; },
    gaeste: () => notizGaesteDialog({ id, title: (document.getElementById('notiz-titel') || {}).value || '' }),
    // Nach einer Abweisung (Leserecht, zu groß, beschädigt) die Notiz neu öffnen
    neuOeffnen: () => { if (aufSeite()) renderNotizEditor(id, projektId ? { projektId } : {}); },
    raus: (grund) => {
      toast(grund === 'geloescht' ? 'Diese Notiz wurde gelöscht.'
        : grund === 'projekt-geloescht' ? 'Das Projekt wurde gelöscht — seine Notiz liegt mit im Papierkorb.'
        : grund === 'freigabe-entzogen' ? 'Die Freigabe dieser Notiz wurde dir entzogen.'
        : grund === 'zurueckgespielt' ? 'Eine Sicherung wurde zurückgespielt. Bitte öffne die Notiz neu.'
        : 'Du bist nicht mehr angemeldet.', 'error');
      if (aufSeite()) zurueck();
    },
    // Strom kam nie an: Gibt es die Notiz noch, und darf ich hinein? (EventSource verrät den Grund nicht.)
    // true = ja/unklar (später noch einmal), false = nein (dann ist `weg` schon erledigt)
    nochDa: async () => {
      if (projektId) {
        try { await api('GET', `/api/projects/${projektId}/notiz`); return true; }
        catch (e) {
          if (e.verbindung) throw e;
          toast('Dieses Projekt gibt es nicht mehr — seine Notiz ist nicht mehr erreichbar.', 'error');
          if (aufSeite()) zurueck();
          return false;
        }
      }
      const l = await api('GET', '/api/notes');
      if (l && !(l.notes || []).some(n => n.id === id)) {
        toast('Diese Notiz gibt es nicht mehr, oder sie ist nicht mehr für dich freigegeben.', 'error');
        if (aufSeite()) notizZurueckZurListe();
        return false;
      }
      return true;
    },
    fertig: () => zurueck(),
  };
}

// ─── Die Sitzung ────────────────────────────────────────────────────────────────────────────

function notizSitzungStarten(id, weg = notizWegeApp(id)) {
  const K = window.Kollab;
  const Y = K.Y, A = K.awarenessProtocol;
  const speicherKey = weg.speicherKey;
  const s = {
    id, offen: true, doc: new Y.Doc(), aw: null, quill: null, binding: null,
    es: null, verbindung: null, zugriff: null, du: null,
    warteschlange: [], sendet: false, sendeFehler: false, versuche: 0, gestartet: false,
    timer: { neu: null, hintergrund: null, anwesenheit: null, titel: null, sichern: null, nochmal: null }, faehnchen: new Map(),
  };
  s.aw = new A.Awareness(s.doc);
  const $ = (x) => document.getElementById(x);

  function status(text, art) {
    const el = $('notiz-status'); if (!el) return;
    el.textContent = text; el.dataset.art = art || '';
  }
  function statusNachWarteschlange() {
    if (!s.es || !s.verbindung || s.sendeFehler) status(s.warteschlange.length ? 'Keine Verbindung – wird nachgereicht' : 'Keine Verbindung', 'fehler');
    else if (s.warteschlange.length || s.sendet) status('Wird gespeichert …', 'laeuft');
    else status(s.zugriff === 'read' ? 'Nur lesen' : 'Gespeichert', 'ok');
  }

  // Noch nicht beim Server angekommene Änderungen auf dem Gerät sichern — ein Neuladen im Funkloch
  // soll nichts kosten. Beim nächsten Öffnen werden sie nachgereicht.
  //
  // Gesichert wird NUR die Warteschlange, nicht der ganze Stand der Notiz: Wird inzwischen eine
  // Sicherung zurückgespielt, mischte ein ganzer alter Stand die zurückgespielte Notiz wieder auf.
  // Einzelne Änderungen, deren Vorgänger im Dokument des Servers fehlen, hält Yjs dagegen zurück
  // (gefunden beim Durchlesen, 27.09.2026).
  const warteschlangeAlsEine = () => s.warteschlange.length === 1 ? s.warteschlange[0] : Y.mergeUpdates(s.warteschlange);
  function lokalSichern() {
    clearTimeout(s.timer.sichern);
    s.timer.sichern = setTimeout(() => {
      try {
        if (s.warteschlange.length) localStorage.setItem(speicherKey, notizB64(warteschlangeAlsEine()));
        else localStorage.removeItem(speicherKey);
      } catch (_) { /* privates Fenster o. ä. — dann eben nur im Speicher */ }
    }, 300);
  }
  try {
    const gesichert = localStorage.getItem(speicherKey);
    if (gesichert) Y.applyUpdate(s.doc, notizAusB64(gesichert), 'gesichert');
  } catch (_) {}

  // Schreibfeld
  s.quill = new K.Quill('#notiz-feld', {
    theme: 'snow', formats: NOTIZ_FORMATE, placeholder: 'Hier schreiben …', readOnly: true,
    modules: { toolbar: '#notiz-leiste', cursors: { transformOnTextChange: true },
      history: { userOnly: true } },   // Rückgängig nimmt nur die EIGENEN Änderungen zurück
  });
  // Die Verbindung Schreibfeld ↔ Dokument entsteht erst, wenn der Stand des Servers da ist (siehe
  // 'start'). Vorher ist das Dokument leer, Quill hat aber schon sein eigenes Schluss-Zeilenende —
  // kommt der Stand dann hinzu, bleibt dieses zusätzlich stehen: eine Leerzeile zu viel am Ende, in
  // die man hineintippt (gemessen 26.09.2026, dasselbe wie beim leeren Start in Schritt 2).
  const anbinden = () => {
    if (s.binding) return;
    s.binding = new K.QuillBinding(s.doc.getText('notiz'), s.quill, s.aw);
    s.quill.on('editor-change', () => stapelnBald());
  };

  // Eigene Änderungen → Warteschlange → Server (während eine Sendung läuft, sammeln sich die
  // nächsten Tastendrücke und gehen gebündelt hinterher).
  s.doc.on('update', (u, herkunft) => {
    if (herkunft === 'server') return;
    s.warteschlange.push(u);
    lokalSichern();
    senden();
  });

  async function senden() {
    if (s.sendet || !s.verbindung || !s.warteschlange.length || !s.offen) { statusNachWarteschlange(); return; }
    s.sendet = true; statusNachWarteschlange();
    const anzahl = s.warteschlange.length;
    const update = anzahl === 1 ? s.warteschlange[0] : Y.mergeUpdates(s.warteschlange);
    if (update.length > 70 * 1024) {
      // Würde schon an der Größengrenze des Servers scheitern — und dann endlos wiederholt.
      s.sendet = false;
      try { localStorage.removeItem(speicherKey); } catch (_) {}
      toast('Diese Änderung ist zu groß (z. B. ein sehr langer eingefügter Text) und wurde nicht übernommen.', 'error');
      s.beenden({ verwerfen: true });
      weg.neuOeffnen();
      return;
    }
    try {
      await weg.senden('aenderung', { verbindung: s.verbindung, update: notizB64(update) });
      s.warteschlange.splice(0, anzahl);
      s.sendeFehler = false;
      lokalSichern();
    } catch (e) {
      s.sendet = false;
      if (e.code === 'VERBINDUNG_WEG') { neuVerbinden(0); return; }
      if (e.code === 'NUR_LESEN' || e.code === 'ZU_GROSS' || e.code === 'BESCHAEDIGT') {
        // Das Gerät hat die Änderung schon bei sich eingetragen — neu öffnen, Stand des Servers übernehmen.
        try { localStorage.removeItem(speicherKey); } catch (_) {}
        toast(e.code === 'NUR_LESEN' ? 'Du kannst diese Notiz nur noch lesen. Deine letzte Änderung wurde nicht übernommen.' : e.message, 'error');
        s.beenden({ verwerfen: true });
        weg.neuOeffnen();
        return;
      }
      // Gast: Anmeldung weg (neues Passwort, entfernt, abgeschaltet) — die Gästeseite übernimmt
      if (e.gastAbgemeldet) { s.beenden({ verwerfen: false }); weg.raus(e.code); return; }
      // Funkloch: bleibt in der Warteschlange (und auf dem Gerät), in 3 s ein neuer Versuch —
      // der Ereignisstrom merkt das Funkloch oft erst viel später.
      s.sendeFehler = true;
      statusNachWarteschlange();
      clearTimeout(s.timer.nochmal);
      s.timer.nochmal = setTimeout(senden, 3000);
      return;
    }
    s.sendet = false;
    if (s.warteschlange.length) senden(); else statusNachWarteschlange();
  }

  // Cursor und Anwesenheit → Server (gebündelt, höchstens alle 150 ms)
  s.aw.on('update', (_, herkunft) => {
    if (herkunft === 'server' || !s.verbindung) return;
    if (s.timer.anwesenheit) return;
    s.timer.anwesenheit = setTimeout(anwesenheitSenden, 150);
  });
  function anwesenheitSenden() {
    s.timer.anwesenheit = null;
    if (!s.verbindung || !s.offen || !s.aw.getLocalState()) return;
    weg.senden('anwesenheit',
      { verbindung: s.verbindung, update: notizB64(A.encodeAwarenessUpdate(s.aw, [s.doc.clientID])) }).catch(() => {});
  }

  // Wer ist drin — und das Namensfähnchen am fremden Cursor. Am Handy gibt es kein Überfahren mit
  // der Maus; ohne das Einblenden sähe man nie, WESSEN Cursor das ist.
  s.aw.on('change', ({ added, updated }) => {
    anwesendeZeigen();
    const cursors = s.quill && s.quill.getModule('cursors');
    if (!cursors) return;
    for (const cid of added.concat(updated)) {
      if (cid === s.doc.clientID) continue;
      setTimeout(() => {   // y-quill legt den Cursor im selben Ereignis an — danach einblenden
        if (!s.offen) return;
        cursors.toggleFlag(String(cid), true);
        faehnchenStapeln();
        clearTimeout(s.faehnchen.get(cid));
        s.faehnchen.set(cid, setTimeout(() => { if (s.offen) { cursors.toggleFlag(String(cid), false); faehnchenStapeln(); } }, 3000));
      }, 0);
    }
  });

  // Stehen zwei an derselben Stelle, lägen ihre Namensfähnchen genau übereinander (Alex am
  // Bildschirmfoto, 27.09.2026). Sichtbare Fähnchen, die sich überdecken würden, stapeln sich
  // deshalb nach oben; in der ersten Zeile ist oben kein Platz — dort weichen sie unter die Zeile aus.
  // Verschoben wird über margin-top: Position und Breite setzt quill-cursors bei jeder Bewegung neu,
  // den Außenabstand fasst es nicht an.
  function faehnchenStapeln() {
    const feld = $('notiz-feld'); if (!feld || !s.offen) return;
    const alle = [...feld.querySelectorAll('.ql-cursor')].map(c => ({
      f: c.querySelector('.ql-cursor-flag'), caret: c.querySelector('.ql-cursor-caret-container') })).filter(x => x.f && x.caret);
    for (const x of alle) x.f.style.marginTop = '';
    const oben = (feld.querySelector('.ql-editor') || feld).getBoundingClientRect().top;
    const sichtbar = alle.filter(x => x.caret.classList.contains('hover') && x.f.offsetParent)
      .map(x => ({ ...x, r: x.f.getBoundingClientRect(), zeile: x.caret.getBoundingClientRect().height }))
      .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
    const belegt = [];
    const schneidet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const um = (r, dy) => ({ left: r.left, right: r.right, top: r.top + dy, bottom: r.bottom + dy });
    for (const x of sichtbar) {
      const h = x.r.height + 2;
      let dy = 0;
      while (belegt.some(b => schneidet(um(x.r, dy), b)) || x.r.top + dy < oben - 4) {
        if (x.r.top + dy - h >= oben - 4 && dy <= 0) dy -= h;       // nach oben stapeln, solange Platz ist
        else dy = dy <= 0 ? x.zeile + x.r.height : dy + h;          // sonst unter die Zeile ausweichen
        if (Math.abs(dy) > 20 * h) break;                            // Notbremse
      }
      if (dy) x.f.style.marginTop = dy + 'px';
      belegt.push(um(x.r, dy));
    }
  }
  // Nach jeder Bewegung im Text (quill-cursors setzt die Fähnchen dabei neu) und bei neuer Breite
  let stapelnGeplant = false;
  const stapelnBald = () => { if (stapelnGeplant) return; stapelnGeplant = true;
    requestAnimationFrame(() => { stapelnGeplant = false; faehnchenStapeln(); }); };
  window.addEventListener('resize', stapelnBald);
  function anwesendeZeigen() {
    const el = $('notiz-anwesend'); if (!el) return;
    const leute = new Map();
    for (const [cid, st] of s.aw.getStates()) {
      if (!st || !st.user) continue;
      // Das eigene zweite Fenster (Handy + Rechner) ist keine fremde Person
      const selbst = cid === s.doc.clientID || (s.du && st.user.name === s.du.name);
      const key = selbst ? '~du' : st.user.name;
      if (!leute.has(key)) leute.set(key, { name: selbst ? 'Du' : st.user.name, farbe: st.user.color, selbst });
    }
    const liste = [...leute.values()].sort((a, b) => (b.selbst - a.selbst) || a.name.localeCompare(b.name));
    el.innerHTML = liste.map(p => `<span class="notiz-person${p.selbst ? ' notiz-person--du' : ''}"><span class="notiz-punkt" style="background:${esc(p.farbe)}"></span>${esc(p.name)}</span>`).join('');
  }

  function zugriffSetzen(z, ansage) {
    const vorher = s.zugriff;
    s.zugriff = z;
    const lesen = z === 'read';
    s.quill.enable(!lesen);
    const leiste = $('notiz-leiste'); if (leiste) leiste.hidden = lesen;
    const hinweis = $('notiz-nur-lesen'); if (hinweis) hinweis.hidden = !lesen;
    const titel = $('notiz-titel'); if (titel) titel.disabled = lesen || !weg.kopfSpeichern;   // Gäste: Titel fest
    for (const x of ['notiz-projekt-wahl', 'notiz-projekt-text']) { const f = $(x); if (f) f.disabled = lesen; }
    if (ansage && vorher && vorher !== z) toast(lesen ? 'Du kannst diese Notiz jetzt nur noch lesen.' : 'Du kannst diese Notiz jetzt auch bearbeiten.', 'info');
    statusNachWarteschlange();
  }

  // Titel und Projekt: normale Felder, gespeichert kurz nach dem Tippen (der Text selbst läuft live).
  function kopfZeigen(k, erzwingen) {
    if (!k) return;
    const t = $('notiz-titel');
    if (t && (erzwingen || document.activeElement !== t)) t.value = k.title || '';
    const wahl = $('notiz-projekt-wahl'), frei = $('notiz-projekt-text');
    if (wahl && document.activeElement !== wahl) wahl.value = k.project_id ? String(k.project_id) : '';
    if (frei && document.activeElement !== frei) { frei.value = k.project_id ? '' : (k.project_text || ''); frei.disabled = !!k.project_id || s.zugriff === 'read'; }
    const zeile = $('notiz-projekt-zeile'); if (zeile) zeile.textContent = 'Projekt: ' + (k.project_text || '–');
  }
  function kopfSpeichernBald() {
    clearTimeout(s.timer.titel);
    s.timer.titel = setTimeout(kopfSpeichern, 700);
  }
  async function kopfSpeichern() {
    const titel = ($('notiz-titel') || {}).value || '';
    if (!titel.trim()) { status('Titel fehlt', 'fehler'); return; }
    const wahl = ($('notiz-projekt-wahl') || {}).value || '';
    const frei = ($('notiz-projekt-text') || {}).value || '';
    if (!weg.kopfSpeichern) return;   // Gäste ändern den Titel nicht
    try {
      const r = await weg.kopfSpeichern({ title: titel.trim(), project_id: wahl ? Number(wahl) : null,
        project_text: wahl ? '' : frei.trim(), verbindung: s.verbindung });
      if (r && r.note) kopfZeigen(r.note);
      statusNachWarteschlange();
    } catch (e) { toast(e.message, 'error'); }
  }
  const tEl = $('notiz-titel');
  if (tEl) { tEl.addEventListener('input', kopfSpeichernBald); tEl.addEventListener('blur', () => { if (s.timer.titel) { clearTimeout(s.timer.titel); kopfSpeichern(); } }); }
  const wEl = $('notiz-projekt-wahl'), fEl = $('notiz-projekt-text');
  if (wEl) wEl.addEventListener('change', () => { if (fEl) { if (wEl.value) fEl.value = ''; fEl.disabled = !!wEl.value; } kopfSpeichern(); });
  if (fEl) fEl.addEventListener('input', kopfSpeichernBald);

  // ─── Verbindung ───────────────────────────────────────────────────────────────────────────
  async function verbinden() {
    if (!s.offen || s.es) return;
    status('Verbinde …', 'laeuft');
    let ticket;
    try { ticket = await weg.ticket(); } catch (e) {
      if (e && e.gastAbgemeldet) { s.beenden({ verwerfen: false }); weg.raus(e.code); return; }
      /* sonst Funkloch */
    }
    if (!s.offen) return;
    if (!ticket) { neuVerbinden(); return; }
    const es = new EventSource(weg.stromUrl(ticket));
    s.es = es;
    let angekommen = false;
    es.addEventListener('start', (ev) => {
      angekommen = true;
      const d = JSON.parse(ev.data);
      s.verbindung = d.verbindung; s.versuche = 0;
      const sv = notizAusB64(d.sv);
      Y.applyUpdate(s.doc, notizAusB64(d.stand), 'server');
      anbinden();
      if (d.anwesenheit) A.applyAwarenessUpdate(s.aw, notizAusB64(d.anwesenheit), 'server');
      s.du = d.du;
      s.aw.setLocalStateField('user', { name: d.du.name, color: d.du.farbe });
      zugriffSetzen(d.zugriff, s.gestartet);
      kopfZeigen(d.kopf, !s.gestartet);
      // Was der Server noch nicht hat (Funkloch, auf dem Gerät gesichert), jetzt nachreichen.
      if (d.zugriff === 'read') {
        s.warteschlange = [];
        try { localStorage.removeItem(speicherKey); } catch (_) {}
      } else {
        const fehlt = Y.encodeStateAsUpdate(s.doc, sv);
        s.warteschlange = fehlt.length > 2 ? [fehlt] : [];
        senden();
      }
      if (!s.gestartet) {
        s.gestartet = true;
        if (d.zugriff !== 'read' && !(d.kopf && d.kopf.title)) { const t = $('notiz-titel'); if (t) t.focus(); }
      }
      anwesenheitSenden();
      anwesendeZeigen();
      statusNachWarteschlange();
    });
    es.addEventListener('aenderung', (ev) => { Y.applyUpdate(s.doc, notizAusB64(JSON.parse(ev.data).update), 'server'); });
    es.addEventListener('anwesenheit', (ev) => { A.applyAwarenessUpdate(s.aw, notizAusB64(JSON.parse(ev.data).update), 'server'); });
    es.addEventListener('zugriff', (ev) => zugriffSetzen(JSON.parse(ev.data).zugriff, true));
    es.addEventListener('kopf', (ev) => kopfZeigen(JSON.parse(ev.data)));
    es.addEventListener('raus', (ev) => {
      // Selbst schließen, BEVOR der Strom endet — sonst verbindet EventSource von sich aus neu.
      const grund = JSON.parse(ev.data).grund;
      s.beenden({ verwerfen: true });
      weg.raus(grund);
    });
    es.onerror = async () => {
      if (s.es !== es) return;
      es.close(); s.es = null; s.verbindung = null;
      statusNachWarteschlange();
      if (!s.offen) return;
      if (!angekommen) {
        // Nie angekommen: gibt es die Notiz noch, und darf ich hinein? (EventSource verrät den Grund nicht.)
        let da = true;
        try { da = await weg.nochDa(); } catch (_) { /* Funkloch — einfach später noch einmal */ }
        if (!da) { s.beenden({ verwerfen: true }); return; }
      }
      neuVerbinden();
    };
  }
  function neuVerbinden(sofort) {
    if (!s.offen || document.hidden) return;
    clearTimeout(s.timer.neu);
    const warten = sofort === 0 ? 0 : Math.min(15000, 1000 * Math.pow(2, s.versuche++));
    if (s.es) { s.es.close(); s.es = null; s.verbindung = null; }
    s.timer.neu = setTimeout(verbinden, warten);
  }
  function trennen() {
    if (s.es) { s.es.close(); s.es = null; }
    s.verbindung = null;
    statusNachWarteschlange();
  }

  // Im Hintergrund nach einer Minute aus der Notiz abmelden: Wer das Handy mit offener Notiz
  // wegsteckt, zählt sonst weiter als „drin" — und bekommt keine Meldungen über Änderungen.
  function sichtbarkeit() {
    if (document.hidden) {
      clearTimeout(s.timer.hintergrund);
      s.timer.hintergrund = setTimeout(trennen, notizZeiten.hintergrundMs);
    } else {
      clearTimeout(s.timer.hintergrund);
      if (!s.es) { s.versuche = 0; verbinden(); }
    }
  }
  const wiederOnline = () => { if (!s.es) { s.versuche = 0; verbinden(); } };
  // Seite wird verlassen (Neuladen, „Jetzt aktualisieren", Tab zu): Was noch nicht beim Server ist,
  // SOFORT auf dem Gerät sichern — das gebündelte Sichern wartet sonst 300 ms, und genau die letzten
  // Tastendrücke gingen verloren. beenden() sichert und schickt einen letzten Versuch hinterher.
  const seiteWeg = () => s.beenden();
  document.addEventListener('visibilitychange', sichtbarkeit);
  window.addEventListener('online', wiederOnline);
  window.addEventListener('pagehide', seiteWeg);

  // „← Fertig"
  const fertig = $('notiz-fertig');
  if (fertig) fertig.addEventListener('click', async () => {
    if (s.timer.titel) { clearTimeout(s.timer.titel); await kopfSpeichern(); }
    for (let i = 0; i < 30 && (s.warteschlange.length || s.sendet) && s.verbindung; i++) await new Promise(r => setTimeout(r, 100));
    if (s.warteschlange.length || s.sendet) {
      const ok = await confirmModal('Deine letzten Änderungen sind noch nicht beim Server angekommen (keine Verbindung). '
        + 'Sie bleiben auf diesem Gerät gespeichert und werden beim nächsten Öffnen der Notiz nachgereicht.',
        { title: 'Noch nicht alles übertragen', okLabel: 'Trotzdem schließen' });
      if (!ok) return;
    }
    weg.fertig();
  });

  // Warten, bis alles beim Server ist (höchstens 3 s) — Datei und Kopie baut der Server aus SEINEM Stand
  s.bisGesendet = async () => {
    for (let i = 0; i < 30 && (s.warteschlange.length || s.sendet) && s.verbindung; i++) await new Promise(r => setTimeout(r, 100));
    return !(s.warteschlange.length || s.sendet);
  };

  // „⋯": Drucken und Speichern als
  const mehr = $('notiz-mehr');
  if (mehr) mehr.addEventListener('click', async () => {
    const wahl = await choiceModal('', typeof weg.menue === 'function' ? weg.menue(s.zugriff) : weg.menue, { title: 'Drucken und Speichern' });
    if (wahl) ausfuehren(wahl);
  });
  const ausfuehren = async (wahl) => {
    if (!s.offen) return;
    if (wahl === 'gaeste') { if (weg.gaeste) weg.gaeste(); return; }   // braucht keinen gesendeten Stand
    if (wahl === 'drucken') {
      notizDrucken(($('notiz-titel') || {}).value || 'Notiz', JSON.stringify(s.doc.getText('notiz').toDelta()), () => ausfuehren('pdf'));
      return;
    }
    if (!(await s.bisGesendet())) {
      // Die Meldung liegt oben über „⋯" — der Knopf in ihr erspart den Umweg über das Menü
      toast('Deine letzten Änderungen sind noch nicht beim Server (keine Verbindung) — die Datei würde sie nicht enthalten.', 'error', 15000,
        { text: 'Nochmal versuchen', beiKlick: () => ausfuehren(wahl) });
      return;
    }
    if (weg.menueExtra && weg.menueExtra(wahl)) return;
    weg.herunterladen(wahl);
  };

  s.beenden = ({ verwerfen } = {}) => {
    if (!s.offen) return;
    s.offen = false;
    for (const t of Object.values(s.timer)) clearTimeout(t);
    for (const t of s.faehnchen.values()) clearTimeout(t);
    document.removeEventListener('visibilitychange', sichtbarkeit);
    window.removeEventListener('online', wiederOnline);
    window.removeEventListener('pagehide', seiteWeg);
    window.removeEventListener('resize', stapelnBald);
    if (verwerfen) { try { localStorage.removeItem(speicherKey); } catch (_) {} }
    else if (s.warteschlange.length) {
      // Letzter Versuch beim Verlassen — VOR dem Schließen des Stroms, solange der Server die
      // Verbindung noch kennt. Klappt er nicht, liegt der Stand auf dem Gerät.
      const offen = warteschlangeAlsEine();
      try { localStorage.setItem(speicherKey, notizB64(offen)); } catch (_) {}
      const ziel = s.verbindung && weg.zumSchluss();
      if (ziel) {
        fetch(ziel.url, { method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ziel.token },
          body: JSON.stringify({ verbindung: s.verbindung, update: notizB64(offen) }) }).catch(() => {});
      }
    }
    if (s.es) { s.es.close(); s.es = null; }
    s.verbindung = null;
    try { if (s.binding) s.binding.destroy(); } catch (_) {}
    try { s.aw.destroy(); } catch (_) {}
    try { s.doc.destroy(); } catch (_) {}
    if (_notizSitzung === s) _notizSitzung = null;
  };

  verbinden();
  return s;
}
