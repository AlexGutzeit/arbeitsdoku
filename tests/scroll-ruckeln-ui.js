// Puppeteer-Test: Beim Scrollen darf die Seite NICHT zurückspringen.
//
// Hintergrund: Die Willkommensseite hat eine Uhr, die im Sekundentakt ihren Text ändert. Das ist eine
// DOM-Änderung innerhalb von #app — und der Beobachter aus B10 (Ansicht erhalten) stellt danach die
// zuletzt GEMERKTE Scrollposition wieder her. Gemerkt wird aber nur entschärft (120 ms), also ist der
// Wert beim Scrollen veraltet → die Seite hüpft um genau diese 120 ms Bewegung zurück.
// Zusätzlich lief bei jedem Merken ein querySelectorAll über alle <details> und Scrollboxen — waehrend
// des Scrollens spürbar.
// Start: node tests/scroll-ruckeln-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3142, DB = '/tmp/scrollruckeln.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const today = new Date().toLocaleDateString('sv-SE');
const morgenISO = new Date(Date.now() + 864e5).toLocaleDateString('sv-SE');

// Ermittelt, WAS auf dieser Seite scrollt: das Dokument oder ein innerer Bereich.
const scrollTraeger = p => p.evaluate(() => {
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollHeight - doc.clientHeight > 80) return { art: 'seite', weite: doc.scrollHeight - doc.clientHeight };
  const k = [...document.querySelectorAll('.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll, .main')];
  for (const el of k) {
    if (el.scrollHeight - el.clientHeight > 80) return { art: 'innen', sel: el.className, achse: 'y', weite: el.scrollHeight - el.clientHeight };
    if (el.scrollWidth - el.clientWidth > 80) return { art: 'innen', sel: el.className, achse: 'x', weite: el.scrollWidth - el.clientWidth };
  }
  return { art: 'keiner' };
});
const _finde = `(t) => t.art === 'seite' ? (document.scrollingElement || document.documentElement)
  : [...document.querySelectorAll('.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll, .main')].find(e => e.className === t.sel)`;

async function scrollProbe(p, label) {
  let t = await scrollTraeger(p);
  // Kurze Seiten (z. B. Benachrichtigungen ohne aktiven Push-Dienst) passen ganz ins Fenster.
  // Dann das Fenster verkleinern, statt die Pruefung auszulassen — die Mechanik haengt nicht von
  // der Fenstergroesse ab, aber ein Test, bei dem sich nichts bewegt, beweist nichts.
  let verkleinert = false;
  for (const h of [260, 200]) {
    if (t.art !== 'keiner') break;
    await p.setViewport({ width: 390, height: h, isMobile: true, hasTouch: true });
    await sleep(700);
    verkleinert = true;
    t = await scrollTraeger(p);
  }
  if (verkleinert && t.art !== 'keiner') label += ' (kleines Fenster)';
  if (t.art === 'keiner') { ok(`${label}: scrollbarer Inhalt vorhanden`, false, 'nichts scrollbar — Test wäre wertlos'); return; }
  await p.evaluate((t, code) => {
    const el = eval(code)(t);
    window._ziel = el; window._achse = t.achse === 'x' ? 'scrollLeft' : 'scrollTop';
    window._spruenge = []; window._letzte = el[window._achse];
    (t.art === 'seite' ? window : el).addEventListener('scroll', () => {
      const y = window._ziel[window._achse];
      if (y < window._letzte - 4) window._spruenge.push({ von: Math.round(window._letzte), nach: Math.round(y) });
      window._letzte = y;
    }, { passive: true });
  }, t, _finde);
  for (let i = 0; i < 30; i++) { await p.evaluate(() => { window._ziel[window._achse] += 60; }); await sleep(90); }
  await sleep(1600);
  const r = await p.evaluate(() => ({ s: window._spruenge, ende: Math.round(window._ziel[window._achse]) }));
  if (r.s.length) console.log('      Rücksprünge:', JSON.stringify(r.s.slice(0, 5)));
  ok(`${label}: kein Rücksprung (${t.art === 'seite' ? 'Seite' : 'Bereich ' + String(t.sel).split(' ')[0]})`,
    r.s.length === 0 && r.ende >= Math.min(100, t.weite - 10), `${r.s.length} Sprünge, Ende ${r.ende} von ${t.weite}`);
}
const morgen = new Date(Date.now() + 864e5).toLocaleDateString('sv-SE');

