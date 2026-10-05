// Profilbild an den Stellen, die am 05.10.2026 dazugekommen sind (Alex: „konsistent auch in der Wochen- und
// Monatsansicht" + Vorschläge 1–7):
//
//   1  Planung Woche und Monat — Spaltenkopf wie in der Tagesansicht
//   2  Menükopf — rechts neben Name und Rolle, führt nach „Mein Konto"
//   3  Abwesenheitskalender — Namensspalte
//   4  Abwesenheitsanträge — beim Antragsteller
//   5  Planungsformular — Mitarbeiter-Auswahl
//   6  Meldungen — „Gemeldet von" an Karte und im Detail
//   7  Schwarzes Brett — Verfasser am Aushang (Brett und Willkommensseite)
//   +  Zeitnachweis Woche und Monat (Alex' Nachtrag) — wie dessen Tagesansicht, beim Mitarbeiter selbst ohne Bild
//
// Die Regel, um die es eigentlich geht: In Spalten, Menü und Formular (1, 2, 3, 5) bleibt ohne Bild ALLES
// wie bisher — der Platzhalter ist unsichtbar und nimmt keinen Platz ein. In Listen (4, 6, 7) steht ohne
// Bild ein Kreis mit Initialen, sonst stünden Namen mit und ohne Bild durcheinander.
// Geprüft wird deshalb immer beides: eine Person MIT Bild (Max, Chef) und eine OHNE (Erika, Admin).
//
//   node tests/avatar-orte-ui.js            (Bildschirmfotos: AVATAR_FOTOS=<ordner>)
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3368, DB = '/tmp/avatar-orte-ui.db', BASIS = `http://localhost:${PORT}`;
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const FOTOS = process.env.AVATAR_FOTOS || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Multipart von Hand — wie in avatar-api.js
function hochladen(token, buf) {
  const rand = '----ad' + Date.now();
  const koerper = Buffer.concat([
    Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="bild"; filename="bild.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf, Buffer.from(`\r\n--${rand}--\r\n`)]);
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': koerper.length } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s.slice(0, 150) })); });
    r.on('error', rej); r.write(koerper); r.end();
  });
}

