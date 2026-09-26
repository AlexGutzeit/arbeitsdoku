// Das Bündel für die gemeinsamen Notizen (Etappe A, Schritt 2 — 26.09.2026).
//
// public/vendor/kollab.min.js fasst Yjs (gemeinsames Dokument), Quill (Schreibfeld mit Fett, Listen,
// Checklisten) und ihre Anbindungen zu EINER Datei zusammen. Dieser Test prüft das, was später
// niemand mehr von Hand nachsieht:
//
//   1. Das eingecheckte Bündel passt zu den installierten Paketen (sonst wurde package.json geändert,
//      ohne neu zu bauen — oder das Bündel von Hand angefasst).
//   2. Jede mitgelieferte Bibliothek steht mit Lizenztext in kollab-LIZENZEN.txt, und keine hat eine
//      Lizenz, die für die App nicht passt (Schutz vor einem stillen Wechsel bei einem Update).
//   3. Es lädt unter der Sicherheitsregel der App (script-src 'self', kein eval) — nur bei Bedarf,
//      nur einmal, und nach einem Funkloch beim nächsten Versuch erneut.
//   4. Zwei Schreibfelder gleichen sich über Yjs ab, samt Checkliste und fremdem Cursor.
//   5. Der Server (yjs aus node_modules) versteht die Änderungen des Browsers und umgekehrt —
//      darauf baut Schritt 3.
//
//   node tests/kollab-buendel.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const Y = require('yjs');

