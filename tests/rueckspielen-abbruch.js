// Zurückspielen, das mittendrin scheitert: danach gilt eindeutig der alte Stand (R3, 25.09.2026).
//
// Vorher ersetzte die App zuerst die Datenbank-Datei, schrieb dann die Dateien einzeln und lud erst
// am Ende neu. Brach es dazwischen ab, lag auf der Platte die NEUE Datenbank, im Speicher die ALTE,
// und die Dateien waren halb ersetzt — welcher Stand danach galt, entschied der Zufall (Autosave
// oder Neustart, was zuerst kam). Die Sicherheitskopie davor war unverschlüsselt und unvollständig.
//
// Die Fehler sind ECHT, keine Hintertür im Code: fehlende Schreibrechte an genau der Stelle, an der
// der jeweilige Schritt schreiben muss.
//   1  Abbruch beim EINSETZEN (Datenbank und Dokumente sind schon getauscht) → alles zurückgerollt,
//      auf der Platte UND im Speicher der alte Stand, auch nach einem harten Neustart
//   2  Abbruch beim BEREITLEGEN (wie volle Platte) → nichts angefasst
//   3  Sicherheitskopie nicht schreibbar → es wird gar nicht erst zurückgespielt
//   4  ohne Fehler → Stand der Sicherung, Sicherheitskopie vollständig
//   5  mit hinterlegtem Schlüssel → Sicherheitskopie verschlüsselt, mit dem Schlüssel lesbar
//
//   node tests/rueckspielen-abbruch.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const AdmZip = require('adm-zip');
const krypto = require('../backup-krypto');

