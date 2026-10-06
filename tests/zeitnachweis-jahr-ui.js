// Zeitnachweis: „Jahr" und „Gesamt" (Alex, 06.10.2026) — zusätzlich zu Tag, Woche, Monat.
//
// Jahr: zwölf Zeilen (Monate) × Personen; Gesamt: die Jahre seit dem ersten Eintrag × Personen. Eine Zelle zeigt
// Nettostunden / Arbeitstage, Abwesenheiten als Zeichen mit Anzahl und die Zahl der Verstöße; Antippen führt eine
// Stufe tiefer (Gesamt → Jahr → Monat). Gesamt beginnt beim ersten Eintrag und hat nichts zu blättern.
//
// Die Daten liegen bewusst in den VORJAHREN: Ein Test mit Einträgen im laufenden Jahr wäre im Januar anders als im
// Oktober (Einträge in der Zukunft, leere Monate). So ist er an jedem Tag des Jahres gleich.
//
//   node tests/zeitnachweis-jahr-ui.js            (Bildschirmfotos: ZN_FOTOS=<ordner>)
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3373, DB = '/tmp/zeitnachweis-jahr-ui.db', BASIS = `http://localhost:${PORT}`;
const FOTOS = process.env.ZN_FOTOS || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JETZT = new Date().getFullYear(), VJ = JETZT - 1, VVJ = JETZT - 2;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  if (FOTOS) fs.mkdirSync(FOTOS, { recursive: true });
  const lg = fs.openSync('/tmp/zeitnachweis-jahr-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/zeitnachweis-jahr-ui-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    // Ein ERWACHSENER mit Geburtsdatum: Ohne Datum gilt jemand vorsichtshalber als Jugendlicher (strengere
    // Pausen) — dann zählte schon ein 8-Stunden-Tag mit 30 Min. Pause als Verstoß (beim ersten Lauf: „⚠️ 2").
    const moritz = (await req('POST', '/api/users', admin, { username: 'moritz', password: 'Start!2345', name: 'Moritz Groß', role: 'mitarbeiter',
      birth_date: '1980-05-05', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 })).body.user;
    const maxId = moritz.id;
    const erika = (await req('POST', '/api/users', admin, { username: 'erika', password: 'Start!2345', name: 'Erika Beispiel', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 })).body.user;
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Heizung Müller' })).body.project;
    const eintrag = async (uid, date, von, bis, extra = {}) => {
      const r = await req('POST', '/api/entries', admin, { user_id: uid, date, time_from: von, time_to: bis, break_minutes: 30, description: 'Arbeit', ...extra });
      if (r.status >= 300) throw new Error('Eintrag ' + date + ': ' + r.text.slice(0, 120));
    };
    // Moritz: im Januar des Vorjahrs zwei Tage (einer davon über 10 Std. → Verstoß), im Juni des Vorvorjahrs einer
    await eintrag(maxId, `${VJ}-01-14`, '07:00', '15:30', { project_id: projekt.id });       // 8:00
    await eintrag(maxId, `${VJ}-01-15`, '06:00', '18:00');                                    // 11:30 → über 10 Std.
    await eintrag(maxId, `${VVJ}-06-02`, '07:00', '12:30');                                   // 5:00
    await eintrag(erika.id, `${VJ}-03-10`, '07:00', '11:30');                                 // 4:00
    // Urlaub für Moritz: Mo 19. bis Mi 21. des Januars? — die Wochentage hängen vom Jahr ab; drei Kalendertage nehmen
    // und die erwarteten Wochentage selbst zählen.
    const urlaubVon = `${VJ}-01-19`, urlaubBis = `${VJ}-01-21`;
    let urlaubTage = 0;
    for (let d = new Date(urlaubVon + 'T12:00:00'); d <= new Date(urlaubBis + 'T12:00:00'); d.setDate(d.getDate() + 1)) if (d.getDay() % 6 !== 0) urlaubTage++;
    // Urlaub, wie im Betrieb: beantragt und genehmigt (offene Anträge zeigen die Raster nicht)
    const moritzT = (await req('POST', '/api/auth/login', null, { username: 'moritz', password: 'Start!2345' })).body.token;
    const chefT = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;
    const antrag = (await req('POST', '/api/absences', moritzT, { type: 'urlaub', date_from: urlaubVon, date_to: urlaubBis })).body.absence;
    const gen = await req('POST', `/api/absences/${antrag.id}/approve`, chefT, {});
    ok('Testdaten angelegt (Einträge in zwei Vorjahren, Urlaub genehmigt)', gen.status < 300, gen.text.slice(0, 100));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const anmelden = async (user, pass, vp = { width: 1280, height: 900 }) => {
      const p = await browser.newPage(); await p.setViewport(vp); p.setDefaultTimeout(30000);
      p.on('pageerror', e => fehler.push(String(e)));
      p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fehler.push(m.text()); });
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await p.evaluate(() => localStorage.clear());
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', user); await p.type('#login-pass', pass);
      await p.click('#login-form button[type="submit"]'); await sleep(2200);
      await p.evaluate(() => { location.hash = '#/'; }); await sleep(2200);
      return p;
    };
    const foto = async (p, name) => { if (FOTOS) await p.screenshot({ path: path.join(FOTOS, name + '.png'), fullPage: true }); };
    const ansicht = (p, v) => p.click(`.view-toggle [data-view="${v}"]`).then(() => sleep(1800));
    // Das Raster als Tabelle: Zeilenkopf → je Spalte der Text der Zelle
    const raster = (p) => p.evaluate(() => {
      const t = document.querySelector('.week-month-grid'); if (!t) return null;
      const koepfe = [...t.querySelectorAll('thead th')].slice(1).map(th => th.innerText.replace(/\s+/g, ' ').trim());
      const zeilen = [...t.querySelectorAll('tbody tr')].map(tr => ({
        kopf: tr.querySelector('.grid-row-header').innerText.trim(), heute: tr.classList.contains('grid-today'),
        zellen: [...tr.querySelectorAll('td.grid-cell')].map(td => td.innerText.replace(/\s+/g, ' ').trim()) }));
      return { koepfe, zeilen, periode: (document.querySelector('.current-period') || {}).innerText };
    });
    const spalte = (r, name) => r.koepfe.findIndex(k => k.includes(name));

    console.log('── Chef: Umschalter ──');
    let p = await anmelden('chef', pw('chef'));
    const knoepfe = await p.$$eval('.view-toggle button', bs => bs.map(b => b.textContent.trim()));
    ok('Tag · Woche · Monat · Jahr · Gesamt', JSON.stringify(knoepfe) === '["Tag","Woche","Monat","Jahr","Gesamt"]', JSON.stringify(knoepfe));

    console.log(`\n── Jahr ${VJ} ──`);
    await ansicht(p, 'year');
    ok('Jahr zeigt das laufende Jahr', (await raster(p) || {}).periode === String(JETZT), (await raster(p) || {}).periode);
    await p.click('#date-prev'); await sleep(1800);
    let r = await raster(p);
    ok(`‹ blättert ins Vorjahr (${VJ})`, r && r.periode === String(VJ), r && r.periode);
    ok('zwölf Zeilen, Januar bis Dezember', r.zeilen.length === 12 && r.zeilen[0].kopf === 'Januar' && r.zeilen[11].kopf === 'Dezember', JSON.stringify(r.zeilen.map(z => z.kopf)));
    const sMax = spalte(r, 'Moritz Groß'), sErika = spalte(r, 'Erika Beispiel');
    ok('Spalten für Moritz und Erika (beide haben Einträge)', sMax >= 0 && sErika >= 0, JSON.stringify(r.koepfe));
    const jan = r.zeilen[0].zellen[sMax];
    ok('Moritz im Januar: 19:30 / 2 Tage', jan.startsWith('19:30 / 2 Tage'), jan);
    ok(`… Urlaub als Zeichen mit ${urlaubTage} Tagen`, new RegExp('🌴\\s*' + urlaubTage).test(jan), jan);
    ok('… und ein Verstoß (über 10 Std. am 15.)', /⚠️\s*1/.test(jan), jan);
    ok('Erika im März: 4:00 / 1 Tag', r.zeilen[2].zellen[sErika].startsWith('4:00 / 1 Tag'), r.zeilen[2].zellen[sErika]);
    ok('leere Monate bleiben leer', r.zeilen[5].zellen[sMax] === '' && r.zeilen[0].zellen[sErika] === '', JSON.stringify([r.zeilen[5].zellen[sMax], r.zeilen[0].zellen[sErika]]));
    ok('im Kopf die Jahressumme je Person', r.koepfe[sMax].includes('19:30') && r.koepfe[sErika].includes('4:00'), JSON.stringify(r.koepfe));
    ok('kein Monat des Vorjahrs ist als „heute" markiert', r.zeilen.every(z => !z.heute));
    const netto = await p.$eval('.summary-card .value', e => e.textContent.trim());
    ok('Kachel Nettostunden = Summe des Jahres', netto === '23:30', netto);
    await foto(p, '1-jahr');

    console.log('\n── Filter wirken auch hier ──');
    ok('ohne Filter kein Filter-Hinweis', !(await p.$('.grid-filter-hinweis')));
    await p.select('#filter-project', String(projekt.id)); await sleep(1800);
    r = await raster(p);
    ok('Projekt „Heizung Müller": nur noch der eine Tag', r.zeilen[0].zellen[spalte(r, 'Moritz')] === '8:00 / 1 Tag', r.zeilen[0].zellen[spalte(r, 'Moritz')]);
    // Alex, 06.10.2026: Mit Projekt-/Such-/Regie-Filter nur die passenden STUNDEN — Abwesenheiten und ⚠️ gehören zum
    // ganzen Tag und lenkten ab („⚠️ 12" in Monaten ohne das Projekt).
    ok('… ohne Urlaub-Zeichen und ohne ⚠️ (gehören zum Tag, nicht zum Projekt)', !/🌴|⚠️/.test(r.zeilen[0].zellen[spalte(r, 'Moritz')]), r.zeilen[0].zellen[spalte(r, 'Moritz')]);
    ok('… und ein Satz sagt, warum', /nur die passenden Stunden/.test(await p.$eval('.grid-filter-hinweis', e => e.textContent).catch(() => '')));
    await p.select('#filter-project', ''); await sleep(1500);
    await p.type('#filter-search', 'Heizung'); await sleep(2200);
    r = await raster(p);
    ok('Suche „Heizung" findet den Tag über den Projektnamen — auch hier nur Stunden', r.zeilen[0].zellen[spalte(r, 'Moritz')] === '8:00 / 1 Tag', r.zeilen[0].zellen[spalte(r, 'Moritz')]);
    await p.$eval('#filter-search', e => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(2200);
    r = await raster(p);
    ok('Filter weg: Urlaub und ⚠️ sind wieder da', /🌴/.test(r.zeilen[0].zellen[spalte(r, 'Moritz')]) && /⚠️/.test(r.zeilen[0].zellen[spalte(r, 'Moritz')]), r.zeilen[0].zellen[spalte(r, 'Moritz')]);
    await p.select('#filter-project', ''); await sleep(1800);

    console.log('\n── Antippen: Jahr → Monat ──');
    await p.evaluate(sp => document.querySelectorAll('.week-month-grid tbody tr')[0].querySelectorAll('td.grid-cell')[sp].click(), sMax);
    await sleep(1800);
    r = await raster(p);
    ok(`Januar ${VJ} öffnet sich in der Monatsansicht`, r && r.periode === `Januar ${VJ}`
      && await p.$eval('.view-toggle .active', b => b.dataset.view) === 'month', r && r.periode);

    console.log('\n── Gesamt ──');
    await ansicht(p, 'total');
    r = await raster(p);
    const monate = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    ok(`„Gesamt · seit Juni ${VVJ}" (erster Eintrag)`, r.periode === `Gesamt · seit Juni ${VVJ}`, r.periode);
    ok('keine Pfeile und kein „Jetzt"', !(await p.$('#date-prev')) && !(await p.$('#date-next')) && !(await p.$('#date-today')));
    ok(`Zeilen ${VVJ}, ${VJ}, ${JETZT}`, JSON.stringify(r.zeilen.map(z => z.kopf)) === JSON.stringify([String(VVJ), String(VJ), String(JETZT)]), JSON.stringify(r.zeilen.map(z => z.kopf)));
    ok('das laufende Jahr ist markiert', r.zeilen[2].heute && !r.zeilen[0].heute);
    const gMax = spalte(r, 'Moritz');
    ok(`Moritz ${VVJ}: 5:00 / 1 Tag, ${VJ}: 19:30 / 2 Tage`, r.zeilen[0].zellen[gMax].startsWith('5:00 / 1 Tag') && r.zeilen[1].zellen[gMax].startsWith('19:30 / 2 Tage'),
      JSON.stringify(r.zeilen.map(z => z.zellen[gMax])));
    ok('im Kopf die Gesamtsumme', r.koepfe[gMax].includes('24:30'), r.koepfe[gMax]);
    void monate;
    await foto(p, '2-gesamt');
    await p.evaluate(sp => document.querySelectorAll('.week-month-grid tbody tr')[1].querySelectorAll('td.grid-cell')[sp].click(), gMax);
    await sleep(1800);
    r = await raster(p);
    ok(`Antippen: ${VJ} öffnet sich in der Jahresansicht`, r && r.periode === String(VJ) && await p.$eval('.view-toggle .active', b => b.dataset.view) === 'year', r && r.periode);
    await p.close();

    console.log('\n── Moritz selbst (Mitarbeiter): nur die eigene Spalte, mit Soll ──');
    p = await anmelden('moritz', 'Start!2345');
    await ansicht(p, 'year'); await p.click('#date-prev'); await sleep(1800);
    r = await raster(p);
    ok('eine Spalte', r.koepfe.length === 1, JSON.stringify(r.koepfe));
    ok('Januar: 19:30 / 2 Tage', r.zeilen[0].zellen[0].startsWith('19:30 / 2 Tage'), r.zeilen[0].zellen[0]);
    const kacheln = await p.$$eval('.summary-card .label', ls => ls.map(l => l.textContent.trim()));
    ok('Kacheln wie in Woche und Monat (Soll, Über/Unter, Überstunden gesamt)', kacheln.some(k => /Soll-Stunden/.test(k)) && kacheln.some(k => /Überstunden gesamt/.test(k)), JSON.stringify(kacheln));
    await ansicht(p, 'total');
    r = await raster(p);
    ok('Gesamt beginnt bei seinem ersten Eintrag', r.periode === `Gesamt · seit Juni ${VVJ}`, r.periode);
    await p.close();

    console.log('\n── Handy ──');
    p = await anmelden('chef', pw('chef'), { width: 390, height: 844, isMobile: true, hasTouch: true });
    await ansicht(p, 'year'); await p.click('#date-prev'); await sleep(1800);
    const breit = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    ok('am Handy kein seitliches Scrollen der Seite (das Raster scrollt in sich)', breit);
    await foto(p, '3-handy-jahr');
    await p.close();

    ok('keine JavaScript-Fehler', fehler.length === 0, fehler.slice(0, 3).join(' | '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
  }
  console.log(`\nZeitnachweis Jahr/Gesamt: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
