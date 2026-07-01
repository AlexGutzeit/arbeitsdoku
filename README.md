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
| **📝 Notizen** | Persönliche und **geteilte** Notizen (Lese-/Schreibrechte pro Benutzer), mit Bearbeitungs-Sperre gegen gleichzeitiges Editieren. Empfänger können eine geteilte Notiz per **„Freigabe verlassen"** selbst aus ihrer Liste entfernen; beim Eigentümer verschwindet der Haken, er kann sie durch erneutes Anhaken wieder freigeben. Filterbar nach **eigenen / freigegebenen** Notizen (sowie gezielt **nach jedem einzelnen Freigeber**), Projekt und Suchtext. |
| **🗂️ Dokumente** | Dateiablage mit Ordnern/Unterordnern. Upload (PDF, MS-Office `docx/xlsx/pptx`, OpenDocument `odt/ods/odp`, Bilder PNG/JPG, `txt/csv/md`; max. Dateigröße standardmäßig 5 MB, vom Admin einstellbar, Magic-Byte-Prüfung gegen umbenannte `.exe`), Verschieben, Umbenennen, rekursives Löschen. Konfigurierbares Gesamt-Speicherlimit **und** Pro-Datei-Limit. Mitarbeiter laden nur herunter – außer sie bekommen das Upload-Recht. |
| **🏖️ Abwesenheit** | Krank, Urlaub, Freizeitausgleich, Sonderurlaub, Feiertag, Berufsschule, Innung. Urlaub/FZA/Sonderurlaub durchlaufen einen **Genehmigungs-Workflow**. Prioritätsbewusste Tageszählung (Feiertag > Krank > Schule/Innung > Urlaub/FZA) und korrekte Soll-Stunden-/Überstunden-Verrechnung. **Arbeiten trotz Abwesenheit ist möglich** und wird sauber verrechnet: an Urlaub/Schule/Feiertag-Tagen zählt gebuchte Zeit voll als Überstunden, bei **FZA** sinkt nur der Abzug. **Krank** ist überstundenneutral bis zur normalen Tagesleistung (Soll = min(gearbeitete Stunden, Normal-Soll)) – Mehrarbeit darüber hinaus zählt als Überstunden. |
| **📈 Statistik** | Soll-/Ist-Stunden und Überstunden je Zeitraum und Mitarbeiter, mit Diagrammen. |
| **📄 PDF-Export** | Druckfertiger Arbeitsnachweis (Einträge + Abwesenheiten + Stunden-Zusammenfassung) als PDF, gefiltert nach Zeitraum/Mitarbeiter/Projekt. |
| **⚙️ Einstellungen** | White-Label-Branding (Logo + App-Icon; **max. Bild-Dateigröße admin-einstellbar, Default 5 MB**), Dokumenten-Speicherlimit (Gesamt + pro Datei), Datenbank-Backup/Restore. *(Chef/Admin; Größenlimits nur Admin)* |
| **📜 Audit-Log** | Revisionssicheres Protokoll: An-/Abmeldungen (Login erfolgreich/fehlgeschlagen, manuelle Abmeldung, Sitzungs-Timeout), Benutzeränderungen, Einstellungs-/Branding-Änderungen, Backups u. a. Benutzeranlage mit allen Parametern, Änderungen feldgenau als „alt → neu" (Passwörter nie). Mit Filter (Aktion/Zeitraum), seitenweisem Nachladen und CSV-Export fürs Archiv. *(Admin)* |
| **🗑️ Papierkorb** | Gelöschte Einträge und Abwesenheiten bleiben mit Begründung erhalten (GoBD). **Gelöschte Zeit­einträge** können wiederhergestellt werden – jeder sieht/stellt wieder her, was er selbst gelöscht hat; Chef/Admin alles. **Gelöschte Abwesenheiten** werden für Chef/Mitarbeiter/Buchhalter **nicht** wiederhergestellt (das brächte sie als bereits genehmigt zurück und könnte mit zwischenzeitlicher Planung kollidieren) – stattdessen „**Neu beantragen**": ein frischer Antrag mit den alten Daten, der wieder durch die Genehmigung läuft. Nur der **Admin** kann eine Abwesenheit echt **wiederherstellen** (Ausnahme für versehentliche Löschungen). Im Unterreiter **Mitarbeiter** liegen ausgestellte Mitarbeiter zum Wiedereinstellen (**Chef/Admin** – Mitarbeiter haben darauf keinen Zugriff); endgültiges Löschen (mit allen Daten) ist dort nur als Admin und nur für zuvor ausgestellte Mitarbeiter möglich. |

