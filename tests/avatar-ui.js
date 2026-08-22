// Profilbilder in der Oberfläche: hochladen, in der Kopfzeile sehen, wieder entfernen.
//
// Der unscheinbare, aber entscheidende Prüfpunkt: Die Bilder liegen hinter der Anmeldung und
// werden per fetch geholt — angezeigt werden sie als blob:-Adresse. Das erlaubt die
// Sicherheitsrichtlinie nur, weil `blob:` dort ausdrücklich steht. Fehlt es, verwirft der Browser
// das Bild STUMM: kein Fehler im Code, nur ein leerer Kreis. Deshalb wird hier geprüft, dass die
// Konsole keine Verletzung meldet UND dass wirklich ein Bild gesetzt wurde.
//
// Zweiter Punkt: Wer kein Bild hat, bekommt Initialen in seiner Personenfarbe — die Oberfläche
// darf also nie leer wirken, auch wenn niemand ein Bild hochlädt.
//
//   node tests/avatar-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3258, DB = '/tmp/avatar-ui.db', BASIS = `http://localhost:${PORT}`;
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  const bildDatei = '/tmp/avatar-ui-testbild.png';
  fs.writeFileSync(bildDatei, await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 220, g: 60, b: 60 } } }).png().toBuffer());

  const lg = fs.openSync('/tmp/avatar-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/avatar-ui-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 900 });
    page.setDefaultTimeout(45000);
    const meldungen = [];
    page.on('console', m => { if (m.type() === 'error') meldungen.push(m.text()); });
    page.on('pageerror', e => meldungen.push('Seitenfehler: ' + String(e)));

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2200);

    console.log('── Ohne Bild bleibt die Ansicht wie bisher (Alex, 22.08.2026) ──');
    const anfang = await page.evaluate(() => {
      const a = document.querySelector('#kopf-avatar .avatar');
      if (!a) return null;
      const st = getComputedStyle(a);
      return { text: a.textContent.trim(), anzeige: st.display, bild: st.backgroundImage,
               breite: Math.round(a.getBoundingClientRect().width) };
    });
    ok('der Platzhalter steht im Baum (damit er später gefüllt werden kann)', !!anfang, JSON.stringify(anfang));
    ok('… ist aber unsichtbar', anfang.anzeige === 'none', JSON.stringify(anfang));
    ok('… nimmt keinen Platz ein', anfang.breite === 0, JSON.stringify(anfang));
    ok('… und zeigt keine Initialen', anfang.text === '', JSON.stringify(anfang));

    console.log('\n── Auf „Mein Konto" gibt es dagegen eine Vorschau-Fläche ──');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#avatar-vorschau'); await sleep(900);
    const vorschauLeer = await page.evaluate(() => {
      const a = document.querySelector('#avatar-vorschau .avatar');
      return a ? { text: a.textContent.trim(), breite: Math.round(a.getBoundingClientRect().width) } : null;
    });
    ok('dort stehen die Initialen', (vorschauLeer || {}).text === 'MM', JSON.stringify(vorschauLeer));
    ok('… und sie hat eine Fläche', (vorschauLeer || {}).breite > 50, JSON.stringify(vorschauLeer));

    console.log('\n── Bild hochladen ──');
    await page.waitForSelector('#avatar-waehlen'); await sleep(300);
    const eingabe = await page.$('#avatar-datei');
    await eingabe.uploadFile(bildDatei);
    await sleep(3000);
    const nachher = await page.evaluate(() => {
      const v = document.querySelector('#avatar-vorschau .avatar');
      const k = document.querySelector('#kopf-avatar .avatar');
      const lies = el => el ? { bild: getComputedStyle(el).backgroundImage, text: el.textContent.trim() } : null;
      return { vorschau: lies(v), kopf: lies(k) };
    });
    ok('die Vorschau zeigt ein Bild', /blob:/.test((nachher.vorschau || {}).bild || ''), JSON.stringify(nachher.vorschau));
    ok('… und die Initialen sind daraus verschwunden', (nachher.vorschau || {}).text === '', JSON.stringify(nachher.vorschau));
    ok('die Kopfzeile zieht sofort mit', /blob:/.test((nachher.kopf || {}).bild || ''), JSON.stringify(nachher.kopf));

    const verstoss = meldungen.filter(m => /Content Security Policy|Refused to load/i.test(m));
    ok('die Sicherheitsrichtlinie erlaubt das Bild (keine Verletzung in der Konsole)',
      verstoss.length === 0, verstoss.slice(0, 2).join(' | '));

    console.log('\n── Nach einem Neuladen ist es immer noch da ──');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const nachReload = await page.evaluate(() => {
      const k = document.querySelector('#kopf-avatar .avatar');
      return k ? getComputedStyle(k).backgroundImage : null;
    });
    ok('Bild in der Kopfzeile', /blob:/.test(nachReload || ''), String(nachReload));

    console.log('\n── Entfernen ──');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#avatar-weg'); await sleep(700);
    await page.click('#avatar-weg');
    await sleep(2200);
    const weg = await page.evaluate(() => {
      const v = document.querySelector('#avatar-vorschau .avatar');
      const k = document.querySelector('#kopf-avatar .avatar');
      return { vorschau: v ? { bild: getComputedStyle(v).backgroundImage, text: v.textContent.trim() } : null,
               kopf: k ? k.textContent.trim() : null };
    });
    ok('die Vorschau zeigt wieder Initialen', (weg.vorschau || {}).text === 'MM' && (weg.vorschau || {}).bild === 'none',
      JSON.stringify(weg.vorschau));
    ok('… und die Kopfzeile ist wieder leer, wie vor den Profilbildern',
      weg.kopf === '' , JSON.stringify(weg));
    ok('der Knopf heißt wieder „Bild hochladen"',
      /Bild hochladen/.test(await page.$eval('#avatar-waehlen', el => el.textContent)));

    console.log('\n── Avatare an den Stellen, wo man Personen unterscheidet ──');
    // Noch einmal hochladen, damit es etwas zu sehen gibt.
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#avatar-datei'); await sleep(600);
    await (await page.$('#avatar-datei')).uploadFile(bildDatei);
    await sleep(2500);

    // Ohne Daten gibt es gar keine Spalten — die Zeitleiste zeigt dann „Keine Planungen fuer
    // diesen Tag". Daran ist dieser Abschnitt beim ersten Lauf umgefallen: nicht am Avatar,
    // sondern am leeren Tag.
    const adminT = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const alle = (await req('GET', '/api/users', adminT)).body.users || [];
    const heute = new Date().toLocaleDateString('sv-SE');
    for (const u of alle.filter(x => x.role === 'mitarbeiter').slice(0, 2)) {
      await req('POST', '/api/planning', adminT,
        { date: heute, time_from: '07:00', time_to: '15:30', description: 'Baustelle', assigned_user_ids: [u.id] });
      await req('POST', '/api/entries', adminT,
        { user_id: u.id, date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'Arbeit' });
    }

    // Als Chef anmelden, der sieht alle Spalten.
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'chef'); await page.type('#login-pass', pw('chef'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2200);

    for (const [name, route, wo] of [
      ['Planung', '#/planning', '.tl-col-header-name .avatar'],
      ['Zeitnachweis', '#/', '.tl-col-header-name .avatar'],
      ['Mitarbeiter-Liste', '#/users', '.data-table .avatar'],
    ]) {
      await page.goto(BASIS + '/' + route, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      const gefunden = await page.evaluate((sel) => {
        const els = [...document.querySelectorAll(sel)];
        const mitBild = els.filter(e => /blob:/.test(getComputedStyle(e).backgroundImage));
        const ohneBildUnsichtbar = els.filter(e => getComputedStyle(e).display === 'none');
        return { anzahl: els.length, mitBild: mitBild.length, ohneBildUnsichtbar: ohneBildUnsichtbar.length };
      }, wo);
      ok(`${name}: Avatare sind da`, gefunden.anzahl > 0, JSON.stringify(gefunden));
      ok(`${name}: … mindestens einer zeigt das Bild`, gefunden.mitBild >= 1, JSON.stringify(gefunden));
      ok(`${name}: … wer kein Bild hat, belegt keinen Platz`,
        gefunden.ohneBildUnsichtbar === gefunden.anzahl - gefunden.mitBild, JSON.stringify(gefunden));

      // „Ein Bild ist da" ist nicht dasselbe wie „das Bild ist zu sehen". Genau daran hing ein
      // Fehler, den kein bisheriger Test bemerkt hat: Die Kurzform `background:` im inline-style
      // setzt background-size/-position auf ihre Ausgangswerte zurueck und schlaegt dabei das
      // Stylesheet. Das Bild wurde dann in Originalgroesse oben links angesetzt — im 26-px-Kreis
      // sah man nur eine Ecke, meist einfarbiger Hintergrund. Deshalb wird hier gemessen, WIE
      // gemalt wird, nicht nur DASS etwas gemalt wird.
      const gemalt = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
        .filter(e => /blob:/.test(getComputedStyle(e).backgroundImage))
        .map(e => ({ kante: Math.round(e.getBoundingClientRect().width),
                     groesse: getComputedStyle(e).backgroundSize,
                     pos: getComputedStyle(e).backgroundPosition })), wo);
      ok(`${name}: … das Bild fuellt den Kreis (background-size: cover)`,
        gemalt.length > 0 && gemalt.every(g => g.groesse === 'cover'), JSON.stringify(gemalt));
      ok(`${name}: … und ist mittig ausgerichtet`,
        gemalt.every(g => /50%\s+50%|center/.test(g.pos)), JSON.stringify(gemalt));
    }

    console.log('\n── Das Bild darf den Namen nicht in die naechste Zeile druecken ──');
    // Ein Profilbild kostet in der Namensspalte rund 34 px. Ohne Mindestbreite quetscht
    // `table { width: 100% }` die Spalte auf schmalen Bildschirmen so weit zusammen, dass
    // Namen umbrechen. Gemessen wird ueber die HOEHE, nicht ueber getClientRects(): Der Name
    // ist ein Flex-Kind und damit ein Block — er liefert immer genau EIN Rechteck, auch bei
    // drei Zeilen Text. (Genau daran war die erste Fassung dieser Messung blind.)
    await page.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' }); await sleep(2000);
    for (const [marke, breite] of [['Rechner', 1100], ['Tablet', 700], ['Handy', 380]]) {
      await page.setViewport({ width: breite, height: 800 });
      await sleep(900);
      const mess = await page.evaluate(() => {
        const zeilen = [...document.querySelectorAll('#users-tbody tr')].map(tr => {
          const spans = [...tr.querySelector('td').querySelectorAll('span')];
          const name = spans[spans.length - 1];
          const zh = parseFloat(getComputedStyle(name).lineHeight) || 16;
          return { text: name.textContent.trim(), zeilen: Math.max(1, Math.round(name.getBoundingClientRect().height / zh)) };
        });
        const wrap = document.querySelector('.table-wrap');
        return { zeilen,
          seitlich: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          schiebbar: wrap ? wrap.scrollWidth - wrap.clientWidth : -1 };
      });
      const umgebrochen = mess.zeilen.filter(z => z.zeilen > 1);
      ok(`${marke} (${breite} px): kein Name bricht um`, umgebrochen.length === 0,
        JSON.stringify(umgebrochen));
      ok(`${marke}: die Seite laeuft dabei nicht seitlich weg`, mess.seitlich <= 1,
        `${mess.seitlich} px Ueberhang`);
    }
    // Gegenprobe zur Messung selbst: Ein absurd langer Name MUSS umbrechen — sonst misst der
    // Test nur leere Luft und waere gruen, egal was das Layout tut.
    await page.setViewport({ width: 380, height: 800 });
    const bricht = await page.evaluate(() => {
      const spans = [...document.querySelector('#users-tbody tr td').querySelectorAll('span')];
      const name = spans[spans.length - 1];
      const alt = name.textContent;
      name.textContent = 'Maximiliane Charlotte von Hohenberg-Lichtenstein';
      const zh = parseFloat(getComputedStyle(name).lineHeight) || 16;
      const z = Math.round(name.getBoundingClientRect().height / zh);
      name.textContent = alt;
      return z;
    });
    ok('Gegenprobe: ein absurd langer Name bricht sehr wohl um (die Messung ist nicht blind)',
      bricht > 1, `${bricht} Zeile(n)`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(bildDatei); } catch (_) {}
  }
  console.log(`\nProfilbilder (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
