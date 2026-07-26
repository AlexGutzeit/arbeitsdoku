// Prod-Klon-Pruefung der UX-Runde 1 (B3 Zoom + B2 Tap-Ziele + B8a Kontrast).
// Laeuft NUR LESEND gegen eine KOPIE der Produktivdaten unter /tmp/prodklon.db.
// Fehlt die Kopie, ueberspringt sich der Test.
// Start: node tests/ux-runde1-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3133, DB = '/tmp/prodklon.db', BASE = 'http://localhost:' + PORT;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const SHOTS = '/tmp/claude-1000/-home-alex-zeug-arbeitsdoku/84cc3a6c-bbc9-43b1-ae98-766adee26b4e/scratchpad';
const CHROME = path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = []; const hinweise = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const req = (m, p) => new Promise((res, rej) => { const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); r.on('error', rej); r.end(); });

const PROBE = function (sel) {
  const el = document.querySelector(sel); if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const hits = (x, y) => { if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const t = document.elementFromPoint(x, y); return !!(t && (t === el || el.contains(t))); };
  if (!hits(cx, cy)) return { mitte: false };
  let l = 0, rr = 0, u = 0, d = 0;
  while (l < 40 && hits(cx - l - 1, cy)) l++; while (rr < 40 && hits(cx + rr + 1, cy)) rr++;
  while (u < 40 && hits(cx, cy - u - 1)) u++; while (d < 40 && hits(cx, cy + d + 1)) d++;
  return { mitte: true, breite: l + rr + 1, hoehe: u + d + 1, sichtbar: Math.round(r.width) + 'x' + Math.round(r.height) };
};
const KONTRAST = function () {
  const parse = t => (t.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const grau = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 40;
  const graue = [], sonstige = []; let gezaehlt = 0;
  document.querySelectorAll('.main *, .sidebar *').forEach(el => {
    if (!el.checkVisibility || !el.checkVisibility()) return;
    const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    if (!txt) return;
    const cs = getComputedStyle(el);
    const fs2 = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    if (fs2 >= 24 || (fs2 >= 18.66 && bold)) return;      // Grossschrift: AA-Grenze waere 3:1
    // Hintergrund von unten nach oben zusammensetzen — halbtransparente Ebenen (z. B. das
    // Rollen-Abzeichen auf der gruenen Kopfleiste) sonst falsch als Weiss gemessen.
    const schichten = [];
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const m = (c || '').match(/[\d.]+/g);
      if (!m) continue;
      const alpha = m.length > 3 ? Number(m[3]) : 1;
      if (alpha === 0) continue;
      schichten.unshift({ rgb: m.slice(0, 3).map(Number), alpha });
      if (alpha === 1) break;
    }
    let bg = [255, 255, 255];
    schichten.forEach(l => { bg = bg.map((v, i) => l.rgb[i] * l.alpha + v * (1 - l.alpha)); });
    const fg = parse(cs.color);
    const a = lum(fg), b = lum(bg);
    const k = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    gezaehlt++;
    if (k >= 4.5) return;
    const eintrag = { k, farbe: cs.color, grund: 'rgb(' + bg.map(Math.round).join(', ') + ')', wo: (typeof el.className === 'string' ? el.className : el.tagName) + ' „' + txt.slice(0, 34) + '"' };
    // „Grauer Nebentext auf hellem Grund" = genau das, was B8a angeht.
    if (grau(fg) && b >= 0.6) graue.push(eintrag); else sonstige.push(eintrag);
  });
  const uniq = arr => { const m = new Map(); arr.forEach(e => { if (!m.has(e.wo)) m.set(e.wo, e); }); return [...m.values()].sort((x, y) => x.k - y.k); };
  return { gezaehlt, graue: uniq(graue), sonstige: uniq(sonstige).slice(0, 4) };
};

