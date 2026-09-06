// Alex' Szenario, Ende zu Ende durchgerechnet (06.09.2026):
//   anhäufen → 10 h auszahlen → anhäufen → MEHR auszahlen als da ist (Stand geht ins Minus)
//   → anhäufen → kündigen.
//
// Geprüft wird nicht nur, dass die App eine Zahl liefert, sondern dass sie zur HANDRECHNUNG passt:
//   Überstunden gesamt = Ist − Soll − Auszahlungen
// und dass dieselbe Zahl in Statistik, Lohn-CSV und PDF-Zeitnachweis wieder auftaucht.
//
// Zwei Fallen, in die der erste Entwurf lief:
//   * Ohne Soll-Historie (`user_target_hours`) ist `getEarliestTargetDate` null — der
//     Überstundenstand bleibt stur beim Startsaldo, alles zeigt 0 und der Test sieht nichts.
//   * Wer nur EINZELNE Tage bucht, sammelt kein Guthaben, sondern ein tiefes Minus: Das Soll läuft
//     ja an allen anderen Werktagen weiter. Der erste Lauf stand bei −944 h statt im Plus.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//
//   node tests/auszahlung-durchrechnung.js
const fs = require('fs'); const http = require('http'); const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/auszahlung-durchrechnung.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const express = require('express');
const { initDatabase, getDb } = require('../database/init');

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
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const iso = d => d.toISOString().slice(0, 10);
const rund = n => Math.round((Number(n) || 0) * 100) / 100;
const heute = new Date(new Date().toLocaleDateString('sv-SE') + 'T12:00:00Z');

