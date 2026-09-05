// Ausstellen mit ZUKÜNFTIGEM Austrittsdatum: vormerken statt sofort aussperren.
//
// Der Fehler, um den es geht (Alex, 04.09.2026): Wer am 05.09. ausstellte und den 30.09. als
// letzten Arbeitstag eintrug, sperrte den Mitarbeiter SOFORT aus — während sein Soll bis zum
// 30.09. weiterlief (`isEmployedOn` zählt bis einschließlich Austrittsdatum). Er konnte seine
// Stunden nicht mehr buchen. Ergebnis: 18 Arbeitstage mit Soll, aber ohne Ist — rund 144 Stunden,
// die still vom Überstundenstand abgingen. Ausgerechnet in der Lage, in der dieser Stand
// ausgezahlt wird.
//
// Geprüft wird deshalb BEIDES:
//   * dass der Zugang bis zum letzten Arbeitstag bestehen bleibt (sonst kann er nicht buchen)
//   * dass das Soll trotzdem am Austrittstag endet (sonst wäre die Vormerkung wirkungslos)
//
// Und die Gegenrichtung: Ein RÜCKWIRKENDES Datum muss weiterhin sofort wirken — das ist der
// bewährte Weg, den die Firma bisher benutzt hat.
//
//   node tests/austritt-vormerken.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3303, DB = '/tmp/austritt-vormerken.db', LOG = '/tmp/austritt-vormerken-srv.log';
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

// Alles RELATIV zu heute — ein festes Datum bedeutet in einem Jahr etwas anderes
// ([[reference_tests_zeitfallen]]).
const heute = new Date().toLocaleDateString('sv-SE');
const plus = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const werktage = (von, bis) => {
  let n = 0; const c = new Date(von + 'T12:00:00Z'), e = new Date(bis + 'T12:00:00Z');
  while (c <= e) { const d = c.getUTCDay(); if (d !== 0 && d !== 6) n++; c.setUTCDate(c.getUTCDate() + 1); }
  return n;
};

