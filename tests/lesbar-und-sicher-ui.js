// Lesen können, nichts verlieren: Meldungen, Sprechblase am Warnzeichen, Klick neben ein Fenster
// (R14, R24, R20 — 25.09.2026).
//
//   R14  Meldungen standen immer 3 s — eine zweizeilige Fehlermeldung las niemand zu Ende.
//        Jetzt nach Textlänge (Fehler 6–15 s), Antippen schließt.
//   R24  Die Erklärung am „!" eines Zeiteintrags (Arbeitszeit, Pause, Ruhezeit) verschwand am Handy
//        nach 4 s, am Rechner sobald die Maus das kleine Zeichen verließ. Jetzt: Handy bis zum
//        nächsten Antippen, Rechner solange die Maus auf Zeichen oder Sprechblase ist.
//   R20  Ein Klick neben ein Fenster schloss es samt allem Eingetippten. Jetzt nur ohne Eingaben.
//
//   node tests/lesbar-und-sicher-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3332, DB = '/tmp/lesbar-und-sicher.db', LOG = '/tmp/lesbar-und-sicher.log';
const BASIS = 'http://localhost:' + PORT;
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
const blase = p => p.evaluate(() => { const t = document.querySelector('.entry-tooltip'); return !!t && t.style.display !== 'none'; });
// Die ERKLÄRUNG zum Verstoß — nicht irgendeine Sprechblase. Unter dem Warnzeichen liegt der
// Eintragsblock, der beim Überfahren seine eigene Detail-Sprechblase zeigt; „irgendeine ist offen"
// wäre deshalb auch ohne die Reparatur grün gewesen (so bei den Gegenproben aufgefallen).
const erklaerung = p => p.evaluate(() => { const t = document.querySelector('.entry-tooltip');
  return !!t && t.style.display !== 'none' && /ArbZG|Jugendarbeitsschutz/.test(t.innerText); });
