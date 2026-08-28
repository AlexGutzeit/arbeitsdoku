// Abwesenheitskalender: wer fehlt wann, alle Mitarbeiter auf einen Blick (Alex, 28.08.2026).
//
// „Aktuell fehlt noch die Ansicht, in der man über Monats- und Jahresansicht alle Abwesenheiten
// aller Mitarbeiter auf einen Blick sieht."
//
// WAS HIER WIRKLICH AUF DEM SPIEL STEHT — und warum die Prüfungen so aussehen, wie sie aussehen:
//
//  * DER VOLLE TAG. In den echten Daten waren am 05.06.2026 acht von zwölf gleichzeitig weg. Genau
//    solche Tage sind der Grund für die Ansicht, und genau sie brechen ein Kalenderblatt („+5
//    weitere"). Deshalb wird nicht geprüft, ob „irgendwas gezeichnet wird", sondern ob an diesem
//    Tag WIRKLICH ACHT Balken stehen.
//
//  * DER ÜBERSTEHENDE ZEITRAUM. Der längste echte ist 47 Tage (11.01.–26.02.2027). Wer im Februar
//    schaut, darf nicht denken, der Zeitraum beginne am Monatsersten — die Schnittkante muss als
//    solche erkennbar sein.
//
//  * FEIERTAGE HABEN KEINEN BESITZER (user_id NULL). Als eigene Zeile würden sie jede Zeile füllen;
//    sie gehören als Spalte hinter alle Zeilen.
//
//  * WER DARF ES SEHEN. Manager-Sicht heißt hier Admin, Chef UND Buchhalter (lesend). Ein
//    Mitarbeiter — auch einer mit Rechten — darf den Reiter nicht einmal sehen.
//
//   node tests/abwesenheitskalender-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3298, DB = '/tmp/abwesenheitskalender.db', LOG = '/tmp/abwesenheitskalender-srv.log';
const BASIS = `http://localhost:${PORT}`;
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

// Ein fester Monat, damit die Zahlen unabhaengig vom Testtag stimmen. Juni 2026 bildet den echten
// Fall nach: der 05. ist der volle Tag, der 04. ein Feiertag.
const JAHR = 2026, MONAT = '2026-06';

async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  seite.setDefaultTimeout(45000);
  await seite.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await seite.waitForSelector('a[href="#/statistics"]'); await sleep(700);
  return { ktx, seite };
}

