// Die unangenehmen Fälle rund um Anwesenheit, Warnung und Pausenvorschlag.
//
// Nachgereicht nach dem Deploy vom 30.07.2026 — ausgedacht als „womit könnte man das kaputtkriegen?".
// Fünf Lagen, bei denen eine naive Summe oder eine verwechselte Person falsch liegen würde:
//
//   A  TEILWEISE Überlappung (07–12 und 11–16): 9 Std Anwesenheit, nicht 10.
//   B  Ein Eintrag liegt VOLLSTÄNDIG in einem anderen (07–17 und 09–12): 10 Std, nicht 13.
//   C  Drei getrennte Blöcke mit Lücken (07–09, 11–13, 15–17): 6 Std Anwesenheit, aber 10 Std
//      Spanne — hier darf das Gesetz NICHT anspringen.
//   D  Der Admin bucht FÜR JEMAND ANDEREN: Alter und Tag müssen dem Gewählten gehören, nicht dem
//      Angemeldeten. Sonst bekäme der Azubi die Erwachsenen-Regel, nur weil der Chef tippt.
//   E  Ein KOLLEGE hat am selben Tag 12 Stunden: darf nicht durchschlagen.
//
//   node tests/hoechstzeit-komplex-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3219, DB = '/tmp/hoechstzeit-komplex.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const jahre = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
const MA = { role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 };
const tagNr = n => new Date(Date.now() - (n + 2) * 864e5).toISOString().slice(0, 10);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/hoechstzeit-komplex-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/hoechstzeit-komplex-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    await req('PUT', '/api/settings', admin.token, { break_minutes_default: 30 });
    const neu = async (u, name, alter) => {
      const r = await req('POST', '/api/users', admin.token,
        { username: u, password: 'Start!2345', name, birth_date: jahre(alter), ...MA });
      if (r.status >= 300) throw new Error(u + ': ' + r.text);
      return r.body.user;
    };
    const gerd = await neu('gerd', 'Gerd Gross', 40);
    const azubi = await neu('azubi', 'Anton Azubi', 16);
    const kollege = await neu('kollege', 'Kai Kollege', 30);
    const buchen = (uid, tag, von, bis, pause) => req('POST', '/api/entries', admin.token,
      { date: tag, time_from: von, time_to: bis, break_minutes: pause, user_id: uid })
      .then(r => { if (r.status >= 300) throw new Error('Buchung: ' + r.text); return r.body; });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);
    await page.evaluateOnNewDocument(() => {
      const E = Date; const b = new E(); b.setHours(19, 0, 0, 0); const v = b.getTime() - E.now();
      function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
      G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
    });
    const anmelden = async (n, p) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', n); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);
    };
    // fuerId: nur als Admin — dann wird zuerst der Mitarbeiter gewaehlt.
    async function messen(datum, von, bis, pause, fuerId) {
      await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(400);
      await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ef-break'); await sleep(800);
      if (fuerId) {
        await page.evaluate(id => { const s = document.getElementById('ef-user'); s.value = String(id); s.dispatchEvent(new Event('change', { bubbles: true })); }, fuerId);
        await sleep(1200);
      }
      await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
      await sleep(1200);
      await page.evaluate((v, b, p) => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to'), br = document.getElementById('ef-break');
        f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
        if (p !== null && p !== undefined) { br.value = String(p); br.dispatchEvent(new Event('change', { bubbles: true })); }
      }, von, bis, pause);
      await sleep(1600);
      return {
        pause: await page.evaluate(() => document.getElementById('ef-break').value),
        hinweis: await page.evaluate(() => { const e = document.getElementById('ef-break-hinweis'); return e && e.checkVisibility && e.checkVisibility() ? e.innerText : ''; }),
        warnung: await page.evaluate(() => { const e = document.getElementById('ef-zeit-warnung'); return e && e.checkVisibility && e.checkVisibility() ? e.innerText : ''; }),
      };
    }

    await anmelden('gerd', 'Start!2345');

    console.log('\n── A  Teilweise Überlappung (07–12 und 11–16) ──────────');
    const tA = tagNr(0);
    await buchen(gerd.id, tA, '07:00', '12:00', 0);
    await buchen(gerd.id, tA, '11:00', '16:00', 0);       // 1 Std Überschneidung → 9 Std Anwesenheit
    let m = await messen(tA, '16:00', '18:00', 0);        // → 11 Std Anwesenheit, 11 Std Arbeit
    ok('A: Warnung, denn zusammen sind es 11 Std', /11 Std/.test(m.warnung), `„${m.warnung}"`);
    // Den HINWEIS in einem eigenen Durchgang ablesen, OHNE die Pause anzufassen: Sobald jemand die
    // Pause von Hand setzt, friert der Hinweis ein (gewolltes „manuell geändert"-Verhalten). Genau
    // daran ist dieser Test beim ersten Lauf hängengeblieben und zeigte den Stand von vorher.
    m = await messen(tA, '16:00', '18:00', null);
    ok('A: der Pausenhinweis nennt ebenfalls 11 Std Anwesenheit (nicht 12)',
      /11 Std Anwesenheit/.test(m.hinweis), `„${m.hinweis}"`);

    console.log('\n── B  Eintrag liegt VOLLSTÄNDIG in einem anderen ───────');
    const tB = tagNr(1);
    await buchen(gerd.id, tB, '07:00', '17:00', 60);
    await buchen(gerd.id, tB, '09:00', '12:00', 0);       // komplett innerhalb → 10 Std Anwesenheit
    m = await messen(tB, '17:00', '17:30', 0);            // → 10,5 Std Anwesenheit, 9,5 Std Arbeit
    ok('B: keine Warnung (9,5 Std Arbeit, nicht 13)', m.warnung === '', `„${m.warnung}"`);
    ok('B: Anwesenheit wird als 10 Std 30 min gelesen', /10 Std 30 min Anwesenheit/.test(m.hinweis), `„${m.hinweis}"`);

    console.log('\n── C  Drei Blöcke mit Lücken: 6 Std in 10 Std Spanne ───');
    const tC = tagNr(2);
    for (const [v, b] of [['07:00', '09:00'], ['11:00', '13:00']]) await buchen(gerd.id, tC, v, b, 0);
    m = await messen(tC, '15:00', '17:00', null);         // Vorschlag NICHT setzen — er ist das Prüfobjekt
    ok('C: Vorschlag bleibt bei der Firmenpause (30), keine Anhebung', m.pause === '30', `${m.pause} min · „${m.hinweis}"`);
    ok('C: kein Gesetz im Hinweis — 6 Std Anwesenheit', !/Arbeitszeitgesetz/.test(m.hinweis), `„${m.hinweis}"`);
    ok('C: keine Höchstzeit-Warnung', m.warnung === '', `„${m.warnung}"`);

    console.log('\n── D  Admin bucht FÜR den Azubi ────────────────────────');
    await anmelden('admin', pw('admin'));
    const tD = tagNr(3);
    m = await messen(tD, '07:00', '16:30', 60, azubi.id);  // 8,5 Std Arbeit
    ok('D: Warnung nach dem JUGENDarbeitsschutzgesetz', /Jugendarbeitsschutzgesetz/.test(m.warnung), `„${m.warnung}"`);
    ok('D: … und nicht nach dem Arbeitszeitgesetz der Erwachsenen', !/§ 3 ArbZG/.test(m.warnung), `„${m.warnung}"`);
    m = await messen(tD, '07:00', '16:30', 60, gerd.id);   // derselbe Tag, aber ein Erwachsener
    ok('D: für den Erwachsenen am selben Tag KEINE Warnung', m.warnung === '', `„${m.warnung}"`);

    console.log('\n── E  Der Kollege hat am selben Tag 12 Stunden ─────────');
    const tE = tagNr(4);
    await buchen(kollege.id, tE, '06:00', '18:00', 0);
    await anmelden('gerd', 'Start!2345');
    m = await messen(tE, '08:00', '12:00', 0);
    ok('E: fremde Stunden schlagen nicht durch — keine Warnung', m.warnung === '', `„${m.warnung}"`);
    m = await messen(tE, '08:00', '12:00', null);        // Hinweis wieder ohne Handanlegen ablesen
    ok('E: … und auch der Pausenhinweis bleibt beim eigenen Tag (4 Std, nicht 12)',
      !/12 Std/.test(m.hinweis), `„${m.hinweis}"`);
    ok('E: der Vorschlag ist die Firmenpause, unbeeinflusst vom Kollegen', m.pause === '30', `${m.pause} min`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nKomplexe Lagen: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
