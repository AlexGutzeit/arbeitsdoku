// Kollegen (Oberfläche): Menü mit den Kollegen als Unterpunkten, Übersicht, Seite einer Person, vCard,
// „Für die Kollegen" auf Mein Konto samt Vorschau — am Rechner und am Handy.
//
// Was der Server freigibt, prüft tests/kollegen.js. Hier geht es darum, dass die Oberfläche es richtig zeigt:
// Telefon als Anruf-Link, Zeilenumbrüche im Infotext, keine leeren Zeilen für nicht Freigegebenes, ein
// Bild bzw. Initialen bei jedem, und dass die Haken in Mein Konto nur gehen, wenn es etwas zu zeigen gibt.
//
//   node tests/kollegen-ui.js            (Bildschirmfotos: KOLLEGEN_FOTOS=<ordner>)
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3371, DB = '/tmp/kollegen-ui.db', BASIS = `http://localhost:${PORT}`;
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const FOTOS = process.env.KOLLEGEN_FOTOS || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
function hochladen(token, buf) {
  const rand = '----ku' + Date.now();
  const koerper = Buffer.concat([
    Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="bild"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf, Buffer.from(`\r\n--${rand}--\r\n`)]);
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': koerper.length } },
      x => { x.resume(); x.on('end', () => res(x.statusCode)); });
    r.on('error', rej); r.write(koerper); r.end();
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  if (FOTOS) fs.mkdirSync(FOTOS, { recursive: true });
  const lg = fs.openSync('/tmp/kollegen-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/kollegen-ui-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const login = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body;
    const admin = await login('admin', pw('admin'));
    const anlegen = async (username, name, extra = {}) => (await req('POST', '/api/users', admin.token, {
      username, password: 'Start!2345', name, role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40, ...extra })).body.user;
    const anna = await anlegen('anna', 'Anna Berger', { birth_date: '1990-03-12' });
    const bernd = await anlegen('bernd', 'Bernd Kraus');
    const annaT = (await login('anna', 'Start!2345')).token;
    ok('Profilbild für Anna', (await hochladen(annaT, await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 30, g: 110, b: 170 } } }).png().toBuffer())) < 300);
    await req('PUT', '/api/kollegen/mein-profil', annaT, { info: 'Ansprechpartnerin für Heizung\nspreche Polnisch',
      telefon: '+49 171 234-5678', telefon_zeigen: true, email: 'anna.geheim@beispiel.de', email_zeigen: false });
    await req('PUT', '/api/users/geburtstag-freigabe', annaT, { zeigen: true, alter_auch: true });
    const w = (await req('POST', '/api/tools', admin.token, { name: 'Bohrhammer Hilti' })).body;
    await req('POST', `/api/tools/${(w.tool || w).id}/checkout`, annaT, { project_text: 'Baustelle Müller' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const neueSeite = async (vp, u, p) => {
      const s = await browser.newPage(); await s.setViewport(vp); s.setDefaultTimeout(30000);
      s.on('pageerror', e => fehler.push(String(e)));
      s.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fehler.push(m.text()); });
      await s.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await s.evaluate(() => localStorage.clear());
      await s.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await s.waitForSelector('#login-user');
      await s.type('#login-user', u); await s.type('#login-pass', p);
      await s.click('#login-form button[type="submit"]'); await sleep(2500);
      return s;
    };
    const foto = async (s, name) => { if (FOTOS) await s.screenshot({ path: path.join(FOTOS, name + '.png') }); };
    const gruppe = (s) => s.evaluate(() => {
      const g = document.getElementById('nav-kollegen');
      return g && { offen: g.classList.contains('open'),
        punkte: [...g.querySelectorAll('.nav-subitem')].filter(a => getComputedStyle(a).display !== 'none')
          .map(a => (a.querySelector('.nav-kollege-name') || a).textContent.trim().replace(/\s+/g, ' ')),
        bilder: [...g.querySelectorAll('.avatar')].map(a => ({ wer: a.title, bild: /blob:/.test(getComputedStyle(a).backgroundImage), text: a.textContent.trim(), sichtbar: getComputedStyle(a).display !== 'none' })) };
    });

    console.log('── Menü (Bernd am Rechner) ──');
    let p = await neueSeite({ width: 1280, height: 900 }, 'bernd', 'Start!2345');
    await p.click('#menu-btn'); await sleep(800);
    let g = await gruppe(p);
    ok('Menüpunkt „Kollegen" da, anfangs zu', g && !g.offen && g.punkte.length === 0, JSON.stringify(g));
    await p.click('#nav-kollegen-label'); await sleep(400);
    g = await gruppe(p);
    ok('Antippen klappt auf: „Alle Kollegen" und die Namen', g.offen && g.punkte[0] === 'Alle Kollegen'
      && g.punkte.includes('Anna Berger') && g.punkte.includes('Chef') && g.punkte.includes('Max Mustermann'), JSON.stringify(g.punkte));
    ok('… ohne das Admin-Konto und ohne einen selbst', !g.punkte.includes('Administrator') && !g.punkte.includes('Bernd Kraus'));
    const bildAnna = g.bilder.find(b => b.wer === 'Anna Berger'), bildMax = g.bilder.find(b => b.wer === 'Max Mustermann');
    ok('… Anna mit ihrem Bild', bildAnna && bildAnna.bild, JSON.stringify(bildAnna));
    ok('… Max ohne Bild mit Initialen (Personenliste)', bildMax && !bildMax.bild && bildMax.sichtbar && bildMax.text === 'MM', JSON.stringify(bildMax));
    await foto(p, '1-menue');
    await p.click('#nav-kollegen-label'); await sleep(400);
    ok('… und wieder zu', !(await gruppe(p)).offen);

    console.log('\n── Annas Seite ──');
    await p.click('#nav-kollegen-label'); await sleep(300);
    await p.evaluate(() => [...document.querySelectorAll('#nav-kollegen .nav-subitem')].find(a => /Anna/.test(a.textContent)).click());
    await sleep(2000);
    ok('Klick führt zu ihrer Seite', await p.evaluate(id => location.hash === '#/kollegen/' + id, anna.id));
    const seite = await p.evaluate(() => {
      const m = document.querySelector('.main');
      const tel = m.querySelector('a[href^="tel:"]');
      return { text: m.innerText, name: (m.querySelector('.kollege-name') || {}).textContent,
        tel: tel && tel.getAttribute('href'), telText: tel && tel.textContent, mail: !!m.querySelector('a[href^="mailto:"]'),
        infoHtml: (m.querySelector('.kollege-info-text') || {}).innerHTML, vcard: !!m.querySelector('#kollege-vcard'),
        bild: (() => { const a = m.querySelector('.kollege-kopf .avatar'); return a && { breite: Math.round(a.getBoundingClientRect().width), bild: /blob:/.test(getComputedStyle(a).backgroundImage) }; })(),
        menueAktiv: (document.querySelector('#nav-kollegen .nav-subitem.active') || {}).textContent };
    });
    ok('Name und großes Bild (96 px)', seite.name === 'Anna Berger' && seite.bild && seite.bild.breite === 96 && seite.bild.bild, JSON.stringify(seite.bild));
    const [hj, hm, ht] = new Date().toLocaleDateString('sv-SE').split('-').map(Number);
    const alter = hj - 1990 - ((hm < 3 || (hm === 3 && ht < 12)) ? 1 : 0);
    ok(`Geburtstag „12. März · ${alter} Jahre"`, seite.text.includes(`12. März · ${alter} Jahre`), seite.text.slice(0, 300));
    ok('Telefon als Anruf-Link (nur Ziffern und +)', seite.tel === 'tel:+491712345678' && seite.telText === '+49 171 234-5678', seite.tel);
    ok('keine E-Mail-Zeile (nicht freigegeben)', !seite.mail && !/E-Mail/.test(seite.text));
    ok('Infotext mit Zeilenumbruch', seite.infoHtml === 'Ansprechpartnerin für Heizung<br>spreche Polnisch', seite.infoHtml);
    ok('ausgeliehenes Werkzeug mit Baustelle', /Bohrhammer Hilti · Baustelle Müller · seit/.test(seite.text), seite.text.slice(-200));
    ok('im Menü ist Anna markiert', (seite.menueAktiv || '').includes('Anna Berger'), seite.menueAktiv);
    await foto(p, '2-anna');

    console.log('\n── vCard ──');
    await p.evaluate(() => { window.dateiHerunterladen = (blob, name) => blob.text().then(t => { window._vcard = { name, t }; }); });
    await p.click('#kollege-vcard'); await sleep(1500);
    const vc = await p.evaluate(() => window._vcard);
    ok('„Ins Telefonbuch übernehmen" lädt die Kontaktkarte', vc && vc.name === 'Anna Berger.vcf' && /BEGIN:VCARD/.test(vc.t), vc && vc.name);
    ok('… mit Telefon, Geburtstag und Foto — ohne die E-Mail', vc && /TEL;TYPE=CELL:\+49 171 234-5678/.test(vc.t) && /BDAY:1990-03-12/.test(vc.t)
      && /PHOTO;/.test(vc.t) && !/anna\.geheim/.test(vc.t));

    console.log('\n── Übersicht ──');
    await p.goto(BASIS + '/#/kollegen', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    const karten = await p.$$eval('.kollegen-karte', ks => ks.map(k => ({ text: k.innerText.replace(/\s+/g, ' ').trim(), href: k.getAttribute('href'),
      bild: /blob:/.test(getComputedStyle(k.querySelector('.avatar')).backgroundImage), initialen: k.querySelector('.avatar').textContent.trim() })));
    ok('eine Karte je Kollege (Buchhalter, Chef, Max, Anna)', karten.length === 4, JSON.stringify(karten.map(k => k.text)));
    ok('… mit Rolle', karten.some(k => k.text === 'Anna Berger Mitarbeiter'), JSON.stringify(karten.map(k => k.text)));
    ok('… Anna mit Bild, die anderen mit Initialen', karten.find(k => /Anna/.test(k.text)).bild && karten.filter(k => !/Anna/.test(k.text)).every(k => !k.bild && k.initialen.length === 2));
    await foto(p, '3-uebersicht');

    console.log('\n── „Neu im Team" wird angezeigt (Antwort des Servers nachgestellt — die Regel prüft kollegen.js) ──');
    await p.setRequestInterception(true);
    const umbauen = r => {
      if (/\/api\/kollegen(\/\d+)?$/.test(r.url()) && r.method() === 'GET') {
        return http.get(r.url(), { headers: r.headers() }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => {
          const j = JSON.parse(s);
          if (j.kollegen) j.kollegen.forEach(k => { if (k.name === 'Max Mustermann') k.neu = true; });
          if (j.name === 'Max Mustermann') j.neu = true;
          r.respond({ status: x.statusCode, contentType: 'application/json', body: JSON.stringify(j) });
        }); });
      }
      r.continue();
    };
    p.on('request', umbauen);
    // goto() auf dieselbe Adresse lädt NICHT neu — also erst weg und wieder hin
    await p.evaluate(() => { location.hash = '#/welcome'; }); await sleep(1200);
    await p.evaluate(() => { location.hash = '#/kollegen'; }); await sleep(2200);
    ok('Marke „neu" an Max\' Karte', await p.evaluate(() => [...document.querySelectorAll('.kollegen-karte')].some(k => /Max/.test(k.textContent) && k.querySelector('.kollege-neu'))));
    ok('… und im Menü', await p.evaluate(() => [...document.querySelectorAll('#nav-kollegen .nav-kollege')].some(k => /Max/.test(k.textContent) && k.querySelector('.kollege-neu'))));
    const max = (await req('GET', '/api/kollegen', annaT)).body.kollegen.find(k => k.name === 'Max Mustermann');
    await p.goto(BASIS + '/#/kollegen/' + max.id, { waitUntil: 'domcontentloaded' }); await sleep(2000);
    ok('… und auf seiner Seite „Neu im Team"', await p.evaluate(() => /Neu im Team/.test((document.querySelector('.kollege-kopf') || {}).textContent || '')));
    ok('wer nichts freigegeben hat: ein freundlicher Satz statt leerer Felder', await p.evaluate(() => /Max hat noch nichts für die Kollegen freigegeben/.test(document.querySelector('.main').innerText)));
    ok('… und keine Telefonbuch-Schaltfläche', !(await p.$('#kollege-vcard')));
    p.off('request', umbauen); await p.setRequestInterception(false);

    console.log('\n── Mein Konto → „Für die Kollegen" (Bernd) ──');
    await p.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#kollegen-profil-form'); await sleep(600);
    ok('Haken bei leerem Telefon gesperrt', await p.$eval('#kk-telefon-zeigen', e => e.disabled));
    ok('ohne hinterlegtes Geburtsdatum ist der Geburtstags-Haken gesperrt', await p.$eval('#geb-zeigen', e => e.disabled));
    ok('die Geburtstagskarte darüber verweist auf „Für die Kollegen"', /Für die Kollegen/.test(await p.$eval('#konto-geburtstag', e => e.innerText)));
    await p.type('#kk-telefon', 'abc');
    await p.click('#kk-telefon-zeigen'); await p.click('#kollegen-profil-form button[type="submit"]'); await sleep(900);
    ok('ungültige Nummer: die Meldung steht an der Karte', /Telefonnummer/.test(await p.$eval('#kk-fehler', e => e.textContent)), await p.$eval('#kk-fehler', e => e.textContent));
    await p.$eval('#kk-telefon', e => { e.focus(); e.select(); }); await p.keyboard.press('Backspace');
    ok('Telefon wieder leer → Haken gesperrt und raus', await p.$eval('#kk-telefon-zeigen', e => e.disabled && !e.checked));
    await p.type('#kk-telefon', '0151 9876543');
    ok('mit Nummer wieder wählbar', !(await p.$eval('#kk-telefon-zeigen', e => e.disabled)));
    await p.click('#kk-telefon-zeigen');
    await p.type('#kk-email', 'bernd@beispiel.de');                 // eingetragen, aber NICHT freigegeben
    await p.type('#kk-info', 'Fahre den Sprinter');
    ok('Zeichenzähler läuft mit', (await p.$eval('#kk-zeichen', e => e.textContent)) === '18');
    await p.click('#kollegen-profil-form button[type="submit"]'); await sleep(1000);
    const gespeichert = (await req('GET', '/api/kollegen/mein-profil', (await login('bernd', 'Start!2345')).token)).body;
    ok('gespeichert, wie eingegeben', gespeichert.telefon === '0151 9876543' && gespeichert.telefon_zeigen && gespeichert.email === 'bernd@beispiel.de'
      && !gespeichert.email_zeigen && gespeichert.info === 'Fahre den Sprinter', JSON.stringify(gespeichert));
    await foto(p, '4-konto');
    await p.click('a[href="#/kollegen/' + bernd.id + '"]'); await sleep(2000);
    const vorschau = await p.evaluate(() => document.querySelector('.main').innerText);
    ok('„So sehen dich deine Kollegen": Vorschau mit Telefon und Text, ohne E-Mail',
      /So sehen dich deine Kollegen/.test(vorschau) && /0151 9876543/.test(vorschau) && /Fahre den Sprinter/.test(vorschau) && !/bernd@beispiel/.test(vorschau), vorschau.slice(0, 300));
    await p.click('.kollege-vorschau a'); await sleep(2500);
    // Die Karte steht von sich aus weiter unten (unter Profilbild und Geburtstag) — ohne Sprung wäre ihr Kopf
    // NICHT direkt unter der Kopfleiste. Und mit Sprung darf er nicht HINTER der festen Kopfleiste verschwinden.
    const sprung = await p.evaluate(() => {
      const k = document.getElementById('konto-kollegen'), kopf = document.querySelector('.header');
      if (!k || location.hash !== '#/konto') return null;
      return { karte: Math.round(k.getBoundingClientRect().top), leiste: Math.round(kopf.getBoundingClientRect().bottom) };
    });
    ok('der Link zurück springt zur Karte in Mein Konto — direkt unter die Kopfleiste, nicht dahinter',
      sprung && sprung.karte >= sprung.leiste && sprung.karte < sprung.leiste + 60, JSON.stringify(sprung));
    await p.close();

    console.log('\n── Am Handy (Anna) ──');
    p = await neueSeite({ width: 400, height: 850, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'anna', 'Start!2345');
    await p.click('#menu-btn'); await sleep(800);
    const lbl = await p.evaluate(() => { const e = document.getElementById('nav-kollegen-label'); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + 40, y: b.y + b.height / 2 }; });
    await p.touchscreen.tap(lbl.x, lbl.y); await sleep(500);
    g = await gruppe(p);
    ok('Antippen klappt die Kollegen auf', g.offen && g.punkte.includes('Bernd Kraus'), JSON.stringify(g.punkte));
    await foto(p, '5-handy-menue');
    const bpos = await p.evaluate(() => { const a = [...document.querySelectorAll('#nav-kollegen .nav-subitem')].find(x => /Bernd/.test(x.textContent)); const b = a.getBoundingClientRect(); return { x: b.x + 60, y: b.y + b.height / 2 }; });
    await p.touchscreen.tap(bpos.x, bpos.y); await sleep(2200);
    const handy = await p.evaluate(() => ({ hash: location.hash, breit: document.documentElement.scrollWidth <= innerWidth + 1,
      tel: !!document.querySelector('.main a[href="tel:015198765430"], .main a[href="tel:01519876543"]') }));
    ok('Bernds Seite am Handy, ohne seitliches Scrollen, mit Anruf-Link', /#\/kollegen\/\d+/.test(handy.hash) && handy.breit && handy.tel, JSON.stringify(handy));
    await foto(p, '6-handy-bernd');
    await p.close();

    console.log('\n── Als Admin ──');
    p = await neueSeite({ width: 1280, height: 900 }, 'admin', pw('admin'));
    await p.goto(BASIS + '/#/kollegen', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    const adminKarten = await p.$$eval('.kollegen-karte strong', ks => ks.map(k => k.textContent));
    ok('der Admin sieht alle Kollegen (fünf), sich selbst nicht', adminKarten.length === 5 && !adminKarten.includes('Administrator'), JSON.stringify(adminKarten));
    await p.close();

    ok('keine JavaScript-Fehler', fehler.length === 0, fehler.slice(0, 3).join(' | '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nKollegen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
