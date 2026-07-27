const express = require('express');
const PDFDocument = require('pdfkit');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');
const push = require('../push');
const { computeAbsenceSummary, countUrlaubDaysInYear, vacationAccount, countUrlaubPendingInYear } = require('./absence-days');
const { recordAbsenceHistory, berlinNow } = require('../audit');
const { pruefeSperre, protokolliereEingriff } = require('../abschluss');

// Abrechnungs-Abschluss: Fast jede Aktion auf einer Abwesenheit verschiebt die Soll-Stunden —
// Genehmigen und Ablehnen genauso wie Anlegen oder Loeschen, denn erst der Status entscheidet, ob
// die Tage zaehlen. Deshalb pruefen alle diese Routen denselben Zeitraum. proposed_* gehoert dazu:
// Beim Quittieren eines Manager-Vorschlags werden diese Daten zu den echten.
function sperreFuerAbwesenheit(db, absence, req) {
  return pruefeSperre(db,
    [absence.date_from, absence.date_to, absence.proposed_date_from, absence.proposed_date_to],
    req.user, req.body && req.body.reason);
}

// Datumsbereich „TT.MM.–TT.MM." (bzw. ein einzelnes Datum, wenn von==bis) für Push-Texte.
function fmtRange(from, to) {
  const f = (d) => String(d).split('-').reverse().join('.');
  return from === to ? f(from) : `${f(from)}–${f(to)}`;
}

// Validierungs-Helper für ISO-Datum (YYYY-MM-DD, kalendarisch gültig)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const COMMENT_MAX = 1000;
function tooLongComment(c) { return typeof c === 'string' && c.length > COMMENT_MAX; }

// Hinweis (kein Block), wenn ein Urlaubs-Antrag den verfügbaren Resturlaub überschreitet.
// Zählt genehmigt (genommen+geplant) + offen beantragt gegen den Gesamtanspruch des Jahres.
// (B5) Bei jahresübergreifendem Urlaub (z. B. 28.12.–05.01.) wird JEDES betroffene Jahr geprüft,
// nicht nur das Startjahr — die Warnung nennt das erste überzogene Jahr.
function urlaubWarning(db, uid, type, dateFrom, dateTo) {
  if (type !== 'urlaub' || uid == null) return null;
  const y0 = parseInt(String(dateFrom).slice(0, 4), 10);
  const y1 = parseInt(String(dateTo || dateFrom).slice(0, 4), 10) || y0;
  if (!y0) return null;
  for (let year = y0; year <= y1; year++) {
    const v = vacationAccount(db, uid, year, new Date());
    const beantragt = countUrlaubPendingInYear(db, uid, year);
    const verbraucht = v.genommen + v.geplant + beantragt;
    if (verbraucht > v.verfuegbar) {
      const rest = Math.round((v.verfuegbar - v.genommen - v.geplant) * 100) / 100;
      return `Überschreitet den Resturlaub für ${year}: noch ${rest} Arbeitstage verfügbar.`;
    }
  }
  return null;
}

const router = express.Router();

// Typen die sofort aktiv sind (kein Genehmigungsschritt)
const AUTO_ACTIVE = ['krank', 'feiertag', 'berufsschule', 'innung'];
// Typen die Chef-Benachrichtigung brauchen (auch nach Edit)
const NOTIFY_CHEF = ['krank', 'berufsschule', 'innung'];
// Typen die eine Genehmigung brauchen (Vorschlags-Mechanismus bei Manager-Edit von approved)
const APPROVAL_REQUIRED = ['urlaub', 'freizeitausgleich', 'sonderurlaub'];

// Konflikt-Gruppen: zwei Abwesenheiten derselben Gruppe duerfen sich pro Tag NICHT
// ueberschneiden (Doppelbuchung). Stufenuebergreifend (z.B. Krank ueber Urlaub) bleibt
// erlaubt — das ist das gewollte Verdraengungs-Feature der Tageszaehlung.
const CONFLICT_GROUPS = [
  ['urlaub', 'freizeitausgleich', 'sonderurlaub'],
  ['berufsschule', 'innung'],
  ['krank'],
];
const TYPE_LABELS = {
  krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'Freizeitausgleich',
  sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag', berufsschule: 'Berufsschule', innung: 'Innung',
};
function conflictGroup(type) {
  return CONFLICT_GROUPS.find(g => g.includes(type)) || null;
}
// Liefert einen kollidierenden Datensatz derselben Gruppe (oder null). excludeId beim Bearbeiten.
function sameTierConflict(db, uid, type, from, to, excludeId) {
  const group = conflictGroup(type);
  if (!group || uid == null) return null; // feiertag (global) oder unbekannt: kein Gruppen-Check
  const ph = group.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, type, date_from, date_to FROM absences
    WHERE user_id = ? AND deleted_at IS NULL
      AND status IN ('pending','active','approved')
      AND type IN (${ph})
      AND date_from <= ? AND date_to >= ?
      AND id != ?
    ORDER BY date_from LIMIT 1
  `).get(uid, ...group, to, from, excludeId || -1);
}
function conflictMessage(type, conflict) {
  const g = conflictGroup(type).map(t => TYPE_LABELS[t]).join('/');
  const fmt = (d) => d.split('-').reverse().join('.');
  return `Überschneidung mit bestehender Abwesenheit „${TYPE_LABELS[conflict.type] || conflict.type}" `
    + `(${fmt(conflict.date_from)}–${fmt(conflict.date_to)}). Pro Tag ist nur eine Abwesenheit aus ${g} möglich.`;
}

