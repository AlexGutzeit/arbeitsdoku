// Zeitnachweis ↔ Projekt (Alex, 20.10.2026): Wer im Zeitnachweis ein Projekt wählt, sieht dessen
// Zwischenziele und die Live-Projektnotiz direkt im Formular — dieselbe Quelle wie im Board.
//
// Carla (Chef, nicht zugeteilt), Anna und Ben (zugeteilt), Tom (nicht zugeteilt). Geprüft:
//   * Anna wählt „PV Beispiel": Bereich mit Dach / AC-Seite / Abnahme (3-Farb-Auswahl). Die Notiz gibt es
//     noch nicht: leeres Feld „Hier tippen …", angelegt wird NICHTS — erst ihr Antippen legt sie an.
//   * Anna hakt „Dach" ab → Server-Stand + Bens Board live.
//   * Ben ändert „AC-Seite" → Annas Formular zieht nach, ihre Arbeitsbeschreibung bleibt stehen.
//   * Anna schreibt in die Notiz → beim Server; Notizfelder landen NICHT im Eintragsentwurf.
//   * Speichern: Eintrag mit Projekt, Notiz bleibt, Anna ist danach nicht mehr „in der Notiz".
//   * Projektwechsel → anderer Bereich, alte Sitzung beendet; „Kein Projekt" → kein Bereich.
//   * Tom (nicht zugeteilt): nur lesen — Ziele als Punkte, keine Knopfleiste, Bens Text kommt live an;
//     PATCH direkt → 403. Bei einer noch leeren Notiz „noch leer" ohne Anfangen-Feld; fängt Anna sie an,
//     startet sie bei Tom von selbst. Carla (Chef): darf ändern.
//   * Nebenfund: Eintrag eines ERLEDIGTEN Projekts bearbeiten → Projekt steht im Feld, Speichern behält es.
//
//   node tests/zeitnachweis-projekt-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3361, DB = '/tmp/zeitnachweis-projekt-ui.db', LOG = '/tmp/zeitnachweis-projekt-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const FOTO = process.env.FOTO || '';   // Verzeichnis für ein Handy-Foto (optional)
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const gestern = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); };

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
    const id = {}, tok = {};
    for (const [u, n, rolle] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Dach', 'mitarbeiter'], ['ben', 'Ben AC', 'mitarbeiter'], ['tom', 'Tom Springer', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: rolle,
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user.id;
      tok[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    const pv = (await req('POST', '/api/projects', tok.carla, { name: 'PV Beispiel', assigned_user_ids: [id.anna, id.ben],
      milestones: [{ title: 'Dach', est_days: 2 }, { title: 'AC-Seite', est_days: 1 }, { title: 'Abnahme', est_days: 1 }] })).body.project;
    const halle = (await req('POST', '/api/projects', tok.carla, { name: 'Halle Süd', assigned_user_ids: [id.anna] })).body.project;
    const altbau = (await req('POST', '/api/projects', tok.carla, { name: 'Altbau Nord', assigned_user_ids: [id.anna] })).body.project;
    const [dach, ac] = pv.milestones;
    ok('Aufbau: drei Projekte, PV mit drei Zielen', !!(pv && halle && altbau && pv.milestones.length === 3));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async (u, handy) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(u + ': ' + e.message));
      if (handy) await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      else await p.setViewport({ width: 1300, height: 1000 });
      p.setDefaultTimeout(15000);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(400);
      return p;
    };
    const B = '#ef-projekt-bereich';
    const neuerEintrag = async (p) => { await p.evaluate(() => { location.hash = '/entry/new'; }); await p.waitForSelector('#ef-project'); await sleep(300); };
    const waehle = async (p, pid) => { await p.select('#ef-project', pid ? String(pid) : ''); };
    const notizBereit = (p) => p.waitForFunction((b) => { const s = document.querySelector(b + ' #notiz-status');
      return s && /Gespeichert|Nur lesen/.test(s.textContent); }, { timeout: 10000 }, B);
    const bereich = (p) => p.evaluate((b) => { const el = document.querySelector(b);
      return { sichtbar: !!el && el.checkVisibility(), text: el ? el.innerText : '',
        opts: el ? el.querySelectorAll('.ms-opt').length : 0, dots: el ? el.querySelectorAll('.ms-dot').length : 0,
        leiste: !!(el && el.querySelector('#notiz-leiste') && el.querySelector('#notiz-leiste').checkVisibility()),
        nurLesen: !!(el && el.querySelector('#notiz-nur-lesen') && el.querySelector('#notiz-nur-lesen').checkVisibility()),
        tippbar: !!(el && el.querySelector('.ql-editor') && el.querySelector('.ql-editor').isContentEditable),
        notiz: el && el.querySelector('.ql-editor') ? el.querySelector('.ql-editor').innerText : '' }; }, B);
    const aktiv = (p, sel, mid) => p.evaluate((s, m) => { const a = document.querySelector(`${s} .ms-opt.active[data-mid="${m}"]`); return a ? a.dataset.status : null; }, sel, mid);
    const drin = async (pid) => ((await req('GET', `/api/projects/${pid}`, tok.carla)).body.project.notiz || {}).live || [];

    const A = await seite('anna'), Ben = await seite('ben');

    console.log('\nAnna wählt das Projekt');
    await neuerEintrag(A);
    let a = await bereich(A);
    ok('ohne Projekt: kein Bereich', !a.sichtbar, JSON.stringify(a));
    await waehle(A, pv.id);
    await A.waitForFunction((b) => document.querySelectorAll(b + ' .ms-opt').length === 9, {}, B);
    await A.waitForSelector(B + ' #ef-notiz-anfangen');
    await sleep(300);
    ok('Notiz noch nicht da: leeres Feld „Hier tippen …", angelegt ist nichts',
      /Hier tippen/.test(await A.evaluate((b) => document.querySelector(b + ' #ef-notiz-anfangen').innerText, B))
      && (await req('GET', `/api/projects/${pv.id}/notiz`, tok.carla)).body.notiz === null);
    await A.bringToFront();   // ohne Fenster-Fokus setzt Quill keine Schreibmarke (Testfalle, s. notiz-gaeste-ui)
    await A.click(B + ' #ef-notiz-anfangen');
    await notizBereit(A); await sleep(300);
    a = await bereich(A);
    ok('Bereich: Kopf mit Projektname, Dach / AC-Seite / Abnahme mit 3-Farb-Auswahl, Hinweis „gelten sofort"',
      a.sichtbar && /PV Beispiel/.test(a.text) && /Dach/.test(a.text) && /AC-Seite/.test(a.text) && /Abnahme/.test(a.text) && a.opts === 9 && /gelten sofort/.test(a.text), JSON.stringify(a));
    ok('Antippen legt die Notiz an — Live-Notiz zum Mitschreiben: Knopfleiste da, tippbar, Schreibmarke drin',
      a.leiste && a.tippbar && !a.nurLesen && (await A.evaluate(() => !!document.activeElement.closest('.ql-editor')))
      && !!(await req('GET', `/api/projects/${pv.id}/notiz`, tok.carla)).body.notiz, JSON.stringify(a));
    ok('Anna steht jetzt „in der Notiz"', (await drin(pv.id)).includes('Anna Dach'), JSON.stringify(await drin(pv.id)));

    console.log('\nDach abhaken');
    await Ben.evaluate(() => { location.hash = '/projects'; });
    const K = `.proj-tile[data-id="${pv.id}"]`;
    await Ben.waitForSelector(K); await sleep(300);
    await Ben.evaluate((k) => document.querySelector(k + ' .proj-name').click(), K); await sleep(300);
    await A.evaluate((b, m) => document.querySelector(`${b} .ms-opt[data-mid="${m}"][data-status="done"]`).click(), B, dach.id);
    await A.waitForFunction((b, m) => !!document.querySelector(`${b} .ms-opt.active[data-mid="${m}"][data-status="done"]`), { timeout: 8000 }, B, dach.id).catch(() => {});
    const server = (await req('GET', `/api/projects/${pv.id}`, tok.ben)).body.project.milestones.find(m => m.id === dach.id).status;
    ok('Annas Formular zeigt „Dach" erledigt, Server auch', (await aktiv(A, B, dach.id)) === 'done' && server === 'done', server);
    await Ben.waitForFunction((k, m) => !!document.querySelector(`${k} .ms-opt.active[data-mid="${m}"][data-status="done"]`), { timeout: 8000 }, K, dach.id).catch(() => {});
    ok('Bens Board zeigt es live (ohne Neuladen)', (await aktiv(Ben, K, dach.id)) === 'done');

    console.log('\nBen ändert etwas, Anna tippt gerade');
    await A.evaluate(() => { const d = document.getElementById('ef-desc'); d.focus(); });
    await A.keyboard.type('Module montiert');
    await req('PATCH', `/api/projects/${pv.id}/milestones/${ac.id}/status`, tok.ben, { status: 'doing' });
    await A.waitForFunction((b, m) => !!document.querySelector(`${b} .ms-opt.active[data-mid="${m}"][data-status="doing"]`), { timeout: 8000 }, B, ac.id).catch(() => {});
    ok('Annas Formular zieht „AC-Seite: in Arbeit" nach', (await aktiv(A, B, ac.id)) === 'doing');
    ok('… und ihre Arbeitsbeschreibung bleibt stehen', (await A.evaluate(() => document.getElementById('ef-desc').value)) === 'Module montiert');

    console.log('\nNotiz schreiben');
    await A.evaluate(() => { _notizSitzung.quill.setSelection(0, 0, 'user'); });
    await A.keyboard.type('Stringleitungen liegen im Dachboden');
    await A.waitForFunction((b) => /Gespeichert/.test(document.querySelector(b + ' #notiz-status').textContent), { timeout: 8000 }, B);
    // Der Server schreibt den Text 1,5 s nach der letzten Taste in die Tabelle (notizen-live.js)
    let n = null;
    for (let i = 0; i < 30; i++) { n = (await req('GET', `/api/projects/${pv.id}/notiz`, tok.ben)).body.notiz; if (n && /Dachboden/.test(n.body)) break; await sleep(200); }
    ok('Notiztext ist beim Server', n && /Stringleitungen liegen im Dachboden/.test(n.body), n && n.body);
    const entwurf = await A.evaluate(() => { entwuerfeSichern();
      const k = Object.keys(localStorage).find(x => x.startsWith(ENTWURF_PRAEFIX) && x.includes('eintrag:neu'));
      return k ? localStorage.getItem(k) : ''; });
    ok('Eintragsentwurf enthält die Arbeitsbeschreibung, aber keine Notizfelder',
      /Module montiert/.test(entwurf) && !/notiz-/.test(entwurf), entwurf.slice(0, 300));

    console.log('\nSpeichern');
    await A.evaluate((d) => { const el = document.getElementById('ef-date'); el.value = d; el.dispatchEvent(new Event('change', { bubbles: true })); }, gestern());
    await sleep(600);
    await A.evaluate(() => {
      const setze = (i, v) => { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      setze('ef-from', '08:00'); setze('ef-to', '12:00');
    });
    await sleep(600);
    await A.evaluate(() => { const el = document.getElementById('ef-break'); el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await A.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await A.waitForFunction(() => location.hash === '#/' || location.hash === '', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    const eintraege = (await req('GET', `/api/entries?date_from=${gestern()}&date_to=${gestern()}`, tok.anna)).body.entries || [];
    const e1 = eintraege.find(e => e.description === 'Module montiert');
    ok('Eintrag gespeichert mit Projekt PV Beispiel', !!e1 && Number(e1.project_id) === pv.id, JSON.stringify(eintraege.map(e => [e.description, e.project_id])));
    n = (await req('GET', `/api/projects/${pv.id}/notiz`, tok.ben)).body.notiz;
    ok('Notiz bleibt nach dem Speichern', n && /Stringleitungen/.test(n.body));
    ok('Anna ist nach dem Speichern nicht mehr „in der Notiz"', !(await drin(pv.id)).includes('Anna Dach'), JSON.stringify(await drin(pv.id)));

    console.log('\nProjekt wechseln');
    await neuerEintrag(A);
    await waehle(A, pv.id); await notizBereit(A);
    await waehle(A, halle.id);
    await A.waitForFunction((b) => /Halle Süd/.test(document.querySelector(b).innerText), {}, B);
    await A.waitForSelector(B + ' #ef-notiz-anfangen'); await sleep(400);
    a = await bereich(A);
    ok('Bereich zeigt jetzt „Halle Süd", keine Ziele, Notiz noch leer', /Halle Süd/.test(a.text) && !/PV Beispiel/.test(a.text) && /Keine Zwischenziele/.test(a.text) && a.opts === 0, JSON.stringify(a));
    ok('alte Notiz verlassen', !(await drin(pv.id)).includes('Anna Dach'));
    await waehle(A, pv.id); await notizBereit(A);
    ok('zurück auf PV: Notiz läuft wieder', (await drin(pv.id)).includes('Anna Dach'));
    await waehle(A, null); await sleep(400);
    ok('„Kein Projekt" → Bereich weg, Notiz verlassen', !(await bereich(A)).sichtbar && !(await drin(pv.id)).includes('Anna Dach'));

    console.log('\nTom (nicht zugeteilt) liest mit');
    const T = await seite('tom', true);
    await neuerEintrag(T);
    await waehle(T, pv.id);
    await T.waitForFunction((b) => document.querySelectorAll(b + ' .ms-dot').length === 3, {}, B);
    await notizBereit(T);
    const t = await bereich(T);
    ok('Tom: Ziele nur als Punkte, Hinweis „nicht zugeteilt"', t.opts === 0 && t.dots === 3 && /nicht zugeteilt/.test(t.text), JSON.stringify(t));
    ok('Tom: Notiz lesbar, keine Knopfleiste, nicht tippbar', /Stringleitungen/.test(t.notiz) && !t.leiste && t.nurLesen && !t.tippbar, JSON.stringify(t));
    if (FOTO) await T.screenshot({ path: path.join(FOTO, 'zeitnachweis-projekt-tom.png'), fullPage: true });
    ok('Tom: Status direkt per Schnittstelle → 403', (await req('PATCH', `/api/projects/${pv.id}/milestones/${ac.id}/status`, tok.tom, { status: 'done' })).status === 403);
    // Ben schreibt in der Notiz (Board → Projektnotiz) — Tom sieht es im Formular live
    await Ben.evaluate((pid) => { location.hash = `/projects/${pid}/notiz`; }, pv.id);
    await Ben.waitForFunction(() => /Gespeichert/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 10000 });
    await Ben.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await Ben.keyboard.type(' AC folgt Donnerstag');
    await T.waitForFunction((b) => /AC folgt Donnerstag/.test(document.querySelector(b + ' .ql-editor').innerText), { timeout: 8000 }, B).catch(() => {});
    ok('Bens Text kommt bei Tom live im Formular an', /AC folgt Donnerstag/.test((await bereich(T)).notiz));
    await req('PATCH', `/api/projects/${pv.id}/milestones/${ac.id}/status`, tok.ben, { status: 'done' });
    await T.waitForFunction((b) => document.querySelectorAll(b + ' .ms-dot[title="erledigt"]').length === 2, { timeout: 8000 }, B).catch(() => {});
    ok('Bens Statuswechsel kommt bei Tom an (2 von 3 erledigt)', (await T.evaluate((b) => document.querySelectorAll(b + ' .ms-dot[title="erledigt"]').length, B)) === 2);

    console.log('\nTom bei einer noch leeren Notiz');
    await neuerEintrag(T);
    await waehle(T, halle.id);
    await T.waitForFunction((b) => /noch leer/.test((document.querySelector(b + ' #ef-projekt-notiz') || {}).innerText || ''), {}, B);
    ok('Tom: „noch leer", kein Feld zum Anfangen', !(await T.$(B + ' #ef-notiz-anfangen')));
    await neuerEintrag(A); await waehle(A, halle.id);
    await A.bringToFront();
    await A.waitForSelector(B + ' #ef-notiz-anfangen'); await A.click(B + ' #ef-notiz-anfangen'); await notizBereit(A); await sleep(300);
    await A.keyboard.type('Schlüssel beim Nachbarn');
    await T.waitForFunction((b) => /Schlüssel beim Nachbarn/.test((document.querySelector(b + ' .ql-editor') || {}).innerText || ''), { timeout: 10000 }, B).catch(() => {});
    const t2 = await bereich(T);
    ok('Anna fängt an → bei Tom startet die Notiz von selbst, nur lesen', /Schlüssel beim Nachbarn/.test(t2.notiz) && !t2.tippbar, JSON.stringify(t2));

    console.log('\nCarla (Chef, nicht zugeteilt)');
    const C = await seite('carla');
    await neuerEintrag(C);
    await waehle(C, pv.id);
    await C.waitForFunction((b) => document.querySelectorAll(b + ' .ms-opt').length === 9, {}, B);
    await notizBereit(C);
    const c = await bereich(C);
    ok('Carla: darf ändern und mitschreiben', c.opts === 9 && c.leiste && c.tippbar && /gelten sofort/.test(c.text), JSON.stringify(c));

    console.log('\nErledigtes Projekt beim Bearbeiten');
    const alt = (await req('POST', '/api/entries', tok.anna, { date: gestern(), time_from: '13:00', time_to: '15:00', break_minutes: 0,
      project_id: altbau.id, description: 'Leitungen gezogen' })).body.entry;
    ok('Aufbau: Eintrag auf „Altbau Nord", Projekt dann erledigt', !!alt && (await req('POST', `/api/projects/${altbau.id}/done`, tok.carla)).status === 200);
    await A.evaluate((eid) => { location.hash = '/entry/' + eid; }, alt.id);
    await A.waitForSelector('#ef-project'); await sleep(500);
    const feld = await A.evaluate(() => { const s = document.getElementById('ef-project'); return { wert: s.value, text: s.selectedOptions[0] ? s.selectedOptions[0].textContent : '' }; });
    ok('Projekt steht im Feld als „Altbau Nord (erledigt)"', feld.wert === String(altbau.id) && /Altbau Nord \(erledigt\)/.test(feld.text), JSON.stringify(feld));
    await A.waitForSelector(B + ' #ef-notiz-anfangen');
    ok('Bereich auch beim erledigten Projekt (Notiz bleibt beschreibbar)', (await bereich(A)).sichtbar);
    await A.evaluate(() => { document.getElementById('ef-desc').value = 'Leitungen gezogen, geprüft'; });
    await A.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await A.waitForSelector('.modal-overlay [data-act="ok"]');
    await A.evaluate(() => document.querySelector('.modal-overlay [data-act="ok"]').click());
    await A.waitForFunction(() => location.hash === '#/' || location.hash === '', { timeout: 8000 }).catch(() => {});
    await sleep(500);
    const nachher = (await req('GET', `/api/entries/${alt.id}`, tok.anna)).body.entry;
    ok('Speichern behält die Projekt-Zuordnung', nachher && nachher.description === 'Leitungen gezogen, geprüft' && Number(nachher.project_id) === altbau.id,
      JSON.stringify(nachher && [nachher.description, nachher.project_id]));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nZeitnachweis ↔ Projekt (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
