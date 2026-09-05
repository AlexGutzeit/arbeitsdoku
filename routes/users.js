const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { ROLLEN_MIT_BESTELLRECHT, bestellmeldungenAufraeumen } = require('../bestellrecht');
const { pruefeSperre, pruefeSperreGlobal, protokolliereEingriff, abgerechnetBis } = require('../abschluss');
const { istUhrzeit } = require('../zeit');
const zweiFaktor = require('../zweifaktor');
const { austrittsdatumSetzen, austrittsdatumAufheben, ausstellenVollziehen, berlinHeute } = require('../ausstellen');

const router = express.Router();

// Personalnummer des Lohnbueros (Lohn-Export C1). Bewusst KEINE Eindeutigkeitspruefung — die
// Nummern vergibt das Lohnbuero. Leer bleibt erlaubt; fuehrende Nullen bleiben erhalten (TEXT).
// Arbeitsbeginn (HH:MM). Leer/ungueltig behandeln wir NICHT gleich: leer heisst „Vorgabe 07:00",
// Unsinn wie „25:99" wird abgewiesen — sonst stuende spaeter eine unmoegliche Zeit im Formular.
function normArbeitsbeginn(v) {
  if (v === undefined || v === null) return undefined;      // nicht mitgeschickt -> unveraendert
  const t = String(v).trim();
  if (t === '') return '';                                  // leer -> Firmenwert (NULL in der DB)
  return istUhrzeit(t) ? t : null;                          // null = ungueltig, Aufrufer meldet 400
}

function normPersonalNr(v) {
  if (v === undefined || v === null) return undefined;      // Feld nicht mitgeschickt -> unveraendert
  const t = String(v).trim().slice(0, 32);
  return t === '' ? null : t;
}


// Gültige Rollen. 'admin' darf ausschließlich durch Admins vergeben werden (siehe POST/PUT).
const ROLES = ['mitarbeiter', 'buchhalter', 'chef', 'admin'];

// Anzahl AKTIVER Admins außer einem bestimmten Nutzer — für den „letzter Admin"-Schutz (S3):
// der letzte verbleibende Admin darf nicht herabgestuft/ausgestellt werden (sonst 0 Admins → Aussperrung).
function otherActiveAdmins(db, exceptId) {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND COALESCE(active,1) = 1 AND id != ?").get(exceptId).c;
}

// Passwort-Policy (serverseitig erzwungen — Quelle der Wahrheit; das Frontend spiegelt sie nur).
// Gilt beim Anlegen UND Zurücksetzen. Der Login prüft NICHTS davon → Altpasswörter bleiben nutzbar.
function passwordPolicyError(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Passwort: mindestens 8 Zeichen';
  if (pw.length > 72) return 'Passwort: höchstens 72 Zeichen';        // bcrypt nutzt nur die ersten 72 Bytes
  if (!/[a-z]/.test(pw)) return 'Passwort: mindestens ein Kleinbuchstabe';
  if (!/[A-Z]/.test(pw)) return 'Passwort: mindestens ein Großbuchstabe';
  if (!/[0-9]/.test(pw)) return 'Passwort: mindestens eine Ziffer';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Passwort: mindestens ein Sonderzeichen';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'Passwort darf nicht dem Benutzernamen entsprechen';
  return null;
}

// Felder, die im Audit-Log nachvollziehbar protokolliert werden (Label + Formatter).
// Das Passwort wird BEWUSST nie geloggt.
// Geburtsdatum: nur fuer die Altersgrenze der Pausenregeln. Leer ist erlaubt und bedeutet
// „unbekannt" — dann gilt der strengere Jugendschutz. Ein unmoegliches Datum wird abgewiesen,
// damit aus einem Tippfehler kein falsches Alter wird.
const GEBURT_FEHLER = 'Ungültiges Geburtsdatum (erwartet JJJJ-MM-TT, ein realer Tag, nicht in der Zukunft)';
function normGeburtsdatum(v) {
  if (v === undefined) return '';                       // Feld nicht mitgeschickt → unveraendert
  const s = String(v ?? '').trim();
  if (!s) return '';                                    // bewusst geleert
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  if (s > heute) return null;                           // in der Zukunft geboren gibt es nicht
  if (s < '1900-01-01') return null;
  return s;
}

const USER_AUDIT_FIELDS = [
  ['username', 'Benutzername', v => String(v ?? '')],
  ['name', 'Name', v => String(v ?? '')],
  ['role', 'Rolle', v => String(v ?? '')],
  ['target_hours_per_week', 'Soll-Stunden/Woche', v => String(v ?? '')],
  ['start_overtime', 'Start-Überstunden', v => String(v ?? 0)],
  ['personnel_no', 'Personalnummer', v => String(v ?? '')],
  ['work_start', 'Arbeitsbeginn', v => (v ? String(v) : '(Firmenwert)')],
  ['birth_date', 'Geburtsdatum', v => (v ? String(v) : '(nicht hinterlegt)')],
  ['can_bulletin', 'Recht Schwarzes Brett', v => (v ? 'Ja' : 'Nein')],
  ['can_upload', 'Recht Dokumente-Upload', v => (v ? 'Ja' : 'Nein')],
  ['can_order', 'Recht Bestellungen abschließen', v => (v ? 'Ja' : 'Nein')],
];
// Planungsrecht semantisch als EINE Stufe (statt zwei Boolescher Felder), damit im Audit auf einen Blick
// erkennbar ist, WELCHER Stand gilt — insbesondere „alle → nur sich" (nur die alle-Stufe entzogen).
function planLevel(u) {
  if (u.can_plan_all) return 'alle';
  if (u.can_plan) return 'nur sich';
  return 'keins';
}
// Alle relevanten Felder eines neuen Benutzers als Klartext.
function userAuditCreate(u) {
  const parts = USER_AUDIT_FIELDS.map(([k, label, fmt]) => `${label}: ${fmt(u[k])}`);
  parts.push(`Planungsrecht: ${planLevel(u)}`);
  return parts.join(', ');
}
// Nur die geaenderten Felder als "Feld: alt → neu".
function userAuditDiff(before, after) {
  const changes = [];
  for (const [k, label, fmt] of USER_AUDIT_FIELDS) {
    if (fmt(before[k]) !== fmt(after[k])) changes.push(`${label}: ${fmt(before[k])} → ${fmt(after[k])}`);
  }
  if (planLevel(before) !== planLevel(after)) {
    changes.push(`Planungsrecht: ${planLevel(before)} → ${planLevel(after)}`);
  }
  return changes;
}

