// Was wird aus den Aufträgen, wenn jemand die Firma verlässt?
//
// Alex hat das am 15.09.2026 gefragt, bevor es passiert ist — die beste Zeit für solche Fragen.
// Gemessen ergaben sich drei Anforderungen, und alle drei hängen an EINER Eigenschaft: Die
// Nutzerliste fürs Board muss Ausgeschiedene ENTHALTEN (`/api/users/list?all=1`). Ohne sie
//
//   * sähe die Spalte einer Ausgeschiedenen aus wie jede andere,
//   * und ihr Haken verschwände beim Bearbeiten ihres eigenen Auftrags — wer dort nur die Notiz
//     ändert und speichert, entfernt die Zuweisung STILLSCHWEIGEND (das Formular schickt nur die
//     angehakten Kästchen). Der Auftrag rutscht nach „Nicht zugewiesen", ohne dass es jemand
//     wollte oder merkte.
//
// Genau das war der Zustand vor dem 15.09.2026: Im Code stand die Ausnahme `active !== 0 ||
// assignedIds.has(u.id)` schon da — sie konnte nur nie greifen, weil die Liste den Ausgeschiedenen
// gar nicht enthielt. Eine Bedingung, die nach jemandem sucht, der nicht in der Liste steht.
//
//   node tests/board-ausgeschieden-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3322, DB = '/tmp/board-ausgeschieden.db', LOG = '/tmp/board-ausgeschieden.log';
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
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    // Berliner Datum, nicht UTC: Zwischen 0 und 2 Uhr ist `toISOString()` noch „gestern" — der Server
    // legt Anna aber mit dem Berliner Datum an, und ein Austritt VOR dem Eintritt wird abgewiesen.
    // Genau so gescheitert in der Nacht auf den 25.09.2026, 00:1x Uhr.
    const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

    const PW = 'Monteur1!';
    const anna = (await req('POST', '/api/users', admin, { username: 'anna', password: PW,
      name: 'Anna Anders', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    const bodo = (await req('POST', '/api/users', admin, { username: 'bodo', password: PW,
      name: 'Bodo Beck', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;

    const allein  = (await req('POST', '/api/projects', admin, { name: 'Nur Anna', assigned_user_ids: [anna.id] })).body.project;
    const zuZweit = (await req('POST', '/api/projects', admin, { name: 'Anna und Bodo', assigned_user_ids: [anna.id, bodo.id] })).body.project;
    const fremd   = (await req('POST', '/api/projects', admin, { name: 'Nur Bodo', assigned_user_ids: [bodo.id] })).body.project;

    const aus = await req('POST', `/api/users/${anna.id}/deactivate`, admin, { employed_until: heute });
    ok('Anna ist ausgestellt', aus.status === 200, aus.status + ' ' + aus.text.slice(0, 80));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    // JEDE Prüfung in einer FRISCHEN Sitzung: Die Nutzerliste liegt in einer Modulvariablen und
    // wird nur nachgeladen, wenn sie leer ist — in derselben Sitzung misst man den Stand von vorher.
    const frisch = async () => {
      const ktx = await browser.createBrowserContext();
      const s = await ktx.newPage();
      await s.setViewport({ width: 1300, height: 900 });
      s.setDefaultTimeout(30000);
      await s.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await s.waitForSelector('#login-user');
      await s.type('#login-user', 'admin'); await s.type('#login-pass', pw('admin'));
      await s.click('#login-form button[type="submit"]'); await sleep(2600);
      await s.goto(BASIS + '/#/projects', { waitUntil: 'domcontentloaded' }); await sleep(2500);
      return { ktx, s };
    };
    const auswahl = (s) => s.evaluate(() => [...document.querySelectorAll('.pf2-assignee')]
      .map(cb => ({ name: cb.parentElement.textContent.replace(/\s+/g, ' ').trim(), an: cb.checked })));
    const formularOeffnen = async (s, projektName) => {
      if (!projektName) { await s.evaluate(() => document.getElementById('fab-new').click()); }
      else {
        await s.evaluate((n) => {
          const t = [...document.querySelectorAll('.proj-tile')].find(x => x.textContent.includes(n));
          if (t) t.click();
        }, projektName);
        await sleep(1000);
        await s.evaluate((n) => {
          const t = [...document.querySelectorAll('.proj-tile')].find(x => x.textContent.includes(n));
          const b = t && [...t.querySelectorAll('button')].find(x => /bearbeiten/i.test(x.textContent));
          if (b) b.click();
        }, projektName);
      }
      await s.waitForSelector('.pf2-assignee', { timeout: 15000 });
      await sleep(700);
    };

    // ── 1. Die Spalte bleibt — gekennzeichnet und am Ende ────────────────────────────────────
    console.log('\n── Die Spalte einer Ausgeschiedenen ──');
    let a = await frisch();
    const spalten = await a.s.evaluate(() => [...document.querySelectorAll('.board-col')].map(c => ({
      name: (c.querySelector('.board-col-head') || {}).textContent.replace(/\s+/g, ' ').trim(),
      aus: !!c.querySelector('.board-aus'),
      kacheln: c.querySelectorAll('.proj-tile').length,
    })));
    const annaSpalte = spalten.find(x => /Anna Anders/.test(x.name));
    ok('der Auftrag fällt NICHT nach „Nicht zugewiesen"', !!annaSpalte && annaSpalte.kacheln === 2,
      JSON.stringify(spalten));
    ok('… die Spalte ist als „ausgeschieden" gekennzeichnet', !!annaSpalte && annaSpalte.aus,
      JSON.stringify(annaSpalte));
    ok('… und steht ganz am Ende', spalten[spalten.length - 1] === annaSpalte, JSON.stringify(spalten.map(x => x.name)));
    ok('… die Aktiven stehen davor und unmarkiert',
      spalten.filter(x => x.aus).length === 1, JSON.stringify(spalten.map(x => [x.name, x.aus])));
    await a.s.close(); await a.ktx.close();

    // ── 2. Zuteilen: nur noch Aktive ─────────────────────────────────────────────────────────
    console.log('\n── Neu zuteilen darf man sie nicht mehr ──');
    a = await frisch();
    await formularOeffnen(a.s, null);
    const neu = await auswahl(a.s);
    ok('bei einem NEUEN Auftrag fehlt sie', !neu.some(x => /Anna/.test(x.name)),
      JSON.stringify(neu.map(x => x.name)));
    ok('… die Aktiven stehen alle da', neu.length === 4, JSON.stringify(neu.map(x => x.name)));
    await a.s.close(); await a.ktx.close();

    a = await frisch();
    await formularOeffnen(a.s, 'Nur Bodo');
    const fremdAuswahl = await auswahl(a.s);
    ok('bei einem FREMDEN Auftrag fehlt sie ebenfalls',
      !fremdAuswahl.some(x => /Anna/.test(x.name)), JSON.stringify(fremdAuswahl.map(x => x.name)));
    await a.s.close(); await a.ktx.close();

    // ── 3. Ihr eigener Auftrag behält den Haken ──────────────────────────────────────────────
    console.log('\n── Ihr eigener Auftrag behält den Haken ──');
    a = await frisch();
    await formularOeffnen(a.s, 'Anna und Bodo');
    const eigen = await auswahl(a.s);
    const annaZeile = eigen.find(x => /Anna/.test(x.name));
    ok('sie steht im Formular ihres Auftrags', !!annaZeile, JSON.stringify(eigen.map(x => x.name)));
    ok('… und ist angehakt', !!annaZeile && annaZeile.an, JSON.stringify(annaZeile));
    ok('… mit dem Hinweis, warum', !!annaZeile && /ausgeschieden/i.test(annaZeile.name), JSON.stringify(annaZeile));

    // DIE ENTSCHEIDENDE PRÜFUNG: bloss speichern darf die Zuweisung NICHT verlieren.
    await a.s.evaluate(() => {
      const f = document.getElementById('pf2-note');
      if (f) { f.value = 'Notiz geändert, sonst nichts'; f.dispatchEvent(new Event('input', { bubbles: true })); }
      const b = [...document.querySelectorAll('button')].find(x => /^Speichern/i.test(x.textContent.trim()));
      if (b) b.click();
    });
    await sleep(2200);
    const nachher = (await req('GET', '/api/projects', admin)).body.projects.find(x => x.name === 'Anna und Bodo');
    ok('nach blossem Speichern ist sie NOCH zugewiesen',
      (nachher.assigned_users || []).some(u => u.user_id === anna.id),
      JSON.stringify((nachher.assigned_users || []).map(u => u.name)));
    ok('… und Bodo natürlich auch',
      (nachher.assigned_users || []).some(u => u.user_id === bodo.id),
      JSON.stringify((nachher.assigned_users || []).map(u => u.name)));
    await a.s.close(); await a.ktx.close();

    // ── 4. Ohne Zuweisungen verschwindet die Spalte von allein ───────────────────────────────
    console.log('\n── Ohne Aufträge ist die Spalte weg ──');
    await req('PUT', `/api/projects/${allein.id}`, admin, { name: 'Nur Anna', assigned_user_ids: [] });
    await req('PUT', `/api/projects/${zuZweit.id}`, admin, { name: 'Anna und Bodo', assigned_user_ids: [bodo.id] });
    a = await frisch();
    const danach = await a.s.evaluate(() => [...document.querySelectorAll('.board-col-head')]
      .map(c => c.textContent.replace(/\s+/g, ' ').trim()));
    ok('die Spalte verschwindet von allein', !danach.some(x => /Anna Anders/.test(x)), JSON.stringify(danach));
    ok('… und der freigegebene Auftrag steht unter „Nicht zugewiesen"',
      await a.s.evaluate(() => {
        const c = [...document.querySelectorAll('.board-col')]
          .find(x => /Nicht zugewiesen/.test(x.querySelector('.board-col-head').textContent));
        return !!c && [...c.querySelectorAll('.proj-tile')].some(t => t.textContent.includes('Nur Anna'));
      }));
    await a.s.close(); await a.ktx.close();
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }

  console.log(`\nAusgeschiedene im Board: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
