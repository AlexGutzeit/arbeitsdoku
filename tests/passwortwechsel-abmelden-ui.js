// Passwort im Browser gewechselt — DIESES Gerät bleibt drin, das andere fliegt hinaus.
//
// Seit dem 10.11.2026 beendet ein Passwortwechsel alle Anmeldungen des Kontos, auch die eigene;
// der Server legt dafür ein frisches Token in die Antwort (API-Seite: tests/sitzung-widerruf.js).
// Die Oberfläche MUSS es übernehmen. Vergisst sie das, wirft der Wechsel den hinaus, der ihn
// gerade vorgenommen hat — beim nächsten Klick, nicht sofort, also genau dann, wenn kein Test
// mehr hinsieht.
//
// Zwei Wege führen dorthin, beide werden geklickt:
//   * „Mein Konto" → Passwort ändern
//   * Mitarbeiter-Dialog → Passwort zurücksetzen, angewandt auf das EIGENE Konto
//
// Der Herzschlag der Live-Kanäle läuft hier schnell (0,4 s statt 30 s): Der eigene Kanal hängt
// noch an der alten Anmeldung, wird vom Server geschlossen und muss sich mit dem frischen Token
// still neu verbinden. Ginge das schief, stünde man kurz nach dem Wechsel in der Anmeldemaske.
//
//   node tests/passwortwechsel-abmelden-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const CHROME = require('./hilfen/chrome');
const PORT = 3396, DB = '/tmp/passwortwechsel-abmelden.db', LOG = '/tmp/passwortwechsel-abmelden-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Fragt MIT dem Token, das die Seite gerade wirklich benutzt — nicht mit einem aus dem Test.
const kommtDurch = (page) => page.evaluate(async () =>
  (await fetch('/api/entries', { headers: { Authorization: 'Bearer ' + S.token } })).status);
