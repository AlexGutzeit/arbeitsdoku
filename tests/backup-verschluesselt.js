// Die Sicherung verlässt den Server verschlüsselt — und der Server kann sie nicht öffnen.
//
// Das ist der ganze Sinn: Auf dem Server liegen nur ÖFFENTLICHE Schlüssel. Er kann verpacken,
// nicht auspacken. Wer ihn übernimmt, kommt an den laufenden Bestand, aber nicht an die Historie
// und nicht an die Kopien, die auf anderen Rechnern liegen.
//
// Die wichtigste Zeile hier sucht nach einem ECHTEN Kundennamen roh im Byte-Strom der
// heruntergeladenen Datei. Ohne sie könnte der Container den Inhalt einfach durchreichen und
// alles andere wäre trotzdem grün.
//
// Und: Ohne konfigurierte Empfänger muss alles bleiben, wie es war. Dieses Repo wird auch von
// Fremdfirmen betrieben, deren Sicherung darf ein Update nicht stillschweigend abschalten.
//
//   node tests/backup-verschluesselt.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const krypto = require('../backup-krypto');
const AdmZip = require('adm-zip');

// Ein Zip ist KOMPRIMIERT — ein Kundenname steht darin nicht woertlich, auch unverschluesselt
// nicht. Eine Suche im rohen Zip waere also immer erfolglos und die Pruefung „Klartext ist
// verschwunden" waere wertlos gruen. (Genau das ist beim ersten Wurf passiert.)
//
// Zwei Dinge, die WIRKLICH unterscheiden:
//   * Der Eintragsname „arbeitsdoku.db" steht in einem Zip UNKOMPRIMIERT im Kopf jedes Eintrags.
//   * Packt man das Zip aus, steht der Kundenname im Klartext in der Datenbank.
const dbAusZip = (zip) => new AdmZip(zip).getEntries().find(e => e.entryName.endsWith('.db')).getData();

const PORT = 3284, DB = '/tmp/backup-verschl.db';
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
function hochladen(token, buf, name) {
  return new Promise((res, rej) => {
    const rand = '----ad' + Date.now();
    const k = Buffer.concat([
      Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="backup"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf, Buffer.from(`\r\n--${rand}--\r\n`)]);
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/backup/restore', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': k.length } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); r.write(k); r.end();
  });
}

