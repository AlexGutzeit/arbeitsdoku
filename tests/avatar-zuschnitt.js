// Der Nutzer bestimmt den Ausschnitt seines Profilbilds (Alex, 23.08.2026).
//
// Bis hierher hat die App geraten: `sharp` mit `position: 'attention'` sucht die Region mit der
// höchsten Luminanzfrequenz, Farbsättigung und Hautton-Präsenz. Das ist keine Gesichtserkennung,
// sondern eine Heuristik — bei einem Gruppenfoto oder jemandem am Bildrand geht sie daneben, und
// weil nur die fertigen Quadrate gespeichert wurden, war das dann endgültig.
//
// Jetzt schickt der Browser das gewählte Rechteck mit, und das Original bleibt liegen, damit man
// den Ausschnitt später ohne neues Foto ändern kann.
//
// Geprüft wird mit einem Bild aus vier verschiedenfarbigen Vierteln: Welches Viertel im Kreis
// landet, lässt sich damit an der Farbe ABLESEN statt zu vermuten.
//
//   node tests/avatar-zuschnitt.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const sharp = require('sharp');

const PORT = 3273, DB = '/tmp/avatar-zuschnitt.db';
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
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
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'GET', headers: t ? { Authorization: 'Bearer ' + t } : {} },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => res({ status: x.statusCode, buf: Buffer.concat(teile), typ: x.headers['content-type'] })); });
    r.on('error', rej); r.end();
  });
}
// Mehrteilige Sendung mit Bild UND (optional) Ausschnitt-Feld.
function hochladen(token, buf, zuschnitt, typ = 'image/png') {
  const rand = '----ad' + Date.now() + Math.random().toString(36).slice(2);
  const teile = [];
  if (zuschnitt) {
    teile.push(Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="zuschnitt"\r\n\r\n${JSON.stringify(zuschnitt)}\r\n`));
  }
  const endung = typ === 'image/jpeg' ? 'jpg' : 'png';
  teile.push(Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="bild"; filename="a.${endung}"\r\nContent-Type: ${typ}\r\n\r\n`), buf, Buffer.from(`\r\n--${rand}--\r\n`));
  const k = Buffer.concat(teile);
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': k.length } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s })); });
    r.on('error', rej); r.write(k); r.end();
  });
}

// Vier Viertel, vier klar unterscheidbare Farben.
const BREITE = 800, HOEHE = 600;
const VIERTEL = {
  'links oben':   { r: 220, g: 30,  b: 30,  links: 0,        oben: 0,       },
  'rechts oben':  { r: 30,  g: 120, b: 220, links: BREITE/2, oben: 0,       },
  'links unten':  { r: 240, g: 200, b: 20,  links: 0,        oben: HOEHE/2, },
  'rechts unten': { r: 30,  g: 170, b: 90,  links: BREITE/2, oben: HOEHE/2, },
};
const testbild = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${BREITE}" height="${HOEHE}">
  ${Object.values(VIERTEL).map(v => `<rect x="${v.links}" y="${v.oben}" width="${BREITE/2}" height="${HOEHE/2}" fill="rgb(${v.r},${v.g},${v.b})"/>`).join('')}
