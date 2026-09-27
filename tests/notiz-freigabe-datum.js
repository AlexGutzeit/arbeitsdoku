// Neue Freigabe leuchtet nur beim NEUEN Empfänger auf — nicht bei allen bisherigen (27.09.2026).
//
// Zähler („Coin") und Hervorhebung in der Liste werten das Freigabe-Datum aus. Beim Speichern der
// Freigaben wurde es für ALLE neu gesetzt: Kam Rita dazu, war die Notiz auch bei Tom wieder „neu".
// Geprüft wird, was Tom und Rita sehen:
//   * Neue Freigabe → Zähler +1 und hervorgehoben (wie immer).
//   * Jemand anderes kommt dazu → bei Tom bleibt es still, sein Freigabe-Datum ist unverändert.
//   * Lesen → Schreiben: das Recht gilt, aber es leuchtet nichts auf (Alex: wie beim Push).
//   * Entfernen und wieder hinzufügen → wieder neu.
// Die Push-Meldung (nur an neu Hinzugekommene) prüft tests/push-targeting.js.
//
//   node tests/notiz-freigabe-datum.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3341, DB = '/tmp/notiz-freigabe-datum.db', LOG = '/tmp/notiz-freigabe-datum.log';
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const id = {}, t = {};
    for (const u of ['anna', 'tom', 'rita']) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: u, role: 'mitarbeiter', hours_mon: 8 })).body.user.id;
      t[u] = await tok(u, 'Test1234!');
    }
    const note = (await req('POST', '/api/notes', t.anna, { title: 'Übergabe' })).body.note;
    const zaehler = async (u) => (await req('GET', '/api/badges', t[u])).body.notes;
    const inListe = async (u) => ((await req('GET', '/api/notes', t[u])).body.notes || []).find(x => x.id === note.id) || null;
    const bild = async (u) => { const n = await inListe(u); return { zaehler: await zaehler(u), markiert: n ? !!n.is_unread : null, recht: n ? n.permission || (n.shares || []).find(s => s.user_id === id[u])?.permission : null }; };
    // Das Datum steht in der eigenen Liste des Empfängers (GET …/shares liefert es nicht). Ohne Datum
    // ist die Prüfung rot — die erste Fassung verglich undefined mit undefined und war grün.
    const datum = async (u) => { const n = await inListe(u); const d = n && (n.shares || []).find(s => s.user_id === id[u]); return (d && d.created_at) || null; };
    const gesehen = async (u) => { await req('POST', '/api/badges/notes', t[u]); await sleep(20); };
    const teilen = (liste) => req('PUT', `/api/notes/${note.id}/shares`, t.anna, { shares: liste });
    for (const u of ['tom', 'rita']) await gesehen(u);

    console.log('\nNeue Freigabe');
    await teilen([{ user_id: id.tom, permission: 'read' }]);
    const tom1 = await bild('tom');
    ok('Tom: Zähler 1, Notiz hervorgehoben', tom1.zaehler === 1 && tom1.markiert === true, JSON.stringify(tom1));
    await gesehen('tom');
    const tom2 = await bild('tom');
    ok('… nach dem Anschauen: Zähler 0, nicht mehr hervorgehoben', tom2.zaehler === 0 && tom2.markiert === false, JSON.stringify(tom2));
    const tomDatum = await datum('tom');

    console.log('\nJemand anderes kommt dazu');
    await sleep(30);
    await teilen([{ user_id: id.tom, permission: 'read' }, { user_id: id.rita, permission: 'read' }]);
    const rita1 = await bild('rita'), tom3 = await bild('tom');
    ok('Rita (neu): Zähler 1, hervorgehoben', rita1.zaehler === 1 && rita1.markiert === true, JSON.stringify(rita1));
    ok('Tom (schon dabei): bleibt still — Zähler 0, nicht hervorgehoben', tom3.zaehler === 0 && tom3.markiert === false, JSON.stringify(tom3));
    ok('… Toms Freigabe-Datum ist unverändert', !!tomDatum && (await datum('tom')) === tomDatum, `${tomDatum} → ${await datum('tom')}`);
    await gesehen('rita');

    console.log('\nLesen → Schreiben');
    await sleep(30);
    await teilen([{ user_id: id.tom, permission: 'write' }, { user_id: id.rita, permission: 'read' }]);
    const tom4 = await bild('tom'), rita2 = await bild('rita');
    const freigaben = (await req('GET', `/api/notes/${note.id}/shares`, t.anna)).body.shares;
    ok('Toms Recht ist jetzt Schreiben', freigaben.find(s => s.user_id === id.tom).permission === 'write', JSON.stringify(freigaben));
    ok('… aber es leuchtet nichts auf, weder bei Tom noch bei Rita', tom4.zaehler === 0 && !tom4.markiert && rita2.zaehler === 0 && !rita2.markiert, JSON.stringify([tom4, rita2]));
    ok('… und Toms Freigabe-Datum ist weiter das erste', !!tomDatum && (await datum('tom')) === tomDatum);

    console.log('\nEntfernen und wieder hinzufügen');
    await teilen([{ user_id: id.rita, permission: 'read' }]);
    ok('Tom entfernt: die Notiz ist aus seiner Liste', (await inListe('tom')) === null);
    await sleep(30);
    await teilen([{ user_id: id.rita, permission: 'read' }, { user_id: id.tom, permission: 'read' }]);
    const tom5 = await bild('tom');
    ok('wieder hinzugefügt: für Tom wieder neu (Zähler 1, hervorgehoben), neues Datum',
      tom5.zaehler === 1 && tom5.markiert === true && !!tomDatum && (await datum('tom')) > tomDatum, JSON.stringify(tom5));
    const rita3 = await bild('rita');
    ok('… Rita bleibt still', rita3.zaehler === 0 && !rita3.markiert, JSON.stringify(rita3));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    srv.kill();
  }
  console.log(`\nFreigabe-Datum: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
