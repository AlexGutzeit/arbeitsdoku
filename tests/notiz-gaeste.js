// Gäste in Notizen — Server (Etappe C, 27.09.2026).
//
// Anna (Eigentümerin) lädt zwei Gäste ein: „Herr Maier" (Schreiben) und „Frau Lang" (Lesen, mit
// Ablaufdatum). Tom hat Schreibrecht als Mitarbeiter, Rita nichts. Geprüft wird, was Alex entschieden hat:
//   * Nur der Eigentümer verwaltet Gäste; Name Pflicht und eindeutig, Passwort ≥ 8, kein Hash nach außen.
//   * Anmelden mit Link-Kennung + Passwort; Gast-Token öffnet KEINEN Mitarbeiter-Weg (und umgekehrt).
//   * Live: Gäste schreiben (Schreiben) bzw. lesen nur; sie heißen überall „… (Gast)"; sie sehen von
//     Mitarbeitern nur den VORNAMEN und vom Kopf nur den Titel. Ihre Änderung zählt bei Mitarbeitern als neu.
//   * Schreiben → Lesen sofort; neues Passwort wirft nur DIESEN Gast raus; Entfernen wirft raus.
//   * Firmenschalter aus → alle raus, kein Anmelden, kein Anlegen; wieder an → gilt wieder.
//   * 5 falsche Passwörter → gesperrt (auch mit richtigem Passwort), neues Passwort hebt die Sperre auf.
//   * Drucken/Herunterladen für Gäste; Kopie einer Notiz startet ohne Gäste; Notiz gelöscht → Gäste weg.
//   * Direkt an der Datenbank (Server beendet): Ablaufdatum vorbei, Eigentümer ausgestellt.
//
//   node tests/notiz-gaeste.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const Y = require('yjs');
const { geraetOeffnen, b64 } = require('./hilfen/notiz-live-geraet');

