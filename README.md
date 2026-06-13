# Arbeitsdoku

Arbeitsdokumentations-Webapp: Zeiterfassung, Abwesenheiten, Planung, Bestellungen, PDF-Export. Single-Page-App + Express-Backend + SQLite via sql.js. PWA-fähig (Homescreen-Install, Offline-Hint).

## Setup auf neuem Server

```bash
git clone <repo-url> arbeitsdoku
cd arbeitsdoku
npm install
cp .env.example .env
# In .env einen sicheren JWT_SECRET eintragen, z. B. erzeugt mit:
openssl rand -base64 48
npm start
```

Beim ersten Start:
- Datenbank wird automatisch angelegt unter `data/arbeitsdoku.db`
- Vier Seed-User (`admin`, `chef`, `buchhalter`, `max`) werden mit **zufälligen Passwörtern** erstellt
- Die Passwörter werden **einmalig** in der Konsole ausgegeben — bitte notieren

Server hört per Default auf Port `3000`. Mit `PORT=8080 npm start` ändern.

## ENV-Variablen

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `JWT_SECRET` | ja | — | Min. 32 Zeichen. Server startet sonst nicht. |
| `PORT` | nein | `3000` | HTTP-Port |
| `DB_PATH` | nein | `./data/arbeitsdoku.db` | SQLite-Pfad |

## White-Label-Branding

App-Name, Theme-Farbe, Hintergrundfarbe und App-Icon sind über die Settings-UI konfigurierbar (Chef-/Admin-Rolle, **Einstellungen → App-Branding**).

- **Defaults:** „Arbeitsdoku", grünes Theme, neutrales „AD"-Icon
- **Icon-Upload:** PNG/JPG, mind. 256×256, beliebiges Seitenverhältnis (wird auf 512×512 quadratisch gecroppt). Alle PWA-Größen + maskable werden automatisch generiert.
- **Reset-Button** stellt das AD-Default-Icon wieder her.
- Nach Branding-Änderungen lädt die App automatisch neu. Bereits installierte PWAs (Homescreen) müssen neu installiert werden, damit das neue Icon übernommen wird.

## Backup & Restore

In den Settings unter **Datenbank-Backup**:
- **Backup herunterladen:** ZIP mit DB + allen Uploads (Logo, Custom-Icons).
- **Backup einspielen:** überschreibt aktuelle Daten; ein Safety-Backup wird vorher automatisch in `backups/` angelegt.

Backup enthält:
```
arbeitsdoku.db
uploads/<firmenlogo>.jpg
uploads/icons/master.png + icon-*.png + maskable-*.png
```

## Skripte

| Script | Zweck |
|---|---|
| `npm start` | Produktionsbetrieb |
| `npm run dev` | Dev-Server (Port 3001, separate `data/local.db`, Dev-JWT) |
| `npm run clone-db` | Kopiert Prod-DB via SSH und anonymisiert die Passwörter zu `test` (interne Nutzung) |
| `node scripts/generate-icons.js` | Generiert die AD-Default-Icons aus `public/icons/source.svg` neu (nur nötig wenn SVG geändert wird) |

## Lizenz

[MIT](LICENSE) © Alex Gutzeit