// Haengt jedem User seine Anstellungszeitraeume an (kompakt: [{s,e}], e=null = aktuell angestellt).
// Damit kann das Frontend MA aus Perioden-Ansichten ausblenden, in denen sie (noch) nicht angestellt sind.
function attachEmployment(db, users) {
  if (!users.length) return users;
  const ids = users.map(u => u.id);
  const rows = db.prepare(
    `SELECT user_id, start_date, end_date FROM employment_periods WHERE user_id IN (${ids.map(() => '?').join(',')}) ORDER BY start_date ASC`
  ).all(...ids);
  const byUser = {};
  for (const r of rows) (byUser[r.user_id] || (byUser[r.user_id] = [])).push({ s: r.start_date, e: r.end_date });
  for (const u of users) u.employment = byUser[u.id] || [];
  return users;
}

// Einfache Benutzerliste (id + name) für alle authentifizierten User (z.B. Regie-Dropdown).
// Default nur AKTIVE (fuer Zuweisungs-Picker neuer Arbeit); ?all=1 schliesst Ausgestellte ein
// (z.B. fuer Historien-Filter), inkl. active-Flag zum Kennzeichnen.
router.get('/list', authenticate, (req, res) => {
  const db = getDb();
  const all = req.query.all === '1' || req.query.all === 'true';
  const users = all
    ? db.prepare("SELECT id, name, role, active FROM users WHERE role != 'admin' ORDER BY name").all()
    : db.prepare("SELECT id, name, role, active FROM users WHERE role != 'admin' AND active = 1 ORDER BY name").all();
  res.json({ users: attachEmployment(db, users) });
});

// Wer hat heute Geburtstag? Fuer die Einblendung auf der Willkommensseite.
//
// Datenschutz: Chef/Admin/Buchhalter bekommen `birth_date` ueber GET /api/users ohnehin — hier
// wird also nichts Neues offengelegt. Fuer die BELEGSCHAFT waere eine Anzeige einwilligungspflichtig
// (§ 26 BDSG traegt sie nicht), deshalb gibt es diesen Endpunkt bewusst nur fuer diese drei Rollen.
// Trotzdem verlaesst das Geburtsdatum selbst den Server nicht — nur Name und Alter.
// Eigene Geburtstags-Freigabe lesen und setzen. Immer gegen req.user.id — es gibt keinen Weg,
// darueber die Freigabe eines anderen zu aendern. MUSS vor "/:id" stehen.
router.get('/geburtstag-freigabe', authenticate, (req, res) => {
  const db = getDb();
  let zeile = null;
  try { zeile = db.prepare('SELECT zeigen, alter_auch FROM geburtstag_freigabe WHERE user_id = ?').get(req.user.id); } catch (_) {}
  res.json({
    // Das eigene Geburtsdatum wird bewusst mitgeliefert: Der Mitarbeiter soll sehen, was die
    // Verwaltung hinterlegt hat, und einen Zahlendreher melden koennen.
    geburtsdatum: req.user.birth_date || null,
    zeigen: !!(zeile && zeile.zeigen),
    alter_auch: !!(zeile && zeile.alter_auch),
  });
});

// Eigene Warn-Schalter lesen und setzen. Wie bei der Geburtstags-Freigabe immer gegen
// req.user.id — es gibt keinen Weg, damit die Anzeige eines anderen zu verstellen.
// FEHLENDE Zeile heisst: alles an. Wer nichts einstellt, bekommt die Warnungen.
// MUSS vor "/:id" stehen.
router.get('/warnungen', authenticate, (req, res) => {
  const db = getDb();
  let z = null;
  try { z = db.prepare('SELECT pausen, arbeitszeit, ruhezeit FROM warnung_prefs WHERE user_id = ?').get(req.user.id); } catch (_) {}
  res.json({
    pausen: z ? !!z.pausen : true,
    arbeitszeit: z ? !!z.arbeitszeit : true,
    ruhezeit: z ? !!z.ruhezeit : true,
  });
});

