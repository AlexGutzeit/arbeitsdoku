// Die Werkzeuge der MCP-Schnittstelle (Alex, 14.11.2026) — Protokoll in routes/mcp.js.
//
// Grundsatz: KEIN eigener Datenbankzugriff. Jedes Werkzeug ruft die Routen der Oberfläche auf — über den
// eigenen Server (127.0.0.1) und mit demselben Zugangsschlüssel. Damit gelten für Hermes genau dieselben
// Prüfungen und Rechte wie in der App: Ein Mitarbeiter-Schlüssel sieht nur die eigenen Zeiten, weil
// /api/entries das so entscheidet, nicht weil es hier nachgebaut wäre. Was hier passiert, ist Auswahl,
// Zusammenfassen und Kürzen der Antwort.
//
// Die Folgeaufrufe tragen das Prozess-Geheimnis aus schluessel.js: Dann zählen sie nicht noch einmal gegen
// die Bremse, und im Protokoll stehen die echte Adresse des Aufrufers und der Name des Werkzeugs.
const http = require('http');
const schluessel = require('./schluessel');
const { istDatum, berlinHeute } = require('./zeit');
const { calcActualHours } = require('./routes/statistics');

/** Fehler, deren Text der Aufrufer sehen darf (Eingabe falsch, nichts gefunden, Route lehnt ab). */
class Hinweis extends Error {}

// ── Aufruf der eigenen Routen ────────────────────────────────────────────────────────────────
function eigeneAdresse() {
  const h = (process.env.LISTEN_HOST || '').trim();
  const host = (!h || h === '0.0.0.0' || h === 'localhost') ? '127.0.0.1' : (h === '::' ? '::1' : h);
  return { host, port: Number(process.env.PORT || 3000) };
}
function intern(ktx, methode, pfad, body, binaer) {
  return new Promise((resolve, reject) => {
    const daten = body ? JSON.stringify(body) : null;
    const { host, port } = eigeneAdresse();
    const r = http.request({ host, port, path: pfad, method: methode, headers: {
      Authorization: 'Bearer ' + ktx.roh, 'Content-Type': 'application/json', 'X-Intern': schluessel.INTERN,
      'X-Intern-Ip': ktx.ip || '', 'X-Intern-Werkzeug': ktx.werkzeug || '',
      ...(daten ? { 'Content-Length': Buffer.byteLength(daten) } : {}),
    } }, (x) => {
      // Binär (PDF): die Bytes sammeln; JSON-Fehlermeldungen der Route trotzdem lesbar machen
      const teile = [];
      x.on('data', c => { teile.push(c); });
      x.on('end', () => {
        const roh = Buffer.concat(teile);
        let j = null; try { j = JSON.parse(roh.toString('utf8')); } catch (_) {}
        resolve({ status: x.statusCode, body: j, roh: binaer ? roh : undefined, typ: x.headers['content-type'] || '' });
      });
    });
    r.setTimeout(20000, () => r.destroy(new Error('Zeitüberschreitung')));
    r.on('error', reject);
    if (daten) r.write(daten);
    r.end();
  });
}
// Antwort der Route oder ein Hinweis mit ihrer (für Nutzer geschriebenen) Fehlermeldung.
async function hole(ktx, pfad) {
  const a = await intern(ktx, 'GET', pfad);
  if (a.status === 200) return a.body || {};
  if (a.status === 403) throw new Hinweis((a.body && a.body.error) || 'Dafür fehlt die Berechtigung.');
  if (a.status === 404) throw new Hinweis((a.body && a.body.error) || 'Nicht gefunden.');
  if (a.status >= 500) throw new Error('Route ' + pfad.split('?')[0] + ' antwortet ' + a.status);
  throw new Hinweis((a.body && a.body.error) || `Abruf nicht möglich (${a.status}).`);
}
const q = (o) => {
  const t = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return t.length ? '?' + t.join('&') : '';
};

// ── kleine Helfer ────────────────────────────────────────────────────────────────────────────
const norm = (v) => String(v == null ? '' : v).normalize('NFC').toLocaleLowerCase('de');
const enthaelt = (heu, nadel) => norm(heu).includes(norm(nadel));
/** Alle Wörter müssen vorkommen, egal in welchem Feld und in welcher Reihenfolge. */
const trifft = (nadel, ...felder) => { const h = norm(felder.filter(Boolean).join(' ')); return norm(nadel).split(/\s+/).filter(Boolean).every(w => h.includes(w)); };
// Leere Felder weglassen — die Antworten gehen an ein Sprachmodell, jedes Zeichen zählt.
function ohneLeeres(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    r[k] = v;
  }
  return r;
}
const kuerzen = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + ' …' : t; };
function seiten(liste, a) {
  const pro = a.pro_seite || 20;
  const seite = a.seite || 1;
  const gesamt = Math.max(1, Math.ceil(liste.length / pro));
  return { seite, seiten: gesamt, gesamt_anzahl: liste.length, teil: liste.slice((seite - 1) * pro, seite * pro) };
}
const REGIE = { 0: 'nein', 1: 'ja', 2: 'pauschal', 3: 'Büro', 4: 'Lager', 5: 'Intern' };
const ABWESENHEIT = { urlaub: 'Urlaub', krank: 'Krank', fza: 'Freizeitausgleich', feiertag: 'Feiertag', berufsschule: 'Berufsschule',
  innung: 'Innung', sonderurlaub: 'Sonderurlaub', unbezahlt: 'Unbezahlt' };

/** „Max", „max muster" oder 7 → Nummer. Mehrdeutig oder unbekannt → Hinweis mit den Möglichkeiten. */
async function mitarbeiterNr(ktx, wert) {
  if (wert === undefined || wert === null || wert === '') return null;
  if (/^\d+$/.test(String(wert))) return Number(wert);
  const leute = (await hole(ktx, '/api/users/list')).users || [];
  const treffer = leute.filter(u => trifft(wert, u.name));
  if (treffer.length === 1) return treffer[0].id;
  const exakt = treffer.filter(u => norm(u.name) === norm(wert));
  if (exakt.length === 1) return exakt[0].id;
  if (!treffer.length) throw new Hinweis(`Kein Mitarbeiter „${wert}" gefunden. Mitarbeiter: ${leute.map(u => u.name).join(', ')}.`);
  throw new Hinweis(`„${wert}" ist mehrdeutig: ${treffer.map(u => `${u.name} (${u.id})`).join(', ')}.`);
}
function zeitraum(a, standardTage) {
  const bis = a.bis || berlinHeute();
  const von = a.von || (standardTage ? new Date(new Date(bis + 'T12:00:00Z').getTime() - standardTage * 864e5).toISOString().slice(0, 10) : undefined);
  if (von && bis && von > bis) throw new Hinweis('„von" liegt nach „bis".');
  return { von, bis };
}

// ── Zeiteinträge: gemeinsamer Abruf für Suche und Summe ───────────────────────────────────────
async function eintraegeHolen(ktx, a) {
  const { von, bis } = zeitraum(a, 31);
  const uid = await mitarbeiterNr(ktx, a.mitarbeiter);
  const projektNr = a.auftrag !== undefined && /^\d+$/.test(String(a.auftrag)) ? Number(a.auftrag) : null;
  const b = await hole(ktx, '/api/entries' + q({ date_from: von, date_to: bis, user_id: uid, project_id: projektNr,
    search: a.text, regie: a.regie }));
  let liste = b.entries || [];
  if (uid) liste = liste.filter(e => e.user_id === uid);   // für Mitarbeiter-Schlüssel: die Route liefert ohnehin nur die eigenen
  if (a.kunde) liste = liste.filter(e => enthaelt(e.client, a.kunde));
  if (a.auftrag !== undefined && projektNr === null) liste = liste.filter(e => enthaelt(e.project_name || e.project_text, a.auftrag));
  return { von, bis, liste };
}
const eintragKurz = (e) => ohneLeeres({
  id: e.id, datum: e.date, von: e.time_from, bis: e.time_to, pause_min: e.break_minutes || 0, netto_std: e.net_hours,
  mitarbeiter: e.user_name, kunde: e.client, auftrag: e.project_name || e.project_text, adresse: e.address,
  beschreibung: e.description, regie: e.has_regie ? REGIE[e.has_regie] : undefined, notiz: e.personal_note,
});

