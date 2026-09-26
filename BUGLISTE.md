# Bugliste — Code-Durchsicht vom 24.09.2026

Stand der Durchsicht: `ddae438` (Cache 413). Nur gelesen, nichts geändert.
Jeder Befund wurde im Code nachgeprüft; Verdachtsfälle, die sich nicht bestätigt haben, stehen
unten unter „Geprüft und in Ordnung".

**So wird die Liste geführt:** Kennungen (R1 …) bleiben fest, auch wenn Punkte erledigt sind —
sie tauchen in Commit-Nachrichten auf. Erledigt heißt: Häkchen setzen, Commit dahinterschreiben.
Neue Funde kommen unten mit der nächsten freien Nummer dazu.

| Status | Bedeutung |
|---|---|
| `[ ]` | offen |
| `[~]` | in Arbeit |
| `[x]` | erledigt (mit Commit) |
| `[-]` | bewusst verworfen (mit Begründung) |

---

## Hoch — echte Auswirkungen im Alltag

### [x] R1 · Automatisches Abmelden löscht getippte Entwürfe (Datenverlust) — erledigt in `5b9105d`
- **Wo:** `public/js/app-2-auth-layout.js:158` (`logout()` → `entwurfAllesLoeschen()`), Sitzungsdauer `routes/auth.js:108` (`expiresIn: '24h'`, keine Verlängerung)
- **Was passiert:** Die Sitzung gilt fest 24 Stunden ab Anmeldung. Läuft sie ab, führt der nächste
  Serveraufruf zu 401 → `logout()` → **alle** Formular-Entwürfe werden gelöscht. Ausgerechnet die
  Entwurfs-Sicherung, die Datenverlust verhindern soll, wird dabei geleert. Es erscheint auch keine
  Erklärung — man landet einfach auf der Anmeldeseite.
- **Beispiel:** gestern 16:30 angemeldet, heute 16:25 Tagesbericht angefangen, 16:35 „Speichern"
  → Anmeldeseite, Text weg.
- **Nachtrag beim Umsetzen (24.09.):** Es ist schlimmer — `api()` gibt nach dem Abmelden `null`
  zurück statt zu werfen. Das Eintragsformular (`app-3-dashboard.js:1502–1508`) hält das für Erfolg:
  zeigt **„Eintrag erstellt"**, löscht den Entwurf und springt weiter — gespeichert wurde nichts.
  Dasselbe Muster (Ergebnis ungeprüft) steckt in 136 schreibenden Aufrufen.
- **Gemessen (Prod-Kopie, 24.09.):** 218 Ablauf-Abmeldungen in 30 Tagen bei 11 Personen, über den
  ganzen Arbeitstag verteilt; **197 davon mit Neuanmeldung binnen 3 Minuten** — die Leute fliegen
  mitten in der Nutzung raus. Rund 90 % aller Anmeldungen sind erzwungene Neuanmeldungen.
- **Entscheidung (Alex, 24.09.):** gleitende Sitzung — abgemeldet nach **3 Tagen ohne Aktivität**,
  spätestens nach **30 Tagen** neu anmelden.
- **Vorschlag:** Entwürfe nur beim *bewussten* Abmelden löschen, beim automatischen behalten und
  nach der Neuanmeldung wieder anbieten. Meldung „Sitzung abgelaufen — bitte neu anmelden, deine
  Eingaben sind noch da". Zusätzlich gleitende Sitzung: Server erneuert das Token, wenn nur noch
  wenige Stunden übrig sind.

### [ ] R2 · Server kann bei bestimmten Fehlern komplett abstürzen *(herabgestuft, s. Neubewertung)*
- **Wo:**
  - `scheduler.js:314` — die minütliche Aufgabe `tick()` ist async, wird aber **ohne `await`** in
    `try/catch` gesetzt; das Fangnetz fängt dadurch nichts.
  - `routes/backup.js:207` — `await krypto.verschluesselnPuffer(…)` ohne Fehlerfang.
  - `routes/users.js:480 → 497` — Benutzername wird *vor* `await bcrypt.hash` geprüft, eingefügt
    *danach*. Legen zwei Leute gleichzeitig denselben Namen an, wirft der zweite Insert (UNIQUE).