router.put('/warnungen', authenticate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  // Fehlt ein Feld, bleibt es AN — ein unvollstaendiger Aufruf darf keine Warnung stillegen.
  const werte = {
    pausen: b.pausen === undefined ? 1 : (b.pausen ? 1 : 0),
    arbeitszeit: b.arbeitszeit === undefined ? 1 : (b.arbeitszeit ? 1 : 0),
    ruhezeit: b.ruhezeit === undefined ? 1 : (b.ruhezeit ? 1 : 0),
  };
  try {
    db.prepare(`INSERT INTO warnung_prefs (user_id, pausen, arbeitszeit, ruhezeit, geaendert)
                VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
                ON CONFLICT(user_id) DO UPDATE SET pausen = excluded.pausen,
                  arbeitszeit = excluded.arbeitszeit, ruhezeit = excluded.ruhezeit,
                  geaendert = excluded.geaendert`)
      .run(req.user.id, werte.pausen, werte.arbeitszeit, werte.ruhezeit);
    // Abgeschaltete Warnungen gehoeren ins Protokoll: Es ist eine bewusste Entscheidung gegen einen
    // gesetzlichen Hinweis, und sie sollte nachvollziehbar bleiben.
    const aus = Object.keys(werte).filter(k => !werte[k]);
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'warnungen_geaendert',
      details: aus.length ? 'ausgeblendet: ' + aus.join(', ') : 'alle Warnungen sichtbar', ip: req.ip });
    res.json({ pausen: !!werte.pausen, arbeitszeit: !!werte.arbeitszeit, ruhezeit: !!werte.ruhezeit });
  } catch (e) {
    console.error('Warn-Schalter fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.put('/geburtstag-freigabe', authenticate, (req, res) => {
  const db = getDb();
  const zeigen = !!(req.body || {}).zeigen;
  // „Alter zeigen" ohne „Geburtstag zeigen" ergibt keinen Sinn — der Server raeumt das gerade,
  // damit kein widerspruechlicher Zustand entstehen kann.
  const alterAuch = zeigen && !!(req.body || {}).alter_auch;
  try {
    db.prepare(`INSERT INTO geburtstag_freigabe (user_id, zeigen, alter_auch, geaendert)
                VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
                ON CONFLICT(user_id) DO UPDATE SET zeigen = excluded.zeigen,
                  alter_auch = excluded.alter_auch, geaendert = excluded.geaendert`)
      .run(req.user.id, zeigen ? 1 : 0, alterAuch ? 1 : 0);
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'geburtstag_freigabe',
      details: zeigen ? (alterAuch ? 'Geburtstag + Alter sichtbar' : 'Geburtstag sichtbar') : 'nicht sichtbar', ip: req.ip });
    res.json({ zeigen, alter_auch: alterAuch });
  } catch (e) {
    console.error('Geburtstags-Freigabe fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Die eigenen Stammdaten, nur lesend. Dieselbe Ueberlegung wie beim Geburtsdatum: Ein falscher
// Wert faellt demjenigen auf, den er betrifft — vorausgesetzt, er bekommt ihn ueberhaupt zu sehen.
// Bis hierher standen Soll-Stunden, Urlaubsanspruch und Personalnummer nur in der
// Mitarbeiterverwaltung, die ein Mitarbeiter gar nicht oeffnen kann.
//
// Bewusst OHNE Nutzer-Kennung im Pfad: Man liest immer nur die eigenen.
// MUSS vor "/:id" stehen.
router.get('/meine-stammdaten', authenticate, (req, res) => {
  const db = getDb();
  const lies = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (_) { return null; } };
  const u = lies('SELECT * FROM users WHERE id = ?', req.user.id) || {};

  // Anstellungszeitraeume (Ein- und Austritt). Fehlt die Tabelle auf einem Altstand, bleibt es leer.
  //
  // EIN NOCH NICHT ERREICHTES AUSTRITTSDATUM WIRD HIER NICHT MITGESCHICKT.
  //
  // Seit dem 05.09.2026 kann ein Austritt VORGEMERKT werden: Das Datum steht fest, das Konto laeuft
  // bis dahin weiter. Diese Karte ist die Anzeige „so hat die Verwaltung dich hinterlegt" — stuende
  // dort ein kuenftiges Enddatum, erfuehre der Mitarbeiter aus der App von seiner Kuendigung, bevor
  // der Chef mit ihm gesprochen hat. Das waere der schlimmste Fehler, den diese Funktion machen
  // kann, und er passiert leise.
  //
  // Es wird nicht GELOGEN, sondern der Stand von HEUTE gezeigt: Ein Zeitraum, dessen Ende noch
  // bevorsteht, laeuft heute — die Oberflaeche schreibt dafuer „– heute".
  //
  // Die FORMALE Datenauskunft (`/meine-daten`, weiter unten) enthaelt die Zeitraeume dagegen
  // VOLLSTAENDIG, mit dem kuenftigen Datum. Sie ist der Auszug aus dem Bestand, nicht die Anzeige
  // des heutigen Stands — dort etwas wegzulassen waere das Verstecken von Daten.
  let zeitraeume = [];
  try {
    const heuteIso = new Date().toLocaleDateString('sv-SE');
    zeitraeume = db.prepare('SELECT start_date, end_date FROM employment_periods WHERE user_id = ? ORDER BY start_date')
      .all(req.user.id)
      .map(z => (z.end_date && z.end_date >= heuteIso) ? { ...z, end_date: null } : z);
  } catch (_) {}

  // Urlaubsanspruch: die derzeit gueltige Zeile aus der versionierten Historie, sonst der Wert
  // am Nutzer.
  let anspruch = u.vacation_days_per_year;
  try {
    const heute = new Date().toLocaleDateString('sv-SE');
    const zeile = db.prepare(`SELECT days FROM vacation_entitlements WHERE user_id = ? AND valid_from <= ?
                              ORDER BY valid_from DESC LIMIT 1`).get(req.user.id, heute);
    if (zeile && zeile.days != null) anspruch = zeile.days;
  } catch (_) {}

  res.json({
    stammdaten: {
      name: u.name,
      benutzername: u.username,
      rolle: u.role,
      personalnummer: u.personnel_no || null,
      geburtsdatum: u.birth_date || null,
      soll_stunden_woche: u.target_hours_per_week,
      arbeitsbeginn: u.work_start || null,     // leer = Firmenwert
      urlaubstage_jahr: anspruch != null ? anspruch : null,
      start_ueberstunden: u.start_overtime || 0,
      anstellung: zeitraeume,
      rechte: {
        planen: !!u.can_plan, planen_alle: !!u.can_plan_all,
        schwarzes_brett: !!u.can_bulletin, dateien_hochladen: !!u.can_upload,
      },
    },
  });
});

// Auskunft ueber die eigenen Daten (Art. 15 DSGVO) als JSON-Datei.
//
// Fuer einen Betrieb mit elf Leuten selten gebraucht — aber es ist ein Recht, und diese App wird
// auch von Fremdfirmen betrieben. Ausgegeben wird alles, was mit der Person verknuepft ist; die
// Abfragen sind einzeln gekapselt, damit eine fehlende Tabelle (Altstand) die Auskunft nicht
// scheitern laesst, sondern nur diesen einen Abschnitt leer laesst.
// MUSS vor "/:id" stehen.
router.get('/meine-daten', authenticate, (req, res) => {
  const db = getDb();
  const id = req.user.id;
  const hole = (sql) => { try { return db.prepare(sql).all(id); } catch (_) { return []; } };
  const holeEins = (sql) => { try { return db.prepare(sql).get(id) || null; } catch (_) { return null; } };

  const nutzer = holeEins('SELECT * FROM users WHERE id = ?') || {};
  delete nutzer.password_hash;   // niemals herausgeben, auch nicht an den Eigentuemer

  const daten = {
    erstellt_am: new Date().toISOString(),
    hinweis: 'Auskunft nach Art. 15 DSGVO über alle zu dieser Person gespeicherten Daten.',
    stammdaten: nutzer,
    anstellungszeitraeume: hole('SELECT * FROM employment_periods WHERE user_id = ?'),
    soll_stunden_historie: hole('SELECT * FROM user_target_hours WHERE user_id = ?'),
    urlaubsanspruch: hole('SELECT * FROM vacation_entitlements WHERE user_id = ?'),
    zeiteintraege: hole('SELECT * FROM entries WHERE user_id = ?'),
    abwesenheiten: hole('SELECT * FROM absences WHERE user_id = ?'),
    planung: hole('SELECT p.* FROM planning_entries p JOIN planning_assignments a ON a.planning_id = p.id WHERE a.user_id = ?'),
    notizen: hole('SELECT * FROM notes WHERE user_id = ?'),
    mit_mir_geteilte_notizen: hole('SELECT note_id, permission FROM note_shares WHERE user_id = ?'),
    aushaenge_von_mir: hole('SELECT * FROM bulletin_entries WHERE created_by = ?'),
    bestellungen: hole('SELECT * FROM orders WHERE user_id = ?'),
    push_einstellungen: holeEins('SELECT * FROM push_prefs WHERE user_id = ?'),
    push_geraete: hole('SELECT id, user_agent, created_at FROM push_subscriptions WHERE user_id = ?'),
    geburtstags_freigabe: holeEins('SELECT * FROM geburtstag_freigabe WHERE user_id = ?'),
    profilbild: holeEins('SELECT * FROM user_avatars WHERE user_id = ?'),
    // Beim zweiten Faktor NUR die Tatsache, nicht das Geheimnis — das waere ein Schluessel, kein Datum.
    zwei_faktor: (() => {
      const z = holeEins('SELECT confirmed_at, aktiv FROM twofa_secrets WHERE user_id = ?');
      return z ? { eingerichtet_am: z.confirmed_at, aktiv: !!z.aktiv } : null;
    })(),
    protokoll_eintraege: hole('SELECT ts, action, details, ip FROM audit_logs WHERE user_id = ?'),
  };

  logAudit(db, { userId: id, username: req.user.username, action: 'datenauskunft', ip: req.ip });
  const name = String(req.user.username || 'daten').replace(/[^a-zA-Z0-9_-]/g, '');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="arbeitsdoku-meine-daten-${name}.json"`);
  res.send(JSON.stringify(daten, null, 2));
});

// MUSS vor "/:id" stehen, sonst schluckt die Id-Route das Wort "geburtstage".
// Wer heute Geburtstag hat. Frueher nur fuer Chef/Admin/Buchhalter — jetzt fuer ALLE, aber mit
// zwei verschiedenen Sichten:
//   Manager (Chef/Admin/Buchhalter): wie bisher alle, mit Alter. Sie haben das Geburtsdatum
//                                    ohnehin in der Mitarbeiterliste.
//   Alle uebrigen:                   nur, wer sich selbst freigegeben hat — und das Alter nur,
//                                    wenn ausdruecklich auch dafuer freigegeben.
router.get('/geburtstage', authenticate, (req, res) => {
  const db = getDb();
  // Ortszeit, nicht UTC: Um 01:00 Berliner Zeit ist es in UTC noch gestern — der Geburtstag ginge
  // sonst eine Stunde zu spaet an und eine Stunde zu frueh aus.
  const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const [jahr, monat, tag] = heute.split('-').map(Number);
  const schaltjahr = (jahr % 4 === 0 && jahr % 100 !== 0) || jahr % 400 === 0;
  // Am 29. Februar Geborene haetten in drei von vier Jahren gar keinen Geburtstag. Sie werden in
  // Nicht-Schaltjahren am 28. angezeigt — mit Vermerk, damit niemand denkt, das Datum sei falsch.
  const ersatzFuer29 = !schaltjahr && monat === 2 && tag === 28;

  const istManager = ['admin', 'chef', 'buchhalter'].includes(req.user.role);
  // Ein Buchhalter sieht keine Admin-Konten (wie bisher); wer gar kein Manager ist, sieht ohnehin
  // nur Freigegebene, und die duerfen dann auch Admins sein.
  const rollenFilter = (req.user.role === 'admin' || !istManager) ? '' : "AND role != 'admin'";

  // Freigaben einmal einlesen. Fehlt die Tabelle (sehr alter Stand), gilt „nichts freigegeben".
  const freigabe = {};
  try {
    for (const f of db.prepare('SELECT user_id, zeigen, alter_auch FROM geburtstag_freigabe').all()) {
      freigabe[f.user_id] = { zeigen: !!f.zeigen, alterAuch: !!f.alter_auch };
    }
  } catch (_) {}
  const rows = db.prepare(
    `SELECT id, name, birth_date FROM users
      WHERE active = 1 AND birth_date IS NOT NULL AND birth_date != '' AND id != ? ${rollenFilter}
      ORDER BY name`
  ).all(req.user.id);

  const geburtstage = [];
  for (const r of rows) {
    const [gJahr, gMonat, gTag] = String(r.birth_date).split('-').map(Number);
    const echterTag = gMonat === monat && gTag === tag;
    const vorgezogen = ersatzFuer29 && gMonat === 2 && gTag === 29;
    if (!echterTag && !vorgezogen) continue;
    const frei = freigabe[r.id] || { zeigen: false, alterAuch: false };
    if (!istManager && !frei.zeigen) continue;   // ohne Freigabe sehen Kollegen nichts

    // Alter: das begonnene Lebensjahr. Wer am 29.02. geboren ist, wird am 28.02. mitgezaehlt.
    // Manager sehen es immer, alle anderen nur bei ausdruecklicher Freigabe — „das Team darf
    // gratulieren" ist nicht dasselbe wie „das Team darf mein Alter kennen".
    const alterZeigen = istManager || frei.alterAuch;
    geburtstage.push({
      id: r.id, name: r.name, am_29_februar: vorgezogen,
      ...(alterZeigen ? { alter: jahr - gJahr } : {}),
    });
  }
  res.json({ geburtstage });
});

// Ausgestellte Mitarbeiter (Papierkorb-Reiter "Mitarbeiter"). Chef+Admin (MA haben keinen Zugriff).
// MUSS vor "/:id" stehen.
router.get('/inactive', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.target_hours_per_week, u.deactivated_at, u.deactivated_by,
           du.name AS deactivated_by_name,
           (SELECT MAX(ep.end_date) FROM employment_periods ep WHERE ep.user_id = u.id) AS employed_until
    FROM users u
    LEFT JOIN users du ON u.deactivated_by = du.id
    WHERE u.active = 0
    ORDER BY u.deactivated_at DESC, u.name
  `).all();
  res.json({ users: rows });
});

