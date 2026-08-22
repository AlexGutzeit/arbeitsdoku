// Arbeitsbeginn je Mitarbeiter + Zeit-Vorbelegung, die nie unmöglich ist.
//
// Die Uhrzeit wird im Browser GESTELLT (Date überschrieben). Ohne das würde der Test nur prüfen,
// zu welcher Tageszeit er zufällig läuft — genau der Fehler, der entwurf-sicherung-ui um 06:15
// rot gemacht hat, obwohl am Code nichts falsch war.
//   node tests/arbeitsbeginn-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3156, DB = '/tmp/arbeitsbeginn.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const heute = new Date().toLocaleDateString('sv-SE');

// Stellt die Uhr des Browsers auf HH:MM des HEUTIGEN Tages — vor dem Laden der Seite, damit die
// App beim Aufbau schon die gestellte Zeit sieht.
async function uhrStellen(page, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  await page.evaluateOnNewDocument((stunde, minute) => {
    const Echt = Date;
    const basis = new Echt();
    basis.setHours(stunde, minute, 0, 0);
    const versatz = basis.getTime() - Echt.now();
    // Date so ersetzen, dass „jetzt" verschoben ist, feste Zeitstempel aber unveraendert bleiben.
    function Gestellt(...args) {
      if (args.length === 0) return new Echt(Echt.now() + versatz);
      return new Echt(...args);
    }
    Gestellt.prototype = Echt.prototype;
    Gestellt.now = () => Echt.now() + versatz;
    Gestellt.parse = Echt.parse;
    Gestellt.UTC = Echt.UTC;
    window.Date = Gestellt;
  }, h, m);
}

const werte = p => p.evaluate(() => ({
  von: document.getElementById('ef-from')?.value,
  bis: document.getElementById('ef-to')?.value,
  pause: document.getElementById('ef-break')?.value,
}));