const PORT = 3329, DB = '/tmp/rueckspielen-abbruch.db', LOG = '/tmp/rueckspielen-abbruch.log';
const AUS = '/tmp/rueckspielen-abbruch-sicherungen';          // BACKUP_OUT des Testservers
const APP = path.join(__dirname, '..');
const ORDNER = { uploads: path.join(APP, 'uploads'), documents: path.join(APP, 'storage', 'documents'), avatare: path.join(APP, 'storage', 'avatare') };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function anfrage(m, p, t, body, kopf = {}) {
  return new Promise((res, rej) => {
    const d = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: {
      ...(Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }), ...kopf,
      ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': d.length } : {}) } },
    x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => {
      const roh = Buffer.concat(teile); let j = null; try { j = JSON.parse(roh.toString()); } catch (_) {}
      res({ status: x.statusCode, body: j, roh }); }); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const req = (m, p, t, b) => anfrage(m, p, t, b);
function hochladen(p, t, feld, dateiname, typ, daten, extra = {}) {
  const grenze = '----rueck' + Date.now() + Math.random().toString(36).slice(2);
  const teile = [];
  for (const [k, v] of Object.entries(extra)) teile.push(Buffer.from(`--${grenze}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  teile.push(Buffer.from(`--${grenze}\r\nContent-Disposition: form-data; name="${feld}"; filename="${dateiname}"\r\nContent-Type: ${typ}\r\n\r\n`), daten, Buffer.from(`\r\n--${grenze}--\r\n`));
  return anfrage('POST', p, t, Buffer.concat(teile), { 'Content-Type': 'multipart/form-data; boundary=' + grenze });
}
const zurueckspielen = (t, zip) => hochladen('/api/backup/restore', t, 'backup', 'sicherung.zip', 'application/zip', zip);

// Alle Dateien der drei Ablagen mit Prüfsumme — Ordner werden als Ordner vermerkt.
function schnappschuss() {
  const bild = {};
  const lauf = (dir, praefix) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      if (e === 'tmp') continue;
      const voll = path.join(dir, e), rel = praefix + '/' + e;
      const st = fs.statSync(voll);
      if (st.isDirectory()) { bild[rel] = 'ORDNER'; lauf(voll, rel); }
      else bild[rel] = sha(fs.readFileSync(voll));
    }
  };
  for (const [name, dir] of Object.entries(ORDNER)) lauf(dir, name);
  return bild;
}
function unterschiede(a, b) {
  const alle = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...alle].filter(k => a[k] !== b[k]).map(k => `${k}: ${a[k] || '—'} → ${b[k] || '—'}`);
}
const reste = (bild) => Object.keys(bild).filter(k => k.includes('.rueckspielen-'));

// Die Datenbank-DATEI lesen — nicht über den Server: Genau hier lag der Unterschied zum Speicher.
let SQL;
async function inDerDatei(sql) {
  if (!SQL) SQL = await require('sql.js')();
  const d = new SQL.Database(fs.readFileSync(DB));
  try { const r = d.exec(sql); return r.length ? r[0].values[0][0] : null; } finally { d.close(); }
}
const kopien = () => (fs.existsSync(AUS) ? fs.readdirSync(AUS) : []).sort();

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  fs.rmSync(AUS, { recursive: true, force: true });
  // Arbeitsordner eines FRUEHEREN, abgebrochenen Laufs wegraeumen. Die Ablagen gehoeren dem Repo,
  // nicht diesem Test — ohne das vergiftet ein einziger kaputter Lauf alle folgenden (so geschehen
  // bei den Gegenproben: die ohne Aufraeumen liess Reste in uploads/icons/ liegen).
  const altreste = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir)) {
    const voll = path.join(dir, e);
    if (!fs.statSync(voll).isDirectory()) continue;
    if (e.startsWith('.rueckspielen-')) fs.rmSync(voll, { recursive: true, force: true }); else altreste(voll);
  } };
  Object.values(ORDNER).forEach(altreste);
  const lg = fs.openSync(LOG, 'w');
  const starten = () => spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      BACKUP_OUT: AUS, BACKUP_EMPFAENGER: '' }, stdio: ['ignore', lg, lg] });
  const bereit = async () => { for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(150); } };
  let srv = starten();
  const aufraeumen = [];   // Rechte zurückdrehen, egal wie der Test endet
  try {
    await bereit();
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmelden = async () => (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    let a = await anmelden();
    let admin = a.token; const adminId = a.user.id;
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;

    // ── Stand A ──
    const sharp = require('sharp');
    const bildA = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 20, g: 120, b: 60 } } }).png().toBuffer();
    ok('Profilbild A hochgeladen', (await hochladen('/api/avatare', admin, 'bild', 'a.png', 'image/png', bildA)).status < 300);
    const dokVorher = new Set(fs.readdirSync(ORDNER.documents));
    const dok = await hochladen('/api/documents/upload', admin, 'file', 'rueckspielen.txt', 'text/plain', Buffer.from('Stand A'));
    const dokDatei = fs.readdirSync(ORDNER.documents).find(f => !dokVorher.has(f));
    ok('Dokument A hochgeladen', dok.status < 300 && !!dokDatei, dok.status + ' ' + dokDatei);
    const x = (await req('POST', '/api/entries', admin, { date: '2026-09-01', time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: maxId, description: 'Stand A' })).body.entry;
    const sicherungA = await anfrage('GET', '/api/backup/download', admin);
    ok('Sicherung A heruntergeladen (unverschlüsselt, Zip)', sicherungA.status === 200 && sicherungA.roh[0] === 0x50);
    const zipA = sicherungA.roh;
    const bildA_datei = new AdmZip(zipA).getEntries().find(e => e.entryName === `avatare/${adminId}.webp`);
    ok('die Sicherung enthält das Profilbild', !!bildA_datei);
    const avatarA = bildA_datei.getData();

    // ── Stand B ──
    const y = (await req('POST', '/api/entries', admin, { date: '2026-09-02', time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: maxId, description: 'Stand B' })).body.entry;
    const bildB = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    await hochladen('/api/avatare', admin, 'bild', 'b.png', 'image/png', bildB);
    fs.writeFileSync(path.join(ORDNER.documents, dokDatei), 'Stand B');   // Inhalt auf der Platte geändert
    const avatarPfad = path.join(ORDNER.avatare, `${adminId}.webp`);
    const avatarB = fs.readFileSync(avatarPfad);
    ok('Stand B unterscheidet sich von A (Bild, Dokument, Eintrag)', sha(avatarB) !== sha(avatarA) && !!y);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n1 — Abbruch beim Einsetzen: alles zurückgerollt');
    // Das Profilbild wird durch einen schreibgeschützten ORDNER gleichen Namens ersetzt. Ein Ordner
    // lässt sich ohne Schreibrecht nicht verschieben — der Tausch scheitert also genau dort, wenn
    // Datenbank-Datei und Dokumente schon getauscht sind.
    fs.unlinkSync(avatarPfad); fs.mkdirSync(avatarPfad); fs.chmodSync(avatarPfad, 0o555);
    aufraeumen.push(() => { try { fs.chmodSync(avatarPfad, 0o755); fs.rmdirSync(avatarPfad); } catch (_) {} if (!fs.existsSync(avatarPfad)) fs.writeFileSync(avatarPfad, avatarB); });
    const vorher1 = schnappschuss();
    const logVorher = fs.readFileSync(LOG, 'utf8').length;
    const r1 = await zurueckspielen(admin, zipA);
    const logNeu = fs.readFileSync(LOG, 'utf8').slice(logVorher);
    ok('Antwort: abgebrochen, „es gilt weiterhin der Stand von vorher"', r1.status === 500 && /Stand von vorher/.test((r1.body || {}).error || ''), JSON.stringify(r1.body));
    ok('der Abbruch kam wirklich beim Einsetzen (Datenbank und Dokumente waren schon getauscht)',
      /Zurückspielen abgebrochen \(einsetzen\), zurückgerollt: true/.test(logNeu), logNeu.slice(0, 200));
    const nachher1 = schnappschuss();
    ok('alle Dateien byte-gleich wie vorher', unterschiede(vorher1, nachher1).length === 0, unterschiede(vorher1, nachher1).slice(0, 4).join(' | '));
    ok('keine Arbeitsordner übrig', reste(nachher1).length === 0, reste(nachher1).join(', '));
    ok('Datenbank-DATEI: Eintrag aus Stand B noch da', await inDerDatei(`SELECT COUNT(*) FROM entries WHERE id = ${y.id}`) === 1);
    ok('laufende App: Eintrag aus Stand B noch da', (await req('GET', '/api/entries/' + y.id, admin)).status === 200);
    // Der Fall, in dem früher der Zufall entschied: Neustart, bevor das Autosave lief.
    srv.kill('SIGKILL'); await sleep(300);
    srv = starten(); await bereit();
    a = await anmelden(); admin = a.token;
    ok('nach hartem Neustart: weiterhin Stand B', (await req('GET', '/api/entries/' + y.id, admin)).status === 200);
    const k1 = kopien();
    ok('Sicherheitskopie liegt bei den Sicherungen, Name nach der Regel der nächtlichen',
      k1.length === 1 && /^arbeitsdoku_backup_\d{8}-\d{6}_vor-rueckspielen\.zip$/.test(k1[0]), k1.join(', '));
    const kopie1 = new AdmZip(path.join(AUS, k1[0]));
    const namen1 = kopie1.getEntries().map(e => e.entryName);
    const dbInKopie = kopie1.getEntries().find(e => e.entryName === 'arbeitsdoku.db').getData();
    if (!SQL) SQL = await require('sql.js')();
    const kopieDb = new SQL.Database(dbInKopie);
    ok('Sicherheitskopie enthält den Stand von VOR dem Zurückspielen (Eintrag B)',
      kopieDb.exec(`SELECT COUNT(*) FROM entries WHERE id = ${y.id}`)[0].values[0][0] === 1);
    kopieDb.close();
    ok('Sicherheitskopie vollständig: Dokumente und Profilbilder (früher fehlten beide)',
      namen1.includes('documents/' + dokDatei) && namen1.includes(`avatare/${adminId}-gross.webp`)
      && kopie1.getEntry('documents/' + dokDatei).getData().toString() === 'Stand B', namen1.filter(n => !n.startsWith('uploads')).slice(0, 6).join(', '));
    ok('ohne Schlüssel: keine .env in der Kopie (harte Regel wie nachts)', !namen1.includes('.env'));
    aufraeumen.pop()();

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n2 — Abbruch beim Bereitlegen (wie volle Platte): nichts angefasst');
    fs.chmodSync(ORDNER.documents, 0o555);
    aufraeumen.push(() => fs.chmodSync(ORDNER.documents, 0o755));
    const vorher2 = schnappschuss();
    const r2 = await zurueckspielen(admin, zipA);
    aufraeumen.pop()();
    const nachher2 = schnappschuss();
    ok('Antwort: abgebrochen, nichts verändert', r2.status === 500 && /nichts verändert/.test((r2.body || {}).error || ''), JSON.stringify(r2.body));
    ok('Meldung ohne Rohtext und Serverpfad', !/EACCES|\/home\//.test((r2.body || {}).error || ''), (r2.body || {}).error);
    ok('alle Dateien byte-gleich, keine Arbeitsordner', unterschiede(vorher2, nachher2).length === 0 && reste(nachher2).length === 0,
      unterschiede(vorher2, nachher2).concat(reste(nachher2)).slice(0, 4).join(' | '));
    ok('Datenbank: Eintrag aus Stand B noch da (Datei und App)',
      await inDerDatei(`SELECT COUNT(*) FROM entries WHERE id = ${y.id}`) === 1 && (await req('GET', '/api/entries/' + y.id, admin)).status === 200);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n3 — Sicherheitskopie nicht schreibbar: gar nicht erst zurückgespielt');
    const k3vorher = kopien();
    fs.chmodSync(AUS, 0o555);
    aufraeumen.push(() => fs.chmodSync(AUS, 0o755));
    const vorher3 = schnappschuss();
    const r3 = await zurueckspielen(admin, zipA);
    aufraeumen.pop()();
    ok('Antwort nennt die Sicherheitskopie und „nichts verändert"',
      r3.status === 500 && /Sicherheitskopie/.test((r3.body || {}).error || '') && /nichts verändert/.test((r3.body || {}).error || ''), JSON.stringify(r3.body));
    ok('Dateien und Datenbank unverändert, keine halbe Kopie',
      unterschiede(vorher3, schnappschuss()).length === 0 && JSON.stringify(kopien()) === JSON.stringify(k3vorher)
      && await inDerDatei(`SELECT COUNT(*) FROM entries WHERE id = ${y.id}`) === 1, kopien().join(', '));

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n4 — ohne Fehler: Stand der Sicherung');
    const r4 = await zurueckspielen(admin, zipA);
    ok('Antwort: erfolgreich, nennt die Sicherheitskopie', r4.status === 200 && /_vor-rueckspielen\.zip$/.test((r4.body || {}).safetyBackup || ''), JSON.stringify(r4.body));
    ok('Eintrag aus Stand B weg, aus Stand A da (App)',
      (await req('GET', '/api/entries/' + y.id, admin)).status === 404 && (await req('GET', '/api/entries/' + x.id, admin)).status === 200);
    ok('… und in der Datenbank-DATEI', await inDerDatei(`SELECT COUNT(*) FROM entries WHERE id = ${y.id}`) === 0
      && await inDerDatei(`SELECT COUNT(*) FROM entries WHERE id = ${x.id}`) === 1);
    ok('Profilbild und Dokument wieder aus Stand A',
      sha(fs.readFileSync(avatarPfad)) === sha(avatarA) && fs.readFileSync(path.join(ORDNER.documents, dokDatei), 'utf8') === 'Stand A');
    ok('keine Arbeitsordner übrig', reste(schnappschuss()).length === 0);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n5 — mit Schlüssel: Sicherheitskopie verschlüsselt und lesbar');
    const paar = krypto.paarErzeugen();
    const hinterlegt = await req('POST', '/api/backup/empfaenger', admin, { name: 'Testschluessel', pubkey: paar.oeffentlich });
    ok('Schlüssel hinterlegt', hinterlegt.status < 300, JSON.stringify(hinterlegt.body));
    const k5vorher = new Set(kopien());
    const r5 = await zurueckspielen(admin, zipA);
    const neu5 = kopien().filter(k => !k5vorher.has(k));
    ok('erfolgreich, neue Kopie ist .adbk', r5.status === 200 && neu5.length === 1 && /_vor-rueckspielen\.adbk$/.test(neu5[0]), JSON.stringify(r5.body) + ' ' + neu5);
    const roh5 = fs.readFileSync(path.join(AUS, neu5[0]));
    ok('Klartext steht nicht drin', krypto.istContainer(roh5) && !roh5.includes(Buffer.from('SQLite format')));
    const offen = new AdmZip(krypto.entschluesseln(roh5, paar.privat));
    const namen5 = offen.getEntries().map(e => e.entryName);
    ok('mit dem Schlüssel lesbar: Datenbank, Dokumente, Profilbilder',
      namen5.includes('arbeitsdoku.db') && namen5.includes('documents/' + dokDatei) && namen5.includes(`avatare/${adminId}.webp`), namen5.slice(0, 5).join(', '));
    ok('die .env nur hier, in der verschlüsselten Fassung (wenn es eine gibt)', namen5.includes('.env') === fs.existsSync(path.join(APP, '.env')));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const f of aufraeumen.reverse()) { try { f(); } catch (_) {} }
    try { srv.kill(); } catch (_) {}
  }
  console.log(`\nZurückspielen mit Abbruch: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
