// UI-Test (Puppeteer): mehrere Mitarbeiter parallel mit unterschiedlichem Anspruch/Verfall über Jahre.
// Prüft IM ECHTEN BROWSER, dass die Manager-Urlaubsübersicht jede MA-Zeile korrekt + unabhängig anzeigt
// (Abgleich gegen die Backend-Werte), Jahreswechsel wirkt, „–"-Weiche für unkonfigurierte MA, und die
// MA-Eigen-Kopfzeile (konfiguriert vs. nicht). Ergänzt die reinen Logik-/API-Tests um die Browser-Ebene.
//   node tests/vacation-multi-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3205, DB = '/tmp/vacation-multi-ui.db', BASE = 'http://localhost:' + PORT;
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
const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/vacation-multi-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const pw = (fs.readFileSync('/tmp/vacation-multi-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = await tok('admin', pw);

    const mkU = async (un, nm) => (await req('POST', '/api/users', admin, { username: un, password: 'Test1234!', name: nm, role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    const ent = (uid, vf, d, m, u) => req('POST', `/api/statistics/vacation/${uid}`, admin, { valid_from: vf, days: d, carryover_mode: m, carryover_until: u || null });
    const sc = (uid, d) => req('PUT', `/api/statistics/vacation/${uid}/start-carry`, admin, { days: d });
    const mk = async (uid, ty, f, t) => (await req('POST', '/api/absences', admin, { type: ty, date_from: f, date_to: t, target_user_id: uid })).body.absence.id;
    const appr = id => req('POST', `/api/absences/${id}/approve`, admin);

    // Fünf MA – gleiche Matrix wie vacation-multi.js (unterschiedlicher Anspruch/Verfall):
    const A = await mkU('anna', 'Anna Musterfrau');   // yearend 25/28/30
    await ent(A.id, '2024-01-01', 25, 'yearend'); await ent(A.id, '2025-01-01', 28, 'yearend'); await ent(A.id, '2026-01-01', 30, 'yearend');
    await appr(await mk(A.id, 'urlaub', '2024-06-03', '2024-06-07')); await appr(await mk(A.id, 'urlaub', '2025-06-02', '2025-06-06'));
    await appr(await mk(A.id, 'urlaub', '2026-06-01', '2026-06-05')); await appr(await mk(A.id, 'urlaub', '2026-08-03', '2026-08-07'));
    const B = await mkU('bernd', 'Bernd Beispiel');   // never
    await ent(B.id, '2024-01-01', 30, 'never');
    await appr(await mk(B.id, 'urlaub', '2024-06-03', '2024-06-07')); await appr(await mk(B.id, 'urlaub', '2025-06-02', '2025-06-06')); await appr(await mk(B.id, 'urlaub', '2026-06-01', '2026-06-05'));
    const C = await mkU('clara', 'Clara Test');       // date 31.3.
    await ent(C.id, '2025-01-01', 24, 'date', '03-31');
    await appr(await mk(C.id, 'urlaub', '2025-06-02', '2025-06-06')); await appr(await mk(C.id, 'urlaub', '2026-06-01', '2026-06-05'));
    const D = await mkU('dieter', 'Dieter Neu');      // start_carry + Wechsel yearend->never
    await sc(D.id, 8); await ent(D.id, '2024-01-01', 25, 'yearend'); await ent(D.id, '2026-01-01', 30, 'never');
    const E = await mkU('erik', 'Erik Ohnekonto');    // unkonfiguriert
    await appr(await mk(E.id, 'urlaub', '2026-06-01', '2026-06-05'));
    ok('Setup: 5 MA angelegt', !!(A && B && C && D && E));

    // Erwartungswerte je Jahr direkt aus dem Backend (Overview-API) – die Browser-Tabelle MUSS das spiegeln.
    const expByYear = {};
    for (const y of [2026, 2027]) {
      const rows = (await req('GET', `/api/absences/vacation-overview?year=${y}`, admin)).body.rows;
      expByYear[y] = Object.fromEntries(rows.map(r => [r.name, r]));
    }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1360, height: 950 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(900);
    await p.waitForSelector('.absence-tab[data-tab="vacation"]', { timeout: 8000 });
    await p.evaluate(() => document.querySelector('.absence-tab[data-tab="vacation"]').click());
    await p.waitForSelector('.vac-ov-table', { timeout: 8000 }); await sleep(400);

    // Tabelle aus dem DOM lesen: name -> [zellen...]
    const readTable = () => p.evaluate(() => {
      const out = {};
      document.querySelectorAll('.vac-ov-table tbody tr[data-name]').forEach(tr => {
        const c = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
        out[c[0]] = c; // 0=Name,1=Anspruch,2=Übrig,3=Gesamt,4=Genommen,5=Geplant,6=NochZuPlanen,7=Beantragt,8=Krank,9=FZA
      });
      return out;
    });

    // Vergleich Browser-Zeile ↔ Backend je konfiguriertem MA (Rendering spiegelt die Rechnung, unabhängig je MA)
    const DASH = '–';
    const checkYear = async (year) => {
      const t = await readTable();
      const exp = expByYear[year];
      for (const name of ['Anna Musterfrau', 'Bernd Beispiel', 'Clara Test', 'Dieter Neu']) {
        const e = exp[name], c = t[name];
        const good = c && String(e.anspruch) === c[1] && String(e.uebertrag) === c[2] && String(e.gesamtanspruch) === c[3]
          && String(e.genommen) === c[4] && String(e.geplant) === c[5] && String(e.nochZuPlanen) === c[6]
          && String(e.beantragt) === c[7] && String(e.krank) === c[8] && String(e.fza) === c[9];
        ok(`${year}: „${name}" Browser = Backend (${e.anspruch}/${e.uebertrag}/${e.gesamtanspruch}/${e.genommen}/${e.geplant}/${e.nochZuPlanen})`, good, 'browser=' + JSON.stringify(c) + ' backend=' + JSON.stringify([e.anspruch, e.uebertrag, e.gesamtanspruch, e.genommen, e.geplant, e.nochZuPlanen, e.beantragt, e.krank, e.fza]));
      }
      // Erik: unkonfiguriert → „–" in den Anspruch-Spalten, genommen aber real
      const er = t['Erik Ohnekonto'];
      ok(`${year}: „Erik" unkonfiguriert → „–" in Anspruch/Übrig/Gesamt/NochZuPlanen`, er && er[1] === DASH && er[2] === DASH && er[3] === DASH && er[6] === DASH, 'erik=' + JSON.stringify(er));
      ok(`${year}: „Erik" genommen real (5)`, er && er[4] === String(exp['Erik Ohnekonto'].genommen), 'erik genommen=' + (er && er[4]));
    };

    console.log('\nManager-Übersicht 2026 (Browser = Backend, je MA unabhängig):');
    await checkYear(2026);
    // Unabhängigkeit sichtbar: Übertrag unterscheidet sich je MA
    const t26 = await readTable();
    ok('Übertrag je MA verschieden (Anna=0, Bernd>0, Clara=0, Dieter=0)', t26['Anna Musterfrau'][2] === '0' && Number(t26['Bernd Beispiel'][2]) > 0 && t26['Clara Test'][2] === '0' && t26['Dieter Neu'][2] === '0', JSON.stringify({ A: t26['Anna Musterfrau'][2], B: t26['Bernd Beispiel'][2], C: t26['Clara Test'][2], D: t26['Dieter Neu'][2] }));

    console.log('\nJahreswechsel auf 2027 (Übertrag wächst bei never/Wechsel):');
    await p.select('#vac-ov-year', '2027'); await sleep(600);
    await p.waitForSelector('.vac-ov-table', { timeout: 8000 });
    await checkYear(2027);
    const t27 = await readTable();
    ok('2027: Dieter Übertrag > 0 (2026 lief never)', Number(t27['Dieter Neu'][2]) > 0, 'dieter uebertrag 2027=' + t27['Dieter Neu'][2]);

    // MA-Eigen-Kopfzeile: konfiguriert (Bernd) zeigt neue Fassung, unkonfiguriert (Erik) die alte
    console.log('\nMA-Kopfzeilen (konfiguriert vs. nicht):');
    const maHeader = async (user) => {
      const ctx = await browser.createBrowserContext(); const pm = await ctx.newPage(); await pm.setViewport({ width: 1000, height: 800 });
      await pm.goto(BASE, { waitUntil: 'networkidle2' });
      await pm.waitForSelector('#login-user'); await pm.type('#login-user', user); await pm.type('#login-pass', 'Test1234!');
      await pm.click('#login-form button[type="submit"]'); await pm.waitForSelector('a[href="#/absences"]', { timeout: 8000 });
      await pm.evaluate(() => { location.hash = '#/absences'; }); await sleep(800);
      await pm.waitForSelector('.absence-counter', { timeout: 8000 });
      const txt = await pm.evaluate(() => document.querySelector('.absence-counter').textContent);
      await ctx.close(); return txt.replace(/\s+/g, ' ').trim();
    };
    const hB = await maHeader('bernd');
    ok('Bernd (konfiguriert): Kopf zeigt genommen · geplant · verbleibend', /genommen/.test(hB) && /geplant/.test(hB) && /verbleibend/.test(hB), hB);
    const hE = await maHeader('erik');
    ok('Erik (unkonfiguriert): alte Kopfzeile „X Arbeitstage" (kein verbleibend)', /Arbeitstage/.test(hE) && !/verbleibend/.test(hE), hE);

  } catch (e) { fail++; fails.push('EXCEPTION: ' + e.message); console.log('  ✗ EXCEPTION: ' + e.message); }
  finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nVacation-Multi-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
