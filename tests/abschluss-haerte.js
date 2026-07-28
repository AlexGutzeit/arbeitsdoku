// Härtetest für den Abrechnungs-Abschluss: gezielt die Fälle, in denen die Mechanik brechen KANN.
//
// Die vorhandenen Tests zeigen, dass der Normalfall stimmt. Hier wird das Gegenteil versucht:
// Zeiträume wieder öffnen, nachdem eine Differenz übernommen wurde; Stunden im bezahlten Monat
// LÖSCHEN statt nachtragen; Mitarbeiter, die es zum Stichtag noch gar nicht gab oder heute nicht
// mehr gibt; ein rückwirkender Feiertag, der alle gleichzeitig trifft.
//
// Jedes Szenario läuft auf einer FRISCHEN Datenbank. Abschlüsse sind firmenweit — liefen die
// Szenarien nacheinander auf demselben Bestand, würden sie sich gegenseitig verdecken.
//   node tests/abschluss-haerte.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3165, DB = '/tmp/abschluss-haerte.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('    ✓ ' + n)) : (fail++, fails.push(n), console.log('    ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JAHR = new Date().getFullYear() - 1;
const d2 = n => String(n).padStart(2, '0');
const GRUND = 'Prüfung im Härtetest';

// ── Server je Szenario frisch hochziehen ────────────────────────────────────────────────────
let srv = null;
async function frischerServer() {
  if (srv) { srv.kill('SIGTERM'); await sleep(600); }
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-haerte-srv.log', 'w');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  // Beim EADDRINUSE saet der neue Server noch seine Passwoerter ins Log und stirbt dann — /health
  // antwortet dabei vom ALTEN Prozess, und die Anmeldung scheitert mit fremden Zugangsdaten.
  // Das ist beim Entwickeln passiert; hier wird es benannt statt geraten.
  let gestorben = null;
  srv.on('exit', (code) => { gestorben = code; });
  for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
  // Auf die Passwortzeilen WARTEN: /health antwortet, bevor der Seed-Block geschrieben ist.
  // Ohne dieses Warten kommt sporadisch ein leeres Passwort und der Test bricht mit einem
  // nichtssagenden „Cannot read properties of undefined" ab.
  let log = '';
  for (let i = 0; i < 100; i++) {
    log = fs.readFileSync('/tmp/abschluss-haerte-srv.log', 'utf8');
    if (/admin\s+->\s+\S+/.test(log) && /max\s+->\s+\S+/.test(log)) break;
    await sleep(200);
  }
  const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
  const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
  const [admin, chef, max] = [await an('admin'), await an('chef'), await an('max')];
  if (!admin?.token || !chef?.token || !max?.user) {
    const adressBelegt = /EADDRINUSE/.test(log) || gestorben !== null;
    throw new Error('Anmeldung im Testaufbau fehlgeschlagen'
      + (adressBelegt ? ` — Port ${PORT} ist belegt (Server-Rest eines abgebrochenen Laufs?). `
        + 'Erst aufraeumen, dann erneut starten.' : ''));
  }
  return { admin: admin.token, chef: chef.token, max };
}

// Werktage eines Monats mit 8-h-Einträgen füllen
async function monatFuellen(admin, uid, monat, von = '07:00', bis = '15:30') {
  for (let t = 1; t <= 28; t++) {
    const datum = `${JAHR}-${monat}-${d2(t)}`;
    const wt = new Date(datum + 'T12:00:00Z').getUTCDay();
    if (wt === 0 || wt === 6) continue;
    await req('POST', '/api/entries', admin, { date: datum, time_from: von, time_to: bis, break_minutes: 30, user_id: uid });
  }
}
async function sollSetzen(chef, uid, ab, stunden = 8) {
  return req('POST', `/api/statistics/targets/${uid}`, chef, {
    hours_mon: stunden, hours_tue: stunden, hours_wed: stunden, hours_thu: stunden, hours_fri: stunden, valid_from: ab });
}
const stand = async (admin, uid) => {
  const o = (await req('GET', `/api/statistics/overtime?user_id=${uid}`, admin)).body;
  return Number(o.overtime ?? o.ueberstunden ?? o.ueber_gesamt ?? 0);
};
const perioden = async (t) => (await req('GET', '/api/closure', t)).body.perioden;

