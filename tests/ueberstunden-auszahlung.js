// Überstunden auszahlen — Routen, Rechnung und die Regeln drumherum.
//
// Die drei Entscheidungen, die hier abgesichert werden (Alex, 06.09.2026):
//   * Ein Wunschtag in einem abgeschlossenen Monat wird auf den ersten offenen Tag GEZOGEN —
//     nicht abgewiesen und nicht rückwirkend verbucht. Ein Abschluss, der sich nachträglich
//     bewegt, wäre das Gegenteil von revisionssicher.
//   * Mehr Stunden als vorhanden werden GEWARNT, aber zugelassen. Ein Minus kann gewollt sein.
//   * Auszahlung geht jederzeit, nicht nur beim Austritt.
//
// Und der Punkt, an dem am meisten hängt: NUR eine bestätigte Auszahlung bewegt eine Zahl.
// Solange der Mitarbeiter nicht zugestimmt hat, sind die Stunden noch da.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]): ein zweiter Prozess auf derselben Datei hätte
// eine eigene Kopie im Speicher, und die Autosave-Takte überschrieben sich gegenseitig.
//
//   node tests/ueberstunden-auszahlung.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/ueberstunden-auszahlung.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const { auszahlungenSumme, offeneSumme } = require('../auszahlung');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let PORT = 0;
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Relativ zu heute ([[reference_tests_zeitfallen]]).
const heute = new Date().toLocaleDateString('sv-SE');
const plus = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const rund = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/entries', require('../routes/entries'));
  app.use('/api/statistics', require('../routes/statistics'));
  app.use('/api/payroll', require('../routes/payroll'));
  app.use('/api/closure', require('../routes/closure'));
  app.use('/api/payouts', require('../routes/payouts'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const anSeed = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PWSEED })).body.token;
    const admin = await anSeed('admin'), chef = await anSeed('chef');
    const PW = 'Auszahl!2345';

    const anlegen = async (benutzer, name) => (await req('POST', '/api/users', admin, {
      username: benutzer, password: PW, name, role: 'mitarbeiter', target_hours_per_week: 40,
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    const anMit = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PW })).body.token;
    const stand = async (id) => (await req('GET', `/api/statistics/overtime?user_id=${id}&date_to=${plus(400)}`, admin)).body.overtime;

    console.log('── Aufbau: ein Mitarbeiter mit Überstundenbestand ──');
    const m = await anlegen('auszahl', 'Otto Auszahl');
    const mTok = await anMit('auszahl');
    // Start-Ueberstunden setzen statt Stunden zu buchen: schneller und unabhaengig davon, auf
    // welchen Wochentag "heute" faellt.
    db.prepare('UPDATE users SET start_overtime = 100 WHERE id = ?').run(m.id);
    ok('Aufbau: Konto steht', !!m && !!mTok, JSON.stringify(m && m.id));
    const start = await stand(m.id);
    ok('… mit einem Ausgangsstand', typeof start === 'number', String(start));

    console.log('\n── Eine offene Anfrage bewegt KEINE Zahl ──');
    const a1 = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 40, wirksam_ab: heute });
    ok('Chef kann eine Auszahlung anlegen', a1.status === 201, a1.status + ' ' + a1.text.slice(0, 120));
    ok('… sie ist zunächst offen', a1.body && a1.body.auszahlung && a1.body.auszahlung.status === 'offen',
      JSON.stringify(a1.body && a1.body.auszahlung));
    ok('… der Überstundenstand ist unverändert', rund(await stand(m.id)) === rund(start),
      `${start} → ${await stand(m.id)}`);
    ok('… wird aber als offen ausgewiesen', rund(offeneSumme(db, m.id)) === 40, String(offeneSumme(db, m.id)));

    console.log('\n── Nur der Mitarbeiter selbst entscheidet ──');
    const fremd = await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, chef, {});
    ok('der Chef kann NICHT für ihn bestätigen', fremd.status === 403, fremd.status + ' ' + fremd.text.slice(0, 90));
    const adminVersuch = await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, admin, {});
    ok('… der Admin auch nicht', adminVersuch.status === 403, adminVersuch.status + ' ' + adminVersuch.text.slice(0, 90));

    console.log('\n── Erst die Bestätigung rechnet ──');
    const best = await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, mTok, {});
    ok('der Mitarbeiter bestätigt', best.status === 200, best.status + ' ' + best.text.slice(0, 90));
    ok('… jetzt sinkt der Stand um genau 40', rund(await stand(m.id)) === rund(start - 40),
      `${start} → ${await stand(m.id)} (erwartet ${rund(start - 40)})`);
    ok('… und nichts steht mehr offen', offeneSumme(db, m.id) === 0, String(offeneSumme(db, m.id)));
    const nochmal = await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, mTok, {});
    ok('… ein zweites Bestätigen wird abgewiesen', nochmal.status === 409, String(nochmal.status));

    console.log('\n── Vor dem wirksam_ab zählt sie nicht ──');
    // MESSFEHLER, den der erste Entwurf hatte: Zwei verschiedene Stichtage miteinander zu
    // vergleichen sagt nichts — zwischen ihnen laeuft auch das SOLL weiter, der Unterschied war
    // 26 statt der erwarteten 10. Richtig ist, DENSELBEN Stichtag vorher und nachher zu messen.
    const otAn = async (tag) => (await req('GET', `/api/statistics/overtime?user_id=${m.id}&date_to=${tag}`, admin)).body.overtime;
    const davorFrueh = await otAn(plus(29));
    const davorSpaet = await otAn(plus(31));
    const spaeter = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 10, wirksam_ab: plus(30) });
    await req('POST', `/api/payouts/${spaeter.body.auszahlung.id}/bestaetigen`, mTok, {});
    ok('am Tag VOR dem Wirksamwerden aendert sich nichts', rund(await otAn(plus(29))) === rund(davorFrueh),
      `${davorFrueh} → ${await otAn(plus(29))}`);
    ok('… am Tag danach sind es genau 10 weniger', rund(await otAn(plus(31))) === rund(davorSpaet - 10),
      `${davorSpaet} → ${await otAn(plus(31))}`);
    ok('… die Summenfunktion sieht das genauso',
      rund(auszahlungenSumme(db, m.id, plus(29))) === 40 && rund(auszahlungenSumme(db, m.id, plus(31))) === 50,
      `${auszahlungenSumme(db, m.id, plus(29))} / ${auszahlungenSumme(db, m.id, plus(31))}`);

    console.log('\n── Ablehnen braucht einen Grund ──');
    const a2 = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 5, wirksam_ab: heute });
    const ohne = await req('POST', `/api/payouts/${a2.body.auszahlung.id}/ablehnen`, mTok, { grund: '' });
    ok('ohne Grund wird abgewiesen', ohne.status === 400, ohne.status + ' ' + ohne.text.slice(0, 90));
    const vorAblehnung = await stand(m.id);
    const mitGrund = await req('POST', `/api/payouts/${a2.body.auszahlung.id}/ablehnen`, mTok, { grund: 'lieber abfeiern' });
    ok('mit Grund geht es', mitGrund.status === 200, mitGrund.status + ' ' + mitGrund.text.slice(0, 90));
    ok('… und eine abgelehnte bewegt nichts', rund(await stand(m.id)) === rund(vorAblehnung),
      `${vorAblehnung} → ${await stand(m.id)}`);

    console.log('\n── Zurückziehen kann nur der Chef, und nur solange offen ist ──');
    const a3 = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 7, wirksam_ab: heute });
    const maZieht = await req('POST', `/api/payouts/${a3.body.auszahlung.id}/zurueckziehen`, mTok, {});
    ok('der Mitarbeiter kann nicht zurückziehen', maZieht.status === 403, String(maZieht.status));
    const zieht = await req('POST', `/api/payouts/${a3.body.auszahlung.id}/zurueckziehen`, chef, {});
    ok('der Chef kann es', zieht.status === 200, zieht.status + ' ' + zieht.text.slice(0, 90));
    const nochmalZiehen = await req('POST', `/api/payouts/${a3.body.auszahlung.id}/zurueckziehen`, chef, {});
    ok('… aber kein zweites Mal', nochmalZiehen.status === 409, String(nochmalZiehen.status));

    console.log('\n── Nur EINE offene Anfrage je Mitarbeiter ──');
    // Sonst könnte man dieselben Stunden mehrfach verplanen, ohne dass es auffällt.
    const b1 = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 3, wirksam_ab: heute });
    const b2 = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 3, wirksam_ab: heute });
    ok('die zweite offene wird abgewiesen', b2.status === 409, b2.status + ' ' + b2.text.slice(0, 90));
    await req('POST', `/api/payouts/${b1.body.auszahlung.id}/zurueckziehen`, chef, {});

    console.log('\n── Mehr Stunden als vorhanden: warnen, aber zulassen ──');
    // Absolut gross statt "Stand + 500": Der Stand kann negativ sein, dann waere die Summe
    // kleiner als 0 und die Route wiese sie aus einem ganz anderen Grund ab.
    const zuViel = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 100000, wirksam_ab: heute });
    ok('wird angenommen', zuViel.status === 201, zuViel.status + ' ' + zuViel.text.slice(0, 90));
    ok('… mit einer Warnung', (zuViel.body.warnungen || []).some(w => /mehr Stunden als der aktuelle Stand/i.test(w)),
      JSON.stringify(zuViel.body.warnungen));
    await req('POST', `/api/payouts/${zuViel.body.auszahlung.id}/zurueckziehen`, chef, {});

    console.log('\n── Der Unterschriftsweg ist überall erkennbar ──');
    const unter = await req('POST', '/api/payouts', chef, {
      user_id: m.id, stunden: 6, wirksam_ab: heute, belegweg: 'unterschrift' });
    ok('wird sofort als bestätigt angelegt', unter.body.auszahlung.status === 'bestaetigt',
      JSON.stringify(unter.body.auszahlung));
    ok('… und ist als Unterschrift gekennzeichnet',
      unter.body.auszahlung.belegweg === 'unterschrift' && unter.body.auszahlung.per_unterschrift === true,
      JSON.stringify(unter.body.auszahlung));
    const protokoll = db.prepare("SELECT details FROM audit_logs WHERE action = 'overtime_payout_signed' ORDER BY id DESC LIMIT 1").get();
    ok('… auch im Protokoll', !!protokoll && /unterschrieben/i.test(protokoll.details), JSON.stringify(protokoll));

    console.log('\n── Ein abgeschlossener Monat wird nicht rückwirkend bewegt ──');
    // Den Vormonat abschliessen und dann versuchen, in ihn hinein auszuzahlen.
    const vormonat = (() => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCDate(0);
      return d.toISOString().slice(0, 7); })();
    const abschluss = await req('POST', '/api/closure', chef, { month: vormonat });
    ok('Vormonat abgeschlossen', abschluss.status === 200 || abschluss.status === 201,
      abschluss.status + ' ' + abschluss.text.slice(0, 120));
    const rueck = await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 4, wirksam_ab: `${vormonat}-15` });
    ok('eine Auszahlung in den abgeschlossenen Monat wird angenommen', rueck.status === 201,
      rueck.status + ' ' + rueck.text.slice(0, 120));
    ok('… aber auf den ersten offenen Tag gezogen', rueck.body.auszahlung.wirksam_ab > `${vormonat}-31`,
      JSON.stringify(rueck.body.auszahlung.wirksam_ab));
    ok('… und die Verschiebung wird gesagt',
      (rueck.body.warnungen || []).some(w => /abgeschlossen/i.test(w)), JSON.stringify(rueck.body.warnungen));
    const prot2 = db.prepare("SELECT details FROM audit_logs WHERE action = 'overtime_payout_create' ORDER BY id DESC LIMIT 1").get();
    ok('… der ursprünglich gewünschte Tag steht im Protokoll',
      !!prot2 && prot2.details.includes(`${vormonat}-15`), JSON.stringify(prot2));

    console.log('\n── Sichtbarkeit ──');
    const eigene = await req('GET', '/api/payouts', mTok);
    ok('der Mitarbeiter sieht seine eigenen', eigene.status === 200 && (eigene.body.auszahlungen || []).length > 0,
      String(eigene.status));
    ok('… und ausschließlich seine eigenen',
      (eigene.body.auszahlungen || []).every(z => z.user_id === m.id), JSON.stringify((eigene.body.auszahlungen || []).map(z => z.user_id)));
    const andererId = (await anlegen('anderer', 'Anna Anders')).id;
    const fremdListe = await req('GET', `/api/payouts?user_id=${andererId}`, mTok);
    ok('… fremde nicht einmal auf Nachfrage', fremdListe.status === 403, String(fremdListe.status));
    const alle = await req('GET', '/api/payouts', chef);
    ok('der Chef sieht alle', alle.status === 200 && (alle.body.auszahlungen || []).length > 0, String(alle.status));

    console.log('\n── Ausstellen: nicht blockieren, aber nichts haengen lassen ──');
    // Alex, 06.09.2026: "Die Ueberstunden koennen doch auch mitgenommen werden." Der Austritt ist
    // eine arbeitsrechtliche Tatsache und darf nicht daran haengen, ob in der App eine Anfrage
    // offenliegt. Ohne das automatische Zurueckziehen haenge sie aber FUER IMMER — zustimmen darf
    // nur der Betroffene, und der kommt nicht mehr hinein.
    const g = await anlegen('gehtweg', 'Gustav Gehtweg');
    const anfrage = await req('POST', '/api/payouts', chef, { user_id: g.id, stunden: 12, wirksam_ab: heute });
    ok('Aufbau: eine offene Anfrage steht', anfrage.status === 201, String(anfrage.status));

    const aus = await req('POST', `/api/users/${g.id}/deactivate`, chef, { employed_until: heute });
    ok('Ausstellen wird NICHT blockiert', aus.status === 200, aus.status + ' ' + aus.text.slice(0, 120));
    ok('… das Konto ist zu', db.prepare('SELECT active FROM users WHERE id = ?').get(g.id).active === 0);

    const danach = db.prepare('SELECT status FROM overtime_payouts WHERE user_id = ?').get(g.id);
    ok('… die offene Anfrage ist zurückgezogen, haengt also nicht ewig',
      danach && danach.status === 'zurueckgezogen', JSON.stringify(danach));
    // MESSFEHLER des ersten Entwurfs: Den Ueberstundenstand vor und nach dem Ausstellen zu
    // vergleichen sagt hier nichts — das Ausstellen beendet den Anstellungszeitraum, damit hoert
    // auch das SOLL auf zu laufen und die Zahl aendert sich aus einem ganz anderen Grund.
    // Die Behauptung "die Stunden bleiben stehen" heisst genau: es wird keine Auszahlung gerechnet.
    ok('… und die Stunden bleiben stehen (keine Auszahlung zaehlt)',
      auszahlungenSumme(db, g.id, plus(400)) === 0, String(auszahlungenSumme(db, g.id, plus(400))));
    const protAus = db.prepare("SELECT details FROM audit_logs WHERE action = 'overtime_payout_auto_withdraw' ORDER BY id DESC LIMIT 1").get();
    ok('… und es steht im Protokoll', !!protAus && /12 h/.test(protAus.details), JSON.stringify(protAus));

    console.log('\n── Unsinn wird abgewiesen ──');
    ok('0 Stunden', (await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 0, wirksam_ab: heute })).status === 400);
    ok('negative Stunden', (await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: -5, wirksam_ab: heute })).status === 400);
    ok('krummes Datum', (await req('POST', '/api/payouts', chef, { user_id: m.id, stunden: 5, wirksam_ab: 'gestern' })).status === 400);
    ok('unbekannter Mitarbeiter', (await req('POST', '/api/payouts', chef, { user_id: 999999, stunden: 5, wirksam_ab: heute })).status === 404);
    ok('ein Mitarbeiter kann keine anlegen',
      (await req('POST', '/api/payouts', mTok, { user_id: m.id, stunden: 5, wirksam_ab: heute })).status === 403);
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    server.close();
  }

  console.log(`\nÜberstunden-Auszahlung: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
