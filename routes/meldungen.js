// Meldungen (30.09.2026): Probleme zu festen Themen melden — „Auto 2 → Ölwechsel", „Papiermüll → voll".
//
// Wer was darf, steht in meldungrecht.js (EINE Stelle):
//   melden                          jeder
//   eigene Meldung ändern/zurückziehen   nur solange sie „offen" ist
//   alle ändern, Status, Rückmeldung     Chef/Admin oder Einzelrecht „Meldungen bearbeiten"
//   Themen anlegen/umbenennen/sortieren/löschen   nur Chef/Admin
//   endgültig löschen               nur Admin (zum Testen, Alex)
//
// Alle sehen alle offenen Meldungen und die History — dann meldet niemand „Papiermüll voll" doppelt.
// Erledigte und zurückgezogene Meldungen stehen in der History, ebenso ALLE Meldungen eines gelöschten
// Themas (auch noch offene, Alex 30.09.2026) — die sind dann nur noch zu lesen.
//
// Jede Änderung landet im Verlauf der Meldung (mit dem Namen zum Zeitpunkt) und setzt updated_at/updated_by —
// daran hängen Zähler und Hervorheben (Etappe 2).
const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../sse');
const { logAudit } = require('../audit');
const reste = require('../reste');
const push = require('../push');
const regeln = require('../meldung-regeln');
const erinnerungen = require('../meldung-erinnerungen');
const { darfMeldungenBearbeiten, darfMeldungenVerwalten, SQL_MELDUNGSBERECHTIGT, SQL_MELDUNGSROLLEN } = require('../meldungrecht');

const router = express.Router();

const JETZT = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const STATUS = ['offen', 'in_arbeit', 'erledigt'];            // was Bearbeiter setzen dürfen
const STATUS_TEXT = { offen: 'offen', in_arbeit: 'in Arbeit', erledigt: 'erledigt', zurueckgezogen: 'zurückgezogen' };
const MAX_TEXT = 2000, MAX_THEMA = 60;

// Eine Meldung mit allen Namen. „automatisch" = regelmäßige Meldung (created_by NULL, Etappe 3).
const MELDUNG_SQL = `
  SELECT m.*, t.name AS thema_name, t.deleted_at AS thema_geloescht_am,
    CASE WHEN m.created_by IS NULL THEN 'automatisch' ELSE COALESCE(cu.name, 'Gelöschtes Konto') END AS created_by_name,
    uu.name AS updated_by_name, su.name AS status_by_name
  FROM meldungen m
  LEFT JOIN meldung_themen t ON t.id = m.thema_id
  LEFT JOIN users cu ON cu.id = m.created_by
  LEFT JOIN users uu ON uu.id = m.updated_by
  LEFT JOIN users su ON su.id = m.status_by`;

function ausgabe(m, user) {
  if (!m) return null;
  return { ...m, dringend: !!m.dringend, eigen: m.created_by != null && m.created_by === user.id,
    thema_geloescht: !!m.thema_geloescht_am, in_history: istHistory(m) };
}
const istHistory = (m) => m.status === 'erledigt' || m.status === 'zurueckgezogen' || !!m.thema_geloescht_am;

function holen(db, id) {
  return db.prepare(MELDUNG_SQL + ' WHERE m.id = ?').get(id);
}

// Jede Meldung bekommt die EIGENEN Erinnerungen des Fragenden mit — fremde sieht niemand (Alex, 01.10.2026).
function mitErinnerungen(db, user, liste) {
  const je = erinnerungen.eigeneZu(db, user.id, liste.map(m => m.id));
  return liste.map(m => ({ ...m, erinnerungen: je.get(m.id) || [] }));
}

function verlauf(db, meldungId, user, art, vorher, nachher) {
  db.prepare('INSERT INTO meldung_verlauf (meldung_id, art, user_id, user_name, vorher, nachher) VALUES (?, ?, ?, ?, ?, ?)')
    .run(meldungId, art, user ? user.id : null, user ? (user.name || user.username) : 'automatisch',
      vorher == null ? null : String(vorher), nachher == null ? null : String(nachher));
}

