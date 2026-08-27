// Ein Klick auf die Meldung muss in dem Menue landen, aus dem sie kam (Alex, 27.08.2026).
//
// Alex nach dem Deploy: „Wenn ich auf die Bestellung notification klicke, wuerde ich erwarten in
// der app direkt in das ‚Bestellungen' Menue weitergeleitet zu werden. Das hat aber in diesem Fall
// nicht funktioniert."
//
// Dabei kam zweierlei heraus, und nur das Erste war der Grund fuer sein Beispiel:
//
//  1. Der Service Worker rief `client.navigate()` und danach SOFORT `focus()`, ohne die Navigation
//     abzuwarten. `navigate()` gibt ein Versprechen zurueck, das bei einem reinen Fragmentwechsel
//     oder einem nicht kontrollierten Fenster still abgelehnt wird — ein `try/catch` sieht das
//     nicht, weil die Ablehnung asynchron kommt. Die App kam nach vorn und blieb stehen.
//
//  2. Die PLANUNGS-Erinnerung zeigte auf `/planning` statt `/#/planning`. In einer Hash-Anwendung
//     gibt es diese Adresse nicht; der Server liefert dafuer nur die Startseite aus. Diese
//     Erinnerung hat also NIE beim Termin gelandet, seit es sie gibt.
//
// Punkt 2 ist der Grund fuer diesen Test: Ein falsches Ziel faellt beim Benutzen kaum auf — man
// landet ja irgendwo, nur nicht dort, wo man hinwollte. Geprueft wird deshalb JEDE Meldung, die
// die App verschickt, gegen die Routen, die es wirklich gibt.
//
// In-Process mit eigenem Port (listen(0)), damit der Test neben einer laufenden Suite arbeiten kann.
//
//   node tests/meldung-ziel.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');

// web-push mocken, BEVOR push.js geladen wird.
const webpush = require('web-push');
let SENT = [];
webpush.sendNotification = (sub, payload) => {
  SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return Promise.resolve({ statusCode: 201 });
};

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/meldung-ziel.db';
process.env.VAPID_PUBLIC = 'BPVS3ECi9gwO7lzmfRVhSOEYjVEgraSHuI3NY99sjRv099IUssBZTdHoHvkQnJet0QUv07n_LSWJhbdRZ60Pc0A';
process.env.VAPID_PRIVATE = 'Gw_Gj7P4o-b5uAXuE8bT00TMWvby6V20t2fDguxf-8o';
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// Die Routen, die der Verteiler in public/js wirklich kennt. Wird hier eine Adresse geprueft, die
// es nicht gibt, landet der Nutzer auf der Startseite — genau der Fehler, um den es geht.
const ECHTE_ROUTEN = ['/welcome', '/dashboard', '/orders', '/bulletin', '/notes', '/absences',
                      '/planning', '/projects', '/statistics', '/documents', '/tools', '/konto',
                      '/users', '/settings', '/audit', '/pdf'];

function zielPruefen(was, url) {
  if (url === '/') { ok(`${was}: Ziel „/" (Startseite, kein eigenes Menü)`, true); return; }
  const raute = url.indexOf('#');
  if (raute < 0) {
    ok(`${was}: Ziel enthält die Raute`, false,
       `„${url}" — in einer Hash-App liefert das nur die Startseite aus`);
    return;
  }
  const route = url.slice(raute + 1);
  ok(`${was}: Ziel „${url}" ist eine echte Route`, ECHTE_ROUTEN.includes(route),
     `„${route}" steht in keinem Verteiler`);
}