// ALLE Werktage zwischen zwei Punkten (Tage zurueck von heute). Lueckenlos ist wichtig: Wer nur
// einzelne Tage bucht, sammelt kein Guthaben, sondern ein tiefes Minus — das Soll laeuft ja
// weiter. Mein erster Versuch hatte genau diesen Fehler und stand bei -944 h.
function werktageZwischen(vonZurueck, bisZurueck) {
  const out = []; const d = new Date(heute); d.setUTCDate(d.getUTCDate() - vonZurueck);
  const ende = new Date(heute); ende.setUTCDate(ende.getUTCDate() - bisZurueck);
  while (d <= ende) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth','auth'],['/api/users','users'],['/api/entries','entries'],
    ['/api/statistics','statistics'],['/api/payroll','payroll'],['/api/payouts','payouts'],['/api/pdf','pdf'],['/api/closure','closure']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  const login = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body.token;
  const admin = await login('admin', PWSEED), chef = await login('chef', PWSEED);
  const PW = 'Bilanz!2345';
  const u = (await req('POST', '/api/users', admin, { username: 'bilanz', password: PW, name: 'Bernd Bilanz',
    role: 'mitarbeiter', target_hours_per_week: 40, hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
  const mTok = await login('bilanz', PW);
  // Anstellung weit genug zurueck — UND die Soll-Historie, sonst ist getEarliestTargetDate null
  // und der Ueberstundenstand bleibt stur beim Startsaldo (mein erster Versuch: alles 0).
  const beginn = werktageZwischen(120, 81)[0];   // erster wirklich gebuchter Werktag
  db.prepare('UPDATE employment_periods SET start_date = ? WHERE user_id = ?').run(beginn, u.id);
  const t = await req('POST', `/api/statistics/targets/${u.id}`, chef, {
    hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: beginn });
  if (t.status !== 200 && t.status !== 201) console.log('Soll-Historie fehlgeschlagen:', t.status, t.text.slice(0,120));

  const stand = async (bis) => (await req('GET', `/api/statistics/overtime?user_id=${u.id}&date_to=${bis || iso(heute)}`, admin)).body.overtime;
  const statistik = async (von, bis) => {
    const r = await req('GET', `/api/statistics?user_ids=${u.id}&period=custom&from=${von}&to=${bis}`, admin);
    return r.body && r.body.users && r.body.users[0];
  };
  const buchen = async (tage, stunden) => {
    for (const t of tage) {
      const bis = `${String(7 + stunden).padStart(2,'0')}:00`;
      const r = await req('POST', '/api/entries', mTok, { date: t, time_from: '07:00', time_to: bis, break_minutes: 0, description: 'Arbeit' });
      if (r.status !== 201) { console.log('BUCHUNG FEHLGESCHLAGEN', t, r.status, r.text.slice(0,120)); }
    }
  };

  const zeile = (was, ot, extra) => console.log(`  ${was.padEnd(46)} ${String(rund(ot)).padStart(9)} h  ${extra || ''}`);

  console.log('SZENARIO — Bernd Bilanz, 8 h/Tag Mo–Fr, Start-Überstunden 0\n');

  // ── Phase 1: anhaeufen ──────────────────────────────────────────────────────────────────
  const p1 = werktageZwischen(120, 81);    // lueckenlos, je 10 h (Soll 8) -> +2 h/Tag
  await buchen(p1, 10);
  const s1 = await statistik(p1[0], p1[p1.length - 1]);
  const ot1 = await stand();
  console.log(`Phase 1 — ${p1.length} Werktage à 10 h gearbeitet (Soll 8), lückenlos:`);
  console.log(`  Ist ${s1.ist} h · Soll ${s1.soll} h · Saldo ${rund(s1.ist - s1.soll)} h`);
  zeile('Überstundenstand nach Phase 1', ot1);

  // ── Auszahlung 1: 10 h ──────────────────────────────────────────────────────────────────
  const a1 = await req('POST', '/api/payouts', chef, { user_id: u.id, stunden: 10, wirksam_ab: p1[p1.length - 1] });
  console.log(`\n  Auszahlung 1 angelegt: 10 h, wirksam ab ${a1.body.auszahlung.wirksam_ab}`);
  const otOffen = await stand();
  zeile('… solange OFFEN (darf sich nicht bewegen)', otOffen, otOffen === ot1 ? '✓ unverändert' : '✗ VERÄNDERT');
  await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, mTok, {});
  const ot2 = await stand();
  zeile('… nach Bestätigung', ot2, `erwartet ${rund(ot1 - 10)} ${rund(ot2) === rund(ot1 - 10) ? '✓' : '✗'}`);

  // ── Phase 2: wieder anhaeufen ───────────────────────────────────────────────────────────
  const p2 = werktageZwischen(80, 31);      // lueckenlos, je 12 h -> +4 h/Tag
  await buchen(p2, 12);
  const ot3 = await stand();
  zeile('Überstundenstand nach Phase 2', ot3, `(+${rund(ot3 - ot2)} h dazu)`);

  // ── Auszahlung 2: MEHR als vorhanden ────────────────────────────────────────────────────
  const zuViel = rund(ot3 + 20);
  const a2 = await req('POST', '/api/payouts', chef, { user_id: u.id, stunden: zuViel, wirksam_ab: p2[p2.length - 1] });
  console.log(`\n  Auszahlung 2 angelegt: ${zuViel} h (Stand war ${rund(ot3)} h)`);
  console.log(`  Warnung des Servers: ${JSON.stringify(a2.body.warnungen)}`);
  await req('POST', `/api/payouts/${a2.body.auszahlung.id}/bestaetigen`, mTok, {});
  const ot4 = await stand();
  zeile('… nach Bestätigung', ot4, `erwartet ${rund(ot3 - zuViel)} = -20 ${rund(ot4) === -20 ? '✓' : '✗'}`);

  // ── Phase 3: wieder anhaeufen ───────────────────────────────────────────────────────────
  const p3 = werktageZwischen(30, 1);       // lueckenlos, je 11 h -> +3 h/Tag
  await buchen(p3, 11);
  const ot5 = await stand();
  zeile('Überstundenstand nach Phase 3', ot5, `(+${rund(ot5 - ot4)} h dazu)`);

  // ── Kuendigung ──────────────────────────────────────────────────────────────────────────
  const letzterTag = p3[p3.length - 1];
  const aus = await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: letzterTag });
  console.log(`\n  Ausgestellt zum ${letzterTag} (${aus.status}, vorgemerkt=${aus.body && aus.body.vorgemerkt})`);
  const ot6 = await stand(iso(heute));
  zeile('Überstundenstand nach dem Ausstellen', ot6);
  const ot6spaet = await stand(iso(new Date(heute.getTime() + 200*864e5)));
  zeile('… und ein halbes Jahr später (Soll läuft nicht weiter)', ot6spaet,
    rund(ot6) === rund(ot6spaet) ? '✓ eingefroren' : '✗ läuft weiter');

  // ── Gegenrechnung von Hand ──────────────────────────────────────────────────────────────
  const ges = await statistik(iso(new Date(heute.getTime() - 400*864e5)), iso(heute));
  const auszahlungenSumme = db.prepare("SELECT COALESCE(SUM(stunden),0) s FROM overtime_payouts WHERE user_id=? AND status='bestaetigt'").get(u.id).s;
  console.log('\nGEGENRECHNUNG');
  console.log(`  Ist gesamt                    ${String(rund(ges.ist)).padStart(9)} h`);
  console.log(`  Soll gesamt                   ${String(rund(ges.soll)).padStart(9)} h`);
  console.log(`  Saldo (Ist − Soll)            ${String(rund(ges.ist - ges.soll)).padStart(9)} h`);
  console.log(`  − Auszahlungen                ${String(rund(auszahlungenSumme)).padStart(9)} h  (10 + ${zuViel})`);
  console.log(`  = erwartet                    ${String(rund(ges.ist - ges.soll - auszahlungenSumme)).padStart(9)} h`);
  console.log(`  App sagt                      ${String(rund(ot6)).padStart(9)} h  ${rund(ges.ist - ges.soll - auszahlungenSumme) === rund(ot6) ? '✓ passt' : '✗ WEICHT AB'}`);
  console.log(`  Statistik-Feld "ausgezahlt"   ${String(rund(ges.ausgezahlt)).padStart(9)} h  ${rund(ges.ausgezahlt) === rund(auszahlungenSumme) ? '✓' : '✗'}`);

  // ── Lohn-CSV der betroffenen Monate ─────────────────────────────────────────────────────
  console.log('\nLOHN-CSV (nur die Zeilen von Bernd Bilanz)');
  const monate = [...new Set([...p1, ...p2, ...p3].map(d => d.slice(0, 7)))].sort();
  for (const m of monate) {
    const csv = (await req('GET', `/api/payroll/monat.csv?month=${m}`, admin)).text;
    const kopf = csv.split('\r\n')[0].split(';').map(x => x.replace(/"/g, ''));
    const z = csv.split('\r\n').find(x => x.includes('Bernd Bilanz'));
    if (!z) { console.log(`  ${m}: keine Zeile`); continue; }
    const w = z.split(';').map(x => x.replace(/"/g, ''));
    const feld = (n) => w[kopf.indexOf(n)];
    console.log(`  ${m}:  Soll ${feld('Soll-Stunden').padStart(6)} · Ist ${feld('Ist-Stunden').padStart(6)} · Saldo ${feld('Saldo').padStart(7)}`
      + ` · Ü-gesamt ${feld('Überstunden gesamt').padStart(8)} · Auszahlung ${String(feld('Auszahlung Stunden')).padStart(7)} (${feld('Auszahlung Beleg') || '—'})`
      + (feld('Beschäftigt bis') ? ` · bis ${feld('Beschäftigt bis')}` : ''));
  }

  // ── PDF ─────────────────────────────────────────────────────────────────────────────────
  const pdf = await req('GET', `/api/pdf/export?user_id=${u.id}&date_from=${p1[0]}&date_to=${iso(heute)}`, admin, null, true);
  if (pdf.status === 200) {
    fs.writeFileSync('/tmp/auszahlung-durchrechnung.pdf', pdf.buf);
    console.log(`\nPDF erzeugt: ${pdf.buf.length} Bytes → /tmp/durchrechnung.pdf`);
  } else {
    console.log(`\nPDF: HTTP ${pdf.status} — ${pdf.buf.toString().slice(0, 200)}`);
  }

  // ── Zusicherungen ───────────────────────────────────────────────────────────────────────
  console.log('\nPRÜFUNGEN');
  ok('eine OFFENE Auszahlung bewegt den Stand nicht', rund(otOffen) === rund(ot1), `${ot1} → ${otOffen}`);
  ok('die erste Auszahlung zieht genau 10 h ab', rund(ot2) === rund(ot1 - 10), `${ot1} → ${ot2}`);
  ok('der Stand kann ins Minus gehen', rund(ot4) === -20, String(ot4));
  ok('… und wächst danach normal weiter', rund(ot5) > 0, String(ot5));
  ok('nach dem Ausstellen läuft das Soll nicht weiter', rund(ot6) === rund(ot6spaet), `${ot6} vs ${ot6spaet}`);
  ok('Handrechnung: Ist − Soll − Auszahlungen = Überstunden gesamt',
    rund(ges.ist - ges.soll - auszahlungenSumme) === rund(ot6),
    `${rund(ges.ist)} − ${rund(ges.soll)} − ${rund(auszahlungenSumme)} = ${rund(ges.ist - ges.soll - auszahlungenSumme)} vs ${rund(ot6)}`);
  ok('die Statistik weist die Auszahlungen aus', rund(ges.ausgezahlt) === rund(auszahlungenSumme),
    `${ges.ausgezahlt} vs ${auszahlungenSumme}`);

  // Lohn-CSV: der Ueberstundenstand muss von Monat zu Monat aufgehen
  let lauf = 0; const csvAbw = [];
  for (const m of monate) {
    const csv = (await req('GET', `/api/payroll/monat.csv?month=${m}`, admin)).text;
    const kopf = csv.split('\r\n')[0].split(';').map(x => x.replace(/"/g, ''));
    const z = csv.split('\r\n').find(x => x.includes('Bernd Bilanz'));
    if (!z) continue;
    const w = z.split(';').map(x => x.replace(/"/g, ''));
    const zahl = (n) => Number(String(w[kopf.indexOf(n)]).replace(',', '.')) || 0;
    lauf = rund(lauf + zahl('Saldo') - zahl('Auszahlung Stunden'));
    if (lauf !== rund(zahl('Überstunden gesamt'))) {
      csvAbw.push(`${m}: fortgeschrieben ${lauf} vs ausgewiesen ${zahl('Überstunden gesamt')}`);
    }
  }
  ok('Lohn-CSV: Saldo minus Auszahlung schreibt den Stand Monat für Monat richtig fort',
    csvAbw.length === 0, csvAbw.join(' | '));
  ok('… und endet auf demselben Wert wie die App', rund(lauf) === rund(ot6), `${lauf} vs ${ot6}`);

  // PDF: die Zahl muss ERKLAERT sein
  const { execFileSync } = require('child_process');
  let text = '';
  try {
    execFileSync('pdftotext', ['-layout', '/tmp/auszahlung-durchrechnung.pdf', '/tmp/auszahlung-durchrechnung.txt']);
    text = fs.readFileSync('/tmp/auszahlung-durchrechnung.txt', 'utf8');
  } catch (_) { console.log('  (pdftotext fehlt — PDF-Inhalt uebersprungen)'); }
  if (text) {
    // ZEITFALLE, die der erste Entwurf hatte: "52:00" und "211:00" fest eingetragen. Wie viele
    // Werktage in die Phasen fallen, haengt aber davon ab, auf welchen Wochentag "heute" faellt —
    // morgen waere der Test rot gewesen, ohne dass sich etwas verschlechtert haette. Die Erwartung
    // wird deshalb aus den gemessenen Werten GERECHNET ([[reference_tests_zeitfallen]]).
    const hmm = (n) => { const m = Math.round(Math.abs(n) * 60);
      return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
    const erwAusgezahlt = `davon ausgezahlt: -${hmm(auszahlungenSumme)}`;
    const erwGesamt = `Überstunden gesamt: ${ot6 >= 0 ? '+' : '-'}${hmm(ot6)}`;
    ok(`PDF nennt die ausgezahlten Stunden (${erwAusgezahlt})`, text.includes(erwAusgezahlt),
      (text.match(/Gesamtstunden[\s\S]{0,160}/) || [''])[0]);
    ok(`… und den Gesamtstand (${erwGesamt})`, text.includes(erwGesamt),
      (text.match(/Überstunden gesamt:.*/) || [''])[0]);
  }

  console.log(`\nDurchrechnung: ${pass} bestanden, ${fail} fehlgeschlagen`);
  server.close();
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
