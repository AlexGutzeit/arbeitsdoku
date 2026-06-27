// Web-Push-Versand. Reines Hilfsmodul (kein Express-Router) — wird an den Ereignis-Stellen
// (Bestellung, Aushang, Notiz, Abwesenheit) aufgerufen und sendet echte Handy-/Desktop-
// Benachrichtigungen an die betroffenen Nutzer. Ziel ist immer „wessen Zaehler/Coin steigt"
// (Logik analog routes/badges.js), nie der Ausloeser selbst.
//
// Fehlen die VAPID-Schluessel (.env), ist alles ein No-op — die App laeuft normal weiter,
// nur ohne Push. Der Versand ist „fire-and-forget": er darf den ausloesenden Request nicht
// verzoegern und Fehler eines Geraets duerfen die anderen nicht abbrechen.

const webpush = require('web-push');
const { iconBasePath } = require('./routes/branding');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

let enabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    enabled = true;
  } catch (e) {
    console.error('Web-Push deaktiviert — ungueltige VAPID-Konfiguration:', e.message);
  }
}

function isEnabled() {
  return enabled;
}

function getPublicKey() {
  return enabled ? VAPID_PUBLIC : null;
}

// Manager = Rollen, die Abwesenheitsantraege/Krankmeldungen bearbeiten (chef/admin/buchhalter).
// Nur aktive Nutzer. Optionaler Ausschluss (z. B. der Ausloeser).
function managerIds(db, excludeUserId) {
  try {
    const rows = db.prepare(
      "SELECT id FROM users WHERE role IN ('chef','admin','buchhalter') AND COALESCE(active,1) = 1"
    ).all();
    return rows.map(r => r.id).filter(id => id !== excludeUserId);
  } catch (e) {
    console.error('managerIds fehlgeschlagen:', e.message);
    return [];
  }
}

// category: 'orders' | 'bulletin' | 'notes' | 'absences' — entspricht den Spalten in push_prefs.
// payload: { title, body, url } — url ist die App-Route (Hash) fuer notificationclick.
// Sendet an alle Abos der Zielnutzer, die die Kategorie nicht abgeschaltet haben.
// Abgelaufene Abos (404/410) werden entfernt.
async function notifyUsers(db, userIds, category, payload, excludeUserId) {
  if (!enabled) return;
  try {
    const targets = [...new Set((userIds || []).filter(id => id != null && id !== excludeUserId))];
    if (targets.length === 0) return;

    // Kategorie-Schalter je Nutzer pruefen (fehlende Zeile = Standard „an").
    // Ohne Kategorie (z. B. Test-Push) wird nicht gefiltert. Nur erlaubte Spaltennamen zulassen.
    const VALID = ['orders', 'bulletin', 'notes', 'absences'];
    const allowed = (category && VALID.includes(category))
      ? targets.filter(uid => {
          const pref = db.prepare('SELECT ' + category + ' AS v FROM push_prefs WHERE user_id = ?').get(uid);
          return !pref || pref.v == null || pref.v === 1;
        })
      : targets;
    if (allowed.length === 0) return;

    const placeholders = allowed.map(() => '?').join(',');
    const subs = db.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`
    ).all(...allowed);
    if (subs.length === 0) return;

    // Branding-Icon (Logo des Kunden, falls hochgeladen) für die Benachrichtigung.
    let icon = '/icons/icon-192x192.png';
    try { icon = iconBasePath() + '/icon-192x192.png'; } catch (_) {}
    const body = JSON.stringify({
      title: payload.title || 'Arbeitsdoku',
      body: payload.body || '',
      url: payload.url || '/',
      icon: payload.icon || icon,
    });

    await Promise.all(subs.map(async (s) => {
      const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(subscription, body);
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          // Abo existiert auf dem Push-Dienst nicht mehr → aufraeumen.
          try { db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id); } catch (_) {}
        } else {
          console.error('Push-Versand fehlgeschlagen (Status ' + code + '):', err && err.message);
        }
      }
    }));
  } catch (e) {
    console.error('notifyUsers fehlgeschlagen:', e.message);
  }
}

module.exports = { isEnabled, getPublicKey, managerIds, notifyUsers };
