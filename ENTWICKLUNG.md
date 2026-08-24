# Entwicklungsnotizen

Diese Datei ist das **Werkstattbuch**: Warum die Tests so gebaut sind, wie sie gebaut sind, was sie
über die Zeit aufgedeckt haben, und welche Fallen beim Ändern wieder zuschnappen können.

Das [README](README.md) beschreibt dagegen den **Ist-Zustand** — was die App kann und wie man sie
betreibt. Wer nur wissen will, wie etwas heute funktioniert, ist dort richtig und braucht diese
Datei nicht.

---

## Änderungsverlauf (Auszug)

Nur Punkte, bei denen das **Warum** später noch von Belang ist. Der vollständige Verlauf steht in
der Git-Historie (`git log`).

### 2026-08-24 · Sicherungen verschlüsseln — der Schlüssel liegt nicht auf dem Server

Alex' Frage war präzise: „Bringt eine verschlüsselte Datenbank etwas, wenn der Schlüssel in der
`.env` daneben liegt?" Nein. Die App muss ständig entschlüsseln, also kann es jeder auch, der auf
dem Server ist. Geschützt werden können nur **ruhende** Kopien — und genau die waren das Problem:
167 vollständige Klartext-Kopien mit Kundennamen, Adressen, Geburtsdaten und
Abwesenheits-Kommentaren, verteilt auf VPS, Mini-PC und einen Laptop mit **unverschlüsselter
Platte**.

Deshalb **asymmetrisch**: Der Server bekommt nur öffentliche Schlüssel. Er kann sichern, aber nicht
lesen. Zwei Empfänger — die Zweitanlage (damit die Notfall-Umschaltung ohne Menschen läuft) und ein
Offline-Schlüssel.

**Warum ECDH P-256 und nicht X25519.** X25519 wäre die modernere Wahl. Aber die Entschlüsselung
muss im Browser laufen — auch in einer Seite, die per Doppelklick von einem USB-Stick geöffnet
wird. Nachgemessen statt angenommen: Eine `file://`-Seite ist ein sicherer Kontext, `crypto.subtle`
ist dort verfügbar, und WebCrypto beherrscht ECDH P-256, HKDF-SHA256 und AES-256-GCM überall.
X25519 nicht. Ein Format für Node und Browser ist mehr wert als die schönere Kurve.

**Warum die Entschlüsselung im Browser liegt.** Ein Feld „Schlüssel" auf einer Serverseite wäre
bequemer gewesen — und hätte den Zweck aufgehoben: Der Schlüssel wäre über die Leitung gegangen.
Also entschlüsselt der Browser und schickt dem Server das fertige ZIP, das dieser wie bisher
behandelt. Der Test schneidet **alle** Anfragen mit und belegt, dass der Schlüssel in keiner
einzigen vorkommt; er vermutet es nicht.

**Eine Datei, zwei Einbindungen.** `public/js/sicherung-krypto.js` nutzen sowohl die
Einstellungsseite als auch das Notfall-Werkzeug. Zwei Fassungen wären auseinandergedriftet, und
ausgerechnet die, die man im Ernstfall braucht, ist die nie benutzte.

**Die Reihenfolge beim Altbestand ist der ganze Punkt.** Verschlüsseln, sofort wieder
entschlüsseln, Byte für Byte vergleichen — und **erst danach** das Klartext-ZIP löschen. Ein
Formatfehler wäre sonst der stille Totalverlust der Historie, bemerkt erst, wenn jemand sie
braucht. Ohne privaten Schlüssel wird verschlüsselt, aber nichts gelöscht; auf einem Server, der
absichtlich nicht lesen kann, ist das der richtige Ausgang. Drei Gegenproben belegen es: vor dem
Beweis löschen, die Prüfung überspringen, der Fehlerweg räumt zu viel weg — jede lässt den Test
umfallen.

**Was das ausdrücklich nicht löst:** Wer den laufenden Server übernimmt, sieht die Daten weiterhin.
Dagegen hilft der zweite Faktor, die Rechteverwaltung und ein aktuelles System — keine
Verschlüsselung.

**Der teuerste Fehler wäre kein Programmfehler.** Wer alle privaten Schlüssel verliert, verliert
die gesamte Historie, endgültig. Deshalb zwei Empfänger, und der Offline-Schlüssel gehört an zwei
getrennte Orte, bevor die erste verschlüsselte Sicherung entsteht.

### 2026-08-23 · Der Nutzer schneidet sein Profilbild selbst zu

Alex' Frage: „Woher weiß die App, welchen Ausschnitt ich haben möchte?" Antwort: gar nicht. Sie
riet mit `sharp`s `position: 'attention'` — laut Dokumentation die Region mit der höchsten
Luminanzfrequenz, Farbsättigung und Hautton-Präsenz. **Keine Gesichtserkennung.** Ein Vergleich an
vier Fällen zeigte: deutlich besser als ein Mittelschnitt (bei einer Person am Bildrand oder einem
Kopf am oberen Rand rettet sie das Bild), aber bei zwei Personen wählt sie eine aus, ohne zu
fragen. Schlimmer noch: Gespeichert wurden nur die fertigen Quadrate — ein schiefer Ausschnitt war
damit **endgültig**.

**Der Ausschnitt reist in Bildpunkten des Originals, nicht in Bildschirmpunkten.** Was der Browser
anzeigt, muss nicht dem entsprechen, was `sharp` sieht: Der Browser dreht ein Handyfoto anhand der
EXIF-Angabe selbst, und beim späteren Nachschneiden liegt auf der Platte ein auf 1600 px
heruntergerechnetes Original. Deshalb schickt die Oberfläche die Maße des Bildes MIT, das sie
angezeigt hat, und der Server rechnet verhältnismäßig um. Ein Test schickt bewusst halbierte Maße
und prüft, dass trotzdem das richtige Viertel im Kreis landet.

**Bedient wird das Bild, nicht der Rahmen.** Der Kreis steht fest, das Foto wird darunter
geschoben. Am Handy ist das die vertraute Geste, und der Rahmen kann nie aus dem Bild laufen —
das Begrenzen passiert an einer einzigen Stelle (`begrenzen()`), nicht an jedem Ereignis einzeln.

**Zwei Fallen, beide beim Bauen zugeschnappt:**

* `router.get('/original')` stand hinter `router.get('/:id')`. Express nimmt die erste passende
  Route — `/api/avatare/original` wäre also als Nutzer-Kennung „original" gelesen worden. Steht
  jetzt davor, mit einem Kommentar, der erklärt warum.
* `touch-action: none` auf der Bühne ist kein Feinschliff, sondern die Bedingung dafür, dass der
  Finger das Bild verschiebt statt die Seite zu scrollen. Ohne die Zeile wäre der Dialog am Handy
  unbedienbar — sie steht deshalb als eigene Zusicherung im Test und nicht nur im Stylesheet.

**Gemessen statt behauptet:** Beide Tests arbeiten mit einem Bild aus vier verschiedenfarbigen
Vierteln. Welches im Kreis landet, ist an der Farbe ablesbar. Die Richtungsprobe zielt bewusst auf
ein Viertel, das die Bildmitte NICHT trifft — die erste Fassung zielte auf „rechts unten", was
zufällig auch ohne jedes Schieben herauskam, und hätte damit nichts geprüft.

