// MCP-Schnittstelle /mcp: echter MCP-Client, Anmeldung, Rechte, Schreiben mit Vorschau, Protokoll, Bremsen.
//
// Warum (Alex, 14.11.2026): Hermes und später andere KI-Assistenten greifen über /mcp zu — aus dem Internet. Der
// Server ist ein schlanker Eigenbau (Entscheidung A); ob ein echter Client damit klarkommt, prüft hier der
// OFFIZIELLE MCP-Client (@modelcontextprotocol/sdk, nur als Testwerkzeug installiert). Dazu alles, was ein
// Schlüssel nicht darf, gemessen an dem, was ankommt (Antworten, Datenbank, Protokolle).
//
// Geprüft: Handshake + Werkzeugliste + Aufruf mit dem offiziellen Client · ohne/mit falschem/widerrufenem
// Schlüssel und mit normalem Anmelde-Token → 401 · GET → 405 · fremder Origin → 403 · Stapel/falsche Version → 400 ·
// Benachrichtigung → 202 · unbekannte Methode/Werkzeug · Eingabeprüfung · Lese-Schlüssel sieht und benutzt keine
// Schreib-Werkzeuge · Mitarbeiter-Schlüssel sieht nur eigene Zeiten · Vorschau schreibt nichts · Anlegen/Ändern mit
// Werkzeugname im Änderungsprotokoll · kein Lösch-Werkzeug · Zugriffsprotokoll ohne Inhalte · Folgeaufrufe zählen
// nicht doppelt gegen die Bremse · gefälschte interne Kopfzeilen wirken nicht · Bremse je Schlüssel.
//   node tests/mcp-protokoll.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3413, DB = '/tmp/mcp-protokoll.db', LOG = '/tmp/mcp-protokoll-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, token, b, kopf) {
  return new Promise((res) => { const d = b === undefined ? null : (typeof b === 'string' ? b : JSON.stringify(b));
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}), ...(kopf || {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, kopf: x.headers, roh: s }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}
let nr = 1;
const rpc = (schl, method, params, kopf) => req('POST', '/mcp', schl, { jsonrpc: '2.0', id: nr++, method, params }, kopf);
const werkzeug = async (schl, name, args) => {
  const r = await rpc(schl, 'tools/call', { name, arguments: args });
  const res = r.body && r.body.result;
  let daten = null; try { daten = res && !res.isError ? JSON.parse(res.content[0].text) : null; } catch (_) {}
  return { status: r.status, fehler: res ? (res.isError ? res.content[0].text : null) : (r.body && r.body.error && r.body.error.message), daten, struktur: res && res.structuredContent, roh: r.body };
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const anmelden = async (u, p) => (await req('POST', '/api/auth/login', null, { username: u, password: p })).body?.token;
    const admin = await anmelden('admin', adminPw);
    const PW = 'Test1234!';
    const konto = async (username, name, role) => { const r = await req('POST', '/api/users', admin, { username, password: PW, name, role,
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 }); return r.body?.id || r.body?.user?.id; };
    const ids = { mia: await konto('mcpmia', 'Mia Mcp', 'mitarbeiter'), tom: await konto('mcptom', 'Tom Mcp', 'mitarbeiter'), chef: await konto('mcpchef', 'Carla Chef', 'chef') };
    const tok = { mia: await anmelden('mcpmia', PW), tom: await anmelden('mcptom', PW), chef: await anmelden('mcpchef', PW) };
    const eintrag = (t, d, von, bis, kunde) => req('POST', '/api/entries', t, { date: d, time_from: von, time_to: bis, break_minutes: 0, client: kunde });
    await eintrag(tok.mia, '2026-10-05', '07:00', '12:00', 'Bäckerei Korn');
    await eintrag(tok.mia, '2026-10-05', '11:00', '15:00', 'Bäckerei Korn');   // überschneidet sich: zählt einmal → 8 Std.
    await eintrag(tok.mia, '2026-10-06', '07:00', '10:00', 'Stadtwerke');
    await eintrag(tok.tom, '2026-10-05', '07:00', '16:00', 'Bäckerei Korn');
    const schl = async (t, name, recht) => (await req('POST', '/api/schluessel', t, { name, recht, passwort: PW })).body?.schluessel;
    const S = { miaLesen: await schl(tok.mia, 'Hermes Mia', 'lesen'), miaSchreiben: await schl(tok.mia, 'Hermes Mia schreibt', 'schreiben'),
      chef: await schl(tok.chef, 'Assistent Chef', 'lesen'), tom: await schl(tok.tom, 'Toms Skript', 'lesen') };
    ok('Server, Konten, Einträge und vier Schlüssel', admin && Object.values(S).every(Boolean));

    console.log('── offizieller MCP-Client ──');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'arbeitsdoku-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(BASIS + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + S.chef } } });
    await client.connect(transport);
    const info = client.getServerVersion();
    ok('Handshake: Server „arbeitsdoku", mit Anleitung', info && info.name === 'arbeitsdoku' && /stunden_summe/.test(client.getInstructions() || ''), JSON.stringify(info));
    const liste = (await client.listTools()).tools;
    ok('Werkzeugliste: 21 Lese-Werkzeuge mit deutscher Beschreibung und Schema', liste.length === 21 && liste.every(t => t.description && t.inputSchema && t.inputSchema.type === 'object'), liste.length);
    ok('… alle als „nur lesen" gekennzeichnet', liste.every(t => t.annotations && t.annotations.readOnlyHint === true));
    const summe = await client.callTool({ name: 'stunden_summe', arguments: { von: '2026-10-01', bis: '2026-10-31', kunde: 'korn' } });
    const sd = summe.structuredContent;
    ok('stunden_summe „korn" im Oktober: Mia 8 Std. (Überschneidung einmal), Tom 9 Std., gesamt 17',
      sd && sd.stunden_gesamt === 17 && sd.je_mitarbeiter.find(x => x.mitarbeiter === 'Mia Mcp').stunden === 8 && sd.je_mitarbeiter.find(x => x.mitarbeiter === 'Tom Mcp').stunden === 9, JSON.stringify(sd));
    ok('… Text und strukturierte Antwort sind dasselbe', JSON.stringify(JSON.parse(summe.content[0].text)) === JSON.stringify(sd));
    const falsch = await client.callTool({ name: 'stunden_summe', arguments: { von: '2026-10-01' } });
    ok('Pflichtparameter fehlt → Werkzeugfehler (isError), kein Abbruch', falsch.isError === true && /„bis" fehlt/.test(falsch.content[0].text), JSON.stringify(falsch));
    await client.ping();
    ok('ping', true);
    await client.close();

    console.log('── Anmeldung und Protokoll ──');
    let r = await rpc(null, 'tools/list');
    ok('ohne Schlüssel → 401 mit WWW-Authenticate', r.status === 401 && /Bearer/.test(r.kopf['www-authenticate'] || ''), r.status);
    r = await rpc('adk_' + 'x'.repeat(43), 'tools/list');
    ok('falscher Schlüssel → 401', r.status === 401);
    r = await rpc(tok.chef, 'tools/list');
    ok('normales Anmelde-Token (kein Schlüssel) → 401', r.status === 401);
    r = await req('GET', '/mcp', S.chef);
    ok('GET → 405 (kein Ereignisstrom)', r.status === 405 && r.kopf.allow === 'POST', r.status);
    r = await rpc(S.chef, 'ping', {}, { Origin: 'https://boese.example' });
    ok('fremder Origin → 403', r.status === 403, r.status);
    r = await rpc(S.chef, 'ping', {}, { Origin: BASIS });
    ok('eigener Origin → ok', r.status === 200 && r.body.result, r.status);
    r = await req('POST', '/mcp', S.chef, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    ok('Stapel (Array) → 400', r.status === 400 && r.body.error.code === -32600, r.status);
    r = await rpc(S.chef, 'ping', {}, { 'MCP-Protocol-Version': '1999-01-01' });
    ok('unbekannte Protokollversion → 400', r.status === 400, r.status);
    r = await req('POST', '/mcp', S.chef, { jsonrpc: '2.0', method: 'notifications/initialized' });
    ok('Benachrichtigung → 202 ohne Inhalt', r.status === 202 && r.roh === '', r.status);
    r = await rpc(S.chef, 'resources/list');
    ok('unbekannte Methode → -32601', r.body && r.body.error && r.body.error.code === -32601);
    let w = await werkzeug(S.chef, 'gibt_es_nicht', {});
    ok('unbekanntes Werkzeug → -32602', /Unbekanntes Werkzeug/.test(w.fehler || ''), JSON.stringify(w.roh));
    w = await werkzeug(S.chef, 'zeiteintraege_suchen', { von: '2026-13-01' });
    ok('ungültiges Datum → Werkzeugfehler', /gültiges Datum/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.chef, 'zeiteintraege_suchen', { geheim: 1 });
    ok('unbekannter Parameter → Werkzeugfehler', /Unbekannter Parameter/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.chef, 'zeiteintraege_suchen', { pro_seite: 500 });
    ok('pro_seite über 50 → Werkzeugfehler', /höchstens 50/.test(w.fehler || ''), w.fehler);

    console.log('── Rechte ──');
    w = await werkzeug(S.miaLesen, 'zeiteintraege_suchen', { von: '2026-10-01', bis: '2026-10-31' });
    ok('Mia-Schlüssel: nur Mias 3 Einträge', w.daten && w.daten.anzahl === 3 && w.daten.eintraege.every(e => e.mitarbeiter === 'Mia Mcp'), JSON.stringify(w.daten));
    w = await werkzeug(S.miaLesen, 'stunden_summe', { von: '2026-10-01', bis: '2026-10-31', mitarbeiter: 'Tom' });
    ok('Mia fragt nach Toms Stunden → keine fremden Stunden', w.fehler || (w.daten && w.daten.stunden_gesamt === 0), JSON.stringify(w));
    w = await werkzeug(S.miaLesen, 'kunden_suchen', {});
    ok('Mia sieht bei den Kunden nur ihre eigenen Einsätze (Korn 2, nicht 3)', w.daten && w.daten.kunden.find(k => k.kunde === 'Bäckerei Korn').einsaetze === 2, JSON.stringify(w.daten));
    const lesenListe = ((await rpc(S.miaLesen, 'tools/list')).body.result.tools || []).map(t => t.name);
    const schreibListe = ((await rpc(S.miaSchreiben, 'tools/list')).body.result.tools || []).map(t => t.name);
    ok('Lese-Schlüssel: keine Schreib-Werkzeuge in der Liste', !lesenListe.some(n => /anlegen|aendern/.test(n)), lesenListe.join(','));
    ok('Schreib-Schlüssel: zusätzlich anlegen und ändern — und nirgends ein Lösch-Werkzeug',
      schreibListe.includes('zeiteintrag_anlegen') && schreibListe.includes('zeiteintrag_aendern') && !schreibListe.some(n => /loesch|lösch|delete|entfern/.test(n)), schreibListe.join(','));
    const zaehlen = async () => ((await req('GET', '/api/entries?date_from=2000-01-01', admin)).body?.entries || []).length;
    const vorher = await zaehlen();
    w = await werkzeug(S.miaLesen, 'zeiteintrag_anlegen', { datum: '2026-10-07', von: '07:00', bis: '09:00' });
    ok('Lese-Schlüssel ruft zeiteintrag_anlegen trotzdem → abgelehnt, nichts angelegt', /Unbekanntes Werkzeug/.test(w.fehler || '') && (await zaehlen()) === vorher, w.fehler);

    console.log('── Schreiben ──');
    w = await werkzeug(S.miaSchreiben, 'zeiteintrag_anlegen', { datum: '2026-10-07', von: '07:00', bis: '09:30', pause_min: 15, kunde: 'Stadtwerke', vorschau: true });
    ok('Vorschau: Nettostunden 2,25, gespeichert: false, nichts angelegt', w.daten && w.daten.vorschau && w.daten.wuerde_ergeben.netto_std === 2.25 && (await zaehlen()) === vorher, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'zeiteintrag_anlegen', { datum: '2026-10-07', von: '07:00', bis: '09:30', pause_min: 15, kunde: 'Stadtwerke', beschreibung: 'Zählerschrank MCP' });
    const neuNr = w.daten && w.daten.angelegt && w.daten.angelegt.id;
    ok('Anlegen: gespeichert, gehört Mia', w.daten && w.daten.gespeichert && (await zaehlen()) === vorher + 1, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'zeiteintrag_anlegen', { datum: '2026-10-07', von: '07:00', bis: '09:30', pause_min: 15, kunde: 'Stadtwerke', beschreibung: 'Zählerschrank MCP' });
    ok('derselbe Eintrag noch einmal → Rückfrage „gibt es schon", nichts angelegt', /gibt es schon/.test(w.fehler || '') && (await zaehlen()) === vorher + 1, w.fehler);
    w = await werkzeug(S.miaSchreiben, 'zeiteintrag_aendern', { nr: neuNr, bis: '10:00' });
    ok('Ändern: neues Ende, Nettostunden 2,75', w.daten && w.daten.gespeichert && w.daten['geändert'].netto_std === 2.75, JSON.stringify(w));
    const tomsNr = ((await req('GET', '/api/entries', tok.tom)).body.entries || [])[0].id;
    w = await werkzeug(S.miaSchreiben, 'zeiteintrag_aendern', { nr: tomsNr, beschreibung: 'fremd' });
    ok('fremden Eintrag ändern → abgelehnt (die Route entscheidet)', !!w.fehler && !w.daten, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'zeiteintrag_aendern', { nr: neuNr });
    ok('Ändern ohne Felder → Hinweis', /Nichts zu ändern/.test(w.fehler || ''), w.fehler);
    const prot = ((await req('GET', '/api/audit?action=schluessel_schreibzugriff&limit=50', admin)).body?.logs || []);
    ok('Änderungsprotokoll: Anlegen + Ändern mit Schlüssel und Werkzeugname (Vorschau und Abgelehntes nicht)',
      prot.length === 2 && prot.some(p => /POST \/api\/entries → 201 · über Schlüssel „Hermes Mia schreibt" · Werkzeug zeiteintrag_anlegen/.test(p.details))
      && prot.some(p => /Werkzeug zeiteintrag_aendern/.test(p.details)), JSON.stringify(prot.map(p => p.details)));

    console.log('── Zugriffsprotokoll ──');
    await werkzeug(S.chef, 'zeiteintraege_suchen', { text: 'GeheimesSuchwort4711' });
    const zug = (await req('GET', '/api/schluessel/protokoll', admin)).body?.zugriffe || [];
    ok('Zugriffe stehen drin: Werkzeug, Ergebnis, Schlüssel, Dauer', zug.some(z => z.werkzeug === 'zeiteintraege_suchen' && z.ergebnis === 'ok' && z.schluessel === 'Assistent Chef' && z.dauer_ms >= 0)
      && zug.some(z => z.ergebnis === 'abgewiesen') && zug.some(z => z.werkzeug === 'zeiteintrag_anlegen' && z.ergebnis === 'fehler'), JSON.stringify(zug.slice(0, 3)));
    ok('… ohne Inhalte (das Suchwort steht nirgends)', !JSON.stringify(zug).includes('GeheimesSuchwort4711'));
    ok('Mitarbeiter darf das Zugriffsprotokoll nicht sehen', (await req('GET', '/api/schluessel/protokoll', tok.mia)).status === 403);

    console.log('── Kopfzeilen fälschen ──');
    await rpc(S.tom, 'ping', {}, { 'X-Intern': 'a'.repeat(48), 'X-Intern-Ip': '203.0.113.99', 'X-Intern-Werkzeug': 'gefaelscht' });
    await req('GET', '/api/bulletin', S.tom, undefined, { 'X-Intern': 'b'.repeat(48), 'X-Intern-Ip': '203.0.113.99' });
    const toms = ((await req('GET', '/api/schluessel', tok.tom)).body.schluessel || [])[0];
    ok('gefälschtes X-Intern ändert die gespeicherte Adresse nicht', toms && toms.zuletzt_ip && toms.zuletzt_ip !== '203.0.113.99', JSON.stringify(toms));

    console.log('── Bremse ──');
    const vielSchl = await schl(tok.chef, 'Viel', 'lesen');
    const st = [];
    for (let i = 0; i < 25; i++) st.push((await werkzeug(vielSchl, 'kunden_suchen', {})).status);
    ok('25 × kunden_suchen (je 2 Folgeaufrufe) bleibt unter der Grenze — Folgeaufrufe zählen nicht mit', st.every(s => s === 200), st.join(','));
    for (let i = 0; i < 35; i++) st.push((await rpc(vielSchl, 'ping')).status);
    const r61 = await rpc(vielSchl, 'ping');
    ok('… nach 60 Anfragen in der Minute: 429', st.slice(0, 60).every(s => s === 200) && r61.status === 429, `${st.length}: ${st.slice(55).join(',')} → ${r61.status}`);

    console.log('── Widerruf ──');
    const miaId = ((await req('GET', '/api/schluessel', tok.mia)).body.schluessel || []).find(s => s.name === 'Hermes Mia').id;
    await req('POST', `/api/schluessel/${miaId}/widerrufen`, tok.mia);
    r = await rpc(S.miaLesen, 'tools/list');
    ok('widerrufener Schlüssel → 401 an /mcp', r.status === 401, r.status);
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nMCP-Schnittstelle: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
