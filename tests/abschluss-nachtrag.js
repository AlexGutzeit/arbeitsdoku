// Nachträge in einem bereits abgerechneten Monat: kommen die Stunden am Ende beim Mitarbeiter an?
//
// Das ist die Frage, an der der ganze Abschluss hängt. Trägt der Administrator vier Stunden in
// einem bezahlten Monat nach, dann sind sie im Zeitnachweis und in der Monatsstatistik sofort da —
// aber der Überstunden-Gesamtstand rührt sich bewusst nicht, und genau der geht ans Lohnbüro.
// Ohne die Übernahme wären diese Stunden gearbeitet, dokumentiert und nie bezahlt.
//
// Geprüft wird deshalb die ganze Kette: nachtragen → Differenz sichtbar → nächster Abschluss
// blockiert → übernehmen → Stunden im Gesamtstand UND im Lohn-Export → Abschluss wieder möglich.
//   node tests/abschluss-nachtrag.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3163, DB = '/tmp/abschluss-nachtrag.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JAHR = new Date().getFullYear() - 1;      // sicher komplett vergangen
const d2 = n => String(n).padStart(2, '0');
const zahlAus = (zeile, spalte) => Number(String(zeile.split(';')[spalte]).replace(/"/g, '').replace(',', '.'));

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-nachtrag-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    const log = fs.readFileSync('/tmp/abschluss-nachtrag-srv.log', 'utf8');
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const admin = (await an('admin')).token, chef = (await an('chef')).token;
    const maxA = await an('max'); const uid = maxA.user.id;

    await req('POST', `/api/statistics/targets/${uid}`, chef,
      { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${JAHR}-01-01` });
    for (const m of ['01', '02', '03', '04', '05', '06']) {
      for (let t = 1; t <= 28; t++) {
        const datum = `${JAHR}-${m}-${d2(t)}`;
        const wt = new Date(datum + 'T12:00:00Z').getUTCDay();
        if (wt === 0 || wt === 6) continue;
        await req('POST', '/api/entries', admin, { date: datum, time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: uid });
      }
    }

    // Nur bis MAI abschliessen — der Juni bleibt offen und ist spaeter der Prueffall fuer die Sperre.
    const zu = await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-05` });
    ok('Januar bis Mai abgeschlossen', zu.status === 201 && zu.body.erledigt.length === 5,
      `${zu.status} ${JSON.stringify(zu.body?.erledigt || zu.body?.error || '').slice(0, 120)}`);

    const stand = async () => (await req('GET', `/api/statistics/overtime?user_id=${uid}`, admin)).body;
    const csvUeber = async (monat) => {
      const zeile = (await req('GET', `/api/payroll/monat.csv?month=${monat}`, admin)).text
        .split('\r\n').find(z => z.includes('Max'));
      return zahlAus(zeile, 6);   // Spalte „Überstunden gesamt"
    };

    const vorher = await stand();
    const csvVorher = await csvUeber(`${JAHR}-06`);
    const csvIst = async (monat) => zahlAus((await req('GET', `/api/payroll/monat.csv?month=${monat}`, admin)).text
      .split('\r\n').find(z => z.includes('Max')), 4);
    const istJuniVorher = await csvIst(`${JAHR}-06`);
    ok('Ausgangsstand gemessen', typeof (vorher.overtime ?? vorher.ueberstunden ?? vorher) !== 'undefined',
      JSON.stringify(vorher).slice(0, 100));
    const wert = (o) => Number(o.overtime ?? o.ueberstunden ?? o.ueber_gesamt ?? 0);

    // ── Nachtrag im abgerechneten April ───────────────────────────────────────────────────
    const nach = await req('POST', '/api/entries', admin, {
      date: `${JAHR}-04-14`, time_from: '16:00', time_to: '20:00', break_minutes: 0,
      user_id: uid, reason: 'Vergessener Noteinsatz, Stundenzettel nachgereicht',
    });
    ok('Admin trägt 4 h im abgerechneten April nach', nach.status === 201, `${nach.status} ${nach.body?.error || ''}`);

    const nachStand = await stand();
    ok('der Überstundenstand bleibt zunächst unverändert', wert(nachStand) === wert(vorher),
      `${wert(vorher)} → ${wert(nachStand)}`);
    ok('auch der Lohn-Export ändert sich noch nicht', (await csvUeber(`${JAHR}-06`)) === csvVorher,
      `${csvVorher} → ${await csvUeber(`${JAHR}-06`)}`);

    // ── Die Differenz wird ausgewiesen ────────────────────────────────────────────────────
    const per = (await req('GET', '/api/closure', chef)).body.perioden;
    const april = per.find(p => p.periodFrom.endsWith('-04-01'));
    ok('die offene Differenz steht im Stand', april && april.offenGesamt === 4, String(april && april.offenGesamt));
    const abw = (await req('GET', `/api/closure/${april.id}/abweichung`, chef)).body;
    ok('die Abweichungs-Ansicht nennt 4 offene Stunden', abw.offenGesamt === 4, String(abw.offenGesamt));
    ok('sie weist sie dem richtigen Mitarbeiter zu',
      (abw.abweichungen || []).some(a => a.offen === 4 && /Max/.test(a.name || '')),
      JSON.stringify(abw.abweichungen || []).slice(0, 160));

    // ── Der nächste Abschluss ist blockiert ───────────────────────────────────────────────
    const blockiert = await req('POST', '/api/closure', chef, { month: `${JAHR}-06` });
    ok('der nächste Monatsabschluss wird blockiert', blockiert.status === 409 && /nachträglich/i.test(blockiert.body?.error || ''),
      `${blockiert.status} ${(blockiert.body?.error || '').slice(0, 120)}`);
    ok('die Blockade nennt den betroffenen Mitarbeiter', /Max/.test(blockiert.body?.error || ''), blockiert.body?.error);
    const blockiertBis = await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-06` });
    ok('auch der Sammel-Abschluss wird blockiert',
      blockiertBis.status === 409 || (blockiertBis.body?.erledigt || []).length === 0,
      `${blockiertBis.status} ${JSON.stringify(blockiertBis.body).slice(0, 120)}`);

    // ── Übernehmen ────────────────────────────────────────────────────────────────────────
    const ohneText = await req('POST', `/api/closure/${april.id}/uebernehmen`, chef, {});
    ok('ohne Kommentar wird die Übernahme abgewiesen', ohneText.status === 400,
      `${ohneText.status} ${ohneText.body?.error || ''}`);
    const zuKurz = await req('POST', `/api/closure/${april.id}/uebernehmen`, chef, { reason: '  x ' });
    ok('ein Ein-Zeichen-Kommentar reicht nicht', zuKurz.status === 400, String(zuKurz.status));
    ok('nach der Abweisung ist nichts gebucht',
      ((await req('GET', `/api/closure/${april.id}/abweichung`, chef)).body.offenGesamt) === 4);

    const KOMMENTAR = 'Noteinsatz Ostern, Stundenzettel erst im Juni eingereicht';
    const ue = await req('POST', `/api/closure/${april.id}/uebernehmen`, chef, { reason: KOMMENTAR });
    ok('die Differenz lässt sich übernehmen', ue.status === 200 && ue.body.uebernommen.length === 1,
      `${ue.status} ${JSON.stringify(ue.body).slice(0, 140)}`);
    ok('sie wirkt ab dem Tag nach dem letzten Stichtag', ue.body.wirksamAb === `${JAHR}-06-01`, String(ue.body?.wirksamAb));

    const danach = await stand();
    ok('JETZT steigt der Überstundenstand um 4 h', wert(danach) === wert(vorher) + 4,
      `${wert(vorher)} → ${wert(danach)}`);
    const csvDanach = await csvUeber(`${JAHR}-06`);
    ok('und der Lohn-Export enthält die 4 h', csvDanach === csvVorher + 4, `${csvVorher} → ${csvDanach}`);

    ok('die Differenz gilt nicht mehr als offen',
      ((await req('GET', `/api/closure/${april.id}/abweichung`, chef)).body.offenGesamt) === 0);
    ok('der abgeschlossene April bleibt als Beleg unverändert',
      ((await req('GET', '/api/closure', chef)).body.perioden.find(p => p.id === april.id).zeilen[0].ist) === 160,
      'Beleg wurde verändert');

    // ── Die Kennzeichnung: woher kommen diese Stunden? ────────────────────────────────────
    // Ohne sie stuenden im Folgemonat ploetzlich 4 Stunden mehr, die niemand zuordnen kann.
    const csvZeile = (await req('GET', `/api/payroll/monat.csv?month=${JAHR}-06`, admin)).text
      .split('\r\n').find(z => z.includes('Max'));
    const kopf = (await req('GET', `/api/payroll/monat.csv?month=${JAHR}-06`, admin)).text.split('\r\n')[0];
    ok('der Lohn-Export hat eine eigene Nachtrags-Spalte', /Nachtrag Vormonat/.test(kopf) && /Nachtrag Herkunft/.test(kopf), kopf.slice(0, 200));
    ok('dort stehen die 4 Stunden', zahlAus(csvZeile, 14) === 4, csvZeile);
    ok('die Herkunft nennt den Monat', /April/.test(csvZeile.split(';')[15] || ''), csvZeile.split(';')[15]);
    ok('und den Kommentar', csvZeile.includes('Noteinsatz Ostern'), csvZeile.split(';')[15]);
    // Gearbeitet wurden die Stunden im April — sie duerfen die Ist-Zeit des Juni NICHT aufblaehen.
    ok('die Ist-Stunden des Folgemonats bleiben unberührt',
      zahlAus(csvZeile, 4) === istJuniVorher,
      `${istJuniVorher} → ${zahlAus(csvZeile, 4)} — der Nachtrag gehört nicht in die Ist-Zeit des Juni`);

    const meinStand = (await req('GET', '/api/closure', maxA.token)).body;
    ok('der Mitarbeiter sieht den Nachtrag mit Herkunft',
      (meinStand.nachtraege || []).some(n => n.stunden === 4 && /April/.test(n.herkunft) && /Noteinsatz/.test(n.grund)),
      JSON.stringify(meinStand.nachtraege || []).slice(0, 200));

    const auditTxt = (await req('GET', '/api/audit?limit=200', admin)).text;
    ok('die Übernahme steht mit Kommentar im Protokoll',
      /closure_adjust/.test(auditTxt) && auditTxt.includes('Noteinsatz Ostern'), auditTxt.slice(0, 120));

    // ── Und der Abschluss geht wieder ─────────────────────────────────────────────────────
    const juni = await req('POST', '/api/closure', chef, { month: `${JAHR}-06` });
    ok('der Juni lässt sich jetzt abschließen', juni.status === 201, `${juni.status} ${juni.body?.error || ''}`);

    // Kein Doppelzählen: Nach dem Juni-Abschluss steckt der Nachtrag im Juni-Snapshot — er darf
    // nicht zusätzlich aus der Korrekturtabelle addiert werden.
    const nachJuni = await stand();
    ok('nach dem nächsten Abschluss wird der Nachtrag NICHT doppelt gezählt',
      wert(nachJuni) === wert(danach), `${wert(danach)} → ${wert(nachJuni)}`);

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nNachträge: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