// Push (Etappe 2): an alle, die bearbeiten dürfen, und an den Melder — dieselben, deren Zähler steigt
// (routes/badges.js). Nie an den, der es getan hat (notifyUsers schließt ihn aus). Ein Antippen führt direkt
// zur Meldung und hebt sie hervor (ziel, wie seit R30 überall).
function pushSenden(db, m, akteur, titel, text) {
  let ids = [];
  try {
    ids = db.prepare(`SELECT id FROM users WHERE ${SQL_MELDUNGSBERECHTIGT} AND COALESCE(active,1) = 1`)
      .all(...SQL_MELDUNGSROLLEN).map(r => r.id);
  } catch (_) { /* Altstand ohne Spalte: dann eben nur der Melder */ }
  if (m.created_by != null) ids.push(m.created_by);
  push.notifyUsers(db, ids, 'meldungen', {
    title: titel, body: text,
    url: '/#/meldungen',
    ziel: { art: 'meldung', id: m.id },
  }, akteur ? akteur.id : null);
}
const wer = (user) => (user && (user.name || user.username)) || 'automatisch';

function geaendert(db, id, user) {
  db.prepare(`UPDATE meldungen SET updated_at = ${JETZT}, updated_by = ? WHERE id = ?`).run(user.id, id);
}

const kurz = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const textPruefen = (t) => {
  const s = String(t == null ? '' : t).trim();
  if (!s) return { fehler: 'Bitte beschreibe kurz, was los ist.' };
  if (s.length > MAX_TEXT) return { fehler: `Die Meldung ist zu lang (höchstens ${MAX_TEXT} Zeichen).` };
  return { text: s };
};
const themaNamePruefen = (n) => {
  const s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim();
  if (!s) return { fehler: 'Bitte gib dem Thema einen Namen.' };
  if (s.length > MAX_THEMA) return { fehler: `Der Name ist zu lang (höchstens ${MAX_THEMA} Zeichen).` };
  return { name: s };
};
function namensDoppel(db, name, ausser) {
  return db.prepare('SELECT id FROM meldung_themen WHERE deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id != ?')
    .get(name, ausser || 0);
}
const aktivesThema = (db, id) => db.prepare('SELECT * FROM meldung_themen WHERE id = ? AND deleted_at IS NULL').get(Number(id));

// ── Lesen ──────────────────────────────────────────────────────────────────────────────────────────────

// Themen (aktive, in Reihenfolge) und alle offenen / in Arbeit befindlichen Meldungen dazu.
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const themen = db.prepare('SELECT id, name, sort FROM meldung_themen WHERE deleted_at IS NULL ORDER BY sort, id').all();
  const meldungen = db.prepare(MELDUNG_SQL + `
    WHERE m.status IN ('offen', 'in_arbeit') AND t.deleted_at IS NULL
    ORDER BY m.dringend DESC, m.created_at ASC`).all().map(m => ausgabe(m, req.user));
  const mitEigenen = mitErinnerungen(db, req.user, meldungen);
  // Bis wann hat der Nutzer die Meldungen zuletzt gesehen? Daran markiert die Seite „neu"/„geändert" — BEVOR sie
  // selbst „gesehen" meldet (Zähler, routes/badges.js).
  const gesehen = db.prepare("SELECT seen_at FROM user_seen WHERE user_id = ? AND topic = 'meldungen'").get(req.user.id);
  // Regelmäßige Meldungen mit ihrer nächsten Fälligkeit — alle sehen, was demnächst kommt (Rückfrage 30)
  let regelListe = [];
  try { regelListe = regeln.regelnLesen(db, new Date()); } catch (_) { /* Altstand ohne Tabellen */ }
  res.json({ themen, meldungen: mitEigenen, regeln: regelListe, gesehen_bis: gesehen ? gesehen.seen_at : null,
    darf: { bearbeiten: darfMeldungenBearbeiten(req.user), verwalten: darfMeldungenVerwalten(req.user),
            loeschen: req.user.role === 'admin' } });
});

