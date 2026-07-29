// Der Coin zeigte eine offene Bestellung an, obwohl die Liste leer war (Alex, 29.07.2026, Handy).
//
// Ursache: Die Zähler werden ausschliesslich per SSE GESENDET, nie geholt. Bricht die Verbindung ab
// — Handy im Standby, Funkloch, Tab im Hintergrund —, geht jede Änderung aus dieser Zeit verloren.
// Der Coin bleibt auf einem Stand stehen, den es nicht mehr gibt, bis jemand die Seite neu lädt.
// Das Öffnen der Bestellseite half nicht: die Liste wird geladen, der Zähler nicht.
//
// Geprüft werden beide Wege zurück in die Wirklichkeit:
//   1. Rückkehr zum Tab (visibilitychange) — der Fall aus dem Screenshot
//   2. Wiederaufbau der SSE-Verbindung (onopen)
//
//   node tests/badge-nachziehen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3212, DB = '/tmp/badge-nachziehen.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Wert des Bestell-Coins in der Seitenleiste, '' wenn er ausgeblendet ist.
const coin = page => page.evaluate(() => {
  const el = document.getElementById('nav-badge-orders');
  if (!el) return '(kein Element)';
  return el.style.display === 'none' ? '' : el.textContent;
});

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/badge-nachziehen-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/badge-nachziehen-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 950 });
    page.setDefaultTimeout(45000);

    // ── Fall 1: Rückkehr zum Tab, während die SSE-Verbindung tot ist ─────────────────────────
    // Der SSE-Kanal wird hart blockiert — das ist das Handy mit ausgeschaltetem Bildschirm.
    await page.setRequestInterception(true);
    let sseBlockiert = true;
    page.on('request', r => {
      if (sseBlockiert && /\/api\/events/.test(r.url())) return r.abort();
      r.continue();
    });

    const bestellung = await req('POST', '/api/orders', max.token, { product: 'Kabelbinder', quantity: 5, unit: 'Pack' });
    if (bestellung.status >= 300) throw new Error('Bestellung: ' + bestellung.text);

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'admin'); await page.type('#login-pass', pw('admin'));
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(1200);
    ok('Coin zeigt die offene Bestellung (1)', (await coin(page)) === '1', await coin(page));

    // Jemand anders erledigt sie — die Sitzung hier bekommt davon nichts mit.
    const id = (await req('GET', '/api/orders', admin.token)).body.orders[0].id;
    await req('POST', `/api/orders/${id}/order`, admin.token);
    await sleep(1500);
    ok('ohne Verbindung bleibt der Coin stehen (so entstand der Fehler)', (await coin(page)) === '1', await coin(page));

    // Der Nutzer geht auf die Bestellseite: Liste leer, Coin trotzdem 1 — genau Alex' Screenshot.
    await page.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' }); await sleep(1500);
    const listeLeer = await page.evaluate(() => !/Kabelbinder/.test(document.querySelector('.main').innerText));
    ok('Bestellliste ist leer', listeLeer);

    // Jetzt der Fall aus dem Screenshot: Tab wieder sichtbar.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(1800);
    ok('nach Rückkehr zum Tab ist der Coin weg', (await coin(page)) === '', `Coin zeigt „${await coin(page)}"`);

    // ── Fall 2: die SSE-Verbindung kommt zurück ──────────────────────────────────────────────
    const zweite = await req('POST', '/api/orders', max.token, { product: 'Wago-Klemmen', quantity: 2, unit: 'Beutel' });
    if (zweite.status >= 300) throw new Error('zweite Bestellung: ' + zweite.text);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(1500);
    ok('neue Bestellung erscheint als Coin (1)', (await coin(page)) === '1', await coin(page));

    const id2 = (await req('GET', '/api/orders', admin.token)).body.orders[0].id;
    await req('POST', `/api/orders/${id2}/order`, admin.token);
    await sleep(800);
    ok('noch getrennt → Coin steht weiterhin auf 1', (await coin(page)) === '1', await coin(page));

    sseBlockiert = false;                       // „Funkloch verlassen"
    await page.evaluate(() => { if (window.S && S.sse) { try { S.sse.close(); } catch (_) {} S.sse = null; } connectSSE(); });
    await sleep(2500);
    ok('nach Wiederaufbau der Verbindung ist der Coin weg', (await coin(page)) === '', `Coin zeigt „${await coin(page)}"`);
    // Statt `readyState` abzufragen (der Wert wechselt beim Wiederverbinden mehrfach und sagt allein
    // nichts) wird geprüft, was zählt: Kommt jetzt wieder LIVE etwas an? Dazu eine dritte Bestellung
    // anlegen — ohne Tab-Wechsel, ohne Neuladen.
    await req('POST', '/api/orders', max.token, { product: 'Isolierband', quantity: 3, unit: 'Rollen' });
    let live = '';
    for (let i = 0; i < 20 && live !== '1'; i++) { await sleep(500); live = await coin(page); }
    ok('… und der Kanal überträgt wieder live (dritte Bestellung erscheint von selbst)', live === '1', `Coin zeigt „${live}"`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nZähler nachziehen: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
