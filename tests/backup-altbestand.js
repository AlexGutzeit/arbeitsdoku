// Die einmalige Umstellung der vorhandenen Klartext-Sicherungen (Alex, 24.08.2026).
//
// Auf drei Rechnern liegen 167 Zips mit Kundennamen, Adressen und Geburtsdaten. Dieses Skript
// verschlüsselt sie. Dabei zählt genau eine Eigenschaft: Es darf NIE ein Klartext-Zip löschen,
// bevor bewiesen ist, dass aus dem verschlüsselten Nachfolger wieder Byte für Byte dasselbe
// herauskommt. Ein Formatfehler wäre sonst der stille Totalverlust der ganzen Historie.
//
// Deshalb prüft dieser Test nicht nur den guten Ausgang, sondern vor allem den schlechten: Was
// bleibt liegen, wenn der Rückweg scheitert?
//
//   node tests/backup-altbestand.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const k = require('../backup-krypto');
const { umstellen } = require('../scripts/backup-altbestand-verschluesseln');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const minipc = k.paarErzeugen();
const offline = k.paarErzeugen();
const fremd = k.paarErzeugen();
const empfaenger = [
  { name: 'minipc', schluessel: k.oeffentlichLesen(minipc.oeffentlich) },
  { name: 'offline', schluessel: k.oeffentlichLesen(offline.oeffentlich) },
];

// Ein Zip-artiger Inhalt mit einem Namen darin, nach dem sich später roh suchen lässt.
const KUNDE = 'Elektro Wiegand GmbH, Ahornweg 12';
function zipAehnlich(nummer) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`sicherung ${nummer} — ${KUNDE}\n`, 'utf8'),
    Buffer.alloc(2048, nummer & 0xff),
  ]);
}

function frischesVerzeichnis(anzahl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altbestand-'));
  const inhalte = new Map();
  for (let i = 1; i <= anzahl; i++) {
    const name = `arbeitsdoku_backup_2026-08-0${i}.zip`;
    const daten = zipAehnlich(i);
    fs.writeFileSync(path.join(dir, name), daten);
    fs.utimesSync(path.join(dir, name), new Date('2026-08-0' + i), new Date('2026-08-0' + i));
    inhalte.set(name, daten);
  }
  return { dir, inhalte };
}
const namen = (dir) => fs.readdirSync(dir).sort();

