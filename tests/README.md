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
