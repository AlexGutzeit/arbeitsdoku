// Projekte suchen: Suchleiste im Board + Projekt-Auswahl mit Suche in allen Formularen (Alex, 12.11.2026).
//
// Warum: Bei vielen Aufträgen hieß die Projekt-Auswahl wischen, wischen, wischen — und das Board hatte gar keine Suche.
// Jetzt filtert jeder Buchstabe. Das alte <select> bleibt als unsichtbare Wertquelle stehen; an ihm hängt alles
// Bisherige (Freitext sperren, Kunde/Adresse übernehmen, Speichern, Entwurf). Gemessen wird deshalb immer BEIDES:
// was man sieht (Suchzeile, Liste) und was ankommt (Wert des <select>, Folgefelder, gespeicherte Daten).
//
// Geprüft im Browser:
//   * Board: Name, Kunde, Adresse, Mitarbeiter, Zwischenziel, mehrere Wörter; Spalten ohne Treffer weg, Zahl am
//     Spaltenkopf zählt Treffer, „x von y" zählt jeden Auftrag einmal, Kein-Treffer-Hinweis, Begriff übersteht Neuaufbau.
//   * Zeitnachweis-Formular: tippen filtert, Enter/Klick wählt (Kunde + Adresse kommen mit, Freitext gesperrt),
//     weggeklickt = alte Wahl bleibt, Esc, Pfeiltasten, ×, „als Freitext übernehmen", Wert ohne Ereignis gesetzt.
//   * Planungsformular, Zeitnachweis-Filter, Abrechnung/PDF, Notizen (Filter, neue Notiz, offene Notiz), Werkzeug.
//   * 360 px breit: Liste bleibt im Bild. Am Handy (Touch) rollt die Zeile beim Antippen unter die Kopfleiste und die
//     Liste passt in den Platz bis zur Tastatur; am PC rollt nichts.
//   node tests/projekt-suche-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const CHROME = require('./hilfen/chrome');
const PORT = 3409, DB = '/tmp/projekt-suche-ui.db', LOG = '/tmp/projekt-suche-ui-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, token, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: adminPw })).body?.token;
    ok('Server startet, Admin-Anmeldung', !!admin);

    const ma = (await req('POST', '/api/users', admin, { username: 'suchma', password: 'Test1234!', name: 'Ottilie Sucher', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body || {};
    const maId = ma.id || ma.user?.id;
    const projekt = async (b) => { const r = await req('POST', '/api/projects', admin, b); return (r.body && (r.body.id || r.body.project?.id)); };
    const P = {
      neubau: await projekt({ name: 'Neubau Schmidt', client: 'Bauherr Müller', address: 'Lindenweg 4, Testdorf', assigned_user_ids: [maId] }),
      altbau: await projekt({ name: 'Altbau Sanierung', client: 'Firma Kurz', address: 'Hauptstraße 1' }),
      pv: await projekt({ name: 'PV Anlage Dach', client: 'Schmidt', milestones: [{ title: 'Wechselrichter setzen', est_days: 1 }] }),
    };
    for (let i = 1; i <= 25; i++) await projekt({ name: 'Füllauftrag ' + String(i).padStart(2, '0') });
    ok('Projekte angelegt (3 echte + 25 Füller), Mitarbeiter zugeteilt', P.neubau && P.altbau && P.pv && maId, JSON.stringify(P));
    const werkzeug = (await req('POST', '/api/tools', admin, { name: 'Bohrhammer' })).body || {};
    const notiz = (await req('POST', '/api/notes', admin, { title: 'Suchnotiz', body: '' })).body || {};
    const notizId = notiz.id || notiz.note?.id;
    ok('Werkzeug und Notiz angelegt', !!(werkzeug.id || werkzeug.tool?.id) && !!notizId, JSON.stringify({ werkzeug, notiz }));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 900 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => fehler.push(String(e && e.message || e)));
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'admin'); await page.type('#login-pass', adminPw);
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/projects"]');
    const geh = async (hash, sel) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector(sel); await sleep(300); };

    // ── Board ────────────────────────────────────────────────────────────────────────────────
    console.log('── Board: Suchleiste ──');
    await geh('#/projects', '#ls-board');
    const board = () => page.evaluate(() => {
      const sicht = (el) => el.checkVisibility();
      const kacheln = [...document.querySelectorAll('.proj-tile')].filter(sicht);
      return { namen: [...new Set(kacheln.map(t => t.querySelector('.proj-name').textContent))].sort(),
        spalten: [...document.querySelectorAll('.board-col')].filter(sicht).map(c => c.querySelector('.board-col-head').textContent.trim().replace(/\s+/g, ' ')),
        zahl: document.getElementById('ls-count-board').textContent,
        leer: (() => { const l = document.querySelector('.board-suche-leer'); return l && sicht(l) ? l.textContent : ''; })() };
    });
    const suche = async (text) => { await page.focus('#ls-board');
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
      if (text) await page.type('#ls-board', text); await sleep(150); return board(); };
    // Eine frische Datenbank bringt zwei Beispielprojekte mit — die Gesamtzahl kommt deshalb vom Server
    const GESAMT = ((await req('GET', '/api/projects', admin)).body?.projects || []).length;
    const ohne = await board();
    ok(`ohne Suche: alle ${GESAMT} Aufträge zu sehen`, GESAMT >= 28 && ohne.namen.length === GESAMT, ohne.namen.length + ' / ' + GESAMT);
    let b = await suche('schmidt');
    ok('„schmidt" → Name (Neubau Schmidt) UND Kunde (PV Anlage Dach)', JSON.stringify(b.namen) === JSON.stringify(['Neubau Schmidt', 'PV Anlage Dach']), JSON.stringify(b.namen));
    ok(`… „2 von ${GESAMT}", jeder Auftrag nur einmal gezählt`, b.zahl === `2 von ${GESAMT}`, b.zahl);
    ok('… Spalten ohne Treffer sind weg (Ottilies Spalte bleibt mit 1)', b.spalten.some(s => /Ottilie Sucher 1$/.test(s)) && b.spalten.length <= 2, JSON.stringify(b.spalten));
    b = await suche('lindenweg');
    ok('Adresse: „lindenweg" → Neubau Schmidt', JSON.stringify(b.namen) === '["Neubau Schmidt"]', JSON.stringify(b.namen));
    b = await suche('ottilie');
    ok('Mitarbeiter: „ottilie" → ihr Auftrag', JSON.stringify(b.namen) === '["Neubau Schmidt"]', JSON.stringify(b.namen));
    b = await suche('wechselrichter');
    ok('Zwischenziel: „wechselrichter" → PV Anlage Dach', JSON.stringify(b.namen) === '["PV Anlage Dach"]', JSON.stringify(b.namen));
    b = await suche('dach pv');
    ok('mehrere Wörter, andere Reihenfolge: „dach pv"', JSON.stringify(b.namen) === '["PV Anlage Dach"]', JSON.stringify(b.namen));
    b = await suche('gibtsnicht');
    ok('kein Treffer → keine Spalte, Hinweis steht da', b.namen.length === 0 && b.spalten.length === 0 && /Kein Auftrag passt zu „gibtsnicht"/.test(b.leer), JSON.stringify(b));
    b = await suche('schmidt');
    await page.evaluate(() => renderProjects()); await page.waitForFunction(() => !!document.querySelector('#ls-board')); await sleep(400);
    const nachher = await page.evaluate(() => ({ wert: document.getElementById('ls-board').value, fokus: document.activeElement && document.activeElement.id }));
    b = await board();
    ok('Neuaufbau (Live-Update): Begriff, Filter und Fokus bleiben', nachher.wert === 'schmidt' && nachher.fokus === 'ls-board' && b.namen.length === 2, JSON.stringify({ nachher, b }));
    b = await suche('');
    ok('Suche geleert: wieder alle, Spaltenzahl wie vorher', b.namen.length === GESAMT && b.zahl === '' && b.spalten.length === ohne.spalten.length, JSON.stringify({ n: b.namen.length, z: b.zahl }));

    // ── Werkzeuge: Auswahl mit Suche ───────────────────────────────────────────────────────
    const stand = (id) => page.evaluate((id) => {
      const sel = document.getElementById(id), feld = document.getElementById(id + '-suche');
      const liste = document.getElementById(id + '-suche-liste');
      return { wert: sel ? sel.value : null, feld: feld ? feld.value : null, platz: feld ? feld.placeholder : null,
        selSichtbar: sel ? sel.checkVisibility() : null, feldSichtbar: feld ? feld.checkVisibility() : false,
        offen: !!liste && !liste.hidden, eintraege: liste ? [...liste.querySelectorAll('li')].map(l => l.textContent.trim()) : [],
        aktiv: liste && liste.querySelector('.aktiv') ? liste.querySelector('.aktiv').textContent.trim() : null,
        fokus: document.activeElement && document.activeElement.id, disabled: feld ? feld.disabled : null };
    }, id);
    const tippen = async (id, text) => { await page.click('#' + id + '-suche'); await page.keyboard.type(text); await sleep(100); return stand(id); };
    const wegklicken = async () => { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await sleep(100); };

    // ── Zeitnachweis-Formular ────────────────────────────────────────────────────────────────
    console.log('── Zeitnachweis-Formular ──');
    await geh('#/entry/new', '#ef-project-suche');
    let s = await stand('ef-project');
    ok('altes Dropdown unsichtbar, Suchzeile sichtbar', s.selSichtbar === false && s.feldSichtbar, JSON.stringify(s));
    ok('Beschriftung „Projekt (Auswahl)" gehört zur Suchzeile', await page.evaluate(() => { const f = document.getElementById('ef-project-suche'); return f.labels && f.labels.length ? true : /Projekt/.test(f.getAttribute('aria-label') || ''); }));
    await page.click('#ef-project-suche'); await sleep(100);
    s = await stand('ef-project');
    ok('Antippen öffnet die Liste: „Kein Projekt" + alle Projekte', s.offen && s.eintraege.length === GESAMT + 1 && /Kein Projekt/.test(s.eintraege[0]), s.eintraege.length);
    ok('… Kunde steht klein daneben', s.eintraege.some(t => t === 'Neubau Schmidt Bauherr Müller'), JSON.stringify(s.eintraege.slice(0, 5)));
    await page.keyboard.type('sch');
    s = await stand('ef-project');
    ok('„sch" filtert sofort (Name + Kunde), Freitext-Angebot unten', JSON.stringify(s.eintraege) === JSON.stringify(['Neubau Schmidt Bauherr Müller', 'PV Anlage Dach Schmidt', '„sch" als Freitext übernehmen']), JSON.stringify(s.eintraege));
    await page.keyboard.type('midt lind');
    s = await stand('ef-project');
    ok('„schmidt lind" (Name + Adresse) → nur Neubau Schmidt, erster markiert', s.eintraege[0] === 'Neubau Schmidt Bauherr Müller' && s.aktiv === s.eintraege[0] && s.eintraege.length === 2, JSON.stringify(s));
    await page.keyboard.press('Enter'); await sleep(200);
    s = await stand('ef-project');
    const folge = await page.evaluate(() => ({ kunde: document.getElementById('ef-client').value, adresse: document.getElementById('ef-address').value,
      frei: document.getElementById('ef-project-text').disabled, abgeschickt: location.hash }));
    ok('Enter wählt: <select> hat den Wert, Zeile zeigt den Namen, Liste zu', s.wert === String(P.neubau) && s.feld === 'Neubau Schmidt' && !s.offen, JSON.stringify(s));
    ok('… die alte Automatik lief: Kunde + Adresse übernommen, Freitext gesperrt', folge.kunde === 'Bauherr Müller' && /Lindenweg/.test(folge.adresse) && folge.frei, JSON.stringify(folge));
    ok('… Enter hat das Formular NICHT abgeschickt', folge.abgeschickt === '#/entry/new', folge.abgeschickt);
    s = await tippen('ef-project', 'altbau');
    ok('neu öffnen: Zeile leer, alte Wahl als Platzhalter', s.platz === 'Neubau Schmidt', s.platz);
    await wegklicken();
    s = await stand('ef-project');
    ok('getippt, aber weggeklickt → alte Wahl bleibt', s.wert === String(P.neubau) && s.feld === 'Neubau Schmidt' && !s.offen, JSON.stringify(s));
    await tippen('ef-project', 'altbau'); await page.keyboard.press('Escape'); await sleep(100);
    s = await stand('ef-project');
    ok('Esc → Liste zu, alte Wahl bleibt', s.wert === String(P.neubau) && !s.offen, JSON.stringify(s));
    await tippen('ef-project', 'altbau');
    await page.click('#ef-project-suche-liste li[data-i="0"]'); await sleep(200);
    s = await stand('ef-project');
    ok('Klick auf einen Eintrag wählt ihn', s.wert === String(P.altbau) && s.feld === 'Altbau Sanierung', JSON.stringify(s));
    await page.click('#ef-project-suche'); await sleep(100);
    s = await stand('ef-project');
    ok('beim Öffnen ist die aktuelle Wahl markiert', s.aktiv === 'Altbau Sanierung Firma Kurz', s.aktiv);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await sleep(200);
    s = await stand('ef-project');
    const reihenfolge = await page.evaluate(() => [...document.getElementById('ef-project').options].map(o => o.value));
    const erwartet = reihenfolge[reihenfolge.indexOf(String(P.altbau)) + 2];
    ok('↓ ↓ Enter wählt zwei weiter unten', s.wert === erwartet, JSON.stringify({ s: s.wert, erwartet }));
    await page.click('.such-auswahl-x'); await sleep(200);
    s = await stand('ef-project');
    const freiOffen = await page.evaluate(() => !document.getElementById('ef-project-text').disabled);
    ok('× → kein Projekt, Freitext wieder frei', s.wert === '' && s.feld === '' && freiOffen, JSON.stringify(s));
    s = await tippen('ef-project', 'Baustelle Hinterhof');
    ok('kein Treffer → nur das Freitext-Angebot, markiert', s.eintraege.length === 1 && s.eintraege[0] === '„Baustelle Hinterhof" als Freitext übernehmen' && s.aktiv === s.eintraege[0], JSON.stringify(s));
    await page.keyboard.press('Enter'); await sleep(200);
    const ft = await page.evaluate(() => { const f = document.getElementById('ef-project-text'); return { wert: f.value, frei: !f.disabled, fokus: document.activeElement === f }; });
    s = await stand('ef-project');
    ok('Freitext übernommen: steht im Freitext-Feld, Fokus dort, kein Projekt gewählt', ft.wert === 'Baustelle Hinterhof' && ft.frei && ft.fokus && s.wert === '', JSON.stringify({ ft, s }));
    await page.evaluate((id) => { document.getElementById('ef-project').value = String(id); }, P.pv); await sleep(50);
    s = await stand('ef-project');
    ok('Wert per Code OHNE Ereignis gesetzt (Entwurf, Live-Notiz) → Zeile zeigt ihn', s.feld === 'PV Anlage Dach', JSON.stringify(s));

    // Handybreite
    await page.setViewport({ width: 360, height: 740 });
    await page.click('#ef-project-suche'); await sleep(150);
    const schmal = await page.evaluate(() => { const l = document.getElementById('ef-project-suche-liste').getBoundingClientRect();
      return { links: l.left, rechts: l.right, breite: innerWidth, ueber: document.documentElement.scrollWidth > innerWidth + 1 }; });
    ok('360 px: Liste bleibt im Bild, nichts läuft über', schmal.links >= 0 && schmal.rechts <= schmal.breite && !schmal.ueber, JSON.stringify(schmal));
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 1200, height: 900 });

    // Am PC rollt beim Öffnen nichts — das Nach-oben-Schieben ist nur für Touch-Geräte
    await geh('#/entry/new', '#ef-project-suche');
    await page.evaluate(() => { document.getElementById('ef-project-suche').scrollIntoView({ block: 'center' }); });
    const yVor = await page.evaluate(() => window.scrollY);
    await page.click('#ef-project-suche'); await sleep(200);
    const pc = await page.evaluate(() => { const l = document.getElementById('ef-project-suche-liste').getBoundingClientRect(); return { y: window.scrollY, unten: l.bottom, h: innerHeight }; });
    ok('PC: Öffnen rollt die Seite nicht, Liste endet im Fenster', pc.y === yVor && pc.unten <= pc.h, JSON.stringify({ yVor, pc }));
    await page.keyboard.press('Escape');
    // Zeile weit unten im Fenster: Die feste CSS-Grenze (45 % der Höhe) ragte hier unten hinaus — die Liste
    // richtet sich nach dem wirklich freien Platz. (Dieselbe Rechnung hält sie am Handy über der Tastatur.)
    await page.evaluate(() => { const f = document.getElementById('ef-project-suche'); window.scrollBy(0, f.getBoundingClientRect().top - (innerHeight - 260)); });
    await page.click('#ef-project-suche'); await sleep(200);
    const tief = await page.evaluate(() => { const l = document.getElementById('ef-project-suche-liste'); return { unten: Math.round(l.getBoundingClientRect().bottom), h: innerHeight, hoehe: l.clientHeight, inhalt: l.scrollHeight }; });
    ok('PC, Zeile weit unten: Liste wird kürzer und endet trotzdem im Fenster', tief.unten <= tief.h && tief.hoehe < 0.45 * tief.h && tief.inhalt > tief.hoehe, JSON.stringify(tief));
    await page.keyboard.press('Escape');

    // Handy mit Touch: Zeile rollt unter die Kopfleiste, die Liste passt in den Platz bis zur Tastatur.
    // Die Tastatur wird nachgestellt, indem der sichtbare Bereich bei offener Liste schrumpft.
    console.log('── Handy: Zeile rollt nach oben ──');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });   // lädt die Seite neu
    await geh('#/entry/new', '#ef-project-suche');
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(100);
    const handy = () => page.evaluate(() => {
      const f = document.getElementById('ef-project-suche').getBoundingClientRect();
      const l = document.getElementById('ef-project-suche-liste');
      const kopf = document.querySelector('.header').getBoundingClientRect().bottom;
      const vv = window.visualViewport;
      return { touch: matchMedia('(pointer: coarse)').matches, feldOben: Math.round(f.top), kopf: Math.round(kopf),
        listeUnten: Math.round(l.getBoundingClientRect().bottom), sichtUnten: Math.round(vv.offsetTop + vv.height),
        listeHoehe: l.clientHeight, inhalt: l.scrollHeight, offen: !l.hidden };
    });
    const vorTipp = await handy();
    ok('Vorbedingung: Touch-Gerät, Zeile steht weit unten', vorTipp.touch && vorTipp.feldOben > 400, JSON.stringify(vorTipp));
    await page.tap('#ef-project-suche'); await sleep(300);
    let h = await handy();
    ok('Antippen: Zeile steht direkt unter der Kopfleiste', h.offen && h.feldOben >= h.kopf && h.feldOben <= h.kopf + 20, JSON.stringify(h));
    ok('… Liste endet im sichtbaren Bereich und scrollt in sich', h.listeUnten <= h.sichtUnten && h.inhalt > h.listeHoehe, JSON.stringify(h));
    await page.setViewport({ width: 390, height: 460, isMobile: true, hasTouch: true }); await sleep(400);   // Tastatur geht auf
    h = await handy();
    ok('Tastatur geht auf: Zeile bleibt oben, Liste schrumpft bis über die Tastatur', h.offen && h.feldOben >= h.kopf && h.feldOben <= h.kopf + 20 && h.listeUnten <= h.sichtUnten, JSON.stringify(h));
    await page.keyboard.type('pv'); await sleep(150);
    await page.keyboard.press('Enter'); await sleep(200);
    ok('… und gewählt wird wie gewohnt', (await stand('ef-project')).feld === 'PV Anlage Dach');
    ok('… der Platz zum Hochrollen ist danach wieder weg', await page.evaluate(() => !document.querySelector('.such-auswahl-platz')));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.tap('#ef-project-suche'); await sleep(200);
    const mitPlatz = await page.evaluate(() => !!document.querySelector('.such-auswahl-platz'));
    await page.evaluate(() => { location.hash = '#/projects'; }); await page.waitForSelector('#ls-board'); await sleep(300);
    ok('Seitenwechsel bei offener Liste: kein Platz bleibt an der nächsten Seite hängen', mitPlatz && await page.evaluate(() => !document.querySelector('.such-auswahl-platz')), String(mitPlatz));
    await page.setViewport({ width: 1200, height: 900 });   // lädt die Seite neu

    // ── Planungsformular ────────────────────────────────────────────────────────────────────
    console.log('── Planungsformular ──');
    await geh('#/planning/new', '#pf-project-suche');
    s = await tippen('pf-project', 'altbau');
    ok('Planung: „altbau" filtert', s.eintraege[0] === 'Altbau Sanierung Firma Kurz', JSON.stringify(s.eintraege));
    await page.keyboard.press('Enter'); await sleep(200);
    s = await stand('pf-project');
    const pf = await page.evaluate(() => ({ kunde: document.getElementById('pf-client').value, frei: document.getElementById('pf-project-text').disabled }));
    ok('… gewählt, Kunde übernommen, Freitext gesperrt', s.wert === String(P.altbau) && pf.kunde === 'Firma Kurz' && pf.frei, JSON.stringify({ s, pf }));
    await tippen('pf-project', 'Halle 7');
    await page.click('#pf-project-suche-liste li.such-auswahl-frei'); await sleep(200);
    const pft = await page.evaluate(() => ({ wert: document.getElementById('pf-project-text').value, sel: document.getElementById('pf-project').value }));
    ok('… Freitext per Klick übernommen', pft.wert === 'Halle 7' && pft.sel === '', JSON.stringify(pft));

    // ── Zeitnachweis-Filter ─────────────────────────────────────────────────────────────────
    console.log('── Zeitnachweis-Liste: Filter ──');
    await geh('#/', '#filter-project-suche');
    s = await stand('filter-project');
    ok('Filter: Platzhalter „Alle Projekte"', /^Alle Projekte/.test(s.platz), s.platz);
    s = await tippen('filter-project', 'pv');
    ok('Filter: kein Freitext-Angebot (es gibt kein Freitext-Feld)', !s.eintraege.some(t => /Freitext/.test(t)), JSON.stringify(s.eintraege));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!document.getElementById('filter-project-suche')); await sleep(400);
    const filt = await page.evaluate(() => ({ s: S.filterProjectId, feld: (document.getElementById('filter-project-suche') || {}).value }));
    ok('Filter gewählt → Liste filtert, Zeile zeigt das Projekt', String(filt.s) === String(P.pv) && filt.feld === 'PV Anlage Dach', JSON.stringify(filt));
    await page.evaluate(() => { S.filterProjectId = ''; });

    // ── Abrechnung / PDF ────────────────────────────────────────────────────────────────────
    console.log('── Abrechnung / PDF ──');
    await geh('#/pdf', '#pdf-project-suche');
    s = await tippen('pdf-project', 'neubau'); await page.keyboard.press('Enter'); await sleep(100);
    s = await stand('pdf-project');
    ok('PDF: Projekt per Suche gewählt', s.wert === String(P.neubau), JSON.stringify(s));

    // ── Notizen ─────────────────────────────────────────────────────────────────────────────
    console.log('── Notizen ──');
    await geh('#/notes', '#note-filter-project-suche');
    s = await tippen('note-filter-project', 'kein');
    ok('Notiz-Filter: „Kein Projekt" (Wert none) ist findbar', s.eintraege[0] === 'Kein Projekt', JSON.stringify(s.eintraege));
    await page.keyboard.press('Escape');
    const neu = await page.$('#fab-new');   // der runde „+“-Knopf öffnet auf /notes das Formular
    if (neu) {
      await neu.click(); await page.waitForSelector('#nf-project-suche'); await sleep(200);
      await tippen('nf-project', 'Kellerraum'); await page.keyboard.press('Enter'); await sleep(150);
      const nf = await page.evaluate(() => ({ frei: document.getElementById('nf-project-text').value, sel: document.getElementById('nf-project').value }));
      ok('Neue Notiz: Freitext übernommen', nf.frei === 'Kellerraum' && nf.sel === '', JSON.stringify(nf));
      await tippen('nf-project', 'dach'); await page.keyboard.press('Enter'); await sleep(150);
      const nf2 = await page.evaluate(() => ({ frei: document.getElementById('nf-project-text').value, gesperrt: document.getElementById('nf-project-text').disabled, sel: document.getElementById('nf-project').value }));
      ok('… danach Projekt gewählt: Freitext leer und gesperrt', nf2.sel === String(P.pv) && nf2.frei === '' && nf2.gesperrt, JSON.stringify(nf2));
      await tippen('nf-project', 'Dachboden');   // „dach"-Treffer gibt es, Freitext steht trotzdem unten
      const nfl = await stand('nf-project');
      ok('… Freitext-Angebot auch neben Treffern', nfl.eintraege[nfl.eintraege.length - 1] === '„Dachboden" als Freitext übernehmen', JSON.stringify(nfl.eintraege));
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const f = document.getElementById('nf-project-text'); f.disabled = false; f.value = 'x'; f.dispatchEvent(new Event('input', { bubbles: true })); });
      const nf3 = await stand('nf-project');
      ok('… Tippen im Freitext leert die Auswahl ohne Ereignis — Zeile zieht nach', nf3.wert === '' && nf3.feld === '', JSON.stringify(nf3));
    } else ok('Knopf „Neue Notiz" gefunden', false, 'Selektor anpassen');

    console.log('── Offene Notiz ──');
    await geh('#/notes/' + notizId, '#notiz-projekt-wahl-suche');
    await page.evaluate(() => { const d = document.getElementById('notiz-projekt'); if (d) d.open = true; }); await sleep(200);
    await tippen('notiz-projekt-wahl', 'altbau'); await page.keyboard.press('Enter');
    let gespeichert = null;
    for (let i = 0; i < 30; i++) { const r = await req('GET', '/api/notes', admin); gespeichert = ((r.body && r.body.notes) || []).find(n => n.id === notizId); if (gespeichert && gespeichert.project_id === P.altbau) break; await sleep(200); }
    ok('Offene Notiz: Projekt per Suche gewählt → gespeichert', gespeichert && gespeichert.project_id === P.altbau, JSON.stringify(gespeichert && { p: gespeichert.project_id, t: gespeichert.project_text }));

    // ── Werkzeug ────────────────────────────────────────────────────────────────────────────
    console.log('── Werkzeug ──');
    await geh('#/tools', '.tool-checkout');
    const tid = await page.$eval('.tool-checkout', b => b.dataset.id);
    await page.click('.tool-checkout'); await page.waitForSelector(`#tcf-proj-${tid}-suche`); await sleep(150);
    s = await tippen(`tcf-proj-${tid}`, 'linden'); await page.keyboard.press('Enter'); await sleep(150);
    s = await stand(`tcf-proj-${tid}`);
    const tcf = await page.evaluate((t) => ({ adr: document.getElementById('tcf-addr-' + t).value, frei: document.getElementById('tcf-text-' + t).disabled }), tid);
    ok('Werkzeug: Projekt per Adresse gefunden, Adresse übernommen, Freitext gesperrt', s.wert === String(P.neubau) && /Lindenweg/.test(tcf.adr) && tcf.frei, JSON.stringify({ s, tcf }));

    ok('keine Skriptfehler im Browser', fehler.length === 0, fehler.join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nProjekt-Suche: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
