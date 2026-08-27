// Das Bestellrecht, geklickt statt aufgerufen (Alex, 25.08.2026).
//
// Über die Schnittstelle stimmt es schon (tests/bestellrecht.js). Hier geht es um das, was bei
// diesem Projekt wiederholt danebenging: dass in der Oberfläche der Knopf fehlt, obwohl der
// Server längst erlaubt — oder umgekehrt einer dasteht, der nichts tut.
//
// Besonders geprüft wird die Sichtbarkeit des Kästchens: Für den Buchhalter gehört es
// ausgeblendet (er darf per Rolle), seine Planungs- und Brett-Rechte aber NICHT — die beiden
// Blöcke folgen deshalb verschiedenen Regeln, und genau da ist ein Fehler leicht zu machen.
//
//   node tests/bestellrecht-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3289, DB = '/tmp/bestellrecht-ui.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/bestellrecht-ui-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  await seite.setViewport({ width: 1100, height: 950 });
  seite.setDefaultTimeout(30000);
  await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await sleep(2500);
  return { ktx, seite };
}
const sichtbar = (seite, wahl) => seite.evaluate(w => {
  const el = document.querySelector(w);
  return !!el && el.checkVisibility();
}, wahl);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;

    const PW = 'Vorarbeit3r!';
    const vor = (await req('POST', '/api/users', admin, { username: 'vorarbeiter', password: PW, name: 'Volker Vorarbeiter', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    ok('Vorarbeiter angelegt', !!vor && vor.can_order === 0, JSON.stringify(vor && vor.can_order));
    const kollege = (await req('POST', '/api/users', admin, { username: 'kollege', password: PW, name: 'Kai Kollege', role: 'mitarbeiter', target_hours_per_week: 40 })).body.token || true;
    const kollegeTok = (await req('POST', '/api/auth/login', null, { username: 'kollege', password: PW })).body.token;
    await req('POST', '/api/orders', kollegeTok, { product: 'Kabeltrommel 50m', quantity: 2 });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];

    console.log('── Ohne Recht: kein Knopf ──');
    let v = await anmelden(browser, 'vorarbeiter', PW);
    v.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await v.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('die Bestellung ist sichtbar', /Kabeltrommel/.test(await v.seite.evaluate(() => document.body.innerText)));
    ok('… aber kein „Bestellt"-Knopf', await v.seite.evaluate(() => !document.querySelector('.order-mark-btn')));

    console.log('\n── Der Admin vergibt das Recht ──');
    const a = await anmelden(browser, 'admin', pwAdmin);
    a.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await a.seite.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' });
    await a.seite.waitForSelector('.edit-user'); await sleep(800);
    await a.seite.evaluate((id) => {
      document.querySelector(`.edit-user[data-id="${id}"]`).click();
    }, vor.id);
    await a.seite.waitForSelector('#um-can-order'); await sleep(600);
    ok('das Kästchen „Bestellungen abschließen" ist da', await sichtbar(a.seite, '#um-can-order'));
    ok('… und noch nicht gesetzt', await a.seite.evaluate(() => !document.getElementById('um-can-order').checked));
    ok('… der erklärende Satz steht daneben',
      /Bestellt.*setzen/s.test(await a.seite.evaluate(() => document.getElementById('um-order-group').innerText)),
      await a.seite.evaluate(() => document.getElementById('um-order-group').innerText.slice(0, 100)));

    console.log('\n── Sichtbarkeit je Rolle ──');
    // Der Kern der Sache: Fuer den Buchhalter verschwindet NUR das Bestellrecht, seine
    // Planungs- und Brett-Rechte bleiben stehen. Fuer den Chef verschwindet beides.
    await a.seite.select('#um-role', 'buchhalter'); await sleep(400);
    ok('Buchhalter: Bestell-Kästchen verborgen', !(await sichtbar(a.seite, '#um-can-order')));
    ok('Buchhalter: Planungsrecht bleibt sichtbar', await sichtbar(a.seite, '#um-can-plan'));
    ok('Buchhalter: Hinweis erscheint', await sichtbar(a.seite, '#um-order-role-hint'));
    await a.seite.select('#um-role', 'chef'); await sleep(400);
    ok('Chef: beides verborgen',
      !(await sichtbar(a.seite, '#um-can-order')) && !(await sichtbar(a.seite, '#um-can-plan')));
    await a.seite.select('#um-role', 'mitarbeiter'); await sleep(400);
    ok('Mitarbeiter: beides wieder da',
      (await sichtbar(a.seite, '#um-can-order')) && (await sichtbar(a.seite, '#um-can-plan')));

    console.log('\n── Speichern ──');
    await a.seite.click('#um-can-order');
    await a.seite.evaluate(() => document.querySelector('#um-can-order').closest('form').querySelector('button[type="submit"]').click());
    await sleep(2000);
    const gespeichert = (await req('GET', '/api/users', admin)).body.users.find(u => u.id === vor.id);
    ok('das Recht steht in der Datenbank', gespeichert && gespeichert.can_order === 1, JSON.stringify(gespeichert && gespeichert.can_order));

    console.log('\n── Mit Recht: der Knopf wirkt ──');
    await v.seite.close(); await v.ktx.close();
    v = await anmelden(browser, 'vorarbeiter', PW);
    v.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await v.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('jetzt ist der „Bestellt"-Knopf da', await v.seite.evaluate(() => !!document.querySelector('.order-mark-btn')));
    await v.seite.click('.order-mark-btn');
    await sleep(2000);
    const db = (await req('GET', '/api/orders/ordered', admin)).body.orders;
    ok('… und der Klick hat wirklich gebucht', db.length === 1 && /Kabeltrommel/.test(db[0].product), JSON.stringify(db.map(o => o.product)));
    ok('… mit dem Vorarbeiter als Besteller', db[0].ordered_by_name === 'Volker Vorarbeiter', db[0].ordered_by_name);
    ok('… und die offene Liste ist leer', ((await req('GET', '/api/orders', admin)).body.orders || []).length === 0);

    console.log('\n── Der Zähler im Menü folgt dem Recht ──');
    // Alex am 27.08.2026 mit Bildschirmfoto: „das mit dem zaehl coin scheint bei den berechtigten
    // noch nicht zu funktionieren." Der Server rechnete den Zaehler laengst nach dem Recht, aber
    // die Menuezeile fragte weiter `role === 'chef' || role === 'admin'` — die Marke wurde also nie
    // GEZEICHNET, und refreshBadges() ueberspringt, was es nicht findet (`if (!el) continue`).
    // Fuer den Berechtigten hiess das: Das App-Symbol zaehlte mit, im Menue stand nichts.
    await req('POST', '/api/orders', kollegeTok, { product: 'Klemmen', quantity: 5 });
    await v.seite.goto(BASIS + '/#/dashboard', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('die Marke ist im Menü überhaupt vorhanden',
      await v.seite.evaluate(() => !!document.getElementById('nav-badge-orders')),
      'ohne das Element aktualisiert refreshBadges() nichts');
    ok('… und sie ist sichtbar', await sichtbar(v.seite, '#nav-badge-orders'));
    ok('… und zeigt die eine offene Bestellung',
      (await v.seite.evaluate(() => (document.getElementById('nav-badge-orders') || {}).textContent)) === '1',
      await v.seite.evaluate(() => (document.getElementById('nav-badge-orders') || {}).textContent));

    console.log('\n── Die Kategorie „Bestellungen" folgt dem Recht ──');
    // NICHT den Seitentext durchsuchen: „Bestellungen" steht als Menuepunkt auf JEDER Seite, die
    // Pruefung waere immer gruen (erst so gebaut, dann gemerkt). Gemessen wird die Funktion, die
    // wirklich entscheidet, welche Schalter und Digest-Kategorien angeboten werden.
    await v.seite.goto(BASIS + '/#/notifications', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('darfBestellen() sagt ja', await v.seite.evaluate(() => darfBestellen()));
    ok('… und „orders" wird als Kategorie angeboten',
      (await v.seite.evaluate(() => summaryCatOptions().map(c => c.key))).includes('orders'),
      JSON.stringify(await v.seite.evaluate(() => summaryCatOptions().map(c => c.key))));

    console.log('\n── Entzug ──');
    await req('PUT', `/api/users/${vor.id}`, admin, { can_order: false });
    await v.seite.close(); await v.ktx.close();
    v = await anmelden(browser, 'vorarbeiter', PW);
    v.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await req('POST', '/api/orders', kollegeTok, { product: 'Dosen', quantity: 10 });
    await v.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('der Knopf ist wieder weg', await v.seite.evaluate(() => !document.querySelector('.order-mark-btn')));
    // Es liegen jetzt zwei offene Bestellungen („Klemmen", „Dosen") — die Marke darf trotzdem weg
    // sein. Ohne offene Bestellung waere die Zusicherung wertlos, weil sie auch bei kaputtem
    // Recht gruen waere.
    ok('… und die Marke im Menü ist es auch',
      !(await v.seite.evaluate(() => !!document.getElementById('nav-badge-orders'))),
      'offen: ' + JSON.stringify(((await req('GET', '/api/orders', admin)).body.orders || []).map(o => o.product)));
    await v.seite.goto(BASIS + '/#/notifications', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('darfBestellen() sagt nein', await v.seite.evaluate(() => darfBestellen() === false));
    ok('… und „orders" wird nicht mehr angeboten',
      !(await v.seite.evaluate(() => summaryCatOptions().map(c => c.key))).includes('orders'),
      JSON.stringify(await v.seite.evaluate(() => summaryCatOptions().map(c => c.key))));

    ok('keine JavaScript-Fehler auf allen besuchten Seiten', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
  }
  console.log(`\nBestellrecht (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