const tokenIn = (page) => page.evaluate(() => ({ speicher: localStorage.getItem('token'), laufend: S.token }));
const kanalOffen = (page) => page.evaluate(() => !!S.sse && S.sse.readyState === 1);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang', SSE_PULS_MS: '400' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const seite = async (kontext, breite) => {
      const p = await (kontext || browser).newPage(); await p.setViewport({ width: breite, height: 950 });
      p.setDefaultTimeout(30000);
      p.on('pageerror', e => fehler.push(String(e && e.message || e)));
      return p;
    };
    const anmelden = async (page, name, passwort) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', name); await page.type('#login-pass', passwort);
      await page.click('#login-form button[type="submit"]');
      await sleep(2400);
    };

    // „Rechner" = der Standard-Kontext. „Handy" = eigener Kontext, also eigener Speicher.
    const rechner = await seite(null, 520);
    await anmelden(rechner, 'max', pw('max'));
    const handyKontext = await browser.createBrowserContext();
    const handy = await seite(handyKontext, 420);
    await anmelden(handy, 'max', pw('max'));
    // Ein zweiter Tab am Rechner, der SCHON OFFEN IST, wenn gewechselt wird.
    const zweiterTab = await seite(null, 520);
    await zweiterTab.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2500);

    console.log('── Ausgangslage: beide Geräte sind drin ──');
    ok('Rechner kommt durch', (await kommtDurch(rechner)) === 200);
    ok('Handy kommt durch', (await kommtDurch(handy)) === 200);
    ok('der Live-Kanal des Rechners steht', await kanalOffen(rechner));
    const vorher = await tokenIn(rechner);

    console.log('\n── Am Rechner unter „Mein Konto" das Passwort ändern ──');
    await rechner.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await rechner.waitForSelector('#konto-pw-form'); await sleep(1200);
    const hinweis = await rechner.$eval('#konto-pw-form', el => el.innerText);
    ok('das Formular sagt vorher, was passiert', /allen anderen Geräten/.test(hinweis), hinweis.slice(-160));
    await rechner.type('#pw-alt', pw('max'));
    await rechner.type('#pw-neu', 'Frisch2026!');
    await rechner.type('#pw-neu2', 'Frisch2026!');
    await rechner.evaluate(() => { const b = document.querySelector('#konto-pw-form button[type="submit"]'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(1500);
    ok('der Wechsel ist angekommen',
      (await req('POST', '/api/auth/login', null, { username: 'max', password: 'Frisch2026!' })).status === 200,
      'ohne ihn pruefte der Rest nur, dass Nichtstun nichts kaputtmacht');
    const meldung = await rechner.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    ok('… und die Meldung nennt die abgemeldeten Geräte', /anderen Geräten/.test(meldung), meldung);
    // Die Seite lädt nach dem Wechsel sofort die Zwei-Faktor-Karte nach. Ohne übernommenes Token
    // fliegt man schon HIER hinaus — deshalb erst nach der Maske fragen, dann nach dem Formular
    // (das es dann gar nicht mehr gibt; `$eval` würde den ganzen Test abbrechen).
    ok('direkt danach steht keine Anmeldemaske da', !(await rechner.$('#login-user')),
      'das frische Token wurde nicht uebernommen');
    ok('keine Fehlermeldung im Formular', await rechner.evaluate(() => {
      const el = document.getElementById('pw-fehler'); return !!el && getComputedStyle(el).display === 'none'; }));

    console.log('\n── DIESES Gerät bleibt angemeldet ──');
    const nachher = await tokenIn(rechner);
    ok('es gibt ein FRISCHES Token', !!nachher.speicher && nachher.speicher !== vorher.speicher,
      `${String(vorher.speicher).slice(-12)} → ${String(nachher.speicher).slice(-12)}`);
    ok('… und der laufende Betrieb benutzt dasselbe', nachher.laufend === nachher.speicher);
    ok('der Rechner kommt weiterhin durch', (await kommtDurch(rechner)) === 200);
    // Mehrere Herzschläge abwarten: Der Server schließt den Kanal der ALTEN Anmeldung, die Seite
    // verbindet neu. Dabei darf sie sich nicht abmelden.
    await sleep(3500);
    ok('nach dem Neuverbinden des Live-Kanals: weiterhin keine Anmeldemaske', !(await rechner.$('#login-user')));
    ok('… und der Kanal steht wieder', await kanalOffen(rechner));
    ok('… das Token ist dabei dasselbe geblieben', (await tokenIn(rechner)).speicher === nachher.speicher);
    await rechner.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('die App läuft weiter', !(await rechner.$('#login-user')));
    await rechner.reload({ waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('… auch nach einem Neuladen', !(await rechner.$('#login-user')),
      'sonst waere das frische Token nicht dauerhaft gespeichert');

    console.log('\n── Das andere Gerät ist draußen ──');
    ok('das Handy wird abgewiesen', (await kommtDurch(handy)) === 401);
    // Nicht neu laden: Das Handy lag einfach offen da. Sein Live-Kanal wurde geschlossen, beim
    // Neuverbinden erfaehrt die Seite den Grund und zeigt die Anmeldemaske von selbst.
    ok('… und landet von selbst in der Anmeldemaske', !!(await handy.$('#login-user')),
      'der geschlossene Kanal muss die Seite zum Abmelden bringen, nicht erst der naechste Klick');

    console.log('\n── Der zweite Tab auf DEMSELBEN Gerät, der schon offen war ──');
    ok('er hat das frische Token übernommen', (await tokenIn(zweiterTab)).laufend === nachher.speicher,
      `Tab: …${String((await tokenIn(zweiterTab)).laufend).slice(-12)}  Speicher: …${String(nachher.speicher).slice(-12)}`);
    ok('… kommt weiterhin durch', (await kommtDurch(zweiterTab)) === 200, 'derselbe Rechner darf nicht ausgesperrt sein');
    ok('… und zeigt keine Anmeldemaske', !(await zweiterTab.$('#login-user')));

    console.log('\n── Der Admin setzt im Mitarbeiter-Dialog sein EIGENES Passwort ──');
    const adminKontext = await browser.createBrowserContext();
    const admin = await seite(adminKontext, 1000);
    await anmelden(admin, 'admin', pw('admin'));
    const adminVorher = await tokenIn(admin);
    const adminId = await admin.evaluate(() => S.user.id);
    await admin.evaluate(() => { location.hash = '#/users'; });
    await admin.waitForSelector(`.edit-user[data-id="${adminId}"]`); await sleep(600);
    await admin.evaluate((id) => document.querySelector(`.edit-user[data-id="${id}"]`).click(), adminId);
    await admin.waitForSelector('#um-reset-pw-btn'); await sleep(500);
    await admin.evaluate(() => document.getElementById('um-reset-pw-btn').click());
    await sleep(300);
    const dialogHinweis = await admin.$eval('#um-reset-pw-form', el => el.innerText);
    ok('der Dialog sagt vorher, was passiert', /Beendet alle Anmeldungen/.test(dialogHinweis), dialogHinweis.slice(-160));
    await admin.type('#um-pw-new', 'AdminNeu2026!');
    await admin.type('#um-pw-repeat', 'AdminNeu2026!');
    await admin.evaluate(() => document.getElementById('um-pw-save').click());
    await sleep(1500);
    ok('das Passwort ist gesetzt',
      (await req('POST', '/api/auth/login', null, { username: 'admin', password: 'AdminNeu2026!' })).status === 200);
    const adminNachher = await tokenIn(admin);
    ok('der Admin hat ein FRISCHES Token', !!adminNachher.speicher && adminNachher.speicher !== adminVorher.speicher);
    ok('… im laufenden Betrieb dasselbe', adminNachher.laufend === adminNachher.speicher);
    ok('… und kommt weiterhin durch', (await kommtDurch(admin)) === 200);
    await sleep(3000);
    await admin.evaluate(() => { location.hash = '#/'; }); await sleep(1800);
    ok('… auch nach Herzschlag und Seitenwechsel ohne Anmeldemaske', !(await admin.$('#login-user')));

    ok('keine Skriptfehler', fehler.length === 0, fehler.slice(0, 3).join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nPasswortwechsel im Browser: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