// Frischer Tab mit gestellter Uhr, angemeldet über den gemerkten Anmeldestand.
async function tabMitUhr(browser, ctx, hhmm, hash) {
  const p = await ctx.newPage();
  await p.setViewport({ width: 1100, height: 900 });
  await uhrStellen(p, hhmm);
  await p.goto(BASE + '/' + (hash || ''), { waitUntil: 'networkidle2' });
  await sleep(2600);
  return p;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/arbeitsbeginn-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/arbeitsbeginn-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;

    // ── Backend: Vorgabe, Setzen, Ablehnen ────────────────────────────────
    console.log('Arbeitsbeginn speichern:');
    // birth_date gesetzt: Ohne Geburtsdatum nimmt die App vorsichtshalber „unter 18" an und
    // schlaegt nach Jugendarbeitsschutzgesetz laengere Pausen vor. Hier geht es um den
    // Arbeitsbeginn, nicht um die Alterstabellen (die stehen in pause-jugendschutz-ui.js).
    const VOLLJAEHRIG = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 35); return d.toLocaleDateString('sv-SE'); })();
    const frueh = (await req('POST', '/api/users', admin, { username: 'frueh', password: 'Test1234!', name: 'Frieda Früh', role: 'mitarbeiter', work_start: '06:00', birth_date: VOLLJAEHRIG })).body.user;
    ok('angelegt mit 06:00', frueh && frueh.work_start === '06:00', JSON.stringify(frueh && frueh.work_start));
    const normal = (await req('POST', '/api/users', admin, { username: 'normal', password: 'Test1234!', name: 'Norbert Normal', role: 'mitarbeiter', birth_date: VOLLJAEHRIG })).body.user;
    ok('ohne Angabe → leer (= Firmenwert)', normal && !normal.work_start, JSON.stringify(normal && normal.work_start));

    for (const mist of ['25:99', 'abc', '7', '07:5']) {
      const r = await req('PUT', '/api/users/' + normal.id, admin, { work_start: mist });
      ok(`Unsinn „${mist}" wird abgelehnt (400)`, r.status === 400, String(r.status));
    }
    const leer = await req('PUT', '/api/users/' + frueh.id, admin, { work_start: '' });
    ok('leeres Feld → folgt wieder dem Firmenwert', leer.status === 200 && !leer.body.user.work_start, JSON.stringify(leer.body && leer.body.user && leer.body.user.work_start));
    await req('PUT', '/api/users/' + frueh.id, admin, { work_start: '06:00' });   // wiederherstellen

    const audit = await req('GET', '/api/audit?action=user_update', admin);
    ok('Änderung steht im Audit-Log', JSON.stringify(audit.body || {}).includes('Arbeitsbeginn'),
      JSON.stringify(audit.body).slice(0, 140));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx = await browser.createBrowserContext();
    // Einmal anmelden, danach lebt der Anmeldestand im Kontext weiter
    {
      const p0 = await ctx.newPage();
      await p0.goto(BASE, { waitUntil: 'networkidle2' });
      await p0.waitForSelector('#login-user');
      await p0.type('#login-user', 'frueh'); await p0.type('#login-pass', 'Test1234!');
      await p0.click('#login-form button[type="submit"]');
      await p0.waitForSelector('a[href="#/planning"]');
      await p0.close();
    }

    // ── Die Kernregel, mit gestellter Uhr ─────────────────────────────────
    console.log('Vorbelegung bei Arbeitsbeginn 06:00 (Frieda):');
    let p = await tabMitUhr(browser, ctx, '05:30', '#/entry/new');
    ok('Uhr wurde wirklich gestellt', (await p.evaluate(() => new Date().getHours() + ':' + new Date().getMinutes())).startsWith('5:'),
      await p.evaluate(() => new Date().toTimeString().slice(0, 5)));
    let w = await werte(p);
    ok('vor dem Arbeitsbeginn (05:30) → 05:30 – 05:30', w.von === '05:30' && w.bis === '05:30', JSON.stringify(w));
    await p.close();

    p = await tabMitUhr(browser, ctx, '09:00', '#/entry/new');
    w = await werte(p);
    ok('nach dem Arbeitsbeginn (09:00) → 06:00 – 09:00', w.von === '06:00' && w.bis === '09:00', JSON.stringify(w));
    ok('Pause aus dem Firmenwert vorbelegt (30 min)', String(w.pause) === '30', JSON.stringify(w.pause));
    await p.close();

    // ── Alex' Prüfsteine: früher Start, Arbeit fortsetzen ─────────────────
    console.log('Fortsetzen nach frühem Start (Vorgänger 05:45–06:15, Arbeitsbeginn 07:00):');
    const nb = (await req('POST', '/api/auth/login', null, { username: 'normal', password: 'Test1234!' })).body.token;
    await req('POST', '/api/entries', nb, { date: heute, time_from: '05:45', time_to: '06:15', break_minutes: 0 });
    const ctx2 = await browser.createBrowserContext();
    {
      const p0 = await ctx2.newPage();
      await p0.goto(BASE, { waitUntil: 'networkidle2' });
      await p0.waitForSelector('#login-user');
      await p0.type('#login-user', 'normal'); await p0.type('#login-pass', 'Test1234!');
      await p0.click('#login-form button[type="submit"]');
      await p0.waitForSelector('a[href="#/planning"]');
      await p0.close();
    }
    p = await tabMitUhr(browser, ctx2, '06:45', '#/entry/new');
    w = await werte(p);
    ok('Fall 1 — jetzt 06:45 → 06:15 – 06:45 (nicht 06:45 – 06:45)', w.von === '06:15' && w.bis === '06:45', JSON.stringify(w));
    await p.close();

    p = await tabMitUhr(browser, ctx2, '07:15', '#/entry/new');
    w = await werte(p);
    ok('Fall 2 — jetzt 07:15 → 06:15 – 07:15 (NICHT 07:00 – 07:15)', w.von === '06:15' && w.bis === '07:15', JSON.stringify(w));
    await p.close();

    // ── Vorgänger liegt in der Zukunft (Tag im Voraus gebucht) ────────────
    console.log('Tag im Voraus gebucht:');
    await req('POST', '/api/entries', nb, { date: heute, time_from: '08:00', time_to: '16:00', break_minutes: 0 });
    p = await tabMitUhr(browser, ctx2, '10:00', '#/entry/new');
    w = await werte(p);
    ok('Vorgänger endet 16:00, jetzt 10:00 → 16:00 – 16:00 (keine Überlappung)',
      w.von === '16:00' && w.bis === '16:00', JSON.stringify(w));
    await p.close();

    // ── Admin wechselt den Mitarbeiter → richtiger Arbeitsbeginn ──────────
    console.log('Admin wechselt den Mitarbeiter:');
    const ctx3 = await browser.createBrowserContext();
    {
      const p0 = await ctx3.newPage();
      await p0.goto(BASE, { waitUntil: 'networkidle2' });
      await p0.waitForSelector('#login-user');
      await p0.type('#login-user', 'admin'); await p0.type('#login-pass', apw);
      await p0.click('#login-form button[type="submit"]');
      await p0.waitForSelector('a[href="#/planning"]');
      await p0.close();
    }
    // Eigener Tag ohne Eintraege für Frieda: morgen
    const morgen = new Date(Date.now() + 864e5).toLocaleDateString('sv-SE');
    p = await tabMitUhr(browser, ctx3, '09:00', '#/entry/new');
    await p.evaluate((d) => {
      const el = document.getElementById('ef-date'); el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, morgen);
    await sleep(1500);
    await p.evaluate((id) => {
      const s = document.getElementById('ef-user'); s.value = String(id);
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, frueh.id);
    await sleep(1800);
    w = await werte(p);
    ok('Frieda gewählt → ihr Arbeitsbeginn 06:00', w.von === '06:00', JSON.stringify(w));
    await p.evaluate((id) => {
      const s = document.getElementById('ef-user'); s.value = String(id);
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, normal.id);
    await sleep(1800);
    w = await werte(p);
    ok('Norbert gewählt → sein Arbeitsbeginn 07:00', w.von === '07:00', JSON.stringify(w));

    // Gegenprobe: eine von Hand gesetzte Zeit darf NICHT überschrieben werden
    await p.evaluate(() => {
      const el = document.getElementById('ef-from'); el.value = '11:11';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.evaluate((id) => {
      const s = document.getElementById('ef-user'); s.value = String(id);
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, frueh.id);
    await sleep(1800);
    ok('von Hand gesetzte Zeit bleibt stehen', (await werte(p)).von === '11:11', JSON.stringify(await werte(p)));
    await p.close();

    // ── Feld im Mitarbeiter-Dialog ────────────────────────────────────────
    console.log('Mitarbeiter-Dialog:');
    p = await tabMitUhr(browser, ctx3, '09:00', '#/users');
    const dialog = await p.evaluate((id) => {
      const btn = document.querySelector(`.edit-user[data-id="${id}"]`);
      if (!btn) return 'kein Knopf';
      btn.click(); return 'ok';
    }, frueh.id);
    ok('Dialog geöffnet', dialog === 'ok', String(dialog));
    await sleep(900);
    ok('Feld „Arbeitsbeginn" zeigt den abweichenden Wert 06:00',
      (await p.evaluate(() => document.getElementById('um-work-start')?.value)) === '06:00',
      await p.evaluate(() => document.getElementById('um-work-start')?.value));
    await p.evaluate(() => {
      const el = document.getElementById('um-work-start'); el.value = '05:30';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('user-modal-form').requestSubmit();
    });
    await sleep(2000);
    const nachher = (await req('GET', '/api/users', admin)).body.users.find(u => u.id === frueh.id);
    ok('Änderung im Dialog gespeichert', nachher && nachher.work_start === '05:30', JSON.stringify(nachher && nachher.work_start));

    // ── Firmenwert wirkt auf alle ohne eigenen Wert ───────────────────────
    console.log('Firmenwert aus den Einstellungen:');
    const vorgabe = await req('GET', '/api/settings/arbeitszeit', nb);
    ok('Mitarbeiter darf die Vorgaben lesen', vorgabe.status === 200, String(vorgabe.status));
    ok('Vorgabe ist 07:00 / 8 h / 30 min',
      vorgabe.body.arbeitszeit.work_start_default === '07:00'
      && Number(vorgabe.body.arbeitszeit.work_hours_per_day) === 8
      && Number(vorgabe.body.arbeitszeit.break_minutes_default) === 30, JSON.stringify(vorgabe.body));

    const chefpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: chefpw })).body.token;
    ok('Mitarbeiter darf die vollen Einstellungen NICHT lesen', (await req('GET', '/api/settings', nb)).status === 403);
    for (const mist of [{ work_start_default: '99:00' }, { work_hours_per_day: '0' }, { break_minutes_default: '999' }]) {
      ok(`ungültige Vorgabe abgelehnt: ${JSON.stringify(mist)}`, (await req('PUT', '/api/settings', chef, mist)).status === 400);
    }
    ok('Firmenwert auf 06:30 / 7,5 h / 45 min gesetzt',
      (await req('PUT', '/api/settings', chef, { work_start_default: '06:30', work_hours_per_day: '7,5', break_minutes_default: '45' })).status === 200);

    // Norbert hat KEINEN eigenen Wert → muss dem Firmenwert folgen
    const ctx4 = await browser.createBrowserContext();
    {
      const p0 = await ctx4.newPage();
      await p0.goto(BASE, { waitUntil: 'networkidle2' });
      await p0.waitForSelector('#login-user');
      await p0.type('#login-user', 'normal'); await p0.type('#login-pass', 'Test1234!');
      await p0.click('#login-form button[type="submit"]');
      await p0.waitForSelector('a[href="#/planning"]');
      await p0.close();
    }
    // Tag ohne Eintraege waehlen (heute hat Norbert schon welche)
    const uebermorgen = new Date(Date.now() + 2 * 864e5).toLocaleDateString('sv-SE');
    p = await tabMitUhr(browser, ctx4, '09:00', '#/entry/new');
    await p.evaluate((d) => {
      const el = document.getElementById('ef-date'); el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, uebermorgen);
    await sleep(1800);
    w = await werte(p);
    ok('ohne eigenen Wert gilt der neue Firmenwert 06:30', w.von === '06:30', JSON.stringify(w));
    ok('geänderte Firmen-Pause wird vorbelegt (45 min)', String(w.pause) === '45', JSON.stringify(w.pause));
    await p.close();

    // Frieda hat 05:30 eigenen Wert → bleibt bei sich
    p = await tabMitUhr(browser, ctx, '09:00', '#/entry/new');
    await p.evaluate((d) => {
      const el = document.getElementById('ef-date'); el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, uebermorgen);
    await sleep(1800);
    ok('eigener Wert schlägt den Firmenwert (05:30)', (await werte(p)).von === '05:30', JSON.stringify(await werte(p)));
    await p.close();

    // ── Planung folgt den Firmenwerten ────────────────────────────────────
    console.log('Planung:');
    const ctx5 = await browser.createBrowserContext();
    {
      const p0 = await ctx5.newPage();
      await p0.goto(BASE, { waitUntil: 'networkidle2' });
      await p0.waitForSelector('#login-user');
      await p0.type('#login-user', 'chef'); await p0.type('#login-pass', chefpw);
      await p0.click('#login-form button[type="submit"]');
      await p0.waitForSelector('a[href="#/planning"]');
      await p0.close();
    }
    p = await tabMitUhr(browser, ctx5, '09:00', '#/planning/new');
    const planZeit = await p.evaluate(() => ({
      von: document.getElementById('pf-single-from')?.value,
      bis: document.getElementById('pf-single-to')?.value,
    }));
    // 06:30 + 7,5 h + 45 min = 14:45
    ok('Planung übernimmt die Firmenwerte (06:30 – 14:45)',
      planZeit.von === '06:30' && planZeit.bis === '14:45', JSON.stringify(planZeit));
    await p.close();

    // Zurück auf die Vorgaben — damit ergibt die Planung wieder 07:00–15:30 wie bisher
    await req('PUT', '/api/settings', chef, { work_start_default: '07:00', work_hours_per_day: '8', break_minutes_default: '30' });
    p = await tabMitUhr(browser, ctx5, '09:00', '#/planning/new');
    const planStandard = await p.evaluate(() => ({
      von: document.getElementById('pf-single-from')?.value,
      bis: document.getElementById('pf-single-to')?.value,
    }));
    ok('mit den Vorgabewerten wieder 07:00 – 15:30 wie bisher',
      planStandard.von === '07:00' && planStandard.bis === '15:30', JSON.stringify(planStandard));
    await p.close();

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nArbeitsbeginn: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
