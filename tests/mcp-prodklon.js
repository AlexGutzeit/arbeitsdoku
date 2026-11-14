// MCP-Werkzeuge gegen echte Daten (Prod-Kopie): jedes Werkzeug je Rolle, kleine Antworten, Stunden = App-Statistik.
//
// Warum (Alex, 14.11.2026): Die Werkzeuge lesen die Antworten der App-Routen und fassen sie zusammen. Ob die Felder
// stimmen und nichts aus dem Ruder läuft (Größe, Fehler bei Altdaten), zeigt erst der echte Bestand. Und die wichtigste
// Zahl — „wie viele Stunden" — muss für JEDEN Mitarbeiter und Monat genau das Ist der App-Statistik treffen.
//
// Arbeitet auf einer KOPIE von /tmp/prodklon.db (die Vorlage bleibt unberührt, geprüft per SHA-256).
// Fehlt die Vorlage, wird der Test übersprungen (Hinweis, Exit 0).
//   node tests/mcp-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');

const VORLAGE = '/tmp/prodklon.db';
const PORT = 3414, DB = '/tmp/mcp-prodklon-kopie.db', LOG = '/tmp/mcp-prodklon-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

if (!fs.existsSync(VORLAGE)) { console.log(`${VORLAGE} fehlt — Test uebersprungen.`); process.exit(0); }
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function req(m, p, token, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, laenge: s.length }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}
let nr = 1;
async function werkzeug(schl, name, args) {
  const r = await req('POST', '/mcp', schl, { jsonrpc: '2.0', id: nr++, method: 'tools/call', params: { name, arguments: args || {} } });
  const res = r.body && r.body.result;
  return { status: r.status, laenge: r.laenge, fehler: res && res.isError ? res.content[0].text : (r.body && r.body.error ? r.body.error.message : null), daten: res && res.structuredContent };
}

(async () => {
  const vorher = sha(VORLAGE);
  fs.copyFileSync(VORLAGE, DB);
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(200); }
    const anmelden = async (u) => (await req('POST', '/api/auth/login', null, { username: u, password: 'test' })).body?.token;
    const admin = await anmelden('admin');
    const leute = ((await req('GET', '/api/users/list', admin)).body?.users || []).filter(u => u.active !== 0);
    // Benutzernamen kommen aus der Kopie und werden nirgends ausgegeben (keine echten Namen in Protokollen)
    const namen = ((await req('GET', '/api/users', admin)).body?.users || []).filter(u => u.active !== 0);
    const rolle = (r) => namen.find(u => u.role === r);
    const schl = async (tok, n) => (await req('POST', '/api/schluessel', tok, { name: n, recht: 'lesen', passwort: 'test' })).body?.schluessel;
    const K = {};
    for (const r of ['admin', 'chef', 'mitarbeiter']) {
      const u = r === 'admin' ? { username: 'admin' } : rolle(r);
      const t = u && await anmelden(u.username);
      K[r] = t && await schl(t, 'Prodklon ' + r);
    }
    ok('Kopie läuft, Schlüssel für Admin, Chef und Mitarbeiter', admin && K.admin && K.chef && K.mitarbeiter, Object.keys(K).filter(k => !K[k]).join(','));

    console.log('── jedes Werkzeug je Rolle ──');
    const AUFRUFE = [['angemeldet_als'], ['mitarbeiter_liste'], ['zeiteintraege_suchen', {}], ['zeiteintraege_suchen', { von: '2026-01-01', pro_seite: 50, seite: 2 }],
      ['stunden_summe', { von: '2026-01-01', bis: '2026-12-31', einzelposten: true }], ['kunden_suchen', {}], ['auftraege_suchen', {}],
      ['planung_anzeigen', {}], ['abwesenheiten', {}], ['stundenkonto', {}], ['stundenkonto', { zeitraum: 'gesamt' }], ['urlaubskonto', {}],
      ['notizen_suchen', {}], ['aushaenge'], ['werkzeuge_liste', {}], ['bestellungen', {}], ['bestellungen', { bestellte: true }],
      ['lager_suchen', {}], ['meldungen', {}], ['meldungen', { erledigte: true }], ['ablage_liste', {}], ['abrechnung_stand'], ['kollegen', {}]];
    const projekte = (await req('GET', '/api/projects', admin)).body?.projects || [];
    for (const p of projekte.slice(0, 5)) AUFRUFE.push(['auftrag_anzeigen', { nr: p.id }]);
    for (const r of ['admin', 'chef', 'mitarbeiter']) {
      const probleme = [], gross = [];
      for (const [name, args] of AUFRUFE) {
        const w = await werkzeug(K[r], name, args);
        // Erwartbare Ablehnungen der Route (z. B. Mitarbeiter darf Projektstatistik nicht) sind ok — Absturz oder 500 nicht
        if (w.status !== 200 || (w.fehler && /interner Fehler/i.test(w.fehler))) probleme.push(`${name}: ${w.status} ${w.fehler || ''}`);
        if (w.laenge > 120000) gross.push(`${name} ${Math.round(w.laenge / 1024)} KB`);
      }
      ok(`${r}: alle ${AUFRUFE.length} Aufrufe ohne internen Fehler`, probleme.length === 0, probleme.join(' | '));
      ok(`${r}: keine Antwort über 120 KB`, gross.length === 0, gross.join(', '));
    }
    const ma = await werkzeug(K.mitarbeiter, 'zeiteintraege_suchen', { von: '2000-01-01', pro_seite: 50 });
    const maId = rolle('mitarbeiter').id;
    const maEigene = ((await req('GET', `/api/entries?user_id=${maId}&date_from=2000-01-01`, admin)).body?.entries || []).length;
    ok('Mitarbeiter-Schlüssel: genau so viele Einträge wie die eigenen in der App', ma.daten && ma.daten.anzahl === maEigene, `${ma.daten && ma.daten.anzahl} / ${maEigene}`);

    console.log('── Stundensumme = Ist der App-Statistik (je Mitarbeiter, je Monat) ──');
    // Alle Aufrufe kommen von 127.0.0.1 — die Bremse je Adresse (120/Min.) ist nach den Rollen-Durchläufen fast voll.
    await sleep(61000);
    const abweichungen = []; let verglichen = 0;
    for (const monat of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      // je Monat ein frischer Schlüssel — sonst greift nach 60 Aufrufen in der Minute die Bremse (429)
      const mSchl = await schl(admin, 'Vergleich ' + monat);
      const bis = new Date(Date.UTC(Number(monat.slice(0, 4)), Number(monat.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const stat = (await req('GET', `/api/statistics?period=month&date=${monat}-15`, admin)).body?.users || [];
      for (const u of stat) {
        const w = await werkzeug(mSchl, 'stunden_summe', { von: `${monat}-01`, bis, mitarbeiter: String(u.user_id) });
        const mcp = w.daten ? w.daten.stunden_gesamt : null;
        verglichen++;
        if (mcp === null || Math.abs(mcp - (u.ist || 0)) > 0.005) abweichungen.push(`${monat} Nr. ${u.user_id}: MCP ${mcp} (${w.status}${w.fehler ? ' ' + w.fehler : ''}) / App ${u.ist}`);
      }
    }
    ok(`${verglichen} Vergleiche Monat × Mitarbeiter: keine Abweichung`, verglichen > 10 && abweichungen.length === 0, abweichungen.slice(0, 5).join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    srv.kill();
    await sleep(500);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  ok('Vorlage /tmp/prodklon.db unverändert (SHA-256)', sha(VORLAGE) === vorher);
  console.log(`\nMCP am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