const kalenderOeffnen = async (seite, anker, modus) => {
  await seite.goto(BASIS + '/#/absences', { waitUntil: 'domcontentloaded' });
  await seite.waitForSelector('.absence-tab, .absence-empty'); await sleep(1500);
  await seite.evaluate((a, m) => { Abwesenheitskalender.zustand.anker = a; Abwesenheitskalender.zustand.modus = m; }, anker, modus);
  await seite.evaluate(() => {
    const b = [...document.querySelectorAll('.absence-tab')].find(x => x.dataset.tab === 'kalender');
    if (b) b.click();
  });
  await sleep(1500);
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;
    const PW = 'K4lender!Test';

    // Acht Mitarbeiter, damit der volle Tag ueberhaupt entstehen kann.
    const namen = ['Anna Abel', 'Bert Busch', 'Cem Celik', 'Dora Dietz', 'Emil Ernst', 'Frida Funk', 'Gero Groß', 'Hans Huber'];
    const ids = [];
    for (let i = 0; i < namen.length; i++) {
      const r = await req('POST', '/api/users', admin, { username: 'ma' + i, password: PW, name: namen[i],
        role: 'mitarbeiter', target_hours_per_week: 40 });
      ids.push(r.body.user.id);
    }
    // Ein Buchhalter (lesende Manager-Sicht) und ein Mitarbeiter MIT Rechten (darf es NICHT sehen).
    await req('POST', '/api/users', admin, { username: 'buchi', password: PW, name: 'Bea Buch', role: 'buchhalter', target_hours_per_week: 40 });
    await req('POST', '/api/users', admin, { username: 'vorarbeiter', password: PW, name: 'Volker Vor',
      role: 'mitarbeiter', target_hours_per_week: 40, can_plan: true, can_order: true, can_bulletin: true });

    // Anlegen UND pruefen. Ohne die Zusicherung koennte der eigentliche Fall („acht Balken")
    // aus dem falschen Grund gruen oder rot sein — man saehe nur die Wirkung, nie die Ursache.
    const angelegt = [];
    const abw = async (uid, typ, von, bis) => {
      const r = await req('POST', '/api/absences', admin, { target_user_id: uid, type: typ, date_from: von, date_to: bis });
      angelegt.push({ typ, von, status: r.status, fehler: r.body && r.body.error });
      return r;
    };

    // DER VOLLE TAG: acht Leute am 05.06.2026 (5x Urlaub, 3x Freizeitausgleich) — wie in echt.
    for (let i = 0; i < 5; i++) await abw(ids[i], 'urlaub', MONAT + '-05', MONAT + '-05');
    for (let i = 5; i < 8; i++) await abw(ids[i], 'freizeitausgleich', MONAT + '-05', MONAT + '-05');
    // Ein Zeitraum, der ueber BEIDE Monatsraender hinauslaeuft.
    await abw(ids[0], 'berufsschule', '2026-05-20', '2026-07-10');
    // Ein Feiertag ohne Besitzer.
    await req('POST', '/api/absences', admin, { type: 'feiertag', date_from: MONAT + '-04', date_to: MONAT + '-04', comment: 'Fronleichnam' });
    // Ein noch nicht genehmigter Antrag (Mitarbeiter beantragt selbst -> pending).
    const maTok = (await req('POST', '/api/auth/login', null, { username: 'ma1', password: PW })).body.token;
    await req('POST', '/api/absences', maTok, { type: 'urlaub', date_from: MONAT + '-22', date_to: MONAT + '-24' });

    // Ein ALTER, laengst abgeschlossener Eintrag. Der landet im „Verlauf", und dessen Monate werden
    // erst beim Aufklappen gezeichnet. Genau diesen Fall hat der erste Anlauf komplett verfehlt:
    // Der Sprung suchte eine Karte, die im Dokument noch gar nicht existierte, und tat still
    // nichts. In echten Daten ist das der Normalfall — alles aelter als eine Woche liegt dort.
    const langHer = (() => { const d = new Date(); d.setMonth(d.getMonth() - 5); return d.toISOString().slice(0, 10); })();
    const altR = await abw(ids[6], 'sonderurlaub', langHer, langHer);
    const altId = altR.body && altR.body.absence && altR.body.absence.id;
    // GENEHMIGEN ist hier Pflicht, nicht Beiwerk: Ein offener Antrag steht immer oben in der
    // Liste („recent"), egal wie alt er ist — er waere also im Dokument und der Test liefe am
    // eigentlichen Fall vorbei. Erst genehmigt wandert er in den Verlauf. (Genau daran ist der
    // erste Anlauf gescheitert: Die Gegenprobe blieb gruen.)
    const altGen = await req('POST', `/api/absences/${altId}/approve`, admin);
    ok('der alte Eintrag ist genehmigt und liegt damit im Verlauf',
      altGen.status === 200, altGen.status + ' ' + altGen.text.slice(0, 80));

    const misslungen = angelegt.filter(x => x.status !== 201 && x.status !== 200);
    ok('alle Testdaten wurden wirklich angelegt', misslungen.length === 0, JSON.stringify(misslungen.slice(0, 4)));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];

    console.log('── Wer den Reiter sieht ──');
    let a = await anmelden(browser, 'admin', pwAdmin);
    a.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await a.seite.goto(BASIS + '/#/absences', { waitUntil: 'domcontentloaded' }); await sleep(1800);
    const reiterAdmin = await a.seite.$$eval('.absence-tab', els => els.map(e => e.dataset.tab));
    ok('Admin sieht den Kalender-Reiter', reiterAdmin.includes('kalender'), JSON.stringify(reiterAdmin));

    const b = await anmelden(browser, 'buchi', PW);
    await b.seite.goto(BASIS + '/#/absences', { waitUntil: 'domcontentloaded' }); await sleep(1800);
    ok('Buchhalter auch (er hat lesende Manager-Sicht)',
      (await b.seite.$$eval('.absence-tab', els => els.map(e => e.dataset.tab))).includes('kalender'));

    const v = await anmelden(browser, 'vorarbeiter', PW);
    await v.seite.goto(BASIS + '/#/absences', { waitUntil: 'domcontentloaded' }); await sleep(1800);
    const reiterMa = await v.seite.$$eval('.absence-tab', els => els.map(e => e.dataset.tab));
    ok('ein Mitarbeiter mit Rechten NICHT', !reiterMa.includes('kalender'), JSON.stringify(reiterMa));
    ok('… und seine eigene Liste steht unverändert da',
      await v.seite.evaluate(() => !!document.querySelector('.absence-all-header, .absence-empty')));
    await v.seite.close(); await v.ktx.close();
    await b.seite.close(); await b.ktx.close();

    console.log('\n── Der volle Tag: 8 von 12 gleichzeitig weg ──');
    await kalenderOeffnen(a.seite, MONAT + '-01', 'monat');
    const mess = async (tag) => a.seite.evaluate((t) => {
      const kopf = [...document.querySelectorAll('.abscal-kopf-tag')].find(e => e.textContent.trim().endsWith(t));
      if (!kopf) return null;
      const r = kopf.getBoundingClientRect();
      const balken = [...document.querySelectorAll('.abscal-bar')].filter(el => {
        const q = el.getBoundingClientRect();
        return q.left <= r.left + r.width / 2 && q.right >= r.left + r.width / 2;
      });
      // Zeilen statt Balken zaehlen: Wer an einem Tag zwei Eintraege hat (Urlaub UND
      // Berufsschule), ist trotzdem EIN Mensch, der fehlt.
      const zeilen = new Set(balken.map(el => Math.round(el.getBoundingClientRect().top)));
      return { menschen: zeilen.size, balken: balken.length,
               arten: [...new Set(balken.map(el => el.className.match(/abscal-bar--(\w+)/)?.[1]))].sort() };
    }, tag);
    const voll = await mess('05');
    ok('am 05.06. sind wirklich ACHT Menschen als abwesend gezeichnet',
      voll && voll.menschen === 8, JSON.stringify(voll));
    ok('… und zwar Urlaub UND Freizeitausgleich, nicht in einen Topf geworfen',
      voll && voll.arten.includes('urlaub') && voll.arten.includes('freizeitausgleich'), JSON.stringify(voll && voll.arten));

    console.log('\n── Die Tageszahl bleibt lesbar, auch unter einem Streifen ──');
    // Alex am 28.08.2026: „Der 4. Juni ist scheinbar ein Feiertag, aber das Datum ist nicht zu
    // sehen." In einem Grid gilt z-index auch ohne `position` — die Streifen hoben sich ueber die
    // Kopfzellen. NICHT mit elementFromPoint pruefen: die Streifen haben `pointer-events: none`,
    // das Werkzeug ueberspringt sie und meldet faelschlich „nichts verdeckt". Deshalb hier
    // kurzzeitig anfassbar machen und dann ehrlich nachfassen.
    const verdeckt = await a.seite.evaluate(() => {
      document.querySelectorAll('.abscal-spalte').forEach(e => e.style.pointerEvents = 'auto');
      const raus = [];
      for (const e of document.querySelectorAll('.abscal-kopf-tag')) {
        const q = e.getBoundingClientRect();
        const t = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
        if (t && /abscal-spalte/.test(t.className || '')) raus.push(e.textContent.trim());
      }
      document.querySelectorAll('.abscal-spalte').forEach(e => e.style.pointerEvents = '');
      return raus;
    });
    ok('keine Tageszahl wird von Wochenend- oder Feiertagsstreifen verdeckt',
      verdeckt.length === 0, 'verdeckt: ' + JSON.stringify(verdeckt));

    console.log('\n── Jeder hat seine eigene Zeile ──');
    const zeilen = await a.seite.$$eval('.abscal-name', els => els.map(e => e.textContent.trim()));
    ok('alle acht Mitarbeiter haben eine Zeile', namen.every(n => zeilen.includes(n)), JSON.stringify(zeilen));
    // Diese Zusicherung braucht einen Monat, in dem die Person auch ANGESTELLT ist. Die Testnutzer
    // entstehen heute (die API setzt den Eintritt immer auf heute), im Juni 2026 waren sie es also
    // nicht — dort erscheinen nur die mit Eintraegen, ueber das Sicherheitsnetz.
    const heuteAnker = new Date().toLocaleDateString('sv-SE').slice(0, 8) + '01';
    await kalenderOeffnen(a.seite, heuteAnker, 'monat');
    const zeilenHeute = await a.seite.$$eval('.abscal-name', els => els.map(e => e.textContent.trim()));
    ok('… auch wer gar nichts eingetragen hat (sonst wüsste man nicht, wer DA ist)',
      zeilenHeute.includes('Volker Vor'), JSON.stringify(zeilenHeute));
    await kalenderOeffnen(a.seite, MONAT + '-01', 'monat');
    ok('der Feiertag ist KEINE eigene Zeile', !zeilen.some(n => /feiertag|fronleichnam/i.test(n)), JSON.stringify(zeilen));
    ok('… sondern eine Spalte hinter allen Zeilen',
      (await a.seite.$$('.abscal-spalte--feiertag')).length === 1);

    console.log('\n── Was über den Rand läuft, sieht nicht aus wie ein Ende ──');
    const rand = await a.seite.evaluate(() => {
      const el = document.querySelector('.abscal-bar--berufsschule');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { links: el.className.includes('offen-links'), rechts: el.className.includes('offen-rechts'),
               randLinks: cs.borderLeftStyle, randRechts: cs.borderRightStyle };
    });
    ok('der Zeitraum vom 20.05. bis 10.07. ist an BEIDEN Rändern als offen markiert',
      rand && rand.links && rand.rechts, JSON.stringify(rand));
    ok('… und das ist auch sichtbar (gepunktete Kante)',
      rand && rand.randLinks === 'dotted' && rand.randRechts === 'dotted', JSON.stringify(rand));

    console.log('\n── Noch nicht genehmigt sieht anders aus ──');
    const offen = await a.seite.evaluate(() => {
      const el = document.querySelector('.abscal-bar--pending');
      return el ? { da: true, muster: getComputedStyle(el).backgroundImage.slice(0, 30) } : { da: false };
    });
    ok('der offene Antrag ist als solcher gezeichnet', offen.da, JSON.stringify(offen));
    ok('… und zwar schraffiert, nicht nur blasser (auf 3 px im Jahr sonst unsichtbar)',
      offen.da && /gradient/.test(offen.muster), JSON.stringify(offen));

    console.log('\n── Die Jahresansicht zeigt das ganze Jahr ──');
    await a.seite.evaluate(() => {
      [...document.querySelectorAll('.abscal-modus-btn')].find(b => b.dataset.modus === 'jahr').click();
    });
    await sleep(1200);
    const jahr = await a.seite.evaluate(() => {
      const sc = document.querySelector('.abscal-scroll');
      sc.scrollLeft = 99999;
      const koepfe = [...document.querySelectorAll('.abscal-kopf-monat')].map(e => e.textContent.trim());
      const letzter = [...document.querySelectorAll('.abscal-kopf-monat')].pop();
      const r = letzter.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      return { koepfe: koepfe.join(','), dezErreichbar: r.left >= sr.left - 1 && r.right <= sr.right + 1,
               balken: document.querySelectorAll('.abscal-bar').length,
               weStreifen: document.querySelectorAll('.abscal-spalte--we').length,
               seiteWaagerecht: Math.round(document.documentElement.scrollWidth - window.innerWidth) };
    });
    ok('alle zwölf Monate stehen im Kopf', jahr.koepfe === 'Jan,Feb,Mär,Apr,Mai,Jun,Jul,Aug,Sep,Okt,Nov,Dez', jahr.koepfe);
    ok('… Dezember ist durch Wischen erreichbar', jahr.dezErreichbar, JSON.stringify(jahr));
    ok('… die Abwesenheiten sind auch dort gezeichnet', jahr.balken > 0, String(jahr.balken));
    // 104 Wochenend-Streifen zu je 3 px ergaeben ein Barcode-Muster, das die Monatsnamen zerschneidet.
    ok('… und Wochenenden sind im Jahr NICHT gestreift (sonst Barcode)', jahr.weStreifen === 0, String(jahr.weStreifen));
    ok('die SEITE scrollt dabei nicht waagerecht — nur die Fläche', jahr.seiteWaagerecht <= 2, String(jahr.seiteWaagerecht));

    console.log('\n── Die Erklärung am Balken ist auch im Jahr erreichbar ──');
    // Alex wuenschte sich „bei der Jahresansicht ein mouseover mit Urlaub von–bis". Da ist es —
    // aber ein Ein-Tages-Balken ist im Jahr drei Pixel breit. Ohne vergroesserte Trefferflaeche
    // waere die Erklaerung zwar vorhanden und trotzdem unerreichbar.
    const treffer = await a.seite.evaluate(() => {
      const b = [...document.querySelectorAll('.abscal-bar')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .sort((x, y) => x.r.width - y.r.width)[0];
      if (!b) return null;
      const nach = getComputedStyle(b.el, '::after');
      return { schmalster: Math.round(b.r.width),
               flaecheLinks: nach.left, flaecheRechts: nach.right, hatFlaeche: nach.content !== 'none' };
    });
    ok('auch der schmalste Balken hat eine anfassbare Fläche',
      treffer && treffer.hatFlaeche, JSON.stringify(treffer));
    const bubble = await a.seite.evaluate(async () => {
      const el = document.querySelector('.abscal-bar');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: r.left + 1, clientY: r.top + 5 }));
      await new Promise(r2 => setTimeout(r2, 200));
      const t = document.querySelector('.entry-tooltip, #entry-tooltip');
      return t ? { sichtbar: t.style.display !== 'none', text: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) } : { sichtbar: false };
    });
    ok('Mouseover zeigt Name, Art und Zeitraum', bubble.sichtbar && /\d{2}\.\d{2}\.\d{4}/.test(bubble.text),
      JSON.stringify(bubble));

    console.log('\n── Der Name bleibt beim Wischen stehen ──');
    const klebt = await a.seite.evaluate(() => {
      const sc = document.querySelector('.abscal-scroll');
      sc.scrollLeft = 0;
      const n = document.querySelector('.abscal-name');
      const vorher = Math.round(n.getBoundingClientRect().left);
      sc.scrollLeft = 99999;
      const nachher = Math.round(n.getBoundingClientRect().left);
      const r = n.getBoundingClientRect();
      const oben = document.elementFromPoint(r.left + 20, r.top + 10);
      return { vorher, nachher, obenauf: oben ? (oben.className || oben.tagName) : 'nichts' };
    });
    ok('die Namensspalte wandert nicht mit', klebt.vorher === klebt.nachher, JSON.stringify(klebt));
    ok('… und wird nicht von Balken überdeckt', /abscal-name/.test(klebt.obenauf), JSON.stringify(klebt));

    console.log('\n── Am Handy ──');
    await a.seite.setViewport({ width: 411, height: 795 });
    await kalenderOeffnen(a.seite, '2026-01-01', 'jahr');
    const handy = await a.seite.evaluate(() => ({
      seiteWaagerecht: Math.round(document.documentElement.scrollWidth - window.innerWidth),
      flaecheScrollt: (() => { const sc = document.querySelector('.abscal-scroll'); return sc.scrollWidth > sc.clientWidth; })(),
      zeilen: document.querySelectorAll('.abscal-name').length,
    }));
    ok('die Seite scrollt nicht waagerecht', handy.seiteWaagerecht <= 2, String(handy.seiteWaagerecht));
    ok('… die Kalenderfläche schon (dort gehört das Wischen hin)', handy.flaecheScrollt);
    ok('… und alle Zeilen sind da', handy.zeilen >= 8, String(handy.zeilen));

    console.log('\n── Kein leerer Blick: es startet dort, wo heute ist ──');
    // Im laufenden Jahr soll man nicht im Januar landen und sich zur Gegenwart wischen muessen.
    const jetzt = new Date().toLocaleDateString('sv-SE');
    await kalenderOeffnen(a.seite, jetzt.slice(0, 4) + '-01-01', 'jahr');
    const start = await a.seite.evaluate(() => {
      const sc = document.querySelector('.abscal-scroll');
      const hs = document.querySelector('.abscal-spalte--heute');
      if (!hs) return { markerDa: false };
      const r = hs.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      return { markerDa: true, imBild: r.left >= sr.left && r.right <= sr.right, scrollLeft: Math.round(sc.scrollLeft) };
    });
    ok('„heute" ist markiert', start.markerDa, JSON.stringify(start));
    ok('… und steht beim Öffnen im Bild, ohne dass man wischt', start.imBild, JSON.stringify(start));
    // Und der Wechsel ins Monatsraster landet im aktuellen Monat, nicht stur im Januar.
    await a.seite.evaluate(() => {
      [...document.querySelectorAll('.abscal-modus-btn')].find(b => b.dataset.modus === 'monat').click();
    });
    await sleep(900);
    const monatTitel = await a.seite.evaluate(() => document.querySelector('.abscal-titel')?.textContent.trim());
    const erwartet = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'][Number(jetzt.slice(5, 7)) - 1] + ' ' + jetzt.slice(0, 4);
    ok('Wechsel ins Monatsraster landet im aktuellen Monat', monatTitel === erwartet, `${monatTitel} statt ${erwartet}`);

    console.log('\n── Antippen führt in die Liste, genau zu dem Eintrag ──');
    await a.seite.setViewport({ width: 1400, height: 900 });
    await kalenderOeffnen(a.seite, MONAT + '-01', 'monat');
    // Erst ALLES zuklappen. Ohne das ist der Eintrag ohnehin sichtbar, und die Zusicherung
    // „alle Hüllen aufgeklappt" prüft nichts — genau das ist beim Bauen passiert und erst in der
    // Gegenprobe aufgefallen (Aufdecken abgeschaltet → Test blieb grün).
    await a.seite.evaluate(() => {
      _absTab = 'list';
      _collapsedSections = new Set(['krank', 'urlaub', 'freizeitausgleich', 'sonderurlaub', 'berufsschule', 'innung', 'feiertag']);
      localStorage.setItem('absenceCollapsed', JSON.stringify([..._collapsedSections]));
    });
    await kalenderOeffnen(a.seite, MONAT + '-01', 'monat');
    const sprung = await a.seite.evaluate(async () => {
      // Einen Eintrag waehlen, der NUR in der Liste steht. Manche stehen zusaetzlich im
      // Posteingang ganz oben — dort sind sie immer sichtbar, und die Pruefung „aufgedeckt"
      // waere wertlos. (Genau darauf ist der erste Anlauf hereingefallen.)
      const listeUnten = document.querySelector('#abscal-wrap');
      const bar = [...document.querySelectorAll('.abscal-bar')].find(el => true);
      const id = bar.dataset.abs;
      bar.click();
      await new Promise(r => setTimeout(r, 1800));
      // Die Karte IN DER LISTE (nicht die Posteingangs-Kopie): die letzte im Dokument.
      const alle = [...document.querySelectorAll(`.absence-card[data-id="${id}"]`)];
      const karte = alle[alle.length - 1];
      const reiter = document.querySelector('.absence-tab.active')?.dataset.tab;
      if (!karte) return { reiter, gefunden: false, id };
      // „Sichtbar" heisst hier wirklich sichtbar — die Liste ist bis zu vier Ebenen zugeklappt.
      // Nachweisen, dass wirklich etwas aufzudecken WAR — sonst ist „sichtbar" wertlos.
      const huellen = [];
      for (let el = karte.parentElement; el && !el.classList.contains('main'); el = el.parentElement) {
        if (el.tagName === 'DETAILS') huellen.push('details:' + (el.open ? 'offen' : 'ZU'));
        if (el.classList.contains('absence-section-body')) huellen.push('body:' + (el.classList.contains('collapsed') ? 'ZU' : 'offen'));
      }
      return { reiter, gefunden: true, id, kopien: alle.length, sichtbar: karte.checkVisibility(), huellen,
               hervor: karte.className.includes('absence-card--hervor'),
               umriss: getComputedStyle(karte).outlineStyle };
    });
    ok('der Reiter wechselt zur Liste', sprung.reiter === 'list', JSON.stringify(sprung));
    ok('… der angetippte Eintrag ist dort zu finden', sprung.gefunden, JSON.stringify(sprung));
    ok('… er steckte wirklich in mindestens einer zugeklappten Hülle', (sprung.huellen || []).length > 0, JSON.stringify(sprung));
    ok('… und ist trotzdem sichtbar (alle Hüllen aufgeklappt)',
      sprung.sichtbar && !(sprung.huellen || []).some(h => /ZU/.test(h)), JSON.stringify(sprung));
    ok('… und farblich hervorgehoben', sprung.hervor && sprung.umriss === 'solid', JSON.stringify(sprung));
    // Nach der kurzen Zeit muss die Hervorhebung wieder weg sein, sonst bleibt sie fuer immer stehen.
    await sleep(2600);
    ok('… die Hervorhebung verschwindet nach ein paar Sekunden',
      await a.seite.evaluate(() => !document.querySelector('.absence-card--hervor')));

    console.log('\n── Live: genehmigt die Chefin nebenan, erscheint es sofort ──');
    // Der eigentliche Anspruch: Der Kalender steht offen, jemand ANDERES genehmigt, und der Balken
    // ist da — ohne Neuladen. Ausgeloest wird das ueber eine echte Anfrage eines zweiten Nutzers,
    // nicht durch einen nachgebauten Aufruf im Browser.
    await kalenderOeffnen(a.seite, MONAT + '-01', 'monat');
    const vorher = await a.seite.evaluate(() => document.querySelectorAll('.abscal-bar').length);
    const antrag = (await req('GET', '/api/absences?type=urlaub', admin)).body.absences.find(x => x.status === 'pending');
    ok('es gibt einen offenen Antrag zum Genehmigen', !!antrag, JSON.stringify(antrag && antrag.id));
    const gen = await req('POST', `/api/absences/${antrag.id}/approve`, admin);
    ok('… genehmigt', gen.status === 200, gen.status + ' ' + gen.text.slice(0, 80));
    await sleep(2500);
    const nachher = await a.seite.evaluate(() => ({
      balken: document.querySelectorAll('.abscal-bar').length,
      nochOffen: document.querySelectorAll('.abscal-bar--pending').length,
      reiter: document.querySelector('.absence-tab.active')?.dataset.tab,
      titel: document.querySelector('.abscal-titel')?.textContent.trim(),
    }));
    ok('der Kalender bleibt offen und beim selben Monat', nachher.reiter === 'kalender' && nachher.titel === 'Juni 2026',
      JSON.stringify(nachher));
    // Gezielt DEN genehmigten Balken pruefen. „Gar keine Schraffur mehr" waere falsch: Ein
    // Fremdeintrag, den ein Manager fuer jemanden anlegt, ist ebenfalls erst einmal offen — die
    // acht vom 05.06. sind es also auch, voellig zu Recht.
    const derBalken = await a.seite.evaluate((id) => {
      const el = document.querySelector(`.abscal-bar[data-abs="${id}"]`);
      return el ? { da: true, offen: el.className.includes('--pending') } : { da: false };
    }, antrag.id);
    ok('… der genehmigte Eintrag ist ohne Neuladen nicht mehr schraffiert',
      derBalken.da && !derBalken.offen, JSON.stringify(derBalken));
    ok('… die Balken sind dabei nicht verloren gegangen', nachher.balken >= vorher, `${vorher} → ${nachher.balken}`);

    console.log('\n── … und dabei bleibt die Wischposition stehen ──');
    // Wer gerade den März ansieht, darf durch die Genehmigung eines Kollegen nicht zu „heute"
    // zurückgerissen werden. Dieselbe Falle wie beim Scroll-Rücksprung im Zeitnachweis.
    await a.seite.evaluate(() => {
      [...document.querySelectorAll('.abscal-modus-btn')].find(b => b.dataset.modus === 'jahr').click();
    });
    await sleep(1200);
    // Auf einen Wert wischen, den es WIRKLICH gibt: Auf einem breiten Fenster passt das Jahr fast
    // hinein, der Wischweg ist dann nur wenige Dutzend Pixel. Ein Wunschwert von 250 wuerde
    // stillschweigend auf das Maximum gekappt — und der Test pruefte nichts.
    const gewischt = await a.seite.evaluate(() => {
      const sc = document.querySelector('.abscal-scroll');
      const max = sc.scrollWidth - sc.clientWidth;
      sc.scrollLeft = Math.round(max / 2);
      sc.dispatchEvent(new Event('scroll'));
      return { max, gesetzt: Math.round(sc.scrollLeft) };
    });
    ok('es gibt überhaupt einen Wischweg zum Merken', gewischt.max > 10 && gewischt.gesetzt > 0, JSON.stringify(gewischt));
    await sleep(400);
    await req('POST', '/api/absences', admin, { target_user_id: ids[3], type: 'krank', date_from: MONAT + '-18', date_to: MONAT + '-19' });
    await sleep(2500);
    const wisch = await a.seite.evaluate(() => ({
      scrollLeft: Math.round(document.querySelector('.abscal-scroll').scrollLeft),
      modus: document.querySelector('.abscal-modus-btn.active')?.dataset.modus,
    }));
    ok('nach einer fremden Änderung steht die Ansicht noch da, wo man war',
      wisch.modus === 'jahr' && Math.abs(wisch.scrollLeft - gewischt.gesetzt) < 5,
      JSON.stringify({ ...wisch, erwartet: gewischt.gesetzt }));

    console.log('\n── Nur wer im Zeitraum angestellt war, bekommt eine Zeile ──');
    // Alex am 28.08.2026: „hast du auch darauf geachtet, dass immer die eingestellten ma angezeigt
    // werden?" — Nein. Die Zeilen waren „alle aktiven Nutzer". Damit erschien in einem laengst
    // vergangenen Monat jemand, der erst spaeter anfing, und ein altes Jahr zeigte die heutige
    // Mannschaft.
    //
    // Die Daten muessen RELATIV zu heute sein: `POST /api/users` setzt den Eintritt immer auf
    // heute, ein Rueckdatieren gibt es dort nicht. Damit lassen sich beide Faelle trotzdem
    // nachbauen — Eintritt mitten im Monat (Sarah, ab heute) und Austritt mitten im Monat
    // (Gerda, bis heute).
    const heute = new Date().toLocaleDateString('sv-SE');
    const monatVon = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 8) + '01'; };

    const sarah = (await req('POST', '/api/users', admin, { username: 'spaet', password: PW, name: 'Späte Sarah',
      role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    ok('Späteinsteigerin angelegt (Eintritt heute)', !!sarah, JSON.stringify(sarah && sarah.id));
    const gerda = (await req('POST', '/api/users', admin, { username: 'weg', password: PW, name: 'Gehende Gerda',
      role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    const aus = await req('POST', `/api/users/${gerda.id}/deactivate`, admin, { employed_until: heute });
    ok('Ausscheidende ausgestellt (Austritt heute)', aus.status === 200, aus.status + ' ' + aus.text.slice(0, 90));

    // Die Seite hat ihre Nutzerliste beim Oeffnen geladen — die beiden Neuen kennt sie noch nicht.
    // Ohne dieses Neuladen fehlten sie in JEDER Ansicht, und der Test pruefte nur, dass etwas
    // fehlt, was es im Browser gar nicht gibt.
    await a.seite.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2200);
    ok('die neuen Konten sind in der Oberfläche angekommen',
      (await a.seite.evaluate(() => (S.users || []).map(u => u.name))).includes('Späte Sarah'),
      JSON.stringify(await a.seite.evaluate(() => (S.users || []).length)));

    const zeilenIn = async (anker, modus) => {
      await kalenderOeffnen(a.seite, anker, modus);
      return a.seite.evaluate(() => [...document.querySelectorAll('.abscal-name')].map(e => e.textContent.trim()));
    };
    let z = await zeilenIn(monatVon(-1), 'monat');
    ok('Vormonat: die Späteinsteigerin ist NOCH nicht da', !z.includes('Späte Sarah'), JSON.stringify(z));
    ok('… die Ausscheidende ebenfalls nicht (sie kam erst diesen Monat)', !z.includes('Gehende Gerda'), JSON.stringify(z));
    z = await zeilenIn(monatVon(0), 'monat');
    ok('dieser Monat: die Späteinsteigerin ist da', z.includes('Späte Sarah'), JSON.stringify(z));
    ok('… und die Ausscheidende AUCH NOCH (Austritt mitten im Monat)', z.includes('Gehende Gerda'), JSON.stringify(z));
    z = await zeilenIn(monatVon(1), 'monat');
    ok('Folgemonat: die Ausscheidende ist weg', !z.includes('Gehende Gerda'), JSON.stringify(z));
    ok('… die Späteinsteigerin bleibt (offenes Ende)', z.includes('Späte Sarah'), JSON.stringify(z));
    z = await zeilenIn(heute.slice(0, 4) + '-01-01', 'jahr');
    ok('dieses Jahr: BEIDE stehen drin (irgendwann darin angestellt)',
      z.includes('Späte Sarah') && z.includes('Gehende Gerda'), JSON.stringify(z));
    z = await zeilenIn((Number(heute.slice(0, 4)) - 2) + '-01-01', 'jahr');
    ok('ein Jahr, in dem niemand angestellt war → keine Zeilen', z.length === 0, JSON.stringify(z));
    ok('… und es steht ein verständlicher Hinweis statt eines leeren Rasters',
      /niemand angestellt/.test(await a.seite.evaluate(() => document.querySelector('.absence-empty')?.textContent || '')),
      await a.seite.evaluate(() => document.querySelector('.absence-empty')?.textContent || ''));

    console.log('\n── Auch ein ALTER Eintrag aus dem Verlauf wird gefunden ──');
    ok('der alte Eintrag wurde angelegt', !!altId, JSON.stringify(altR.body && altR.body.error));
    // Alles zuklappen, damit wirklich etwas aufzudecken ist.
    await a.seite.evaluate(() => {
      _collapsedSections = new Set(['krank', 'urlaub', 'freizeitausgleich', 'sonderurlaub', 'berufsschule', 'innung', 'feiertag']);
      localStorage.setItem('absenceCollapsed', JSON.stringify([..._collapsedSections]));
    });
    await kalenderOeffnen(a.seite, langHer.slice(0, 8) + '01', 'monat');
    const alt = await a.seite.evaluate(async (id) => {
      const bar = document.querySelector(`.abscal-bar[data-abs="${id}"]`);
      if (!bar) return { balkenDa: false };
      bar.click();
      await new Promise(r => setTimeout(r, 1800));
      const karte = document.querySelector(`.absence-card[data-id="${id}"]`);
      const offen = [...document.querySelectorAll('.absence-section')]
        .filter(s => !s.querySelector('.absence-section-body')?.classList.contains('collapsed'))
        .map(s => s.dataset.sectionType);
      return { balkenDa: true, karteDa: !!karte, sichtbar: !!karte && karte.checkVisibility(),
               hervor: !!karte && karte.className.includes('absence-card--hervor'), offeneAbschnitte: offen };
    }, altId);
    ok('der alte Eintrag ist im Kalender gezeichnet', alt.balkenDa, JSON.stringify(alt));
    ok('… ein Klick holt seine Karte aus dem Verlauf hervor', alt.karteDa, JSON.stringify(alt));
    ok('… sie ist sichtbar und hervorgehoben', alt.sichtbar && alt.hervor, JSON.stringify(alt));
    // Alex' Frage: klappt das ALLE Abschnitte auf?
    ok('… und es geht NUR sein Abschnitt auf, nicht alle',
      alt.offeneAbschnitte && alt.offeneAbschnitte.length === 1 && alt.offeneAbschnitte[0] === 'sonderurlaub',
      JSON.stringify(alt.offeneAbschnitte));

    console.log('\n── In der Jahresansicht: Jahre blättern und in den Monat springen ──');
    const jetztJahr = new Date().getFullYear();
    await kalenderOeffnen(a.seite, jetztJahr + '-01-01', 'jahr');
    ok('beim Öffnen steht das laufende Jahr da',
      (await a.seite.evaluate(() => document.querySelector('.abscal-titel')?.textContent.trim())) === String(jetztJahr));
    await a.seite.evaluate(() => document.querySelector('[data-schritt="1"]').click());
    await sleep(1000);
    ok(`ein Klick auf ›  führt nach ${jetztJahr + 1}`,
      (await a.seite.evaluate(() => document.querySelector('.abscal-titel')?.textContent.trim())) === String(jetztJahr + 1));
    // Und dort muss auch WIRKLICH das Folgejahr stehen, nicht nur die Überschrift.
    const folgejahr = await a.seite.evaluate(() => {
      const k = [...document.querySelectorAll('.abscal-kopf-monat')];
      return { monate: k.length, ersterTitel: k[0]?.title || '' };
    });
    ok('… und das Raster zeigt dessen zwölf Monate',
      folgejahr.monate === 12 && folgejahr.ersterTitel.includes(String(jetztJahr + 1)), JSON.stringify(folgejahr));
    await a.seite.evaluate(() => document.querySelector('[data-schritt="-1"]').click());
    await sleep(900);
    await a.seite.evaluate(() => document.querySelector('[data-schritt="-1"]').click());
    await sleep(900);
    ok(`zweimal ‹ führt nach ${jetztJahr - 1}`,
      (await a.seite.evaluate(() => document.querySelector('.abscal-titel')?.textContent.trim())) === String(jetztJahr - 1));
    await a.seite.evaluate(() => document.querySelector('[data-heute]').click());
    await sleep(900);
    ok('„Heute" holt das laufende Jahr zurück',
      (await a.seite.evaluate(() => document.querySelector('.abscal-titel')?.textContent.trim())) === String(jetztJahr));

    // Auf einen Monatsnamen tippen -> genau dieser Monat.
    const gesprungen = await a.seite.evaluate(async () => {
      const mai = [...document.querySelectorAll('.abscal-kopf-monat')].find(e => e.textContent.trim() === 'Mai');
      mai.click();
      await new Promise(r => setTimeout(r, 900));
      return { titel: document.querySelector('.abscal-titel')?.textContent.trim(),
               modus: document.querySelector('.abscal-modus-btn.active')?.dataset.modus,
               tageskoepfe: document.querySelectorAll('.abscal-kopf-tag').length };
    });
    ok('ein Klick auf „Mai" springt in den Mai', gesprungen.titel === 'Mai ' + jetztJahr, JSON.stringify(gesprungen));
    ok('… und zwar wirklich in die Monatsansicht (31 Tagesspalten)',
      gesprungen.modus === 'monat' && gesprungen.tageskoepfe === 31, JSON.stringify(gesprungen));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
    await a.seite.close(); await a.ktx.close();
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(`\nAbwesenheitskalender: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