// History: erledigt, zurückgezogen, oder das Thema ist gelöscht. Neueste zuerst, seitenweise.
router.get('/history', authenticate, (req, res) => {
  const db = getDb();
  const wo = ['(m.status IN (?, ?) OR t.deleted_at IS NOT NULL)'];
  const p = ['erledigt', 'zurueckgezogen'];
  if (req.query.thema_id) { wo.push('m.thema_id = ?'); p.push(Number(req.query.thema_id)); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const sql = MELDUNG_SQL + ` WHERE ${wo.join(' AND ')} ORDER BY COALESCE(m.status_at, m.updated_at) DESC, m.id DESC`;
  // Suche in JavaScript statt mit LIKE: SQLite kennt Groß/klein nur bei ASCII — „BLÄTTER" fände „blätter"
  // nicht. Die History eines Betriebs ist klein genug, um sie dafür ganz zu lesen.
  const q = String(req.query.q || '').trim().toLocaleLowerCase('de');
  const zeilen = q
    ? db.prepare(sql).all(...p)
        .filter(m => [m.text, m.rueckmeldung, m.created_by_name].join('\n').toLocaleLowerCase('de').includes(q))
        .slice(offset, offset + limit + 1)
    : db.prepare(sql + ' LIMIT ? OFFSET ?').all(...p, limit + 1, offset);
  // Filter-Auswahl: alle Themen, zu denen es History gibt — auch gelöschte (Alex: „bleibt in der History")
  const themen = db.prepare(`SELECT DISTINCT t.id, t.name, t.sort, t.deleted_at IS NOT NULL AS geloescht FROM meldung_themen t
    JOIN meldungen m ON m.thema_id = t.id
    WHERE m.status IN ('erledigt', 'zurueckgezogen') OR t.deleted_at IS NOT NULL
    ORDER BY geloescht, t.sort, t.name`).all().map(t => ({ ...t, geloescht: !!t.geloescht }));
  res.json({ meldungen: mitErinnerungen(db, req.user, zeilen.slice(0, limit).map(m => ausgabe(m, req.user))), mehr: zeilen.length > limit, themen });
});

// Eine Meldung mit Verlauf (Detail-Ansicht).
router.get('/:id(\\d+)', authenticate, (req, res) => {
  const db = getDb();
  const m = holen(db, req.params.id);
  if (!m) return res.status(404).json({ error: 'Diese Meldung gibt es nicht mehr.' });
  const verlaufListe = db.prepare('SELECT art, user_name, at, vorher, nachher FROM meldung_verlauf WHERE meldung_id = ? ORDER BY id').all(m.id);
  res.json({ meldung: mitErinnerungen(db, req.user, [ausgabe(m, req.user)])[0], verlauf: verlaufListe });
});

// ── Melden und ändern ──────────────────────────────────────────────────────────────────────────────────

router.post('/', authenticate, (req, res) => {
  const db = getDb();
  const thema = aktivesThema(db, req.body.thema_id);
  if (!thema) return res.status(400).json({ error: 'Bitte wähle ein Thema.' });
  const t = textPruefen(req.body.text);
  if (t.fehler) return res.status(400).json({ error: t.fehler });
  const dringend = req.body.dringend ? 1 : 0;
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO meldungen (thema_id, text, dringend, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`)
      .run(thema.id, t.text, dringend, req.user.id, req.user.id);
    verlauf(db, r.lastInsertRowid, req.user, 'gemeldet', null, t.text);
    return r.lastInsertRowid;
  })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_create',
    details: `Nr. ${id} · ${thema.name}${dringend ? ' · dringend' : ''}: ${kurz(t.text)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  const neu = holen(db, id);
  res.status(201).json({ meldung: ausgabe(neu, req.user) });
  pushSenden(db, neu, req.user, `Neue Meldung: ${thema.name}`, `${dringend ? '🔴 ' : ''}${kurz(t.text, 100)} — von ${wer(req.user)}`);
});

// Ändern: Text, Dringlichkeit, Thema — und (nur Bearbeiter) die Rückmeldung an den Melder.
router.put('/:id(\\d+)', authenticate, (req, res) => {
  const db = getDb();
  const m = holen(db, req.params.id);
  if (!m) return res.status(404).json({ error: 'Diese Meldung gibt es nicht mehr.' });
  if (m.thema_geloescht_am) return res.status(409).json({ error: 'Das Thema wurde gelöscht — die Meldung steht nur noch in der History.' });
  const bearbeiter = darfMeldungenBearbeiten(req.user);
  const eigen = m.created_by != null && m.created_by === req.user.id;
  if (!bearbeiter) {
    if (!eigen) return res.status(403).json({ error: 'Du kannst nur deine eigenen Meldungen ändern.' });
    if (m.status !== 'offen') return res.status(409).json({ error: 'Die Meldung wird schon bearbeitet — ändern geht nur, solange sie offen ist.' });
  }

  const b = req.body || {};
  const aenderungen = [];   // [art, vorher, nachher]
  let text = m.text, dringend = m.dringend, themaId = m.thema_id, rueck = m.rueckmeldung;
  if (b.text !== undefined) {
    const t = textPruefen(b.text);
    if (t.fehler) return res.status(400).json({ error: t.fehler });
    if (t.text !== m.text) { aenderungen.push(['bearbeitet', m.text, t.text]); text = t.text; }
  }
  if (b.dringend !== undefined && (b.dringend ? 1 : 0) !== m.dringend) {
    dringend = b.dringend ? 1 : 0;
    aenderungen.push(['dringlichkeit', m.dringend ? 'dringend' : 'normal', dringend ? 'dringend' : 'normal']);
  }
  if (b.thema_id !== undefined && Number(b.thema_id) !== m.thema_id) {
    const neu = aktivesThema(db, b.thema_id);
    if (!neu) return res.status(400).json({ error: 'Dieses Thema gibt es nicht (mehr).' });
    aenderungen.push(['thema', m.thema_name, neu.name]); themaId = neu.id;
  }
  if (b.rueckmeldung !== undefined) {
    if (!bearbeiter) return res.status(403).json({ error: 'Eine Rückmeldung schreiben Chef und Admin.' });
    const r = String(b.rueckmeldung || '').trim() || null;
    if (r && r.length > MAX_TEXT) return res.status(400).json({ error: `Die Rückmeldung ist zu lang (höchstens ${MAX_TEXT} Zeichen).` });
    if (r !== (m.rueckmeldung || null)) { aenderungen.push(['rueckmeldung', m.rueckmeldung, r]); rueck = r; }
  }
  if (!aenderungen.length) return res.json({ meldung: ausgabe(m, req.user), unveraendert: true });

  db.transaction(() => {
    db.prepare('UPDATE meldungen SET text = ?, dringend = ?, thema_id = ?, rueckmeldung = ? WHERE id = ?')
      .run(text, dringend, themaId, rueck, m.id);
    for (const [art, vorher, nachher] of aenderungen) verlauf(db, m.id, req.user, art, vorher, nachher);
    geaendert(db, m.id, req.user);
  })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_update',
    details: `Nr. ${m.id} · ${m.thema_name}: ` + aenderungen.map(([art, v, n]) =>
      art === 'bearbeitet' ? `Text „${kurz(v, 40)}" → „${kurz(n, 40)}"`
      : art === 'rueckmeldung' ? `Rückmeldung „${kurz(n, 40) || '(leer)'}"`
      : `${art === 'thema' ? 'Thema' : 'Dringlichkeit'} ${v} → ${n}`).join('; '), ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  const nachher = holen(db, m.id);
  res.json({ meldung: ausgabe(nachher, req.user) });
  const nurRueck = aenderungen.every(([art]) => art === 'rueckmeldung');
  if (nurRueck) pushSenden(db, nachher, req.user, `Rückmeldung: ${nachher.thema_name}`, `${wer(req.user)}: ${kurz(rueck || '(entfernt)', 100)} — zu „${kurz(nachher.text, 40)}"`);
  else pushSenden(db, nachher, req.user, `Meldung geändert: ${nachher.thema_name}`, `${wer(req.user)}: ${kurz(nachher.text, 100)}`);
});

// Status setzen: offen / in Arbeit / erledigt (auch zurück — „wieder öffnen").
router.post('/:id(\\d+)/status', authenticate, (req, res) => {
  const db = getDb();
  if (!darfMeldungenBearbeiten(req.user)) return res.status(403).json({ error: 'Den Stand setzen Chef und Admin.' });
  const m = holen(db, req.params.id);
  if (!m) return res.status(404).json({ error: 'Diese Meldung gibt es nicht mehr.' });
  if (m.thema_geloescht_am) return res.status(409).json({ error: 'Das Thema wurde gelöscht — die Meldung steht nur noch in der History.' });
  const neu = String((req.body || {}).status || '');
  if (!STATUS.includes(neu)) return res.status(400).json({ error: 'Unbekannter Stand.' });
  if (neu === m.status) return res.json({ meldung: ausgabe(m, req.user), unveraendert: true });
  db.transaction(() => {
    db.prepare(`UPDATE meldungen SET status = ?, status_at = ${JETZT}, status_by = ? WHERE id = ?`).run(neu, req.user.id, m.id);
    verlauf(db, m.id, req.user, 'status', m.status, neu);
    geaendert(db, m.id, req.user);
  })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_status',
    details: `Nr. ${m.id} · ${m.thema_name}: ${STATUS_TEXT[m.status]} → ${STATUS_TEXT[neu]} (${kurz(m.text, 40)})`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ meldung: ausgabe(holen(db, m.id), req.user) });
  pushSenden(db, m, req.user, `Meldung ${neu === 'offen' ? 'wieder offen' : STATUS_TEXT[neu]}: ${m.thema_name}`, `${wer(req.user)}: ${kurz(m.text, 100)}`);
});

// Zurückziehen: nur der Melder selbst, nur solange offen. Nichts verschwindet — sie steht in der History.
router.post('/:id(\\d+)/zurueckziehen', authenticate, (req, res) => {
  const db = getDb();
  const m = holen(db, req.params.id);
  if (!m) return res.status(404).json({ error: 'Diese Meldung gibt es nicht mehr.' });
  if (m.created_by == null || m.created_by !== req.user.id) return res.status(403).json({ error: 'Zurückziehen kann nur, wer die Meldung geschrieben hat.' });
  if (m.thema_geloescht_am) return res.status(409).json({ error: 'Das Thema wurde gelöscht — die Meldung steht nur noch in der History.' });
  if (m.status !== 'offen') return res.status(409).json({ error: 'Die Meldung wird schon bearbeitet — zurückziehen geht nur, solange sie offen ist.' });
  db.transaction(() => {
    db.prepare(`UPDATE meldungen SET status = 'zurueckgezogen', status_at = ${JETZT}, status_by = ? WHERE id = ?`).run(req.user.id, m.id);
    verlauf(db, m.id, req.user, 'status', m.status, 'zurueckgezogen');
    geaendert(db, m.id, req.user);
  })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_zurueckgezogen',
    details: `Nr. ${m.id} · ${m.thema_name}: ${kurz(m.text)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ meldung: ausgabe(holen(db, m.id), req.user) });
  pushSenden(db, m, req.user, `Meldung zurückgezogen: ${m.thema_name}`, `${wer(req.user)}: ${kurz(m.text, 100)}`);
});

// Endgültig löschen — nur Admin (zum Testen). Mit Verlauf; der Protokolleintrag behält den Text.
router.delete('/:id(\\d+)', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Endgültig löschen kann nur der Admin.' });
  const db = getDb();
  const m = holen(db, req.params.id);
  if (!m) return res.status(404).json({ error: 'Diese Meldung gibt es nicht mehr.' });
  db.transaction(() => {
    db.prepare('DELETE FROM meldungen WHERE id = ?').run(m.id);
    reste.nachLoeschen(db, 'meldungen');
  })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_delete',
    details: `Nr. ${m.id} · ${m.thema_name} · von ${m.created_by_name} (${STATUS_TEXT[m.status] || m.status}): ${kurz(m.text, 120)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ success: true });
});

