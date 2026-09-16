// Die drei Board-Ansichten: Alle · Mitarbeiter · Kategorien (Alex, 15.09.2026).
//
// Der Serverteil steht in tests/auftrags-kategorien.js. Hier geht es um das, was man SIEHT — und
// vor allem um die Regel, die man beim Bauen am leichtesten falsch macht:
//
//   Mitarbeiter → Rest-Spalte „Nicht zugewiesen" = kein Mitarbeiter
//   Kategorien  → Rest-Spalte „Ohne Kategorie"   = keine Kategorie
//   Alle        → Rest-Spalte „Nicht zugewiesen" = WEDER noch
//
// Der letzte Fall ist der Sinn der Sache: In „Alle" darf nichts durchs Raster fallen. Ein Auftrag
// mit Kategorie, aber ohne Mitarbeiter, steht unter seiner Kategorie — nicht im Rest. Und eine
// Kachel darf mehrfach erscheinen (Mitarbeiter UND Kategorie), damit jede Spalte vollständig ist.
//
//   node tests/auftrags-kategorien-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3323, DB = '/tmp/auftrags-kategorien-ui.db', LOG = '/tmp/auftrags-kategorien-ui.log';
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
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;

    for (const alt of (await req('GET', '/api/projects', admin)).body.projects) {
      await req('DELETE', `/api/projects/${alt.id}`, admin);   // Seed-Auftraege aus dem Weg
    }
    const pv = (await req('POST', '/api/projects/kategorien', admin, { name: 'PV' })).body.kategorie;
    const zs = (await req('POST', '/api/projects/kategorien', admin, { name: 'Zählerschrank' })).body.kategorie;
    await req('POST', '/api/projects/kategorien', admin, { name: 'Kleinarbeiten' });   // bleibt leer

    // Vier Fälle, die zusammen jede Kombination abdecken:
    await req('POST', '/api/projects', admin, { name: 'Halle 3 Dach', assigned_user_ids: [maxId], category_ids: [pv.id] });
    await req('POST', '/api/projects', admin, { name: 'Dach Süd',     category_ids: [pv.id, zs.id] });   // nur Kategorie
    await req('POST', '/api/projects', admin, { name: 'Kabel ziehen', assigned_user_ids: [maxId] });      // nur MA
    await req('POST', '/api/projects', admin, { name: 'Nichts davon' });                                  // weder noch
    // Alex' Beispiel (16.09.2026): ZWEI Zugeteilte, ZWEI Kategorien — der Fall, an dem sich die
    // Plaketten-Regel vollstaendig zeigt.
    const erikaId = (await req('POST', '/api/users', admin, { username: 'erika', password: 'Monteur1!',
      name: 'Erika Musterfrau', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user.id;
    await req('POST', '/api/projects', admin, { name: 'Wallbox Carport',
      assigned_user_ids: [maxId, erikaId], category_ids: [pv.id, zs.id] });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1400, height: 950 });
    seite.setDefaultTimeout(30000);
    const jsFehler = [];
    seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pw('admin'));
    await seite.click('#login-form button[type="submit"]'); await sleep(2600);
    await seite.goto(BASIS + '/#/projects', { waitUntil: 'domcontentloaded' }); await sleep(2500);

    const board = () => seite.evaluate(() => [...document.querySelectorAll('.board-col')].map(c => ({
      name: c.querySelector('.board-col-head').textContent
        .replace(/[▦✎×]/g, ' ').replace(/\s+/g, ' ').trim(),
      kat: !!c.querySelector('.board-kat-zeichen'),
      auftraege: [...c.querySelectorAll('.proj-tile .proj-name')].map(t => t.textContent.trim()),
    })));
    const umschalten = async (welche) => {
      await seite.evaluate((w) => {
        const b = [...document.querySelectorAll('.board-ansicht-btn')].find(x => x.dataset.ansicht === w);
        if (b) b.click();
      }, welche);
      await sleep(2000);
    };
    const spalte = (b, n) => b.find(c => c.name.startsWith(n));

    console.log('── Voreinstellung: die Ansicht, die es vorher gab ──');
    ok('beim Öffnen steht „Mitarbeiter" an',
      await seite.evaluate(() => (document.querySelector('.board-ansicht-btn.active') || {}).dataset?.ansicht === 'mitarbeiter'),
      await seite.evaluate(() => (document.querySelector('.board-ansicht-btn.active') || {}).textContent));
    let b = await board();
    ok('… „Nicht zugewiesen" enthält alles ohne Mitarbeiter',
      spalte(b, 'Nicht zugewiesen').auftraege.sort().join('|') === 'Dach Süd|Nichts davon',
      JSON.stringify(spalte(b, 'Nicht zugewiesen').auftraege));
    ok('… Max hat seine beiden', spalte(b, 'Max Mustermann').auftraege.sort().join('|') === 'Halle 3 Dach|Kabel ziehen',
      JSON.stringify(spalte(b, 'Max Mustermann').auftraege));
    ok('… und es gibt KEINE Kategorie-Spalten', !b.some(c => c.kat), JSON.stringify(b.map(c => c.name)));

    console.log('\n── Kategorien ──');
    await umschalten('kategorien');
    b = await board();
    ok('die Rest-Spalte heisst jetzt „Ohne Kategorie"', !!spalte(b, 'Ohne Kategorie'), JSON.stringify(b.map(c => c.name)));
    ok('… und enthält, was keine Kategorie hat',
      spalte(b, 'Ohne Kategorie').auftraege.sort().join('|') === 'Kabel ziehen|Nichts davon',
      JSON.stringify(spalte(b, 'Ohne Kategorie').auftraege));
    ok('… PV zeigt beide PV-Aufträge', spalte(b, 'PV').auftraege.sort().join('|') === 'Dach Süd|Halle 3 Dach',
      JSON.stringify(spalte(b, 'PV').auftraege));
    ok('… „Dach Süd" steht auch unter Zählerschrank',
      spalte(b, 'Zählerschrank').auftraege.join('|') === 'Dach Süd', JSON.stringify(spalte(b, 'Zählerschrank').auftraege));
    ok('… eine LEERE Kategorie wird trotzdem gezeigt (sonst legt man sie doppelt an)',
      !!spalte(b, 'Kleinarbeiten'), JSON.stringify(b.map(c => c.name)));
    ok('… und es gibt KEINE Mitarbeiter-Spalten',
      !b.some(c => /Max Mustermann/.test(c.name)), JSON.stringify(b.map(c => c.name)));

    console.log('\n── Alle ──');
    await umschalten('alle');
    b = await board();
    ok('hier steht NUR die echte Waise im Rest',
      spalte(b, 'Nicht zugewiesen').auftraege.join('|') === 'Nichts davon',
      JSON.stringify(spalte(b, 'Nicht zugewiesen').auftraege));
    ok('… „Dach Süd" (Kategorie, kein MA) fällt NICHT in den Rest',
      !spalte(b, 'Nicht zugewiesen').auftraege.includes('Dach Süd'));
    ok('… sondern steht unter seinen Kategorien',
      spalte(b, 'PV').auftraege.includes('Dach Süd') && spalte(b, 'Zählerschrank').auftraege.includes('Dach Süd'));
    ok('… Mitarbeiter- UND Kategorie-Spalten sind da',
      !!spalte(b, 'Max Mustermann') && !!spalte(b, 'PV'), JSON.stringify(b.map(c => c.name)));
    ok('… dieselbe Kachel erscheint mehrfach (Max UND PV)',
      spalte(b, 'Max Mustermann').auftraege.includes('Halle 3 Dach')
      && spalte(b, 'PV').auftraege.includes('Halle 3 Dach'));
    // Gegenprobe: JEDER Auftrag ist in „Alle" mindestens einmal zu sehen.
    const alleSichtbar = new Set(b.flatMap(c => c.auftraege));
    ok('… kein Auftrag fällt durchs Raster',
      ['Halle 3 Dach', 'Dach Süd', 'Kabel ziehen', 'Nichts davon'].every(n => alleSichtbar.has(n)),
      JSON.stringify([...alleSichtbar]));

    console.log('\n── Die Plaketten zeigen die ANDERE Richtung ──');
    // Alex' Fall (16.09.2026): In der Kategorie-Spalte „PV" stand auf jeder Kachel die Plakette
    // „PV" — eine Wiederholung der Spalte, unter der man ohnehin steht. Nuetzlich ist dort, WER
    // den Auftrag hat.
    const plaketten = (spaltenName) => seite.evaluate((n) => {
      const sp = [...document.querySelectorAll('.board-col')].find(c =>
        c.querySelector('.board-col-head').textContent.replace(/[▦✎×]/g, ' ').replace(/\s+/g, ' ').trim().startsWith(n));
      if (!sp) return null;
      return [...sp.querySelectorAll('.proj-tile')].map(t => ({
        name: t.querySelector('.proj-name').textContent.trim(),
        ma: [...t.querySelectorAll('.proj-kat-ma')].map(x => x.textContent.trim()),
        kat: [...t.querySelectorAll('.proj-kat:not(.proj-kat-ma)')].map(x => x.textContent.trim()),
      }));
    }, spaltenName);

    await umschalten('kategorien');
    let pvSp = await plaketten('PV');
    let halle = pvSp.find(x => x.name === 'Halle 3 Dach');
    ok('in der Spalte „PV" steht NICHT noch einmal „PV"', !halle.kat.includes('PV'), JSON.stringify(halle));
    ok('… sondern wer den Auftrag hat', halle.ma.join('|') === 'Max Mustermann', JSON.stringify(halle));
    const dach = pvSp.find(x => x.name === 'Dach Süd');
    ok('… und die ANDERE Kategorie bleibt stehen', dach.kat.join('|') === 'Zählerschrank', JSON.stringify(dach));
    ok('… ein Auftrag ohne Mitarbeiter zeigt dort auch keinen', dach.ma.length === 0, JSON.stringify(dach));
    const ohne = await plaketten('Ohne Kategorie');
    ok('in „Ohne Kategorie" stehen die Mitarbeiter',
      (ohne.find(x => x.name === 'Kabel ziehen') || {}).ma.join('|') === 'Max Mustermann',
      JSON.stringify(ohne));

    await umschalten('mitarbeiter');
    const maSp = await plaketten('Max Mustermann');
    halle = maSp.find(x => x.name === 'Halle 3 Dach');
    ok('in der Mitarbeiter-Spalte stehen weiterhin die Kategorien', halle.kat.join('|') === 'PV', JSON.stringify(halle));
    ok('… und NICHT der Mitarbeiter, in dessen Spalte man steht', halle.ma.length === 0, JSON.stringify(halle));
    ok('… wohl aber die ANDEREN Zugeteilten',
      (maSp.find(x => x.name === 'Wallbox Carport') || {}).ma.join('|') === 'Erika Musterfrau',
      JSON.stringify(maSp.find(x => x.name === 'Wallbox Carport')));
    const rest = await plaketten('Nicht zugewiesen');
    ok('in „Nicht zugewiesen" stehen die Kategorien',
      (rest.find(x => x.name === 'Dach Süd') || {}).kat.sort().join('|') === 'PV|Zählerschrank',
      JSON.stringify(rest));

    await umschalten('alle');
    ok('in „Alle" gilt dieselbe Regel je Spalte: Kategorie-Spalte zeigt den Mitarbeiter …',
      (await plaketten('PV')).find(x => x.name === 'Halle 3 Dach').ma.join('|') === 'Max Mustermann');
    ok('… und die Mitarbeiter-Spalte die Kategorie',
      (await plaketten('Max Mustermann')).find(x => x.name === 'Halle 3 Dach').kat.join('|') === 'PV');

    console.log('\n── Alex\' Beispiel: zwei Zugeteilte, zwei Kategorien, alle vier Spalten ──');
    // „Wallbox Carport" haengt an Max UND Erika sowie an PV UND Zaehlerschrank.
    // Erwartet ist in jeder der vier Spalten: ALLES ausser der Spalte selbst.
    await umschalten('alle');
    const wallbox = async (sp) => {
      const z = (await plaketten(sp)).find(x => x.name === 'Wallbox Carport');
      return z ? [...z.ma, ...z.kat].sort().join(' · ') : '(nicht in der Spalte)';
    };
    ok('unter Max:            Erika · PV · Zählerschrank',
      await wallbox('Max Mustermann') === 'Erika Musterfrau · PV · Zählerschrank', await wallbox('Max Mustermann'));
    ok('unter Erika:          Max · PV · Zählerschrank',
      await wallbox('Erika Musterfrau') === 'Max Mustermann · PV · Zählerschrank', await wallbox('Erika Musterfrau'));
    ok('unter PV:             Erika · Max · Zählerschrank',
      await wallbox('PV') === 'Erika Musterfrau · Max Mustermann · Zählerschrank', await wallbox('PV'));
    ok('unter Zählerschrank:  Erika · Max · PV',
      await wallbox('Zählerschrank') === 'Erika Musterfrau · Max Mustermann · PV', await wallbox('Zählerschrank'));

    console.log('\n── Die Ansicht bleibt stehen ──');
    await seite.evaluate(() => renderProjects());
    await sleep(2200);
    ok('nach einem Neuaufbau ist „Alle" noch gewählt',
      await seite.evaluate(() => (document.querySelector('.board-ansicht-btn.active') || {}).dataset?.ansicht === 'alle'));

    console.log('\n── Kategorien verwalten ──');
    await umschalten('kategorien');
    ok('der Chef sieht „+ Kategorie"', await seite.evaluate(() => !!document.getElementById('kat-neu')));
    ok('… und je Spalte Umbenennen/Löschen',
      await seite.evaluate(() => document.querySelectorAll('.kat-um').length === 3
                              && document.querySelectorAll('.kat-weg').length === 3),
      await seite.evaluate(() => document.querySelectorAll('.kat-um').length));
    // Löschen einer BELEGTEN Kategorie: zwei Rückfragen, und die Aufträge bleiben.
    await seite.evaluate((id) => document.querySelector(`.kat-weg[data-id="${id}"]`).click(), pv.id);
    await sleep(700);
    const frage1 = await seite.evaluate(() => (document.querySelector('.modal') || {}).innerText || '');
    ok('die erste Rückfrage sagt, dass die Aufträge bleiben', /Aufträge selbst bleiben/.test(frage1), frage1.slice(0, 160));
    await seite.evaluate(() => [...document.querySelectorAll('.modal button')].find(x => /Löschen/i.test(x.textContent)).click());
    await sleep(900);
    const frage2 = await seite.evaluate(() => (document.querySelector('.modal') || {}).innerText || '');
    ok('… die zweite nennt die Zahl der betroffenen Aufträge', /noch 2 Aufträge/.test(frage2), frage2.slice(0, 160));
    await seite.evaluate(() => [...document.querySelectorAll('.modal button')].find(x => /Trotzdem/i.test(x.textContent)).click());
    await sleep(2200);
    b = await board();
    ok('… PV ist weg', !spalte(b, 'PV'), JSON.stringify(b.map(c => c.name)));
    ok('… die Aufträge nicht',
      (await req('GET', '/api/projects', admin)).body.projects.length === 4);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }

  console.log(`\nAuftrags-Kategorien (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