function req(server, method, p, token, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
                 ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let s = ''; res.on('data', c => s += c); res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (_) {}
        resolve({ status: res.statusCode, body: j, text: s }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  await initDatabase();
  const db = getDb();
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync('pw123456', 10));

  const ids = {};
  for (const u of ['admin', 'chef', 'buchhalter', 'max']) {
    ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  }
  for (const [uname, uid] of Object.entries(ids)) {
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'k')").run(uid, 'sub://' + uname);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/orders', require('../routes/orders'));
  app.use('/api/bulletin', require('../routes/bulletin'));
  app.use('/api/absences', require('../routes/absences'));
  app.use('/api/notes', require('../routes/notes'));
  app.use('/api/push', require('../routes/push'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const tok = {};
  for (const u of Object.keys(ids)) {
    tok[u] = (await req(server, 'POST', '/api/auth/login', null, { username: u, password: 'pw123456' })).body.token;
  }
  const ausloesen = async (method, p, uname, body) => {
    SENT = [];
    const r = await req(server, method, p, tok[uname], body);
    await sleep(120);
    return r;
  };
  const ziele = () => [...new Set(SENT.map(s => s.payload.url))];

  try {
    console.log('── Jede Meldung nennt ihr Menü ──');

    let r = await ausloesen('POST', '/api/orders', 'max', { product: 'Kabeltrommel', quantity: 2 });
    ok('Bestellung angelegt', r.status === 201, r.status + ' ' + r.text.slice(0, 80));
    ok('… und sie hat überhaupt jemanden erreicht', SENT.length > 0, JSON.stringify(ziele()));
    for (const z of ziele()) zielPruefen('neue Bestellung', z);

    r = await ausloesen('POST', '/api/bulletin', 'admin', { title: 'Betriebsversammlung', content: 'Freitag 15 Uhr' });
    ok('Aushang angelegt', r.status === 201 || r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    for (const z of ziele()) zielPruefen('neuer Aushang', z);

    const heute = new Date().toLocaleDateString('sv-SE');
    r = await ausloesen('POST', '/api/absences', 'max', { type: 'urlaub', date_from: heute, date_to: heute });
    ok('Abwesenheit beantragt', r.status === 201 || r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    for (const z of ziele()) zielPruefen('Abwesenheits-Antrag', z);

    const notiz = (await req(server, 'POST', '/api/notes', tok.admin, { title: 'Übergabe', content: 'Schlüssel im Büro' })).body;
    const nid = notiz && (notiz.note ? notiz.note.id : notiz.id);
    r = await ausloesen('PUT', `/api/notes/${nid}/shares`, 'admin', { shares: [{ user_id: ids.max, can_edit: 0 }] });
    ok('Notiz freigegeben', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    for (const z of ziele()) zielPruefen('geteilte Notiz', z);

    r = await ausloesen('POST', '/api/push/test', 'max');
    ok('Testmeldung verschickt', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    for (const z of ziele()) zielPruefen('Testmeldung', z);

    console.log('\n── Die Planungs-Erinnerung (der eigentliche Fund) ──');
    // Sie laeuft nicht ueber eine Route, sondern ueber den Zeitplaner — deshalb direkt geprueft.
    // Genau hier stand '/planning' ohne Raute, und niemand hat es je gemerkt.
    const { buildReminderPush } = require('../scheduler');
    // entry_id null ist zulaessig: occurrenceRepEntry liefert dann nichts, und die Erinnerung
    // faellt auf „Termin" zurueck. Das Ziel haengt daran nicht — genau darum geht es hier.
    const erinnerung = buildReminderPush(db, { user_id: ids.max, entry_id: null, group_id: null }, 'x', '2026-08-28 07:00');
    zielPruefen('Planungs-Erinnerung', erinnerung.url);

    console.log('\n── Kein Ziel im Code darf die Raute vergessen ──');
    // Der Fangzaun: Die Prüfungen oben treffen nur, was der Test wirklich auslöst. Eine später
    // ergänzte Meldung mit falschem Ziel käme sonst ungeprüft durch.
    const quellen = ['routes/orders.js', 'routes/bulletin.js', 'routes/absences.js',
                     'routes/notes.js', 'routes/push.js', 'scheduler.js'];
    const schlechte = [];
    for (const datei of quellen) {
      const txt = fs.readFileSync(path.join(__dirname, '..', datei), 'utf8');
      for (const m of txt.matchAll(/\burl:\s*'([^']*)'/g)) {
        const u = m[1];
        if (u === '/' || u.startsWith('/#/')) continue;
        schlechte.push(`${datei}: „${u}"`);
      }
    }
    ok('alle Ziele im Quelltext sind „/" oder „/#/…"', schlechte.length === 0, schlechte.join(', '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    server.close();
  }
  console.log(`\nZiel der Meldungen: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