**Und ein Eigentor beim Gegenprüfen:** Nach der Sabotage habe ich `git checkout -- routes/avatare.js`
gerufen, um sie zurückzunehmen — die Datei war aber noch nicht committet, und damit war die
gesamte Serverarbeit weg. Regel für die Zukunft: **erst committen, dann sabotieren.** Eine Kopie
neben der Datei hilft nur, wenn man sie nicht im selben Befehl wieder löscht (auch das ist in
dieser Nacht passiert).

---

### 2026-08-23 · PDF-Nachweis zieht auf „Mein Konto"; zweiter Tab flog beim Abmelden mit raus

**„Auf allen Geräten abmelden".** Alex fragte, ob man sich damit aussperren kann. Gemessen im
Browser — nicht gelesen: Das klickende Gerät bleibt drin, weil die Antwort sofort ein frisches
Token liefert und die Oberfläche es übernimmt (es überlebt auch ein Neuladen). Ein zweiter Tab
**auf demselben Gerät** flog aber heraus: Er hält sein Token im Speicher seiner Seite und erfuhr
von der Erneuerung nichts. Behoben über das `storage`-Ereignis, das genau in den *anderen* Tabs
feuert. Bewusst nur ein NEUES Token wird übernommen — verschwindet das Token (Abmelden anderswo),
passiert nichts: Bei einem JWT ist das reines Aufräumen im Browser, und jemanden ungefragt aus
einer laufenden Eingabe zu werfen wäre schlimmer als ein Tab, der noch offen ist.

Auf API-Ebene war das längst geprüft (`konto-sitzung-daten.js`). Was fehlte: **Den Knopf hatte im
Browser nie jemand gedrückt** — geprüft war nur, DASS er existiert. Genau in dieser Lücke saß der
Fehler. Beim Bauen des neuen Tests dann ein lehrreicher Fehlschlag: Der erste Wurf suchte den
Dialog-Knopf über die Beschriftung und traf „Abmelden" in der Kopfzeile. Der Test meldete sich
selbst ab und behauptete dann, der Knopf sperre einen aus. Seither über
`.dialog-modal [data-act="ok"]`, mit einer Zeile davor, die belegt, dass der Dialog aufgeht.

**PDF-Nachweis.** Für einen Mitarbeiter war `#/pdf` nur der Download seiner eigenen Zeiten — eine
persönliche Sache. Sie sitzt jetzt als Karte auf „Mein Konto"; der Menüpunkt entfällt für ihn, die
Adresse leitet um (Lesezeichen), und Chef/Admin/Buchhalter behalten „Abrechnung" unverändert, weil
Lohn-CSV und Monatsabschluss auf einer persönlichen Seite nichts zu suchen hätten.

Das Formular steht damit an zwei Orten und darf trotzdem nur EINMAL im Code existieren, sonst
laufen die beiden mit der Zeit auseinander: `pdfFormularHtml()` und `pdfFormularBinden()` in
`app-7-stats-pdf.js`. Die Mitarbeiter-Auswahl ist ein Schalter — auf der Konto-Karte fehlt sie, dort
gibt es ausschließlich die eigenen Zeiten (serverseitig ohnehin, aber die Oberfläche soll es gar
nicht erst anbieten).

**Die Falle beim Umbenennen von Menüpunkten hat wieder zugeschlagen** — diesmal beim Entfernen:
`lohn-export-ui.js` wartete beim Anmelden auf `a[href="#/pdf"]` und lief für den Mitarbeiter in
eine Zeitüberschreitung. Wer einen Menüpunkt anfasst, muss mit `grep` durch `tests/`; ein Warten
auf einen Menüpunkt gehört an einen, den JEDE Rolle hat.

---

### 2026-08-23 (nachts) · Die Zeitfalle um Mitternacht

Beim Abschluss-Lauf der Suite um kurz nach Mitternacht fielen auf einmal zehn Tests um, die
tagsüber grün waren. Kein Zufall und keine Flakiness: **SQLite schreibt `strftime('now')` in UTC**,
im Sommer zwei Stunden hinter unserer Uhr. Zwischen 00:00 und 02:00 Uhr sind „UTC-heute" und
„hier-heute" zwei verschiedene Tage.

**Ein echter Fehler in der App war dabei.** Die Willkommensseite filterte die Aushänge mit
`b.created_at.slice(0, 10) === today` — roher UTC-Zeitstempel gegen lokales Datum. Ein Aushang, der
um 00:30 Uhr geschrieben wurde, war damit zwei Stunden lang unsichtbar und tauchte um 02:00 Uhr
von selbst auf. Im Tagesbetrieb bemerkt das niemand; nachts glaubt man es nicht.

Behoben mit `datumAusZeitstempel()` (`app-1-core.js`), die einen DB-Zeitstempel in den hiesigen
Kalendertag umrechnet. **Bewusst im Frontend, nicht im Server:** Die Marke `created_at` wird auch
gegen `user_seen` verglichen, um den Zähler am Menüpunkt zu setzen. Verschöbe man sie im Server,
liefen Anzeige und Zähler auseinander.

Ebenfalls angeglichen: Das Geburtsdatums-Feld begrenzte per `toISOString()` auf das UTC-Datum,
während der Server gegen das Berliner Datum prüft. Feld und Server waren nachts eine Tagesgrenze
auseinander.

**Der Rest waren Testfehler** — 43 Datumsrechnungen in 24 Testdateien, die den *aktuellen*
Zeitpunkt über `toISOString()` in ein Datum verwandelten. Alle auf `toLocaleDateString('sv-SE')`
umgestellt (liefert dasselbe Format, aber lokal). **Nicht angefasst** wurden Rechnungen, die auf
einem festen Anker stehen (`new Date(iso + 'T12:00:00Z')`, `setUTCDate`) — dort ist UTC richtig,
und lokal zu rechnen hätte sie kaputt gemacht.

**Die Lehre für neue Tests:** Ein Datum aus „jetzt" gehört über die lokale Uhr gebildet, ein Datum
aus einem ISO-String über einen UTC-Anker. Wer das mischt, baut einen Test, der zwischen 00:00 und
02:00 Uhr aus dem falschen Grund rot wird — oder, schlimmer, aus dem falschen Grund grün bleibt.

`tests/aushang-mitternacht-ui.js` stellt die Falle deshalb **absichtlich**, zu jeder Uhrzeit: Die
Antwort auf `/api/bulletin` wird im Browser abgefangen und der Zeitstempel auf „heute, 00:30 Uhr
bei uns" gesetzt — was in UTC zwangsläufig der Vortag ist. Der Test prüft ausdrücklich vorher nach,
dass die Falle wirklich steht, sonst prüfte er nichts.

---

### 2026-08-22 (nachts) · Profilbilder, Geburtstags-Freigabe, „Mein Konto" komplett
Aufbauend auf der Konto-Seite: Profilbild, eigenes Geburtsdatum samt Freigabe, eigene Stammdaten,
die Benachrichtigungen von ihrer eigenen Seite hierher, „überall abmelden" und die Datenauskunft.

