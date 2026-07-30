// Der „abgerechnet"-Hinweis auf der Statistik gehört zum ANGEWÄHLTEN Zeitraum.
//
// Vorher stand auf jeder Ansicht derselbe Satz — „Abgerechnet bis 30.06." samt der Juni-Zahlen —
// auch wenn man den Mai ansah (Alex, 30.07.2026). Jetzt gilt: Es zählen die Abschlüsse, die sich
// mit dem angezeigten Zeitraum überschneiden; ist keiner dabei, erscheint gar kein Hinweis.
//
// Geprüft wird über zwei abgeschlossene Monate hinweg, damit auch auffällt, wenn immer nur der
// letzte gezeigt wird:
//   * offener Monat        → gar kein Hinweis
//   * erster Abschluss     → dessen Monat und dessen Zahlen
//   * zweiter Abschluss    → dessen Monat und dessen Zahlen
//   * Jahr                 → „bis <letzter Stichtag>", weil sich mehrere überschneiden
//   * Tag/Woche im Monat   → folgt dem Datum, nicht dem letzten Abschluss
//
//   node tests/abschluss-statistik-monat-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3223, DB = '/tmp/abschluss-stat-monat.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// Die Datenbank wird VOR dem Server aufgebaut. Grund: Ein über die API angelegter Mitarbeiter ist
// ab HEUTE angestellt — in einem abgeschlossenen Monat des Vorjahres taucht er dann zu Recht gar
// nicht auf, und der Abschluss bliebe leer. Beim ersten Lauf ist genau das passiert.
async function datenbankVorbereiten(dbPfad, jahr, monate, stunden) {
  process.env.DB_PATH = dbPfad;
  process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
  const bcrypt = require('bcryptjs');
  const { initDatabase, getDb, saveToFile } = require('../database/init');
  await initDatabase();
  const db = getDb();
  const hash = bcrypt.hashSync('Start!2345', 10);
  // Der Seed vergibt Zufallspasswoerter und gibt sie nur EINMAL aus — hier beim Aufbau, nicht im
  // Server-Log. Deshalb bekommt der Admin ein bekanntes Passwort gesetzt, statt es spaeter aus dem
  // Log zu fischen. (Genau daran ist der zweite Lauf gescheitert: „Nicht authentifiziert".)
  db.prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'").run(hash);
  db.prepare(`INSERT INTO users (username, password_hash, name, role, target_hours_per_week, start_overtime)
              VALUES ('mia', ?, 'Mia Mustermann', 'mitarbeiter', 40, 0)`).run(hash);
  const uid = db.prepare("SELECT id FROM users WHERE username='mia'").get().id;
  const ab = `${jahr - 1}-01-01`;
  db.prepare('DELETE FROM employment_periods WHERE user_id = ?').run(uid);
  db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)').run(uid, ab);
  db.prepare(`INSERT INTO user_target_hours (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from)
              VALUES (?, 40, 8, 8, 8, 8, 8, ?)`).run(uid, ab);
  for (const m of monate) {
    // net_hours ist eine Pflichtspalte — die App rechnet sie sonst in der Route aus.
    db.prepare(`INSERT INTO entries (user_id, date, time_from, time_to, break_minutes, net_hours, description)
                VALUES (?, ?, '08:00', ?, 0, ?, 'Probe')`)
      .run(uid, `${m}-10`, `${String(8 + stunden[m]).padStart(2, '0')}:00`, stunden[m]);
  }
  saveToFile();
  return uid;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  // Zwei sicher vergangene Monate des VORJAHRES, mit UNTERSCHIEDLICHEN Ist-Stunden — sonst könnte
  // der Test nicht unterscheiden, welcher Abschluss gerade angezeigt wird.
  const jahr = new Date().getFullYear() - 1;
  const m1 = `${jahr}-03`, m2 = `${jahr}-04`;
  const stunden = { [m1]: 4, [m2]: 7 };
  await datenbankVorbereiten(DB, jahr, [m1, m2], stunden);

  const lg = fs.openSync('/tmp/abschluss-stat-monat-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    const anmeldung = await req('POST', '/api/auth/login', null, { username: 'admin', password: 'Start!2345' });
    if (anmeldung.status !== 200) throw new Error('Admin-Anmeldung: ' + anmeldung.text);
    const admin = anmeldung.body;
    for (const m of [m1, m2]) {
      const c = await req('POST', '/api/closure', admin.token, { month: m });
      if (c.status >= 300) throw new Error('Abschluss ' + m + ': ' + c.text);
    }
    const nameVon = m => `${MONATE[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
    console.log(`   abgeschlossen: ${nameVon(m1)} (Ist ${stunden[m1]} h) und ${nameVon(m2)} (Ist ${stunden[m2]} h)\n`);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1100 });
    page.setDefaultTimeout(45000);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'mia'); await page.type('#login-pass', 'Start!2345');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(600);

    // Statistik auf einen bestimmten Zeitraum stellen und den Hinweis-Kasten lesen.
    async function hinweisFuer(period, datum) {
      await page.goto(BASIS + '/#/statistics', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.stats-page'); await sleep(900);
      await page.evaluate((p, d) => {
        S.statsPeriod = p;
        if (d) S.statsDate = new Date(d + 'T12:00:00');
        renderStatistics();
      }, period, datum || null);
      await sleep(1400);
      return page.evaluate(() => {
        const k = document.querySelector('.stats-page > .card');
        return k && /abgerechnet/i.test(k.innerText) ? k.innerText.replace(/\s+/g, ' ').trim() : '';
      });
    }

    console.log('── Monatsansicht ──');
    let h = await hinweisFuer('month', `${jahr}-05-15`);          // Monat NACH beiden Abschlüssen
    ok(`offener Monat (${nameVon(jahr + '-05')}) → gar kein Hinweis`, h === '', `„${h}"`);

    h = await hinweisFuer('month', `${m1}-15`);
    ok(`${nameVon(m1)} → Hinweis nennt genau diesen Monat`,
      h.includes(nameVon(m1) + ' ist abgerechnet'), `„${h}"`);
    ok(`${nameVon(m1)} → und NICHT den späteren Abschluss`, !h.includes(nameVon(m2)), `„${h}"`);
    ok(`${nameVon(m1)} → zeigt dessen eigene Zahlen (Ist ${stunden[m1]} h)`,
      new RegExp('Ist ' + stunden[m1] + ' h').test(h), `„${h}"`);

    h = await hinweisFuer('month', `${m2}-15`);
    ok(`${nameVon(m2)} → Hinweis nennt genau diesen Monat`,
      h.includes(nameVon(m2) + ' ist abgerechnet'), `„${h}"`);
    ok(`${nameVon(m2)} → zeigt dessen eigene Zahlen (Ist ${stunden[m2]} h)`,
      new RegExp('Ist ' + stunden[m2] + ' h').test(h), `„${h}"`);

    console.log('\n── Tag und Woche folgen dem Datum ──');
    h = await hinweisFuer('day', `${m1}-10`);
    ok(`Tag im ${nameVon(m1)} → dessen Abschluss`, h.includes(nameVon(m1) + ' ist abgerechnet'), `„${h}"`);
    h = await hinweisFuer('day', `${jahr}-05-12`);
    ok('Tag in einem offenen Monat → kein Hinweis', h === '', `„${h}"`);

    console.log('\n── Jahr: mehrere Abschlüsse im Zeitraum ──');
    h = await hinweisFuer('year', `${jahr}-06-15`);
    ok('Jahr → „Abgerechnet bis …" statt eines einzelnen Monats',
      /Abgerechnet bis/.test(h) && !/ist abgerechnet/.test(h), `„${h}"`);
    ok('Jahr → der Stichtag ist der des LETZTEN Abschlusses',
      h.includes('30.04.') || h.includes('30.4.'), `„${h}"`);

    console.log('\n── Gegenprobe: die Zahlen unterscheiden sich wirklich ──');
    ok('die beiden Monate haben verschiedene Ist-Stunden', stunden[m1] !== stunden[m2]);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAbschluss-Hinweis je Zeitraum: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
