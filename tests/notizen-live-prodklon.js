// Live-Notizen am Prod-Klon: Umstellung der echten Notizen auf das gemeinsame Dokument (Etappe A, Schritt 3).
//
// Beim ersten Start nach dem Deploy wird jede Notiz einmal umgestellt: Aus ihrem Klartext wird ein
// Yjs-Dokument (database/init.js, ensureNotizLiveSchema). Das darf NICHTS sichtbar verändern:
//   * jeder Text zeichengleich (auch Umlaute, Zeilenumbrüche, Sonderzeichen wie „×"),
//   * Zeitstempel und „bearbeitet von" unberührt — sonst sprängen morgens bei allen die Zähler an,
//   * ein zweiter Start stellt nichts mehr um (idempotent),
//   * die Eigentümerin öffnet ihre Notiz live und sieht genau ihren Text.
// Die Vorlage /tmp/prodklon.db wird nur gelesen (Prüfsumme vorher/nachher).
//
//   node tests/notizen-live-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { geraetOeffnen } = require('./hilfen/notiz-live-geraet');
const nd = require('../notiz-dokument');

const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3337, DB = '/tmp/notizen-live-prodklon.db', LOG = '/tmp/notizen-live-prodklon.log';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

let srv = null;
async function starten(protokoll) {
  const lg = fs.openSync(protokoll, 'w');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) return true; } catch (_) {} await sleep(150); }
  return false;
}
async function beenden() {
  if (!srv) return;
  const weg = new Promise(r => srv.once('exit', r));
  srv.kill('SIGTERM'); await weg; srv = null;
}
const zeilen = (d, sql) => { const r = d.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test übersprungen.'); process.exit(0); }
  const pruefsumme = () => crypto.createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex');
  const summeVorher = pruefsumme();
  fs.copyFileSync(QUELLE, DB);
  const SQL = await initSqlJs();
  const d0 = new SQL.Database(fs.readFileSync(DB));
  const spalten = zeilen(d0, 'PRAGMA table_info(notes)').map(c => c.name);
  const alt = zeilen(d0, 'SELECT id, user_id, title, body, updated_at, updated_by FROM notes ORDER BY id');
  const freigabenEcht = zeilen(d0, 'SELECT COUNT(*) AS n FROM note_shares WHERE note_id IN (SELECT id FROM notes)')[0].n;
  d0.close();
  console.log(`Klon: ${alt.length} Notizen${spalten.includes('ydoc') ? ' (schon umgestellt!)' : ''}\n`);
  if (!alt.length) { console.log('Keine Notizen im Klon — Test übersprungen.'); process.exit(0); }

  const offen = [];
  try {
    console.log('Erster Start: Umstellung');
    ok('Server startet auf dem Klon', await starten(LOG));
    await beenden();
    const log1 = fs.readFileSync(LOG, 'utf8');
    const m = log1.match(/Migration: (\d+) Notiz\(en\) auf gemeinsames Dokument umgestellt\./);
    ok(`alle ${alt.length} Notizen umgestellt (Meldung im Startprotokoll)`, spalten.includes('ydoc') || (m && Number(m[1]) === alt.length), m ? m[0] : 'keine Meldung');
    ok('keine Fehlermeldung der Umstellung', !/ensureNotizLiveSchema fehlgeschlagen/.test(log1));
    {
      const dw = new SQL.Database(fs.readFileSync(DB));
      const waisen = zeilen(dw, 'SELECT COUNT(*) AS n FROM note_shares WHERE note_id NOT IN (SELECT id FROM notes)')[0].n;
      const echte = zeilen(dw, 'SELECT COUNT(*) AS n FROM note_shares')[0].n;
      dw.close();
      ok('verwaiste Freigaben zu gelöschten Notizen sind weg, echte Freigaben bleiben', waisen === 0 && echte === freigabenEcht,
        JSON.stringify({ waisen, echte, erwartet: freigabenEcht }));
    }

    const d1 = new SQL.Database(fs.readFileSync(DB));
    const neu = Object.fromEntries(zeilen(d1, 'SELECT id, title, body, body_delta, ydoc, updated_at, updated_by FROM notes').map(n => [n.id, n]));
    d1.close();
    const abweichend = [], zeitAnders = [], dokAnders = [];
    for (const a of alt) {
      const n = neu[a.id];
      if (!n || n.body !== a.body || n.title !== a.title) abweichend.push(a.id);
      if (!n || n.updated_at !== a.updated_at || n.updated_by !== a.updated_by) zeitAnders.push(a.id);
      if (n && n.ydoc) {
        const doc = nd.laden(n.ydoc);
        const f = nd.felder(doc);
        if (doc.getText(nd.TEXT).toString() !== (a.body || '') + '\n' || f.body_delta !== n.body_delta) dokAnders.push(a.id);
        doc.destroy();
      } else dokAnders.push(a.id);
    }
    ok('jeder Text und Titel zeichengleich', abweichend.length === 0, abweichend.join(', '));
    ok('Zeitstempel und „bearbeitet von" unberührt (kein Zähler springt an)', zeitAnders.length === 0, zeitAnders.join(', '));
    ok('jedes Dokument enthält genau den Text (+ Zeilenende), Formatierung passt dazu', dokAnders.length === 0, dokAnders.join(', '));
    const mitSonderzeichen = alt.filter(a => /[äöüÄÖÜß×–„"\n]/.test(a.body || '')).length;
    console.log(`    (davon ${mitSonderzeichen} mit Umlauten, Sonderzeichen oder Zeilenumbrüchen)`);

    console.log('\nZweiter Start');
    ok('Server startet erneut', await starten(LOG + '.2'));
    const log2 = fs.readFileSync(LOG + '.2', 'utf8');
    ok('stellt nichts mehr um (idempotent)', !/auf gemeinsames Dokument umgestellt/.test(log2));

    console.log('\nLive öffnen');
    // Eine Eigentümerin ohne zweiten Faktor (am Klon ist jedes Passwort „test")
    const d2 = new SQL.Database(fs.readFileSync(DB));
    const zweiFaktor = new Set(zeilen(d2, "SELECT name FROM sqlite_master WHERE name='twofa_secrets'").length
      ? zeilen(d2, 'SELECT user_id FROM twofa_secrets').map(r => r.user_id) : []);
    const kandidat = zeilen(d2, `SELECT n.id, n.body, n.user_id, u.username FROM notes n JOIN users u ON u.id = n.user_id
                                  WHERE COALESCE(u.active,1) = 1 ORDER BY LENGTH(n.body) DESC`).find(k => !zweiFaktor.has(k.user_id));
    d2.close();
    let anmeldung = null;
    if (kandidat) anmeldung = await req('POST', '/api/auth/login', null, { username: kandidat.username, password: 'test' });
    const token = anmeldung && anmeldung.body && anmeldung.body.token;
    if (!token) {
      console.log('    (keine Eigentümerin ohne zweiten Faktor anmeldbar — Teil übersprungen)');
    } else {
      const ticket = (await req('GET', '/api/events/ticket', token)).body.ticket;
      const g = await geraetOeffnen({ port: PORT, ticket, noteId: kandidat.id, token });
      offen.push(g);
      ok('die Eigentümerin öffnet ihre längste Notiz live und sieht genau ihren Text',
        g.status === 200 && g.text() === (kandidat.body || '') + '\n', `${g.status} ${g.doc && JSON.stringify(g.text().slice(0, 60))}`);
    }
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const g of offen) g.schliessen();
    await beenden().catch(() => {});
  }
  ok('die Vorlage /tmp/prodklon.db ist unverändert', pruefsumme() === summeVorher);
  console.log(`\nLive-Notizen (Prod-Klon): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
