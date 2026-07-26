// Probe: Überträgt deploy.sh WIRKLICH alles, was der Server zum Starten braucht?
//
// deploy.sh synct eine FESTE Dateiliste. Eine neue Datei im Projektstamm (z. B. csv.js) landet
// dadurch nicht auf dem Server — der Dienst startet nach dem Neustart gar nicht mehr, weil ein
// require fehlschlägt. Genau das wäre beim Lohn-Export-Deploy passiert.
//
// Der Test baut die Auslieferung LOKAL nach: Er liest die rsync-Zeilen aus deploy.sh, kopiert exakt
// diese Pfade in ein leeres Verzeichnis, verlinkt node_modules und startet den Server dort.
// Kommt er hoch und antwortet, ist die Liste vollständig.
//   node tests/deploy-vollstaendigkeit.js
const { spawn, execSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');

const PROJEKT = path.join(__dirname, '..');
const ZIEL = path.join(os.tmpdir(), 'deploy-probe-' + Date.now());
const PORT = 3154;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const hole = (pfad) => new Promise(res => {
  const r = http.request({ host: 'localhost', port: PORT, path: pfad, method: 'GET' },
    x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s })); });
  r.on('error', () => res({ status: 0, text: '' })); r.end();
});

// Die zu übertragenden Pfade aus deploy.sh herauslesen — nicht hier doppelt pflegen.
function pfadeAusDeploySkript() {
  const skript = fs.readFileSync(path.join(PROJEKT, 'deploy.sh'), 'utf8');
  const pfade = [];
  for (const zeile of skript.split('\n')) {
    if (!/^\s*rsync\s/.test(zeile)) continue;
    // alles zwischen den Optionen und dem Ziel ("$DEPLOY_HOST:...)
    const ohneZiel = zeile.replace(/"\$DEPLOY_HOST[^"]*"\s*$/, '');
    for (const teil of ohneZiel.trim().split(/\s+/).slice(1)) {
      if (teil.startsWith('-')) continue;
      pfade.push(teil.replace(/\/$/, ''));
    }
  }
  return [...new Set(pfade)];
}

(async () => {
  const pfade = pfadeAusDeploySkript();
  ok('Dateiliste aus deploy.sh gelesen', pfade.length >= 8, pfade.join(' '));

  fs.mkdirSync(ZIEL, { recursive: true });
  let fehlend = [];
  for (const p of pfade) {
    const quelle = path.join(PROJEKT, p);
    if (!fs.existsSync(quelle)) { fehlend.push(p); continue; }
    const ziel = path.join(ZIEL, p);
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    fs.cpSync(quelle, ziel, { recursive: true });
  }
  ok('alle in deploy.sh genannten Pfade existieren', fehlend.length === 0, fehlend.join(', '));

  // node_modules kommen auf dem Server per npm install --omit=dev; hier verlinken.
  fs.symlinkSync(path.join(PROJEKT, 'node_modules'), path.join(ZIEL, 'node_modules'));

  const log = path.join(os.tmpdir(), 'deploy-probe.log');
  const srv = spawn('node', ['server.js'], {
    cwd: ZIEL,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DB_PATH: path.join(ZIEL, 'probe.db'), JWT_SECRET: 'probe-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')],
  });
  try {
    let gesund = false;
    for (let i = 0; i < 60; i++) { const h = await hole('/health'); if (h.status === 200) { gesund = true; break; } await sleep(300); }
    const ausgabe = fs.readFileSync(log, 'utf8');
    ok('Server startet allein aus den ausgelieferten Dateien', gesund,
      (ausgabe.match(/Cannot find module[^\n]*/) || ausgabe.split('\n').filter(Boolean).slice(-3).join(' | ') || '').slice(0, 200));
    ok('keine fehlenden Module', !/Cannot find module/.test(ausgabe),
      (ausgabe.match(/Cannot find module[^\n]*/) || [''])[0]);

    if (gesund) {
      // Stichproben auf die Auslieferung: Oberflaeche und eine Route, die csv.js braucht
      const seite = await hole('/');
      ok('Oberfläche wird ausgeliefert', seite.status === 200 && /<div id="app">/.test(seite.text), String(seite.status));
      const sw = await hole('/sw.js');
      ok('Service Worker wird ausgeliefert', sw.status === 200 && /CACHE_VERSION/.test(sw.text), String(sw.status));
      const geschuetzt = await hole('/api/payroll/monat.csv?month=2026-07');
      ok('Lohn-Export-Route ist erreichbar (401 ohne Anmeldung, kein 404/500)',
        geschuetzt.status === 401, String(geschuetzt.status));
    }
  } finally {
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(path.join(ZIEL, 'node_modules')); } catch (_) {}
    try { fs.rmSync(ZIEL, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\nDeploy-Vollständigkeit: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
