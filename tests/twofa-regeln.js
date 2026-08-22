// Die Regeln der Zwei-Faktor-Anmeldung: Wer muss wie oft einen Code eingeben?
//
// Zwei Teile:
//   A) die reinen Regeln aus zweifaktor.js — mit GESTELLTER Uhr, damit sich „wöchentlich" prüfen
//      lässt, ohne eine Woche zu warten. Kein Server, kein Warten.
//   B) die Einstellungen je Rolle über die API, inklusive des Riegels, dass nur ein Admin die
//      Pflicht für Administratoren ändern darf.
//
//   node tests/twofa-regeln.js
const { spawn } = require('child_process');
const totp = require('../totp');
const http = require('http'); const fs = require('fs'); const path = require('path');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
delete process.env.TWOFA_AUS;
const zf = require('../zweifaktor');

const PORT = 3248, DB = '/tmp/twofa-regeln.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JETZT = Date.parse('2026-08-22T12:00:00Z');
const vorStunden = h => new Date(JETZT - h * 3600e3).toISOString().replace('T', ' ').replace('Z', '');
const vorTagen = t => vorStunden(t * 24);

(async () => {
  console.log('── A) Gültigkeit eines bestätigten Geräts, je Einstellung ──');
  // Jede Zeile: Einstellung, wie lange die Bestaetigung her ist, erwartet gueltig?
  const faelle = [
    ['geraet',       vorTagen(3650), true,  'nach zehn Jahren noch gültig — genau das heisst „einmal pro Gerät"'],
    ['taeglich',     vorStunden(23), true,  'nach 23 Stunden noch gültig'],
    ['taeglich',     vorStunden(25), false, 'nach 25 Stunden abgelaufen'],
    ['woechentlich', vorTagen(6),    true,  'nach 6 Tagen noch gültig'],
    ['woechentlich', vorTagen(8),    false, 'nach 8 Tagen abgelaufen'],
    ['monatlich',    vorTagen(29),   true,  'nach 29 Tagen noch gültig'],
    ['monatlich',    vorTagen(31),   false, 'nach 31 Tagen abgelaufen'],
    ['immer',        vorStunden(1),  false, '„jedes Mal" vertraut keinem Gerät, auch keinem frischen'],
    ['aus',          vorStunden(1),  false, 'bei „aus" gibt es kein Gerätevertrauen'],
  ];
  for (const [modus, bestaetigt, erwartet, text] of faelle) {
    ok(`${modus}: ${text}`, zf.geraetGueltig(bestaetigt, modus, JETZT) === erwartet);
  }
  ok('ohne Bestätigung nie gültig', zf.geraetGueltig(null, 'geraet', JETZT) === false);
  ok('unsinniger Zeitstempel → nicht gültig', zf.geraetGueltig('kein-datum', 'taeglich', JETZT) === false);

  console.log('\n── A) Wird beim Anmelden ein Code verlangt? ──');
  ok('ohne eingerichteten Authenticator nie',
    zf.codeNoetig({ modus: 'immer', eingerichtet: false, jetztMs: JETZT }) === false);
  ok('„jedes Mal" verlangt immer einen',
    zf.codeNoetig({ modus: 'immer', eingerichtet: true, geraetBestaetigtAm: vorStunden(1), jetztMs: JETZT }) === true);
  ok('„einmal pro Gerät" mit bekanntem Gerät: kein Code',
    zf.codeNoetig({ modus: 'geraet', eingerichtet: true, geraetBestaetigtAm: vorTagen(100), jetztMs: JETZT }) === false);
  ok('„einmal pro Gerät" ohne bekanntes Gerät: Code',
    zf.codeNoetig({ modus: 'geraet', eingerichtet: true, geraetBestaetigtAm: null, jetztMs: JETZT }) === true);
  ok('„wöchentlich", Gerät 8 Tage alt: Code',
    zf.codeNoetig({ modus: 'woechentlich', eingerichtet: true, geraetBestaetigtAm: vorTagen(8), jetztMs: JETZT }) === true);
  // Der Fall, der leicht vergessen wird: freiwillig eingerichtet, Rolle steht auf „aus".
  ok('freiwillig eingerichtet trotz Rolle „aus": es gilt „einmal pro Gerät" (unbekanntes Gerät → Code)',
    zf.codeNoetig({ modus: 'aus', eingerichtet: true, geraetBestaetigtAm: null, jetztMs: JETZT }) === true);
  ok('… und mit bekanntem Gerät kein Code',
    zf.codeNoetig({ modus: 'aus', eingerichtet: true, geraetBestaetigtAm: vorTagen(200), jetztMs: JETZT }) === false);

  console.log('\n── A) Muss die Einrichtung nachgeholt werden? ──');
  ok('Pflicht-Rolle ohne Authenticator → ja', zf.einrichtungNoetig('woechentlich', false) === true);
  ok('Pflicht-Rolle mit Authenticator → nein', zf.einrichtungNoetig('woechentlich', true) === false);
  ok('Rolle „aus" ohne Authenticator → nein', zf.einrichtungNoetig('aus', false) === false);

  console.log('\n── A) Der Notfall-Schalter sticht alles ──');
  process.env.TWOFA_AUS = '1';
  ok('kein Code mehr verlangt',
    zf.codeNoetig({ modus: 'immer', eingerichtet: true, geraetBestaetigtAm: null, jetztMs: JETZT }) === false);
  delete process.env.TWOFA_AUS;
  ok('… und nach dem Entfernen greift wieder alles',
    zf.codeNoetig({ modus: 'immer', eingerichtet: true, geraetBestaetigtAm: null, jetztMs: JETZT }) === true);

  // ── B) Über die API ────────────────────────────────────────────────────────────────────────
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/twofa-regeln-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/twofa-regeln-srv.log', 'utf8'); if (/chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;

    console.log('\n── B) Vorgabe nach dem Update: für niemanden ändert sich etwas ──');
    const start = (await req('GET', '/api/settings', admin)).body.settings;
    ok('keine der vier Einstellungen ist gesetzt',
      !start.twofa_admin && !start.twofa_chef && !start.twofa_buchhalter && !start.twofa_mitarbeiter,
      JSON.stringify({ a: start.twofa_admin, c: start.twofa_chef }));

    // Der Admin richtet sich zuerst selbst einen Authenticator ein.
    //
    // Ohne das sperrt sich dieser Test bei der naechsten Zeile selbst aus — und zwar voellig zu
    // Recht: Sobald twofa_admin scharf steht und der Admin keinen Authenticator hat, greift der
    // Einrichtungs-Zwang sofort und jede weitere Anfrage bekommt 403. Genau so soll es sein; hier
    // ist es nur laestig. (Beim ersten Lauf ist mir dieser Test deshalb umgefallen.)
    // Dasselbe gilt fuer den Chef, sobald weiter unten twofa_chef scharf gestellt wird.
    const einrichten = async (token, wer) => {
      const setup = await req('POST', '/api/auth/2fa/setup', token);
      // Nacheinander im selben 30-Sekunden-Fenster geht nicht (Replay-Riegel je Nutzer) — es sind
      // aber verschiedene Nutzer mit eigenen Geheimnissen, also unproblematisch.
      const v = await req('POST', '/api/auth/2fa/verify', token, { code: totp.code(setup.body.geheim) });
      ok(`${wer} hat für diesen Test einen Authenticator eingerichtet`, v.status === 200,
        `${v.status} ${v.text.slice(0, 60)}`);
    };
    await einrichten(admin, 'Admin');
    await einrichten(chef, 'Chef');

    console.log('\n── B) Speichern und Prüfen der Werte ──');
    const gut = await req('PUT', '/api/settings', admin,
      { twofa_admin: 'immer', twofa_chef: 'woechentlich', twofa_buchhalter: 'monatlich', twofa_mitarbeiter: 'geraet' });
    ok('gültige Werte werden gespeichert', gut.status === 200, `${gut.status} ${gut.text.slice(0, 90)}`);
    const jetzt = (await req('GET', '/api/settings', admin)).body.settings;
    ok('… und stehen danach drin',
      jetzt.twofa_admin === 'immer' && jetzt.twofa_chef === 'woechentlich'
      && jetzt.twofa_buchhalter === 'monatlich' && jetzt.twofa_mitarbeiter === 'geraet',
      JSON.stringify(jetzt.twofa_chef));
    const bloed = await req('PUT', '/api/settings', admin, { twofa_chef: 'manchmal' });
    ok('ein erfundener Wert wird abgelehnt', bloed.status === 400, `${bloed.status} ${bloed.text.slice(0, 80)}`);
    ok('… und ändert nichts',
      (await req('GET', '/api/settings', admin)).body.settings.twofa_chef === 'woechentlich');

    console.log('\n── B) Der Riegel: nur ein Admin darf die Admin-Pflicht ändern ──');
    const chefVersuch = await req('PUT', '/api/settings', chef, { twofa_admin: 'aus' });
    ok('Chef darf twofa_admin NICHT ändern', chefVersuch.status === 403, `${chefVersuch.status} ${chefVersuch.text.slice(0, 80)}`);
    ok('… der Wert steht unverändert auf „immer"',
      (await req('GET', '/api/settings', admin)).body.settings.twofa_admin === 'immer');
    const chefDarf = await req('PUT', '/api/settings', chef, { twofa_mitarbeiter: 'taeglich' });
    ok('… die anderen Rollen darf der Chef sehr wohl ändern', chefDarf.status === 200, String(chefDarf.status));
    ok('… und das ist auch angekommen',
      (await req('GET', '/api/settings', admin)).body.settings.twofa_mitarbeiter === 'taeglich');
    const adminDarf = await req('PUT', '/api/settings', admin, { twofa_admin: 'taeglich' });
    ok('der Admin selbst darf es', adminDarf.status === 200, String(adminDarf.status));

    console.log('\n── B) Gespeicherter Wert kommt zurück ──');
    // ACHTUNG, hier hatte ich zuerst „die Änderung greift sofort trotz Zwischenspeicher" stehen —
    // das prüft diese Zeile NICHT: GET /api/settings liest unmittelbar aus der Datenbank und geht
    // am Zwischenspeicher von modusFuerRolle vorbei. Ob das Verwerfen des Speichers wirkt, kann
    // erst der Anmelde-Test zeigen, der modusFuerRolle wirklich benutzt. Bis dahin steht hier nur
    // die ehrliche, kleinere Aussage.
    await req('PUT', '/api/settings', admin, { twofa_buchhalter: 'aus' });
    const sofort = (await req('GET', '/api/settings', admin)).body.settings.twofa_buchhalter;
    ok('der geänderte Wert steht in der Datenbank', sofort === 'aus', String(sofort));

    console.log('\n── B) Andere Einstellungen bleiben unberührt (Abwärtskompatibilität) ──');
    await req('PUT', '/api/settings', admin, { company_name: 'SenTec', work_start_default: '07:30' });
    const misch = (await req('GET', '/api/settings', admin)).body.settings;
    ok('Firmenname gespeichert', misch.company_name === 'SenTec');
    ok('Arbeitsbeginn gespeichert', misch.work_start_default === '07:30');
    ok('… und die 2FA-Werte stehen weiterhin', misch.twofa_admin === 'taeglich', String(misch.twofa_admin));
    ok('der schmale Endpunkt für alle Rollen antwortet weiterhin',
      (await req('GET', '/api/settings/arbeitszeit', chef)).status === 200);

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n2FA-Regeln: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
