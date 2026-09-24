// Gleitende Sitzung (R1, Alex 24.09.2026): 3 Tage ohne Aktivitaet, hoechstens 30 Tage.
//
// Vorher galt jede Anmeldung fest 24 Stunden — gemessen flogen die Leute dadurch mitten in der
// Arbeit heraus. Jetzt erneuert der Server das Token unterwegs (Kopfzeile X-Neues-Token).
//
// Die wichtigen Zusicherungen sind die, in denen NICHT erneuert werden darf: ein widerrufenes
// Token („auf allen Geraeten abmelden"), ein ausgestelltes Konto, und die Hoechstdauer. Ohne sie
// liesse sich ein erbeutetes Token durch blosses Benutzen endlos verlaengern.
//
// Dazu die Gruende beim Abweisen: Nur SITZUNG_ABGELAUFEN erlaubt der Oberflaeche, Entwuerfe zu
// behalten — deshalb muss jeder Fall seinen eigenen Code tragen.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//   node tests/sitzung-gleitend.js
const fs = require('fs');
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/sitzung-gleitend.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const GEHEIM = process.env.JWT_SECRET;

const express = require('express');
const { initDatabase, getDb } = require('../database/init');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let PORT = 0;
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s, neu: x.headers['x-neues-token'] || null }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JETZT = () => Math.floor(Date.now() / 1000);
const TAG = 24 * 3600;
// Ein Token mit frei gewaehltem Alter — genau so, wie es der Server ausgestellt haette.
const token = (userId, { alterS = 0, anmeldungVorS = null, restS = 3 * TAG, sitzung = 0, ohneAnmeldung = false } = {}) => {
  const iat = JETZT() - alterS;
  const payload = { userId, role: 'mitarbeiter', sitzung, iat, exp: JETZT() + restS };
  if (!ohneAnmeldung) payload.anmeldung = JETZT() - (anmeldungVorS == null ? alterS : anmeldungVorS);
  return jwt.sign(payload, GEHEIM);
};

