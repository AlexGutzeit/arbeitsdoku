// Uploads: kaputte Anfragen bringen den Server nicht zu Fall, und das App-Icon prüft Größe, Typ und Mindestmaß.
//
// Warum: multer 1.4.5-lts.2 war verwundbar (u. a. CVE-2025-47935/-47944, CVE-2025-48997, CVE-2025-7338 — ein
// fehlerhafter Multipart-Upload konnte den Prozess abstürzen lassen oder Speicher festhalten), `npm audit` meldete
// es aber nicht: „-lts.2" ist nach Semver eine Vorabversion und fällt nicht unter „< 2.0.0". Seit 24.10.2026
// multer 2. Alle Upload-Wege liegen hinter der Anmeldung — ein einziges Konto hätte genügt.
// Gegenprobe mit 1.4.5-lts.2: abgebrochene Uploads ließen Dateien in uploads/tmp liegen (Platte voll machbar), und
// eine Datei von genau Limit-Größe galt als zu groß. Einen Absturz lösten diese Eingaben auch dort nicht aus.
//
// Das App-Icon hatte keinen Test. Geprüft werden nur die Fälle, die nichts ablegen (der Erfolgsfall schreibt fest
// nach uploads/icons/ im Projektordner und würde das Icon des Entwicklungsservers überschreiben).
//   node tests/upload-robust.js
const { spawn } = require('child_process');
const http = require('http'); const net = require('net'); const fs = require('fs'); const path = require('path');
const sharp = require('sharp');

const PORT = 3376, DB = '/tmp/upload-robust.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const MB = 1024 * 1024;

function reqJSON(method, p, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}

// Fertiger Multipart-Body an einen Pfad; `kopf` überschreibt den Content-Type (für kaputte Grenzen).
function sende(token, urlPath, body, boundary, kopf) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port: PORT, path: urlPath, method: 'POST', headers: {
      'Content-Type': kopf || 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length, Authorization: 'Bearer ' + token,
    } }, (res) => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ status: 0, fehler: e.code })); r.write(body); r.end();
  });
}
const teil = (b, feld, datei, typ, inhalt) => Buffer.concat([
  Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${feld}"${datei ? `; filename="${datei}"` : ''}\r\n` +
    (typ ? `Content-Type: ${typ}\r\n` : '') + '\r\n'), inhalt, Buffer.from('\r\n')]);
const ende = b => Buffer.from(`--${b}--\r\n`);

