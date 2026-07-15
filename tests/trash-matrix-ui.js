// KOMPLEXER Papierkorb-/Lösch-Matrix-Test (Puppeteer) — Abwesenheits- UND Eintrags-Logik über alle Rollen.
// Deckt viele Variationen ab: genehmigen → löschen → neu beantragen → wiederherstellen, Eigentums- vs.
// deleted_by-Sicht, Rollen-Sichtbarkeit der Tabs/Buttons, Ausstellen/Wiedereinstellen.
// Start: node tests/trash-matrix-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3097;
const DB = '/tmp/trash-matrix-ui.db';
const BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('    ✓ ' + n)) : (fail++, console.log('    ✗ ' + n + (e ? '  → ' + e : '')));
const head = (t) => console.log('\n' + t);
function req(method, p, token, body) {
  return new Promise((res, rej) => { const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } }, x => { let s=''; x.on('data',d=>s+=d); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
const tokenOf = async (u, pw='Test1234!') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;

// ---- UI-Helfer ----
async function loginUI(p, user, pass) {
  await p.evaluate(() => { try { localStorage.clear(); } catch(_){} });
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user');
  await p.evaluate(() => { document.getElementById('login-user').value=''; document.getElementById('login-pass').value=''; });
  await p.type('#login-user', user); await p.type('#login-pass', pass);
  await p.click('#login-form button[type="submit"]');
  await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
}
const goHash = async (p, h) => { await p.evaluate((x) => { location.hash = x; }, h); await sleep(900); };
const clickDialogOk = async (p) => { await sleep(250); await p.evaluate(() => { const b = document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); }); await sleep(400); };
const navInfo = (p) => p.evaluate(() => ({
  group: !!document.getElementById('nav-papierkorb'),
  entries: !!document.querySelector('a[href="#/deleted-entries"]'),
  absences: !!document.querySelector('a[href="#/deleted-absences"]'),
  users: !!document.querySelector('a[href="#/deleted-users"]'),
}));

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/trash-matrix-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/trash-matrix-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tokenOf('admin', apw);
    const mk = (u, role) => req('POST','/api/users', admin, { username:u, password:'Test1234!', name:u.toUpperCase(), role, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const chef = (await mk('xchef','chef')).body.user;
    const buch = (await mk('xbuch','buchhalter')).body.user;
    const ma1  = (await mk('xma1','mitarbeiter')).body.user;
    const ma2  = (await mk('xma2','mitarbeiter')).body.user;
    const cTok = await tokenOf('xchef'), bTok = await tokenOf('xbuch'), t1 = await tokenOf('xma1'), t2 = await tokenOf('xma2');
    head('SETUP: admin + chef + buchhalter + ma1 + ma2');
    ok('Nutzer angelegt', !!(chef&&buch&&ma1&&ma2));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:900 });

    // ============================================================
    head('SZENARIO 1 — Abwesenheit: ma1 beantragt Urlaub → Chef genehmigt → Chef löscht → ma1 „Neu beantragen"');
    // ============================================================
    const absX = (await req('POST','/api/absences', t1, { type:'urlaub', date_from:'2026-10-05', date_to:'2026-10-07', comment:'Kurzurlaub' })).body.absence;
    await req('POST','/api/absences/'+absX.id+'/approve', cTok);   // Chef genehmigt
    let chk = (await req('GET','/api/absences?from=2026-10-05&to=2026-10-07', t1)).body.absences.find(a=>a.id===absX.id);
    ok('1a) Urlaub ist genehmigt (approved)', chk && chk.status === 'approved', chk && chk.status);
    await req('DELETE','/api/absences/'+absX.id, cTok, { reason:'Engpass auf Baustelle' });  // Chef löscht genehmigte
    ok('1b) Chef hat genehmigten Urlaub gelöscht', (await req('GET','/api/absences?from=2026-10-05&to=2026-10-07', t1)).body.absences.every(a=>a.id!==absX.id));

    await loginUI(p, 'xma1', 'Test1234!');
    await goHash(p, '#/deleted-absences');
    let v = await p.evaluate((id) => ({
      sees: !!document.querySelector('.reapply-absence[data-id="'+id+'"]'),
      restore: document.querySelectorAll('.restore-absence').length,
      delBy: [...document.querySelectorAll('td')].some(td => /CHEF/i.test(td.textContent)),
    }), absX.id);
    ok('1c) ma1 sieht die vom Chef gelöschte EIGENE Abwesenheit', v.sees, JSON.stringify(v));
    ok('1d) ma1 hat KEINEN „Wiederherstellen"-Button (nur „Neu beantragen")', v.restore === 0, JSON.stringify(v));
    ok('1e) Spalte „gelöscht von" zeigt den Chef', v.delBy, JSON.stringify(v));

    // ma1 klickt „Neu beantragen" → Formular vorbefüllt → einreichen
    await p.evaluate((id) => document.querySelector('.reapply-absence[data-id="'+id+'"]').click(), absX.id);
    await p.waitForSelector('#absence-form-overlay'); await sleep(400);
    const f = await p.evaluate(() => ({ type:(document.getElementById('abs-type')||{}).value, from:(document.getElementById('abs-from')||{}).value, to:(document.getElementById('abs-to')||{}).value }));
    ok('1f) „Neu beantragen"-Formular vorbefüllt (Urlaub, 05.–07.10.)', f.type==='urlaub' && f.from==='2026-10-05' && f.to==='2026-10-07', JSON.stringify(f));
    await p.click('#abs-save'); await sleep(1200);
    const reReq = (await req('GET','/api/absences?from=2026-10-05&to=2026-10-07', t1)).body.absences.filter(a=>a.user_id===ma1.id && a.deleted_at==null);
    ok('1g) Neuer Antrag existiert und ist PENDING (läuft wieder durch Genehmigung)', reReq.length===1 && reReq[0].status==='pending', JSON.stringify(reReq.map(a=>a.status)));

    // ============================================================
    head('SZENARIO 2 — Abwesenheit: nur ADMIN kann echt „Wiederherstellen"');
    // ============================================================
    const absY = (await req('POST','/api/absences', t1, { type:'krank', date_from:'2026-10-12', date_to:'2026-10-12' })).body.absence;
    await req('DELETE','/api/absences/'+absY.id, cTok, { reason:'Korrektur' });
    // API-Berechtigung
    ok('2a) Chef Abwesenheit-Restore → 403', (await req('POST','/api/absences/'+absY.id+'/restore', cTok, {})).status === 403);
    ok('2b) ma1 Abwesenheit-Restore → 403', (await req('POST','/api/absences/'+absY.id+'/restore', t1, {})).status === 403);
    ok('2c) Buchhalter Abwesenheit-Restore → 403', (await req('POST','/api/absences/'+absY.id+'/restore', bTok, {})).status === 403);
    // UI als Admin: „Wiederherstellen" sichtbar + funktioniert
    await loginUI(p, 'admin', apw);
    await goHash(p, '#/deleted-absences');
    const av = await p.evaluate((id) => ({ restore: !!document.querySelector('.restore-absence[data-id="'+id+'"]'), reapply: document.querySelectorAll('.reapply-absence').length }), absY.id);
    ok('2d) Admin sieht „Wiederherstellen" (kein „Neu beantragen")', av.restore && av.reapply===0, JSON.stringify(av));
    await p.evaluate((id) => document.querySelector('.restore-absence[data-id="'+id+'"]').click(), absY.id);
    await clickDialogOk(p);  // confirmModal
    await clickDialogOk(p);  // promptModal (Begründung optional)
    await sleep(800);
    const yBack = (await req('GET','/api/absences?from=2026-10-12&to=2026-10-12', admin)).body.absences.find(a=>a.id===absY.id);
    ok('2e) Admin hat Abwesenheit wiederhergestellt (wieder aktiv)', !!yBack && yBack.deleted_at==null, JSON.stringify(yBack && {d:yBack.deleted_at}));

    // ============================================================
    head('SZENARIO 3 — Eintrag: ma1 löscht eigenen Zeiteintrag → sieht ihn → „Wiederherstellen"');
    // ============================================================
    const e1 = (await req('POST','/api/entries', t1, { date:'2026-10-06', time_from:'07:00', time_to:'15:00', break_minutes:30 })).body.entry;
    await req('DELETE','/api/entries/'+e1.id, t1);
    await loginUI(p, 'xma1', 'Test1234!');
    await goHash(p, '#/deleted-entries');
    let ev = await p.evaluate((id) => ({ sees: !!document.querySelector('.restore-entry[data-id="'+id+'"]') }), e1.id);
    ok('3a) ma1 sieht eigenen gelöschten Eintrag mit „Wiederherstellen"', ev.sees, JSON.stringify(ev));
    await p.evaluate((id) => document.querySelector('.restore-entry[data-id="'+id+'"]').click(), e1.id);
    await clickDialogOk(p);  // confirm
    await clickDialogOk(p);  // reason prompt
    await sleep(700);
    const e1back = (await req('GET','/api/entries?from=2026-10-06&to=2026-10-06', t1)).body.entries.find(x=>x.id===e1.id);
    ok('3b) Eintrag ist wiederhergestellt (wieder aktiv)', !!e1back, JSON.stringify(!!e1back));

    // ============================================================
    head('SZENARIO 4 — Eintrag-Eigentum: ma1 sieht NICHT die Löschungen anderer; deleted_by-Trennung');
    // ============================================================
    const e2 = (await req('POST','/api/entries', t2, { date:'2026-10-06', time_from:'08:00', time_to:'16:00', break_minutes:30 })).body.entry; // ma2
    await req('DELETE','/api/entries/'+e2.id, t2);
    const e3 = (await req('POST','/api/entries', t1, { date:'2026-10-13', time_from:'07:00', time_to:'15:00', break_minutes:30 })).body.entry; // ma1
    await req('DELETE','/api/entries/'+e3.id, admin, { reason:'vom Admin entfernt' }); // admin löscht ma1s Eintrag
    await loginUI(p, 'xma1', 'Test1234!');
    await goHash(p, '#/deleted-entries');
    const e4 = await p.evaluate((idA, idB) => ({
      seesMa2: !!document.querySelector('.restore-entry[data-id="'+idA+'"]'),
      seesAdminDeleted: !!document.querySelector('.restore-entry[data-id="'+idB+'"]'),
    }), e2.id, e3.id);
    ok('4a) ma1 sieht NICHT ma2s gelöschten Eintrag', e4.seesMa2 === false, JSON.stringify(e4));
    ok('4b) ma1 sieht NICHT seinen vom Admin gelöschten Eintrag (Einträge = deleted_by)', e4.seesAdminDeleted === false, JSON.stringify(e4));
    ok('4c) Kontrast: ma1 KANN fremd-gelöschten Eintrag nicht restaurieren (API 403)', (await req('POST','/api/entries/'+e3.id+'/restore', t1, {})).status === 403);
    // Admin sieht alles
    await loginUI(p, 'admin', apw);
    await goHash(p, '#/deleted-entries');
    const adminSees = await p.evaluate((a,b) => ({ a: !!document.querySelector('.restore-entry[data-id="'+a+'"]'), b: !!document.querySelector('.restore-entry[data-id="'+b+'"]') }), e2.id, e3.id);
    ok('4d) Admin sieht ma2s UND den admin-gelöschten ma1-Eintrag', adminSees.a && adminSees.b, JSON.stringify(adminSees));

    // ============================================================
    head('SZENARIO 5 — Rollen-Sichtbarkeit der Papierkorb-Tabs + Abwesenheits-Button');
    // ============================================================
    await loginUI(p, 'xma1', 'Test1234!');  let n = await navInfo(p);
    ok('5a) ma1: Papierkorb mit Einträge+Abwesenheiten, OHNE Mitarbeiter-Tab', n.group&&n.entries&&n.absences&&!n.users, JSON.stringify(n));
    await loginUI(p, 'xbuch', 'Test1234!'); n = await navInfo(p);
    ok('5b) Buchhalter: wie MA (kein Mitarbeiter-Tab)', n.group&&n.entries&&n.absences&&!n.users, JSON.stringify(n));
    await loginUI(p, 'xchef', 'Test1234!'); n = await navInfo(p);
    ok('5c) Chef: alle drei Tabs (inkl. Mitarbeiter)', n.group&&n.entries&&n.absences&&n.users, JSON.stringify(n));
    await goHash(p, '#/deleted-absences');
    const chefBtn = await p.evaluate(() => ({ reapply: document.querySelectorAll('.reapply-absence').length, restore: document.querySelectorAll('.restore-absence').length }));
    ok('5d) Chef: Abwesenheits-Button = „Neu beantragen" (kein Restore)', chefBtn.reapply>0 && chefBtn.restore===0, JSON.stringify(chefBtn));
    await loginUI(p, 'admin', apw); n = await navInfo(p);
    ok('5e) Admin: alle drei Tabs', n.group&&n.entries&&n.absences&&n.users, JSON.stringify(n));

    // ============================================================
    head('SZENARIO 6 — Buchhalter: sieht nur EIGENE Löschungen, keinen fremden Eintrag');
    // ============================================================
    const eB = (await req('POST','/api/entries', bTok, { date:'2026-10-14', time_from:'09:00', time_to:'12:00', break_minutes:0 })).body.entry; // buch eigener
    await req('DELETE','/api/entries/'+eB.id, bTok);
    await loginUI(p, 'xbuch', 'Test1234!');
    await goHash(p, '#/deleted-entries');
    const bv = await p.evaluate((own, foreign) => ({ own: !!document.querySelector('.restore-entry[data-id="'+own+'"]'), foreign: !!document.querySelector('.restore-entry[data-id="'+foreign+'"]') }), eB.id, e2.id);
    ok('6a) Buchhalter sieht eigenen gelöschten Eintrag', bv.own, JSON.stringify(bv));
    ok('6b) Buchhalter sieht NICHT ma2s gelöschten Eintrag', bv.foreign === false, JSON.stringify(bv));
    ok('6c) Buchhalter → /api/users/inactive verboten (403)', (await req('GET','/api/users/inactive', bTok)).status === 403);

    // ============================================================
    head('SZENARIO 7 — Ausstellen/Wiedereinstellen: Chef stellt ma2 aus → Papierkorb→Mitarbeiter → wiedereinstellen');
    // ============================================================
    await req('POST','/api/users/'+ma2.id+'/deactivate', cTok, {});
    ok('7a) Chef hat ma2 ausgestellt (active=0)', (await req('GET','/api/users/inactive', cTok)).body.users.some(u=>u.id===ma2.id));
    ok('7b) Ausgestellter ma2 kann sich nicht mehr einloggen', (await req('POST','/api/auth/login', null, { username:'xma2', password:'Test1234!' })).status >= 400);
    await loginUI(p, 'xchef', 'Test1234!');
    await goHash(p, '#/deleted-users');
    const seesU = await p.evaluate((id) => !!document.querySelector('.reactivate-user[data-id="'+id+'"]'), ma2.id);
    ok('7c) Chef sieht ma2 im Papierkorb→Mitarbeiter mit „Wiedereinstellen"', seesU, ''+seesU);
    await p.evaluate((id) => document.querySelector('.reactivate-user[data-id="'+id+'"]').click(), ma2.id);
    await sleep(500);
    await p.evaluate(() => { const i = document.getElementById('pm-input'); if (i) { i.value = '2026-11-02'; i.dispatchEvent(new Event('input', { bubbles:true })); } });
    await p.evaluate(() => { const b = document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); });
    await sleep(1200);
    ok('7d) ma2 ist wieder aktiv (Login wieder möglich)', (await req('POST','/api/auth/login', null, { username:'xma2', password:'Test1234!' })).status === 200);
    ok('7e) ma1 (MA) → /api/users/inactive verboten (403)', (await req('GET','/api/users/inactive', t1)).status === 403);

    // ============================================================
    head('SZENARIO 8 — Buchhalter ist read-only bei Abwesenheiten (sieht alles, ändert nichts Fremdes)');
    // ============================================================
    const absB = (await req('POST','/api/absences', t1, { type:'urlaub', date_from:'2026-11-09', date_to:'2026-11-10' })).body.absence; // ma1 pending
    ok('8a) Buchhalter sieht fremde Abwesenheiten (Lese-Sicht erhalten)', (await req('GET','/api/absences?from=2026-11-09&to=2026-11-10&user_id='+ma1.id, bTok)).status === 200);
    ok('8b) Buchhalter genehmigen (fremd) → 403', (await req('POST','/api/absences/'+absB.id+'/approve', bTok)).status === 403);
    ok('8c) Buchhalter ablehnen (fremd) → 403', (await req('POST','/api/absences/'+absB.id+'/reject', bTok, { reason:'x' })).status === 403);
    ok('8d) Buchhalter löschen (fremd) → 403', (await req('DELETE','/api/absences/'+absB.id, bTok, { reason:'x' })).status === 403);
    ok('8e) Buchhalter Fremdeintrag (für ma1) → 403', (await req('POST','/api/absences', bTok, { type:'urlaub', date_from:'2026-11-20', date_to:'2026-11-20', target_user_id:ma1.id })).status === 403);
    ok('8f) Buchhalter Feiertag eintragen → 403', (await req('POST','/api/absences', bTok, { type:'feiertag', date_from:'2026-11-25', date_to:'2026-11-25' })).status === 403);
    const ownB = await req('POST','/api/absences', bTok, { type:'krank', date_from:'2026-11-09', date_to:'2026-11-09' });
    ok('8g) Buchhalter darf EIGENE Abwesenheit eintragen', ownB.status < 300 && !!(ownB.body && ownB.body.absence));
    // Chef darf weiterhin alles
    ok('8h) Chef genehmigen (fremd) → ok', (await req('POST','/api/absences/'+absB.id+'/approve', cTok)).status === 200);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\n==================== Papierkorb-Matrix: ${pass} ok, ${fail} fehlgeschlagen ====================`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