// ── Zeiteinträge schreiben ───────────────────────────────────────────────────────────────────
const UHR = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', maxLength: 5 };
const EINTRAG_FELDER = {
  datum: { type: 'string', format: 'date', description: 'Tag, JJJJ-MM-TT' },
  von: { ...UHR, description: 'Beginn, HH:MM' },
  bis: { ...UHR, description: 'Ende, HH:MM' },
  pause_min: { type: 'integer', minimum: 0, maximum: 600, description: 'Pause in Minuten' },
  kunde: { type: 'string', maxLength: 200, description: 'Kunde' },
  adresse: { type: 'string', maxLength: 300, description: 'Adresse / Arbeitsort' },
  auftrag: { type: 'string', maxLength: 200, description: 'Auftrag: Nummer oder Name eines Auftrags vom Board; sonst wird der Text als Freitext übernommen' },
  beschreibung: { type: 'string', maxLength: 2000, description: 'Arbeitsbeschreibung' },
  regie: { type: 'integer', minimum: 0, maximum: 5, description: 'Regiezettel: 0 nein, 1 ja, 2 pauschal, 3 Büro, 4 Lager, 5 Intern' },
  grund: { type: 'string', maxLength: 500, description: 'Begründung — nötig bei fremden Einträgen (Admin) und in abgerechneten Monaten (Admin)' },
  doppelt_ok: { type: 'boolean', description: 'Trotzdem speichern, obwohl es einen gleichen Eintrag gibt (nur nach Rückfrage beim Menschen)' },
  vorschau: { type: 'boolean', description: 'Nur prüfen und zeigen, was entstünde — nichts speichern' },
};
async function eintragKoerper(ktx, a) {
  const b = {};
  if (a.datum !== undefined) b.date = a.datum;
  if (a.von !== undefined) b.time_from = a.von;
  if (a.bis !== undefined) b.time_to = a.bis;
  if (a.pause_min !== undefined) b.break_minutes = a.pause_min;
  if (a.kunde !== undefined) b.client = a.kunde;
  if (a.adresse !== undefined) b.address = a.adresse;
  if (a.beschreibung !== undefined) b.description = a.beschreibung;
  if (a.regie !== undefined) b.has_regie = a.regie;
  if (a.grund !== undefined) b.reason = a.grund;
  if (a.doppelt_ok) b.doppelt_ok = true;
  if (a.vorschau) b.vorschau = true;
  if (a.auftrag !== undefined) {
    if (a.auftrag === '') { b.project_id = null; b.project_text = ''; }
    else {
      const p = await auftragFinden(ktx, a.auftrag);
      if (p) { b.project_id = p.id; b.project_text = ''; } else { b.project_id = null; b.project_text = a.auftrag; }
    }
  }
  return b;
}
/** Auftrag vom Board per Nummer oder Name (Teil genügt, eindeutig) — oder null, wenn keiner passt. */
async function auftragFinden(ktx, wert) {
  if (/^\d+$/.test(String(wert))) return { id: Number(wert) };
  const treffer = ((await hole(ktx, '/api/projects')).projects || []).filter(p => trifft(wert, p.name));
  const exakt = treffer.filter(p => norm(p.name) === norm(wert));
  const p = exakt.length === 1 ? exakt[0] : (treffer.length === 1 ? treffer[0] : null);
  if (!p && treffer.length > 1) throw new Hinweis(`Auftrag „${wert}" ist mehrdeutig: ${treffer.slice(0, 10).map(x => `${x.name} (${x.id})`).join(', ')}. Bitte die Nummer angeben.`);
  return p ? { id: p.id, name: p.name } : null;
}
// Antwort einer Schreib-Route: Inhalt bei Erfolg, sonst ein Hinweis mit der (für Nutzer geschriebenen) Meldung der App
function geschrieben(a) {
  if (a.status === 200 || a.status === 201) return a.body || {};
  if (a.status >= 500) throw new Error('Schreiben: Route antwortet ' + a.status);
  throw new Hinweis((a.body && a.body.error) || `Nicht gespeichert (${a.status}).`);
}
// Das Brett lehnt ohne Recht nur mit „Keine Berechtigung" ab — für einen Assistenten zu knapp
// (nur genau diese Ablehnung übersetzen — sperrt der Schlüssel selbst, bleibt dessen Meldung stehen)
function brett(a) {
  if (a.status === 403 && a.body && a.body.error === 'Keine Berechtigung') throw new Hinweis('Für das Schwarze Brett fehlt dir das Recht. Es vergibt der Chef oder Admin im Mitarbeiter-Dialog.');
  return geschrieben(a);
}
const SCHREIBT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const VORSCHAU = { type: 'boolean', description: 'Nur prüfen und zeigen, was passieren würde — nichts speichern' };
const ABW_ART = { urlaub: 'urlaub', fza: 'freizeitausgleich', sonderurlaub: 'sonderurlaub', krank: 'krank', berufsschule: 'berufsschule', innung: 'innung' };
const ABW_STATUS = { pending: 'beantragt — wartet auf Genehmigung durch Chef/Admin', active: 'eingetragen' };
/** Werkzeug per Nummer oder Name (Teil genügt, eindeutig). */
async function werkzeugFinden(ktx, wert) {
  const alle = (await hole(ktx, '/api/tools')).tools || [];
  const t = /^\d+$/.test(String(wert)) ? alle.filter(x => x.id === Number(wert)) : alle.filter(x => trifft(wert, x.name));
  const exakt = t.filter(x => norm(x.name) === norm(wert));
  if (exakt.length === 1) return exakt[0];
  if (t.length === 1) return t[0];
  if (!t.length) throw new Hinweis(`Kein Werkzeug „${wert}" gefunden.`);
  throw new Hinweis(`„${wert}" ist mehrdeutig: ${t.slice(0, 10).map(x => `${x.name} (${x.id})`).join(', ')}. Bitte die Nummer angeben.`);
}
function schreibenAuswerten(a, vorschau, wort) {
  const e = a.body && a.body.entry;
  if ((a.status === 200 || a.status === 201) && a.body && a.body.vorschau) {
    return { vorschau: true, gespeichert: false, wuerde_ergeben: eintragKurz(e || {}), hinweis: 'Alle Prüfungen bestanden. Ohne vorschau erneut aufrufen, um zu speichern.' };
  }
  if (a.status === 200 || a.status === 201) return { gespeichert: true, [wort]: eintragKurz(e || {}) };
  if (a.status === 409 && a.body && a.body.code === 'EINTRAG_DOPPELT') {
    throw new Hinweis(`${a.body.error} (Eintrag Nr. ${a.body.vorhanden_id}). Nur nach Rückfrage beim Menschen mit doppelt_ok=true speichern.`);
  }
  if (a.status >= 500) throw new Error('Speichern: Route antwortet ' + a.status);
  throw new Hinweis((a.body && a.body.error) || `Nicht gespeichert (${a.status}).`);
}

// ── „Mein Konto" ──────────────────────────────────────────────────────────────────────────────
const PUSH_KAT = { bestellungen: 'orders', schwarzes_brett: 'bulletin', notizen: 'notes', abwesenheiten: 'absences', planung: 'planning', meldungen: 'meldungen' };
const PUSH_TEXT = { bestellungen: 'neue Bestellungen', schwarzes_brett: 'neue Aushänge', notizen: 'geteilte Notizen', abwesenheiten: 'Abwesenheiten/Anträge',
  planung: 'Planung', meldungen: 'Meldungen' };
const ZUS_KAT = { bestellungen: 'orders', schwarzes_brett: 'bulletin', notizen: 'notes', abwesenheiten: 'absences', meldungen: 'meldungen' };
const KAT_DE = Object.fromEntries(Object.entries(PUSH_KAT).map(([de, en]) => [en, de]));
const TAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const PDF_MAX = 8 * 1048576;   // größer → Download-Adresse nutzen