const zeitraeume = (db, id) => db;   // Platzhalter, wird über die API gelesen

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
    const PW = 'Austritt!2345';
    // Die selbst angelegten Konten haben PW — `pw()` liest nur die Startpasswoerter aus dem
    // Server-Protokoll und liefert fuer sie `undefined`.
    const anMit = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PW })).body.token;

    const anlegen = async (benutzer, name, abWann) => {
      const u = (await req('POST', '/api/users', admin, {
        username: benutzer, password: PW, name, role: 'mitarbeiter', target_hours_per_week: 40,
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
      if (abWann) {
        // Zieht den Anstellungsbeginn zurueck — sonst waere ein rueckwirkendes Austrittsdatum
        // „vor dem Eintrittsdatum" und wuerde zu Recht abgewiesen.
        await req('POST', `/api/statistics/targets/${u.id}`, chef, {
          hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: abWann });
      }
      return u;
    };
    const holen = async (id) => (await req('GET', '/api/users', admin)).body.users.find(u => u.id === id);

    console.log('── Zukünftiges Austrittsdatum: vormerken, nicht aussperren ──');
    const v = await anlegen('vorgemerkt', 'Vera Vorgemerkt');
    const vTok = await anMit('vorgemerkt');
    ok('Aufbau: Konto angelegt und angemeldet', !!v && !!vTok, JSON.stringify(v && v.id));

    const inZwanzig = plus(20);
    const r = await req('POST', `/api/users/${v.id}/deactivate`, chef, { employed_until: inZwanzig });
    ok('Ausstellen mit Datum in der Zukunft wird angenommen', r.status === 200, r.status + ' ' + r.text.slice(0, 90));
    ok('… und meldet sich ausdrücklich als Vormerkung', r.body && r.body.vorgemerkt === true, JSON.stringify(r.body));

    const nach = await holen(v.id);
    ok('das Konto bleibt AKTIV', nach && Number(nach.active) === 1, JSON.stringify(nach && nach.active));
    ok('… das Austrittsdatum steht trotzdem schon fest',
      nach && (nach.employment || []).some(p => p.e === inZwanzig), JSON.stringify(nach && nach.employment));

    // Der eigentliche Punkt: Er muss weiterarbeiten können.
    const buchen = await req('POST', '/api/entries', vTok, { date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'letzte Wochen' });
    ok('er kann sich noch anmelden und Stunden buchen', buchen.status === 201, buchen.status + ' ' + buchen.text.slice(0, 90));
    ok('… seine Sitzung lebt (geschützter Aufruf geht)', (await req('GET', '/api/entries', vTok)).status === 200);

    console.log('\n── Das Soll endet trotzdem am Austrittstag ──');
    // Ohne diese Prüfung wäre die Vormerkung wirkungslos — dann liefe die Anstellung einfach weiter.
    const nachAustritt = plus(25);
    const csv = (await req('GET', `/api/payroll/monat.csv?month=${nachAustritt.slice(0, 7)}`, admin)).text;
    ok('der Lohn-Export ist abrufbar', csv.length > 20, csv.slice(0, 60));
    const zeile = csv.split('\r\n').find(z => z.includes('Vera Vorgemerkt'));
    ok('… und nennt „Beschäftigt bis" mit dem vorgemerkten Datum',
      !!zeile && zeile.includes(inZwanzig), (zeile || '').slice(0, 160));

    console.log('\n── Zwei-Faktor und Push bleiben bis zum Vollzug ──');
    // Sie erst beim Vollzug zu löschen ist der Sinn der Sache: Bis dahin arbeitet er normal weiter.
    const zwei = await req('GET', '/api/twofa/status', vTok);
    ok('sein Zwei-Faktor-Zustand ist weiterhin abrufbar', zwei.status === 200, zwei.status + ' ' + zwei.text.slice(0, 80));

    console.log('\n── Die Vormerkung lässt sich aufheben ──');
    const auf = await req('POST', `/api/users/${v.id}/austritt-aufheben`, chef);
    ok('Aufheben geht', auf.status === 200, auf.status + ' ' + auf.text.slice(0, 90));
    const nachAuf = await holen(v.id);
    ok('… danach ist kein Austrittsdatum mehr gesetzt',
      nachAuf && !(nachAuf.employment || []).some(p => p.e), JSON.stringify(nachAuf && nachAuf.employment));
    ok('… und das Konto ist weiterhin aktiv', nachAuf && Number(nachAuf.active) === 1);
    const nochmal = await req('POST', `/api/users/${v.id}/austritt-aufheben`, chef);
    ok('ein zweites Aufheben wird abgewiesen', nochmal.status === 409, nochmal.status + ' ' + nochmal.text.slice(0, 90));

    console.log('\n── Heute als letzter Arbeitstag: er arbeitet heute noch ──');
    const t = await anlegen('heutetag', 'Theo Heute');
    const tTok = await anMit('heutetag');
    const rt = await req('POST', `/api/users/${t.id}/deactivate`, chef, { employed_until: heute });
    ok('wird als Vormerkung behandelt, nicht als sofortiges Ausstellen',
      rt.status === 200 && rt.body.vorgemerkt === true, rt.status + ' ' + JSON.stringify(rt.body));
    ok('… er kommt heute noch hinein', (await req('GET', '/api/entries', tTok)).status === 200);

    console.log('\n── Rückwirkendes Datum wirkt weiterhin SOFORT ──');
    // Der bewährte Weg. Würde er sich mit ändern, wäre die Reparatur eine Verschlechterung.
    const s = await anlegen('sofort', 'Sofia Sofort', plus(-60));
    const sTok = await anMit('sofort');
    const rs = await req('POST', `/api/users/${s.id}/deactivate`, chef, { employed_until: plus(-1) });
    ok('Ausstellen mit gestrigem Datum geht', rs.status === 200, rs.status + ' ' + rs.text.slice(0, 90));
    ok('… und ist ausdrücklich KEINE Vormerkung', rs.body && rs.body.vorgemerkt === false, JSON.stringify(rs.body));
    const nachS = (await req('GET', '/api/users/inactive', admin)).body;
    ok('… das Konto ist geschlossen',
      JSON.stringify(nachS).includes('Sofia Sofort'), JSON.stringify(nachS).slice(0, 140));
    ok('… seine Sitzung ist sofort tot (401)', (await req('GET', '/api/entries', sTok)).status === 401);
    const aufS = await req('POST', `/api/users/${s.id}/austritt-aufheben`, chef);
    ok('bei einem geschlossenen Konto verweist das Aufheben auf „Wiedereinstellen"',
      aufS.status === 409 && /Wiedereinstellen/i.test(aufS.text), aufS.status + ' ' + aufS.text.slice(0, 110));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    srv.kill();
  }
  console.log(`\nAustritt vormerken: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
