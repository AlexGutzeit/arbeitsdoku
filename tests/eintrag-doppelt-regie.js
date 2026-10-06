// Doppelte Einträge (Rückfrage statt stillem Doppel) und der Regie-Filter mit allen Arten — Alex, 06.10.2026.
//
// Anlass war eine Filterprobe an den echten Daten: drei identische Einträge (zweimal Doppel-Tipper vor dem
// Doppel-Klick-Schutz, einmal von Hand dreimal eingetragen). Und „Regie: Ja" zählte alle Arten außer „Nein" —
// also auch Büro-, Lager- und Interne Zeiten.
//
// Identisch = gleiche Person, gleicher Tag und in ALLEN Inhaltsfeldern gleich (Von, Bis, Pause, Projekt, Kunde,
// Adresse, Beschreibung, Regie-Art) — so sahen alle drei echten Doppel aus. Unterscheidet sich ein Feld, ist es
// zeitgleiche Arbeit an zwei Aufträgen und KEIN Doppel. Kein Verbot: Wer bewusst trotzdem speichert,
// kann das (Rückfrage im Formular, `doppelt_ok` am Server).
//
//   node tests/eintrag-doppelt-regie.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3375, DB = '/tmp/eintrag-doppelt-regie.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const TAG = '2026-09-01';   // fester Tag in der Vergangenheit — nie „heute", nie Zukunft

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/eintrag-doppelt-regie-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/eintrag-doppelt-regie-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await req('POST', '/api/users', admin, { username: 'moritz', password: 'Start!2345', name: 'Moritz Groß', role: 'mitarbeiter',
      birth_date: '1980-05-05', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 });
    const T = (await req('POST', '/api/auth/login', null, { username: 'moritz', password: 'Start!2345' })).body.token;
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Heizung Müller' })).body.project;
    const anderes = (await req('POST', '/api/projects', admin, { name: 'Dach Schmidt' })).body.project;
    const anzahl = async () => ((await req('GET', `/api/entries?date_from=${TAG}&date_to=${TAG}`, T)).body.entries || []).length;
    const eintrag = (extra = {}) => req('POST', '/api/entries', T, { date: TAG, time_from: '07:00', time_to: '15:30', break_minutes: 30,
      project_id: projekt.id, description: 'Arbeit', ...extra });

    console.log('── Server: denselben Eintrag gibt es schon ──');
    let r = await eintrag();
    ok('der erste Eintrag wird angelegt', r.status === 201, r.text.slice(0, 80));
    const erster = r.body.entry;
    r = await eintrag();
    ok('derselbe noch einmal → 409 mit Kennung EINTRAG_DOPPELT', r.status === 409 && r.body.code === 'EINTRAG_DOPPELT', `${r.status} ${r.text.slice(0, 120)}`);
    ok('… die Meldung nennt Tag, Zeit und Projekt', /01\.09\.2026, 07:00–15:30, Heizung Müller/.test(r.body.error || ''), r.body.error);
    ok('… und es wurde nichts angelegt', await anzahl() === 1);
    r = await eintrag({ doppelt_ok: true });
    ok('mit „trotzdem speichern" geht es', r.status === 201 && await anzahl() === 2, `${r.status}`);
    const zweiter = r.body.entry;
    ok('gleiche Zeit, ANDERES Projekt ist kein Doppel (zeitgleiche Aufträge)', (await eintrag({ project_id: anderes.id })).status === 201);
    ok('gleiche Zeit ohne Projekt ist auch keins', (await eintrag({ project_id: null })).status === 201);
    ok('andere Zeit ist keins', (await eintrag({ time_from: '15:30', time_to: '17:00', break_minutes: 0 })).status === 201);
    ok('gleiche Zeit und gleiches Projekt, aber andere Beschreibung → zwei Aufträge, kein Doppel', (await eintrag({ description: 'Zweiter Auftrag' })).status === 201);
    ok('… ebenso mit anderer Pause', (await eintrag({ break_minutes: 45 })).status === 201);

    console.log('\n── Server: Bearbeiten ──');
    // Nur die persönliche Notiz ändern: Der Inhalt bleibt gleich — es GIBT noch die gleiche Kopie
    r = await req('PUT', '/api/entries/' + erster.id, T, { personal_note: 'nur für mich', reason: '' });
    ok('Bearbeiten, solange eine gleiche Kopie existiert → Rückfrage (die Kopie IST ein Doppel)',
      r.status === 409 && r.body.code === 'EINTRAG_DOPPELT', `${r.status}`);
    r = await req('PUT', '/api/entries/' + erster.id, T, { personal_note: 'nur für mich', reason: '', doppelt_ok: true });
    ok('… mit „trotzdem" gespeichert', r.status === 200, r.text.slice(0, 80));
    r = await req('DELETE', '/api/entries/' + zweiter.id, T, { reason: 'Doppel' });
    ok('die Kopie wird gelöscht', r.status === 200, r.text.slice(0, 80));
    r = await req('PUT', '/api/entries/' + erster.id, T, { personal_note: 'wieder allein', reason: '' });
    ok('danach: Bearbeiten ohne Rückfrage — ein Eintrag ist kein Doppel von sich selbst, gelöschte zählen nicht', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    const spaeter = (await eintrag({ time_from: '17:00', time_to: '18:00', break_minutes: 0 })).body.entry;
    r = await req('PUT', '/api/entries/' + spaeter.id, T, { time_from: '07:00', time_to: '15:30', break_minutes: 30, reason: '' });
    ok('einen anderen Eintrag auf dieselbe Zeit UND dasselbe Projekt umstellen → Rückfrage', r.status === 409 && r.body.code === 'EINTRAG_DOPPELT', `${r.status}`);

    console.log('\n── Server: Regie-Filter mit allen Arten ──');
    const arten = { 0: 'Nein', 1: 'Ja', 2: 'pauschal', 3: 'Büro', 4: 'Lager', 5: 'Intern' };
    for (const k of Object.keys(arten)) {
      await req('POST', '/api/entries', T, { date: `2026-08-0${Number(k) + 3}`, time_from: '07:00', time_to: String(8 + Number(k)).padStart(2, '0') + ':00', break_minutes: 0, has_regie: Number(k) });
    }
    const regie = async (wert) => ((await req('GET', `/api/entries?date_from=2026-08-01&date_to=2026-08-31&regie=${wert}`, T)).body.entries || []).map(e => e.has_regie).sort();
    ok('„Nein" → nur ohne Regie', JSON.stringify(await regie('0')) === '[0]', JSON.stringify(await regie('0')));
    ok('„Ja" → NUR echte Regie (früher: alle Arten)', JSON.stringify(await regie('1')) === '[1]', JSON.stringify(await regie('1')));
    ok('„Büro" → nur Büro', JSON.stringify(await regie('3')) === '[3]', JSON.stringify(await regie('3')));
    ok('„jede Art" → alle außer „Nein" (das frühere „Ja")', JSON.stringify(await regie('jede')) === '[1,2,3,4,5]', JSON.stringify(await regie('jede')));
    ok('ohne Filter → alle sechs', ((await req('GET', '/api/entries?date_from=2026-08-01&date_to=2026-08-31', T)).body.entries || []).length === 6);

    console.log('\n── Oberfläche: die Rückfrage im Formular ──');
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1100, height: 900 }); p.setDefaultTimeout(30000);
    const fehler = []; p.on('pageerror', e => fehler.push(String(e)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fehler.push(m.text()); });
    await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'moritz'); await p.type('#login-pass', 'Start!2345');
    await p.click('#login-form button[type="submit"]'); await sleep(2200);
    const formular = async () => {
      await p.evaluate(() => { location.hash = '#/welcome'; }); await sleep(600);
      await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1600);
      await p.waitForSelector('#ef-from');
      // Erst das Datum: Ein Datumswechsel belegt „Von" neu vor (Anschluss an den letzten Eintrag des Tages) —
      // die Zeiten danach setzen, wie ein Mensch es täte. Die Pause zuletzt (sie wird aus den Zeiten vorbelegt).
      const setze = (id, v) => p.evaluate((i, w) => { const el = document.getElementById(i); el.value = w;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, id, v);
      await setze('ef-date', TAG); await sleep(700);
      await setze('ef-project', String(projekt.id)); await sleep(300);
      await setze('ef-from', '07:00'); await setze('ef-to', '15:30'); await sleep(300);
      await setze('ef-break', '30'); await setze('ef-desc', 'Arbeit'); await sleep(300);
      const werte = await p.evaluate(() => ['ef-date', 'ef-from', 'ef-to', 'ef-break', 'ef-project', 'ef-desc'].map(i => document.getElementById(i).value).join(' '));
      if (werte !== `${TAG} 07:00 15:30 30 ${projekt.id} Arbeit`) console.log('      Formular steht auf: ' + werte);
      await p.evaluate(() => document.getElementById('entry-form').requestSubmit());
      await sleep(1200);
    };
    const vorher = await anzahl();
    await formular();
    const dialog = await p.evaluate(() => { const m = [...document.querySelectorAll('.modal')].pop(); return m ? m.innerText : null; });
    ok('Speichern eines vorhandenen Eintrags fragt nach', /Eintrag gibt es schon/.test(dialog || '') && /Trotzdem speichern/.test(dialog || ''), dialog);
    await p.click('.modal [data-act="cancel"]'); await sleep(800);
    ok('„Abbrechen": nichts gespeichert, das Formular bleibt offen', await anzahl() === vorher && await p.evaluate(() => location.hash === '#/entry/new'));
    await p.evaluate(() => document.getElementById('entry-form').requestSubmit()); await sleep(1200);
    await p.click('.modal [data-act="ok"]'); await sleep(1800);
    ok('„Trotzdem speichern": gespeichert, zurück zur Übersicht', await anzahl() === vorher + 1 && await p.evaluate(() => location.hash === '#/' || location.hash === ''), String(await anzahl()));

    console.log('\n── Oberfläche: Regie-Filter ──');
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(1800);
    const optionen = await p.$$eval('#filter-regie option', os => os.map(o => o.value + '=' + o.textContent.trim()));
    ok('Alle · Nein · jede Art · Ja · pauschal · Büro · Lager · Intern',
      JSON.stringify(optionen) === JSON.stringify(['=Regie: Alle', '0=Regie: Nein', 'jede=Regie: jede Art', '1=Regie: Ja', '2=Regie: pauschal', '3=Regie: Büro', '4=Regie: Lager', '5=Regie: Intern']),
      JSON.stringify(optionen));
    await p.click('.view-toggle [data-view="total"]'); await sleep(1800);
    await p.select('#filter-regie', '3'); await sleep(1800);
    const buero = await p.$eval('.summary-card .value', e => e.textContent.trim());
    ok('„Regie: Büro" in Gesamt: nur die Büro-Stunden (07:00–11:00 = 4:00)', buero === '4:00', buero);
    ok('keine JavaScript-Fehler', fehler.length === 0, fehler.slice(0, 2).join(' | '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
  }
  console.log(`\nDoppelte Einträge + Regie-Filter: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