// ── Werkzeuge ────────────────────────────────────────────────────────────────────────────────
const S = {   // wiederkehrende Parameter
  von: { type: 'string', format: 'date', description: 'Erster Tag, JJJJ-MM-TT' },
  bis: { type: 'string', format: 'date', description: 'Letzter Tag, JJJJ-MM-TT (Standard: heute)' },
  mitarbeiter: { type: 'string', maxLength: 80, description: 'Name (oder Teil davon) oder Nummer des Mitarbeiters' },
  text: { type: 'string', maxLength: 100, description: 'Suchwörter (alle müssen vorkommen)' },
  seite: { type: 'integer', minimum: 1, maximum: 1000, description: 'Seite der Ergebnisliste (ab 1)' },
  pro_seite: { type: 'integer', minimum: 1, maximum: 50, description: 'Einträge je Seite (Standard 20, höchstens 50)' },
};
const LESEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const WERKZEUGE = [
  {
    name: 'angemeldet_als', title: 'Wer bin ich?', annotations: LESEN,
    description: 'Zeigt, als welcher App-Benutzer dieser Schlüssel angemeldet ist, mit welchem Recht, und das heutige Datum. Hilft bei relativen Angaben wie „letzten Monat".',
    eingabe: {},
    async ausfuehren(a, ktx) {
      return { benutzer: ktx.user.name, rolle: ktx.user.role, schluessel: ktx.schluessel.name,
        recht: ktx.schluessel.recht === 'schreiben' ? 'lesen + Zeiteinträge anlegen/ändern' : 'nur lesen', heute: berlinHeute(),
        hinweis: ktx.user.role === 'mitarbeiter' ? 'Als Mitarbeiter siehst du nur deine eigenen Zeiten, Abwesenheiten und Planungen.' : undefined };
    },
  },
  {
    name: 'mitarbeiter_liste', title: 'Mitarbeiter', annotations: LESEN,
    description: 'Listet die Mitarbeiter mit Nummer, Name und Rolle — für die Filter der anderen Werkzeuge.',
    eingabe: { ausgeschiedene: { type: 'boolean', description: 'Auch ausgeschiedene Mitarbeiter zeigen (Standard: nein)' } },
    async ausfuehren(a, ktx) {
      const leute = (await hole(ktx, '/api/users/list' + (a.ausgeschiedene ? '?all=1' : ''))).users || [];
      return { mitarbeiter: leute.map(u => ohneLeeres({ nr: u.id, name: u.name, rolle: u.role, ausgeschieden: u.active === 0 ? true : undefined })) };
    },
  },
  {
    name: 'zeiteintraege_suchen', title: 'Zeiteinträge suchen', annotations: LESEN,
    description: 'Sucht Zeiteinträge (Einsätze) mit Datum, Uhrzeit, Pause, Nettostunden, Kunde, Auftrag, Adresse und Beschreibung. Filter: Zeitraum (ohne Angabe: die letzten 31 Tage), Mitarbeiter, Kunde, Auftrag, Suchwörter, Regie. Liefert auch die Stundensumme der Treffer (zeitgleiche Einsätze derselben Person zählen einmal).',
    eingabe: { von: S.von, bis: S.bis, mitarbeiter: S.mitarbeiter,
      kunde: { type: 'string', maxLength: 100, description: 'Kunde (Teil des Namens genügt)' },
      auftrag: { type: 'string', maxLength: 100, description: 'Auftrag/Projekt: Name (Teil genügt) oder Nummer' },
      text: { ...S.text, description: 'Suchwörter in Beschreibung, Adresse, Kunde, Auftrag und Name' },
      regie: { type: 'string', enum: ['0', '1', '2', '3', '4', '5', 'jede'], description: 'Regie: 0 nein, 1 ja, 2 pauschal, 3 Büro, 4 Lager, 5 Intern, jede = alles außer nein' },
      seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      const { von, bis, liste } = await eintraegeHolen(ktx, a);
      const s = seiten(liste, a);
      return { zeitraum: { von, bis }, anzahl: liste.length, stunden: calcActualHours(liste), seite: s.seite, seiten: s.seiten, eintraege: s.teil.map(eintragKurz) };
    },
  },
  {
    name: 'stunden_summe', title: 'Stundensumme', annotations: LESEN,
    description: 'Summiert Nettostunden je Mitarbeiter und gesamt — genauso gerechnet wie der Zeitnachweis der App (überschneiden sich Einsätze derselben Person am selben Tag, zählt die Zeit einmal). Beispiel: „Wie viele Stunden war Max im Oktober bei Kunde Müller?" → von 2026-10-01, bis 2026-10-31, mitarbeiter Max, kunde Müller. Mit einzelposten=true auch die Einträge.',
    eingabe: { von: { ...S.von, description: 'Erster Tag, JJJJ-MM-TT (Pflicht)' }, bis: { ...S.bis, description: 'Letzter Tag, JJJJ-MM-TT (Pflicht)' },
      mitarbeiter: S.mitarbeiter, kunde: { type: 'string', maxLength: 100, description: 'Kunde (Teil des Namens genügt)' },
      auftrag: { type: 'string', maxLength: 100, description: 'Auftrag/Projekt: Name (Teil genügt) oder Nummer' },
      text: S.text, regie: { type: 'string', enum: ['0', '1', '2', '3', '4', '5', 'jede'], description: 'Regie-Filter wie bei zeiteintraege_suchen' },
      einzelposten: { type: 'boolean', description: 'Auch die einzelnen Einträge liefern (höchstens 200)' } },
    pflicht: ['von', 'bis'],
    async ausfuehren(a, ktx) {
      const { von, bis, liste } = await eintraegeHolen(ktx, a);
      const jePerson = new Map();
      for (const e of liste) { if (!jePerson.has(e.user_id)) jePerson.set(e.user_id, { name: e.user_name, eintraege: [] }); jePerson.get(e.user_id).eintraege.push(e); }
      const personen = [...jePerson.values()].map(p => ({ mitarbeiter: p.name, stunden: calcActualHours(p.eintraege), eintraege: p.eintraege.length, tage: new Set(p.eintraege.map(e => e.date)).size }))
        .sort((x, y) => y.stunden - x.stunden);
      return ohneLeeres({ zeitraum: { von, bis }, filter: ohneLeeres({ mitarbeiter: a.mitarbeiter, kunde: a.kunde, auftrag: a.auftrag, text: a.text, regie: a.regie }),
        stunden_gesamt: calcActualHours(liste), eintraege_gesamt: liste.length, je_mitarbeiter: personen,
        einzelposten: a.einzelposten ? liste.slice(0, 200).map(eintragKurz) : undefined,
        hinweis: a.einzelposten && liste.length > 200 ? `Nur die ersten 200 von ${liste.length} Einträgen — für alle zeiteintraege_suchen seitenweise nutzen.` : undefined });
    },
  },
  {
    name: 'kunden_suchen', title: 'Kunden suchen', annotations: LESEN,
    description: 'Findet Kunden. Die App hat keine eigene Kundenliste — „Kunde" steht an Aufträgen und Zeiteinträgen. Liefert je Kunde die Zahl der Einsätze, ersten und letzten Einsatz, Stunden und die zugehörigen Aufträge.',
    eingabe: { text: { ...S.text, description: 'Teil des Kundennamens (leer = alle)' }, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      const [p, e] = await Promise.all([hole(ktx, '/api/projects'), hole(ktx, '/api/entries' + q({ date_from: '1900-01-01' }))]);
      const kunden = new Map();
      const kunde = (name) => { const k = norm(name).trim(); if (!k) return null;
        if (!kunden.has(k)) kunden.set(k, { kunde: String(name).trim(), eintraege: [], auftraege: new Set() }); return kunden.get(k); };
      for (const x of p.projects || []) { const k = kunde(x.client); if (k) k.auftraege.add(x.name); }
      for (const x of e.entries || []) { const k = kunde(x.client); if (!k) continue; k.eintraege.push(x); if (x.project_name || x.project_text) k.auftraege.add(x.project_name || x.project_text); }
      let liste = [...kunden.values()].filter(k => !a.text || trifft(a.text, k.kunde)).map(k => {
        const tage = k.eintraege.map(x => x.date).sort();
        return ohneLeeres({ kunde: k.kunde, einsaetze: k.eintraege.length, stunden: calcActualHours(k.eintraege), erster_einsatz: tage[0], letzter_einsatz: tage[tage.length - 1],
          auftraege: [...k.auftraege].slice(0, 15) });
      }).sort((x, y) => (y.letzter_einsatz || '').localeCompare(x.letzter_einsatz || '') || x.kunde.localeCompare(y.kunde));
      const s = seiten(liste, a);
      return { anzahl: liste.length, seite: s.seite, seiten: s.seiten, kunden: s.teil };
    },
  },
  {
    name: 'auftraege_suchen', title: 'Aufträge suchen', annotations: LESEN,
    description: 'Sucht Aufträge/Projekte vom Auftrags-Board: Name, Kunde, Adresse, Dringlichkeit, Frist, Zuteilung, Kategorien, Fortschritt der Zwischenziele. Standard: offene Aufträge.',
    eingabe: { text: { ...S.text, description: 'Suchwörter in Name, Kunde, Adresse, Kurzinfo' }, mitarbeiter: { ...S.mitarbeiter, description: 'Nur Aufträge, die diesem Mitarbeiter zugeteilt sind' },
      erledigte: { type: 'boolean', description: 'Erledigte statt offene Aufträge (nur Chef/Admin)' }, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      let liste = (await hole(ktx, '/api/projects' + (a.erledigte ? '?done=1' : ''))).projects || [];
      if (a.text) liste = liste.filter(p => trifft(a.text, p.name, p.client, p.address, p.note));
      if (a.mitarbeiter) { const uid = await mitarbeiterNr(ktx, a.mitarbeiter); liste = liste.filter(p => (p.assigned_users || []).some(u => u.user_id === uid)); }
      const s = seiten(liste, a);
      return { anzahl: liste.length, seite: s.seite, seiten: s.seiten, auftraege: s.teil.map(auftragKurz) };
    },
  },
  {
    name: 'auftrag_anzeigen', title: 'Auftrag anzeigen', annotations: LESEN,
    description: 'Zeigt einen Auftrag vollständig: Daten, Zwischenziele mit Status, gebuchte Stunden je Mitarbeiter (wenn die Rolle das sehen darf) und den Text der Projektnotiz.',
    eingabe: { nr: { type: 'integer', minimum: 1, description: 'Nummer des Auftrags (aus auftraege_suchen)' } },
    pflicht: ['nr'],
    async ausfuehren(a, ktx) {
      const p = (await hole(ktx, `/api/projects/${a.nr}`)).project;
      const [st, nz] = await Promise.all([
        hole(ktx, `/api/projects/${a.nr}/stats`).catch(e => { if (e instanceof Hinweis) return null; throw e; }),
        hole(ktx, `/api/projects/${a.nr}/notiz`).catch(e => { if (e instanceof Hinweis) return null; throw e; }),
      ]);
      return ohneLeeres({ ...auftragKurz(p), kurzinfo: p.note, angelegt: p.created_at, erledigt_am: p.done_at,
        zwischenziele: (p.milestones || []).map(m => ohneLeeres({ titel: m.title, status: MS[m.status] || m.status, arbeitstage: m.est_days })),
        stunden: st ? { gesamt: st.total_hours, eintraege: st.total_entries, je_mitarbeiter: (st.per_user || []).map(u => ({ mitarbeiter: u.name, stunden: u.hours, eintraege: u.entries })) } : undefined,
        projektnotiz: nz && nz.notiz && nz.notiz.body ? ohneLeeres({ text: kuerzen(nz.notiz.body, 8000), bearbeitet: nz.notiz.updated_at, von: nz.notiz.von }) : undefined });
    },
  },
  {
    name: 'planung_anzeigen', title: 'Planung', annotations: LESEN,
    description: 'Zeigt die Einsatzplanung (wer ist wann wo eingeplant) für einen Zeitraum. Ohne Angabe: heute bis in 7 Tagen.',
    eingabe: { von: { ...S.von, description: 'Erster Tag (Standard: heute)' }, bis: { ...S.bis, description: 'Letzter Tag (Standard: in 7 Tagen)' },
      mitarbeiter: S.mitarbeiter, text: { ...S.text, description: 'Suchwörter in Kunde, Auftrag, Adresse, Beschreibung' }, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      const von = a.von || berlinHeute();
      const bis = a.bis || new Date(new Date(von + 'T12:00:00Z').getTime() + 7 * 864e5).toISOString().slice(0, 10);
      if (von > bis) throw new Hinweis('„von" liegt nach „bis".');
      let liste = (await hole(ktx, '/api/planning' + q({ date_from: von, date_to: bis }))).entries || [];
      liste = liste.filter(p => p.date >= von && p.date <= bis);
      if (a.mitarbeiter) { const uid = await mitarbeiterNr(ktx, a.mitarbeiter); liste = liste.filter(p => (p.assigned_users || []).some(u => (u.user_id || u.id) === uid)); }
      if (a.text) liste = liste.filter(p => trifft(a.text, p.client, p.project_name, p.project_text, p.address, p.description));
      liste.sort((x, y) => (x.date + x.time_from).localeCompare(y.date + y.time_from));
      const s = seiten(liste, a);
      return { zeitraum: { von, bis }, anzahl: liste.length, seite: s.seite, seiten: s.seiten, planung: s.teil.map(p => ohneLeeres({
        id: p.id, datum: p.date, von: p.time_from, bis: p.time_to, mitarbeiter: (p.assigned_users || []).map(u => u.name || u.user_name).filter(Boolean),
        kunde: p.client, auftrag: p.project_name || p.project_text, adresse: p.address, beschreibung: p.description })) };
    },
  },
  {
    name: 'abwesenheiten', title: 'Abwesenheiten', annotations: LESEN,
    description: 'Zeigt Abwesenheiten (Urlaub, Krank, Freizeitausgleich, Feiertage, Berufsschule …) mit Zeitraum und Status. Ohne Angabe: der laufende Monat.',
    eingabe: { von: S.von, bis: S.bis, mitarbeiter: S.mitarbeiter,
      art: { type: 'string', enum: Object.keys(ABWESENHEIT), description: 'Nur diese Art' }, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      const heute = berlinHeute();
      const von = a.von || heute.slice(0, 8) + '01';
      const bis = a.bis || new Date(Date.UTC(Number(von.slice(0, 4)), Number(von.slice(5, 7)), 0)).toISOString().slice(0, 10);
      if (von > bis) throw new Hinweis('„von" liegt nach „bis".');
      const uid = await mitarbeiterNr(ktx, a.mitarbeiter);
      let liste = (await hole(ktx, '/api/absences' + q({ from: von, to: bis, user_id: uid, type: a.art }))).absences || [];
      if (uid) liste = liste.filter(x => x.user_id === uid || x.type === 'feiertag');
      if (a.art) liste = liste.filter(x => x.type === a.art);
      const s = seiten(liste, a);
      return { zeitraum: { von, bis }, anzahl: liste.length, seite: s.seite, seiten: s.seiten, abwesenheiten: s.teil.map(x => ohneLeeres({
        art: ABWESENHEIT[x.type] || x.type, von: x.date_from, bis: x.date_to || x.date_from, mitarbeiter: x.type === 'feiertag' ? undefined : x.user_name,
        status: x.status, kommentar: x.comment })) };
    },
  },
  {
    name: 'stundenkonto', title: 'Stundenkonto', annotations: LESEN,
    description: 'Soll, Ist und Überstunden je Mitarbeiter für einen Tag, eine Woche, einen Monat, ein Jahr oder gesamt — wie die Statistik der App. Dazu Überstundenstand gesamt und ausgezahlte Stunden.',
    eingabe: { zeitraum: { type: 'string', enum: ['tag', 'woche', 'monat', 'jahr', 'gesamt'], description: 'Standard: monat' },
      datum: { type: 'string', format: 'date', description: 'Ein Tag im gewünschten Zeitraum, JJJJ-MM-TT (Standard: heute)' }, mitarbeiter: S.mitarbeiter },
    async ausfuehren(a, ktx) {
      const ZR = { tag: 'day', woche: 'week', monat: 'month', jahr: 'year', gesamt: 'all' };
      const uid = await mitarbeiterNr(ktx, a.mitarbeiter);
      const b = await hole(ktx, '/api/statistics' + q({ period: ZR[a.zeitraum || 'monat'], date: a.datum || berlinHeute(), user_ids: uid }));
      let leute = b.users || [];
      if (uid) leute = leute.filter(u => u.user_id === uid);
      return ohneLeeres({ zeitraum: b.range ? ohneLeeres({ von: b.range.from, bis: b.range.to, bezeichnung: b.range.label }) : undefined,
        mitarbeiter: leute.map(u => ohneLeeres({ mitarbeiter: u.user_name, ist_std: u.ist, soll_std: u.soll, ueberstunden_zeitraum: u.ueber,
          ueberstunden_gesamt: u.ueber_gesamt, ausgezahlt_std: u.ausgezahlt || undefined,
          // Die Tagesliste der Statistik bleibt weg — für Fragen nach einzelnen Tagen gibt es zeiteintraege_suchen
          arbeitstage: u.arbeitstage && typeof u.arbeitstage === 'object' ? ohneLeeres({ anzahl: u.arbeitstage.anzahl, ueber_8_std: u.arbeitstage.ueber8, bis_8_std: u.arbeitstage.bis8 }) : undefined })) });
    },
  },
  {
    name: 'urlaubskonto', title: 'Urlaubskonto', annotations: LESEN,
    description: 'Urlaubsanspruch, Übertrag, genommen, geplant und Rest je Mitarbeiter für ein Jahr.',
    eingabe: { jahr: { type: 'integer', minimum: 2000, maximum: 2100, description: 'Jahr (Standard: laufendes)' }, mitarbeiter: S.mitarbeiter },
    async ausfuehren(a, ktx) {
      const jahr = a.jahr || Number(berlinHeute().slice(0, 4));
      const uid = await mitarbeiterNr(ktx, a.mitarbeiter);
      try {
        let rows = (await hole(ktx, '/api/absences/vacation-overview' + q({ year: jahr }))).rows || [];
        if (uid) rows = rows.filter(r => r.user_id === uid);
        return { jahr, mitarbeiter: rows.map(r => ohneLeeres({ mitarbeiter: r.name, anspruch: r.anspruch, uebertrag: r.uebertrag, gesamt: r.gesamtanspruch,
          genommen: r.genommen, geplant: r.geplant, noch_zu_planen: r.nochZuPlanen, beantragt: r.beantragt, krank_tage: r.krank, fza_tage: r.fza })) };
      } catch (e) {
        if (!(e instanceof Hinweis)) throw e;
        // Mitarbeiter sehen die Übersicht aller nicht — dann das eigene Konto
        const s = await hole(ktx, '/api/absences/summary' + q({ from: `${jahr}-01-01`, to: `${jahr}-12-31` }));
        const v = s.vacation || {};
        return { jahr, mitarbeiter: [ohneLeeres({ mitarbeiter: ktx.user.name, anspruch: v.anspruch, uebertrag: v.uebertrag, genommen: v.genommen,
          geplant: v.geplant, noch_zu_planen: v.nochZuPlanen, rest: v.rest })], tage_je_art: s.summary };
      }
    },
  },
  {
    name: 'notizen_suchen', title: 'Notizen suchen', annotations: LESEN,
    description: 'Sucht in den eigenen und den mit dir geteilten Notizen (Titel, Text, Projekt). Liefert einen Auszug; den ganzen Text mit notiz_lesen. Projektnotizen stehen bei auftrag_anzeigen.',
    eingabe: { text: S.text, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      let liste = (await hole(ktx, '/api/notes')).notes || [];
      if (a.text) liste = liste.filter(n => trifft(a.text, n.title, n.body, n.project_name, n.project_text));
      liste.sort((x, y) => String(y.updated_at || '').localeCompare(String(x.updated_at || '')));
      const s = seiten(liste, a);
      return { anzahl: liste.length, seite: s.seite, seiten: s.seiten, notizen: s.teil.map(n => ohneLeeres({ nr: n.id, titel: n.title,
        auftrag: n.project_name || n.project_text, von: n.owner_name || n.user_name, geaendert: n.updated_at, auszug: kuerzen(n.body, 300) })) };
    },
  },
  {
    name: 'notiz_lesen', title: 'Notiz lesen', annotations: LESEN,
    description: 'Liefert den vollständigen Text einer Notiz (Nummer aus notizen_suchen).',
    eingabe: { nr: { type: 'integer', minimum: 1, description: 'Nummer der Notiz' } }, pflicht: ['nr'],
    async ausfuehren(a, ktx) {
      const n = ((await hole(ktx, '/api/notes')).notes || []).find(x => x.id === a.nr);
      if (!n) throw new Hinweis('Diese Notiz gibt es nicht oder sie ist nicht für dich freigegeben.');
      return ohneLeeres({ nr: n.id, titel: n.title, auftrag: n.project_name || n.project_text, von: n.owner_name || n.user_name, geaendert: n.updated_at, text: kuerzen(n.body, 20000) });
    },
  },
  {
    name: 'aushaenge', title: 'Aushänge', annotations: LESEN,
    description: 'Die Aushänge vom Schwarzen Brett (Titel, Text, Termin).',
    eingabe: {},
    async ausfuehren(a, ktx) {
      const liste = (await hole(ktx, '/api/bulletin')).entries || [];
      return { aushaenge: liste.map(x => ohneLeeres({ nr: x.id, titel: x.title, text: kuerzen(x.text, 2000), termin: x.event_date,
        entfernt_am: x.auto_delete_date, von: x.author_name, geaendert: x.updated_at || x.created_at })) };
    },
  },
  {
    name: 'werkzeuge_liste', title: 'Werkzeuge', annotations: LESEN,
    description: 'Werkzeuge und Geräte: wer hat was, seit wann, für welchen Auftrag, wo.',
    eingabe: { text: { ...S.text, description: 'Suchwörter in Werkzeug, Person, Auftrag, Ort' }, nur_ausgeliehen: { type: 'boolean', description: 'Nur, was gerade jemand hat' } },
    async ausfuehren(a, ktx) {
      let liste = (await hole(ktx, '/api/tools')).tools || [];
      if (a.nur_ausgeliehen) liste = liste.filter(t => t.checkout_id);
      if (a.text) liste = liste.filter(t => trifft(a.text, t.name, t.checked_out_by_name, t.checkout_project_name, t.checkout_project_text, t.checkout_address));
      return { anzahl: liste.length, werkzeuge: liste.map(t => ohneLeeres({ nr: t.id, werkzeug: t.name, bei: t.checked_out_by_name, seit: t.checked_out_at,
        auftrag: t.checkout_project_name || t.checkout_project_text, ort: t.checkout_address, frei: t.checkout_id ? undefined : true })) };
    },
  },
  {
    name: 'bestellungen', title: 'Bestellungen (Material)', annotations: LESEN,
    description: 'Material-Bestellungen: offene (noch zu bestellen) und bereits bestellte, mit Menge, Einheit, Auftrag und Ort.',
    eingabe: { bestellte: { type: 'boolean', description: 'Bereits bestellte statt offene zeigen' }, text: S.text, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      let liste = (await hole(ktx, a.bestellte ? '/api/orders/ordered' : '/api/orders')).orders || [];
      if (a.text) liste = liste.filter(o => trifft(a.text, o.product, o.comment, o.project_name, o.location_text, o.user_name));
      const s = seiten(liste, a);
      return { art: a.bestellte ? 'bestellt' : 'offen', anzahl: liste.length, seite: s.seite, seiten: s.seiten, bestellungen: s.teil.map(o => ohneLeeres({
        menge: o.quantity, einheit: o.unit, material: o.product, kommentar: o.comment, auftrag: o.project_name, ort: o.location_text,
        von: o.user_name, angelegt: o.created_at, bestellt_am: o.ordered_at, bestellt_von: o.ordered_by_name })) };
    },
  },
  {
    name: 'lager_suchen', title: 'Produktverzeichnis', annotations: LESEN,
    description: 'Sucht im Produktverzeichnis (Lager): Name, Hersteller, Kategorie, Einheit.',
    eingabe: { text: { ...S.text, description: 'Suchwörter (Name, Hersteller)' }, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      let liste = (await hole(ktx, '/api/products' + q({ q: a.text }))).produkte || [];
      if (a.text) liste = liste.filter(p => trifft(a.text, p.name, p.hersteller, p.kategorie_name));
      const s = seiten(liste, a);
      return { anzahl: liste.length, seite: s.seite, seiten: s.seiten, produkte: s.teil.map(p => ohneLeeres({ nr: p.id, name: p.name, hersteller: p.hersteller, kategorie: p.kategorie_name, einheit: p.default_unit })) };
    },
  },
  {
    name: 'meldungen', title: 'Meldungen', annotations: LESEN,
    description: 'Gemeldete Probleme/Anliegen mit Thema, Status und Rückmeldung. Standard: aktuelle; mit erledigte=true die History.',
    eingabe: { text: S.text, erledigte: { type: 'boolean', description: 'Erledigte aus der History statt aktuelle' }, seite: S.seite, pro_seite: S.pro_seite },
    async ausfuehren(a, ktx) {
      const b = await hole(ktx, a.erledigte ? '/api/meldungen/history' + q({ q: a.text, limit: 200 }) : '/api/meldungen');
      let liste = b.meldungen || b.eintraege || [];
      if (a.text && !a.erledigte) liste = liste.filter(m => trifft(a.text, m.text, m.rueckmeldung, m.thema_name, m.created_by_name));
      const s = seiten(liste, a);
      return { anzahl: liste.length, seite: s.seite, seiten: s.seiten, meldungen: s.teil.map(m => ohneLeeres({ nr: m.id, thema: m.thema_name, text: kuerzen(m.text, 1000),
        dringend: m.dringend ? true : undefined, status: m.status, rueckmeldung: m.rueckmeldung, von: m.created_by_name, angelegt: m.created_at, geaendert: m.updated_at })) };
    },
  },
  {
    name: 'ablage_liste', title: 'Ablage (Dokumente)', annotations: LESEN,
    description: 'Ordner und Dateien der Ablage (nur Namen, Größe und Datum — keine Dateiinhalte).',
    eingabe: { ordner: { type: 'integer', minimum: 1, description: 'Nummer des Ordners (leer = Hauptordner)' } },
    async ausfuehren(a, ktx) {
      const b = await hole(ktx, '/api/documents' + q({ folder_id: a.ordner }));
      return ohneLeeres({ ordner: b.folder ? b.folder.name : 'Hauptordner', pfad: (b.breadcrumb || []).map(x => x.name).join(' / '),
        unterordner: (b.folders || []).map(f => ({ nr: f.id, name: f.name })),
        dateien: (b.documents || []).map(d => ohneLeeres({ name: d.title || d.original_name, datei: d.original_name, groesse_kb: d.size ? Math.round(d.size / 1024) : undefined, hochgeladen: d.uploaded_at })) });
    },
  },
  {
    name: 'abrechnung_stand', title: 'Abrechnungsstand', annotations: LESEN,
    description: 'Bis wann die Monate abgerechnet (abgeschlossen) sind — Einträge davor lassen sich nicht mehr ändern.',
    eingabe: {},
    async ausfuehren(a, ktx) {
      const b = await hole(ktx, '/api/closure');
      return ohneLeeres({ abgerechnet_bis: b.bis, naechster_monat: b.naechsterMonat,
        abschluesse: (b.perioden || []).map(p => ohneLeeres({ von: p.periodFrom, bis: p.periodTo, abgeschlossen_am: p.closedAt, von_wem: p.closedByName })),
        nachtraege: (b.nachtraege || []).length || undefined });
    },
  },
  {
    name: 'kollegen', title: 'Kollegen', annotations: LESEN,
    description: 'Das Kollegen-Verzeichnis: Name, Rolle und was die Kollegen selbst freigegeben haben (Telefon, E-Mail, Infotext).',
    eingabe: { nr: { type: 'integer', minimum: 1, description: 'Nummer eines Kollegen für Einzelheiten (leer = alle)' } },
    async ausfuehren(a, ktx) {
      if (a.nr) { const b = await hole(ktx, `/api/kollegen/${a.nr}`); const k = b.kollege || b;
        return ohneLeeres({ nr: k.id, name: k.name, rolle: k.role, telefon: k.telefon, email: k.email, info: k.infotext || k.info }); }
      return { kollegen: ((await hole(ktx, '/api/kollegen')).kollegen || []).map(k => ({ nr: k.id, name: k.name, rolle: k.role })) };
    },
  },

  // ── Schreiben (nur Schlüssel mit Recht „lesen + schreiben"; Entscheidung D: zunächst nur Zeiteinträge) ──
  // Beide gehen durch POST/PUT /api/entries — mit allen Prüfungen der App: Zeiten, Pause, Abrechnungssperre,
  // Doppel-Rückfrage, eigene vs. fremde Einträge. „vorschau" läuft durch genau diese Prüfungen und schreibt nichts.
  {
    name: 'zeiteintrag_anlegen', title: 'Zeiteintrag anlegen', schreibt: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Legt einen Zeiteintrag für den Benutzer dieses Schlüssels an (Admin: für den angegebenen Mitarbeiter). Es gelten alle Prüfungen der App. Tipp: erst mit vorschau=true prüfen und dem Menschen zeigen, dann ohne Vorschau anlegen. Löschen ist über diese Schnittstelle nicht möglich.',
    eingabe: { ...EINTRAG_FELDER, mitarbeiter: { ...S.mitarbeiter, description: 'Nur für Admin-Schlüssel: für wen der Eintrag ist' } },
    pflicht: ['datum', 'von', 'bis'],
    async ausfuehren(a, ktx) {
      const body = await eintragKoerper(ktx, a);
      if (a.mitarbeiter !== undefined) body.user_id = await mitarbeiterNr(ktx, a.mitarbeiter);
      return schreibenAuswerten(await intern(ktx, 'POST', '/api/entries', body), a.vorschau, 'angelegt');
    },
  },
  {
    name: 'zeiteintrag_aendern', title: 'Zeiteintrag ändern', schreibt: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Ändert einen bestehenden Zeiteintrag (Nummer aus zeiteintraege_suchen). Nur angegebene Felder werden geändert. Eigene Einträge; fremde nur mit Admin-Schlüssel und grund. Der alte Stand bleibt im Änderungsverlauf. Tipp: erst mit vorschau=true.',
    eingabe: { nr: { type: 'integer', minimum: 1, description: 'Nummer des Zeiteintrags' }, ...EINTRAG_FELDER },
    pflicht: ['nr'],
    async ausfuehren(a, ktx) {
      const body = await eintragKoerper(ktx, a);
      if (Object.keys(body).filter(k => !['vorschau', 'doppelt_ok', 'reason'].includes(k)).length === 0) throw new Hinweis('Nichts zu ändern — bitte mindestens ein Feld angeben.');
      return schreibenAuswerten(await intern(ktx, 'PUT', `/api/entries/${a.nr}`, body), a.vorschau, 'geändert');
    },
  },

  // ── Seit 14.11.2026 abends (Alex): Material, Abwesenheit, Werkzeug ──
  {
    name: 'material_bestellen', title: 'Material bestellen', schreibt: true, annotations: SCHREIBT,
    description: 'Gibt eine Material-Bestellung auf — wie das Bestellformular der App (landet in „offene Bestellungen", wer bestellen darf, bekommt eine Meldung). Mit Auftrag wird für die Baustelle bestellt, ohne fürs Lager. Ändern oder Löschen von Bestellungen geht hier nicht. Tipp: erst mit vorschau=true.',
    eingabe: { material: { type: 'string', maxLength: 200, description: 'Was bestellt werden soll' },
      menge: { type: 'integer', minimum: 1, maximum: 100000, description: 'Anzahl' },
      einheit: { type: 'string', maxLength: 20, description: 'Einheit, z. B. Stk, m, Rolle' },
      kommentar: { type: 'string', maxLength: 500, description: 'Hinweis, z. B. Händler oder Artikelnummer' },
      auftrag: { type: 'string', maxLength: 200, description: 'Auftrag (Nummer oder Name) — leer = fürs Lager' },
      produkt_nr: { type: 'integer', minimum: 1, description: 'Nummer aus lager_suchen, falls bekannt' },
      vorschau: VORSCHAU },
    pflicht: ['material'],
    async ausfuehren(a, ktx) {
      let projekt = null;
      if (a.auftrag) { projekt = await auftragFinden(ktx, a.auftrag); if (!projekt) throw new Hinweis(`Kein Auftrag „${a.auftrag}" gefunden. Ohne Auftrag geht die Bestellung ans Lager.`); }
      const b = geschrieben(await intern(ktx, 'POST', '/api/orders', { product: a.material, quantity: a.menge, unit: a.einheit, comment: a.kommentar,
        project_id: projekt ? projekt.id : null, product_id: a.produkt_nr, vorschau: a.vorschau === true }));
      const o = b.order || {};
      const kurz = ohneLeeres({ nr: o.id, menge: o.quantity, einheit: o.unit, material: o.product, kommentar: o.comment, fuer: o.location_text });
      return b.vorschau ? { vorschau: true, gespeichert: false, wuerde_ergeben: kurz, hinweis: 'Alle Prüfungen bestanden. Ohne vorschau erneut aufrufen, um zu bestellen.' }
        : { gespeichert: true, bestellung: kurz };
    },
  },
  {
    name: 'abwesenheit_eintragen', title: 'Abwesenheit eintragen/beantragen', schreibt: true, annotations: SCHREIBT,
    description: 'Trägt eine Abwesenheit für den Benutzer dieses Schlüssels ein — wie in der App: Urlaub, Freizeitausgleich und Sonderurlaub werden BEANTRAGT (Chef/Admin genehmigt), Krank, Berufsschule und Innung sind sofort eingetragen. Es gelten die Prüfungen der App (Überschneidungen, abgerechnete Monate). Nur für sich selbst, keine Feiertage. Tipp: erst mit vorschau=true — sie zeigt auch, ob der Resturlaub reicht.',
    eingabe: { art: { type: 'string', enum: Object.keys(ABW_ART), description: 'urlaub, fza (Freizeitausgleich), sonderurlaub, krank, berufsschule, innung' },
      von: { type: 'string', format: 'date', description: 'Erster Tag, JJJJ-MM-TT' },
      bis: { type: 'string', format: 'date', description: 'Letzter Tag, JJJJ-MM-TT (Standard: wie von)' },
      kommentar: { type: 'string', maxLength: 500, description: 'Kommentar (optional)' },
      vorschau: VORSCHAU },
    pflicht: ['art', 'von'],
    async ausfuehren(a, ktx) {
      const b = geschrieben(await intern(ktx, 'POST', '/api/absences', { type: ABW_ART[a.art], date_from: a.von, date_to: a.bis || a.von,
        comment: a.kommentar, vorschau: a.vorschau === true }));
      const x = b.absence || {};
      const kurz = ohneLeeres({ nr: x.id, art: ABWESENHEIT[x.type] || x.type, von: x.date_from, bis: x.date_to, status: ABW_STATUS[x.status] || x.status, kommentar: x.comment });
      const warnung = b.warning ? (typeof b.warning === 'string' ? b.warning : (b.warning.text || b.warning.message || JSON.stringify(b.warning))) : undefined;
      return ohneLeeres(b.vorschau ? { vorschau: true, gespeichert: false, wuerde_ergeben: kurz, warnung, hinweis: 'Alle Prüfungen bestanden. Ohne vorschau erneut aufrufen, um einzutragen.' }
        : { gespeichert: true, abwesenheit: kurz, warnung });
    },
  },
  {
    name: 'werkzeug_entnehmen', title: 'Werkzeug entnehmen', schreibt: true, annotations: SCHREIBT,
    description: 'Vermerkt, dass der Benutzer dieses Schlüssels ein Werkzeug hat — wie „Entnehmen" auf der Werkzeugseite. Hat es gerade ein Kollege, nur mit uebernehmen=true (wie „Übernehmen"). Tipp: erst mit vorschau=true.',
    eingabe: { werkzeug: { type: 'string', maxLength: 100, description: 'Werkzeug: Name (Teil genügt) oder Nummer aus werkzeuge_liste' },
      auftrag: { type: 'string', maxLength: 200, description: 'Für welchen Auftrag (Nummer oder Name; sonst als Freitext)' },
      adresse: { type: 'string', maxLength: 300, description: 'Wo das Werkzeug ist' },
      uebernehmen: { type: 'boolean', description: 'Von dem Kollegen übernehmen, der es gerade hat' },
      vorschau: VORSCHAU },
    pflicht: ['werkzeug'],
    async ausfuehren(a, ktx) {
      const t = await werkzeugFinden(ktx, a.werkzeug);
      let wo = 'checkout';
      if (t.checkout_id) {
        if (t.checked_out_by === ktx.user.id) throw new Hinweis(`Du hast „${t.name}" schon (seit ${t.checked_out_at}).`);
        if (!a.uebernehmen) throw new Hinweis(`„${t.name}" ist gerade bei ${t.checked_out_by_name} (seit ${t.checked_out_at}). Zum Übernehmen mit uebernehmen=true erneut aufrufen.`);
        wo = 'takeover';
      }
      const body = { vorschau: a.vorschau === true, address: a.adresse || null };
      if (a.auftrag) { const p = await auftragFinden(ktx, a.auftrag); if (p) body.project_id = p.id; else body.project_text = a.auftrag; }
      const b = geschrieben(await intern(ktx, 'POST', `/api/tools/${t.id}/${wo}`, body));
      const was = wo === 'takeover' ? `von ${t.checked_out_by_name} übernommen` : 'entnommen';
      return b.vorschau ? { vorschau: true, gespeichert: false, wuerde: `„${t.name}" ${was}`, hinweis: 'Alle Prüfungen bestanden. Ohne vorschau erneut aufrufen.' }
        : { gespeichert: true, werkzeug: t.name, vorgang: was };
    },
  },
  {
    name: 'werkzeug_zurueckgeben', title: 'Werkzeug zurückgeben', schreibt: true, annotations: SCHREIBT,
    description: 'Gibt ein Werkzeug zurück (wieder frei) — wie „Zurückgeben" auf der Werkzeugseite. Fremde Werkzeuge nur als Chef/Admin. Tipp: erst mit vorschau=true.',
    eingabe: { werkzeug: { type: 'string', maxLength: 100, description: 'Werkzeug: Name (Teil genügt) oder Nummer' }, vorschau: VORSCHAU },
    pflicht: ['werkzeug'],
    async ausfuehren(a, ktx) {
      const t = await werkzeugFinden(ktx, a.werkzeug);
      if (!t.checkout_id) throw new Hinweis(`„${t.name}" ist gar nicht entnommen.`);
      const b = geschrieben(await intern(ktx, 'POST', `/api/tools/${t.id}/return`, { vorschau: a.vorschau === true }));
      return b.vorschau ? { vorschau: true, gespeichert: false, wuerde: `„${t.name}" zurückgeben (bisher bei ${t.checked_out_by_name})`, hinweis: 'Ohne vorschau erneut aufrufen.' }
        : { gespeichert: true, werkzeug: t.name, vorgang: 'zurückgegeben' };
    },
  },

  // ── Schwarzes Brett (Alex, 14.11.2026): nur wer in der App das Recht dazu hat — die Route entscheidet ──
  {
    name: 'aushang_anlegen', title: 'Aushang anlegen', schreibt: true, annotations: SCHREIBT,
    description: 'Hängt einen Aushang ans Schwarze Brett — wie in der App, nur mit dem Recht „Schwarzes Brett" (Chef/Admin immer). Alle bekommen eine Meldung. Löschen geht hier nicht. Tipp: erst mit vorschau=true.',
    eingabe: { titel: { type: 'string', maxLength: 200, description: 'Überschrift' }, text: { type: 'string', maxLength: 5000, description: 'Text des Aushangs' },
      termin: { type: 'string', format: 'date', description: 'Termin, um den es geht (JJJJ-MM-TT, optional)' },
      entfernen_am: { type: 'string', format: 'date', description: 'Aushang an diesem Tag automatisch entfernen (JJJJ-MM-TT, optional)' },
      vorschau: VORSCHAU },
    pflicht: ['titel'],
    async ausfuehren(a, ktx) {
      const b = brett(await intern(ktx, 'POST', '/api/bulletin', { title: a.titel, text: a.text || '', event_date: a.termin || null,
        auto_delete_date: a.entfernen_am || null, vorschau: a.vorschau === true }));
      const e = b.entry || {};
      const kurz = ohneLeeres({ nr: e.id, titel: e.title, text: kuerzen(e.text, 500), termin: e.event_date, entfernt_am: e.auto_delete_date });
      return b.vorschau ? { vorschau: true, gespeichert: false, wuerde_ergeben: kurz, hinweis: 'Recht und Angaben geprüft. Ohne vorschau erneut aufrufen, um auszuhängen.' }
        : { gespeichert: true, aushang: kurz };
    },
  },
  {
    name: 'aushang_aendern', title: 'Aushang ändern', schreibt: true, annotations: { ...SCHREIBT, destructiveHint: true, idempotentHint: true },
    description: 'Ändert einen Aushang (Nummer aus der Liste der Aushänge). Nur angegebene Felder werden geändert. Nur mit dem Recht „Schwarzes Brett". Tipp: erst mit vorschau=true.',
    eingabe: { nr: { type: 'integer', minimum: 1, description: 'Nummer des Aushangs' }, titel: { type: 'string', maxLength: 200, description: 'Neue Überschrift' },
      text: { type: 'string', maxLength: 5000, description: 'Neuer Text' }, termin: { type: 'string', format: 'date', description: 'Neuer Termin (JJJJ-MM-TT)' },
      entfernen_am: { type: 'string', format: 'date', description: 'Neues Entfernen-Datum (JJJJ-MM-TT)' }, vorschau: VORSCHAU },
    pflicht: ['nr'],
    async ausfuehren(a, ktx) {
      const body = { vorschau: a.vorschau === true };
      if (a.titel !== undefined) { if (!a.titel.trim()) throw new Hinweis('Die Überschrift darf nicht leer sein.'); body.title = a.titel; }
      if (a.text !== undefined) body.text = a.text;
      if (a.termin !== undefined) body.event_date = a.termin;
      if (a.entfernen_am !== undefined) body.auto_delete_date = a.entfernen_am;
      if (Object.keys(body).length === 1) throw new Hinweis('Nichts zu ändern — bitte mindestens ein Feld angeben.');
      const b = brett(await intern(ktx, 'PUT', `/api/bulletin/${a.nr}`, body));
      const e = b.entry || {};
      const kurz = ohneLeeres({ nr: e.id || a.nr, titel: e.title, text: kuerzen(e.text, 500), termin: e.event_date, entfernt_am: e.auto_delete_date });
      if (b.vorschau) return { vorschau: true, gespeichert: false, wuerde_ergeben: kurz, hinweis: 'Ohne vorschau erneut aufrufen, um zu speichern.' };
      return b.unchanged ? { gespeichert: false, hinweis: 'Keine Änderung — der Aushang ist schon so.', aushang: kurz } : { gespeichert: true, aushang: kurz };
    },
  },

  // ── „Mein Konto" und Zeitnachweis-PDF (Alex, 15.11.2026) ──
  {
    name: 'mein_konto', title: 'Mein Konto', annotations: LESEN,
    description: 'Alles von der Seite „Mein Konto" des Benutzers dieses Schlüssels: Stammdaten und Rechte, Benachrichtigungen (welche Push-Kategorien an sind, geplante Zusammenfassungen), Gesetzeswarnungen, was die Kollegen sehen (Infotext, Telefon, E-Mail, Geburtstag) und eigene Überstunden-Auszahlungen. Zugangsschlüssel, Passwort und Zwei-Faktor stehen nur in der App.',
    eingabe: {},
    async ausfuehren(a, ktx) {
      const [st, push, zus, warn, kol, aus] = await Promise.all([
        hole(ktx, '/api/users/meine-stammdaten'), hole(ktx, '/api/push/prefs'), hole(ktx, '/api/push/summaries'),
        hole(ktx, '/api/users/warnungen'), hole(ktx, '/api/kollegen/mein-profil'),
        hole(ktx, '/api/payouts').catch(e => { if (e instanceof Hinweis) return {}; throw e; }),
      ]);
      const s = st.stammdaten || {};
      return ohneLeeres({
        stammdaten: ohneLeeres({ name: s.name, benutzername: s.benutzername, rolle: s.rolle, personalnummer: s.personalnummer, geburtsdatum: s.geburtsdatum,
          soll_stunden_woche: s.soll_stunden_woche, arbeitsbeginn: s.arbeitsbeginn, urlaubstage_jahr: s.urlaubstage_jahr, start_ueberstunden: s.start_ueberstunden || undefined,
          anstellung: (s.anstellung || []).map(z => ({ von: z.start_date, bis: z.end_date || 'heute' })),
          rechte: Object.entries(s.rechte || {}).filter(([, v]) => v).map(([k, v]) => typeof v === 'string' ? `${k}: ${v}` : k) }),
        benachrichtigungen: {
          push: Object.fromEntries(Object.entries(PUSH_KAT).map(([de, en]) => [de, push[en] !== false])),
          hinweis: 'Push kommt nur auf Geräten an, auf denen die App Benachrichtigungen erlaubt hat (Mein Konto → Benachrichtigungen).',
          zusammenfassungen_alle_pausiert: !!zus.pausedAll,
          zusammenfassungen: (zus.schedules || []).map(z => ohneLeeres({ nr: z.id, name: z.name, wochentage: z.weekdays.map(d => TAGE[d - 1]), uhrzeit: z.time,
            kategorien: z.cats.map(c => KAT_DE[c] || c), pausiert: z.paused || undefined })),
        },
        gesetzeswarnungen: { pausen: !!warn.pausen, hoechstarbeitszeit: !!warn.arbeitszeit, ruhezeit: !!warn.ruhezeit },
        fuer_kollegen: ohneLeeres({ infotext: kol.info, telefon: kol.telefon, telefon_sichtbar: kol.telefon ? !!kol.telefon_zeigen : undefined,
          email: kol.email, email_sichtbar: kol.email ? !!kol.email_zeigen : undefined, geburtstag_sichtbar: !!kol.geburtstag_zeigen,
          alter_sichtbar: kol.geburtstag_zeigen ? !!kol.alter_zeigen : undefined }),
        ueberstunden_auszahlungen: ((aus && aus.auszahlungen) || []).filter(z => z.user_id === ktx.user.id).map(z => ohneLeeres({ stunden: z.stunden, wirksam_ab: z.wirksam_ab, status: z.status, grund: z.grund })),
      });
    },
  },
  {
    name: 'zeitnachweis_pdf', title: 'Zeitnachweis als PDF', annotations: LESEN,
    description: 'Erzeugt den Zeitnachweis als PDF — dasselbe Dokument wie „Zeitnachweis als PDF" in der App — und liefert es als Datei (eingebettete Ressource, application/pdf). Mitarbeiter bekommen immer ihren eigenen; Chef/Admin/Buchhaltung wahlweise für einen Mitarbeiter oder alle. Zusätzlich steht eine Download-Adresse dabei, die mit demselben Schlüssel funktioniert.',
    eingabe: { von: { type: 'string', format: 'date', description: 'Erster Tag, JJJJ-MM-TT' }, bis: { type: 'string', format: 'date', description: 'Letzter Tag, JJJJ-MM-TT' },
      mitarbeiter: { ...S.mitarbeiter, description: 'Nur für Chef/Admin/Buchhaltung: Name oder Nummer (leer = alle)' },
      auftrag: { type: 'string', maxLength: 200, description: 'Nur Einträge dieses Auftrags (Nummer oder Name)' } },
    pflicht: ['von', 'bis'],
    async ausfuehren(a, ktx) {
      if (a.von > a.bis) throw new Hinweis('„von" liegt nach „bis".');
      const uid = ktx.user.role === 'mitarbeiter' ? null : await mitarbeiterNr(ktx, a.mitarbeiter);
      let projekt = null;
      if (a.auftrag) { projekt = await auftragFinden(ktx, a.auftrag); if (!projekt) throw new Hinweis(`Kein Auftrag „${a.auftrag}" gefunden.`); }
      const pfad = '/api/pdf/export' + q({ date_from: a.von, date_to: a.bis, user_id: uid, project_id: projekt && projekt.id });
      const r = await intern(ktx, 'GET', pfad, null, true);
      if (r.status !== 200 || !/application\/pdf/.test(r.typ)) {
        if (r.status >= 500) throw new Error('PDF: Route antwortet ' + r.status);
        throw new Hinweis((r.body && r.body.error) || `PDF nicht erzeugt (${r.status}).`);
      }
      if (r.roh.length > PDF_MAX) throw new Hinweis(`Das PDF ist zu groß für die Übertragung (${Math.round(r.roh.length / 1048576)} MB). Bitte einen kürzeren Zeitraum wählen oder die Download-Adresse nutzen.`);
      const seiten = (r.roh.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      const datei = `zeitnachweis_${a.von}_${a.bis}.pdf`;
      return {
        datei, seiten, groesse_kb: Math.round(r.roh.length / 1024), zeitraum: { von: a.von, bis: a.bis },
        download: { adresse: ktx.basis + pfad, kopfzeile: 'Authorization: Bearer <derselbe Schlüssel>' },
        __inhalt: [{ type: 'resource', resource: { uri: `arbeitsdoku://zeitnachweis/${datei}`, mimeType: 'application/pdf', blob: r.roh.toString('base64') } }],
      };
    },
  },
  {
    name: 'benachrichtigungen_einstellen', title: 'Benachrichtigungen einstellen', schreibt: true, annotations: { ...SCHREIBT, idempotentHint: true },
    description: 'Schaltet Push-Benachrichtigungen je Kategorie an oder aus (wie „Mein Konto → Benachrichtigungen"). Nur angegebene Kategorien ändern sich. Ob überhaupt Push ankommt, entscheidet das Gerät in der App.',
    eingabe: Object.fromEntries(Object.keys(PUSH_KAT).map(de => [de, { type: 'boolean', description: `Push für ${PUSH_TEXT[de]}` }])),
    async ausfuehren(a, ktx) {
      const body = {};
      for (const [de, en] of Object.entries(PUSH_KAT)) if (a[de] !== undefined) body[en] = a[de];
      if (!Object.keys(body).length) throw new Hinweis(`Bitte mindestens eine Kategorie angeben: ${Object.keys(PUSH_KAT).join(', ')}.`);
      const b = geschrieben(await intern(ktx, 'PUT', '/api/push/prefs', body));
      return { gespeichert: true, push: Object.fromEntries(Object.entries(PUSH_KAT).map(([de, en]) => [de, b[en] !== false])) };
    },
  },
  {
    name: 'gesetzeswarnungen_einstellen', title: 'Gesetzeswarnungen einstellen', schreibt: true, annotations: { ...SCHREIBT, idempotentHint: true },
    description: 'Schaltet die persönlichen Hinweise zu Pausen, Höchstarbeitszeit und Ruhezeit (ArbZG/JArbSchG) im Zeitnachweis an oder aus. Nur angegebene ändern sich.',
    eingabe: { pausen: { type: 'boolean', description: 'Hinweis bei zu kurzer Pause' }, hoechstarbeitszeit: { type: 'boolean', description: 'Hinweis bei Überschreiten der Höchstarbeitszeit' },
      ruhezeit: { type: 'boolean', description: 'Hinweis bei zu kurzer Ruhezeit' } },
    async ausfuehren(a, ktx) {
      if (a.pausen === undefined && a.hoechstarbeitszeit === undefined && a.ruhezeit === undefined) throw new Hinweis('Bitte mindestens einen Schalter angeben.');
      // Die Route setzt fehlende Felder auf „an" — deshalb den aktuellen Stand mitschicken
      const jetzt = await hole(ktx, '/api/users/warnungen');
      const neu = { pausen: a.pausen ?? !!jetzt.pausen, arbeitszeit: a.hoechstarbeitszeit ?? !!jetzt.arbeitszeit, ruhezeit: a.ruhezeit ?? !!jetzt.ruhezeit };
      geschrieben(await intern(ktx, 'PUT', '/api/users/warnungen', neu));
      return { gespeichert: true, gesetzeswarnungen: { pausen: neu.pausen, hoechstarbeitszeit: neu.arbeitszeit, ruhezeit: neu.ruhezeit } };
    },
  },
  {
    name: 'kollegen_profil_aendern', title: 'Was die Kollegen sehen', schreibt: true, annotations: { ...SCHREIBT, idempotentHint: true },
    description: 'Ändert, was die Kollegen im Kollegen-Verzeichnis über dich sehen: Infotext, Telefon, E-Mail (jeweils mit sichtbar ja/nein) und ob Geburtstag/Alter angezeigt werden. Nur angegebene Felder ändern sich; leerer Text löscht den Eintrag.',
    eingabe: { infotext: { type: 'string', maxLength: 1000, description: 'Infotext für die Kollegen' },
      telefon: { type: 'string', maxLength: 40, description: 'Telefonnummer' }, telefon_sichtbar: { type: 'boolean', description: 'Telefon für Kollegen sichtbar' },
      email: { type: 'string', maxLength: 120, description: 'E-Mail-Adresse' }, email_sichtbar: { type: 'boolean', description: 'E-Mail für Kollegen sichtbar' },
      geburtstag_sichtbar: { type: 'boolean', description: 'Geburtstag (Tag und Monat) für Kollegen sichtbar' }, alter_sichtbar: { type: 'boolean', description: 'Auch das Alter zeigen (nur zusammen mit dem Geburtstag)' } },
    async ausfuehren(a, ktx) {
      if (!Object.keys(a).length) throw new Hinweis('Bitte mindestens ein Feld angeben.');
      const jetzt = await hole(ktx, '/api/kollegen/mein-profil');
      const profil = Object.keys(a).some(k => ['infotext', 'telefon', 'telefon_sichtbar', 'email', 'email_sichtbar'].includes(k));
      let p = null;
      if (profil) {
        p = geschrieben(await intern(ktx, 'PUT', '/api/kollegen/mein-profil', {
          info: a.infotext ?? jetzt.info, telefon: a.telefon ?? jetzt.telefon, telefon_zeigen: a.telefon_sichtbar ?? jetzt.telefon_zeigen,
          email: a.email ?? jetzt.email, email_zeigen: a.email_sichtbar ?? jetzt.email_zeigen }));
      }
      let g = null;
      if (a.geburtstag_sichtbar !== undefined || a.alter_sichtbar !== undefined) {
        g = geschrieben(await intern(ktx, 'PUT', '/api/users/geburtstag-freigabe', {
          zeigen: a.geburtstag_sichtbar ?? jetzt.geburtstag_zeigen, alter_auch: a.alter_sichtbar ?? jetzt.alter_zeigen }));
      }
      const n = p || { info: jetzt.info, telefon: jetzt.telefon, telefon_zeigen: jetzt.telefon_zeigen, email: jetzt.email, email_zeigen: jetzt.email_zeigen };
      const gz = g ? !!g.zeigen : !!jetzt.geburtstag_zeigen;
      return { gespeichert: true, fuer_kollegen: ohneLeeres({ infotext: n.info, telefon: n.telefon, telefon_sichtbar: n.telefon ? !!n.telefon_zeigen : undefined,
        email: n.email, email_sichtbar: n.email ? !!n.email_zeigen : undefined, geburtstag_sichtbar: gz,
        alter_sichtbar: gz ? (g ? !!g.alter_auch : !!jetzt.alter_zeigen) : undefined }),
        hinweis: (a.geburtstag_sichtbar && !jetzt.geburtsdatum_hinterlegt) ? 'Es ist kein Geburtsdatum hinterlegt — sichtbar wird erst etwas, wenn die Verwaltung es einträgt.' : undefined };
    },
  },
  {
    name: 'zusammenfassung_planen', title: 'Geplante Zusammenfassung', schreibt: true, annotations: SCHREIBT,
    description: 'Legt eine geplante Zusammenfassung (Sammel-Push zu festen Zeiten) an oder ändert eine bestehende (mit nr) — wie „Mein Konto → Zusammenfassungen". Einzeln pausieren mit pausiert=true. Löschen geht hier nicht.',
    eingabe: { nr: { type: 'integer', minimum: 1, description: 'Nummer einer bestehenden Zusammenfassung (leer = neu anlegen)' },
      name: { type: 'string', maxLength: 40, description: 'Name, z. B. „Morgens"' },
      wochentage: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Wochentage 1 = Montag … 7 = Sonntag' },
      uhrzeit: { ...UHR, description: 'Uhrzeit HH:MM' },
      kategorien: { type: 'array', maxItems: 5, items: { type: 'string', enum: Object.keys(ZUS_KAT) }, description: `Inhalt: ${Object.keys(ZUS_KAT).join(', ')}` },
      pausiert: { type: 'boolean', description: 'Diese Zusammenfassung pausieren (true) oder fortsetzen (false)' } },
    async ausfuehren(a, ktx) {
      const body = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.wochentage !== undefined) body.weekdays = a.wochentage;
      if (a.uhrzeit !== undefined) body.time = a.uhrzeit;
      if (a.kategorien !== undefined) body.cats = a.kategorien.map(k => ZUS_KAT[k]);
      if (a.pausiert !== undefined) body.paused = a.pausiert;
      if (!a.nr && (!a.wochentage || !a.uhrzeit || !a.kategorien)) throw new Hinweis('Für eine neue Zusammenfassung bitte wochentage, uhrzeit und kategorien angeben.');
      if (a.nr && !Object.keys(body).length) throw new Hinweis('Nichts zu ändern — bitte mindestens ein Feld angeben.');
      const b = geschrieben(await intern(ktx, a.nr ? 'PUT' : 'POST', a.nr ? `/api/push/summaries/${a.nr}` : '/api/push/summaries', body));
      const z = b.schedule || {};
      return { gespeichert: true, zusammenfassung: ohneLeeres({ nr: z.id, name: z.name, wochentage: (z.weekdays || []).map(d => TAGE[d - 1]), uhrzeit: z.time,
        kategorien: (z.cats || []).map(c => KAT_DE[c] || c), pausiert: z.paused || undefined }) };
    },
  },
  {
    name: 'zusammenfassungen_pausieren', title: 'Alle Zusammenfassungen pausieren', schreibt: true, annotations: { ...SCHREIBT, idempotentHint: true },
    description: 'Pausiert alle geplanten Zusammenfassungen auf einmal (z. B. im Urlaub) oder setzt sie fort.',
    eingabe: { pausiert: { type: 'boolean', description: 'true = alle pausieren, false = fortsetzen' } },
    pflicht: ['pausiert'],
    async ausfuehren(a, ktx) {
      const b = geschrieben(await intern(ktx, 'PUT', '/api/push/summaries/pause-all', { paused: a.pausiert }));
      return { gespeichert: true, alle_pausiert: !!b.pausedAll };
    },
  },
];
const MS = { offen: 'offen', doing: 'in Arbeit', done: 'erledigt' };
const DRINGLICHKEIT = { rot: 'dringend', orange: 'hoch', gelb: 'mittel', gruen: 'niedrig' };
function auftragKurz(p) {
  const ms = p.milestones || [];
  const summe = ms.reduce((s, m) => s + (Number(m.est_days) || 0), 0);
  const fertig = ms.filter(m => m.status === 'done').reduce((s, m) => s + (Number(m.est_days) || 0), 0);
  return ohneLeeres({ nr: p.id, name: p.name, kunde: p.client, adresse: p.address, dringlichkeit: DRINGLICHKEIT[p.urgency] || p.urgency,
    frist: p.due_date, erledigt: p.done ? true : undefined, zugeteilt: (p.assigned_users || []).map(u => u.name),
    kategorien: (p.categories || []).map(k => k.name), fortschritt_prozent: summe ? Math.round(fertig / summe * 100) : undefined,
    projektnotiz: p.notiz && p.notiz.hat_inhalt ? true : undefined });
}

