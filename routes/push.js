const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const push = require('../push');

const router = express.Router();

const CATEGORIES = ['orders', 'bulletin', 'notes', 'absences'];

// Oeffentlicher VAPID-Key, den der Browser zum Abonnieren braucht. 503 wenn Push aus ist.
router.get('/key', authenticate, (req, res) => {
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push nicht konfiguriert' });
  res.json({ key });
});

// Geraete-Abo speichern (oder bei gleichem endpoint aktualisieren / auf diesen Nutzer umhaengen).
router.post('/subscribe', authenticate, (req, res) => {
  const sub = req.body && req.body.subscription ? req.body.subscription : req.body;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Ungueltiges Abo' });
  }
  const db = getDb();
  const ua = (req.get('user-agent') || '').slice(0, 255);
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`
  ).run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua);
  res.json({ success: true });
});

// Abo entfernen (Gerät abmelden).
router.post('/unsubscribe', authenticate, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint fehlt' });
  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ success: true });
});

// Kategorie-Schalter des Nutzers lesen (fehlende Zeile = alles an).
router.get('/prefs', authenticate, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT orders, bulletin, notes, absences FROM push_prefs WHERE user_id = ?').get(req.user.id);
  const out = {};
  for (const c of CATEGORIES) out[c] = row ? (row[c] === 1 || row[c] == null) : true;
  res.json(out);
});

// Kategorie-Schalter setzen (nur die mitgesendeten Kategorien aendern).
router.put('/prefs', authenticate, (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const cur = db.prepare('SELECT orders, bulletin, notes, absences FROM push_prefs WHERE user_id = ?').get(req.user.id) || {};
  const val = (c) => {
    if (c in body) return body[c] ? 1 : 0;
    return cur[c] != null ? cur[c] : 1;
  };
  db.prepare(
    `INSERT INTO push_prefs (user_id, orders, bulletin, notes, absences)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET orders = excluded.orders,
       bulletin = excluded.bulletin, notes = excluded.notes, absences = excluded.absences`
  ).run(req.user.id, val('orders'), val('bulletin'), val('notes'), val('absences'));
  const out = {};
  for (const c of CATEGORIES) out[c] = val(c) === 1;
  res.json(out);
});

// Test-Benachrichtigung an die eigenen Geraete (ignoriert die Kategorie-Schalter bewusst nicht —
// nutzt eine eigene Kategorie, die immer als „an" gilt, da keine push_prefs-Spalte existiert).
router.post('/test', authenticate, async (req, res) => {
  if (!push.isEnabled()) return res.status(503).json({ error: 'Push nicht konfiguriert' });
  const db = getDb();
  const has = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id).n;
  if (!has) return res.status(400).json({ error: 'Kein Geraet abonniert' });
  await push.notifyUsers(db, [req.user.id], null, {
    title: 'Test-Benachrichtigung',
    body: 'Push funktioniert auf diesem Geraet. 🎉',
    url: '/',
  }, null);
  res.json({ success: true });
});

// ===== Geplante Zusammenfassungen (Digest-Push) =====
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_MAX = 40;
const scheduleOut = (r) => ({
  id: r.id,
  name: r.name || '',
  weekdays: String(r.weekdays || '').split(',').filter(Boolean).map(Number),
  time: r.time,
  cats: String(r.cats || '').split(',').filter(Boolean),
  paused: r.paused === 1,
});
// Eingabe validieren/normalisieren. orders nur für Chef/Admin. Gibt {error} oder {name,weekdays,time,cats}.
function normalizeSchedule(body, role) {
  const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, NAME_MAX);
  const days = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number).filter(n => n >= 1 && n <= 7))].sort((a, b) => a - b);
  const time = (typeof body.time === 'string' && TIME_RE.test(body.time)) ? body.time : null;
  const canOrders = role === 'chef' || role === 'admin';
  const cats = [...new Set((Array.isArray(body.cats) ? body.cats : []).filter(c => CATEGORIES.includes(c)))]
    .filter(c => c !== 'orders' || canOrders);
  if (!days.length) return { error: 'Mindestens ein Wochentag erforderlich' };
  if (!time) return { error: 'Ungültige Uhrzeit (erwartet HH:MM)' };
  if (!cats.length) return { error: 'Mindestens eine Kategorie erforderlich' };
  return { name, weekdays: days.join(','), time, cats: cats.join(',') };
}

// Eigene Pläne + Global-Pause-Status
router.get('/summaries', authenticate, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM summary_schedules WHERE user_id = ? ORDER BY time, id').all(req.user.id);
  const pref = db.prepare('SELECT summaries_paused FROM push_prefs WHERE user_id = ?').get(req.user.id);
  res.json({ schedules: rows.map(scheduleOut), pausedAll: !!(pref && pref.summaries_paused === 1) });
});

// Neuen Plan anlegen
router.post('/summaries', authenticate, (req, res) => {
  const norm = normalizeSchedule(req.body || {}, req.user.role);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const db = getDb();
  const r = db.prepare(
    'INSERT INTO summary_schedules (user_id, name, weekdays, time, cats, paused) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(req.user.id, norm.name, norm.weekdays, norm.time, norm.cats);
  const row = db.prepare('SELECT * FROM summary_schedules WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ schedule: scheduleOut(row) });
});

// Global-Pause (Urlaub) — MUSS vor '/summaries/:id' stehen.
router.put('/summaries/pause-all', authenticate, (req, res) => {
  const db = getDb();
  const paused = req.body && req.body.paused ? 1 : 0;
  db.prepare(
    `INSERT INTO push_prefs (user_id, summaries_paused) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET summaries_paused = excluded.summaries_paused`
  ).run(req.user.id, paused);
  res.json({ pausedAll: paused === 1 });
});

// Plan bearbeiten (Felder und/oder Einzel-Pause) — nur eigene
router.put('/summaries/:id', authenticate, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM summary_schedules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Plan nicht gefunden' });
  const body = req.body || {};
  // Feld-Änderung (Wochentage/Zeit/Kategorien) nur, wenn mindestens eines mitgeschickt wird.
  if (body.name !== undefined || body.weekdays !== undefined || body.time !== undefined || body.cats !== undefined) {
    const cur = scheduleOut(row);
    const norm = normalizeSchedule({ name: body.name ?? cur.name, weekdays: body.weekdays ?? cur.weekdays, time: body.time ?? row.time, cats: body.cats ?? cur.cats }, req.user.role);
    if (norm.error) return res.status(400).json({ error: norm.error });
    db.prepare('UPDATE summary_schedules SET name = ?, weekdays = ?, time = ?, cats = ? WHERE id = ?').run(norm.name, norm.weekdays, norm.time, norm.cats, row.id);
  }
  if (body.paused !== undefined) {
    db.prepare('UPDATE summary_schedules SET paused = ? WHERE id = ?').run(body.paused ? 1 : 0, row.id);
  }
  const updated = db.prepare('SELECT * FROM summary_schedules WHERE id = ?').get(row.id);
  res.json({ schedule: scheduleOut(updated) });
});

// Plan löschen — nur eigene
router.delete('/summaries/:id', authenticate, (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM summary_schedules WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Plan nicht gefunden' });
  res.json({ success: true });
});

module.exports = router;