const meldung = p => p.evaluate(() => { const t = document.querySelector('.toast'); return !!t && t.classList.contains('show') ? t.textContent : ''; });

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    // Ein Verstoß, damit es ein „!" gibt: 11 Std Anwesenheit mit 45 min Pause → über 10 Std.
    const volker = (await req('POST', '/api/users', admin, { username: 'volker', password: 'Str3ng!Geheim',
      name: 'Volker Vorarbeiter', role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '1985-03-03' })).body.user;
    await req('POST', '/api/entries', admin, { user_id: volker.id, date: '2026-07-08', time_from: '06:00', time_to: '17:00', break_minutes: 45, description: 'x' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const anmelden = async (vp) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage(); await p.setViewport(vp); p.setDefaultTimeout(30000);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(600);
      return p;
    };
    const tagesansicht = async (p) => {
      await p.evaluate(() => { location.hash = '/dashboard'; }); await p.waitForSelector('.main'); await sleep(800);
      await p.evaluate(() => { S.view = 'day'; S.currentDate = new Date('2026-07-08T12:00:00'); render(); });
      await p.waitForSelector('.verstoss-zeichen'); await sleep(600);
      return p.evaluate(() => { const z = document.querySelector('.verstoss-zeichen'); z.scrollIntoView({ block: 'center' });
        const r = z.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    };

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR24 — Erklärung am „!" (Rechner)');
    const p = await anmelden({ width: 1400, height: 1000 });
    let pt = await tagesansicht(p);
    await p.mouse.move(pt.x, pt.y); await sleep(300);
    ok('Maus aufs Zeichen: die Erklärung erscheint', await erklaerung(p));
    const tip = await p.evaluate(() => { const r = document.querySelector('.entry-tooltip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.move(tip.x, tip.y, { steps: 5 }); await sleep(900);
    ok('Maus hinüber auf die Sprechblase: die Erklärung bleibt offen (zum Lesen)', await erklaerung(p));
    await p.mouse.move(5, 5, { steps: 3 }); await sleep(800);
    ok('Maus weg von beidem: Sprechblase schließt', !(await blase(p)));
    await p.mouse.move(pt.x, pt.y); await sleep(300);
    // Zielpunkt garantiert AUSSERHALB von Zeichen und Sprechblase — sonst bleibt sie zu Recht offen
    const lage = await p.evaluate((x, y) => {
      const r = document.querySelector('.entry-tooltip').getBoundingClientRect();
      return { tip: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], zeichen: [Math.round(x), Math.round(y)] };
    }, pt.x, pt.y);
    await p.mouse.move(5, 5); await sleep(120);
    const kurzDanach = await erklaerung(p);
    await sleep(700);
    ok('Kulanz: kurz nach dem Verlassen noch da, dann zu', kurzDanach && !(await blase(p)), JSON.stringify({ kurzDanach, ...lage }));

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR14 — Meldungen');
    await p.evaluate(() => toast('Gespeichert', 'success'));
    await sleep(2500); const kurz25 = await meldung(p);
    await sleep(1200); const kurz37 = await meldung(p);
    ok('kurze Erfolgsmeldung: 3 s wie bisher', kurz25 === 'Gespeichert' && kurz37 === '', JSON.stringify({ kurz25, kurz37 }));
    const lang = 'Hochladen fehlgeschlagen: kein Speicherplatz mehr frei. Bitte beim Administrator melden und später noch einmal versuchen.';
    await p.evaluate((t) => toast(t, 'error'), lang);
    await sleep(6500); const lang65 = await meldung(p);
    ok('lange Fehlermeldung steht nach 6,5 s noch (vorher nach 3 s weg)', lang65 === lang, JSON.stringify(lang65.slice(0, 40)));
    await sleep(4000);
    ok('… und geht nach Textlänge von selbst (spätestens 15 s)', await meldung(p) === '');
    await p.evaluate(() => toast('Etwas ging schief — bitte noch einmal.', 'error'));
    await sleep(400);
    const meldungsLage = await p.evaluate(() => { const r = document.querySelector('.toast').getBoundingClientRect(); return { oben: Math.round(r.top), unten: Math.round(r.bottom), hoehe: innerHeight }; });
    // Oben unter der Kopfleiste (Alex): unten verdeckte eine länger stehende Meldung Knöpfe am Rand
    ok('die Meldung steht oben unter der Kopfleiste, nicht über Knöpfen am unteren Rand',
      meldungsLage.oben >= 56 && meldungsLage.unten < meldungsLage.hoehe / 3, JSON.stringify(meldungsLage));
    await p.click('.toast'); await sleep(150);
    ok('Antippen schließt die Meldung sofort', await meldung(p) === '');

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR20 — Klick neben ein Fenster');
    await p.evaluate(() => { window.__erg = 'offen'; promptModal('Grund:', { title: 'Ablehnen' }).then(v => { window.__erg = v; }); });
    await p.waitForSelector('#pm-input');
    await p.type('#pm-input', 'Material war nicht auf der Baustelle');
    await p.mouse.click(5, 5); await sleep(300);
    const nachKlick = await p.evaluate(() => ({ offen: !!document.getElementById('pm-input'), text: (document.getElementById('pm-input') || {}).value, erg: window.__erg }));
    ok('Eingabedialog mit Text: Klick daneben schließt NICHT, Text bleibt', nachKlick.offen && nachKlick.text === 'Material war nicht auf der Baustelle' && nachKlick.erg === 'offen', JSON.stringify(nachKlick));
    ok('… und sagt, wie man verwirft', /Eingaben sind noch da/.test(await meldung(p)));
    await p.evaluate(() => { const k = document.querySelector('.modal [data-act="cancel"]'); if (k) k.click(); }); await sleep(300);
    ok('„Abbrechen" verwirft wie gewohnt', await p.evaluate(() => !document.getElementById('pm-input') && window.__erg === null));
    await p.evaluate(() => { window.__erg = 'offen'; promptModal('Name:', { title: 'Umbenennen', defaultValue: 'Alt' }).then(v => { window.__erg = v; }); });
    await p.waitForSelector('#pm-input'); await sleep(200);
    await p.mouse.click(5, 5); await sleep(300);
    ok('ohne Eingabe (nur Vorbelegung): Klick daneben schließt wie bisher', await p.evaluate(() => !document.getElementById('pm-input') && window.__erg === null));
    await p.evaluate(() => { window.__erg = 'offen'; confirmModal('Wirklich?', { title: 'Frage' }).then(v => { window.__erg = v; }); });
    await sleep(300); await p.mouse.click(5, 5); await sleep(300);
    ok('Rückfrage ohne Eingabefelder: Klick daneben schließt wie bisher', await p.evaluate(() => window.__erg === false && !document.querySelector('.dialog-modal')));
    // Ein echtes Formular: Mitarbeiter anlegen
    await p.evaluate(() => { location.hash = '/users'; }); await p.waitForSelector('#add-user-btn'); await sleep(500);
    await p.click('#add-user-btn'); await p.waitForSelector('#um-cancel'); await sleep(300);
    const feld = await p.evaluate(() => { const f = document.querySelector('.modal-overlay input[type="text"]'); f.focus(); return f.id; });
    await p.keyboard.type('Neu Eingestellt');
    await p.mouse.click(5, 5); await sleep(300);
    ok('Mitarbeiter-Formular mit Eingabe: Klick daneben schließt NICHT', await p.evaluate((id) => !!document.getElementById('um-cancel') && document.getElementById(id).value === 'Neu Eingestellt', feld));
    await p.evaluate(() => { const k = document.getElementById('um-cancel'); if (k) k.click(); }); await sleep(300);
    ok('… „Abbrechen" schließt', await p.evaluate(() => !document.getElementById('um-cancel')));

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR24 — Erklärung am „!" (Handy, langer Druck)');
    const h = await anmelden({ width: 390, height: 780, isMobile: true, hasTouch: true });
    pt = await tagesansicht(h);
    await h.touchscreen.touchStart(pt.x, pt.y); await sleep(700); await h.touchscreen.touchEnd();
    await sleep(200);
    ok('langer Druck: die Erklärung erscheint', await erklaerung(h));
    await sleep(5000);
    ok('nach 5 s noch da (vorher nach 4 s weg)', await erklaerung(h));
    await h.touchscreen.touchStart(5, 700); await h.touchscreen.touchEnd(); await sleep(300);
    ok('Antippen irgendwo schließt sie', !(await blase(h)));
    await h.touchscreen.touchStart(pt.x, pt.y); await sleep(700); await h.touchscreen.touchEnd(); await sleep(200);
    const wieder = await blase(h);
    await h.evaluate(() => window.scrollBy(0, 40)); await sleep(300);
    ok('Scrollen schließt sie ebenfalls', wieder && !(await blase(h)), JSON.stringify({ wieder }));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nLesbar und sicher: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
