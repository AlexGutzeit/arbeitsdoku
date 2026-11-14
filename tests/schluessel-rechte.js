// Zugangsschlüssel für Programme: Anlegen, Rechte, Grenzen, Widerruf — über die echte Schnittstelle.
//
// Warum (Alex, 14.11.2026): Die Arbeitsdoku bekommt eine MCP-Schnittstelle für KI-Assistenten (Hermes) und ist
// öffentlich erreichbar. Ein Schlüssel darf nie mehr als sein App-Benutzer, „lesen" darf nie schreiben, gelöscht
// wird nie, Verwaltung ist nie erreichbar. Gemessen wird an dem, was ANKOMMT (Antworten, Datenbank, Protokoll),
// nicht an der Erlaubt-Liste selbst.
//
// Geprüft: Anlegen nur mit Passwort, Schlüssel nur einmal sichtbar, gespeichert nur als Hash · lesen ≠ schreiben ·
// Mitarbeiter-Schlüssel sieht keine fremden Zeiten · gesperrte Bereiche 403 · kein DELETE · Vorschau schreibt
// nichts · Schreibzugriff mit Schlüsselname im Protokoll · fremder Schlüssel nicht widerrufbar, Admin widerruft
// jeden · widerrufen / abgelaufen / Konto ausgestellt → 401 · Passwortwechsel und „überall abmelden" lassen ihn
// gültig · jede Zeile der Erlaubt-Liste trifft eine echte Route · Bremse je Schlüssel und für Fehlversuche.
//   node tests/schluessel-rechte.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const crypto = require('crypto');

const PORT = 3410, DB = '/tmp/schluessel-rechte.db', LOG = '/tmp/schluessel-rechte-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, token, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}

