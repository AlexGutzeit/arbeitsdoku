// Puppeteer-Test (B4): Entwurfs-Sicherung fuer Formulare.
//  - App geht in den Hintergrund (der Anruf-Fall) -> Entwurf liegt im Speicher
//  - danach Seite komplett neu laden (wie nach dem Abschuss durchs Betriebssystem)
//    -> Leiste bietet den Entwurf an, „Wiederherstellen" bringt die Eingaben zurueck
//  - „Verwerfen" laesst das Formular leer und bietet nichts mehr an
//  - Seitenwechsel sichert und meldet „Entwurf gesichert"
//  - nach erfolgreichem Speichern gibt es KEINEN Entwurf mehr
//  - Abmelden loescht alle Entwuerfe (geteilte Geraete)
//  - Planung: die Mehrtages-Auswahl ueberlebt mit
// Start: node tests/entwurf-sicherung-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3136, DB = '/tmp/entwurf.db', BASE = 'http://localhost:' + PORT;
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

const setVal = (p, id, v) => p.evaluate((i, val) => {
  const el = document.getElementById(i); el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, id, v);
const getVal = (p, id) => p.evaluate(i => { const el = document.getElementById(i); return el ? el.value : null; }, id);
const leisteDa = p => p.evaluate(() => !!document.querySelector('.draft-bar'));
const entwuerfe = p => p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('entwurf:')));