function isManager(user) {
  return user.role === 'admin' || user.role === 'chef' || user.role === 'buchhalter';
}
// Schreib-/Verwaltungsrechte auf FREMDE Abwesenheiten (genehmigen/ablehnen/löschen/bearbeiten/quittieren,
// Fremdeintrag, Feiertage). Buchhalter ist bewusst NICHT dabei: er hat lesende Manager-Sicht, verwaltet
// aber nicht (konsistent zu Zeiteinträgen, die er auch nur selbst löschen kann).
function canManageAbsences(user) {
  return user.role === 'admin' || user.role === 'chef';
}

function initialStatus(type) {
  return AUTO_ACTIVE.includes(type) ? 'active' : 'pending';
}

function withUserName(absence, db) {
  if (absence.user_id) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(absence.user_id);
    absence.user_name = u ? u.name : 'Unbekannt';
  } else {
    absence.user_name = 'Alle';
  }
  if (absence.processed_by) {
    const p = db.prepare('SELECT name FROM users WHERE id = ?').get(absence.processed_by);
    absence.processed_by_name = p ? p.name : 'Unbekannt';
  }
  if (absence.created_by) {
    const cb = db.prepare('SELECT name FROM users WHERE id = ?').get(absence.created_by);
    absence.created_by_name = cb ? cb.name : 'Unbekannt';
  }
  return absence;
}

// Hilfsfunktion: Arbeitstage (Mo-Fr) zählen, begrenzt auf from/to
function countWorkdays(dateFrom, dateTo) {
  let count = 0;
  const start = new Date(dateFrom + 'T12:00:00');
  const end = new Date(dateTo + 'T12:00:00');
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Arbeitstage im Schnittbereich zweier Zeiträume
function countWorkdaysIntersect(aFrom, aTo, bFrom, bTo) {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (from > to) return 0;
  return countWorkdays(from, to);
}

// GET /api/absences — eigene (MA) oder alle (Manager)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const { type, from, to, user_id } = req.query;

  let sql = 'SELECT * FROM absences WHERE 1=1 AND deleted_at IS NULL';
  const params = [];

  if (!isManager(req.user)) {
    // Eigene Abwesenheiten + globale Feiertage (gelten fuer alle)
    sql += " AND (user_id = ? OR (type = 'feiertag' AND status = 'active'))";
    params.push(uid);
  } else if (user_id) {
    sql += ' AND user_id = ?';
    params.push(Number(user_id));
  }

  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (from) { sql += ' AND date_to >= ?'; params.push(from); }
  if (to)   { sql += ' AND date_from <= ?'; params.push(to); }

  sql += ' ORDER BY date_from DESC, created_at DESC';

  const absences = db.prepare(sql).all(...params).map(a => withUserName(a, db));
  res.json({ absences });
});

// GET /api/absences/summary — Abwesenheitsübersicht für Zeitraum
router.get('/summary', authenticate, (req, res) => {
  const db = getDb();
  const { from, to, user_id } = req.query;

  if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });

  let targetUid;
  if (req.user.role === 'mitarbeiter') {
    targetUid = req.user.id;
  } else if (user_id) {
    if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
    targetUid = Number(user_id);
  } else {
    // Manager ohne user_id: eigene Zusammenfassung
    targetUid = req.user.id;
  }

  // Prioritätsbewusste Zählung (Feiertag > Krank > Urlaub/FZA) — gemeinsame Quelle mit der PDF
  const { summary, totalUniqueDays } = computeAbsenceSummary(db, targetUid, from, to);
  // Anzeigejahr aus dem Zeitraum (from) ableiten; Split-Stichtag = heute.
  const year = parseInt(String(from).slice(0, 4), 10) || new Date().getFullYear();
  const urlaubTageJahr = countUrlaubDaysInYear(db, targetUid, year); // Abwärtskompat (nur genommen+geplant gesamt)
  const vacation = vacationAccount(db, targetUid, year, new Date());

  res.json({ summary, totalUniqueDays, urlaubTageJahr, year, vacation, anyVacationConfigured: anyVacationConfigured(db) });
});