// ── Erinnerungen (persönlich, nur Bearbeiter; meldung-erinnerungen.js) ─────────────────────────────────
// Sie gehören dem, der sie stellt: Andere sehen sie nicht, und sie stehen deshalb nicht im Verlauf der Meldung,
// den alle lesen — nur im Protokoll. Eine fremde Erinnerung gibt es für den Fragenden schlicht nicht (404).

const erinnerungsListe = (db, user, meldungId) => erinnerungen.eigeneZu(db, user.id, [meldungId]).get(meldungId) || [];
const erinnerungKurz = (e) => erinnerungen.umText(e.um) + (e.hinweis ? ` „${kurz(e.hinweis, 40)}"` : '');

router.post('/:id(\\d+)/erinnerungen', authenticate, (req, res) => {
  if (!darfMeldungenBearbeiten(req.user)) return res.status(403).json({ error: 'Erinnerungen stellt, wer Meldungen bearbeitet (Chef, Admin, Einzelrecht).' });
  const db = getDb();
  const m = holen(db, req.params.id);
  if (!m) return res.status(404).json({ error: 'Diese Meldung gibt es nicht mehr.' });
  if (!erinnerungen.meldungAktiv(m)) return res.status(409).json({ error: 'Die Meldung steht in der History — dort ruhen Erinnerungen. Öffne sie wieder, dann kannst du eine stellen.' });
  const p = erinnerungen.pruefen(req.body, new Date());
  if (p.fehler) return res.status(400).json({ error: p.fehler });
  if (erinnerungen.anzahl(db, req.user.id, m.id) >= erinnerungen.MAX_JE_MELDUNG) {
    return res.status(409).json({ error: `Mehr als ${erinnerungen.MAX_JE_MELDUNG} Erinnerungen an einer Meldung gehen nicht.` });
  }
  const id = erinnerungen.anlegen(db, req.user.id, m.id, p);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_erinnerung_create',
    details: `Nr. ${m.id} · ${m.thema_name}: ${erinnerungKurz(p)} (${kurz(m.text, 40)})`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.status(201).json({ id, erinnerungen: erinnerungsListe(db, req.user, m.id) });
});

