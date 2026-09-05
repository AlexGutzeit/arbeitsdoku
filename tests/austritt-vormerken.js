// Ausstellen mit ZUKÜNFTIGEM Austrittsdatum: vormerken statt sofort aussperren.
//
// Der Fehler, um den es geht (Alex, 04.09.2026): Wer am 05.09. ausstellte und den 30.09. als
// letzten Arbeitstag eintrug, sperrte den Mitarbeiter SOFORT aus — während sein Soll bis zum
// 30.09. weiterlief (`isEmployedOn` zählt bis einschließlich Austrittsdatum). Er konnte seine
// Stunden nicht mehr buchen. Ergebnis: 18 Arbeitstage mit Soll, aber ohne Ist — rund 144 Stunden,
// die still vom Überstundenstand abgingen. Ausgerechnet in der Lage, in der dieser Stand
// ausgezahlt wird.
//
// Geprüft wird deshalb BEIDES:
//   * dass der Zugang bis zum letzten Arbeitstag bestehen bleibt (sonst kann er nicht buchen)
//   * dass das Soll trotzdem am Austrittstag endet (sonst wäre die Vormerkung wirkungslos)
//
// Und die Gegenrichtung: Ein RÜCKWIRKENDES Datum muss weiterhin sofort wirken — das ist der
// bewährte Weg, den die Firma bisher benutzt hat.
//
// IN-PROCESS, kein eigener Server-Prozess: Der Vollzug durch den Zeitplaner wird direkt aufgerufen
// und muss dabei DIESELBE Datenbank sehen wie die Routen. Ein zweiter Prozess auf derselben Datei
// hätte eine eigene Kopie im Speicher — die Prüfungen liefen ins Leere, und der Autosave-Takt
// beider Seiten überschriebe sich gegenseitig ([[reference_zweiter_prozess_db]]).
//
//   node tests/austritt-vormerken.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/austritt-vormerken.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const { austritteVollziehen } = require('../scheduler');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let PORT = 0;
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Alles RELATIV zu heute — ein festes Datum bedeutet in einem Jahr etwas anderes
// ([[reference_tests_zeitfallen]]).
const heute = new Date().toLocaleDateString('sv-SE');
const plus = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/entries', require('../routes/entries'));
  app.use('/api/statistics', require('../routes/statistics'));
  app.use('/api/payroll', require('../routes/payroll'));
  app.use('/api/twofa', require('../routes/twofa'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const anSeed = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PWSEED })).body.token;
    const admin = await anSeed('admin'), chef = await anSeed('chef');
    const PW = 'Austritt!2345';
    const anMit = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PW })).body.token;

    const anlegen = async (benutzer, name, abWann) => {
      const u = (await req('POST', '/api/users', admin, {
        username: benutzer, password: PW, name, role: 'mitarbeiter', target_hours_per_week: 40,
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
      if (abWann) {
        // Zieht den Anstellungsbeginn zurueck — sonst waere ein rueckwirkendes Austrittsdatum
        // „vor dem Eintrittsdatum" und wuerde zu Recht abgewiesen.
        await req('POST', `/api/statistics/targets/${u.id}`, chef, {
          hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: abWann });
      }
      return u;
    };
    const holen = async (id) => (await req('GET', '/api/users', admin)).body.users.find(u => u.id === id);

    console.log('── Zukünftiges Austrittsdatum: vormerken, nicht aussperren ──');
    const v = await anlegen('vorgemerkt', 'Vera Vorgemerkt');
    const vTok = await anMit('vorgemerkt');
    ok('Aufbau: Konto angelegt und angemeldet', !!v && !!vTok, JSON.stringify(v && v.id));

    const inZwanzig = plus(20);
    const r = await req('POST', `/api/users/${v.id}/deactivate`, chef, { employed_until: inZwanzig });
    ok('Ausstellen mit Datum in der Zukunft wird angenommen', r.status === 200, r.status + ' ' + r.text.slice(0, 90));
    ok('… und meldet sich ausdrücklich als Vormerkung', r.body && r.body.vorgemerkt === true, JSON.stringify(r.body));

    const nach = await holen(v.id);
    ok('das Konto bleibt AKTIV', nach && Number(nach.active) === 1, JSON.stringify(nach && nach.active));
    ok('… das Austrittsdatum steht trotzdem schon fest',
      nach && (nach.employment || []).some(p => p.e === inZwanzig), JSON.stringify(nach && nach.employment));

    // Der eigentliche Punkt: Er muss weiterarbeiten können.
    const buchen = await req('POST', '/api/entries', vTok, { date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'letzte Wochen' });
    ok('er kann sich noch anmelden und Stunden buchen', buchen.status === 201, buchen.status + ' ' + buchen.text.slice(0, 90));
    ok('… seine Sitzung lebt (geschützter Aufruf geht)', (await req('GET', '/api/entries', vTok)).status === 200);

    console.log('\n── Das Soll endet trotzdem am Austrittstag ──');
    // Ohne diese Prüfung wäre die Vormerkung wirkungslos — dann liefe die Anstellung einfach weiter.
    const nachAustritt = plus(25);
    const csv = (await req('GET', `/api/payroll/monat.csv?month=${nachAustritt.slice(0, 7)}`, admin)).text;
    ok('der Lohn-Export ist abrufbar', csv.length > 20, csv.slice(0, 60));
    const zeile = csv.split('\r\n').find(z => z.includes('Vera Vorgemerkt'));
    ok('… und nennt „Beschäftigt bis" mit dem vorgemerkten Datum',
      !!zeile && zeile.includes(inZwanzig), (zeile || '').slice(0, 160));

    console.log('\n── Zwei-Faktor und Push bleiben bis zum Vollzug ──');
    // Sie erst beim Vollzug zu löschen ist der Sinn der Sache: Bis dahin arbeitet er normal weiter.
    const zwei = await req('GET', '/api/twofa/status', vTok);
    ok('sein Zwei-Faktor-Zustand ist weiterhin abrufbar', zwei.status === 200, zwei.status + ' ' + zwei.text.slice(0, 80));

    console.log('\n── Die Vormerkung lässt sich aufheben ──');
    const auf = await req('POST', `/api/users/${v.id}/austritt-aufheben`, chef);
    ok('Aufheben geht', auf.status === 200, auf.status + ' ' + auf.text.slice(0, 90));
    const nachAuf = await holen(v.id);
    ok('… danach ist kein Austrittsdatum mehr gesetzt',
      nachAuf && !(nachAuf.employment || []).some(p => p.e), JSON.stringify(nachAuf && nachAuf.employment));
    ok('… und das Konto ist weiterhin aktiv', nachAuf && Number(nachAuf.active) === 1);
    const nochmal = await req('POST', `/api/users/${v.id}/austritt-aufheben`, chef);
    ok('ein zweites Aufheben wird abgewiesen', nochmal.status === 409, nochmal.status + ' ' + nochmal.text.slice(0, 90));

    console.log('\n── Heute als letzter Arbeitstag: wirkt SOFORT ──');
    // Nur ein Tag, der noch BEVORSTEHT, wird vorgemerkt. „Heute" schliesst sofort — der Knopf
    // „Ausstellen" schickt ohne Angabe genau dieses Datum, und er muss weiterhin das tun, was
    // draufsteht (auch bei einer fristlosen Trennung).
    const t = await anlegen('heutetag', 'Theo Heute');
    const tTok = await anMit('heutetag');
    const rt = await req('POST', `/api/users/${t.id}/deactivate`, chef, { employed_until: heute });
    ok('wirkt sofort, ist KEINE Vormerkung',
      rt.status === 200 && rt.body.vorgemerkt === false, rt.status + ' ' + JSON.stringify(rt.body));
    ok('… seine Sitzung ist sofort tot', (await req('GET', '/api/entries', tTok)).status === 401);

    // Und der Normalfall: der Knopf ohne Datumsangabe.
    const o = await anlegen('ohnedatum', 'Olga Ohnedatum');
    const oTok = await anMit('ohnedatum');
    const ro = await req('POST', `/api/users/${o.id}/deactivate`, chef, {});
    ok('Ausstellen OHNE Datum schliesst das Konto sofort',
      ro.status === 200 && ro.body.vorgemerkt === false, ro.status + ' ' + JSON.stringify(ro.body));
    ok('… auch dort ist die Sitzung sofort tot', (await req('GET', '/api/entries', oTok)).status === 401);

    console.log('\n── Rückwirkendes Datum wirkt weiterhin SOFORT ──');
    // Der bewährte Weg. Würde er sich mit ändern, wäre die Reparatur eine Verschlechterung.
    const s = await anlegen('sofort', 'Sofia Sofort', plus(-60));
    const sTok = await anMit('sofort');
    const rs = await req('POST', `/api/users/${s.id}/deactivate`, chef, { employed_until: plus(-1) });
    ok('Ausstellen mit gestrigem Datum geht', rs.status === 200, rs.status + ' ' + rs.text.slice(0, 90));
    ok('… und ist ausdrücklich KEINE Vormerkung', rs.body && rs.body.vorgemerkt === false, JSON.stringify(rs.body));
    const nachS = (await req('GET', '/api/users/inactive', admin)).body;
    ok('… das Konto ist geschlossen',
      JSON.stringify(nachS).includes('Sofia Sofort'), JSON.stringify(nachS).slice(0, 140));
    ok('… seine Sitzung ist sofort tot (401)', (await req('GET', '/api/entries', sTok)).status === 401);
    const aufS = await req('POST', `/api/users/${s.id}/austritt-aufheben`, chef);
    ok('bei einem geschlossenen Konto verweist das Aufheben auf „Wiedereinstellen"',
      aufS.status === 409 && /Wiedereinstellen/i.test(aufS.text), aufS.status + ' ' + aufS.text.slice(0, 110));
    console.log('\n── Der Zeitplaner vollzieht die Vormerkung ──');
    // Der eigentliche Prüfstein: Nach dem Vollzug muss der Zustand ZEICHENGLEICH dem sein, den ein
    // sofortiges Ausstellen erzeugt hätte. Sonst wäre die Vormerkung ein zweiter, leicht anderer
    // Weg — genau die Sorte Doppelung, die auseinanderläuft.
    const p1 = await anlegen('spaeter', 'Petra Später', plus(-60));
    const p1Tok = await anMit('spaeter');
    await req('POST', `/api/users/${p1.id}/deactivate`, chef, { employed_until: plus(3) });
    ok('vorgemerkt zum ' + plus(3), Number((await holen(p1.id)).active) === 1);

    // „Heute" vorgestellt: der Tag NACH dem letzten Arbeitstag.
    const vollzogen = austritteVollziehen(db, plus(4));
    // NICHT „genau einer": Ein frueherer Abschnitt hat Theo zum heutigen Tag vorgemerkt, und mit
    // „heute = plus(4)" ist auch er faellig. Das ist richtig so — der Zeitplaner holt ALLE
    // faelligen. Gepruefft wird deshalb das, worauf es ankommt: Petra ist dabei, und niemand,
    // dessen letzter Arbeitstag noch bevorsteht.
    ok('der Zeitplaner vollzieht den fälligen Austritt',
      vollzogen.some(v => v.id === p1.id), JSON.stringify(vollzogen));
    ok('… und fasst niemanden an, der noch arbeitet',
      vollzogen.every(v => v.end_date < plus(4)), JSON.stringify(vollzogen));

    const nachVollzug = (await req('GET', '/api/users/inactive', admin)).body.users.find(u => u.id === p1.id);
    ok('das Konto ist danach geschlossen', !!nachVollzug, JSON.stringify(nachVollzug));
    ok('… und seine Sitzung tot', (await req('GET', '/api/entries', p1Tok)).status === 401);

    // Vergleich mit dem sofortigen Weg — Feld für Feld.
    const wieSofort = (await req('GET', '/api/users/inactive', admin)).body.users.find(u => u.name === 'Sofia Sofort');
    const felder = (u) => u ? {
      active: Number(u.active),
      hatAustrittsdatum: !!u.employed_until || (u.employment || []).some(p => p.e),
      deactivated_gesetzt: !!u.deactivated_at,
    } : null;
    ok('Vollzug und sofortiges Ausstellen hinterlassen denselben Zustand',
      JSON.stringify(felder(nachVollzug)) === JSON.stringify(felder(wieSofort)),
      JSON.stringify(felder(nachVollzug)) + ' vs. ' + JSON.stringify(felder(wieSofort)));

    // Die Aufräumarbeit muss ebenfalls gelaufen sein.
    ok('… Push-Abos sind entfernt',
      db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(p1.id).n === 0);
    ok('… Zwei-Faktor ist entfernt',
      !db.prepare('SELECT user_id FROM twofa_secrets WHERE user_id = ?').get(p1.id));
    const prot = db.prepare("SELECT details FROM audit_logs WHERE action='user_deactivate' ORDER BY id DESC LIMIT 1").get();
    ok('… und im Protokoll steht, dass es vorgemerkt war',
      prot && /vorgemerkt/.test(prot.details), JSON.stringify(prot));

    console.log('\n── Versäumtes wird nachgeholt, nicht übersprungen ──');
    // Läuft der Server über den Stichtag nicht, darf das Konto nicht für immer offen bleiben.
    const p2 = await anlegen('verpasst', 'Vera Verpasst', plus(-60));
    await req('POST', `/api/users/${p2.id}/deactivate`, chef, { employed_until: plus(2) });
    const spaet = austritteVollziehen(db, plus(30));   // erst 28 Tage später gestartet
    ok('ein längst fälliger Austritt wird nachgeholt',
      spaet.some(v => v.id === p2.id), JSON.stringify(spaet));

    console.log('\n── Wer noch arbeitet, wird NICHT geschlossen ──');
    const p3 = await anlegen('laeuft', 'Lena Läuft', plus(-60));
    await req('POST', `/api/users/${p3.id}/deactivate`, chef, { employed_until: plus(10) });
    const zuFrueh = austritteVollziehen(db, plus(10));  // sein LETZTER Arbeitstag
    ok('am letzten Arbeitstag selbst passiert nichts',
      !zuFrueh.some(v => v.id === p3.id), JSON.stringify(zuFrueh));
    ok('… sein Konto ist noch offen', Number((await holen(p3.id)).active) === 1);
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    server.close();
  }
  console.log(`\nAustritt vormerken: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