let srv = null;
async function starten() {
  const lg = fs.openSync(LOG, 'a');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) return; await sleep(200); }
}
async function anhalten() {
  if (!srv) return;
  const weg = new Promise(r => srv.once('exit', r));
  srv.kill('SIGTERM'); await weg; srv = null;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  fs.writeFileSync(LOG, '');
  try {
    await starten();
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const anmelden = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body?.token;
    const admin = await anmelden('admin', adminPw);
    ok('Server startet, Admin-Anmeldung', !!admin);

    const PW = 'Test1234!';
    const konto = async (username, role) => { const r = await req('POST', '/api/users', admin, { username, password: PW, name: 'Probe ' + username, role,
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 }); return r.body?.id || r.body?.user?.id; };
    const ids = { anna: await konto('schlanna', 'mitarbeiter'), ben: await konto('schlben', 'mitarbeiter'), chef: await konto('schlchef', 'chef') };
    const tok = { anna: await anmelden('schlanna', PW), ben: await anmelden('schlben', PW), chef: await anmelden('schlchef', PW) };
    ok('drei Konten (2 Mitarbeiter, Chef), angemeldet', Object.values(ids).every(Boolean) && Object.values(tok).every(Boolean));
    const tag = (n) => `2026-10-${String(n).padStart(2, '0')}`;
    const eintrag = (t, d, extra) => req('POST', '/api/entries', t, { date: d, time_from: '07:00', time_to: '15:00', break_minutes: 30, client: 'Kunde Probe', ...extra });
    await eintrag(tok.anna, tag(5)); await eintrag(tok.anna, tag(6)); await eintrag(tok.ben, tag(5), { client: 'Kunde Geheim' });

    console.log('── Anlegen ──');
    const neu = (t, b) => req('POST', '/api/schluessel', t, b);
    let r = await neu(tok.anna, { name: 'Hermes', recht: 'lesen' });
    ok('ohne Passwort → 400', r.status === 400, r.status);
    r = await neu(tok.anna, { name: 'Hermes', recht: 'lesen', passwort: 'falsch' });
    ok('falsches Passwort → 400 (nicht 401: sonst flöge man hinaus)', r.status === 400, r.status);
    r = await neu(tok.anna, { name: 'Hermes', recht: 'alles', passwort: PW });
    ok('unbekanntes Recht → 400', r.status === 400, r.status);
    r = await neu(tok.anna, { name: 'Hermes', recht: 'lesen', passwort: PW, ablauf: '2020-01-01' });
    ok('Ablauf in der Vergangenheit → 400', r.status === 400, r.status);
    r = await neu(tok.anna, { name: 'Hermes Anna', recht: 'lesen', passwort: PW });
    const annaLesen = r.body?.schluessel;
    ok('richtig → 201, Schlüssel beginnt mit adk_ und ist lang', r.status === 201 && /^adk_[A-Za-z0-9_-]{40,}$/.test(annaLesen || ''), JSON.stringify(r.body));
    const annaSchreiben = (await neu(tok.anna, { name: 'Hermes Anna schreibt', recht: 'schreiben', passwort: PW })).body?.schluessel;
    const chefLesen = (await neu(tok.chef, { name: 'Chef-Assistent', recht: 'lesen', passwort: PW })).body?.schluessel;
    const benLesen = (await neu(tok.ben, { name: 'Bens Skript', recht: 'lesen', passwort: PW })).body?.schluessel;
    ok('weitere Schlüssel (Anna schreibt, Chef liest, Ben liest)', !!(annaSchreiben && chefLesen && benLesen));
    const liste = (await req('GET', '/api/schluessel', tok.anna)).body?.schluessel || [];
    ok('Liste: nur Annas zwei, ohne Hash und ohne Schlüssel', liste.length === 2 && liste.every(s => !('hash' in s) && !JSON.stringify(s).includes(annaLesen.slice(10))), JSON.stringify(liste));
    ok('… mit Anfang zum Wiedererkennen', liste.some(s => annaLesen.startsWith(s.anzeige.replace('…', ''))), JSON.stringify(liste.map(s => s.anzeige)));

    console.log('── Lesen ──');
    r = await req('GET', '/api/entries?date_from=2026-10-01&date_to=2026-10-31', annaLesen);
    ok('Anna-Schlüssel liest: nur Annas 2 Einträge', r.status === 200 && r.body.entries.length === 2 && r.body.entries.every(e => e.user_id === ids.anna), JSON.stringify(r.body).slice(0, 200));
    r = await req('GET', `/api/entries?user_id=${ids.ben}`, annaLesen);
    ok('… auch mit user_id=Ben: nichts von Ben (die Route entscheidet)', r.status === 200 && r.body.entries.every(e => e.user_id === ids.anna), JSON.stringify(r.body).slice(0, 200));
    r = await req('GET', '/api/entries?search=Geheim', annaLesen);
    ok('… Suche nach Bens Kunden: leer', r.status === 200 && r.body.entries.length === 0);
    r = await req('GET', '/api/entries?date_from=2026-10-01&date_to=2026-10-31', chefLesen);
    ok('Chef-Schlüssel liest alle 3 Einträge (wie der Chef in der App)', r.status === 200 && r.body.entries.length === 3, r.body && r.body.entries && r.body.entries.length);

    console.log('── lesen darf nicht schreiben ──');
    const zaehlen = async () => ((await req('GET', '/api/entries', admin)).body?.entries || []).length;
    const vorher = await zaehlen();
    r = await eintrag(annaLesen, tag(7));
    ok('Lese-Schlüssel: Anlegen → 403', r.status === 403 && r.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT', JSON.stringify(r));
    const annasErster = (await req('GET', '/api/entries', tok.anna)).body.entries[0];
    r = await req('PUT', `/api/entries/${annasErster.id}`, annaLesen, { description: 'geändert' });
    ok('Lese-Schlüssel: Ändern → 403', r.status === 403);
    ok('… nichts ist dazugekommen', (await zaehlen()) === vorher);

    console.log('── Schreiben ──');
    r = await eintrag(annaSchreiben, tag(8), { vorschau: true });
    ok('Vorschau → 200 mit Nettostunden, aber kein Eintrag', r.status === 200 && r.body?.vorschau === true && r.body.entry.net_hours === 7.5 && (await zaehlen()) === vorher, JSON.stringify(r.body));
    r = await eintrag(annaSchreiben, tag(8), { break_minutes: 600 });
    ok('Vorschau-unabhängig: Prüfungen der Route gelten (Pause schluckt alles → 400)', r.status === 400, r.status);
    r = await eintrag(annaSchreiben, tag(8), { description: 'über Hermes' });
    const neuId = r.body?.entry?.id;
    ok('Schreib-Schlüssel: Anlegen → 201, gehört Anna', r.status === 201 && r.body.entry.user_id === ids.anna, JSON.stringify(r.body));
    r = await req('PUT', `/api/entries/${neuId}`, annaSchreiben, { description: 'über Hermes geändert' });
    ok('… Ändern → 200', r.status === 200 && r.body.entry.description === 'über Hermes geändert', r.status);
    r = await req('PUT', `/api/entries/${neuId}`, annaSchreiben, { description: 'nur Vorschau', vorschau: true });
    const nachVorschau = (await req('GET', `/api/entries/${neuId}`, tok.anna)).body;
    ok('… Ändern mit Vorschau → nichts geändert', r.status === 200 && r.body.vorschau && JSON.stringify(nachVorschau).includes('über Hermes geändert'), JSON.stringify(nachVorschau).slice(0, 160));
    const bensEintrag = (await req('GET', '/api/entries', tok.ben)).body.entries[0];
    r = await req('PUT', `/api/entries/${bensEintrag.id}`, annaSchreiben, { description: 'fremd' });
    ok('… fremden Eintrag ändern → 403 (die Route entscheidet)', r.status === 403, r.status);
    r = await req('DELETE', `/api/entries/${neuId}`, annaSchreiben);
    ok('… Löschen → 403, Eintrag ist noch da', r.status === 403 && (await req('GET', `/api/entries/${neuId}`, tok.anna)).status === 200, r.status);
    const prot = ((await req('GET', '/api/audit?action=schluessel_schreibzugriff&limit=50', admin)).body?.logs || []);
    ok('Protokoll: genau 2 Schreibzugriffe (Anlegen + Ändern, keine Vorschau, nichts Abgewiesenes)', prot.length === 2, JSON.stringify(prot.map(p => p.details)));
    ok('… mit Schlüsselname und Konto', prot.every(p => /über Schlüssel „Hermes Anna schreibt"/.test(p.details) && p.user_id === ids.anna), JSON.stringify(prot));
    const verlauf = (await req('GET', `/api/entries/${neuId}/history`, admin)).body;
    ok('Änderungsverlauf des Eintrags nennt den Schlüssel', ((verlauf && verlauf.history) || []).some(h => h.reason === 'über Schlüssel „Hermes Anna schreibt"'), JSON.stringify(verlauf).slice(0, 300));

    console.log('── gesperrte Bereiche ──');
    const gesperrt = [['GET', '/api/users'], ['GET', '/api/settings'], ['GET', '/api/backup/download'], ['POST', '/api/backup/restore'], ['GET', '/api/settings/arbeitszeit'], ['GET', '/api/audit'],
      ['GET', '/api/schluessel'], ['POST', '/api/schluessel'], ['GET', '/api/auth/me'], ['PUT', '/api/auth/password'],
      ['GET', '/api/entries/deleted'], [`GET`, `/api/entries/${neuId}/history`], ['GET', '/api/events/ticket'],
      ['GET', '/api/users/meine-daten'], ['POST', '/api/projects'], ['POST', '/api/absences'], ['GET', '/api/projects/1/entries.csv']];
    for (const [m, p] of gesperrt) {
      const a = await req(m, p, chefLesen, m === 'GET' ? null : {});
      const b = await req(m, p, annaSchreiben, m === 'GET' ? null : {});
      ok(`${m} ${p} → 403 (lesen wie schreiben)`, a.status === 403 && b.status === 403 && a.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT', `${a.status}/${b.status}`);
    }

    console.log('── Erlaubt-Liste trifft echte Routen ──');
    const { LESEN } = require('../schluessel');
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Schlüssel-Probe' })).body;
    const pid = projekt?.id || projekt?.project?.id || 1;
    const falsch = [];
    for (const muster of LESEN) {
      const p = muster.replace(/\\d\+/g, muster.includes('/api/statistics') || muster.includes('/api/payouts') ? String(ids.anna) : String(pid));
      const a = await req('GET', p, chefLesen);
      if (a.status === 404 && a.body?.code === 'UNBEKANNTE_ADRESSE') falsch.push(p);
      if (a.status === 403 && a.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT') falsch.push(p + ' (abgewiesen)');
    }
    ok(`alle ${LESEN.length} Lese-Pfade gibt es, und der Schlüssel kommt durch`, falsch.length === 0, falsch.join(', '));

    console.log('── Widerruf ──');
    const annaListe = (await req('GET', '/api/schluessel', tok.anna)).body.schluessel;
    const annaLesenId = annaListe.find(s => s.name === 'Hermes Anna').id;
    r = await req('POST', `/api/schluessel/${annaLesenId}/widerrufen`, tok.ben);
    ok('Ben kann Annas Schlüssel nicht widerrufen (404)', r.status === 404 && (await req('GET', '/api/entries', annaLesen)).status === 200, r.status);
    r = await req('POST', `/api/schluessel/${annaLesenId}/widerrufen`, tok.anna);
    const nach = await req('GET', '/api/entries', annaLesen);
    ok('Anna widerruft → Schlüssel sofort 401', r.status === 200 && nach.status === 401 && nach.body?.code === 'SCHLUESSEL_UNGUELTIG', JSON.stringify(nach));
    const benId = (await req('GET', '/api/schluessel?alle=1', admin)).body.schluessel.find(s => s.name === 'Bens Skript').id;
    r = await req('POST', `/api/schluessel/${benId}/widerrufen`, admin);
    ok('Admin widerruft Bens Schlüssel → 401', r.status === 200 && (await req('GET', '/api/entries', benLesen)).status === 401);
    const alleListe = (await req('GET', '/api/schluessel?alle=1', admin)).body.schluessel;
    ok('Admin-Liste zeigt alle Konten mit Zustand', alleListe.length === 4 && alleListe.filter(s => s.zustand === 'widerrufen').length === 2, JSON.stringify(alleListe.map(s => [s.user_name, s.zustand])));
    ok('Anna sieht mit ?alle=1 trotzdem nur ihre', ((await req('GET', '/api/schluessel?alle=1', tok.anna)).body.schluessel || []).every(s => s.user_id === ids.anna));

    console.log('── Passwortwechsel / überall abmelden ──');
    r = await req('PUT', '/api/auth/password', tok.anna, { aktuell: PW, neu: 'Neu5678!x' });
    ok('Anna wechselt ihr Passwort', r.status === 200, r.status);
    await req('POST', '/api/auth/alle-abmelden', tok.chef);
    ok('… ihr Schreib-Schlüssel gilt weiter, der des Chefs nach „überall abmelden" auch (Entscheidung C)',
      (await req('GET', '/api/entries', annaSchreiben)).status === 200 && (await req('GET', '/api/entries', chefLesen)).status === 200);

    console.log('── Konto ausstellen ──');
    r = await req('POST', `/api/users/${ids.chef}/deactivate`, admin, {});
    const aus = await req('GET', '/api/entries', chefLesen);
    ok('Chef ausgestellt → sein Schlüssel 401 KONTO_AUSGESTELLT', aus.status === 401 && aus.body?.code === 'KONTO_AUSGESTELLT', JSON.stringify([r.status, aus]));

    console.log('── Ablauf (Server angehalten, Datum in der Datei zurückgesetzt) ──');
    await anhalten();
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const d = new SQL.Database(fs.readFileSync(DB));
    const hash = crypto.createHash('sha256').update(annaSchreiben).digest('hex');
    const vorDb = d.exec('SELECT hash, recht FROM api_schluessel')[0].values;
    ok('Datenbank enthält nur Hashes — kein Schlüssel im Klartext', !fs.readFileSync(DB).includes(Buffer.from(annaSchreiben)) && vorDb.some(v => v[0] === hash), vorDb.length);
    d.run("UPDATE api_schluessel SET ablauf = '2026-01-01' WHERE hash = ?", [hash]);
    fs.writeFileSync(DB, Buffer.from(d.export()));
    await starten();
    const ab = await req('GET', '/api/entries', annaSchreiben);
    ok('abgelaufener Schlüssel → 401 SCHLUESSEL_ABGELAUFEN', ab.status === 401 && ab.body?.code === 'SCHLUESSEL_ABGELAUFEN', JSON.stringify(ab));

    console.log('── Bremsen ──');
    const tokAnna2 = await anmelden('schlanna', 'Neu5678!x');
    const bremsSchl = (await neu(tokAnna2, { name: 'Dauerfeuer', recht: 'lesen', passwort: 'Neu5678!x' })).body?.schluessel;
    const stati = [];
    for (let i = 0; i < 62; i++) stati.push((await req('GET', '/api/bulletin', bremsSchl)).status);
    ok('je Schlüssel: 60 je Minute, dann 429', stati.slice(0, 60).every(s => s === 200) && stati[60] === 429 && stati[61] === 429, stati.slice(55).join(','));
    const fehl = [];
    for (let i = 0; i < 12; i++) fehl.push((await req('GET', '/api/bulletin', 'adk_' + crypto.randomBytes(32).toString('base64url'))).status);
    ok('falsche Schlüssel: 10 × 401, dann 429', fehl.slice(0, 10).every(s => s === 401) && fehl[10] === 429 && fehl[11] === 429, fehl.join(','));
    ok('… normale Anmeldung ist davon nicht betroffen', (await req('GET', '/api/bulletin', tokAnna2)).status === 200);
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    await anhalten().catch(() => {});
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nZugangsschlüssel: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