// Ändern: neues Datum, neue Uhrzeit, anderer Hinweis. Macht eine ausgelöste oder verfallene Erinnerung wieder
// scharf. Ruht die Meldung gerade (History), ruht auch die geänderte Erinnerung — bis zum Wiederöffnen.
router.put('/erinnerungen/:eid(\\d+)', authenticate, (req, res) => {
  if (!darfMeldungenBearbeiten(req.user)) return res.status(403).json({ error: 'Erinnerungen stellt, wer Meldungen bearbeitet (Chef, Admin, Einzelrecht).' });
  const db = getDb();
  const e = erinnerungen.eigene(db, req.user.id, req.params.eid);
  if (!e) return res.status(404).json({ error: 'Diese Erinnerung gibt es nicht (mehr).' });
  const p = erinnerungen.pruefen(req.body, new Date());
  if (p.fehler) return res.status(400).json({ error: p.fehler });
  const m = holen(db, e.meldung_id);
  erinnerungen.aendern(db, e.id, p);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_erinnerung_update',
    details: `Nr. ${e.meldung_id} · ${m ? m.thema_name : '?'}: ${erinnerungKurz(e)} → ${erinnerungKurz(p)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ erinnerungen: erinnerungsListe(db, req.user, e.meldung_id) });
});

// Löschen geht immer — auch ohne Recht (wer es verloren hat, räumt seine alten Erinnerungen selbst weg).
router.delete('/erinnerungen/:eid(\\d+)', authenticate, (req, res) => {
  const db = getDb();
  const e = erinnerungen.eigene(db, req.user.id, req.params.eid);
  if (!e) return res.status(404).json({ error: 'Diese Erinnerung gibt es nicht (mehr).' });
  const m = holen(db, e.meldung_id);
  erinnerungen.entfernen(db, e.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_erinnerung_delete',
    details: `Nr. ${e.meldung_id} · ${m ? m.thema_name : '?'}: ${erinnerungKurz(e)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ erinnerungen: erinnerungsListe(db, req.user, e.meldung_id) });
});