**Querschnitts-Features:** Echtzeit-Updates über alle Geräte (Server-Sent Events), **Push-Benachrichtigungen
aufs Handy auch bei geschlossener App** (Web Push, optional je Gerät aktivierbar), **Navigations-Button mit
freier Wahl der Karten-App/des -Dienstes** (Auswahl-Dialog statt fester Google-Bindung – Android zeigt die
Geräte-Auswahl der installierten Apps, iOS/Desktop eine kuratierte Liste; Wahl merkbar), rollenbasierte
Sichtbarkeit, mobil-optimiert/installierbar (PWA), Brute-Force-Schutz am Login, durchgehend
parametrisierte SQL-Abfragen und HTML-Escaping (XSS-Schutz).

### 🔔 Push-Benachrichtigungen (Web Push)

Zusätzlich zu den Live-Zählern (die nur bei geöffneter App hochzählen) kann jeder Nutzer über den
Seitenleisten-Punkt **„🔔 Benachrichtigungen"** echte Geräte-Benachrichtigungen aktivieren – sie kommen auch
an, wenn die App geschlossen ist. Gemeldet wird genau das, was auch den jeweiligen Zähler erhöhen würde,
**außer für den Auslöser selbst**:

| Ereignis | Benachrichtigt wird |
|---|---|
| Neue Bestellung | Chef + Admin |
| Neuer/aktualisierter Aushang | alle außer dem Autor |
| Notiz geteilt/angeboten | die betroffenen Empfänger |
| Neuer Abwesenheitsantrag bzw. Krank-/Schule-/Innung-Meldung | alle Manager (Chef/Admin/Buchhalter) |
| Urlaub genehmigt/abgelehnt bzw. Abwesenheit vom Chef bearbeitet | der betroffene Mitarbeiter |

Pro Nutzer lassen sich die Kategorien (Abwesenheiten / Schwarzes Brett / Notizen, für Chef/Admin zusätzlich
Bestellungen) einzeln ein- und ausschalten (wird sofort gespeichert).

**Geplante Zusammenfassung (Digest):** Als Alternative zu den ereignisgetriebenen Pushes kann jeder Nutzer
beliebig viele **Zusammenfassungen** anlegen (**+**) – je mit **Name** (z. B. „Einkaufen"), **Wochentagen**,
**Uhrzeit** und **Kategorien**. Zur gewählten Zeit kommt **eine** Push mit den offenen To-dos, z. B.
„Du hast noch 3 Bestellungen, 2 Abwesenheiten und 4 Notizen zu bearbeiten." bzw. **„Es gibt nichts zu tun."**
(der Name wird zum Titel). So kann man die normalen Kategorie-Pushes ausschalten und sich stattdessen zu
festen Zeiten erinnern lassen. Jeder Plan ist **bearbeitbar**, einzeln **pausierbar** (Pause/Fortsetzen) und
löschbar; zusätzlich lassen sich mit **„Alle pausieren"** sämtliche Pläne auf einmal aussetzen (z. B. im
Urlaub). Die Zusammenfassung wird **unabhängig** von den Kategorie-Schaltern zugestellt.

**Voraussetzung:** In der `.env`
müssen `VAPID_PUBLIC`/`VAPID_PRIVATE`/`VAPID_SUBJECT` gesetzt sein (siehe Konfiguration) – fehlen sie, ist
Push inaktiv; die Benachrichtigungen-Karte zeigt dann statt des „Aktivieren"-Buttons einen Hinweis (für
Admins mit Einrichtungstipp). **Auf iPhone/iPad** funktioniert Web Push nur, wenn die App über „Teilen → Zum
Home-Bildschirm" installiert ist (PWA, ab iOS 16.4); Android-Chrome und Desktop funktionieren auch im
Browser-Tab.