- **Was passiert:** Express 4 fängt keine Fehler aus async-Routen, und es gibt keinen globalen
  `process.on('unhandledRejection')`. Node 22 beendet sich. systemd startet nach 5 s neu
  (`Restart=always`, geprüft) — aber alle Verbindungen brechen ab und bis zu 5 s noch nicht
  gespeicherter Änderungen gehen verloren (Autosave-Takt).
- **Vorschlag:** `tick(…).catch(…)`; async-Routen in einen Fehler-Wrapper; globaler
  `unhandledRejection`-Wächter, der protokolliert und `saveToFile()` aufruft statt zu beenden.
- **Neubewertung (24.09., nachgemessen):** Kein Auslöser ist im Betrieb tatsächlich erreichbar.
  Der Nutzer-Wettlauf lässt sich **nicht** nachstellen: 5 gleichzeitige Anlagen desselben Namens →
  1× 201, 4× 409, Server läuft weiter. Grund: `bcryptjs` hasht praktisch **blockierend** (die
  anderen Anfragen warten ~80 ms und prüfen danach) — der Kommentar „blockiert den Event-Loop
  nicht" in `routes/users.js:493` stimmt nicht. Die beiden anderen Stellen bräuchten einen Fehler,
  der sich nicht herbeiführen lässt. Bleibt eine **Absicherung gegen künftige Fehler** — sinnvoll,
  aber keine akute Gefahr. Herabgestuft auf **Mittel**.

### [x] R3 · Sicherung zurückspielen: halber Abbruch hinterlässt unbestimmten Zustand — erledigt in `3dadfd4`
- **Deployt:** Prod 25.09.2026 (`db4c4b0`, Cache 419).
- **Wo:** `routes/backup.js:484–533`, Sicherheitskopie `:486`, Rotation `scripts/make-backup.js:117`
- **Was passiert:** Erst wird die DB-Datei ersetzt, dann werden Dateien geschrieben, erst am Ende
  wird die DB neu geladen. Scheitert etwas dazwischen (z. B. volle Platte): Meldung
  „fehlgeschlagen", auf der Platte liegt die *neue* DB, im Speicher die *alte*. Das nächste
  Autospeichern überschreibt die neue wieder — startet der Server vorher neu, gilt die neue.
  Welche Daten gelten, ist Zufall.
- **Außerdem die Sicherheitskopie vor dem Zurückspielen:**
  - **unverschlüsselt** (`.zip`) — entgegen der Regel seit 09.09.2026
  - **unvollständig** — ohne Dokumente, Profilbilder, App-Icons
  - **wird nie aufgeräumt** — das Rotationsmuster erfasst nur `arbeitsdoku_backup_*`
- **Stand:** latent — auf dem VPS gibt es noch keine solche Kopie (über die Oberfläche wurde nie
  zurückgespielt).
- **Vorschlag:** Bei Fehler aus der Sicherheitskopie zurückspielen, oder Reihenfolge: Dateien →
  DB → sofort neu laden. Sicherheitskopie als `.adbk` verschlüsseln, vollständig machen, mitrotieren.
- **Gelöst (25.09.):** fünf Schritte — Prüfen, Sicherheitskopie (vollständig, verschlüsselt, bei den
  nächtlichen Sicherungen, ohne sie kein Weiter), Bereitlegen neben dem Ziel, Einsetzen nur per
  Umbenennen mit Zurückrollen, Aufräumen. Test `tests/rueckspielen-abbruch.js` löst Abbrüche echt aus
  (Schreibrechte) und prüft auch nach hartem Neustart.

---

## Mittel — Sackgassen und irreführende Zustände

### [x] R4 · Ewiger Lade-Kreisel auf 9 Seiten — erledigt in `8fcafa1`
- **Deployt:** Prod 25.09.2026 (`00ed4a3`, Cache 418).
- **Wo:** Mitarbeiter `app-5-team.js:1004`, Projekte `app-5-team.js:1919`, Notizen
  `app-8-comm-init.js:944`, Dokumente `app-6-admin.js:1432`, Papierkorb-Reiter
  `app-6-admin.js:1075 / 1138 / 1191 / 1270`
