// Puppeteer-Test (B8b): Bedienung per Tastatur und mit Screenreader.
//  - Dialoge: Rolle, Beschriftung, Fokus SPRINGT HINEIN, Tab kommt NICHT heraus,
//    Escape schliesst, Fokus kehrt zum ausloesenden Knopf zurueck
//  - Hintergrund ist waehrend eines Dialogs fuer Screenreader ausgeblendet
//  - Meldungsfeld wird angesagt (role=status / aria-live)
//  - Landmarken (Kopf/Navigation/Hauptbereich) und „aktuelle Seite" im Menue
//  - Symbol-Knoepfe haben einen lesbaren Namen
// Start: node tests/barrierefrei-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3140, DB = '/tmp/barrierefrei.db', BASE = 'http://localhost:' + PORT;
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

const imDialog = p => p.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  return !!(d && document.activeElement && d.contains(document.activeElement));
});
const aktivesElement = p => p.evaluate(() => {
  const a = document.activeElement;
  return a ? (a.id || a.className || a.tagName) : null;
});

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/barrierefrei-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/barrierefrei-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    await req('POST', '/api/tools', admin, { name: 'Schlagbohrmaschine' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(800);

    // ── Grundgeruest ──────────────────────────────────────────────────────
    console.log('Seitengerüst:');
    ok('Seitensprache ist Deutsch', (await p.evaluate(() => document.documentElement.lang)) === 'de');
    ok('Hauptbereich ist als solcher benannt', await p.evaluate(() => !!document.querySelector('[role="main"], main')));
    ok('Navigation ist als solche benannt', await p.evaluate(() => !!document.querySelector('nav[aria-label], [role="navigation"]')));
    ok('Kopfleiste ist als solche benannt', await p.evaluate(() => !!document.querySelector('[role="banner"], header')));
    ok('Menü-Knopf hat einen lesbaren Namen', await p.evaluate(() => {
      const b = document.getElementById('menu-btn');
      return !!b && !!(b.getAttribute('aria-label') || '').trim();
    }));
    ok('aktueller Menüpunkt ist als „aktuelle Seite" gekennzeichnet', await p.evaluate(() => {
      const a = document.querySelector('nav a.active');
      return !!a && a.getAttribute('aria-current') === 'page';
    }));

    // ── Meldungsfeld ──────────────────────────────────────────────────────
    console.log('Meldungen:');
    await p.evaluate(() => toast('Testmeldung', 'success')); await sleep(300);
    const meldung = await p.evaluate(() => {
      const t = document.querySelector('.toast');
      return t ? { rolle: t.getAttribute('role'), live: t.getAttribute('aria-live'), text: t.textContent } : null;
    });
    ok('Meldungsfeld wird angesagt (role=status + aria-live)',
      !!meldung && meldung.rolle === 'status' && meldung.live === 'polite', JSON.stringify(meldung));

    // ── Bestätigungsdialog ────────────────────────────────────────────────
    console.log('Bestätigungsdialog (Werkzeug löschen):');
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(2000);
    await p.evaluate(() => document.querySelector('.tool-delete').focus());
    const vorher = await aktivesElement(p);
    await p.evaluate(() => document.querySelector('.tool-delete').click()); await sleep(600);

    const dlg = await p.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      const beschriftet = d.getAttribute('aria-labelledby');
      const titel = beschriftet ? document.getElementById(beschriftet) : null;
      return { modal: d.getAttribute('aria-modal'), titel: titel ? titel.textContent : null };
    });
    ok('Dialog ist als Dialog gekennzeichnet', !!dlg && dlg.modal === 'true', JSON.stringify(dlg));
    ok('Dialog trägt seinen Titel als Beschriftung', !!dlg && !!dlg.titel, JSON.stringify(dlg));
    ok('Fokus springt in den Dialog', await imDialog(p), String(await aktivesElement(p)));
    ok('Hintergrund ist für Screenreader ausgeblendet',
      (await p.evaluate(() => document.getElementById('app').getAttribute('aria-hidden'))) === 'true');

    // Die Fokusfalle: 12x Tab darf den Dialog NICHT verlassen
    let entkommen = null;
    for (let i = 0; i < 12; i++) {
      await p.keyboard.press('Tab');
      if (!(await imDialog(p))) { entkommen = await aktivesElement(p); break; }
    }
    ok('Tab kommt aus dem Dialog nicht heraus', entkommen === null, 'gelandet bei: ' + entkommen);
    for (let i = 0; i < 4; i++) await p.keyboard.down('Shift'), await p.keyboard.press('Tab'), await p.keyboard.up('Shift');
    ok('auch rückwärts (Umschalt+Tab) bleibt der Fokus drin', await imDialog(p), String(await aktivesElement(p)));

    await p.keyboard.press('Escape'); await sleep(500);
    ok('Escape schließt den Dialog', !(await p.evaluate(() => !!document.querySelector('[role="dialog"]'))));
    ok('Hintergrund ist wieder freigegeben',
      (await p.evaluate(() => document.getElementById('app').getAttribute('aria-hidden'))) === null);
    ok('Fokus kehrt zum auslösenden Knopf zurück', (await aktivesElement(p)) === vorher, `${vorher} → ${await aktivesElement(p)}`);

    // ── Eingabedialog (Begründung) ────────────────────────────────────────
    console.log('Eingabedialog:');
    await p.evaluate(() => { promptModal('Testfrage', { title: 'Begründung' }); }); await sleep(500);
    ok('Fokus liegt im Eingabefeld', (await aktivesElement(p)) === 'pm-input', String(await aktivesElement(p)));
    let raus = null;
    for (let i = 0; i < 10; i++) {
      await p.keyboard.press('Tab');
      if (!(await imDialog(p))) { raus = await aktivesElement(p); break; }
    }
    ok('auch hier kommt Tab nicht heraus', raus === null, 'gelandet bei: ' + raus);
    await p.keyboard.press('Escape'); await sleep(400);
    ok('Escape schließt auch den Eingabedialog', !(await p.evaluate(() => !!document.querySelector('[role="dialog"]'))));

    // ── Abwesenheits-Dialog (eigenes Overlay, kein modal-overlay) ─────────
    console.log('Abwesenheits-Dialog:');
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(2200);
    await p.evaluate(() => document.getElementById('fab-new').click()); await sleep(900);
    ok('Dialog ist gekennzeichnet', await p.evaluate(() => {
      const d = document.querySelector('#absence-form-overlay [role="dialog"], #absence-form-overlay.absence-form-card');
      return !!document.querySelector('[role="dialog"]');
    }));
    let rausAbs = null;
    for (let i = 0; i < 14; i++) {
      await p.keyboard.press('Tab');
      if (!(await imDialog(p))) { rausAbs = await aktivesElement(p); break; }
    }
    ok('Tab bleibt im Abwesenheits-Dialog', rausAbs === null, 'gelandet bei: ' + rausAbs);
    await p.keyboard.press('Escape'); await sleep(500);
    ok('Escape schließt ihn', !(await p.evaluate(() => !!document.getElementById('absence-form-overlay'))));

    // ── Symbol-Knöpfe ─────────────────────────────────────────────────────
    console.log('Symbol-Knöpfe:');
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(2200);
    const namenlos = await p.evaluate(() => {
      return [...document.querySelectorAll('button')].filter(b => {
        if (!b.checkVisibility()) return false;
        const text = (b.textContent || '').replace(/[\s‹›×✕✖✎⋮+]/g, '').trim();
        const name = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        return !text && !name;   // weder lesbarer Text noch Beschriftung
      }).map(b => b.id || b.className || b.outerHTML.slice(0, 60));
    });
    ok('kein sichtbarer Symbol-Knopf ohne Namen (Zeitnachweis)', namenlos.length === 0, JSON.stringify(namenlos));
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(2000);
    const namenlos2 = await p.evaluate(() => {
      return [...document.querySelectorAll('button')].filter(b => {
        if (!b.checkVisibility()) return false;
        const text = (b.textContent || '').replace(/[\s‹›×✕✖✎⋮+]/g, '').trim();
        const name = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        return !text && !name;
      }).map(b => b.id || b.className || b.outerHTML.slice(0, 60));
    });
    ok('… und keiner in der Werkzeugliste', namenlos2.length === 0, JSON.stringify(namenlos2));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBarrierefreiheit (B8b): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