// ── Themen (nur Chef/Admin) ────────────────────────────────────────────────────────────────────────────

function nurVerwalter(req, res, next) {
  if (!darfMeldungenVerwalten(req.user)) return res.status(403).json({ error: 'Themen verwalten Chef und Admin.' });
  next();
}

router.post('/themen', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const n = themaNamePruefen(req.body && req.body.name);
  if (n.fehler) return res.status(400).json({ error: n.fehler });
  if (namensDoppel(db, n.name)) return res.status(409).json({ error: `Das Thema „${n.name}" gibt es schon.` });
  const sort = (db.prepare('SELECT MAX(sort) AS s FROM meldung_themen WHERE deleted_at IS NULL').get().s ?? -1) + 1;
  const r = db.prepare('INSERT INTO meldung_themen (name, sort, created_by) VALUES (?, ?, ?)').run(n.name, sort, req.user.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_thema_create',
    details: `Thema „${n.name}" (Nr. ${r.lastInsertRowid})`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.status(201).json({ thema: { id: r.lastInsertRowid, name: n.name, sort } });
});

// Reihenfolge: die Nummern der aktiven Themen in der gewünschten Folge.
router.put('/themen-reihenfolge', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : null;
  const aktiv = db.prepare('SELECT id FROM meldung_themen WHERE deleted_at IS NULL ORDER BY sort, id').all().map(r => r.id);
  if (!ids || ids.length !== aktiv.length || new Set(ids).size !== ids.length || !ids.every(i => aktiv.includes(i))) {
    return res.status(409).json({ error: 'Die Themen haben sich inzwischen geändert — bitte die Seite neu laden.' });
  }
  db.transaction(() => { ids.forEach((id, i) => db.prepare('UPDATE meldung_themen SET sort = ? WHERE id = ?').run(i, id)); })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_thema_reihenfolge',
    details: 'Reihenfolge: ' + ids.map(id => (db.prepare('SELECT name FROM meldung_themen WHERE id = ?').get(id) || {}).name).join(', '), ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ success: true });
});