// Alle Benutzer abrufen
router.get('/', authenticate, authorize('chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  let users;

  if (req.user.role === 'admin') {
    users = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, personnel_no, work_start, birth_date, active, created_at FROM users ORDER BY name').all();
  } else {
    users = db.prepare("SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, personnel_no, work_start, birth_date, active, created_at FROM users WHERE role != 'admin' ORDER BY name").all();
  }

  res.json({ users: attachEmployment(db, users) });
});

// Einzelnen Benutzer abrufen
router.get('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  let user;

  user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, personnel_no, work_start, birth_date, created_at FROM users WHERE id = ?').get(req.params.id);

  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  res.json({ user });
});

// Benutzer erstellen
router.post('/', authenticate, authorize('chef'), async (req, res) => {
  const { username, password, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, personnel_no, work_start, birth_date } = req.body;
  // „alle" impliziert immer „sich" (can_plan_all=1 ⇒ can_plan=1).
  let planAll = can_plan_all ? 1 : 0;
  let planSelf = (can_plan || can_plan_all) ? 1 : 0;
  let bulletin = can_bulletin ? 1 : 0;
  let upload = can_upload ? 1 : 0;
  let order = can_order ? 1 : 0;

  if (!username || !password || !name || !role) {
    return res.status(400).json({ error: 'Benutzername, Passwort, Name und Rolle sind Pflichtfelder' });
  }

  // Nur bekannte Rollen; die Admin-Rolle ausschließlich durch Admins (Nicht-Admins: reduzierte Menge).
  const allowedRoles = req.user.role === 'admin' ? ROLES : ['mitarbeiter', 'buchhalter', 'chef'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }
  // #9: Chef/Admin haben Planung/Schwarzes Brett/Upload per Rolle — Einzelrecht-Flags redundant → 0.
  if (role === 'chef' || role === 'admin') { planAll = 0; planSelf = 0; bulletin = 0; upload = 0; }
  // Beim Bestellen zaehlt der Buchhalter mit — deshalb eine EIGENE Zeile mit drei Rollen. Die
  // obige um ihn zu erweitern haette ihm Planung, Brett und Upload weggenommen, die er nicht
  // implizit besitzt.
  if (ROLLEN_MIT_BESTELLRECHT.includes(role)) order = 0;

  // B5: start_overtime muss eine Zahl sein (negativ erlaubt = Start mit Überstunden-Schuld).
  if (start_overtime !== undefined && start_overtime !== null && !Number.isFinite(Number(start_overtime))) {
    return res.status(400).json({ error: 'Start-Überstunden müssen eine Zahl sein' });
  }

  const pwErr = passwordPolicyError(password, username);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  const hMon = hours_mon || 8, hTue = hours_tue || 8, hWed = hours_wed || 8, hThu = hours_thu || 8, hFri = hours_fri || 6;
  const hpw = target_hours_per_week || (hMon + hTue + hWed + hThu + hFri);

  // Arbeitsbeginn pruefen, BEVOR angelegt wird — sonst stuende eine unmoegliche Zeit in der Vorbelegung.
  const beginnNeu = work_start === undefined ? '' : normArbeitsbeginn(work_start);
  if (beginnNeu === null) return res.status(400).json({ error: 'Ungültiger Arbeitsbeginn (erwartet HH:MM, 00:00 bis 23:59)' });
  const geburtNeu = normGeburtsdatum(birth_date);
  if (geburtNeu === null) return res.status(400).json({ error: GEBURT_FEHLER });

  let hash;
  try { hash = await bcrypt.hash(password, 10); } // kooperativ (blockiert den Event-Loop nicht)
  catch (e) { console.error('Hash-Fehler:', e.message); return res.status(500).json({ error: 'Interner Serverfehler' }); }
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, personnel_no, work_start, birth_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(username, hash, name, role, hpw, Number(start_overtime) || 0, planSelf, planAll, bulletin, upload, order, normPersonalNr(personnel_no) ?? null, beginnNeu || null, geburtNeu || null);

  const userId = result.lastInsertRowid;
  // B6: „heute" in Europe/Berlin (wie im Rest der App) statt UTC — sonst nahe Mitternacht 1 Tag daneben.
  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  db.prepare(
    'INSERT INTO user_target_hours (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, hpw, hMon, hTue, hWed, hThu, hFri, today);
  // Offener Anstellungszeitraum ab heute (Basis fuer die Soll-Stunden-Anrechnung)
  db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)').run(userId, today);

  const user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, personnel_no, work_start, birth_date, created_at FROM users WHERE id = ?').get(userId);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_create',
    details: `id=${userId} · ${userAuditCreate(user)}`, ip: req.ip });
  res.status(201).json({ user });
});

