# Tests

Lokale Test-Skripte. Voraussetzung: laufender Server auf `:3000` mit anonymisiertem
Prod-Clone (alle Passwörter `test`):

```bash
npm run clone-db        # Prod-DB ziehen + Passwörter anonymisieren (intern)
PORT=3000 npm start     # Server starten
```

## Integrationstest (API/Berechnung)

```bash
node tests/complex-saldo-versioning.js
```
Prüft Soll/Ist/Überstunden + Revisionssicherheit (Soft-Delete, History, Papierkorb) über
ein komplexes Szenario (krank → FZA → löschen → Urlaub) inkl. Überlappung, Feiertag, Restore.

## Abwesenheits-Überschneidung (Logik, kein Server nötig)

```bash
node tests/absence-overlap.js
```
Prüft die prioritätsbewusste Tageszählung (`routes/absence-days.js`), die `/api/absences/summary`
**und** die PDF gemeinsam nutzen: Krank verdrängt Urlaub/FZA an überschnittenen Tagen, Feiertag
verdrängt alles, Wochenenden zählen nie — inkl. „Urlaubstage genommen (Jahr)". Läuft gegen eine
frische Temp-DB.

## Abwesenheits-Doppelbuchung (Logik, kein Server nötig)

```bash
node tests/absence-conflict.js
```
Prüft `sameTierConflict` (`routes/absences.js`): Doppelbuchung innerhalb derselben Stufe wird
verhindert (Urlaub/FZA/Sonderurlaub untereinander, Berufsschule/Innung, Krank gegen Krank),
während stufenübergreifende Überschneidungen (Krank über Urlaub usw.) erlaubt bleiben.

## Abwesenheiten im Browser (echte UI-Klicks, Puppeteer)

```bash
node tests/browser-absences.js   # BASE per ENV setzbar (Default :3000)
```
Fährt das komplette Szenario durch: FZA buchen (Soll bleibt 8) → Urlaub am selben Tag =
Fehlermeldung → FZA löschen, Urlaub buchen + als Admin genehmigen (Soll 0, 1 Urlaubstag) →
Krank am selben Tag (verdrängt Urlaub) → Krank+Krank und Berufsschule+Innung = Fehler.

Braucht eine **frische DB**, in der `max` und `admin` das Passwort `test` haben und `max` 8h
Mo-Fr hinterlegt hat. Setup-Skript (Beispiel, gegen eigene Temp-DB):

```js
// setup.js — dann:  DB_PATH=/tmp/bro.db JWT_SECRET=<32+ Zeichen> node setup.js
process.env.DB_PATH = '/tmp/bro.db';
const bcrypt = require('bcryptjs');
const { initDatabase, getDb, saveToFile } = require('./database/init');
(async () => {
  await initDatabase(); const db = getDb();
  const h = bcrypt.hashSync('test', 10);
  db.prepare("UPDATE users SET password_hash=? WHERE username IN ('max','admin')").run(h);
  const id = db.prepare("SELECT id FROM users WHERE username='max'").get().id;
  db.prepare('DELETE FROM user_target_hours WHERE user_id=?').run(id);
  db.prepare(`INSERT INTO user_target_hours (user_id,hours_per_week,hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from)
    VALUES (?,40,8,8,8,8,8,'2020-01-01')`).run(id);
  saveToFile(); process.exit(0);
})();
```
Dann Server gegen diese DB starten und `BASE=http://localhost:<port> node tests/browser-absences.js`.

## Bedienung auf dem Handy: Zoom, Trefferflächen, Kontrast (Puppeteer)

```bash
node tests/touch-ux-ui.js          # frische Test-DB
node tests/ux-runde1-prodklon.js   # gegen eine KOPIE der Produktivdaten (nur lesend)
```

Beide Tests messen die **Wirklichkeit im Browser**, nicht die CSS-Angabe:

* **Trefferfläche** — der Test tastet mit `document.elementFromPoint()` rund um einen Knopf ab und
  ermittelt, wo ein Tipp den Knopf tatsächlich trifft. So fällt auch auf, wenn eine vergrößerte
  Fläche vom `overflow: hidden` des Eintrags beschnitten wird oder einen Nachbarknopf verschluckt.
* **Kontrast** — die gerenderten Farben werden ausgelesen, halbtransparente Hintergründe von unten
  nach oben überlagert (sonst misst man z. B. das Rollen-Abzeichen auf der farbigen Kopfleiste
  falsch) und daraus das WCAG-Verhältnis gerechnet. Gefordert sind 4,5:1 für graue Nebentexte.
* **Gegenprobe mit Maus** — mit `pointer: fine` darf sich nichts verändern; die Touch-Regeln greifen
  ausschließlich auf Touchgeräten.

Den Prod-Klon vorher holen (er liegt bewusst außerhalb des Projekts und wird nie beschrieben):

```bash
scp <server>:/pfad/arbeitsdoku/data/arbeitsdoku.db /tmp/prodklon.db
```

Fehlt die Kopie, überspringt sich `ux-runde1-prodklon.js` mit Hinweis statt zu scheitern.

## Browser-Smoke-Test (echte UI-Klicks, Puppeteer)

```bash
node tests/browser-smoke.js
```
Klickt durch: Login → Dokumente → Ordner anlegen → Datei hochladen → umbenennen → löschen.

**Chromium-Browser bereitstellen** (wird bewusst NICHT bei `npm install` geladen, siehe
`.puppeteerrc.cjs`). Einmalig `chrome-headless-shell` besorgen, z. B.:

```bash
# Variante A: ueber Puppeteer (braucht 'unzip' im PATH)
npx puppeteer browsers install chrome-headless-shell

# Variante B: manuell (falls unzip fehlt) — Zip laden + mit 7z/bsdtar entpacken
VER=149.0.7827.22
curl -sL -o /tmp/chs.zip "https://storage.googleapis.com/chrome-for-testing-public/$VER/linux64/chrome-headless-shell-linux64.zip"
DEST=~/.cache/puppeteer/chrome-headless-shell/linux-$VER
mkdir -p "$DEST" && 7z x /tmp/chs.zip -o"$DEST" -y
chmod +x "$DEST/chrome-headless-shell-linux64/chrome-headless-shell"
```

Der Test sucht die Binary unter dem Standard-Cache-Pfad oder via `CHROME_BIN`:

```bash
CHROME_BIN=/pfad/zu/chrome-headless-shell node tests/browser-smoke.js
```

> Hinweis: Puppeteer ist eine **devDependency** und kommt nie auf Prod (Deploy nutzt
> `npm install --omit=dev`).