// Bricht mitten im Upload ab: Kopf + halber Body, dann Socket zu (der Speicher-Fall aus CVE-2025-47935).
function abbrechen(token, urlPath, feld) {
  return new Promise((resolve) => {
    const b = 'abbruch' + Date.now();
    const kopfteil = `--${b}\r\nContent-Disposition: form-data; name="${feld}"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`;
    const s = net.connect(PORT, 'localhost', () => {
      s.write(`POST ${urlPath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\n` +
        `Content-Type: multipart/form-data; boundary=${b}\r\nContent-Length: ${2 * MB}\r\n\r\n` + kopfteil);
      s.write(Buffer.alloc(64 * 1024, 0x41));
      setTimeout(() => { s.destroy(); resolve(); }, 150);
    });
    s.on('error', () => resolve());
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const logPfad = '/tmp/upload-robust-srv.log';
  const lg = fs.openSync(logPfad, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let beendet = false; srv.on('exit', () => { beendet = true; });
  const lebt = async () => !beendet && (await reqJSON('GET', '/health')).status === 200;
  try {
    for (let i = 0; i < 60; i++) { if ((await reqJSON('GET', '/health')).status === 200) break; await sleep(150); }
    const pw = (fs.readFileSync(logPfad, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const token = (await reqJSON('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body?.token;
    ok('Admin-Anmeldung', !!token);

    const wege = [['/api/avatare', 'bild'], ['/api/documents/upload', 'file'], ['/api/settings/logo', 'logo'],
      ['/api/settings/app-icon', 'icon'], ['/api/backup/restore', 'backup']];

    console.log('── Kaputte Uploads an jeden Weg: Antwort 4xx, Server lebt weiter ──');
    for (const [weg, feld] of wege) {
      const b = 'grenze' + Date.now();
      const faelle = [
        ['leerer Feldname', Buffer.concat([teil(b, '', 'x.png', 'image/png', Buffer.from('abc')), ende(b)])],
        ['ohne Schlussgrenze', teil(b, feld, 'x.png', 'image/png', Buffer.from('abc'))],
        ['Teil ohne Kopfzeilen', Buffer.from(`--${b}\r\n\r\nabc\r\n--${b}--\r\n`)],
        ['falsches Feld', Buffer.concat([teil(b, 'anderes', 'x.png', 'image/png', Buffer.from('abc')), ende(b)])],
        ['Grenze fehlt im Kopf', Buffer.concat([teil(b, feld, 'x.png', 'image/png', Buffer.from('abc')), ende(b)]), 'multipart/form-data'],
      ];
      for (const [name, body, kopf] of faelle) {
        const r = await sende(token, weg, body, b, kopf);
        ok(`${weg} · ${name} → ${r.status}`, r.status >= 400 && r.status < 500, JSON.stringify(r.body || r.fehler));
      }
      for (let i = 0; i < 5; i++) await abbrechen(token, weg, feld);
      await sleep(300);
      ok(`${weg} · nach allem noch erreichbar (inkl. 5 abgebrochene Uploads)`, await lebt());
    }

    console.log('── App-Icon: Größe, Typ, Mindestmaß ──');
    await reqJSON('PUT', '/api/settings/branding-limit', token, { fileValue: '1', fileUnit: 'MB' });
    const b = 'icon' + Date.now();
    let r = await sende(token, '/api/settings/app-icon', Buffer.concat([teil(b, 'icon', 'gross.png', 'image/png', Buffer.alloc(Math.round(1.3 * MB), 0x41)), ende(b)]), b);
    ok('über dem Branding-Limit → 413', r.status === 413 && /zu groß/.test(r.body?.error || ''), JSON.stringify(r.body));
    r = await sende(token, '/api/settings/app-icon', Buffer.concat([teil(b, 'icon', 'icon.gif', 'image/gif', Buffer.from('GIF89a')), ende(b)]), b);
    ok('falscher Typ → 400 „Nur PNG und JPG"', r.status === 400 && /Nur PNG und JPG/.test(r.body?.error || ''), JSON.stringify(r.body));
    const klein = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2a7' } }).png().toBuffer();
    r = await sende(token, '/api/settings/app-icon', Buffer.concat([teil(b, 'icon', 'klein.png', 'image/png', klein), ende(b)]), b);
    ok('64×64 → 400 „zu klein" (Datei kam an, sharp hat sie gelesen)', r.status === 400 && /zu klein/.test(r.body?.error || ''), JSON.stringify(r.body));
    const exakt = Buffer.alloc(1 * MB, 0x41);
    r = await sende(token, '/api/settings/app-icon', Buffer.concat([teil(b, 'icon', 'exakt.png', 'image/png', exakt), ende(b)]), b);
    ok('genau 1 MB (= Limit) wird angenommen, scheitert erst am Bildinhalt', r.status === 400 && !/zu groß/.test(r.body?.error || ''), JSON.stringify(r.body));
    const ohne = await new Promise(res => {
      const q = http.request({ host: 'localhost', port: PORT, path: '/api/settings/app-icon', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + b } }, x => { x.resume(); res(x.statusCode); });
      q.on('error', () => res(0)); q.end(Buffer.concat([teil(b, 'icon', 'x.png', 'image/png', klein), ende(b)]));
    });
    ok('ohne Anmeldung gesperrt → 401', ohne === 401, String(ohne));

    const tmp = path.join(__dirname, '..', 'uploads', 'tmp');
    const reste = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter(f => Date.now() - fs.statSync(path.join(tmp, f)).mtimeMs < 120000) : [];
    ok('keine frischen Reste in uploads/tmp', reste.length === 0, reste.join(', '));
    ok('Server lebt am Ende', await lebt());
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (_) {} }
  console.log(`\nUploads robust: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