// Benutzer bearbeiten
router.put('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  // Chef darf Admin-Accounts nicht bearbeiten
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins bearbeitet werden' });
  }

  const { username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, personnel_no, work_start } = req.body;

  // Rollen-Absicherung (serverseitig, nicht nur im Frontend): nur bekannte Rollen zulassen und die
  // Admin-Rolle ausschließlich durch Admins vergeben — sonst könnte ein Chef per direktem API-Call einen
  // Nutzer (oder sich selbst) zu Admin hochstufen. Greift nur bei tatsächlicher Rollen-Änderung.
  if (role !== undefined && role !== user.role) {
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Ungültige Rolle' });
    }
    if (role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nur Admins dürfen die Admin-Rolle vergeben' });
    }
    // S3: den LETZTEN aktiven Admin nicht herabstufen — sonst gäbe es 0 Admins und niemand käme mehr an die
    // Admin-Funktionen. Bei mehreren Admins ist das Herabstufen erlaubt.
    if (user.role === 'admin' && role !== 'admin' && user.active !== 0 && otherActiveAdmins(db, user.id) === 0) {
      return res.status(400).json({ error: 'Der letzte Admin kann nicht herabgestuft werden — lege zuerst einen weiteren Admin an.' });
    }
  }

  // B5: start_overtime muss eine Zahl sein (negativ erlaubt = Start mit Überstunden-Schuld).
  if (start_overtime !== undefined && start_overtime !== null && !Number.isFinite(Number(start_overtime))) {
    return res.status(400).json({ error: 'Start-Überstunden müssen eine Zahl sein' });
  }

  // Benutzernamen-Eindeutigkeit (wie beim Anlegen): ein umbenannter Nutzer darf keinen bereits vergebenen
  // Namen bekommen — sonst gäbe es zwei Zeilen mit gleichem username und die Anmeldung wäre mehrdeutig.
  if (username && username !== user.username) {
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
    if (clash) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  // Rechte-Stufen normalisieren: jeweils mitgeschicktes Feld übernehmen, sonst Bestand behalten;
  // „alle" impliziert immer „sich".
  let newPlanAll = can_plan_all !== undefined ? (can_plan_all ? 1 : 0) : (user.can_plan_all || 0);
  let newPlanSelf = can_plan !== undefined ? (can_plan ? 1 : 0) : (user.can_plan || 0);
  if (newPlanAll) newPlanSelf = 1;
  let newBulletin = can_bulletin !== undefined ? (can_bulletin ? 1 : 0) : (user.can_bulletin || 0);
  let newUpload = can_upload !== undefined ? (can_upload ? 1 : 0) : (user.can_upload || 0);
  let newOrder = can_order !== undefined ? (can_order ? 1 : 0) : (user.can_order || 0);
  // #9: Chef/Admin haben Planung/Schwarzes Brett/Upload ohnehin per Rolle — die Einzelrecht-Flags sind
  // redundant und werden für sie immer auf 0 gehalten (auch gegen direkte API-Aufrufe).
  const effRole = role || user.role;
  if (effRole === 'chef' || effRole === 'admin') { newPlanAll = 0; newPlanSelf = 0; newBulletin = 0; newUpload = 0; }
  if (ROLLEN_MIT_BESTELLRECHT.includes(effRole)) newOrder = 0;   // drei Rollen, s. o.

  // Start-Überstunden und Wochenstunden verschieben das Saldo über den GESAMTEN Verlauf, also auch
  // in bereits abgerechneten Zeiträumen — und tragen kein Datum, an dem sich das eingrenzen liesse.
  // Deshalb hier die globale Sperre. Bewusst nur bei echter Wertaenderung: sonst waere auch eine
  // blosse Umbenennung blockiert, obwohl sie keine Zahl bewegt.
  const otNeu = start_overtime !== undefined ? Number(start_overtime) : Number(user.start_overtime || 0);
  const thNeu = target_hours_per_week !== undefined ? Number(target_hours_per_week) : Number(user.target_hours_per_week || 0);
  const zahlenAendernSich = otNeu !== Number(user.start_overtime || 0) || thNeu !== Number(user.target_hours_per_week || 0);
  const sperre = zahlenAendernSich ? pruefeSperreGlobal(db, req.user, req.body.reason) : null;
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  const beginnGeprueft = normArbeitsbeginn(work_start);
  if (beginnGeprueft === null) return res.status(400).json({ error: 'Ungültiger Arbeitsbeginn (erwartet HH:MM, 00:00 bis 23:59)' });
  const beginnPut = beginnGeprueft !== undefined ? (beginnGeprueft || null) : (user.work_start || null);
  const geburtGeprueft = normGeburtsdatum(req.body.birth_date);
  if (geburtGeprueft === null) return res.status(400).json({ error: GEBURT_FEHLER });
  const geburtPut = req.body.birth_date === undefined ? (user.birth_date || null) : (geburtGeprueft || null);

  db.prepare(
    'UPDATE users SET username=?, name=?, role=?, target_hours_per_week=?, start_overtime=?, can_plan=?, can_plan_all=?, can_bulletin=?, can_upload=?, can_order=?, personnel_no=?, work_start=?, birth_date=? WHERE id=?'
  ).run(
    username || user.username,
    name || user.name,
    role || user.role,
    target_hours_per_week !== undefined ? target_hours_per_week : user.target_hours_per_week,
    start_overtime !== undefined ? Number(start_overtime) : (user.start_overtime || 0),
    newPlanSelf,
    newPlanAll,
    newBulletin,
    newUpload,
    newOrder,
    normPersonalNr(personnel_no) !== undefined ? normPersonalNr(personnel_no) : (user.personnel_no ?? null),
    beginnPut,
    geburtPut,
    req.params.id
  );

  const updated = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, personnel_no, work_start, birth_date, created_at FROM users WHERE id = ?').get(req.params.id);
  const _changes = userAuditDiff(user, updated);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_update',
    details: `${updated.username} (id=${req.params.id}): ` + (_changes.length ? _changes.join('; ') : 'keine Änderung'),
    ip: req.ip });

  // Ein Recht wegzunehmen ist nicht das Gegenteil vom Geben: Sonst bekaeme jemand weiter
  // Bestell-Meldungen fuer etwas, das er nicht mehr sehen darf. Laeuft nach JEDER Aenderung, weil
  // das Recht auch ueber die Rolle verschwinden kann (Chef -> Mitarbeiter).
  const aufgeraeumt = bestellmeldungenAufraeumen(db, req.params.id);
  if (aufgeraeumt) {
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'bestellrecht_aufgeraeumt',
      details: `${updated.username} (id=${req.params.id}): ${aufgeraeumt.text}`, ip: req.ip });
  }
  protokolliereEingriff(db, req, sperre, `Start-Überstunden/Wochenstunden von ${updated.username} geändert`);
  res.json({ user: updated });
});