// ── Eingabeprüfung (nur das, was die Werkzeuge oben benutzen) ──────────────────────────────────
function schema(w) {
  return { type: 'object', properties: Object.fromEntries(Object.entries(w.eingabe).map(([k, v]) => {
    const { format, ...rest } = v;   // „date" prüfen wir selbst; im Schema als Muster, das jeder Client versteht
    return [k, format === 'date' ? { ...rest, pattern: '^\\d{4}-\\d{2}-\\d{2}$' } : rest];
  })), required: w.pflicht || [], additionalProperties: false };
}
function eingabePruefen(w, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return 'Die Parameter müssen ein Objekt sein.';
  for (const k of Object.keys(args)) if (!w.eingabe[k]) return `Unbekannter Parameter „${k}". Erlaubt: ${Object.keys(w.eingabe).join(', ') || 'keine'}.`;
  for (const k of w.pflicht || []) if (args[k] === undefined || args[k] === null || args[k] === '') return `„${k}" fehlt.`;
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue;
    const s = w.eingabe[k];
    if (s.type === 'string') {
      if (typeof v !== 'string') return `„${k}" muss Text sein.`;
      if (s.maxLength && v.length > s.maxLength) return `„${k}" ist zu lang (höchstens ${s.maxLength} Zeichen).`;
      if (s.enum && !s.enum.includes(v)) return `„${k}" muss einer dieser Werte sein: ${s.enum.join(', ')}.`;
      if (s.format === 'date' && !istDatum(v)) return `„${k}" muss ein gültiges Datum JJJJ-MM-TT sein.`;
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `„${k}" hat nicht das erwartete Format${s.description ? ' (' + s.description + ')' : ''}.`;
    } else if (s.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) return `„${k}" muss eine ganze Zahl sein.`;
      if (s.minimum !== undefined && v < s.minimum) return `„${k}" muss mindestens ${s.minimum} sein.`;
      if (s.maximum !== undefined && v > s.maximum) return `„${k}" darf höchstens ${s.maximum} sein.`;
    } else if (s.type === 'boolean') {
      if (typeof v !== 'boolean') return `„${k}" muss true oder false sein.`;
    } else if (s.type === 'array') {
      if (!Array.isArray(v)) return `„${k}" muss eine Liste sein.`;
      if (s.maxItems !== undefined && v.length > s.maxItems) return `„${k}" hat zu viele Einträge (höchstens ${s.maxItems}).`;
      if (s.minItems !== undefined && v.length < s.minItems) return `„${k}" braucht mindestens ${s.minItems} Eintrag.`;
      const i = s.items || {};
      for (const x of v) {
        if (i.type === 'integer' && (typeof x !== 'number' || !Number.isInteger(x) || (i.minimum !== undefined && x < i.minimum) || (i.maximum !== undefined && x > i.maximum)))
          return `„${k}": jeder Eintrag muss eine ganze Zahl${i.minimum !== undefined ? ` von ${i.minimum} bis ${i.maximum}` : ''} sein.`;
        if (i.type === 'string' && (typeof x !== 'string' || (i.enum && !i.enum.includes(x))))
          return `„${k}": erlaubt sind ${i.enum ? i.enum.join(', ') : 'nur Texte'}.`;
      }
    }
  }
  return null;
}

/** Werkzeuge, die dieser Schlüssel benutzen darf. */
function fuer(recht) {
  return WERKZEUGE.filter(w => !w.schreibt || recht === 'schreiben');
}
function beschreibung(w) {
  return { name: w.name, title: w.title, description: w.description, inputSchema: schema(w), annotations: w.annotations };
}

module.exports = { WERKZEUGE, fuer, beschreibung, eingabePruefen, Hinweis, intern };