// Ist irgendwo im Betrieb ein Urlaubsanspruch (Zeile oder Start-Resturlaub) hinterlegt? Steuert, ob die
// NEUEN Resturlaub-Ansichten (Manager-Reiter etc.) überhaupt erscheinen (sonst bleibt alles bei der alten Sicht).
function anyVacationConfigured(db) {
  try {
    return !!db.prepare('SELECT 1 FROM vacation_entitlements LIMIT 1').get();
  } catch (_) { return false; }
}

// Urlaubskonto je aktivem Nicht-Admin-Nutzer (gemeinsame Quelle für JSON- und PDF-Ausgabe).
function buildVacationOverview(db, year, now) {
  const users = db.prepare("SELECT id, name FROM users WHERE role != 'admin' AND COALESCE(active,1) = 1 ORDER BY name").all();
  const from = `${year}-01-01`, to = `${year}-12-31`;
  return users.map(u => {
    const v = vacationAccount(db, u.id, year, now);
    const { summary } = computeAbsenceSummary(db, u.id, from, to);
    return {
      user_id: u.id, name: u.name, configured: v.configured,
      anspruch: v.anspruch, uebertrag: v.uebertrag, gesamtanspruch: v.verfuegbar,
      genommen: v.genommen, geplant: v.geplant, nochZuPlanen: v.nochZuPlanen,
      beantragt: countUrlaubPendingInYear(db, u.id, year),
      krank: summary.krank || 0, fza: summary.freizeitausgleich || 0,
    };
  });
}

// GET /api/absences/vacation-overview?year=YYYY — Urlaubskonto je Mitarbeiter (nur Manager/Buchhalter, read).
router.get('/vacation-overview', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const now = new Date();
  res.json({ year, stand: now.toISOString().slice(0, 10), rows: buildVacationOverview(db, year, now) });
});

// GET /api/absences/vacation-overview.pdf?year=YYYY — dieselbe Tabelle als echtes Server-PDF (Download).
router.get('/vacation-overview.pdf', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const now = new Date();
  const rows = buildVacationOverview(db, year, now);

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Urlaubsuebersicht_${year}.pdf"`);
  doc.pipe(res);

  doc.fontSize(15).font('Helvetica-Bold').fillColor('#111').text(`Urlaubsübersicht ${year}`, 40, 40);
  doc.fontSize(9).font('Helvetica').fillColor('#555').text(`Stand: ${now.toLocaleDateString('de-DE')}`);
  doc.moveDown(0.6).fillColor('#111');

  const cols = [
    { k: 'name', label: 'Mitarbeiter', w: 150, align: 'left' },
    { k: 'anspruch', label: 'Anspruch', w: 62 },
    { k: 'uebertrag', label: 'Übriger Vorjahr', w: 76 },
    { k: 'gesamtanspruch', label: 'Gesamtanspruch', w: 82 },
    { k: 'genommen', label: 'Genommen', w: 66 },
    { k: 'geplant', label: 'Geplant & akzept.', w: 84 },
    { k: 'nochZuPlanen', label: 'Noch zu planen', w: 78 },
    { k: 'beantragt', label: 'Beantragt (offen)', w: 84 },
    { k: 'krank', label: 'Krank', w: 46 },
    { k: 'fza', label: 'FZA', w: 42 },
  ];
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const x0 = 40, rowH = 18;
  let y = doc.y;
  const drawRow = (vals, header) => {
    if (y + rowH > doc.page.height - 40) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 }); y = 40; }
    if (header) { doc.rect(x0, y, totalW, rowH).fill('#f3f4f6'); }
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 7.5 : 8.5).fillColor(header ? '#333' : '#111');
    const calcCols = ['anspruch', 'uebertrag', 'gesamtanspruch', 'nochZuPlanen'];
    let x = x0;
    for (const c of cols) {
      let t = String(vals[c.k]);
      if (!header && vals.configured === false && calcCols.includes(c.k)) t = '–'; // ohne Anspruch keine Rechnung
      doc.text(t, x + 3, y + 5, { width: c.w - 6, align: c.align || 'center', lineBreak: false });
      x += c.w;
    }
    doc.moveTo(x0, y + rowH).lineTo(x0 + totalW, y + rowH).lineWidth(0.3).strokeColor('#cbd5e1').stroke();
    y += rowH;
  };
  drawRow(cols.reduce((o, c) => { o[c.k] = c.label; return o; }, {}), true);
  for (const r of rows) drawRow(r, false);

  doc.end();
});