// Passwort zurücksetzen
router.post('/:id/reset-password', authenticate, authorize('chef'), async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Passwort kann nur von Admins geändert werden' });
  }
  const { password } = req.body;
  const pwErr = passwordPolicyError(password, user.username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  let hash;
  try { hash = await bcrypt.hash(password, 10); } // kooperativ (blockiert den Event-Loop nicht)
  catch (e) { console.error('Hash-Fehler:', e.message); return res.status(500).json({ error: 'Interner Serverfehler' }); }
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, req.params.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_password_reset',
    details: `Passwort zurueckgesetzt fuer: ${user.username} (id=${req.params.id})`, ip: req.ip });
  res.json({ success: true });
});

// Zwei-Faktor-Anmeldung eines Mitarbeiters zuruecksetzen — der Weg zurueck bei verlorenem Handy.
// Es gibt bewusst keine Wiederherstellungs-Codes (Entscheidung Alex, 19.08.2026): Bei elf Leuten im
// selben Betrieb ist der Admin der praktischere Weg, und ein Zettel, den man verlegt, hilft nicht.
//
// Loescht Geheimnis UND alle vertrauten Geraete. Sonst koennte sich jemand mit einem alten,
// gemerkten Geraet weiterhin ohne Code anmelden.
router.post('/:id/twofa-reset', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  // Gleiche Sonderregel wie beim Passwort: An einen Admin darf nur ein Admin heran.
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Die Zwei-Faktor-Anmeldung eines Admins kann nur ein Admin zurücksetzen' });
  }
  zweiFaktor.zuruecksetzen(db, user.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_2fa_reset',
    details: `Zwei-Faktor zurueckgesetzt fuer: ${user.username} (id=${req.params.id})`, ip: req.ip });
  res.json({ success: true });
});

