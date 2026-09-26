// Live-Notizen und das Zurückspielen einer Sicherung: Der offene Stand im Speicher darf die zurückgespielte Notiz nicht überschreiben.
//
// Ist beim Zurückspielen jemand in einer Notiz, hält der Server deren Dokument aus der ALTEN
// Datenbank im Speicher — samt Tastendrücken, die noch nicht gespeichert sind (1,5 s Ruhe). Ohne
// Gegenmaßnahme schriebe der nächste Speichervorgang diesen Stand in die gerade zurückgespielte
// Datenbank. routes/backup.js ruft deshalb vor dem Einsetzen `allesVerwerfen()` auf.
//
// Nachgestellt wird genau diese Reihenfolge (in-process, wie tests/push-targeting.js); dazu prüft der
// Test am Quelltext, dass `einsetzen()` sie auch so aufruft.
//
//   node tests/notizen-live-zurueckspielen.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/notizen-live-zurueckspielen.db';
const fs = require('fs'); const path = require('path'); const http = require('http');
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { initDatabase, getDb, setDb, datenbankVorbereiten } = require('../database/init');
const { geraetOeffnen } = require('./hilfen/notiz-live-geraet');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(port, m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  let server;
  try {
    console.log('\nQuelltext: einsetzen() verwirft die Live-Notizen VOR dem Tausch');
    const quelle = fs.readFileSync(path.join(__dirname, '../routes/backup.js'), 'utf8');
    const einsetzen = quelle.slice(quelle.indexOf('function einsetzen('));
    const iVerwerfen = einsetzen.indexOf("require('../notizen-live').allesVerwerfen(");
    const iTausch = einsetzen.indexOf('setDb(neueDb)');
    ok('allesVerwerfen() steht in einsetzen() vor setDb(neueDb)', iVerwerfen > 0 && iTausch > 0 && iVerwerfen < iTausch, `${iVerwerfen} / ${iTausch}`);

    await initDatabase();
    const db = getDb();
    db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync('pw123456', 10));
    const max = db.prepare("SELECT id FROM users WHERE username = 'max'").get();
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/notes', require('../routes/notes'));
    server = app.listen(0); await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    const token = (await req(port, 'POST', '/api/auth/login', null, { username: 'max', password: 'pw123456' })).body.token;
    const note = (await req(port, 'POST', '/api/notes', token, { title: 'Lager', body: 'Stand der Sicherung' })).body.note;

    // „Sicherung" = dieser Stand der Datenbank
    const sicherung = Buffer.from(getDb()._db.export());

    console.log('\nJemand tippt, dann wird zurückgespielt');
    const ticket = jwt.sign({ userId: max.id, sse: true }, process.env.JWT_SECRET, { expiresIn: '60s' });
    const g = await geraetOeffnen({ port, ticket, noteId: note.id, token });
    const r = await g.schreibe(t => t.insert(t.length - 1, ' – danach getippt'));
    ok('die Änderung ist beim Server angekommen (noch nicht gespeichert)', r.status === 200 && /danach getippt/.test(g.text()), String(r.status));

    // Genau die Reihenfolge aus routes/backup.js, einsetzen():
    require('../notizen-live').allesVerwerfen('zurueckgespielt');
    setDb(datenbankVorbereiten(sicherung));

    const raus = await g.warte('raus');
    ok('wer drin war, fliegt raus — mit dem Grund „zurückgespielt"', raus && raus.grund === 'zurueckgespielt' && !g.offen, JSON.stringify(raus));
    await sleep(2500);   // länger als die Ruhepause vor dem Speichern
    const danach = getDb().prepare('SELECT body FROM notes WHERE id = ?').get(note.id);
    ok('die zurückgespielte Notiz bleibt, wie sie in der Sicherung stand', danach && danach.body === 'Stand der Sicherung', JSON.stringify(danach));

    console.log('\nDanach geht es normal weiter');
    const ticket2 = jwt.sign({ userId: max.id, sse: true }, process.env.JWT_SECRET, { expiresIn: '60s' });
    const g2 = await geraetOeffnen({ port, ticket: ticket2, noteId: note.id, token });
    ok('neu öffnen zeigt den zurückgespielten Stand', g2.status === 200 && g2.text() === 'Stand der Sicherung\n', JSON.stringify(g2.doc && g2.text()));
    await g2.schreibe(t => t.insert(0, 'Neu: '));
    await sleep(2000);
    ok('… und neue Änderungen werden wieder gespeichert', getDb().prepare('SELECT body FROM notes WHERE id = ?').get(note.id).body === 'Neu: Stand der Sicherung');
    g2.schliessen();

    console.log('\nHandy war offline, dann wird zurückgespielt, dann meldet es sich zurück');
    // So sichert der Browser im Funkloch (notiz-sitzung.js): nur die WARTESCHLANGE, nicht den ganzen
    // Stand. Hier nachgestellt mit Yjs direkt — dieselben Bytes, die der Browser schickte.
    const Y = require('yjs');
    const ausB = (u) => Buffer.from(u).toString('base64');
    await sleep(100);
    const sicherung2 = Buffer.from(getDb()._db.export());                    // Stand „Neu: Stand der Sicherung"
    const t3 = jwt.sign({ userId: max.id, sse: true }, process.env.JWT_SECRET, { expiresIn: '60s' });
    const online = await geraetOeffnen({ port, ticket: t3, noteId: note.id, token });
    await online.schreibe(t => t.insert(t.length - 1, ' – nach der Sicherung'));   // landet auf dem Server
    const handy = new Y.Doc(); Y.applyUpdate(handy, Y.encodeStateAsUpdate(online.doc));   // das Handy kannte diesen Stand …
    const svHandy = Y.encodeStateVector(handy);
    handy.getText('notiz').insert(handy.getText('notiz').length - 1, ' – offline getippt');  // … und tippte offline weiter
    const nurWarteschlange = Y.encodeStateAsUpdate(handy, svHandy);
    const ganzerStand = Y.encodeStateAsUpdate(handy);
    online.schliessen(); await sleep(2000);
    require('../notizen-live').allesVerwerfen('zurueckgespielt');
    setDb(datenbankVorbereiten(sicherung2));
    const zurueck = () => getDb().prepare('SELECT body FROM notes WHERE id = ?').get(note.id).body;
    ok('zurückgespielt: „Neu: Stand der Sicherung"', zurueck() === 'Neu: Stand der Sicherung', zurueck());
    // Das Handy öffnet neu: frisches Dokument + Gesichertes, dann Stand des Servers, dann Nachreichen
    const nachreichen = async (gesichert) => {
      const t = jwt.sign({ userId: max.id, sse: true }, process.env.JWT_SECRET, { expiresIn: '60s' });
      const g = await geraetOeffnen({ port, ticket: t, noteId: note.id, token });
      const d = new Y.Doc(); Y.applyUpdate(d, gesichert, 'gesichert');
      Y.applyUpdate(d, Y.encodeStateAsUpdate(g.doc), 'server');
      const fehlt = Y.encodeStateAsUpdate(d, Y.encodeStateVector(g.doc));
      const r = fehlt.length > 2 ? await g.rohSenden(ausB(fehlt)) : { status: 200 };
      g.schliessen(); await sleep(2000);
      return r.status;
    };
    const st = await nachreichen(nurWarteschlange);
    ok('nur die Warteschlange gesichert → die zurückgespielte Notiz bleibt (Offline-Änderung ohne Vorgänger wird zurückgehalten)',
      st === 200 && zurueck() === 'Neu: Stand der Sicherung', JSON.stringify({ st, body: zurueck() }));
    // Gegenstück: So war es vorher (ganzer Stand gesichert) — er mischt den alten Stand wieder hinein
    await nachreichen(ganzerStand);
    ok('zum Vergleich: der GANZE Stand gesichert hätte „nach der Sicherung" wieder hineingemischt (deshalb nur die Warteschlange)',
      /nach der Sicherung/.test(zurueck()), zurueck());
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (server) server.close();
  }
  console.log(`\nLive-Notizen beim Zurückspielen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
