// API-Test: Urlaubskonto-Endpunkte. Entitlement-CRUD (+Rechte), summary.vacation, vacation-overview
// (Manager-only, Spalten, beantragt nicht abgezogen), Antrags-Warnung.
//   node tests/vacation-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const PORT = 3183, DB = '/tmp/vacation-api.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;

// UHR FESTGEHALTEN. Der Urlaubsanspruch ist JAHRESBEZOGEN, und „genommen" gegen „geplant"
// entscheidet sich am heutigen Datum. Feste Zeitraeume im Test wandern deshalb mit der Zeit von
// „Zukunft" nach „Vergangenheit" — am 07.08.2026 ist genau das passiert: „2026-08-03 bis
// 2026-08-07" war beim Schreiben Zukunft und zaehlte ploetzlich als genommen.
//
// Die Zeitraeume relativ zu heute zu waehlen hilft nicht: Sie muessen ALLE IM SELBEN JAHR liegen
// wie der Anspruch, und in einem Januar oder Dezember gibt es nicht auf beiden Seiten Platz.
// Deshalb laeuft der Server hier mit einer festgehaltenen Uhr (Mitte des Testjahres); die
// Zeitraeume bleiben fest und der Test veraltet nie.
const TESTJAHR = 2026;
const UHR_PRELOAD = path.join(os.tmpdir(), 'vacation-uhr-' + process.pid + '.js');
fs.writeFileSync(UHR_PRELOAD, `const E = Date; const ziel = new E('${TESTJAHR}-07-15T12:00:00').getTime();
const v = ziel - E.now();
function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC;
globalThis.Date = G;`);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/vacation-api-srv.log', 'w');
  const srv = spawn('node', ['-r', UHR_PRELOAD, 'server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/vacation-api-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = await tok('admin', apw);
    const ma = (await req('POST', '/api/users', admin, { username: 'urlauber', password: 'Passw0rd!', name: 'Uwe Urlauber', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    const maT = await tok('urlauber', 'Passw0rd!');

    // ── Frisch (nichts konfiguriert) → alte Ansicht ──
    console.log('\nGate „nichts konfiguriert":');
    let r0 = await req('GET', `/api/absences/summary?user_id=${ma.id}&from=2026-01-01&to=2026-12-31`, admin);
    ok('frisch: vacation.configured=false + anyVacationConfigured=false', r0.body.vacation.configured === false && r0.body.anyVacationConfigured === false, JSON.stringify({ c: r0.body.vacation.configured, any: r0.body.anyVacationConfigured }));

    // ── Entitlement-CRUD + Rechte ──
    console.log('\nEntitlement-CRUD:');
    let r = await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: '2026-01-01', days: 30, carryover_mode: 'yearend' });
    ok('POST legt Zeile an', r.status === 200 && r.body.entitlements.length === 1, 'status=' + r.status);
    const eid = r.body.entitlements[0].id;
    r = await req('GET', `/api/statistics/vacation/${ma.id}`, admin);
    ok('GET liefert die Zeile', r.body.entitlements[0].days === 30);
    r = await req('PUT', `/api/statistics/vacation/${ma.id}/${eid}`, admin, { valid_from: '2026-01-01', days: 25, carryover_mode: 'date', carryover_until: '03-31' });
    ok('PUT ändert Tage + Verfall (date)', r.body.entitlements[0].days === 25 && r.body.entitlements[0].carryover_mode === 'date' && r.body.entitlements[0].carryover_until === '03-31');
    r = await req('PUT', `/api/statistics/vacation/${ma.id}/${eid}`, admin, { valid_from: '2026-01-01', days: 25, carryover_mode: 'date' });
    ok('PUT date ohne Datum → 400', r.status === 400, 'status=' + r.status);

    // ── B4: valid_from-Format + S2: unmögliche Verfall-Tage ──
    ok('B4: valid_from Unsinn ("heute") → 400', (await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: 'heute', days: 10, carryover_mode: 'yearend' })).status === 400);
    ok('B4: valid_from unmöglicher Tag (2026-13-40) → 400', (await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: '2026-13-40', days: 10, carryover_mode: 'yearend' })).status === 400);
    ok('B4: valid_from dt. Format (15.07.2026) → 400', (await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: '15.07.2026', days: 10, carryover_mode: 'yearend' })).status === 400);
    ok('B4: valid_from fehlt → 400', (await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { days: 10, carryover_mode: 'yearend' })).status === 400);
    ok('S2: carryover_until unmöglicher Tag (02-30) → 400', (await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: '2027-01-01', days: 10, carryover_mode: 'date', carryover_until: '02-30' })).status === 400);
    ok('S2: carryover_until 02-29 (Schaltjahr) erlaubt → 200', (await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: '2028-01-01', days: 10, carryover_mode: 'date', carryover_until: '02-29' })).status === 200);
    // Aufräumen: die beiden zusätzlich angelegten Zeilen (2027/2028) wieder entfernen, damit die weiteren Asserts stimmen
    { const list = (await req('GET', `/api/statistics/vacation/${ma.id}`, admin)).body.entitlements; for (const e of list) if (e.valid_from === '2028-01-01') await req('DELETE', `/api/statistics/vacation/${ma.id}/${e.id}`, admin); }

    // zurück auf yearend/25
    await req('PUT', `/api/statistics/vacation/${ma.id}/${eid}`, admin, { valid_from: '2026-01-01', days: 25, carryover_mode: 'yearend' });

    // Rechte: MA darf nicht schreiben
    r = await req('POST', `/api/statistics/vacation/${ma.id}`, maT, { valid_from: '2026-01-01', days: 5 });
    ok('MA POST → 403', r.status === 403, 'status=' + r.status);
    r = await req('GET', `/api/statistics/vacation/${ma.id}`, maT);
    ok('MA GET eigene → ok', r.status === 200);

    // ── Urlaub anlegen (Fremdeintrag) + genehmigen ──
    const mkUrlaub = async (from, to) => {
      const c = await req('POST', '/api/absences', admin, { type: 'urlaub', date_from: from, date_to: to, target_user_id: ma.id });
      return c.body.absence.id;
    };
    const approve = (id) => req('POST', `/api/absences/${id}/approve`, admin);
    const past = await mkUrlaub('2026-06-01', '2026-06-05');   // 5 Wochentage, Vergangenheit
    const future = await mkUrlaub('2026-08-03', '2026-08-07'); // 5 Wochentage, Zukunft
    await approve(past); await approve(future);

    console.log('\nsummary.vacation:');
    r = await req('GET', `/api/absences/summary?user_id=${ma.id}&from=2026-01-01&to=2026-12-31`, admin);
    const v = r.body.vacation;
    ok('nach Anspruch: configured=true + anyVacationConfigured=true', v.configured === true && r.body.anyVacationConfigured === true);
    ok('anspruch 25', v.anspruch === 25, JSON.stringify(v));
    ok('genommen 5 (Vergangenheit)', v.genommen === 5);
    ok('geplant 5 (Zukunft)', v.geplant === 5);
    ok('nochZuPlanen 15', v.nochZuPlanen === 15);

    // ── vacation-overview ──
    console.log('\nvacation-overview:');
    r = await req('GET', '/api/absences/vacation-overview?year=2026', admin);
    ok('Manager: 200 + Zeile für MA', r.status === 200 && r.body.rows.some(x => x.user_id === ma.id));
    const row = r.body.rows.find(x => x.user_id === ma.id);
    ok('Spalten stimmen (Anspruch/genommen/geplant/nochZuPlanen)', row.anspruch === 25 && row.genommen === 5 && row.geplant === 5 && row.nochZuPlanen === 15, JSON.stringify(row));
    ok('gesamtanspruch = 25', row.gesamtanspruch === 25);
    ok('konfigurierter MA → configured=true', row.configured === true);
    ok('unkonfigurierter MA (Max) → configured=false', (r.body.rows.find(x => x.name === 'Max Mustermann') || {}).configured === false);
    r = await req('GET', '/api/absences/vacation-overview?year=2026', maT);
    ok('MA → 403', r.status === 403, 'status=' + r.status);

    // PDF-Export (echtes Server-PDF)
    const pdf = await new Promise((resPromise) => {
      const rq = http.request({ host: 'localhost', port: PORT, path: '/api/absences/vacation-overview.pdf?year=2026', method: 'GET', headers: { Authorization: 'Bearer ' + admin } }, x => {
        const chunks = []; x.on('data', c => chunks.push(c)); x.on('end', () => resPromise({ status: x.statusCode, type: x.headers['content-type'], buf: Buffer.concat(chunks) }));
      }); rq.end();
    });
    ok('PDF: 200 + application/pdf + %PDF-Header', pdf.status === 200 && /application\/pdf/.test(pdf.type || '') && pdf.buf.slice(0, 4).toString() === '%PDF', `status=${pdf.status} type=${pdf.type} head=${pdf.buf.slice(0, 4).toString()}`);
    const pdfMa = await new Promise((resPromise) => {
      const rq = http.request({ host: 'localhost', port: PORT, path: '/api/absences/vacation-overview.pdf?year=2026', method: 'GET', headers: { Authorization: 'Bearer ' + maT } }, x => { x.on('data', () => {}); x.on('end', () => resPromise(x.statusCode)); }); rq.end();
    });
    ok('PDF: MA → 403', pdfMa === 403, 'status=' + pdfMa);

    // ── Beantragt (pending) wird ausgewiesen, NICHT abgezogen + Warnung ──
    console.log('\nbeantragt + Warnung:');
    const pend = await req('POST', '/api/absences', admin, { type: 'urlaub', date_from: '2026-09-01', date_to: '2026-09-30', target_user_id: ma.id });
    ok('großer pending-Antrag → Warnung im Response', !!pend.body.warning, 'warning=' + pend.body.warning);
    r = await req('GET', '/api/absences/vacation-overview?year=2026', admin);
    const row2 = r.body.rows.find(x => x.user_id === ma.id);
    ok('beantragt > 0 ausgewiesen', row2.beantragt > 0, 'beantragt=' + row2.beantragt);
    ok('nochZuPlanen UNVERÄNDERT (pending nicht abgezogen)', row2.nochZuPlanen === 15, 'nochZuPlanen=' + row2.nochZuPlanen);

    // ── Start-Resturlaub (Übertrag) ──
    console.log('\nStart-Resturlaub:');
    r = await req('PUT', `/api/statistics/vacation/${ma.id}/start-carry`, admin, { days: 6 });
    ok('start-carry gesetzt (200)', r.status === 200 && r.body.start_carry === 6, JSON.stringify(r.body));
    r = await req('GET', `/api/statistics/vacation/${ma.id}`, admin);
    ok('GET liefert start_carry', r.body.start_carry === 6);
    r = await req('GET', `/api/absences/summary?user_id=${ma.id}&from=2026-01-01&to=2026-12-31`, admin);
    ok('summary: Übertrag = 6, verfuegbar = 31', r.body.vacation.uebertrag === 6 && r.body.vacation.verfuegbar === 31, JSON.stringify(r.body.vacation));
    r = await req('PUT', `/api/statistics/vacation/${ma.id}/start-carry`, maT, { days: 9 });
    ok('MA start-carry → 403', r.status === 403, 'status=' + r.status);

    // ── Audit-Log: Anlegen/Ändern/Löschen + Start-Resturlaub protokolliert ──
    console.log('\nAudit-Log:');
    const ce = await req('POST', `/api/statistics/vacation/${ma.id}`, admin, { valid_from: '2027-01-01', days: 22, carryover_mode: 'never' });
    const newId = ce.body.entitlements.find(e => e.valid_from === '2027-01-01').id;
    await req('PUT', `/api/statistics/vacation/${ma.id}/${newId}`, admin, { valid_from: '2027-01-01', days: 26, carryover_mode: 'yearend' });
    await req('DELETE', `/api/statistics/vacation/${ma.id}/${newId}`, admin);
    const auditOf = async (action) => (await req('GET', `/api/audit?action=${action}&limit=50`, admin)).body.logs || [];
    ok('vacation_create protokolliert (mit MA-Name)', (await auditOf('vacation_create')).some(l => /Uwe Urlauber/.test(l.details)));
    ok('vacation_update protokolliert (mit „→")', (await auditOf('vacation_update')).some(l => /→/.test(l.details)));
    ok('vacation_delete protokolliert („gelöscht")', (await auditOf('vacation_delete')).some(l => /gelöscht/.test(l.details)));
    ok('vacation_startcarry_update protokolliert', (await auditOf('vacation_startcarry_update')).length > 0);
    ok('Audit-Log nur Admin (MA → 403)', (await req('GET', '/api/audit', maT)).status === 403);

    // ── B5: jahresübergreifender Antrag prüft AUCH das Folgejahr ──
    console.log('\nB5 — Antrag über den Jahreswechsel:');
    const b5 = (await req('POST', '/api/users', admin, { username: 'grenzgang', password: 'Test1234!', name: 'Grenz Gang', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    await req('POST', `/api/statistics/vacation/${b5.id}`, admin, { valid_from: '2026-01-01', days: 30, carryover_mode: 'yearend' });
    await req('POST', `/api/statistics/vacation/${b5.id}`, admin, { valid_from: '2027-01-01', days: 2, carryover_mode: 'yearend' }); // 2027 nur 2 Tage Anspruch
    // Antrag 28.12.2026–08.01.2027: Dezember-Teil (≤30) passt, Januar-Teil (>2) sprengt 2027
    const r5 = await req('POST', '/api/absences', admin, { type: 'urlaub', date_from: '2026-12-28', date_to: '2027-01-08', target_user_id: b5.id });
    ok('Warnung nennt das Folgejahr 2027 (nicht nur 2026)', /2027/.test(r5.body.warning || ''), 'warning=' + r5.body.warning);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nVacation-API: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