// Alle Avatare unter `sel`: wessen (title), mit Bild?, sichtbar?, Breite, Initialen.
const avatareUnter = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map(el => {
  const st = getComputedStyle(el);
  return { wer: el.getAttribute('title'), bild: /blob:/.test(st.backgroundImage), sichtbar: st.display !== 'none',
           breite: Math.round(el.getBoundingClientRect().width), text: el.textContent.trim() };
}), sel);
const von = (liste, name) => liste.filter(a => a.wer === name);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  if (FOTOS) fs.mkdirSync(FOTOS, { recursive: true });
  const bild = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();

  const lg = fs.openSync('/tmp/avatar-orte-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/avatar-orte-ui-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const login = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body;

    // ── Daten ──
    const admin = (await login('admin', pw('admin'))).token;
    const chef = await login('chef', pw('chef'));
    const max = await login('max', pw('max'));
    const erika = (await req('POST', '/api/users', admin, {
      username: 'erika', password: 'Start!2345', name: 'Erika Beispiel', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
    })).body.user;
    const erikaT = (await login('erika', 'Start!2345')).token;
    ok('Bild für Max hochgeladen', (await hochladen(max.token, bild)).status < 300);
    ok('Bild für den Chef hochgeladen', (await hochladen(chef.token, bild)).status < 300);

    const heute = new Date().toLocaleDateString('sv-SE');
    for (const u of [max.user.id, erika.id]) {
      await req('POST', '/api/planning', admin, { date: heute, time_from: '07:00', time_to: '15:30', description: 'Baustelle', assigned_user_ids: [u] });
      // Ohne Eintrag zeichnet der Zeitnachweis am Tag gar keine Spalten (dieselbe Falle wie in avatar-ui.js)
      await req('POST', '/api/entries', admin, { user_id: u, date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'Arbeit' });
    }
    ok('Max beantragt Urlaub', (await req('POST', '/api/absences', max.token, { type: 'urlaub', date_from: heute, date_to: heute })).status < 300);
    ok('Erika beantragt Urlaub', (await req('POST', '/api/absences', erikaT, { type: 'urlaub', date_from: heute, date_to: heute })).status < 300);
    const thema = (await req('POST', '/api/meldungen/themen', admin, { name: 'Auto 2' })).body.thema.id;
    const mMax = await req('POST', '/api/meldungen', max.token, { thema_id: thema, text: 'Ölwechsel fällig' });
    ok('Max meldet etwas', mMax.status === 201, `${mMax.status} ${mMax.text.slice(0, 80)}`);
    ok('… die Meldung trägt melder_id (für das Bild)', mMax.body && mMax.body.meldung && mMax.body.meldung.melder_id === max.user.id,
      JSON.stringify(mMax.body && mMax.body.meldung && mMax.body.meldung.melder_id));
    ok('Erika meldet etwas', (await req('POST', '/api/meldungen', erikaT, { thema_id: thema, text: 'Wischer quietscht' })).status === 201);
    const aChef = await req('POST', '/api/bulletin', chef.token, { title: 'Grillfest', text: 'Freitag ab 15 Uhr' });
    ok('Chef hängt aus', aChef.status < 300 && aChef.body.entry && aChef.body.entry.author_id === chef.user.id,
      `${aChef.status} ${JSON.stringify(aChef.body && aChef.body.entry && aChef.body.entry.author_id)}`);
    ok('Admin hängt aus', (await req('POST', '/api/bulletin', admin, { title: 'Neue Schlüssel', text: 'im Büro' })).status < 300);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultTimeout(45000);
    const fehler = [];
    page.on('pageerror', e => fehler.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fehler.push(m.text()); });
    const anmelden = async (u, p) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', u); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await sleep(2200);
    };
    const foto = async (name, p = page) => { if (FOTOS) await p.screenshot({ path: path.join(FOTOS, name + '.png') }); };
    const gehe = async (route) => { await page.goto(BASIS + '/#' + route, { waitUntil: 'domcontentloaded' }); await sleep(2200); };

    // Leer-Regel: Max mit Bild sichtbar, Erika unsichtbar und ohne Platz
    const leerRegel = (titel, liste) => {
      const m = von(liste, 'Max Mustermann'), e = von(liste, 'Erika Beispiel');
      ok(`${titel}: Max zeigt sein Bild`, m.length > 0 && m.every(a => a.bild && a.sichtbar), JSON.stringify(m));
      ok(`${titel}: … Erika (ohne Bild) unsichtbar und ohne Platz — wie bisher`,
        e.length > 0 && e.every(a => !a.sichtbar && a.breite === 0 && a.text === ''), JSON.stringify(e));
    };
    // Initialen-Regel in Listen
    const listenRegel = (titel, liste, mitBild, ohneBild, initialen) => {
      const m = von(liste, mitBild), o = von(liste, ohneBild);
      ok(`${titel}: ${mitBild} zeigt das Bild`, m.length > 0 && m.every(a => a.bild && a.sichtbar), JSON.stringify(m));
      ok(`${titel}: … ${ohneBild} (ohne Bild) bekommt Initialen „${initialen}"`,
        o.length > 0 && o.every(a => !a.bild && a.sichtbar && a.text === initialen && a.breite > 10), JSON.stringify(o));
    };

    await anmelden('chef', pw('chef'));

    console.log('── 1) Planung: Woche und Monat wie die Tagesansicht ──');
    await gehe('/planning');
    leerRegel('Tag (wie bisher)', await avatareUnter(page, '.tl-col-header-name .avatar'));
    await page.click('[data-pview="week"]'); await sleep(1500);
    leerRegel('Woche', await avatareUnter(page, '.week-month-grid th.grid-col-header .avatar'));
    await foto('1-woche');
    await page.click('[data-pview="month"]'); await sleep(1500);
    leerRegel('Monat', await avatareUnter(page, '.week-month-grid th.grid-col-header .avatar'));
    await foto('1-monat');
    await page.click('[data-pview="day"]'); await sleep(800);

    console.log('\n── + Zeitnachweis: Woche und Monat wie die Tagesansicht ──');
    await gehe('/');
    leerRegel('Zeitnachweis Tag (wie bisher)', await avatareUnter(page, '.tl-col-header-name .avatar'));
    await page.click('[data-view="week"]'); await sleep(1500);
    leerRegel('Zeitnachweis Woche', await avatareUnter(page, '.week-month-grid th.grid-col-header .avatar'));
    await foto('z-woche');
    await page.click('[data-view="month"]'); await sleep(1500);
    leerRegel('Zeitnachweis Monat', await avatareUnter(page, '.week-month-grid th.grid-col-header .avatar'));
    await page.click('[data-view="day"]'); await sleep(800);

    console.log('\n── 5) Planungsformular: Mitarbeiter-Auswahl ──');
    await gehe('/planning/new');
    await page.waitForSelector('.planning-user-checkboxes');
    leerRegel('Auswahl', await avatareUnter(page, '.planning-user-checkboxes .avatar'));
    await foto('5-formular');

    console.log('\n── 3) Abwesenheitskalender ──');
    await gehe('/absences');
    await page.click('.absence-tab[data-tab="kalender"]'); await sleep(1800);
    leerRegel('Kalender', await avatareUnter(page, '.abscal-name .avatar'));
    const namen = await page.$$eval('.abscal-name', els => els.map(e => e.textContent.trim()));
    ok('… die Namen stehen weiter vollständig da', namen.includes('Max Mustermann') && namen.includes('Erika Beispiel'), JSON.stringify(namen));
    await foto('3-kalender');

    console.log('\n── 4) Abwesenheitsanträge ──');
    await page.click('.absence-tab[data-tab="list"]'); await sleep(1500);
    listenRegel('Anträge', await avatareUnter(page, '.absence-user .avatar'), 'Max Mustermann', 'Erika Beispiel', 'EB');
    await foto('4-antraege');

    console.log('\n── 6) Meldungen ──');
    await gehe('/meldungen');
    listenRegel('Karte', await avatareUnter(page, '.mld-meta .avatar'), 'Max Mustermann', 'Erika Beispiel', 'EB');
    await foto('6-meldungen');
    // Das Detail ist ein Dialog am <body> — den sieht das automatische Nachladen nicht
    await page.evaluate(() => [...document.querySelectorAll('.mld-karte')].find(k => /Ölwechsel/.test(k.textContent)).click());
    await page.waitForSelector('.mld-detail'); await sleep(1500);
    const imDetail = await avatareUnter(page, '.mld-detail .mld-meta .avatar');
    ok('Detail: „Gemeldet von" mit Max\' Bild (auch im Dialog nachgeladen)',
      von(imDetail, 'Max Mustermann').length === 1 && von(imDetail, 'Max Mustermann')[0].bild, JSON.stringify(imDetail));
    await foto('6-detail');
    await page.keyboard.press('Escape'); await sleep(500);

    console.log('\n── 7) Schwarzes Brett und Willkommensseite ──');
    await gehe('/bulletin');
    listenRegel('Brett', await avatareUnter(page, '.bulletin-meta .avatar'), 'Chef', 'Administrator', 'AD');
    await foto('7-brett');
    await gehe('/welcome');
    listenRegel('Willkommen', await avatareUnter(page, '.welcome-bulletin-meta .avatar'), 'Chef', 'Administrator', 'AD');

    console.log('\n── 2) Menükopf ──');
    // Das Menü ist auch am großen Bildschirm eine Schublade — erst aufklappen, sonst misst man außerhalb des Bilds
    await page.click('#menu-btn'); await sleep(900);
    const kopfChef = await page.evaluate(() => {
      const a = document.getElementById('menue-avatar'); const v = a && a.querySelector('.avatar');
      return a && { link: getComputedStyle(a).display, ziel: a.getAttribute('href'),
                    bild: !!v && /blob:/.test(getComputedStyle(v).backgroundImage), breite: v ? Math.round(v.getBoundingClientRect().width) : 0 };
    });
    ok('Chef: Bild im Menükopf, 44 px', kopfChef && kopfChef.link !== 'none' && kopfChef.bild && kopfChef.breite === 44, JSON.stringify(kopfChef));
    ok('… und es führt nach „Mein Konto"', kopfChef && kopfChef.ziel === '#/konto');
    const reihe = await page.evaluate(() => {
      const t = document.querySelector('.sidebar-kopf-text').getBoundingClientRect(), a = document.getElementById('menue-avatar').getBoundingClientRect();
      return { textRechts: Math.round(t.right), bildLinks: Math.round(a.left), mitteText: Math.round(t.top + t.height / 2), mitteBild: Math.round(a.top + a.height / 2) };
    });
    ok('… rechts neben Name und Rolle, auf einer Höhe', reihe.bildLinks >= reihe.textRechts && Math.abs(reihe.mitteText - reihe.mitteBild) <= 4, JSON.stringify(reihe));
    const sichtbar = await page.evaluate(() => { const r = document.getElementById('menue-avatar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    ok('… und im aufgeklappten Menü wirklich zu sehen', sichtbar);
    await foto('2-menue-gross');
    await page.click('#menue-avatar'); await sleep(1500);
    ok('… ein Klick öffnet „Mein Konto"', await page.evaluate(() => location.hash === '#/konto'));
    ok('… und die Schublade geht dabei zu', await page.evaluate(() => !document.getElementById('sidebar').classList.contains('open')));

    await anmelden('admin', pw('admin'));
    const kopfAdmin = await page.evaluate(() => {
      const a = document.getElementById('menue-avatar');
      return a && { link: getComputedStyle(a).display, kopfText: document.querySelector('.sidebar-header').innerText.replace(/\s+/g, ' ').trim() };
    });
    ok('Admin (ohne Bild): kein Link, kein leerer Kreis, kein Tab-Stopp — der Kopf wie bisher',
      kopfAdmin && kopfAdmin.link === 'none' && kopfAdmin.kopfText === 'Administrator Administrator'   /* Name + Rolle, sonst nichts */, JSON.stringify(kopfAdmin));

    // Am Handy: das aufgeklappte Menü, wie auf Alex' Bildschirmfoto
    const handy = await browser.newPage();
    await handy.setViewport({ width: 400, height: 850, deviceScaleFactor: 2 });
    await handy.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await handy.evaluate(() => localStorage.clear());
    await handy.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await handy.waitForSelector('#login-user');
    await handy.type('#login-user', 'max'); await handy.type('#login-pass', pw('max'));
    await handy.click('#login-form button[type="submit"]'); await sleep(2500);
    await handy.click('#menu-btn'); await sleep(900);
    const handyKopf = await handy.evaluate(() => {
      const a = document.getElementById('menue-avatar'); const v = a.querySelector('.avatar'); const r = a.getBoundingClientRect();
      return { bild: /blob:/.test(getComputedStyle(v).backgroundImage), imBild: r.left >= 0 && r.right <= innerWidth };
    });
    ok('Handy: im aufgeklappten Menü steht Max\' Bild', handyKopf.bild && handyKopf.imBild, JSON.stringify(handyKopf));
    await foto('2-menue-handy', handy);
    await handy.keyboard.press('Escape'); await sleep(300);
    await handy.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    for (const v of ['week', 'month']) {
      await handy.click(`[data-view="${v}"]`); await sleep(1500);
      const eigen = await avatareUnter(handy, '.week-month-grid th.grid-col-header .avatar');
      ok(`Zeitnachweis ${v === 'week' ? 'Woche' : 'Monat'} als Max selbst: nur die eigene Spalte, kein Bild — wie „Meine Einträge" am Tag`,
        eigen.length === 0, JSON.stringify(eigen));
    }
    await handy.close();

    console.log('\n── Hochladen: der Menükopf zieht ohne Neuladen mit ──');
    await anmelden('erika', 'Start!2345');
    ok('vorher: Erika hat keinen Bild-Link im Menükopf',
      await page.evaluate(() => getComputedStyle(document.getElementById('menue-avatar')).display === 'none'));
    await gehe('/konto');
    await page.waitForSelector('#avatar-datei');
    const datei = '/tmp/avatar-orte-ui-bild.png'; fs.writeFileSync(datei, bild);
    await (await page.$('#avatar-datei')).uploadFile(datei);
    await page.waitForSelector('.zuschnitt-modal [data-act="ok"]:not([disabled])', { timeout: 20000 }); await sleep(400);
    await page.click('.zuschnitt-modal [data-act="ok"]'); await sleep(3000);
    ok('nachher: Bild im Menükopf, ohne die Seite neu zu laden', await page.evaluate(() => {
      const a = document.getElementById('menue-avatar'); const v = a && a.querySelector('.avatar');
      return getComputedStyle(a).display !== 'none' && /blob:/.test(getComputedStyle(v).backgroundImage);
    }));
    ok('„Mein Konto" nennt die neuen Stellen', /Abwesenheitskalender und bei deinen Anträgen,\s+Meldungen und Aushängen/.test(
      await page.evaluate(() => document.body.innerText)));

    ok('keine JavaScript-Fehler', fehler.length === 0, fehler.slice(0, 3).join(' | '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nAvatare an weiteren Stellen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