// GET /api/absences/pending — offene Anträge für Manager-Ansicht (Posteingang)
router.get('/pending', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const absences = db.prepare(`
    SELECT * FROM absences
    WHERE deleted_at IS NULL AND (
      status = 'pending'
      OR (status = 'active' AND type IN ('krank','berufsschule','innung') AND notified_at IS NULL)
    )
    ORDER BY updated_at DESC
  `).all().map(a => withUserName(a, db));
  res.json({ absences });
});

// GET /api/absences/by-date — für Timeline-Anzeige (Von-Bis-Bereich)
router.get('/by-date', authenticate, (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });
  const fDate = new Date(from + 'T00:00:00');
  const tDate = new Date(to + 'T00:00:00');
  if (isNaN(fDate) || isNaN(tDate)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat' });
  }
  const diffDays = (tDate - fDate) / (1000 * 60 * 60 * 24);
  if (diffDays < 0 || diffDays > 366) {
    return res.status(400).json({ error: 'Zeitraum zu groß (max. 366 Tage)' });
  }

  const uid = req.user.id;
  let sql, params;

  // Genehmigungspflichtige Typen erscheinen erst nach Genehmigung (approved), nicht schon bei pending
  const APPROVAL_TYPES = "('urlaub','sonderurlaub','freizeitausgleich')";

  // Alle Abwesenheiten sehen: Manager immer; Mitarbeiter mit „alle"-Planungsrecht (can_plan_all) NUR im
  // Planungskontext (damit sie vernünftig fremd-planen können). Die echte Autorisierung ist can_plan_all —
  // scope ist nur ein Kontext-Hinweis (Dashboard/Statistik nutzen ihn bewusst nicht). Self-Planer
  // (can_plan ohne can_plan_all) sehen weiterhin nur die eigenen Abwesenheiten.
  const canSeeAll = isManager(req.user) || (req.user.can_plan_all && req.query.scope === 'planning');

  if (canSeeAll) {
    // Optionaler user_id-Filter (eine ID oder kommasepariert) — globale Feiertage (user_id IS NULL)
    // bleiben immer enthalten. Ohne Filter: alle (z.B. Dashboard/Planung).
    const idList = String(req.query.user_id || '').split(',').map(s => parseInt(s, 10)).filter(n => n > 0);
    const userFilter = idList.length
      ? ` AND (a.user_id IN (${idList.map(() => '?').join(',')}) OR a.user_id IS NULL)` : '';
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND a.deleted_at IS NULL
           AND (
             (a.status IN ('active','approved'))
             OR (a.status = 'pending' AND a.type NOT IN ${APPROVAL_TYPES})
             OR (a.status = 'pending' AND a.proposed_date_from IS NOT NULL)
           )${userFilter}
           ORDER BY a.date_from`;
    params = [to, from, ...idList];
  } else {
    // Mitarbeiter: eigene + Feiertage (active)
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND a.deleted_at IS NULL
           AND (
             (a.user_id = ? AND (
               a.status IN ('active','approved')
               OR (a.status = 'pending' AND a.type NOT IN ${APPROVAL_TYPES})
               OR (a.status = 'pending' AND a.proposed_date_from IS NOT NULL)
             ))
             OR (a.user_id IS NULL AND a.status = 'active')
           )
           ORDER BY a.date_from`;
    params = [to, from, uid];
  }

  const rows = db.prepare(sql).all(...params);
  // Datenschutz: Nicht-Manager (z. B. Planer) sehen bei FREMDEN Abwesenheiten keinen Kommentar
  // (möglicher sensibler Grund). Eigener Kommentar bleibt sichtbar.
  if (!isManager(req.user)) {
    for (const r of rows) if (r.user_id && r.user_id !== uid) r.comment = '';
  }
  res.json({ absences: rows });
});

