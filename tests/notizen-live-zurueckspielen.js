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
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (server) server.close();
  }
  console.log(`\nLive-Notizen beim Zurückspielen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
