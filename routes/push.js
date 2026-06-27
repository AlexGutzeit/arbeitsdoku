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

module.exports = router;