</svg>`)).png().toBuffer();

// Welche der vier Farben zeigt das Bild in der Mitte?
async function farbeInDerMitte(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const x = Math.floor(info.width / 2), y = Math.floor(info.height / 2);
  const i = (y * info.width + x) * info.channels;
  const p = { r: data[i], g: data[i + 1], b: data[i + 2] };
  let beste = null, abstand = 1e9;
  for (const [name, v] of Object.entries(VIERTEL)) {
    const d = Math.abs(p.r - v.r) + Math.abs(p.g - v.g) + Math.abs(p.b - v.b);
    if (d < abstand) { abstand = d; beste = name; }
  }
  return { name: beste, abstand, pixel: p };
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  const lg = fs.openSync('/tmp/avatar-zuschnitt-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/avatar-zuschnitt-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await req('POST', '/api/users', admin, { username: 'nora', password: 'Test1234!', name: 'Nora Kranz', role: 'mitarbeiter' });
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;
    const nora = (await req('POST', '/api/auth/login', null, { username: 'nora', password: 'Test1234!' })).body;
    const bild = await testbild();

    console.log('── Ohne Angabe raet die App wie bisher ──');
    ok('Hochladen klappt', (await hochladen(max.token, bild)).status === 200);
    const ohne = await holen(`/api/avatare/${max.user.id}`, max.token);
    ok('… und liefert ein Bild', ohne.status === 200 && /image\/webp/.test(ohne.typ));
    const geraten = await farbeInDerMitte(ohne.buf);
    console.log(`     (geraten wurde: ${geraten.name})`);

    console.log('\n── Mit Ausschnitt: „rechts oben" ──');
    const rechtsOben = { links: BREITE / 2, oben: 0, breite: BREITE / 2, hoehe: HOEHE / 2, bildBreite: BREITE, bildHoehe: HOEHE };
    ok('Hochladen mit Ausschnitt klappt', (await hochladen(max.token, bild, rechtsOben)).status === 200);
    let f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('das kleine Bild zeigt „rechts oben"', f.name === 'rechts oben', `${f.name} ${JSON.stringify(f.pixel)}`);
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}?g=gross`, max.token)).buf);
    ok('… und das grosse ebenso', f.name === 'rechts oben', `${f.name} ${JSON.stringify(f.pixel)}`);

    console.log('\n── Der Browser darf sich in der Bildgroesse irren ──');
    // Er meldet halbe Masse — der Server rechnet verhaeltnismaessig um statt roh zu uebernehmen.
    const halb = { links: BREITE / 4, oben: HOEHE / 4, breite: BREITE / 4, hoehe: HOEHE / 4, bildBreite: BREITE / 2, bildHoehe: HOEHE / 2 };
    ok('Hochladen klappt', (await hochladen(max.token, bild, halb)).status === 200);
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('trotzdem landet „rechts unten" im Kreis', f.name === 'rechts unten', `${f.name} ${JSON.stringify(f.pixel)}`);

    console.log('\n── Das Original bleibt liegen ──');
    const orig = await holen('/api/avatare/original', max.token);
    ok('es ist abrufbar', orig.status === 200 && /image\/webp/.test(orig.typ), `${orig.status} ${orig.typ}`);
    const om = await sharp(orig.buf).metadata();
    ok('… ungeschnitten in voller Breite', om.width === BREITE && om.height === HOEHE, `${om.width}x${om.height}`);
    ok('… und klein genug fuer die Platte (< 900 kB)', orig.buf.length < 900 * 1024, `${Math.round(orig.buf.length / 1024)} kB`);
    console.log(`     (Original: ${om.width}x${om.height}, ${Math.round(orig.buf.length / 1024)} kB)`);

    console.log('\n── Und bei einem echten Handyfoto? ──');
    // Flache Farben lassen sich auf ein paar Kilobyte pressen — die Groessengrenze waere damit
    // nicht geprueft. Also ein grosses, unruhiges Bild: 4000x3000 Rauschen, wie es eine Kamera
    // liefert. Erwartet: laengste Kante auf 1600 gedeckelt, Datei im dreistelligen kB-Bereich.
    const rauschen = await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } })
      .jpeg({ quality: 88 }).toBuffer();
    console.log(`     (hochgeladen: ${Math.round(rauschen.length / 1024 / 1024 * 10) / 10} MB JPEG, 4000x3000)`);
    ok('ein grosses Foto laesst sich hochladen',
      (await hochladen(nora.token, rauschen, null, 'image/jpeg')).status === 200);
    const gross = await holen('/api/avatare/original', nora.token);
    const gm = await sharp(gross.buf).metadata();
    ok('das Original ist auf 1600 px gedeckelt', Math.max(gm.width, gm.height) === 1600, `${gm.width}x${gm.height}`);
    ok('… und bleibt unter 900 kB', gross.buf.length < 900 * 1024, `${Math.round(gross.buf.length / 1024)} kB`);
    console.log(`     (abgelegt: ${gm.width}x${gm.height}, ${Math.round(gross.buf.length / 1024)} kB)`);
    // Beim Bauen dieses Tests aufgefallen: Ein 4000x3000-PNG mit Rauschen ist 33 MB gross und
    // laeuft in die Eingangsgrenze. Das ist richtig so — aber es soll eine verstaendliche Meldung
    // geben und keinen Serverfehler.
    const zuGross = await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).png().toBuffer();
    const abgelehnt = await hochladen(nora.token, zuGross);
    ok('ein 33-MB-Bild wird abgewiesen', abgelehnt.status === 400, String(abgelehnt.status));
    ok('… mit einer Meldung, die die Grenze nennt', /MB/.test(abgelehnt.text), abgelehnt.text.slice(0, 90));
    await req('DELETE', '/api/avatare', nora.token);

    console.log('\n── Ausschnitt nachtraeglich aendern, OHNE neues Foto ──');
    const neu = await req('POST', '/api/avatare/zuschnitt', max.token,
      { zuschnitt: { links: 0, oben: HOEHE / 2, breite: BREITE / 2, hoehe: HOEHE / 2, bildBreite: BREITE, bildHoehe: HOEHE } });
    ok('klappt', neu.status === 200, `${neu.status} ${neu.text.slice(0, 90)}`);
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('jetzt steht „links unten" im Kreis', f.name === 'links unten', `${f.name} ${JSON.stringify(f.pixel)}`);
    ok('… und die Frischemarke ist neu', !!(neu.body && neu.body.stand));

    console.log('\n── Unsinn wird abgewiesen ──');
    for (const [was, z] of [
      ['leer', {}],
      ['ohne Bildmasse', { links: 0, oben: 0, breite: 100, hoehe: 100 }],
      ['winzig', { links: 0, oben: 0, breite: 4, hoehe: 4, bildBreite: BREITE, bildHoehe: HOEHE }],
      ['Text statt Zahlen', { links: 'a', oben: 'b', breite: 'c', hoehe: 'd', bildBreite: BREITE, bildHoehe: HOEHE }],
    ]) {
      ok(`${was} → 400`, (await req('POST', '/api/avatare/zuschnitt', max.token, { zuschnitt: z })).status === 400);
    }
    // Ein um wenige Bildpunkte ueberstehendes Rechteck ist Rundung, kein Angriff — es wird
    // zurechtgerueckt und angenommen. Was danach zu klein waere, faellt durch.
    const knapp = await req('POST', '/api/avatare/zuschnitt', max.token,
      { zuschnitt: { links: BREITE / 2, oben: HOEHE / 2, breite: BREITE / 2 + 3, hoehe: HOEHE / 2 + 3, bildBreite: BREITE, bildHoehe: HOEHE } });
    ok('knapp ueberstehend wird zurechtgerueckt und angenommen', knapp.status === 200, `${knapp.status} ${knapp.text.slice(0, 80)}`);
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('… und trifft weiterhin „rechts unten"', f.name === 'rechts unten', `${f.name} ${JSON.stringify(f.pixel)}`);
    const daneben = await req('POST', '/api/avatare/zuschnitt', max.token,
      { zuschnitt: { links: BREITE - 5, oben: HOEHE - 5, breite: 999, hoehe: 999, bildBreite: BREITE, bildHoehe: HOEHE } });
    ok('voellig daneben (bliebe ein 5-px-Streifen) → 400', daneben.status === 400, String(daneben.status));

    console.log('\n── Das Original gehoert nur einem selbst ──');
    ok('Nora hat noch keines', (await holen('/api/avatare/original', nora.token)).status === 404);
    // Bewusst ein ANDERES Bild — sonst waere „sie bekommt ihres" von „sie bekommt seines" nicht
    // zu unterscheiden, und die Zeile darunter pruefte nichts.
    const noraBild = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="rgb(90,40,150)"/></svg>`)).png().toBuffer();
    await hochladen(nora.token, noraBild, { links: 0, oben: 0, breite: 320, hoehe: 320, bildBreite: 640, bildHoehe: 640 });
    const noraOrig = await holen('/api/avatare/original', nora.token);
    ok('… danach ihres', noraOrig.status === 200);
    const nm = await sharp(noraOrig.buf).metadata();
    ok('… und es ist IHRES, nicht das von Max', nm.width === 640 && nm.height === 640,
      `${nm.width}x${nm.height} — Max' Original ist ${BREITE}x${HOEHE}`);
    const maxOrigNochmal = await holen('/api/avatare/original', max.token);
    const mm = await sharp(maxOrigNochmal.buf).metadata();
    ok('… und Max bekommt weiterhin seines', mm.width === BREITE && mm.height === HOEHE, `${mm.width}x${mm.height}`);
    ok('ohne Anmeldung gibt es keines', (await holen('/api/avatare/original', null)).status === 401);

    console.log('\n── Entfernen raeumt auch das Original weg ──');
    ok('Entfernen klappt', (await req('DELETE', '/api/avatare', max.token)).status === 200);
    ok('Original ist weg', (await holen('/api/avatare/original', max.token)).status === 404);
    ok('… und die Datei auch', !fs.existsSync(path.join(BILDER, `${max.user.id}-original.webp`)));
    ok('Ausschnitt aendern geht dann nicht mehr',
      (await req('POST', '/api/avatare/zuschnitt', max.token,
        { zuschnitt: { links: 0, oben: 0, breite: 100, hoehe: 100, bildBreite: BREITE, bildHoehe: HOEHE } })).status === 404);
    ok('Noras Bild ist unberuehrt', (await holen('/api/avatare/original', nora.token)).status === 200);

    console.log('\n── Im Protokoll ──');
    const eintraege = JSON.stringify((await req('GET', '/api/audit?limit=100', admin)).body);
    ok('Ausschnitt-Aenderung protokolliert', /avatar_ausschnitt/.test(eintraege));

  } finally {
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nAvatar-Ausschnitt: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
