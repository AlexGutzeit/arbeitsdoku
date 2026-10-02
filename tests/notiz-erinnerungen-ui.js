// Persönliche Erinnerungen an Notizen — Oberfläche und echter Zeitplaner (Alex, 02.10.2026).
//
// Geprüft in der echten App:
//   A  Eigentümerin: Notiz öffnen → ⋯ → „🔔 Erinnern" → „Meine Erinnerungen" → „Neue Erinnerung": vorbelegt
//      morgen um den Arbeitsbeginn, „in 4 Wochen", Hinweis. Danach steht unter dem Titel „🔔 Deine Erinnerung: …";
//      antippen öffnet den Dialog wieder, Ändern stellt die Uhrzeit um.
//   B  Übersicht: an der Karte „🔔 Datum, Uhrzeit" — nur die eigene, an anderen Karten nichts.
//   C  Leserin (nur lesen): sieht Olgas Erinnerung nicht, hat aber selbst „🔔 Erinnern" im Menü.
//   D  Handy (390 px): der Dialog passt.
//   E  Der ECHTE Zeitplaner löst Lenas Erinnerung aus: Coin „1" live; Antippen der Push → Notizen, die Notiz
//      hervorgehoben und mit „🔔 Erinnerung" gekennzeichnet — auch nach dem stillen Auffrischen der Liste.
//
//   node tests/notiz-erinnerungen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3366, DB = '/tmp/notiz-erinnerungen-ui.db', LOG = '/tmp/notiz-erinnerungen-ui.log';
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
    const t = {}, ids = {};
    for (const [u, n] of [['olga', 'Olga Owner'], ['lena', 'Lena Leserin']]) {
      ids[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter' })).body.user.id;
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    const n1 = (await req('POST', '/api/notes', t.olga, { title: 'Angebot Gartenhütte', body: 'Preis klären, Zeichnung schicken' })).body.note.id;
    const n2 = (await req('POST', '/api/notes', t.olga, { title: 'Einkaufsliste', body: 'Schrauben' })).body.note.id;
    for (const n of [n1, n2]) await req('PUT', `/api/notes/${n}/shares`, t.olga, { shares: [{ user_id: ids.lena, permission: 'read' }] });

    // E vorbereiten: Lenas Erinnerung zur nächsten (sicher noch kommenden) Minute — der echte Zeitplaner läuft
    // 15 s nach dem Start und dann minütlich; bis die anderen Teile durch sind, ist sie fällig.
    const um = berlinJetzt(new Date(Date.now() + (new Date().getSeconds() > 45 ? 120000 : 60000))).slice(0, 16);
    const el = await req('POST', `/api/notes/${n1}/erinnerungen`, t.lena, { datum: um.slice(0, 10), uhrzeit: um.slice(11, 16), hinweis: 'Angebot muss raus' });
    ok('Vorbereitung: Lenas Erinnerung für ' + um + ' gestellt', el.status === 201, JSON.stringify(el.body));

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
    const zu = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForFunction(() => !document.querySelector('.main .loading')); await sleep(700); };
    const notizOeffnen = async (p, id) => {
      await zu(p, '/notes/' + id);
      await p.waitForSelector('.notiz-editor .ql-editor');
      await p.waitForFunction(() => /Gespeichert|Nur lesen|lesen/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 }).catch(() => {});
      await sleep(400);
    };
    const menue = async (p) => { await p.click('#notiz-mehr'); await p.waitForSelector('.modal-overlay [data-val]'); await sleep(200);
      return p.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val)); };
    const waehlen = (p, val) => p.evaluate(v => document.querySelector(`.modal-overlay [data-val="${v}"]`).click(), val);
    const eintraege = (p) => p.evaluate(() => [...document.querySelectorAll('.notiz-erinnerungen-dialog .erinnerung-eintrag')].map(li => li.textContent.replace(/\s+/g, ' ').trim()));
    const zeile = (p) => p.evaluate(() => { const z = document.getElementById('notiz-erinnerung-zeile'); return z && !z.hidden ? z.textContent.replace(/\s+/g, ' ').trim() : null; });
    const kartenZeile = (p, id) => p.evaluate((i) => { const k = document.querySelector(`.note-card[data-id="${i}"] .note-erinnerung`); return k ? k.textContent.replace(/\s+/g, ' ').trim() : null; }, id);
    const coin = (p) => p.evaluate(() => { const b = document.getElementById('nav-badge-notes'); return b && b.style.display !== 'none' ? b.textContent.trim() : '0'; });

    // Lena meldet sich gleich an, schaut einmal in die Notizen und bleibt dann auf der Startseite
    const L = await neueSeite();
    await anmelden(L, 'lena');
    await zu(L, '/notes'); await zu(L, '/welcome');

    console.log('A · Eigentümerin stellt eine Erinnerung in der Notiz');
    const O = await neueSeite();
    await anmelden(O, 'olga');
    await notizOeffnen(O, n1);
    ok('vorher keine Zeile „Deine Erinnerung"', (await zeile(O)) === null);
    const eintraegeMenue = await menue(O);
    ok('⋯ enthält „🔔 Erinnern"', eintraegeMenue.includes('erinnern'), JSON.stringify(eintraegeMenue));
    await waehlen(O, 'erinnern');
    await O.waitForSelector('.notiz-erinnerungen-dialog'); await sleep(500);
    ok('Dialog „Meine Erinnerungen" mit Titel und „nur für dich", noch leer', await O.evaluate(() => {
      const d = document.querySelector('.notiz-erinnerungen-dialog'); const t = d.textContent.replace(/\s+/g, ' ');
      return /Meine Erinnerungen/.test(t) && /Angebot Gartenhütte · nur für dich/.test(t) && /Noch keine Erinnerung/.test(t); }));
    await O.click('.notiz-erinnerungen-dialog [data-act="erinnern"]');
    await O.waitForSelector('.erinnerung-form #ef-datum'); await sleep(300);
    const vorbelegt = await O.evaluate(() => [document.getElementById('ef-datum').value, document.getElementById('ef-uhr').value]);
    ok('Formular: morgen, um den Arbeitsbeginn (07:00)', vorbelegt[0] === plus(HEUTE, 1) && vorbelegt[1] === '07:00', JSON.stringify(vorbelegt));
    await O.click('.erinnerung-form [data-tage="28"]');
    await O.type('#ef-hinweis', 'Angebot bis Freitag fertig');
    await O.click('.erinnerung-form [data-act="ok"]'); await sleep(900);
    let e = await eintraege(O);
    ok('gestellt: steht im Dialog mit Zeit und Hinweis', e.length === 1 && e[0].includes(umText(plus(HEUTE, 28), '07:00')) && e[0].includes('Angebot bis Freitag fertig'), JSON.stringify(e));
    await O.click('.notiz-erinnerungen-dialog [data-act="zu"]'); await sleep(400);
    ok('unter dem Titel: „🔔 Deine Erinnerung: …"', (await zeile(O)) === '🔔 Deine Erinnerung: ' + umText(plus(HEUTE, 28), '07:00'), await zeile(O));
    await O.click('#notiz-erinnerung-zeile');
    await O.waitForSelector('.notiz-erinnerungen-dialog .erinnerung-eintrag'); await sleep(300);
    await O.click('.notiz-erinnerungen-dialog [data-e="aendern"]');
    await O.waitForSelector('.erinnerung-form'); await sleep(250);
    await O.evaluate(() => { document.getElementById('ef-uhr').value = '08:15'; });
    await O.click('.erinnerung-form [data-act="ok"]'); await sleep(900);
    ok('Zeile antippen → Dialog, Ändern → neue Uhrzeit in Dialog und Zeile', (await eintraege(O))[0].includes(umText(plus(HEUTE, 28), '08:15'))
      && (await zeile(O)) === '🔔 Deine Erinnerung: ' + umText(plus(HEUTE, 28), '08:15'), JSON.stringify([await eintraege(O), await zeile(O)]));
    await O.click('.notiz-erinnerungen-dialog [data-act="zu"]'); await sleep(300);

    console.log('B · Übersicht');
    await O.evaluate(() => document.getElementById('notiz-fertig').click()); await sleep(1200);
    if (!/#\/notes$/.test(await O.evaluate(() => location.hash))) await zu(O, '/notes');
    await O.waitForSelector('.note-card'); await sleep(500);
    ok('Karte: „🔔 Datum, Uhrzeit" — die nächste eigene', (await kartenZeile(O, n1)) === '🔔 ' + umText(plus(HEUTE, 28), '08:15'), await kartenZeile(O, n1));
    ok('… an der anderen Karte nichts', (await kartenZeile(O, n2)) === null);

    console.log('C · Leserin');
    const L2 = await neueSeite();
    await anmelden(L2, 'lena');
    await zu(L2, '/notes'); await L2.waitForSelector('.note-card'); await sleep(400);
    ok('an Olgas Notiz sieht Lena nur IHRE eigene Erinnerung, nicht Olgas', (await kartenZeile(L2, n1)) === '🔔 ' + umText(um.slice(0, 10), um.slice(11, 16)), await kartenZeile(L2, n1));
    await notizOeffnen(L2, n1);
    ok('nur lesend — und trotzdem „🔔 Erinnern" im Menü', (await menue(L2)).includes('erinnern'));
    await L2.evaluate(() => document.querySelector('.modal-overlay [data-act="cancel"]').click()); await sleep(200);
    await zu(L2, '/welcome');

    console.log('D · Handy');
    const H = await neueSeite(true);
    await anmelden(H, 'olga');
    await notizOeffnen(H, n1);
    await H.click('#notiz-erinnerung-zeile');
    await H.waitForSelector('.notiz-erinnerungen-dialog .erinnerung-eintrag'); await sleep(400);
    const passt = await H.evaluate(() => { const m = document.querySelector('.notiz-erinnerungen-dialog .modal').getBoundingClientRect();
      return { links: Math.round(m.left), rechts: Math.round(m.right), seite: document.documentElement.scrollWidth }; });
    ok('Dialog passt auf 390 px, keine seitliche Scrollleiste', passt.links >= 0 && passt.rechts <= 390 && passt.seite <= 390, JSON.stringify(passt));

    console.log('E · Der Zeitplaner erinnert, Antippen führt zur Notiz');
    let gekommen = false;
    for (let i = 0; i < 170 && !gekommen; i++) {
      const b = (await req('GET', '/api/badges', t.lena)).body || {};
      gekommen = b.notizErinnerungen >= 1;
      if (!gekommen) await sleep(1000);
    }
    ok('der echte Zeitplaner hat Lenas Erinnerung ausgelöst', gekommen);
    await L.waitForFunction(() => { const b = document.getElementById('nav-badge-notes'); return b && b.style.display !== 'none' && b.textContent.trim() === '1'; }, { timeout: 10000 }).catch(() => {});
    ok('Coin „1" bei Lena (Notizen) — live, ohne Neuladen', (await coin(L)) === '1', await coin(L));
    ok('… bei Olga kommt davon nichts an', (await req('GET', '/api/badges', t.olga)).body.notizErinnerungen === 0);
    // Antippen der Push: der Hintergrunddienst schickt der App diese Nachricht (wie bei jeder Meldung seit R30)
    await L.evaluate((z) => { navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { typ: 'meldung-geklickt', url: '/#/notes', ziel: z } })); }, { art: 'notiz', id: n1 });
    await L.waitForFunction((id) => { const k = document.querySelector(`.note-card[data-id="${id}"]`); return k && k.classList.contains('ziel-hervor'); }, { timeout: 8000 }, n1).catch(() => {});
    const karte = (p) => p.evaluate((id) => { const k = document.querySelector(`.note-card[data-id="${id}"]`);
      return k && { hervor: k.classList.contains('ziel-hervor'), markiert: k.classList.contains('note-card--unread'), marke: (k.querySelector('.note-marke') || {}).textContent || null }; }, n1);
    const k1 = await karte(L);
    ok('Antippen → Notizen, die Notiz hervorgehoben, mit „🔔 Erinnerung" gekennzeichnet', await L.evaluate(() => location.hash) === '#/notes' && k1 && k1.hervor && k1.markiert && k1.marke === '🔔 Erinnerung',
      JSON.stringify(k1));
    ok('… die andere Notiz nicht', await L.evaluate((id) => !document.querySelector(`.note-card[data-id="${id}"] .note-marke`), n2));
    // Stilles Auffrischen (jemand ändert eine andere Notiz) darf die Marke nicht wegnehmen
    await req('PUT', `/api/notes/${n2}`, t.olga, { title: 'Einkaufsliste Baumarkt' });
    await L.waitForFunction(() => [...document.querySelectorAll('.note-card .note-title')].some(x => /Baumarkt/.test(x.textContent)), { timeout: 8000 }).catch(() => {});
    const k2 = await karte(L);
    ok('… und die Marke bleibt, wenn sich die Liste still auffrischt', await L.evaluate(() => [...document.querySelectorAll('.note-card .note-title')].some(x => /Baumarkt/.test(x.textContent)))
      && k2 && k2.marke === '🔔 Erinnerung', JSON.stringify(k2));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nNotiz-Erinnerungen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