// Der Anruf: App in den Hintergrund schicken. Genau dieses Ereignis feuert auf dem Handy,
// bevor das Betriebssystem die App aus dem Speicher wirft.
async function inDenHintergrund(p) {
  const c = await p.createCDPSession();
  await c.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(400);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/entwurf-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/entwurf-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'entwma', password: 'Test1234!', name: 'Entwurf MA', role: 'mitarbeiter' })).body.user;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let p = await browser.newPage();
    await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
    // Das Betriebssystem hat die App abgeschossen: FRISCHER Tab. Ein blosses p.goto() taugt dafuer
    // nicht — Chrome stellt beim Neuladen derselben Seite die Feldinhalte selbst wieder her und
    // wuerde den Test gruen faerben, ohne dass unsere Entwurfs-Sicherung ueberhaupt greift.
    // localStorage (Token + Entwuerfe) bleibt im selben Browser-Kontext erhalten.
    const neustart = async (hash) => {
      await p.close();
      p = await browser.newPage();
      await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
      await p.goto(BASE + '/' + hash, { waitUntil: 'networkidle2' });
      await sleep(2500);
    };
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(600);

    // ── Der Anruf-Fall am Zeiteintrag ─────────────────────────────────────
    console.log('Zeiteintrag — Anruf mitten im Ausfuellen:');
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(2000);
    ok('Formular offen', await p.evaluate(() => !!document.getElementById('entry-form')));
    ok('noch kein Entwurf vorhanden', (await entwuerfe(p)).length === 0);
    ok('keine Entwurfs-Leiste beim frischen Formular', !(await leisteDa(p)));

    await setVal(p, 'ef-client', 'Fischer & Sohn');
    await setVal(p, 'ef-address', 'Bergweg 12, Musterstadt');
    await setVal(p, 'ef-desc', 'Verteilerschrank erneuern, 3 Sicherungsautomaten');
    await sleep(800);
    await inDenHintergrund(p);
    const nachHintergrund = await entwuerfe(p);
    ok('beim Wechsel in den Hintergrund gesichert', nachHintergrund.length === 1, JSON.stringify(nachHintergrund));

    // Betriebssystem raeumt die App weg -> vollstaendiger Neustart der Seite
    await neustart('#/entry/new');
    ok('nach dem Neustart wird ein Entwurf angeboten', await leisteDa(p));
    ok('Formular ist zunaechst leer (nichts wird heimlich eingesetzt)',
      (await getVal(p, 'ef-client')) === '', JSON.stringify(await getVal(p, 'ef-client')));
    await p.click('#entwurf-uebernehmen'); await sleep(500);
    ok('Kunde wiederhergestellt', (await getVal(p, 'ef-client')) === 'Fischer & Sohn', JSON.stringify(await getVal(p, 'ef-client')));
    ok('Adresse wiederhergestellt', (await getVal(p, 'ef-address')) === 'Bergweg 12, Musterstadt');
    ok('Beschreibung wiederhergestellt', /Sicherungsautomaten/.test(await getVal(p, 'ef-desc')));
    ok('Leiste verschwindet nach dem Wiederherstellen', !(await leisteDa(p)));

    // ── Speichern raeumt den Entwurf weg ──────────────────────────────────
    console.log('Nach dem Speichern:');
    await setVal(p, 'ef-user', String(ma.id));
    await p.evaluate(() => document.getElementById('entry-form').requestSubmit()); await sleep(2000);
    ok('Eintrag gespeichert', await p.evaluate(() => location.hash === '#/' || location.hash === ''), await p.evaluate(() => location.hash));
    ok('Entwurf nach dem Speichern weg', (await entwuerfe(p)).length === 0, JSON.stringify(await entwuerfe(p)));
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(2000);
    ok('frisches Formular bietet nichts mehr an', !(await leisteDa(p)));

    // ── Verwerfen ─────────────────────────────────────────────────────────
    console.log('Verwerfen:');
    await setVal(p, 'ef-client', 'Wird verworfen'); await sleep(800);
    await inDenHintergrund(p);
    await neustart('#/entry/new');
    ok('Entwurf wird angeboten', await leisteDa(p));
    await p.click('#entwurf-verwerfen'); await sleep(400);
    ok('Formular bleibt leer', (await getVal(p, 'ef-client')) === '');
    ok('Entwurf ist geloescht', (await entwuerfe(p)).length === 0, JSON.stringify(await entwuerfe(p)));
    await neustart('#/entry/new');
    ok('und wird nicht erneut angeboten', !(await leisteDa(p)));

    // ── Seitenwechsel: sichern + kurz Bescheid geben ──────────────────────
    console.log('Versehentlich weggetippt:');
    await setVal(p, 'ef-client', 'Versehentlich verlassen'); await sleep(800);
    await p.evaluate(() => { location.hash = '#/planning'; }); await sleep(1200);
    const hinweis = await p.evaluate(() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; });
    ok('Hinweis „Entwurf gesichert" erscheint', /Entwurf gesichert/.test(hinweis), JSON.stringify(hinweis));
    await neustart('#/entry/new');
    ok('Entwurf ist nach dem Wegtippen da', await leisteDa(p));
    await p.click('#entwurf-uebernehmen'); await sleep(400);
    ok('Eingabe zurueck', (await getVal(p, 'ef-client')) === 'Versehentlich verlassen');

    // ── Der Hinweis darf keine wichtigere Meldung ueberdecken ─────────────
    // Es gibt nur EIN Meldungsfeld. Wuerde „Entwurf gesichert" eine Fehlermeldung ersetzen,
    // erfuehre der Nutzer nie, warum er ploetzlich woanders steht.
    console.log('Vorrang der Meldungen:');
    const bul = (await req('POST', '/api/bulletin', admin, { title: 'Gleich geloescht', text: 'x' })).body.entry;
    await req('DELETE', '/api/bulletin/' + bul.id, admin);
    await neustart('#/entry/new');
    if (await leisteDa(p)) { await p.click('#entwurf-verwerfen'); await sleep(300); }
    await setVal(p, 'ef-client', 'Etwas Getipptes'); await sleep(800);
    await p.evaluate(id => { location.hash = '#/bulletin/edit/' + id; }, bul.id);
    await sleep(1800);
    const meldung = await p.evaluate(() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; });
    ok('Fehlermeldung bleibt stehen, der Entwurfs-Hinweis draengt sich nicht vor',
      /existiert nicht mehr/i.test(meldung), JSON.stringify(meldung));
    ok('der Entwurf wurde trotzdem gesichert', (await entwuerfe(p)).length >= 1, JSON.stringify(await entwuerfe(p)));

    // ── Projekt gewaehlt UND Adresse von Hand geaendert ───────────────────
    // Die Projekt-Auswahl traegt beim Wechseln Adresse/Kunde/Notiz des Projekts ein. Beim
    // Wiederherstellen darf diese Automatik die selbst getippten Werte NICHT ueberschreiben.
    console.log('Projekt gewaehlt, Adresse danach selbst geaendert:');
    await req('POST', '/api/projects', admin, { name: 'Neubau Schmidt', client: 'Schmidt Bau', address: 'Projektadresse 1' });
    await neustart('#/entry/new');
    if (await leisteDa(p)) { await p.click('#entwurf-verwerfen'); await sleep(300); }
    const projId = await p.evaluate(() => {
      const s2 = document.getElementById('ef-project');
      const o = [...s2.options].find(x => /Neubau Schmidt/.test(x.textContent));
      return o ? o.value : null;
    });
    ok('Testprojekt steht zur Auswahl', !!projId, String(projId));
    await setVal(p, 'ef-project', projId); await sleep(500);
    ok('Projektadresse wurde uebernommen', (await getVal(p, 'ef-address')) === 'Projektadresse 1', JSON.stringify(await getVal(p, 'ef-address')));
    await setVal(p, 'ef-address', 'Baustelle hinten links 9');   // von Hand korrigiert
    await sleep(800);
    await inDenHintergrund(p);
    await neustart('#/entry/new');
    ok('Entwurf mit Projekt wird angeboten', await leisteDa(p));
    await p.click('#entwurf-uebernehmen'); await sleep(700);
    ok('Projekt wieder ausgewaehlt', (await getVal(p, 'ef-project')) === projId, JSON.stringify(await getVal(p, 'ef-project')));
    ok('selbst getippte Adresse ueberlebt (Projekt-Automatik schreibt sie NICHT zurueck)',
      (await getVal(p, 'ef-address')) === 'Baustelle hinten links 9', JSON.stringify(await getVal(p, 'ef-address')));
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(1200);
    await neustart('#/entry/new');
    if (await leisteDa(p)) { await p.click('#entwurf-verwerfen'); await sleep(300); }

    // ── Planung: Mehrtages-Auswahl muss mitkommen ─────────────────────────
    console.log('Planung mit mehreren Tagen:');
    await neustart('#/planning/new');
    ok('Planungsformular offen', await p.evaluate(() => !!document.getElementById('planning-form')));
    await setVal(p, 'pf-client', 'Mehrtages-Kunde');
    // Mehrtage-Schalter an und einen Bereich waehlen
    const tageVorher = await p.evaluate(() => {
      const t = document.getElementById('pf-multi-toggle');
      if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
      return document.querySelectorAll('.plan-day-row').length;
    });
    await sleep(900);
    const tageNachher = await p.evaluate(() => document.querySelectorAll('.plan-day-row').length);
    ok('mehrere Tage ausgewaehlt', tageNachher >= 1, `vorher ${tageVorher}, jetzt ${tageNachher}`);
    await sleep(800);
    await inDenHintergrund(p);
    await neustart('#/planning/new');
    ok('Planungs-Entwurf wird angeboten', await leisteDa(p));
    await p.click('#entwurf-uebernehmen'); await sleep(700);
    ok('Kunde in der Planung zurueck', (await getVal(p, 'pf-client')) === 'Mehrtages-Kunde', JSON.stringify(await getVal(p, 'pf-client')));
    const tageZurueck = await p.evaluate(() => document.querySelectorAll('.plan-day-row').length);
    ok('Tages-Auswahl kam mit zurueck', tageZurueck === tageNachher, `erwartet ${tageNachher}, ist ${tageZurueck}`);

    // ── Die uebrigen Formulare ────────────────────────────────────────────
    // Alle werden ueber den runden „+"-Knopf geoeffnet; Aushang und Auftrag wechseln dabei
    // die Ansicht, Bestellung/Notiz/Abwesenheit klappen an Ort und Stelle auf.
    console.log('Die uebrigen Formulare:');
    const weitere = [
      { name: 'Bestellung',   hash: '#/orders',   feld: 'of-product',  wert: 'Kabelbinder 200 mm', knopf: '#order-add-btn' },
      { name: 'Notiz',        hash: '#/notes',    feld: 'nf-title',    wert: 'Materialliste Halle 3' },
      { name: 'Aushang',      hash: '#/bulletin', feld: 'bf-title',    wert: 'Betriebsversammlung Freitag' },
      { name: 'Auftrag',      hash: '#/projects', feld: 'pf2-name',    wert: 'Halle 3 Beleuchtung' },
      { name: 'Abwesenheit',  hash: '#/absences', feld: 'abs-comment', wert: 'Zahnarzttermin' },
    ];
    const formularOeffnen = async (f) => {
      const knopf = f.knopf || '#fab-new';   // Bestellungen haben einen eigenen „+ Hinzufuegen"-Knopf
      await p.evaluate(h => { location.hash = h; }, f.hash);
      await p.waitForFunction(sel => !!document.querySelector(sel), { timeout: 8000 }, knopf);
      await sleep(1500);
      await p.evaluate(sel => document.querySelector(sel).click(), knopf);
      await p.waitForFunction(id => !!document.getElementById(id), { timeout: 8000 }, f.feld);
      await sleep(500);
    };
    for (const f of weitere) {
      try {
        await formularOeffnen(f);
        if (await leisteDa(p)) { await p.click('#entwurf-verwerfen'); await sleep(300); }
        await setVal(p, f.feld, f.wert);
        await sleep(800);
        await inDenHintergrund(p);
        await neustart(f.hash);
        await formularOeffnen(f);
        const angeboten = await leisteDa(p);
        if (!angeboten) { ok(`${f.name}: Entwurf wird angeboten`, false, 'keine Leiste'); continue; }
        await p.click('#entwurf-uebernehmen'); await sleep(500);
        ok(`${f.name}: Eingabe ueberlebt den Neustart`, (await getVal(p, f.feld)) === f.wert, JSON.stringify(await getVal(p, f.feld)));
      } catch (e) {
        ok(`${f.name}: Entwurf wird angeboten`, false, String(e.message || e).slice(0, 90));
      }
    }

    // ── Abmelden raeumt auf (geteilte Geraete) ────────────────────────────
    console.log('Abmelden:');
    ok('vor dem Abmelden liegt ein Entwurf vor', (await entwuerfe(p)).length >= 1, JSON.stringify(await entwuerfe(p)));
    await p.evaluate(() => logout(true)); await sleep(1500);
    ok('nach dem Abmelden ist kein Entwurf mehr gespeichert', (await entwuerfe(p)).length === 0, JSON.stringify(await entwuerfe(p)));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nEntwurfs-Sicherung (B4): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