// POST /api/absences — neue Abwesenheit anlegen
router.post('/', authenticate, (req, res) => {
  const db = getDb();
  const { type, date_from, date_to, comment, target_user_id } = req.body;

  if (!type || !date_from || !date_to) {
    return res.status(400).json({ error: 'Typ, Datum von und bis sind Pflichtfelder' });
  }
  if (!isValidDate(date_from) || !isValidDate(date_to)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  if (date_from > date_to) {
    return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });
  }
  if (tooLongComment(comment)) {
    return res.status(400).json({ error: `Kommentar zu lang (max. ${COMMENT_MAX} Zeichen)` });
  }

  const validTypes = ['krank','urlaub','freizeitausgleich','sonderurlaub','feiertag','berufsschule','innung'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Ungültiger Typ' });
  }

  // Feiertage nur für Chef/Admin
  if (type === 'feiertag' && !canManageAbsences(req.user)) {
    return res.status(403).json({ error: 'Feiertage können nur von Chef/Admin eingetragen werden' });
  }

  let uid, status, created_by;

  if (type === 'feiertag') {
    uid = null;
    status = initialStatus(type);
    created_by = req.user.id;
  } else if (target_user_id && Number(target_user_id) !== req.user.id) {
    // Chef/Admin trägt für anderen MA ein (Buchhalter nicht — read-only)
    if (!canManageAbsences(req.user)) {
      return res.status(403).json({ error: 'Keine Berechtigung für Fremdeintrag' });
    }
    // Ziel-Mitarbeiter muss existieren und aktiv sein (analog POST /api/entries) — sonst entstünden
    // verwaiste Abwesenheiten, die in keiner Auswertung auftauchen.
    const target = db.prepare("SELECT id, role, COALESCE(active,1) AS active FROM users WHERE id = ?").get(Number(target_user_id));
    if (!target || target.active === 0 || target.role === 'admin') {
      return res.status(400).json({ error: 'Ungültiger Mitarbeiter' });
    }
    uid = Number(target_user_id);
    created_by = req.user.id;
    // urlaub/freizeitausgleich/sonderurlaub → pending (MA muss akzeptieren)
    // alle anderen → active (informativ)
    if (['urlaub', 'freizeitausgleich', 'sonderurlaub'].includes(type)) {
      status = 'pending';
    } else {
      status = 'active';
    }
  } else {
    // Normaler Eigeneintrag
    uid = req.user.id;
    created_by = req.user.id;
    status = initialStatus(type);
  }

  // Doppelbuchung innerhalb derselben Stufe verhindern (z.B. Urlaub + FZA am selben Tag)
  const conflict = sameTierConflict(db, uid, type, date_from, date_to, null);
  if (conflict) {
    return res.status(400).json({ error: conflictMessage(type, conflict) });
  }

  const sperre = pruefeSperre(db, [date_from, date_to], req.user, req.body.reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  const result = db.prepare(`
    INSERT INTO absences (user_id, type, date_from, date_to, status, comment, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
  `).run(uid, type, date_from, date_to, status, (comment || '').trim(), created_by);

  const absence = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(result.lastInsertRowid), db);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${type} ${date_from}–${date_to} angelegt`);
  broadcast('absences', req.headers['x-tab-id']);
  res.status(201).json({ absence, warning: urlaubWarning(db, uid, type, date_from, date_to) });

  // Push analog Abwesenheits-Badge:
  const label = TYPE_LABELS[type] || type;
  const range = fmtRange(date_from, date_to);
  if (type !== 'feiertag') {
    if (created_by !== uid && status === 'pending' && APPROVAL_REQUIRED.includes(type)) {
      // Manager hat für einen MA eingetragen → der MA muss bestätigen.
      push.notifyUsers(db, [uid], 'absences', {
        title: `${label} eingetragen`, body: `Bitte bestätigen: ${range}`, url: '/#/absences',
      }, req.user.id);
    } else if (status === 'pending' && APPROVAL_REQUIRED.includes(type)) {
      // Selbstantrag → alle Manager.
      push.notifyUsers(db, push.managerIds(db, req.user.id), 'absences', {
        title: `Neuer Antrag: ${label}`, body: `${absence.user_name}: ${range}`, url: '/#/absences',
      }, req.user.id);
    } else if (status === 'active' && NOTIFY_CHEF.includes(type)) {
      // Krank/Berufsschule/Innung gemeldet → alle Manager.
      push.notifyUsers(db, push.managerIds(db, req.user.id), 'absences', {
        title: `${label} gemeldet`, body: `${absence.user_name}: ${range}`, url: '/#/absences',
      }, req.user.id);
    }
  }
});

// PUT /api/absences/:id — Abwesenheit bearbeiten
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const isOwner = absence.user_id === req.user.id;
  const manager = canManageAbsences(req.user);
  if (!isOwner && !manager) return res.status(403).json({ error: 'Keine Berechtigung' });

  // GoBD: Bearbeiten einer fremden Abwesenheit (Manager) erfordert eine Begruendung
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!isOwner && !reason) {
    return res.status(400).json({ error: 'Begründung erforderlich beim Bearbeiten einer fremden Abwesenheit' });
  }

  const { date_from, date_to, comment } = req.body;
  if (!date_from || !date_to) return res.status(400).json({ error: 'Datum von und bis erforderlich' });
  if (!isValidDate(date_from) || !isValidDate(date_to)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  if (date_from > date_to) return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });
  if (tooLongComment(comment)) {
    return res.status(400).json({ error: `Kommentar zu lang (max. ${COMMENT_MAX} Zeichen)` });
  }

  // Doppelbuchung innerhalb derselben Stufe verhindern (sich selbst ausgenommen)
  const conflict = sameTierConflict(db, absence.user_id, absence.type, date_from, date_to, absence.id);
  if (conflict) {
    return res.status(400).json({ error: conflictMessage(absence.type, conflict) });
  }

  // Alter UND neuer Zeitraum: sonst liesse sich eine Abwesenheit aus dem bezahlten Bereich schieben.
  const sperre = pruefeSperre(db,
    [absence.date_from, absence.date_to, absence.proposed_date_from, absence.proposed_date_to, date_from, date_to],
    req.user, reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  // GoBD: Vorher-Abbild festhalten, bevor irgendein UPDATE-Zweig die Daten ueberschreibt
  recordAbsenceHistory(db, absence, 'update', req.user.id, reason);

  let newStatus = absence.status;
  let notifiedAt = absence.notified_at;
  let newCreatedBy = absence.created_by;

  // Vorschlags-Mechanismus: Manager bearbeitet GENEHMIGTEN Urlaub/FZA/Sonderurlaub
  // ODER bereits pendenden Vorschlag (proposed_date_from gesetzt) → alte Daten schützen
  const useProposalMechanism = manager && !isOwner
    && APPROVAL_REQUIRED.includes(absence.type)
    && (absence.status === 'approved' || (absence.status === 'pending' && absence.proposed_date_from));

  if (isOwner && !manager) {
    // MA bearbeitet eigene Abwesenheit → proposed_* immer löschen
    if (absence.status === 'approved' || absence.status === 'rejected') {
      newStatus = 'pending';
      newCreatedBy = absence.user_id;
    } else if (absence.status === 'active' && NOTIFY_CHEF.includes(absence.type)) {
      notifiedAt = null;
      newCreatedBy = absence.user_id;
    }
    db.prepare(`
      UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
        status = ?, notified_at = ?, created_by = ?,
        proposed_date_from = NULL, proposed_date_to = NULL, ma_needs_ack = 0,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, newCreatedBy, absence.id);

  } else if (useProposalMechanism) {
    // Vorschlag: alte Daten in date_from/date_to bleiben, neue in proposed_*
    // Status → pending, MA muss zustimmen
    db.prepare(`
      UPDATE absences SET proposed_date_from = ?, proposed_date_to = ?,
        comment = ?, status = 'pending', ma_needs_ack = 1,
        processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), req.user.id, absence.id);

  } else if (manager && !isOwner) {
    // Direktes Update: Krank/BS/Innung oder pending Urlaub (ohne vorherigen Vorschlag)
    db.prepare(`
      UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
        status = ?, notified_at = ?, created_by = ?,
        proposed_date_from = NULL, proposed_date_to = NULL, ma_needs_ack = 1,
        processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, newCreatedBy, req.user.id, absence.id);

  } else {
    // Manager bearbeitet eigene Abwesenheit
    if (manager && absence.created_by && absence.created_by !== absence.user_id) {
      if (absence.status === 'approved' || absence.status === 'rejected') {
        newStatus = 'pending';
      }
    }
    db.prepare(`
      UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
        status = ?, notified_at = ?, created_by = ?,
        proposed_date_from = NULL, proposed_date_to = NULL, ma_needs_ack = 0,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, newCreatedBy, absence.id);
  }

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} geändert`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });

  // Manager hat eine fremde Abwesenheit bearbeitet → MA muss bestätigen (ma_needs_ack gesetzt).
  if (updated.ma_needs_ack === 1 && updated.user_id && updated.user_id !== req.user.id) {
    const label = TYPE_LABELS[updated.type] || updated.type;
    // Bei Vorschlag zeigt proposed_* die neuen Daten, sonst date_from/to.
    const fromD = updated.proposed_date_from || updated.date_from;
    const toD = updated.proposed_date_to || updated.date_to;
    push.notifyUsers(db, [updated.user_id], 'absences', {
      title: 'Abwesenheit bearbeitet', body: `Bitte bestätigen: ${label} ${fmtRange(fromD, toD)}`, url: '/#/absences',
    }, req.user.id);
  }
});

