// Persönliche Erinnerungen an Meldungen — Oberfläche und echter Zeitplaner (Alex, 01.10.2026).
//
// Geprüft in der echten App:
//   A  Chefin: Meldung öffnen → „🔔 Meine Erinnerungen · nur für dich" → „🔔 Erinnern": vorbelegt morgen um den
//      Arbeitsbeginn, „in 4 Wochen" setzt das Datum, Hinweis; gespeichert steht sie im Detail und als
//      „🔔 Datum, Uhrzeit" an der Karte. Ändern (Uhrzeit), Escape schließt nur das Formular.
//   B  Mitarbeiterin: kein 🔔 an der Karte, kein Abschnitt im Detail.
//   C  Erledigte Meldung: an der Karte „🔔 Erinnerung ruht", im Detail „ruht" und kein „Erinnern".
//   D  Handy (390 px): das Formular passt, die Seite scrollt nicht seitwärts.
//   E  Der ECHTE Zeitplaner löst die Erinnerung des zweiten Chefs aus: Coin „1" live, dann an der Karte die Marke
//      „🔔 Erinnerung" (hervorgehoben).
//   F  Löschen aus dem Detail.
//
//   node tests/meldung-erinnerungen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3364, DB = '/tmp/meldung-erinnerungen-ui.db', LOG = '/tmp/meldung-erinnerungen-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const berlinJetzt = (d) => (d || new Date()).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
const HEUTE = berlinJetzt().slice(0, 10);
const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const umText = (datum, uhr) => `${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(datum + 'T12:00:00Z').getUTCDay()]} ${datum.slice(8, 10)}.${datum.slice(5, 7)}.${datum.slice(0, 4)}, ${uhr}`;

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
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['bernd', 'Bernd Zweitchef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter']]) {
      await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r });
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    const auto = (await req('POST', '/api/meldungen/themen', admin, { name: 'Auto 2' })).body.thema.id;
    const tuev = (await req('POST', '/api/meldungen', t.anna, { thema_id: auto, text: 'TÜV abgelaufen, Termin in 4 Wochen' })).body.meldung;
    const reifen = (await req('POST', '/api/meldungen', t.anna, { thema_id: auto, text: 'Reifen wechseln' })).body.meldung;
    const tor = (await req('POST', '/api/meldungen', t.anna, { thema_id: auto, text: 'Anhänger: Licht kaputt' })).body.meldung;

    // E vorbereiten: Bernds Erinnerung zur nächsten (sicher noch kommenden) Minute — der echte Zeitplaner läuft
    // 15 s nach dem Start und dann minütlich; bis die anderen Teile durch sind, ist sie fällig.
    const jetzt = new Date(Date.now() + (new Date().getSeconds() > 45 ? 120000 : 60000));
    const umBernd = berlinJetzt(jetzt).slice(0, 16);
    const eb = await req('POST', `/api/meldungen/${tor.id}/erinnerungen`, t.bernd, { datum: umBernd.slice(0, 10), uhrzeit: umBernd.slice(11, 16), hinweis: 'Ersatzlampe mitnehmen' });
    ok('Vorbereitung: Bernds Erinnerung für ' + umBernd + ' gestellt', eb.status === 201, JSON.stringify(eb.body));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async (handy) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      await p.setViewport(handy ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 900 });
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
    const zu = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForFunction(() => !document.querySelector('.main .loading')); await sleep(600); };
    const karteOeffnen = async (p, text) => {
      await p.evaluate((tx) => [...document.querySelectorAll('.mld-karte')].find(k => k.textContent.includes(tx)).click(), text);
      await p.waitForSelector('.mld-detail'); await sleep(300);
    };
    const eintraege = (p) => p.evaluate(() => [...document.querySelectorAll('.mld-detail .erinnerung-eintrag')].map(li => li.textContent.replace(/\s+/g, ' ').trim()));
    const karteZeile = (p, text) => p.evaluate((tx) => { const k = [...document.querySelectorAll('.mld-karte')].find(x => x.textContent.includes(tx));
      const z = k && k.querySelector('.mld-erinnerung'); return z ? z.textContent.replace(/\s+/g, ' ').trim() : null; }, text);
    const coin = (p) => p.evaluate(() => { const b = document.getElementById('nav-badge-meldungen'); return b && b.style.display !== 'none' ? b.textContent.trim() : '0'; });

    // C vorbereiten: eine erledigte Meldung mit Carlas Erinnerung — VOR Bernds erstem Besuch. Als Chef zählt Bernd
    // jede fremde Änderung; käme sie danach, stünde in E „2" statt „1" (Erinnerung + Carlas „erledigt").
    await req('POST', `/api/meldungen/${reifen.id}/erinnerungen`, t.carla, { datum: plus(HEUTE, 10), uhrzeit: '07:00' });
    await req('POST', `/api/meldungen/${reifen.id}/status`, t.carla, { status: 'erledigt' });

    // Bernd meldet sich gleich an und bleibt auf der Startseite — so sieht man den Coin kommen
    const B = await neueSeite();
    await anmelden(B, 'bernd');
    await zu(B, '/meldungen'); await zu(B, '/welcome');

    console.log('A · Chefin stellt eine Erinnerung');
    const C = await neueSeite();
    await anmelden(C, 'carla');
    await zu(C, '/meldungen');
    await karteOeffnen(C, 'TÜV abgelaufen');
    const kopf = await C.evaluate(() => { const b = document.querySelector('.mld-detail .mld-erinnerungen'); return b && b.textContent.replace(/\s+/g, ' ').trim(); });
    ok('Detail: „🔔 Meine Erinnerungen · nur für dich" mit Knopf „🔔 Erinnern"', !!kopf && kopf.startsWith('🔔 Meine Erinnerungen nur für dich')
      && !!(await C.$('.mld-detail [data-act="erinnern"]')), kopf);
    await C.click('.mld-detail [data-act="erinnern"]'); await C.waitForSelector('.erinnerung-form #ef-datum'); await sleep(300);
    const vorbelegt = await C.evaluate(() => [document.getElementById('ef-datum').value, document.getElementById('ef-uhr').value]);
    ok('vorbelegt: morgen, um den Arbeitsbeginn (07:00)', vorbelegt[0] === plus(HEUTE, 1) && vorbelegt[1] === '07:00', JSON.stringify(vorbelegt));
    await C.click('.erinnerung-form [data-tage="28"]'); await sleep(150);
    ok('„in 4 Wochen" setzt das Datum', await C.evaluate(() => document.getElementById('ef-datum').value) === plus(HEUTE, 28));
    await C.type('#ef-hinweis', 'Werkstatt Müller, 9 Uhr');
    await C.click('.erinnerung-form [data-act="ok"]'); await sleep(900);
    let e = await eintraege(C);
    ok('gespeichert: steht im Detail mit Zeit und Hinweis, der Dialog bleibt offen', !(await C.$('.erinnerung-form')) && !!(await C.$('.mld-detail'))
      && e.length === 1 && e[0].includes(umText(plus(HEUTE, 28), '07:00')) && e[0].includes('Werkstatt Müller, 9 Uhr'), JSON.stringify(e));
    await C.click('.mld-detail [data-act="erinnern"]'); await C.waitForSelector('.erinnerung-form'); await sleep(250);
    await C.keyboard.press('Escape'); await sleep(400);
    ok('Escape schließt nur das Formular, das Detail bleibt', !(await C.$('.erinnerung-form')) && !!(await C.$('.mld-detail')));
    await C.click('.mld-detail [data-e="aendern"]'); await C.waitForSelector('.erinnerung-form'); await sleep(250);
    const geladen = await C.evaluate(() => [document.getElementById('ef-datum').value, document.getElementById('ef-uhr').value, document.getElementById('ef-hinweis').value]);
    ok('Ändern: Formular trägt die gespeicherten Werte', geladen.join('|') === `${plus(HEUTE, 28)}|07:00|Werkstatt Müller, 9 Uhr`, JSON.stringify(geladen));
    await C.evaluate(() => { const f = document.getElementById('ef-uhr'); f.value = '08:15'; });
    await C.click('.erinnerung-form [data-act="ok"]'); await sleep(900);
    e = await eintraege(C);
    ok('… neue Uhrzeit steht im Detail', e.length === 1 && e[0].includes(umText(plus(HEUTE, 28), '08:15')), JSON.stringify(e));
    await C.click('.mld-detail [data-act="zu"]'); await sleep(1200);
    ok('Karte: „🔔 Datum, Uhrzeit" — die nächste Erinnerung', await karteZeile(C, 'TÜV abgelaufen') === '🔔 ' + umText(plus(HEUTE, 28), '08:15'), await karteZeile(C, 'TÜV abgelaufen'));

    console.log('B · Mitarbeiterin');
    const A = await neueSeite();
    await anmelden(A, 'anna');
    await zu(A, '/meldungen');
    ok('kein 🔔 an der Karte (Carlas Erinnerung ist privat)', await karteZeile(A, 'TÜV abgelaufen') === null);
    await karteOeffnen(A, 'TÜV abgelaufen');
    ok('kein Abschnitt „Meine Erinnerungen" im Detail', !(await A.$('.mld-detail .mld-erinnerungen')));

    console.log('C · Erledigt: ruht');
    await C.waitForSelector('[data-mld-ansicht="history"]');
    await C.evaluate(() => document.querySelector('[data-mld-ansicht="history"]').click());
    await C.waitForSelector('.mld-hist-liste'); await sleep(700);
    ok('History-Karte: „🔔 Erinnerung ruht"', await karteZeile(C, 'Reifen wechseln') === '🔔 Erinnerung ruht', await karteZeile(C, 'Reifen wechseln'));
    await karteOeffnen(C, 'Reifen wechseln');
    const ruht = await C.evaluate(() => ({ text: document.querySelector('.mld-detail .mld-erinnerungen').textContent.replace(/\s+/g, ' '),
      knopf: !!document.querySelector('.mld-detail [data-act="erinnern"]') }));
    ok('Detail: „ruht", Hinweis zur History, kein „Erinnern"', /ruht/.test(ruht.text) && /Solange die Meldung in der History steht/.test(ruht.text) && !ruht.knopf, ruht.text);
    await C.click('.mld-detail [data-act="zu"]'); await sleep(600);
    await C.waitForSelector('[data-mld-ansicht="offen"]');
    await C.evaluate(() => document.querySelector('[data-mld-ansicht="offen"]').click()); await sleep(900);

    console.log('D · Handy');
    const H = await neueSeite(true);
    await anmelden(H, 'carla');
    await zu(H, '/meldungen');
    await karteOeffnen(H, 'TÜV abgelaufen');
    await H.evaluate(() => document.querySelector('.mld-detail [data-act="erinnern"]').click()); await H.waitForSelector('.erinnerung-form'); await sleep(400);
    const passt = await H.evaluate(() => { const m = document.querySelector('.erinnerung-form .modal').getBoundingClientRect();
      return { links: Math.round(m.left), rechts: Math.round(m.right), seite: document.documentElement.scrollWidth }; });
    ok('Formular passt auf 390 px, keine seitliche Scrollleiste', passt.links >= 0 && passt.rechts <= 390 && passt.seite <= 390, JSON.stringify(passt));

    console.log('E · Der Zeitplaner erinnert');
    let gekommen = false;
    for (let i = 0; i < 170 && !gekommen; i++) {
      const b = (await req('GET', '/api/badges', t.bernd)).body || {};
      gekommen = b.meldungenErinnerungen >= 1;
      if (!gekommen) await sleep(1000);
    }
    ok('der echte Zeitplaner hat Bernds Erinnerung ausgelöst', gekommen);
    await B.waitForFunction(() => { const b = document.getElementById('nav-badge-meldungen'); return b && b.style.display !== 'none' && b.textContent.trim() === '1'; }, { timeout: 10000 }).catch(() => {});
    ok('Coin „1" bei Bernd — live, ohne Neuladen', (await coin(B)) === '1', await coin(B));
    ok('… bei Carla kommt davon nichts an', (await req('GET', '/api/badges', t.carla)).body.meldungenErinnerungen === 0);
    await zu(B, '/meldungen');
    const marke = await B.evaluate((id) => { const k = document.querySelector(`.mld-karte[data-id="${id}"]`);
      return k && { marke: (k.querySelector('.mld-marke') || {}).textContent || null, markiert: k.classList.contains('mld-markiert') }; }, tor.id);
    ok('Karte trägt die Marke „🔔 Erinnerung" und ist hervorgehoben', marke && marke.marke === '🔔 Erinnerung' && marke.markiert, JSON.stringify(marke));
    ok('… andere Karten nicht', await B.evaluate((id) => [...document.querySelectorAll('.mld-karte')].filter(k => k.dataset.id !== String(id)).every(k => !k.querySelector('.mld-marke')), tor.id));
    await karteOeffnen(B, 'Licht kaputt');
    e = await eintraege(B);
    ok('Detail: „gekommen am …" mit Hinweis, Knopf „Neues Datum"', e.length === 1 && /gekommen am \d\d\.\d\d\.\d{4}, \d\d:\d\d/.test(e[0]) && e[0].includes('Ersatzlampe mitnehmen') && e[0].includes('Neues Datum'), JSON.stringify(e));

    console.log('F · Löschen');
    await zu(C, '/welcome'); await zu(C, '/meldungen');
    await karteOeffnen(C, 'TÜV abgelaufen');
    await C.click('.mld-detail [data-e="loeschen"]'); await sleep(500);
    await C.evaluate(() => [...document.querySelectorAll('.modal-overlay')].pop().querySelector('[data-act="ok"], .btn-primary, .btn-danger').click()); await sleep(900);
    ok('gelöscht: der Abschnitt ist leer, „Erinnern" bleibt', (await eintraege(C)).length === 0 && !!(await C.$('.mld-detail [data-act="erinnern"]')));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nMeldungs-Erinnerungen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
