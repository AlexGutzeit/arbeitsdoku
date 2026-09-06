// Was passiert, wenn der Mitarbeiter eine Auszahlung ABLEHNT (Alex, 06.09.2026)?
//
// Der Weg ist ausdrücklich vorgesehen: Der Verzicht auf Stunden ist die Entscheidung des
// Mitarbeiters. Eine Ablehnung darf deshalb NICHTS kosten — keine Stunde, keinen Hinweis weniger.
// Geprüft wird die ganze Kette:
//   * der Überstundenstand bleibt auf die Stelle genau gleich
//   * die Begründung wird festgehalten und ist für den Chef lesbar
//   * der Zähler beim Mitarbeiter verschwindet, die Karte zeigt den Vorgang im Verlauf
//   * eine abgelehnte Anfrage lässt sich nicht nachträglich doch noch bestätigen
//   * der Chef kann danach eine NEUE Anfrage stellen (die Ablehnung blockiert ihn nicht)
//   * in Lohn-CSV und PDF taucht keine Stunde auf
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//
//   node tests/auszahlung-ablehnung.js
const fs = require('fs'); const http = require('http'); const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/auszahlung-ablehnung.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const { auszahlungenSumme, offeneSumme } = require('../auszahlung');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const rund = n => Math.round((Number(n) || 0) * 100) / 100;

