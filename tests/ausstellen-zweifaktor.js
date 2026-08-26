// Was bleibt liegen, wenn jemand ausgestellt wird? (Alex, 25.08.2026)
//
// Ausstellen ist ein Soft-Delete: Alle Daten bleiben, damit die Historie stimmt. Beim zweiten
// Faktor ist genau das aber gefaehrlich. Der Authenticator auf dem privaten Handy ueberlebt das
// Ausstellen sonst — samt der gemerkten Geraete, die je nach Intervall wochenlang gar keinen Code
// verlangen. Kaeme der Account je versehentlich wieder auf active=1, waere das alte Handy sofort
// wieder ein gueltiger zweiter Faktor. Kein Schutz mehr, sondern eine offene Tuer, die niemand
// sieht.
//
// Deshalb wird er beim Ausstellen geloescht. Und deshalb prueft dieser Test beide Richtungen:
// dass der zweite Faktor WEG ist — und dass alles andere NICHT angefasst wurde.
//
//   node tests/ausstellen-zweifaktor.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3290, DB = '/tmp/ausstellen-2fa.db', LOG = '/tmp/ausstellen-2fa-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
           TWOFA_KEY: 'FSuaZ0oS0k9m1qJ0m5b3fS0mF0mZ0aS0k9m1qJ0m5b3=' }, stdio: ['ignore', lg, lg] });
  const initSqlJs = require('sql.js');
  const totp = require('../totp');
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;

    const PW = 'Monteur!2026x';
    const u = (await req('POST', '/api/users', admin, { username: 'monteur', password: PW, name: 'Mark Monteur',
      role: 'mitarbeiter', target_hours_per_week: 38.5, start_overtime: 12.5, can_plan: true, can_bulletin: true,
      personnel_no: 'P-77', work_start: '06:30', birth_date: '1990-04-01' })).body.user;
    ok('Mitarbeiter angelegt', !!u, JSON.stringify(u));
    const tok = (await req('POST', '/api/auth/login', null, { username: 'monteur', password: PW })).body.token;

    // Zwei-Faktor wirklich einrichten (nicht in die Tabelle schreiben) — nur so entstehen auch
    // die Geraete-Eintraege, um die es hier geht.
    const start = await req('POST', '/api/auth/2fa/setup', tok);
    ok('Einrichtung gestartet', start.status === 200 && !!start.body.geheim, start.status + ' ' + start.text.slice(0, 80));
    const scharf = await req('POST', '/api/auth/2fa/verify', tok, { code: totp.code(start.body.geheim), geraet_merken: true });
    ok('… mit gültigem Code scharf geschaltet', scharf.status === 200, scharf.status + ' ' + scharf.text.slice(0, 90));

    // Direkt in der Datei nachsehen — der Server hat sie gerade gespeichert.
    async function tabellen() {
      // GET /api/backup/download ruft saveToFile() auf — ohne das liest man die Datei von vor bis
      // zu fuenf Sekunden (Autosave-Takt) und misst einen Stand, den es so gar nicht mehr gibt.
      // Mit POST (Tippfehler im ersten Wurf) passiert gar nichts: Die Tabellen waren dann LEER,
      // und „der Zwei-Faktor ist weg" war gruen, ohne irgendetwas zu belegen.
      await req('GET', '/api/backup/download', admin).catch(() => {});
      await sleep(400);
      const SQL = await initSqlJs();
      const db = new SQL.Database(fs.readFileSync(DB));
      const z = (s) => { try { const r = db.exec(s); return r[0] ? r[0].values : []; } catch (_) { return []; } };
      const raus = {
        secrets: z(`SELECT user_id FROM twofa_secrets WHERE user_id = ${u.id}`).length,
        devices: z(`SELECT id FROM twofa_devices WHERE user_id = ${u.id}`).length,
        avatare: z(`SELECT user_id FROM user_avatars WHERE user_id = ${u.id}`).length,
        abos: z(`SELECT id FROM push_subscriptions WHERE user_id = ${u.id}`).length,
        user: z(`SELECT active, can_plan, can_bulletin, target_hours_per_week, start_overtime, personnel_no, work_start, birth_date FROM users WHERE id = ${u.id}`)[0],
      };
      db.close();
      return raus;
    }
    // Ein Geraet und ein Push-Abo dazu, damit sich beides unterscheiden laesst.
    await req('POST', '/api/push/subscribe', tok, { endpoint: 'sub://monteur', keys: { p256dh: 'k', auth: 'k' } });

    let vor = await tabellen();
    ok('vorher: Zwei-Faktor ist hinterlegt', vor.secrets === 1, JSON.stringify(vor.secrets));
    ok('vorher: ein Push-Abo liegt vor', vor.abos === 1, JSON.stringify(vor.abos));

    console.log('\n── Ausstellen ──');
    // Relativ rechnen, nicht fest eintragen: Der Mitarbeiter wird HEUTE angelegt, sein
    // Anstellungszeitraum beginnt also heute. Ein festes Datum ist am naechsten Tag zwangslaeufig
    // zu frueh — genau daran ist dieser Test einen Tag nach seiner Entstehung umgefallen
    // (dieselbe Falle wie in tests/trash-access.js, 25.08.2026).
    const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
    const morgen = new Date(Date.now() + 24 * 3600 * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
    const r = await req('POST', `/api/users/${u.id}/deactivate`, admin, { employed_until: heute });
    ok('ausgestellt', r.status === 200, r.status + ' ' + r.text.slice(0, 90));

    const nach = await tabellen();
    ok('der Zwei-Faktor ist WEG', nach.secrets === 0, JSON.stringify(nach.secrets));
    ok('… auch die gemerkten Geräte', nach.devices === 0, JSON.stringify(nach.devices));
    ok('… und die Push-Abos (wie bisher)', nach.abos === 0, JSON.stringify(nach.abos));

    console.log('\n── Was ABSICHTLICH stehen bleibt ──');
    ok('Account ist ausgestellt (active=0)', nach.user[0] === 0, JSON.stringify(nach.user));
    ok('Planungsrecht bleibt', nach.user[1] === 1, JSON.stringify(nach.user));
    ok('Schwarzes-Brett-Recht bleibt', nach.user[2] === 1);
    ok('Soll-Stunden bleiben (38,5)', Number(nach.user[3]) === 38.5, String(nach.user[3]));
    ok('Start-Überstunden bleiben (12,5)', Number(nach.user[4]) === 12.5, String(nach.user[4]));
    ok('Personalnummer bleibt', nach.user[5] === 'P-77', String(nach.user[5]));
    ok('Arbeitsbeginn bleibt', nach.user[6] === '06:30', String(nach.user[6]));
    ok('Geburtsdatum bleibt', nach.user[7] === '1990-04-01', String(nach.user[7]));

    console.log('\n── Der Zugang ist wirklich zu ──');
    const login = await req('POST', '/api/auth/login', null, { username: 'monteur', password: PW });
    ok('Anmelden schlägt fehl', login.status === 403, login.status + ' ' + login.text.slice(0, 70));
    const alteSitzung = await req('GET', '/api/orders', tok);
    ok('… und die laufende Sitzung fliegt sofort raus (401)', alteSitzung.status === 401, alteSitzung.status + '');

    console.log('\n── Wiedereinstellen ──');
    const wieder = await req('POST', `/api/users/${u.id}/reactivate`, admin, { start_date: morgen });
    ok('wiedereingestellt', wieder.status === 200, wieder.status + ' ' + wieder.text.slice(0, 80));
    const tok2 = (await req('POST', '/api/auth/login', null, { username: 'monteur', password: PW })).body.token;
    ok('… Anmelden geht wieder', !!tok2);
    const zustand = await req('GET', '/api/auth/2fa/status', tok2);
    const zf = zustand.body && zustand.body.zwei_faktor;
    ok('… der zweite Faktor muss NEU eingerichtet werden',
      zustand.status === 200 && zf && zf.eingerichtet === false, zustand.status + ' ' + zustand.text.slice(0, 120));
    const nach2 = await tabellen();
    ok('… und die alten Rechte sind noch da', nach2.user[1] === 1 && nach2.user[2] === 1, JSON.stringify(nach2.user));
    ok('… ebenso Soll-Stunden und Start-Überstunden', Number(nach2.user[3]) === 38.5 && Number(nach2.user[4]) === 12.5);

    console.log('\n── Im Protokoll steht es auch ──');
    const audit = await req('GET', '/api/audit?limit=50', admin);
    const eintrag = (audit.body.logs || audit.body.entries || []).find(z => z.action === 'user_deactivate');
    ok('der Audit-Eintrag nennt die gelöschte Zwei-Faktor-Anmeldung',
      !!eintrag && /Zwei-Faktor geloescht/.test(eintrag.details || ''), JSON.stringify(eintrag && eintrag.details));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally { srv.kill('SIGTERM'); await sleep(600); }

  console.log(`\nAusstellen & Zwei-Faktor: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