// DELETE /api/absences/:id
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const isOwner = absence.user_id === req.user.id;
  if (!isOwner && !canManageAbsences(req.user)) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  // MA kann pending/active/rejected löschen — nur approved erfordert Chef/Admin
  if (isOwner && !canManageAbsences(req.user) && absence.status === 'approved') {
    return res.status(403).json({ error: 'Genehmigte Abwesenheiten können nur vom Vorgesetzten gelöscht werden' });
  }

  // GoBD: Loeschen einer fremden Abwesenheit (Manager) erfordert Begruendung
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!isOwner && !reason) {
    return res.status(400).json({ error: 'Begründung erforderlich beim Löschen einer fremden Abwesenheit' });
  }

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  // Vorher-Abbild festhalten, dann Soft-Delete (Zeile bleibt fuer Pruefung erhalten)
  recordAbsenceHistory(db, absence, 'delete', req.user.id, reason);
  db.prepare("UPDATE absences SET deleted_at = ?, deleted_by = ? WHERE id = ?")
    .run(berlinNow(), req.user.id, absence.id);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} gelöscht`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Aenderungsverlauf einer Abwesenheit (chef + admin) — GoBD-Nachvollziehbarkeit
router.get('/:id/history', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT h.id, h.absence_id, h.action, h.changed_by, h.changed_at, h.reason, h.snapshot,
           u.name as changed_by_name
    FROM absence_history h
    LEFT JOIN users u ON h.changed_by = u.id
    WHERE h.absence_id = ?
    ORDER BY h.changed_at DESC, h.id DESC
  `).all(req.params.id);
  for (const r of rows) {
    try { r.snapshot = JSON.parse(r.snapshot); } catch (_) { r.snapshot = null; }
  }
  res.json({ history: rows });
});

