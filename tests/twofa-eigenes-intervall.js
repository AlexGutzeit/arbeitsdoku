// Wer sich FREIWILLIG absichert, bestimmt selbst, wie oft ein Code verlangt wird
// (Alex, 23.08.2026).
//
// Bisher galt für Freiwillige fest „einmal pro Gerät" — die mildeste Stufe. Wer es strenger will,
// hatte keine Möglichkeit dazu, und wer nur gelegentlich gefragt werden möchte, ebenfalls nicht.
//
// Drei Dinge sind hier heikel und werden deshalb einzeln geprüft:
//   1. Die ROLLE gewinnt. Schreibt die Verwaltung etwas vor, ist der eigene Wunsch wirkungslos —
//      bleibt aber gespeichert und greift wieder, sobald die Pflicht aufgehoben wird.
//   2. Umstellen verlangt einen Code. Sonst könnte an einem unbeaufsichtigten, noch angemeldeten
//      Gerät jemand die Absicherung lockern.
//   3. Strenger werden muss SOFORT wirken. Ein gemerktes Gerät darf einen nicht weiter ohne Code
//      hereinlassen, nachdem man auf „bei jeder Anmeldung" gestellt hat.
//
//   node tests/twofa-eigenes-intervall.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const totp = require('../totp');

const PORT = 3282, DB = '/tmp/twofa-intervall.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, keks) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(keks ? { Cookie: keks } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {}
        const sc = x.headers['set-cookie'] || [];
        res({ status: x.statusCode, body: j, text: s, keks: (sc.find(c => /ad_geraet=/.test(c)) || '').split(';')[0] }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Ein Code, der sicher NEUER ist als der zuletzt verbrauchte Zeitschritt DIESES Schluessels.
// Der Server nimmt nur die drei Fenster um „jetzt", und jeder Code verbraucht seinen Schritt —
// wer mehrere hintereinander braucht, muss also gelegentlich auf das naechste Fenster warten
// (hoechstens 30 Sekunden). Je Schluessel getrennt, denn jeder Nutzer hat seinen eigenen Zaehler.
const letzterSchritt = new Map();
async function frisch(geheim) {
  const zuletzt = letzterSchritt.has(geheim) ? letzterSchritt.get(geheim) : -1;
  while (Math.floor(Date.now() / 30000) + 1 <= zuletzt) await sleep(1000);
  letzterSchritt.set(geheim, Math.floor(Date.now() / 30000) + 1);
  return totp.code(geheim, Date.now() + 30000);
}
const zustand = async (t) => (await req('GET', '/api/auth/2fa/status', t)).body.zwei_faktor;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/twofa-intervall-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/twofa-intervall-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const maPw = pw('max');
    let maT = (await req('POST', '/api/auth/login', null, { username: 'max', password: maPw })).body.token;

    // ── Zuerst die REGEL selbst, ohne Server drumherum ────────────────────────────────────────
    // Warum das hier steht: Die Prüfungen weiter unten laufen über die Anmeldung — und die
    // erzwingt einen Code schon deshalb, weil das Umstellen die gemerkten Geräte löscht. Sie
    // blieben deshalb auch dann grün, wenn die Intervall-Regel gar nichts täte. (Genau das hat
    // die erste Gegenprobe gezeigt.) Diese Tabelle prüft die Rechnung direkt.
    console.log('── Die Regel selbst ──');
    const zf = require('../zweifaktor');
    const vorTagen = (t) => new Date(Date.now() - t * 864e5).toISOString();
    const noetig = (eigenModus, tage, modus = 'aus') =>
      zf.codeNoetig({ modus, eingerichtet: true, eigenModus, geraetBestaetigtAm: vorTagen(tage) });
    ok('ohne eigenen Wunsch gilt weiter „einmal pro Gerät" (auch nach 400 Tagen kein Code)',
      noetig(null, 400) === false);
    ok('„einmal pro Gerät" ausdrücklich gewählt: ebenso', noetig('geraet', 400) === false);
    ok('„täglich": ein 2 Tage altes Gerät reicht NICHT mehr', noetig('taeglich', 2) === true);
    ok('„täglich": ein 5 Stunden altes genügt', noetig('taeglich', 5 / 24) === false);
    ok('„wöchentlich": nach 3 Tagen kein Code', noetig('woechentlich', 3) === false);
    ok('„wöchentlich": nach 8 Tagen schon', noetig('woechentlich', 8) === true);
    ok('„monatlich": nach 10 Tagen kein Code', noetig('monatlich', 10) === false);
    ok('„monatlich": nach 40 Tagen schon', noetig('monatlich', 40) === true);
    ok('„bei jeder Anmeldung": auch ein frisch bestätigtes Gerät hilft nicht',
      noetig('immer', 0.001) === true);
    ok('die Rolle gewinnt: Pflicht „immer" schlägt den eigenen Wunsch „monatlich"',
      noetig('monatlich', 0.001, 'immer') === true);
    ok('… und umgekehrt: Pflicht „monatlich" schlägt den eigenen Wunsch „immer"',
      noetig('immer', 10, 'monatlich') === false);
    ok('ein unsinniger gespeicherter Wert fällt auf „einmal pro Gerät" zurück',
      noetig('jaehrlich', 400) === false);

    console.log('\n── Freiwillig einrichten, Rolle steht auf „aus" ──');
    const setup = (await req('POST', '/api/auth/2fa/setup', maT, {})).body;
    ok('Schlüssel erhalten', /^[A-Z2-7]{32}$/.test(setup.geheim || ''));
    ok('bestätigt', (await req('POST', '/api/auth/2fa/verify', maT, { code: await frisch(setup.geheim) })).status === 200);
    let z = await zustand(maT);
    ok('die Vorgabe ist „einmal pro Gerät"', z.eigen_modus === 'geraet', String(z.eigen_modus));
    ok('… und sie ist wählbar, weil die Rolle nichts vorschreibt', z.eigen_modus_waehlbar === true);
    ok('… zur Auswahl stehen fünf Stufen OHNE „aus"',
      Array.isArray(z.modi_auswahl) && z.modi_auswahl.length === 5 && !z.modi_auswahl.some(m => m.wert === 'aus'),
      JSON.stringify((z.modi_auswahl || []).map(m => m.wert)));

    console.log('\n── Umstellen verlangt einen Code ──');
    let r = await req('POST', '/api/auth/2fa/eigener-modus', maT, { modus: 'taeglich' });
    ok('ohne Code abgelehnt', r.status === 400, `${r.status} ${r.text.slice(0, 70)}`);
    r = await req('POST', '/api/auth/2fa/eigener-modus', maT, { modus: 'taeglich', code: '000000' });
    ok('mit falschem Code abgelehnt', r.status === 400, `${r.status} ${r.text.slice(0, 70)}`);
    r = await req('POST', '/api/auth/2fa/eigener-modus', maT, { modus: 'jaehrlich', code: await frisch(setup.geheim) });
    ok('ein erfundener Wert wird abgelehnt', r.status === 400, `${r.status} ${r.text.slice(0, 70)}`);
    ok('… und nichts davon hat etwas geändert', (await zustand(maT)).eigen_modus === 'geraet');

    r = await req('POST', '/api/auth/2fa/eigener-modus', maT, { modus: 'taeglich', code: await frisch(setup.geheim) });
    ok('mit gültigem Code klappt es', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    ok('… und der Zustand sagt „täglich"', (await zustand(maT)).eigen_modus === 'taeglich');

    console.log('\n── Und die Anmeldung hält sich daran ──');
    // Gerät merken lassen, dann so tun, als wäre es von gestern.
    let a = await req('POST', '/api/auth/login', null, { username: 'max', password: maPw });
    ok('Code wird verlangt', a.body.zwei_faktor_erforderlich === true);
    ok('… und „Gerät merken" ist erlaubt (nicht „bei jeder Anmeldung")', a.body.geraet_merkbar === true);
    let v = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frisch(setup.geheim), geraet_merken: true });
    ok('Anmeldung klappt und das Gerät wird gemerkt', v.status === 200 && !!v.keks, `${v.status} ${v.keks}`);
    const keks = v.keks;
    maT = v.body.token;
    a = await req('POST', '/api/auth/login', null, { username: 'max', password: maPw }, keks);
    ok('gleich danach: kein Code (Gerät ist frisch bestätigt)', !a.body.zwei_faktor_erforderlich && !!a.body.token);

    console.log('\n── Strenger stellen wirkt SOFORT, auch auf gemerkte Geräte ──');
    r = await req('POST', '/api/auth/2fa/eigener-modus', maT, { modus: 'immer', code: await frisch(setup.geheim) });
    ok('auf „bei jeder Anmeldung" gestellt', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    a = await req('POST', '/api/auth/login', null, { username: 'max', password: maPw }, keks);
    ok('das bekannte Gerät hilft jetzt NICHT mehr', a.body.zwei_faktor_erforderlich === true,
      JSON.stringify(a.body).slice(0, 80));
    ok('… und „Gerät merken" wird gar nicht erst angeboten', a.body.geraet_merkbar === false);
    v = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frisch(setup.geheim) });
    ok('mit Code kommt er hinein', v.status === 200 && !!v.body.token, `${v.status}`);
    maT = v.body.token;

    console.log('\n── Die Rolle gewinnt, sobald die Verwaltung etwas vorschreibt ──');
    // Scharfschalten braucht einen eigenen Authenticator des Admins.
    const aSetup = (await req('POST', '/api/auth/2fa/setup', admin, {})).body;
    await req('POST', '/api/auth/2fa/verify', admin, { code: await frisch(aSetup.geheim) });
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'woechentlich', twofa_code: await frisch(aSetup.geheim) });
    ok('Pflicht „wöchentlich" steht', r.status === 200, `${r.status} ${r.text.slice(0, 70)}`);
    z = await zustand(maT);
    ok('die Anzeige nennt jetzt die Vorgabe', z.modus === 'woechentlich' && z.pflicht === true, JSON.stringify({ m: z.modus, p: z.pflicht }));
    ok('… die eigene Auswahl ist nicht mehr wählbar', z.eigen_modus_waehlbar === false);
    ok('… der eigene Wunsch bleibt aber gespeichert', z.eigen_modus === 'immer', String(z.eigen_modus));
    r = await req('POST', '/api/auth/2fa/eigener-modus', maT, { modus: 'monatlich', code: await frisch(setup.geheim) });
    ok('Umstellen wird abgelehnt, solange die Pflicht gilt', r.status === 403, `${r.status} ${r.text.slice(0, 80)}`);

    console.log('\n── Nimmt die Verwaltung die Pflicht zurück, gilt wieder der eigene Wunsch ──');
    await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'aus' });
    z = await zustand(maT);
    ok('wieder wählbar', z.eigen_modus_waehlbar === true);
    ok('… und es gilt wieder „bei jeder Anmeldung"', z.eigen_modus === 'immer' && z.modus_text === 'aus',
      JSON.stringify({ eigen: z.eigen_modus, rolle: z.modus }));
    a = await req('POST', '/api/auth/login', null, { username: 'max', password: maPw }, keks);
    ok('die Anmeldung verlangt entsprechend einen Code', a.body.zwei_faktor_erforderlich === true);

    console.log('\n── Wer nichts eingerichtet hat, kann auch nichts einstellen ──');
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;
    r = await req('POST', '/api/auth/2fa/eigener-modus', chef, { modus: 'taeglich', code: '123456' });
    ok('abgelehnt', r.status === 400, `${r.status} ${r.text.slice(0, 70)}`);
    ok('ohne Anmeldung erst recht',
      (await req('POST', '/api/auth/2fa/eigener-modus', null, { modus: 'taeglich', code: '123456' })).status === 401);

    console.log('\n── Alex\' Ablauf, Schritt fuer Schritt (23.08.2026) ──');
    // Sein Wortlaut: „freiwillig einschalten und 1x pro Monat sagen, gilt das. Wenn dann die
    // Pflicht kommt mit einmal die Woche, gilt das. Wenn die Pflicht heraus genommen wird, gilt
    // wieder 1x pro Monat. Dann kann ich auch wieder abschalten. Wenn Pflicht, kann ich auch
    // nicht abschalten." — genau so nachgespielt, mit einem frischen Nutzer.
    await req('POST', '/api/users', admin, { username: 'ablauf', password: 'Test1234!', name: 'Ablauf Probe', role: 'mitarbeiter' });
    let bT = (await req('POST', '/api/auth/login', null, { username: 'ablauf', password: 'Test1234!' })).body.token;
    const bSetup = (await req('POST', '/api/auth/2fa/setup', bT, {})).body;
    await req('POST', '/api/auth/2fa/verify', bT, { code: await frisch(bSetup.geheim) });

    ok('1) freiwillig eingeschaltet und auf „monatlich" gestellt',
      (await req('POST', '/api/auth/2fa/eigener-modus', bT, { modus: 'monatlich', code: await frisch(bSetup.geheim) })).status === 200);
    let zb = await zustand(bT);
    ok('   → es gilt „monatlich"', zb.eigen_modus === 'monatlich' && zb.pflicht === false, JSON.stringify({ e: zb.eigen_modus, p: zb.pflicht }));

    await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'woechentlich', twofa_code: await frisch(aSetup.geheim) });
    zb = await zustand(bT);
    ok('2) Pflicht „woechentlich" kommt → sie gilt', zb.modus === 'woechentlich' && zb.pflicht === true, JSON.stringify({ m: zb.modus }));
    ok('   → und abschalten geht jetzt NICHT',
      (await req('POST', '/api/auth/2fa/aus', bT, { code: await frisch(bSetup.geheim) })).status === 403);
    ok('   → das Intervall umstellen ebenso wenig',
      (await req('POST', '/api/auth/2fa/eigener-modus', bT, { modus: 'taeglich', code: await frisch(bSetup.geheim) })).status === 403);
    ok('   → aber sein Authenticator ist unveraendert aktiv', (await zustand(bT)).eingerichtet === true);

    await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'aus' });
    zb = await zustand(bT);
    ok('3) Pflicht faellt weg → wieder „monatlich"',
      zb.pflicht === false && zb.eigen_modus === 'monatlich', JSON.stringify({ p: zb.pflicht, e: zb.eigen_modus }));

    ok('4) jetzt kann er abschalten',
      (await req('POST', '/api/auth/2fa/aus', bT, { code: await frisch(bSetup.geheim) })).status === 200);
    zb = await zustand(bT);
    ok('   → gilt als nicht mehr eingerichtet', zb.eingerichtet === false);
    ok('   → der Schluessel liegt aber noch da (stillgelegt)', zb.stillgelegt === true, JSON.stringify(zb));
    ok('   → und die Anmeldung verlangt keinen Code mehr',
      !(await req('POST', '/api/auth/login', null, { username: 'ablauf', password: 'Test1234!' })).body.zwei_faktor_erforderlich);

    ok('5) schaltet er wieder ein, gilt weiterhin sein „monatlich"',
      (await req('POST', '/api/auth/2fa/verify', bT, { code: await frisch(bSetup.geheim) })).status === 200);
    zb = await zustand(bT);
    ok('   → derselbe Schluessel, derselbe Wunsch',
      zb.eingerichtet === true && zb.eigen_modus === 'monatlich', JSON.stringify({ e: zb.eingerichtet, m: zb.eigen_modus }));

    console.log('\n── Im Protokoll ──');
    ok('die Umstellung ist vermerkt',
      /twofa_eigener_modus/.test(JSON.stringify((await req('GET', '/api/audit?limit=200', admin)).body)));

  } finally {
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nEigenes Intervall: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