(async () => {
  console.log('── Der gute Ausgang: verschlüsselt, geprüft, Klartext weg ──');
  {
    const { dir, inhalte } = frischesVerzeichnis(3);
    const vorher = fs.statSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.zip')).mtimeMs;
    const { ergebnisse, geprueft } = await umstellen(dir, { empfaenger, schluessel: minipc.privat });

    ok('alle drei gemeldet als fertig', ergebnisse.length === 3 && ergebnisse.every(e => e.zustand === 'fertig'),
      JSON.stringify(ergebnisse));
    ok('geprüft-Kennzeichen gesetzt', geprueft === true);
    ok('kein Klartext-Zip mehr da', !namen(dir).some(n => n.endsWith('.zip')), namen(dir).join(' '));
    ok('drei .adbk stattdessen', namen(dir).filter(n => n.endsWith('.adbk')).length === 3);
    ok('keine .teil-Reste', !namen(dir).some(n => n.endsWith('.teil')), namen(dir).join(' '));

    let alleGleich = true, alleContainer = true, keinKlartext = true;
    for (const [zipName, daten] of inhalte) {
      const roh = fs.readFileSync(path.join(dir, zipName.replace('.zip', '.adbk')));
      if (!k.istContainer(roh)) alleContainer = false;
      if (roh.includes(KUNDE)) keinKlartext = false;
      if (!k.entschluesseln(roh, minipc.privat).equals(daten)) alleGleich = false;
    }
    ok('jede Datei ist ein ADBK1-Container', alleContainer);
    ok('der Kundenname steht NICHT mehr roh in der Datei', keinKlartext);
    ok('jede Datei kommt Byte-gleich zurück (minipc)', alleGleich);

    const mitOffline = k.entschluesseln(fs.readFileSync(path.join(dir, 'arbeitsdoku_backup_2026-08-02.adbk')), offline.privat);
    ok('auch der zweite Schlüssel öffnet sie', mitOffline.equals(inhalte.get('arbeitsdoku_backup_2026-08-02.zip')));

    const st = fs.statSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.adbk'));
    ok('das Alter der Sicherung bleibt erhalten (Rotation)', Math.abs(st.mtimeMs - vorher) < 1000,
      `vorher ${new Date(vorher).toISOString()}, nachher ${st.mtime.toISOString()}`);
    ok('Datei nur für den Besitzer lesbar (600)', (st.mode & 0o777) === 0o600, '0' + (st.mode & 0o777).toString(8));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n── Der schlechte Ausgang: Rückweg scheitert ──');
  {
    // Ein Schlüssel, der zu diesen Empfängern nicht passt: das Auspacken schlägt fehl, also ist
    // der Beweis nicht erbracht. Genau dann darf nichts gelöscht werden.
    const { dir, inhalte } = frischesVerzeichnis(2);
    const { ergebnisse } = await umstellen(dir, { empfaenger, schluessel: fremd.privat });

    ok('beide als Fehler gemeldet', ergebnisse.every(e => e.zustand === 'fehler'), JSON.stringify(ergebnisse));
    ok('die Meldung nennt den Rückweg', ergebnisse.every(e => /Rückweg/.test(e.grund || '')), ergebnisse[0] && ergebnisse[0].grund);
    ok('ALLE Klartext-Zips liegen noch da', namen(dir).filter(n => n.endsWith('.zip')).length === 2, namen(dir).join(' '));
    ok('kein .adbk zurückgelassen', !namen(dir).some(n => n.endsWith('.adbk')), namen(dir).join(' '));
    ok('kein .teil zurückgelassen', !namen(dir).some(n => n.endsWith('.teil')), namen(dir).join(' '));
    let unversehrt = true;
    for (const [name, daten] of inhalte) if (!fs.readFileSync(path.join(dir, name)).equals(daten)) unversehrt = false;
    ok('die Klartext-Zips sind unverändert', unversehrt);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n── Ohne privaten Schlüssel: verschlüsseln ja, löschen nein ──');
  {
    // Der Fall auf dem VPS: Dort liegt absichtlich kein privater Schlüssel. Verschlüsseln kann er
    // trotzdem — nur beweisen kann er nichts, also fasst er den Klartext nicht an.
    const { dir } = frischesVerzeichnis(2);
    const { ergebnisse, geprueft } = await umstellen(dir, { empfaenger, schluessel: '' });
    ok('als ungeprüft gemeldet', ergebnisse.every(e => e.zustand === 'ungeprueft'), JSON.stringify(ergebnisse));
    ok('geprüft-Kennzeichen ist falsch', geprueft === false);
    ok('Klartext-Zips liegen noch da', namen(dir).filter(n => n.endsWith('.zip')).length === 2);
    ok('.adbk sind trotzdem entstanden', namen(dir).filter(n => n.endsWith('.adbk')).length === 2);
    ok('und sie lassen sich öffnen', k.istContainer(fs.readFileSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.adbk'))));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n── Zweiter Lauf, Probelauf, fremde Dateien ──');
  {
    const { dir } = frischesVerzeichnis(2);
    await umstellen(dir, { empfaenger, schluessel: minipc.privat });
    const zweiter = await umstellen(dir, { empfaenger, schluessel: minipc.privat });
    ok('zweiter Lauf findet nichts mehr zu tun', zweiter.ergebnisse.length === 0, JSON.stringify(zweiter.ergebnisse));

    // Ein Klartext-Zip, neben dem schon ein .adbk liegt: nicht noch einmal verschlüsseln und
    // vor allem nicht ungeprüft löschen — hier weiss das Skript nicht, ob beides zusammengehört.
    fs.writeFileSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.zip'), zipAehnlich(9));
    const dritter = await umstellen(dir, { empfaenger, schluessel: minipc.privat });
    ok('Zip mit vorhandenem .adbk wird übersprungen', dritter.ergebnisse.every(e => e.zustand === 'schon-da'), JSON.stringify(dritter.ergebnisse));
    ok('… und bleibt liegen', fs.existsSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.zip')));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const { dir, inhalte } = frischesVerzeichnis(2);
    fs.writeFileSync(path.join(dir, 'notizen.txt'), 'nicht anfassen');
    fs.writeFileSync(path.join(dir, 'db.sqlite'), 'auch nicht');
    const probe = await umstellen(dir, { empfaenger, schluessel: minipc.privat, trocken: true });
    ok('Probelauf meldet nur, was wäre', probe.ergebnisse.length === 2 && probe.ergebnisse.every(e => e.zustand === 'waere'));
    ok('Probelauf ändert nichts', namen(dir).join(' ') === ['arbeitsdoku_backup_2026-08-01.zip', 'arbeitsdoku_backup_2026-08-02.zip', 'db.sqlite', 'notizen.txt'].join(' '),
      namen(dir).join(' '));

    await umstellen(dir, { empfaenger, schluessel: minipc.privat });
    ok('Dateien ohne .zip bleiben unangetastet',
      fs.readFileSync(path.join(dir, 'notizen.txt'), 'utf8') === 'nicht anfassen'
      && fs.readFileSync(path.join(dir, 'db.sqlite'), 'utf8') === 'auch nicht');
    ok('die Zips daneben wurden trotzdem umgestellt', namen(dir).filter(n => n.endsWith('.adbk')).length === 2);
    inhalte.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n── Verständliche Abbrüche ──');
  {
    const { dir } = frischesVerzeichnis(1);
    try { await umstellen(dir, { empfaenger: [], schluessel: minipc.privat }); ok('ohne Empfänger → Abbruch', false, 'ging durch'); }
    catch (e) { ok('ohne Empfänger → Abbruch mit BACKUP_EMPFAENGER im Text', /BACKUP_EMPFAENGER/.test(e.message), e.message); }
    ok('… und das Zip liegt unangetastet da', fs.existsSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.zip')));
    try { await umstellen(path.join(dir, 'gibtsnicht'), { empfaenger }); ok('fehlendes Verzeichnis → Abbruch', false, 'ging durch'); }
    catch (e) { ok('fehlendes Verzeichnis → Abbruch', /nicht gefunden/.test(e.message), e.message); }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n── Auf der Kommandozeile aufgerufen ──');
  {
    const { dir, inhalte } = frischesVerzeichnis(2);
    const umgebung = { ...process.env, BACKUP_EMPFAENGER: `minipc:${minipc.oeffentlich},offline:${offline.oeffentlich}`, BACKUP_SCHLUESSEL: minipc.privat };
    const ausgabe = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'backup-altbestand-verschluesseln.js'), dir],
      { env: umgebung, encoding: 'utf8' });
    ok('Ausgabe nennt die Empfänger', /minipc/.test(ausgabe) && /offline/.test(ausgabe), ausgabe.trim());
    ok('Ausgabe sagt, dass geprüft und gelöscht wurde', /geprüft/.test(ausgabe) && /gelöscht/.test(ausgabe), ausgabe.trim());
    ok('danach nur noch .adbk', namen(dir).every(n => n.endsWith('.adbk')) && namen(dir).length === 2, namen(dir).join(' '));
    ok('und der Inhalt stimmt', k.entschluesseln(fs.readFileSync(path.join(dir, 'arbeitsdoku_backup_2026-08-01.adbk')), offline.privat)
      .equals(inhalte.get('arbeitsdoku_backup_2026-08-01.zip')));

    // Der CLI-Entschlüsseler ist der Weg, den notfall-umschalten.sh geht.
    const ziel = path.join(dir, 'zurueck.zip');
    const pfad = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'backup-entschluesseln.js'),
      path.join(dir, 'arbeitsdoku_backup_2026-08-01.adbk'), ziel], { env: umgebung, encoding: 'utf8' });
    ok('backup-entschluesseln.js gibt den Zielpfad auf stdout aus', pfad.trim() === ziel, pfad.trim());
    ok('… und die Datei ist Byte-gleich zum Original', fs.readFileSync(ziel).equals(inhalte.get('arbeitsdoku_backup_2026-08-01.zip')));

    // Ohne Schlüssel darf es nicht still etwas Falsches tun, sondern muss sagen, was fehlt.
    let fehler = '';
    try {
      execFileSync('node', [path.join(__dirname, '..', 'scripts', 'backup-entschluesseln.js'),
        path.join(dir, 'arbeitsdoku_backup_2026-08-02.adbk'), path.join(dir, 'x.zip')],
        { env: { ...umgebung, BACKUP_SCHLUESSEL: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { fehler = (e.stderr || '') + ''; }
    ok('ohne BACKUP_SCHLUESSEL: Abbruch mit Erklärung', /BACKUP_SCHLUESSEL/.test(fehler) && /minipc/.test(fehler), fehler.trim().split('\n')[0]);
    ok('… und es entsteht keine halbe Zieldatei', !fs.existsSync(path.join(dir, 'x.zip')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nAltbestand-Umstellung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
