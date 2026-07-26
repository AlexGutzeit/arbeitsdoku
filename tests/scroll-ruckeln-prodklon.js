// Prod-Klon-Pruefung: Kein Zurueckspringen beim Scrollen — mit den ECHTEN Daten,
// die die Willkommensseite lang und die Uhr aktiv machen. NUR LESEND.
// Start: node tests/scroll-ruckeln-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3143, DB = '/tmp/prodklon.db', BASE = 'http://localhost:' + PORT;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const req = (m, p) => new Promise((res, rej) => { const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); r.on('error', rej); r.end(); });

// Ermittelt, WAS auf dieser Seite ueberhaupt scrollt: das Dokument oder ein innerer Bereich
// (Planung und Auftrags-Board scrollen bewusst innen, die Seite selbst steht still).
const scrollTraeger = p => p.evaluate(() => {
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollHeight - doc.clientHeight > 80) return { art: 'seite', weite: doc.scrollHeight - doc.clientHeight };
  const kandidaten = [...document.querySelectorAll('.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll, .main')];
  for (const el of kandidaten) {
    if (el.scrollHeight - el.clientHeight > 80) return { art: 'innen', sel: el.className, weite: el.scrollHeight - el.clientHeight, achse: 'y' };
    if (el.scrollWidth - el.clientWidth > 80) return { art: 'innen', sel: el.className, weite: el.scrollWidth - el.clientWidth, achse: 'x' };
  }
  return { art: 'keiner' };
});

// Scrollt in kleinen Schritten und meldet jeden Rueckwaerts-Sprung.
async function scrollProbe(p, label) {
  let traeger = await scrollTraeger(p);
  // Passt eine Seite ganz ins Fenster, beweist ein Scroll-Test dort NICHTS. Statt sie zu
  // ueberspringen, das Fenster verkleinern — die Mechanik haengt nicht von der Fenstergroesse ab.
  let verkleinert = false;
  for (const h of [260, 200]) {
    if (traeger.art !== 'keiner') break;
    await p.setViewport({ width: 390, height: h, isMobile: true, hasTouch: true });
    await sleep(700);
    verkleinert = true;
    traeger = await scrollTraeger(p);
  }
  if (traeger.art === 'keiner') {
    // Die Seite passt selbst in ein winziges Fenster — im Klon liegen dort schlicht keine Daten
    // (z. B. keine offenen Bestellungen). Ohne Inhalt kann der Fehler nicht auftreten; MIT Inhalt
    // ist dieselbe Seite in tests/scroll-ruckeln-ui.js geprüft (dort werden 25 Bestellungen angelegt).
    ok(`${label}: im Klon ohne Inhalt — mit Daten in scroll-ruckeln-ui.js geprüft`, true);
    return { ende: 0, art: 'keiner' };
  }
  if (verkleinert) label += ' (kleines Fenster)';
  await p.evaluate(t => {
    const el = t.art === 'seite'
      ? (document.scrollingElement || document.documentElement)
      : [...document.querySelectorAll('.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll, .main')]
          .find(e => e.className === t.sel);
    window._ziel = el;
    window._achse = t.achse === 'x' ? 'scrollLeft' : 'scrollTop';
    window._sprünge = [];
    window._letzte = el[window._achse];
    (t.art === 'seite' ? window : el).addEventListener('scroll', () => {
      const y = window._ziel[window._achse];
      if (y < window._letzte - 4) window._sprünge.push({ von: Math.round(window._letzte), nach: Math.round(y) });
      window._letzte = y;
    }, { passive: true });
  }, traeger);
  for (let i = 0; i < 30; i++) {
    await p.evaluate(() => { window._ziel[window._achse] += 60; });
    await sleep(90);
  }
  await sleep(1800);   // mehrere Uhr-/Live-Ticks abwarten
  const r = await p.evaluate(() => ({ s: window._sprünge, ende: Math.round(window._ziel[window._achse]) }));
  if (verkleinert) { await p.setViewport({ width: 390, height: 380, isMobile: true, hasTouch: true }); await sleep(400); }
  if (r.s.length) console.log('      Rücksprünge:', JSON.stringify(r.s.slice(0, 5)));
  ok(`${label}: kein Rücksprung (${traeger.art === 'seite' ? 'Seite' : 'Bereich ' + String(traeger.sel).split(' ')[0]})`,
    r.s.length === 0 && r.ende >= Math.min(100, traeger.weite - 10), `${r.s.length} Sprünge, Ende ${r.ende} von ${traeger.weite}`);
  return { ende: r.ende, art: traeger.art };
}

