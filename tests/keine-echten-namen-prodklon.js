// Wächter: Keine echten Personen- oder Kundennamen im (öffentlichen) Repo.
//
// Warum: Am 08.10.2026 standen Mitarbeiter-Vornamen, ein Kundenprojekt und sogar der 18. Geburtstag eines
// Jugendlichen in Werkstattbuch, Code-Kommentaren und Tests — geschrieben beim Erklären echter Befunde. Der Test
// `keine-geheimnisse` sucht nur nach Schlüsseln und Passwörtern, nicht nach Namen.
//
// Wie: Die Namen kommen aus der LOKALEN Prod-Kopie (/tmp/prodklon.db, nie im Repo) — so muss kein echter Name
// hier stehen. Geprüft wird jedes Wort (≥ 4 Buchstaben) aus Nutzer- und Projektnamen gegen alle Dateien im Repo.
// Allgemeine Wörter, die zufällig auch Projektnamen sind („Lager"), stehen unten als Ausnahme — dort NIE einen
// Namen eintragen, sondern die Fundstelle umschreiben („ein Mitarbeiter", „ein Kundenprojekt").
//
//   node tests/keine-echten-namen-prodklon.js        (ohne /tmp/prodklon.db: übersprungen)
const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const initSqlJs = require('sql.js');

const VORLAGE = '/tmp/prodklon.db';
const WURZEL = path.join(__dirname, '..');
// Gewöhnliche Wörter, Firmen-/Produktname der App und der Rechteinhaber (LICENSE) — keine Personen/Kunden.
const ERLAUBT = new Set(['lager', 'regie', 'büro', 'buero', 'intern', 'sentec', 'gutzeit', 'alexander', 'documents',
  'installieren', 'abhängigkeiten', 'wallbox', 'carport', 'halle', 'dach', 'service', 'wartung', 'montage',
  'allgemein', 'diverses', 'werkstatt', 'fahrzeug', 'schulung', 'administrator', 'alex', 'kita', 'gartenhütte']);
// Je Datei erlaubt: ausgedachte Testfiguren mit gängigen Vornamen — und zwei ALTLASTEN, die sich in der Prod-Kopie
// echte Konten über den Vornamen aussuchen (scenario-shared-planning, browser-smoke). Die gehören umgebaut
// (Konto per Rolle wählen), dann hier austragen. Neue Einträge nur für erfundene Figuren.
const ERLAUBT_IN = {
  'tests/backup-empfaenger.js': ['daniel'], 'tests/backup-empfaenger-ui.js': ['daniel'],  // Testchef „Daniel"
  'tests/planning-series.js': ['jakob'], 'tests/board-live-buffer-ui.js': ['jakob'],      // Figuren „Jakob", „Jakob Live"
  'tests/hoechstarbeitszeit-ui.js': ['jonas'], 'tests/listen-suche-ui.js': ['jonas'],
  'tests/pause-jugendschutz-ui.js': ['jonas'],                                            // „Jonas Klein/Schmidt/Jung"
  'tests/produktpflege-ui.js': ['wagner'],                                                // „Herr Wagner"
  'tests/scenario-shared-planning.js': ['daniel', 'jakob'],                               // ALTLAST: echte Konten
  'tests/browser-smoke.js': ['daniel'],                                                   // ALTLAST: echtes Konto
};

(async () => {
  if (!fs.existsSync(VORLAGE)) { console.log('Prod-Klon ' + VORLAGE + ' fehlt — Test übersprungen.'); process.exit(0); }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(VORLAGE));
  const woerter = new Set();
  for (const sql of ['SELECT name FROM users', 'SELECT name FROM projects']) {
    const r = db.exec(sql);
    for (const [n] of (r.length ? r[0].values : [])) {
      for (const w of String(n || '').split(/[^\p{L}]+/u)) {
        const k = w.replace(/^[YZ]_/, '');
        if (k.length >= 4 && !ERLAUBT.has(k.toLowerCase())) woerter.add(k);
      }
    }
  }
  db.close();
  const dateien = execSync('git ls-files', { cwd: WURZEL, encoding: 'utf8' }).split('\n')
    .filter(f => f && !/^(node_modules|public\/vendor)\/|package-lock\.json$|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|db|zip|adbk)$/i.test(f));
  const funde = [];
  for (const f of dateien) {
    let text; try { text = fs.readFileSync(path.join(WURZEL, f), 'utf8'); } catch (_) { continue; }
    const zeilen = text.split('\n');
    const hier = ERLAUBT_IN[f] || [];
    for (const w of woerter) {
      if (hier.includes(w.toLowerCase())) continue;
      const re = new RegExp('(^|[^\\p{L}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|n)?(?=[^\\p{L}]|$)', 'u');
      zeilen.forEach((z, i) => { if (re.test(z)) funde.push(`${f}:${i + 1}`); });
    }
  }
  // Die Fundstelle nennen, NICHT das Wort — die Ausgabe landet in Protokollen.
  console.log(`  ${woerter.size} Namens-Wörter aus der Prod-Kopie, ${dateien.length} Dateien geprüft`);
  if (funde.length) {
    console.log('  ✗ echte Namen gefunden an:\n    ' + [...new Set(funde)].slice(0, 30).join('\n    '));
    console.log(`\nKeine echten Namen: 0 bestanden, 1 fehlgeschlagen`); process.exit(1);
  }
  console.log('  ✓ kein echter Personen- oder Kundenname im Repo');
  console.log(`\nKeine echten Namen: 1 bestanden, 0 fehlgeschlagen`);
})();
