// Profilbilder: Hochladen, Ausliefern, Entfernen — und vor allem, wer sie NICHT sehen darf.
//
// Ein Gesichtsfoto ist ein personenbezogenes Datum. Die Bilder liegen deshalb nicht im öffentlich
// ausgelieferten `uploads/` wie das Firmenlogo, sondern hinter der Anmeldung. Genau das ist hier
// der wichtigste Prüfpunkt: **ohne Anmeldung kommt man nicht heran**, auch nicht, wenn man den
// Pfad kennt.
//
// Zweiter Punkt: Was hochgeladen wird, ist beliebig groß und beliebig gedreht. Gespeichert wird
// immer dasselbe kleine Quadrat.
//
//   node tests/avatar-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const sharp = require('sharp');

const PORT = 3256, DB = '/tmp/avatar-api.db';
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => {
        const roh = Buffer.concat(teile); let j = null; try { j = JSON.parse(roh.toString()); } catch (_) {}
        res({ status: x.statusCode, body: j, buf: roh, text: roh.toString().slice(0, 200), typ: x.headers['content-type'] }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Multipart von Hand — die Tests kommen ohne Fremdbibliothek aus.
function hochladen(token, buf, dateiname, feld = 'bild', typ = 'image/png') {
  const rand = '----ad' + Date.now();
  const koerper = Buffer.concat([
    Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="${feld}"; filename="${dateiname}"\r\nContent-Type: ${typ}\r\n\r\n`),
    buf, Buffer.from(`\r\n--${rand}--\r\n`)]);
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': koerper.length } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s.slice(0, 150) }); }); });
    r.on('error', rej); r.write(koerper); r.end();
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  const lg = fs.openSync('/tmp/avatar-api-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/avatar-api-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body;

    console.log('── Ohne Bild ──');
    ok('die Übersicht ist leer', Object.keys((await req('GET', '/api/avatare', max.token)).body.stand).length === 0);
    ok('ein Abruf liefert 404', (await req('GET', '/api/avatare/' + max.user.id, max.token)).status === 404);

    console.log('\n── Hochladen ──');
    // Ein breites Rechteck, damit man sieht, dass zugeschnitten wird.
    const breit = await sharp({ create: { width: 900, height: 300, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    const hoch = await hochladen(max.token, breit, 'ich.png');
    ok('klappt', hoch.status === 200, `${hoch.status} ${hoch.text}`);
    ok('… und liefert eine Frischemarke zurück', !!hoch.body.stand, JSON.stringify(hoch.body));

    const abruf = await req('GET', '/api/avatare/' + max.user.id, max.token);
    ok('das Bild kommt zurück', abruf.status === 200, String(abruf.status));
    ok('… als WebP', /image\/webp/.test(abruf.typ || ''), String(abruf.typ));
    const daten = await sharp(abruf.buf).metadata();
    ok('… quadratisch 256 × 256, egal was hochgeladen wurde',
      daten.width === 256 && daten.height === 256, `${daten.width}×${daten.height}`);
    ok('… und klein (unter 100 kB, obwohl 900×300 hochgeladen)', abruf.buf.length < 100 * 1024, `${abruf.buf.length} Byte`);
    // Der Zwischenspeicher-Hinweis muss „private" sagen — das Bild gehoert zu einer Person und
    // hat in einem gemeinsamen Zwischenspeicher (Proxy) nichts verloren.
    const kopf = await new Promise((res) => {
      const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare/' + max.user.id,
        method: 'GET', headers: { Authorization: 'Bearer ' + max.token } },
        x => { x.resume(); res(x.headers); });
      r.end();
    });
    ok('… und ist als privat markiert', /private/.test(kopf['cache-control'] || ''), String(kopf['cache-control']));

    console.log('\n── Wer darf es sehen? ──');
    ok('ein Kollege ja (angemeldet)', (await req('GET', '/api/avatare/' + max.user.id, chef.token)).status === 200);
    const ohne = await req('GET', '/api/avatare/' + max.user.id, null);
    ok('OHNE Anmeldung nein — das ist der Kern', ohne.status === 401, `${ohne.status}`);
    // Achtung bei der Formulierung: Diese Pfade antworten mit 200 — aber mit der App-Seite, nicht
    // mit dem Bild (die Einzelseiten-Anwendung faengt unbekannte Pfade ab). Ein Status-Vergleich
    // waere hier also irrefuehrend; entscheidend ist, dass KEIN Bild herauskommt.
    for (const pfad of ['/uploads/avatare/', '/storage/avatare/', '/avatare/']) {
      const r = await req('GET', pfad + max.user.id + '.webp', null);
      ok(`kein Bild unter ${pfad}`, !/image\//.test(r.typ || ''), `${r.status}, ${r.typ}`);
    }

    console.log('\n── Man kann nur das EIGENE Bild setzen ──');
    // Die Route nimmt gar keine Kennung entgegen — ein fremdes Konto ist darueber nicht erreichbar.
    // Ein ANDERES Bild — mit demselben waeren die beiden Ergebnisse byteweise gleich und die
    // Pruefung unten wertlos. (Genau daran ist sie beim ersten Lauf umgefallen.)
    const chefBildQuelle = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 90, b: 200 } } }).png().toBuffer();
    const chefHoch = await hochladen(chef.token, chefBildQuelle, 'chef.png');
    ok('der Chef lädt sein eigenes hoch', chefHoch.status === 200);
    const uebersicht = (await req('GET', '/api/avatare', max.token)).body.stand;
    ok('… beide Bilder sind in der Übersicht',
      !!uebersicht[max.user.id] && !!uebersicht[chef.user.id], JSON.stringify(uebersicht));
    const maxBild = (await req('GET', '/api/avatare/' + max.user.id, max.token)).buf;
    const chefBild = (await req('GET', '/api/avatare/' + chef.user.id, max.token)).buf;
    ok('… und es sind verschiedene Bilder', !maxBild.equals(chefBild));

    console.log('\n── Was abgelehnt werden muss ──');
    const kaputt = await hochladen(max.token, Buffer.from('das ist gar kein Bild'), 'boese.png');
    ok('eine als Bild getarnte Textdatei wird abgelehnt', kaputt.status === 400, `${kaputt.status} ${kaputt.text}`);
    ok('… und das alte Bild ist unversehrt',
      (await req('GET', '/api/avatare/' + max.user.id, max.token)).status === 200);
    const falscherTyp = await hochladen(max.token, breit, 'x.pdf', 'bild', 'application/pdf');
    ok('ein PDF wird abgelehnt', falscherTyp.status === 400, `${falscherTyp.status}`);
    ok('ohne Anmeldung geht Hochladen nicht',
      (await hochladen('unsinn', breit, 'x.png')).status === 401);

    console.log('\n── Entfernen ──');
    ok('klappt', (await req('DELETE', '/api/avatare', max.token)).status === 200);
    ok('… danach 404', (await req('GET', '/api/avatare/' + max.user.id, max.token)).status === 404);
    ok('… und die Datei ist wirklich weg', !fs.existsSync(path.join(BILDER, max.user.id + '.webp')));
    ok('… der Chef behält seins', (await req('GET', '/api/avatare/' + chef.user.id, max.token)).status === 200);
    ok('… und die Übersicht kennt nur noch eines',
      Object.keys((await req('GET', '/api/avatare', max.token)).body.stand).length === 1);

    console.log('\n── Im Audit-Log steht es ──');
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const eintraege = JSON.stringify((await req('GET', '/api/audit?limit=100', admin)).body);
    ok('Setzen protokolliert', /avatar_gesetzt/.test(eintraege));
    ok('Entfernen protokolliert', /avatar_entfernt/.test(eintraege));

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nProfilbilder: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
