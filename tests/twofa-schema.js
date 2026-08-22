// Die 2FA-Tabellen müssen auf JEDEM Altstand crashfrei nachwachsen — und zwar auf BEIDEN Wegen.
//
// Der Grund für diesen Test: `ensureAuditSchema` läuft nur im Restore-Pfad, nie beim normalen
// Start (database/init.js). Wer eine Migration nur dort einhängt, baut etwas, das auf einem
// laufenden Produktivserver nie greift und erst nach einem Wiederherstellen auffällt. Deshalb wird
// hier ausdrücklich beides geprüft:
//   1. Neuanlage        — frische Datenbank
//   2. Altstand + Start — Tabellen gelöscht, Server neu gestartet (Init-Pfad)
//   3. Altstand + Restore — Sicherung ohne die Tabellen eingespielt (Restore-Pfad)
//
// Und der wichtigste Punkt: Fehlt das Schema, darf sich trotzdem jeder anmelden. Ein 2FA-Fehler
// darf niemals den Zugang kosten.
//
//   node tests/twofa-schema.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3244, DB = '/tmp/twofa-schema.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

let srv = null;
async function starten(logDatei) {
  const lg = fs.openSync(logDatei, 'w');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(200); }
  throw new Error('Server kam nicht hoch: ' + logDatei);
}
async function stoppen() {
  if (!srv) return;
  srv.kill('SIGTERM');
  for (let i = 0; i < 40; i++) { if (srv.exitCode !== null || srv.killed) break; await sleep(100); }
  await sleep(600);   // der Autosave-Takt schreibt noch einmal zurueck
  srv = null;
}

