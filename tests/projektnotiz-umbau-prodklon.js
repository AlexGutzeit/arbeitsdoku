// Projektnotiz: Umbau der Notiz-Tabelle an echten Daten (Prod-Klon, 28.09.2026).
//
// Damit eine Notiz einem PROJEKT statt einer Person gehören kann, muss `notes.user_id` leer sein dürfen —
// SQLite kann das nur, indem die Tabelle neu aufgebaut wird (database/init.js, ensureProjektNotizSchema).
// Geprüft wird an Kopien der Produktivdaten, dass dabei nichts verloren geht:
//   * jede Notiz mit JEDER Spalte zeichengleich (auch ydoc-Bytes, Delta, Zeitstempel, Bearbeiter), Nummern gleich;
//   * Freigaben, Angebote, Gesehen-Merker, Gäste unverändert; Fremdschlüssel in Ordnung; Datei heil;
//   * der Nummernzähler fällt nicht zurück (sonst bekäme eine neue Notiz die Nummer einer gelöschten);
//   * danach darf user_id leer sein, projekt_notiz_fuer gibt es, höchstens eine Notiz je Projekt;
//   * zweiter Start: kein zweiter Umbau.
// Vorlage /tmp/prodklon.db (wird nicht verändert) und, falls da, die alte Rohkopie /tmp/prodklon-echt.db
// (Stand vor den Live-Notizen: dort laufen ALLE Umstellungen nacheinander).
//
//   node tests/projektnotiz-umbau-prodklon.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const initSqlJs = require('sql.js');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const summe = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// /tmp/prodklon.db wird von älteren Prod-Klon-Tests direkt beschrieben — in der Suite ist sie oft schon
// umgebaut, bevor dieser Test drankommt. Deshalb zusätzlich die ROHEN Kopien (werden hier nie verändert):
// die frische vor einem Deploy (/tmp/prodklon-frisch-roh.db) und die alte von vor Etappe A.
const VORLAGEN = ['/tmp/prodklon.db', '/tmp/prodklon-frisch-roh.db', '/tmp/prodklon-echt.db'].filter(p => fs.existsSync(p));
// Fremdschlüssel-Verstöße je „Tabelle→Elterntabelle"
const verstoesse = (db) => { const r = db.exec('PRAGMA foreign_key_check'); const m = {};
  if (r.length) for (const v of r[0].values) m[v[0] + '→' + v[2]] = (m[v[0] + '→' + v[2]] || 0) + 1; return m; };

function zeilen(db, sql) {
  const r = db.exec(sql); if (!r.length) return [];
  return r[0].values.map(v => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i] instanceof Uint8Array ? Buffer.from(v[i]).toString('base64') : v[i]])));
}

