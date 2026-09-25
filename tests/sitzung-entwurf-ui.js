// Abgelaufene Sitzung mitten im Formular (R1, Alex 24.09.2026).
//
// Vorher: Die Sitzung lief fest nach 24 Stunden ab. Beim naechsten Speichern kam 401, die App meldete
// ab, gab `null` zurueck — und das Eintragsformular hielt das fuer Erfolg: „Eintrag erstellt",
// Entwurf geloescht, gespeichert war nichts. Dazu loeschte das automatische Abmelden ALLE Entwuerfe.
//
// Jetzt:
//   * ein schreibender Aufruf nach dem Abmelden ist ein FEHLER, nie ein Erfolg
//   * bei ABGELAUFENER Sitzung bleiben die Entwuerfe — auch die letzten Tastenanschlaege — und nach
//     der Neuanmeldung geht es zurueck ins Formular, das sie anbietet
//   * bei „auf allen Geraeten beendet", bewusstem Abmelden und Nutzerwechsel werden sie geloescht
//     (geteilte Geraete, verlorenes Handy) — das sind die Gegenproben
//   * das stille Erneuern des Tokens im Browser, mit seinen zwei Riegeln
//
//   node tests/sitzung-entwurf-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');

const PORT = 3326, DB = '/tmp/sitzung-entwurf-ui.db', LOG = '/tmp/sitzung-entwurf-ui.log';
const BASIS = 'http://localhost:' + PORT;
const GEHEIM = 'test-secret-mindestens-32-zeichen-lang';
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
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: GEHEIM }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1100, height: 900 });
    seite.setDefaultTimeout(30000);
    const jsFehler = [];
    seite.on('pageerror', e => jsFehler.push(e.message));

    const anmelden = async (u) => {
      if (!(await seite.$('#login-user'))) { await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); }
      await seite.waitForSelector('#login-user');
      await seite.evaluate(() => { document.getElementById('login-user').value = ''; document.getElementById('login-pass').value = ''; });
      await seite.type('#login-user', u); await seite.type('#login-pass', pw(u));
      await seite.click('#login-form button[type="submit"]'); await sleep(2600);
    };
    // Gueltige Zeiten ausdruecklich setzen. Die Vorbelegung haengt an der Uhrzeit: Vor Arbeitsbeginn
    // (nachts) steht das Formular auf 07:00–07:00 mit 30 min Pause — seit R6 haelt die Oberflaeche das
    // beim Absenden auf, der Aufruf erreicht den Server nie, und die Sitzungspruefung, um die es HIER
    // geht, kommt nicht zum Zug. Gefunden, weil die Suite um 2 Uhr nachts lief.
    const neuesFormular = async () => {
      await seite.goto(BASIS + '/#/entry/new', { waitUntil: 'domcontentloaded' });
      await seite.waitForSelector('#ef-desc'); await sleep(900);
      await seite.evaluate(() => {
        for (const [id, w] of [['ef-from', '08:00'], ['ef-to', '12:00']]) {
          const el = document.getElementById(id); el.value = w;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await sleep(700);
    };
    // Macht das Token im Browser ungueltig — genau so, wie es nach Ablauf aussaehe.
    const sitzungAblaufenLassen = (uid) => seite.evaluate((t) => { S.token = t; localStorage.setItem('token', t); },
      jwt.sign({ userId: uid, role: 'mitarbeiter', sitzung: 0, iat: Math.floor(Date.now() / 1000) - 4 * 86400,
                 exp: Math.floor(Date.now() / 1000) - 10 }, GEHEIM));
    const toastText = () => seite.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
    const entwurfSchluessel = () => seite.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('entwurf:')));
    const eintraegeMit = async (text) => (await req('GET', '/api/entries', admin)).body.entries.filter(e => e.description === text).length;
    const TEXT = 'Zählerschrank Kita, Hauptverteiler gesetzt, Messung folgt';

    // ────────────────────────────────────────────────────────────────────────────────────────
    console.log('── Sitzung läuft mitten im Formular ab ──');
    await anmelden('max');
    await neuesFormular();
    await seite.type('#ef-desc', TEXT, { delay: 5 });
    // KEIN Warten auf die Entprell-Pause: Auch die letzten Tastenanschläge muessen gesichert werden.
    await sitzungAblaufenLassen(maxId);
    await seite.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await sleep(700);
    const t1 = await toastText();
    ok('KEIN „Eintrag erstellt" — die alte falsche Erfolgsmeldung', !/Eintrag erstellt/.test(t1), t1);
    ok('… sondern ausdrücklich „NICHT gespeichert"', /NICHT gespeichert/.test(t1), t1);
    ok('… und wirklich nichts auf dem Server', await eintraegeMit(TEXT) === 0);
    await seite.waitForSelector('#login-user');
    const hinweis = await seite.evaluate(() => (document.querySelector('.login-hinweis') || {}).textContent || '');
    ok('die Anmeldeseite sagt, warum man dort ist', /Sitzung ist abgelaufen/.test(hinweis), hinweis);
    ok('… und dass die Eingaben gesichert sind', /gesichert/.test(hinweis), hinweis);
    const k1 = await entwurfSchluessel();
    ok('der Entwurf liegt unter Max\' Kennung', k1.some(k => k.startsWith('entwurf:' + maxId + ':')), JSON.stringify(k1));
    const inhalt = await seite.evaluate((ks) => ks.map(k => localStorage.getItem(k)).join(''), k1);
    ok('… vollständig, inklusive der letzten Tastenanschläge', inhalt.includes(TEXT), inhalt.slice(0, 120));

    console.log('\n── Neu anmelden: zurück ins Formular, Entwurf wird angeboten ──');
    await anmelden('max');
    ok('man landet wieder im Eintragsformular', await seite.evaluate(() => location.hash) === '#/entry/new',
      await seite.evaluate(() => location.hash));
    await seite.waitForSelector('.draft-bar', { timeout: 8000 }).catch(() => {});
    ok('„Nicht gespeicherter Entwurf gefunden" steht da', !!(await seite.$('.draft-bar')));
    // Fehlt die Leiste, soll der Test das BENENNEN und weiterlaufen — nicht an einem null abbrechen.
    await seite.evaluate(() => { const k = document.getElementById('entwurf-uebernehmen'); if (k) k.click(); });
    await sleep(500);
    ok('… und „Wiederherstellen" bringt den Text zurück', await seite.$eval('#ef-desc', el => el.value) === TEXT,
      await seite.$eval('#ef-desc', el => el.value));
    ok('der Hinweis auf der Anmeldeseite ist danach wieder weg', await seite.evaluate(() => S.anmeldeHinweis === null));

    // ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Gegenprobe: ein ANDERER meldet sich an ──');
    await neuesFormular();
    await seite.type('#ef-desc', 'Nur für Max bestimmt', { delay: 5 });
    await sitzungAblaufenLassen(maxId);
    await seite.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await seite.waitForSelector('#login-user'); await sleep(400);
    ok('(Max\' Entwurf liegt vor dem Wechsel noch da)', (await entwurfSchluessel()).some(k => k.startsWith('entwurf:' + maxId + ':')));
    await anmelden('chef');
    const k2 = await entwurfSchluessel();
    ok('meldet sich der Chef an, sind Max\' Entwürfe vom Gerät verschwunden', !k2.some(k => k.startsWith('entwurf:' + maxId + ':')), JSON.stringify(k2));
    ok('… und der Chef landet NICHT in Max\' Formular', await seite.evaluate(() => location.hash) === '#/welcome',
      await seite.evaluate(() => location.hash));

    // ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Gegenprobe: „Auf allen Geräten abmelden" (Handy verloren) ──');
    await seite.evaluate(() => { S.token = null; });   // schlicht zur Anmeldeseite
    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.evaluate(() => { localStorage.clear(); location.hash = '#/login'; });
    await seite.reload({ waitUntil: 'domcontentloaded' }); await sleep(800);
    await anmelden('max');
    await neuesFormular();
    await seite.type('#ef-desc', 'Kundenadresse, soll nicht liegen bleiben', { delay: 5 });
    await sleep(600);
    // Von einem ANDEREN Gerät aus: Max drückt „auf allen Geräten abmelden".
    const maxAnderswo = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body.token;
    const alle = await req('POST', '/api/auth/alle-abmelden', maxAnderswo);
    ok('(„auf allen Geräten abmelden" angenommen)', alle.status === 200, alle.text.slice(0, 80));
    await seite.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await seite.waitForSelector('#login-user'); await sleep(500);
    ok('der Entwurf ist GELÖSCHT', !(await entwurfSchluessel()).length, JSON.stringify(await entwurfSchluessel()));
    ok('die Anmeldeseite sagt „auf allen Geräten beendet"',
      /allen Geräten beendet/.test(await seite.evaluate(() => (document.querySelector('.login-hinweis') || {}).textContent || '')));
    ok('… und verspricht KEINE gesicherten Eingaben',
      !/gesichert/.test(await seite.evaluate(() => (document.querySelector('.login-hinweis') || {}).textContent || '')));

    // ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Gegenprobe: bewusst abmelden ──');
    await anmelden('max');
    await neuesFormular();
    await seite.type('#ef-desc', 'bewusst abgemeldet', { delay: 5 });
    await sleep(600);
    ok('(Entwurf vor dem Abmelden gesichert)', (await entwurfSchluessel()).length > 0);
    await seite.evaluate(() => logout(true));
    await seite.waitForSelector('#login-user'); await sleep(400);
    ok('bewusstes Abmelden löscht die Entwürfe wie bisher', !(await entwurfSchluessel()).length);
    ok('… ohne Hinweis auf der Anmeldeseite', !(await seite.$('.login-hinweis')));

    // ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Beim Öffnen der App bereits abgelaufen ──');
    await anmelden('max');
    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' }); await sleep(1500);
    await sitzungAblaufenLassen(maxId);
    await seite.reload({ waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user', { timeout: 15000 }); await sleep(800);
    ok('Anmeldeseite mit „abgelaufen"', /abgelaufen/.test(await seite.evaluate(() => (document.querySelector('.login-hinweis') || {}).textContent || '')));
    await anmelden('max');
    ok('… und danach zurück auf die Seite von vorhin', await seite.evaluate(() => location.hash) === '#/orders',
      await seite.evaluate(() => location.hash));

    // ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Stilles Erneuern im Browser ──');
    const jetzt = Math.floor(Date.now() / 1000);
    const alt = jwt.sign({ userId: maxId, role: 'mitarbeiter', sitzung: 1, anmeldung: jetzt - 7200, iat: jetzt - 7200, exp: jetzt + 3600 }, GEHEIM);
    await seite.evaluate((t) => { S.token = t; localStorage.setItem('token', t); }, alt);
    await seite.evaluate(async () => { await api('GET', '/api/orders'); });
    const nachher = await seite.evaluate(() => ({ s: S.token, l: localStorage.getItem('token') }));
    const nd = jwt.decode(nachher.s);
    ok('ein zwei Stunden altes Token wird beim nächsten Aufruf ersetzt', nachher.s !== alt && nd && nd.iat >= jetzt - 5);
    ok('… auch im Speicher des Geräts (übersteht das Schließen der App)', nachher.l === nachher.s);
    ok('… und läuft wieder 3 Tage', nd && Math.abs(nd.exp - (nd.iat + 3 * 86400)) <= 2);

    const fremd = jwt.sign({ userId: maxId + 1000, role: 'mitarbeiter', sitzung: 0, anmeldung: jetzt, iat: jetzt, exp: jetzt + 3600 }, GEHEIM);
    const r1 = await seite.evaluate((t) => { const vor = S.token; tokenUebernehmen(t); return S.token === vor; }, fremd);
    ok('ein Token für einen ANDEREN Nutzer wird nicht übernommen', r1);
    const r2 = await seite.evaluate((t) => { const vor = S.token; S.token = null; tokenUebernehmen(t); const blieb = S.token === null; S.token = vor; return blieb; },
      jwt.sign({ userId: maxId, sitzung: 1, anmeldung: jetzt, iat: jetzt, exp: jetzt + 3600 }, GEHEIM));
    ok('nach dem Abmelden belebt eine verspätete Antwort die Sitzung NICHT wieder', r2);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }

  console.log(`\nSitzung + Entwürfe (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
