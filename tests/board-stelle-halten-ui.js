// Bleibt die Stelle, an der ich arbeite? (Alex, 15.09.2026)
//
// Das Board scrollt waagerecht. Wer ganz rechts an einer Kategorie arbeitet, will nach dem
// Bearbeiten eines Auftrags GENAU DORT weitermachen — nicht wieder oben links anfangen. Dasselbe
// gilt fuer den gewaehlten Reiter (Alle / Mitarbeiter / Kategorien).
//
// Vier davon funktionierten schon, als Alex danach fragte; sie stehen hier, damit sie nicht
// unbemerkt kaputtgehen. Neu ist nur der letzte Fall: die Reiterwahl ueberlebt jetzt auch das
// Schliessen und Wiederoeffnen der App.
//
// WORAUF ZU ACHTEN IST: Das Fenster muss SCHMAL genug sein, dass das Board ueberhaupt scrollen
// MUSS. In einem breiten Fenster ist scrollLeft immer 0, und der Test waere aus dem falschen Grund
// gruen. Deshalb prueft er zuerst, dass scrollWidth groesser als clientWidth ist.
//
//   node tests/board-stelle-halten-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3324, DB = '/tmp/board-stelle-halten.db', LOG = '/tmp/board-stelle-halten.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;

    // Acht Kategorien mit je einem Auftrag: genug Spalten, dass waagerecht gescrollt werden muss.
    const kats = [];
    for (const n of ['Kleinarbeiten', 'PV-Anlagen', 'Wartung', 'Zählerschrank', 'Notdienst', 'Planung', 'Abnahme', 'Sonstiges'])
      kats.push((await req('POST', '/api/projects/kategorien', admin, { name: n })).body.kategorie);
    for (let i = 0; i < kats.length; i++)
      await req('POST', '/api/projects', admin, { name: 'Auftrag ' + (i + 1), client: 'Kunde ' + (i + 1), category_ids: [kats[i].id] });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 900, height: 800 });   // schmal: das Board MUSS scrollen
    seite.setDefaultTimeout(30000);
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));
    const anmelden = async () => {
      await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await seite.waitForSelector('#login-user');
      await seite.evaluate(() => { document.getElementById('login-user').value = ''; document.getElementById('login-pass').value = ''; });
      await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pw);
      await seite.click('#login-form button[type="submit"]'); await sleep(2600);
    };
    await anmelden();

    const zustand = () => seite.evaluate(() => {
      const sc = document.querySelector('.board-scroll');
      return {
        ansicht: (document.querySelector('.board-ansicht-btn.active') || {}).dataset?.ansicht || null,
        scroll: sc ? Math.round(sc.scrollLeft) : -1,
        scrollbar: sc ? sc.scrollWidth > sc.clientWidth + 20 : false,
      };
    });
    const zumBoard = async () => { await seite.goto(BASIS + '/#/projects', { waitUntil: 'domcontentloaded' }); await sleep(2500); };
    const reiter = async (w) => { await seite.evaluate((x) => {
      const b = [...document.querySelectorAll('.board-ansicht-btn')].find(y => y.dataset.ansicht === x); if (b) b.click();
    }, w); await sleep(2200); };
    const nachRechts = async () => { await seite.evaluate(() => { document.querySelector('.board-scroll').scrollLeft = 900; }); await sleep(600); };
    const kachelAuf = async () => {
      for (let i = 0; i < 3; i++) {
        if (await seite.evaluate(() => !!document.querySelector('.proj-tile.expanded'))) return;
        await seite.evaluate(() => { const t = document.querySelectorAll('.proj-tile'); if (t.length) t[t.length - 1].click(); });
        await sleep(1400);
      }
    };
    const bearbeiten = async () => { await seite.evaluate(() => {
      const t = [...document.querySelectorAll('.proj-tile.expanded')][0];
      const b = t && [...t.querySelectorAll('button')].find(x => /bearbeiten/i.test(x.textContent + (x.title || '')));
      if (b) b.click();
    }); await seite.waitForSelector('#projekt-form', { timeout: 15000 }); await sleep(900); };

    console.log('── Die Messung muss ueberhaupt etwas messen koennen ──');
    await zumBoard(); await reiter('kategorien'); await nachRechts();
    let z = await zustand();
    ok('das Board scrollt waagerecht (sonst waere jede Zusicherung hohl)', z.scrollbar, JSON.stringify(z));
    ok('… und steht nach rechts gescrollt', z.scroll > 300, JSON.stringify(z));
    ok('… im Reiter „Kategorien"', z.ansicht === 'kategorien', z.ansicht);
    const stelle = z.scroll;

    console.log('\n── Eine Kachel aufklappen ──');
    await kachelAuf();
    z = await zustand();
    ok('Reiter bleibt', z.ansicht === 'kategorien', z.ansicht);
    ok('Stelle bleibt', z.scroll === stelle, z.scroll + ' statt ' + stelle);

    console.log('\n── Bearbeiten und SPEICHERN ──');
    await bearbeiten();
    ok('das Formular ist offen', await seite.evaluate(() => !!document.getElementById('projekt-form')));
    await seite.evaluate(() => { const b = [...document.querySelectorAll('#projekt-form button')]
      .find(x => /Speichern|Änderungen|erstellen/i.test(x.textContent)); if (b) b.click(); });
    await sleep(2600);
    z = await zustand();
    ok('nach dem Speichern: Reiter bleibt „Kategorien"', z.ansicht === 'kategorien', z.ansicht);
    ok('nach dem Speichern: Stelle bleibt', z.scroll === stelle, z.scroll + ' statt ' + stelle);

    console.log('\n── Bearbeiten und ZURUECK (ohne zu speichern) ──');
    await reiter('kategorien'); await nachRechts(); await kachelAuf(); await bearbeiten();
    await seite.evaluate(() => { const b = document.getElementById('pf2-back'); if (b) b.click(); });
    await sleep(2400);
    z = await zustand();
    ok('nach „Zurück": Reiter bleibt', z.ansicht === 'kategorien', z.ansicht);
    ok('nach „Zurück": Stelle bleibt', z.scroll === stelle, z.scroll + ' statt ' + stelle);

    console.log('\n── Ausflug in einen anderen Menuepunkt ──');
    await reiter('kategorien');
    await seite.goto(BASIS + '/#/dashboard', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    await zumBoard();
    z = await zustand();
    ok('nach der Rueckkehr steht wieder „Kategorien" an', z.ansicht === 'kategorien', z.ansicht);

    console.log('\n── App schliessen und wieder oeffnen ──');
    await reiter('alle');
    await seite.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
    z = await zustand();
    ok('nach dem Neustart steht „Alle" an — die Wahl ueberlebt das Schliessen',
      z.ansicht === 'alle', z.ansicht);
    ok('… und sie liegt auf DIESEM Geraet, nicht am Konto',
      await seite.evaluate(() => localStorage.getItem('board_ansicht')) === 'alle',
      await seite.evaluate(() => localStorage.getItem('board_ansicht')));

    // Gegenprobe: ein kaputter Wert darf die Seite nicht lahmlegen, sondern faellt zurueck.
    await seite.evaluate(() => localStorage.setItem('board_ansicht', 'quatsch'));
    await seite.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
    z = await zustand();
    ok('ein unbekannter gemerkter Wert faellt still auf „Mitarbeiter" zurueck',
      z.ansicht === 'mitarbeiter', z.ansicht);

    // Und noch eine: ohne gemerkten Wert (frisches Geraet) bleibt es bei der alten Voreinstellung.
    await seite.evaluate(() => localStorage.removeItem('board_ansicht'));
    await seite.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
    z = await zustand();
    ok('auf einem frischen Geraet steht weiterhin „Mitarbeiter" an', z.ansicht === 'mitarbeiter', z.ansicht);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }

  console.log(`\nBoard: die Stelle halten: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