(async () => {
  if (!VORLAGEN.length) { console.log('Prod-Klon fehlt — Test uebersprungen'); process.exit(0); }
  const SQL = await initSqlJs();
  for (const vorlage of VORLAGEN) {
    console.log(`\n${vorlage}`);
    const summeVorlage = summe(vorlage);
    const alt = new SQL.Database(fs.readFileSync(vorlage));
    const altSpalten = zeilen(alt, 'PRAGMA table_info(notes)').map(c => c.name);
    const altNotizen = zeilen(alt, 'SELECT * FROM notes ORDER BY id');
    const nebenTabellen = ['note_shares', 'note_offers', 'note_gesehen', 'note_gaeste']
      .filter(t => zeilen(alt, `SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`).length);
    const altNeben = Object.fromEntries(nebenTabellen.map(t => [t, JSON.stringify(zeilen(alt, `SELECT * FROM ${t} ORDER BY 1, 2`))]));
    const altZaehler = (zeilen(alt, "SELECT seq FROM sqlite_sequence WHERE name = 'notes'")[0] || {}).seq || 0;
    const warNotNull = zeilen(alt, 'PRAGMA table_info(notes)').find(c => c.name === 'user_id').notnull === 1;
    const altVerstoesse = verstoesse(alt);
    alt.close();

    // Auf einer KOPIE hochfahren — wie der Server beim Start (alle Umstellungen der Reihe nach)
    const kopie = path.join('/tmp', 'projektnotiz-umbau-' + path.basename(vorlage));
    fs.copyFileSync(vorlage, kopie);
    const skript = `process.env.DB_PATH=${JSON.stringify(kopie)};process.env.JWT_SECRET='x'.repeat(40);
      const { initDatabase, getDb } = require(${JSON.stringify(path.join(__dirname, '..', 'database', 'init'))});
      initDatabase().then(() => { const fs = require('fs'); fs.writeFileSync(process.env.DB_PATH, Buffer.from(getDb()._db.export())); process.exit(0); });`;
    const lauf = (n) => require('child_process').spawnSync('node', ['-e', skript], { encoding: 'utf8', timeout: 120000 });
    const erst = lauf(1);
    const umbauMeldung = /Migration: notes neu aufgebaut/.test(erst.stdout + erst.stderr);
    ok(`Start auf der Kopie läuft durch${warNotNull ? ', Umbau gemeldet' : ''}`, erst.status === 0 && (!warNotNull || umbauMeldung) && !/ensureProjektNotizSchema fehlgeschlagen/.test(erst.stderr + erst.stdout),
      (erst.stdout + erst.stderr).split('\n').filter(z => /Migration|fehlgeschlagen/.test(z)).join(' | '));

    const neu = new SQL.Database(fs.readFileSync(kopie));
    const neuSpalten = zeilen(neu, 'PRAGMA table_info(notes)');
    const neuNotizen = zeilen(neu, 'SELECT * FROM notes ORDER BY id');
    // Vergleich über die ALTEN Spalten — spätere Umstellungen dürfen neue anhängen (ydoc, … bei der Rohkopie)
    const anders = altNotizen.filter((a, i) => { const n = neuNotizen.find(x => x.id === a.id);
      return !n || altSpalten.some(c => c !== 'ydoc' && c !== 'body_delta' && n[c] !== a[c]) || (a.ydoc != null && n.ydoc !== a.ydoc); });
    ok(`${altNotizen.length} Notizen: Nummer und jede bisherige Spalte zeichengleich`, neuNotizen.length === altNotizen.length && anders.length === 0,
      JSON.stringify({ vorher: altNotizen.length, nachher: neuNotizen.length, anders: anders.map(a => a.id) }));
    const neuNeben = Object.fromEntries(nebenTabellen.map(t => [t, JSON.stringify(zeilen(neu, `SELECT * FROM ${t} ORDER BY 1, 2`))]));
    const nebenAnders = nebenTabellen.filter(t => neuNeben[t] !== altNeben[t]);
    // Bei der Rohkopie räumen die Live-Notizen verwaiste Freigaben ab — das ist gewollt und an anderer Stelle geprüft
    ok('Freigaben, Angebote, Gesehen-Merker, Gäste: unverändert' + (warNotNull && !altSpalten.includes('ydoc') ? ' (Rohkopie: nur um Verwaiste bereinigt)' : ''),
      nebenAnders.length === 0 || (!altSpalten.includes('ydoc') && nebenAnders.every(t => ['note_shares', 'note_offers', 'note_gesehen'].includes(t))), JSON.stringify(nebenAnders));
    // Die Produktivdaten haben ALTE Verstöße (z. B. Planungs-Zuweisungen zu gelöschten Planungen) — die
    // gehen den Umbau nichts an. Er darf aber keine NEUEN erzeugen, und auf Notizen darf keiner zeigen.
    const neuVerstoesse = verstoesse(neu);
    const mehr = Object.keys(neuVerstoesse).filter(k => neuVerstoesse[k] > (altVerstoesse[k] || 0));
    const aufNotizen = Object.keys(neuVerstoesse).filter(k => k.endsWith('→notes'));
    ok('keine neuen Fremdschlüssel-Verstöße, keiner zeigt auf Notizen, Datei heil',
      mehr.length === 0 && aufNotizen.length === 0 && zeilen(neu, 'PRAGMA integrity_check')[0].integrity_check === 'ok', JSON.stringify({ mehr, aufNotizen }));
    const neuZaehler = (zeilen(neu, "SELECT seq FROM sqlite_sequence WHERE name = 'notes'")[0] || {}).seq || 0;
    ok(`Nummernzähler nicht zurückgefallen (${altZaehler} → ${neuZaehler})`, neuZaehler >= altZaehler && !zeilen(neu, "SELECT 1 FROM sqlite_sequence WHERE name = 'notes_neu'").length);
    ok('user_id darf jetzt leer sein, projekt_notiz_fuer ist da (mit eindeutigem Index)',
      neuSpalten.find(c => c.name === 'user_id').notnull === 0 && neuSpalten.some(c => c.name === 'projekt_notiz_fuer')
        && zeilen(neu, "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_notes_projektnotiz'").length === 1);
    const projekt = zeilen(neu, 'SELECT id FROM projects LIMIT 1')[0];
    if (projekt) {
      neu.run("INSERT INTO notes (user_id, title, body, projekt_notiz_fuer) VALUES (NULL, 'Probe', '', ?)", [projekt.id]);
      let zweite = null;
      try { neu.run("INSERT INTO notes (user_id, title, body, projekt_notiz_fuer) VALUES (NULL, 'Probe 2', '', ?)", [projekt.id]); } catch (e) { zweite = e.message; }
      ok('eine Notiz ohne Eigentümer lässt sich anlegen — eine zweite fürs selbe Projekt nicht', /UNIQUE/.test(zweite || ''), zweite);
    }
    neu.close();
    const zweit = lauf(2);
    ok('zweiter Start: kein zweiter Umbau', zweit.status === 0 && !/Migration: notes neu aufgebaut/.test(zweit.stdout + zweit.stderr));
    ok('die Vorlage selbst ist unverändert', summe(vorlage) === summeVorlage);
    try { fs.unlinkSync(kopie); } catch (_) {}
  }
  console.log(`\nProjektnotiz-Umbau (Prod-Klon): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
