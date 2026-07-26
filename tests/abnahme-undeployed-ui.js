// ABNAHME-TEST über ALLE noch nicht deployten Änderungen (Bugliste v6, Runden 1–4).
// Ein Durchlauf, der jede Änderung im Browser gegen einen echten Server prüft — als letzte Kontrolle
// vor dem Deployment. Start: node tests/abnahme-undeployed-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3129, DB = '/tmp/abnahme.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) { j = s; } res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const today = new Date().toLocaleDateString('sv-SE');
const XSS = '</textarea><img src=x onerror="window.__xss=true">';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abnahme-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/abnahme-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const cpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'abnahme', password: 'Test1234!', name: 'Abnahme MA', role: 'mitarbeiter' })).body.user;
    const maTok = (await login('abnahme', 'Test1234!')).body.token;
    const selfP = (await req('POST', '/api/users', admin, { username: 'abself', password: 'Test1234!', name: 'Self Planer', role: 'mitarbeiter', can_plan: true })).body.user;
    const selfTok = (await login('abself', 'Test1234!')).body.token;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 950 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // ══ RUNDE 1 ══
    console.log('Runde 1 — XSS, Rechte, Abrechnung, Zahlen, Layout:');
    await req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: ma.id, comment: XSS });
    await p.evaluate(() => { window.__xss = false; location.hash = '#/absences'; }); await sleep(1400);
    const eb = await p.$('.absence-edit');
    if (eb) { await eb.click(); await sleep(700); }
    const a1 = await p.evaluate(() => ({ xss: window.__xss === true, img: !!document.querySelector('.absence-form-card img'), val: document.getElementById('abs-comment')?.value || '' }));
    ok('A1 XSS: kein Script ausgeführt', a1.xss === false);
    ok('A1 XSS: kein <img> eingeschleust', a1.img === false);
    ok('A1: Kommentar unverfälscht im Feld', a1.val.includes('<img src=x'));
    await p.evaluate(() => document.getElementById('abs-cancel')?.click()); await sleep(200);
    ok('A1b esc() escapt Anführungszeichen', (await p.evaluate(() => esc('a" x'))).includes('&quot;'));

    const fremd = (await req('POST', '/api/planning', admin, { date: '2027-12-01', time_from: '08:00', time_to: '16:00', assigned_user_ids: [ma.id] })).body.entry;
    const a2 = await req('POST', '/api/planning/to-series', selfTok, { entry_id: fremd.id, date: '2027-12-01', time_from: '08:00', time_to: '16:00', assigned_user_ids: [selfP.id], recurrence: { freq: 'weekly', end_type: 'count', end_count: 2 } });
    ok('A2: fremde Planung nicht löschbar (403)', a2.status === 403, 'status=' + a2.status);
    ok('A2: fremde Planung existiert noch', ((await req('GET', '/api/planning?date_from=2027-12-01&date_to=2027-12-01', admin)).body.entries || []).some(e => e.id === fremd.id));

    const proj = (await req('POST', '/api/projects', admin, { name: 'Abnahme-Projekt' })).body.project;
    const pe = (await req('POST', '/api/entries', admin, { user_id: ma.id, date: today, time_from: '08:00', time_to: '12:00', project_id: proj.id })).body.entry;
    await req('DELETE', `/api/entries/${pe.id}`, admin, { reason: 'Abnahme' });
    ok('A4: gelöschte Stunden zählen nicht mehr', (await req('GET', `/api/projects/${proj.id}/stats`, admin)).body.total_hours === 0);

    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(900);
    await p.click('#add-user-btn'); await sleep(500);
    const a6 = await p.evaluate(() => {
      const el = document.getElementById('um-start-overtime');
      el.value = '7,5'; const komma = numFromField(el, 0);
      el.value = 'abc'; const quatsch = numFromField(el, 0);
      return { text: el.type === 'text', komma, quatsch };
    });
    ok('A6: Stundenfeld komma-fähig', a6.text && a6.komma === 7.5, JSON.stringify(a6));
    ok('A6: unlesbare Eingabe → Meldung statt 0', a6.quatsch === null);
    await p.evaluate(() => document.getElementById('um-cancel')?.click()); await sleep(200);
    ok('B13: Erprobungs-Banner ist weg', await p.evaluate(async () => { location.hash = '#/notifications'; await new Promise(r => setTimeout(r, 900)); return !document.querySelector('.erprobung-banner'); }));

    await p.setViewport({ width: 380, height: 800 });
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1300);
    const b1 = await p.evaluate(() => { const r = document.querySelector('.form-row'); const k = [...r.children].filter(c => c.offsetParent); return { d: getComputedStyle(r).display, k: k.length, z: new Set(k.map(c => Math.round(c.getBoundingClientRect().top))).size }; });
    ok('B1: Mobil-Layout stapelt', b1.d === 'grid' && b1.z === b1.k, JSON.stringify(b1));
    await p.setViewport({ width: 1200, height: 950 });

    // ══ RUNDE 2 ══
    console.log('Runde 2 — Dialoge, Live-Updates, Mehrtages-Dedup:');
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(1200);
    await p.evaluate(() => { showAbsenceForm(null, 'krank', null, null, null); showAbsenceForm(null, 'urlaub', null, null, null); }); await sleep(400);
    ok('A5: nur EIN Abwesenheits-Dialog', (await p.evaluate(() => document.querySelectorAll('.absence-form-overlay').length)) === 1);
    await p.evaluate(() => document.getElementById('abs-cancel')?.click()); await sleep(200);

    const g1 = await req('POST', '/api/planning', admin, { client: 'Dedup', assigned_user_ids: [ma.id], days: [{ date: '2027-12-06', time_from: '07:00', time_to: '16:00' }, { date: '2027-12-07', time_from: '07:00', time_to: '16:00' }] });
    const g2 = await req('POST', '/api/planning', admin, { client: 'Dedup', assigned_user_ids: [ma.id], days: [{ date: '2027-12-06', time_from: '07:00', time_to: '16:00' }, { date: '2027-12-08', time_from: '07:00', time_to: '16:00' }] });
    ok('A7a: abweichender Tag = eigene Planung', g2.status === 201 && !g2.body.deduped);
    ok('A7a: der abweichende Tag existiert', ((await req('GET', '/api/planning?date_from=2027-12-08&date_to=2027-12-08', admin)).body.entries || []).length === 1);
    const g3 = await req('POST', '/api/planning', admin, { client: 'Dedup', assigned_user_ids: [ma.id], days: [{ date: '2027-12-06', time_from: '07:00', time_to: '16:00' }, { date: '2027-12-07', time_from: '07:00', time_to: '16:00' }] });
    ok('A7a: echte Dublette weiterhin erkannt', g3.body && g3.body.deduped === true);

    const b5 = await p.evaluate(async () => {
      const pr = confirmModal('Löschen?', { title: 'Löschen', danger: true });
      await new Promise(r => setTimeout(r, 150));
      const focusCancel = document.activeElement?.dataset?.act === 'cancel';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      const offen = !!document.querySelector('.dialog-modal');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await pr; return { focusCancel, offen };
    });
    ok('B5: Fokus auf „Abbrechen"', b5.focusCancel);
    ok('B5: Enter bestätigt Löschen nicht', b5.offen);
    ok('A7b: _editorBusy erkennt offenes Formular', await p.evaluate(() => { const d = document.createElement('div'); d.id = 'order-form-area'; d.innerHTML = '<input>'; document.querySelector('.main').appendChild(d); const r = _editorBusy('#order-form-area'); d.remove(); return r === true; }));

    // ══ RUNDE 3 ══
    console.log('Runde 3 — Startzeit, private Notiz, Aushang:');
    const ctxM = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
    const pm = await ctxM.newPage(); await pm.setViewport({ width: 1200, height: 950 });
    await pm.goto(BASE, { waitUntil: 'networkidle2' });
    await pm.waitForSelector('#login-user'); await pm.type('#login-user', 'abnahme'); await pm.type('#login-pass', 'Test1234!');
    await pm.click('#login-form button[type="submit"]'); await pm.waitForSelector('a[href="#/planning"]'); await sleep(400);
    await pm.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1400);
    ok('Startzeit: erster Eintrag → 07:00', (await pm.evaluate(() => document.getElementById('ef-from').value)) === '07:00');
    await req('POST', '/api/entries', maTok, { date: today, time_from: '07:00', time_to: '10:00', project_text: 'Erster' });
    await pm.evaluate(() => { location.hash = '#/'; }); await sleep(700);
    await pm.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1400);
    ok('Startzeit: schließt an Vorgänger an (10:00)', (await pm.evaluate(() => document.getElementById('ef-from').value)) === '10:00');
    const plan = await req('POST', '/api/planning', admin, { date: today, time_from: '13:00', time_to: '15:00', assigned_user_ids: [ma.id], client: 'Geplant' });
    await pm.evaluate((id) => { location.hash = '#/planning/accept/' + id; }, plan.body.entry.id); await sleep(1600);
    ok('Startzeit: Realität (10:00) schlägt Planung (13:00)', (await pm.evaluate(() => document.getElementById('ef-from').value)) === '10:00');

    const chefTok = (await login('chef', cpw)).body.token;
    const ce = (await req('POST', '/api/entries', chefTok, { date: today, time_from: '16:00', time_to: '17:00', project_text: 'Chef', personal_note: 'PRIVAT' })).body.entry;
    const ctxC = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
    const pc = await ctxC.newPage(); await pc.setViewport({ width: 1200, height: 950 });
    await pc.goto(BASE, { waitUntil: 'networkidle2' });
    await pc.waitForSelector('#login-user'); await pc.type('#login-user', 'chef'); await pc.type('#login-pass', cpw);
    await pc.click('#login-form button[type="submit"]'); await pc.waitForSelector('a[href="#/planning"]'); await sleep(400);
    await pc.evaluate((id) => { location.hash = '#/entry/' + id; }, ce.id); await sleep(1500);
    await pc.evaluate(() => { document.getElementById('ef-desc').value = 'geändert'; });
    await pc.evaluate(() => document.getElementById('entry-form').requestSubmit()); await sleep(600);
    await pc.evaluate(() => { const b = [...document.querySelectorAll('.dialog-modal button')].find(x => /^OK$/i.test(x.textContent.trim())); if (b) b.click(); }); await sleep(1300);
    const ceAfter = (await req('GET', '/api/entries/' + ce.id, chefTok)).body.entry;
    ok('A16: Änderung gespeichert', ceAfter.description === 'geändert');
    ok('A16: private Notiz erhalten', ceAfter.personal_note === 'PRIVAT');

    const bul = (await req('POST', '/api/bulletin', admin, { title: 'Abnahme-Aushang', text: 'x' })).body.entry;
    const bulBefore = ((await req('GET', '/api/bulletin', admin)).body.entries || []).length;
    await req('DELETE', '/api/bulletin/' + bul.id, admin);
    await p.evaluate((id) => { location.hash = '#/bulletin/edit/' + id; }, bul.id); await sleep(1400);
    const a17 = await p.evaluate(() => ({ hash: location.hash, toast: document.querySelector('.toast')?.textContent || '' }));
    ok('A17: Hinweis statt stiller Neuanlage', /existiert nicht mehr/i.test(a17.toast));
    ok('A17: kein neuer Aushang', ((await req('GET', '/api/bulletin', admin)).body.entries || []).length === bulBefore - 1);

    // ══ RUNDE 4 (Robustheit) ══
    console.log('Runde 4 — Robustheit:');
    ok('R4: Abwesenheit für ungültigen MA → 400', (await req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: 999999 })).status === 400);
    const r2 = await p.evaluate(() => { const alt = renderToken(); renderToken(); return renderStale(alt); });
    ok('R2: veraltete Render-Marke erkannt', r2 === true);
    const r3 = await p.evaluate(() => { const b = document.createElement('div'); b.id = 'rb'; document.body.appendChild(b); let c = 0; renderLoadError('#rb', 'Fehler', () => c++); const hat = !!b.querySelector('button'); b.querySelector('button').click(); const res = hat && c === 1; b.remove(); return res; });
    ok('R3: Ladefehler mit „Erneut versuchen"', r3);
    const r5 = await p.evaluate(() => { localStorage.setItem('user', '{kaputt'); const v = _readStoredUser(); const clean = localStorage.getItem('user') === null; localStorage.removeItem('user'); return v === null && clean; });
    ok('R5: kaputter Speicher wird abgefangen', r5);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nABNAHME (alle undeployten Änderungen): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