const PORT = 3342, DB = '/tmp/notiz-gaeste.db', LOG = '/tmp/notiz-gaeste.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const st = []; x.on('data', c => st.push(c)); x.on('end', () => { const buf = Buffer.concat(st); let j = null; if (!roh) { try { j = JSON.parse(buf.toString()); } catch (_) {} } res({ status: x.statusCode, body: j, buf }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Einmal kurz an einen Ereignisstrom klopfen: Status, ohne offen zu bleiben
const strom = (pfad) => new Promise((ok) => {
  const r = http.get({ agent: false, host: 'localhost', port: PORT, path: pfad }, (res) => { ok(res.statusCode); res.destroy(); });
  r.on('error', () => ok(0));
});
// Namen der ANDEREN, wie sie beim Gerät angekommen sind (der eigene Eintrag ist lokal gesetzt)
const namenIn = (g) => [...g.aw.getStates()].filter(([cid]) => cid !== g.doc.clientID).map(([, s]) => s && s.user && s.user.name).filter(Boolean).sort();

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: ['ignore', lg, lg] });
  const offen = [];
  let tokenMaier, tokenLang, gMaier, gLang;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const id = {}, t = {};
    for (const [u, n] of [['anna', 'Anna Berger'], ['tom', 'Tom Kraus'], ['rita', 'Rita Lehmann']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter', hours_mon: 8 })).body.user.id;
      t[u] = await tok(u, 'Test1234!');
    }
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Halle 2' })).body;
    const projektId = projekt && (projekt.project ? projekt.project.id : projekt.id);
    const note = (await req('POST', '/api/notes', t.anna, { title: 'Übergabe Halle 2', project_id: projektId })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, t.anna, { shares: [{ user_id: id.tom, permission: 'write' }] });
    const ticket = async (u) => (await req('GET', '/api/events/ticket', t[u])).body.ticket;
    const gastTicket = async (tk) => (await req('GET', '/api/gast/ticket', tk)).body.ticket;
    const G = (pfad) => `/api/notes/${note.id}/gaeste${pfad || ''}`;
    const morgen = new Date(Date.now() + 36 * 3600 * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);

    console.log('\nVerwalten — nur der Eigentümer');
    const fremd = [await req('GET', G(), t.tom), await req('POST', G(), t.tom, { name: 'X', passwort: 'Geheim123', permission: 'read' }), await req('GET', G(), t.rita)];
    ok('Tom (Schreibrecht) und Rita: keine Gäste sehen oder anlegen (403)', fremd.every(r => r.status === 403), fremd.map(r => r.status).join('/'));
    const falsch = [await req('POST', G(), t.anna, { name: ' ', passwort: 'Geheim123' }), await req('POST', G(), t.anna, { name: 'Kurz', passwort: 'kurz' }),
      await req('POST', G(), t.anna, { name: 'Alt', passwort: 'Geheim123', ablauf: '2020-01-01' }), await req('POST', G(), t.anna, { name: 'Recht', passwort: 'Geheim123', permission: 'admin' })];
    ok('Name leer / Passwort zu kurz / Ablauf vorbei / unbekanntes Recht → 400 mit Erklärung', falsch.every(r => r.status === 400 && r.body.error), falsch.map(r => r.status + ' ' + (r.body || {}).error).join(' | '));
    const maier = await req('POST', G(), t.anna, { name: 'Herr Maier', passwort: 'Geheim123', permission: 'write' });
    ok('„Herr Maier" (Schreiben) angelegt: Link-Kennung da, KEIN Passwort-Hash in der Antwort',
      maier.status === 201 && /^[A-Za-z0-9_-]{30,}$/.test(maier.body.gast.token) && !JSON.stringify(maier.body).includes('$2') && !('pw_hash' in maier.body.gast), JSON.stringify(maier.body));
    const doppelt = await req('POST', G(), t.anna, { name: 'herr maier', passwort: 'Geheim123' });
    ok('derselbe Name noch einmal (andere Schreibweise) → 400', doppelt.status === 400, JSON.stringify(doppelt.body));
    const lang = await req('POST', G(), t.anna, { name: 'Frau Lang', passwort: 'Lesen1234', permission: 'read', ablauf: morgen });
    ok('„Frau Lang" (Lesen, bis morgen) angelegt', lang.status === 201 && lang.body.gast.ablauf === morgen && lang.body.gast.permission === 'read');
    const liste = await req('GET', G(), t.anna);
    ok('Liste: zwei Gäste, Schalter an', liste.body.erlaubt === true && liste.body.gaeste.map(g => g.name).join(',') === 'Frau Lang,Herr Maier');
    const annaNotiz = ((await req('GET', '/api/notes', t.anna)).body.notes || []).find(n => n.id === note.id);
    const tomNotiz = ((await req('GET', '/api/notes', t.tom)).body.notes || []).find(n => n.id === note.id);
    ok('Notizliste: Anna sieht „2 Gäste", Tom sieht die Zahl nicht', annaNotiz.gaeste === 2 && !('gaeste' in tomNotiz), `${annaNotiz.gaeste} / ${tomNotiz.gaeste}`);

    console.log('\nAnmelden');
    const unbekannt = await req('POST', '/api/gast/anmelden', null, { token: 'gibt-es-nicht', passwort: 'Geheim123' });
    const falschPw = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'Falsch123' });
    ok('fremde Kennung → 404, falsches Passwort → 401 (jeweils mit Erklärung)', unbekannt.status === 404 && falschPw.status === 401 && /stimmt nicht/.test(falschPw.body.error), `${unbekannt.status} ${falschPw.status}`);
    const anm = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'Geheim123' });
    tokenMaier = anm.body && anm.body.token;
    ok('richtig → Anmeldung mit Name, Recht und Titel', anm.status === 200 && tokenMaier && anm.body.name === 'Herr Maier' && anm.body.zugriff === 'write' && anm.body.titel === 'Übergabe Halle 2', JSON.stringify(anm.body).slice(0, 120));
    tokenLang = (await req('POST', '/api/gast/anmelden', null, { token: lang.body.gast.token, passwort: 'Lesen1234' })).body.token;
    const info = await req('GET', '/api/gast/notiz', tokenMaier);
    ok('GET /api/gast/notiz: Titel, Name, Recht — kein Projekt, keine Notiznummer', info.status === 200 && info.body.titel === 'Übergabe Halle 2' && !('project_text' in info.body) && !('id' in info.body), JSON.stringify(info.body));

    console.log('\nGast-Token öffnet keinen Mitarbeiter-Weg — und umgekehrt');
    const gt = await gastTicket(tokenMaier);
    const zu = {
      notizen: (await req('GET', '/api/notes', tokenMaier)).status,
      ticket: (await req('GET', '/api/events/ticket', tokenMaier)).status,
      events: await strom(`/api/events?token=${encodeURIComponent(tokenMaier)}`),
      eventsTicket: await strom(`/api/events?ticket=${encodeURIComponent(gt)}`),
      notizStrom: await strom(`/api/notes/${note.id}/live?ticket=${encodeURIComponent(gt)}`),
      badges: (await req('GET', '/api/badges', tokenMaier)).status,
      export: (await req('GET', `/api/notes/${note.id}/export/pdf`, tokenMaier)).status,
    };
    ok('Gast-Token: Notizen, Ticket, App-Ereignisstrom, Notiz-Ereignisstrom, Zähler, Mitarbeiter-Export → alle 401', Object.values(zu).every(s => s === 401), JSON.stringify(zu));
    const annaTicket = await ticket('anna');
    const umgekehrt = {
      notiz: (await req('GET', '/api/gast/notiz', t.anna)).status,
      ticket: (await req('GET', '/api/gast/ticket', t.anna)).status,
      strom: await strom(`/api/gast/live?ticket=${encodeURIComponent(annaTicket)}`),
      export: (await req('GET', '/api/gast/export/pdf', t.anna)).status,
    };
    ok('Mitarbeiter-Token und -Ticket auf den Gast-Wegen → alle 401', Object.values(umgekehrt).every(s => s === 401), JSON.stringify(umgekehrt));

    console.log('\nLive: Gäste in der Notiz');
    const gAnna = await geraetOeffnen({ port: PORT, ticket: await ticket('anna'), noteId: note.id, token: t.anna }); offen.push(gAnna);
    gMaier = await geraetOeffnen({ port: PORT, ticket: await gastTicket(tokenMaier), token: tokenMaier, basis: '/api/gast' }); offen.push(gMaier);
    const startMaier = gMaier.ereignisse.find(e => e.typ === 'start').daten;
    ok('Maier ist drin: Schreiben, heißt „Herr Maier (Gast)", Kopf nur mit Titel (kein Projekt)',
      gMaier.status === 200 && gMaier.zugriff === 'write' && gMaier.du.name === 'Herr Maier (Gast)'
        && JSON.stringify(startMaier.kopf) === JSON.stringify({ title: 'Übergabe Halle 2' }), JSON.stringify([gMaier.status, gMaier.du, startMaier.kopf]));
    await gAnna.cursor(0);
    await gMaier.warte('anwesenheit', () => namenIn(gMaier).includes('Anna'));
    ok('Maier sieht Anna nur mit Vornamen („Anna", nicht „Anna Berger")', namenIn(gMaier).includes('Anna') && !namenIn(gMaier).some(n => /Berger/.test(n)), JSON.stringify(namenIn(gMaier)));
    await gMaier.cursor(0);
    await gAnna.warte('anwesenheit', () => namenIn(gAnna).some(n => /Maier/.test(n)));
    ok('Anna sieht den Gast als „Herr Maier (Gast)" — den Namen setzt der Server, nicht der Gast', namenIn(gAnna).includes('Herr Maier (Gast)') && !namenIn(gAnna).includes('selbst erfunden'), JSON.stringify(namenIn(gAnna)));
    const gTom = await geraetOeffnen({ port: PORT, ticket: await ticket('tom'), noteId: note.id, token: t.tom }); offen.push(gTom);
    ok('Tom (Mitarbeiter) sieht Anna mit vollem Namen und den Gast mit Zusatz', namenIn(gTom).includes('Anna Berger') && namenIn(gTom).includes('Herr Maier (Gast)'), JSON.stringify(namenIn(gTom)));
    await gTom.cursor(0);
    await gMaier.warte('anwesenheit', () => namenIn(gMaier).includes('Tom'));
    ok('… und Maier sieht Tom nur als „Tom"', namenIn(gMaier).includes('Tom') && !namenIn(gMaier).some(n => /Kraus/.test(n)), JSON.stringify(namenIn(gMaier)));
    const drinListe = ((await req('GET', '/api/notes', t.anna)).body.notes || []).find(n => n.id === note.id).live;
    ok('In der Notizliste steht der Gast bei „gerade drin"', drinListe.includes('Herr Maier (Gast)'), JSON.stringify(drinListe));
    gTom.schliessen(); await sleep(300);
    await req('POST', '/api/badges/notes', t.tom); await sleep(30);
    const tomVorher = (await req('GET', '/api/badges', t.tom)).body.notes;
    const w = await gMaier.schreibe(txt => txt.insert(0, 'Vom Gast: '));
    await gAnna.warte('aenderung');
    ok('Maier schreibt → Anna sieht es live', w.status === 200 && gAnna.text().startsWith('Vom Gast: '), JSON.stringify([w.status, gAnna.text()]));
    await sleep(2200);
    const nachher = ((await req('GET', '/api/notes', t.tom)).body.notes || []).find(n => n.id === note.id);
    const tomNachher = (await req('GET', '/api/badges', t.tom)).body.notes;
    ok('gespeichert mit „Bearbeitet von Herr Maier (Gast)"; für Tom (nicht drin) neu: Zähler +1, hervorgehoben',
      nachher.updated_by_name === 'Herr Maier (Gast)' && nachher.updated_by == null && nachher.is_unread === true && tomNachher === tomVorher + 1,
      JSON.stringify([nachher.updated_by_name, nachher.updated_by, nachher.is_unread, tomVorher, tomNachher]));
    gLang = await geraetOeffnen({ port: PORT, ticket: await gastTicket(tokenLang), token: tokenLang, basis: '/api/gast' }); offen.push(gLang);
    const lw = await gLang.schreibe(txt => txt.insert(0, 'Darf ich?'));
    ok('Frau Lang (Lesen) ist drin, darf aber nicht schreiben (403 NUR_LESEN)', gLang.zugriff === 'read' && lw.status === 403 && lw.body.code === 'NUR_LESEN', JSON.stringify([gLang.zugriff, lw.status, lw.body]));
    const titelNeu = await req('PUT', `/api/notes/${note.id}`, t.anna, { title: 'Übergabe Halle 2 (neu)', project_id: projektId });
    const kopfLang = await gLang.warte('kopf');
    ok('Anna benennt um → der Gast bekommt nur den Titel', titelNeu.status === 200 && kopfLang && JSON.stringify(kopfLang) === JSON.stringify({ title: 'Übergabe Halle 2 (neu)' }), JSON.stringify(kopfLang));
    const pdf = await req('GET', '/api/gast/export/pdf', tokenMaier, null, true);
    ok('Gast lädt die Notiz als PDF herunter', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF', String(pdf.status));

    console.log('\nRechte ändern, neues Passwort, entfernen');
    const lesen = await req('PUT', G('/' + maier.body.gast.id), t.anna, { permission: 'read' });
    const zugriffEvt = await gMaier.warte('zugriff');
    const nachLesen = await gMaier.schreibe(txt => txt.insert(0, 'X'));
    ok('Schreiben → Lesen: gilt sofort, ohne Rauswurf; Schreiben dann 403', lesen.status === 200 && zugriffEvt && zugriffEvt.zugriff === 'read' && gMaier.offen && nachLesen.status === 403, JSON.stringify([lesen.status, zugriffEvt, nachLesen.status]));
    await req('PUT', G('/' + maier.body.gast.id), t.anna, { permission: 'write' });
    await gMaier.warte('zugriff', d => d.zugriff === 'write');
    const pw = await req('PUT', G('/' + maier.body.gast.id + '/passwort'), t.anna, { passwort: 'NeuesGeheim1' });
    const raus = await gMaier.warte('raus');
    await sleep(200);
    ok('neues Passwort → Maier fliegt raus („passwort-geaendert") — Frau Lang bleibt drin',
      pw.status === 200 && raus && raus.grund === 'passwort-geaendert' && gLang.offen, JSON.stringify([pw.status, raus, gLang.offen]));
    const alt = await req('GET', '/api/gast/notiz', tokenMaier);
    const altPw = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'Geheim123' });
    const neuPw = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'NeuesGeheim1' });
    ok('alte Anmeldung ungültig (401 GAST_PASSWORT_GEAENDERT), altes Passwort falsch, neues geht',
      alt.status === 401 && alt.body.code === 'GAST_PASSWORT_GEAENDERT' && altPw.status === 401 && neuPw.status === 200, `${alt.status} ${alt.body.code} ${altPw.status} ${neuPw.status}`);
    tokenMaier = neuPw.body.token;
    const weg = await req('DELETE', G('/' + lang.body.gast.id), t.anna);
    const rausLang = await gLang.warte('raus');
    const langDanach = await req('GET', '/api/gast/notiz', tokenLang);
    const langAnm = await req('POST', '/api/gast/anmelden', null, { token: lang.body.gast.token, passwort: 'Lesen1234' });
    ok('Frau Lang entfernt → raus („gast-entfernt"), Anmeldung und Link ungültig',
      weg.status === 200 && rausLang && rausLang.grund === 'gast-entfernt' && langDanach.status === 401 && langAnm.status === 404, JSON.stringify([weg.status, rausLang, langDanach.status, langAnm.status]));

    console.log('\nFirmenschalter');
    gMaier = await geraetOeffnen({ port: PORT, ticket: await gastTicket(tokenMaier), token: tokenMaier, basis: '/api/gast' }); offen.push(gMaier);
    const aus = await req('PUT', '/api/settings', admin, { notiz_gaeste: 'aus' });
    const rausAus = await gMaier.warte('raus');
    const anlegenAus = await req('POST', G(), t.anna, { name: 'Neu', passwort: 'Geheim123' });
    const anmAus = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'NeuesGeheim1' });
    const tokenAus = await req('GET', '/api/gast/notiz', tokenMaier);
    ok('aus → Gast sofort raus („gaeste-aus"), kein Anlegen, kein Anmelden, Anmeldung ungültig',
      aus.status === 200 && rausAus && rausAus.grund === 'gaeste-aus' && anlegenAus.status === 403 && anmAus.status === 403 && tokenAus.status === 403,
      JSON.stringify([aus.status, rausAus, anlegenAus.status, anmAus.status, tokenAus.status]));
    ok('… die Zugänge selbst bleiben gespeichert', (await req('GET', G(), t.anna)).body.gaeste.length === 1);
    await req('PUT', '/api/settings', admin, { notiz_gaeste: 'an' });
    ok('wieder an → dieselbe Anmeldung gilt wieder', (await req('GET', '/api/gast/notiz', tokenMaier)).status === 200);
    const schalterFalsch = await req('PUT', '/api/settings', admin, { notiz_gaeste: 'vielleicht' });
    ok('Schalter nimmt nur „an"/„aus"', schalterFalsch.status === 400);

    console.log('\nFehlversuch-Bremse');
    const versuche = [];
    for (let i = 0; i < 5; i++) versuche.push((await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'Falsch' + i })).status);
    const trotzRichtig = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'NeuesGeheim1' });
    ok('5 falsche Passwörter → gesperrt; dann auch mit dem richtigen 429', versuche.join(',') === '401,401,401,401,429' && trotzRichtig.status === 429 && /gesperrt/.test(trotzRichtig.body.error),
      versuche.join(',') + ' / ' + trotzRichtig.status);
    const listeGesperrt = (await req('GET', G(), t.anna)).body.gaeste[0];
    ok('Anna sieht in der Liste „gesperrt"', listeGesperrt.gesperrt === true);
    const protokoll = (await req('GET', '/api/audit?limit=50', admin)).body;
    const zeilen = JSON.stringify(protokoll);
    ok('Protokoll: Anlegen, Fehlversuche und Sperre stehen drin', /notiz_gast_angelegt/.test(zeilen) && /notiz_gast_login_failed/.test(zeilen) && /notiz_gast_gesperrt/.test(zeilen), zeilen.slice(0, 200));
    await req('PUT', G('/' + maier.body.gast.id + '/passwort'), t.anna, { passwort: 'DrittesGeheim1' });
    const nachSperre = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'DrittesGeheim1' });
    ok('neues Passwort hebt die Sperre auf', nachSperre.status === 200, String(nachSperre.status));
    tokenMaier = nachSperre.body.token;

    console.log('\nKopie und Löschen');
    const kopie = await req('POST', `/api/notes/${note.id}/kopie`, t.tom);
    const kopieGaeste = await req('GET', `/api/notes/${kopie.body.note.id}/gaeste`, t.tom);
    ok('Tom kopiert die Notiz → seine Kopie hat keine Gäste', kopie.status === 201 && kopieGaeste.status === 200 && kopieGaeste.body.gaeste.length === 0, JSON.stringify(kopieGaeste.body));
    const gGeloescht = await geraetOeffnen({ port: PORT, ticket: await gastTicket(tokenMaier), token: tokenMaier, basis: '/api/gast' }); offen.push(gGeloescht);
    const del = await req('DELETE', `/api/notes/${note.id}`, t.anna);
    const rausDel = await gGeloescht.warte('raus');
    const nachDel = await req('GET', '/api/gast/notiz', tokenMaier);
    const anmDel = await req('POST', '/api/gast/anmelden', null, { token: maier.body.gast.token, passwort: 'DrittesGeheim1' });
    ok('Notiz gelöscht → Gast raus („geloescht"), Anmeldung und Link ungültig', del.status === 200 && rausDel && rausDel.grund === 'geloescht' && nachDel.status === 401 && anmDel.status === 404,
      JSON.stringify([del.status, rausDel, nachDel.status, anmDel.status]));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const g of offen) g.schliessen();
    srv.kill();
    await new Promise(r => { if (srv.exitCode !== null) r(); else srv.once('exit', r); });
  }

  // ── Teil 2: direkt an der Datenbank (der Server ist beendet — kein zweiter Prozess) ──────────
  try {
    console.log('\nAm Datenbank-Stand: Ablauf und ausgestellter Eigentümer');
    process.env.DB_PATH = DB;
    const { initDatabase, getDb } = require('../database/init');
    await initDatabase();
    const db = getDb();
    const gaeste = require('../notiz-gaeste');
    const anna = db.prepare("SELECT id FROM users WHERE username = 'anna'").get();
    const n2 = db.prepare("INSERT INTO notes (user_id, title, body, created_at, updated_at) VALUES (?, 'Zweite', '', datetime('now'), datetime('now'))").run(anna.id).lastInsertRowid;
    const r = await gaeste.anlegen(db, n2, { name: 'Herr Ablauf', passwort: 'Geheim123', permission: 'write' }, anna.id);
    const anm = await gaeste.anmelden(db, r.gast.token, 'Geheim123');
    ok('frisch: anmelden und prüfen gehen', anm.status === 200 && !!gaeste.pruefen(db, anm.token).gast);
    db.prepare("UPDATE note_gaeste SET ablauf = '2020-01-01' WHERE id = ?").run(r.gast.id);
    const p1 = gaeste.pruefen(db, anm.token), a1 = await gaeste.anmelden(db, r.gast.token, 'Geheim123');
    ok('Ablaufdatum vorbei → Anmeldung ungültig (GAST_ABGELAUFEN), neu anmelden 403', p1.code === 'GAST_ABGELAUFEN' && a1.status === 403, JSON.stringify([p1.code, a1.status]));
    db.prepare('UPDATE note_gaeste SET ablauf = NULL WHERE id = ?').run(r.gast.id);
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(anna.id);
    const p2 = gaeste.pruefen(db, anm.token), a2 = await gaeste.anmelden(db, r.gast.token, 'Geheim123');
    ok('Eigentümerin ausgestellt → ihre Gastzugänge gelten nicht mehr', !p2.gast && a2.status === 403, JSON.stringify([p2.code, a2.status]));
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(anna.id);
    ok('… wieder eingestellt → gelten wieder', !!gaeste.pruefen(db, anm.token).gast);
    const spalten = db.prepare('PRAGMA table_info(note_gaeste)').all().map(c => c.name);
    ok('Schema: note_gaeste mit Hash, Passwort-Stand, Ablauf, Sperre', ['pw_hash', 'pw_stand', 'ablauf', 'gesperrt_bis', 'token'].every(c => spalten.includes(c)), spalten.join(','));
  } catch (e) {
    fail++; fails.push('Absturz Teil 2: ' + e.message); console.log('  ✗ Absturz Teil 2: ' + e.stack);
  }
  console.log(`\nNotiz-Gäste (Server): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