// Warten, bis die Seite lang genug ist — statt einmal nach festem Schlaf zu messen.
//
// Die Willkommensseite laedt ihre Karten (Wetter, Aushaenge, Termine) nach. Unter Suite-Last
// braucht das laenger als der feste Schlaf, die Seite ist dann noch kurz, und der Test faellt um,
// ohne dass irgendetwas kaputt waere — genau so geschehen am 25.08.2026. Die Zusicherung selbst
// bleibt scharf: Wird die Seite NIE lang genug, schlaegt sie weiterhin fehl.
async function warteAufHoehe(p, mindestens, maxMs = 20000) {
  const bis = Date.now() + maxMs;
  let hoehe = 0;
  while (Date.now() < bis) {
    hoehe = await p.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (hoehe > mindestens) return hoehe;
    await new Promise(r => setTimeout(r, 400));
  }
  return hoehe;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/scrollruckeln-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/scrollruckeln-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'scrollma', password: 'Test1234!', name: 'Scroll MA', role: 'mitarbeiter' })).body.user;
    // Genug Inhalt, damit die Willkommensseite lang genug zum Scrollen wird
    for (let i = 1; i <= 12; i++) {
      await req('POST', '/api/bulletin', admin, { title: 'Aushang ' + i, text: 'Text für Aushang Nummer ' + i });
      await req('POST', '/api/planning', admin, { days: [{ date: i % 2 ? today : morgen, time_from: '07:00', time_to: '15:00' }],
        client: 'Kunde ' + i, address: 'Strasse ' + i, assigned_user_ids: [ma.id] });
    }
    // Genug Inhalt fuer JEDE Seite — sonst ist der Test dort wertlos (siehe Prod-Klon: dort hatten
    // mehrere Seiten zu wenig Daten und die Pruefung bewies nichts).
    for (let i = 1; i <= 25; i++) {
      await req('POST', '/api/orders', admin, { product: 'Material Position ' + i, quantity: i, unit: 'St' });
      await req('POST', '/api/notes', admin, { title: 'Notiz ' + i, body: 'Inhalt der Notiz ' + i });
      await req('POST', '/api/tools', admin, { name: 'Werkzeug ' + i });
      await req('POST', '/api/users', admin, { username: 'user' + i, password: 'Test1234!', name: 'Testperson ' + i, role: 'mitarbeiter' });
    }
    // Geplante Zusammenfassungen: sonst ist die Benachrichtigungen-Seite zu kurz zum Scrollen
    // (Push selbst gibt es im Testbrowser nicht) und die Pruefung dort waere wertlos.
    for (let i = 1; i <= 14; i++) {
      await req('POST', '/api/push/summaries', admin, { name: 'Zusammenfassung ' + i, weekdays: [1, 2, 3, 4, 5], time: '18:00', cats: ['planning'] });
    }
    for (let i = 1; i <= 20; i++) {
      const pr = (await req('POST', '/api/projects', admin, { name: 'Auftrag ' + i, client: 'Kunde ' + i })).body.project;
      if (pr && i % 2 === 0) await req('DELETE', '/api/projects/' + pr.id, admin, { reason: 'Test' });
      const e = (await req('POST', '/api/entries', admin, { date: today, time_from: '07:00', time_to: '08:00', client: 'Kunde ' + i, user_id: ma.id })).body.entry;
      if (e) await req('DELETE', '/api/entries/' + e.id, admin, { reason: 'Testlöschung ' + i });
      const tage = new Date(Date.now() + (i + 40) * 864e5).toLocaleDateString('sv-SE');
      const ab = (await req('POST', '/api/absences', admin, { type: 'urlaub', date_from: tage, date_to: tage, target_user_id: ma.id, comment: 'Test ' + i })).body;
      if (ab && ab.absence) await req('DELETE', '/api/absences/' + ab.absence.id, admin, { reason: 'Testlöschung' });
    }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    // Ohne erlaubte Benachrichtigungen zeigt die Benachrichtigungen-Seite nur „Im Browser blockiert"
    // und ist zu kurz zum Scrollen — die Pruefung waere dort wertlos.
    await browser.defaultBrowserContext().overridePermissions(BASE, ['notifications']);
    const p = await browser.newPage();
    await p.setViewport({ width: 390, height: 700, isMobile: true, hasTouch: true });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(800);

    console.log('Willkommensseite:');
    await p.evaluate(() => { location.hash = '#/welcome'; });
    await sleep(3000);
    const hoehe = await warteAufHoehe(p, 400);
    ok('Seite ist lang genug zum Scrollen', hoehe > 400, 'scrollbar um ' + hoehe + ' px');
    ok('die Uhr tickt (Auslöser des Problems)', await p.evaluate(() => !!document.getElementById('welcome-clock')));

    await scrollProbe(p, 'Willkommen');

    // ── ALLE Seiten, jede mit genug Inhalt ────────────────────────────────
    console.log('Alle weiteren Seiten:');
    // Kleineres Fenster: sonst sind kurze Seiten (z. B. Benachrichtigungen) gar nicht scrollbar
    // und die Pruefung dort waere wertlos.
    await p.setViewport({ width: 390, height: 380, isMobile: true, hasTouch: true }); await sleep(600);
    for (const [hash, label] of [
      ['#/', 'Zeitnachweis'], ['#/planning', 'Planung'], ['#/projects', 'Aufträge'],
      ['#/users', 'Mitarbeiter'], ['#/tools', 'Werkzeuge'], ['#/orders', 'Bestellungen'],
      ['#/notes', 'Notizen'], ['#/bulletin', 'Schwarzes Brett'], ['#/absences', 'Abwesenheiten'],
      ['#/statistics', 'Statistik'], ['#/notifications', 'Benachrichtigungen'],
      ['#/settings', 'Einstellungen'], ['#/audit', 'Audit-Log'],
      ['#/deleted-entries', 'Papierkorb: Einträge'], ['#/deleted-absences', 'Papierkorb: Abwesenheiten'],
      ['#/deleted-projects', 'Papierkorb: Aufträge'],
    ]) {
      await p.evaluate(h => { location.hash = h; }, hash);
      await sleep(2600);
      await scrollProbe(p, label);
    }

    // Und die Ansicht muss trotzdem noch erhalten bleiben (B10 darf nicht kaputtgehen):
    console.log('Ansicht bleibt trotzdem erhalten:');
    await p.setViewport({ width: 390, height: 700, isMobile: true, hasTouch: true }); await sleep(500);
    await p.evaluate(() => { location.hash = '#/welcome'; }); await sleep(2600);
    await p.evaluate(() => window.scrollTo(0, 250)); await sleep(700);
    const vorher = await p.evaluate(() => Math.round(window.scrollY));
    await p.evaluate(() => renderWelcome());
    await sleep(2200);
    const nachher = await p.evaluate(() => Math.round(window.scrollY));
    ok('Scrollposition überlebt einen Neuaufbau', Math.abs(nachher - vorher) < 60, `${vorher} → ${nachher}`);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nScroll-Ruckeln: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
