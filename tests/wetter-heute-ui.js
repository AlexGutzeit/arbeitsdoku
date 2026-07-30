// Die Wetterkarte zeigte den heutigen Tag ZWEIMAL (Alex, 30.07.2026).
//
// Oben steht der stündliche Verlauf von heute — und in der Wochenliste stand „Heute" gleich noch
// einmal, aufgeklappt sogar mit demselben Streifen darunter. Die Liste beginnt jetzt mit MORGEN.
//
// Die Wetterdaten kommen sonst von einem fremden Dienst. Der Test fängt die Anfrage ab und
// antwortet selbst — damit hängt er weder am Netz noch am echten Wetter und kann Tagesgrenzen
// gezielt setzen.
//
//   node tests/wetter-heute-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3221, DB = '/tmp/wetter-heute.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const plusTage = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Vier Tage Stundenwerte bauen: heute + drei Folgetage.
function wetterAntwort(heute) {
  const time = [], temp = [], code = [], rain = [];
  for (let t = 0; t < 4; t++) {
    const tag = plusTage(heute, t);
    for (let s = 0; s < 24; s++) {
      time.push(`${tag}T${String(s).padStart(2, '0')}:00`);
      temp.push(15 + s % 12 + t);
      code.push(t === 0 ? 0 : 3);
      rain.push(t * 5);
    }
  }
  return {
    city: 'Teststadt',
    current: { temperature_2m: 21.5, weather_code: 0, wind_speed_10m: 9.1, relative_humidity_2m: 44 },
    daily: { temperature_2m_max: [27, 26, 25, 24], temperature_2m_min: [14, 13, 12, 11] },
    hourly: { time, temperature_2m: temp, weather_code: code, precipitation_probability: rain },
  };
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/wetter-heute-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/wetter-heute-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1200 });
    page.setDefaultTimeout(45000);
    const heute = new Date().toLocaleDateString('sv-SE');
    const antwort = JSON.stringify(wetterAntwort(heute));
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (/\/api\/settings\/weather/.test(r.url())) {
        return r.respond({ status: 200, contentType: 'application/json', body: antwort });
      }
      r.continue();
    });

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(600);
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.weather-week', { timeout: 20000 }); await sleep(800);

    const zeilen = await page.evaluate(() => [...document.querySelectorAll('.weather-week .ww-item .ww-row')]
      .map(r => r.querySelector('.ww-day') ? r.querySelector('.ww-day').innerText.replace(/\s+/g, ' ').trim() : ''));
    console.log('   Zeilen der Wochenliste:', JSON.stringify(zeilen));

    ok('„Heute" steht NICHT mehr in der Wochenliste', !zeilen.some(z => /Heute/.test(z)), JSON.stringify(zeilen));
    const morgen = new Date(plusTage(heute, 1) + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    ok('die Liste beginnt mit morgen', zeilen.length > 0 && zeilen[0].includes(morgen), `erste Zeile „${zeilen[0]}", erwartet ${morgen}`);
    ok('drei Folgetage stehen in der Liste', zeilen.length === 3, String(zeilen.length));
    const heuteKurz = new Date(heute + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    ok('das heutige Datum taucht in der Liste nirgends auf', !zeilen.some(z => z.includes(heuteKurz)), heuteKurz + ' in ' + JSON.stringify(zeilen));

    // Oben MUSS der heutige Verlauf weiterhin stehen — und zwar genau einmal sichtbar.
    const streifen = await page.evaluate(() => {
      const alle = [...document.querySelectorAll('#welcome-weather .wh-scroll')];
      const sichtbar = alle.filter(e => e.checkVisibility && e.checkVisibility());
      const obenVorWoche = alle.length && document.querySelector('#welcome-weather .weather-week')
        ? alle[0].compareDocumentPosition(document.querySelector('#welcome-weather .weather-week')) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0;
      return { gesamt: alle.length, sichtbar: sichtbar.length, obenVorWoche: !!obenVorWoche };
    });
    ok('der heutige Stundenverlauf steht weiterhin oben', streifen.obenVorWoche, JSON.stringify(streifen));
    ok('… und ist der EINZIGE sichtbare Streifen', streifen.sichtbar === 1, JSON.stringify(streifen));

    // Aufklappen eines Folgetags muss weiter funktionieren.
    await page.click('.weather-week .ww-item .ww-row');
    await sleep(600);
    const nachKlick = await page.evaluate(() => [...document.querySelectorAll('#welcome-weather .wh-scroll')]
      .filter(e => e.checkVisibility && e.checkVisibility()).length);
    ok('Antippen eines Folgetags klappt seinen Verlauf auf', nachKlick === 2, String(nachKlick));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nWetter — heute nur einmal: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