// Mitarbeiter AUSSTELLEN (Soft-Delete): kein Login mehr, aber alle Daten bleiben erhalten und
// werden fuer den Anstellungszeitraum weiter angezeigt/berechnet. Schliesst den offenen
// Anstellungszeitraum mit dem Austrittsdatum (Default heute).
router.post('/:id/deactivate', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins ausgestellt werden' });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Sich selbst kann man nicht ausstellen' });
  }
  // S3: auch beim Ausstellen den letzten aktiven Admin schützen (falls je jemand einen Admin über den API-Weg
  // ausstellen wollte, der der einzige verbliebene ist).
  if (user.role === 'admin' && otherActiveAdmins(db, user.id) === 0) {
    return res.status(400).json({ error: 'Der letzte Admin kann nicht ausgestellt werden — lege zuerst einen weiteren Admin an.' });
  }
  if (user.active === 0) return res.status(409).json({ error: 'Mitarbeiter ist bereits ausgestellt' });

  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const employedUntil = req.body && req.body.employed_until ? String(req.body.employed_until) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(employedUntil)) {
    return res.status(400).json({ error: 'Ungültiges Austrittsdatum (Format JJJJ-MM-TT)' });
  }
  // Austrittsdatum darf nicht vor dem aktuellen Eintritt liegen
  const open = db.prepare('SELECT id, start_date FROM employment_periods WHERE user_id = ? AND end_date IS NULL ORDER BY start_date DESC LIMIT 1').get(req.params.id);
  if (open && employedUntil < open.start_date) {
    return res.status(400).json({ error: `Austrittsdatum liegt vor dem Eintrittsdatum (${open.start_date})` });
  }

  // Ein rueckdatiertes Austrittsdatum setzt das Soll ab da auf 0 — auch in abgerechneten Monaten.
  const sperre = pruefeSperre(db, [employedUntil], req.user, req.body && req.body.reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  // Das Austrittsdatum steht in beiden Faellen sofort fest — es begrenzt die Soll-Stunden.
  austrittsdatumSetzen(db, Number(req.params.id), employedUntil);

  // LIEGT DER LETZTE ARBEITSTAG NOCH VOR UNS, wird nur VORGEMERKT: Das Konto bleibt offen, der
  // Zeitplaner schliesst es am Tag danach (scheduler.js, austritteVollziehen).
  //
  // Vorher wurde IMMER sofort geschlossen. Wer am 05.09. ausstellte und den 30.09. als letzten
  // Arbeitstag eintrug, sperrte den Mitarbeiter 25 Tage zu frueh aus — waehrend sein Soll
  // weiterlief (isEmployedOn zaehlt bis einschliesslich Austrittsdatum). Ergebnis: 18 Arbeitstage
  // mit Soll, aber ohne Ist, rund 144 Stunden still vom Ueberstundenstand abgezogen. Ausgerechnet
  // in der Lage, in der dieser Stand ausgezahlt wird (Alex, 04.09.2026).
  //
  // Die Schwelle ist `> heute`: Nur ein Tag, der noch BEVORSTEHT, wird vorgemerkt.
  //
  // Erst stand hier `>= heute` mit der Begruendung „wer heute seinen letzten Tag hat, arbeitet
  // heute noch". Das war zu weit gegriffen: Der Knopf „Ausstellen" schickt ohne Datum das heutige,
  // und damit schloss der Normalfall das Konto nicht mehr — auch nicht bei einer fristlosen
  // Trennung, wo der Zugang sofort weg muss. Aufgefallen an auth-active-guard, ausstellen-zweifaktor
  // und trash-access, die genau das zusichern.
  //
  // Wer moechte, dass jemand seinen letzten Tag noch zu Ende arbeitet, drueckt den Knopf am Abend
  // oder am Tag danach — so lief es bisher, und der Chef behaelt die Entscheidung.
  const heute = berlinHeute();
  if (employedUntil > heute) {
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_austritt_vorgemerkt',
      details: `Austritt vorgemerkt: ${user.username} (${user.role}, id=${req.params.id}), `
        + `letzter Arbeitstag ${employedUntil} — Zugang bleibt bis dahin bestehen`, ip: req.ip });
    protokolliereEingriff(db, req, sperre, `Austrittsdatum ${employedUntil} vorgemerkt`);
    return res.json({ success: true, vorgemerkt: true, employed_until: employedUntil });
  }

  ausstellenVollziehen(db, Number(req.params.id), employedUntil,
    { id: req.user.id, username: req.user.username, ip: req.ip });

  protokolliereEingriff(db, req, sperre, `Austrittsdatum ${employedUntil} gesetzt`);
  res.json({ success: true, vorgemerkt: false });
});

