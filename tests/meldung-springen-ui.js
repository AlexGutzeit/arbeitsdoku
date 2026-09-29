// Meldung antippen → genau dorthin, hervorgehoben (Alex, 29.09.2026).
//
// Alex: „Wenn ich auf die Push-Nachricht klicke, werde ich sofort zu Notizen geleitet und die Notiz ist
// hervorgehoben. Bei einer Meldung, dass ‚Alex freifunk' als Gast etwas geändert hat, bin ich auf der
// Willkommensseite gelandet. Prüfe auch die anderen Meldungen." Geprüft in der echten App:
//   A  App offen (Nachricht vom Service Worker, wie sw.js sie schickt): je Meldungsart die richtige Seite
//      und GENAU das gemeinte Element hervorgehoben — Notiz, Angebot, Projektkachel (aufgeklappt),
//      Abwesenheitskarte, Aushang, Bestellung, Termin (am Tag des Termins). Auch, wenn man schon dort ist.
//   B  App war zu (sw.js öffnet /?meldung=…#/…): hervorgehoben, die Adresse danach wieder sauber.
//   C  Abgemeldet angetippt: nach der Anmeldung genau dort — nicht auf der Willkommensseite.
//   D  Die Gästeseite hat keinen Empfänger — deshalb schickt sw.js ihr nichts (tests/meldung-sw.js).
//
//   node tests/meldung-springen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3357, DB = '/tmp/meldung-springen.db', LOG = '/tmp/meldung-springen.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const tag = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

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
    const id = {}, t = {};
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r })).body.user.id;
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    // Viele Dinge je Art, damit „das richtige" nicht zufällig oben steht
    const notizen = [];
    for (let i = 1; i <= 12; i++) { const n = (await req('POST', '/api/notes', t.carla, { title: `Notiz ${i}`, body: 'x' })).body; notizen.push(n.id || (n.note && n.note.id)); }
    const angebotNotiz = (await req('POST', '/api/notes', t.anna, { title: 'Angebot von Anna', body: 'y' })).body;
    const angebotNid = angebotNotiz.id || (angebotNotiz.note && angebotNotiz.note.id);
    await req('POST', `/api/notes/${angebotNid}/offer`, t.anna, { user_ids: [id.carla] });
    const aushaenge = [];
    for (let i = 1; i <= 8; i++) { const a = (await req('POST', '/api/bulletin', t.carla, { title: `Aushang ${i}`, text: '' })).body; aushaenge.push(a.id || (a.entry && a.entry.id)); }
    const bestellungen = [];
    for (let i = 1; i <= 8; i++) { const b = (await req('POST', '/api/orders', t.anna, { product: `Teil ${i}`, quantity: 1 })).body; bestellungen.push(b.id || (b.order && b.order.id)); }
    const projekte = [];
    for (let i = 1; i <= 6; i++) { const p = (await req('POST', '/api/projects', t.carla, { name: `Auftrag ${i}`, assigned_user_ids: [id.anna] })).body; projekte.push((p.project || p).id); }
    const abw = (await req('POST', '/api/absences', t.anna, { type: 'urlaub', date_from: tag(20), date_to: tag(21) })).body;
    const abwId = (abw.absence || abw).id;
    const termine = [];
    for (const [i, zeit] of [['07:00', '09:00'], ['10:00', '12:00'], ['13:00', '15:00']].entries()) {
      const pl = (await req('POST', '/api/planning', t.carla, { date: tag(9), time_from: zeit[0], time_to: zeit[1], client: `Termin ${i + 1}`, assigned_user_ids: [id.anna] })).body;
      termine.push((pl.entry || pl).id);
    }
    ok('Aufbau vollständig', notizen.every(Boolean) && angebotNid && aushaenge.every(Boolean) && bestellungen.every(Boolean) && projekte.every(Boolean) && abwId && termine.every(Boolean),
      JSON.stringify({ notizen, aushaenge, bestellungen, projekte, abwId, termine }));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async () => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      p.setDefaultTimeout(15000);
      return p;
    };
    const anmelden = async (p) => {
      await p.waitForSelector('#login-user');
      await p.type('#login-user', 'carla'); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(600);
    };
    // Was gerade hervorgehoben ist: Klasse + Kennung
    const hervorgehoben = (p) => p.evaluate(() => [...document.querySelectorAll('.ziel-hervor, .bulletin-card--hervor, .absence-card--hervor, .tl-plan-entry--hervor')]
      .map(e => ({ kl: e.className, id: e.dataset.id || e.dataset.noteId || e.dataset.planningId || null })));
    const warteAuf = async (p, pruef, ms = 6000) => { const bis = Date.now() + ms; while (Date.now() < bis) { const h = await hervorgehoben(p); if (pruef(h)) return h; await sleep(100); } return hervorgehoben(p); };
    const nachricht = (p, url, ziel) => p.evaluate((url, ziel) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { typ: 'meldung-geklickt', url, ziel } }));
    }, url, ziel);

    const P = await neueSeite();
    await P.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
    await anmelden(P);

    console.log('A · App offen, Meldung angetippt');
    const FAELLE = [
      ['Notiz bearbeitet', '/#/notes', { art: 'notiz', id: notizen[2] }, '#/notes', h => h.some(x => /ziel-hervor/.test(x.kl) && x.id == notizen[2])],
      ['Notiz angeboten', '/#/notes', { art: 'notiz', id: angebotNid }, '#/notes', h => h.some(x => /ziel-hervor/.test(x.kl) && x.id == angebotNid)],
      ['Projektnotiz bearbeitet', '/#/projects', { art: 'projekt', id: projekte[4] }, '#/projects', h => h.some(x => /ziel-hervor/.test(x.kl) && x.id == projekte[4])],
      ['Aushang', '/#/bulletin', { art: 'aushang', id: aushaenge[1] }, '#/bulletin', h => h.some(x => /bulletin-card--hervor/.test(x.kl) && x.id == aushaenge[1])],
      ['Neue Bestellung', '/#/orders', { art: 'bestellung', id: bestellungen[3] }, '#/orders', h => h.some(x => /ziel-hervor/.test(x.kl) && x.id == bestellungen[3])],
      ['Neuer Antrag (Abwesenheit)', '/#/absences', { art: 'abwesenheit', id: abwId }, '#/absences', h => h.some(x => /absence-card--hervor/.test(x.kl) && x.id == abwId)],
      ['Erinnerung (Termin)', '/#/planning', { art: 'termin', id: termine[1], datum: tag(9) }, '#/planning', h => h.some(x => /tl-plan-entry--hervor/.test(x.kl) && x.id == termine[1])],
    ];
    for (const [name, url, ziel, hash, pruef] of FAELLE) {
      await P.evaluate(() => { location.hash = '/welcome'; }); await P.waitForFunction(() => location.hash === '#/welcome'); await sleep(600);
      await nachricht(P, url, ziel);
      const h = await warteAuf(P, pruef);
      ok(`${name}: auf ${hash}, genau dieses hervorgehoben`, (await P.evaluate(() => location.hash)) === hash && pruef(h), JSON.stringify({ hash: await P.evaluate(() => location.hash), h }));
    }
    await P.evaluate(() => { location.hash = '/welcome'; }); await sleep(500);
    await nachricht(P, '/#/projects', { art: 'projekt', id: projekte[4] });
    await warteAuf(P, h => h.some(x => x.id == projekte[4]));
    ok('Projektkachel ist aufgeklappt', await P.evaluate((pid) => !!document.querySelector(`.proj-tile[data-id="${pid}"].expanded`), projekte[4]));
    ok('Termin: Planung steht auf dem Tag des Termins', await P.evaluate((d) => formatDateISO(S.planningDate) === d && S.planningView === 'day', tag(9)).catch(() => false));

    // Schon auf der Seite: trotzdem hinspringen und hervorheben
    await P.evaluate(() => { location.hash = '/notes'; }); await P.waitForFunction(() => !!document.querySelector('.note-card')); await sleep(600);
    await nachricht(P, '/#/notes', { art: 'notiz', id: notizen[9] });
    const hSchon = await warteAuf(P, h => h.some(x => x.id == notizen[9]));
    ok('schon auf „Notizen": trotzdem hervorgehoben', hSchon.some(x => /ziel-hervor/.test(x.kl) && x.id == notizen[9]), JSON.stringify(hSchon));

    console.log('B · App war zu (sw.js öffnet /?meldung=…)');
    const zielB = encodeURIComponent(JSON.stringify({ art: 'aushang', id: aushaenge[6] }));
    await P.goto(BASIS + '/?meldung=' + zielB + '#/bulletin', { waitUntil: 'domcontentloaded' });
    const hB = await warteAuf(P, h => h.some(x => /bulletin-card--hervor/.test(x.kl) && x.id == aushaenge[6]));
    ok('Aushang hervorgehoben', hB.some(x => /bulletin-card--hervor/.test(x.kl) && x.id == aushaenge[6]), JSON.stringify(hB));
    ok('Adresse danach sauber (kein ?meldung mehr)', await P.evaluate(() => !location.search && location.hash === '#/bulletin'), await P.evaluate(() => location.href));

    console.log('C · Abgemeldet angetippt');
    const Q = await neueSeite();
    const zielC = encodeURIComponent(JSON.stringify({ art: 'notiz', id: notizen[5] }));
    await Q.goto(BASIS + '/?meldung=' + zielC + '#/notes', { waitUntil: 'domcontentloaded' });
    await anmelden(Q);
    await Q.waitForFunction(() => location.hash === '#/notes', { timeout: 8000 }).catch(() => {});
    const hC = await warteAuf(Q, h => h.some(x => x.id == notizen[5]));
    ok('nach der Anmeldung auf „Notizen" (nicht Willkommen), die Notiz hervorgehoben',
      (await Q.evaluate(() => location.hash)) === '#/notes' && hC.some(x => /ziel-hervor/.test(x.kl) && x.id == notizen[5]), JSON.stringify({ hash: await Q.evaluate(() => location.hash), hC }));

    console.log('D · Die Gästeseite hat keinen Empfänger');
    const gastQuelle = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gast.js'), 'utf8');
    ok('gast.js horcht nicht auf Meldungen — sw.js muss sie meiden (tests/meldung-sw.js)', !/meldung-geklickt/.test(gastQuelle));
    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nMeldung antippen → genau dorthin: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