// Die Datenbank NUR LESEND anfassen, waehrend kein Server laeuft (nie ein zweiter Prozess auf der
// laufenden Datei — database/init.js schreibt sie alle 5 Sekunden komplett neu).
function tabellen() {
  const { execFileSync } = require('child_process');
  const aus = execFileSync('python3', ['-c', `
import sqlite3, json
c = sqlite3.connect("file:${DB}?mode=ro", uri=True)
t = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
i = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")]
sp = {}
for tab in ('twofa_secrets','twofa_devices'):
    if tab in t: sp[tab] = [r[1] for r in c.execute("PRAGMA table_info(%s)" % tab)]
print(json.dumps({"tabellen": t, "indizes": i, "spalten": sp}))
`]);
  return JSON.parse(aus.toString());
}
function ohneZweiFaktor() {
  const { execFileSync } = require('child_process');
  execFileSync('python3', ['-c', `
import sqlite3
c = sqlite3.connect("${DB}")
c.execute("DROP TABLE IF EXISTS twofa_secrets")
c.execute("DROP TABLE IF EXISTS twofa_devices")
c.commit()
`]);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try {
    console.log('── 1. Frische Datenbank ──');
    await starten('/tmp/twofa-schema-1.log');
    const log = fs.readFileSync('/tmp/twofa-schema-1.log', 'utf8');
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmeldung = await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') });
    ok('Anmeldung funktioniert', anmeldung.status === 200, String(anmeldung.status));
    await stoppen();

    let z = tabellen();
    ok('twofa_secrets ist da', z.tabellen.includes('twofa_secrets'), z.tabellen.filter(t => t.startsWith('twofa')).join(','));
    ok('twofa_devices ist da', z.tabellen.includes('twofa_devices'));
    ok('der Index auf die Geräte ist da', z.indizes.includes('idx_twofa_devices_user'), z.indizes.join(','));
    ok('twofa_secrets hat die erwarteten Spalten',
      ['user_id', 'secret_enc', 'confirmed_at', 'last_step', 'created_at'].every(s => z.spalten.twofa_secrets.includes(s)),
      (z.spalten.twofa_secrets || []).join(','));
    ok('twofa_devices hat die erwarteten Spalten',
      ['user_id', 'token_hash', 'user_agent', 'confirmed_at', 'last_used_at'].every(s => z.spalten.twofa_devices.includes(s)),
      (z.spalten.twofa_devices || []).join(','));

    console.log('\n── 2. Altstand: Tabellen fehlen, Server startet neu (Init-Pfad) ──');
    ohneZweiFaktor();
    let vorher = tabellen();
    ok('die Tabellen sind wirklich weg (sonst prüft der nächste Schritt nichts)',
      !vorher.tabellen.includes('twofa_secrets') && !vorher.tabellen.includes('twofa_devices'));
    await starten('/tmp/twofa-schema-2.log');
    const zweiteAnmeldung = await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') });
    ok('der Altstand fährt hoch und die Anmeldung geht', zweiteAnmeldung.status === 200, String(zweiteAnmeldung.status));
    ok('… ohne Fehler im Protokoll', !/ensureTwoFactorSchema fehlgeschlagen/.test(fs.readFileSync('/tmp/twofa-schema-2.log', 'utf8')));
    await stoppen();
    z = tabellen();
    ok('die Tabellen sind beim Start nachgewachsen',
      z.tabellen.includes('twofa_secrets') && z.tabellen.includes('twofa_devices'),
      z.tabellen.filter(t => t.startsWith('twofa')).join(','));

    console.log('\n── 3. Altstand einspielen (Restore-Pfad) ──');
    // Eine Sicherung ziehen, darin die 2FA-Tabellen entfernen, wieder einspielen.
    await starten('/tmp/twofa-schema-3.log');
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const zip = await new Promise((res, rej) => {
      const r = http.request({ host: 'localhost', port: PORT, path: '/api/backup/download', method: 'GET',
        headers: { Authorization: 'Bearer ' + admin } }, x => {
        const teile = []; x.on('data', d => teile.push(d));
        x.on('end', () => res({ status: x.statusCode, buf: Buffer.concat(teile) }));
      });
      r.on('error', rej); r.end();
    });
    ok('Sicherung heruntergeladen', zip.status === 200 && zip.buf.length > 1000, `${zip.status}, ${zip.buf.length} Byte`);
    await stoppen();

    // In der Sicherung die Tabellen entfernen → so sähe ein echter Altstand aus.
    const altZip = '/tmp/twofa-schema-alt.zip';
    fs.writeFileSync(altZip, zip.buf);
    const { execFileSync } = require('child_process');
    execFileSync('python3', ['-c', `
import zipfile, sqlite3, os, shutil, sys
quelle, ziel = "${altZip}", "/tmp/twofa-schema-alt-neu.zip"
tmp = "/tmp/twofa-schema-alt-db"
os.makedirs(tmp, exist_ok=True)
zin = zipfile.ZipFile(quelle)
db = next(n for n in zin.namelist() if n.endswith('.db'))
zin.extract(db, tmp)
p = os.path.join(tmp, db)
c = sqlite3.connect(p)
c.execute("DROP TABLE IF EXISTS twofa_secrets"); c.execute("DROP TABLE IF EXISTS twofa_devices"); c.commit(); c.close()
zout = zipfile.ZipFile(ziel, 'w', zipfile.ZIP_DEFLATED)
for n in zin.namelist():
    zout.writestr(n, open(p,'rb').read() if n == db else zin.read(n))
zout.close()
print("ok")
`]);

    await starten('/tmp/twofa-schema-4.log');
    const admin2 = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const grenze = fs.readFileSync('/tmp/twofa-schema-alt-neu.zip');
    const rand = '----ad' + Date.now();
    const koerper = Buffer.concat([
      Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="backup"; filename="b.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      grenze, Buffer.from(`\r\n--${rand}--\r\n`)]);
    const restore = await new Promise((res, rej) => {
      const r = http.request({ host: 'localhost', port: PORT, path: '/api/backup/restore', method: 'POST',
        headers: { Authorization: 'Bearer ' + admin2, 'Content-Type': 'multipart/form-data; boundary=' + rand,
                   'Content-Length': koerper.length } },
        x => { let s = ''; x.on('data', d => s += d); x.on('end', () => res({ status: x.statusCode, text: s })); });
      r.on('error', rej); r.write(koerper); r.end();
    });
    ok('Altstand ohne 2FA-Tabellen lässt sich einspielen', restore.status === 200, `${restore.status} ${restore.text.slice(0, 120)}`);
    await sleep(800);
    const nachRestore = await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') });
    ok('… danach kann man sich weiterhin anmelden', nachRestore.status === 200, String(nachRestore.status));
    await stoppen();
    z = tabellen();
    ok('… und die Tabellen sind auch über den Restore-Pfad nachgewachsen',
      z.tabellen.includes('twofa_secrets') && z.tabellen.includes('twofa_devices'),
      z.tabellen.filter(t => t.startsWith('twofa')).join(','));

  } finally {
    await stoppen();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n2FA-Schema: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