router.put('/themen/:id(\\d+)', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const t = aktivesThema(db, req.params.id);
  if (!t) return res.status(404).json({ error: 'Dieses Thema gibt es nicht (mehr).' });
  const n = themaNamePruefen(req.body && req.body.name);
  if (n.fehler) return res.status(400).json({ error: n.fehler });
  if (n.name === t.name) return res.json({ thema: t, unveraendert: true });
  if (namensDoppel(db, n.name, t.id)) return res.status(409).json({ error: `Das Thema „${n.name}" gibt es schon.` });
  db.prepare('UPDATE meldung_themen SET name = ? WHERE id = ?').run(n.name, t.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_thema_update',
    details: `Thema „${t.name}" → „${n.name}" (Nr. ${t.id})`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ thema: { ...t, name: n.name } });
});

// Bewusst OHNE Push: Das Löschen eines Themas ist Aufräumen, keine Neuigkeit — bei drei offenen Meldungen
// kämen sonst drei Meldungen auf einmal. Zähler und Hervorheben zeigen es trotzdem (updated_at).
// Löschen: Ohne Meldungen ist das Thema ganz weg. Mit Meldungen bleibt es weich gelöscht, und ALLES darauf
// wandert in die History — auch noch offene Meldungen, mit Vermerk im Verlauf (Alex, 30.09.2026).
router.delete('/themen/:id(\\d+)', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const t = aktivesThema(db, req.params.id);
  if (!t) return res.status(404).json({ error: 'Dieses Thema gibt es nicht (mehr).' });
  const anzahl = db.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE thema_id = ?').get(t.id).n;
  const offene = db.prepare("SELECT id FROM meldungen WHERE thema_id = ? AND status IN ('offen', 'in_arbeit')").all(t.id).map(r => r.id);
  db.transaction(() => {
    if (!anzahl) {
      // Ohne Meldungen ist das Thema ganz weg — seine Regeln (die nie etwas ausgelöst haben) mit
      const ids = db.prepare('SELECT id FROM meldung_regeln WHERE thema_id = ?').all(t.id).map(r => r.id);
      for (const id of ids) db.prepare('DELETE FROM meldung_regeln WHERE id = ?').run(id);
      db.prepare('DELETE FROM meldung_themen WHERE id = ?').run(t.id);
      if (ids.length) reste.nachLoeschen(db, 'meldung_regeln');
      return;
    }
    db.prepare(`UPDATE meldung_themen SET deleted_at = ${JETZT}, deleted_by = ? WHERE id = ?`).run(req.user.id, t.id);
    // Seine regelmäßigen Meldungen enden mit ihm (Alex, Rückfrage 13)
    db.prepare(`UPDATE meldung_regeln SET deleted_at = ${JETZT}, deleted_by = ? WHERE thema_id = ? AND deleted_at IS NULL`).run(req.user.id, t.id);
    for (const id of offene) {
      verlauf(db, id, req.user, 'thema_geloescht', t.name, null);
      geaendert(db, id, req.user);
    }
  })();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_thema_delete',
    details: `Thema „${t.name}" (Nr. ${t.id}) ` + (anzahl
      ? `gelöscht — ${anzahl} ${anzahl === 1 ? 'Meldung bleibt' : 'Meldungen bleiben'} in der History` + (offene.length ? `, davon ${offene.length} noch offen` : '')
      : 'gelöscht (keine Meldungen)'), ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ success: true, inHistory: anzahl, offen: offene.length });
});

// ── Regelmäßige Meldungen (nur Chef/Admin; Etappe 3, meldung-regeln.js) ────────────────────────────────

const regelHolen = (db, id) => db.prepare('SELECT * FROM meldung_regeln WHERE id = ? AND deleted_at IS NULL').get(Number(id));
const regelAusgabe = (db, id) => regeln.regelnLesen(db, new Date()).find(r => r.id === Number(id)) || null;
const regelKurz = (r, thema) => `„${kurz(r.text, 40)}" (${thema}): ` + r.ausloeser.map(regeln.ausloeserText).join(' + ');

