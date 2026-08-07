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