let PORT = 0;
function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const bufs = []; x.on('data', c => bufs.push(c)); x.on('end', () => {
        const buf = Buffer.concat(bufs);
        if (roh) return res({ status: x.statusCode, buf });
        let j = null; try { j = JSON.parse(buf.toString()); } catch (_) {}
        res({ status: x.statusCode, body: j, text: buf.toString() }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const iso = d => d.toISOString().slice(0, 10);
const heute = new Date(new Date().toLocaleDateString('sv-SE') + 'T12:00:00Z');
function werktage(v, b) { const o = []; const d = new Date(heute); d.setUTCDate(d.getUTCDate() - v);
  const e = new Date(heute); e.setUTCDate(e.getUTCDate() - b);
  while (d <= e) { const w = d.getUTCDay(); if (w >= 1 && w <= 5) o.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); } return o; }

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth','auth'],['/api/users','users'],['/api/entries','entries'],
    ['/api/statistics','statistics'],['/api/payroll','payroll'],['/api/payouts','payouts'],
    ['/api/pdf','pdf'],['/api/badges','badges']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const login = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body.token;
    const admin = await login('admin', PWSEED), chef = await login('chef', PWSEED);
    const PW = 'Ablehn!2345';
    const u = (await req('POST', '/api/users', admin, { username: 'ablehner', password: PW, name: 'Anton Ablehner',
      role: 'mitarbeiter', target_hours_per_week: 40, hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    const mTok = await login('ablehner', PW);
    const tage = werktage(40, 1);
    db.prepare('UPDATE employment_periods SET start_date = ? WHERE user_id = ?').run(tage[0], u.id);
    await req('POST', `/api/statistics/targets/${u.id}`, chef, {
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: tage[0] });
    for (const t of tage) await req('POST', '/api/entries', mTok, {
      date: t, time_from: '07:00', time_to: '17:00', break_minutes: 0, description: 'Arbeit' });

    const stand = async () => (await req('GET', `/api/statistics/overtime?user_id=${u.id}&date_to=${iso(heute)}`, admin)).body.overtime;
    const vorher = await stand();
    ok(`Aufbau: ${tage.length} Tage à 10 h → Stand ${rund(vorher)} h`, rund(vorher) === tage.length * 2, String(vorher));

    console.log('\n── Der Chef fragt an, der Mitarbeiter lehnt ab ──');
    const a = await req('POST', '/api/payouts', chef, { user_id: u.id, stunden: 30, wirksam_ab: iso(heute) });
    ok('Anfrage steht', a.status === 201 && a.body.auszahlung.status === 'offen', String(a.status));
    const zaehlerVor = (await req('GET', '/api/badges', mTok)).body.konto;
    ok('… der Zähler beim Mitarbeiter steht auf 1', zaehlerVor === 1, String(zaehlerVor));

    const ohneGrund = await req('POST', `/api/payouts/${a.body.auszahlung.id}/ablehnen`, mTok, { grund: '' });
    ok('ohne Begründung wird die Ablehnung abgewiesen', ohneGrund.status === 400, ohneGrund.status + ' ' + ohneGrund.text.slice(0, 90));
    const zuKurz = await req('POST', `/api/payouts/${a.body.auszahlung.id}/ablehnen`, mTok, { grund: 'ne' });
    ok('… eine zu kurze auch', zuKurz.status === 400, String(zuKurz.status));

    const GRUND = 'Ich möchte lieber abfeiern.';
    const ab = await req('POST', `/api/payouts/${a.body.auszahlung.id}/ablehnen`, mTok, { grund: GRUND });
    ok('mit Begründung geht es', ab.status === 200, ab.status + ' ' + ab.text.slice(0, 90));

    console.log('\n── Es kostet KEINE Stunde ──');
    ok('der Überstundenstand ist auf die Stelle genau gleich', rund(await stand()) === rund(vorher),
      `${rund(vorher)} → ${rund(await stand())}`);
    ok('… es zählt keine Auszahlung', auszahlungenSumme(db, u.id, iso(heute)) === 0, String(auszahlungenSumme(db, u.id, iso(heute))));
    ok('… und nichts steht mehr offen', offeneSumme(db, u.id) === 0, String(offeneSumme(db, u.id)));
    const zaehlerNach = (await req('GET', '/api/badges', mTok)).body.konto;
    ok('… der Zähler ist weg', zaehlerNach === 0, String(zaehlerNach));

    console.log('\n── Die Begründung ist festgehalten und für den Chef lesbar ──');
    const beimChef = (await req('GET', `/api/payouts?user_id=${u.id}`, chef)).body.auszahlungen[0];
    ok('der Chef sieht den Status „abgelehnt"', beimChef.status === 'abgelehnt', JSON.stringify(beimChef.status));
    ok('… und die Begründung im Wortlaut', beimChef.grund === GRUND, JSON.stringify(beimChef.grund));
    ok('… und wer entschieden hat', beimChef.entschieden_von_name === 'ablehner', JSON.stringify(beimChef.entschieden_von_name));
    const prot = db.prepare("SELECT details FROM audit_logs WHERE action = 'overtime_payout_reject' ORDER BY id DESC LIMIT 1").get();
    ok('… und es steht im Protokoll', !!prot && prot.details.includes(GRUND), JSON.stringify(prot));

    console.log('\n── Eine Ablehnung ist endgültig ──');
    const doch = await req('POST', `/api/payouts/${a.body.auszahlung.id}/bestaetigen`, mTok, {});
    ok('sie lässt sich nicht nachträglich doch bestätigen', doch.status === 409, doch.status + ' ' + doch.text.slice(0, 90));
    const zieh = await req('POST', `/api/payouts/${a.body.auszahlung.id}/zurueckziehen`, chef, {});
    ok('… und der Chef kann sie auch nicht zurückziehen', zieh.status === 409, String(zieh.status));

    console.log('\n── Der Chef ist nicht blockiert ──');
    // Die Sperre gilt nur fuer OFFENE Anfragen — eine abgelehnte darf einen neuen Anlauf nicht
    // verhindern, sonst waere eine einmalige Ablehnung eine Sackgasse fuer immer.
    const neu = await req('POST', '/api/payouts', chef, { user_id: u.id, stunden: 12, wirksam_ab: iso(heute) });
    ok('er kann eine neue Anfrage stellen', neu.status === 201, neu.status + ' ' + neu.text.slice(0, 110));
    ok('… und die steht wieder offen', neu.body.auszahlung.status === 'offen', JSON.stringify(neu.body.auszahlung.status));
    const zaehlerNeu = (await req('GET', '/api/badges', mTok)).body.konto;
    ok('… der Zähler ist wieder da', zaehlerNeu === 1, String(zaehlerNeu));

    console.log('\n── In Lohn-CSV und PDF taucht nichts auf ──');
    const monat = iso(heute).slice(0, 7);
    const csv = (await req('GET', `/api/payroll/monat.csv?month=${monat}`, admin)).text;
    const kopf = csv.split('\r\n')[0].split(';').map(x => x.replace(/"/g, ''));
    const z = (csv.split('\r\n').find(x => x.includes('Anton Ablehner')) || '').split(';').map(x => x.replace(/"/g, ''));
    ok('die Spalte „Auszahlung Stunden" bleibt 0',
      Number(String(z[kopf.indexOf('Auszahlung Stunden')]).replace(',', '.')) === 0, JSON.stringify(z[kopf.indexOf('Auszahlung Stunden')]));
    ok('… und „Auszahlung Beleg" bleibt leer', !z[kopf.indexOf('Auszahlung Beleg')], JSON.stringify(z[kopf.indexOf('Auszahlung Beleg')]));

    const pdf = await req('GET', `/api/pdf/export?user_id=${u.id}&date_from=${tage[0]}&date_to=${iso(heute)}`, admin, null, true);
    fs.writeFileSync('/tmp/auszahlung-ablehnung.pdf', pdf.buf);
    let text = '';
    try {
      require('child_process').execFileSync('pdftotext', ['-layout', '/tmp/auszahlung-ablehnung.pdf', '/tmp/auszahlung-ablehnung.txt']);
      text = fs.readFileSync('/tmp/auszahlung-ablehnung.txt', 'utf8');
    } catch (_) { console.log('  (pdftotext fehlt)'); }
    if (text) {
      ok('das PDF nennt keine Auszahlung', !/davon ausgezahlt/i.test(text),
        (text.match(/Gesamtstunden[\s\S]{0,140}/) || [''])[0]);
      const m = text.match(/Überstunden gesamt:\s*([+-][\d:]+)/);
      const erwartet = `+${Math.floor(vorher)}:00`;
      ok(`… und den unveränderten Stand ${erwartet}`, !!m && m[1] === erwartet, m ? m[1] : 'nicht gefunden');
    }

    console.log('\n── Was der Chef NICHT bekommt ──');
    // Ehrlich gemessen und hier festgehalten: Es gibt fuer die Ablehnung KEINE Push-Meldung und
    // keinen Zaehler beim Chef. Er erfaehrt davon nur, wenn er selbst nachsieht.
    const chefZaehler = (await req('GET', '/api/badges', chef)).body;
    ok('der Chef hat KEINEN Zähler für Auszahlungen (bewusst festgehalten)',
      chefZaehler.konto === 0, JSON.stringify(chefZaehler));
    console.log('\n── Was im Protokoll steht ──');
    const eintraege = db.prepare("SELECT action, username, details FROM audit_logs WHERE action LIKE 'overtime%' ORDER BY id").all();
    for (const e of eintraege) console.log(`  ${e.action.padEnd(26)} ${String(e.username).padEnd(10)} ${e.details}`);
    ok('jede Aktion ist protokolliert (anlegen, ablehnen, erneut anlegen)',
      eintraege.length === 3 && eintraege.map(e => e.action).join(',') === 'overtime_payout_create,overtime_payout_reject,overtime_payout_create',
      eintraege.map(e => e.action).join(', '));
    ok('… mit dem Namen dessen, der gehandelt hat',
      eintraege[1] && eintraege[1].username === 'ablehner', JSON.stringify(eintraege[1] && eintraege[1].username));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nAblehnung: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
