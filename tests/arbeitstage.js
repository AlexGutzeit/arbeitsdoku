// Gearbeitete Tage und Spesen-Aufteilung — Statistik, Lohn-CSV, PDF (Alex, 30.09.2026).
//
// Alex: „In der Statistik eine Auflistung der gearbeiteten Tage (Arbeitstag = wenn mehr als 0 Stunden gebucht
// wurden). Außerdem für die Spesen eine Aufgliederung von Tagen mit mehr als 8 Stunden und weniger als 8 Stunden."
// Entschieden: für die 8-Stunden-Grenze zählt die Zeit vom ersten Beginn bis zum letzten Ende des Tages (Pausen
// und Lücken eingerechnet), genau 8:00 zählt zu „bis 8 Std."; alle Arbeitstage; auch in Lohn-CSV und PDF.
// Sollwerte stehen hier von Hand fest (nicht aus der geprüften Funktion):
//   A  07:00–15:30, 30 min Pause     → gearbeitet 8:00, Beginn–Ende 8:30 → mehr als 8
//   B  07:00–15:00, keine Pause      → 8:00 / genau 8:00                → bis 8
//   C  07:00–10:00 und 13:00–16:00   → 6:00 / 9:00 (Mittagslücke)       → mehr als 8
//   D  07:00–12:00 und 11:00–15:00   → 8:00 (Überlappung einmal) / 8:00 → bis 8
//   E  07:00–07:30, 30 min Pause     → 0:00 — die App nimmt so einen Eintrag gar nicht an (kein 0-Stunden-Tag)
//   F  Samstag 08:00–12:00           → 4:00 → bis 8
//   G  gelöschter Eintrag, H Krank   → zählen nicht
// Erwartet: 5 Arbeitstage, 2 × mehr als 8 Std., 3 × bis 8 Std. — überall gleich.
//
//   node tests/arbeitstage.js
const { spawn, execFileSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3362, DB = '/tmp/arbeitstage-test.db', LOG = '/tmp/arbeitstage-test.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => { const buf = Buffer.concat(teile); const s = buf.toString('utf8');
        let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s, buf }); }); });
    r.setTimeout(20000, () => { r.destroy(); res({ status: 'keine Antwort', body: null, text: '' }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const iso = (d) => d.toISOString().slice(0, 10);
// Vormonat, erster Montag: acht Tage ab dort liegen sicher im selben, vergangenen Monat
const heute = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }) + 'T12:00:00Z');
const monat1 = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() - 1, 1, 12));
const montag = new Date(monat1); while (montag.getUTCDay() !== 1) montag.setUTCDate(montag.getUTCDate() + 1);
const tag = (n) => { const d = new Date(montag); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const MONAT = iso(monat1).slice(0, 7);
const monatEnde = iso(new Date(Date.UTC(monat1.getUTCFullYear(), monat1.getUTCMonth() + 1, 0, 12)));

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const anna = (await req('POST', '/api/users', admin, { username: 'anna', password: 'Test1234!', name: 'Anna Berger', role: 'mitarbeiter' })).body.user;
    const tAnna = (await req('POST', '/api/auth/login', null, { username: 'anna', password: 'Test1234!' })).body.token;
    // Anstellung rückdatieren, damit der Vormonat zählt
    await req('POST', `/api/statistics/targets/${anna.id}`, admin, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${MONAT}-01` });
    const e = (d, von, bis, pause) => req('POST', '/api/entries', admin, { date: d, time_from: von, time_to: bis, break_minutes: pause || 0, user_id: anna.id });
    const angelegt = [
      await e(tag(0), '07:00', '15:30', 30),                                   // A
      await e(tag(1), '07:00', '15:00', 0),                                    // B
      await e(tag(2), '07:00', '10:00', 0), await e(tag(2), '13:00', '16:00', 0), // C
      await e(tag(3), '07:00', '12:00', 0), await e(tag(3), '11:00', '15:00', 0), // D
      await e(tag(5), '08:00', '12:00', 0),                                    // F (Samstag)
    ];
    const nurPause = await e(tag(4), '07:00', '07:30', 30);                    // E
    const g = await e(tag(7), '07:00', '17:00', 0);                            // G, wird gelöscht
    const gId = (g.body.entry || g.body).id;
    const geloescht = await req('DELETE', `/api/entries/${gId}`, admin, { reason: 'Test: doppelt gebucht' });
    await req('POST', '/api/absences', admin, { type: 'krank', date_from: tag(8), date_to: tag(8), target_user_id: anna.id });   // H
    ok('Aufbau: alle Einträge angelegt, G gelöscht, Samstag ist Samstag', angelegt.every(r => r.status < 300) && geloescht.status === 200
      && new Date(tag(5) + 'T12:00:00Z').getUTCDay() === 6, JSON.stringify([angelegt.map(r => r.status), geloescht.status]));
    ok('E: ein Eintrag nur aus Pause wird abgewiesen — ein gebuchter Tag hat immer mehr als 0 Stunden', nurPause.status === 400, String(nurPause.status));

    console.log('Statistik');
    const st = (await req('GET', `/api/statistics?user_ids=${anna.id}&period=month&date=${tag(2)}`, admin)).body;
    const a = st.users[0].arbeitstage;
    ok('5 Arbeitstage, 2 × mehr als 8 Std., 3 × bis 8 Std.', a.anzahl === 5 && a.ueber8 === 2 && a.bis8 === 3, JSON.stringify({ anzahl: a.anzahl, ueber8: a.ueber8, bis8: a.bis8 }));
    const t = Object.fromEntries(a.tage.map(x => [x.datum, x]));
    ok('A: 07:00–15:30, anwesend 8,5, gearbeitet 8, mehr als 8', t[tag(0)] && t[tag(0)].beginn === '07:00' && t[tag(0)].ende === '15:30' && t[tag(0)].anwesend === 8.5 && t[tag(0)].ist === 8 && t[tag(0)].ueber8 === true, JSON.stringify(t[tag(0)]));
    ok('B: genau 8:00 → bis 8', t[tag(1)] && t[tag(1)].anwesend === 8 && t[tag(1)].ueber8 === false, JSON.stringify(t[tag(1)]));
    ok('C: Mittagslücke zählt mit (07:00–16:00 = 9), gearbeitet 6 → mehr als 8', t[tag(2)] && t[tag(2)].anwesend === 9 && t[tag(2)].ist === 6 && t[tag(2)].ueber8 === true, JSON.stringify(t[tag(2)]));
    ok('D: Überlappung einmal (8), 07:00–15:00 → bis 8', t[tag(3)] && t[tag(3)].ist === 8 && t[tag(3)].anwesend === 8 && t[tag(3)].ueber8 === false, JSON.stringify(t[tag(3)]));
    ok('E: kein Arbeitstag', !t[tag(4)]);
    ok('F: Samstag zählt (4 Std., bis 8)', t[tag(5)] && t[tag(5)].ist === 4 && t[tag(5)].ueber8 === false);
    ok('G gelöscht und H krank zählen nicht', !t[tag(7)] && !t[tag(8)]);
    ok('Tage nach Datum sortiert', a.tage.map(x => x.datum).join() === [tag(0), tag(1), tag(2), tag(3), tag(5)].join());
    ok('Summe über alle Mitarbeiter (combined)', st.combined.arbeitstage && st.combined.arbeitstage.anzahl === 5 && st.combined.arbeitstage.ueber8 === 2);
    const eigen = (await req('GET', `/api/statistics?period=month&date=${tag(2)}`, tAnna)).body;
    ok('die Mitarbeiterin sieht ihre eigenen Tage', eigen.users.length === 1 && eigen.users[0].arbeitstage.anzahl === 5);

    console.log('Lohn-CSV');
    const csv = (await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, admin)).text.replace(/^﻿/, '').trim().split(/\r?\n/).map(z => z.split(';').map(x => x.replace(/^"|"$/g, '')));
    const kopf = csv[0], zeile = csv.find(z => z[1] === 'Anna Berger'), summe = csv[csv.length - 1];
    const sp = (n) => kopf.indexOf(n);
    ok('drei neue Spalten ganz hinten, die alten bleiben an ihrem Platz', kopf.slice(-3).join('|') === 'Arbeitstage|davon mehr als 8 Std.|davon bis 8 Std.' && kopf[0] === 'Personalnummer' && kopf[kopf.length - 4] === 'Beschäftigt bis', kopf.join('|'));
    ok('Anna: 5 / 2 / 3', zeile && zeile[sp('Arbeitstage')] === '5' && zeile[sp('davon mehr als 8 Std.')] === '2' && zeile[sp('davon bis 8 Std.')] === '3', zeile && zeile.slice(-3).join('|'));
    ok('Summenzeile rechnet sie mit', summe[1] === 'Summe' && Number(summe[sp('Arbeitstage')]) >= 5 && Number(summe[sp('davon mehr als 8 Std.')]) >= 2, summe.slice(-3).join('|'));

    console.log('PDF-Nachweis');
    const pdf = await req('GET', `/api/pdf/export?user_id=${anna.id}&date_from=${MONAT}-01&date_to=${monatEnde}`, admin);
    fs.writeFileSync('/tmp/arbeitstage-test.pdf', pdf.buf);
    let text = '';
    try { execFileSync('pdftotext', ['-layout', '/tmp/arbeitstage-test.pdf', '/tmp/arbeitstage-test.txt']); text = fs.readFileSync('/tmp/arbeitstage-test.txt', 'utf8'); } catch (err) { text = 'pdftotext fehlt: ' + err.message; }
    ok('PDF nennt „Arbeitstage: 5 (mehr als 8 Std.: 2, bis 8 Std.: 3; Beginn bis Ende)"', /Arbeitstage: 5 \(mehr als 8 Std\.: 2, bis 8 Std\.: 3; Beginn bis Ende\)/.test(text), text.split('\n').filter(z => /Arbeitstage|Überstunden gesamt/.test(z)).join(' / ').slice(0, 200));
  } catch (err) {
    ok('Ablauf ohne Ausnahme', false, err && err.stack);
  } finally {
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nGearbeitete Tage: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
