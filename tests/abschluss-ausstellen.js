// Ausstellen von Mitarbeitern unter dem Abrechnungs-Abschluss.
//
// Ausstellen ist der NORMALE Weg beim Ausscheiden (endgültiges Löschen ist ein Not-Werkzeug).
// Dabei bleiben alle Daten erhalten, und der Mitarbeiter zählt für seinen Anstellungszeitraum
// weiter korrekt — auch wenn er mitten im Monat geht. Genau das wird hier geprüft, mit
// UNABHÄNGIG nachgerechneten Sollwerten statt mit dem, was die App gerade liefert.
//
// Jedes Szenario auf einer frischen Datenbank (Abschlüsse sind firmenweit).
//   node tests/abschluss-ausstellen.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3169, DB = '/tmp/abschluss-ausstellen.db';
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
const GRUND = 'Prüfung im Ausstellen-Test';

// Werktage in einem Zeitraum — bewusst hier nachgerechnet und NICHT aus der App geholt.
// Ein Test, der seine Erwartung beim Prüfling abholt, prüft nichts.
function werktage(vonISO, bisISO) {
  let n = 0;
  const c = new Date(vonISO + 'T12:00:00Z'), e = new Date(bisISO + 'T12:00:00Z');
  while (c <= e) { const d = c.getUTCDay(); if (d !== 0 && d !== 6) n++; c.setUTCDate(c.getUTCDate() + 1); }
  return n;
}

let srv = null;
async function frischerServer() {
  if (srv) { srv.kill('SIGTERM'); await sleep(700); }
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-ausstellen-srv.log', 'w');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let gestorben = null; srv.on('exit', c => { gestorben = c; });
  for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
  let log = '';
  for (let i = 0; i < 100; i++) {
    log = fs.readFileSync('/tmp/abschluss-ausstellen-srv.log', 'utf8');
    if (/admin\s+->\s+\S+/.test(log) && /chef\s+->\s+\S+/.test(log)) break;
    await sleep(200);
  }
  const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
  const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
  const [admin, chef] = [await an('admin'), await an('chef')];
  if (!admin?.token || !chef?.token) {
    throw new Error('Testaufbau: Anmeldung fehlgeschlagen'
      + (/EADDRINUSE/.test(log) || gestorben !== null ? ` — Port ${PORT} belegt (Server-Rest?)` : ''));
  }
  return { admin: admin.token, chef: chef.token };
}