Ein Gerät/Browser hat genau **ein** Push-Abo. Ist die Browser-Erlaubnis erteilt, wird das Abo beim Login
automatisch dem **aktuell angemeldeten Nutzer** zugeordnet – auf einem geteilten Gerät gehen die
Benachrichtigungen also immer an den, der gerade eingeloggt ist. Beim **Abmelden** wird das Push-Abo dieses
Geräts entfernt (beim nächsten Login folgt es wieder dem Angemeldeten); ein bewusstes **„Ausschalten"** bleibt
dagegen aus, bis wieder „Aktivieren" gedrückt wird. **Ausgestellte Mitarbeiter** erhalten keine
Benachrichtigungen mehr.

**Hinweise zur Zustellung:** Web Push läuft über den Push-Dienst des Browsers (Google/Apple/Mozilla) und
wird bei fehlendem Empfang nachgeliefert (TTL 1 Tag), Priorität „normal". Zu beachten: Am **Desktop** muss
der Browser laufen (auch im Hintergrund). Auf **Android** kann die Akku-Optimierung einzelne Browser in den
Standby schicken und Meldungen verzögern → für den Empfangs-Browser ggf. „uneingeschränkt" einstellen. Pro
Gerät am besten **einen** Browser bzw. die installierte PWA nutzen (zwei Browser = zwei getrennte Abos, ggf.
doppelte Meldungen). Mehrere Meldungen stapeln sich einzeln (werden nicht zusammengefasst).

---

## Rollen & Rechte

| Rolle | Sieht / darf |
|---|---|
| **Administrator** | Alles: Benutzer-, Projekt-, Einstellungsverwaltung, Audit-Log, kompletter Papierkorb/Wiederherstellung. |
| **Chef** | Wie Admin bei Team-/Projekt-/Einstellungs-Verwaltung und Sicht auf alle Daten – ohne Audit-Log. Papierkorb: **voller** Zugriff (alle gelöschten Einträge/Abwesenheiten + ausgestellte Mitarbeiter wiederherstellen). |
| **Buchhalter** | **Lesende** Manager-Sicht auf alle Mitarbeiterdaten/Statistiken/Nachweise (kein Verwalten von Stammdaten). Bei Abwesenheiten **read-only**: sieht alle, kann aber fremde **nicht** genehmigen/ablehnen/löschen/bearbeiten und keine Fremd-/Feiertagseinträge anlegen (eigene Abwesenheiten normal). Papierkorb: nur eigene. |
| **Mitarbeiter** | Nur die **eigenen** Daten (Zeiten, Abwesenheiten, Planung) + globale Feiertage. Papierkorb: sieht/stellt nur **selbst Gelöschtes** wieder her (kein Zugriff auf ausgestellte Mitarbeiter). |

**Zusätzliche Einzelrechte** (pro Benutzer unter *Mitarbeiter → Bearbeiten* vergebbar):

- **Planungsrecht** – zwei Stufen, getrennt vergebbar:
  - **sich** – darf nur sich selbst verplanen. In der Planung fällt die Mitarbeiter-Auswahl weg (Planung läuft auf den Nutzer selbst); fremde Abwesenheiten bleiben unsichtbar. Hat ein „alle"-Planer ihn einer **gemeinsamen** Planung zugewiesen, kann er diese für sich anpassen: Löschen klinkt nur ihn aus, eine Zeitänderung teilt den Eintrag auf (er bekommt seinen eigenen, die anderen bleiben unverändert).
  - **alle** – darf alle Mitarbeiter verplanen und sieht in der **Planungsansicht** deren Abwesenheiten (Typ, **ohne** Kommentar). Schließt „sich" automatisch ein.
- **Schwarzes Brett bearbeiten** – darf Aushänge verfassen
- **Dokumente hochladen** – darf in der Dateiablage hochladen/verwalten

> Geänderte Rechte greifen für den betroffenen Nutzer **ohne Ab-/Anmelden** – ein Seiten-Reload (F5) bzw. das Zurückkehren zum Tab genügt.

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