(async () => {
  if (!fs.existsSync(DB)) {
    console.log('Prod-Klon ' + DB + ' fehlt — Test uebersprungen.');
    console.log('  Holen mit: scp alexg@10.83.27.2:/home/alexg/arbeitsdoku/data/arbeitsdoku.db ' + DB);
    process.exit(0);
  }
  const lg = fs.openSync('/tmp/prodklon-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: '/home/alex/zeug/arbeitsdoku', env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const r = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1");
    const [id, username, name, role] = r[0].values[0];
    console.log(`  Prod-Klon: ${db.exec('SELECT COUNT(*) FROM entries')[0].values[0][0]} Zeiteintraege, ` +
      `${db.exec('SELECT COUNT(*) FROM users')[0].values[0][0]} Nutzer — angemeldet als ${name} (${role})`);
    db.close();
    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });
    const db2 = new SQL.Database(fs.readFileSync(DB));
    const TAG_MIT_ADRESSE = db2.exec("SELECT date FROM entries WHERE deleted_at IS NULL AND address IS NOT NULL AND address<>'' ORDER BY date DESC LIMIT 1")[0].values[0][0];
    const TAG_PLANUNG = db2.exec("SELECT date FROM planning_entries WHERE date <= date('now') ORDER BY date DESC LIMIT 1")[0].values[0][0];
    db2.close();
    console.log(`  echter Arbeitstag mit Adressen: ${TAG_MIT_ADRESSE} · letzte Planung: ${TAG_PLANUNG}`);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); },
      token, JSON.stringify({ id, username, name, role }));
    await p.goto(BASE, { waitUntil: 'networkidle2' }); await sleep(2500);
    ok('mit echten Daten angemeldet', await p.evaluate(() => !!document.querySelector('a[href="#/planning"]')));
    ok('Touch-Modus aktiv', await p.evaluate(() => matchMedia('(pointer: coarse)').matches));

    console.log('B3 — Zoom:');
    const vp = await p.evaluate(() => document.querySelector('meta[name="viewport"]').content);
    ok('Zoom nicht gesperrt', !/user-scalable\s*=\s*no/i.test(vp), vp);

    console.log('B2 — Trefferflaechen auf echten Seiten:');
    // Zeitnachweis: Tag mit echten Eintraegen suchen
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(2500);
    // Gezielt auf einen echten Arbeitstag mit hinterlegten Adressen springen
    await p.evaluate(d => { S.currentDate = new Date(d + 'T12:00:00'); renderDashboardContent(); }, TAG_MIT_ADRESSE);
    await sleep(3000);
    let nav = await p.evaluate(PROBE, '.tl-nav-btn');
    const diag = await p.evaluate(() => ({ tlentry: document.querySelectorAll('.tl-entry').length,
      tlnav: document.querySelectorAll('.tl-nav-btn').length, navaddr: document.querySelectorAll('.nav-to-addr').length,
      gridentry: document.querySelectorAll('.grid-entry').length, datum: (document.querySelector('.current-period') || {}).textContent }));
    console.log('      Diagnose Zeitnachweis:', JSON.stringify(diag));
    if (nav && nav.mitte) {
      const [iw, ih] = nav.sichtbar.split('x').map(Number);
      console.log(`      echtes Icon ${iw}x${ih} px  →  Trefferflaeche ${nav.breite}x${nav.hoehe} px`);
      ok('Zeitnachweis: Trefferflaeche vergroessert', nav.breite >= iw * 1.6 && nav.hoehe >= ih * 1.6, JSON.stringify(nav));
      await p.screenshot({ path: SHOTS + '/ux1-prod-zeitnachweis.png' });
    } else ok('Zeitnachweis: Navi-Icon in echten Daten gefunden', false, 'kein Eintrag mit Adresse in 14 Tagen');

    await p.evaluate(() => { location.hash = '#/planning'; }); await sleep(2500);
    await p.evaluate(d => { S.planningDate = new Date(d + 'T12:00:00'); S.planningView = 'day'; renderPlanningContent(); }, TAG_PLANUNG);
    await sleep(3000);
    console.log('      Diagnose Planung:', JSON.stringify(await p.evaluate(() => ({
      planentry: document.querySelectorAll('.tl-plan-entry').length, menu: document.querySelectorAll('.plan-menu-btn').length,
      action: document.querySelectorAll('.plan-action-btn').length, main: (document.querySelector('.main')||{}).innerHTML ? document.querySelector('.main').innerHTML.length : 0 }))));
    const menu = await p.evaluate(() => { const b = document.querySelector('.plan-menu-btn'); if (!b) return null;
      const r2 = b.getBoundingClientRect(); return { w: Math.round(r2.width), h: Math.round(r2.height) }; });
    ok('Planung: ⋮ ist 44 px', !!menu && menu.w >= 44 && menu.h >= 44, JSON.stringify(menu));
    if (menu) await p.screenshot({ path: SHOTS + '/ux1-prod-planung.png' });

    console.log('B8a — graue Nebentexte je Seite (Grenze 4,5:1):');
    for (const [hash, label] of [['#/', 'Zeitnachweis'], ['#/orders', 'Bestellungen'], ['#/notes', 'Notizen'],
                                 ['#/tools', 'Werkzeuge'], ['#/absences', 'Abwesenheiten'], ['#/projects', 'Auftraege']]) {
      await p.evaluate(h => { location.hash = h; }, hash); await sleep(2600);
      const k = await p.evaluate(KONTRAST);
      ok(`${label}: ${k.gezaehlt} Textstellen geprueft, graue Nebentexte alle >= 4,5:1`,
         k.gezaehlt >= 5 && k.graue.length === 0,
         k.gezaehlt < 5 ? 'Seite hat kaum Inhalt (im Klon leer)' : k.graue.map(e => `${e.k}:1 ${e.farbe} auf ${e.grund} — ${e.wo}`).join('\n        '));
      k.sonstige.forEach(e => hinweise.push(`${label}: ${e.k}:1  ${e.farbe} auf ${e.grund}  ${e.wo}`));
    }
    if (hinweise.length) {
      console.log('\nHINWEISE — Kontrastschwaechen AUSSERHALB von B8a (nicht durch diese Aenderung verursacht):');
      [...new Set(hinweise)].forEach(h => console.log('  ! ' + h));
    }
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProd-Klon UX-Runde 1: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