const PORT = 3335, DB = '/tmp/kollab-buendel.db', LOG = '/tmp/kollab-buendel.log';
const BASIS = 'http://localhost:' + PORT;
const APP = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
// Lizenzen, unter denen eine Bibliothek in der (öffentlichen) App mitgeliefert werden darf
const ERLAUBT = ['MIT', 'BSD-3-Clause', 'BSD-2-Clause', 'Apache-2.0', 'ISC'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(p) {
  return new Promise((res, rej) => {
    http.get({ host: 'localhost', port: PORT, path: p }, x => { x.resume(); res(x.statusCode); }).on('error', rej);
  });
}

(async () => {
  console.log('\nDas eingecheckte Bündel');
  const pruef = spawnSync('node', ['scripts/kollab-buendeln.js', '--pruefen'], { cwd: APP, encoding: 'utf8' });
  ok('passt zu den installierten Paketen (--pruefen)', pruef.status === 0, (pruef.stdout + pruef.stderr).trim());
  const js = fs.readFileSync(path.join(APP, 'public/vendor/kollab.min.js'), 'utf8');
  ok('bleibt unter 450 KB (wächst nicht unbemerkt)', js.length < 450 * 1024, Math.round(js.length / 1024) + ' KB');

  console.log('\nLizenzen');
  const { buendeln } = require('../scripts/kollab-buendeln.js');
  const { pakete } = await buendeln();
  const lizenzen = fs.readFileSync(path.join(APP, 'public/vendor/kollab-LIZENZEN.txt'), 'utf8');
  ok('das Bündel enthält die erwarteten Kernpakete',
    ['yjs', 'quill', 'y-quill', 'quill-cursors', 'y-protocols'].every(n => pakete.some(p => p.name === n)),
    pakete.map(p => p.name).join(', '));
  const ohneEintrag = pakete.filter(p => !lizenzen.includes(`\n${p.name} ${p.version} — ${p.lizenz}\n`));
  ok('jede mitgelieferte Bibliothek steht mit Version in kollab-LIZENZEN.txt', ohneEintrag.length === 0,
    ohneEintrag.map(p => p.name).join(', '));
  const ohneText = pakete.filter(p => !p.text);
  ok('Lizenztext fehlt höchstens dort, wo das Paket selbst keinen mitbringt (nur quill-cursors)',
    ohneText.map(p => p.name).join(',') === 'quill-cursors', ohneText.map(p => p.name).join(', '));
  const fremd = pakete.filter(p => !ERLAUBT.includes(p.lizenz));
  ok('keine Bibliothek mit einer Lizenz außerhalb von ' + ERLAUBT.join('/'), fremd.length === 0,
    fremd.map(p => p.name + ' (' + p.lizenz + ')').join(', '));

  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('/health')) === 200) break; } catch (_) {} await sleep(200); }
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async () => {
      const p = await browser.newPage();
      await p.evaluateOnNewDocument(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '')));
      });
      const fehler = []; p.on('pageerror', e => fehler.push(e.message));
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      return { p, fehler };
    };

    console.log('\nLaden in der App');
    const { p, fehler } = await seite();
    ok('vor dem ersten Öffnen einer Notiz ist nichts geladen',
      await p.evaluate(() => !window.Kollab && !document.querySelector('script[src="/vendor/kollab.min.js"]')));
    const geladen = await p.evaluate(async () => {
      const [a, b] = await Promise.all([notizEditorLaden(), notizEditorLaden()]);
      return { a, b, skripte: document.querySelectorAll('script[src="/vendor/kollab.min.js"]').length,
        stile: document.querySelectorAll('link[href="/vendor/kollab.css"]').length,
        teile: window.Kollab && Object.keys(window.Kollab).sort().join(',') };
    });
    ok('notizEditorLaden() lädt Skript und Stile — auch bei zwei gleichzeitigen Aufrufen nur einmal',
      geladen.a && geladen.b && geladen.skripte === 1 && geladen.stile === 1, JSON.stringify(geladen));
    ok('window.Kollab bringt Y, Quill, QuillBinding und awarenessProtocol mit',
      geladen.teile === 'Quill,QuillBinding,Y,awarenessProtocol', geladen.teile);

    // Zwei Schreibfelder wie zwei Geräte — hier in einer Seite, über Yjs verbunden
    await p.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `<div id="probe" style="position:fixed;inset:0;z-index:99999;background:#fff;padding:8px">
        <div id="leiste-a"><button class="ql-bold"></button><button class="ql-list" value="check"></button></div>
        <div id="feld-a"></div><div id="feld-b"></div></div>`);
      const { Y, Quill, QuillBinding, awarenessProtocol: A } = window.Kollab;
      const da = new Y.Doc(), db = new Y.Doc();
      // Ein gemeinsames Dokument beginnt NIE leer, sondern mit einem Zeilenende. Quill hat immer einen
      // Schluss-Zeilenumbruch, den y-quill bei einem leeren Dokument nicht kennt — formatiert jemand
      // die letzte Zeile (Checkliste), zeigt die Gegenseite sonst eine Leerzeile zu viel (gemessen
      // 26.09.2026). Schritt 3 legt jede Notiz auf dem Server so an.
      da.getText('notiz').insert(0, '\n');
      Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
      da.on('update', (u, o) => { if (o !== 'netz') Y.applyUpdate(db, u, 'netz'); });
      db.on('update', (u, o) => { if (o !== 'netz') Y.applyUpdate(da, u, 'netz'); });
      const wa = new A.Awareness(da), wb = new A.Awareness(db);
      wa.setLocalStateField('user', { name: 'Anna', color: '#2563eb' });
      wa.on('update', ({ added, updated, removed }, o) => {
        if (o !== 'netz') A.applyAwarenessUpdate(wb, A.encodeAwarenessUpdate(wa, added.concat(updated, removed)), 'netz');
      });
      const formats = ['bold', 'italic', 'underline', 'list'];
      const qa = new Quill('#feld-a', { theme: 'snow', formats, modules: { toolbar: '#leiste-a', cursors: true } });
      const qb = new Quill('#feld-b', { theme: 'snow', formats, modules: { toolbar: false, cursors: true } });
      new QuillBinding(da.getText('notiz'), qa, wa);
      new QuillBinding(db.getText('notiz'), qb, wb);
      window.__probe = { Y, da, db, qa, qb };
    });
    await p.click('#feld-a .ql-editor'); await p.keyboard.type('Wago 221-413');
    await p.click('#leiste-a .ql-list[value="check"]'); await sleep(150);
    const abgleich = await p.evaluate(() => {
      const { qa, qb } = window.__probe;
      return { a: JSON.stringify(qa.getContents().ops), b: JSON.stringify(qb.getContents().ops),
        cursorBeiB: !!document.querySelector('#feld-b .ql-cursor .ql-cursor-name'),
        cursorName: (document.querySelector('#feld-b .ql-cursor-name') || {}).textContent,
        knopfHoehe: getComputedStyle(document.querySelector('#leiste-a button')).height };
    });
    ok('Getipptes und Checkliste kommen im zweiten Feld gleich an', abgleich.a === abgleich.b && /"list":"unchecked"/.test(abgleich.b)
      && /Wago 221-413/.test(abgleich.b), abgleich.b);
    ok('der Cursor des anderen steht mit Namen im zweiten Feld', abgleich.cursorBeiB && abgleich.cursorName === 'Anna',
      JSON.stringify(abgleich));
    ok('die Stile aus kollab.css greifen (Knopfleiste gestaltet)', abgleich.knopfHoehe === '24px', abgleich.knopfHoehe);

    console.log('\nServer und Browser rechnen mit demselben Yjs');
    const ausBrowser = await p.evaluate(() => {
      const { Y, da } = window.__probe;
      return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(da)));
    });
    const server = new Y.Doc();
    Y.applyUpdate(server, Buffer.from(ausBrowser, 'base64'));
    const delta = server.getText('notiz').toDelta();
    ok('der Server liest Text und Checkliste aus dem Browser-Stand',
      server.getText('notiz').toString() === 'Wago 221-413\n' && delta.some(d => d.attributes && d.attributes.list === 'unchecked'),
      JSON.stringify(delta));
    const vorher = Y.encodeStateVector(server);
    server.getText('notiz').insert(0, 'Material: ');
    const zurueck = Buffer.from(Y.encodeStateAsUpdate(server, vorher)).toString('base64');
    const imBrowser = await p.evaluate((u) => {
      const { Y, db, qa } = window.__probe;
      Y.applyUpdate(db, Uint8Array.from(atob(u), c => c.charCodeAt(0)), 'server');
      return qa.getText();
    }, zurueck);
    ok('eine Änderung vom Server erscheint in beiden Feldern', imBrowser === 'Material: Wago 221-413\n', JSON.stringify(imBrowser));

    const csp = await p.evaluate(() => window.__csp);
    ok('keine Verletzung der Sicherheitsregel (kein eval, nichts Fremdes)', csp.length === 0, JSON.stringify(csp));
    ok('keine Skriptfehler auf der Seite', fehler.length === 0, JSON.stringify(fehler));

    console.log('\nFunkloch beim ersten Öffnen');
    // Ein Handy, das die Datei noch nie geladen hat: Der Hintergrunddienst der App würde sie sonst
    // am Test vorbei holen (bzw. aus seinem Speicher liefern — was im echten Funkloch ja erwünscht ist).
    const ctx = await browser.createBrowserContext();
    const p2 = await ctx.newPage();
    await p2.setBypassServiceWorker(true);
    await p2.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p2.waitForSelector('#login-user');
    await p2.setRequestInterception(true);
    let sperren = true;
    p2.on('request', r => (sperren && r.url().includes('/vendor/kollab.min.js')) ? r.abort('internetdisconnected') : r.continue());
    const erster = await p2.evaluate(() => notizEditorLaden());
    sperren = false;
    const zweiter = await p2.evaluate(() => notizEditorLaden());
    const reste = await p2.evaluate(() => document.querySelectorAll('script[src="/vendor/kollab.min.js"]').length);
    ok('ohne Netz meldet notizEditorLaden() „nicht geladen" statt zu hängen', erster === false, String(erster));
    ok('beim nächsten Öffnen wird neu geladen — und es bleibt nur ein Skript-Eintrag', zweiter === true && reste === 1,
      JSON.stringify({ zweiter, reste }));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nKollab-Bündel: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