// Eine VORMERKUNG wieder aufheben — der Anstellungszeitraum ist danach wieder offen.
//
// Nur solange das Konto noch aktiv ist: Ist es bereits geschlossen, ist „Wiedereinstellen" der
// richtige Weg (der legt einen neuen Zeitraum an und laesst die Luecke stehen).
router.post('/:id/austritt-aufheben', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins bearbeitet werden' });
  }
  if (user.active === 0) {
    return res.status(409).json({ error: 'Der Mitarbeiter ist bereits ausgestellt — bitte „Wiedereinstellen" verwenden.' });
  }
  const offen = db.prepare(
    'SELECT id, end_date FROM employment_periods WHERE user_id = ? ORDER BY start_date DESC LIMIT 1'
  ).get(req.params.id);
  if (!offen || !offen.end_date) {
    return res.status(409).json({ error: 'Für diesen Mitarbeiter ist kein Austritt vorgemerkt' });
  }

  // Das Aufheben verlaengert die Anstellung wieder — und damit die Soll-Stunden. In einem
  // abgerechneten Zeitraum waere das eine rueckwirkende Aenderung an bezahlten Zahlen.
  const sperre = pruefeSperre(db, [offen.end_date], req.user, req.body && req.body.reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  austrittsdatumAufheben(db, Number(req.params.id));
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_austritt_aufgehoben',
    details: `Vormerkung aufgehoben: ${user.username} (id=${req.params.id}), war ${offen.end_date}`, ip: req.ip });
  protokolliereEingriff(db, req, sperre, `Vormerkung zum ${offen.end_date} aufgehoben`);
  res.json({ success: true });
});

// Mitarbeiter WIEDEREINSTELLEN: neuer offener Anstellungszeitraum ab Wiedereintrittsdatum
// (Default heute). Die Lueckenzeit dazwischen bleibt mit Soll = 0 bestehen.
router.post('/:id/reactivate', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins wiedereingestellt werden' });
  }
  if (user.active === 1) return res.status(409).json({ error: 'Mitarbeiter ist bereits aktiv' });

  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const startDate = req.body && req.body.start_date ? String(req.body.start_date) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: 'Ungültiges Wiedereintrittsdatum (Format JJJJ-MM-TT)' });
  }
  // Wiedereintritt muss nach dem letzten Austritt liegen (keine ueberlappenden Zeitraeume)
  const lastEnd = db.prepare('SELECT MAX(end_date) AS d FROM employment_periods WHERE user_id = ?').get(req.params.id);
  if (lastEnd && lastEnd.d && startDate <= lastEnd.d) {
    return res.status(400).json({ error: `Wiedereintritt muss nach dem letzten Austritt (${lastEnd.d}) liegen` });
  }

  const sperre = pruefeSperre(db, [startDate], req.user, req.body && req.body.reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  db.prepare('UPDATE users SET active = 1, deactivated_at = NULL, deactivated_by = NULL WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)').run(req.params.id, startDate);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_reactivate',
    details: `Wiedereingestellt: ${user.username} (${user.role}, id=${req.params.id}), Eintritt ${startDate}`, ip: req.ip });
  protokolliereEingriff(db, req, sperre, `Wiedereintritt ${startDate} gesetzt`);
  res.json({ success: true });
});

// Benutzer ENDGUELTIG löschen (Hard-Delete inkl. aller Daten per Cascade). Nur Admin und nur,
// wenn der Mitarbeiter zuvor ausgestellt wurde — schuetzt vor versehentlichem Datenverlust.
router.delete('/:id', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Sich selbst kann man nicht löschen' });
  }
  if (user.active !== 0) {
    return res.status(400).json({ error: 'Mitarbeiter muss zuerst ausgestellt werden, bevor er endgültig gelöscht werden kann' });
  }

  // Der Hard-Delete loescht per Kaskade ALLE Eintraege des Nutzers — auch bereits abgerechnete.
  // Eine Sperre waere hier Vortaeuschung (das Werkzeug ist bewusst der letzte Ausweg), aber der
  // Vermerk muss im Protokoll stehen. Der Beleg selbst ueberlebt: payroll_closure_rows haengt
  // bewusst NICHT an users (Name und Personalnummer stehen als Kopie darin).
  const abgerechnet = abgerechnetBis(db);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_delete',
    details: `Endgueltig geloescht: ${user.username} (${user.role}, id=${req.params.id})`
      + (abgerechnet ? ` — BETRIFFT ABGERECHNETE ZEITRÄUME (bis ${abgerechnet})` : ''), ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
// Die Passwort-Regeln sind die Quelle der Wahrheit — auch fuer „eigenes Passwort aendern"
// (routes/auth.js). Als Eigenschaft am Router mitgegeben, wie es server.js mit
// brandingRouter.renderIndex vormacht; ein zweiter Export wuerde das Mount-Muster brechen.
module.exports.passwordPolicyError = passwordPolicyError;