// Papierkorb-Vollsicht: Chef/Admin sehen alles, Mitarbeiter (und Buchhalter) nur ihre EIGENEN Löschungen.
const canSeeAllTrash = (u) => u.role === 'admin' || u.role === 'chef';

// Gelöschte Abwesenheiten (Papierkorb). Chef/Admin: alle. Mitarbeiter/Buchhalter: ihre EIGENEN
// (`user_id` = Eigentum, NICHT `deleted_by`) — so sieht der MA auch eine vom Chef gelöschte eigene
// Abwesenheit und kann sie neu beantragen.
router.get('/deleted/list', authenticate, (req, res) => {
  const db = getDb();
  const ownOnly = !canSeeAllTrash(req.user);
  const rows = db.prepare(`
    SELECT a.*, u.name as user_name, du.name as deleted_by_name,
           (SELECT h.reason FROM absence_history h
            WHERE h.absence_id = a.id AND h.action = 'delete'
            ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) as delete_reason
    FROM absences a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN users du ON a.deleted_by = du.id
    WHERE a.deleted_at IS NOT NULL ${ownOnly ? 'AND a.user_id = ?' : ''}
    ORDER BY a.deleted_at DESC
  `).all(...(ownOnly ? [req.user.id] : []));
  res.json({ absences: rows });
});

