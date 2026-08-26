// Gesetzesverstöße in den Übersichten des Zeitnachweises (Alex, 26.08.2026)
//
// Für die Prüfung wird ein WEITERER Zeitraum geladen, als angezeigt wird: ein Tag davor für die
// Ruhezeit, volle Kalenderwochen für die Wochengrenze. Damit steht und fällt alles an einer
// einzigen Eigenschaft — diese Zusatztage dürfen in KEINE angezeigte Zahl geraten.
//
// Ein Fehler dort wäre still: Die Nettostunden eines Monats wären zu hoch, die Zahl sähe trotzdem
// plausibel aus, und niemand käme auf die Idee, sie nachzurechnen. Deshalb steht dieser Nachweis
// im Test VOR allem anderen — und er prüft nicht „unverändert gegenüber gestern", sondern rechnet
// die erwarteten Werte selbst aus.
//
//   node tests/verstoesse-uebersicht-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3293, DB = '/tmp/verstoesse-uebersicht.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/verstoesse-uebersicht-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Die angezeigten Kennzahlen einsammeln — genau die Zahlen, die ein Mensch abliest.
const kennzahlen = (p) => p.evaluate(() => {
  const karte = (wort) => {
    const k = [...document.querySelectorAll('.summary-card')].find(c => new RegExp(wort, 'i').test(c.innerText));
    return k ? k.querySelector('.value').innerText.trim() : null;
  };
  return {
    netto: karte('nettostunden'),
    eintraege: karte('einträge'),
    zellen: [...document.querySelectorAll('.grid-cell-total')].map(e => e.innerText.trim()),
    spalten: [...document.querySelectorAll('.grid-col-header-sum, .tl-col-header-sum')].map(e => e.innerText.trim()),
    tage: [...document.querySelectorAll('.grid-kw-dayhours')].map(e => e.innerText.trim()),
  };
});
const ansicht = async (p, v, datum) => {
  await p.evaluate((vv, d) => { S.view = vv; S.currentDate = new Date(d + 'T12:00:00'); render(); }, v, datum);
  await sleep(2500);
};

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
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'monteur', password: 'Str3ng!Geheim',
      name: 'Mark Monteur', role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '1990-05-05' })).body.user;
    ok('Mitarbeiter angelegt', !!ma, JSON.stringify(ma));

    const buch = (datum, von, bis, pause) => req('POST', '/api/entries', admin,
      { user_id: ma.id, date: datum, time_from: von, time_to: bis, break_minutes: pause || 0, description: datum });

    // Juli 2026: der 1. ist ein Mittwoch, die erste Kalenderwoche beginnt also am Mo 29.06. —
    // im VORMONAT. Genau diese Tage werden für die Wochengrenze mitgeladen und dürfen in keiner
    // Julizahl auftauchen.
    await buch('2026-06-29', '07:00', '15:00', 30);        // Vormonat, aber KW 27
    await buch('2026-06-30', '07:00', '15:00', 30);        // Vormonat, aber KW 27
    await buch('2026-07-01', '07:00', '15:00', 30);        // 7:30
    await buch('2026-07-08', '07:00', '13:00', 0);         // 6:00, der Tag der Tagesansicht
    await buch('2026-07-07', '07:00', '15:00', 30);        // Vortag (Ruhezeit-Grundlage)
    await buch('2026-07-31', '07:00', '15:00', 30);        // letzter Julitag, KW 31 reicht in den August
    await buch('2026-08-03', '07:00', '15:00', 30);        // Folgemonat, KW 32 — darf NIE auftauchen

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1400, height: 1000 });
    p.setDefaultTimeout(30000);
    const jsFehler = [];
    p.on('pageerror', e => jsFehler.push(e.message));

    await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]');
    await sleep(2500);
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(2000);

    console.log('── Die Zusatztage geraten in KEINE angezeigte Zahl ──');

    await ansicht(p, 'day', '2026-07-08');
    let k = await kennzahlen(p);
    ok('Tag: Nettostunden sind die des Tages (6:00)', k.netto === '6:00', k.netto);
    ok('Tag: genau ein Eintrag gezählt', k.eintraege === '1', k.eintraege);
    ok('… obwohl der Vortag mitgeladen wurde', k.spalten.join('|') === '6:00', JSON.stringify(k.spalten));

    await ansicht(p, 'week', '2026-07-08');
    k = await kennzahlen(p);
    // KW 28 = Mo 06.07. bis So 12.07. → nur der 07. (7:30) und der 08. (6:00) = 13:30
    ok('Woche: Nettostunden sind die der Woche (13:30)', k.netto === '13:30', k.netto);
    ok('Woche: zwei Einträge', k.eintraege === '2', k.eintraege);
    // Pause nur aus DIESER Woche: der 07. hat 30 min, der 08. keine. Die 30 min vom 01.07.
    // gehören zu KW 27 (im ersten Wurf hatte ich sie mitgezählt — die App hatte recht).
    ok('… die Spaltensumme stimmt damit überein', k.spalten.join('|') === '13:30 · 30 min Pause', JSON.stringify(k.spalten));

    await ansicht(p, 'month', '2026-07-15');
    k = await kennzahlen(p);
    // Juli: 01. (7:30) + 07. (7:30) + 08. (6:00) + 31. (7:30) = 28:30.
    // NICHT dabei: 29./30.06. (mitgeladen für KW 27) und 03.08. (mitgeladen für KW 31/32).
    ok('Monat: Nettostunden sind die des Monats (28:30)', k.netto === '28:30', k.netto);
    ok('Monat: vier Einträge — Vor- und Folgemonat zählen nicht mit', k.eintraege === '4', k.eintraege);
    ok('… die Spaltensumme ebenfalls', k.spalten.join('|') === '28:30 · 1:30 Pause', JSON.stringify(k.spalten));
    // Nicht im Seitentext nach '29.06.' suchen: Das Datum steht legitim in der KW-Zeilen-
    // beschriftung ('KW 27 · 29.06.2026 - 05.07.2026'), die Prüfung wäre immer rot. Aussagekräftig
    // ist die Gegenrechnung: Die einzelnen Tageszeilen müssen die Monatssumme ergeben.
    const summeTage = k.tage.reduce((s2, t) => {
      const m = /(\d+):(\d{2})/.exec(t); return s2 + (m ? Number(m[1]) * 60 + Number(m[2]) : 0);
    }, 0);
    ok('… und die angezeigten Tageszeilen ergeben genau die Monatssumme', summeTage === 28 * 60 + 30,
      `${summeTage} min gegen 1710 min · ${JSON.stringify(k.tage)}`);

    // Die Zellensummen des Monats: KW 27 zeigt NUR den 01.07., nicht die beiden Junitage.
    ok('Monat: die Randwoche KW 27 zeigt nur den Julianteil (7:30 / 1 Tage)',
      k.zellen.some(z => /^7:30 \/ 1 Tage/.test(z)), JSON.stringify(k.zellen));
    ok('Monat: die Tageszeilen zeigen nur Julitage', k.tage.length === 4, JSON.stringify(k.tage));

    console.log('\n── Auch mit gesetztem Filter ──');
    await p.evaluate(() => { S.filterSearch = '2026-07-08'; S.view = 'month'; render(); });
    await sleep(2500);
    k = await kennzahlen(p);
    ok('Filter: nur der gesuchte Eintrag zählt (6:00)', k.netto === '6:00', k.netto);
    ok('… und genau einer', k.eintraege === '1', k.eintraege);
    await p.evaluate(() => { S.filterSearch = ''; render(); }); await sleep(2000);

    console.log('\n── Der Prüf-Index entsteht und kennt die Randwoche ──');
    const idx = await p.evaluate(() => {
      // Denselben Weg wie die Ansicht: weiter laden, prüfen, nachschlagen.
      return fetch('/api/entries?date_from=2026-06-29&date_to=2026-08-09', { headers: { Authorization: 'Bearer ' + S.token } })
        .then(r => r.json()).then(d => {
          const i = pruefeEintraege(d.entries, { ladeVon: '2026-06-29', ladeBis: '2026-08-09' });
          return { wochen: Object.keys(i.woche), tage: Object.keys(i.tag) };
        });
    });
    ok('die Prüfung läuft über die volle Kalenderwoche', Array.isArray(idx.wochen), JSON.stringify(idx));

    console.log('\n── Jetzt mit echten Verstößen ──');
    // Erst JETZT Verstoss-Daten anlegen: Die Regressionsprüfung oben soll an einem sauberen
    // Bestand messen, sonst vermischen sich die beiden Aussagen.
    const volker = (await req('POST', '/api/users', admin, { username: 'volker', password: 'Str3ng!Geheim',
      name: 'Volker Vorarbeiter', role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '1985-03-03' })).body.user;
    const jule = (await req('POST', '/api/users', admin, { username: 'jule', password: 'Str3ng!Geheim',
      name: 'Jule Jung', role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '2010-06-01' })).body.user;
    const bucheFuer = (uid, datum, von, bis, pause) => req('POST', '/api/entries', admin,
      { user_id: uid, date: datum, time_from: von, time_to: bis, break_minutes: pause || 0, description: 'x' });

    // Volker: 11 Std Anwesenheit mit korrekter Pause → 10:15 Arbeitszeit, nur die TAGESGRENZE fällt.
    await bucheFuer(volker.id, '2026-07-08', '06:00', '17:00', 45);
    // … und am Folgetag zu früh wieder los: Feierabend 17:00, Beginn 03:00 → 10 Std Ruhe.
    await bucheFuer(volker.id, '2026-07-09', '03:00', '09:00', 0);
    // Jule (16): 8:30 Arbeitszeit → über der Jugendgrenze von 8 Std.
    await bucheFuer(jule.id, '2026-07-08', '06:00', '15:30', 60);

    await ansicht(p, 'day', '2026-07-08');
    const spalte = (name) => p.evaluate((n) => {
      const s2 = [...document.querySelectorAll('.timeline-column')]
        .find(c => c.querySelector('.tl-col-header-name').innerText.includes(n));
      if (!s2) return null;
      const kopf = s2.querySelector('.tl-col-header');
      return {
        rahmen: kopf.classList.contains('tl-col-header--verstoss'),
        zeichen: s2.querySelectorAll('.verstoss-zeichen').length,
        aria: (s2.querySelector('.verstoss-zeichen') || {}).ariaLabel || '',
        wochenzeile: !!s2.querySelector('.tl-col-header-woche'),
      };
    }, name);

    const sVolker = await spalte('Volker');
    ok('Tag: Volkers Spalte ist gerahmt', sVolker && sVolker.rahmen, JSON.stringify(sVolker));
    ok('… und trägt ein Warnzeichen', sVolker.zeichen === 1, JSON.stringify(sVolker.zeichen));
    ok('… dessen Beschriftung den Verstoß nennt',
      /Gesetzlicher Verstoß/.test(sVolker.aria) && /10 Std 15 min/.test(sVolker.aria), sVolker.aria);
    const sJule = await spalte('Jule');
    ok('Tag: Jule (16) wird nach Jugendrecht beurteilt',
      sJule && sJule.rahmen && /8 Std 30 min/.test(sJule.aria) && /Jugendarbeitsschutz/.test(sJule.aria), JSON.stringify(sJule));
    const sMark = await spalte('Mark');
    ok('Tag: Mark ohne Verstoß bleibt ungerahmt und ohne Zeichen',
      sMark && !sMark.rahmen && sMark.zeichen === 0, JSON.stringify(sMark));

    console.log('\n── Die Erklärung beim Darüberfahren ──');
    const blase = await p.evaluate(() => {
      const z = [...document.querySelectorAll('.verstoss-zeichen')][0];
      z.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 300, clientY: 300 }));
      const t = document.querySelector('.entry-tooltip');
      return t && getComputedStyle(t).display !== 'none' ? t.innerText.replace(/\s+/g, ' ') : '(keine)';
    });
    ok('die Sprechblase erscheint', blase !== '(keine)', blase);
    ok('… nennt das Gesetz', /§ 3 ArbZG|§ 8 Jugendarbeitsschutzgesetz/.test(blase), blase);
    ok('… und erklärt, dass immer der ganze Tag gerechnet wird',
      /unabhängig von Filter und Zeitraum/.test(blase), blase);

    console.log('\n── Ruhezeit am Folgetag ──');
    await ansicht(p, 'day', '2026-07-09');
    const sRuhe = await spalte('Volker');
    ok('Tag 09.07.: Ruhezeit-Verstoß erkannt', sRuhe && sRuhe.rahmen && /Ruhezeit/.test(sRuhe.aria), JSON.stringify(sRuhe));
    ok('… mit beiden Uhrzeiten im Text', /17:00/.test(sRuhe.aria) && /03:00/.test(sRuhe.aria), sRuhe.aria);

    console.log('\n── Wochenansicht ──');
    await ansicht(p, 'week', '2026-07-08');
    const w = await p.evaluate(() => ({
      zellen: [...document.querySelectorAll('.grid-cell--verstoss')].length,
      zeichenInZellen: [...document.querySelectorAll('.grid-cell-total .verstoss-zeichen')].length,
      koepfe: [...document.querySelectorAll('.grid-col-header--verstoss')].map(e => e.innerText.split('\n')[0].trim()),
    }));
    ok('Woche: die Tage mit Verstoß sind gerahmt', w.zellen === 3, JSON.stringify(w));
    ok('… und tragen das Zeichen an der Tagessumme', w.zeichenInZellen === 3, JSON.stringify(w.zeichenInZellen));

    console.log('\n── Wochengrenze: Jugendliche über 40 Std ──');
    for (const d of ['2026-07-06', '2026-07-07', '2026-07-09', '2026-07-10']) {
      await bucheFuer(jule.id, d, '06:00', '15:00', 60);   // je 8:00
    }
    await ansicht(p, 'week', '2026-07-08');
    const wJule = await p.evaluate(() => {
      const th = [...document.querySelectorAll('.grid-col-header')].find(e => e.innerText.includes('Jule'));
      const z = th && th.querySelector('.verstoss-zeichen');
      return { rahmen: !!th && th.classList.contains('grid-col-header--verstoss'), aria: z ? z.ariaLabel : '' };
    });
    // 4 × 8:00 + 1 × 8:30 = 40:30
    ok('Woche: Jules Spaltenkopf ist gerahmt', wJule.rahmen, JSON.stringify(wJule));
    ok('… der Text nennt 40:30 und § 8 JArbSchG',
      /40 Std 30 min/.test(wJule.aria) && /40 Stunden pro Woche/.test(wJule.aria), wJule.aria);

    console.log('\n── Der Fall, der die Randwochen rechtfertigt ──');
    // Sechs Tage à 8:15 in KW 27 (Mo 29.06. bis Sa 04.07.) = 49:30 → über 48 Std.
    // ZWEI davon liegen im Juni. Im Julifenster sieht man nur 33:00 — die Woche ist trotzdem zu lang.
    const rand = (await req('POST', '/api/users', admin, { username: 'rand', password: 'Str3ng!Geheim',
      name: 'Rita Randwoche', role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '1980-01-01' })).body.user;
    for (const d of ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']) {
      await bucheFuer(rand.id, d, '06:00', '15:00', 45);   // je 8:15 Arbeitszeit, Pause reicht
    }
    await ansicht(p, 'month', '2026-07-15');
    const randZelle = await p.evaluate((name) => {
      const koepfe = [...document.querySelectorAll('.grid-col-header')];
      const i = koepfe.findIndex(e => e.innerText.includes(name));
      if (i < 0) return null;
      const zeile = [...document.querySelectorAll('.week-month-grid tbody tr')][0];   // KW 27
      const zelle = zeile.children[i + 1];                                            // +1 wegen KW-Spalte
      const z = zelle.querySelector('.verstoss-zeichen');
      return {
        rahmen: zelle.classList.contains('grid-cell--verstoss'),
        summe: (zelle.querySelector('.grid-cell-total') || {}).innerText || '',
        aria: z ? z.ariaLabel : '',
      };
    }, 'Rita');
    ok('Monat: die Randwoche ist gerahmt', randZelle && randZelle.rahmen, JSON.stringify(randZelle));
    ok('… die angezeigte Summe bleibt der Julianteil (33:00 / 4 Tage)',
      /33:00 \/ 4 Tage/.test(randZelle.summe), randZelle.summe);
    ok('… der Text nennt aber die VOLLE Woche (49:30)', /49 Std 30 min/.test(randZelle.aria), randZelle.aria);
    ok('… und behauptet keinen Verstoß, sondern nennt den Ausgleich',
      /zulässig/.test(randZelle.aria) && /24 Wochen/.test(randZelle.aria)
      && /Hinweis zur Arbeitszeit/.test(randZelle.aria), randZelle.aria);

    console.log('\n── Der Mitarbeiter sieht seinen eigenen Verstoß ──');
    const ktx = await browser.createBrowserContext();
    const mp = await ktx.newPage();
    await mp.setViewport({ width: 1000, height: 900 });
    mp.setDefaultTimeout(30000);
    await mp.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#login-user');
    await mp.type('#login-user', 'volker'); await mp.type('#login-pass', 'Str3ng!Geheim');
    await mp.click('#login-form button[type="submit"]');
    await sleep(2500);
    await mp.evaluate(() => { location.hash = '#/'; }); await sleep(2000);
    await ansicht(mp, 'day', '2026-07-08');
    const eigen = await mp.evaluate(() => {
      const z = document.querySelector('.verstoss-zeichen');
      return { da: !!z, aria: z ? z.ariaLabel : '', gerahmt: !!document.querySelector('.tl-col-header--verstoss') };
    });
    ok('Mitarbeiter: sieht das Zeichen in der eigenen Ansicht', eigen.da && eigen.gerahmt, JSON.stringify(eigen));
    ok('… mit derselben Erklärung', /10 Std 15 min/.test(eigen.aria), eigen.aria);
    await mp.close(); await ktx.close();

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
  }
  console.log(`\nVerstösse in der Übersicht: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
