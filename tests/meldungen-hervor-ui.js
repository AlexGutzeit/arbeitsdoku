// Meldungen — Coin, „neu/geändert" und der Sprung aus der Push-Meldung (Etappe 2, 30.09.2026).
//
// Alex: „Bei jeder Meldung oder Änderung zählt, wie gewohnt, der Coin vom Chef/Admin hoch. Wenn etwas geändert
// oder neu ist, sollen beim erneuten Betreten vom Chef/Admin die Einträge hervorgehoben werden." — „Beim Klick
// [auf die Push] wird man sofort zur Meldung geführt und diese für ein paar Sekunden hervorgehoben."
// Geprüft in der echten App:
//   A  Coin am Menüpunkt steigt live (ohne Neuladen) und geht beim Hinschauen auf 0.
//   B  Beim Betreten: genau das Neue/Geänderte markiert — beim nächsten Betreten nicht mehr.
//   C  Während man schaut, ändert ein anderer etwas → „geändert" erscheint live.
//   D  Push angetippt → Meldungen, genau diese Karte hervorgehoben; eine erledigte → in der History.
//   E  Mitarbeiterin: markiert ist nur, was an IHRER Meldung ein anderer getan hat (wie ihr Zähler).
//
//   node tests/meldungen-hervor-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3360, DB = '/tmp/meldungen-hervor-ui.db', LOG = '/tmp/meldungen-hervor-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const t = {};
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter'], ['moritz', 'Moritz Muster', 'mitarbeiter']]) {
      await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r });
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    const auto = (await req('POST', '/api/meldungen/themen', admin, { name: 'Auto 2' })).body.thema.id;
    const tonne = (await req('POST', '/api/meldungen/themen', admin, { name: 'Papiermüll' })).body.thema.id;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async () => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      await p.setViewport({ width: 1280, height: 900 });
      p.setDefaultTimeout(15000);
      return p;
    };
    const anmelden = async (p, u) => {
      await p.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(700);
    };
    const zu = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForFunction(() => !document.querySelector('.main .loading')); await sleep(500); };
    const coin = (p) => p.evaluate(() => { const b = document.getElementById('nav-badge-meldungen'); return b && b.style.display !== 'none' ? b.textContent.trim() : '0'; });
    const marken = (p) => p.evaluate(() => [...document.querySelectorAll('.mld-karte')].map(k => ({
      text: k.querySelector('.mld-text').textContent.trim(), marke: (k.querySelector('.mld-marke') || {}).textContent || null })));

    console.log('A · Coin am Menüpunkt');
    const C = await neueSeite();
    await anmelden(C, 'carla');
    await zu(C, '/meldungen'); await zu(C, '/welcome');   // einmal hingeschaut: ab hier zählt alles Neue
    ok('am Anfang kein Coin', (await coin(C)) === '0');
    const oel = (await req('POST', '/api/meldungen', t.anna, { thema_id: auto, text: 'Ölwechsel fällig', dringend: true })).body.meldung;
    const reifen = (await req('POST', '/api/meldungen', t.moritz, { thema_id: auto, text: 'Reifendruck prüfen' })).body.meldung;
    await C.waitForFunction(() => { const b = document.getElementById('nav-badge-meldungen'); return b && b.textContent.trim() === '2' && b.style.display !== 'none'; }, { timeout: 8000 }).catch(() => {});
    ok('zwei neue Meldungen: Coin „2" — live, ohne Neuladen', (await coin(C)) === '2', await coin(C));

    console.log('B · Beim Betreten markiert');
    await zu(C, '/meldungen');
    let m = await marken(C);
    ok('beide Karten tragen „neu"', m.length === 2 && m.every(x => x.marke === 'neu'), JSON.stringify(m));
    ok('… und sind hervorgehoben (Rahmen)', await C.evaluate(() => [...document.querySelectorAll('.mld-karte')].every(k => k.classList.contains('mld-markiert'))));
    ok('Coin weg, sobald man hinschaut', (await coin(C)) === '0');
    // Zeichnet die Seite live neu (ein anderer ändert etwas), bleiben die Markierungen dieses Besuchs stehen
    await req('PUT', `/api/meldungen/${oel.id}`, admin, { text: 'Ölwechsel fällig, 5W-30' });
    await C.waitForFunction(() => [...document.querySelectorAll('.mld-text')].some(x => /5W-30/.test(x.textContent)), { timeout: 8000 }).catch(() => {});
    m = await marken(C);
    ok('live neu gezeichnet: beide weiter „neu" (die Markierung gilt für den ganzen Besuch)', m.some(x => /5W-30/.test(x.text)) && m.length === 2 && m.every(x => x.marke === 'neu'), JSON.stringify(m));
    await zu(C, '/welcome'); await sleep(300);
    ok('… und bleibt weg (Server hat „gesehen")', (await coin(C)) === '0', await coin(C));
    await zu(C, '/meldungen');
    m = await marken(C);
    ok('beim nächsten Betreten: nichts mehr markiert', m.length === 2 && m.every(x => !x.marke), JSON.stringify(m));

    console.log('C · Ein anderer ändert, während man schaut');
    await req('POST', `/api/meldungen/${oel.id}/status`, admin, { status: 'in_arbeit' });
    await C.waitForFunction(() => [...document.querySelectorAll('.mld-karte')].some(k => (k.querySelector('.mld-marke') || {}).textContent === 'geändert'), { timeout: 8000 }).catch(() => {});
    m = await marken(C);
    ok('„Ölwechsel" erscheint live als „geändert", „Reifendruck" nicht', m.find(x => /Ölwechsel/.test(x.text)).marke === 'geändert' && !m.find(x => /Reifendruck/.test(x.text)).marke, JSON.stringify(m));
    ok('… ohne Coin (man schaut ja hin)', (await coin(C)) === '0', await coin(C));
    await zu(C, '/welcome');

    console.log('D · Push angetippt');
    const nachricht = (p, ziel) => p.evaluate((z) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { typ: 'meldung-geklickt', url: '/#/meldungen', ziel: z } }));
    }, ziel);
    await nachricht(C, { art: 'meldung', id: reifen.id });
    await C.waitForFunction((id) => { const k = document.querySelector(`.mld-karte[data-id="${id}"]`); return k && k.classList.contains('ziel-hervor'); }, { timeout: 8000 }, reifen.id).catch(() => {});
    ok('→ Meldungen, genau diese Karte hervorgehoben', await C.evaluate((id) => location.hash === '#/meldungen'
      && !!document.querySelector(`.mld-karte[data-id="${id}"].ziel-hervor`) && document.querySelectorAll('.ziel-hervor').length === 1, reifen.id));
    await sleep(2800);
    ok('… nach ein paar Sekunden ist die Hervorhebung wieder weg', await C.evaluate(() => !document.querySelector('.ziel-hervor')));
    await req('POST', `/api/meldungen/${oel.id}/status`, admin, { status: 'erledigt' });
    await zu(C, '/welcome');
    await nachricht(C, { art: 'meldung', id: oel.id });
    await C.waitForFunction((id) => !!document.querySelector(`.mld-hist-liste .mld-karte[data-id="${id}"].ziel-hervor`), { timeout: 8000 }, oel.id).catch(() => {});
    ok('eine erledigte Meldung → History, dort hervorgehoben', await C.evaluate((id) => !!document.querySelector(`.mld-hist-liste .mld-karte[data-id="${id}"].ziel-hervor`)
      && document.querySelector('[data-mld-ansicht="history"]').classList.contains('active'), oel.id));
    await zu(C, '/welcome');
    await nachricht(C, { art: 'meldung', id: reifen.id });
    await C.waitForFunction((id) => !!document.querySelector(`.mld-col .mld-karte[data-id="${id}"].ziel-hervor`), { timeout: 8000 }, reifen.id).catch(() => {});
    ok('danach wieder eine offene: zurück im Board (nicht in der History hängen geblieben)', await C.evaluate((id) => !!document.querySelector(`.mld-col .mld-karte[data-id="${id}"].ziel-hervor`), reifen.id));

    console.log('E · Mitarbeiterin');
    const A = await neueSeite();
    await anmelden(A, 'anna');
    await zu(A, '/meldungen'); await zu(A, '/welcome');
    await req('POST', '/api/meldungen', t.moritz, { thema_id: tonne, text: 'Tonne voll' });            // fremde Meldung
    const eigene = (await req('POST', '/api/meldungen', t.anna, { thema_id: tonne, text: 'Deckel kaputt' })).body.meldung;
    await req('PUT', `/api/meldungen/${eigene.id}`, t.carla, { rueckmeldung: 'Neuer Deckel ist bestellt' });
    await A.waitForFunction(() => { const b = document.getElementById('nav-badge-meldungen'); return b && b.textContent.trim() === '1'; }, { timeout: 8000 }).catch(() => {});
    ok('Coin „1": die Rückmeldung zu ihrer Meldung — nicht die fremde neue', (await coin(A)) === '1', await coin(A));
    await zu(A, '/meldungen');
    m = await marken(A);
    ok('markiert ist nur ihre eigene („geändert"), die fremde nicht', m.find(x => /Deckel/.test(x.text)).marke === 'geändert' && !m.find(x => /Tonne voll/.test(x.text)).marke, JSON.stringify(m));
    ok('Zusammenfassung bietet „Meldungen" an', await A.evaluate(() => summaryCatOptions().some(c => c.key === 'meldungen')));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nMeldungen — Coin und Hervorheben: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
