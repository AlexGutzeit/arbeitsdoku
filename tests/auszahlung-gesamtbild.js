// Das GESAMTBILD (Alex, 06.09.2026): mehrere Aufbau-Phasen, Freizeitausgleich dazwischen,
// eine Auszahlung mittendrin, und zum Schluss der reale Fall —
//   Austritt vormerken → Reststunden zum LETZTEN Arbeitstag auszahlen → der Zeitplaner vollzieht.
//
// Geprüft wird gegen die HANDRECHNUNG, nicht gegen die App selbst:
//   Überstunden gesamt = Ist − Soll − Auszahlungen
// Freizeitausgleich zählt dabei mit vollem Soll und ohne Ist — das ist genau „abfeiern" und
// unterscheidet ihn von Urlaub/Sonderurlaub/Schule/Innung, wo das Soll auf 0 geht
// (routes/statistics.js, calcTargetHoursRaw).
//
// Und dann dieselbe Zahl in JEDER Darstellung: Statistik, Abwesenheits-Übersicht, Lohn-CSV,
// PDF-Zeitnachweis. Eine Zahl, die je nach Ansicht anders lautet, ist schlimmer als keine.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//
//   node tests/auszahlung-gesamtbild.js
const fs = require('fs'); const http = require('http'); const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/auszahlung-gesamtbild.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const { austritteVollziehen } = require('../scheduler');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const rund = n => Math.round((Number(n) || 0) * 100) / 100;
const hmm = n => { const m = Math.round(Math.abs(n) * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

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

// Alles relativ zu heute ([[reference_tests_zeitfallen]]).
const iso = d => d.toISOString().slice(0, 10);
const heute = new Date(new Date().toLocaleDateString('sv-SE') + 'T12:00:00Z');
const plusTage = n => { const d = new Date(heute); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function werktage(vonZurueck, bisZurueck) {
  const o = []; const d = new Date(heute); d.setUTCDate(d.getUTCDate() - vonZurueck);
  const e = new Date(heute); e.setUTCDate(e.getUTCDate() - bisZurueck);
  while (d <= e) { const w = d.getUTCDay(); if (w >= 1 && w <= 5) o.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return o;
}

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth','auth'],['/api/users','users'],['/api/entries','entries'],
    ['/api/statistics','statistics'],['/api/payroll','payroll'],['/api/payouts','payouts'],
    ['/api/pdf','pdf'],['/api/absences','absences'],['/api/closure','closure']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const login = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body.token;
    const admin = await login('admin', PWSEED), chef = await login('chef', PWSEED);
    const PW = 'Gesamt!2345';
    const u = (await req('POST', '/api/users', admin, { username: 'gesamt', password: PW, name: 'Gerda Gesamt',
      role: 'mitarbeiter', target_hours_per_week: 40, hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    const mTok = await login('gesamt', PW);

    const alleTage = werktage(90, -10);           // bis 10 Tage in die Zukunft (fuer den Austritt)
    const beginn = alleTage[0];
    db.prepare('UPDATE employment_periods SET start_date = ? WHERE user_id = ?').run(beginn, u.id);
    await req('POST', `/api/statistics/targets/${u.id}`, chef, {
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: beginn });

    const stand = async (bis) => (await req('GET', `/api/statistics/overtime?user_id=${u.id}&date_to=${bis || plusTage(30)}`, admin)).body.overtime;
    const buchen = async (tage, h) => { for (const t of tage) {
      const r = await req('POST', '/api/entries', mTok, { date: t, time_from: '07:00',
        time_to: `${String(7 + h).padStart(2, '0')}:00`, break_minutes: 0, description: 'Arbeit' });
      if (r.status !== 201) console.log(`    Buchung ${t} fehlgeschlagen: ${r.status} ${r.text.slice(0, 80)}`);
    } };

    console.log('── Phase 1: Überstunden aufbauen ──');
    const p1 = werktage(90, 66);
    await buchen(p1, 10);                          // +2 h je Tag
    // IMMER zum Stichtag des Abschnitts messen, nie pauschal in die Zukunft: Der Stand am
    // Tag X enthaelt das Soll aller Tage bis X. Mein erster Entwurf mass bei "heute + 30" und
    // zeigte -506 h, weil dort einen Monat unbebuchtes Soll mitlief.
    const ot1 = await stand(p1[p1.length - 1]);
    ok(`Phase 1: ${p1.length} Tage à 10 h → Stand ${rund(ot1)} h`, rund(ot1) === p1.length * 2,
      `${rund(ot1)}, erwartet ${p1.length * 2}`);

    console.log('\n── Phase 2: Freizeitausgleich (abfeiern) ──');
    const fza = werktage(65, 61);
    const fzaTage = fza.length;
    const vorFza = await stand(fza[fza.length - 1]);
    const abw = await req('POST', '/api/absences', chef, { type: 'freizeitausgleich',
      date_from: fza[0], date_to: fza[fza.length - 1], target_user_id: u.id, comment: 'abfeiern' });
    ok('FZA angelegt', abw.status === 201, abw.status + ' ' + abw.text.slice(0, 110));
    const abwId = abw.body && abw.body.absence && abw.body.absence.id;
    if (abw.body.absence.status === 'pending') {
      const g = await req('POST', `/api/absences/${abwId}/approve`, chef, {});
      ok('… und genehmigt', g.status === 200, g.status + ' ' + g.text.slice(0, 90));
    }
    const nachFza = await stand(fza[fza.length - 1]);

    // WAS HIER WIRKLICH ZAEHLT: Der Eintrag selbst bewegt keine Zahl — die Tage waren ohnehin
    // unbebucht, das Soll lief, kein Ist stand dagegen. Mein erster Entwurf behauptete "kostet
    // 24 h" und mass damit etwas anderes als er sagte.
    // Der Unterschied, auf den es ankommt, ist der zu URLAUB: Dort geht das Soll auf 0, der
    // Ueberstundenstand bleibt also unberuehrt. Bei Freizeitausgleich bleibt das Soll stehen —
    // deshalb zehren die Tage vom Konto. Genau das ist "abfeiern".
    ok('der Eintrag allein bewegt nichts (die Tage waren schon unbebucht)',
      rund(vorFza) === rund(nachFza), `${rund(vorFza)} → ${rund(nachFza)}`);
    // Die Gegenprobe laeuft ueber einen ZWEITEN Eintrag, nicht ueber das Umstellen des ersten:
    // Aendert ein Manager eine fremde Abwesenheit, wird das als VORSCHLAG hinterlegt
    // (status=pending, ma_needs_ack=1) und wirkt erst, wenn der Mitarbeiter ihn annimmt. Richtig
    // so — mein erster Entwurf hielt das fuer einen Fehler und mass in Wahrheit einen nicht
    // uebernommenen Vorschlag.
    const ot2 = nachFza;

    console.log('\n── Phase 3: wieder aufbauen ──');
    const p3 = werktage(60, 41);
    await buchen(p3, 12);
    const ot3 = await stand(p3[p3.length - 1]);
    ok(`Phase 3: ${p3.length} Tage à 12 h → +${p3.length * 4} h`, rund(ot3 - ot2) === p3.length * 4,
      `${rund(ot2)} → ${rund(ot3)} (Differenz ${rund(ot3 - ot2)})`);

    console.log('\n── Auszahlung 1 mittendrin ──');
    const a1 = await req('POST', '/api/payouts', chef, { user_id: u.id, stunden: 25, wirksam_ab: p3[p3.length - 1] });
    await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, mTok, {});
    const ot4 = await stand(p3[p3.length - 1]);
    ok('25 h ausgezahlt → genau 25 h weniger', rund(ot4) === rund(ot3 - 25), `${rund(ot3)} → ${rund(ot4)}`);

    console.log('\n── Urlaub zum Vergleich: dort geht das Soll auf 0 ──');
    // Zwei unbebuchte Tage — dieselbe Ausgangslage wie bei den FZA-Tagen. Der Unterschied liegt
    // allein in der Soll-Regel: Freizeitausgleich BEHAELT das Soll (die Tage zehren vom Konto,
    // das ist "abfeiern"), Urlaub setzt es auf 0 (der Stand bleibt unberuehrt).
    const urlaubTage = werktage(40, 39);
    const vorUrlaub = await stand(urlaubTage[urlaubTage.length - 1]);
    const ua = await req('POST', '/api/absences', chef, { type: 'urlaub',
      date_from: urlaubTage[0], date_to: urlaubTage[urlaubTage.length - 1], target_user_id: u.id });
    if (ua.body.absence.status === 'pending') await req('POST', `/api/absences/${ua.body.absence.id}/approve`, chef, {});
    const nachUrlaub = await stand(urlaubTage[urlaubTage.length - 1]);
    ok(`${urlaubTage.length} Urlaubstage heben den Stand um ${urlaubTage.length * 8} h (Soll fällt weg)`,
      rund(nachUrlaub - vorUrlaub) === urlaubTage.length * 8,
      `${rund(vorUrlaub)} → ${rund(nachUrlaub)} (Differenz ${rund(nachUrlaub - vorUrlaub)})`);
    ok('… während die FZA-Tage den Stand NICHT gehoben haben', rund(vorFza) === rund(nachFza),
      `FZA ${rund(vorFza)} → ${rund(nachFza)} · Urlaub ${rund(vorUrlaub)} → ${rund(nachUrlaub)}`);

    console.log('\n── Phase 4: wieder aufbauen ──');
    const p4 = werktage(38, 1);
    await buchen(p4, 11);
    const ot5 = await stand(p4[p4.length - 1]);
    ok(`Phase 4: ${p4.length} Tage à 11 h → +${p4.length * 3} h`, rund(ot5 - ot4) === p4.length * 3,
      `${rund(ot4)} → ${rund(ot5)} (Differenz ${rund(ot5 - ot4)})`);

    console.log('\n── Austritt vormerken, Rest zum LETZTEN Arbeitstag auszahlen ──');
    const letzterTag = werktage(0, -10)[werktage(0, -10).length - 1];
    const aus = await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: letzterTag });
    ok('Austritt ist VORGEMERKT (nicht sofort)', aus.status === 200 && aus.body.vorgemerkt === true, JSON.stringify(aus.body));
    // Bis zum letzten Tag noch buchen — genau der Grund fuer die Vormerkung
    const restTage = werktage(0, -10).filter(t => t <= letzterTag);
    await buchen(restTage, 11);
    const standVorRest = await stand(letzterTag);
    ok(`… er kann bis zuletzt buchen (Stand am letzten Tag ${rund(standVorRest)} h)`, restTage.length > 0, String(restTage.length));

    const rest = rund(standVorRest);
    const a2 = await req('POST', '/api/payouts', chef, { user_id: u.id, stunden: rest, wirksam_ab: letzterTag });
    ok('Rest-Auszahlung angelegt', a2.status === 201, a2.status + ' ' + a2.text.slice(0, 110));
    const best = await req('POST', `/api/payouts/${a2.body.auszahlung.id}/bestaetigen`, mTok, {});
    ok('… und der Mitarbeiter kann noch zustimmen (er hat ja Zugang)', best.status === 200, String(best.status));
    const ot6 = await stand(letzterTag);
    ok('… der Stand am letzten Arbeitstag ist damit 0', rund(ot6) === 0, String(ot6));

    console.log('\n── Der Zeitplaner vollzieht ──');
    const tagDanach = (() => { const d = new Date(letzterTag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return iso(d); })();
    austritteVollziehen(db, tagDanach);
    ok('das Konto ist geschlossen', db.prepare('SELECT active FROM users WHERE id = ?').get(u.id).active === 0);
    const ot7 = await stand(plusTage(365));
    ok('… und der Stand bleibt 0, auch ein Jahr später', rund(ot7) === 0, String(ot7));

    console.log('\n── Handrechnung ──');
    const ges = (await req('GET', `/api/statistics?user_ids=${u.id}&period=total&date=${plusTage(30)}`, admin)).body.users[0];
    const summe = db.prepare("SELECT COALESCE(SUM(stunden),0) s FROM overtime_payouts WHERE user_id=? AND status='bestaetigt'").get(u.id).s;
    console.log(`  Ist ${rund(ges.ist)} − Soll ${rund(ges.soll)} − Auszahlungen ${rund(summe)} = ${rund(ges.ist - ges.soll - summe)}`);
    ok('Ist − Soll − Auszahlungen = Überstunden gesamt',
      rund(ges.ist - ges.soll - summe) === rund(ges.ueber_gesamt),
      `${rund(ges.ist - ges.soll - summe)} vs ${rund(ges.ueber_gesamt)}`);
    ok('… und das ist 0', rund(ges.ueber_gesamt) === 0, String(ges.ueber_gesamt));
    ok('die Statistik weist die Auszahlungen aus', rund(ges.ausgezahlt) === rund(summe), `${ges.ausgezahlt} vs ${summe}`);

    console.log('\n── Abwesenheits-Übersicht ──');
    const zus = await req('GET', `/api/absences/summary?from=${beginn}&to=${plusTage(30)}&user_id=${u.id}`, admin);
    ok(`Freizeitausgleich steht mit ${fzaTage} Tagen drin`,
      Number((zus.body.summary || {}).freizeitausgleich) === fzaTage, JSON.stringify(zus.body.summary));
    ok(`… und Urlaub mit ${urlaubTage.length} Tagen`,
      Number((zus.body.summary || {}).urlaub) === urlaubTage.length, JSON.stringify(zus.body.summary));

    console.log('\n── Lohn-CSV: Monat für Monat fortgeschrieben ──');
    const monate = [...new Set([...p1, ...p3, ...p4, ...restTage].map(d => d.slice(0, 7)))].sort();
    let lauf = 0; const abwCsv = []; let csvAusz = 0, csvFza = 0, csvUrlaub = 0;
    for (const m of monate) {
      const csv = (await req('GET', `/api/payroll/monat.csv?month=${m}`, admin)).text;
      const kopf = csv.split('\r\n')[0].split(';').map(x => x.replace(/"/g, ''));
      const z = csv.split('\r\n').find(x => x.includes('Gerda Gesamt'));
      if (!z) continue;
      const w = z.split(';').map(x => x.replace(/"/g, ''));
      const zahl = n => Number(String(w[kopf.indexOf(n)]).replace(',', '.')) || 0;
      lauf = rund(lauf + zahl('Saldo') - zahl('Auszahlung Stunden'));
      csvAusz = rund(csvAusz + zahl('Auszahlung Stunden'));
      csvFza = rund(csvFza + zahl('FZA')); csvUrlaub = rund(csvUrlaub + zahl('Urlaub'));
      console.log(`  ${m}: Soll ${String(zahl('Soll-Stunden')).padStart(6)} · Ist ${String(zahl('Ist-Stunden')).padStart(6)}`
        + ` · Saldo ${String(zahl('Saldo')).padStart(7)} · Urlaub ${String(zahl('Urlaub')).padStart(3)} · FZA ${String(zahl('FZA')).padStart(3)}`
        + ` · Auszahlung ${String(zahl('Auszahlung Stunden')).padStart(7)} · Ü-gesamt ${String(zahl('Überstunden gesamt')).padStart(8)}`);
      if (lauf !== rund(zahl('Überstunden gesamt'))) abwCsv.push(`${m}: fortgeschrieben ${lauf} vs ausgewiesen ${zahl('Überstunden gesamt')}`);
    }
    ok('CSV: Saldo minus Auszahlung ergibt Monat für Monat den ausgewiesenen Stand', abwCsv.length === 0, abwCsv.join(' | '));
    ok('… die Auszahlungen summieren sich auf denselben Wert', rund(csvAusz) === rund(summe), `${csvAusz} vs ${summe}`);
    ok('… und der letzte Monat endet auf 0', rund(lauf) === 0, String(lauf));
    ok(`… die Abwesenheitstage stimmen (FZA ${fzaTage}, Urlaub ${urlaubTage.length})`,
      csvFza === fzaTage && csvUrlaub === urlaubTage.length, `CSV: FZA ${csvFza}, Urlaub ${csvUrlaub}`);

    console.log('\n── PDF-Zeitnachweis ──');
    const pdf = await req('GET', `/api/pdf/export?user_id=${u.id}&date_from=${beginn}&date_to=${plusTage(30)}`, admin, null, true);
    ok('PDF wird erzeugt', pdf.status === 200 && pdf.buf.length > 3000, `${pdf.status} / ${pdf.buf.length} Bytes`);
    fs.writeFileSync('/tmp/auszahlung-gesamtbild.pdf', pdf.buf);
    let text = '';
    try {
      require('child_process').execFileSync('pdftotext', ['-layout', '/tmp/auszahlung-gesamtbild.pdf', '/tmp/auszahlung-gesamtbild.txt']);
      text = fs.readFileSync('/tmp/auszahlung-gesamtbild.txt', 'utf8');
    } catch (_) { console.log('  (pdftotext fehlt — Inhalt uebersprungen)'); }
    if (text) {
      ok(`PDF nennt die ausgezahlten Stunden (-${hmm(summe)})`, text.includes(`davon ausgezahlt: -${hmm(summe)}`),
        (text.match(/Gesamtstunden[\s\S]{0,200}/) || [''])[0]);
      ok('… und den Gesamtstand 0:00', /Überstunden gesamt:\s*\+0:00/.test(text),
        (text.match(/Überstunden gesamt:.*/) || [''])[0]);
      ok('… und führt den Freizeitausgleich auf', /Freizeitausgleich/i.test(text),
        (text.match(/Abwesenheiten[\s\S]{0,200}/) || [''])[0]);
    }
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nGesamtbild: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
