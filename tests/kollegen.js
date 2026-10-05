// Kollegen (Server): wer drinsteht, was ohne Freigabe den Server NICHT verlässt, „Neu im Team", Werkzeug, vCard.
//
// Die wichtigste Zusicherung ist die negative: Nicht freigegebene Daten dürfen in KEINER Antwort stehen — nicht
// nur „das Feld ist leer", sondern „die Nummer kommt im Text der Antwort gar nicht vor". Sonst könnte sie über
// ein vergessenes Feld oder die vCard doch hinausgehen.
//
// „Neu im Team" hängt am Eintrittsdatum. Das lässt sich über die Oberfläche nicht zurückdatieren; deshalb
// wird der Server einmal angehalten, die Testdatenbank angepasst und neu gestartet.
//
//   node tests/kollegen.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const initSqlJs = require('sql.js');
const sharp = require('sharp');

const PORT = 3370, DB = '/tmp/kollegen-test.db';
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => { const s = Buffer.concat(teile).toString('utf8'); let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s, kopf: x.headers }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
function hochladen(token, buf) {
  const rand = '----kt' + Date.now();
  const koerper = Buffer.concat([
    Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="bild"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf, Buffer.from(`\r\n--${rand}--\r\n`)]);
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': koerper.length } },
      x => { x.resume(); x.on('end', () => res(x.statusCode)); });
    r.on('error', rej); r.write(koerper); r.end();
  });
}
const tag = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };

let srv, log = '';
async function starten() {
  const lg = fs.openSync('/tmp/kollegen-test-srv.log', 'a');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
}
async function anhalten() { const fertig = new Promise(r => srv.on('exit', r)); srv.kill('SIGTERM'); await fertig; }

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync('/tmp/kollegen-test-srv.log'); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  try {
    await starten();
    for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/kollegen-test-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const login = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body;
    const admin = await login('admin', pw('admin'));
    const anlegen = async (username, name, extra = {}) => (await req('POST', '/api/users', admin.token, {
      username, password: 'Start!2345', name, role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40, ...extra })).body.user;
    const anna = await anlegen('anna', 'Anna Berger', { birth_date: '1990-03-12' });
    const bernd = await anlegen('bernd', 'Bernd Kraus');
    const nora = await anlegen('nora', 'Nora Neu');
    const otto = await anlegen('otto', 'Otto Alt');
    const rita = await anlegen('rita', 'Rita Wieder');
    const zukunft = await anlegen('zoe', 'Zoe Später');
    const T = {};
    for (const u of ['anna', 'bernd', 'nora']) T[u] = (await login(u, 'Start!2345')).token;

    console.log('── Wer steht in der Liste ──');
    let liste = (await req('GET', '/api/kollegen', T.bernd)).body.kollegen;
    const namen = liste.map(k => k.name);
    ok('alle aktiven Kollegen, Chef und Buchhaltung mit', ['Chef', 'Buchhalter', 'Max Mustermann', 'Anna Berger', 'Nora Neu'].every(n => namen.includes(n)), JSON.stringify(namen));
    ok('… ohne das Admin-Konto', !namen.includes('Administrator'));
    ok('… ohne einen selbst', !namen.includes('Bernd Kraus'));
    ok('… nach Namen sortiert', JSON.stringify(namen) === JSON.stringify([...namen].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))), JSON.stringify(namen));
    ok('Einführung: alle am selben Tag angelegt → NIEMAND ist „neu"', liste.every(k => !k.neu), JSON.stringify(liste.filter(k => k.neu).map(k => k.name)));

    console.log('\n── Admin und Ausgestellte ──');
    ok('die Seite des Admins gibt es für Kollegen nicht', (await req('GET', '/api/kollegen/' + admin.user.id, T.bernd)).status === 404);
    const adminSelbst = await req('GET', '/api/kollegen/' + admin.user.id, admin.token);
    ok('… der Admin sieht aber seine eigene Vorschau', adminSelbst.status === 200 && adminSelbst.body.selbst === true, adminSelbst.status);
    ok('unbekannte Nummer → 404', (await req('GET', '/api/kollegen/99999', T.bernd)).status === 404);
    ok('keine Zahl → 404', (await req('GET', '/api/kollegen/abc', T.bernd)).status === 404);
    ok('ohne Anmeldung → 401', (await req('GET', '/api/kollegen')).status === 401);

    console.log('\n── Annas Profil: was sie freigibt und was nicht ──');
    let r = await req('PUT', '/api/kollegen/mein-profil', T.anna, {
      info: 'Ansprechpartnerin\r\nfür Heizung\u0007', telefon: '0171 2345678', telefon_zeigen: true,
      email: 'anna.geheim@beispiel.de', email_zeigen: false });
    ok('gespeichert', r.status === 200, r.text.slice(0, 120));
    ok('… Windows-Umbruch vereinheitlicht, Steuerzeichen raus', r.body.info === 'Ansprechpartnerin\nfür Heizung', JSON.stringify(r.body.info));
    let s = await req('GET', '/api/kollegen/' + anna.id, T.bernd);
    ok('Bernd sieht den Infotext', s.body.info === 'Ansprechpartnerin\nfür Heizung');
    ok('… die freigegebene Telefonnummer', s.body.telefon === '0171 2345678');
    ok('… die NICHT freigegebene E-Mail nirgends in der Antwort', s.body.email === null && !s.text.includes('anna.geheim'), s.text.slice(0, 200));
    ok('… ohne Geburtstags-Freigabe keinen Geburtstag — und das Datum nirgends in der Antwort',
      s.body.geburtstag === null && !s.text.includes('1990') && !s.text.includes('03-12'), JSON.stringify(s.body.geburtstag));
    ok('… vCard möglich (Telefon freigegeben)', s.body.vcard === true);

    await req('PUT', '/api/users/geburtstag-freigabe', T.anna, { zeigen: true, alter_auch: false });
    s = await req('GET', '/api/kollegen/' + anna.id, T.bernd);
    ok('Geburtstag freigegeben: Tag und Monat', s.body.geburtstag && s.body.geburtstag.tag === 12 && s.body.geburtstag.monat === 3, JSON.stringify(s.body.geburtstag));
    ok('… aber ohne Alter — und das Geburtsjahr nirgends in der Antwort', s.body.geburtstag.alter === undefined && !s.text.includes('1990'), s.text.slice(0, 200));
    await req('PUT', '/api/users/geburtstag-freigabe', T.anna, { zeigen: true, alter_auch: true });
    s = await req('GET', '/api/kollegen/' + anna.id, T.bernd);
    const [hj, hm, ht] = tag(0).split('-').map(Number);
    const erwartet = hj - 1990 - ((hm < 3 || (hm === 3 && ht < 12)) ? 1 : 0);
    ok('mit Alter-Freigabe: das Alter', s.body.geburtstag.alter === erwartet, JSON.stringify(s.body.geburtstag));
    ok('… das Geburtsjahr selbst trotzdem nicht', !s.text.includes('1990'));

    console.log('\n── Prüfungen beim Speichern ──');
    const fehler = async (b) => (await req('PUT', '/api/kollegen/mein-profil', T.bernd, b)).status;
    ok('Telefon mit Buchstaben → 400', await fehler({ telefon: '0171 ANNA' }) === 400);
    ok('Telefon mit zu wenig Ziffern → 400', await fehler({ telefon: '12' }) === 400);
    ok('E-Mail ohne Domain → 400', await fehler({ email: 'bernd@' }) === 400);
    ok('Infotext über 1000 Zeichen → 400', await fehler({ info: 'x'.repeat(1001) }) === 400);
    r = await req('PUT', '/api/kollegen/mein-profil', T.bernd, { info: '', telefon: '', telefon_zeigen: true, email: '', email_zeigen: true });
    ok('Haken ohne Inhalt wird nicht gespeichert', r.body.telefon_zeigen === false && r.body.email_zeigen === false, JSON.stringify(r.body));
    const mein = (await req('GET', '/api/kollegen/mein-profil', T.anna)).body;
    ok('das eigene Profil liest alles zurück, auch das nicht Freigegebene', mein.email === 'anna.geheim@beispiel.de' && mein.email_zeigen === false
      && mein.geburtstag_zeigen === true && mein.alter_zeigen === true && mein.geburtsdatum_hinterlegt === true, JSON.stringify(mein));

    console.log('\n── Protokoll und Datenauskunft ──');
    const protokoll = (await req('GET', '/api/audit?limit=200', admin.token)).text;
    ok('das Speichern steht im Protokoll', /kollegen_profil/.test(protokoll));
    ok('… ohne Telefonnummer, Adresse oder Text', !protokoll.includes('2345678') && !protokoll.includes('anna.geheim') && !protokoll.includes('Heizung'));
    const auskunft = (await req('GET', '/api/users/meine-daten', T.anna)).body || {};
    ok('Datenauskunft enthält „für die Kollegen"', auskunft.fuer_die_kollegen && auskunft.fuer_die_kollegen.telefon === '0171 2345678', JSON.stringify(auskunft.fuer_die_kollegen));

    console.log('\n── Ausgeliehenes Werkzeug ──');
    const werkzeug = (await req('POST', '/api/tools', admin.token, { name: 'Bohrhammer Hilti' })).body;
    const wId = (werkzeug.tool || werkzeug).id;
    const aus = await req('POST', `/api/tools/${wId}/checkout`, T.anna, { project_text: 'Baustelle Müller' });
    ok('Anna leiht den Bohrhammer', aus.status < 300, aus.text.slice(0, 100));
    s = await req('GET', '/api/kollegen/' + anna.id, T.bernd);
    ok('… steht auf ihrer Seite, mit Baustelle', s.body.werkzeug.length === 1 && s.body.werkzeug[0].name === 'Bohrhammer Hilti' && s.body.werkzeug[0].projekt === 'Baustelle Müller',
      JSON.stringify(s.body.werkzeug));
    await req('POST', `/api/tools/${wId}/return`, T.anna, {});
    s = await req('GET', '/api/kollegen/' + anna.id, T.bernd);
    ok('… nach der Rückgabe nicht mehr', s.body.werkzeug.length === 0, JSON.stringify(s.body.werkzeug));

    console.log('\n── vCard ──');
    ok('Profilbild für Anna', (await hochladen(T.anna, await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer())) < 300);
    await req('PUT', '/api/users/geburtstag-freigabe', T.anna, { zeigen: true, alter_auch: false });
    let v = await req('GET', `/api/kollegen/${anna.id}/vcard`, T.bernd);
    ok('Abruf klappt, als vCard', v.status === 200 && /text\/vcard/.test(v.kopf['content-type']), `${v.status} ${v.kopf['content-type']}`);
    ok('… mit Dateinamen', /Anna Berger\.vcf/.test(decodeURIComponent(v.kopf['content-disposition'] || '')), v.kopf['content-disposition']);
    const zeilen = v.text.split('\r\n');
    ok('… Name aufgeteilt (N: Nachname;Vorname)', zeilen.includes('N:Berger;Anna;;;') && zeilen.includes('FN:Anna Berger'), zeilen.slice(0, 5).join(' | '));
    ok('… mit der freigegebenen Telefonnummer', zeilen.includes('TEL;TYPE=CELL:0171 2345678'));
    ok('… OHNE die nicht freigegebene E-Mail', !v.text.includes('anna.geheim'));
    ok('… ohne Alter-Freigabe KEIN Geburtstag (vCard 3.0 kennt keinen ohne Jahr)', !/BDAY/.test(v.text));
    ok('… mit Foto', /^PHOTO;ENCODING=b;TYPE=JPEG:/m.test(v.text));
    ok('… jede Zeile höchstens 75 Byte (Norm; gefaltet)', zeilen.every(z => Buffer.byteLength(z) <= 75), String(Math.max(...zeilen.map(z => Buffer.byteLength(z)))));
    ok('… beginnt und endet richtig', zeilen[0] === 'BEGIN:VCARD' && zeilen.includes('END:VCARD') && zeilen.includes('VERSION:3.0'));
    await req('PUT', '/api/users/geburtstag-freigabe', T.anna, { zeigen: true, alter_auch: true });
    await req('PUT', '/api/kollegen/mein-profil', T.anna, { info: 'x', telefon: '0171 2345678', telefon_zeigen: true, email: 'anna@beispiel.de', email_zeigen: true });
    v = await req('GET', `/api/kollegen/${anna.id}/vcard`, T.bernd);
    ok('mit Alter-Freigabe: BDAY', v.text.split('\r\n').includes('BDAY:1990-03-12'));
    ok('mit E-Mail-Freigabe: EMAIL', v.text.split('\r\n').includes('EMAIL;TYPE=INTERNET:anna@beispiel.de'));
    ok('wer nichts freigegeben hat, hat keine vCard', (await req('GET', `/api/kollegen/${bernd.id}/vcard`, T.anna)).status === 404);
    ok('die vCard des Admins gibt es für Kollegen nicht', (await req('GET', `/api/kollegen/${admin.user.id}/vcard`, T.anna)).status === 404);

    console.log('\n── „Neu im Team" (Eintrittsdaten zurückdatiert) ──');
    await anhalten();
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    db.run('UPDATE employment_periods SET start_date = ?', [tag(-100)]);                    // Einführung vor 100 Tagen
    db.run('UPDATE employment_periods SET start_date = ? WHERE user_id = ?', [tag(-10), nora.id]);   // neu
    db.run('UPDATE employment_periods SET start_date = ? WHERE user_id = ?', [tag(-40), otto.id]);   // nicht mehr neu
    db.run('UPDATE employment_periods SET end_date = ? WHERE user_id = ?', [tag(-60), rita.id]);     // Wiedereinstellung
    db.run('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)', [rita.id, tag(-10)]);
    db.run('UPDATE employment_periods SET start_date = ? WHERE user_id = ?', [tag(5), zukunft.id]);  // fängt erst an
    fs.writeFileSync(DB, Buffer.from(db.export())); db.close();
    await starten();
    liste = (await req('GET', '/api/kollegen', T.bernd)).body.kollegen;
    const neu = liste.filter(k => k.neu).map(k => k.name);
    ok('Nora (vor 10 Tagen eingetreten) ist neu', neu.includes('Nora Neu'), JSON.stringify(neu));
    ok('… und nur sie', neu.length === 1, JSON.stringify(neu));
    ok('Otto (vor 40 Tagen) nicht mehr', !neu.includes('Otto Alt'));
    ok('Rita (wieder eingestellt vor 10 Tagen) ist nicht „neu"', !neu.includes('Rita Wieder'));
    ok('Zoe (fängt erst in 5 Tagen an) noch nicht', !neu.includes('Zoe Später'));
    ok('die Seite zeigt es auch', (await req('GET', '/api/kollegen/' + nora.id, T.bernd)).body.neu === true);

    console.log('\n── Ausgestellt ──');
    ok('Otto wird ausgestellt', (await req('POST', `/api/users/${otto.id}/deactivate`, admin.token, { employed_until: tag(-1) })).status < 300);
    liste = (await req('GET', '/api/kollegen', T.bernd)).body.kollegen;
    ok('… steht nicht mehr in der Liste', !liste.some(k => k.name === 'Otto Alt'));
    ok('… seine Seite gibt es nicht mehr', (await req('GET', '/api/kollegen/' + otto.id, T.bernd)).status === 404);
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { srv.kill(); } catch (_) {}
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nKollegen (Server): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