router.get('/regeln', authenticate, (req, res) => {
  const db = getDb();
  res.json({ regeln: regeln.regelnLesen(db, new Date(), req.query.thema_id ? Number(req.query.thema_id) : null) });
});

// Vorschau der nächsten Fälligkeiten — noch ohne zu speichern (das Formular zeigt sie beim Eintippen)
router.post('/regeln/vorschau', authenticate, nurVerwalter, (req, res) => {
  const p = regeln.regelPruefen(req.body || {});
  if (p.fehler) return res.status(400).json({ error: p.fehler });
  res.json({ beschreibung: p.r.ausloeser.map(regeln.ausloeserText), naechste: regeln.vorschau(p.r, p.r.ausloeser, new Date(), 5, null) });
});

router.post('/regeln', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const thema = aktivesThema(db, (req.body || {}).thema_id);
  if (!thema) return res.status(400).json({ error: 'Bitte wähle ein Thema.' });
  const p = regeln.regelPruefen(req.body || {});
  if (p.fehler) return res.status(400).json({ error: p.fehler });
  const id = db.transaction(() => regeln.regelSpeichern(db, null, thema.id, p.r, req.user, new Date()))();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_regel_create',
    details: `Regel Nr. ${id} · ${regelKurz(p.r, thema.name)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.status(201).json({ regel: regelAusgabe(db, id) });
});

router.put('/regeln/:id(\\d+)', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const alt = regelHolen(db, req.params.id);
  if (!alt) return res.status(404).json({ error: 'Diese Regel gibt es nicht (mehr).' });
  const thema = aktivesThema(db, (req.body || {}).thema_id || alt.thema_id);
  if (!thema) return res.status(400).json({ error: 'Dieses Thema gibt es nicht (mehr).' });
  const p = regeln.regelPruefen(req.body || {});
  if (p.fehler) return res.status(400).json({ error: p.fehler });
  db.transaction(() => regeln.regelSpeichern(db, alt.id, thema.id, p.r, req.user, new Date()))();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_regel_update',
    details: `Regel Nr. ${alt.id} · ${regelKurz(p.r, thema.name)}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ regel: regelAusgabe(db, alt.id) });
});

// Pausieren / fortsetzen. Beim Fortsetzen zählt es ab heute — die Pause wird nicht nachgeholt.
router.post('/regeln/:id(\\d+)/pause', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const r = regelHolen(db, req.params.id);
  if (!r) return res.status(404).json({ error: 'Diese Regel gibt es nicht (mehr).' });
  const pausiert = (req.body || {}).pausiert ? 1 : 0;
  if (pausiert === r.pausiert) return res.json({ regel: regelAusgabe(db, r.id), unveraendert: true });
  if (pausiert) db.prepare(`UPDATE meldung_regeln SET pausiert = 1, updated_at = ${JETZT}, updated_by = ? WHERE id = ?`).run(req.user.id, r.id);
  else db.prepare(`UPDATE meldung_regeln SET pausiert = 0, gueltig_ab = ?, updated_at = ${JETZT}, updated_by = ? WHERE id = ?`)
    .run(require('../zeit').berlinHeute() + ' 00:00', req.user.id, r.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_regel_pause',
    details: `Regel Nr. ${r.id} „${kurz(r.text, 40)}" ${pausiert ? 'pausiert' : 'fortgesetzt'}`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ regel: regelAusgabe(db, r.id) });
});

// Löschen: die Regel endet; schon erzeugte Meldungen bleiben stehen (Rückfrage 29).
router.delete('/regeln/:id(\\d+)', authenticate, nurVerwalter, (req, res) => {
  const db = getDb();
  const r = regelHolen(db, req.params.id);
  if (!r) return res.status(404).json({ error: 'Diese Regel gibt es nicht (mehr).' });
  db.prepare(`UPDATE meldung_regeln SET deleted_at = ${JETZT}, deleted_by = ? WHERE id = ?`).run(req.user.id, r.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'meldung_regel_delete',
    details: `Regel Nr. ${r.id} „${kurz(r.text, 40)}" gelöscht — erzeugte Meldungen bleiben`, ip: req.ip });
  broadcast('meldungen', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
