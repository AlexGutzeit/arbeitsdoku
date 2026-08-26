// Die Gesetzesregeln selbst: ArbZG und JArbSchG als Falltabelle (Alex, 26.08.2026)
//
// Bis hierher gab es die Regeln nur als Warnzeile im Eintragsformular, und geprüft wurden sie
// ausschliesslich über die Oberfläche mit Suchmustern auf Fliesstext. Seit sie in
// public/js/arbeitszeitrecht.js stehen und ein Objekt zurückgeben, lassen sie sich direkt
// befragen — punktgenau an den Grenzen, ohne Klickweg.
//
// Warum Grenzwerte einzeln: Die Regeln sind alle „mehr als", nicht „ab". Genau 10:00 ist erlaubt,
// genau 11:00 Ruhezeit ist erlaubt. Ein Vorzeichenfehler an dieser Stelle fällt in der Oberfläche
// nie auf — er verschiebt nur, wann ein Zeichen erscheint.
//
//   node tests/arbeitszeitrecht-regeln.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3292, DB = '/tmp/arbeitszeitrecht.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/arbeitszeitrecht-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    p.setDefaultTimeout(30000);
    await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]');
    await sleep(2500);

    ok('das Regelmodul ist geladen', await p.evaluate(() => typeof pruefeEintraege === 'function'));

    // Die Regeln bekommen `jugendlich` als Parameter — Alter und Datenbank spielen hier keine
    // Rolle. Ein Eintrag ist nur { user_id, date, time_from, time_to, break_minutes }.
    const tag = (faelle, vortag, jugendlich, opt) => p.evaluate((f, v, j, o) => {
      const bau = (l) => (l || []).map(x => ({ user_id: 1, date: x[0] || '2026-07-08', time_from: x[1], time_to: x[2], break_minutes: x[3] || 0 }));
      return verstoesseTag(1, '2026-07-08', bau(f), bau(v), j, o).map(x => ({ art: x.art, ist: x.ist, grenze: x.grenze, text: x.text }));
    }, faelle, vortag || [], !!jugendlich, opt || null);
    const arten = (l) => l.map(x => x.art).sort().join(',');

    console.log('\n── Tagesarbeitszeit: die Grenze ist „mehr als" ──');
    // 10:45 Anwesenheit mit 45 min Pause = genau 10:00 Arbeitszeit — und die Pause stimmt dabei
    // auch, sonst schluege die Pausenregel zusaetzlich an und der Fall pruefte zwei Dinge auf
    // einmal (genau so war dieser Test im ersten Wurf falsch).
    ok('Erwachsener, genau 10:00 → kein Verstoß',
      arten(await tag([[null, '06:00', '16:45', 45]])) === '', JSON.stringify(await tag([[null, '06:00', '16:45', 45]])));
    ok('Erwachsener, 10:01 → tag-erwachsen',
      arten(await tag([[null, '06:00', '16:46', 45]])) === 'tag-erwachsen',
      JSON.stringify(await tag([[null, '06:00', '16:46', 45]])));
    ok('Jugendlicher, genau 8:00 → kein Verstoß',
      !arten(await tag([[null, '06:00', '14:00', 0]], [], true)).includes('tag-jugend'),
      JSON.stringify(await tag([[null, '06:00', '14:00', 0]], [], true)));
    ok('Jugendlicher, 8:01 → tag-jugend',
      arten(await tag([[null, '06:00', '14:01', 0]], [], true)).includes('tag-jugend'));
    {
      const v = (await tag([[null, '06:00', '16:46', 45]]))[0];
      ok('… mit Zahlen statt nur Text (ist/grenze in Minuten)', v.ist === 601 && v.grenze === 600, JSON.stringify(v));
      ok('… und der Text nennt § 3 ArbZG', /§ 3 ArbZG/.test(v.text), v.text);
    }

    console.log('\n── Zeitgleiche Aufträge zählen einmal ──');
    ok('zweimal 07:00–12:00 sind 5 Std, kein Verstoß',
      arten(await tag([[null, '07:00', '12:00'], [null, '07:00', '12:00']])) === '',
      JSON.stringify(await tag([[null, '07:00', '12:00'], [null, '07:00', '12:00']])));

    console.log('\n── Ruhepause ──');
    ok('Erwachsener, genau 6:00 Anwesenheit ohne Pause → kein Verstoß',
      arten(await tag([[null, '07:00', '13:00']])) === '');
    ok('Erwachsener, 6:01 ohne Pause → pause-erwachsen',
      arten(await tag([[null, '07:00', '13:01']])) === 'pause-erwachsen');
    ok('… 30 min gebucht genügen dann',
      arten(await tag([[null, '07:00', '13:01', 30]])) === '');
    ok('Erwachsener, 9:45 Anwesenheit mit 30 min → zu wenig (45 nötig)',
      arten(await tag([[null, '07:00', '16:45', 30]])) === 'pause-erwachsen');
    ok('… mit 45 min ist es in Ordnung',
      arten(await tag([[null, '07:00', '16:45', 45]])) === '');
    ok('Jugendlicher, 4:31 ohne Pause → pause-jugend',
      arten(await tag([[null, '07:00', '11:31']], [], true)) === 'pause-jugend');
    ok('Jugendlicher, genau 4:30 ohne Pause → kein Verstoß',
      arten(await tag([[null, '07:00', '11:30']], [], true)) === '');
    {
      const v = (await tag([[null, '07:00', '13:01']]))[0];
      ok('… der Text nennt Anwesenheit, Soll und Ist', /6 Std 1 min/.test(v.text) && /30 Minuten/.test(v.text) && /keine/.test(v.text), v.text);
    }

    console.log('\n── Ruhezeit zwischen zwei Tagen ──');
    const gestern = '2026-07-07';
    const opt = { ladeVon: '2026-07-06' };
    ok('Feierabend 22:00, Beginn 09:00 = genau 11:00 → kein Verstoß',
      arten(await tag([[null, '09:00', '15:00']], [[gestern, '06:00', '22:00', 45]], false, opt)) === '',
      JSON.stringify(await tag([[null, '09:00', '15:00']], [[gestern, '06:00', '22:00', 45]], false, opt)));
    ok('Feierabend 22:00, Beginn 08:59 = 10:59 → ruhezeit-erwachsen',
      arten(await tag([[null, '08:59', '15:00', 30]], [[gestern, '06:00', '22:00', 45]], false, opt)) === 'ruhezeit-erwachsen',
      JSON.stringify(await tag([[null, '08:59', '15:00', 30]], [[gestern, '06:00', '22:00', 45]], false, opt)));
    ok('Jugendlicher: genau 12:00 → kein Verstoß',
      !arten(await tag([[null, '10:00', '14:00']], [[gestern, '06:00', '22:00', 60]], true, opt)).includes('ruhezeit'));
    ok('Jugendlicher: 11:59 → ruhezeit-jugend',
      arten(await tag([[null, '09:59', '14:00']], [[gestern, '06:00', '22:00', 60]], true, opt)).includes('ruhezeit-jugend'));
    {
      const v = (await tag([[null, '08:59', '15:00', 30]], [[gestern, '06:00', '22:00', 45]], false, opt)).find(x => x.art === 'ruhezeit-erwachsen');
      ok('… der Text nennt beide Uhrzeiten', /22:00/.test(v.text) && /08:59/.test(v.text), v.text);
      ok('… und § 5 ArbZG', /§ 5 ArbZG/.test(v.text));
    }
    ok('ohne Vortagseinträge wird die Ruhezeit nicht beurteilt',
      arten(await tag([[null, '05:00', '11:00']], [], false, opt)) === '');

    console.log('\n── Der erste geladene Tag wird NICHT auf Ruhezeit geprüft ──');
    // „Vortag nicht geladen" und „am Vortag nicht gearbeitet" sehen in den Daten gleich aus. Der
    // Fehler erzeugt FEHLENDE Warnungen und wäre damit unsichtbar.
    ok('ladeVon = der Tag selbst → keine Ruhezeit-Aussage',
      arten(await tag([[null, '08:59', '15:00', 30]], [[gestern, '06:00', '22:00', 45]], false, { ladeVon: '2026-07-08' })) === '',
      JSON.stringify(await tag([[null, '08:59', '15:00', 30]], [[gestern, '06:00', '22:00', 45]], false, { ladeVon: '2026-07-08' })));

    console.log('\n── Die 18 Bestands-Platzhalter (07:00–07:00) ──');
    ok('ein Null-Dauer-Eintrag am Vortag gilt nicht als Feierabend',
      arten(await tag([[null, '08:00', '15:00', 30]], [[gestern, '07:00', '07:00']], false, opt)) === '',
      JSON.stringify(await tag([[null, '08:00', '15:00', 30]], [[gestern, '07:00', '07:00']], false, opt)));
    ok('ein Tag, der NUR aus Platzhaltern besteht, erzeugt gar nichts',
      arten(await tag([[null, '07:00', '07:00']], [], false, opt)) === '');

    console.log('\n── Wochengrenzen ──');
    const woche = (spannen, jugendlich) => p.evaluate((sp, j) => {
      const bau = sp.map(x => ({ user_id: 1, date: x[0], time_from: x[1], time_to: x[2], break_minutes: x[3] || 0 }));
      return verstoesseWoche(1, '2026-07-06', bau, j).map(x => ({ art: x.art, ist: x.ist, grenze: x.grenze, hinweis: x.hinweis, text: x.text }));
    }, spannen, !!jugendlich);
    const fuenfTage = (bis, pause) => ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'].map(d => [d, '06:00', bis, pause || 0]);

    ok('Jugendlicher, genau 40:00 → kein Verstoß',
      (await woche(fuenfTage('14:00'), true)).length === 0, JSON.stringify(await woche(fuenfTage('14:00'), true)));
    ok('Jugendlicher, 40:15 → woche-jugend',
      (await woche([...fuenfTage('14:00'), ['2026-07-11', '08:00', '08:15']], true))[0].art === 'woche-jugend');
    ok('Erwachsener bei 40:15 → nichts (seine Grenze liegt bei 48)',
      (await woche([...fuenfTage('14:00'), ['2026-07-11', '08:00', '08:15']], false)).length === 0);
    ok('Erwachsener, genau 48:00 → kein Hinweis',
      (await woche(fuenfTage('16:00', 24), false)).length === 0, JSON.stringify(await woche(fuenfTage('16:00', 24), false)));
    {
      const v = (await woche([...fuenfTage('16:00', 24), ['2026-07-11', '08:00', '08:15']], false))[0];
      ok('Erwachsener, 48:15 → woche-erwachsen', v && v.art === 'woche-erwachsen', JSON.stringify(v));
      ok('… ausdrücklich als HINWEIS gekennzeichnet', v && v.hinweis === true, JSON.stringify(v && v.hinweis));
      ok('… und der Text behauptet keinen Verstoß, sondern nennt den 24-Wochen-Ausgleich',
        /zulässig/.test(v.text) && /24 Wochen/.test(v.text) && !/erlaubt höchstens/.test(v.text), v.text);
    }
    ok('der Jugend-Verstoß ist KEIN blosser Hinweis',
      (await woche([...fuenfTage('14:00'), ['2026-07-11', '08:00', '08:15']], true))[0].hinweis === false);

    console.log('\n── Der Sammelaufruf und sein Index ──');
    const index = await p.evaluate(() => {
      S.users = [{ id: 1, name: 'Erwachsen', birth_date: '1990-01-01' },
                 { id: 2, name: 'Jugend', birth_date: '2010-06-01' },
                 { id: 3, name: 'Ohne Datum', birth_date: null }];
      const e = (uid, d, von, bis, pause) => ({ user_id: uid, date: d, time_from: von, time_to: bis, break_minutes: pause || 0 });
      const liste = [
        e(1, '2026-07-08', '06:00', '17:00', 45),   // 10:15 netto → tag-erwachsen
        e(2, '2026-07-08', '06:00', '15:00', 60),   // 8:00 netto  → genau die Grenze, kein Verstoß
        e(3, '2026-07-08', '06:00', '15:00', 60),   // ohne Geburtsdatum ⇒ Jugendschutz, 8:00 → keiner
        e(2, '2026-07-09', '06:00', '15:30', 60),   // 8:30 → tag-jugend
      ];
      const idx = pruefeEintraege(liste, { ladeVon: '2026-07-06', ladeBis: '2026-07-12' });
      return {
        schluessel: Object.keys(idx.tag).sort(),
        wochenschluessel: Object.keys(idx.woche).sort(),
        erwachsen: verstossTag(idx, 1, '2026-07-08').map(v => v.art),
        jugendOk: verstossTag(idx, 2, '2026-07-08').map(v => v.art),
        jugendVerstoss: verstossTag(idx, 2, '2026-07-09').map(v => v.art),
        ohneDatum: verstossTag(idx, 3, '2026-07-08').map(v => v.art),
      };
    });
    ok('der Index enthält nur Tage MIT Verstoß', index.schluessel.join(' ') === '1|2026-07-08 2|2026-07-09',
      JSON.stringify(index.schluessel));
    ok('… der Erwachsene reisst die Tagesgrenze', index.erwachsen.join(',') === 'tag-erwachsen', JSON.stringify(index.erwachsen));
    ok('… der Jugendliche bei genau 8:00 nicht', index.jugendOk.length === 0, JSON.stringify(index.jugendOk));
    ok('… bei 8:30 schon', index.jugendVerstoss.join(',') === 'tag-jugend', JSON.stringify(index.jugendVerstoss));
    ok('ohne Geburtsdatum gilt der strengere Jugendschutz (8:00 ist dort die Grenze)',
      index.ohneDatum.length === 0, JSON.stringify(index.ohneDatum));

    console.log('\n── Wochenschlüssel ist der Montag, nicht die KW-Nummer ──');
    const wochen = await p.evaluate(() => ({
      montag:    montagDer('2026-07-08'),
      sonntag:   montagDer('2026-07-12'),   // Sonntag gehört zur Woche davor
      jahresende: montagDer('2026-12-31'),
      neujahr:   montagDer('2027-01-01'),
    }));
    ok('Mittwoch 08.07. → Montag 06.07.', wochen.montag === '2026-07-06', wochen.montag);
    ok('Sonntag 12.07. gehört noch zur Woche ab 06.07.', wochen.sonntag === '2026-07-06', wochen.sonntag);
    ok('31.12.2026 und 01.01.2027 liegen in DERSELBEN Woche',
      wochen.jahresende === wochen.neujahr, `${wochen.jahresende} vs ${wochen.neujahr}`);
    ok('… eine KW-Nummer allein hätte sie getrennt (deshalb der Montag als Schlüssel)',
      wochen.jahresende === '2026-12-28', wochen.jahresende);
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
  }
  console.log(`\nArbeitszeitrecht-Regeln: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