- **Was passiert:** Scheitert das Laden (Baustelle ohne Empfang), verschwindet die Meldung nach
  3 s, der Kreisel dreht weiter, kein „Erneut versuchen".
- **Vorschlag:** die vorhandene `renderLoadError()` verwenden (Dashboard, Planung, Statistik
  nutzen sie schon). Siehe auch R5 — beides über eine gemeinsame Seiten-Hülle lösen.
- **Gelöst (25.09.):** `seiteLaden()` für alle Seiten, zusammen mit R5. Beim Durchgehen kam heraus,
  dass es mehr als 9 Seiten waren: Schwarzes Brett, Werkzeuge, Abwesenheiten, Impressum und die
  Formulare zeigten bei Ladefehlern eine **leere** Liste bzw. ein leeres Formular statt eines Kreisels.
  Mit echtem Schaden: Die Einstellungen erschienen mit Ersatzwerten (Speichern hätte überschrieben),
  das Planungsformular verlor die Serien-Regel („Wiederholung entfernen?"). Lesefehler sagen nicht mehr
  „es wurde nichts gespeichert". Test `tests/seite-laden-ui.js`.

### [x] R5 · Ältere, langsame Seite überschreibt die gerade geöffnete — erledigt in `8fcafa1`
- **Deployt:** Prod 25.09.2026 (`00ed4a3`, Cache 418).
- **Wo:** Wächter `renderToken()/renderStale()` in `app-1-core.js:347` — genutzt nur von
  Dashboard, Planung, Statistik, Abwesenheiten. **17 Seiten ohne Wächter:** `renderEntryForm`,
  `renderPlanningForm`, `renderProjectForm`, `renderPdfExport`, `renderTools`, `renderSettings`,
  `renderDeletedEntries/Projects/Absences/Users`, `renderDocuments`, `renderVacationOverview`,
  `renderWelcome`, `renderBulletin`, `renderBulletinForm`, `renderUsers`, `renderProjects`
- **Was passiert:** Bei langsamem Netz sagt die Adresse „Planung", zu sehen ist das Auftrags-Board.
- **Vorschlag:** Wächter überall; am besten eine gemeinsame Seiten-Hülle (Laden + Fehleranzeige +
  Veraltet-Wächter), damit neue Seiten nicht wieder ohne gebaut werden.
- **Gelöst (25.09.):** gemeinsame Ladefunktion `seiteLaden()`, Zähler zusätzlich zentral in `render()`
  und `logout()`. **Auch die vier „geschützten" Seiten waren es nicht:** Übersicht, Planung und
  Statistik zogen ihre Marke erst nach dem ersten Laden, der Test zeigte bei Übersicht und Planung
  genau das Überschreiben. Regel jetzt: `seiteLaden()` ist das erste Warten einer Seite.
  Nicht erfasst: Neuzeichnen nach dem Speichern → R23.

### [x] R6 · Pause länger als Arbeitszeit → still ein 0-Stunden-Eintrag — erledigt in `0f03d56`
- **Deployt:** Prod 25.09.2026 (`8bdc1d4`, Cache 417); nachgebessert in `5ea9648`.
- **Wo:** `public/js/arbeitszeitrecht.js:127` (`restPause` nicht auf Eintragsdauer begrenzt),
  `routes/entries.js:37` (`calculateNetHours` klemmt auf 0), keine Prüfung in Oberfläche/Server
- **Beispiel:** 15:00–15:20 als erster Eintrag des Tages → 30 min Pause vorgeschlagen → **0 h**.
- **Gemessen (Prod-Kopie, 24.09.):** 2 Einträge, bei denen die Pause die ganze Arbeitszeit
  geschluckt hat — Eintrag 1139 (06.08., 13:15–13:45) und 1185 (14.08., 08:00–08:30), beide mit
  30 min Pause, beide als **0 h** gezählt: **1 Stunde Arbeit fehlt im Überstundenkonto.** August ist
  noch nicht abgerechnet (Abschluss bis 30.06.), die Einträge lassen sich also noch korrigieren.
- **Vorschlag:** Vorschlag auf Eintragsdauer begrenzen; „Die Pause ist länger als die Arbeitszeit"
  abweisen oder bewusst bestätigen lassen (Oberfläche und Server).

### [x] R7 · „Abmelden" und „Benachrichtigungen an/aus" können endlos hängen — erledigt in `ed0c1ba`, Test `tests/kleine-sackgassen-ui.js`
**Deployt:** Prod 26.09.2026 (`ed69b7a`, Cache 427).
- **Wo:** `app-5-team.js:163` (`await navigator.serviceWorker.ready` ohne Zeitgrenze) →
  `disablePush()` `:191` → `logout()` `app-2-auth-layout.js:154`; ebenso `enablePush()` `:173`
- **Was passiert:** Ohne aktiven Service Worker (z. B. privates Firefox-Fenster) löst das Warten
  nie auf — der Knopf wirkt **funktionslos**.
- **Vorschlag:** `Promise.race` mit 3 s Zeitgrenze; beim Abmelden den Push-Abbau nicht abwarten.

### [x] R8 · Neue Rechte greifen erst nach Seitenwechsel — erledigt in `ed8a76d`, Test `tests/kleine-sackgassen-ui.js`
**Deployt:** Prod 26.09.2026 (`ed69b7a`, Cache 427).
- **Wo:** `app-2-auth-layout.js:185` — `refreshUser()` vergleicht nur `role, can_plan,
  can_plan_all, can_bulletin, can_upload`; es fehlen `can_order`, `can_products_edit`,
  `can_products_add`
- **Was passiert:** Nach einer Rechtevergabe baut sich die Oberfläche nicht neu auf. Dasselbe
  Muster wie „Mein Konto" (zwei parallele Listen).
- **Nachtrag (24.09., beim Umsetzen von R1):** Auch die Anmelde-Antwort (`routes/auth.js`,
  `anmeldeAntwort`) zählt die Rechte einzeln auf — `can_products_add` fehlt. Bis `refreshUser()`
  antwortet, kennt die Oberfläche das Einlernrecht nicht.
- **Vorschlag:** alle `can_*`-Felder aus dem Objekt ableiten statt aufzählen; Test holt die
  Schlüssel von der Quelle (wie `tests/konto-rechte-ui.js`).

### [x] R9 · Englische und technische Fehlermeldungen — erledigt in `1bf11a8`
- **Deployt:** Prod 25.09.2026 (`351e2d9`, Cache 422).
- **Upload-Fehler** wörtlich durchgereicht: `routes/documents.js:251`, `routes/settings.js:60`,
  `routes/settings.js:344` — z. B. bei voller Platte „ENOSPC: no space left on device, open
  '/home/…'" (englisch **und** mit Serverpfad), oder „Unexpected field".
- **Push aktivieren:** Browserfehler englisch, z. B. „Registration failed – push service error"
  (Brave) — `app-5-team.js:174`, angezeigt ab `:311`.
- **Interne Feldnamen:** „Feld 'personal_note' ist zu lang" — `routes/entries.js:27`.
- **Globaler Fehlerbehandler** `server.js:192` macht aus allem „Interner Serverfehler" (500), auch
  aus „Anfrage zu groß" (Express-Grenze 100 kB) und „ungültige Anfrage" (400).
- ~~**Während Deploy/Neustart** (502/503) zeigt die App nur „Fehler" — `app-1-core.js:129`.
  Besser: „Server startet gerade neu — bitte gleich noch einmal".~~ Erledigt mit R4 in `8fcafa1`
  (502/503/504 ohne JSON → „Der Server ist gerade nicht erreichbar, vermutlich startet er neu").
- **Nach abgelaufener Sitzung** liefert `api()` `null`, einige Stellen greifen trotzdem zu
  (`app-4-planning-tools.js:1312 / 1345 / 1380`, `app-5-team.js:494`) → „Cannot read properties
  of null" kann aufblitzen.
- „User nicht gefunden" — `routes/statistics.js:461`.
- **Vorschlag:** zentrale Fehler-Übersetzung in der Oberfläche (JS-interne Fehler →
  „Unerwarteter Fehler — bitte Seite neu laden", echte Meldung in die Konsole); auf dem Server
  `err.type` / `err.code` auswerten.
- **Gelöst (25.09.):** `fehlertext.js` für Upload- und Dateifehler (Rohtext nur ins Protokoll),
  413/400 im Fehlerbehandler, Beschriftungen statt Feldnamen, „Mitarbeiter nicht gefunden",
  Push-Fehler übersetzt, `toast()` übersetzt Programm- und Netzfehler zentral und schweigt nach dem
  Abmelden. Die Null-Zugriffe nach abgelaufener Sitzung hatten sich mit R1 größtenteils erledigt;
  der Rest landet jetzt übersetzt oder gar nicht in einer Meldung. Test `tests/meldungen-deutsch.js`.
  Nebenbei: `deploy.sh` leitet die Stammdateien jetzt aus Git ab (die feste Liste hätte
  `fehlertext.js` nicht mitgenommen).

### [x] R10 · Fehlende Umlaute in sichtbaren Texten (~20 Stellen) — erledigt in `a9d7912`, Test `641f35c`
- **Deployt:** Prod 25.09.2026 (`351e2d9`, Cache 422).
- `routes/notes.js` 225, 308, 312, 342, 358, 405, 409 („Eigentuemer", „geloescht", „Empfaenger", „gehoert")
- `routes/push.js` 26, 84, **87** (auch der Text der Test-Benachrichtigung: „…auf diesem Geraet")
- `routes/settings.js` 374 („Bild ungueltig")
- `public/js/app-6-admin.js` 569, 581, 584 („auswaehlen", „zuruecksetzen")
- Protokolltexte: `ausstellen.js` 101, 113; `routes/users.js` 651, 671, 834
- **Vorschlag:** korrigieren; Prüfskript als Test, das Umlaut-Ersatz in sichtbaren Texten meldet.
- **Gelöst (25.09.):** 82 Stellen (mehr als die ~20 der Durchsicht) in Meldungen, Audit-Texten und
  Protokollen; Kennungen unverändert. Prüftest `tests/umlaute-in-texten.js`.

### [ ] R11 · Notiz-Sperre läuft nach 15 Minuten ab, ohne Verlängerung
- **Wo:** `routes/notes.js:8` (`LOCK_TIMEOUT_MINUTES = 15`), kein Herzschlag im Client
  (`app-8-comm-init.js:1181`), Freigabe per synchronem XHR in `beforeunload` (`:2336`)
- **Was passiert:** Wer länger schreibt, kann von einem Kollegen überholt werden und bekommt beim
  Speichern „gesperrt" — ohne Weg, die Sperre neu zu holen. Die Meldung nennt nicht, *wer* sperrt
  (Server liefert `editing_by_name`, Client zeigt ihn nicht). Chrome blockiert synchrones XHR beim
  Schließen — die Sperre bleibt dann 15 min stehen.
- **Vorschlag:** Sperre beim Tippen alle paar Minuten erneuern; Namen anzeigen;
  `fetch(…, { keepalive: true })` statt synchronem XHR.

### [x] R12 · „Bestellt" ohne Rückfrage und ohne Rückweg — erledigt in `eb7ac78`
- **Deployt:** Prod 25.09.2026 (`b20c46d`, Cache 421) — mit Menge und Produkt in der Meldung und
  „Doch nicht bestellt" in voller Stärke (beides Wunsch bzw. Abnahme Alex am Screenshot).
- **Wo:** `routes/orders.js:177`, Oberfläche `app-8-comm-init.js:895`; Ändern: `routes/orders.js:120`
- **Was passiert:** Ein Fehltipp am Handy verschiebt die Bestellung endgültig. Zurücknehmen geht
  nicht, löschen nur Admin — ein Chef sitzt fest. Außerdem erlaubt der Server, bereits bestellte
  Einträge nachträglich zu ändern (`ordered_at` wird nicht geprüft; die Oberfläche bietet es nicht an).
- **Vorschlag:** „Rückgängig"-Hinweis oder Rückfrage; Route „doch nicht bestellt" für Chef/Admin;
  Ändern bestellter Einträge für Nicht-Manager sperren.
- **Gelöst (25.09.):** keine Rückfrage (Alex), dafür „Rückgängig" in der Meldung und dauerhaft
  „Doch nicht bestellt" für alle mit Bestellrecht (`DELETE /api/orders/:id/order`); bestellte
  Einträge für **alle** gesperrt (409). Test `tests/bestellt-rueckweg.js`.

---

## Niedrig — Feinschliff

### [x] R13 · Zwei-Faktor-Code abgelaufen — erledigt in `8109987`, Test `tests/kleine-sackgassen-ui.js`
**Deployt:** Prod 26.09.2026 (`ed69b7a`, Cache 427).
Nach 5 Minuten scheitert jeder weitere Code mit „abgelaufen", raus nur über „Abbrechen"
(`routes/auth.js:158`, `app-2-auth-layout.js:57`). → Bei Ablauf automatisch zur Passworteingabe.

### [x] R14 · Meldungen stehen immer nur 3 Sekunden — erledigt in `3c6fdb1`
**Deployt:** Prod 25.09.2026 (`6712d7d`, Cache 424) — Meldungen dabei nach oben verlegt (Entscheidung Alex).
`app-1-core.js:1091` — zweizeilige Fehler kaum lesbar. → Fehler länger bzw. bis zum Antippen,
Dauer nach Textlänge.
**Gelöst (25.09.):** Dauer nach Textlänge (Fehler 6–15 s), Antippen schließt. Test `tests/lesbar-und-sicher-ui.js`.

### [ ] R15 · Auszahlungen: Name und Datumsprüfung uneinheitlich
Beim Anlegen wird der Anzeigename gespeichert, beim Bestätigen/Ablehnen/Zurückziehen der
Benutzername (`routes/payouts.js:207, 239`) — der Kommentar bei `:138` will genau das vermeiden.
„Wirksam ab" nur per Muster geprüft (`:117`), „2026-02-31" wird angenommen.

### [ ] R16 · Urlaubsübersicht „Stand:" zeigt nachts den Vortag
`routes/absences.js:262` (`toISOString`) — zwischen 0 und 2 Uhr. Die Berechnung selbst nutzt
korrekt Ortszeit (`berlinHeute`).

### [ ] R17 · Löschen ohne Protokolleintrag
Schwarzes Brett (`routes/bulletin.js:141`) und Bestellungen (`routes/orders.js:156`) löschen hart,
ohne Eintrag im Protokoll.

### [x] R18 · PDF-Download kann in Safari/iOS abbrechen — erledigt in `3c8e4cb`, Test `tests/kleine-sackgassen-ui.js`
**Deployt:** Prod 26.09.2026 (`ed69b7a`, Cache 427).
`app-8-comm-init.js:2298` — `URL.revokeObjectURL` direkt nach dem Klick. → verzögert freigeben.

### [ ] R19 · Mitarbeiter anlegen ohne Transaktion
`routes/users.js:495–505` — drei Inserts (Nutzer, Soll-Stunden, Anstellung) ohne Transaktion;
scheitert einer, entsteht ein Mitarbeiter ohne Soll-Stunden.

### [x] R20 · Eingabedialog verwirft Text bei Klick daneben — erledigt in `3c6fdb1`
**Deployt:** Prod 25.09.2026 (`6712d7d`, Cache 424) — Meldungen dabei nach oben verlegt (Entscheidung Alex).
`app-1-core.js:1266` (`promptModal`) — ärgerlich bei längeren Begründungen (z. B. Ablehnungsgrund).
→ Klick daneben nur schließen, wenn das Feld leer ist, sonst nachfragen.
**Gelöst (25.09.):** betraf 14 Fenster, nicht nur den Eingabedialog. Klick daneben schließt nur ohne
Eingaben, sonst Hinweis („Abbrechen" verwirft) — `klickDanebenSchliesst()`.

### [x] R21 · Abwesenheitskalender merkt sich die eigene Scrollposition als Benutzer-Wischen — erledigt in `e6c34e4`
- **Wo:** `public/js/abwesenheitskalender.js:303–313`
- **Was passiert:** Beim ersten Öffnen scrollt der Kalender so, dass „heute" im Bild steht. Das
  `scroll`-Ereignis dieser *eigenen* Bewegung wird als gemerkte Position gespeichert, als hätte der
  Benutzer gewischt. Öffnet man dieselbe Ansicht in anderer Breite (Handy gedreht, Fenster
  verkleinert), gilt die alte Pixelposition — „heute" kann außerhalb des Bildes liegen.
- **Gemessen:** „heute" bei 902 px, sichtbar bis 390 px, Stand 527 statt 779 — die 527 stammen aus
  der Desktop-Breite (902 − 1125/3). Gefunden, weil `tests/abwesenheitskalender-ui.js` seit dem
  Datumswechsel rot ist: Am 16.09. lag „heute" noch 7 px weiter links und damit zufällig im Bild.
- **Vorschlag:** nur echtes Wischen merken (die selbst ausgelöste Bewegung nicht speichern).

### [x] R22 · Test-Zeitfalle in `tests/auszahlung-gesamtbild.js` — erledigt in `e6c34e4`
- **Wo:** `werktage(40, 39)` — „die Werktage zwischen vor 40 und vor 39 Tagen"
- **Was passiert:** Fallen beide Tage auf ein Wochenende (am 24.09.: 15./16.08.), ist die Liste leer,
  der Test legt einen Urlaub ohne Datum an und bricht ab. Die App verhält sich korrekt.
- **Vorschlag:** ein Fenster wählen, das garantiert Werktage enthält.

### [ ] R23 · Neuzeichnen nach dem Speichern trifft die inzwischen geöffnete Seite
*(gefunden beim Bau von R4 + R5, 25.09.2026)*
- **Wo:** überall, wo ein Knopf nach `await api(…)` direkt die Seite neu zeichnet — z. B. Dokumente
  umbenennen/verschieben/löschen (`app-6-admin.js`, `renderDocuments()`), Werkzeuge
  (`renderTools()`), Produktverzeichnis (`renderProdukte()`), Einstellungen (`renderSettings()`),
  Papierkorb (Wiederherstellen).
- **Was passiert:** Speichern antippen und, solange die Antwort unterwegs ist, eine andere Seite
  öffnen. Kommt die Antwort, zeichnet der Knopf seine alte Seite über die neue — Adresse und Menü
  zeigen die neue. Dasselbe Bild wie R5, aber `seiteLaden()` hilft hier nicht: Der Aufruf ist ja
  frisch, nicht veraltet.
- **Gemessen (25.09., auf dem Stand nach R4 + R5):** Ordner umbenennen, Antwort 2 s verzögert,
  inzwischen „Mein Konto" geöffnet → danach Adresse `#/konto`, im Bild die Dokumente, und das Menü
  springt mit auf „Dokumente".
- **Vorschlag:** ein Helfer, der nur neu zeichnet, wenn die Adresse noch dieselbe ist wie beim
  Klick, und die Stellen darauf umstellen; Test nach dem Muster von `tests/seite-laden-ui.js`.


### [x] R24 · Erklärung am Warnzeichen („!") verschwindet zu schnell — erledigt in `3c6fdb1`
**Deployt:** Prod 25.09.2026 (`6712d7d`, Cache 424) — Meldungen dabei nach oben verlegt (Entscheidung Alex).
*(Hinweis Alex, 25.09.2026 — gehört zu R14)*
- **Wo:** `attachLongPressTooltip` / `showTooltip` in `app-1-core.js` (Zeichen aus
  `arbeitszeitrecht.js`, angebunden in `app-3-dashboard.js`)
- **Was passiert:** Das „!" an einem Zeiteintrag (zu lange gearbeitet, zu kurze Pause, zu kurze
  Ruhezeit) erklärt sich per Maus-Überfahren bzw. langem Druck. Am Handy blendet die Sprechblase nach
  fest 4 s aus — zu kurz zum Lesen. Am Rechner verschwindet sie, sobald die Maus das kleine Zeichen
  verlässt. Außerdem wird der 4-s-Zeitgeber nie zurückgesetzt: Zweimal kurz hintereinander gehalten,
  schließt der alte Zeitgeber die neue Sprechblase zu früh. Dasselbe gilt für die Detail-Sprechblasen
  der Einträge (B7).
- **Vorschlag:** Handy: stehen lassen bis zum nächsten Antippen oder Scrollen. Rechner: offen, solange
  die Maus auf dem Zeichen oder auf der Sprechblase ist, mit kurzer Kulanz beim Hinübergleiten.
- **Gelöst (25.09.):** so umgesetzt; gilt am Handy auch für die Detail-Sprechblasen der Einträge.

### [x] R25 · Zeitfeld am Handy öffnet die Uhr nicht mehr beim Antippen — erledigt in `5356b8b`
- **Deployt:** Prod 26.09.2026 (`91d06a3`, Cache 425).
- **Nachtrag (26.09., Hinweis Alex):** Datums- und Monatsfelder hatten dieselbe Umstellung — die Hilfe
  öffnet jetzt auch den Kalender (alle Feldarten time/date/month/week/datetime-local). Deployt Prod 26.09.2026 (`35d6085`, Cache 426).
*(Hinweis Alex, 25.09.2026)*
- **Was passiert:** Antippen von „Von"/„Bis" markiert nur Stunde oder Minute; die Uhr öffnet nur noch
  das Symbol rechts. Früher öffnete Antippen sofort die Uhr.
- **Ursache: der Browser, nicht die App.** Chrome 154 auf Android 10. Belegt mit einer Testseite ohne
  App (dasselbe Verhalten); im Code ist das Zeitfeld seit März unverändert, kein Handler unterdrückt
  den Tipp. Ein erster Versuch mit der Uhr-Hilfe auf claude.ai ergab „SecurityError" — dort liegt die
  Seite in einem fremden Rahmen, aus dem Chrome das Öffnen der Uhr verbietet. Auf dem eigenen Server
  (ohne Rahmen) öffnet `showPicker()` die Uhr beim Antippen zuverlässig.
- **Entscheidung Alex:** Uhr wie früher; das Symbol rechts bleibt. Umsetzung: beim Antippen
  `showPicker()` — nur Android mit Chrome-artigem Browser und nur bei Berührung, sonst unverändert.
- **Gelöst (25.09.):** so umgesetzt, Test `tests/uhr-hilfe-ui.js` (9), Gegenproben greifen.
---

## Geprüft und in Ordnung

Damit diese Punkte nicht ein zweites Mal untersucht werden:

- **Knöpfe ohne Funktion: keine.** Alle 297 Knöpfe in den Vorlagen per Skript gegen die
  Klick-Handler abgeglichen; die 3 Treffer waren Scheintreffer (dynamische Kennung beim
  „Erneut versuchen", eigener Hilfsbaustein `$s()` im Scanner, ein Kommentar). Keine eingebetteten
  `onclick` (die Sicherheitsrichtlinie `script-src 'self'` würde sie blockieren).
- **Datumsrechnung** sommerzeitsicher — Server und Oberfläche rechnen mit 12:00 Uhr bzw. UTC.
- **Restore-Pfad** zieht alle Migrationen hoch (`ensureAuditSchema` ruft alle `ensure*Schema`).
- **Letzter Admin** kann weder herabgestuft noch ausgestellt werden (`routes/users.js:540, 691`).
- **Push-Versand ohne `await`** ist sicher — `notifyUsers` fängt alles selbst ab.
- **Planungsrechte:** `can_plan_all` setzt `can_plan` immer mit (`routes/users.js:446, 560`).
- **Auszahlungen, Werkzeug-Ausleihe, Abwesenheits-Genehmigung:** kein hängender Zustand.
- **Kein XSS-Fund** — die verdächtigen Stellen sind Texte für Rückfrage-Dialoge, die selbst escapen.
- **Knopfsperren** (`disabled = true`) werden im Fehlerfall überall wieder aufgehoben.
- **Dienst auf dem VPS** startet nach einem Absturz selbst neu (`Restart=always`, 5 s).

---

## Vorgeschlagene Reihenfolge

1. **R1** — Datenverlust
2. **R2** — Absturz
3. ~~**R4 + R5** gemeinsam über eine Seiten-Hülle~~ erledigt
4. **R9 + R10** — Meldungen (lässt sich gut bündeln)
5. Rest nach Belieben
