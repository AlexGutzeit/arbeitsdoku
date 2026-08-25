// Wer darf Sicherungen öffnen? — die Liste in der Backup-Karte (Alex, 25.08.2026)
//
// Bis hierher ging Verschlüsselung nur über die .env, also nur mit SSH-Zugang. Jetzt stehen
// Empfänger auch in der Datenbank. Damit wandert eine Entscheidung mit erheblicher Tragweite in
// die Oberfläche: Wer in dieser Liste steht, liest jede künftige Sicherung — also alle
// Kundendaten. Entsprechend streng wird hier geprüft.
//
// Drei Dinge, an denen wirklich etwas hängt:
//   * Ein unbrauchbarer Schlüssel muss BEIM SPEICHERN auffallen. Fällt er erst nachts auf,
//     entsteht gar keine Sicherung — der Server bricht dann bewusst ab, statt Klartext zu
//     schreiben.
//   * Der Eintrag aus der Umgebung ist der feste Anker. Über die Oberfläche darf ihn niemand
//     entfernen oder überschreiben.
//   * „geprüft" muss ein Beweis sein, kein Häkchen. Deshalb würfelt der Server die Probe.
//
//   node tests/backup-empfaenger.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const krypto = require('../backup-krypto');

const PORT = 3287, DB = '/tmp/backup-empf.db', LOG = '/tmp/backup-empf-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
function holen(p, t) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, headers: { Authorization: 'Bearer ' + t } },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => res({ status: x.statusCode, buf: Buffer.concat(teile), kopf: x.headers })); });
    r.on('error', rej); r.end();
  });
}

let srv = null;
async function starten(extra = {}) {
  const lg = fs.openSync(LOG, 'a');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      BACKUP_EMPFAENGER: '', ...extra }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(200); }
  throw new Error('Server kam nicht hoch');
}
async function stoppen() { if (srv) { srv.kill('SIGTERM'); await sleep(1200); srv = null; } }
async function anmelden(user = 'admin', pw = null) {
  if (!pw) {
    const log = fs.readFileSync(LOG, 'utf8');
    pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
  }
  return (await req('POST', '/api/auth/login', null, { username: user, password: pw })).body.token;
}