# 4b) (Optional) Push-Benachrichtigungen aktivieren: VAPID-Schlüsselpaar erzeugen und die drei
#     Werte (VAPID_PUBLIC/VAPID_PRIVATE/VAPID_SUBJECT) in .env eintragen. Ohne sie ist Push inaktiv.
node -e "console.log(require('web-push').generateVAPIDKeys())"

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
7. (Optional) **Push-Benachrichtigungen:** Sind die `VAPID_*`-Schlüssel in der `.env` gesetzt (siehe
   [Installation](#installation)), kann jeder Nutzer sie selbst über den Seitenleisten-Punkt
   **🔔 Benachrichtigungen** aktivieren (am Handy am besten als installierte PWA). Details im Abschnitt
   [Push-Benachrichtigungen](#-push-benachrichtigungen-web-push).

---

## Konfiguration (ENV-Variablen)

Konfiguration über die Datei `.env` (Vorlage: `.env.example`).

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `JWT_SECRET` | **ja** | – | Geheimer Schlüssel für die Login-Tokens. **Min. 32 Zeichen**, sonst startet der Server nicht. Lang und zufällig wählen, geheim halten. |
| `PORT` | nein | `3000` | HTTP-Port des Servers. |
| `DB_PATH` | nein | `./data/arbeitsdoku.db` | Pfad der SQLite-Datenbankdatei. |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | nein | – | Schlüsselpaar für **Push-Benachrichtigungen** (Web Push). Einmalig erzeugen mit `node -e "console.log(require('web-push').generateVAPIDKeys())"`. Fehlen sie, ist Push inaktiv. |
| `VAPID_SUBJECT` | nein | `mailto:admin@example.com` | Kontaktangabe (`mailto:` oder `https:`) für den Push-Dienst. |
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

**Sicherheits-Header:** Die App setzt selbst eine restriktive **Content-Security-Policy** sowie
`X-Frame-Options`, `X-Content-Type-Options` und `Referrer-Policy` (schützt u. a. gegen
eingeschleuste Skripte/XSS und Clickjacking). Die **HTTPS-Erzwingung (HSTS)** überlässt sie bewusst
dem Reverse-Proxy – bei Caddy ist HTTPS automatisch aktiv; HSTS kann dort bei Bedarf ergänzt werden.

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
  `backups/` abgelegt. Das Upload-Limit beim Einspielen ist **dynamisch** = konfiguriertes Dokumenten-
  Speicherlimit **+ Reserve** (für DB/Icons), damit ein selbst erzeugtes Backup immer wieder eingespielt
  werden kann – auch wenn die Dokumenten-Ablage groß ist.

Für Server-Betrieb zusätzlich eine **dateibasierte Sicherung** (z. B. nächtlicher `rsync`/Cron der
Ordner `data/`, `uploads/`, `storage/`) einrichten.

**Wiederherstellung (getestet):** Ein per *Backup herunterladen* (oder per Cron) erzeugtes ZIP wird über
*Einstellungen → Backup einspielen* hochgeladen. Der Server prüft das ZIP, legt **zuerst** ein
Safety-Backup der aktuellen Daten an, schreibt die Datenbank **atomar** zurück, stellt Uploads/Dokumente
wieder her und **lädt live neu** (kein Neustart nötig). Wichtig: Das Backup enthält die **echten
Passwörter zum Sicherungszeitpunkt** – nach dem Einspielen gelten wieder genau diese Anmeldedaten. Bei
Totalverlust genügen die drei Ordner `data/`, `uploads/`, `storage/` aus einer Dateisicherung bzw. das
ZIP über die UI.

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

Push-Tests (kein Browser nötig): `node tests/push-api.js` (Abo-/Einstellungs-Endpunkte),
`node tests/push-targeting.js` (richtige Empfänger je Ereignis + 410-Bereinigung),
`node tests/push-sw.js` (Service-Worker-Handler).

Technik-Stack: Node.js/Express · `sql.js` (SQLite in WASM) · `pdfkit` (PDF) · `sharp` (Icons) ·
`bcryptjs` · `jsonwebtoken` · `multer` · `web-push` (Push) · Vanilla-JS-Frontend (kein Framework, kein Build).

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
das Stundenkonto nicht korrekt berechnet werden. Man kann **mehrere „Gültig ab"-Einträge** hinterlegen,
wenn sich die Wochenstunden im Laufe der Anstellung ändern – ab dem jeweiligen Datum gilt dann der neue
Wert (Staffelung). Das **früheste „Gültig ab"-Datum** gilt als **Anstellungsbeginn**: davor werden keine
Soll-Stunden gerechnet (keine Minusstunden vor dem Eintritt). Setze das früheste auf den tatsächlichen
Eintrittstag – auch rückwirkend, um Altzeiten korrekt einzurechnen.

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
