// „Bestellt" mit Rückweg, bestellte Einträge gesperrt (R12, 25.09.2026).
//
// Vorher war ein Tipp auf „Bestellt" endgültig: kein Zurücknehmen, löschen nur als Admin — ein Chef
// oder wer das Bestellrecht hat, saß nach einem Fehltipp fest. Und der Server ließ bestellte
// Einträge noch ändern (die Oberfläche bot es nicht an): In der Liste stand dann etwas anderes, als
// bestellt worden war.
//
// Jetzt (Entscheidung Alex): keine Rückfrage vor „Bestellt", dafür „Rückgängig" in der Meldung und
// dauerhaft „Doch nicht bestellt" für alle mit Bestellrecht; bestellte Einträge sind für ALLE
// gesperrt — erst zurücknehmen, dann ändern.
//
//   node tests/bestellt-rueckweg.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3330, DB = '/tmp/bestellt-rueckweg.db', LOG = '/tmp/bestellt-rueckweg.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const token = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body.token;
    const admin = await token('admin'), chef = await token('chef'), max = await token('max');
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;
    const offen = async () => (await req('GET', '/api/orders', chef)).body.orders.map(o => o.id);
    const bestellt = async () => (await req('GET', '/api/orders/ordered', chef)).body.orders.map(o => o.id);
    const anlegen = async (produkt) => (await req('POST', '/api/orders', max, { product: produkt, quantity: 50, unit: 'm' })).body.order;

    console.log('\nServer: Sperre und Rückweg');
    const o1 = await anlegen('Kabel NYM 3x1,5');
    const o2 = await anlegen('Abzweigdosen');
    ok('zwei offene Positionen angelegt', !!o1 && !!o2);
    ok('Chef markiert als bestellt', (await req('POST', `/api/orders/${o1.id}/order`, chef)).status === 200);

    const aendernMa = await req('PUT', `/api/orders/${o1.id}`, max, { product: 'Kabel NYM 3x2,5', quantity: 60 });
    ok('bestellte Position: Mitarbeiter kann sie nicht mehr ändern (409)', aendernMa.status === 409, aendernMa.status + ' ' + aendernMa.text);
    ok('… und die Meldung nennt den Weg („Doch nicht bestellt")', /Doch nicht bestellt/.test((aendernMa.body || {}).error || ''), (aendernMa.body || {}).error);
    ok('… auch der Chef nicht (gesperrt für alle)', (await req('PUT', `/api/orders/${o1.id}`, chef, { product: 'Kabel NYM 3x2,5' })).status === 409);
    const nachher = (await req('GET', '/api/orders/ordered', chef)).body.orders.find(o => o.id === o1.id);
    ok('die bestellte Position ist unverändert', nachher && nachher.product === 'Kabel NYM 3x1,5' && nachher.quantity === 50, JSON.stringify(nachher));

    ok('Mitarbeiter ohne Bestellrecht darf nicht zurücknehmen (403)', (await req('DELETE', `/api/orders/${o1.id}/order`, max)).status === 403);
    const nichtBestellt = await req('DELETE', `/api/orders/${o2.id}/order`, chef);
    ok('Zurücknehmen einer offenen Position: verständlich abgewiesen (400)', nichtBestellt.status === 400 && /gar nicht als bestellt/.test((nichtBestellt.body || {}).error || ''), nichtBestellt.text);

    ok('Chef nimmt zurück („Doch nicht bestellt")', (await req('DELETE', `/api/orders/${o1.id}/order`, chef)).status === 200);
    ok('Position wieder in der offenen Liste, nicht mehr unter „bestellt"', (await offen()).includes(o1.id) && !(await bestellt()).includes(o1.id));
    const wieder = (await req('GET', '/api/orders', chef)).body.orders.find(o => o.id === o1.id);
    ok('… ohne Bestellmarke (ordered_at, ordered_by leer)', wieder && wieder.ordered_at === null && wieder.ordered_by === null, JSON.stringify(wieder));
    ok('… und lässt sich wieder ändern', (await req('PUT', `/api/orders/${o1.id}`, max, { product: 'Kabel NYM 3x2,5', quantity: 60 })).status === 200);

    // Das Einzelrecht zählt wie die Rolle: wer markieren darf, darf auch zurücknehmen.
    ok('Admin gibt Max das Bestellrecht', (await req('PUT', `/api/users/${maxId}`, admin, { can_order: 1 })).status === 200);
    await req('POST', `/api/orders/${o1.id}/order`, chef);
    ok('mit Bestellrecht: Max darf zurücknehmen', (await req('DELETE', `/api/orders/${o1.id}/order`, max)).status === 200);
    await req('PUT', `/api/users/${maxId}`, admin, { can_order: 0 });

    // ── Oberfläche ──
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1000, height: 900 });
    seite.setDefaultTimeout(20000);
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));
    const anmelden = async (n) => {
      await seite.goto(BASIS + '/?a=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
      await seite.evaluate(() => { try { localStorage.clear(); } catch (_) {} });
      await seite.goto(BASIS + '/?b=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
      await seite.waitForSelector('#login-user');
      await seite.type('#login-user', n); await seite.type('#login-pass', pw(n));
      await seite.click('#login-form button[type="submit"]');
      await seite.waitForFunction(() => document.querySelector('.main')); await sleep(600);
    };
    const zuDenBestellungen = async () => {
      await seite.evaluate(() => { location.hash = '/welcome'; }); await sleep(300);
      await seite.evaluate(() => { location.hash = '/orders'; });
      await seite.waitForSelector('#order-list'); await sleep(500);
    };

    console.log('\nOberfläche: „Rückgängig" in der Meldung');
    await anmelden('chef');
    await zuDenBestellungen();
    await seite.click(`.order-mark-btn[data-id="${o2.id}"]`);
    const knopfDa = await seite.waitForFunction(() => {
      const t = document.querySelector('.toast.show');
      return t && /bestellt/i.test(t.textContent) && t.querySelector('.toast-aktion');
    }, { timeout: 5000 }).then(() => true, () => false);
    ok('nach „Bestellt": Meldung mit Knopf „Rückgängig"', knopfDa);
    ok('keine Rückfrage vor „Bestellt" (kein Dialog)', !(await seite.$('.modal-overlay, .modal')));
    ok('Position ist wirklich bestellt', (await bestellt()).includes(o2.id));
    await sleep(500);   // die Meldung faehrt 0,3 s lang ein — vorher liegt der Knopf noch unter dem Rand
    await seite.click('.toast .toast-aktion');
    const zurueck = await seite.waitForFunction((id) => !!document.querySelector(`.order-mark-btn[data-id="${id}"]`), { timeout: 5000 }, o2.id).then(() => true, () => false);
    ok('„Rückgängig" → Position wieder offen, in der Liste und auf dem Server', zurueck && (await offen()).includes(o2.id) && !(await bestellt()).includes(o2.id));

    console.log('\nOberfläche: „Doch nicht bestellt" in den letzten Bestellungen');
    await seite.click(`.order-mark-btn[data-id="${o2.id}"]`);
    await seite.waitForFunction((id) => !document.querySelector(`.order-mark-btn[data-id="${id}"]`), { timeout: 5000 }, o2.id);
    await sleep(400);
    await seite.click('#toggle-ordered');
    const undoKnopf = await seite.waitForSelector(`.ordered-undo-btn[data-id="${o2.id}"]`, { timeout: 5000 }).then(() => true, () => false);
    ok('bestellte Position hat den Knopf „Doch nicht bestellt"', undoKnopf);
    if (undoKnopf) await seite.click(`.ordered-undo-btn[data-id="${o2.id}"]`);
    const wiederOffen = await seite.waitForFunction((id) => !!document.querySelector(`.order-mark-btn[data-id="${id}"]`), { timeout: 5000 }, o2.id).then(() => true, () => false);
    ok('→ wieder offen', wiederOffen && (await offen()).includes(o2.id));

    // Eine ausgeblendete Meldung ist nur durchsichtig — sie darf weder Klicks abfangen, noch darf
    // ihr Knopf unsichtbar anklickbar bleiben.
    await seite.click(`.order-mark-btn[data-id="${o2.id}"]`);
    await seite.waitForFunction(() => document.querySelector('.toast.show .toast-aktion'), { timeout: 5000 });
    await seite.evaluate(() => { const t = document.querySelector('.toast'); clearTimeout(t._hideTimer); t.classList.remove('show'); });
    await sleep(400);
    ok('ausgeblendete Meldung fängt keine Klicks ab', await seite.evaluate(() => getComputedStyle(document.querySelector('.toast')).pointerEvents === 'none'));
    await req('DELETE', `/api/orders/${o2.id}/order`, chef);

    console.log('\nOberfläche: ohne Bestellrecht kein Rückweg-Knopf');
    await req('POST', `/api/orders/${o1.id}/order`, chef);
    await anmelden('max');
    await zuDenBestellungen();
    const toggle = await seite.$('#toggle-ordered');
    if (toggle) { await toggle.click(); await sleep(800); }
    ok('Mitarbeiter ohne Bestellrecht sieht „Doch nicht bestellt" nicht',
      !(await seite.$('.ordered-undo-btn')), toggle ? '' : 'keine Liste der letzten Bestellungen');
    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nBestellt mit Rückweg: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