(async () => {
  try {

    // ══ 1. Wieder öffnen, NACHDEM eine Differenz übernommen wurde ════════════════════════
    // Der gefährlichste Fall: Die Korrektur wurde gebucht, weil der Zeitraum eingefroren war.
    // Wird er wieder aufgetaut, zählen seine Einträge wieder direkt mit — die Korrektur daneben
    // wäre dieselbe Zeit ein ZWEITES Mal.
    console.log('\n1) Wieder öffnen nach übernommener Differenz:');
    {
      const { admin, chef, max } = await frischerServer();
      const uid = max.user.id;
      await sollSetzen(chef, uid, `${JAHR}-01-01`);
      for (const m of ['01', '02', '03']) await monatFuellen(admin, uid, m);
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-03` });
      const vorher = await stand(admin, uid);

      await req('POST', '/api/entries', admin, { date: `${JAHR}-02-10`, time_from: '17:00', time_to: '21:00', break_minutes: 0, user_id: uid, reason: GRUND });
      const feb = (await perioden(chef)).find(p => p.periodFrom.endsWith('-02-01'));
      await req('POST', `/api/closure/${feb.id}/uebernehmen`, chef, { reason: GRUND });
      const nachUebernahme = await stand(admin, uid);
      ok('Übernahme bringt +4 h', nachUebernahme === vorher + 4, `${vorher} → ${nachUebernahme}`);

      // März und Februar wieder öffnen — danach zählen die Februar-Einträge wieder direkt.
      let ps = await perioden(admin);
      await req('DELETE', `/api/closure/${ps[ps.length - 1].id}`, admin, { reason: GRUND });
      ps = await perioden(admin);
      const auf = await req('DELETE', `/api/closure/${ps[ps.length - 1].id}`, admin, { reason: GRUND });
      ok('Februar lässt sich wieder öffnen', auf.status === 200, `${auf.status} ${auf.body?.error || ''}`);

      const nachOeffnen = await stand(admin, uid);
      ok('die 4 h werden NICHT doppelt gezählt', nachOeffnen === vorher + 4,
        `erwartet ${vorher + 4}, bekommen ${nachOeffnen} — die Korrektur zählt neben den wieder lebenden Einträgen`);
    }

    // ══ 2. Stunden im bezahlten Monat LÖSCHEN (negative Differenz) ═══════════════════════
    console.log('\n2) Negativer Nachtrag (Eintrag im bezahlten Monat gelöscht):');
    {
      const { admin, chef, max } = await frischerServer();
      const uid = max.user.id;
      await sollSetzen(chef, uid, `${JAHR}-01-01`);
      for (const m of ['01', '02']) await monatFuellen(admin, uid, m);
      const extra = (await req('POST', '/api/entries', admin, { date: `${JAHR}-01-20`, time_from: '17:00', time_to: '20:00', break_minutes: 0, user_id: uid })).body.entry;
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-02` });
      const vorher = await stand(admin, uid);

      const weg = await req('DELETE', `/api/entries/${extra.id}`, admin, { reason: GRUND });
      ok('Admin löscht einen Eintrag im bezahlten Januar', weg.status === 200, String(weg.status));
      ok('der Stand bleibt zunächst unverändert', (await stand(admin, uid)) === vorher);

      const jan = (await perioden(chef)).find(p => p.periodFrom.endsWith('-01-01'));
      const abw = (await req('GET', `/api/closure/${jan.id}/abweichung`, chef)).body;
      ok('die Differenz ist negativ (−3 h)', abw.offenGesamt === -3, String(abw.offenGesamt));

      const ue = await req('POST', `/api/closure/${jan.id}/uebernehmen`, chef, { reason: GRUND });
      ok('auch eine negative Differenz lässt sich übernehmen', ue.status === 200, `${ue.status} ${ue.body?.error || ''}`);
      ok('der Stand sinkt um 3 h', (await stand(admin, uid)) === vorher - 3, `${vorher} → ${await stand(admin, uid)}`);
      ok('danach ist nichts mehr offen',
        ((await req('GET', `/api/closure/${jan.id}/abweichung`, chef)).body.offenGesamt) === 0);
    }

    // ══ 3. Mitarbeiter, den es zum Stichtag noch nicht gab ═══════════════════════════════
    console.log('\n3) Später eingetretener Mitarbeiter (kein Beleg im Abschluss):');
    {
      const { admin, chef, max } = await frischerServer();
      await sollSetzen(chef, max.user.id, `${JAHR}-01-01`);
      for (const m of ['01', '02']) await monatFuellen(admin, max.user.id, m);
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-02` });

      const neu = (await req('POST', '/api/users', admin, {
        username: 'spaet', password: 'Start!2345', name: 'Spät Eingetreten', role: 'mitarbeiter',
        start_overtime: 7.5, hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
      })).body.user;
      ok('Neuzugang lässt sich trotz Abschluss anlegen', !!neu, 'Anlegen blockiert');
      const sollNeu = await sollSetzen(chef, neu.id, `${JAHR}-03-01`);
      ok('Soll-Stunden ab NACH dem Stichtag sind erlaubt', sollNeu.status === 200, String(sollNeu.status));
      await monatFuellen(admin, neu.id, '03');

      const s = await stand(admin, neu.id);
      ok('sein Stand rechnet ohne Beleg korrekt (Start-Überstunden bleiben erhalten)',
        Number.isFinite(s) && s !== 0, `Stand=${s} — 7,5 h Start dürfen nicht verloren gehen`);
      ok('er taucht in keinem alten Beleg auf',
        (await perioden(chef)).every(p => p.zeilen.every(z => Number(z.user_id) !== Number(neu.id))));

      const csv = (await req('GET', `/api/payroll/monat.csv?month=${JAHR}-03`, admin)).text;
      ok('im Lohn-Export des Folgemonats ist er dabei', /Spät Eingetreten/.test(csv), csv.slice(0, 120));
    }

    // ══ 4. Endgültig gelöschter Mitarbeiter — der Beleg muss ihn überleben ═══════════════
    console.log('\n4) Mitarbeiter endgültig gelöscht (Beleg muss bleiben):');
    {
      const { admin, chef } = await frischerServer();
      const weg = (await req('POST', '/api/users', admin, {
        username: 'geht', password: 'Start!2345', name: 'Geht Bald', role: 'mitarbeiter', personnel_no: '9999',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
      })).body.user;
      await sollSetzen(chef, weg.id, `${JAHR}-01-01`);
      await monatFuellen(admin, weg.id, '01');
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-01` });
      const jan = (await perioden(chef))[0];
      ok('sein Beleg steht im Abschluss', jan.zeilen.some(z => z.name === 'Geht Bald'));

      const aus = await req('POST', `/api/users/${weg.id}/deactivate`, chef, { employed_until: `${JAHR}-01-15` });
      ok('rückdatiertes Ausstellen wird geblockt', aus.status === 403, String(aus.status));
      const ausAdmin = await req('POST', `/api/users/${weg.id}/deactivate`, admin, { employed_until: `${JAHR}-01-15`, reason: GRUND });
      ok('der Admin darf es mit Begründung', ausAdmin.status === 200, `${ausAdmin.status} ${ausAdmin.body?.error || ''}`);

      const hart = await req('DELETE', `/api/users/${weg.id}`, admin, {});
      ok('endgültiges Löschen ist möglich (bewusst nicht gesperrt)', hart.status === 200, String(hart.status));

      const danach = (await perioden(chef))[0];
      ok('der Beleg überlebt das Löschen', danach && danach.zeilen.some(z => z.name === 'Geht Bald'),
        JSON.stringify(danach?.zeilen || []).slice(0, 160));
      ok('mit Personalnummer', danach.zeilen.some(z => z.personnel_no === '9999'));
      const abw = await req('GET', `/api/closure/${jan.id}/abweichung`, chef);
      ok('die Abweichungs-Ansicht stürzt nicht ab', abw.status === 200, `${abw.status} ${abw.text.slice(0, 120)}`);
      ok('sie meldet ihn als entfernt', (abw.body.abweichungen || []).some(a => a.entfernt), JSON.stringify(abw.body).slice(0, 200));
      const audit = (await req('GET', '/api/audit?limit=100', admin)).text;
      ok('das Protokoll vermerkt „betrifft abgerechnete Zeiträume"', /ABGERECHNETE ZEITR/.test(audit), audit.slice(0, 120));
    }

    // ══ 5. Rückwirkender Feiertag — trifft ALLE gleichzeitig ═════════════════════════════
    console.log('\n5) Feiertag rückwirkend im bezahlten Monat:');
    {
      const { admin, chef, max } = await frischerServer();
      const zweiter = (await req('POST', '/api/users', admin, {
        username: 'kollege', password: 'Start!2345', name: 'Kollege Zwei', role: 'mitarbeiter',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
      })).body.user;
      for (const u of [max.user.id, zweiter.id]) { await sollSetzen(chef, u, `${JAHR}-01-01`); await monatFuellen(admin, u, '01'); }
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-01` });
      const staende = { a: await stand(admin, max.user.id), b: await stand(admin, zweiter.id) };

      const ft = await req('POST', '/api/absences', chef, { type: 'feiertag', date_from: `${JAHR}-01-14`, date_to: `${JAHR}-01-14` });
      ok('Chef kann keinen Feiertag rückwirkend setzen', ft.status === 403, String(ft.status));
      const ftAdmin = await req('POST', '/api/absences', admin, { type: 'feiertag', date_from: `${JAHR}-01-14`, date_to: `${JAHR}-01-14`, reason: GRUND });
      ok('der Admin darf es mit Begründung', ftAdmin.status === 201, `${ftAdmin.status} ${ftAdmin.body?.error || ''}`);

      ok('kein Stand hat sich von allein bewegt',
        (await stand(admin, max.user.id)) === staende.a && (await stand(admin, zweiter.id)) === staende.b);
      const jan = (await perioden(chef))[0];
      const abw = (await req('GET', `/api/closure/${jan.id}/abweichung`, chef)).body;
      ok('die Abweichung betrifft BEIDE Mitarbeiter', (abw.abweichungen || []).filter(a => a.offen !== 0).length === 2,
        JSON.stringify(abw.abweichungen || []).slice(0, 200));
      ok('und ist positiv (Soll sinkt, Saldo steigt)', abw.offenGesamt > 0, String(abw.offenGesamt));

      await req('POST', `/api/closure/${jan.id}/uebernehmen`, chef, { reason: 'Feiertag nachgetragen' });
      ok('nach der Übernahme steigen BEIDE Stände',
        (await stand(admin, max.user.id)) > staende.a && (await stand(admin, zweiter.id)) > staende.b);
    }

    // ══ 6. Denselben Monat zweimal abschließen ═══════════════════════════════════════════
    console.log('\n6) Denselben Monat zweimal abschließen:');
    {
      const { admin, chef, max } = await frischerServer();
      await sollSetzen(chef, max.user.id, `${JAHR}-01-01`);
      await monatFuellen(admin, max.user.id, '01');
      const a = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      const b = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      ok('der erste Abschluss geht durch', a.status === 201, String(a.status));
      ok('der zweite wird sauber abgewiesen', b.status === 409, `${b.status} ${b.body?.error || ''}`);
      ok('es entsteht genau EIN Zeitraum', (await perioden(chef)).length === 1, String((await perioden(chef)).length));

      const gleichzeitig = await Promise.all([
        req('POST', '/api/closure', chef, { month: `${JAHR}-02` }),
        req('POST', '/api/closure', chef, { month: `${JAHR}-02` }),
      ]);
      const erfolge = gleichzeitig.filter(r => r.status === 201).length;
      ok('bei zwei gleichzeitigen Anfragen entsteht höchstens einer', erfolge <= 1,
        `${erfolge} Erfolge — ${gleichzeitig.map(r => r.status).join('/')}`);
      const feb = (await perioden(chef)).filter(p => p.periodFrom.endsWith('-02-01'));
      ok('kein doppelter Februar in der Liste', feb.length <= 1, String(feb.length));
    }

    // ══ 7. Schließen → öffnen → erneut schließen ═════════════════════════════════════════
    console.log('\n7) Schließen, öffnen, erneut schließen — Zahlen müssen gleich sein:');
    {
      const { admin, chef, max } = await frischerServer();
      const uid = max.user.id;
      await sollSetzen(chef, uid, `${JAHR}-01-01`);
      for (const m of ['01', '02']) await monatFuellen(admin, uid, m);
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-02` });
      // NUR die fachlichen Felder vergleichen: id und closure_id sind laufende Nummern und
      // aendern sich beim erneuten Schreiben zwangslaeufig — das sagt ueber die Zahlen nichts.
      const fachlich = (ps) => JSON.stringify(ps.map(p => p.zeilen.map(z => ({
        name: z.name, soll: z.soll, ist: z.ist, saldo: z.saldo, ueber: z.ueberstunden_gesamt,
        istKum: z.ist_kumuliert, sollKum: z.soll_kumuliert,
      }))));
      const beleg1 = fachlich(await perioden(chef));
      const stand1 = await stand(admin, uid);

      const ps = await perioden(admin);
      await req('DELETE', `/api/closure/${ps[ps.length - 1].id}`, admin, { reason: GRUND });
      ok('nach dem Öffnen ist der Stand unverändert', (await stand(admin, uid)) === stand1,
        `${stand1} → ${await stand(admin, uid)}`);
      const wieder = await req('POST', '/api/closure', chef, { month: `${JAHR}-02` });
      ok('erneutes Abschließen geht', wieder.status === 201, `${wieder.status} ${wieder.body?.error || ''}`);
      ok('der Stand ist danach identisch', (await stand(admin, uid)) === stand1, `${stand1} → ${await stand(admin, uid)}`);
      ok('auch die festgehaltenen Zahlen sind identisch', fachlich(await perioden(chef)) === beleg1,
        'Belege weichen ab');
    }

  } finally {
    if (srv) { srv.kill('SIGTERM'); await sleep(700); }
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAbschluss-Härtetest: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); if (srv) srv.kill('SIGTERM'); process.exit(1); });
