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
function intern(ktx, methode, pfad, body) {
  return new Promise((resolve, reject) => {
    const daten = body ? JSON.stringify(body) : null;
    const { host, port } = eigeneAdresse();
    const r = http.request({ host, port, path: pfad, method: methode, headers: {
      Authorization: 'Bearer ' + ktx.roh, 'Content-Type': 'application/json', 'X-Intern': schluessel.INTERN,
      'X-Intern-Ip': ktx.ip || '', 'X-Intern-Werkzeug': ktx.werkzeug || '',
      ...(daten ? { 'Content-Length': Buffer.byteLength(daten) } : {}),
    } }, (x) => {
      let s = ''; x.setEncoding('utf8');
      x.on('data', c => { s += c; });
      x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: x.statusCode, body: j }); });
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
    else if (/^\d+$/.test(a.auftrag)) { b.project_id = Number(a.auftrag); b.project_text = ''; }
    else {
      const treffer = ((await hole(ktx, '/api/projects')).projects || []).filter(p => trifft(a.auftrag, p.name));
      const exakt = treffer.filter(p => norm(p.name) === norm(a.auftrag));
      const p = exakt.length === 1 ? exakt[0] : (treffer.length === 1 ? treffer[0] : null);
      if (!p && treffer.length > 1) throw new Hinweis(`Auftrag „${a.auftrag}" ist mehrdeutig: ${treffer.slice(0, 10).map(x => `${x.name} (${x.id})`).join(', ')}. Bitte die Nummer angeben.`);
      if (p) { b.project_id = p.id; b.project_text = ''; } else { b.project_id = null; b.project_text = a.auftrag; }
    }
  }
  return b;
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
      return { aushaenge: liste.map(x => ohneLeeres({ titel: x.title, text: kuerzen(x.text, 2000), termin: x.event_date, von: x.created_by_name, geaendert: x.updated_at || x.created_at })) };
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
