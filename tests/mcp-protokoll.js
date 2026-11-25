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
const kalendertag = require('./hilfen/kalendertag');
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
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, can_mcp: 2 }); return r.body?.id || r.body?.user?.id; };
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
    ok('Werkzeugliste: 23 Lese-Werkzeuge mit deutscher Beschreibung und Schema', liste.length === 23 && liste.every(t => t.description && t.inputSchema && t.inputSchema.type === 'object'), liste.length);
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

    console.log('── Material, Abwesenheit, Werkzeug ──');
    await req('POST', '/api/projects', admin, { name: 'Neubau Probe', client: 'Probe' });
    for (const n of ['Bohrhammer', 'Presszange']) await req('POST', '/api/tools', admin, { name: n });
    S.tomSchreiben = await schl(tok.tom, 'Tom schreibt', 'schreiben');
    const chefSchreibVorab = await schl(tok.chef, 'Chef schreibt (Brett)', 'schreiben');
    const schreibNamen = ((await rpc(S.miaSchreiben, 'tools/list')).body.result.tools || []).map(t => t.name);
    ok('Schreib-Schlüssel: 36 Werkzeuge (23 lesen + 13 schreiben), Lese-Schlüssel weiter 23',
      schreibNamen.length === 36 && ['material_bestellen', 'abwesenheit_eintragen', 'werkzeug_entnehmen', 'werkzeug_zurueckgeben'].every(n => schreibNamen.includes(n))
      && ((await rpc(S.chef, 'tools/list')).body.result.tools || []).length === 23, schreibNamen.join(','));
    const bestellungen = async () => ((await req('GET', '/api/orders', admin)).body?.orders || []);
    w = await werkzeug(S.miaSchreiben, 'material_bestellen', { material: 'Kabelbinder 280 mm', menge: 50, einheit: 'Stk', auftrag: 'neubau', vorschau: true });
    ok('Bestellung Vorschau: für „Neubau Probe", nichts bestellt', w.daten && w.daten.vorschau && w.daten.wuerde_ergeben.fuer === 'Neubau Probe' && (await bestellungen()).length === 0, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'material_bestellen', { material: 'Kabelbinder 280 mm', menge: 50, einheit: 'Stk', auftrag: 'neubau' });
    const best = await bestellungen();
    ok('Bestellung aufgegeben: 50 Stk für Neubau Probe, von Mia', w.daten && w.daten.gespeichert && best.length === 1 && best[0].quantity === 50 && best[0].location_text === 'Neubau Probe' && best[0].user_name === 'Mia Mcp', JSON.stringify(best));
    w = await werkzeug(S.miaSchreiben, 'material_bestellen', { material: 'Dübel', auftrag: 'gibtsnicht' });
    ok('unbekannter Auftrag → Hinweis, nichts bestellt', /Kein Auftrag „gibtsnicht"/.test(w.fehler || '') && (await bestellungen()).length === 1, w.fehler);
    w = await werkzeug(S.miaSchreiben, 'material_bestellen', { material: 'Dübel' });
    ok('ohne Auftrag → fürs Lager', w.daten && w.daten.bestellung && w.daten.bestellung.fuer === 'Lager', JSON.stringify(w.daten));

    const abw = async () => ((await req('GET', '/api/absences?from=2026-01-01&to=2026-12-31', admin)).body?.absences || []).filter(x => x.type !== 'feiertag');
    w = await werkzeug(S.miaSchreiben, 'abwesenheit_eintragen', { art: 'urlaub', von: '2026-12-21', bis: '2026-12-23', vorschau: true });
    ok('Urlaub Vorschau: „beantragt — wartet auf Genehmigung", nichts eingetragen', w.daten && w.daten.vorschau && /beantragt/.test(w.daten.wuerde_ergeben.status) && (await abw()).length === 0, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'abwesenheit_eintragen', { art: 'urlaub', von: '2026-12-21', bis: '2026-12-23', kommentar: 'über Hermes' });
    let abwListe = await abw();
    ok('Urlaub beantragt: Status pending, für Mia', w.daten && w.daten.gespeichert && abwListe.length === 1 && abwListe[0].status === 'pending' && abwListe[0].user_id === ids.mia, JSON.stringify(abwListe));
    w = await werkzeug(S.miaSchreiben, 'abwesenheit_eintragen', { art: 'fza', von: '2026-12-22' });
    ok('FZA am selben Tag → Hinweis der App (Überschneidung), nichts eingetragen', !!w.fehler && (await abw()).length === 1, w.fehler);
    w = await werkzeug(S.miaSchreiben, 'abwesenheit_eintragen', { art: 'krank', von: '2026-11-02' });
    abwListe = await abw();
    ok('Krank: sofort eingetragen (Status active)', w.daten && w.daten.gespeichert && abwListe.some(x => x.type === 'krank' && x.status === 'active'), JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'abwesenheit_eintragen', { art: 'feiertag', von: '2026-12-24' });
    ok('Feiertag ist keine erlaubte Art → Eingabefehler', /einer dieser Werte/.test(w.fehler || ''), w.fehler);

    const wz = async (name) => ((await req('GET', '/api/tools', admin)).body?.tools || []).find(t => t.name === name);
    w = await werkzeug(S.miaSchreiben, 'werkzeug_entnehmen', { werkzeug: 'bohr', auftrag: 'neubau', vorschau: true });
    ok('Werkzeug Vorschau: nichts entnommen', w.daten && w.daten.vorschau && !(await wz('Bohrhammer')).checkout_id, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'werkzeug_entnehmen', { werkzeug: 'bohr', auftrag: 'neubau', adresse: 'Baustelle Nord' });
    let bh = await wz('Bohrhammer');
    ok('Mia entnimmt den Bohrhammer für Neubau Probe', w.daten && w.daten.gespeichert && bh.checked_out_by === ids.mia && bh.checkout_project_name === 'Neubau Probe', JSON.stringify(bh));
    w = await werkzeug(S.tomSchreiben, 'werkzeug_entnehmen', { werkzeug: 'Bohrhammer' });
    ok('Tom ohne „übernehmen" → Hinweis „ist gerade bei Mia", bleibt bei Mia', /ist gerade bei Mia Mcp/.test(w.fehler || '') && (await wz('Bohrhammer')).checked_out_by === ids.mia, w.fehler);
    w = await werkzeug(S.tomSchreiben, 'werkzeug_entnehmen', { werkzeug: 'Bohrhammer', uebernehmen: true });
    ok('Tom mit uebernehmen=true → jetzt bei Tom', w.daten && w.daten.gespeichert && (await wz('Bohrhammer')).checked_out_by === ids.tom, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'werkzeug_zurueckgeben', { werkzeug: 'Bohrhammer' });
    ok('Mia kann Toms Werkzeug nicht zurückgeben (die Route entscheidet)', /aktuelle Besitzer/.test(w.fehler || '') && (await wz('Bohrhammer')).checked_out_by === ids.tom, w.fehler);
    w = await werkzeug(S.tomSchreiben, 'werkzeug_zurueckgeben', { werkzeug: 'Bohrhammer' });
    ok('Tom gibt zurück → frei', w.daten && w.daten.gespeichert && !(await wz('Bohrhammer')).checkout_id, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'werkzeug_entnehmen', { werkzeug: 'zange zz' });
    ok('unbekanntes Werkzeug → Hinweis', /Kein Werkzeug/.test(w.fehler || ''), w.fehler);

    const prot2 = ((await req('GET', '/api/audit?action=schluessel_schreibzugriff&limit=100', admin)).body?.logs || []).map(p => p.details);
    ok('Änderungsprotokoll: Bestellungen, Abwesenheiten und Werkzeug-Vorgänge mit Schlüssel und Werkzeugname, keine Vorschau',
      prot2.filter(d => /POST \/api\/orders → 201 .*Werkzeug material_bestellen/.test(d)).length === 2
      && prot2.filter(d => /POST \/api\/absences → 201 .*Werkzeug abwesenheit_eintragen/.test(d)).length === 2
      && prot2.some(d => /\/checkout → 200 .*Werkzeug werkzeug_entnehmen/.test(d)) && prot2.some(d => /\/takeover → 200 .*„Tom schreibt"/.test(d))
      && prot2.some(d => /\/return → 200 .*Werkzeug werkzeug_zurueckgeben/.test(d)), JSON.stringify(prot2).slice(0, 600));

    console.log('── Schwarzes Brett ──');
    const brettZahl = async () => ((await req('GET', '/api/bulletin', admin)).body?.entries || []).length;
    w = await werkzeug(S.miaSchreiben, 'aushang_anlegen', { titel: 'Grillfest', text: 'Freitag ab 16 Uhr' });
    ok('Mia ohne Recht „Schwarzes Brett" → klarer Hinweis, nichts ausgehängt', /fehlt dir das Recht/.test(w.fehler || '') && (await brettZahl()) === 0, w.fehler);
    await req('PUT', `/api/users/${ids.mia}`, admin, { can_bulletin: true });
    // Termin und Entfernen-Datum relativ zu heute: Mit festen Daten (20./21.11.2026) war der Aushang ab dem
    // 22.11. schon abgelaufen, die App nahm ihn sofort wieder ab, und der Test wurde rot (Suite 25.11.2026).
    const TERMIN = kalendertag(10), ENTFERNEN = kalendertag(11);
    w = await werkzeug(S.miaSchreiben, 'aushang_anlegen', { titel: 'Grillfest', text: 'Freitag ab 16 Uhr', termin: TERMIN, vorschau: true });
    ok('mit Recht: Vorschau, nichts ausgehängt', w.daten && w.daten.vorschau && (await brettZahl()) === 0, JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'aushang_anlegen', { titel: 'Grillfest', text: 'Freitag ab 16 Uhr', termin: TERMIN, entfernen_am: ENTFERNEN });
    const aushNr = w.daten && w.daten.aushang && w.daten.aushang.nr;
    let brettLesen = await werkzeug(S.chef, 'aushaenge', {});
    const aush = brettLesen.daten && brettLesen.daten.aushaenge.find(x => x.nr === aushNr);
    ok('ausgehängt: der Chef liest ihn mit Nummer, Termin, Entfernen-Datum und Autorin', aush && aush.termin === TERMIN && aush.entfernt_am === ENTFERNEN && aush.von === 'Mia Mcp', JSON.stringify(brettLesen.daten));
    w = await werkzeug(S.miaSchreiben, 'aushang_anlegen', { titel: 'x', termin: '20.11.2026' });
    ok('falsches Datumsformat → Eingabefehler (die Route prüft Daten nicht selbst)', /gültiges Datum/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.miaSchreiben, 'aushang_aendern', { nr: aushNr, text: 'Freitag ab 17 Uhr, bitte Salat mitbringen' });
    brettLesen = await werkzeug(S.chef, 'aushaenge', {});
    ok('ändern: neuer Text kommt an', w.daten && w.daten.gespeichert && brettLesen.daten.aushaenge.find(x => x.nr === aushNr).text === 'Freitag ab 17 Uhr, bitte Salat mitbringen', JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'aushang_aendern', { nr: aushNr, text: 'Freitag ab 17 Uhr, bitte Salat mitbringen' });
    ok('gleicher Text noch einmal → „keine Änderung" (keine Meldung, kein Zähler)', w.daten && w.daten.gespeichert === false && /Keine Änderung/.test(w.daten.hinweis), JSON.stringify(w));
    w = await werkzeug(S.miaSchreiben, 'aushang_aendern', { nr: aushNr, titel: '  ' });
    ok('leere Überschrift → Hinweis', /nicht leer/.test(w.fehler || ''), w.fehler);
    await req('PUT', `/api/users/${ids.mia}`, admin, { can_bulletin: false });
    w = await werkzeug(S.miaSchreiben, 'aushang_aendern', { nr: aushNr, titel: 'Grillfest abgesagt' });
    ok('Recht entzogen → Ändern abgelehnt, Aushang unverändert', /fehlt dir das Recht/.test(w.fehler || '') && (await werkzeug(S.chef, 'aushaenge', {})).daten.aushaenge.find(x => x.nr === aushNr).titel === 'Grillfest', w.fehler);
    const delBrett = await req('DELETE', `/api/bulletin/${aushNr}`, chefSchreibVorab);
    ok('DELETE /api/bulletin/:id mit Schreibschlüssel des Chefs → 403', delBrett.status === 403 && delBrett.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT', JSON.stringify(delBrett));

    console.log('── Mein Konto und Zeitnachweis-PDF ──');
    let mk = await werkzeug(S.tom, 'mein_konto', {});
    ok('mein_konto mit Lese-Schlüssel: Stammdaten, Push (Standard alles an), Warnungen, Kollegen-Teil',
      mk.daten && mk.daten.stammdaten.name === 'Tom Mcp' && Object.values(mk.daten.benachrichtigungen.push).every(v => v === true)
      && mk.daten.gesetzeswarnungen.pausen === true && 'fuer_kollegen' in mk.daten, JSON.stringify(mk.daten).slice(0, 300));
    ok('… ohne Zugangsschlüssel, Passwort, Zwei-Faktor', !/schluessel_|passwort|zwei_faktor|adk_/i.test(JSON.stringify(Object.keys(mk.daten))) && !JSON.stringify(mk.daten).includes('adk_'));
    const pdfAntwort = (await rpc(S.tom, 'tools/call', { name: 'zeitnachweis_pdf', arguments: { von: '2026-10-01', bis: '2026-10-31' } })).body.result;
    const res = pdfAntwort && pdfAntwort.content && pdfAntwort.content.find(c => c.type === 'resource');
    const bytes = res ? Buffer.from(res.resource.blob, 'base64') : Buffer.alloc(0);
    ok('zeitnachweis_pdf (Lese-Schlüssel): eingebettete Datei application/pdf, beginnt mit %PDF', res && res.resource.mimeType === 'application/pdf' && bytes.slice(0, 4).toString() === '%PDF', JSON.stringify(pdfAntwort).slice(0, 200));
    ok('… das strukturierte Ergebnis bleibt klein (keine Datei darin), nennt Seiten und Download-Adresse',
      pdfAntwort.structuredContent && pdfAntwort.structuredContent.seiten >= 1 && !JSON.stringify(pdfAntwort.structuredContent).includes(res.resource.blob.slice(0, 50))
      && /\/api\/pdf\/export\?date_from=2026-10-01&date_to=2026-10-31/.test(pdfAntwort.structuredContent.download.adresse), JSON.stringify(pdfAntwort.structuredContent));
    const direkt = await new Promise((r) => { http.get({ host: 'localhost', port: PORT, path: '/api/pdf/export?date_from=2026-10-01&date_to=2026-10-31', headers: { Authorization: 'Bearer ' + S.tom } },
      x => { const t = []; x.on('data', c => t.push(c)); x.on('end', () => r({ status: x.statusCode, typ: x.headers['content-type'], b: Buffer.concat(t) })); }); });
    ok('… und die Download-Adresse liefert mit demselben Schlüssel das PDF', direkt.status === 200 && /application\/pdf/.test(direkt.typ) && direkt.b.slice(0, 4).toString() === '%PDF', `${direkt.status} ${direkt.typ}`);
    w = await werkzeug(S.tom, 'zeitnachweis_pdf', { von: '2026-10-31', bis: '2026-10-01' });
    ok('von nach bis → Hinweis', /liegt nach/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.tom, 'benachrichtigungen_einstellen', { planung: false });
    ok('Lese-Schlüssel kann Einstellungen nicht ändern (Werkzeug unbekannt)', /Unbekanntes Werkzeug/.test(w.fehler || ''), w.fehler);
    const restPush = await req('PUT', '/api/push/prefs', S.tom, { planning: false });
    ok('… und über REST auch nicht (403)', restPush.status === 403 && restPush.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT', JSON.stringify(restPush.body));

    w = await werkzeug(S.miaSchreiben, 'benachrichtigungen_einstellen', { planung: false, bestellungen: false });
    let pr = (await req('GET', '/api/push/prefs', tok.mia)).body;
    ok('Push: Planung und Bestellungen aus, der Rest bleibt an', w.daten && pr.planning === false && pr.orders === false && pr.bulletin === true && pr.meldungen === true, JSON.stringify(pr));
    w = await werkzeug(S.miaSchreiben, 'benachrichtigungen_einstellen', {});
    ok('… ohne Angabe → Hinweis', /mindestens eine Kategorie/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.miaSchreiben, 'gesetzeswarnungen_einstellen', { ruhezeit: false });
    let wa = (await req('GET', '/api/users/warnungen', tok.mia)).body;
    ok('Warnungen: nur Ruhezeit aus, Pausen und Höchstarbeitszeit bleiben an (die Route würde Fehlendes auf „an" setzen)', wa.ruhezeit === false && wa.pausen === true && wa.arbeitszeit === true, JSON.stringify(wa));
    await werkzeug(S.miaSchreiben, 'gesetzeswarnungen_einstellen', { pausen: false });
    wa = (await req('GET', '/api/users/warnungen', tok.mia)).body;
    ok('… zweite Änderung (Pausen aus) lässt Ruhezeit aus', wa.ruhezeit === false && wa.pausen === false && wa.arbeitszeit === true, JSON.stringify(wa));
    w = await werkzeug(S.miaSchreiben, 'kollegen_profil_aendern', { infotext: 'Elektrikerin, Schwerpunkt PV', telefon: '0171 2345678', telefon_sichtbar: true });
    let alsKollege = (await req('GET', `/api/kollegen/${ids.mia}`, tok.tom)).body || {};
    ok('Kollegen-Profil: Tom sieht Infotext und Telefon', w.daten && alsKollege.info === 'Elektrikerin, Schwerpunkt PV' && alsKollege.telefon === '0171 2345678', JSON.stringify(alsKollege).slice(0, 200));
    await werkzeug(S.miaSchreiben, 'kollegen_profil_aendern', { telefon_sichtbar: false });
    alsKollege = (await req('GET', `/api/kollegen/${ids.mia}`, tok.tom)).body || {};
    ok('… Telefon unsichtbar geschaltet: Tom sieht es nicht mehr, der Infotext bleibt', !alsKollege.telefon && alsKollege.info === 'Elektrikerin, Schwerpunkt PV', JSON.stringify(alsKollege).slice(0, 200));
    w = await werkzeug(S.miaSchreiben, 'kollegen_profil_aendern', { telefon: 'ruf mich an' });
    ok('… ungültige Telefonnummer → Meldung der App', /Telefonnummer/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.miaSchreiben, 'kollegen_profil_aendern', { geburtstag_sichtbar: true });
    ok('Geburtstag sichtbar ohne hinterlegtes Datum → gespeichert, mit Hinweis', w.daten && w.daten.fuer_kollegen.geburtstag_sichtbar === true && /kein Geburtsdatum/.test(w.daten.hinweis || ''), JSON.stringify(w.daten));
    w = await werkzeug(S.miaSchreiben, 'zusammenfassung_planen', { name: 'Morgens', wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:30', kategorien: ['schwarzes_brett', 'meldungen'] });
    const zNr = w.daten && w.daten.zusammenfassung && w.daten.zusammenfassung.nr;
    let zs = (await req('GET', '/api/push/summaries', tok.mia)).body;
    ok('Zusammenfassung angelegt: Mo–Fr 06:30, Brett + Meldungen', zs.schedules.length === 1 && zs.schedules[0].time === '06:30' && zs.schedules[0].weekdays.length === 5
      && JSON.stringify(zs.schedules[0].cats.sort()) === '["bulletin","meldungen"]', JSON.stringify(zs));
    await werkzeug(S.miaSchreiben, 'zusammenfassung_planen', { nr: zNr, pausiert: true, uhrzeit: '07:00' });
    zs = (await req('GET', '/api/push/summaries', tok.mia)).body;
    ok('… geändert: 07:00 und pausiert', zs.schedules[0].time === '07:00' && zs.schedules[0].paused === true, JSON.stringify(zs.schedules));
    w = await werkzeug(S.miaSchreiben, 'zusammenfassung_planen', { wochentage: [1], uhrzeit: '06:00', kategorien: ['urlaub'] });
    ok('… unbekannte Kategorie → Eingabefehler', /erlaubt sind/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.miaSchreiben, 'zusammenfassung_planen', { name: 'unvollständig' });
    ok('… neu ohne Wochentage/Uhrzeit/Kategorien → Hinweis', /bitte wochentage, uhrzeit und kategorien/.test(w.fehler || ''), w.fehler);
    const tomZ = (await req('POST', '/api/push/summaries', tok.tom, { weekdays: [1], time: '06:00', cats: ['bulletin'] })).body.schedule.id;
    w = await werkzeug(S.miaSchreiben, 'zusammenfassung_planen', { nr: tomZ, pausiert: true });
    ok('… fremde Zusammenfassung (von Tom) → nicht gefunden', /nicht gefunden/.test(w.fehler || ''), w.fehler);
    w = await werkzeug(S.miaSchreiben, 'zusammenfassungen_pausieren', { pausiert: true });
    ok('alle Zusammenfassungen pausiert', w.daten && w.daten.alle_pausiert === true && (await req('GET', '/api/push/summaries', tok.mia)).body.pausedAll === true, JSON.stringify(w));
    for (const [m, p] of [['DELETE', `/api/push/summaries/${zNr}`], ['POST', '/api/push/subscribe'], ['POST', '/api/push/test'], ['GET', '/api/schluessel']]) {
      const x = await req(m, p, S.miaSchreiben, m === 'GET' || m === 'DELETE' ? undefined : {});
      ok(`${m} ${p.replace(/\d+/g, ':id')} mit Schreibschlüssel → 403`, x.status === 403 && x.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT', `${x.status}`);
    }

    console.log('── über REST weiterhin gesperrt ──');
    const bestNr = (await bestellungen())[0].id;
    const abwNr = (await abw())[0].id;
    const chefSchreib = await schl(tok.chef, 'Chef schreibt', 'schreiben');
    for (const [m, p, k] of [['DELETE', `/api/orders/${bestNr}`, S.miaSchreiben], ['PUT', `/api/orders/${bestNr}`, S.miaSchreiben],
      ['POST', `/api/orders/${bestNr}/order`, chefSchreib], ['PUT', `/api/absences/${abwNr}`, S.miaSchreiben], ['DELETE', `/api/absences/${abwNr}`, S.miaSchreiben],
      ['POST', `/api/absences/${abwNr}/approve`, chefSchreib], ['POST', '/api/tools', chefSchreib], ['POST', '/api/orders', S.chef]]) {
      const x = await req(m, p, k, m === 'DELETE' ? undefined : {});
      ok(`${m} ${p.replace(/\d+/g, ':id')}${k === S.chef ? ' (Lese-Schlüssel)' : ''} → 403`, x.status === 403 && x.body?.code === 'SCHLUESSEL_NICHT_ERLAUBT', `${x.status} ${JSON.stringify(x.body)}`);
    }

    console.log('── Kopfzeilen fälschen ──');
    // Frischer Schlüssel: „zuletzt benutzt" wird höchstens einmal je Minute geschrieben — die gefälschte Anfrage
    // muss die ERSTE sein, sonst könnte eine angenommene Fälschung gar nicht sichtbar werden.
    const faelschung = { 'X-Intern': 'b'.repeat(48), 'X-Intern-Ip': '203.0.113.99', 'X-Intern-Werkzeug': 'gefaelscht' };
    const fSchl = await schl(tok.tom, 'Fälscher', 'lesen');
    await req('GET', '/api/bulletin', fSchl, undefined, faelschung);
    const fz = ((await req('GET', '/api/schluessel', tok.tom)).body.schluessel || []).find(s => s.name === 'Fälscher');
    ok('gefälschtes X-Intern: gespeichert wird die echte Adresse, nicht die behauptete', fz && fz.zuletzt_ip && fz.zuletzt_ip !== '203.0.113.99', JSON.stringify(fz));
    const fst = [];
    for (let i = 0; i < 62; i++) fst.push((await req('GET', '/api/bulletin', fSchl, undefined, faelschung)).status);
    ok('… und es umgeht die Bremse nicht (nach 60: 429)', fst.includes(429), fst.slice(55).join(','));

    console.log('── Bremse ──');
    // Neues Minutenfenster: Der Test hat bis hier über 120 /mcp-Aufrufe von 127.0.0.1 gemacht — sonst griffe die
    // Grenze je ADRESSE vor der je Schlüssel, die hier gemessen werden soll.
    await sleep(61000);
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