let srv = null;
async function starten(extra = {}) {
  const lg = fs.openSync('/tmp/backup-verschl-srv.log', 'a');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      BACKUP_EMPFAENGER: '', ...extra }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(200); }
  throw new Error('Server kam nicht hoch');
}
async function stoppen() { if (srv) { srv.kill('SIGTERM'); await sleep(1000); srv = null; } }
async function anmelden() {
  const log = fs.readFileSync('/tmp/backup-verschl-srv.log', 'utf8');
  const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
  return (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
}

const KUNDE = 'Sonnenhof Zapfendorf GmbH';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync('/tmp/backup-verschl-srv.log'); } catch (_) {}
  const minipc = krypto.paarErzeugen();
  const offline = krypto.paarErzeugen();
  const fremd = krypto.paarErzeugen();
  const EMPF = `minipc:${minipc.oeffentlich},offline:${offline.oeffentlich}`;

  try {
    console.log('── Ohne Konfiguration bleibt alles beim Alten ──');
    await starten();
    let admin = await anmelden();
    // Ein echter, wiedererkennbarer Kundenname in der Datenbank — daran wird gleich gemessen.
    await req('POST', '/api/projects', admin, { name: KUNDE, address: 'Hauptstr. 3, 96199 Zapfendorf' });
    let d = await holen('/api/backup/download', admin);
    ok('der Download ist ein Zip', d.buf[0] === 0x50 && d.buf[1] === 0x4b, d.buf.subarray(0, 4).toString('hex'));
    ok('… und heisst auch so', /\.zip"/.test(d.kopf['content-disposition'] || ''), d.kopf['content-disposition']);
    ok('… und traegt den Eintragsnamen offen im Kopf (so ist ein Zip nun einmal)',
      d.buf.indexOf(Buffer.from('arbeitsdoku.db')) > 0);
    ok('… ausgepackt steht der Kundenname im Klartext in der Datenbank',
      dbAusZip(d.buf).indexOf(Buffer.from(KUNDE)) > 0);
    await stoppen();

    console.log('\n── Mit Empfaengern kommt ein Container heraus ──');
    await starten({ BACKUP_EMPFAENGER: EMPF });
    admin = await anmelden();
    d = await holen('/api/backup/download', admin);
    ok('Kennung ADBK1', krypto.istContainer(d.buf), d.buf.subarray(0, 6).toString('hex'));
    ok('… Dateiname endet auf .adbk', /\.adbk"/.test(d.kopf['content-disposition'] || ''), d.kopf['content-disposition']);
    ok('… beide Empfaenger sind hinterlegt',
      JSON.stringify(krypto.empfaengerNamen(d.buf)) === '["minipc","offline"]',
      JSON.stringify(krypto.empfaengerNamen(d.buf)));

    console.log('\n── Und nichts davon ist mehr zu erkennen ──');
    ok('der Eintragsname „arbeitsdoku.db" ist verschwunden', d.buf.indexOf(Buffer.from('arbeitsdoku.db')) === -1);
    ok('… ebenso das Zip-Erkennungsmuster', d.buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) === -1);
    ok('… und der Kundenname erst recht nicht', d.buf.indexOf(Buffer.from(KUNDE)) === -1);

    console.log('\n── Mit Schluessel wird daraus wieder ein brauchbares Zip ──');
    const zip = krypto.entschluesseln(d.buf, minipc.privat);
    ok('es ist ein Zip', zip[0] === 0x50 && zip[1] === 0x4b);
    ok('… mit „arbeitsdoku.db" darin', zip.indexOf(Buffer.from('arbeitsdoku.db')) > 0);
    ok('… und ausgepackt steht der Kundenname wieder da', dbAusZip(zip).indexOf(Buffer.from(KUNDE)) > 0);
    ok('der Offline-Schluessel oeffnet dieselbe Datei',
      krypto.entschluesseln(d.buf, offline.privat).equals(zip));
    let scheitert = false;
    try { krypto.entschluesseln(d.buf, fremd.privat); } catch (_) { scheitert = true; }
    ok('ein fremder Schluessel nicht', scheitert);

    console.log('\n── Der Server selbst kann sie nicht oeffnen ──');
    const abgelehnt = await hochladen(admin, d.buf, 'sicherung.adbk');
    ok('Einspielen des Containers wird abgelehnt', abgelehnt.status === 400, String(abgelehnt.status));
    ok('… mit eigener Kennung', abgelehnt.body && abgelehnt.body.code === 'SICHERUNG_VERSCHLUESSELT', JSON.stringify(abgelehnt.body).slice(0, 90));
    ok('… und einer Erklaerung, was zu tun ist', /Schlüssel/.test(abgelehnt.body.error), abgelehnt.body.error.slice(0, 90));
    ok('… die Empfaenger werden genannt', JSON.stringify(abgelehnt.body.empfaenger) === '["minipc","offline"]');
    ok('KEIN Absturz, der Server lebt weiter', (await req('GET', '/health')).status === 200);

    console.log('\n── Das entschluesselte Zip laesst sich normal einspielen ──');
    const wieder = await hochladen(admin, zip, 'sicherung.zip');
    ok('Einspielen klappt', wieder.status === 200, `${wieder.status} ${wieder.text.slice(0, 80)}`);
    await sleep(500);
    ok('… und der Kunde ist danach da',
      ((await req('GET', '/api/projects', admin)).body.projects || []).some(p => p.name === KUNDE));

    console.log('\n── Das Hilfsprogramm wird ausgeliefert ──');
    const w = await holen('/api/backup/entschluesseler', admin);
    ok('es kommt eine Datei', w.status === 200 && w.buf.length > 3000, `${w.status} ${w.buf.length} Byte`);
    ok('… als Download benannt', /sicherung-entschluesseln\.html/.test(w.kopf['content-disposition'] || ''), w.kopf['content-disposition']);
    const html = w.buf.toString('utf8');
    ok('… mit eingebetteter Entschluesselung (kein Verweis nach draussen)',
      html.includes('SicherungKrypto') && !html.includes('src="../public/js/'), 'Verweis statt Einbettung?');
    ok('… und ohne jede externe Quelle', !/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html));

    console.log('\n── Kaputte Konfiguration: lieber laut scheitern ──');
    await stoppen();
    await starten({ BACKUP_EMPFAENGER: 'minipc:das-ist-kein-schluessel' });
    admin = await anmelden();
    const kaputt = await holen('/api/backup/download', admin);
    ok('der Download wird verweigert statt unverschluesselt zu liefern', kaputt.status === 500, String(kaputt.status));
    ok('… mit einer Meldung, die den Grund nennt', /BACKUP_EMPFAENGER|Empfänger/.test(kaputt.buf.toString('utf8')),
      kaputt.buf.toString('utf8').slice(0, 90));

  } finally {
    await stoppen();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nVerschluesselte Sicherung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