async function legeAn(admin, chef, name, benutzer) {
  const u = (await req('POST', '/api/users', admin, {
    username: benutzer, password: 'Start!2345', name, role: 'mitarbeiter', personnel_no: '77' + benutzer.length,
    hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
  })).body.user;
  await req('POST', `/api/statistics/targets/${u.id}`, chef, {
    hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${JAHR}-01-01` });
  return u;
}
// Eintraege 07:00–15:30 (30 min Pause) = 8 h netto, nur an Werktagen im Bereich
async function eintraege(admin, uid, von, bis) {
  let n = 0;
  const c = new Date(von + 'T12:00:00Z'), e = new Date(bis + 'T12:00:00Z');
  while (c <= e) {
    const d = c.getUTCDay(), iso = c.toISOString().slice(0, 10);
    if (d !== 0 && d !== 6) { await req('POST', '/api/entries', admin, { date: iso, time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: uid }); n++; }
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return n;
}
const csvZeile = async (admin, monat, name) => {
  const t = (await req('GET', `/api/payroll/monat.csv?month=${monat}`, admin)).text.split('\r\n');
  const kopf = t[0].split(';').map(x => x.replace(/"/g, ''));
  const zeile = t.find(z => z.includes(name));
  if (!zeile) return null;
  const werte = zeile.split(';').map(x => x.replace(/"/g, ''));
  const o = {}; kopf.forEach((k, i) => { o[k] = werte[i]; });
  return o;
};
const zahl = (s) => Number(String(s).replace(',', '.'));
const perioden = async (t) => (await req('GET', '/api/closure', t)).body.perioden;

(async () => {
  try {

    // ══ 1. Austritt zur Monatsmitte, danach abschließen ═════════════════════════════════
    console.log('\n1) Austritt am 15. Januar, danach den Januar abschließen:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Mitte Januar', 'mittejan');
      const tage = await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-15`);
      const sollErwartet = werktage(`${JAHR}-01-01`, `${JAHR}-01-15`) * 8;
      ok(`Einträge bis zum 15. angelegt (${tage} Werktage)`, tage > 5, String(tage));

      const aus = await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-15` });
      ok('Ausstellen zum 15. geht (Zeitraum noch offen)', aus.status === 200, `${aus.status} ${aus.body?.error || ''}`);

      const zu = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      ok('Januar lässt sich abschließen', zu.status === 201, `${zu.status} ${zu.body?.error || ''}`);

      const z = (await perioden(chef))[0].zeilen.find(x => x.name === 'Mitte Januar');
      ok('der Ausgeschiedene steht im Beleg', !!z, 'fehlt — der letzte Monat wäre unbelegt');
      ok(`Soll zählt nur bis zum Austritt (${sollErwartet} h)`, z && z.soll === sollErwartet,
        `Soll=${z && z.soll}, unabhängig gerechnet ${sollErwartet}`);
      ok('Ist entspricht den gebuchten Tagen', z && z.ist === tage * 8, `Ist=${z && z.ist}, erwartet ${tage * 8}`);
      ok('Saldo ist damit 0', z && z.saldo === 0, `Saldo=${z && z.saldo}`);

      const csv = await csvZeile(admin, `${JAHR}-01`, 'Mitte Januar');
      ok('die Lohn-CSV führt ihn mit „Beschäftigt bis"', csv && csv['Beschäftigt bis'] === `${JAHR}-01-15`,
        csv && csv['Beschäftigt bis']);
      ok('und mit demselben Soll wie der Beleg', csv && zahl(csv['Soll-Stunden']) === sollErwartet, csv && csv['Soll-Stunden']);
    }

    // ══ 2. Einträge NACH dem Austritt ═══════════════════════════════════════════════════
    console.log('\n2) Gebuchte Zeit nach dem Austrittsdatum (Datenpanne):');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Bucht Weiter', 'buchtweiter');
      const tage = await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-31`);
      const sollErwartet = werktage(`${JAHR}-01-01`, `${JAHR}-01-15`) * 8;
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-15` });
      await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });

      const z = (await perioden(chef))[0].zeilen.find(x => x.name === 'Bucht Weiter');
      ok(`Soll endet trotzdem am 15. (${sollErwartet} h)`, z && z.soll === sollErwartet, `Soll=${z && z.soll}`);
      ok('Ist enthält ALLE gebuchten Tage', z && z.ist === tage * 8, `Ist=${z && z.ist}, erwartet ${tage * 8}`);
      ok('die Tage nach dem Austritt werden zu Überstunden', z && z.saldo === tage * 8 - sollErwartet && z.saldo > 0,
        `Saldo=${z && z.saldo}`);
      ok('das ist im Beleg festgehalten und damit nachvollziehbar', z && z.ueberstunden_gesamt === z.saldo,
        `Überstunden gesamt=${z && z.ueberstunden_gesamt}, Saldo=${z && z.saldo}`);
    }

    // ══ 3. Folgemonat: der Ausgeschiedene taucht nicht mehr auf ══════════════════════════
    console.log('\n3) Der Monat NACH dem Austritt:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Weg Ab Februar', 'wegabfeb');
      const bleibt = await legeAn(admin, chef, 'Bleibt Da', 'bleibtda');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-31`);
      await eintraege(admin, bleibt.id, `${JAHR}-01-01`, `${JAHR}-02-28`);
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-31` });
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-02` });

      const jan = (await perioden(chef)).find(p => p.periodFrom.endsWith('-01-01'));
      const feb = (await perioden(chef)).find(p => p.periodFrom.endsWith('-02-01'));
      ok('im Januar-Beleg ist er drin', jan.zeilen.some(x => x.name === 'Weg Ab Februar'));
      ok('im Februar-Beleg nicht mehr', !feb.zeilen.some(x => x.name === 'Weg Ab Februar'),
        JSON.stringify(feb.zeilen.map(x => x.name)));
      ok('der verbliebene Kollege ist in beiden', jan.zeilen.some(x => x.name === 'Bleibt Da') && feb.zeilen.some(x => x.name === 'Bleibt Da'));
      ok('die Februar-CSV führt ihn nicht mehr', (await csvZeile(admin, `${JAHR}-02`, 'Weg Ab Februar')) === null);

      // Seine Daten sind vollstaendig da — das ist der Unterschied zum endgueltigen Loeschen.
      const seine = (await req('GET', `/api/entries?from=${JAHR}-01-01&to=${JAHR}-01-31`, admin)).body.entries
        .filter(e => Number(e.user_id) === Number(u.id));
      ok('seine Zeiteinträge sind vollständig erhalten', seine.length === werktage(`${JAHR}-01-01`, `${JAHR}-01-31`),
        `${seine.length} Einträge`);
      const login = await req('POST', '/api/auth/login', null, { username: 'wegabfeb', password: 'Start!2345' });
      ok('anmelden kann er sich nicht mehr', login.status === 401 || login.status === 403, String(login.status));
    }

    // ══ 4. Austritt RÜCKWIRKEND in einen abgerechneten Monat ════════════════════════════
    console.log('\n4) Austritt rückwirkend in einen bereits bezahlten Monat:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Rueck Datiert', 'rueckdat');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-02-28`);
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-02` });
      const jan = (await perioden(chef)).find(p => p.periodFrom.endsWith('-01-01'));
      const sollVorher = jan.zeilen.find(x => x.name === 'Rueck Datiert').soll;

      const chefVersuch = await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-20` });
      ok('der Chef kommt nicht durch', chefVersuch.status === 403, String(chefVersuch.status));
      const adminVersuch = await req('POST', `/api/users/${u.id}/deactivate`, admin, { employed_until: `${JAHR}-01-20`, reason: GRUND });
      ok('der Admin darf es mit Begründung', adminVersuch.status === 200, `${adminVersuch.status} ${adminVersuch.body?.error || ''}`);

      const janDanach = (await perioden(chef)).find(p => p.id === jan.id);
      ok('der Beleg bleibt auf dem bezahlten Soll stehen',
        janDanach.zeilen.find(x => x.name === 'Rueck Datiert').soll === sollVorher, 'Beleg wurde verändert');
      const abw = (await req('GET', `/api/closure/${jan.id}/abweichung`, chef)).body;
      ok('die Differenz wird ausgewiesen', abw.offenGesamt !== 0, String(abw.offenGesamt));
      ok('und ist positiv (weniger Soll ⇒ mehr Saldo)', abw.offenGesamt > 0, String(abw.offenGesamt));
      const ue = await req('POST', `/api/closure/${jan.id}/uebernehmen`, chef, { reason: 'Austrittsdatum korrigiert' });
      ok('sie lässt sich übernehmen', ue.status === 200, `${ue.status} ${ue.body?.error || ''}`);
    }

    // ══ 5. Wiedereinstellen — die Lücke zählt 0 ═════════════════════════════════════════
    console.log('\n5) Wiedereinstellen nach einer Lücke:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Kommt Zurueck', 'zurueck');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-31`);
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-31` });
      // Februar komplett Luecke, ab 01.03. wieder da
      const ein = await req('POST', `/api/users/${u.id}/reactivate`, chef, { start_date: `${JAHR}-03-01` });
      ok('Wiedereinstellen zum 1. März geht', ein.status === 200, `${ein.status} ${ein.body?.error || ''}`);
      await eintraege(admin, u.id, `${JAHR}-03-01`, `${JAHR}-03-31`);
      await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-03` });

      const ps = await perioden(chef);
      const feb = ps.find(p => p.periodFrom.endsWith('-02-01'));
      const maerz = ps.find(p => p.periodFrom.endsWith('-03-01'));
      ok('im Februar (Lücke) taucht er nicht auf', !feb.zeilen.some(x => x.name === 'Kommt Zurueck'),
        JSON.stringify(feb.zeilen.map(x => x.name)));
      const zM = maerz.zeilen.find(x => x.name === 'Kommt Zurueck');
      ok('im März ist er wieder dabei', !!zM);
      ok('mit vollem Soll für den ganzen März',
        zM && zM.soll === werktage(`${JAHR}-03-01`, `${JAHR}-03-31`) * 8, `Soll=${zM && zM.soll}`);
      ok('die Lücke hat den Überstundenstand nicht belastet', zM && zM.ueberstunden_gesamt === 0,
        `Überstunden gesamt=${zM && zM.ueberstunden_gesamt} — die Lücke darf kein Minus erzeugen`);

      const rueck = await req('POST', `/api/users/${u.id}/reactivate`, chef, { start_date: `${JAHR}-02-10` });
      ok('rückdatiertes Wiedereinstellen in den bezahlten Zeitraum wird geblockt',
        rueck.status === 400 || rueck.status === 403 || rueck.status === 409, String(rueck.status));
    }

    // ══ 6. Austritt genau am Stichtag und einen Tag danach ══════════════════════════════
    console.log('\n6) Austritt genau am Stichtag / einen Tag danach:');
    {
      const { admin, chef } = await frischerServer();
      const amStichtag = await legeAn(admin, chef, 'Am Stichtag', 'amstichtag');
      const danach = await legeAn(admin, chef, 'Tag Danach', 'tagdanach');
      for (const u of [amStichtag, danach]) await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-02-28`);
      await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });   // Stichtag 31.01.

      const genau = await req('POST', `/api/users/${amStichtag.id}/deactivate`, chef, { employed_until: `${JAHR}-01-31` });
      ok('Austritt GENAU am Stichtag wird geblockt (liegt im bezahlten Monat)', genau.status === 403, String(genau.status));
      const einTag = await req('POST', `/api/users/${danach.id}/deactivate`, chef, { employed_until: `${JAHR}-02-01` });
      ok('Austritt einen Tag nach dem Stichtag geht', einTag.status === 200, `${einTag.status} ${einTag.body?.error || ''}`);

      const zu = await req('POST', '/api/closure', chef, { month: `${JAHR}-02` });
      ok('der Februar lässt sich danach abschließen', zu.status === 201, `${zu.status} ${zu.body?.error || ''}`);
      const feb = (await perioden(chef)).find(p => p.periodFrom.endsWith('-02-01'));
      const zT = feb.zeilen.find(x => x.name === 'Tag Danach');
      ok('der am 1.2. Ausgeschiedene ist im Februar-Beleg', !!zT, 'fehlt — sein letzter Tag wäre unbelegt');
      ok('mit Soll für genau diesen einen Tag (oder 0, wenn Wochenende)',
        zT && zT.soll === werktage(`${JAHR}-02-01`, `${JAHR}-02-01`) * 8, `Soll=${zT && zT.soll}`);
    }

    // ══ 7. Ausstellen, abschließen, wieder öffnen ═══════════════════════════════════════
    console.log('\n7) Ausstellen, abschließen, wieder öffnen:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Auf Und Zu', 'aufundzu');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-31`);
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-20` });
      await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      const vorher = JSON.stringify((await perioden(chef))[0].zeilen.map(z => ({ n: z.name, s: z.soll, i: z.ist })));

      const id = (await perioden(admin))[0].id;
      const auf = await req('DELETE', `/api/closure/${id}`, admin, { reason: GRUND });
      ok('wieder öffnen geht auch mit einem Ausgestellten', auf.status === 200, `${auf.status} ${auf.body?.error || ''}`);
      const neu = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      ok('und erneut abschließen ebenso', neu.status === 201, `${neu.status} ${neu.body?.error || ''}`);
      ok('die Zahlen sind unverändert',
        JSON.stringify((await perioden(chef))[0].zeilen.map(z => ({ n: z.name, s: z.soll, i: z.ist }))) === vorher,
        'Belege weichen ab');
    }

    // ══ 8. Urlaub, der über den Austritt hinausreicht ═══════════════════════════════════
    console.log('\n8) Genehmigter Urlaub reicht über den Austritt hinaus:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Urlaub Ende', 'urlaubende');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-10`);
      // Urlaub 13.–24.01., Austritt aber schon am 17.01.
      const abw = await req('POST', '/api/absences', chef, {
        type: 'urlaub', date_from: `${JAHR}-01-13`, date_to: `${JAHR}-01-24`, target_user_id: u.id });
      ok('Urlaub über den Austritt hinaus lässt sich eintragen', abw.status === 201, String(abw.status));
      for (const a of (await req('GET', '/api/absences', admin)).body.absences.filter(x => x.status === 'pending')) {
        await req('POST', `/api/absences/${a.id}/approve`, chef);
      }
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-17` });
      const zu = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      ok('der Januar lässt sich abschließen', zu.status === 201, `${zu.status} ${zu.body?.error || ''}`);

      const z = (await perioden(chef))[0].zeilen.find(x => x.name === 'Urlaub Ende');
      const urlaubTage = werktage(`${JAHR}-01-13`, `${JAHR}-01-17`);   // nur bis zum Austritt
      ok(`Urlaubstage werden nur bis zum Austritt gezählt (${urlaubTage})`, z && z.urlaub === urlaubTage,
        `gezählt ${z && z.urlaub}, unabhängig gerechnet ${urlaubTage}`);
      ok('Soll endet ebenfalls am Austritt',
        z && z.soll === werktage(`${JAHR}-01-01`, `${JAHR}-01-10`) * 8, `Soll=${z && z.soll}`);
    }

    // ══ 9. Zwei Aus- und Wiedereintritte über abgeschlossene Monate ═════════════════════
    console.log('\n9) Zweimal ausgestellt und wieder eingestellt:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Hin Und Her', 'hinundher');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-31`);
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-31` });
      await req('POST', `/api/users/${u.id}/reactivate`, chef, { start_date: `${JAHR}-03-01` });
      await eintraege(admin, u.id, `${JAHR}-03-01`, `${JAHR}-03-31`);
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-03-31` });
      await req('POST', `/api/users/${u.id}/reactivate`, chef, { start_date: `${JAHR}-05-01` });
      await eintraege(admin, u.id, `${JAHR}-05-01`, `${JAHR}-05-31`);
      const zu = await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-05` });
      ok('fünf Monate mit zwei Lücken lassen sich abschließen',
        zu.status === 201 && zu.body.erledigt.length === 5, `${zu.status} ${(zu.body?.erledigt || []).length}`);

      const ps = await perioden(chef);
      const drin = ps.filter(p => p.zeilen.some(x => x.name === 'Hin Und Her')).map(p => p.periodFrom.slice(5, 7));
      ok('er steht genau in den drei Anstellungsmonaten', JSON.stringify(drin) === '["01","03","05"]', JSON.stringify(drin));
      const mai = ps.find(p => p.periodFrom.endsWith('-05-01')).zeilen.find(x => x.name === 'Hin Und Her');
      ok('die beiden Lücken haben kein Minus erzeugt', mai && mai.ueberstunden_gesamt === 0,
        `Überstunden gesamt=${mai && mai.ueberstunden_gesamt}`);
    }

    // ══ 10. Offener Antrag eines Ausgestellten blockiert den Abschluss ══════════════════
    console.log('\n10) Offener Antrag eines Ausgestellten:');
    {
      const { admin, chef } = await frischerServer();
      const u = await legeAn(admin, chef, 'Offen Beantragt', 'offenbeantragt');
      await eintraege(admin, u.id, `${JAHR}-01-01`, `${JAHR}-01-31`);
      await req('POST', '/api/absences', chef, {
        type: 'urlaub', date_from: `${JAHR}-01-20`, date_to: `${JAHR}-01-22`, target_user_id: u.id });
      await req('POST', `/api/users/${u.id}/deactivate`, chef, { employed_until: `${JAHR}-01-31` });

      const zu = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      ok('der offene Antrag blockiert den Abschluss auch bei einem Ausgestellten',
        zu.status === 409 && /Antrag/i.test(zu.body?.error || ''), `${zu.status} ${(zu.body?.error || '').slice(0, 90)}`);
      ok('die Meldung nennt ihn beim Namen', /Offen Beantragt/.test(zu.body?.error || '') ||
        (zu.body?.offen || []).some(o => o.name === 'Offen Beantragt'), JSON.stringify(zu.body?.offen || []));

      for (const a of (await req('GET', '/api/absences', admin)).body.absences.filter(x => x.status === 'pending')) {
        await req('POST', `/api/absences/${a.id}/reject`, chef);
      }
      const nachher = await req('POST', '/api/closure', chef, { month: `${JAHR}-01` });
      ok('nach der Entscheidung geht der Abschluss', nachher.status === 201, `${nachher.status} ${nachher.body?.error || ''}`);
    }

  } finally {
    if (srv) { srv.kill('SIGTERM'); await sleep(700); }
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAusstellen unter dem Abschluss: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); if (srv) srv.kill('SIGTERM'); process.exit(1); });