// Den kompletten Beweis-Durchgang einmal als Funktion — er kommt mehrfach vor.
async function probeDurchlaufen(token, id, privatB64) {
  const p = await req('POST', `/api/backup/empfaenger/${id}/probe`, token);
  if (p.status !== 200) return { status: p.status, body: p.body };
  let klar;
  // Mit dem falschen Schluessel scheitert schon das Oeffnen — genau wie im Browser. Das ist kein
  // Fehler des Tests, sondern das erwartete Verhalten, also wird es zum Ergebnis.
  try { klar = krypto.entschluesseln(Buffer.from(p.body.probe, 'base64'), privatB64); }
  catch (e) { return { status: 'nicht-zu-oeffnen', grund: e.message }; }
  return await req('POST', `/api/backup/empfaenger/${id}/probe/bestaetigen`, token, { klartext: klar.toString('base64') });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const chefin = krypto.paarErzeugen();
  const zweit  = krypto.paarErzeugen();
  const anker  = krypto.paarErzeugen();
  const fremd  = krypto.paarErzeugen();

  try {
    console.log('── Leere Liste: Sicherungen laufen im Klartext ──');
    await starten();
    const admin = await anmelden();
    let r = await req('GET', '/api/backup/empfaenger', admin);
    ok('Liste ist leer', r.status === 200 && r.body.empfaenger.length === 0, JSON.stringify(r.body));
    ok('… und sagt, dass nicht verschluesselt wird', r.body.verschluesselt === false);
    let d = await holen('/api/backup/download', admin);
    ok('Download ist ein Zip', d.buf[0] === 0x50 && d.buf[1] === 0x4b);

    console.log('\n── Einen Schluessel hinterlegen ──');
    r = await req('POST', '/api/backup/empfaenger', admin, { name: 'Chefin', pubkey: chefin.oeffentlich });
    ok('angelegt (201)', r.status === 201, r.status + ' ' + r.text);
    const idChefin = r.body.empfaenger.id;
    ok('… mit Fingerabdruck', /^[0-9a-f]{4} [0-9a-f]{4}$/.test(r.body.empfaenger.fingerabdruck || ''), r.body.empfaenger.fingerabdruck);
    r = await req('GET', '/api/backup/empfaenger', admin);
    ok('steht in der Liste, nicht als „fest"', r.body.empfaenger.length === 1 && r.body.empfaenger[0].fest === false);
    ok('… und ist noch nicht geprueft', r.body.empfaenger[0].geprueft_am === null);

    d = await holen('/api/backup/download', admin);
    ok('Download ist jetzt ein ADBK1-Container', krypto.istContainer(d.buf), d.buf.subarray(0, 6).toString('hex'));
    ok('… Dateiname endet auf .adbk', /\.adbk"/.test(d.kopf['content-disposition'] || ''), d.kopf['content-disposition']);
    ok('… und der neue Schluessel oeffnet ihn wirklich',
      krypto.entschluesseln(d.buf, chefin.privat).subarray(0, 2).toString('hex') === '504b');
    ok('… ein fremder Schluessel nicht', (() => {
      try { krypto.entschluesseln(d.buf, fremd.privat); return false; } catch (_) { return true; }
    })());

    console.log('\n── Was NICHT hineindarf ──');
    const schrott = [
      ['leerer Schluessel', { name: 'X', pubkey: '' }, /kein Schlüssel/i],
      ['Buchstabensalat', { name: 'X', pubkey: 'das ist kein schluessel!!' }, /Zeichen/i],
      ['PEM statt Base64', { name: 'X', pubkey: '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----' }, /PEM/i],
      ['der PRIVATE Schluessel', { name: 'X', pubkey: zweit.privat }, /PRIVATE/],
      ['leerer Name', { name: '   ', pubkey: zweit.oeffentlich }, /Name/i],
      ['Name mit Sonderzeichen', { name: 'a<b>c', pubkey: zweit.oeffentlich }, /Name/i],
      ['Name zu lang', { name: 'x'.repeat(41), pubkey: zweit.oeffentlich }, /Name/i],
    ];
    for (const [was, koerper, muster] of schrott) {
      const a = await req('POST', '/api/backup/empfaenger', admin, koerper);
      ok(`${was} → 400 mit verstaendlichem Grund`,
        a.status === 400 && muster.test(a.body && a.body.error || ''), a.status + ' ' + (a.body && a.body.error || '').slice(0, 60));
    }
    // Falsche Kurve und falsches Verfahren — beide wuerden beim Verschluesseln erst spaeter knallen.
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    for (const [was, key, muster] of [['P-384 statt P-256', p384, /Kurve/i], ['RSA statt EC', rsa, /Typ|EC/i]]) {
      const a = await req('POST', '/api/backup/empfaenger', admin, { name: 'X', pubkey: key });
      ok(`${was} → 400`, a.status === 400 && muster.test(a.body && a.body.error || ''), a.status + ' ' + (a.body && a.body.error || '').slice(0, 60));
    }

    console.log('\n── Doppelte Eintraege ──');
    r = await req('POST', '/api/backup/empfaenger', admin, { name: 'chefin', pubkey: zweit.oeffentlich });
    ok('gleicher Name (andere Schreibweise) → 409', r.status === 409, r.status + ' ' + r.text);
    r = await req('POST', '/api/backup/empfaenger', admin, { name: 'Zweitrechner', pubkey: chefin.oeffentlich });
    ok('gleicher Schluessel unter anderem Namen → 409', r.status === 409 && /Chefin/.test(r.body.error || ''), r.status + ' ' + r.text);

    console.log('\n── Der Beweis, dass jemand den Schluessel hat ──');
    r = await probeDurchlaufen(admin, idChefin, fremd.privat);
    ok('falscher Schluessel: die Probe laesst sich gar nicht erst oeffnen', r.status === 'nicht-zu-oeffnen',
      JSON.stringify(r).slice(0, 80));
    r = await req('GET', '/api/backup/empfaenger', admin);
    ok('… und nichts wurde als geprueft vermerkt', r.body.empfaenger[0].geprueft_am === null);

    r = await probeDurchlaufen(admin, idChefin, chefin.privat);
    ok('richtiger Schluessel → 200', r.status === 200, r.status + ' ' + JSON.stringify(r.body));
    r = await req('GET', '/api/backup/empfaenger', admin);
    ok('… und der Zeitpunkt steht in der Liste', !!r.body.empfaenger[0].geprueft_am, JSON.stringify(r.body.empfaenger[0]));

    // Einmalig: Wer die Probe abfaengt, darf sie nicht ein zweites Mal einloesen.
    const p = await req('POST', `/api/backup/empfaenger/${idChefin}/probe`, admin);
    const klar = krypto.entschluesseln(Buffer.from(p.body.probe, 'base64'), chefin.privat);
    await req('POST', `/api/backup/empfaenger/${idChefin}/probe/bestaetigen`, admin, { klartext: klar.toString('base64') });
    r = await req('POST', `/api/backup/empfaenger/${idChefin}/probe/bestaetigen`, admin, { klartext: klar.toString('base64') });
    ok('dieselbe Probe ein zweites Mal → abgelehnt', r.status === 410, r.status + ' ' + r.text);
    r = await req('POST', `/api/backup/empfaenger/${idChefin}/probe/bestaetigen`, admin, { klartext: Buffer.alloc(32).toString('base64') });
    ok('geratener Klartext ohne Probe → abgelehnt', r.status === 410 || r.status === 400, r.status + '');

    console.log('\n── Umbenennen ──');
    r = await req('POST', '/api/backup/empfaenger', admin, { name: 'Zweitrechner', pubkey: zweit.oeffentlich });
    const idZweit = r.body.empfaenger.id;
    r = await req('PUT', '/api/backup/empfaenger/' + idZweit, admin, { name: 'Mini-PC' });
    ok('umbenannt → 200', r.status === 200 && r.body.empfaenger.name === 'Mini-PC', r.text);
    r = await req('PUT', '/api/backup/empfaenger/' + idZweit, admin, { name: 'Chefin' });
    ok('auf einen vergebenen Namen → 409', r.status === 409, r.status + '');
    d = await holen('/api/backup/download', admin);
    ok('beide Empfaenger stehen im Container', JSON.stringify(krypto.empfaengerNamen(d.buf).sort()) === '["Chefin","Mini-PC"]',
      JSON.stringify(krypto.empfaengerNamen(d.buf)));
    ok('… und jeder oeffnet ihn ALLEIN', (() => {
      try { return krypto.entschluesseln(d.buf, chefin.privat).length > 0 && krypto.entschluesseln(d.buf, zweit.privat).length > 0; }
      catch (_) { return false; }
    })());

    console.log('\n── Rechte ──');
    // Ein Mitarbeiter darf die Liste weder sehen noch anfassen — er kaeme sonst an die
    // Entscheidung heran, wer den gesamten Datenbestand lesen kann.
    const nutzer = await req('POST', '/api/users', admin, { username: 'monteur', password: 'Str3ng!Geheim', name: 'Monteur', role: 'mitarbeiter', target_hours_per_week: 40 });
    ok('Testnutzer angelegt', nutzer.status === 201 || nutzer.status === 200, nutzer.status + ' ' + nutzer.text.slice(0, 80));
    const maToken = await anmelden('monteur', 'Str3ng!Geheim');
    ok('Mitarbeiter kann sich anmelden', !!maToken);
    for (const [m, pfad] of [['GET', '/api/backup/empfaenger'], ['POST', '/api/backup/empfaenger'],
                             ['PUT', '/api/backup/empfaenger/' + idZweit], ['DELETE', '/api/backup/empfaenger/' + idZweit],
                             ['POST', `/api/backup/empfaenger/${idZweit}/probe`]]) {
      const a = await req(m, pfad, maToken, { name: 'Boese', pubkey: fremd.oeffentlich });
      ok(`Mitarbeiter ${m} ${pfad.replace('/api/backup/', '')} → 403`, a.status === 403, a.status + '');
    }
    r = await req('GET', '/api/backup/empfaenger', admin);
    ok('… und die Liste ist unveraendert', r.body.empfaenger.length === 2, JSON.stringify(r.body.empfaenger.map(e => e.name)));

    // Entscheidung Alex (25.08.2026): Sehen ja, aendern nein. Wer die Liste aendert, entscheidet
    // ueber den Zugriff auf den gesamten Datenbestand — und koennte nebenbei den Schluessel der
    // Zweitanlage herausnehmen und damit die Notfall-Umschaltung stilllegen.
    const chefAnlegen = await req('POST', '/api/users', admin, { username: 'daniel', password: 'Str3ng!Geheim', name: 'Daniel', role: 'chef', target_hours_per_week: 40 });
    ok('Chef angelegt', chefAnlegen.status === 201 || chefAnlegen.status === 200, chefAnlegen.status + '');
    const chefToken = await anmelden('daniel', 'Str3ng!Geheim');
    r = await req('GET', '/api/backup/empfaenger', chefToken);
    ok('Chef DARF die Liste sehen', r.status === 200 && r.body.empfaenger.length === 2, r.status + '');
    for (const [m, pfad, koerper] of [
      ['POST', '/api/backup/empfaenger', { name: 'Heimlich', pubkey: fremd.oeffentlich }],
      ['PUT', '/api/backup/empfaenger/' + idZweit, { name: 'Umbenannt' }],
      ['DELETE', '/api/backup/empfaenger/' + idZweit, null],
    ]) {
      const a2 = await req(m, pfad, chefToken, koerper);
      ok(`Chef ${m} → 403 (nur Admin darf aendern)`, a2.status === 403, a2.status + '');
    }
    r = await req('POST', `/api/backup/empfaenger/${idZweit}/probe`, chefToken);
    ok('Chef darf aber PRUEFEN (das aendert nichts am Zugriff)', r.status === 200, r.status + '');
    r = await req('GET', '/api/backup/empfaenger', admin);
    ok('… und nach alledem steht die Liste unveraendert da',
      JSON.stringify(r.body.empfaenger.map(e => e.name).sort()) === '["Chefin","Mini-PC"]',
      JSON.stringify(r.body.empfaenger.map(e => e.name)));

    console.log('\n── Entfernen ──');
    r = await req('DELETE', '/api/backup/empfaenger/' + idZweit, admin);
    ok('entfernt → 200, einer bleibt', r.status === 200 && r.body.verbleibend === 1, r.text);
    r = await req('DELETE', '/api/backup/empfaenger/' + idChefin, admin);
    ok('letzter entfernt → verbleibend 0 (Oberflaeche kann warnen)', r.status === 200 && r.body.verbleibend === 0, r.text);
    d = await holen('/api/backup/download', admin);
    ok('… und der Download ist wieder ein Zip', d.buf[0] === 0x50 && d.buf[1] === 0x4b);
    r = await req('DELETE', '/api/backup/empfaenger/999999', admin);
    ok('unbekannte Nummer → 404', r.status === 404, r.status + '');

    console.log('\n── Protokolliert wird alles ──');
    const audit = await req('GET', '/api/audit?limit=100', admin);
    const aktionen = (audit.body && (audit.body.logs || audit.body.entries || [])).map(z => z.action);
    for (const a of ['backup_empfaenger_add', 'backup_empfaenger_rename', 'backup_empfaenger_remove', 'backup_empfaenger_geprueft']) {
      ok(`${a} steht im Audit-Log`, aktionen.includes(a), aktionen.slice(0, 12).join(', '));
    }
    await stoppen();

    console.log('\n── Der feste Anker aus der Umgebung ──');
    await starten({ BACKUP_EMPFAENGER: `anker:${anker.oeffentlich}` });
    const admin2 = await anmelden();
    r = await req('GET', '/api/backup/empfaenger', admin2);
    ok('steht in der Liste', r.body.empfaenger.length === 1 && r.body.empfaenger[0].name === 'anker', JSON.stringify(r.body.empfaenger));
    ok('… als „fest" gekennzeichnet', r.body.empfaenger[0].fest === true);
    ok('… ohne Nummer, also ueber die Oberflaeche nicht erreichbar', r.body.empfaenger[0].id === null);
    r = await req('POST', '/api/backup/empfaenger', admin2, { name: 'anker', pubkey: chefin.oeffentlich });
    ok('sein Name ist belegt → 409', r.status === 409 && /Server-Konfiguration/.test(r.body.error || ''), r.text.slice(0, 90));
    r = await req('POST', '/api/backup/empfaenger', admin2, { name: 'Kopie', pubkey: anker.oeffentlich });
    ok('sein Schluessel ist belegt → 409', r.status === 409 && /Server-Konfiguration/.test(r.body.error || ''), r.text.slice(0, 90));

    r = await req('POST', '/api/backup/empfaenger', admin2, { name: 'Chefin', pubkey: chefin.oeffentlich });
    ok('daneben geht ein eigener Eintrag', r.status === 201, r.text.slice(0, 80));
    d = await holen('/api/backup/download', admin2);
    ok('der Container kennt BEIDE Quellen', JSON.stringify(krypto.empfaengerNamen(d.buf).sort()) === '["Chefin","anker"]',
      JSON.stringify(krypto.empfaengerNamen(d.buf)));
    ok('… der Umgebungs-Schluessel oeffnet ihn', krypto.entschluesseln(d.buf, anker.privat).length > 0);
    ok('… der aus der Oberflaeche auch', krypto.entschluesseln(d.buf, chefin.privat).length > 0);
    await stoppen();

    console.log('\n── Eine kaputte Zeile legt nicht alles still ──');
    // Direkt in die Datei geschrieben, wie es nur eine defekte Migration oder ein Eingriff von
    // Hand koennte. Der Server muss sie ueberspringen und mit den uebrigen weiterarbeiten —
    // sonst haelt ein einziger verkorkster Eintrag die ganze Sicherung an.
    {
      const SQL = await initSqlJs();
      const db = new SQL.Database(fs.readFileSync(DB));
      db.run("INSERT INTO backup_empfaenger (name, pubkey) VALUES ('Kaputt', 'voellig-unbrauchbar')");
      fs.writeFileSync(DB, Buffer.from(db.export())); db.close();
    }
    await starten({ BACKUP_EMPFAENGER: `anker:${anker.oeffentlich}` });
    const admin3 = await anmelden();
    r = await req('GET', '/api/backup/empfaenger', admin3);
    const kaputt = (r.body.empfaenger || []).find(e => e.name === 'Kaputt');
    ok('die kaputte Zeile wird in der Liste als unbrauchbar gezeigt', !!kaputt && !!kaputt.fehler, JSON.stringify(kaputt));
    d = await holen('/api/backup/download', admin3);
    ok('… die Sicherung entsteht trotzdem', krypto.istContainer(d.buf), d.status + '');
    ok('… mit den brauchbaren Empfaengern', JSON.stringify(krypto.empfaengerNamen(d.buf).sort()) === '["Chefin","anker"]',
      JSON.stringify(krypto.empfaengerNamen(d.buf)));
    ok('… und sie laesst sich oeffnen', krypto.entschluesseln(d.buf, anker.privat).length > 0);
    r = await req('DELETE', '/api/backup/empfaenger/' + kaputt.id, admin3);
    ok('… und sie laesst sich entfernen', r.status === 200, r.status + '');
    await stoppen();

    console.log('\n── Kaputte UMGEBUNG: lieber gar keine Sicherung ──');
    await starten({ BACKUP_EMPFAENGER: 'anker:total-kaputt' });
    const admin4 = await anmelden();
    d = await holen('/api/backup/download', admin4);
    ok('Download bricht ab (500), statt Klartext zu liefern', d.status === 500, d.status + '');
    ok('… und es kommt kein Zip heraus', !(d.buf[0] === 0x50 && d.buf[1] === 0x4b));
    r = await req('GET', '/api/backup/empfaenger', admin4);
    ok('die Liste benennt den Fehler', !!r.body.umgebungsFehler, JSON.stringify(r.body.umgebungsFehler));
    await stoppen();
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally { await stoppen(); }

  console.log(`\nEmpfaengerliste: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
