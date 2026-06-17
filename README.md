# Arbeitsdoku

Eine selbst-hostbare Web-App zur **Arbeitszeit- und Betriebsdokumentation** für kleine Handwerks-,
Service- oder Montagebetriebe. Mitarbeiter erfassen ihre Arbeitszeiten, beantragen Abwesenheiten und
sehen ihren Stundensaldo; Chef/Admin verwalten Team, Projekte, Planung, Dokumente und exportieren
revisionssichere Nachweise als PDF.

- **Single-Page-App** (Vanilla JS) + **Express-Backend** + **SQLite** (via `sql.js`, keine externe DB nötig)
- **PWA-fähig** – per Homescreen installierbar, mit Offline-Hinweis
- **White-Label** – App-Name, Farben und Icon ohne Code-Änderung konfigurierbar
- **DSGVO/GoBD-bewusst** – Soft-Delete mit Papierkorb, Änderungshistorie, Audit-Log
- **Kein Build-Schritt** – `npm install` und starten, fertig

> Lizenz: [MIT](LICENSE). Du darfst die App frei nutzen, anpassen und für andere Firmen ausrollen.

---

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Rollen & Rechte](#rollen--rechte)
- [Schnellstart (lokal testen)](#schnellstart-lokal-testen)
- [Erster Start & Login](#erster-start--login)
- [Erste Schritte nach dem Login](#erste-schritte-nach-dem-login)
- [Konfiguration (ENV-Variablen)](#konfiguration-env-variablen)
- [Produktivbetrieb (Server, HTTPS, Autostart)](#produktivbetrieb-server-https-autostart)
- [Datenablage & Backup](#datenablage--backup)
- [White-Label-Branding](#white-label-branding)
- [Update auf eine neue Version](#update-auf-eine-neue-version)
- [Entwicklung & Tests](#entwicklung--tests)
- [Fehlerbehebung (FAQ)](#fehlerbehebung-faq)

---

## Funktionsumfang

Jeder Punkt entspricht einem Menüpunkt in der App.

| Bereich | Beschreibung |
|---|---|
| **🏠 Willkommen** | Persönliches Dashboard: anstehende Planung, eigene Abwesenheiten, Schnellüberblick. |
| **📊 Zeitnachweis** | Kern-Zeiterfassung. Eintrag mit Datum, Von/Bis, Pause, Arbeitsort, Kunde, Projekt, Beschreibung und optionalem „Regie"-Vermerk. Nettostunden werden automatisch berechnet; überlappende Einträge werden nicht doppelt gezählt. |
| **👥 Mitarbeiter** | Benutzerverwaltung (anlegen/bearbeiten/Rolle setzen), **Soll-Stunden pro Woche** (mit Historie), Start-Überstunden, Passwort zurücksetzen, Einzelrechte vergeben. **Ausstellen statt Löschen:** ausgeschiedene Mitarbeiter werden mit Austrittsdatum ausgestellt (kein Login mehr), ihre Zeiten/Abwesenheiten/Planungen bleiben aber vollständig erhalten und für ihren Anstellungszeitraum in Statistik und PDF berücksichtigt. Wiedereinstellen ist jederzeit möglich (auch mehrfach) – die Lücke zählt 0 Soll-Stunden. *(Chef/Admin)* |
| **📁 Projekte** | Projekt-/Auftragsstammdaten, die in Zeiteinträgen ausgewählt werden können. *(Chef/Admin)* |
| **📅 Planung** | Einsatz-/Schichtplanung: Termine mit Uhrzeit, Ort, Kunde, Projekt – einzeln oder als Gruppe, farblich markierbar. Mitarbeiter sehen ihre Einsätze. |
| **📌 Schwarzes Brett** | Aushänge/Ankündigungen fürs ganze Team, mit Benachrichtigungs-Badge. |
| **🔧 Werkzeugliste** | Werkzeug-Inventar mit Ausleihe/Rückgabe: wer hat was wann entnommen, inkl. Historie und Übernahme. |
| **🛒 Bestellungen** | Material-/Bestellanforderungen der Mitarbeiter; Chef sieht offene Bestellungen (Badge). |
| **📝 Notizen** | Persönliche und **geteilte** Notizen (Lese-/Schreibrechte pro Benutzer), mit Bearbeitungs-Sperre gegen gleichzeitiges Editieren. |
| **🗂️ Dokumente** | Dateiablage mit Ordnern/Unterordnern. Upload (PDF, Office, Bilder, txt/csv; max. 5 MB, Magic-Byte-Prüfung gegen umbenannte `.exe`), Verschieben, Umbenennen, rekursives Löschen. Konfigurierbares Gesamt-Speicherlimit. Mitarbeiter laden nur herunter – außer sie bekommen das Upload-Recht. |
| **🏖️ Abwesenheit** | Krank, Urlaub, Freizeitausgleich, Sonderurlaub, Feiertag, Berufsschule, Innung. Urlaub/FZA/Sonderurlaub durchlaufen einen **Genehmigungs-Workflow**. Prioritätsbewusste Tageszählung (Feiertag > Krank > Schule/Innung > Urlaub/FZA) und korrekte Soll-Stunden-/Überstunden-Verrechnung. |
| **📈 Statistik** | Soll-/Ist-Stunden und Überstunden je Zeitraum und Mitarbeiter, mit Diagrammen. |
| **📄 PDF-Export** | Druckfertiger Arbeitsnachweis (Einträge + Abwesenheiten + Stunden-Zusammenfassung) als PDF, gefiltert nach Zeitraum/Mitarbeiter/Projekt. |
| **⚙️ Einstellungen** | White-Label-Branding, Dokumenten-Speicherlimit, Datenbank-Backup/Restore. *(Chef/Admin)* |
| **📜 Audit-Log** | Revisionssicheres Protokoll (Logins, Backups, Benutzeränderungen u. a.). Benutzeranlage wird mit allen Parametern, Änderungen feldgenau als „alt → neu" protokolliert (Passwörter nie). Mit Filter (Aktion/Zeitraum), seitenweisem Nachladen und CSV-Export fürs Archiv. *(Admin)* |
| **🗑️ Papierkorb** | Gelöschte Einträge/Abwesenheiten bleiben mit Begründung erhalten und können wiederhergestellt werden (GoBD). Im Unterreiter **Mitarbeiter** liegen ausgestellte Mitarbeiter zum Wiedereinstellen; endgültiges Löschen (mit allen Daten) ist dort nur als Admin und nur für zuvor ausgestellte Mitarbeiter möglich. *(Admin)* |

**Querschnitts-Features:** Echtzeit-Updates über alle Geräte (Server-Sent Events), rollenbasierte
Sichtbarkeit, mobil-optimiert/installierbar (PWA), Brute-Force-Schutz am Login, durchgehend
parametrisierte SQL-Abfragen und HTML-Escaping (XSS-Schutz).

---

## Rollen & Rechte

| Rolle | Sieht / darf |
|---|---|
| **Administrator** | Alles: Benutzer-, Projekt-, Einstellungsverwaltung, Audit-Log, Papierkorb/Wiederherstellung. |
| **Chef** | Wie Admin bei Team-/Projekt-/Einstellungs-Verwaltung und Sicht auf alle Daten – ohne Audit-Log/Papierkorb. |
| **Buchhalter** | Lesende Manager-Sicht auf alle Mitarbeiterdaten/Statistiken/Nachweise (kein Verwalten von Stammdaten). |
| **Mitarbeiter** | Nur die **eigenen** Daten (Zeiten, Abwesenheiten, Planung) + globale Feiertage. |

**Zusätzliche Einzelrechte** (pro Benutzer unter *Mitarbeiter → Bearbeiten* vergebbar):

- **Planung bearbeiten** – darf Planungseinträge anlegen/ändern
- **Schwarzes Brett bearbeiten** – darf Aushänge verfassen
- **Dokumente hochladen** – darf in der Dateiablage hochladen/verwalten

---

## Schnellstart (lokal testen)

### Voraussetzungen

- **Node.js 18 oder neuer** (LTS empfohlen) inkl. `npm`. Prüfen mit:
  ```bash
  node --version    # sollte v18.x oder höher zeigen
  ```
  Node gibt es unter <https://nodejs.org> (Installer) oder über den Paketmanager des Systems.
- **git** (zum Klonen) – alternativ das Repo als ZIP herunterladen und entpacken.
- Es wird **keine** separate Datenbank, kein Webserver und kein Build-Tool benötigt.

### Installation

```bash
# 1) Code holen
git clone https://github.com/AlexGutzeit/arbeitsdoku.git
cd arbeitsdoku

# 2) Abhängigkeiten installieren
npm install

# 3) Konfiguration anlegen
cp .env.example .env

# 4) In .env einen sicheren JWT_SECRET eintragen (Pflicht, min. 32 Zeichen).
#    Einen Zufallswert erzeugen und in .env hinter JWT_SECRET= eintragen:
openssl rand -base64 48
#    (Kein openssl? Stattdessen: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")

# 5) Starten
npm start
```

Im Terminal erscheint:

```
Arbeitsdoku-Server läuft auf http://localhost:3000
```

App im Browser öffnen: **<http://localhost:3000>**

---

## Erster Start & Login

Beim allerersten Start (leere Datenbank) passiert automatisch:

- die Datenbank wird unter `data/arbeitsdoku.db` angelegt,
- **vier Test-Benutzer** werden erstellt: `admin`, `chef`, `buchhalter`, `max`,
- für jeden wird ein **zufälliges Passwort** erzeugt und **einmalig** im Terminal ausgegeben:

```
+--------------------------------------------------------+
| ERST-INIT: Zufaellige Passwoerter generiert            |
|  ! Werden NUR JETZT ausgegeben - bitte notieren !      |
+--------------------------------------------------------+
  admin        -> <zufälliges-Passwort>
  chef         -> ...
  ...
```

> ⚠️ **Diese Passwörter sofort notieren** – sie werden nicht erneut angezeigt.
> Melde dich anschließend als **`admin`** mit dem ausgegebenen Passwort an.
> Hast du das Admin-Passwort verloren, kannst du es zurücksetzen (siehe [FAQ](#fehlerbehebung-faq)).

---

## Erste Schritte nach dem Login

Damit die App produktiv nutzbar ist, als **Admin** der Reihe nach:

1. **Branding setzen** – *Einstellungen → App-Branding*: Firmenname, Farben, Logo/Icon.
2. **Mitarbeiter anlegen** – *Mitarbeiter → Neuer Mitarbeiter*: Name, Benutzername, Rolle.
3. **Soll-Stunden hinterlegen** – beim Bearbeiten jedes Mitarbeiters die **Wochen-Soll-Stunden**
   (pro Wochentag) eintragen. **Wichtig:** ohne Soll-Stunden kann die Über-/Minusstunden-Berechnung
   nicht korrekt rechnen.
4. (Optional) **Start-Überstunden** pro Mitarbeiter setzen.
5. (Optional) **Einzelrechte** vergeben (Planung/Schwarzes Brett/Dokumente).
6. **Eigenes Passwort ändern** und die nicht benötigten Test-Konten (`chef`/`buchhalter`/`max`)
   anpassen oder löschen.

---

## Konfiguration (ENV-Variablen)

Konfiguration über die Datei `.env` (Vorlage: `.env.example`).

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `JWT_SECRET` | **ja** | – | Geheimer Schlüssel für die Login-Tokens. **Min. 32 Zeichen**, sonst startet der Server nicht. Lang und zufällig wählen, geheim halten. |
| `PORT` | nein | `3000` | HTTP-Port des Servers. |
| `DB_PATH` | nein | `./data/arbeitsdoku.db` | Pfad der SQLite-Datenbankdatei. |
| `CHROME_BIN` | nein | – | Nur für die Browser-Tests (Puppeteer), nicht für den Betrieb. |

---

## Produktivbetrieb (Server, HTTPS, Autostart)

Für den echten Einsatz auf einem Server (z. B. ein Mini-PC, VPS oder NAS):

### 1. HTTPS über einen Reverse-Proxy (dringend empfohlen)

Die App liefert **reines HTTP** aus und legt das Login-Token im Browser ab. **Ohne HTTPS** könnte
das Token im Netzwerk mitgelesen werden. Setze daher einen Reverse-Proxy mit automatischem
Zertifikat davor. Beispiel mit **[Caddy](https://caddyserver.com)** (`Caddyfile`):

```caddy
arbeitsdoku.deine-domain.de {
    reverse_proxy localhost:3000
}
```

Caddy holt automatisch ein Let's-Encrypt-Zertifikat. (Analog mit nginx + certbot möglich.)
Wenn ein Proxy vor der App läuft, ist `app.set('trust proxy', 1)` bereits aktiv – die echte
Client-IP wird korrekt erkannt (für Login-Limit & Audit-Log).

### 2. Automatischer Start (systemd, Linux)

Damit die App nach Neustart/Absturz von selbst läuft, eine systemd-Unit anlegen, z. B.
`~/.config/systemd/user/arbeitsdoku.service`:

```ini
[Unit]
Description=Arbeitsdoku
After=network.target

[Service]
WorkingDirectory=/pfad/zu/arbeitsdoku
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=JWT_SECRET=DEIN_LANGER_GEHEIMER_WERT
Restart=on-failure

[Install]
WantedBy=default.target
```

Aktivieren:

```bash
systemctl --user daemon-reload
systemctl --user enable --now arbeitsdoku
loginctl enable-linger $USER   # damit der Dienst auch ohne aktive Sitzung läuft
```

> Tipp: ENV-Werte können auch aus der `.env` kommen statt in der Unit zu stehen.

### 3. Monitoring (optional)

Der Endpoint **`GET /health`** antwortet ohne Login mit `{"status":"ok","db":true}` (HTTP 200),
solange Server und Datenbank erreichbar sind, sonst HTTP 503. Ideal für Uptime-Checks
(z. B. Uptime-Robot, Load-Balancer oder ein Cron-Wächter).

### 4. Datensicherung einplanen

Siehe [Datenablage & Backup](#datenablage--backup). Mindestens die `data/`- und `uploads/`-Ordner
(und `storage/`, falls Dokumente genutzt werden) regelmäßig sichern.

---

## Datenablage & Backup

Alle veränderlichen Daten liegen im Projektordner (und sind aus der Versionsverwaltung ausgenommen):

| Ordner | Inhalt |
|---|---|
| `data/` | Die SQLite-Datenbank (`arbeitsdoku.db`) – Herzstück, **atomar** gespeichert (alle 5 s + beim Beenden). |
| `uploads/` | Firmenlogo und generierte App-Icons. |
| `storage/documents/` | Hochgeladene Dokumente (liegen **außerhalb** des öffentlichen Bereichs, nur per Login abrufbar). |
| `backups/` | Automatische Sicherungs-Backups, die vor jedem Restore angelegt werden. |

**Backup über die UI** (*Einstellungen → Datenbank-Backup*):

- **Backup herunterladen** – erzeugt ein ZIP mit Datenbank **+** Uploads (Logo/Icons) **+** Dokumenten.
- **Backup einspielen** – ersetzt die aktuellen Daten; vorher wird automatisch ein Safety-Backup in
  `backups/` abgelegt.

Für Server-Betrieb zusätzlich eine **dateibasierte Sicherung** (z. B. nächtlicher `rsync`/Cron der
Ordner `data/`, `uploads/`, `storage/`) einrichten.

---

## White-Label-Branding

App-Name, Theme-Farbe, Hintergrundfarbe und App-Icon sind über *Einstellungen → App-Branding*
konfigurierbar (Chef/Admin) – **ohne Code-Änderung**.

- **Defaults:** „Arbeitsdoku", grünes Theme, neutrales „AD"-Icon.
- **Icon-Upload:** PNG/JPG, mind. 256×256 px, beliebiges Seitenverhältnis (wird auf 512×512 quadratisch
  zugeschnitten). Alle PWA-Größen inkl. „maskable" werden automatisch erzeugt.
- **Reset-Button** stellt das Standard-Icon wieder her.
- Nach Branding-Änderungen lädt die App automatisch neu. Bereits als PWA installierte Geräte müssen
  neu installiert werden, damit das neue Icon übernommen wird.

---

## Update auf eine neue Version

```bash
cd arbeitsdoku
git pull
npm install            # falls sich Abhängigkeiten geändert haben
# Dienst neu starten, z. B.:
systemctl --user restart arbeitsdoku
```

Schema-Migrationen laufen **automatisch und abwärtskompatibel** beim Start – eine bestehende
Datenbank wird beim Hochziehen sicher aktualisiert. Trotzdem vor einem Update ein **Backup** ziehen.

---

## Entwicklung & Tests

| Befehl | Zweck |
|---|---|
| `npm start` | Produktionsbetrieb. |
| `npm run dev` | Dev-Server auf Port `3001` mit separater `data/local.db` und Dev-JWT. |
| `npm run clone-db` | Kopiert eine Datenbank per SSH und anonymisiert alle Passwörter zu `test` (interne Nutzung; Quelle in `.env.deploy`). |
| `node scripts/generate-icons.js` | Erzeugt die Standard-Icons aus `public/icons/source.svg` neu. |

Automatisierte Tests liegen unter `tests/` (Berechnungs-/Logiktests sowie echte Browser-Klick-Tests
mit Puppeteer). Details in [`tests/README.md`](tests/README.md).

Technik-Stack: Node.js/Express · `sql.js` (SQLite in WASM) · `pdfkit` (PDF) · `sharp` (Icons) ·
`bcryptjs` · `jsonwebtoken` · `multer` · Vanilla-JS-Frontend (kein Framework, kein Build).

---

## Fehlerbehebung (FAQ)

**„FATAL: JWT_SECRET ist nicht gesetzt oder zu kurz" beim Start.**
In `.env` muss `JWT_SECRET=` mit mindestens 32 Zeichen gesetzt sein (siehe [Installation](#installation)).

**Port 3000 ist belegt.**
Mit anderem Port starten: `PORT=8080 npm start` (bzw. `PORT` in `.env`/systemd setzen).

**Admin-Passwort vergessen.**
Server stoppen und ein neues Passwort setzen (ersetzt das des Admin-Kontos):
```bash
node -e "const b=require('bcryptjs'),fs=require('fs'),i=require('sql.js'); i().then(S=>{const db=new S.Database(fs.readFileSync('./data/arbeitsdoku.db')); db.run('UPDATE users SET password_hash=? WHERE username=?',[b.hashSync('NeuesPasswort123',10),'admin']); fs.writeFileSync('./data/arbeitsdoku.db',Buffer.from(db.export())); console.log('Admin-Passwort gesetzt.');});"
```
Danach mit `admin` / `NeuesPasswort123` anmelden und in der App ändern.

**Über-/Minusstunden stimmen nicht.**
Pro Mitarbeiter müssen **Soll-Stunden** hinterlegt sein (*Mitarbeiter → Bearbeiten*). Ohne sie kann
das Stundenkonto nicht korrekt berechnet werden. Das **„Gültig ab"-Datum** der Soll-Stunden gilt als
Anstellungsbeginn: davor werden keine Soll-Stunden gerechnet (keine Minusstunden vor dem Eintritt).
Setze es auf den tatsächlichen Eintrittstag – auch rückwirkend, um Altzeiten korrekt einzurechnen.

**Wie entferne ich einen ausgeschiedenen Mitarbeiter?**
Nicht löschen, sondern **ausstellen**: *Mitarbeiter → Ausstellen*, Austrittsdatum wählen. Der Account
kann sich nicht mehr anmelden, alle Zeiten/Abwesenheiten/Planungen bleiben aber erhalten und werden
für den Anstellungszeitraum weiter in Statistik und PDF berücksichtigt. Ausgestellte Mitarbeiter
liegen im *Papierkorb → Mitarbeiter*; dort kann man sie **wiedereinstellen** (Wiedereintrittsdatum;
die Lücke zählt 0 Soll-Stunden – auch mehrfach möglich) oder als Admin **endgültig löschen** (entfernt
alle Daten unwiderruflich – nur für versehentlich angelegte Konten gedacht).

**Warum hat der Admin kein Stundenkonto?**
Das **Admin-Konto** ist ein reines Verwaltungskonto und gilt nicht als Mitarbeiter – es erscheint
nicht in Zeiterfassung, Statistik oder Stundensalden. Nur Mitarbeiter, Chef und Buchhalter führen
ein Stundenkonto. (Beispiel: 13 Konten = 1 Admin + 12 Mitarbeiter-Konten mit Saldo.)

**Daten weg nach Neuinstallation?**
Die Daten liegen in `data/`, `uploads/`, `storage/`. Beim Klonen/Neuaufsetzen diese Ordner aus dem
Backup zurückspielen.
