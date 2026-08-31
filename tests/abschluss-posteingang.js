// Der Posteingang darf nach einem Abschluss nicht auf ewig verstopfen (Alex, 31.08.2026).
//
// „Was wenn jemand etwas in der Vergangenheit noch nicht akzeptiert oder quittiert hat und der
// abschluss gemacht wurde? Dann verschwindet dieser Eintrag nie mehr aus dem Posteingang."
//
// Der Fall war in den Produktivdaten bereits da: Abschluss bis 30.06.2026, und zwei Innung-Einträge
// von Jakob Wolf (26.–28.05. und 01.06.) warteten dauerhaft auf seine Quittierung.
//
// DIE REGEL, um die es hier geht: Der Abschluss schützt BEZAHLTE ZAHLEN, nicht Vorgänge. Gezählt
// werden nur Abwesenheiten mit Status 'active' oder 'approved' (routes/absence-days.js). Also:
//
//   erlaubt   quittieren (Chef wie Mitarbeiter)      – setzt nur ein Kennzeichen
//   erlaubt   ablehnen eines OFFENEN Antrags         – offen wie abgelehnt zählen beide nicht
//   gesperrt  genehmigen                             – der Tag zählt plötzlich
//   gesperrt  ablehnen eines GEZÄHLTEN Eintrags      – gezählte Tage fielen weg
//   gesperrt  einen Terminvorschlag annehmen         – übernimmt Daten und setzt 'approved'
//
// Beide Seiten werden geprüft. Nur „was jetzt geht" zu prüfen wäre gefährlich: Eine Sperre, die zu
// viel freigibt, verschiebt still bezahlte Stunden — und das fiele erst bei der Lohnabrechnung auf.
//
//   node tests/abschluss-posteingang.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3299, DB = '/tmp/abschluss-posteingang.db', LOG = '/tmp/abschluss-posteingang-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Ein abgeschlossener Monat im Vorjahr — weit genug weg, dass nichts mit „heute" kollidiert.
const JAHR = new Date().getFullYear() - 1;
const MONAT = `${JAHR}-03`;
const IM_MONAT = `${JAHR}-03-10`;
const DANACH  = `${JAHR}-12-15`;   // nach dem Stichtag, dient als Gegenprobe

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log) && /chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body.token;
    const admin = await an('admin'), chef = await an('chef');
    const PW = 'Abschl!2345';
    const ma = (await req('POST', '/api/users', admin, { username: 'moritz', password: PW, name: 'Moritz Meier',
      role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    const maTok = (await req('POST', '/api/auth/login', null, { username: 'moritz', password: PW })).body.token;

    // Die Vorgänge ANLEGEN, bevor abgeschlossen wird — genau so entsteht der Fall in echt.
    const krank = (await req('POST', '/api/absences', maTok, { type: 'krank', date_from: `${JAHR}-03-12`, date_to: `${JAHR}-03-12` })).body.absence;
    const urlaubSpaeter = (await req('POST', '/api/absences', maTok, { type: 'urlaub', date_from: DANACH, date_to: DANACH })).body.absence;
    ok('Aufbau: eine Krankmeldung im Monat', !!krank && krank.status === 'active', JSON.stringify(krank && krank.status));
    ok('Aufbau: ein offener Urlaub NACH dem Stichtag', !!urlaubSpaeter, JSON.stringify(urlaubSpaeter && urlaubSpaeter.id));
    // Ein bereits genehmigter Eintrag im Monat — an ihm wird das GESPERRTE Ablehnen geprüft.
    const genehmigt = (await req('POST', '/api/absences', maTok, { type: 'urlaub', date_from: `${JAHR}-03-17`, date_to: `${JAHR}-03-17` })).body.absence;
    await req('POST', `/api/absences/${genehmigt.id}/approve`, chef);
    // Ein Eintrag, den der MITARBEITER quittieren muss (Manager-Eintrag ohne Terminvorschlag).
    // Der rutscht durch die Abschluss-Prüfung — sie sieht nur `status = 'pending'`.
    const fuerMa = (await req('POST', '/api/absences', chef, { target_user_id: ma.id, type: 'innung',
      date_from: `${JAHR}-03-24`, date_to: `${JAHR}-03-25` })).body.absence;
    ok('Aufbau: ein Eintrag, den der Mitarbeiter quittieren muss', !!fuerMa, JSON.stringify(fuerMa && fuerMa.id));

    console.log('\n── Der Abschluss verweigert sich, solange ein Antrag offen ist ──');
    // Diese Prüfung gibt es bereits — sie ist der Grund, warum OFFENE Anträge gar nicht erst in
    // einem abgeschlossenen Monat hängen bleiben. Hier festgenagelt, damit sie niemand entfernt.
    const stoerer = (await req('POST', '/api/absences', maTok, { type: 'urlaub', date_from: IM_MONAT, date_to: IM_MONAT })).body.absence;
    for (let m = 1; m <= 2; m++) await req('POST', '/api/closure', chef, { month: `${JAHR}-${String(m).padStart(2, '0')}` });
    const verweigert = await req('POST', '/api/closure', chef, { month: MONAT });
    ok('… und nennt den Grund', verweigert.status === 409 && /nicht entschieden/i.test(verweigert.text),
      verweigert.status + ' ' + verweigert.text.slice(0, 110));
    // ABER: Quittierungen sieht sie NICHT — genau die rutschen durch (in den Produktivdaten waren
    // es zwei von Jakob Wolf). Deshalb muss Quittieren danach weiter möglich sein.
    ok('… Quittierungen hält sie dagegen NICHT auf', !/innung/i.test(verweigert.text), verweigert.text.slice(0, 160));

    await req('POST', `/api/absences/${stoerer.id}/reject`, chef);
    const letzterAbschluss = await req('POST', '/api/closure', chef, { month: MONAT });
    ok(`Abschluss bis ${MONAT} liegt vor`, letzterAbschluss.status === 200 || letzterAbschluss.status === 201,
      letzterAbschluss.status + ' ' + letzterAbschluss.text.slice(0, 120));

    // Ein OFFENER Antrag im abgerechneten Zeitraum — erreichbar über den Admin-Eingriff, und in
    // Altdaten auch aus der Zeit vor der obigen Prüfung. An ihm hängt die eigentliche Frage.
    const altlast = (await req('POST', '/api/absences', admin, { target_user_id: ma.id, type: 'urlaub',
      date_from: `${JAHR}-03-26`, date_to: `${JAHR}-03-26`, reason: 'Nachtrag aus der Altzeit' })).body.absence;
    ok('Aufbau: ein offener Antrag im abgerechneten Zeitraum', !!altlast && altlast.status === 'pending',
      JSON.stringify(altlast && altlast.status));

    // Der Beweis-Anker: So sieht die Abrechnung des Monats aus, BEVOR irgendetwas Erlaubtes passiert.
    const csvVor = (await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, admin)).text;
    ok('die Lohn-CSV des abgerechneten Monats ist abrufbar', csvVor.length > 20, csvVor.slice(0, 60));

    console.log('\n── Was nach dem Abschluss NICHT mehr gehen darf ──');
    const gen = await req('POST', `/api/absences/${altlast.id}/approve`, chef);
    ok('Genehmigen ist gesperrt (der Tag würde plötzlich zählen)', gen.status === 403, gen.status + ' ' + gen.text.slice(0, 90));
    const abGenehmigt = await req('POST', `/api/absences/${genehmigt.id}/reject`, chef);
    ok('einen bereits GENEHMIGTEN Eintrag ablehnen ist gesperrt (Tage fielen weg)',
      abGenehmigt.status === 403, abGenehmigt.status + ' ' + abGenehmigt.text.slice(0, 90));

    console.log('\n── Was weiterhin gehen MUSS, sonst verstopft der Posteingang ──');
    const quitt = await req('POST', `/api/absences/${krank.id}/acknowledge`, chef);
    ok('der Chef kann die Krankmeldung quittieren', quitt.status === 200, quitt.status + ' ' + quitt.text.slice(0, 90));
    ok('… und sie ist damit wirklich quittiert',
      !!(await req('GET', '/api/absences', admin)).body.absences.find(a => a.id === krank.id).notified_at);

    const maQuitt = await req('POST', `/api/absences/${fuerMa.id}/acknowledge-ma`, maTok);
    ok('der Mitarbeiter kann quittieren (setzt nur ein Kennzeichen)',
      maQuitt.status === 200, maQuitt.status + ' ' + maQuitt.text.slice(0, 90));
    const nachQuitt = (await req('GET', '/api/absences', admin)).body.absences.find(a => a.id === fuerMa.id);
    ok('… und der Eintrag verlangt keine Quittierung mehr', nachQuitt && !nachQuitt.ma_needs_ack, JSON.stringify(nachQuitt && nachQuitt.ma_needs_ack));
    ok('… sein Status ist dabei unverändert geblieben', nachQuitt && nachQuitt.status === 'active', JSON.stringify(nachQuitt && nachQuitt.status));

    const ab = await req('POST', `/api/absences/${altlast.id}/reject`, chef);
    ok('ein OFFENER Antrag lässt sich ablehnen', ab.status === 200, ab.status + ' ' + ab.text.slice(0, 90));
    const nachAb = (await req('GET', '/api/absences', admin)).body.absences.find(a => a.id === altlast.id);
    ok('… und ist danach wirklich abgelehnt', nachAb && nachAb.status === 'rejected', JSON.stringify(nachAb && nachAb.status));

    console.log('\n── Die Zahlen dürfen sich dabei NICHT verändert haben ──');
    // Der eigentliche Prüfstein: Alles oben Erlaubte darf die abgerechneten Stunden nicht bewegen.
    // Gemessen an dem, worauf es ankommt: der Lohn-CSV des abgerechneten Monats. Sie wurde VOR den
    // erlaubten Aktionen geholt und muss danach zeichengleich sein.
    const csvNach = (await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, admin)).text;
    ok('die Lohn-CSV des abgerechneten Monats ist unverändert', csvNach === csvVor,
      'vorher ' + csvVor.length + ' Zeichen, nachher ' + csvNach.length);

    console.log('\n── Nach dem Stichtag bleibt alles wie bisher ──');
    const genSpaet = await req('POST', `/api/absences/${urlaubSpaeter.id}/approve`, chef);
    ok('ein Antrag NACH dem Stichtag lässt sich normal genehmigen',
      genSpaet.status === 200, genSpaet.status + ' ' + genSpaet.text.slice(0, 90));

    console.log('\n── Der Admin kommt weiterhin mit Begründung durch ──');
    // Auch dieser Eintrag muss ueber den Admin entstehen: Der Mitarbeiter selbst kann im
    // abgerechneten Zeitraum nichts mehr anlegen — voellig zu Recht.
    const r2 = await req('POST', '/api/absences', admin, { target_user_id: ma.id, type: 'urlaub',
      date_from: `${JAHR}-03-19`, date_to: `${JAHR}-03-19`, reason: 'Nachtrag fuer die Pruefung' });
    ok('Aufbau: noch ein offener Antrag im gesperrten Zeitraum', !!(r2.body && r2.body.absence),
      r2.status + ' ' + r2.text.slice(0, 100));
    const urlaub2 = r2.body.absence;
    const ohneGrund = await req('POST', `/api/absences/${urlaub2.id}/approve`, admin);
    ok('… aber NICHT ohne Begründung', ohneGrund.status === 403, ohneGrund.status + ' ' + ohneGrund.text.slice(0, 90));
    const mitGrund = await req('POST', `/api/absences/${urlaub2.id}/approve`, admin, { reason: 'Nachtrag laut Rücksprache mit dem Lohnbüro' });
    ok('… mit Begründung schon', mitGrund.status === 200, mitGrund.status + ' ' + mitGrund.text.slice(0, 90));
    const protokoll = (await req('GET', '/api/audit?action=closure_override&limit=200', admin)).body;
    const zeilen = (protokoll && (protokoll.logs || protokoll.rows || protokoll.entries)) || [];
    ok('… und der Eingriff steht im Protokoll',
      Array.isArray(zeilen) && zeilen.some(z => /genehmigt/i.test(String(z.details || ''))),
      JSON.stringify(zeilen.map(z => z.details)).slice(0, 200));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    srv.kill();
  }
  console.log(`\nAbschluss und Posteingang: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
