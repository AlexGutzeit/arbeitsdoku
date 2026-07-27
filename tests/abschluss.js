// Abrechnungs-Abschluss: Wächter, Abschluss-Ablauf und Admin-Ausweg.
//
// Prüft über HTTP, also genau so, wie ein Browser (oder ein direkter API-Aufruf) es täte —
// Ausgrauen im Formular allein wäre keine Sperre.
//
// Die drei Gruppen aus der Erkundung:
//   A) Datum steht im Aufruf          (Eintrag anlegen/ändern, Abwesenheit, Soll-Stunden, Austritt)
//   B) Datum nur in der Datenbankzeile (löschen, wiederherstellen, genehmigen, ablehnen)
//   C) gar kein Datum, wirkt über alles (Start-Überstunden, Wochenstunden, Anfangs-Resturlaub)
//   node tests/abschluss.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3158, DB = '/tmp/abschluss-test.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JAHR = new Date().getFullYear() - 1;
const GESPERRT = `${JAHR}-01-15`;          // liegt im abzuschließenden Januar
const OFFEN = `${JAHR}-06-15`;             // weit nach dem Stichtag
const GRUND = 'Krankmeldung wurde nachgereicht';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/abschluss-srv.log', 'utf8');
    const pw = (n) => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmelden = async (n) => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body.token;
    const admin = await anmelden('admin'), chef = await anmelden('chef'), max = await anmelden('max');
    ok('angemeldet', !!(admin && chef && max));

    const maxId = (await req('GET', '/api/auth/me', max)).body.user.id;

    // Soll-Stunden ab Jahresbeginn, damit es überhaupt einen Anstellungsbeginn gibt
    await req('POST', `/api/statistics/targets/${maxId}`, chef,
      { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${JAHR}-01-01` });

    // Zwei Einträge: einer im später gesperrten Januar, einer im offenen Juni
    const e1 = (await req('POST', '/api/entries', max, { date: GESPERRT, time_from: '07:00', time_to: '15:30', break_minutes: 30 })).body.entry;
    const e2 = (await req('POST', '/api/entries', max, { date: OFFEN, time_from: '07:00', time_to: '15:30', break_minutes: 30 })).body.entry;
    ok('Vorbereitung: zwei Einträge angelegt', !!(e1 && e2));

    // Dritter Eintrag im Januar, VOR dem Abschluss gelöscht: Er liegt danach im Papierkorb und
    // ist der eigentliche Prüfstein — Wiederherstellen holt ihn zurück in den bezahlten Monat.
    const imPapierkorb = (await req('POST', '/api/entries', max, { date: `${JAHR}-01-22`, time_from: '07:00', time_to: '12:00', break_minutes: 0 })).body.entry;
    await req('DELETE', `/api/entries/${imPapierkorb.id}`, max, {});

    // ── Abschließen ────────────────────────────────────────────────────────────────────────
    const zuFrueh = await req('POST', '/api/closure', chef, { month: `${JAHR}-02` });
    ok('Lücken sind nicht erlaubt (Februar vor Januar)', zuFrueh.status === 409, `${zuFrueh.status} ${zuFrueh.body?.error || ''}`);

    const laufend = await req('POST', '/api/closure', chef, { month: new Date().toISOString().slice(0, 7) });
    ok('laufender Monat lässt sich nicht abschließen', laufend.status === 409 || laufend.status === 400, String(laufend.status));

    const vomMa = await req('POST', '/api/closure', max, { month: `${JAHR}-01` });
    ok('Mitarbeiter darf nicht abschließen', vomMa.status === 403, String(vomMa.status));

    // Offener Antrag im Zeitraum blockiert den Abschluss
    const antrag = (await req('POST', '/api/absences', max, { type: 'urlaub', date_from: `${JAHR}-01-20`, date_to: `${JAHR}-01-21` })).body.absence;
    const mitAntrag = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
    ok('offener Antrag verhindert den Abschluss', mitAntrag.status === 409 && /Antrag/i.test(mitAntrag.body?.error || ''), `${mitAntrag.status} ${mitAntrag.body?.error || ''}`);
    ok('die betroffenen Anträge werden mitgeliefert', Array.isArray(mitAntrag.body?.offen) && mitAntrag.body.offen.length === 1);
    await req('POST', `/api/absences/${antrag.id}/approve`, chef);

    const zu = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
    ok('Chef schließt den Januar ab', zu.status === 201, `${zu.status} ${zu.body?.error || ''}`);
    const stand = await req('GET', '/api/closure', max);
    ok('Stichtag ist gesetzt', stand.body?.bis === `${JAHR}-01-31`, String(stand.body?.bis));
    ok('Mitarbeiter sieht seine eigenen abgerechneten Zahlen',
      (stand.body?.perioden?.[0]?.zeilen || []).length === 1, JSON.stringify(stand.body?.perioden?.[0]?.zeilen || []).slice(0, 120));

    // ── Gruppe A: Datum steht im Aufruf ────────────────────────────────────────────────────
    const neuGesperrt = await req('POST', '/api/entries', max, { date: GESPERRT, time_from: '08:00', time_to: '09:00', break_minutes: 0 });
    ok('A: Eintrag im gesperrten Zeitraum anlegen wird abgewiesen', neuGesperrt.status === 403, `${neuGesperrt.status} ${neuGesperrt.body?.error || ''}`);
    ok('A: die Meldung nennt den Stichtag', /abgerechnet/i.test(neuGesperrt.body?.error || '') && /31\.01\./.test(neuGesperrt.body?.error || ''), neuGesperrt.body?.error);

    const neuOffen = await req('POST', '/api/entries', max, { date: OFFEN, time_from: '08:00', time_to: '09:00', break_minutes: 0 });
    ok('A: nach dem Stichtag bleibt alles normal', neuOffen.status === 201, String(neuOffen.status));

    const aendern = await req('PUT', `/api/entries/${e1.id}`, max, { time_from: '07:00', time_to: '16:00' });
    ok('A: gesperrten Eintrag ändern wird abgewiesen', aendern.status === 403, String(aendern.status));

    // Der Kniff: aus dem gesperrten Zeitraum HERAUSschieben — altes Datum muss mitgeprüft werden
    const rausschieben = await req('PUT', `/api/entries/${e1.id}`, max, { date: OFFEN });
    ok('A: Herausschieben aus dem gesperrten Zeitraum wird abgewiesen', rausschieben.status === 403, String(rausschieben.status));
    // …und HINEIN schieben ebenso
    const reinschieben = await req('PUT', `/api/entries/${e2.id}`, max, { date: GESPERRT });
    ok('A: Hineinschieben in den gesperrten Zeitraum wird abgewiesen', reinschieben.status === 403, String(reinschieben.status));

    const abwGesperrt = await req('POST', '/api/absences', max, { type: 'krank', date_from: `${JAHR}-01-05`, date_to: `${JAHR}-01-06` });
    ok('A: Abwesenheit im gesperrten Zeitraum wird abgewiesen', abwGesperrt.status === 403, String(abwGesperrt.status));

    const sollRueck = await req('POST', `/api/statistics/targets/${maxId}`, chef,
      { hours_mon: 4, hours_tue: 4, hours_wed: 4, hours_thu: 4, hours_fri: 4, valid_from: `${JAHR}-01-10` });
    ok('A: rückdatierte Soll-Stunden werden abgewiesen', sollRueck.status === 403, String(sollRueck.status));

    const austritt = await req('POST', `/api/users/${maxId}/deactivate`, chef, { employed_until: GESPERRT });
    ok('A: rückdatierter Austritt wird abgewiesen', austritt.status === 403, String(austritt.status));

    // ── Gruppe B: Datum nur in der Datenbankzeile ──────────────────────────────────────────
    const loeschen = await req('DELETE', `/api/entries/${e1.id}`, max, {});
    ok('B: gesperrten Eintrag löschen wird abgewiesen', loeschen.status === 403, String(loeschen.status));

    const genehmigen = await req('POST', `/api/absences/${antrag.id}/approve`, chef, {});
    ok('B: Antrag im gesperrten Zeitraum genehmigen wird abgewiesen', genehmigen.status === 403, String(genehmigen.status));
    const ablehnen = await req('POST', `/api/absences/${antrag.id}/reject`, chef, {});
    ok('B: Antrag im gesperrten Zeitraum ablehnen wird abgewiesen', ablehnen.status === 403, String(ablehnen.status));

    const zurueck = await req('POST', `/api/entries/${imPapierkorb.id}/restore`, max, {});
    ok('B: aus dem Papierkorb zurück in den gesperrten Zeitraum wird abgewiesen',
      zurueck.status === 403, `${zurueck.status} ${zurueck.body?.error || ''}`);

    // Gegenprobe, damit die Sperre nicht einfach ALLES abweist:
    const e3 = (await req('POST', '/api/entries', admin, { date: OFFEN, time_from: '10:00', time_to: '11:00', break_minutes: 0, user_id: maxId })).body.entry;
    await req('DELETE', `/api/entries/${e3.id}`, max, {});
    const wieder = await req('POST', `/api/entries/${e3.id}/restore`, max, {});
    ok('B: Wiederherstellen im offenen Zeitraum bleibt erlaubt', wieder.status === 200, String(wieder.status));

    // Und der Admin kommt auch hier mit Begründung durch:
    const zurueckAdmin = await req('POST', `/api/entries/${imPapierkorb.id}/restore`, admin, { reason: GRUND });
    ok('B: Admin holt ihn mit Begründung doch zurück', zurueckAdmin.status === 200, `${zurueckAdmin.status} ${zurueckAdmin.body?.error || ''}`);

    // ── Gruppe C: kein Datum, wirkt über die ganze Historie ────────────────────────────────
    const otAendern = await req('PUT', `/api/users/${maxId}`, chef, { start_overtime: 99 });
    ok('C: Start-Überstunden ändern wird abgewiesen', otAendern.status === 403, `${otAendern.status} ${otAendern.body?.error || ''}`);

    const nurName = await req('PUT', `/api/users/${maxId}`, chef, { name: 'Max Neuer Name' });
    ok('C: eine reine Namensänderung bleibt erlaubt', nurName.status === 200, `${nurName.status} ${nurName.body?.error || ''}`);

    const carry = await req('PUT', `/api/statistics/vacation/${maxId}/start-carry`, chef, { days: 5 });
    ok('C: Anfangs-Resturlaub ändern wird abgewiesen', carry.status === 403, String(carry.status));

    // ── Der Ausweg: Admin mit Begründung ──────────────────────────────────────────────────
    const ohneGrund = await req('PUT', `/api/entries/${e1.id}`, admin, { time_to: '16:00' });
    ok('Ausweg: Admin OHNE Begründung kommt NICHT durch', ohneGrund.status === 400 || ohneGrund.status === 403, String(ohneGrund.status));

    const mitGrund = await req('PUT', `/api/entries/${e1.id}`, admin, { time_to: '16:00', reason: GRUND });
    ok('Ausweg: Admin MIT Begründung kommt durch', mitGrund.status === 200, `${mitGrund.status} ${mitGrund.body?.error || ''}`);

    const chefMitGrund = await req('PUT', `/api/entries/${e1.id}`, chef, { time_to: '17:00', reason: GRUND });
    ok('Ausweg: Chef kommt auch MIT Begründung nicht durch', chefMitGrund.status === 403, String(chefMitGrund.status));

    const auditTxt = (await req('GET', '/api/audit?limit=200', admin)).text;
    ok('Ausweg: der Eingriff steht im Audit-Log', /closure_override/.test(auditTxt), auditTxt.slice(0, 100));
    ok('Ausweg: die Begründung steht mit drin', auditTxt.includes(GRUND));

    // ── Abweichung ausweisen ──────────────────────────────────────────────────────────────
    const cid = (await req('GET', '/api/closure', chef)).body.perioden[0].id;
    const abw = await req('GET', `/api/closure/${cid}/abweichung`, chef);
    ok('die nachträgliche Korrektur wird als Abweichung ausgewiesen',
      abw.status === 200 && abw.body.abweichungen.length === 1, `${abw.status} ${JSON.stringify(abw.body?.abweichungen || []).slice(0, 200)}`);
    ok('die Abweichung nennt bezahlt und jetzt',
      !!(abw.body?.abweichungen?.[0]?.felder?.ist?.bezahlt !== undefined && abw.body.abweichungen[0].felder.ist.jetzt !== undefined),
      JSON.stringify(abw.body?.abweichungen?.[0] || {}).slice(0, 200));

    // ── Wieder öffnen ─────────────────────────────────────────────────────────────────────
    const chefOeffnet = await req('DELETE', `/api/closure/${cid}`, chef, { reason: GRUND });
    ok('nur der Admin darf wieder öffnen', chefOeffnet.status === 403, String(chefOeffnet.status));
    const ohneG = await req('DELETE', `/api/closure/${cid}`, admin, {});
    ok('Wiederöffnen ohne Begründung wird abgewiesen', ohneG.status === 400, String(ohneG.status));
    const auf = await req('DELETE', `/api/closure/${cid}`, admin, { reason: 'Korrektur der Januar-Abrechnung' });
    ok('Admin öffnet den Zeitraum wieder', auf.status === 200, `${auf.status} ${auf.body?.error || ''}`);
    const danach = await req('PUT', `/api/entries/${e1.id}`, max, { time_to: '16:30' });
    ok('nach dem Wiederöffnen ist der Zeitraum normal bearbeitbar', danach.status === 200, String(danach.status));

  } finally {
    srv.kill('SIGTERM'); await sleep(600);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAbschluss-Wächter: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
