// Puppeteer-Test (B6): Suchfeld in den Listen.
//  - Werkzeuge, Mitarbeiter, Dokumente, Bestellungen, Papierkorb (Einträge + Abwesenheiten)
//  - Suche blendet Zeilen aus statt die Liste neu zu bauen -> Knoepfe bleiben funktionsfaehig
//  - Suchfeld behaelt den Fokus beim Tippen
//  - mehrere Woerter = UND-Suche, Gross/Kleinschreibung egal
//  - „Kein Treffer" erscheint und liegt bei Tabellen NICHT im <tbody>
//  - der Suchbegriff ueberlebt einen Neuaufbau der Liste (Live-Update durch Kollegen)
// Start: node tests/listen-suche-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3138, DB = '/tmp/listensuche.db', BASE = 'http://localhost:' + PORT;
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

// Tippt echt ins Feld (Tastendruck fuer Tastendruck) — nur so faellt ein Fokusverlust auf.
async function tippen(p, key, text) {
  await p.click('#ls-' + key);
  await p.evaluate(k => { const el = document.getElementById('ls-' + k); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, key);
  await p.type('#ls-' + key, text, { delay: 30 });
  await sleep(350);
}
const sichtbare = (p, sel) => p.evaluate(s => [...document.querySelectorAll(s + ' [data-suchtext]')]
  .filter(el => el.style.display !== 'none').length, sel);
const gesamt = (p, sel) => p.evaluate(s => document.querySelectorAll(s + ' [data-suchtext]').length, sel);
const zaehler = (p, key) => p.evaluate(k => { const el = document.getElementById('ls-count-' + k); return el ? el.textContent : null; }, key);
const fokusAuf = (p, key) => p.evaluate(k => document.activeElement && document.activeElement.id === 'ls-' + k, key);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/listensuche-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/listensuche-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;

    // Testdaten
    for (const n of ['Bohrmaschine gross', 'Bohrmaschine klein', 'Leiter 3 m', 'Multimeter', 'Kernbohrgeraet'])
      await req('POST', '/api/tools', admin, { name: n });
    const ma1 = (await req('POST', '/api/users', admin, { username: 'schmidt', password: 'Test1234!', name: 'Jonas Schmidt', role: 'mitarbeiter' })).body.user;
    await req('POST', '/api/users', admin, { username: 'mueller', password: 'Test1234!', name: 'Petra Müller', role: 'buchhalter' });
    await req('POST', '/api/users', admin, { username: 'weber', password: 'Test1234!', name: 'Tim Weber', role: 'mitarbeiter' });
    for (const o of [{ product: 'Kabel NYM 3x1,5', quantity: 100, unit: 'm' }, { product: 'Schaltschrank', quantity: 1, unit: 'St' }, { product: 'Kabelbinder', quantity: 200, unit: 'St' }])
      await req('POST', '/api/orders', admin, o);
    // Papierkorb fuellen
    for (const c of ['Meier Halle', 'Schulze Neubau', 'Meier Werkstatt']) {
      const e = (await req('POST', '/api/entries', admin, { date: today, time_from: '07:00', time_to: '08:00', client: c, user_id: ma1.id })).body.entry;
      await req('DELETE', '/api/entries/' + e.id, admin, { reason: 'Testlöschung ' + c });
    }
    const abs = (await req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: ma1.id, comment: 'Grippe' })).body;
    if (abs && abs.absence) await req('DELETE', '/api/absences/' + abs.absence.id, admin, { reason: 'Testlöschung Krank' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(600);

    // ── Werkzeuge ─────────────────────────────────────────────────────────
    console.log('Werkzeugliste:');
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(2000);
    ok('Suchfeld ist sofort sichtbar (nicht erst aufklappen)',
      await p.evaluate(() => { const el = document.getElementById('ls-werkzeug'); return !!el && el.checkVisibility(); }));
    ok('alle 5 Werkzeuge da', (await gesamt(p, '#tools-list')) === 5, String(await gesamt(p, '#tools-list')));
    await tippen(p, 'werkzeug', 'bohr');
    ok('„bohr" findet 3 (2x Bohrmaschine + Kernbohrgeraet)', (await sichtbare(p, '#tools-list')) === 3, String(await sichtbare(p, '#tools-list')));
    ok('Zaehler zeigt „3 von 5"', (await zaehler(p, 'werkzeug')) === '3 von 5', String(await zaehler(p, 'werkzeug')));
    ok('Suchfeld behaelt den Fokus beim Tippen', await fokusAuf(p, 'werkzeug'));
    await tippen(p, 'werkzeug', 'BOHR GROSS');
    ok('mehrere Woerter = UND-Suche, Gross/Klein egal', (await sichtbare(p, '#tools-list')) === 1, String(await sichtbare(p, '#tools-list')));
    await tippen(p, 'werkzeug', 'gibtsnicht');
    ok('„Kein Treffer" erscheint', await p.evaluate(() => {
      const el = document.querySelector('.list-search-empty');
      return !!el && el.style.display !== 'none' && /Kein Treffer/.test(el.textContent);
    }));
    // Der wichtigste Punkt: die Knoepfe der ausgeblendeten Zeilen leben noch
    await tippen(p, 'werkzeug', 'multimeter');
    const entnehmen = await p.evaluate(() => {
      const z = [...document.querySelectorAll('#tools-list .tool-item')].filter(el => el.style.display !== 'none');
      if (z.length !== 1) return 'anzahl=' + z.length;
      const b = z[0].querySelector('.tool-checkout');
      if (!b) return 'kein-knopf';
      b.click();
      const f = document.getElementById('tcf-' + b.dataset.id);
      return f && f.style.display !== 'none' ? 'ok' : 'formular-zu';
    });
    ok('Knopf der gefundenen Zeile funktioniert weiterhin', entnehmen === 'ok', String(entnehmen));

    // Der Suchbegriff muss einen Neuaufbau ueberleben (Kollege speichert -> Live-Update)
    await p.evaluate(() => renderTools()); await sleep(1800);
    ok('Suchbegriff ueberlebt den Neuaufbau der Liste',
      (await p.evaluate(() => document.getElementById('ls-werkzeug').value)) === 'multimeter');
    ok('… und die Filterung wirkt danach weiter', (await sichtbare(p, '#tools-list')) === 1, String(await sichtbare(p, '#tools-list')));
    await tippen(p, 'werkzeug', '');

    // ── Mitarbeiter ───────────────────────────────────────────────────────
    console.log('Mitarbeiter:');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(2000);
    ok('Suchfeld da', await p.evaluate(() => !!document.getElementById('ls-mitarbeiter')));
    await tippen(p, 'mitarbeiter', 'müller');
    ok('Umlaut-Suche findet Petra Müller', (await sichtbare(p, '#users-tbody')) === 1, String(await sichtbare(p, '#users-tbody')));
    await tippen(p, 'mitarbeiter', 'buchhalter');
    // Zwei Treffer sind richtig: Petra Müller hat die Rolle, und die App legt beim ersten Start
    // selbst einen Standardnutzer „Buchhalter" an.
    const buchhalter = await p.evaluate(() => [...document.querySelectorAll('#users-tbody [data-suchtext]')]
      .filter(el => el.style.display !== 'none').map(el => el.dataset.suchtext));
    ok('Suche nach der Rolle findet alle Buchhalter',
      buchhalter.length === 2 && buchhalter.every(t => /buchhalter/i.test(t)), JSON.stringify(buchhalter));
    await tippen(p, 'mitarbeiter', 'weber');
    ok('Suche nach Benutzername funktioniert', (await sichtbare(p, '#users-tbody')) === 1, String(await sichtbare(p, '#users-tbody')));
    await tippen(p, 'mitarbeiter', 'gibtsnicht');
    ok('„Kein Treffer" steht NICHT im Tabellenkoerper (waere ungueltiges HTML)',
      await p.evaluate(() => { const el = document.querySelector('.list-search-empty'); return !!el && !el.closest('tbody') && !el.closest('table'); }));
    await tippen(p, 'mitarbeiter', '');

    // ── Bestellungen ──────────────────────────────────────────────────────
    console.log('Bestellungen:');
    await p.evaluate(() => { location.hash = '#/orders'; }); await sleep(2000);
    ok('Suchfeld da', await p.evaluate(() => !!document.getElementById('ls-bestellung')));
    await tippen(p, 'bestellung', 'kabel');
    ok('„kabel" findet 2', (await sichtbare(p, '#order-list')) === 2, String(await sichtbare(p, '#order-list')));
    await tippen(p, 'bestellung', 'schaltschrank');
    ok('genauer Begriff findet 1', (await sichtbare(p, '#order-list')) === 1, String(await sichtbare(p, '#order-list')));
    await tippen(p, 'bestellung', '');

    // ── Papierkorb: Eintraege ─────────────────────────────────────────────
    console.log('Papierkorb — Einträge:');
    await p.evaluate(() => { location.hash = '#/deleted-entries'; }); await sleep(2000);
    ok('Suchfeld da', await p.evaluate(() => !!document.getElementById('ls-papierkorb-eintraege')));
    ok('3 gelöschte Einträge', (await gesamt(p, '#trash-entries-tbody')) === 3, String(await gesamt(p, '#trash-entries-tbody')));
    await tippen(p, 'papierkorb-eintraege', 'meier');
    ok('„meier" findet 2', (await sichtbare(p, '#trash-entries-tbody')) === 2, String(await sichtbare(p, '#trash-entries-tbody')));
    await tippen(p, 'papierkorb-eintraege', 'schulze');
    ok('Suche über die Begründung/Kunde findet 1', (await sichtbare(p, '#trash-entries-tbody')) === 1, String(await sichtbare(p, '#trash-entries-tbody')));
    await tippen(p, 'papierkorb-eintraege', '');

    // ── Papierkorb: Abwesenheiten ─────────────────────────────────────────
    console.log('Papierkorb — Abwesenheiten:');
    await p.evaluate(() => { location.hash = '#/deleted-absences'; }); await sleep(2000);
    const absDa = await p.evaluate(() => !!document.getElementById('ls-papierkorb-abwesenheiten'));
    if (absDa) {
      await tippen(p, 'papierkorb-abwesenheiten', 'schmidt');
      ok('Suche nach dem Mitarbeiter findet die Abwesenheit', (await sichtbare(p, '#trash-absences-tbody')) >= 1, String(await sichtbare(p, '#trash-absences-tbody')));
      await tippen(p, 'papierkorb-abwesenheiten', 'gibtsnicht');
      ok('kein Treffer blendet alles aus', (await sichtbare(p, '#trash-absences-tbody')) === 0, String(await sichtbare(p, '#trash-absences-tbody')));
      await tippen(p, 'papierkorb-abwesenheiten', '');
    } else ok('Suchfeld bei gelöschten Abwesenheiten', false, 'kein Feld gefunden');

    // ── Dokumente ─────────────────────────────────────────────────────────
    console.log('Dokumente:');
    await req('POST', '/api/documents/folders', admin, { name: 'Schaltplaene' });
    await req('POST', '/api/documents/folders', admin, { name: 'Rechnungen' });
    await p.evaluate(() => { location.hash = '#/documents'; }); await sleep(2200);
    const docDa = await p.evaluate(() => !!document.getElementById('ls-dokument'));
    if (docDa) {
      await tippen(p, 'dokument', 'schalt');
      ok('Ordnersuche findet „Schaltplaene"', (await sichtbare(p, '.doc-list')) === 1, String(await sichtbare(p, '.doc-list')));
      await tippen(p, 'dokument', '');
      ok('leeres Feld zeigt wieder alles', (await sichtbare(p, '.doc-list')) === 2, String(await sichtbare(p, '.doc-list')));
    } else ok('Suchfeld bei Dokumenten', false, 'kein Feld gefunden');

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nListen-Suche (B6): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
