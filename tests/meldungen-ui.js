// Meldungen — Oberfläche: Board, Melden, Knöpfe je Recht, Stand, History, Themen (Alex, 30.09.2026).
//
// Geprüft in der echten App, wie Alex es beschrieben hat: Themen NEBENEINANDER wie das Auftrags-Board (am Handy
// seitlich wischen), „+ Melden" am Thema, jeder sieht alle offenen Meldungen; Knöpfe nur, wo der Server es
// erlaubt (Melder: bearbeiten/zurückziehen solange offen; Chef: Stand, Rückmeldung; Admin: endgültig löschen);
// erledigt → History mit Suche; Thema löschen → seine offenen Meldungen in der History; eine neue Meldung
// erscheint beim Chef ohne Neuladen (Live).
//
//   node tests/meldungen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3359, DB = '/tmp/meldungen-ui.db', LOG = '/tmp/meldungen-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
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
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: adminPw })).body.token;
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter'], ['moritz', 'Moritz Muster', 'mitarbeiter']]) {
      await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r });
    }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async (handy) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      p.on('dialog', d => d.dismiss());
      await p.setViewport(handy ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 900 });
      p.setDefaultTimeout(15000);
      return p;
    };
    const anmelden = async (p, u, pw = 'Test1234!') => {
      await p.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', pw);
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(500);
    };
    const zu = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForFunction(() => !document.querySelector('.main .loading')); await sleep(400); };
    const klick = async (p, sel) => { await p.waitForSelector(sel, { visible: true }); await p.click(sel); await sleep(350); };
    const spalten = (p) => p.evaluate(() => [...document.querySelectorAll('.mld-col')].map(c => ({
      name: c.querySelector('.board-col-head').childNodes[0].textContent.trim(),
      karten: [...c.querySelectorAll('.mld-karte')].map(k => k.querySelector('.mld-text').textContent.trim()) })));
    const knoepfe = (p) => p.evaluate(() => [...document.querySelectorAll('.mld-detail button')].map(b => b.textContent.trim()));
    const detailZu = async (p) => { await p.evaluate(() => { const b = document.querySelector('.mld-detail [data-act="zu"]'); if (b) b.click(); }); await sleep(300); };
    const karteOeffnen = async (p, text) => {
      await p.evaluate((t) => [...document.querySelectorAll('.mld-karte')].find(k => k.textContent.includes(t)).click(), text);
      await p.waitForSelector('.mld-detail'); await sleep(300);
    };

    console.log('Chef: Themen anlegen');
    const C = await neueSeite(false);
    await anmelden(C, 'carla');
    ok('Menüpunkt „Meldungen" im Seitenmenü', await C.evaluate(() => !!document.querySelector('a[href="#/meldungen"]')));
    await zu(C, '/meldungen');
    ok('ohne Themen: Hinweis + „Themen anlegen"', await C.evaluate(() => !!document.getElementById('mld-themen-leer')));
    await klick(C, '#mld-themen-leer');
    for (const n of ['Allgemein', 'Auto 1', 'Auto 2', 'Papiermüll']) {
      await C.type('#mld-t-neu', n); await C.keyboard.press('Enter'); await sleep(400);
    }
    const themenListe = () => C.evaluate(() => [...document.querySelectorAll('.mld-t-name')].map(x => x.textContent));
    ok('vier Themen im Dialog', JSON.stringify(await themenListe()) === JSON.stringify(['Allgemein', 'Auto 1', 'Auto 2', 'Papiermüll']), JSON.stringify(await themenListe()));
    await C.evaluate(() => [...document.querySelectorAll('#mld-t-liste li')].find(li => li.textContent.includes('Auto 2')).querySelector('[data-t="hoch"]').click());
    await sleep(500);
    ok('↑ sortiert um', JSON.stringify(await themenListe()) === JSON.stringify(['Allgemein', 'Auto 2', 'Auto 1', 'Papiermüll']), JSON.stringify(await themenListe()));
    await klick(C, '.modal [data-act="zu"]');
    await sleep(500);
    ok('Board: Themen nebeneinander, in dieser Reihenfolge', JSON.stringify((await spalten(C)).map(s => s.name)) === JSON.stringify(['Allgemein', 'Auto 2', 'Auto 1', 'Papiermüll']),
      JSON.stringify(await spalten(C)));
    ok('… wirklich nebeneinander (gleiche Höhe, wachsendes x)', await C.evaluate(() => {
      const r = [...document.querySelectorAll('.mld-col')].map(c => c.getBoundingClientRect());
      return r.length === 4 && r.every((x, i) => i === 0 || (Math.abs(x.top - r[i - 1].top) < 2 && x.left > r[i - 1].left));
    }));

    console.log('Mitarbeiterin meldet (Handy)');
    const A = await neueSeite(true);
    await anmelden(A, 'anna');
    await zu(A, '/meldungen');
    ok('Handy: die Spalten scrollen seitlich, die Seite selbst nicht', await A.evaluate(() => {
      const s = document.querySelector('.board-scroll');
      return s.scrollWidth > s.clientWidth + 50 && document.documentElement.scrollWidth <= window.innerWidth + 1;
    }));
    ok('Mitarbeiterin sieht kein „Themen verwalten"', await A.evaluate(() => !document.getElementById('mld-themen')));
    await A.evaluate(() => document.querySelector('.mld-col[data-thema-id] .mld-melden') && [...document.querySelectorAll('.mld-col')].find(c => c.textContent.includes('Auto 2')).querySelector('.mld-melden').click());
    await A.waitForSelector('#mld-f-text'); await sleep(300);
    ok('Formular: Thema „Auto 2" vorgewählt', await A.evaluate(() => { const s = document.getElementById('mld-f-thema'); return s.options[s.selectedIndex].text === 'Auto 2'; }));
    await A.click('.modal [data-act="ok"]'); await sleep(300);
    ok('leer abschicken: Hinweis im Formular, nichts gemeldet', await A.evaluate(() => {
      const f = document.getElementById('mld-f-fehler'); return f && f.style.display !== 'none' && /beschreibe/.test(f.textContent);
    }));
    await A.type('#mld-f-text', 'Ölwechsel fällig');
    await A.click('#mld-f-dringend');
    await A.click('.modal [data-act="ok"]'); await sleep(900);
    const auto2 = (await spalten(A)).find(s => s.name === 'Auto 2');
    ok('Meldung steht in „Auto 2" — mit 🔴', auto2 && auto2.karten.length === 1 && /🔴/.test(auto2.karten[0]) && /Ölwechsel fällig/.test(auto2.karten[0]), JSON.stringify(auto2));
    ok('Karte: von wem, wann, Stand „offen"', await A.evaluate(() => {
      const k = document.querySelector('.mld-karte');
      return /Anna Berger · \d\d\.\d\d\.\d{4}, \d\d:\d\d/.test(k.querySelector('.mld-meta').textContent) && k.querySelector('.mld-status').textContent.trim() === 'offen';
    }));

    console.log('Live beim Chef');
    await C.waitForFunction(() => [...document.querySelectorAll('.mld-karte')].some(k => k.textContent.includes('Ölwechsel')), { timeout: 8000 }).catch(() => {});
    ok('die neue Meldung erscheint beim Chef ohne Neuladen', await C.evaluate(() => [...document.querySelectorAll('.mld-karte')].some(k => k.textContent.includes('Ölwechsel'))));

    console.log('Knöpfe je Recht');
    await karteOeffnen(A, 'Ölwechsel');
    let k = await knoepfe(A);
    ok('Melderin (offen): Bearbeiten + Zurückziehen, kein Stand, kein Löschen',
      k.includes('Bearbeiten') && k.includes('Zurückziehen') && !k.includes('In Arbeit') && !k.includes('Endgültig löschen') && !k.some(x => /Rückmeldung/.test(x)), JSON.stringify(k));
    await detailZu(A);
    const M = await neueSeite(true);
    await anmelden(M, 'moritz');
    await zu(M, '/meldungen');
    await karteOeffnen(M, 'Ölwechsel');
    k = await knoepfe(M);
    ok('anderer Mitarbeiter: sieht sie, darf nichts (nur Schließen)', JSON.stringify(k) === JSON.stringify(['Schließen']), JSON.stringify(k));
    ok('… aber den Verlauf', await M.evaluate(() => /Anna Berger/.test(document.querySelector('.mld-verlauf').textContent)));
    await detailZu(M);
    await karteOeffnen(C, 'Ölwechsel');
    k = await knoepfe(C);
    ok('Chef: In Arbeit, Erledigt, Bearbeiten, Rückmeldung — kein Zurückziehen, kein endgültiges Löschen',
      ['In Arbeit', 'Erledigt', 'Bearbeiten', 'Rückmeldung schreiben'].every(x => k.includes(x)) && !k.includes('Zurückziehen') && !k.includes('Endgültig löschen'), JSON.stringify(k));

    console.log('Stand und Rückmeldung');
    await C.evaluate(() => document.querySelector('.mld-detail [data-status="in_arbeit"]').click()); await sleep(900);
    ok('„In Arbeit" → Karte zeigt „in Arbeit · Carla Chef"', await C.evaluate(() => [...document.querySelectorAll('.mld-karte')]
      .some(k => k.textContent.includes('Ölwechsel') && k.querySelector('.mld-status').textContent.trim() === 'in Arbeit · Carla Chef')));
    await karteOeffnen(C, 'Ölwechsel');
    await C.evaluate(() => document.querySelector('.mld-detail [data-act="rueck"]').click());
    await C.waitForSelector('#pm-input'); await C.type('#pm-input', 'Werkstatt am 05.10.');
    await C.evaluate(() => document.querySelector('.modal-overlay:last-of-type [data-act="ok"]').click()); await sleep(900);
    ok('Rückmeldung steht auf der Karte', await C.evaluate(() => [...document.querySelectorAll('.mld-rueck')].some(r => r.textContent.includes('Werkstatt am 05.10.'))));
    await A.waitForFunction(() => [...document.querySelectorAll('.mld-rueck')].some(r => r.textContent.includes('Werkstatt')), { timeout: 8000 }).catch(() => {});
    ok('… und bei der Melderin (live)', await A.evaluate(() => [...document.querySelectorAll('.mld-rueck')].some(r => r.textContent.includes('Werkstatt am 05.10.'))));
    await karteOeffnen(A, 'Ölwechsel');
    k = await knoepfe(A);
    ok('Melderin: jetzt kein Bearbeiten/Zurückziehen mehr (in Arbeit)', !k.includes('Bearbeiten') && !k.includes('Zurückziehen'), JSON.stringify(k));
    await detailZu(A);
    await karteOeffnen(C, 'Ölwechsel');
    await C.evaluate(() => document.querySelector('.mld-detail [data-status="erledigt"]').click()); await sleep(900);
    ok('„Erledigt" → weg vom Board', await C.evaluate(() => ![...document.querySelectorAll('.mld-karte')].some(k => k.textContent.includes('Ölwechsel'))));

    console.log('History');
    await klick(C, '[data-mld-ansicht="history"]');
    ok('History zeigt sie — mit Thema, Stand „erledigt · Carla Chef"', await C.evaluate(() => {
      const k = [...document.querySelectorAll('.mld-hist-liste .mld-karte')].find(x => x.textContent.includes('Ölwechsel'));
      return k && k.querySelector('.mld-thema').textContent.includes('Auto 2') && k.querySelector('.mld-status').textContent.trim() === 'erledigt · Carla Chef';
    }));
    await karteOeffnen(C, 'Ölwechsel');
    const verlauf = await C.evaluate(() => [...document.querySelectorAll('.mld-verlauf li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()));
    ok('Verlauf: gemeldet, in Arbeit, Rückmeldung, erledigt — mit Namen', verlauf.length === 4 && /Anna Berger hat gemeldet/.test(verlauf[0])
      && /Carla Chef Stand: offen → in Arbeit/.test(verlauf[1]) && /Rückmeldung/.test(verlauf[2]) && /in Arbeit → erledigt/.test(verlauf[3]), JSON.stringify(verlauf));
    ok('History-Knopf „Wieder öffnen"', (await knoepfe(C)).includes('Wieder öffnen'));
    await detailZu(C);
    await C.type('#mld-hist-q', 'ÖLWECHSEL'); await sleep(1200);
    ok('Suche (Groß/klein egal)', await C.evaluate(() => document.querySelectorAll('.mld-hist-liste .mld-karte').length === 1));
    await C.evaluate(() => { const f = document.getElementById('mld-hist-q'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(1200);
    await klick(C, '[data-mld-ansicht="offen"]');

    console.log('Thema löschen mit offener Meldung');
    await req('POST', '/api/meldungen', (await req('POST', '/api/auth/login', null, { username: 'moritz', password: 'Test1234!' })).body.token,
      { thema_id: (await req('GET', '/api/meldungen', admin)).body.themen.find(t => t.name === 'Papiermüll').id, text: 'Tonne voll' });
    await sleep(900);
    await klick(C, '#mld-themen');
    await C.evaluate(() => [...document.querySelectorAll('#mld-t-liste li')].find(li => li.textContent.includes('Papiermüll')).querySelector('[data-t="loeschen"]').click());
    await C.waitForFunction(() => [...document.querySelectorAll('.modal p')].some(p => /noch offen/.test(p.textContent)));
    ok('Rückfrage nennt die offene Meldung und die History', await C.evaluate(() => [...document.querySelectorAll('.modal p')].some(p => /1 Meldung ist noch offen/.test(p.textContent) && /History/.test(p.textContent))));
    await C.evaluate(() => [...document.querySelectorAll('.modal-overlay')].pop().querySelector('[data-act="ok"]').click()); await sleep(700);
    await klick(C, '.modal [data-act="zu"]'); await sleep(600);
    ok('Spalte „Papiermüll" ist weg', !(await spalten(C)).some(s => s.name === 'Papiermüll'));
    await klick(C, '[data-mld-ansicht="history"]');
    ok('„Tonne voll" steht in der History — „(Thema gelöscht)", Stand noch „offen"', await C.evaluate(() => {
      const k = [...document.querySelectorAll('.mld-hist-liste .mld-karte')].find(x => x.textContent.includes('Tonne voll'));
      return k && /Thema gelöscht/.test(k.querySelector('.mld-thema').textContent) && k.querySelector('.mld-status').textContent.trim() === 'offen';
    }));
    await karteOeffnen(C, 'Tonne voll');
    ok('dort nur noch zu lesen (nur Schließen)', JSON.stringify(await knoepfe(C)) === JSON.stringify(['Schließen']), JSON.stringify(await knoepfe(C)));
    await detailZu(C);

    console.log('Admin');
    const AD = await neueSeite(false);
    await anmelden(AD, 'admin', adminPw);
    await zu(AD, '/meldungen');
    await klick(AD, '[data-mld-ansicht="history"]');
    await karteOeffnen(AD, 'Ölwechsel');
    ok('Admin: „Endgültig löschen"', (await knoepfe(AD)).includes('Endgültig löschen'));
    await AD.evaluate(() => document.querySelector('.mld-detail [data-act="loeschen"]').click());
    await AD.waitForFunction(() => [...document.querySelectorAll('.modal p')].some(p => /endgültig löschen/.test(p.textContent)));
    await AD.evaluate(() => [...document.querySelectorAll('.modal-overlay')].pop().querySelector('[data-act="ok"]').click()); await sleep(900);
    ok('… gelöscht, auch aus der History', await AD.evaluate(() => ![...document.querySelectorAll('.mld-karte')].some(k => k.textContent.includes('Ölwechsel'))));

    console.log('Einzelrecht im Mitarbeiterformular');
    await zu(AD, '/users');
    const anna = (await req('GET', '/api/users', admin)).body.users.find(u => u.username === 'anna');
    await AD.evaluate((u) => { showUserModal(u); }, anna);
    await AD.waitForSelector('#um-can-meldungen');
    ok('Mitarbeiterin: Häkchen „Meldungen bearbeiten" sichtbar', await AD.evaluate(() => document.getElementById('um-can-meldungen').checkVisibility()));
    await AD.evaluate(() => { const r = document.getElementById('um-role'); r.value = 'chef'; r.dispatchEvent(new Event('change', { bubbles: true })); });
    ok('Rolle Chef: ausgeblendet (hat es per Rolle)', await AD.evaluate(() => !document.getElementById('um-can-meldungen').checkVisibility()));
    await AD.evaluate(() => { const r = document.getElementById('um-role'); r.value = 'mitarbeiter'; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await AD.click('#um-can-meldungen');
    const knopf = await AD.evaluate(() => { const b = document.getElementById('um-can-meldungen').closest('form').querySelector('button[type="submit"]'); b.click(); return b.textContent.trim(); });
    await sleep(1200);
    const annaNachher = (await req('GET', '/api/users', admin)).body.users.find(u => u.username === 'anna');
    ok(`„${knopf}": Anna hat das Recht`, annaNachher.can_meldungen === 1,
      JSON.stringify({ recht: annaNachher.can_meldungen, toast: await AD.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')),
        dialoge: await AD.evaluate(() => [...document.querySelectorAll('.modal h3')].map(h => h.textContent)) }));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nMeldungen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