// Gelöschte Abwesenheit wiederherstellen — NUR Admin (bewusste Ausnahme). Für Chef/Mitarbeiter/Buchhalter
// ist Restore gesperrt, weil er den Antrag als bereits „genehmigt" zurückbrächte und die Genehmigung
// umginge (problematisch, wenn der Zeitraum inzwischen verplant wurde) — die nutzen „Neu beantragen".
// Der gelöschte Datensatz bleibt ohnehin für die Revisionssicherheit (GoBD) im Papierkorb erhalten.
router.post('/:id/restore', authenticate, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Abwesenheiten können nur vom Admin wiederhergestellt werden – bitte neu beantragen.' });
  }
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Gelöschte Abwesenheit nicht gefunden' });

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  recordAbsenceHistory(db, absence, 'restore', req.user.id, reason);
  db.prepare('UPDATE absences SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(req.params.id);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} wiederhergestellt`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// POST /api/absences/:id/approve — genehmigen
router.post('/:id/approve', authenticate, (req, res) => {
  if (!canManageAbsences(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  const newStatus = AUTO_ACTIVE.includes(absence.type) ? 'active' : 'approved';

  db.prepare(`
    UPDATE absences SET status = ?, processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(newStatus, req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} genehmigt`);
  res.json({ absence: updated, warning: urlaubWarning(db, updated.user_id, updated.type, updated.date_from, updated.date_to) });

  // Antrag genehmigt → der Mitarbeiter.
  if (updated.user_id && updated.user_id !== req.user.id) {
    const label = TYPE_LABELS[updated.type] || updated.type;
    push.notifyUsers(db, [updated.user_id], 'absences', {
      title: `${label} genehmigt`, body: fmtRange(updated.date_from, updated.date_to), url: '/#/absences',
    }, req.user.id);
  }
});

// POST /api/absences/:id/reject — ablehnen (Manager)
router.post('/:id/reject', authenticate, (req, res) => {
  if (!canManageAbsences(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  db.prepare(`
    UPDATE absences SET status = 'rejected', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} abgelehnt`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });

  // Antrag abgelehnt → der Mitarbeiter.
  if (updated.user_id && updated.user_id !== req.user.id) {
    const label = TYPE_LABELS[updated.type] || updated.type;
    push.notifyUsers(db, [updated.user_id], 'absences', {
      title: `${label} abgelehnt`, body: fmtRange(updated.date_from, updated.date_to), url: '/#/absences',
    }, req.user.id);
  }
});

// POST /api/absences/:id/accept — MA akzeptiert Manager-eingetragenen Urlaub/FZA
router.post('/:id/accept', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  // Nur wenn: eigener Eintrag, von Manager eingetragen, noch pending
  if (absence.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  if (!absence.created_by || absence.created_by === absence.user_id) {
    return res.status(403).json({ error: 'Nur Manager-Einträge können akzeptiert werden' });
  }
  if (absence.status !== 'pending') {
    return res.status(400).json({ error: 'Nur pending Einträge können akzeptiert werden' });
  }

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  db.prepare(`
    UPDATE absences SET status = 'approved', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} akzeptiert`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/reject-ma — MA lehnt Manager-eingetragenen Urlaub/FZA ab
router.post('/:id/reject-ma', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  // Nur wenn: eigener Eintrag, von Manager eingetragen, noch pending
  if (absence.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  if (!absence.created_by || absence.created_by === absence.user_id) {
    return res.status(403).json({ error: 'Nur Manager-Einträge können abgelehnt werden' });
  }
  if (absence.status !== 'pending') {
    return res.status(400).json({ error: 'Nur pending Einträge können abgelehnt werden' });
  }

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  db.prepare(`
    UPDATE absences SET status = 'rejected', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} vom Mitarbeiter abgelehnt`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge — Chef quittiert Krank/Berufsschule/Innung
router.post('/:id/acknowledge', authenticate, (req, res) => {
  if (!canManageAbsences(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  db.prepare(`
    UPDATE absences SET notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), processed_by = ?,
      processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge-ma — MA quittiert/akzeptiert Manager-Änderung
router.post('/:id/acknowledge-ma', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });
  if (absence.user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  if (absence.proposed_date_from) {
    // MA akzeptiert Vorschlag → proposed Daten übernehmen, Status approved
    db.prepare(`
      UPDATE absences SET date_from = proposed_date_from, date_to = proposed_date_to,
        proposed_date_from = NULL, proposed_date_to = NULL,
        status = 'approved', ma_needs_ack = 0, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(absence.id);
  } else {
    // Krank/BS/Innung quittieren — nur ma_needs_ack löschen
    db.prepare(`
      UPDATE absences SET ma_needs_ack = 0, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(absence.id);
  }

  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to} quittiert`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// POST /api/absences/:id/reject-manager-edit — MA lehnt Manager-Vorschlag ab
router.post('/:id/reject-manager-edit', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });
  if (absence.user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (!absence.ma_needs_ack) return res.status(400).json({ error: 'Keine ausstehende Manager-Änderung' });

  if (!absence.proposed_date_from) {
    return res.status(400).json({ error: 'Kein Manager-Vorschlag vorhanden — nur Quittieren möglich' });
  }

  const sperre = sperreFuerAbwesenheit(db, absence, req);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  // Vorschlag abgelehnt: alte Daten (date_from/to) bleiben, proposed gelöscht
  // Status → pending damit Chef erneut entscheidet; created_by = user_id für Badge
  db.prepare(`
    UPDATE absences SET proposed_date_from = NULL, proposed_date_to = NULL,
      status = 'pending', ma_needs_ack = 0,
      created_by = user_id, processed_by = NULL, processed_at = NULL,
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(absence.id);

  protokolliereEingriff(db, req, sperre, `Abwesenheit ${absence.type} ${absence.date_from}–${absence.date_to}: Manager-Vorschlag abgelehnt`);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
// Fuer Tests
module.exports.sameTierConflict = sameTierConflict;
module.exports.conflictGroup = conflictGroup;
