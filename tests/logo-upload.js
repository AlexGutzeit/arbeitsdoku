// Firmenlogo: Der Server legt nie die hochgeladene Datei ab, sondern ein Bild, das er selbst daraus neu schreibt.
//
// Warum (Sicherheitsprüfung 10.11.2026, P10): Bis dahin zählte nur die Endung. Was sich „logo.png" nannte, lag
// unverändert unter /uploads/ — dem einzigen Ordner, den der Server OHNE Anmeldung ausliefert. Eine HTML-Datei, ein
// SVG mit Skript oder ein Foto samt Standort im EXIF wären so öffentlich abrufbar gewesen. Hochladen darf nur der
// Chef, ausgeliefert wird mit „nosniff" — gering, aber unnötig.
//
// Geprüft wird:
//   A  PNG bleibt PNG (mit Transparenz), wird nicht vergrößert; Kommentar und Angehängtes sind weg
//   B  JPEG bleibt JPEG, längste Seite höchstens 1000 px, EXIF samt Standort weg, Ausrichtung angewendet
//   C  Der Inhalt entscheidet, nicht die Endung — und das Logo der anderen Endung bleibt nicht liegen
//   D  Was kein PNG/JPEG ist, wird abgelehnt; Einstellung, bisheriges Logo und Protokoll bleiben, wie sie waren
//   E  Rechte, Protokoll, Löschen
//   F  Das neu geschriebene Logo landet im PDF
//   G  App-Icon: dieselbe Inhaltsprüfung
//
// Der Test schreibt nach uploads/ im Projektordner (einen anderen Ort kennt der Server nicht). Was dort vorher als
// Logo lag, liegt am Ende wieder dort.
//   node tests/logo-upload.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const crypto = require('crypto');
const sharp = require('sharp');

const PORT = 3407, DB = '/tmp/logo-upload.db', LOG = '/tmp/logo-upload-srv.log';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const WURZEL = path.join(__dirname, '..');
const UPLOADS = path.join(WURZEL, 'uploads'), TMP = path.join(UPLOADS, 'tmp');
const NAMEN = ['logo.png', 'logo.jpg', 'logo.jpeg'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(method, p, token, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (x) => { const t = []; x.on('data', d => t.push(d)); x.on('end', () => {
      const roh = Buffer.concat(t); let j = null; try { j = JSON.parse(roh.toString()); } catch (_) {}
      res({ status: x.statusCode, body: j, roh, typ: x.headers['content-type'] || '' }); }); });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}
function hochladen(token, weg, feld, datei, inhalt) {
  return new Promise((res) => {
    const b = 'grenze' + Date.now() + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${feld}"; filename="${datei}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      inhalt, Buffer.from(`\r\n--${b}--\r\n`)]);
    const r = http.request({ host: 'localhost', port: PORT, path: weg, method: 'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=' + b, 'Content-Length': body.length,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    } }, (x) => { let s = ''; x.on('data', d => s += d); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', (e) => res({ status: 0, body: e.code })); r.end(body);
  });
}
const logo = (token, datei, inhalt) => hochladen(token, '/api/settings/logo', 'logo', datei, inhalt);

// Ein PNG-Textblock (tEXt) gleich hinter dem Kopf — so steckt ein Kommentar in einer sonst gültigen Datei.
function mitKommentar(png, text) {
  const daten = Buffer.concat([Buffer.from('Comment\0'), Buffer.from(text)]);
  const kopf = Buffer.alloc(8); kopf.writeUInt32BE(daten.length, 0); kopf.write('tEXt', 4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from('tEXt'), daten])) >>> 0, 0);
  return Buffer.concat([png.subarray(0, 33), kopf.subarray(0, 4), Buffer.from('tEXt'), daten, crc, png.subarray(33)]);
}
const rauschen = (w, h, kanaele) => sharp(crypto.randomBytes(w * h * kanaele), { raw: { width: w, height: h, channels: kanaele } });
const auf = n => path.join(UPLOADS, n);
const liegt = n => fs.existsSync(auf(n));
const hash = n => liegt(n) ? crypto.createHash('sha256').update(fs.readFileSync(auf(n))).digest('hex') : null;
const tmpReste = () => fs.existsSync(TMP) ? fs.readdirSync(TMP).filter(f => Date.now() - fs.statSync(path.join(TMP, f)).mtimeMs < 120000) : [];