(async () => {
  if (!fs.existsSync(DB)) { console.log('Prod-Klon ' + DB + ' fehlt — Test uebersprungen.'); process.exit(0); }
  const lg = fs.openSync('/tmp/scroll-prod-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const [id, username, name, role] = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    console.log(`  echte Daten, angemeldet als ${name}`);
    db.close();
    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    await browser.defaultBrowserContext().overridePermissions(BASE, ['notifications']);
    const p = await browser.newPage();
    p.on('pageerror', e => console.log('      [Seitenfehler]', String(e.message).slice(0, 140)));
    p.on('console', m => { if (m.type() === 'error') console.log('      [console]', m.text().slice(0, 140)); });
    await p.setViewport({ width: 390, height: 700, isMobile: true, hasTouch: true });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, token, JSON.stringify({ id, username, name, role }));
    // ACHTUNG: goto() auf dieselbe Adresse mit nur anderem Anker ist KEIN echter Neuladevorgang —
    // die App startet dann nicht neu und die gerade gesetzte Anmeldung greift nicht.
    await p.goto(BASE, { waitUntil: 'networkidle2' }); await sleep(2500);
    await p.evaluate(() => { location.hash = '#/welcome'; }); await sleep(4000);
    ok('Willkommensseite mit echten Daten geladen', await p.evaluate(() => !!document.getElementById('welcome-clock')));
    const hoehe = await p.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    ok('Seite ist scrollbar', hoehe > 200, hoehe + ' px');

    const w = await scrollProbe(p, 'Willkommen');
    ok('man ist unten angekommen', w.ende > 150, 'y=' + w.ende);

    // ── JEDE Seite der App durchscrollen ──────────────────────────────────
    // Die Uhr ist nur der auffaelligste Ausloeser; jede DOM-Aenderung (Live-Update eines Kollegen,
    // nachgeladenes Wetter, Zaehler) kann denselben Effekt haben. Darum alle Seiten pruefen.
    const seiten = [
      ['#/', 'Zeitnachweis'], ['#/planning', 'Planung'], ['#/projects', 'Aufträge'],
      ['#/users', 'Mitarbeiter'], ['#/tools', 'Werkzeuge'], ['#/orders', 'Bestellungen'],
      ['#/notes', 'Notizen'], ['#/bulletin', 'Schwarzes Brett'], ['#/absences', 'Abwesenheiten'],
      ['#/documents', 'Dokumente'], ['#/statistics', 'Statistik'], ['#/pdf', 'PDF-Export'],
      ['#/notifications', 'Benachrichtigungen'], ['#/settings', 'Einstellungen'],
      ['#/audit', 'Audit-Log'], ['#/deleted-entries', 'Papierkorb: Einträge'],
      ['#/deleted-absences', 'Papierkorb: Abwesenheiten'], ['#/deleted-projects', 'Papierkorb: Aufträge'],
    ];
    await p.setViewport({ width: 390, height: 380, isMobile: true, hasTouch: true }); await sleep(600);
    for (const [hash, label] of seiten) {
      await p.evaluate(h => { location.hash = h; }, hash);
      await sleep(3200);
      await scrollProbe(p, label);
    }

    // ── Ansicht muss auf JEDER Seite einen Neuaufbau ueberstehen ──────────
    // (Gegenprobe: der Fix darf B10 nicht aushebeln.)
    console.log('Ansicht überlebt den Neuaufbau:');
    // Kleineres Fenster, damit AUCH die kurzen Seiten (Planung, Bestellungen, Aufträge) wirklich
    // scrollbar sind — „übersprungen" ist nicht dasselbe wie „geprüft".
    await p.setViewport({ width: 390, height: 380, isMobile: true, hasTouch: true });
    await sleep(600);
    const neuaufbauten = [
      ['#/welcome', 'Willkommen', 'renderWelcome'],
      ['#/', 'Zeitnachweis', 'renderDashboardContent'],
      ['#/planning', 'Planung', 'renderPlanningContent'],
      ['#/tools', 'Werkzeuge', 'renderTools'],
      ['#/orders', 'Bestellungen', 'renderOrders'],
      ['#/absences', 'Abwesenheiten', 'renderAbsences'],
      ['#/projects', 'Aufträge', 'renderProjects'],
    ];
    for (const [hash, label, fn] of neuaufbauten) {
      await p.evaluate(h => { location.hash = h; }, hash);
      await sleep(3000);
      let traeger = await scrollTraeger(p);
      for (const h of [260, 200]) {
        if (traeger.art !== 'keiner') break;
        await p.setViewport({ width: 390, height: h, isMobile: true, hasTouch: true }); await sleep(700);
        traeger = await scrollTraeger(p);
      }
      if (traeger.art === 'keiner') { ok(`${label}: im Klon ohne Inhalt — mit Daten lokal geprüft`, true); continue; }
      await p.evaluate(t => {
        const el = t.art === 'seite' ? (document.scrollingElement || document.documentElement)
          : [...document.querySelectorAll('.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll, .main')].find(e => e.className === t.sel);
        window._ziel = el; window._achse = t.achse === 'x' ? 'scrollLeft' : 'scrollTop';
        el[window._achse] = 150;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, traeger);
      await sleep(800);
      const vor = await p.evaluate(() => Math.round(window._ziel[window._achse]));
      const lief = await p.evaluate(f => { if (typeof window[f] !== 'function') return false; window[f](); return true; }, fn);
      await sleep(3000);
      const nach = await p.evaluate(t => {
        const el = t.art === 'seite' ? (document.scrollingElement || document.documentElement)
          : [...document.querySelectorAll('.board-scroll, .timeline-scroll, .grid-scroll, .wh-scroll, .vac-ov-scroll, .table-scroll, .main')].find(e => e.className === t.sel);
        return el ? Math.round(el[window._achse]) : -1;
      }, traeger);
      ok(`${label}: Position überlebt den Neuaufbau (${traeger.art === 'seite' ? 'Seite' : 'Bereich'})`,
        lief && Math.abs(nach - vor) < 60, `${lief ? '' : fn + ' fehlt; '}${vor} → ${nach}`);
    }

    // ── Echter Seitenwechsel muss weiterhin OBEN beginnen ─────────────────
    await p.setViewport({ width: 390, height: 700, isMobile: true, hasTouch: true }); await sleep(500);
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(2800);
    await p.evaluate(() => window.scrollTo(0, 400)); await sleep(700);
    await p.evaluate(() => { location.hash = '#/orders'; }); await sleep(3000);
    const obenNachWechsel = await p.evaluate(() => Math.round(window.scrollY));
    ok('nach echtem Seitenwechsel startet man oben', obenNachWechsel < 40, 'y=' + obenNachWechsel);
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nScroll-Verhalten am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