(async () => {
  await initDatabase();
  const db = getDb();
  const PW = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PW, 10));
  const max = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth', 'auth'], ['/api/users', 'users'], ['/api/entries', 'entries']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('── Anmelden: das Token gilt 3 Tage, nicht mehr 24 Stunden ──');
    const an = await req('POST', '/api/auth/login', null, { username: 'max', password: PW });
    const d = jwt.decode(an.body.token);
    ok('Laufzeit ab Anmeldung = 3 Tage', d.exp - d.iat === 3 * TAG, `${(d.exp - d.iat) / 3600} h`);
    ok('… und der Anmeldezeitpunkt steht drin', Math.abs(d.anmeldung - d.iat) <= 1, JSON.stringify(d));

    console.log('\n── Erneuern ──');
    let r = await req('GET', '/api/entries', an.body.token);
    ok('frisches Token (unter 1 Stunde) → KEIN neues', r.status === 200 && !r.neu, String(r.neu).slice(0, 20));

    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600 }));
    const e = r.neu && jwt.decode(r.neu);
    ok('2 Stunden altes Token → neues in der Kopfzeile', r.status === 200 && !!e);
    ok('… wieder 3 Tage ab jetzt', e && Math.abs(e.exp - (JETZT() + 3 * TAG)) <= 2, e && `${(e.exp - JETZT()) / 3600} h`);
    ok('… der Anmeldezeitpunkt wandert NICHT mit', e && Math.abs(e.anmeldung - (JETZT() - 2 * 3600)) <= 2);
    ok('… und das neue Token funktioniert', (await req('GET', '/api/entries', r.neu)).status === 200);

    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600, anmeldungVorS: 29 * TAG }));
    const g = r.neu && jwt.decode(r.neu);
    ok('am 29. Tag wird noch erneuert — aber nur bis zum 30. Tag', g && Math.abs(g.exp - (g.anmeldung + 30 * TAG)) <= 2,
      g && `${(g.exp - JETZT()) / 3600} h Rest`);

    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600, anmeldungVorS: 31 * TAG, restS: 3600 }));
    // Strenger als „nur nicht mehr erneuern": Eine Sitzung ueber ihrer Hoechstdauer ist sofort vorbei —
    // sonst liefe sie mit dem letzten Token noch bis zu drei Tage weiter.
    ok('nach 30 Tagen: abgelaufen, Passwort fällig', r.status === 401 && r.body.code === 'SITZUNG_ABGELAUFEN' && !r.neu, r.text);

    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600, ohneAnmeldung: true, restS: 20 * 3600 }));
    const a = r.neu && jwt.decode(r.neu);
    ok('altes 24-h-Token ohne Anmeldezeitpunkt wird übernommen (niemand fliegt beim Deploy raus)',
      r.status === 200 && a && Math.abs(a.anmeldung - (JETZT() - 2 * 3600)) <= 2);

    console.log('\n── Abweisen mit Grund — und dabei NIE erneuern ──');
    r = await req('GET', '/api/entries', token(max, { alterS: 4 * TAG, restS: -10 }));
    ok('abgelaufen → SITZUNG_ABGELAUFEN', r.status === 401 && r.body.code === 'SITZUNG_ABGELAUFEN', r.text);
    ok('… mit deutscher Meldung', /Sitzung ist abgelaufen/.test(r.body.error), r.body.error);
    ok('… und ohne neues Token', !r.neu);

    // „Auf allen Geraeten abmelden": Stand hochzaehlen, ein altes Token mit Stand 0 ist widerrufen.
    db.prepare('INSERT OR REPLACE INTO user_sitzung (user_id, stand) VALUES (?, 1)').run(max);
    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600, sitzung: 0 }));
    ok('widerrufen → SITZUNG_BEENDET', r.status === 401 && r.body.code === 'SITZUNG_BEENDET', r.text);
    ok('… und ein widerrufenes Token wird NICHT erneuert', !r.neu);
    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600, sitzung: 1 }));
    const n = r.neu && jwt.decode(r.neu);
    ok('mit aktuellem Stand weiter erneuert — und der Stand bleibt im neuen Token', r.status === 200 && n && n.sitzung === 1);

    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(max);
    r = await req('GET', '/api/entries', token(max, { alterS: 2 * 3600, sitzung: 1 }));
    ok('ausgestellt → KONTO_AUSGESTELLT, ohne neues Token', r.status === 401 && r.body.code === 'KONTO_AUSGESTELLT' && !r.neu, r.text);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(max);

    r = await req('GET', '/api/entries', token(999999, { alterS: 2 * 3600 }));
    ok('gelöscht → KONTO_GELOESCHT', r.status === 401 && r.body.code === 'KONTO_GELOESCHT', r.text);
    r = await req('GET', '/api/entries', jwt.sign({ userId: max }, 'ein-ganz-anderes-geheimnis-mit-32-zeichen'));
    ok('falsche Unterschrift → TOKEN_UNGUELTIG', r.status === 401 && r.body.code === 'TOKEN_UNGUELTIG', r.text);
    r = await req('GET', '/api/entries', jwt.sign({ userId: max, sse: true }, GEHEIM, { expiresIn: '60s' }));
    ok('SSE-Ticket als Zugang → TOKEN_UNGUELTIG (Sonder-Token bleiben gesperrt)', r.status === 401 && r.body.code === 'TOKEN_UNGUELTIG');
    r = await req('GET', '/api/entries', null);
    ok('ohne Token → NICHT_ANGEMELDET', r.status === 401 && r.body.code === 'NICHT_ANGEMELDET');

    console.log('\n── Die Stufe des zweiten Faktors begrenzt die Sitzung ──');
    // Der Code wird nur beim ANMELDEN abgefragt. Ohne Grenze fragte „woechentlich" bei einer
    // gleitenden 30-Tage-Sitzung nur noch monatlich. Genau Alex' Einstellung im Betrieb.
    const zf = require('../zweifaktor');
    const erika = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;   // max als Traeger
    db.prepare("INSERT OR REPLACE INTO twofa_secrets (user_id, secret_enc, aktiv, confirmed_at, eigen_modus) VALUES (?, 'x', 1, '2026-09-01 08:00:00', 'woechentlich')").run(erika);
    zf.cacheVergessen();
    r = await req('GET', '/api/entries', token(erika, { alterS: 2 * 3600, anmeldungVorS: 6 * TAG, sitzung: 1 }));
    const w = r.neu && jwt.decode(r.neu);
    ok('eigene Stufe „wöchentlich": am 6. Tag erneuert — aber nur bis zum 7.',
      r.status === 200 && w && Math.abs(w.exp - (w.anmeldung + 7 * TAG)) <= 2, w && `${(w.exp - JETZT()) / 3600} h Rest`);
    r = await req('GET', '/api/entries', token(erika, { alterS: 2 * 3600, anmeldungVorS: 8 * TAG, sitzung: 1 }));
    ok('… am 8. Tag ABGELAUFEN (neu anmelden mit Code)', r.status === 401 && r.body.code === 'SITZUNG_ABGELAUFEN', r.text);
    const neuAn = await req('POST', '/api/auth/login', null, { username: 'max', password: PW });
    ok('(die Anmeldung verlangt dann tatsächlich den Code)', neuAn.body && neuAn.body.zwei_faktor_erforderlich === true,
      JSON.stringify(neuAn.body).slice(0, 100));

    db.prepare("UPDATE twofa_secrets SET eigen_modus = 'geraet' WHERE user_id = ?").run(erika);
    zf.cacheVergessen();
    r = await req('GET', '/api/entries', token(erika, { alterS: 2 * 3600, anmeldungVorS: 10 * TAG, sitzung: 1 }));
    const g2 = r.neu && jwt.decode(r.neu);
    ok('Gegenprobe „einmal pro Gerät": keine zusätzliche Grenze, am 10. Tag erneuert auf 3 Tage',
      r.status === 200 && g2 && Math.abs(g2.exp - (JETZT() + 3 * TAG)) <= 2);

    // Die Rolle schreibt vor — sie gewinnt ueber den eigenen Wunsch.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('twofa_mitarbeiter', 'taeglich')").run();
    zf.cacheVergessen();
    r = await req('GET', '/api/entries', token(erika, { alterS: 2 * 3600, anmeldungVorS: 25 * 3600, sitzung: 1 }));
    ok('Rolle „täglich": nach 25 Stunden ABGELAUFEN, wie mit der alten 24-Stunden-Sitzung',
      r.status === 401 && r.body.code === 'SITZUNG_ABGELAUFEN', r.text);
    r = await req('GET', '/api/entries', token(erika, { alterS: 2 * 3600, anmeldungVorS: 20 * 3600, sitzung: 1 }));
    const t2 = r.neu && jwt.decode(r.neu);
    ok('… nach 20 Stunden noch da, erneuert nur bis 24 Stunden nach der Anmeldung',
      r.status === 200 && t2 && Math.abs(t2.exp - (t2.anmeldung + TAG)) <= 2);
    db.prepare("DELETE FROM settings WHERE key = 'twofa_mitarbeiter'").run();
    db.prepare('DELETE FROM twofa_secrets WHERE user_id = ?').run(erika);
    zf.cacheVergessen();
    r = await req('GET', '/api/entries', token(erika, { alterS: 2 * 3600, anmeldungVorS: 25 * 3600, sitzung: 1 }));
    ok('Gegenprobe ohne Authenticator: 25 Stunden sind kein Problem', r.status === 200 && !!r.neu, r.text.slice(0, 80));

    console.log('\n── Gegenprobe: Nur „abgelaufen" darf wie „abgelaufen" aussehen ──');
    const codes = new Set();
    for (const t of [token(max, { alterS: 4 * TAG, restS: -10 }), token(999999, {}), jwt.sign({ userId: max }, 'x'.repeat(40))])
      codes.add((await req('GET', '/api/entries', t)).body.code);
    ok('drei verschiedene Fälle → drei verschiedene Codes', codes.size === 3, JSON.stringify([...codes]));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nSitzung gleitend: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