(async () => {
  // Was vorher als Logo dalag, merken — der Entwicklungsserver nutzt denselben Ordner.
  const vorher = {}; for (const n of NAMEN) vorher[n] = liegt(n) ? fs.readFileSync(auf(n)) : null;
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: WURZEL, env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 80; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(150); }
    const pw = (fs.readFileSync(LOG, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const anm = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body || {};
    const token = anm.token;
    ok('Server startet, Admin-Anmeldung', !!token);
    for (const n of NAMEN) try { fs.unlinkSync(auf(n)); } catch (_) {}

    const einstellung = async () => ((await req('GET', '/api/settings', token)).body?.settings || {}).company_logo || '';
    const gesetzt = async () => (((await req('GET', '/api/audit?limit=500&action=settings_update', token)).body || {}).logs || [])
      .filter(z => z.details === 'Firmen-Logo gesetzt').length;
    // Ohne Anmeldung holen — so kommt das Logo auch beim Besucher an.
    const holen = async (weg) => { const r = await req('GET', weg); return r.status === 200 && /^image\//.test(r.typ) ? r.roh : null; };

    console.log('── A: PNG bleibt PNG, Kommentar und Angehängtes sind weg ──');
    const MARKE = 'GEHEIM-MARKE-7731', ANHANG = '<script>alert("angehaengt")</script>';
    const pngRoh = await sharp({ create: { width: 300, height: 120, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 100, height: 60, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toBuffer(), left: 100, top: 30 }])
      .png().toBuffer();
    const pngEin = Buffer.concat([mitKommentar(pngRoh, MARKE), Buffer.from(ANHANG)]);
    ok('Vorlage trägt Kommentar und Anhang, sharp liest sie trotzdem als PNG',
      pngEin.includes(MARKE) && pngEin.includes(ANHANG) && (await sharp(pngEin).metadata()).format === 'png');
    let r = await logo(token, 'logo.png', pngEin);
    ok('PNG → 200, Antwort nennt /uploads/logo.png', r.status === 200 && r.body?.logo === '/uploads/logo.png', JSON.stringify(r.body));
    ok('Einstellung zeigt auf /uploads/logo.png', await einstellung() === '/uploads/logo.png', await einstellung());
    let bild = await holen('/uploads/logo.png');
    let m = bild ? await sharp(bild).metadata() : {};
    ok('ohne Anmeldung abrufbar, ist ein PNG', m.format === 'png', m.format);
    ok('300×120 bleibt 300×120 (wird nicht vergrößert)', m.width === 300 && m.height === 120, `${m.width}×${m.height}`);
    const px = bild ? await sharp(bild).ensureAlpha().raw().toBuffer() : Buffer.alloc(0);
    ok('Transparenz erhalten: Ecke durchsichtig, Mitte deckend rot', px[3] === 0 && px[(60 * 300 + 150) * 4] === 200 && px[(60 * 300 + 150) * 4 + 3] === 255,
      `${px[3]} / ${px[(60 * 300 + 150) * 4]} / ${px[(60 * 300 + 150) * 4 + 3]}`);
    ok('Kommentar ist weg', !!bild && !bild.includes(MARKE));
    ok('Angehängtes ist weg', !!bild && !bild.includes(ANHANG) && !bild.includes('<script'));
    ok('abgelegt ist nicht die hochgeladene Datei', !!bild && !bild.equals(pngEin));

    const p16 = await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } }).toColourspace('rgb16').png().toBuffer();
    r = await logo(token, 'tief.png', p16);
    m = await sharp(await holen('/uploads/logo.png') || Buffer.alloc(1)).metadata().catch(() => ({}));
    ok('16-Bit-PNG → 200, abgelegt mit 8 Bit je Kanal', r.status === 200 && (await sharp(p16).metadata()).depth === 'ushort' && m.depth === 'uchar' && m.width === 80, `${r.status} ${m.depth}`);

    r = await logo(token, 'hoch.png', await rauschen(500, 2500, 3).png().toBuffer());
    m = await sharp(await holen('/uploads/logo.png') || Buffer.alloc(1)).metadata().catch(() => ({}));
    ok('hochkant 500×2500 → 200×1000', r.status === 200 && m.width === 200 && m.height === 1000, `${r.status} ${m.width}×${m.height}`);

    console.log('── B: JPEG bleibt JPEG, höchstens 1000 px, EXIF weg, Ausrichtung angewendet ──');
    const jpgEin = Buffer.concat([await rauschen(3000, 1500, 3).jpeg({ quality: 80 })
      .withExif({ IFD0: { Copyright: MARKE }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 6/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '8/1 40/1 0/1' } }).toBuffer(),
      Buffer.from(ANHANG)]);
    const mEin = await sharp(jpgEin).metadata();
    ok('Vorlage: 3000×1500 JPEG mit EXIF (Standort) und Anhang', mEin.format === 'jpeg' && !!mEin.exif && jpgEin.includes(MARKE) && jpgEin.includes(ANHANG), `${mEin.format} exif=${!!mEin.exif}`);
    r = await logo(token, 'foto.jpg', jpgEin);
    ok('JPEG → 200, Antwort nennt /uploads/logo.jpg', r.status === 200 && r.body?.logo === '/uploads/logo.jpg', JSON.stringify(r.body));
    ok('Einstellung zeigt auf /uploads/logo.jpg', await einstellung() === '/uploads/logo.jpg', await einstellung());
    bild = await holen('/uploads/logo.jpg');
    m = bild ? await sharp(bild).metadata() : {};
    ok('ist ein JPEG, 1000×500', m.format === 'jpeg' && m.width === 1000 && m.height === 500, `${m.format} ${m.width}×${m.height}`);
    ok('kein EXIF mehr (Standort, Urheber)', !!bild && !m.exif && !bild.includes(MARKE) && !bild.includes('Exif'));
    ok('Angehängtes ist weg', !!bild && !bild.includes(ANHANG));
    ok('das PNG von eben liegt nicht mehr da', !liegt('logo.png'));

    // Ausrichtung 6 heißt: Das Bild ist quer gespeichert und soll hochkant gezeigt werden. Links oben rot.
    const quer = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer(), left: 0, top: 0 }])
      .jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    ok('Vorlage: 400×200 gespeichert, Ausrichtung 6', (await sharp(quer).metadata()).orientation === 6);
    r = await logo(token, 'gedreht.jpeg', quer);
    bild = await holen('/uploads/logo.jpg');
    m = bild ? await sharp(bild).metadata() : {};
    ok('abgelegt hochkant 200×400, ohne Ausrichtungs-Vermerk', r.status === 200 && m.width === 200 && m.height === 400 && !m.orientation, `${r.status} ${m.width}×${m.height} o=${m.orientation}`);
    const pj = bild ? await sharp(bild).raw().toBuffer() : Buffer.alloc(0);
    const an = (x, y) => [pj[(y * 200 + x) * 3], pj[(y * 200 + x) * 3 + 1]];
    ok('das rote Feld steht jetzt rechts oben (um 90° gedreht, nicht nur umbenannt)', an(150, 50)[0] > 200 && an(150, 50)[1] < 60 && an(50, 50)[1] > 200, `${an(150, 50)} / ${an(50, 50)}`);
    ok('Endung .jpeg wird als logo.jpg abgelegt', r.body?.logo === '/uploads/logo.jpg' && !liegt('logo.jpeg'));

    console.log('── C: Der Inhalt entscheidet, nicht die Endung ──');
    r = await logo(token, 'falsch-benannt.jpg', pngRoh);
    ok('PNG mit der Endung .jpg → als logo.png abgelegt', r.status === 200 && r.body?.logo === '/uploads/logo.png' && (await sharp(auf('logo.png')).metadata()).format === 'png', JSON.stringify(r.body));
    ok('logo.jpg bleibt nicht liegen', !liegt('logo.jpg'));
    r = await logo(token, 'falsch-benannt.PNG', await rauschen(200, 100, 3).jpeg().toBuffer());
    ok('JPEG mit der Endung .PNG → als logo.jpg abgelegt', r.status === 200 && r.body?.logo === '/uploads/logo.jpg' && (await sharp(auf('logo.jpg')).metadata()).format === 'jpeg', JSON.stringify(r.body));
    ok('logo.png bleibt nicht liegen', !liegt('logo.png'));
    // Altstand: Frühere Fassungen legten unter der hochgeladenen Endung ab — auch „logo.jpeg".
    fs.writeFileSync(auf('logo.jpeg'), jpgEin);
    r = await logo(token, 'neu.png', pngRoh);
    ok('ein altes logo.jpeg wird beim nächsten Hochladen mit weggeräumt', r.status === 200 && !liegt('logo.jpeg') && !liegt('logo.jpg') && liegt('logo.png'));

    console.log('── D: Was kein PNG/JPEG ist, wird abgelehnt — und nichts ändert sich ──');
    const standHash = hash('logo.png'), standGesetzt = await gesetzt();
    ok('Ausgangslage: Logo liegt, Einstellung gesetzt, Protokoll gezählt', !!standHash && await einstellung() === '/uploads/logo.png' && standGesetzt >= 7, String(standGesetzt));
    const gross = await rauschen(600, 600, 3).png().toBuffer();
    const ablehnen = [
      ['HTML als .png', 'seite.png', Buffer.from('<!doctype html><html><script>alert(1)</script></html>'), /ungültig/],
      ['SVG mit Skript als .png', 'bild.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><script>alert(1)</script><rect width="300" height="300"/></svg>'), /Nur PNG und JPG/],
      ['GIF als .jpg', 'bild.jpg', await sharp({ create: { width: 300, height: 300, channels: 3, background: '#f00' } }).gif().toBuffer(), /Nur PNG und JPG/],
      ['WebP als .png', 'bild.png', await sharp({ create: { width: 300, height: 300, channels: 3, background: '#f00' } }).webp().toBuffer(), /Nur PNG und JPG/],
      ['TIFF als .jpg', 'bild.jpg', await sharp({ create: { width: 300, height: 300, channels: 3, background: '#f00' } }).tiff().toBuffer(), /Nur PNG und JPG/],
      ['abgeschnittenes PNG', 'halb.png', gross.subarray(0, Math.floor(gross.length / 2)), /ungültig/],
      ['nur der PNG-Kopf, dann Füllbytes', 'kopf.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(2000).fill(0x42)]), /ungültig/],
      ['leere Datei', 'leer.png', Buffer.alloc(0), /ungültig|Keine Datei/],
      ['echtes PNG mit der Endung .gif', 'bild.gif', pngRoh, /Nur PNG und JPG/],
      ['echtes PNG mit der Endung .svg', 'bild.svg', pngRoh, /Nur PNG und JPG/],
    ];
    for (const [name, datei, inhalt, text] of ablehnen) {
      r = await logo(token, datei, inhalt);
      ok(`${name} → 400`, r.status === 400 && text.test(r.body?.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
      ok(`   … Logo, Einstellung und Protokoll unverändert`, hash('logo.png') === standHash && !liegt('logo.jpg') && !liegt('logo.jpeg')
        && await einstellung() === '/uploads/logo.png' && await gesetzt() === standGesetzt);
    }
    ok('nichts davon liegt in uploads/ (nur das bisherige Logo)', fs.readdirSync(UPLOADS).filter(f => /^logo|\.neu$/.test(f)).join() === 'logo.png', fs.readdirSync(UPLOADS).join(', '));
    ok('keine Reste in uploads/tmp', tmpReste().length === 0, tmpReste().join(', '));

    console.log('── E: Rechte, Protokoll, Löschen ──');
    await req('POST', '/api/users', token, { username: 'logomitarbeiter', password: 'Test1234!', name: 'Logo Mitarbeiter', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 });
    const ma = (await req('POST', '/api/auth/login', null, { username: 'logomitarbeiter', password: 'Test1234!' })).body?.token;
    ok('Mitarbeiter angemeldet', !!ma);
    r = await logo(ma, 'logo.png', pngRoh);
    ok('Mitarbeiter → 403', r.status === 403, String(r.status));
    r = await logo(null, 'logo.png', pngRoh);
    ok('ohne Anmeldung → 401', r.status === 401, String(r.status));
    ok('   … beides ohne Wirkung und ohne Reste', hash('logo.png') === standHash && await gesetzt() === standGesetzt && tmpReste().length === 0, tmpReste().join(', '));
    r = await logo(token, 'logo.png', pngRoh);
    ok('ein gelungenes Hochladen schreibt genau eine Protokollzeile', r.status === 200 && await gesetzt() === standGesetzt + 1, String(await gesetzt()));
    r = await req('DELETE', '/api/settings/logo', token);
    ok('Löschen → Datei weg, Einstellung leer', r.status === 200 && !liegt('logo.png') && await einstellung() === '', `${r.status} ${await einstellung()}`);

    console.log('── F: Das neu geschriebene Logo landet im PDF ──');
    const pdf = async () => (await req('GET', `/api/pdf/export?user_id=${anm.user?.id}&date_from=2026-11-02&date_to=2026-11-08`, token));
    r = await pdf();
    ok('ohne Logo: PDF ohne Bild', r.status === 200 && r.roh.subarray(0, 5).toString() === '%PDF-' && !r.roh.includes('/Subtype /Image'), `${r.status} ${r.typ}`);
    await logo(token, 'logo.png', pngEin);
    r = await pdf();
    ok('mit PNG-Logo (Transparenz): PDF enthält ein Bild', r.status === 200 && r.roh.includes('/Subtype /Image'), String(r.status));
    await logo(token, 'foto.jpg', jpgEin);
    r = await pdf();
    ok('mit JPEG-Logo: PDF enthält ein Bild', r.status === 200 && r.roh.includes('/Subtype /Image') && r.roh.includes('/DCTDecode'), String(r.status));
    await req('DELETE', '/api/settings/logo', token);

    console.log('── G: App-Icon — dieselbe Inhaltsprüfung (legt nichts ab) ──');
    const iconDa = (await req('GET', '/api/settings', token)).body?.settings?.app_icon_master || '';
    for (const [name, inhalt] of [
      ['SVG als .png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600"/></svg>')],
      ['WebP als .png', await sharp({ create: { width: 600, height: 600, channels: 3, background: '#f00' } }).webp().toBuffer()],
      ['GIF als .png', await sharp({ create: { width: 600, height: 600, channels: 3, background: '#f00' } }).gif().toBuffer()],
    ]) {
      r = await hochladen(token, '/api/settings/app-icon', 'icon', 'icon.png', inhalt);
      ok(`${name}, 600×600 → 400 „Nur PNG und JPG"`, r.status === 400 && /Nur PNG und JPG/.test(r.body?.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
    }
    ok('App-Icon-Einstellung unverändert, keine Reste in uploads/tmp', ((await req('GET', '/api/settings', token)).body?.settings?.app_icon_master || '') === iconDa && tmpReste().length === 0, tmpReste().join(', '));
    ok('Server lebt am Ende', (await req('GET', '/health')).status === 200);
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    srv.kill();
    for (const n of NAMEN) { try { fs.unlinkSync(auf(n)); } catch (_) {} if (vorher[n]) fs.writeFileSync(auf(n), vorher[n]); }
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nLogo-Upload: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
