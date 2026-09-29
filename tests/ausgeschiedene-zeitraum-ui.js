// Ausgeschiedene nur im Zeitraum ihrer Anstellung (29.09.2026).
//
// Alex: „[Ein] inzwischen ausgestellter Mitarbeiter wird noch in der Statistik in allen Ansichten
// angezeigt. Es sollen nur die Mitarbeiter angezeigt werden, die in dem ausgewählten Zeitraum ganz oder
// teilweise angestellt waren." Die Suche fand dasselbe an vier weiteren Stellen. Aufbau: Tim war im VORJAHR
// vom 01.01. bis 30.06. angestellt (ausgestellt), Anna durchgehend, Nora fängt erst heute an. Geprüft:
//   Statistik (Schnittstelle): Monat/Jahr/Gesamt, mit und ohne Auswahl; gebuchte Stunden nach dem Austritt
//     halten ihn im Zeitraum (sonst verschwänden sie). Oberfläche: Auswahl-Knöpfe folgen dem Zeitraum.
//   Planung Tages- und Wochenansicht: Spalte nur für im Zeitraum Angestellte — auch für Ausgeschiedene, solange
//     sie es waren (vorher: nur Aktive, egal wann), und nicht für Neue vor ihrem Beginn.
//   Urlaubsübersicht: im Jahr Angestellte — Tim im Vorjahr (gekennzeichnet), nicht im laufenden Jahr.
//   Abwesenheits-Formular „Für": keine Ausgestellten.
//   PDF-Nachweis: Auswahlliste folgt dem Zeitraum; fällt der Gewählte heraus, steht wieder „Alle" da.
//
//   node tests/ausgeschiedene-zeitraum-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3356, DB = '/tmp/ausgeschiedene-zeitraum.db', LOG = '/tmp/ausgeschiedene-zeitraum.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const Y1 = new Date().getFullYear() - 1, Y = Y1 + 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const id = {};
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Durchgehend', 'mitarbeiter'], ['tim', 'Tim Ausgeschieden', 'mitarbeiter'], ['nora', 'Nora Neu', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r })).body.user.id;
    }
    const chef = (await req('POST', '/api/auth/login', null, { username: 'carla', password: 'Test1234!' })).body.token;
    const soll = (u, ab) => req('POST', `/api/statistics/targets/${id[u]}`, chef, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: ab });
    await soll('anna', `${Y1}-01-01`); await soll('tim', `${Y1}-01-01`);
    // Tim bucht noch nach seinem späteren Austritt (Nachtrag im August) — solche Stunden dürfen nicht verschwinden
    const nachtrag = await req('POST', '/api/entries', admin, { user_id: id.tim, date: `${Y1}-08-10`, time_from: '07:00', time_to: '12:00', break_minutes: 0 });
    const aus = await req('POST', `/api/users/${id.tim}/deactivate`, admin, { employed_until: `${Y1}-06-30` });
    // Die Tagesansicht zeigt an Tagen ohne jede Planung bewusst gar keine Spalten — deshalb je Prüftag eine
    for (const tag of [`${Y1}-09-15`, `${Y1}-05-15`]) {
      await req('POST', '/api/planning', chef, { date: tag, time_from: '07:00', time_to: '15:00', client: 'Probe', assigned_user_ids: [id.anna] });
    }
    ok('Aufbau: Tim bis 30.06. des Vorjahres angestellt und ausgestellt', aus.status === 200 && nachtrag.status < 300, JSON.stringify({ aus: aus.body, n: nachtrag.status }));

    console.log('Statistik (Schnittstelle)');
    const namen = async (q) => { const r = (await req('GET', '/api/statistics?' + q, chef)).body;
      return { zeilen: (r.users || []).map(u => u.user_name).sort(), knoepfe: (r.angestellt || []).length }; };
    const hat = (x, n) => x.zeilen.includes(n);
    let x = await namen(`period=month&date=${Y1}-09-15`);
    ok('September Vorjahr: Tim fehlt, Anna da', !hat(x, 'Tim Ausgeschieden') && hat(x, 'Anna Durchgehend'), JSON.stringify(x));
    x = await namen(`period=month&date=${Y1}-06-15`);
    ok('Juni Vorjahr (letzter Monat): Tim da', hat(x, 'Tim Ausgeschieden'), JSON.stringify(x));
    x = await namen(`period=month&date=${Y1}-07-15`);
    ok('Juli Vorjahr: Tim fehlt', !hat(x, 'Tim Ausgeschieden'), JSON.stringify(x));
    x = await namen(`period=month&date=${Y1}-08-15`);
    ok('August Vorjahr: Tim da — er hat dort noch gebucht (Stunden verschwinden nicht)', hat(x, 'Tim Ausgeschieden'), JSON.stringify(x));
    x = await namen(`period=year&date=${Y1}-03-01`);
    ok('Jahr Vorjahr: Tim da (teilweise angestellt), Nora nicht (erst später eingestellt)', hat(x, 'Tim Ausgeschieden') && !hat(x, 'Nora Neu'), JSON.stringify(x));
    x = await namen(`period=year&date=${Y}-03-01`);
    ok('laufendes Jahr: Tim fehlt, Nora da', !hat(x, 'Tim Ausgeschieden') && hat(x, 'Nora Neu'), JSON.stringify(x));
    x = await namen(`period=total&date=${Y}-03-01`);
    ok('Gesamt: Tim da', hat(x, 'Tim Ausgeschieden'), JSON.stringify(x));
    x = await namen(`period=month&date=${Y1}-09-15&user_ids=${id.tim},${id.anna}`);
    ok('Auswahl „Tim + Anna" im September Vorjahr: nur Anna (Tim war nicht angestellt)', JSON.stringify(x.zeilen) === '["Anna Durchgehend"]', JSON.stringify(x));
    x = await namen(`period=month&date=${Y1}-09-15&user_ids=${id.tim}`);
    ok('Auswahl nur „Tim" im September Vorjahr: bleibt niemand → wieder alle Angestellten', !hat(x, 'Tim Ausgeschieden') && hat(x, 'Anna Durchgehend'), JSON.stringify(x));

    console.log('Urlaubsübersicht');
    const ue = async (j) => ((await req('GET', `/api/absences/vacation-overview?year=${j}`, chef)).body.rows || []);
    const u1 = await ue(Y1), u0 = await ue(Y);
    const timZeile = u1.find(r => r.name === 'Tim Ausgeschieden');
    ok('Vorjahr: Tim dabei, als ausgestellt gekennzeichnet; Nora nicht', !!timZeile && timZeile.ausgestellt === true && !u1.some(r => r.name === 'Nora Neu'), JSON.stringify(u1.map(r => r.name)));
    ok('laufendes Jahr: Tim nicht, Nora dabei', !u0.some(r => r.name === 'Tim Ausgeschieden') && u0.some(r => r.name === 'Nora Neu'), JSON.stringify(u0.map(r => r.name)));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1200, height: 900 });
    p.setDefaultTimeout(15000);
    p.on('pageerror', e => jsFehler.push(e.message));
    await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
    await p.type('#login-user', 'carla'); await p.type('#login-pass', 'Test1234!');
    await p.click('#login-form button[type="submit"]');
    await p.waitForFunction(() => document.querySelector('.main')); await sleep(600);
    const hin = async (r, bereit) => { await p.evaluate((r) => { location.hash = r; }, r); await p.waitForFunction(bereit, { timeout: 15000 }); await sleep(500); };

    console.log('Statistik (Oberfläche): Auswahl-Knöpfe');
    await hin('/statistics', () => !!document.querySelector('.stats-chips'));
    const knoepfe = async (datum) => {
      await p.evaluate((d) => { S.statsPeriod = 'month'; S.statsDate = new Date(d + 'T12:00:00'); renderStatisticsContent(); }, datum);
      await sleep(1500);
      return p.evaluate(() => [...document.querySelectorAll('.stats-chips .emp-chip')].map(b => b.textContent.trim()));
    };
    let k = await knoepfe(`${Y1}-09-15`);
    ok('September Vorjahr: kein Knopf für Tim, einer für Anna', !k.some(t => /Tim/.test(t)) && k.some(t => /Anna/.test(t)), JSON.stringify(k));
    k = await knoepfe(`${Y1}-05-15`);
    ok('Mai Vorjahr: Knopf für Tim (ausgestellt)', k.some(t => /Tim Ausgeschieden/.test(t)), JSON.stringify(k));
    const tabelle = await p.evaluate(() => document.querySelector('.main').innerText);
    ok('… und Tim steht in der Tabelle', /Tim Ausgeschieden/.test(tabelle));

    console.log('Planung Tagesansicht');
    await hin('/planning', () => !!document.querySelector('.main') && !document.querySelector('.main .spinner'));
    const spalten = async (datum) => {
      await p.evaluate((d) => { S.planningView = 'day'; S.planningDate = new Date(d + 'T12:00:00'); renderPlanningContent(); }, datum);
      await sleep(1500);
      return p.evaluate(() => [...document.querySelectorAll('.tl-col-header-name')].map(e => e.textContent.trim()));
    };
    let sp = await spalten(`${Y1}-09-15`);
    ok('September Vorjahr: keine Spalte für Tim, eine für Anna', !sp.some(t => /Tim/.test(t)) && sp.some(t => /Anna/.test(t)), JSON.stringify(sp));
    sp = await spalten(`${Y1}-05-15`);
    ok('Mai Vorjahr: Spalte für Tim', sp.some(t => /Tim/.test(t)), JSON.stringify(sp));
    const wochenSpalten = async (datum) => {
      await p.evaluate((d) => { S.planningView = 'week'; S.planningDate = new Date(d + 'T12:00:00'); renderPlanningContent(); }, datum);
      await sleep(1500);
      return p.evaluate(() => [...document.querySelectorAll('.grid-col-header')].map(e => e.textContent.trim()));
    };
    let wo = await wochenSpalten(`${Y1}-09-15`);
    ok('Wochenansicht September Vorjahr: kein Tim, Anna ja, Nora nein (fängt erst heute an)', !wo.some(t => /Tim/.test(t)) && wo.some(t => /Anna/.test(t)) && !wo.some(t => /Nora/.test(t)), JSON.stringify(wo));
    wo = await wochenSpalten(`${Y1}-05-15`);
    ok('Wochenansicht Mai Vorjahr: Tim ja (vorher fehlte er dort, obwohl angestellt)', wo.some(t => /Tim/.test(t)), JSON.stringify(wo));
    await p.evaluate(() => { S.planningView = 'day'; });

    console.log('Abwesenheits-Formular');
    await hin('/absences', () => !!document.getElementById('absence-new-btn'));
    await p.click('#absence-new-btn'); await p.waitForSelector('#abs-user');
    const fuer = await p.evaluate(() => [...document.querySelectorAll('#abs-user option')].map(o => o.textContent.trim()));
    ok('„Für": Anna ja, Tim (ausgestellt) nein', fuer.some(t => /Anna/.test(t)) && !fuer.some(t => /Tim/.test(t)), JSON.stringify(fuer));
    await p.click('#abs-cancel'); await sleep(300);

    console.log('PDF-Nachweis');
    await hin('/pdf', () => !!document.getElementById('pdf-user'));
    const liste = async (von, bis) => {
      await p.evaluate((von, bis) => { const per = document.getElementById('pdf-period'); per.value = 'custom'; per.dispatchEvent(new Event('change'));
        const f = document.getElementById('pdf-from'), t = document.getElementById('pdf-to'); f.value = von; t.value = bis;
        f.dispatchEvent(new Event('change')); t.dispatchEvent(new Event('change')); }, von, bis);
      await sleep(200);
      return p.evaluate(() => ({ optionen: [...document.querySelectorAll('#pdf-user option')].map(o => o.textContent.trim()), wert: document.getElementById('pdf-user').value }));
    };
    let l = await liste(`${Y1}-05-01`, `${Y1}-05-31`);
    ok('Mai Vorjahr: Tim wählbar', l.optionen.some(t => /Tim/.test(t)), JSON.stringify(l));
    await p.select('#pdf-user', String(id.tim));
    l = await liste(`${Y1}-09-01`, `${Y1}-09-30`);
    ok('September Vorjahr: Tim nicht mehr wählbar, Auswahl zurück auf „Alle Mitarbeiter"', !l.optionen.some(t => /Tim/.test(t)) && l.wert === '', JSON.stringify(l));
    await p.evaluate(() => { const per = document.getElementById('pdf-period'); per.value = 'month'; per.dispatchEvent(new Event('change')); }); await sleep(200);
    const aktuell = await p.evaluate(() => [...document.querySelectorAll('#pdf-user option')].map(o => o.textContent.trim()));
    ok('aktueller Monat: Tim nicht, Nora ja', !aktuell.some(t => /Tim/.test(t)) && aktuell.some(t => /Nora/.test(t)), JSON.stringify(aktuell));
    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nAusgeschiedene nur im Zeitraum: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