**Profilbilder liegen hinter der Anmeldung** — anders als das Firmenlogo, das öffentlich unter
`uploads/` liegt. Ein Gesichtsfoto ist ein personenbezogenes Datum; wer die Firma verlässt, soll
nicht weiter an die Bilder der Kollegen kommen. Folge: Ein `<img src>` kann keinen Anmelde-Token
mitschicken, die Bilder werden per `fetch` geholt und als `blob:` angezeigt. Dafür steht `blob:`
jetzt in der Sicherheitsrichtlinie — `data:` bleibt verboten, das wäre die viel breitere Erlaubnis.

**Zwei Größen** (96 und 512 px), aus demselben Original gerechnet. Die große ist zugleich der
Bestand: Braucht man später eine dritte, lässt sie sich daraus ableiten, ohne dass jemand neu
hochlädt.

**Ohne Bild ändert sich nichts** (Alex' Vorgabe): Der Platzhalter bleibt unsichtbar im Baum — er
muss dort stehen, weil die Seite gebaut wird, BEVOR die Übersicht der Bilder eintrifft; ohne
Platzhalter wäre er später nicht mehr auffindbar. Genau daran ist der erste Versuch gescheitert
(leere Kopfzeile nach jedem Neuladen).

**Die Sicherung musste mit.** `routes/backup.js` kannte nur `uploads/` und `storage/documents/`.
Ohne Ergänzung wären nach einem Restore alle Gesichter weg gewesen — die Datenbank hätte von den
Bildern gewusst, die Dateien nicht mehr existiert. Gilt auch für `make-backup.js` auf dem Server;
das ist noch offen und gehört in die Deploy-Vorbereitung.

**Geburtstags-Freigabe schließt eine alte Lücke.** Beim Bau der Geburtstags-Einblendung stand hier,
eine Anzeige für die ganze Belegschaft wäre einwilligungspflichtig. Genau die Einwilligung gibt es
jetzt — durch die betroffene Person selbst, zweistufig. Der Endpunkt ist damit nicht mehr
GESPERRT, sondern GEFILTERT; zwei ältere Tests erwarteten noch 403 und sind nachgezogen.

**„Überall abmelden" ohne Sitzungsverwaltung:** ein Zähler je Nutzer, der im Token mitfährt. Passt
er nicht mehr, ist das Token wertlos. Der Klickende bekommt sofort ein frisches — sonst würfe er
sich selbst hinaus. Abwärtskompatibel, weil ein fehlender Anspruch als 0 gilt: Token aus der Zeit
davor bleiben gültig, solange niemand den Knopf gedrückt hat.

**Zwei Testfallen, beide nicht in der App:**
* Puppeteer scrollt ein Element nur so weit in den Sichtbereich, dass es gerade hineinragt — bei
  dieser App landet es damit **unter der klebenden Kopfzeile**, und der Klick trifft den Kopf.
  Symptom: kein Absende-Ereignis, keine Anfrage, keine Fehlermeldung, die Karte bleibt einfach
  stehen. Die Suche danach kostete vier Anläufe. Wer hier klickt, scrollt vorher mittig.
* Ein Abschnitt fand keine Avatare in Planung und Zeitnachweis — nicht wegen der Bilder, sondern
  weil die frische Datenbank keine Einträge hatte und es deshalb gar keine Spalten gab.

### 2026-08-22 · Zwei-Faktor-Anmeldung — was dabei zweimal fast schiefging
Die App stand mit Benutzername und Passwort allein im Netz. Neu ist ein zweiter Faktor (TOTP), je
Rolle unterschiedlich oft verlangt, plus die erste persönliche Seite der App („Mein Konto") — die
es ohnehin brauchte, denn ein Mitarbeiter konnte bis dahin nicht einmal sein eigenes Passwort
ändern.

**TOTP selbst gebaut statt Paket.** Nicht aus Prinzip: RFC 6238 liefert **offizielle Testvektoren**
mit. Eigener Code lässt sich damit gegen die Norm beweisen, eine Fremdbibliothek müsste man
glauben — und wäre eine Lieferkette mehr in einem öffentlichen Repo. Nur für den QR-Code kam eine
Abhängigkeit dazu (`qrcode-svg`, MIT, **null** Unter-Abhängigkeiten); einen QR-Encoder selbst zu
schreiben hieße Reed-Solomon nachzubauen.

**Zwei Funde, die den Entwurf geprägt haben — beide älter als dieses Feature:**

1. `authenticate` prüfte nur die Unterschrift und las `userId`. Jedes mit demselben Geheimnis
   signierte Token kam damit überall durch — das **60-Sekunden-SSE-Ticket war eine Minute lang ein
   vollwertiger Zugangs-Token für die gesamte API**. Der Wächter ist eine Verbotsliste
   (`sse`, `pending2fa`): Wer künftig einen weiteren Sonder-Token einführt und ihn nicht einträgt,
   reißt die Lücke wieder auf.
2. `ensureAuditSchema` läuft **nur im Restore-Pfad**, nie beim normalen Start. Wer eine Migration
   dort einhängt, baut etwas, das auf dem laufenden Produktivserver nie greift. Vorbild ist
   `ensurePushSchema` mit seinen **zwei** Aufrufstellen.

**Die 2FA-Felder liegen in eigenen Tabellen, nicht in `users`.** `authenticate` liest bei jeder
Anfrage eine feste Spaltenliste aus `users`; eine fehlgeschlagene Migration dort sperrt die ganze
Firma aus (ist hier schon einmal passiert). Scheitert die 2FA-Migration, ist schlimmstenfalls 2FA
nicht verfügbar. Dieselbe Leitlinie zieht sich durch: **jeder 2FA-Fehler wird geschluckt und
bedeutet „kein zweiter Faktor", nie „kein Zugang".**

**Was der Browser-Test fand und kein API-Test finden konnte:**
Falsches Passwort und falscher Code antworteten mit **401** — und die App meldet bei jedem 401
automatisch ab (`app-1-core.js`). Ein Tippfehler hätte den Nutzer aus der Anwendung geworfen. Seither
gilt: **400 für Fehleingaben eines angemeldeten Nutzers, 401 nur für ein ungültiges Sitzungs-Token.**
Die API-Tests hatten brav „401 ✓" geprüft und die Folge nicht gesehen.
Ebenfalls dort aufgeschlagen: Element-Kennungen wie `2fa-start` sind **ungültiges CSS** — eine
Kennung darf nicht mit einer Ziffer beginnen. `getElementById` verzeiht es, `querySelector` wirft,
und eine CSS-Regel hätte nie gegriffen.

**Eine Gegenprobe, die nichts bewies.** Die Prüfung „ein voller Token taugt nicht als
Zwischen-Token" schickte einen *falschen* Code mit — sie scheiterte am Code, nicht an der
Token-Art. Der Riegel liess sich entfernen, ohne dass der Test es merkte. Erst mit **gültigem** Code
beißt sie. Merke: Eine Verneinung muss so gebaut sein, dass **nur** die geprüfte Eigenschaft den
Unterschied macht.

**Und einer, der aus dem falschen Grund grün war:** „die Änderung greift sofort trotz
Zwischenspeicher" ging über `GET /api/settings` — das liest direkt aus der Datenbank und am
Zwischenspeicher vorbei. Ersetzt durch die kleinere, ehrliche Aussage; belegt wird es jetzt vom
Anmelde-Test, der `modusFuerRolle` wirklich benutzt.

**Test sperrte sich selbst aus:** `twofa-regeln.js` stellte `twofa_admin` scharf und bekam ab da
403 auf alles. Richtiges Verhalten — der Zwang greift sofort. Der Test richtet jetzt vorher einen
Authenticator ein. Wer 2FA im Test scharf schaltet, muss das mitbedenken.

**Notfall:** `TWOFA_AUS=1` setzt den zweiten Faktor firmenweit aus, ohne etwas zu löschen. Das ist
der einzige Weg zurück, wenn der einzige Admin sein Handy verliert — steht deshalb im README, nicht
in einer Fußnote.

### 2026-08-18 · Meldung bei geänderter Notiz — und warum der Coin nicht am Push hängt
Alex meldete: Kollege bearbeitet eine mit Schreibrecht geteilte Notiz, der Eigentümer bekommt nichts,
obwohl der Kategorie-Schalter „Notizen" an ist. Am Produktivstand nachgesehen (nur lesend, über eine
Kopie): Freigabe `write`, Schalter an, Push-Abo aktiv — an der Einstellung lag es nicht. Die
Speichern-Route verschickte schlicht **nie** einen Push; den gab es nur beim Teilen und beim Anbieten.

**Zwei Irrtümer, die hier leicht passieren:**

1. Das `broadcast('notes')` in der Route sieht aus wie eine Benachrichtigung, ist aber nur SSE — es
   aktualisiert Fenster, die die Seite **gerade offen** haben. Wer nichts offen hat, erfährt nichts.
2. Der **Coin hängt nicht am Push**, sondern an `updated_at`/`updated_by` (siehe `computeBadgeCounts`).
   Deshalb reichte es für den zweiten Wunsch („Leer-Speichern soll nichts auslösen") NICHT, den Push
   zu unterdrücken: Bei Gleichstand darf gar nicht erst geschrieben werden. Die Bearbeitungs-Sperre
   wird trotzdem gelöst, sonst hängt die Notiz für alle anderen fest.

Gleiches Verhalten am Schwarzen Brett ergänzt: Anlegen meldet wie bisher, Bearbeiten nur bei
inhaltlicher Änderung. Ein **nicht mitgeschicktes Feld** heißt dort „unverändert lassen" und darf
folglich auch nichts auslösen — eigener Testfall.

**Beim Testen zweimal selbst danebengelegen, beide Male nachgemessen statt geraten:**
Der Zähler zählt **Einträge seit dem letzten Hinsehen**, nicht Änderungen — ein frisch angelegter
Aushang ist schon mitgezählt und kann durch eine Bearbeitung gar nicht mehr steigen. Der Test setzt
deshalb erst „gelesen" und prüft 0 → bleibt 0 → 1. Und beim Zurücknehmen einer Sabotage habe ich die
eigene Korrektur mitgelöscht, weil die Sicherungskopie von **vor** dem Einbau stammte; aufgefallen
beim Nachzählen mit `grep`.

**Suite-Falle:** Drei Tests (`browser-smoke`, `browser-absences`, `complex-saldo-versioning`)
brauchen einen **von Hand gestarteten** Server auf `:3000` und fallen sonst um — sie gehören zur
Prod-Klon-Gruppe. Mit Server: 29/29, 24/24, 13/14 (die letzte Prüfung meldet sich als Konto „Daniel"
an, das es nur im anonymisierten Klon gibt). Wer die Suite bewertet, muss das wissen, sonst sieht es
nach drei Regressionen aus.

**Und ein Eigentor:** Ich hatte versehentlich drei Suiten parallel laufen, die sich um die festen
Testports stritten und in dasselbe Protokoll schrieben („248 von 151 durchgelaufen"). Der Läufer im
Notizordner hat jetzt eine `flock`-Sperre.

### 2026-08-08 · Gratulation für das Geburtstagskind — und eine Zeitfalle im eigenen Test
Bis dahin sahen nur Chef/Admin/Buchhalter, WER Geburtstag hat; die betroffene Person selbst bekam
nichts. Neu ist eine dezente Karte auf der eigenen Willkommensseite, ohne Alter und ohne Absender
(„das ganze Team wünscht dir“ wäre unwahr — das Team sieht fremde Geburtstage gar nicht).

Datenschutzrechtlich ist das der einfache Fall: eigene Angabe, kein Dritter. Deshalb sieht sie
**jede** Person, auch Mitarbeiter. Technisch fällt dabei **kein** neues Datum an:
`S.user.birth_date` liegt ohnehin im Browser, weil die Pausen-Vorbelegung es für das
Jugendarbeitsschutzgesetz braucht. Der geschützte Endpunkt `/api/users/geburtstage` bleibt
unverändert gesperrt (Test weist 403 für Mitarbeiter nach).

**Die eigentliche Lehre steckt im Test daneben.** `willkommen-unveraendert-ui.js` fiel beim nächsten
Suite-Lauf um — aber nicht wegen der Gratulation: Der Abschnitt „Tagesansicht ohne Sprung“ ruft
`#/planning` auf, und das öffnet immer den **heutigen** Tag. Die Termine des Tests liegen auf
Dienstag und Donnerstag. Am **Freitag** war der Test grün, weil auf den Freitag zufällig die
Urlaubs-Abwesenheit fiel und diese eine Zeitleiste erzeugte; am **Samstag** gab es gar nichts und
der Test lief in eine Zeitüberschreitung. Grün aus dem falschen Grund — einen Tag lang.

Nachgewiesen, dass es keine Regression war: mit stillgelegter Gratulation fällt derselbe Test
genauso um. Behoben durch einen zusätzlichen Termin für **heute** plus eine Zeile, die
ausdrücklich prüft, dass überhaupt eine Zeitleiste da ist — sonst sagt der ganze Abschnitt nichts
aus, egal was er danach misst.

**Regel:** Wer in einem Test `#/planning` (oder `#/` ) direkt aufruft, braucht Daten für **heute**.
Daten auf festen Wochentagen machen den Test vom Kalender abhängig.

### 2026-08-07 · Scrollflächen messen ihren Platz, statt ihn zu schätzen
Im CSS standen seit dem allerersten Commit feste Schätzungen: Zeitleiste `100vh - 260px`,
Auftrags-Board `100vh - 160px`. Die Zahl unterstellt, dass über der Fläche immer gleich viel steht.
Das stimmt nirgends: In der **Planung** sind es nur 166 px — auf **jedem** Handy blieben unten
exakt **94 px** ungenutzt (gemessen von 360×640 bis 430×932, immer dieselbe Zahl, weil der Fehler
konstant ist und nicht mit dem Bildschirm skaliert). Auf dem **Zeitnachweis** steht umgekehrt viel
darüber, dort wurde die Seite unnötig lang.

Seitdem misst `passeScrollflaechenAn()` (`public/js/app-1-core.js`) nach jedem Neuaufbau und beim
Drehen/Vergrößern: verfügbare Höhe = Fensterhöhe − Oberkante der Fläche − *was unter der Karte noch
kommt* − 10 px Luft, mindestens 260 px. Gerechnet wird in **Dokument-Koordinaten**, damit das
Ergebnis nicht davon abhängt, wie weit gerade gescrollt ist. Der Abzug für das, was darunter steht,
ist keine Vorsicht auf Verdacht: Ohne ihn schöbe die Fläche eine Legende oder eine zweite Karte aus
dem Bild.

Die Höhe wird **vor** `viewStateRestore()` gesetzt — andersherum schnitte die neue Höhe die eben
wiederhergestellte Scroll-Position wieder ab (siehe B10).

**Falle beim Gegenprüfen:** Der erste Sabotage-Versuch schaltete nur den Aufruf im Beobachter ab —
der Test blieb grün, weil `setViewport` das `resize`-Ereignis auslöst und die Messung darüber
trotzdem lief. Erst als die **Funktion selbst** stillgelegt war, meldete `platznutzung-ui.js` die
94 px zurück. Wer hier etwas prüft, muss beide Wege abschalten.

**Was der Test NICHT verlangt:** dass unten nie Platz frei bleibt. Auf einem großen Monitor ist der
Tag irgendwann vollständig im Bild — dann ist der Rest darunter keine Verschwendung, sondern
schlicht nichts mehr da. Der Test unterscheidet das über `scrollHeight > clientHeight`.

**Was die Änderung nebenbei aufgedeckt hat:** Nach dem Umbau fiel `longpress-details-ui.js` um —
die per langem Druck geöffnete Sprechblase verschwand auf dem Zeitnachweis beim **Loslassen**
wieder. Gemessen statt geraten: Während des Drucks war sie da, nach `touchend` schickte Chrome
`mouseout`/`mouseleave` (Maus-Ersatzereignisse), und `el.addEventListener('mouseleave', hideTooltip)`
hatte — anders als `mouseenter`/`mousemove` daneben — **keinen** `istMauszeiger()`-Wächter.

Der Fehler lag also schon vorher im Code; die neue Höhe hat die Geometrie nur so verschoben, dass er
zuschnappt. Auf einem echten Gerät hätte er jeden getroffen, der einen Eintrag nahe dem unteren
Bildschirmrand hält. In `app-4-planning-tools.js` stand dieselbe ungeschützte Zeile und ist
mitgefixt, obwohl der Test sie (noch) nicht traf.

Die Ursache ist **nachgemessen, nicht vermutet**: Mit Wächter, aber ohne die zweite Änderung
(Wegfall des kurzen `maxHeight`-Zurücksetzens) ist der Test grün — ohne Wächter, aber mit ihr fällt
er um. Der Wächter ist die Korrektur; das Zurücksetzen wurde nur entfernt, weil es die Seite bei
jedem Neuaufbau ein zweites Mal auslegte.

Gleicher Anlass, zweite Änderung: Die drei Kennzahl-Karten des Zeitnachweises standen auf dem Handy
**untereinander** (~200 px, bevor überhaupt Inhalt kam) und stehen jetzt **nebeneinander** (~85 px),
wie auf der Statistik-Seite längst üblich. Zusammen passt der Zeitnachweis auf einem 411×795-Gerät
wieder auf **einen** Bildschirm (vorher 1117 px Seitenlänge).

### 2026-08-07 · Nie ein zweiter Prozess auf der Produktions-Datenbank
Die App hält die Datenbank vollständig im Arbeitsspeicher; `database/init.js` startet beim Laden
einen Takt, der sie **alle 5 Sekunden als Ganzes** in die Datei zurückschreibt. Ein zweites
Programm, das `initDatabase()` aufruft, bekommt eine **eigene Kopie** — und schreibt sie beim
nächsten Takt über die Datei. Alles, was der laufende Server inzwischen gespeichert hat, wäre weg.

Aufgefallen an einem Hilfsskript, das eine Betriebsmeldung verschicken sollte und dafür
`push.notifyUsers` benutzte: Die Funktion löscht abgelaufene Abos, markiert die Kopie also als
geändert. Ob es gutgeht, hing daran, ob der Prozess in unter fünf Sekunden fertig wird.

**Regel:** Hilfsskripte neben dem laufenden Server öffnen die Datenbankdatei **selbst und nur
lesend** (`new SQL.Database(fs.readFileSync(...))`), niemals über `database/init.js`. So macht es
auch `make-backup.js`. Wer schreiben muss, tut es über die laufende Anwendung — nicht daneben.

### 2026-07-31 · Statistik: Abschluss-Hinweis gehört zum angewählten Zeitraum
Der Hinweis „abgerechnet" zeigte auf **jeder** Ansicht den letzten Abschluss samt dessen Zahlen —
auch beim Ansehen eines anderen Monats. Jetzt zählen die Abschlüsse, die sich mit dem angezeigten
Zeitraum überschneiden; ist keiner dabei, erscheint gar keiner. Zwei Fallstricke: „Gesamt" endet am
**Bezugsdatum**, nicht zwangsläufig heute (obwohl die Ansicht keinen Datumswähler hat), und ein über
die API angelegter Mitarbeiter ist **ab heute** angestellt — in einem Abschluss des Vorjahres kommt
er zu Recht gar nicht vor, weshalb `tests/abschluss-statistik-monat-ui.js` seine Datenbank vor dem
Server aufbaut.

### 2026-07-30 · Wetter: heutiger Tag stand zweimal
Oben der stündliche Verlauf von heute, in der Wochenliste noch einmal „Heute" — aufgeklappt sogar
mit demselben Streifen darunter. Die Liste beginnt jetzt mit **morgen**. Oberer Streifen und Liste
sind zwei getrennte Stellen für denselben Datenbestand (`groupHoursByDay`); wer eine anfasst, muss
die andere im Blick behalten.

### 2026-07-30 · Zeitgleiche Aufträge zählten doppelt
Die Pausen-Vorbelegung summierte die Einträge des Tages, statt die Uhr zu lesen. Zwei parallel
dokumentierte Aufträge (zweimal 07:00–12:00) ergaben 10 Stunden Anwesenheit statt 5 — und § 4 ArbZG
hob die Pause auf 45 Minuten an, für eine Arbeitszeit, die es nie gab. Seitdem zählt überall die
**überlappungsfreie** Anwesenheit. Merksatz: Der **Pausenvorschlag** hängt an der **Anwesenheit**,
die **Höchstzeit-Warnung** an der **Arbeitszeit**.

### 2026-07-30 · Menüpunkt „Export" → „Abrechnung" / „PDF-Nachweis"
„Export" beschrieb die Technik, nicht den Zweck, und war für das Einfrieren abgerechneter Monate zu
harmlos. Die Beschriftung hängt an `canViewAll()` — derselben Bedingung wie die Blöcke auf der Seite
—, **nicht** an der Einstellungen-Berechtigung; sonst läse ausgerechnet der Buchhalter den falschen
Namen. Beim Umbenennen von Menüpunkten immer mit `grep` durch `tests/` gehen: dort werden Menütexte
wörtlich geprüft.

### 2026-07-29 · Eingefrorener Zähler-Coin
Die Nav-Zähler wurden ausschließlich per SSE **gesendet, nie geholt**. Kappt ein Handy die
Verbindung (Bildschirm aus), geht jede Änderung aus dieser Zeit verloren. Seitdem wird der Stand
nach jedem Verbindungsaufbau und bei jeder Rückkehr zum Tab nachgeholt. Allgemein: Zustand, der nur
per Push aktuell gehalten wird, braucht einen **Pull nach der Lücke**.

### 2026-07-29 · Geburtsdatum je Mitarbeiter
Für unter 18-Jährige gilt § 11 JArbSchG mit längeren Pausen. Ein **leeres** Feld heißt bewusst
„unter 18", nicht „Erwachsener" — lieber eine zu lange Pause vorschlagen als eine unzulässig kurze.
Praktische Folge beim Einführen: Solange keine Geburtsdaten gepflegt sind, schlägt schon ein
normaler 8-Stunden-Tag 60 Minuten vor. Nebenwirkung für Tests: Testnutzer **ohne** Geburtsdatum
prüfen ab jetzt die Jugendschutz-Tabelle.

### 2026-07-28 · Abrechnungs-Abschluss
Der Überstundenstand wurde bei jeder Abfrage vom ersten Tag an neu gerechnet — wer einen Mai-Eintrag
korrigierte, verschob damit seinen **heutigen** Stand, obwohl die Mai-Stunden längst bezahlt waren.
Seitdem lassen sich Monate abschließen; der Stand rechnet auf dem festgehaltenen Wert weiter.

---

## Testverfahren im Einzelnen

Push-Tests (kein Browser nötig): `node tests/push-api.js` (Abo-/Einstellungs-Endpunkte),
`node tests/push-targeting.js` (richtige Empfänger je Ereignis + 410-Bereinigung),
`node tests/push-sw.js` (Service-Worker-Handler).

Planungs-Erinnerungen: `node tests/planning-reminders-api.js` (CRUD/Rechte),
`node tests/planning-reminders-scheduler.js` (Feuerlogik, Pause, Serie-Dedupe, Digest-Bündelung),
`node tests/planning-reminders-ui.js` (⋮-Menü + Dialog).

Abrechnungs-Abschluss: `node tests/abschluss-gleichheit.js` ist die **zentrale Probe**. Der Abschluss
stellt die Rechenbasis des Überstundenstands um; der Test nimmt alle Zahlen auf, schließt sechs Monate
nacheinander ab und vergleicht nach jedem Abschluss erneut — **jede Zahl muss identisch bleiben**. Er
prüft zuerst, dass er überhaupt etwas gemessen hat, und macht eine **Gegenprobe** (ein zusätzlicher
Eintrag MUSS die Zahlen bewegen) — ohne die wäre ein Vergleich zweier unveränderter Listen wertlos
grün. Genau dieser Test hat eine echte Abweichung von 0,01 h gefunden: `calcActualHours`/
`calcTargetHours` runden am Ende ihres Zeitraums, und Rundung ist nicht additiv. Deshalb gibt es jetzt
`calcActualHoursRaw`/`calcTargetHoursRaw`, und der Abschluss hält die **ungerundeten** Zwischenstände
fest (`payroll_closure_rows.ist_kumuliert` / `soll_kumuliert`).
`node tests/abschluss.js` prüft die Sperre über HTTP (nicht nur im Formular) für alle drei Gruppen von
Schreibwegen sowie den Admin-Ausweg; `node tests/abschluss-prodklon.js` schließt echte Monate auf einer
Kopie der Produktivdaten ab und weist nach, dass keine Antwort sich ändert;
`node tests/abschluss-nachtrag.js` prüft die Kette, an der der ganze Abschluss hängt: nachtragen →
Differenz sichtbar → nächster Abschluss blockiert → übernehmen → Stunden im Gesamtstand **und** im
Lohn-Export → Abschluss wieder möglich → beim nächsten Abschluss weder doppelt gezählt noch
verloren. Der letzte Punkt war ein echter Fehler: Zuerst zählte die Korrektur nur, solange sie nach
dem Stichtag der Rechenbasis lag — beim übernächsten Abschluss verschwand sie wieder.
`node tests/abschluss-ausstellen.js` prüft den **Normalweg beim Ausscheiden** unter dem Abschluss —
mit unabhängig nachgerechneten Sollwerten statt mit dem, was die App gerade liefert: Austritt zur
Monatsmitte (Soll endet am Austritt, Ist zählt die gebuchten Tage, Beleg trägt „Beschäftigt bis"),
gebuchte Zeit **nach** dem Austritt (wird zu Überstunden statt verschluckt), der Folgemonat (nicht
mehr im Beleg, Daten aber vollständig erhalten, Anmeldung gesperrt), rückdatierter Austritt in einen
bezahlten Monat, Wiedereinstellen nach einer Lücke, Austritt **genau** am Stichtag, zwei
Aus-/Wiedereintritte, Urlaub über den Austritt hinaus, offener Antrag eines Ausgestellten. Dieser
Test fand, dass **Abwesenheitstage nach dem Austritt weitergezählt** wurden (10 statt 5) — behoben in
`routes/absence-days.js`; gegen die Produktivdaten nachgewiesen, dass sich dadurch keine bestehende
Zahl bewegt (46 Antworten verglichen).

`node tests/abschluss-haerte.js` greift die Mechanik gezielt an, statt den Normalfall zu bestätigen:
Zeitraum wieder öffnen, **nachdem** eine Differenz übernommen wurde (fand die Doppelzählung oben);
Stunden im bezahlten Monat **löschen** statt nachtragen (negative Differenz); ein Mitarbeiter, den es
zum Stichtag noch nicht gab; ein endgültig gelöschter Mitarbeiter, dessen Beleg überleben muss; ein
rückwirkender **Feiertag**, der alle gleichzeitig trifft; denselben Monat zweimal (auch gleichzeitig)
abschließen; schließen → öffnen → erneut schließen mit Vergleich der festgehaltenen Zahlen. Jedes
Szenario läuft auf einer **frischen** Datenbank — Abschlüsse sind firmenweit und würden sich sonst
gegenseitig verdecken.
`node tests/abschluss-audit-ui.js` liest das **Protokoll** so, wie ein Mensch es liest: Erscheinen
alle sechs Vorgänge (abschließen, eingreifen, übernehmen, **ablehnen**, wieder öffnen, exportieren)
mit lesbarer Bezeichnung statt rohem Schlüssel? Steht die Begründung in der Detailspalte? Sind sie im
Aktions-**Filter** auswählbar, blendet er andere wirklich aus (mit Gegenprobe), und enthält der
CSV-Export fürs Archiv sie ebenfalls? Ein Vorgang, den man nicht wiederfindet, ist nicht
protokolliert — beim Ablehnen erst recht, denn dort verfallen Stunden.

`node tests/abschluss-ui-knoepfe.js` **bedient** jeden Knopf und jeden Dialog, statt sie zu ersetzen:
Abbrechen in allen drei Rückfragen (und danach ist nachweislich nichts passiert), Pflichtfelder leer
lassen (Dialog bleibt offen, nichts wird gebucht), Speichern und Löschen eines gesperrten Eintrags
als Mitarbeiter, wer die Karte überhaupt sieht. Der vorhandene `abschluss-ui.js` prüft die
Erfolgspfade und ersetzt dabei die Dialoge (`window.confirmModal = () => true`) — damit blieben
ausgerechnet die Abbruch- und Fehlerpfade ungeprüft, und ein „Abbrechen", das trotzdem bucht, fällt
niemandem auf, bis das Geld falsch ist.

`node tests/abschluss-ui.js` bedient die Oberfläche im Browser (Sammel-Abschluss, Sperr-Hinweis,
Begründungsdialog samt **Abbruch**, Mitarbeiter-Sicht, Abweichungs-Anzeige, Wiederöffnen).

**Zwei Fallen in Browser-Tests dieser App**, über die auch dieser Test gestolpert ist: Ein `page.goto`,
das nur den **Hash** ändert, lädt die Seite **nicht** neu — das alte Formular bleibt samt gesperrtem
Absenden-Knopf stehen (Doppel-Submit-Schutz). Deshalb erst auf `#/` und dann zum Ziel. Und Listen mit
mehreren gleichartigen Schaltflächen: Ein Klick auf nur die erste prüft womöglich den falschen
Datensatz und meldet fälschlich „alles in Ordnung".

Gesetzliche Mindestpause: `node tests/pause-gesetz-ui.js` — die Schwellen 6 und 9 Stunden, der
Wackelfall 9:45, der Firmenwert als Untergrenze, Nachziehen beim Ändern der Uhrzeiten, manuelle
Eingabe behält Vorrang. `node tests/pause-beispiele.js` ist zugleich **Beispieltabelle und
Prüfung**: 15 Fälle werden an der echten Oberfläche gemessen und ausgegeben — die Tabelle kann
also nicht veralten, ohne rot zu werden. Sie hat zwei Formulierungsfehler aufgedeckt, die beim
Bauen niemandem auffielen („es fehlen 0 min", Kleinschreibung nach dem Punkt).

Restpausen-Vorbelegung: `node tests/restpause-ui.js` — die Kette aus dem Alltag (30 → 0, 15 → 15 →
5 → 0), mehr als die Firmenpause (nie negativ), Datumswechsel, manuell gesetzte Pause bleibt stehen
(mit Gegenprobe, dass die Startzeit trotzdem nachzieht — beide Felder haben ihre **eigene**
„manuell geändert"-Erkennung), Übernahme aus der Planung bei leerem und bei belegtem Tag, Admin
ohne und mit gewähltem Mitarbeiter, geänderter Firmenwert. Und der gefährliche Fall: Beim
Bearbeiten steht die gespeicherte Pause im Feld und überlebt das Speichern.

Höchstarbeitszeit an echten Daten: `node tests/hoechstzeit-prodklon.js` — nimmt **alle** Zahlen
aller Mitarbeiter auf (31.086 Einzelwerte), löst im Browser die Warnung aus, nimmt erneut auf
(**keine einzige Zahl bewegt sich**), speichert den überlangen Eintrag dann wirklich (**keine
Blockade**, 11,0 h netto wie eingegeben) und löscht ihn wieder — danach stehen alle Zahlen wieder
auf ihrem Ausgangswert. Mit Selbstkontrolle: Solange der Eintrag gespeichert ist, **müssen** sich
Zahlen bewegt haben, sonst wäre der Vergleich blind.

Höchstarbeitszeit: `node tests/hoechstarbeitszeit-ui.js` — die Grenze ist „mehr als", nicht „ab"
(genau 10:00 ist noch erlaubt), sie zählt den **ganzen Tag** über mehrere Einträge, der eigene
Eintrag zählt beim Bearbeiten **nicht doppelt**, und das Speichern bleibt möglich. Dazu die
Wochengrenze der Jugendlichen. Beim Schreiben hing der Test zunächst im GoBD-Begründungsdialog, den
das Bearbeiten öffnet — er bedient ihn jetzt.

Abschluss-Hinweis je Zeitraum: `node tests/abschluss-statistik-monat-ui.js` — prüft über **zwei**
abgeschlossene Monate hinweg, damit auffällt, wenn immer nur der letzte gezeigt wird: offener Monat
→ kein Hinweis, jeder abgeschlossene Monat → seine eigenen Zahlen, Tag/Woche folgen dem Datum,
Jahr → „bis …". Er baut seine Datenbank **vor** dem Server auf, weil ein über die API angelegter
Mitarbeiter erst ab heute angestellt ist und in einem Abschluss des Vorjahres zu Recht gar nicht
vorkäme. Gegenprobe: alte Fassung eingesetzt → sechs Prüfungen rot.

Wetter: `node tests/wetter-heute-ui.js` — **fängt die Wetter-Anfrage ab und antwortet selbst**,
hängt also weder am Netz noch am echten Wetter und kann Tagesgrenzen gezielt setzen. Prüft, dass
heute nur oben steht, die Liste mit morgen beginnt, genau **ein** Stundenstreifen sichtbar ist und
das Aufklappen der Folgetage weiter funktioniert. Gegenprobe gemacht: Nimmt man den Filter heraus,
werden drei Prüfungen rot.

Drei sich überschneidende Aufträge, Schritt für Schritt: `node tests/ueberschneidung-kette-ui.js`
— 07:00–13:00, dann 12:00–16:00 (**9 Std** Anwesenheit) und 15:00–18:00 (**11 Std**), mit 30 und
45 min Pause. Zeigt den Unterschied, auf den es ankommt: Der **Pausenvorschlag** hängt an der
**Anwesenheit**, die **Warnung** an der **Arbeitszeit**. Bei 11 Std Anwesenheit und 75 min Pause
sind es 9:45 Arbeitszeit — für den Erwachsenen also **keine** Warnung, für den Minderjährigen sehr
wohl. Eine Stunde länger, und beide werden gewarnt. Dieselbe Kette wird für beide Altersgruppen
gefahren.

Die unangenehmen Lagen: `node tests/hoechstzeit-komplex-ui.js` — teilweise Überlappung (07–12 und
11–16 sind 9 Std, nicht 10), ein Eintrag **vollständig innerhalb** eines anderen, drei getrennte
Blöcke in einer Zehn-Stunden-Spanne (nur 6 Std Anwesenheit → kein Gesetz), der **Admin bucht für den
Azubi** (Alter und Tag gehören dem Gewählten, nicht dem Angemeldeten) und ein **Kollege** mit 12
Stunden am selben Tag, der nicht durchschlagen darf. Merke fürs Testen: Wer die Pause von Hand
setzt, friert den Hinweis darunter ein (gewolltes Verhalten) — den Hinweis deshalb in einem eigenen
Durchgang **ohne** Handanlegen ablesen.

Zeitgleiche Aufträge: `node tests/pause-parallel-ui.js` — zweimal 07:00–12:00 parallel ergibt 5
Stunden Anwesenheit, nicht 10; der Vorschlag bleibt bei der Firmenpause und nennt **kein** Gesetz.
Mit Gegenprobe, dass dieselben Zeiten **nacheinander** sehr wohl die gesetzliche Anhebung auslösen.

Jugendarbeitsschutz: `node tests/pause-jugendschutz-ui.js` — die drei Fälle nebeneinander (über 18,
16-jährig, **ohne** Geburtsdatum), der Übergang am 18. Geburtstag, das Alter am **Eintragsdatum**
statt am heutigen, und ein nachgetragenes Geburtsdatum. Beim Bau dieses Tests wurden fünf ältere
Pausen-Tests rot: Ihre Testnutzer hatten kein Geburtsdatum und wurden damit als Jugendliche
gerechnet. Sie tragen jetzt ausdrücklich ein Erwachsenen-Datum samt Begründung im Kommentar — sonst
hätten sie unbemerkt die falsche Tabelle geprüft.

Rollenabhängige Menü-Beschriftung: `node tests/menue-abrechnung-ui.js` — prüft für alle vier
Rollen einzeln, dass Beschriftung **und** Seiteninhalt zusammenpassen. Der heikle Fall ist der
**Buchhalter**: weder Chef noch Admin, sieht aber beide Zusatzblöcke — hinge die Beschriftung an der
falschen Rollenprüfung, bekäme gerade er den falschen Namen.

Zähler nach einer Verbindungslücke: `node tests/badge-nachziehen-ui.js` — blockiert `/api/events`
per Request-Interception (das ist das Handy im Standby), lässt jemand anderen die letzte Bestellung
erledigen und prüft, dass der Zähler stehen bleibt — und nach Rückkehr zum Tab bzw. nach dem
Wiederaufbau der Verbindung verschwindet. Dass der Kanal danach wirklich lebt, weist eine **weitere
Live-Änderung** nach; `readyState` allein taugt dafür nicht, der Wert wechselt beim Wiederverbinden
mehrfach. Gegenprobe gemacht: ohne die zwei Nachhol-Aufrufe werden genau die beiden entscheidenden
Prüfungen rot.

Geburtstags-Einblendung: `node tests/geburtstag-ui.js` — wer sie sehen darf (Mitarbeiter bekommt
403), eigener Geburtstag ausgelassen, Ausgestellte und Leute ohne Datum nicht dabei, kein
Geburtsdatum im Antwortkörper, Reihenfolge auf der Seite. Der **29. Februar** wird mit einem
zweiten Server geprüft, dessen **Uhr vorgestellt** ist (2027 kein Schaltjahr → Anzeige am 28. mit
Vermerk; 2028 Schaltjahr → am 28. nicht, am 29. schon) — sonst wäre dieser Zweig nur alle vier
Jahre prüfbar. Gegenprobe gemacht: Nimmt man `mitarbeiter` in die Rollenliste des Endpunkts auf,
wird der Test rot — die **Oberflächen**-Prüfung bleibt dabei grün, weil das Frontend gar nicht erst
fragt. Deshalb prüft dieser Test beides getrennt.

Der **18. Geburtstag** am echten Datenstand: `node tests/jugendschutz-uebergang-prodklon.js` reist
mit vorgestellter Browser-Uhr an den Vortag, den Geburtstag und den Tag danach und misst dort den
Vorschlag (8:30 Anwesenheit: 60 → 30 · 10 Std: 60 → 45). Der Prüfling wird selbst gesucht (jüngster
Nutzer mit Geburtsdatum, mit `PRUEFLING="Name"` gezielt wählbar), der Test veraltet also nicht.
Er wählt bewusst Tage **ohne vorhandene Einträge**, sonst redete die Restpause mit. Gegenprobe:
Verschiebt man die Grenze in `istJugendlich` um einen Tag (`<` → `<=`), wird genau der
Geburtstags-Messpunkt rot.

Arbeitsbeginn & Zeit-Vorbelegung: `node tests/arbeitsbeginn-ui.js` — **stellt die Uhr des Browsers**,
statt sich auf die Laufzeit zu verlassen (ein Test, der nur zu bestimmten Tageszeiten grün ist, taugt
nichts). `node tests/arbeitsbeginn-prodklon.js` prüft gegen eine Kopie der Produktivdaten, dass die
Migration hochzieht und **kein Nutzer ausgesperrt** wird — das Feld wird bei jeder Anfrage mitgelesen.

Auslieferbarkeit: `node tests/deploy-vollstaendigkeit.js` liest die Dateiliste aus `deploy.sh`, kopiert
genau diese Pfade in ein leeres Verzeichnis und startet den Server dort. Fängt ab, dass eine neue Datei
im Projektstamm vergessen wird (der Dienst käme sonst nach dem Neustart gar nicht mehr hoch).

Lohn-Export: `node tests/lohn-export.js` (Zahlen, Dateiformat, Rechte, Audit — inkl. Abgleich mit
Statistik und Abwesenheits-Übersicht), `node tests/lohn-export-ui.js` (Bedienung, Sichtbarkeit je Rolle,
Personalnummer), `node tests/lohn-export-prodklon.js` gegen eine Kopie der Produktivdaten.
`node tests/user-hours-gleichheit.js` beweist, dass die zusammengelegte Stunden-Berechnung
(`routes/user-hours.js`) exakt dieselben Zahlen liefert wie die vorherigen Einzelkopien.

Scroll-Verhalten: `node tests/scroll-ruckeln-ui.js` (jede Seite wird durchgescrollt; jeder Rücksprung
wird gemeldet – Seiten, die innen scrollen wie Planung und Auftrags-Board, werden dort gemessen),
`node tests/scroll-ruckeln-prodklon.js` gegen eine Kopie der Produktivdaten.

Tastatur/Screenreader: `node tests/barrierefrei-ui.js` (Fokusfalle in Dialogen, Escape, Fokus-Rückkehr,
Landmarken, Namen der Symbol-Knöpfe), `node tests/barrierefrei-prodklon.js` gegen eine Kopie der
Produktivdaten.

Listen-Suche: `node tests/listen-suche-ui.js` (alle sechs Listen, Fokus beim Tippen, UND-Suche,
Knöpfe der gefundenen Zeile bleiben funktionsfähig), `node tests/listen-suche-prodklon.js` gegen
eine Kopie der Produktivdaten.

Entwurfs-Sicherung: `node tests/entwurf-sicherung-ui.js` (alle sieben Formulare — App in den Hintergrund
schicken, Tab neu öffnen, Entwurf wiederherstellen/verwerfen, Abmelden räumt auf),
`node tests/entwurf-prodklon.js` gegen eine Kopie der Produktivdaten.

Langer Druck (Details am Zeitnachweis/in der Planung): `node tests/longpress-details-ui.js` mit echter
Touch-Simulation (halten/tippen/wischen) plus Gegenprobe mit der Maus, `node tests/longpress-prodklon.js`
gegen eine Kopie der Produktivdaten.

Bedienung auf dem Handy: `node tests/touch-ux-ui.js` misst die tatsächlichen Trefferflächen
(per `elementFromPoint`, nicht nur die CSS-Angabe) und rechnet die Textkontraste aus den echten
Browser-Farben nach. `node tests/ux-runde1-prodklon.js` wiederholt das gegen eine **Kopie** der
Produktivdaten unter `/tmp/prodklon.db` (fehlt die Kopie, überspringt sich der Test).

Verschlüsselte Sicherungen: `node tests/backup-krypto.js` (hin und zurück mit **jedem** Empfänger,
Byte-Gleichheit, verändertes Byte in Chiffrat/Kopf/Tag scheitert, abgeschnittene Datei stürzt nicht
ab), `node tests/backup-verschluesselt.js` (Download ist ein Container, ein echter Kundenname aus
der Datenbank steht **nicht** roh darin, `POST /restore` erklärt statt abzustürzen),
`node tests/backup-altbestand.js` (die Umstellung löscht Klartext erst nach bewiesener
Rückrichtung — geprüft wird vor allem der schlechte Ausgang),
`node tests/backup-einspielen-ui.js` (der geklickte Hauptweg; **alle** Anfragen mitgeschnitten, der
Schlüssel kommt in keiner vor) und `node tests/backup-entschluesseln-ui.js` (das Notfall-Werkzeug
über `file://` geöffnet wie beim Doppelklick, heruntergeladene Datei eingefangen und mit dem
Original verglichen).
