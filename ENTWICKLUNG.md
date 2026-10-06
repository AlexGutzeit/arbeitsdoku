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

### 2026-09-15 · Vier Beobachtungen aus dem Benutzen — und ein Wächter, der mich erwischt hat

Alex hat das Verzeichnis zum ersten Mal wirklich benutzt. Vier Meldungen in einer halben Stunde,
alle vom selben Schlag: Dinge, die beim Bauen richtig aussehen und beim *Arbeiten* stören.

**1. „Speichern im Unterpunkt Großhändler springt auf Produkte zurück."** Jede Händler-Aktion ruft
`renderProdukte()`, und das baut die Seite von vorn auf — mit dem ersten Reiter. Wer drei Händler
nacheinander pflegt, klickt sich dreimal zurück. Jetzt werden **Reiter und offene Händlerkarte**
gemerkt und nach dem Neuaufbau wiederhergestellt. Dieselbe Lehre wie B10, nur an einer Stelle, an
die damals niemand dachte.

**2. „Beim manuellen Anlegen fehlt ＋ neue Kategorie."** Die Scan-Maske hatte es, der Dialog im
Verzeichnis nicht — und der ist **modal**: Man hätte abbrechen, im Reiter eine Kategorie anlegen
und den schon getippten Namen neu eingeben müssen. Die Gegenprobe im Test ist die eigentliche
Zusicherung: Ohne Kategorienamen entsteht **weder Kategorie noch Produkt**. Sonst hätte man am Ende
ein Produkt ohne die Kategorie, die man wollte.

**3. „Löschen ohne Sicherheitsabfrage"** — erst beim Großhändler, dann bei der Kategorie. Beide
Male dasselbe Muster: Es fragte nur der **Server** zurück, und auch nur, wenn etwas daranhing. Ein
leerer Eintrag verschwand auf einen Klick, und der rote Knopf sitzt direkt neben „Speichern".

Wichtig war die **Wahrheit im Text**: Beim Händler steht, dass die Bestellnummern beim
Wiederherstellen zurückkommen. Bei der Kategorie steht, dass es **keinen Weg zurück gibt** —
Kategorien liegen nicht im Papierkorb. Ein Dialog, der eine Wiederherstellung andeutet, die es
nicht gibt, wäre schlimmer als gar keiner.

**4. „Im Reiter Gelöscht werden nur Produkte gezählt."** Stimmte — und daraus wurde gleich das
endgültige Löschen, nur aus dem Papierkorb heraus. Die Arbeit lag nicht im Knopf, sondern in den
Folgen: Ein endgültig gelöschtes Produkt **löst** die Verknüpfung seiner Bestellungen (der Text
bleibt, das gilt in dieser App durchgehend), gibt seine Barcodes frei und räumt die
„aufgegangen in …"-Verweise anderer Produkte weg. Ohne das zeigten alte Einträge ins Leere.

**Und dann hat mich ein Bestandstest erwischt.** `tests/audit-beschriftungen.js` wurde rot, während
die Suite lief: Ich hatte zwei neue Protokoll-Aktionen eingeführt (`product_purge`,
`supplier_purge`) und **keine Beschriftungen** dafür. Sie wären im Audit-Log als roher Schlüssel
erschienen und nicht filterbar gewesen. Genau dafür gibt es diesen Test — er vergleicht die
protokollierten Aktionen mit der Liste in `app-6-admin.js`, **in beide Richtungen**. Eine Lücke, an
die man beim Bauen nicht denkt, weil das Feature ohne sie funktioniert.

### 2026-09-15 · Der Deploy selbst — drei Dinge, die ich mir gemerkt habe

**Ein `git checkout main` reisst einer laufenden Suite die Dateien weg.** Beim zweiten Deploy lief
die Suite noch. Der übliche Weg (`checkout main` → merge → deploy → `checkout develop`) hätte ihr
Ergebnis wertlos gemacht. Stattdessen `git worktree add /tmp/deploy-main main`, dort gemerged und
deployt, danach `git worktree remove`. `.env.deploy` muss mit (nicht eingecheckt). Das
Arbeitsverzeichnis blieb unverändert auf `develop`.

**Ein 404 ist hier kein Beweis fürs Entfernen.** Nach dem Ausbau des Prüfstands prüfte ich
`/scanner-probe.html` und bekam **200** — Alarm. Die App liefert aber für JEDE unbekannte Adresse
`index.html` aus (SPA-Weiche). Der Beweis war der Vergleich: byte-gleich mit `index.html`, null
Treffer für „Prüfstand", und eine frei erfundene Adresse verhält sich genauso. Auf dem Server lag
wirklich keine Datei mehr.

**Ein Testlauf, während man ändert, misst nichts.** Der Lauf endete mit zwei Roten: einer war ein
echter Fund (die Audit-Beschriftungen), der andere — `touch-ux-ui` — lief standalone grün. Das
liess sich nur *behaupten*, nicht beweisen. Der saubere Durchlauf danach, auf einem Stand, an dem
ich nichts mehr anfasste, gab die Antwort: **218 von 218, nichts übersprungen.** Deshalb ist der
saubere Lauf kein Ritual, sondern die einzige Messung, die zählt.

### 2026-09-15 · „Jetzt aktualisieren" tat nichts — eine zu grobe Bedingung

Alex nach dem Deploy: *„Der 'jetzt aktualisieren' Button funktioniert nicht mehr."* Und kurz
darauf die Beobachtung, die den Fall löste: *„Ich hab auch schon beim Bestellen den Scanner. Nur
der Button hängt und geht nicht weg."* Die App war also längst aktuell — **nur das Banner blieb
stehen**.

**Nachgestellt, nicht geraten.** `tests/sw-aktualisieren-ui.js` fährt die ganze Kette mit einem
echten Browser: registrieren → neue Fassung → Banner → Knopf → Übernahme → Neuladen. Damit sich
`sw.js` zwischen zwei Abrufen ändern kann (das tut ein Deploy), liefert ein Mini-Server die
**echten** Dateien aus und tauscht nur die Versionsnummer — die Datei im Repo anzufassen wäre ein
Test, der seinen Prüfling verbiegt. Der erste Lauf zeigte Alex' Symptom sofort: Der neue Worker
übernimmt, aber die Seite lädt nicht neu und das Banner bleibt.

**Die Ursache war eine Bedingung, die etwas Richtiges wollte:**

```js
const hadController = !!navigator.serviceWorker.controller;   // beim Laden ausgewertet
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (!hadController || refreshing) return;
  location.reload();
});
```

Sie sollte verhindern, dass beim **allerersten** Besuch neu geladen wird: Dort übernimmt der
Service Worker die offene Seite per `clients.claim()`, was ebenfalls einen `controllerchange`
auslöst — ein Reload würde dort eine gerade getippte Anmeldung verwerfen. Richtig gedacht.

Zu grob war sie trotzdem: `hadController` wird **einmal beim Laden** bestimmt und gilt dann für die
ganze Sitzung. Wer die App zum ersten Mal öffnete und **in derselben Sitzung** auf „Jetzt
aktualisieren" drückte, fiel unter dieselbe Ausnahme — der Wechsel, den er selbst ausgelöst hatte,
wurde verworfen.

Jetzt sind es zwei getrennte Gründe zum Neuladen: ein echter Controller-Wechsel **oder** ein Klick
auf den Knopf. Dazu zwei Dinge, die ein Knopf schuldig ist: Er zeigt „Wird geladen …", und wenn
binnen zwei Sekunden nichts passiert, lädt er eben selbst neu. **Ein Knopf, der stillschweigend
nichts tut, ist schlimmer als einer, der zu viel tut.**

**Die Gegenprobe legte eine Schwäche des Tests offen.** Mit der alten Bedingung blieb er zunächst
grün — der Notnagel sprang ein und verdeckte den Fehler. Der Test misst deshalb jetzt die **Zeit**
zwischen Klick und Neuladen: über den Controller-Wechsel sind es ~1,1 s, über den Notnagel ~2,1 s.
Damit trennt er Reparatur und Notbremse. Eine Notbremse, die den Test grün macht, ist genau die
Sorte Sicherheitsnetz, die man später für die Lösung hält.

**Und der Grund für die ursprüngliche Bedingung ist jetzt selbst zugesichert:** Der Test zählt die
Navigationen und verlangt, dass der erste Besuch **nicht** neu lädt. Ohne diese Zusicherung nähme
der Nächste die Bedingung ganz heraus und bräche die Anmeldung.

### 2026-09-14 · Zwei Rechte, zwei schlechte Namen — beide vor dem Deploy geradegezogen

Alex kurz vor dem Deploy: *„Für was ist can_barcode die Bezeichnung? Das eine Recht? Oder das
gesamte Feature? Das verwirrt nicht etwas."* Berechtigt. Die übrigen Rechte sagen, was man **darf**
(`can_order` = Bestellungen abschliessen); `can_barcode` sagte nur, **worum es geht** — und las sich
damit wie „darf Barcodes benutzen", also wie das ganze Feature.

Auf die Anschlussfrage („und die Bearbeitung vom Produktkatalog?") kam der eigentliche Fund:
**`can_products` leidet am selben Fehler** — und, beim Nachsehen in der rohen Produktivkopie,
**existiert dort noch gar nicht**. Auf Produktion stehen nur `can_plan`, `can_bulletin`,
`can_upload`, `can_plan_all`, `can_order`. Beide Namen waren also reine Entwicklungsstände; die
Umbenennung kostete nichts, nach dem Deploy wäre sie eine Migration auf Echtdaten gewesen.

```
can_products  ->  can_products_edit   Lagerdaten pflegen
can_barcode   ->  can_products_add    Artikel einlernen
```

Damit steht das Verhältnis im Namen: **add** ist das kleinere Recht, **edit** schliesst es ein —
genau die Regel aus `barcoderecht.js`.

**Die Reihenfolge war die einzige Falle.** Erst `can_barcode` umzubenennen und dann `can_products`
hätte aus dem frischen `can_products_add` ein `can_products_edit_add` gemacht. Also andersherum,
mit Wortgrenzen, und hinterher gezielt nach genau diesem Doppelnamen gesucht.

**107 Ersetzungen in 19 Dateien.** Dass nichts vergessen wurde, beweist nicht die Textsuche,
sondern `tests/altdb-spalten.js`: Er liest die Spaltenliste **aus `middleware/auth.js` heraus** und
prüft, ob der Restore-Pfad sie nachzieht. Eine halb durchgezogene Umbenennung fiele ihm sofort auf
— das ist derselbe Wächter, der schon bei `can_products` selbst gegriffen hat.

**Nicht gebaut:** eine Migration, die Werte aus den alten Spalten übernimmt. Die gibt es nur in
Entwicklungsdatenbanken; auf Produktion existiert keine von beiden. Eine Migration für eine Spalte
zu schreiben, die nie ausgeliefert wurde, wäre Ballast mit eigenem Fehlerrisiko.

### 2026-09-14 · Zwei verschiedene Knöpfe — der Unterschied war echt, aber stumm

Alex vor der Produktansicht: *„So ganz versteh ich nicht, warum ich bei 2 Großhändlern 2
verschiedene Buttons habe?"* Bei Sonepar stand **„Artikel öffnen"**, bei Rexel **„Händler
öffnen"** — weil nur bei Sonepar ein Artikel-Link hinterlegt war; ohne ihn fällt der Knopf auf die
Startseite des Händlers zurück.

Der Unterschied ist **richtig und nützlich**: Das eine landet beim Artikel, das andere auf einer
Startseite, wo man von vorn sucht. Er erklärte sich nur nicht — man sah eine Inkonsequenz. Jetzt
steht daneben leise *„kein Artikel-Link hinterlegt"*: Damit erklärt sich die Asymmetrie selbst und
sagt gleich, was zu tun ist, um sie aufzulösen.

**Beim Nachsehen fiel eine zweite Sache auf, die niemand gemeldet hatte:** Dieselbe Situation hiess
in den Bestellungen **„Webshop öffnen"** und im Verzeichnis **„Händler öffnen"** — zwei Wörter für
dieselbe Sache, an zwei Stellen gepflegt. Beide benutzen jetzt `pHaendlerZiel()`; damit können sie
nicht mehr auseinanderlaufen.

**Und die Anschlussfrage** (*„öffnen sich die Links im Standardbrowser?"*): Ja —
`target="_blank"` mit `rel="noopener noreferrer"`. In der installierten App übernimmt der Browser
des Geräts, die Arbeitsdoku bleibt im Hintergrund stehen. Bisher prüfte der Test nur `rel`; das
`target` las er aus, ohne es zuzusichern. Ohne `target` würde der Webshop **innerhalb** der App
geöffnet — mit der Anmeldung daneben und ohne Weg zurück ausser Neuladen. Jetzt ist es zugesichert.

**Nebenbei aufgeräumt:** Nach dem Abbruch der Suite liefen drei verwaiste Testserver weiter (Ports
3131, 3308, 3135) — die Testprozesse hatte ich beendet, die von ihnen gestarteten Server nicht.
Deshalb war `produktpflege-ui` zweimal rot, ohne dass am Code etwas fehlte. Identifiziert über
`/proc/<pid>/environ` (DB_PATH) statt über ein Namensmuster, und einzeln beendet — der 18 Tage alte
Entwicklungsserver auf Port 3000 blieb unangetastet.

### 2026-09-14 · Ein Bildschirmfoto deckt einen echten Fehler auf

Alex zum Bild „zwei gleichnamige Artikel": *„Ich vermute, hier sind die Vorschläge nicht mehr zu
sehen?"* — Stimmt. Und die Ursache lag nicht in der Aufnahme, sondern in der App.

**Das Kategorie-Feld ist beides**: Angabe für die Bestellung **und** Filter für die
Vorschlagsliste. Nach einem Scan ist es gefüllt, ohne dass jemand es angefasst hätte — im Bild
stand dort „Installationsmaterial" von der zuvor gescannten Verbindungsklemme. Wer dann
„kabelbinder" tippt, bekommt **nichts**: Die liegen in „Befestigung".

Die Folge wäre genau der Fehler, gegen den das ganze Verzeichnis gebaut ist: *„gibt es nicht"* →
neu anlegen → Doppel. Ein Filter, der stillschweigend Treffer verschluckt, ist schlimmer als kein
Filter.

**Jetzt sucht die Liste ausserhalb der Kategorie weiter und sagt es:** „Nichts in dieser Kategorie
— 2 Treffer in anderen:". Die Hinweiszeile ist kein Produkt und lässt sich nicht anklicken (ohne
den Riegel setzte ein Klick den Produktnamen auf `undefined`). Drei Zusicherungen halten das fest,
darunter die Gegenprobe, dass der Hinweis bei passender Kategorie **nicht** erscheint.

**Im selben Bild steckte noch ein zweiter Fehler**, den ich beim Nachbauen sah: „HellermannTyton"
und „Befestigung" klebten aneinander. Der Produktname war ein nackter Textknoten im Flex-Layout —
`li > :first-child { min-width: 0 }` traf damit den *Hersteller*-Span statt des Namens, und ein
langer Herstellername ohne Trennmöglichkeit lief in die Kategorie hinein. Name und Hersteller
stehen jetzt in einer gemeinsamen Gruppe: Sie bezeichnen den Artikel, die Kategorie ist
Nebenangabe.

**Beides fand ein Mensch, der ein Bild anschaute** — kein Test. Screenshots aus der echten App sind
deshalb nicht nur Illustration; sie sind eine Prüfung, die kein Testlauf ersetzt.

### 2026-09-14 · Zwei Blicke auf einen Screenshot — zwei Umbauten

Beim Zusammenstellen der Bildschirmfotos hat Alex zweimal hingesehen und zweimal etwas gefunden,
das mir beim Bauen nicht aufgefallen war. Beide Male ging es um **dieselbe Stelle**.

**„Warum steht Kategorien direkt unter den Produkten? Unübersichtlich, oder?"** — „Kategorien
verwalten" war ein `<details>` mit derselben Schriftstärke wie eine Produktzeile, direkt an die
Liste geklebt. Es las sich wie ein achtes Produkt.

**Und gleich danach der schärfere Einwand:** „Was, wenn mal mehrere 100 Artikel hinterlegt sind?
Steht das dann ganz unten?" — Ja. Meine erste Reparatur (abgesetzter Kasten mit Überschrift
„Verwaltung") löste nur das Aussehen, nicht die Erreichbarkeit. Bei 300 Artikeln hätte man sich zu
einer Verwaltungsfunktion **durch den ganzen Katalog scrollen** müssen.

Jetzt stehen beide Verwaltungs-Aktionen — „Kategorien verwalten" und „+ Produkt anlegen" — in
**einer Zeile über der Liste**, also immer erreichbar, unabhängig von der Länge. Die Kategorien
klappen darunter auf.

**Die Lehre ist nicht die Anordnung, sondern die Reihenfolge der Fragen.** Ich habe zuerst gefragt
„sieht das falsch aus?" und erst auf Nachfrage „trägt das bei 300 Artikeln?". Die zweite Frage ist
die, die zählt — ein Layout, das mit acht Testartikeln gut aussieht, sagt nichts über den Alltag.

**Ein Screenshot war ausserdem falsch aufgebaut:** Für die Detailansicht hatte ich das erste
Produkt der Liste aufgeklappt — ausgerechnet eines ohne Großhändler. Alex: „Ich sehe gerade noch
nicht, wie und wo Produkte mit den Großhändlern verknüpft sind." Das Bild zeigte einen leeren
Block und beantwortete die Frage nicht. Das Aufnahmeskript sucht jetzt gezielt das Produkt mit
hinterlegten Händlern.

### 2026-09-14 · Zwei Fragen, zwei Lücken: ausbessern und von Hand anlegen

Alex fragte nach dem Prüfstand-Ausbau zwei Dinge, und beide Antworten waren „nur teilweise".

**„Kann ich einen falsch gescannten Code per Hand korrigieren?"** Im Verzeichnis ja (tippen,
alten entfernen) — in der **Anlege-Maske** nein: Dort stand der Code als starres `<code>`-Element.
Wer die Fehllesung genau in dem Moment bemerkte, in dem er sie noch am billigsten beheben konnte,
musste abbrechen und neu scannen. Jetzt ist es ein Eingabefeld, und der korrigierte Wert geht
sowohl beim Anlegen als auch beim **Anlernen an ein bestehendes Produkt** mit — sonst hinge dort am
Ende die Fehllesung, die man gerade ausgebessert hat.

**Die Prüfziffer rechnet dabei live mit.** Das ist der eigentliche Gewinn: Beim Abtippen von
dreizehn Ziffern gibt es sonst keine Kontrolle ausser einem zweiten Paar Augen. Verschwindet die
Warnung beim Tippen, stimmt die Prüfziffer. Dieselbe Anzeige steht jetzt auch im
Produktverzeichnis. Passend zu Alex' eigener Ansage zum Rollout: *„verantwortungsvoll einlernen und
die Ziffern per Hand nachlesen und kontrollieren."*

**„Könnte ich den Katalog auch komplett von Hand anlegen, wie im Supermarkt?"** Der Server konnte
es längst, die Oberfläche nicht: Ein Anlegen-Knopf existierte **nur in der Händlerkarte**. Im
Reiter „Produkte" gab es keinen — wer ohne Großhändler arbeiten wollte, kam nicht hin. Jetzt steht
er dort, und `pvNeuesProduktDialog(null)` legt ohne Zuordnung an.

**Ein Bestandstest wurde dabei rot, aus dem richtigen Grund:** „… sie nennt den Barcode" las den
`innerText` der Maske — Feldwerte stehen dort nicht drin. Das Ziel („die Maske zeigt den gescannten
Code") gilt unverändert, nur der Messpunkt war der alte. Genau die Frage, die bei jedem roten
Bestandstest zuerst zu stellen ist: misst er das Ziel oder den alten Weg?

### 2026-09-14 · Der Prüfstand geht von Bord

Alex: *„ich habe auch das Gefühl, dass das weitere durchs Lager laufen nur mäßig sinnvoll ist."*
Dieselbe Einschätzung von beiden Seiten — die Art der Funde hatte sich gedreht: Die ersten Läufe
fanden echte Regelfehler, die letzten Formulierungen und einen Rangfolge-Fall. Das ist die Kurve,
an der man aufhört.

Entfernt: `public/scanner-probe.html`, `public/scanner-probe.js`, der Link auf der Bestellseite und
`tests/scanner-pruefstand-ui.js` — so, wie es im Kopf jener Testdatei angekündigt war. `deploy.sh`
rsynct `public/` mit `--delete`, die Dateien verschwinden beim nächsten Deploy also von selbst vom
Server; es bleibt nichts Erreichbares zurück.

**Was vom Prüfstand bleibt, ist das Wichtigere:** Jede Scanner-Regel in `public/js/scanner.js` trägt
die Messung im Kommentar, die sie begründet — die Zeitfenster-Auszählung, die sechs Fehllesungen mit
gültiger Prüfziffer, die 62 echten Codes ohne Endstellen-Kollision. Wer eine Regel ändern will,
findet dort, was er widerlegen muss. Ein Werkzeug, das verschwindet, aber seine Zahlen hinterlässt,
war seinen Aufwand wert.

Zwei Quellkommentare verwiesen noch auf die verschwundene Datei; sie sagen jetzt, dass es den
Prüfstand gab und wo seine Ergebnisse stehen — ein Verweis ins Leere ist schlimmer als keiner.

**Der verbleibende Test ist keiner mehr, sondern der Betrieb:** Das Einlern-Recht bekommt zunächst
nur Alex. Für alle anderen ändert sich nichts — der Katalog ist leer, bestellt wird mit freiem Text
wie immer (die „Nullprobe" in `tests/produktkatalog.js` sichert genau das zu).

### 2026-09-14 · Sechs Fehllesungen, sechs gültige Prüfziffern — und eine Schwelle, die der Test korrigiert hat

Alex' vierter Lauf. Die neue Begründung tut, was sie soll — drei Fehllesungen, jede mit ihren
Messwerten benannt, alle drei richtig erkannt. Das Wichtigere ist aber die **Summe über alle
Läufe**:

```
5009547125400 (1×) <- 8000070025400 (17×)   Speisekammer 12.09.
034754431490  (1×) <- 4044773431490 (6×)    Lager 14.09. 16:25
043899941092  (1×) <- 4003899941092 (8×)    Lager 14.09. 17:08
6014150120680 (1×) <- 4013728120680 (6×)    Lager 14.09. 17:19
9014720120512 (2×) <- 4013728120512 (6×)    Lager 14.09. 17:19
4000120297157 (1×) <- 4001110297157 (5×)    Lager 14.09. 17:19
```

**Alle sechs erfüllen ihre Prüfziffer einwandfrei.** Die Prüfziffer hat kein einziges Mal gewarnt —
und das ist kein Zufall: Der native BarcodeDetector gibt nur prüfzifferngültige Ergebnisse heraus.
Jede Fehllesung, die bei uns ankommt, ist per Konstruktion gültig. Damit ist die **Wiederholung der
einzige wirksame Schutz**, und die Entscheidung von gestern, die Schwelle NICHT für gültige GTINs
zu senken, ist nachträglich hart belegt. Die sechs Zeilen stehen jetzt als Kommentar an der
Schwelle selbst — wer sie senken will, sieht sofort, was er widerlegen muss.

**Der Test hat mich dabei korrigiert.** Ich schrieb die Zusicherung „jedes Paar teilt mindestens 6
Endstellen" — sie wurde rot: Das erste Paar teilt nur `25400`, **fünf** Stellen. Die Erkennung
verlangte sechs, also fiel dieser echte Fall am 12.09. durch, und ich musste ihn von Hand
nachrechnen. Ohne den Test hätte ich die Lücke nie bemerkt, weil die Folge harmlos aussah.

**Bevor ich die Schwelle gesenkt habe, die Gegenprobe:** 62 verschiedene *echte* Codes aus drei
Läufen, alle Paare durchgerechnet — bei fünf gemeinsamen Endstellen **kein einziger Fehlalarm**.
Das hat einen Grund: Geschwisterartikel eines Herstellers teilen den **Anfang**
(`4013728120680` / `4013728120512`: neun Stellen vorn, null hinten; `3250616411265` /
`3250616411241` ebenso). Fehllesungen teilen das **Ende**. Genau darum ist das Ende das Kriterium
und der Anfang nicht — jetzt mit Zahlen statt mit Plausibilität.

**Was die Rangfolge richtig gemacht hat:** `VA48CN3` (Code 128, 4×) und `3250616411265` (EAN-13,
11×) auf derselben Etikette — die App nimmt die EAN. Eine gültige GTIN ist Klasse 3, ein
Code-128-Typenschlüssel Klasse 1; die Zahl der Lesungen entscheidet gar nicht erst mit.

### 2026-09-14 · Die richtige Nummer lag daneben — und die App hätte die falsche genommen

Alex' dritter Lauf. 145 Lesungen aus 156 Bildern (93 %), 18 bestätigt. Darin ein Fall, der schwerer
wiegt als alles bisher Gefundene — beide Codes in **derselben Haltung**, also nachweislich auf
demselben Etikett:

```
4061975605740    EAN-13, gültige Prüfziffer     2× gelesen  (nötig: 3)
D23232512002001  Data Matrix                    4× gelesen  → diesen nähme die App
```

`D23232512002001` ist ein Buchstabe und 14 Ziffern ohne Prüfziffer — eine Serien- oder
Chargennummer. Die nächste Packung desselben Artikels trägt eine andere; gespeichert entstünde
jedes Mal ein neues „unbekanntes Produkt". **Die richtige Nummer lag daneben, sie wurde nur einmal
zu selten gelesen.**

Die Ursache ist kein Fehler in der Rangfolge: Eine gültige GTIN ist Klasse 3 und schlägt einen
2D-Code (Klasse 2) — aber die **Schwelle greift davor**. Mit 2 von 3 Lesungen kam die EAN gar nicht
bis zur Wertung.

**Die naheliegende Reparatur wäre falsch gewesen.** „Eine gültige Prüfziffer ist schon eine
Sicherung, also reicht bei GTINs eine Lesung weniger" — im selben Bericht steht der Gegenbeweis:

```
043899941092     UPC-A, gültige Prüfziffer      1× gelesen
4003899941092    EAN-13, gültige Prüfziffer     8× gelesen   (10 gemeinsame Endstellen)
```

Die einmal gelesene UPC-A erfüllt ihre Prüfziffer **einwandfrei** und ist trotzdem eine Fehllesung.
Eine Prüfziffer fängt zufällige Fehler ab, nicht die systematischen eines Decoders — das war schon
die Lehre aus der Speisekammer, hier bestätigt sie sich ein zweites Mal.

Also nicht die Schwelle senken, sondern **sagen, was passiert ist**: Die Anlege-Maske nennt die
knapp verfehlte Artikelnummer und rät, noch einmal ruhig draufzuhalten. Dieselbe Haltung wie
überall sonst — erklären statt still entscheiden. Drei Gegenproben halten den Hinweis leise: nicht
wenn die GTIN ohnehin gewinnt, nicht bei nur EINER Lesung, nicht wenn gar keine GTIN dabei war.

**Und das LAPP-Etikett klärt `4542265236`.** Alex hat es fotografiert: Der Karton trägt links die
EAN `4 044774 701721` und rechts einen Code-128 `4542265236` — die **Art. Nr. steht im Klartext
daneben und lautet 4520014**. Der Code-128 ist also weder Artikelnummer noch GTIN; er ist die
zehnstellige Nummer, die in beiden Läufen allein auftauchte. Die Nachfrage beim Anlegen („Prüf das
bitte kurz") greift bei ihm also zu Recht. Wer diesen Karton scannt, sollte den **linken**
Strichcode in den Rahmen nehmen.

**Ein Fall, der KEIN Fehler ist:** `043899941092` wurde nicht als „Fehllesung von …" markiert,
obwohl die Merkmale passen — die beiden lagen in verschiedenen Haltungen, und im Haltebetrieb ist
die Haltung das Kriterium, nicht der Zeitabstand. In der App ist das folgenlos: Dort beginnt die
Zählung bei jedem Druck von vorn, eine einzelne Lesung erreicht die Schwelle nie.

### 2026-09-14 · Lauf mit den neuen Zahlen — und ein Bericht, der ein Kriterium erfand

Alex' erster Lauf mit der reparierten Messung. Die Zahlen stehen jetzt richtig da:

| | vorher (12.09.) | jetzt |
|---|---|---|
| Rate | „1.0/s" (Laufzeit) | **6,1/s** (Lesezeit) |
| Erster Treffer | „8,7 s" | **0,8 s Lesezeit** (6,7 s nach dem Start) |
| Schalterstellung | fehlte | „gedrückt halten: an · nur im Rahmen lesen: an" |

124 Lesungen aus 133 angesehenen Bildern — **93 %**, praktisch dasselbe wie beim Speisekammer-Lauf
(97 %). Die Behauptung „der Scanner ist schnell, langsam ist der Weg zum nächsten Regal" ist damit
zweimal unabhängig belegt.

**Der Fund steckte in der Begründung, nicht in den Daten.** Eine UPC-A `034754431490` (1 Lesung)
wurde als Fehllesung der EAN-13 `4044773431490` (6 Lesungen) eingestuft — richtig: gemeinsames Ende
`431490`, 1,1 s auseinander. Beide erfüllen ihre Prüfziffer, es ist also wieder ein Fall, in dem
allein die Häufigkeit und das gemeinsame Ende retten.

Der Bericht schrieb dazu: *„gleiches Ende bzw. gleicher Anfang, im selben Moment, dort deutlich
öfter gelesen."* Der **Anfang ist seit dem 09.09. gar nicht mehr Teil der Regel** — er flog raus,
weil ein gemeinsamer Anfang das Kennzeichen *echter* Geschwisterartikel ist (11 Fälle gegen 0
ausgezählt). Der Bericht behauptete also ein Kriterium, das es nicht gibt.

Das ist mehr als ein Schreibfehler: Ich musste den Fall von Hand nachrechnen, um ihn zu beurteilen.
Jetzt liefert der Bericht seine eigene Begründung mit — *„gleiche letzte 6 Stellen, 1,1 s
auseinander, dort 6× statt 1× gelesen"*. Im Haltebetrieb steht dort „in derselben Haltung", weil
dann nicht die Zeit das Kriterium ist.

Der Test prüft die Begründung selbst, samt Gegenprobe: Zwei Artikel mit gemeinsamem **Anfang**
dürfen nicht als Fehllesung gelten.

**Offen für Alex:** `4542265236` (Code 128, 10 Stellen) ist keine GTIN-Länge und erfüllt keine
Prüfziffer. Beim Anlegen erscheint deshalb die Nachfrage — vermutlich zu Recht eine
Großhändler-Artikelnummer, aber das weiss nur, wer die Packung in der Hand hat.

### 2026-09-14 · „Beweise die Fehlerlosigkeit" — drei Funde statt eines Beweises

Alex: *„Kannst du dir bitte noch einige Tests zusätzlich ausdenken, um die Fehlerlosigkeit des
Barcodes zu beweisen."* Beweisen lässt sie sich nicht — ein Test zeigt Fehler, nie deren
Abwesenheit. Was geht: gezielt dort suchen, wo bisher **nichts** misst. Erst messen, dann urteilen.

Die Messung (ein Wegwerf-Skript gegen die echten Routen) fand drei Dinge, die durchgingen:

**1. Ein 5000 Zeichen langer Code wurde angenommen.** Er landet im Offline-Spiegel, den JEDES Handy
im Lager herunterlädt — ein versehentlich gescannter QR mit eingebettetem Text bläht den Katalog
für alle auf. Jetzt 200 Zeichen; die längste echte Angabe aus allen Feldläufen war eine
GS1-Digital-Link-Adresse mit 62.

**2. Ein Code mit Zeilenumbruch oder Tabulator wurde als Artikelnummer gespeichert.** Das sind
vCards, WLAN-Zugänge, Merkblatt-Texte. Abgewiesen wird jetzt, statt still die erste Zeile zu
behalten: Wer eine Visitenkarte scannt, soll erfahren, dass das kein Artikelcode ist.

**3. Der Restore-Pfad zog für `products` nur `hersteller` nach.** `tests/altdb-spalten.js` prüft
seit dem 08.09. die Regel „was die Middleware aus `users` liest, muss der Restore-Pfad nachziehen"
— für `products` gab es keine Entsprechung, und dort lesen die Routen `p.hersteller`,
`p.deleted_at`, `p.merged_into` **namentlich**. Nach dem Einspielen einer alten Sicherung hätte der
Server auf jede Produktabfrage mit „no such column" geantwortet.

Praktisch getroffen hätte es nur eine Sicherung aus der Bauphase — das Verzeichnis ist nicht
deployed. Der Punkt ist ein anderer: **Eine halb umgesetzte Regel ist gefährlicher als keine**, weil
der Nächste sie für vollständig hält. Jetzt stehen alle gelesenen Spalten da, auch für
`product_categories`, `product_barcodes`, `product_suppliers` und `suppliers`.

**Der Test ruft den ECHTEN Restore-Pfad auf.** Dafür wird `ensureAuditSchema` aus
`database/init.js` mitexportiert. Ein nachgebauter Pfad hätte sich selbst geprüft — meine erste
Fassung tat genau das und war deshalb grün, wo sie hätte rot sein müssen.

**Zwei Dinge sind ausdrücklich KEINE Fehler und stehen jetzt als Zusicherung fest:**

* Ein Code aus lauter Leerzeichen heisst „kein Barcode" — mit Pflegerecht entsteht also ein
  barcodeloses Produkt, ohne wird abgewiesen. Mein erster Testentwurf erwartete hier 400 und lag
  falsch; gemessen schlägt vermutet.
* Gross- und Kleinschreibung sind **verschiedene** Codes. `id.abb/X` ist nicht `ID.ABB/x`. Wer das
  später „aufräumt", bricht die Hersteller-QRs — deshalb steht es als Zusicherung da, nicht nur als
  Kommentar.

**Was weiterhin ungeprüft bleibt** (ehrlich gesagt, nicht verschwiegen): das Verhalten echter
Kameras, die Entzifferungsqualität bei schlechtem Licht, und das Zusammenspiel mehrerer Leute am
selben Regal in derselben Sekunde. Das Erste misst nur der Prüfstand am echten Gerät, das Letzte
kann in dieser App nicht auftreten (ein Prozess, Node arbeitet eine Anfrage nach der anderen ab —
und die Eindeutigkeit hängt zusätzlich am UNIQUE-Index der Datenbank, nicht nur an der Prüfung im
Code).

### 2026-09-13 · Hersteller je Produkt — und was daran nicht das Feld ist

Alex: *„Generell soll es eine weitere Spalte für jedes Produkt geben. Nämlich Hersteller. Da jedes
Produkt von mehreren Herstellern auf Lager sein kann."* Der zweite Satz liest sich zunächst wie ein
Widerspruch zum ersten — eine Spalte kann keine mehreren Hersteller halten. Er ist die Begründung:
Weil derselbe Artikel von mehreren Herstellern im Regal liegt, braucht **jeder Eintrag** die
Angabe, um sie auseinanderzuhalten. Ein Hersteller je Produkt, derselbe Name mehrfach erlaubt.

Das ist auch die einzige Lesart, die zum Barcode-Modell passt: Jeder Hersteller hat seine eigene
EAN, also sind es ohnehin zwei Artikel. Eine n:m-Zuordnung hätte die Frage aufgeworfen, welcher
der hinterlegten Barcodes zu welchem Hersteller gehört — unbeantwortbar.

**Die eigentliche Arbeit war nicht das Feld, sondern die Folgen:**

* **Die Doppel-Warnung** hätte ab sofort dauerhaft angeschlagen — „Kabelbinder 200 mm" von OBO und
  von HellermannTyton wären zwei Namensgleiche. Eine Warnung, die immer an ist, liest niemand mehr.
  Der Hersteller gehört also in den Vergleichsschlüssel. Ein **leerer** Hersteller zählt dabei als
  eigener Wert: „Kabelbinder" ohne Angabe neben „Kabelbinder / OBO" ist sehr wohl verdächtig.
* **Die Bestell-Vorschlagsliste** musste ihn anzeigen. Ohne das stünden dort zwei identische
  Zeilen, und man bestellt aufs Geratewohl eine davon — das Feld wäre wertlos gewesen.
* **Suchen** geht auch über den Hersteller: Im Lager weiss man oft die Marke, nicht den Artikelnamen.
* **Zusammenführen** nimmt ihn mit, wenn das Ziel keinen hat.

**Freitext, aber nicht beliebig.** Alex wollte gerade eben die Datenhygiene erhöhen — ein freies
Feld, das „ABB", „abb" und „A.B.B." nebeneinander entstehen lässt, wäre das Gegenteil gewesen. Wer
etwas tippt, das in Vergleichsform einem vorhandenen Hersteller entspricht, bekommt **dessen**
Schreibweise gespeichert; nur wirklich neue Namen kommen so ins Feld, wie sie getippt wurden. Eine
gepflegte Stammdatenliste wäre die strengere Lösung gewesen — sie kostet einen eigenen Reiter mit
Papierkorb und Zusammenführen, und dafür ist der Nutzen zu klein.

**Ein Bestandstest zählte fest 4 Produkte** und wurde durch die zwei neuen Testartikel rot. Statt
die Zahl auf 6 zu setzen, misst er jetzt die **Veränderung** (vorher/nachher) — die soll null sein.
Eine feste Zahl in einer Zusicherung erzieht dazu, sie anzupassen statt sie zu lesen.

### 2026-09-13 · Einlernen wird ein Recht — eine Gründungsregel wird umgedreht

Alex: *„ich würde da doch gerne eine Berechtigung vergeben um die datenhygiene hoch zu halten.
Chef/Admin dürfen immer einlernen. Buchhalter und MA nur mit Berechtigung."*

Damit fällt die Begründung, die seit dem ersten Tag im Code stand: *„Anlegen darf JEDER — wer im
Lager vor einem unbekannten Barcode steht und nichts tun kann, umgeht die App."* Das war kein
Fehler, sondern eine Abwägung; sie wird jetzt anders entschieden. Der Preis bleibt derselbe (wer
den Karton in der Hand hat, muss fragen), der Gewinn ist, dass Einträge nur dort entstehen, wo
jemand auf Schreibweise, Kategorie und Doppel achtet.

**Ein eigenes Recht, nicht `can_products_edit` mitbenutzt.** Sonst hätte „darf einen Barcode einlernen"
automatisch „darf umbenennen, zusammenführen, löschen" bedeutet — gröber als gefragt. Umgekehrt
**folgt** das kleine aus dem grossen: Wer pflegen darf, kann im Verzeichnis längst Barcodes
anlernen und sogar Produkte ohne Code anlegen; ohne die Folgerung dürfte er es nur am Regal nicht.
Die Folgerung steht **einmal** in `barcoderecht.js`, und das Häkchen wird geleert, sobald
`can_products_edit` gesetzt ist — zwei Quellen für dieselbe Aussage laufen sonst auseinander.

**Drei Routen, ein Riegel.** `POST /api/products`, `POST /:id/barcodes` **und**
`POST /kategorien` — letztere, weil die Anlege-Maske nebenbei eine Kategorie erzeugen kann; ohne
sie hätte ein Unberechtigter zwar kein Produkt, aber Kategorien anlegen können. Alle drei hängen
an derselben Middleware, damit Regel und Erklärung nicht auseinanderlaufen (die Lehre aus
`bestellrecht.js`, wo dieselbe Bedingung an fünf Stellen stand und drei falsch waren).

**Die Meldung durfte nicht vom Barcode sprechen.** Mein erster Entwurf begann mit „Unbekannter
Barcode — …". Derselbe Riegel sitzt aber auch vor dem Anlegen *ohne* Code und vor einer neuen
Kategorie; dort wäre der Satz schlicht falsch gewesen. Den Barcode nennt jetzt die Oberfläche, die
ihn kennt. Ein Test hält das fest: Die Server-Meldung darf das Wort „Barcode" **nicht** enthalten.

**Die wichtigste Zusicherung ist eine Zusage aus der Meldung selbst:** Sie verspricht, dass
Bestellen mit freiem Text weitergeht. Also wird genau das geprüft — ein Versprechen in einer
Fehlermeldung ist eine Zusage wie jede andere.

**Rote Bestandstests, und was sie bedeuteten.** Nach dem Umbau waren fünf Testdateien rot. Zwei
Sorten: eine Zusicherung „jeder Mitarbeiter darf anlegen", die **abgelöst** und nicht kaputt ist —
sie steht jetzt in der neuen Form da; und Testaufbauten, die `max` als Anleger benutzen — die
bekommen das Recht ausdrücklich, so wie Alex es in der Firma vergäbe. Keine wurde stillgelegt.

**Gegenprobe:** `darfArtikelEinlernen()` fest auf `true` — dann erscheint die Anlege-Maske wieder,
und die Zusicherung „es erscheint KEINE Anlege-Maske" fällt.

**Nebenbei ein eigener Fehler:** Für die Startprobe habe ich `node -e "require('./server.js')"`
laufen lassen — gegen die Datenbank aus der `.env`, während ein Dev-Server lief. Genau der zweite
Prozess auf derselben Datei, vor dem meine eigene Notiz warnt. Es ist nichts passiert (beendet vor
dem 5-Sekunden-Autosave, Zeitstempel unverändert), aber es war Glück, nicht Sorgfalt. Die Probe
gehört mit eigenem `DB_PATH` und eigenem Port gefahren.

### 2026-09-12 · Ich habe einen Rat gegeben, der gar nicht wirken konnte

Alex' zweiter Lauf kam im ALTEN Berichtsformat zurück — ohne „Lesezeit", ohne die Zeile mit den
Schaltern. Nachgesehen: Auf dem Produktivserver liegt der Prüfstand vom **9. September**
(Häkchen aus, `display:none` am Knopf, `?v=385`). Meine Reparatur liegt auf `develop`, sein Handy
holt die Seite aber vom Produktivserver.

Mein Satz „lade die Seite einmal neu" **konnte also gar nichts bewirken** — neu geladen wird
dieselbe alte Datei. Der Fehler dahinter ist nicht der Tippfehler, sondern die Annahme: Ich habe
lokal repariert und stillschweigend unterstellt, das sei damit „draussen". Bei einer Änderung, die
der Benutzer sehen soll, gehört die Frage „wo läuft das, was er benutzt?" **vor** die Antwort.

**Zweiter Fund derselben Wurzel:** `scanner-probe.html` lud das Skript weiter als `?v=385`. Der
Prüfstand liegt **nicht** im Service-Worker-Vorrat — dieser Parameter ist der einzige Hebel gegen
eine alte Fassung im Browser. Selbst nach einem Deploy wäre die Änderung auf dem Handy nicht
angekommen. Jetzt gleicht ein Test das `?v=` gegen `CACHE_VERSION` ab.

**Wie ich trotzdem sicher sagen kann, dass der Haltebetrieb an war** — aus den Zahlen des Laufs,
nicht aus Vermutung: 10 Bilder geprüft, Rate 1.0/s (also ≈ 10 s seit dem Kamerastart), erster
Treffer nach 8.684 s, **9 Lesungen**. Liefe die Schleife durchgehend mit 1 Bild/s, lägen die Bilder
im Sekundenabstand; nach dem ersten Treffer bei 8.7 s blieben höchstens zwei Bilder übrig — neun
Lesungen sind dann unmöglich. Im Haltebetrieb passt es zwanglos: Die zehn Bilder entstehen alle
während eines kurzen Drucks. Alex hat das Häkchen also selbst gesetzt, und die Zahl „1.0/s" misst
wieder die Laufzeit statt der Lesezeit.

### 2026-09-12 · Die Zahnpasta-Tube: nachfragen, wo eine Regel falsch wäre

Alex hat die Tube fotografiert. `T60020279303` steht **auf der Falz**, neben Füllmenge und
Öffnungssymbol — genau dort druckt die Abfüllmaschine die **Chargennummer**. Die nächste Tube
derselben Sorte trägt eine andere; als Barcode gespeichert wäre das Produkt beim nächsten Einkauf
wieder unbekannt, und jemand legte ein Doppel an.

**Trotzdem keine Verbotsregel — und das ist der Punkt dieses Eintrags.** Aus der Zeichenkette
allein ist der Fall nicht zu entscheiden. „Buchstabe plus Ziffern" ist die Form einer völlig
normalen Artikelnummer; `S78037524` und `A2026052700123` stehen im Code ausdrücklich als
Beispiele, die unberührt bleiben SOLLEN. Der Unterschied steckt nicht im Code, sondern in der
**Stelle auf der Verpackung** — und die sieht die App nicht.

Also: **nachfragen statt abweisen.** `scannerNachfragenObArtikelnummer` ist bewusst stumpf — sie
fragt immer, wenn der Code keine gültige GTIN ist, denn nur die ist nachweislich eine
Artikelnummer. Der Hinweis nennt jetzt beide Quellen: Lieferschein-Etiketten **und** die Falz von
Tuben / den Boden von Flaschen.

**Die Gegenprobe war hier lehrreicher als der Test selbst.** Ich habe die naive Regel eingesetzt,
die sich aufdrängt — „enthält einen Buchstaben ⇒ verdächtig". Ergebnis: **fünf** Zusicherungen rot,
darunter der ganze Lieferschein-Hinweis. Denn `801036963840` ist eine reine Ziffernfolge; die
naive Regel hätte die aus Felddaten gebaute Warnung stillschweigend abgeschaltet. Eine Regel, die
den neuen Fall trifft und dabei den alten verliert, ist keine Verbesserung.

**Die Gegenprobe, die zählt**, ist ohnehin die verneinende: Bei gültigen EAN-13, EAN-8 und UPC-A
darf **nicht** gefragt werden. Wer bei jedem zweiten Scan einen Hinweis wegklickt, liest ihn nie
wieder — dann ist die Warnung schlechter als keine.

### 2026-09-12 · Speisekammer-Lauf: 26 Codes — und eine Zahl, die den Scanner verleumdet hat

Alex' Lauf über die eigene Speisekammer, 26 Codes in gut vier Minuten, 25 bestätigt. Inhaltlich ist
**nichts schiefgegangen**: Jede Regel hat auf echten Handelsetiketten genau das getan, wofür sie
gebaut wurde. Die Erkenntnisse stecken diesmal in den **Messwerten**, nicht in den Treffern.

**1. „318 Bilder geprüft (1.3/s)" war eine Verleumdung des eigenen Scanners.** Das klang nach einem
lahmen Decoder. Die Gegenrechnung aus demselben Bericht: Die Lesungen der 26 Einträge summieren
sich auf **308** — aus **318** angesehenen Bildern. **97 % Trefferquote.** Fast jedes Bild, das die
Schleife angesehen hat, war ein Treffer.

Die Ursache ist der Haltebetrieb: Seit „gedrückt halten" schaut die Schleife nur beim Drücken auf
ein Bild — geteilt wurde aber weiter durch die **ganze verstrichene Zeit**, Laufwege zum nächsten
Regalbrett eingerechnet. Dasselbe galt für „Erster Treffer nach 14.6 Sekunden": gemessen ab
Kamerastart, nicht ab dem ersten Druck.

Das ist nicht bloss unschön. Nach so einer Zahl optimiert man an der **falschen Stelle** — etwa an
der Auflösung oder am Decoder, während in Wahrheit nur der Mensch zwischen zwei Kartons unterwegs
war. Gemessen wird jetzt die **Lesezeit**: die Zeit, in der wirklich gelesen wurde. Beide Zahlen
stehen im Bericht („2.1 s Lesezeit (14.6 s nach dem Start)"), damit der Ablauf ablesbar bleibt.

**2. Der Bericht verschwieg die zwei Schalter, die die Messung am stärksten verändern.** Ob
„gedrückt halten" und „nur im Rahmen lesen" an waren, stand nirgends — ohne das sind die Zahlen
nicht deutbar. Ich musste es aus dem Verhältnis 308/318 erschliessen. Beide stehen jetzt im Kopf.

**3. Das Rätsel „4311" von vorletzter Woche ist gelöst.** Alex damals: *„4311 kenn ich nicht. Ist
mir unbekannt."* In diesem Lauf tauchen **drei** EAN-13 auf, die mit 4311 beginnen
(`4311536170300`, `4311501706381`, `4311501123591`) — ein deutscher GS1-Präfixbereich. Die nackte
„4311" war also mit grosser Wahrscheinlichkeit ein **abgebrochener Lesevorgang** eines solchen
Etiketts, und die Kurzzahl-Regel hat sie zu Recht abgewiesen. Eine Regel, die aus einem ungeklärten
Fund entstand, ist damit nachträglich belegt.

**4. Eine gültige Prüfziffer ist KEIN Beweis.** `8000070025400` (17 Lesungen) und `5009547125400`
(1 Lesung) wurden 913 ms auseinander gelesen und als dieselbe Etikette gruppiert. Nachgerechnet:
**beide erfüllen die EAN-13-Prüfziffer.** Der Decoder hat also eine formal einwandfreie, inhaltlich
falsche Nummer geliefert. Gerettet haben allein die **Häufigkeit** (17 zu 1) und das gemeinsame
Ende (`25400`, fünf Stellen) — genau die zwei Kriterien, die am 09.09. aus den Messdaten entstanden
sind. Hätten wir nur die Prüfziffer geglaubt, läge jetzt ein Geisterprodukt im Katalog.

**5. Offen, aber nicht gefährlich:** `T60020279303` (QR) wurde als Artikelcode übernommen. Er passt
in keine der Ausschlussregeln, sieht aber auch nicht nach einer GTIN aus. Ob das eine Artikelnummer
oder ein Chargencode ist, kann nur Alex am Produkt nachsehen — eine Regel auf Verdacht wäre genau
der Fehler, der beim `id.abb`-Fall beinahe passiert wäre.

### 2026-09-12 · Am Prüfstand war kein Knopf — zum zweiten Mal ein unsichtbares Bedienelement

Alex: *„am Prüfstand ist gerade gar kein button zu sehen um das scannen zu aktivieren."*

Der Halte-Knopf hing an einem Häkchen, das **aus** war — und seine Anfangsanzeige stand zusätzlich
fest im HTML (`display:none`). Zwei Quellen für dieselbe Aussage „ist der Knopf sichtbar?", und sie
liefen auseinander. Behoben an der Wurzel: Das `display:none` ist **raus**, das Häkchen ist
**gesetzt** (der Prüfstand soll sich verhalten wie die App), und die Sichtbarkeit stellt beim Start
dieselbe Funktion her, die auch das Umschalten bedient.

**Das war der zweite Fall derselben Art.** Am 09.09. standen die beiden Schalter innerhalb von
`#zoombox`, die ohne Kamera-Zoom ausgeblendet ist — auf Alex' Android war der Zoom da, auf einem
iPhone ohne Zoom wären sie unsichtbar gewesen. Beide Male hat es **kein Test gemerkt**, und zwar
aus einem simplen Grund: **Keiner hat die Seite je geladen.** Der Prüfstand war „nur ein Werkzeug".

`tests/scanner-pruefstand-ui.js` holt das nach. Er läuft **ohne Kamera** — headless gibt es keine,
und das ist genau der Punkt: Die Bedienelemente müssen schon vor dem Start sichtbar sein. Geprüft
wird der Knopf vor jedem Start, das Aus- und Wiedereinschalten, die Lage **unter** dem Kamerabild
(über die gemessenen Rechtecke, nicht über die Zeile im Quelltext) — und ausdrücklich, dass keiner
der drei Schalter in `#zoombox` liegt, während die zugeklappt ist. Die Gegenprobe mit dem Zustand
von heute Morgen macht drei Zusicherungen rot.

**In der App ist der Knopf unbedingt** — kein Häkchen, kein `display:none`, ausserhalb der Zoom-Box,
unter dem Bild. Dort kann derselbe Fehler nicht auftreten.

**Beim Entfernen des Prüfstands mitnehmen:** `public/scanner-probe.html`, `public/scanner-probe.js`,
der Link auf der Bestellseite **und** `tests/scanner-pruefstand-ui.js`. Das steht auch im Kopf der
Testdatei.

### 2026-09-10 · Zwei Sicherungen fielen aus — ein Punkt am falschen Bezugspunkt

Die Morgenkontrolle meldete um 07:30: *„keine Sicherung von heute — VPS hat nicht gesichert oder
das Abholen klemmt."* Im Protokoll des VPS standen zweimal drei Worte:

```
[backup] DB fehlt: ./data/arbeitsdoku.db
```

In der `.env` steht `DB_PATH=./data/arbeitsdoku.db` — **relativ**. cron startet im
Heimatverzeichnis, dort gibt es kein `./data`. Betroffen waren die Läufe um 00:00 und 06:00, also
beide seit der Umstellung auf das neue Skript am Vorabend.

**Warum es vorher lief und warum ich es nicht gemerkt habe:**

* Das **alte** Skript lag in einem eigenen Verzeichnis und hatte seinen Pfad fest verdrahtet.
* Die **App** merkt davon nichts: systemd startet sie mit `WorkingDirectory` im App-Verzeichnis.
* Mein **Handlauf am Abend** lief durch, weil ich zufällig im App-Verzeichnis stand. Ein Test, der
  nur beweist, dass man selbst am richtigen Ort steht, beweist nichts über cron.

**Die Lehre ist nicht „Pfad korrigieren", sondern:** Ein Sicherungsskript darf nicht davon
abhängen, **wo** es aufgerufen wird. Pfade aus der `.env` beziehen sich jetzt auf das
App-Verzeichnis (`ausApp()`), nicht auf das Arbeitsverzeichnis; nur ein Pfad, der als
Kommandozeilen-Argument kommt, bleibt cwd-relativ — das erwartet man dort.

**Die Fehlermeldung war mitschuldig.** `DB fehlt: ./data/arbeitsdoku.db` sagt nicht, **wo** gesucht
wurde — genau die Angabe, die den Fall in einem Satz gelöst hätte. Sie nennt jetzt den aufgelösten
Pfad, das App-Verzeichnis und den Rohwert aus der `.env`.

Der Test (`tests/backup-naechtlich.js`, Abschnitt 6) stellt die Kombination nach: relativer
`DB_PATH` in der `.env` **plus** Aufruf aus einem fremden Verzeichnis. Die Gegenprobe mit dem alten
Code macht vier Zusicherungen rot und schreibt dabei wörtlich dieselbe Zeile wie der Produktivserver.

**Nicht angefasst:** `database/init.js` löst `DB_PATH` ebenfalls gegen das Arbeitsverzeichnis auf.
Dort ist es heute harmlos (systemd setzt das Verzeichnis), aber dieselbe Zerbrechlichkeit.

### 2026-09-09 · Produkte ohne Barcode — und wie die Gründungsregel dabei heil bleibt

Alex wollte die **Gegenrichtung**: *„und das optional einem Produkt mit Barcode über eine suche
zuordnen. wenn kein Barcode verknüpft wird kann man das Produkt zum bestellen nicht scannen aber
über die suche finden."* Und kurz darauf die Ergänzung, die den Kreis schließt: *„dem Produkt ohne
Barcode soll später im Lager von einem MA beim Scannen ein Barcode zugeordnet werden können."*

Das kippt die Regel, auf der das ganze Verzeichnis gebaut war: **In den Katalog kommt nur, was
einen Barcode hat.** Sie war kein Selbstzweck — sie war der Schutz davor, dass das Verzeichnis
zumüllt, weil jede getippte Bestellung einen Eintrag erzeugt. Der Schutz sitzt jetzt woanders:

* **Beim Scannen** gilt sie unverändert. Wer keinen Code hat, legt nichts an.
* **Ohne Code anlegen** darf nur, wer **„Lagerdaten pflegen"** hat — dieselbe Handvoll Leute, die
  auch zusammenführen und löschen darf. Wildwuchs entsteht nicht dort, sondern bei den 13 Leuten
  mit dem Handy im Lager.

Damit war auch das **harte Verbot, den letzten Barcode zu entfernen**, keine Unmöglichkeit mehr,
sondern eine Entscheidung mit Folgen. Aus `403 „ein Produkt muss mindestens einen haben"` wurde ein
`409` mit Rückfrage, das sagt, **was danach gilt**: nicht mehr scannbar, über die Suche findbar.

**Zwei Fehler, die der Test gefunden hat und ich nicht:**

1. `${p.barcodes ? … : 'ohne Barcode'}` — ein **leeres Array ist wahr**. Die Kennzeichnung wäre nie
   erschienen, und zwar genau bei den Produkten, für die sie gedacht ist.
2. Das Formular an der Händlerzeile hatte **Bestellnummer und Link, aber keinen Kommentar** — die
   Route schreibt alle drei Felder, ein Klick auf *Speichern* hätte den Kommentar still geleert.
   Der Test schreibt deshalb beide Felder und liest **beide** zurück.

**Die Gegenprobe zur Anlern-Kette** (ein `.filter(p => p.barcodes.length)` in die Vorschlagsliste
gesetzt) hat drei Zusicherungen rot gemacht — der Test misst also wirklich den Weg vom codelosen
Produkt zum gescannten Code, und nicht nur, dass irgendein Dialog aufgeht.

**Eine falsche Fährte unterwegs:** Der erste UI-Test war rot, weil das Suchziel-Produkt *nach* dem
Seitenaufbau angelegt wurde. Das war kein Fehler der Suche — die Verzeichnis-Ansicht baut sich bei
fremden Änderungen mit Absicht **nicht** neu auf (sie ist voller Eingabefelder) und blendet nur den
Hinweis „Neu laden" ein. Gefährlich war dabei die **Gegenprobe daneben** („bietet Zugeordnetes
nicht noch einmal an"), die grün war, weil überhaupt nichts gefunden wurde. Grün aus dem falschen
Grund, wieder einmal.

### 2026-09-09 · Die Sicherungen verschlüsseln — und die `.env` gehört hinein

Alex: *„die .env Datei ist ja sehr wichtig. Wird die auch jede Nacht mit gespeichert? Sonst bringen
mir die ganzen backups nicht so viel, oder?"* — Sie wurde nicht. Und seine begründete Annahme
(*„sobald in der .env ein schlüssel liegt oooooder in den einstellungen bei backup, dann wird
verschlüsselt"*) galt nur für den **Download** aus der App; die **nächtliche** Sicherung schrieb
immer Klartext, weil sie ein eigenständiges Skript ohne jede Krypto-Abhängigkeit war.

**Was ohne `.env` fehlt:** `TWOFA_KEY` verschlüsselt die Zwei-Faktor-Geheimnisse in der Datenbank —
ohne ihn spielt man einen Bestand zurück, an dem sich niemand mehr anmelden kann (der Notausgang
`TWOFA_AUS=1` existiert, aber alle müssten neu einrichten). Die `VAPID_`-Schlüssel: alle
Push-Anmeldungen wertlos. `JWT_SECRET`: alle Sitzungen weg.

**Der eigentliche Fund war aber die Kette.** Vier Stellen erwarteten fest `arbeitsdoku_backup_*.zip`:
das Abhol-Skript des Mini-PCs (`--include`), die Morgenkontrolle, die Wiederherstellungs-Übung
(entpackt mit Pythons `zipfile`) und der Erzeuger selbst. Hätte ich nur den Erzeuger umgestellt,
wäre auf dem Mini-PC **nichts** mehr angekommen und die Morgenkontrolle hätte jeden Morgen Alarm
geschlagen — beides still und erst am nächsten Tag sichtbar. Deshalb die Reihenfolge: **erst alle
Leser auf beide Formate, dann den Erzeuger.** Jeder Leser wurde nach der Änderung einzeln laufen
gelassen, nicht nur editiert.

Die Übung schickt jetzt **jede** Sicherung durch `backup-entschluesseln.js` — das reicht
Klartext-Zips unverändert durch. Dadurch braucht es keine Fallunterscheidung, und der
Entschlüsselungsweg wird bei **jeder** wöchentlichen Übung mitgeprüft statt erst im Ernstfall.

`make-backup.js` liegt jetzt **im Repo** (`scripts/`, wird von `deploy.sh` mitgeliefert). Vorher
existierte es nur auf dem Server: unversioniert, ungetestet, im Ernstfall von Hand nachzubauen —
für das Programm, das alles retten soll, der falsche Ort.

**Die harte Regel** steht in `tests/backup-naechtlich.js` als verneinende Zusage: *ohne Empfänger
keine `.env` im Archiv*. Lieber eine Sicherung ohne Schlüssel als Schlüssel im Klartext — die
Archive liegen am Ende in 60 Versionen auf zwei Rechnern.

**Schlüssel ohne Umweg:** Das Paar für den Mini-PC wurde **auf dem Mini-PC** erzeugt, der private
Teil direkt in dessen `.env` geschrieben und nie ausgegeben. Nach aussen ging nur der öffentliche.
So musste kein privater Schlüssel durch den Chat — und der Sitzungsmitschnitt wird ja selbst auf
den Produktivserver gesichert.

**Ende-zu-Ende belegt:** VPS erzeugt `.adbk` (minipc, offline) → Mini-PC holt sie → Morgenkontrolle
meldet „Sicherung von heute da" → Übung entschlüsselt und stellt wieder her: 13 Nutzer, 1304
Einträge, App startet.

### 2026-09-09 · Durchsucht nach Sackgassen — zwei gefunden

Alex bat, das Barcode-Feature auf Logikfehler, Bugs, unmögliche Zustände und englische Meldungen
durchzugehen. Gesucht wurde nicht durch Lesen, sondern durch **Ausprobieren**: ein Bosheits-Skript,
das dem Server absichtlich Unfug vorsetzt.

**Kein Befund** bei: englischen Meldungen (alle deutsch), Zusammenführen mit sich selbst, in ein
bereits aufgegangenes Produkt oder aus einem heraus, Kategorien in gelöschte verschmelzen,
Grenzwerten (leere Namen, zu lange Bestellnummern), Rechteprüfungen auf allen neuen Wegen, und
Barcodes mit Schrägstrich (`https://qr.fischer.id/p/551442` — echte Hersteller-QRs werden ja
gespeichert; Anlegen, Nachschlagen und Entfernen gehen sauber durch). Auch die **Kette**
A→B→C führt den ältesten Barcode korrekt zum letzten Überlebenden.

**Fund 1 — ein Versprechen, das die App nicht einlösen konnte.** Beim Löschen eines Großhändlers
stand: „Die bleiben erhalten und kommen zurück, wenn der Händler wiederhergestellt wird." Es gab
aber **kein Wiederherstellen** (404), und wer denselben Namen neu anlegte, bekam einen *neuen*
Händler — die alten Bestellnummern blieben als unsichtbare, verwaiste Zeilen in der Datenbank
liegen (gemessen: 1 Waise nach einem einzigen Durchgang). Jetzt gibt es
`POST /api/suppliers/:id/wiederherstellen`, gelöschte Händler stehen im Papierkorb, und der
Grenzfall „Name inzwischen neu vergeben" wird erklärt statt still zu scheitern.

**Fund 2 — eine echte Sackgasse.** Der Barcode eines gelöschten Produkts bleibt belegt. Die App bot
nach dem Scan an: „Soll er als NEUES Produkt angelegt werden?" — wer ja sagte, füllte die Maske aus
und bekam beim Speichern „Dieser Barcode gehört bereits zu …". *Anlernen* an ein anderes Produkt
scheiterte aus demselben Grund. **Es gab keinen Weg vorwärts.** Jetzt wird das Zurückholen
angeboten (wer das Recht hat) beziehungsweise erklärt, wer helfen kann (wer es nicht hat). Und die
409-Meldungen beider Wege sagen jetzt selbst, woran es liegt und wie man herauskommt.

Beides in `tests/produktpflege.js` festgeschrieben.

### 2026-09-09 · „Failed to fetch" — einmal zentral übersetzt

Alex: *„aber das macht auch keinen Sinn wenn ich offline dann nicht auf bestellen klicken kann."*

Der Einwand trifft: Der Katalog-Spiegel deckt **nur** Suchen und Nachschlagen ab. Sein Nutzen liegt
weniger im *vollständig* Offline-Fall als bei **zäher** Verbindung — dort stünde die Bestellseite
sonst minutenlang leer. Vollständig ohne Empfang bleibt vom Spiegel wenig übrig: Man kann
nachsehen, was man in der Hand hält, mehr nicht.

Umso wichtiger ist, dass das Absenden **ehrlich** scheitert. Nachgesehen: Es scheiterte mit
`toast(err.message)` — und `err.message` war die Rohmeldung des Browsers, **„Failed to fetch"**.
Dieselbe Stelle hatte ich eine Stunde vorher schon beim Produkt-Anlegen einzeln repariert. Zwei
Vorkommen sind ein Muster: Die richtige Stelle ist `api()` selbst, nicht die dreißig Fangstellen.

`api()` übersetzt jetzt **einmal zentral** und hängt `verbindung: true` an den Fehler. Dieses
Merkmal ist zugleich das verlässlichste Unterscheidungszeichen für den Katalog-Spiegel: Er darf auf
die Gerätekopie ausweichen, wenn die *Verbindung* fehlt — aber niemals, wenn der *Server*
fachlich abgelehnt hat. `istVerbindungsfehler` fragt es zuerst ab.

Gegenprobe: Übersetzung entfernt → „Failed to fetch" steht wieder da, zwei Zusagen fallen.

### 2026-09-09 · Anlegen im Funkloch — gemessen, nicht abgeleitet

Alex: *„angenommen im Lager wäre kein Empfang, ich lerne einen neuen scan ein, gehe auf speichern
und versetze mein Smartphone in standby. Wird das beim erneuten Empfang trotzdem synchronisiert?
Auch 30 Minuten später? Auch auf dem iphone?"*

Statt aus dem Entwurf zu antworten, alle drei Fälle im Browser durchgespielt:

* **Schon offline, unbekannten Code gescannt** → die Maske erscheint gar nicht erst. Die App sagt
  vorher: „Ohne Verbindung lässt sich weder prüfen, ob es ihn inzwischen gibt, noch ein Produkt
  anlegen."
* **Maske offen, dann Verbindung weg, dann speichern** → die Eingabe bleibt stehen. Die Meldung
  lautete allerdings **„Failed to fetch"** — die Rohmeldung des Browsers, englisch, technisch, und
  sie verschweigt das Wichtigste: dass nichts gespeichert wurde *und nichts nachgeholt wird*.
* **Verbindung kommt zurück** → nichts auf dem Server, nichts im Gerätespeicher. Es gibt keine
  Warteschlange.

Die Antwort ist also **nein**, und zwar unabhängig von 30 Minuten und unabhängig vom Gerät — es ist
keine Plattformfrage, es liegt schlicht nichts vor. Behoben wurde die Meldung: Sie ist jetzt deutsch
und sagt ausdrücklich, dass nichts nachgeholt wird und ein zweiter Druck genügt.

### 2026-09-09 · Drei Nachfragen — und eine vierte Lücke, die dabei auffiel

Alex fragte nach: (1) Bekommt der Bearbeitende eine Meldung mit Knopf? (2) Kann MA b im Lager den
Code sofort nutzen, den MA a eben eingelernt hat? (3) Wird eine Änderung aus der Pflege sofort zu
beiden im Lager synchronisiert?

Die Antworten, jede im Test festgeschrieben statt behauptet:

1. **Ja** — Hinweisband mit „Neu laden", und die angefangene Eingabe bleibt stehen.
2. **Ja, sofort.** Der Scan fragt den **Server** (`GET /api/products/barcode/:code`), nicht die
   Gerätekopie. Um das zu *beweisen*, leert der Test die Kopie vorher absichtlich — findet der Scan
   das Produkt trotzdem, kann es nur vom Server gekommen sein. Beim *Tippen* greift die
   nachgezogene Kopie.
3. **Ja** — die Pflege löst dasselbe Signal aus, beide Handys ziehen nach; ein Scan fragt ohnehin
   den Server.

**Die vierte Lücke, ungefragt gefunden:** `es.onopen` zog nach einem Verbindungsabbruch die *Zähler*
nach, den *Katalog* aber nicht. Wer im Lager aus einem Funkloch kommt oder das Handy aus der Tasche
holt, hätte eine Produktliste von vorhin gehabt — verpasste Signale sind weg. Das ist exakt der
Fehler vom „eingefrorenen Coin": nur gesendet, nie geholt. Jetzt zieht sowohl `onopen` als auch der
Wechsel zurück in die App den Katalog nach. Gegenprobe: die Zusage fällt.

### 2026-09-09 · Wächst das Verzeichnis live mit? Bisher nicht.

Alex' Frage: *„wenn MA a am pc sitzt und Produkt Datenbank bearbeiten offen hat und in diesem
Moment MA b einen Artikel einlernt, kann dann MA a live die Datenbank wachsen sehen?"*

Nachgesehen statt aus der Absicht geantwortet: `routes/products.js` und `routes/suppliers.js` rufen
an **16 Stellen** `broadcast('produkte')` — und im Frontend hörte **niemand** darauf. Das Signal
ging ins Leere. Die ehrliche Antwort war also nein.

Beim Nachrüsten sind es **zwei sehr verschiedene Fälle**, und sie brauchen entgegengesetzte
Behandlung:

* **Bestellungen** — die Gerätekopie des Katalogs wird still nachgezogen, **kein** Neuaufbau. Die
  Vorschlagsliste liest bei jedem Tastendruck aus `S.produktKatalog`; das neue Produkt ist damit
  beim nächsten Buchstaben da, ohne dass jemandem das Formular unter den Fingern weggerissen wird.
* **Verzeichnis-Pflege** — hier wird **nicht** neu aufgebaut, sondern ein Hinweisband eingeblendet.
  Diese Seite besteht fast nur aus Eingabefeldern: Name, Kategorie, Barcodes, Bestellnummern,
  Kommentare. Ein Neuaufbau vernichtete angefangene Arbeit — und zwar genau dann, wenn zwei Leute
  **gleichzeitig aufräumen**, also im Ernstfall. Wer soweit ist, drückt selbst auf „Neu laden".

`tests/produkte-live-ui.js` fährt beide Fälle mit zwei Benutzern zugleich: MA a tippt im Formular,
MA b legt über die Schnittstelle an. Geprüft wird nicht nur, dass das Produkt ankommt, sondern
ausdrücklich auch, dass MA a' angefangene Eingabe **unversehrt** stehen bleibt. Gegenprobe ohne
Empfänger: vier Zusagen fallen.

### 2026-09-09 · Gedrückt halten — und ein Schalter, den nie jemand sah

Alex: *„Das Problem mit dem über das Regal schwenken könnte man lösen, indem man ein touchbutton
‚scannen' platziert und nur so lange der button gedrückt ist, wird gescannt."*

Der Vorschlag löst mehr als das Prüfstand-Problem. Im Live-Scanner begann das Lesen bisher in dem
Moment, in dem sich die Kamera öffnet — wer das Handy erst hochführt, liest womöglich schon das
Nachbaretikett. Jetzt bestimmt der Mensch, **wann** gelesen wird. Und der zweite Gewinn ist der
größere: **Die Zählung beginnt bei jedem Druck von vorn.** Damit ist jede Haltung genau eine
Etikette, und Codes verschiedener Kartons können sich nicht mehr vermischen — genau das, was im
Regal-Lauf als Verkettung sichtbar wurde.

Im **Prüfstand** ist es ein Schalter, kein Zwang: Lange Messläufe über Minuten sollen möglich
bleiben. Ist er an, gruppiert der Prüfstand nach **Haltung** statt nach Zeitabstand — er muss die
Zusammengehörigkeit dann nicht mehr raten, er weiß sie.

**Zwei eigene Fehler dabei, beide von Messungen aufgedeckt:**

Erstens hellte mein Entwurf die Abdunklung beim Halten von 0,58 auf 0,45 auf — also genau in dem
Moment, in dem der Rahmen am stärksten führen soll. Der Test meldete es (`… das Aussen ist
abgedunkelt`).

Zweitens, und schwerer: Der neue Schalter landete **innerhalb von `#zoombox`** — und die ist
ausgeblendet, wenn ein Gerät keinen Zoom hergibt. Beim Nachmessen stellte sich heraus, dass der
Schalter **„nur im Rahmen lesen"** von vorhin dort schon die ganze Zeit lag. Auf Alex' Android ist
Zoom vorhanden, also war er sichtbar; auf einem iPhone ohne Zoom wäre er **nie** zu sehen gewesen.
Gefunden nur, weil `checkVisibility()` „false" meldete und ich der Ursache nachgegangen bin statt
sie zu übergehen. Beide Schalter stehen jetzt ausserhalb.

Gegenprobe zum Halten: `!liest` entfernt → „vor dem Drücken wird nicht gelesen" und „nach dem
Loslassen wird nicht weitergelesen" fallen beide.

### 2026-09-09 · Ausgezählt statt geschätzt: wie oft trifft es wirklich?

Auf die Frage, ob solche Kartons häufig sind, Alex: *„kannst du doch selbst aus deinen Daten raus
lesen. Ich würde sagen, nicht oft."* Zu Recht — fünf Feldläufe lagen vor, **64 verschiedene Codes**:

```
 40  Artikelnummer (gültige GTIN)
 13  reine Zahl OHNE Prüfziffer
  6  sonstiger Code (mit Buchstaben)
  4  Werbe-/Infocode
  1  Charge/Datum
```

Die 13 fraglichen zerfallen sauber in zwei Gruppen:

```
4311             in 4 von 5 Läufen, 121x gelesen   <- neben WECHSELNDEN Nachbarn
801036998746     in 3 von 5 Läufen                 <- Etiketten-IDs derselben Familie
801036963840     in 2 von 5 Läufen
--- alle übrigen: je EIN Lauf ---
2003145 · 2004922 · 912002870 · 4542265236 · 95583298 · 95599269 · 276848080010825 · …
```

**Das entscheidet die offene Frage.** Die zehn Einzelgänger sehen nach Haus- und Bestellnummern von
Händlern aus und können ein Produkt sehr wohl bezeichnen — sie abzuweisen hiesse, jemanden vor
einem Karton stehen zu lassen, dessen einziger Barcode nun mal so aussieht. Sie werden deshalb nur
**zurückgestuft** und beim Anlegen mit einem Hinweis versehen.

`4311` dagegen erscheint neben wechselnden Nachbarn, klebt also auf vielen Etiketten; gespeichert
zeigten lauter verschiedene Artikel auf **denselben** Eintrag. Er wird **abgewiesen** und erklärt.
Die Grenze liegt bei fünf Ziffern, und das ist mit Absicht knapp: Unter allen 64 gemessenen Codes
ist er der **einzige** mit höchstens fünf. Die nächstkürzeren echten Nummern haben sieben und
bleiben unberührt.

So bleibt auf dem fotografierten Lieferschein-Etikett die Etiketten-ID `801036963840` übrig — samt
Warnung, dass sie sich mit jeder Lieferung ändert.

**Nachtrag, und eine Korrektur an mir selbst:** Ich hatte geschrieben, auf diesem Karton gebe es
gar keinen Artikel-Barcode. Alex hat **denselben Karton von der anderen Seite** fotografiert — dort
klebt das Hersteller-Etikett von Schletter:

```
Unterlegplatte Dachhaken 2,5/5 mm      973000-075      100 Stk
EAN-13  4262371512483   (Prüfziffer stimmt)   + ein QR
```

Die Aussage galt also nur für das **Lieferschein-Etikett**. Der Karton trägt sehr wohl eine gültige
GTIN, nur eben auf einer anderen Seite — und die schlägt in der Rangfolge beide Logistikcodes, auch
mit weit weniger Lesungen. In keinem der fünf Läufe kam sie vor; diese Seite wurde nie gescannt.

Der Warntext sagte deshalb bisher etwas Irreführendes („steht meist auf der Ware selbst, nicht auf
dem Versandkarton"). Er lautet jetzt: **„Dreh den Karton um: Der Artikel-Barcode steht meist auf
einer anderen Seite, auf dem Etikett des Herstellers — oder auf der Ware selbst."*

### 2026-09-09 · Das Etikett löst beide Rätsel

Alex hat den Karton fotografiert. Damit ist klar, was die beiden unerklärten Codes sind:

```
Etiketten ID  801036963840      <- steht im Klartext direkt UNTER dem Data-Matrix
Lieferdatum   07.09.2026           TRANS 801905 - TOUR WZ07 - BOX 8
```

Ein **Lieferschein-Etikett** des Großhändlers, kein Produktetikett. Die Artikelnummern stehen nur
als **Text** darauf — `1010957292` beim Händler, `Schletter 973000-075` beim Hersteller. Die
lesbaren Codes bezeichnen das **Etikett** und die Tour, nicht die Ware.

**Die Regel daraus:** Eine rein numerische Angabe ist genau dann eine Artikelnummer, wenn sie die
GTIN-Prüfziffer erfüllt. Sonst verliert sie den 2D-Bonus — ein Data-Matrix ist verlässlich
*gelesen*, sein *Inhalt* ist deshalb noch keine Artikelnummer. Nur reine Ziffern; alles mit
Buchstaben bleibt unberührt, dort ist keine Prüfziffer zu erwarten.

Die Prüfziffer trifft nicht jeden Fall: `801037001516` — eine weitere Etiketten-ID aus demselben
Lauf — erfüllt sie **zufällig**. Bei zwölfstelligen Zahlen passiert das in etwa einem von zehn
Fällen. Mehr gibt der Inhalt nicht her.

**Ein eigener Test fiel dabei** — er erwartete, `801036963840` gewinne gegen `4311`. Das war meine
Annahme, es sei ein Artikelcode; das Foto widerlegt sie. Die Zusage sagt jetzt, was gilt.

### 2026-09-09 · „4311" verliert — und die Prüfstand-Zeile war irreführend

Der Lauf um 11:45 zeigt die Wirkung: erster Treffer nach **5,5 s**, die Charge `*202511182 06/17/26`
wird als solche abgewiesen, beide Fehllesungen namentlich benannt, und auf **jeder** Etikette nimmt
die App das Richtige — bis auf eine.

Bei 78–80 s lagen auf EINER Etikette:

```
4311          QR,          57× gelesen   ← kennt niemand
801036963840  Data-Matrix, 11× gelesen
```

Beide 2D, keiner eine gültige GTIN — also entschied allein die Trefferzahl, und die unerklärte
`4311` gewann. Die **kürzeste Artikelnummer** dieser Welt ist eine EAN-8, und die erfüllt eine
Prüfziffer, wäre also ohnehin eine Klasse höher. Eine reine Zahl mit weniger als acht Stellen ist
deshalb keine Artikelnummer, sondern eine Haus-, Regal- oder Lieferantenkennung: Sie fällt eine
Klasse zurück. Allein gelesen wird sie weiterhin genommen — sonst ginge auf so einer Etikette gar
nichts.

**Und ein Fehler in meiner eigenen Zeile von vorhin.** „→ Die App würde nehmen: X" rechnete über den
GANZEN Lauf. Der echte Scanner hört aber beim ersten bestätigten Treffer auf; er sieht nie alle 33
Codes eines dreiminütigen Rundgangs. Die Zeile beantwortete damit eine Frage, die niemand hat — und
las sich, als nähme die App immer nur diesen einen. Jetzt wird **innerhalb jeder Gruppe
gleichzeitig gelesener Codes** markiert, und nur dort, wo es überhaupt eine Wahl gab.

### 2026-09-09 · Kein Personenname in der Oberfläche

Alex zu meiner Chargen-Meldung („sag Alex Bescheid"): *„ist nicht richtig, da die app ja frei ab git
liegt. Somit eher, sag deinem admin bescheid."*

Er hat recht, und es traf mehr Stellen, als er genannt hatte — gesucht statt nur die zwei
genannten geändert:

```
app-8-comm-init.js  „…und Alex sagen, wie es lief"                → dem Admin
app-8-comm-init.js  „sag Alex Bescheid"                           → sag deinem Admin Bescheid
scanner-probe.html  „Ergebnis kopieren — dann an Alex schicken"   → an den Admin
scanner-probe.js    „Jetzt in eine Nachricht an Alex einfügen"    → an den Admin
```

Geprüft am **gerenderten** Text, nicht am Quelltext — inklusive des Chargen-Dialogs, der dafür
wirklich ausgelöst wurde. Quelltext-**Kommentare** behalten den Namen: Dort ist er Herkunftsangabe
(„im Lager gemessen, Alex, 09.09.2026") und erklärt, warum eine Regel so aussieht, wie sie aussieht.

`tests/scanner-formular-ui.js` hält das jetzt fest: Der sichtbare Text der Bestellseite darf keinen
Personennamen enthalten. Gegenprobe mit dem alten Wortlaut: fällt. Die Lehre gehört zur
Grundausstattung dieses Projekts — die App liegt öffentlich und läuft auch in anderen Betrieben,
und dort gibt es weder einen Alex noch dieselbe Firma. Siehe [[project_repo_public]].

### 2026-09-09 · Charge statt Artikel

Aus demselben Lauf: `*202511182 06/17/26` — Data-Matrix, **18×** gelesen, also grundsolide erkannt
und trotzdem das Falsche. Chargennummer plus Verfallsdatum, bei jeder Lieferung anders. Als Barcode
gespeichert wäre jede neue Charge ein „unbekanntes Produkt" — dieselbe Katalog-Verschmutzung, gegen
die schon die GS1-Zerlegung gebaut wurde.

Gefragt, ob Artikelnummern Schrägstriche tragen. Alex: *„ohne mir sicher zu sein, würde ich ein /
in einer Artikelnummer bezweifeln."* **„Bezweifeln" ist nicht „ausschliessen"** — die Regel ist
deshalb so eng wie möglich gefasst: Abgelehnt wird nur ein **Datum aus drei durch Schrägstrich
getrennten Zahlengruppen**. Gemessen:

```
*202511182 06/17/26  → abgelehnt (Charge)      AEH-25-100   → Artikelcode
1/1/26               → abgelehnt (Charge)      LOT/2026     → Artikelcode
                                               4051/22      → Artikelcode
```

Werbe- und Chargencodes laufen jetzt durch **eine** Funktion (`scannerNichtUebernehmen`), die den
Grund zurückgibt. Der Grund entscheidet über die Rangfolge *und* über den Text, der dem Benutzer
gezeigt wird — sonst laufen die beiden auseinander, und wer scannt, sieht nichts passieren und
scannt noch dreimal. Die Chargen-Meldung schliesst mit *„Sollte das doch eine gültige Artikelnummer
sein, sag Alex Bescheid"*: Die Regel beruht auf einer Vermutung, und das soll sie auch zugeben.

### 2026-09-09 · Erster Lauf mit Zielrahmen — und eine umgekehrte Entscheidung

39 Codes, 1774 Bilder. **Erster Treffer nach 6,5 s** statt 13–17 s, 6,5 Bilder/s statt 5,8 — der
Zuschnitt kostet nichts, er hilft. Werbe-QRs (`lappkabel.de/cpr` 13×, `digitus.info` 11×) sauber
abgewiesen, Hersteller-QRs (`qr.fischer.id/p/551442`) behalten, `054444116155` als Fehllesung von
`4054433116155` benannt.

**Der Fund:** Auf DERSELBEN Etikette standen

```
4003899947209                          EAN-13, 49× gelesen
https://www.eltropa.de/produkt/2811369 QR,     21× gelesen
```

Mit dem festen 2D-Bonus (+1000) gewann die **Händler-Adresse**. Sie bezeichnet den Artikel zwar
auch — aber die GTIN ist die Nummer, die *jeder* kennt: der Hersteller, der zweite Händler, das
nächste System. Deshalb jetzt eine **Rangfolge in Klassen**, innerhalb der Klasse entscheidet die
Trefferzahl:

```
3  gültige GTIN     2  2D-Code     1  sonstige     0  Werbecode
```

Das **kehrt eine frühere Entscheidung um**. „2D schlägt 1D immer" war damit begründet, dass eine EAN
*zufällig daneben* im Bild liegen könne (Valentins Lauf). Mit dem Zielrahmen liegt nichts mehr
zufällig daneben — die Begründung ist entfallen, also fällt auch die Regel. Ein QR als einzige
Angabe gewinnt weiterhin.

Nebenbei löst das den `4311`-Fall: Der unerklärte QR verliert jetzt gegen jede Artikelnummer auf
derselben Etikette, auch mit doppelt so vielen Lesungen.

**Ein selbst geschriebener Test fiel dabei** — „die Trefferzahl bleibt ausschlaggebend", vom selben
Vormittag. Statt die Erwartung umzudrehen, erst geprüft, ob sein Fall real ist: Er paarte eine
Fehllesung mit einem oft gelesenen Code von einer **anderen** Etikette. Ein Decoder meldet `ean_13`
aber nur bei **gültiger Prüfziffer** — eine solche Fehllesung setzt also eine echte EAN auf
derselben Etikette voraus, und die wird zuverlässig öfter gelesen. In Alex' Daten gilt das
ausnahmslos für **alle acht** Fehllesungen mit gültiger Prüfziffer. Die Zusage prüft jetzt das, was
wirklich trägt: Unter zwei Artikelnummern gewinnt die öfter gelesene.

Der Prüfstand zeigt neuerdings auch **„→ Die App würde nehmen: …"**. Er listet alle Treffer, die App
nimmt genau einen — ohne diese Zeile liest man eine Liste und weiß nicht, was am Ende im
Bestellformular stünde.

**Noch offen:** `*202511182 06/17/26` (Data-Matrix, 18×) ist eine Charge mit Verfallsdatum, keine
Artikelnummer — pro Charge verschieden. Und `4311` bleibt unerklärt; neu ist nur, dass er *im
Rahmen* lag, also auf einer Etikette klebt und nicht irgendwo im Fahrzeug.

### 2026-09-09 · Ein Test, der sich selbst vergiftet hatte

Nach dem Ausschnitt-Umbau meldete die Suite `browser-smoke` rot — „Aufräumen: BT-Shared gelöscht".
Naheliegend wäre gewesen, das der frischen Änderung zuzuschreiben. Der Test lief aber auch auf dem
Stand, auf dem die Suite eine Stunde vorher **grün** gemeldet hatte (geprüft in einem eigenen
`git worktree`). Also keine Regression.

Die Ursache: **`browser-smoke` startet als einziger Test keinen eigenen Server**, sondern arbeitet
gegen den dauerhaft laufenden auf `localhost:3000` — mit **bleibender** Datenbank. Ich hatte kurz
zuvor eine Suite abgebrochen; ein abgebrochener Lauf kommt nie zum Aufräumen und lässt seinen
Ordner stehen. Der nächste Lauf legt einen eigenen an, löscht beim Aufräumen aber den **zuerst
gefundenen** — also den alten — und lässt wieder einen zurück. Die Zahl bleibt bei eins, und der
Test fällt von da an **für immer**, ohne dass sich am Programm etwas geändert hätte.

Bestätigt durch Messung statt Vermutung: Ordnerliste des Dev-Servers abgefragt (genau ein
`BT-Shared`, angelegt 10:48 vom letzten Lauf), Rest entfernt, Test wieder 42/42.

Der Test räumt jetzt **zu Beginn** seine eigenen Reste weg. Gegenprobe: Rest künstlich angelegt →
„(Rest eines früheren Laufs entfernt: BT-Shared)", danach grün.

Die Lehre ist grösser als der Fall: Ein Test auf gemeinsamem, bleibendem Zustand meldet früher oder
später etwas, das mit der Änderung nichts zu tun hat — und kostet genau dann Zeit, wenn man sie
nicht hat. Siehe [[reference_messfallen_browser]].

### 2026-09-09 · Der Rahmen hört auf zu lügen

Alex: „Das Scanner Feld einzuschränken wäre auf jeden Fall eine gute Idee. Dann aber bitte auch
optisch sichtbar, so dass man sieht wo man hinzielen muss." Anlass war `4311` — ein QR, den niemand
zuordnen konnte, 16- bzw. 18-mal gelesen, und als 2D-Code hätte er jeden Strichcode geschlagen.

Den grünen Rahmen gab es schon — als **Dekoration**. Gelesen wurde das ganze Bild. Ein Rahmen, der
etwas anderes verspricht als das Programm tut, ist schlimmer als kein Rahmen.

**Die eigentliche Arbeit steckt in der Geometrie.** Das Video wird mit `object-fit: cover`
angezeigt: Es wird vergrössert, bis die Box gefüllt ist, und links/rechts oder oben/unten fällt
etwas weg. Wer die Prozentwerte des Rahmens einfach auf `videoWidth`/`videoHeight` anwendet, liest
den falschen Bereich — **und merkt es nicht**, weil trotzdem Codes gefunden werden.
`scannerAusschnittRechteck` rechnet deshalb über Maßstab und Versatz; nachgerechnet für ein
1080×1920-Bild in einer 380×500-Box: Maßstab 0,352, Versatz oben 87,8 px, Ausschnitt 907×369.

**Zwei Decoder, ein Bild.** Der native `BarcodeDetector` bekommt jetzt das Canvas statt des Videos.
Für den mitgelieferten Decoder gibt es kein `decodeFromCanvas` — dafür habe ich im Bündel
nachgesehen, wie ZXing selbst dekodiert:

```
createBinaryBitmap(t) { … t instanceof HTMLVideoElement ? drawFrameOnCanvas(t) : drawImageOnCanvas(t);
                        const r = getCaptureCanvas(t); const n = new b(r, e, …)   // b = HTMLCanvasElementLuminanceSource
decode(t)            { const e = this.createBinaryBitmap(t); return this.decodeBitmap(e) …
```

Also genau die Kette, die ich jetzt selbst aufbaue — nur mit meinem Ausschnitt. Nebeneffekt: ZXings
eigene Dauerschleife (`decodeFromVideoElementContinuously`) entfällt, und damit eine Fehlerquelle,
die schon einmal zugeschlagen hat (überlebende Schleifen zählten nach dem Stoppen weiter).

**Was hier nicht beweisbar ist:** dass ein ECHTER Barcode aus dem Ausschnitt gelesen wird. Das
Bündel enthält keine Encoder (`No encoder available for format 7`), es lässt sich also kein
Testcode erzeugen, und Chromes Kamera-Attrappe liefert nur ein Rollmuster. Ein selbst gemalter
Code-39 scheiterte an meiner Mustertabelle aus dem Gedächtnis — sie hatte vier breite Elemente
statt drei, und „3 of 9" heißt genau das nicht. Statt zu raten: Der Beweis am Regal bleibt der
Prüfstand.

**Geprüft ist stattdessen** (`tests/scanner-ausschnitt-ui.js`, mit Chromes Kamera-Attrappe und
einem mitschreibenden Ersatz-`BarcodeDetector`): die Umrechnung, dass der Ausschnitt wirklich
abschneidet (mit Farben statt Barcodes), dass die ZXing-Kette richtig verdrahtet ist (leeres Bild →
`NotFoundException`, kein `TypeError`), und der Kern: **der Decoder bekommt ein Canvas, dessen Maße
genau der Rahmen sind.** Gegenprobe mit `detect(v)` statt `detect(schnitt)`: fällt.

Ein Messfehler dabei war meiner: Ich zählte die Eckwinkel über `borderTopWidth || borderBottomWidth`
— und `"0px"` ist eine *wahre* Zeichenkette, also kam für die untere Ecke die falsche Kante heraus
und der Test meldete drei statt vier.

Der **Prüfstand** hat denselben Ausschnitt bekommen, dazu einen Schalter „nur im Rahmen lesen" zum
Vergleichen. Gemessen: mit Rahmen bekommt der Decoder ein Canvas 1613×223, ohne Rahmen das ganze
Video.

### 2026-09-09 · Crafter-Lauf und gestapelte Etiketten — eine Annahme widerlegt

Vier Treffer binnen 1,5 Sekunden im Fahrzeug:

```
4050821027874  ean_13  12×  bestätigt      das echte Etikett
050894027874   upc_a    5×  bestätigt      Fehllesung — kam DURCH die Schwelle
008970027874   upc_a    1×  verworfen
8050124027874  ean_13   5×  bestätigt      Fehllesung — kam ebenfalls durch
```

Alle vier enden auf `027874`. Damit ist meine Aussage von der Straßenlaterne — „drei Lesungen
trennen sauber" — **widerlegt**: Im Fahrzeug werden Fehllesungen stabil genug für fünf Treffer. Für
die App ändert das nichts (sie nimmt den EINEN besten Treffer, hier 12×), für den Prüfstand schon:
Er listet alle und suggerierte damit, drei Artikel gefunden zu haben.

Alex' Nachsatz — **„ich habe auch teilweise 3 Barcodes direkt übereinander"** — erklärt den
Mechanismus und entwertete zugleich meine erste Fassung der Erkennung. Bei gestapelten Symbolen
kann eine Abtastlinie zwei Codes kreuzen: linke Hälfte vom einen, rechte vom anderen. Deshalb das
gemeinsame Ende. Gemessen:

| | gemeinsamer Anfang | gemeinsames Ende |
|---|---|---|
| `4003899947247` / `4003899947209` — zwei **echte** Artikel | **11** | 0 |
| `4050821027874` / `050894027874` — Fehllesung | 0 | **6** |

Meine erste Fassung prüfte **auch den Anfang** — und hätte damit genau die gestapelten
Geschwister-Codes eines Herstellers als Fehllesung beschuldigt, denn die werden im selben Moment
gelesen. Das Kriterium ist raus; es zählt nur noch das gemeinsame **Ende**. (Ausgeliefert war die
falsche Fassung rund zwanzig Minuten.)

**Folge für die App:** Auf einer Großhändler-Etikette stehen typisch Artikelnummer, Bestellnummer
und Charge. Im Crafter-Lauf lagen `2003145` (keine GTIN) und `4251786213047` (gültige GTIN) 225 ms
auseinander — mit **gleicher Trefferzahl**. Es war reiner Zufall, welche gewonnen hätte, und eine
Charge im Katalog wäre pro Packung verschieden gewesen: jede Packung ein neues „unbekanntes
Produkt". Eine inhaltlich gültige GTIN zählt jetzt **doppelt** — bewusst ein Faktor und kein fester
Bonus, damit die Trefferzahl ausschlaggebend bleibt und eine schwach gelesene (möglicherweise
falsch gelesene) GTIN keinen deutlich öfter gelesenen Code verdrängt.

**Offen:** `4311`, ein QR mit 18 bzw. 16 Lesungen in beiden Läufen. Ein 2D-Code schlägt bislang
jeden Strichcode. Hängt dieser Aufkleber im Fahrzeug oder am Regal, gewinnt er gegen den EAN des
Produkts. Wartet auf Alex' Auskunft, was das ist.

### 2026-09-09 · Lager-Rundgang: zwei stille Doppel-Quellen

39 Codes in vier Minuten, echte Ware. Der Lauf bestätigt die Drei-Lesungen-Schwelle eindrucksvoll
und fördert zwei Fehler zutage, die beide **keinen Fehler ausgelöst**, sondern nur den Katalog
verschmutzt hätten.

**1. Zusammengesetzte Data-Matrix.** Auf derselben Packung standen jeweils beide:

```
4043377228871,22SL22118P0205002,100   Data-Matrix, 7× gelesen
4043377228871                          EAN-13 daneben, 8× gelesen
4043377079275,21010589,50              Data-Matrix, 3×
4043377079275                          Code-128 daneben, 5×
```

Vorn die Artikelnummer, dahinter Charge und Menge — pro Packung verschieden. Ungelöst wären das
**zwei Einträge für denselben Artikel**, je nachdem, welches Etikett man erwischt. Die
Normalisierung nimmt jetzt das erste Feld, aber **nur wenn dessen Prüfziffer stimmt**. Ein
Lageretikett wie `A2026052700123,charge7` bleibt damit unangetastet, und `1234567890123,x` (13
Ziffern, falsche Prüfziffer) auch.

**2. Werbe-QRs.** `https://bauer-solar.de/solarmodule/` (13×) und
`https://www.latrivenetacavi.com/download/environment_label.pdf` (9×). Solche Codes kleben auf
*allen* Produkten eines Herstellers — gespeichert zeigten zwei verschiedene Artikel auf denselben
Eintrag, und der zweite bekäme „gehört bereits zu …", ohne dass jemand versteht, warum.

Mein erster Entwurf war **zu grob**: „jede http-Adresse ist Werbung". Das hätte Valentins Befund vom
Vortag zerstört — `https://id.abb/2CKA006800A3087` und `https://qr.fischer.id/p/568010` *bezeichnen*
Artikel. Der Bestandstest „ein QR schlägt eine EAN daneben im Bild" fiel prompt. Der Unterschied
steckt im letzten Pfadstück: Eine Artikelnummer enthält Ziffern, ein Seitenname nicht. Eine
Faustregel, bewusst vorsichtig: **im Zweifel Artikelcode**, denn ein zu Unrecht abgewiesener Code
hält jemanden im Lager auf, ein zu Unrecht gespeicherter macht nur Aufräumarbeit.

Dazu zwei Feinheiten: Der Werbe-QR verliert den 2D-Bonus (sonst schlüge die Herstelleradresse mit
13 Lesungen den echten Strichcode mit 5), wird aber weiterhin **zurückgegeben** — die Auswahl
beginnt jetzt bei `-Infinity` statt `-1`. Zurückgeben und erklären („Das ist ein Werbe- oder
Infocode, keine Artikelnummer") ist besser als „nichts erkannt". Und `scannerIstWerbecode`
normalisiert selbst, damit die Antwort nicht davon abhängt, in welcher Reihenfolge man die beiden
Funktionen aufruft.

**Was der Lauf NICHT zeigte, obwohl es so aussah:** Vier achtstellige ITF-Codes binnen 1,3 Sekunden
(`16008366`, `00620061`, `11100466`, `00640061`) — ein Etikett, viermal verschieden gelesen, wie es
für ITF ohne Prüfziffer typisch ist. Der Prüfstand auf dem Server meldete sie als „bestätigt", weil
er **älter ist als die ITF-14-Regel**. Der aktuelle Code verwirft sie alle. Der Prüfstand wurde
angeglichen — ein Messgerät, das anders urteilt als die App, ist schlechter als keines.

### 2026-09-09 · Katalog-Spiegel — und zwei Tests, die nichts gemessen haben

Alex: „baue so lang doch schon einmal den offline Spiegel."

Der Katalog liegt jetzt in `localStorage` (`arbeitsdoku.katalog.v1`), wird sofort benutzt und
daneben aufgefrischt; nach vier Sekunden ohne Antwort läuft es mit der Kopie weiter. Der `stand`
kommt vom **Server**, nicht vom Gerät — Handyuhren gehen falsch.

**Was der Spiegel bewusst NICHT kann**, und was deshalb auch nicht behauptet wird: Absenden und
Anlegen brauchen den Server. Ein unbekannter Code ohne Verbindung bekommt darum keine
Anlegen-Maske, die beim Speichern scheitert, sondern eine Auskunft mit dem Code zum Notieren. Eine
Antwort des Servers wird nie vom Spiegel überschrieben (er weiß nichts von gelöschten Produkten).

**Der Fund, ohne den der Spiegel wertlos gewesen wäre:** `renderOrders` hatte im Fehlerfall ein
`return`. Ohne Verbindung wäre also gar nichts erschienen — weder der gespiegelte Katalog noch der
Hinweis darauf. Genau der Fall, für den gebaut wurde, war der einzige, in dem man nichts davon
gesehen hätte. Jetzt steht die Seite, und die Liste fehlt eben mit einem Satz dazu.

**Drei Anläufe, bis der Test wirklich etwas gemessen hat** — jeder war vorher grün:

1. `page.setRequestInterception` schneidet mit einem **aktiven Service Worker** nichts ab; die
   Anfragen laufen über dessen Ziel, nicht über das der Seite. Der Test hat also fröhlich eine
   voll funktionierende Online-App geprüft. → `page.setOfflineMode()`.
2. `goto()` auf **dieselbe** Adresse mit gleichem Hash lädt gar nichts neu. Nach dem Umschalten auf
   offline stand weiterhin die online gerenderte Seite da. → `reload()`. Dieselbe Falle wie bei den
   Auszahlungs-Tests; sie schnappt zuverlässig wieder zu.
3. Dasselbe noch einmal beim Zurückschalten auf online.

Gegenprobe zum Schluss: `katalogSpiegelLesen()` stillgelegt → Live-Suche, Kategorienliste und
Barcode-Nachschlag fallen offline aus. Siehe [[reference_messfallen_browser]].

### 2026-09-09 · Verzeichnis-Pflege und Großhändler

Alex: „Ich würde gerne (Groß)händler hinzufügen können und dann die Möglichkeit haben, jedem
Produkt einen Link, Kommentar und/oder Bestellnummer für jeden Großhändler hinzuzufügen."

Entschieden (Alex): **keine** automatische Zuordnung frei getippter Bestellungen (Namen zu raten
hängt still die falsche Bestellnummer an), **alle vier** Felder am Händler selbst, **kein**
Hauptlieferant — alphabetisch.

**Die Falle, für die `tests/produktpflege.js` überhaupt existiert.** `product_suppliers` hat ein
`UNIQUE(product_id, supplier_id)`. Führt man zwei Produkte zusammen, die **beide** bei Sonepar
liegen, kann die Zeile nicht einfach umgehängt werden. Der beiläufige Weg wäre
`UPDATE OR IGNORE …; DELETE FROM … WHERE product_id = <quelle>` — und der verschluckt eine der
beiden Bestellnummern **still**. Die Gegenprobe mit genau dieser Fassung ist aufschlussreich: „es
steht genau EIN Eintrag da" bleibt grün, „die eigene Bestellnummer ist unverändert" bleibt grün.
Nur die vier Zusagen, die gezielt nach der **zweiten** Nummer suchen, fallen. Eine Prüfung, die
lediglich „ging durch" misst, hätte den Verlust durchgewinkt — bemerkt hätte ihn Monate später
jemand beim Bestellen.

Deshalb: Was das Ziel noch nicht hat, wandert. Was es schon hat, wird an dessen Kommentar
angehängt, gekennzeichnet mit der Herkunft, und in Antwort wie Protokoll gezählt.

**Zwei Fehler in meinem eigenen Code, die der Test gefunden hat:**

* Die Dublettenwarnung beim Umbenennen hing an `vergleichsform(neu) !== vergleichsform(alt)`. Genau
  beim Angleichen zweier Schreibweisen — „Kabelbinder 200 mm" → „kabel-binder 200mm" — ist die
  Vergleichsform **identisch**, die Warnung wäre also stumm geblieben, wenn man sie braucht.
  Verglichen wird jetzt zeichengenau.
* `linkpruefung.js` wies `shop.sonepar.de/123` ab. So tippt man Adressen; die Prüfung ergänzt
  jetzt `https://`. Ein `javascript:` trägt bereits ein Schema und fällt deshalb **nicht** in
  diesen Zweig — es bleibt abgewiesen, auch als `JaVaScRiPt:`.

**Im Bildschirmfoto gefunden, nicht im Test:** Auf 390 px brach die Bestellnummer im Ausklapper
mitten entzwei — „Best.-Nr. 99-" / „2231". Eine Nummer über zwei Zeilen liest man falsch ab, und
beim Bestellen fällt es niemandem auf. Jetzt `white-space: nowrap`; lieber rutscht der ganze Block
in die nächste Zeile.

Die Reiter der Ansicht borgen sich `.absence-tabs`, statt einen zweiten Reiter-Stil einzuführen.
`rel="noopener"` an jedem Händler-Link ist im Browser-Test festgeschrieben: Ohne das kann die
Zielseite über `window.opener` die App-Seite auf eine nachgebaute Anmeldemaske umleiten — der Knopf
funktioniert dabei, es fällt also nichts auf.

### 2026-09-08 · Recht „Lagerdaten pflegen" — und ein Test, der aus dem falschen Grund grün war

Alex: „Wer darf die Lagerdaten bearbeiten? Das darf ja momentan nur Chef und Admin. Auch hier würde
ich bei *Mitarbeiter → Bearbeiten* gerne noch ein Recht hinzufügen."

Gebaut nach dem Muster von `bestellrecht.js`, und zwar aus dem dort gelernten Grund: Beim
Bestellrecht stand dieselbe Regel an **fünf Stellen, drei davon falsch**. Eine hingeschriebene
Bedingung `role IN ('chef','admin')` sieht richtig aus und übersieht das Häkchen **still** — nichts
geht kaputt, es geht nur nicht. Deshalb wieder **ein** Modul (`produktrecht.js`) mit der Regel,
`routes/products.js` fragt nur noch dort. Es gehört in die `STAMMDATEIEN` von `deploy.sh`; fehlt es
auf dem Server, startet der Dienst nach dem nächsten Neustart gar nicht.

**Zwei Unterschiede zum Bestellrecht, beide bewusst:**

* **Der Buchhalter hat es *nicht* per Rolle.** Beim Bestellen zählt er mit, weil er die Rechnungen
  bekommt; mit dem Lagerverzeichnis hat er nichts zu tun. Die Rollenliste ist deshalb eine eigene
  und wird *nicht* aus dem Bestellrecht übernommen.
* **Anlegen bleibt für jeden offen.** Das Recht regelt nur das *Pflegen*. Wer im Lager vor einem
  unbekannten Barcode steht und nichts eintragen kann, umgeht die App — dann ist der Katalog nach
  vier Wochen wertlos.

**Der eigentliche Fund kam aber vom neuen `tests/altdb-spalten.js`.** `middleware/auth.js` liest bei
*jeder* Anfrage eine feste Spaltenliste aus `users`. Fehlt eine davon nach dem Wiederherstellen
eines alten Backups, antwortet der Server auf alles mit `no such column` — auch dem Admin, ohne Weg
zurück ausser über die Konsole. Bisher hat **kein Test** diesen Pfad geschützt. Der neue liest die
Spaltenliste **aus dem Quelltext der Middleware**, statt sie abzuschreiben; damit wird er beim
nächsten neuen Recht nicht still veraltet.

Beim ersten Lauf war er grün — **und prüfte nichts**: Sein Muster traf die *erste* `SELECT … FROM
users WHERE id = ?` in `auth.js`, und das ist `SELECT username`. Eine Spalte, alle Zusagen erfüllt.
Jetzt nimmt er die **längste** Abfrage und wirft, wenn sie unter fünf Spalten fällt. Dasselbe Muster
wie in [[reference_tests_zeitfallen]]: Grün allein beweist nichts, die Gegenprobe ist Pflicht.

Gegenproben, alle drei greifen: Einzelrecht totgelegt → zwei Zusagen fallen. Buchhalter in die
Rollenliste geschmuggelt → zwei fallen. `addCol` im Restore-Pfad entfernt → alle vier fallen.

### 2026-09-06 · Eine Zeitzone im ganzen Servercode

Alex' Frage nach dem Deploy: „Nicht dass noch irgendwo Zeiten um (mehrere) Stunde(n) auseinander
laufen." Anlass war der Zeitzonen-Fehler beim Auszahlungs-Zähler — die Frage war, ob es weitere
gibt.

**Die Lage ist zweigeteilt, und das ist in Ordnung**, solange nicht über die Grenze hinweg
verglichen wird:

| Quelle | Zone | wo |
|---|---|---|
| `strftime('now')` in SQL | **UTC** | Aushang, Notizen, Abwesenheiten, `user_seen` |
| `berlinJetzt()` in JS | **Ortszeit** | Protokoll, Ausstellen, Auszahlung, Werkzeuge |

Gefährlich sind genau drei Dinge, und danach wurde gesucht:

**1. „Heute" aus `toISOString()`.** Das ist das UTC-Datum — zwischen Mitternacht und zwei Uhr
(Sommerzeit) liefert es den **Vortag**. Zwei Fundstellen, beide echte Fehler:

* `routes/bulletin.js` löschte abgelaufene Aushänge mit `auto_delete_date < heute(UTC)` — ein
  abgelaufener Aushang blieb bis zu zwei Stunden zu lange stehen.
* `routes/absence-days.js` bestimmte den Stichtag des Urlaubskontos so. Am 1. Januar früh wäre
  noch das **Vorjahr** gerechnet worden: falscher Anspruch, falscher Verfall-Stichtag.

**2. Ein Vergleich über die Zonengrenze.** Nur einer, und der war am Vortag schon repariert
(`getSeenAtBerlin`). Die übrigen Zähler wurden einzeln nachgesehen: alle UTC gegen UTC. Auch die
eine Stelle, die `absences` in Ortszeit schreibt, ist harmlos — sie setzt `deleted_at`, und das
wird nur auf `IS NULL` geprüft, nie verglichen.

**3. Die Zeitzone des Prozesses.** `toLocaleDateString('sv-SE')` ohne Angabe nimmt sie. Der
Produktivserver steht auf `Europe/Berlin`, deshalb war nichts kaputt — aber das ist eine
unausgesprochene Abhängigkeit von der Serverkonfiguration, und auf einem Server, der wie üblich
auf UTC steht, verschöbe sich alles lautlos. `server.js` legt `TZ` jetzt fest, sofern nichts
vorgegeben ist. Auf dem heutigen Server ändert das nichts.

**Die Rechnung gibt es jetzt einmal** (`zeit.js`), vorher lag sie in siebzehn Fassungen herum. Der
Wächter `tests/zeitzonen.js` hält das fest — und hat sich sofort bewährt: Beim ersten Durchgang
fand er **vierzehn Stellen, die ich übersehen hatte**. Ein Test, der nur bestätigt, was man schon
weiß, hätte hier nichts gebracht.

**Gegengeprüft**, weil ein Umbau an so vielen Stellen leicht etwas verschiebt: jedes umgestellte
Format einzeln gegen das alte verglichen (alle zeichengleich), und die Nullprobe gegen die echten
Produktivdaten — Statistik, alle Überstundenstände und der Lohn-Export unverändert.

**Nebenbei:** `scripts/suite.sh` sperrt mit `flock`; die Sperrdatei bleibt nach einem Abbruch
liegen, die Sperre selbst wird aber freigegeben. Wer auf die DATEI prüft statt auf die Sperre,
hält die Suite fälschlich für laufend — mir genau so passiert.

---

### 2026-09-06 · Überstunden auszahlen — und was die Nullprobe wert ist

Der Anlass kam aus der vorigen Reparatur: Beim Ausstellen entscheidet sich, ob Überstunden
abgefeiert, stehen gelassen oder ausgezahlt werden — nur konnte die App den dritten Weg gar nicht,
und die Frage wurde nirgends gestellt.

**Eigene Tabelle, nicht `payroll_adjustments` erweitern.** Dort ist `closure_id NOT NULL`, und das
loszuwerden verlangt in SQLite einen Tabellen-Neubau auf Lohndaten. Wichtiger als die Technik ist
aber die Bedeutung: Ein Nachtrag heißt „hier fehlten Stunden", eine Auszahlung heißt „diese Stunden
sind mit Geld abgegolten". In derselben Spalte könnte das Lohnbüro sie nicht auseinanderhalten.

**Die Nullprobe, und warum sie allein nichts beweist.** Der gefährlichste Fehler war nicht ein
kaputter neuer Knopf, sondern ein stillschweigend verschobener alter Überstundenstand — etwas, das
ein Test der neuen Funktion nie sieht. Dafür entstand `tests/user-hours-nullprobe.js`: zwei Server
auf je einer Kopie derselben Produktivdaten, Vergleich über alle Nutzer, Monate und Jahre plus den
Lohn-Export zeichenweise.

Sie war sofort grün — und genau das war der Punkt, an dem man aufhören könnte und nichts wüsste:
Genauso grün wäre sie, wenn der neue Summand schlicht nichts täte. Zwei Gegenproben:

* Ein künstliches `- 0.01` in der Formel ließ alle drei Zusicherungen fallen. Das Werkzeug misst.
* Eine echte Auszahlung über 40 Stunden senkte den Stand von −1634,25 auf −1674,25, exakt 40; eine
  **offene** Anfrage über 25 Stunden bewegte nichts; vor dem `wirksam_ab` war der Stand identisch.

Erst beides zusammen ist ein Beweis. Dieselbe Doppelrichtung gibt es schon in
`tests/stunden-vorher-nachher.js` — der beweist, dass sich eine Zahl **ändert** (die korrigierte
Projektfilter-Rechnung). Verwechselt man die Richtungen, beweist der Test das Gegenteil von dem,
was man glaubt.

**Als der Lohn-Export dann doch abwich**, war das richtig: zwei neue Spalten. Per Spaltenvergleich
geprüft, dass jeder andere Wert zeichengleich blieb — eine rote Nullprobe ist kein Grund, das
Werkzeug abzuschalten, sondern einer, den Unterschied zu erklären.

**Vier Messfehler in den eigenen Tests**, alle derselben Art — gemessen wurde etwas anderes als
behauptet:

| Behauptung | Was tatsächlich gemessen wurde |
|---|---|
| „vor dem `wirksam_ab` zählt sie nicht" | zwei verschiedene Stichtage — dazwischen läuft auch das **Soll** (26 statt 10) |
| „mehr Stunden als vorhanden" | `Stand + 500` wird negativ, wenn der Stand es ist → Abweisung aus ganz anderem Grund |
| „die Stunden bleiben stehen" (beim Ausstellen) | das Ausstellen beendet den Anstellungszeitraum, das **Soll** fällt weg |
| „der Unterschriftsweg steht im Verlauf" | `goto` auf **dieselbe** Adresse löst kein `hashchange` aus — die Seite baute sich nie neu auf |

Der letzte ist der lehrreichste: Er sah aus wie ein Fehler im Code und war ein Fehler im Messen.
Dahinter steckte aber eine echte Lücke — ohne SSE-Broadcast erschiene die Anfrage beim Mitarbeiter
erst beim nächsten Laden. Über eine Entscheidung, die seine Stunden betrifft, soll er nicht
zufällig stolpern.

**Zwei Funde erst aus den Screenshots.** „chef möchte dir …" stand mit dem Benutzernamen statt dem
Namen, und „12:00 Stunden" las sich wie eine Uhrzeit. Beides sieht kein Test, der auf Vorhandensein
prüft. Umgekehrt war der Verdacht, die Aktionen-Spalte laufe über, **falsch** — gemessen kein
Überlauf bei 1280 und 1024; schmaler scrollt die Tabelle in ihrem eigenen Bereich wie zuvor.

**Der Prod-Klon ist eine VORLAGE, keine rohe Kopie.** Für die Nullprobe holte ich eine frische
Kopie der Produktivdaten und legte sie über `/tmp/prodklon.db`. Danach fielen zwei Tests um, die
mit meiner Arbeit nichts zu tun hatten: `aussperren-prodklon` und `zweifaktor-klickweg-prodklon`.
Grund: Diese Tests melden sich mit dem Passwort `test` an — die Vorlage ist **aufbereitet**, und das
stand nirgends. Deshalb gibt es jetzt `scripts/prodklon-vorbereiten.js`.

Aufbereitet gehört zweierlei: die Passwörter **und** die Zwei-Faktor-Einträge. Seit auf Produktion
wirklich jemand einen Authenticator eingerichtet hat, bringt eine rohe Kopie einen echten Eintrag
mit; `POST /2fa/setup` liefert dann keinen Schlüssel mehr, und der Test stirbt an „Leerer
Base32-Schlüssel". Das sieht nach einem Fehler in der App aus und ist eine unpassende Vorlage.

Beim Suchen fiel nebenbei auf: **sechs Tests starten einen Server direkt auf `/tmp/prodklon.db`**
(`ux-runde1-`, `longpress-`, `entwurf-`, `listen-suche-`, `barrierefrei-`, `scroll-ruckeln-prodklon`).
Sie nennen sich im Kopfkommentar „nur lesend", aber ein laufender Server schreibt durch den
Autosave-Takt zurück — die Datei wächst und sammelt Zustand aus früheren Läufen. Für eine Kopie in
`/tmp` ist das ungefährlich, für eine *Vorlage* nicht: Genau so hatte ein früherer Lauf schon einen
Authenticator hinterlassen. Wer die Vorlage neu braucht, baut sie mit dem Skript neu.

**Die Rückmeldung an den Chef — und zwei Fehler dabei.** Der Ablehnungs-Test förderte zutage, dass
der Chef von der Entscheidung nie erfuhr. Der Zähler am Menüpunkt *Mitarbeiter* schließt das; die
Meldung in der Liste verschwindet nach einmaligem Ansehen, der Verlauf darunter bleibt.

Zwei Dinge gingen dabei schief, und beide waren nur durch Messen zu finden:

*Zeitzonen.* `user_seen.seen_at` entsteht mit SQLites `strftime('now')` — also **UTC**.
`overtime_payouts.entschieden_am` kommt aus `berlinNow()` — also **Ortszeit**. Im Sommer lag
„gesehen" damit zwei Stunden hinter der Entscheidung, und die Meldung wäre trotz Ansehen noch zwei
Stunden stehen geblieben. Die anderen Zähler sind davon nicht betroffen: Sie vergleichen gegen
Felder, die ebenfalls per `strftime('now')` gesetzt werden (bulletin, notes). Behoben mit
`getSeenAtBerlin()`, das über den echten Zeitstempel umrechnet — ein festes „+2 Stunden" wäre im
Winter falsch.

*Ein flatterhafter Test.* Danach fiel der Browser-Test mal durch, mal nicht. Ursache war die
SSE-Zeile, die ich selbst eingebaut hatte: Trifft die Ablehnung ein, während der Chef auf der Liste
steht, baut sich die Seite neu auf — und meldete „gesehen", obwohl niemand hingesehen haben muss;
das Fenster kann im Hintergrund stehen. Seitdem meldet nur der Aufruf der Seite „gesehen", nicht
der Live-Neuaufbau (`renderUsers(ausSse)`). Dreimal hintereinander grün gegengeprüft — ein Test,
der mal so und mal so ausgeht, ist schlimmer als einer, der immer rot ist.

**Der heikle Reihenfolgefall:** angelegt, während der Monat offen war, bestätigt, nachdem er
abgeschlossen wurde. Erwartet und geprüft ist dieselbe Semantik wie beim Nachtrag — der eingefrorene
Monat behält seine Zahlen, der laufende Stand sinkt. Der Test dafür musste zweimal umgebaut werden:
Der laufende Monat lässt sich zu Recht nicht abschließen, und wer heute angelegt wird, hat im
Vormonat gar keine eingefrorene Zeile, gegen die man prüfen könnte.

---

### 2026-08-26 · „Ich kann nicht mehr weiter nach unten scrollen"

Alex' Meldung vom eigenen Handy. Gemessen bei 393×830: 317 px für den Tagesverlauf, die Seite
selbst unbeweglich. Der Verlauf scrollte in sich — wer auf Kennzahlen oder Filtern wischte, bewegte
gar nichts.

**Die Absicht stand schon im Code:** `_FLAECHE_MIN = 260  // darunter wird die Fläche unbrauchbar →
dann lieber die Seite scrollen`. Die Schwelle griff nur nie, weil 317 knapp darüber lag — und 317 px
sind praktisch genauso unbrauchbar wie 260. Schwelle auf 440, und darunter bekommt die Fläche gar
keine Begrenzung mehr.

**Das allein wäre eine Verschlechterung gewesen.** Das Raster zeichnete immer 00:00–24:00 (1200 px)
und sprang danach auf 6:00. Ohne Begrenzung wäre man oben in sechs Stunden Leere gelandet. Deshalb
zeichnet es jetzt nur noch die Stunden des Tages — eine davor, eine danach, mindestens acht. Damit
ist auch das Scrollen auf 6:00 ersatzlos entfallen: Es gibt nichts mehr zu überspringen.

**Fast eine Regression eingebaut.** `passeScrollflaechenAn()` gilt für ALLE Scrollflächen, also auch
für die Zeitleiste der **Planung** — und die zeichnet weiterhin 00:00–24:00 und springt danach auf
6:00. Ohne Begrenzung liefe dieser Sprung ins Leere und man landete morgens um Mitternacht.
Aufgefallen ist es an `tests/platznutzung-ui.js` vom 07.08., der zwei Zusicherungen dazu enthält.
Die Fläche darf jetzt nur wachsen, wo sie es ausdrücklich erlaubt (`data-frei`) — das ist genau die
Fläche, deren Inhalt zugeschnitten ist. Danach lief der alte Test **unverändert** durch: kein
Aufweichen einer bestehenden Zusicherung.

**Nachtrag am 27.08.:** Zwei Korrekturen an der eigenen Regel. Erstens leitete sie den Rasteranfang
aus dem ERSTEN EINTRAG ab — dadurch wanderte er täglich, und Alex kam „nicht mehr auf vor 6:00
Uhr". Anker ist jetzt die Firmenvorgabe (Arbeitsbeginn − 1 Std bis regulärer Feierabend + 1 Std);
wer früher beginnt oder später aufhört, zieht das Raster auf. Ohne dieses Aufziehen bekäme ein
Eintrag ab 04:00 `top: -100` — er läge über dem Raster und wäre schlicht unsichtbar. Zweitens
bekam die **Planung** dieselbe Behandlung, auf Alex' Wunsch vor dem Deploy: dort war es dieselbe
Falle, nur mit 588 px Wischfläche ab Mitternacht.

Bemerkenswert an dem Fall: Der Ärger kam von einer Zahl, die jemand (ich, drei Wochen früher)
bewusst gesetzt hatte — mit dem richtigen Gedanken und einem zu niedrigen Wert. Erst ein echtes
Gerät in echter Hand zeigte es.

**Und dabei fast verloren gegangen.** Der Planungs-Umbau war einmal geschrieben und dann weg: Ich
hatte die Gegenprobe (Sabotage einbauen, Test umfallen sehen, `git checkout --`) und den Commit in
denselben Befehl gepackt. Das Zurücksetzen lief vor dem Commit. Übrig blieb ein Commit, dessen
Nachricht die Änderung beschreibt, während die Datei nicht einmal in seiner Dateiliste steht.
Gefunden hat es allein der Testlauf danach: `handy-verlauf-ui` meldete für die Planung wieder
00:00–24:00 und `scrollTop 280`. Die Lehre steht jetzt als harte Regel fest — `git checkout --`
und `git commit` nie im selben Befehl, und nach jedem Commit mit `git show --stat` prüfen, dass
die Datei wirklich drin ist.

### 2026-09-05 · Ausstellen sperrte sofort, egal wann der letzte Arbeitstag war

Alex beim Planen der Überstunden-Auszahlung: „wenn der chef heute sagt, dass MA am 30.9 ausgestellt
wird, hat der MA ab heute keinen zugriff mehr. Was ja nicht richtig ist."

Stimmte. `POST /:id/deactivate` setzte `active = 0` **unbedingt**, egal welches Austrittsdatum
danebenstand. Das Datum wanderte nur in `employment_periods.end_date` — und **das Soll lief bis
dahin weiter** (`isEmployedOn` zählt bis einschließlich Enddatum). Buchen konnte er nicht mehr.

**Die Zahl macht den Unterschied zwischen Ärgernis und Schaden:** 18 Arbeitstage mit Soll, aber
ohne Ist — rund 144 Stunden, die still vom Überstundenstand abgehen. Ausgerechnet in der Lage, in
der dieser Stand ausgezahlt wird. Getroffen hat es die Firma nie: Der einzige ausgestellte
Mitarbeiter wurde *rückwirkend* ausgestellt.

**Die Vormerkung brauchte kein neues Feld.** Sie ist die Kombination, die es vorher nicht geben
konnte: Konto aktiv **und** der jüngste Anstellungszeitraum hat schon ein Ende. Der Zeitplaner
vollzieht sie in der Nacht danach — mit `end_date < heute`, nicht `== gestern`: Lief der Server
über den Stichtag nicht, holt der nächste Start es nach. Ein Konto, das über seinen Austrittstag
hinaus offen bleibt, wäre ein echtes Sicherheitsproblem.

**Zwei Fehler, die ich selbst eingebaut und die Tests gefunden haben:**

Ich wählte die Schwelle `>= heute` mit der Begründung „wer heute seinen letzten Tag hat, arbeitet
heute noch". Zu weit gegriffen: Der Knopf *Ausstellen* schickt ohne Angabe das heutige Datum — damit
schloss der **Normalfall** das Konto nicht mehr, auch nicht bei einer fristlosen Trennung. Drei
bestehende Tests (`auth-active-guard`, `ausstellen-zweifaktor`, `trash-access`) waren rot, und zwar
zu Recht. Jetzt `> heute`: Nur ein Tag, der noch bevorsteht, wird vorgemerkt.

Und beim Gegenprüfen fiel auf, dass **„Meine Daten" die Anstellungszeiträume samt künftigem
Enddatum zeigt** — der Mitarbeiter hätte dort von seiner Kündigung gelesen. Geschlossen wird das
serverseitig, nicht in der Anzeige; die formale Datenauskunft bleibt vollständig.

**Und warum mein Test das Leck zuerst durchließ:** Er suchte nach „19.09.2026". Die Karte schreibt
`toLocaleDateString('de-DE')`, also **„19.9.2026" ohne führende Null**. Eine formatabhängige
Zusicherung ist keine. Jetzt wird in allen Schreibweisen gesucht **und** direkt an der Karte
geprüft, statt nur im Seitentext.

### 2026-08-31 · Der Abschluss sperrte Vorgänge, nicht Zahlen

Alex: „Was wenn jemand etwas in der Vergangenheit noch nicht akzeptiert oder quittiert hat und der
abschluss gemacht wurde? Dann verschwindet dieser Eintrag nie mehr aus dem Posteingang."

**Der Fall war längst da, nicht nur denkbar.** Abschluss bis 30.06.2026, und zwei Innung-Einträge
eines Mitarbeiters (26.–28.05. und 01.06.) warteten dauerhaft auf seine Quittierung.

**Die Frage, die niemand gestellt hatte:** Wovor schützt der Abschluss eigentlich? Vor verschobenen
**Zahlen** — nicht vor Vorgängen. Gezählt werden nur Abwesenheiten mit Status `active` oder
`approved` (`routes/absence-days.js`). Damit lässt sich jede Aktion sauber einsortieren:

| Aktion | ändert eine gezählte Zahl? | |
|---|---|---|
| quittieren (Chef wie MA, ohne Vorschlag) | nein — nur ein Kennzeichen | **erlaubt** |
| ablehnen eines **offenen** Antrags | nein — offen wie abgelehnt zählen nicht | **erlaubt** |
| genehmigen | ja — der Tag zählt plötzlich | gesperrt |
| ablehnen eines **gezählten** Eintrags | ja — Tage fielen weg | gesperrt |
| Terminvorschlag annehmen | ja — übernimmt Daten, setzt `approved` | gesperrt |

Zwei Zeilen in `routes/absences.js`. Bemerkenswert daran: Die Chef-Quittierung war **schon immer**
frei — sie prüft die Sperre gar nicht. Das war richtig, stand aber nirgends; jetzt steht es als
Kommentar dort, damit niemand die Sperre „nachrüstet" und das Problem wieder einbaut.

**Und ein Fund beim Bauen:** Alex' zweiter Vorschlag — der Abschluss soll sich weigern, solange
etwas offen ist — existiert bereits. Nur prüft `offeneAntraege` in `routes/closure.js`
ausschließlich `status = 'pending'`; **Quittierungen sieht sie nicht**. Genau das deckt sich mit den
echten Daten: null hängende Anträge, zwei hängende Quittierungen. Die Prüfung bleibt, wie sie ist —
Quittieren geht jetzt immer, also muss sie den Abschluss dafür nicht aufhalten.

**Der Test prüft beide Seiten.** Nur „was jetzt geht" zu prüfen wäre hier gefährlich: Eine Sperre,
die zu viel freigibt, verschiebt still bezahlte Stunden, und das fiele erst bei der Lohnabrechnung
auf. Deshalb steht neben jeder Freigabe die Gegenrichtung — und als Anker die **Lohn-CSV des
abgerechneten Monats**, die vor und nach allen erlaubten Aktionen zeichengleich sein muss. Die drei
Gegenproben treffen entsprechend beides: zu streng (alte pauschale Sperre) **und** zu locker (Sperre
ganz weg).

### 2026-08-28 · Abwesenheitskalender — und drei Fehler, die man nur durch Messen findet

Liste und Urlaubsübersicht beantworten „wer hat wie viel". Offen war „wer fehlt wann". Alex wollte
Monats- und Jahresansicht, alle Mitarbeiter auf einen Blick.

**Der Zuschnitt kam aus den Daten, nicht aus dem Geschmack.** Am 05.06.2026 waren acht von zwölf
gleichzeitig weg (5× Urlaub, 3× Freizeitausgleich). Ein klassisches Kalenderblatt müsste diese eine
Tageszelle mit acht Namen füllen — und endet bei „+5 weitere". Ausgerechnet die Tage, wegen derer
man die Ansicht baut, wären die unlesbaren. Eine Matrix (Zeile je Mitarbeiter, Spalte je Tag) hat
das Problem nicht: Jeder hat seine Zeile, und ein voller Tag ist eine senkrechte Wand.

Weitere Zahlen aus dem Prod-Klon, die die Arbeit klein hielten: 93 Abwesenheiten im ganzen Jahr
(kein Performance-Thema), `GET /api/absences` liefert Managern längst alles mit Namen (**keine neue
Route**), Feiertage haben `user_id NULL` (also Spalte, nicht Zeile), und der längste Zeitraum ist
47 Tage — er läuft über Monatsgrenzen, die Schnittkante braucht eine Markierung.

**Monat und Jahr sind dieselbe Funktion**, unterschieden nur durch Spaltenbreite und Kopfzeile.
Zwei Renderer wären zwei Fassungen derselben Regel — dieselbe Falle wie beim Bestellrecht zwei Tage
zuvor.

**Drei Fehler, die kein Blick auf den Bildschirm gezeigt hätte:**

1. **Die Namensspalte lag über den ersten vier Tagen.** Sie saß in Gitterspalte 1 statt in einer
   eigenen; im Juni verschwand ausgerechnet der 05. darunter — der Tag, der die ganze Ansicht
   rechtfertigt.
2. **Die Kurzschreibweise `background:` knipste die Schraffur aus.** Die Farbklassen stehen im Blatt
   nach `.abscal-bar--pending` und setzten `background-image` auf `none` zurück. Offene Anträge
   sahen aus wie genehmigte. Im Bild ist der Unterschied nicht zu bemerken; gesehen hat es der Test.
3. **In einem Grid gilt `z-index` auch ohne `position`.** Die Unterlage-Streifen (z-index 0) hoben
   sich damit über die Kopfzellen — Wochenenden und Feiertage verloren ihre Tageszahl. Gefunden hat
   es Alex am 04.06.

**Und ein Fehler in meiner Prüfmethode, der schlimmer war als die Fehler selbst.** Ich hatte Punkt 3
zuvor mit `elementFromPoint` „widerlegt" und gemeldet, nichts sei verdeckt. Die Streifen haben
`pointer-events: none` — das Werkzeug überspringt sie und meldet brav, was *darunter* liegt. Der
Beweis war wertlos, und ich hatte ihn als Beweis ausgegeben. Richtig geht es nur, indem man die
Streifen kurz anfassbar macht (dann stimmt die Antwort) oder die Zelle als Bild ausschneidet. Beides
steht jetzt im Test, mitsamt der Warnung.

Zusatz: Die Farben der Abwesenheitsarten lagen **dreifach** im Stylesheet; der Kalender wäre die
vierte Kopie geworden. Sie stehen jetzt einmal als CSS-Variablen.

**Nachtrag: eine Zusicherung, die nichts zusicherte.** Zum Sprung „Balken antippen → Liste" gehört,
dass zugeklappte Abschnitte aufgehen. Der Test prüfte „Eintrag sichtbar" — und blieb grün, als ich
das Aufdecken zur Gegenprobe abschaltete. Grund: Standardmäßig ist gar nichts zugeklappt, der
Eintrag war ohnehin sichtbar. Der Test klappt jetzt vorher alles zu **und** weist nach, dass es
wirklich etwas aufzudecken gab.

Dabei fiel ein echter Fehler auf: Ein Eintrag, der noch eine Aktion braucht, steht **zweimal** auf
der Seite — im Posteingang oben und in der Liste unten. Der Sprung nahm `querySelector`, also die
erste Kopie; die Karte in der Liste blieb zugeklappt und unmarkiert. Wer danach weiterlas, fand sie
dort nicht wieder. Jetzt werden alle Kopien aufgedeckt und hervorgehoben.

Und einer, den nur ein echtes Gerät gezeigt hätte: `attachLongPressTooltip` ruft sein zweites
Argument als **Funktion** auf (`htmlFor()`); ich übergab einen String. Am Rechner läuft alles über
`mouseenter` — der lange Druck wäre erst auf dem Handy auf die Nase gefallen.

### 2026-08-27 · Ein Helfer allein hilft nicht, wenn ihn keiner fragt

Alex, mit Bildschirmfoto vom Handy: Als **Mitarbeiter mit Bestellrecht** ist der „Bestellt"-Knopf
da, aber neben „Bestellungen" steht kein Zähler.

Das Merkwürdige: Beide Seiten waren schon richtig gebaut. `bestellrecht.js` hat `darfBestellen()`,
das Frontend hat sein Gegenstück in `app-1-core.js`, und `routes/badges.js` rechnet den Zähler
längst mit `can_order`. Nur die eine Zeile, die die Marke ins Menü schreibt
(`app-2-auth-layout.js`), fragte weiter `role === 'chef' || role === 'admin'`.

**Warum das so lange unsichtbar blieb:** `refreshBadges()` überspringt, was es nicht findet
(`if (!el) continue`). Die Marke wurde also nie gezeichnet und deshalb auch nie aktualisiert — kein
Fehler, keine leere Marke, einfach nichts. Gleichzeitig zählt `setAppBadge` die offenen
Bestellungen mit: Das App-Symbol zeigte eine Zahl, die im Menü nirgends auftauchte.

**Die Warnung stand längst im Code.** In `bestellrecht.js`, ganz oben: „Auch users.js, badges.js und
der Zeitplaner müssen dieselbe Frage stellen, und drei Fassungen derselben Regel driften
auseinander." Genau das ist passiert — der Helfer war da, der Aufrufer nicht. Einen gemeinsamen
Helfer zu schreiben genügt nicht; man muss auch jede Stelle finden, die die Frage anders stellt.
`grep` nach der harten Rollenprüfung findet sie in Sekunden, wenn man daran denkt.

**Und das README hatte recht behalten.** Dort stand seit dem Bau der Satz „Zähler und Push-Meldung
folgen dem Recht – sonst hätte man den Knopf, erführe aber nie, dass etwas zu bestellen ist."
Beschrieben war also das gewünschte Verhalten, gebaut nur die Hälfte davon. Am README war nichts
zu ändern.

**Nachtrag, noch am selben Tag.** Beim Suchen nach weiteren Abweichungen fiel auf, dass der
**Buchhalter** auf der Meldungsseite ausgenommen war, obwohl er bestellen darf — `routes/badges.js`
und `routes/orders.js` prüften beide `role IN ('chef','admin') OR can_order = 1`. Alex hat das
entschieden: „wer bestellen kann, muss auch coin und push bekommen!"

Damit gab es die Regel an **vier** Stellen in **drei** Fassungen. Sie steht jetzt zweimal, beide in
`bestellrecht.js` und aus derselben Rollenliste gebaut: `darfBestellen(user)` für einen Nutzer und
`SQL_BESTELLBERECHTIGT` für die Liste der Empfänger. Eine hingeschriebene Bedingung
`role IN ('chef','admin')` sieht richtig aus und übersieht den Buchhalter still — niemand merkt es,
weil nichts kaputtgeht, es kommt nur keine Meldung an.

Der Test prüft die beiden Fassungen deshalb **gegeneinander** statt jede für sich: Wen liefert das
SQL, wen die Funktion? Zwei ungleiche Listen fallen sofort auf, egal welche der beiden jemand
später anfasst.

**Und einen Tag später die fünfte.** Alex, wieder mit Bildschirmfoto: Als Mitarbeiter mit
Bestellrecht wählt er in der geplanten Zusammenfassung „Bestellungen" — und bekommt *„Mindestens
eine Kategorie erforderlich"*. Wählt er zusätzlich „Schwarzes Brett", wird gespeichert, und danach
steht dort nur das Brett.

`normalizeSchedule()` in `routes/push.js` bekam als zweiten Parameter nur die **Rolle**. Damit kann
die Frage gar nicht richtig beantwortet werden — `can_order` steht am Nutzer, nicht an der Rolle.
Die Kategorie wurde still weggefiltert, und *danach* schlug die Prüfung „mindestens eine Kategorie"
zu. Betroffen waren Rechteinhaber **und** der Buchhalter.

**Die eigentliche Lehre steckt aber im Test, nicht im Code.** `tests/bestellrecht.js` prüft seit
jeher gründlich, dass der Entzug des Rechts eine Zusammenfassung kürzt und eine leer gewordene
löscht. Nur legt er seine Zusammenfassungen per `INSERT` **direkt in der Tabelle** an — damit ist
`normalizeSchedule` nie beteiligt. Der Test war gründlich auf dem Rückweg und hatte den Hinweg nie
betreten. Jetzt geht ein Abschnitt über die API: allein, kombiniert, als Buchhalter, und nach dem
Entzug wieder gesperrt.

**Bilanz dieser Regel:** fünf Stellen, drei davon falsch, gefunden in drei Runden — zwei davon von
Alex am Gerät, nicht von mir am Code. Ein `grep` nach `can_order` findet die Fassungen, die das
Recht wenigstens erwähnen. Es findet nicht die, die stattdessen `role` prüfen — und genau die waren
alle drei Fehler. Wer nach so einer Regel sucht, muss nach dem **Ersatz** suchen, nicht nach dem
Original.

### 2026-08-26 · Gesetzesverstöße sichtbar machen — und was dabei still schiefgehen kann

Die App kannte ArbZG und JArbSchG längst. Sie prüfte nur an einer einzigen Stelle: als Warnzeile im
Eintragsformular, während jemand bucht. Wer später auf die Übersicht sah, sah davon nichts — ein
11-Stunden-Tag und ein 8-Stunden-Tag sahen gleich aus.

**Der Zuschnitt kam aus dem Befund, nicht aus dem Wunsch.** Die gesamte Gesetzeslogik steckte als
lokale Funktionen INNERHALB von `renderEntryForm()`: nicht exportiert, ein einziger Aufrufer, und
sie lieferte einen fertigen Satz. Um sie ein zweites Mal zu benutzen, musste sie heraus — und aus
dem Satz musste eine Auskunft werden, die man auswerten kann. Ein Verstoß ist jetzt ein Objekt mit
`art`, `ist`, `grenze`, `gesetz`. Nebeneffekt: Der Test befragt die Regel direkt, statt mit
Suchmustern auf Fließtext zu zielen.

**Die eigentliche Gefahr war nicht die Kryptografie der Regeln, sondern die Datenbeschaffung.** Für
die Ruhezeit braucht es den Vortag, für eine Wochengrenze die volle Kalenderwoche — im Monatsraster
ragt die erste und letzte KW über den Monatsrand. Also wird mehr geladen als angezeigt. Rutschen
diese Zusatztage in eine Summe, ist die Monatszahl zu hoch, sieht aber plausibel aus, und niemand
rechnet sie nach. Deshalb stand die Regressionsprüfung im Ablauf VOR dem ersten Warnzeichen, und
die Gegenprobe zeigte, was sonst passiert wäre: **43:30 statt 28:30**.

**Der Null-Dauer-Filter.** Im Bestand liegen 18 Einträge mit `07:00–07:00`. Für die Stundenrechnung
sind sie harmlos — sie zählen null. Die Ruhezeit fragt aber nicht „wie lange", sondern „wann ging es
los": Ein Platzhalter um 07:00 an einem Tag, an dem die Arbeit um 09:00 begann, verkürzt die
gerechnete Nachtruhe um zwei Stunden und erzeugt einen Verstoß, den es nicht gibt. Meine erste
Gegenprobe biss nicht, weil ich den Platzhalter an den *Vortag* gesetzt hatte — dort verlängert er
die Ruhezeit und fällt gar nicht auf. Erst am Tagesanfang zeigt sich die Falle.

**Die 48-Stunden-Woche ist kein Verbot.** § 3 ArbZG erlaubt 10 Stunden täglich, also mehr als 48 in
der Woche, solange über 24 Wochen ausgeglichen wird. Ein Zeichen, das „Verstoß" behauptet, wäre
falsch — und zwar plausibel falsch, also unauffällig. Sie ist deshalb als Hinweis gekennzeichnet
(`hinweis: true`), leiser dargestellt und anders formuliert. Ich hatte Alex die Grenze zuerst als
harte verkauft und das korrigiert, bevor er entschied.

**Rahmen als innerer Schatten, nicht als Randlinie.** Eine Randlinie macht die Tabellenzelle breiter
und verschiebt das ganze Raster — der Fehler fällt erst auf, wenn genug Zellen markiert sind.

**Das Zeichen ist ein `<span>`, kein `<button>`.** Ein Knopf mit ⚠️ als einzigem Inhalt rutscht durch
die Prüfung in `tests/barrierefrei-ui.js`, weil deren Regex das Warnzeichen nicht wegstreicht und
der Text damit als „vorhanden" gilt. Ein `title` gäbe zwei Sprechblasen übereinander.

**Die Schalter kamen nach — und mit ihnen die schärfste Frage des Tages.** Jeder darf Warnungen für
sich ausblenden. Entscheidend war: *wessen* Einstellung gilt. Zählte die der betroffenen Person,
könnte ein Mitarbeiter seine eigenen Verstöße vor dem Chef unsichtbar machen. Also gilt die des
Betrachters. Und die Schalter wirken nur in den Übersichten — beim Eintragen bleibt der Hinweis
stehen, das ist der Moment, in dem sich etwas richtigstellen lässt (Alex' Klarstellung). Damit ist
das Formular auf dieselbe Regelmenge umgestellt und meldet jetzt auch Ruhezeit, Erwachsenen-Woche
und zu kurze Pause.

**Zwei Zusicherungen im Bestand prüften danach etwas anderes, als sie behaupteten.** In
`hoechstarbeitszeit-ui` stand „bei genau 10:00 wieder weg" gegen eine leere Warnzeile — die dortige
Buchung hat aber 10 Std Anwesenheit **ohne jede Pause** und verletzt damit § 4 ArbZG wirklich. Statt
die Prüfung abzuschwächen, prüft sie jetzt gezielt die Tagesgrenze, und eine zweite belegt die
Pausenmeldung.

**Und im eigenen Test der Schalter steckten zwei stille Fehler.** `tagesbild()` rief `render()`,
ohne vorher auf den Zeitnachweis zu wechseln — nach dem Abschnitt „Mein Konto" rendert das die
Kontoseite mit null Spalten, und jede Prüfung auf „kein Zeichen mehr" ist trivial wahr. Der Fall
„Abruf gescheitert" kam gar nicht vor, weil der Test immer erfolgreich lud; erst mit einem
ersetzten `ladeWarnungen` biss die Gegenprobe.

**Was die echten Daten zeigten.** Am Prod-Klon: 85 von 738 Personentagen ohne gebuchte Pause bei
über sechs Stunden Anwesenheit, dazu Tage über zehn Stunden — und ein Fall mit Feierabend 23:30 und
Arbeitsbeginn 05:45 am Folgetag: 6 Std 15 min Ruhezeit. Das stand seit Monaten so da und war
nirgends sichtbar.

### 2026-08-25 · Bestellen, wenn Chef und Chefin im Urlaub sind

Alex' Beobachtung: Nur Admin, Chef und Buchhalter dürfen eine offene Bestellung abschliessen. Sind
die ersten beiden weg, steht der Einkauf. Also ein Einzelrecht `can_order`, gedanklich parallel zum
Planungsrecht.

**Zwei stille Fallen.** `middleware/auth.js` liest bei JEDER Anfrage eine **feste Spaltenliste** aus
`users` — fehlt `can_order` dort, ist das Recht serverseitig schlicht nicht vorhanden und alles
wäre wirkungslos, ohne dass irgendwo ein Fehler erschiene. Dieselbe Falle eine Ebene tiefer in
`scheduler.js`, der für die Zusammenfassung `SELECT id, role, active` lädt.

**Der Buchhalter ist der Sonderfall.** Beim Bestellen hat er das Recht per Rolle — bei Planung,
Schwarzem Brett und Upload **nicht**; in `planning.js`, `bulletin.js` und `documents.js` kommt die
Rolle gar nicht vor. Die vorhandene Normalisierungszeile (chef/admin) einfach um ihn zu erweitern
hätte ihm also drei echte Rechte weggenommen. Deshalb eine eigene Zeile mit drei Rollen — und in
der Oberfläche eine eigene Gruppe mit eigener Sichtbarkeitsregel. Die Gegenprobe (beides
zusammengelegt) lässt den Test genau an dieser Stelle umfallen.

**Das Recht allein hätte nichts genützt.** Zähler und Push gingen an `role IN ('chef','admin')`. Ein
Vorarbeiter hätte den Knopf gehabt und nie erfahren, dass etwas zu bestellen ist — ausgerechnet
während des Urlaubs. Beides folgt jetzt dem Recht.

**Alex' eigentlicher Punkt war der Entzug.** Ein Recht wegzunehmen ist nicht das Gegenteil vom
Geben: Es bleibt etwas liegen. `bestellmeldungenAufraeumen()` schaltet den Push-Schalter ab und
streicht `orders` aus geplanten Zusammenfassungen; aus „notes,orders" wird „notes". Bleibt keine
Kategorie übrig, wird die Zusammenfassung gelöscht — eine Meldung, die nichts mehr melden kann, ist
Ballast. Alles im Audit-Log. Und sie läuft nach **jeder** Änderung an Rolle oder Recht, nicht nur
beim Häkchen-Wegnehmen: Ein Chef, der zum Mitarbeiter zurückgestuft wird, verliert das Recht
ebenfalls, nur implizit. Dieser Weg wäre sonst offen geblieben.

### 2026-08-25 · Ausstellen löscht den zweiten Faktor

Ausstellen ist ein Soft-Delete — alle Daten bleiben, damit die Historie stimmt. Beim zweiten Faktor
ist genau das gefährlich: Der Authenticator auf dem privaten Handy überlebte das Ausstellen, samt
der gemerkten Geräte, die je nach Intervall wochenlang gar keinen Code verlangen. Käme der Account
je versehentlich wieder auf `active = 1`, wäre das alte Handy sofort wieder ein gültiger zweiter
Faktor. Kein Schutz mehr, sondern eine offene Tür, die niemand sieht.

Profilbild und Einzelrechte bleiben dagegen **absichtlich** stehen: Das Bild hängt an alten
Ansichten, die Rechte wirken ohne aktiven Account nicht — beide können nicht zur stillen Hintertür
werden, und nach einer Wiedereinstellung ist alles wie zuvor.

**Der Test misst beide Richtungen** — was weg sein muss und was unangetastet bleibt. Beim ersten
Wurf war er trotzdem wertlos: Er las die Datenbankdatei, während der Server sie nur alle fünf
Sekunden speichert, und der Auslöser dafür hatte die falsche HTTP-Methode. Die Tabellen waren
deshalb **leer**, und „der Zwei-Faktor ist weg" stand grün da, ohne irgendetwas zu belegen.
Aufgefallen ist es nur, weil zwei Nachbarzeilen („vorher ist er hinterlegt") aus demselben Grund
rot wurden.

### 2026-08-25 · Verschlüsselung ohne SSH — und ein Fund in `api()`

Alex' Einwand traf eine echte Lücke: Empfänger standen nur in der `.env`. Wer keinen SSH-Zugang
hat — also so gut wie jeder Betreiber ausser dem Entwickler — konnte die Verschlüsselung gar nicht
einschalten. Sie war damit theoretisch vorhanden und praktisch nicht benutzbar.

Jetzt stehen Empfänger auch in der Datenbank und werden in der Backup-Karte gepflegt: hinzufügen,
umbenennen, entfernen, prüfen. Dazu ein Generator im Browser und eine `openssl`-Anleitung für die,
die nichts anklicken wollen.

**Beide Quellen gleichzeitig, und warum.** Der `.env`-Eintrag bleibt der feste Anker: Er hängt an
der Maschine, kein Restore verschiebt ihn, und über die Oberfläche kommt niemand an ihn heran. Die
Datenbank-Liste ist der bequeme Weg. In der Oberfläche stehen `.env`-Einträge sichtbar, aber
unveränderlich.

**Das nächtliche Skript musste mit.** `make-backup.js` läuft im Cron, nicht in der App. Hätte es
weiter nur die `.env` gelesen, wäre der schlechteste aller Zustände entstanden: Die Karte sagt
„verschlüsselt", und um Mitternacht schreibt der Server eine offene Kopie. Es liest die Liste
deshalb aus der Datenbankdatei, die es ohnehin gerade sichert — nur lesend, per sql.js.

**„Geprüft" ist ein Beweis, kein Häkchen.** Der *Server* würfelt Zufallsbytes, verschlüsselt sie an
den Empfänger, der Browser entschlüsselt und schickt sie zurück. Ein Browser, der bloss „hat
geklappt" meldet, würde nichts belegen. Die Probe gilt genau einmal. Das schützt vor der
gefährlichsten Störung des Verfahrens: einem Schlüssel, dessen privaten Teil niemand mehr hat —
die Sicherungen laufen dann weiter und sind unlesbar.

**Ändern darf nur der Admin** (Entscheidung Alex). Sehen dürfen Chef und Chefin, wie die ganze
Backup-Karte — sie dürfen ohnehin eine vollständige Sicherung herunterladen. Aber wer die Liste
ändert, könnte im Vorbeigehen den Schlüssel der Zweitanlage entfernen und damit die
Notfall-Umschaltung stilllegen, ohne dass das irgendwo aufschlägt.

**Validierung gehört an die Tür.** Ein unbrauchbarer Schlüssel wird beim Speichern abgelehnt — mit
Namen: PEM statt Base64, RSA statt EC, P-384 statt P-256, und vor allem der *private* Schlüssel im
Feld für den öffentlichen. Letzteres fängt schon der Browser ab, damit das Geheimnis den Rechner
nicht verlässt; der Server lehnt es zusätzlich ab. Die Gegenprobe zeigte, wie viel daran hängt: Mit
abgeschalteter Kurvenprüfung wird ein P-384-Schlüssel angenommen — und danach schlägt der Download
komplett fehl. Es gäbe dann gar keine Sicherungen mehr.

**Nebenfund, app-weit.** Der Oberflächen-Test liest Konsolenfehler wirklich mit, statt es zu
behaupten — und stiess sofort auf einen: `api()` legte laufende Schreibanfragen in eine Map und
räumte sie per `run.finally(…)` wieder heraus. `.finally()` erzeugt aber eine EIGENE Zusage; lehnt
`run` ab, lehnt auch sie ab, und um die kümmert sich niemand. Jeder fehlgeschlagene POST/PUT/DELETE
der gesamten App hinterliess damit eine unbehandelte Ablehnung. Sichtbar war nichts — der Aufrufer
bekam seinen Fehler immer korrekt —, aber in der Konsole stand er als unbehandelt. Eine Zeile.

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
wird gemeldet – Seiten, die innen scrollen wie Planung und Auftrags-Board, werden dort gemessen; seit
05.10.2026 MIT geladenen Profilbildern und der Seite Meldungen), `node tests/scroll-ruckeln-prodklon.js`
gegen eine Kopie der Produktivdaten. Dieser bekommt eine feste Wetterantwort (ohne Wetterkarte ist die echte
Willkommensseite gar nicht scrollbar) und scrollt in Schritten nach Seitenlänge — mit festen 60 px war die
kurze echte Seite unten, bevor die Uhr tickte, und der nachgebaute Juli-Fehler blieb unentdeckt.

Seit Oktober 2026 steht zu jedem neuen Test ein eigener Abschnitt am Ende dieser Datei (mit Gegenproben); die
vollständige Liste erzeugt `node scripts/generate-test-index.js` in `tests/README.md`. Die Tests vom 05.10.2026:
`kollegen.js` / `kollegen-ui.js` (Kollegen), `menue-gruppen-ui.js` (Menü-Gruppen auf UND zu), `avatar-orte-ui.js`
(Profilbild an allen Stellen), `avatar-fehlt-ui.js` (fehlende Bilddatei hält keine Verbindung offen),
`twofa-eigenes-intervall.js` (Vorgabe der Rolle = Minimum, 03.10.).

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

Empfängerliste der Sicherungen: `node tests/backup-empfaenger.js` (Rechte je Rolle, Ablehnung
unbrauchbarer Schlüssel samt der Verwechslung privat/öffentlich, doppelte Namen und doppelte
Schlüssel, der `.env`-Anker als unveränderlicher Eintrag, der Beweis-Durchgang mit richtigem und
falschem Schlüssel, die Einmaligkeit der Probe — und eine kaputte Zeile in der Datenbank, die
übersprungen wird, statt die ganze Sicherung anzuhalten) sowie
`node tests/backup-empfaenger-ui.js` (der geklickte Weg samt Mitschnitt aller Anfragen: der private
Schlüssel kommt in keiner vor, auch nicht in Teilen; die Sicht des Chefs ohne Änderungsknöpfe).

Bestellrecht: `node tests/bestellrecht.js` (in-process mit gemocktem web-push, damit die Empfänger
EXAKT geprüft werden: ohne Recht admin+chef, mit Recht admin+Rechteinhaber, Buchhalter nie; dazu
der Entzug samt Zusammenfassungen und der Weg über die Rolle) und `node tests/bestellrecht-ui.js`
(geklickt, mit dem Kern: beim Buchhalter verschwindet NUR das Bestell-Kästchen, sein Planungsrecht
bleibt stehen).

Ausstellen: `node tests/ausstellen-zweifaktor.js` (der zweite Faktor und die gemerkten Geräte sind
weg, Profilbild, Rechte, Soll-Stunden, Start-Überstunden, Personalnummer, Arbeitsbeginn und
Geburtsdatum bleiben; Login 403, laufende Sitzung 401; nach dem Wiedereinstellen muss der zweite
Faktor neu eingerichtet werden).

Gesetzesverstöße: `node tests/arbeitszeitrecht-regeln.js` (die Regeln als Falltabelle, Grenzwerte
punktgenau — genau 10:00 und genau 11:00 Ruhezeit sind erlaubt; Jahreswechsel; die Null-Dauer-
Platzhalter) und `node tests/verstoesse-uebersicht-ui.js` (zuerst die Regression: die zusätzlich
geladenen Tage dürfen in keine angezeigte Zahl geraten — die erwarteten Werte werden dabei selbst
ausgerechnet, nicht mit gestern verglichen; danach Marker, Rahmen und Sprechblase in allen drei
Ansichten, Chef- wie Mitarbeiter-Sicht, samt der Randwoche, die über den Monatsrand ragt).

Warn-Schalter: `node tests/warn-schalter-ui.js` (Standard ist an — auch bei gescheitertem Abruf und
bei unvollständigem PUT; es gilt die Einstellung des Betrachters, niemand kann eigene Verstöße
verstecken; Ausblenden ändert keine Zahl; der Hinweis beim Eintragen bleibt trotzdem stehen).

Tagesverlauf am Handy: `node tests/handy-verlauf-ui.js` (unter der Schwelle scrollt die SEITE und der
Verlauf hat keine Begrenzung mehr; das Raster passt sich dem Tag an — normaler Tag, sehr langer Tag,
einzelner Termin mit Mindestbreite; die Blockpositionen stimmen relativ zum verschobenen
Rasteranfang; am Rechner und in Woche/Monat bleibt alles unverändert).

## Auftrags-Kategorien und die drei Board-Ansichten (15.09.2026)

Ein Auftrag kann Mitarbeitern zugeordnet sein **und** Kategorien („Kleinarbeiten", „PV",
„Zählerschrank"). Beides unabhängig voneinander, beides mehrfach. Über dem Board stehen drei
Knöpfe: **Alle · Mitarbeiter · Kategorien**.

### Die Rest-Spalte bedeutet in jeder Ansicht etwas anderes

Das ist die Stelle, an der man sich beim Bauen vertut, weil „Nicht zugewiesen" so aussieht, als
wäre es immer dasselbe:

| Ansicht | Rest-Spalte | enthält |
|---|---|---|
| Mitarbeiter | „Nicht zugewiesen" | kein Mitarbeiter |
| Kategorien | „Ohne Kategorie" | keine Kategorie |
| Alle | „Nicht zugewiesen" | **weder noch** |

Der dritte Fall ist der Sinn der Sache. Ein Auftrag mit Kategorie, aber ohne Mitarbeiter, ist
**nicht** heimatlos — er steht unter seiner Kategorie. Stünde er zusätzlich im Rest, sähe das Board
mehr offene Arbeit vor, als es gibt. Deshalb ist die Bedingung in „Alle" `restlos = kein MA UND
keine Kategorie`, nicht `kein MA`.

Die Kehrseite: **dieselbe Kachel erscheint mehrfach** — einmal bei jedem Mitarbeiter, einmal bei
jeder Kategorie. Das ist gewollt, nicht ein Fehler beim Gruppieren. Jede Spalte soll für sich
vollständig sein; wer auf „PV" schaut, will alle PV-Aufträge sehen, auch die, die Max schon hat.
`tests/auftrags-kategorien-ui.js` sichert beides ab: die Mehrfach-Anzeige und die Gegenprobe, dass
in „Alle" **kein** Auftrag durchs Raster fällt.

**Leere Kategorien bleiben stehen.** Eine Spalte nur zu zeigen, wenn etwas drinsteht, wäre der
naheliegende Filter — und der Weg, auf dem „PV" zum zweiten Mal angelegt wird, weil es unsichtbar
war.

### Ein PUT ohne `category_ids` darf nichts löschen

`setCategories` läuft in `PUT /api/projects/:id` nur, wenn `req.body.category_ids !== undefined`.
Ohne diese Abfrage räumte jedes Umschalten der Dringlichkeit (das schickt nur `{ urgency }`) still
die Kategorien ab. Dieselbe Falle wie seinerzeit bei den Zuweisungen; `tests/auftrags-kategorien.js`
prüft sie ausdrücklich, zusammen mit der Gegenprobe, dass eine **leere Liste** sehr wohl löscht.

### Zwei Tabellen, die gleich heißen

`project_categories` (Art der Arbeit) und `product_categories` (Art der Ware) haben nichts
miteinander zu tun. Der naheliegende und falsche Schritt wäre ein gemeinsamer Topf, weil beide
„Kategorie" heißen. „Zählerschrank" darf in beiden Welten stehen, und das Löschen der einen lässt
die andere unberührt — auch das steht als Zusicherung im Test, damit es niemand später
zusammenlegt.

Aus demselben Grund hat `routes/projects.js` seine **eigene** `vergleichsform` und importiert sie
nicht aus `products.js`: Die beiden Listen dürfen ihre Namensregeln unabhängig voneinander ändern.

### Löschen fragt einmal — und nennt die Zahl

Erster Entwurf: ein Dialog, der MITTEILTE, dass die Aufträge bleiben, danach einer, der genau das
bestätigen ließ. Alex am lebenden Objekt: *„Wo kann ich bestätigen, dass der Auftrag ohne diese
Kategorie bleiben soll?"* — im ersten Dialog gab es nämlich nichts zu entscheiden.

Jetzt **eine** Frage, und sie nennt die Zahl selbst. Die Oberfläche kennt sie: `_boardKategorien`
trägt `anzahl` und wird bei jedem Aufbau des Boards frisch geholt.

**Der Riegel im Server bleibt — als Gegenprobe, nicht als zweite Frage.** Der Klick schickt `DELETE`
bewusst OHNE `loesen`. Stimmt die Zahl aus der 409-Antwort mit der überein, die im Dialog stand,
wird stillschweigend mit `{ loesen: true }` durchgereicht. Weicht sie ab — jemand hat in der
Zwischenzeit zugeordnet, und das Live-Ereignis kam nicht an —, wird noch einmal gefragt, mit der
richtigen Zahl. So bestätigt man nie eine Zahl und löscht dann eine andere.

`anzahl` in `GET /kategorien` zählt seitdem **dasselbe wie der Riegel**: alle nicht gelöschten
Aufträge, auch erledigte. Vorher zählte die Liste nur die offenen — der Dialog hätte eine andere
Zahl genannt als die Sicherung dahinter.

### Wer die Firma verlässt, behält seine Aufträge

Entschieden am 15.09.2026: Ein Auftrag fällt beim Ausstellen **nicht** still auf „Nicht zugewiesen"
zurück — sonst verschwände die Information, wer ihn zuletzt hatte. Stattdessen:

* Die Spalte bleibt, solange ihr etwas zugewiesen ist, trägt den Vermerk **„ausgeschieden"** und
  sortiert **ans Ende**. Ist der letzte Auftrag weg, verschwindet sie von selbst — die Spalten
  entstehen aus `aktive Mitarbeiter ∪ irgendwo zugewiesene`.
* In der **Auswahl** beim Anlegen und Bearbeiten stehen nur **aktive** Mitarbeiter. Ein bereits
  gesetztes Häkchen bleibt aber sichtbar und angehakt, sonst nähme ein bloßes Speichern die
  Zuweisung weg, ohne dass es jemand wollte.

Die beiden Regeln widersprechen sich nur scheinbar: Die Spaltenliste beantwortet „wer hat noch
etwas?", die Auswahlliste „wem darf ich noch etwas geben?". `tests/board-ausgeschieden-ui.js` misst
sie getrennt — und zwar in **je einer frischen Sitzung**, weil `_boardUsers` eine Modulvariable ist,
die nur nachlädt, wenn sie leer ist. Eine Messung in derselben Sitzung misst den Stand von vorher.

### Die Stelle halten (15.09.2026)

Alex fragte, ob Scroll-Stelle und Reiter das Bearbeiten eines Auftrags überleben. **Erst gemessen,
dann gebaut** — vier der fünf Fälle taten es schon (Kachel aufklappen, Bearbeiten + Speichern,
Bearbeiten + Zurück, anderer Menüpunkt und zurück). Gefehlt hat nur der App-Neustart: `_boardAnsicht`
ist eine Modulvariable und stirbt mit dem Seiten-Neuaufbau.

Die Wahl liegt jetzt im `localStorage` unter `board_ansicht` — **geräte-, nicht kontobezogen**. Am
Rechner arbeitet man nach Mitarbeitern, am Handy im Lieferwagen eher nach Kategorien; eine
kontoweite Einstellung würde die eine Gewohnheit über die andere stülpen.

Zwei Dinge sind Absicht und stehen als Gegenproben im Test:
* Ein **unbekannter** gemerkter Wert (alte Version, von Hand verändert) fällt still auf
  „Mitarbeiter" zurück, statt eine leere Spaltenliste zu erzeugen.
* Lesen **und** Schreiben stehen in `try/catch`: in einem privaten Fenster wirft `localStorage`,
  und daran darf das Board nicht hängenbleiben.

`tests/board-stelle-halten-ui.js` misst in einem **schmalen** Fenster (900 px), damit das Board
überhaupt scrollen MUSS — in einem breiten Fenster ist `scrollLeft` immer 0 und jede Zusicherung
wäre aus dem falschen Grund grün. Die erste Zusicherung prüft deshalb, dass es eine waagerechte
Scrollleiste überhaupt gibt.

### Die Plakette zeigt nie ihre eigene Spalte (16.09.2026)

Alex im echten Betrieb: In der Kategorie-Spalte „Test" stand auf der Kachel die Plakette „Test".
Eine Wiederholung dessen, worunter man ohnehin steht — und kein Hinweis darauf, **wer** den Auftrag
hat.

Die Plaketten beantworten eine einzige Frage: *Wo taucht dieser Auftrag sonst noch auf?* Daraus
folgt die Regel in einem Satz — sie hängt an der **Spalte**, nicht an der Ansicht:

> **Alles, woran der Auftrag hängt, minus die Spalte, in der man gerade steht.**

Mein erster Entwurf war die halbe Regel (Mitarbeiter-Spalte → nur Kategorien). Alex hat sie zu Ende
gedacht: Ein Auftrag an **Max und Anna** in **PV und Zählerschrank** zeigt

| Spalte | Plaketten |
|---|---|
| Max | Anna · PV · Zählerschrank |
| Anna | Max · PV · Zählerschrank |
| PV | Max · Anna · Zählerschrank |
| Zählerschrank | Max · Anna · PV |

Damit sieht man in der Mitarbeiter-Spalte auch, **mit wem** man einen Auftrag teilt — das war
vorher nirgends auf der Kachel zu sehen. Die Rest-Spalten brauchen keinen Sonderfall: In
„Nicht zugewiesen" gibt es keine Mitarbeiter, in „Ohne Kategorie" keine Kategorien, da fällt die
jeweilige Hälfte von selbst weg. Der Code wurde dadurch kürzer statt länger.

Deshalb bekommt `tileHtml(p, spalte)` seine Spalte übergeben. In „Alle" ergibt sich das Verhalten
von selbst, weil dort beide Spaltenarten nebeneinanderstehen.

**Kein Avatar in der Plakette.** Der erste Entwurf setzte `avatarHtml(…, 14)` davor. Wer kein Bild
hinterlegt hat, bekommt aber `.avatar--leer` — und das ist `display: none`. Die Plaketten sähen je
nach Konto unterschiedlich aus. Stattdessen ein 7-px-Punkt in `colorFor(user_id)`: immer da, und
dieselbe Personenfarbe wie im Spaltenkopf und in der Planung.

### Eine kurze Liste neben einer langen (16.09.2026)

Alex, mit Screenshot: *„Das aktualisiert sich nicht. Ich habe inzwischen definitiv mehr Rechte."*
Auf „Mein Konto" standen weiter nur „Schwarzes Brett, Dateien hochladen" — obwohl er sich
Bestell-, Lagerdaten- und Einlernrecht gegeben hatte.

Der Server schickte in `rechte` längst **alle sieben** Schalter. Die Anzeige in `app-5-team.js`
zählte **drei** davon auf, hartkodiert. Zwei handgepflegte Listen nebeneinander, und niemand merkt,
wenn die kürzere zurückbleibt: Wer ein Recht ergänzt, fasst die Route an — die Anzeige liegt in
einer anderen Datei und schweigt einfach weiter.

**Die Reparatur ist nicht „drei Zeilen nachtragen"**, sondern die Richtung umdrehen: Es wird über das
gelaufen, **was ankommt**. Ein Schlüssel ohne Beschriftung erscheint mit seinem **rohen Namen**
(`bestellungen_abschliessen`) statt zu verschwinden. Hässlich — und genau deshalb richtig: Beim
nächsten neuen Recht sieht man sofort, dass eine Zeile fehlt.

Zwei Rechte schließen ein kleineres ein (`barcoderecht.js`: *das größere Recht schließt das kleinere
ein*). Beide nebeneinander zu nennen läse sich wie zwei Dinge, obwohl es eine Stufe ist — also nur
das größere, und wo der Name es nicht verrät, mit Zusatz: „Lagerdaten pflegen (schließt Einlernen
ein)".

`tests/konto-rechte-ui.js` (14) prüft das Entscheidende **ohne eigene Liste**: Es holt die Schlüssel
vom Server und verlangt für jeden eine Beschriftung im Quelltext. Eine Aufzählung im Test wäre die
dritte Liste, die zurückbleiben kann. Dazu eine Gegenprobe mit einem erfundenen Schlüssel — sonst
prüfte die Zusicherung womöglich gar nichts.

## Gleitende Sitzung und die falsche Erfolgsmeldung (R1, 24.09.2026)

### Was gemessen wurde

Eine Anmeldung galt fest 24 Stunden ab dem Anmelden. Die Prod-Kopie zeigte, was das bedeutet:
**218 Ablauf-Abmeldungen in 30 Tagen bei 11 Personen, 197 davon mit Neuanmeldung binnen 3 Minuten.**
Die Leute flogen nicht nachts im Hintergrund heraus, sondern mitten in der Arbeit. Rund 90 % aller
Anmeldungen waren erzwungen. Ohne diese Zahl hätte die Entscheidung über die Sitzungsdauer auf
Vermutung beruht.

### Der eigentliche Fehler: `null` sieht aus wie Erfolg

Bei 401 rief `api()` `logout()` auf und gab **`null`** zurück. 136 schreibende Aufrufe prüfen ihr
Ergebnis nicht — das Eintragsformular etwa macht `await api('POST', …); toast('Eintrag erstellt');
entwurfLoeschen(…)`. Nach Ablauf der Sitzung zeigte es also **„Eintrag erstellt"**, löschte den Entwurf
und sprang weiter; gespeichert war nichts. Obendrein löschte `logout()` beim automatischen Abmelden
alle Entwürfe — die Sicherung, die genau diesen Verlust verhindern sollte.

Die Reparatur sitzt an der zentralen Stelle, nicht in 136 Formularen: Ein **schreibender** Aufruf
**wirft** nach dem Abmelden einen Fehler („NICHT gespeichert"), und damit landen alle in ihrem ohnehin
vorhandenen `catch`. Lesende Aufrufe geben weiter `null` zurück — dort prüfen die Aufrufer darauf, und
ein Fehler würde nur zusätzliche Meldungen erzeugen.

### Warum der Server jetzt einen Grund mitschickt

Ob Entwürfe bleiben dürfen, hängt am **Grund** des 401. Nur bei `SITZUNG_ABGELAUFEN` meldet sich gleich
derselbe Mensch wieder an. Bei `SITZUNG_BEENDET` („auf allen Geräten abmelden" — typisch: Handy
verloren), `KONTO_AUSGESTELLT` und `KONTO_GELOESCHT` müssen Kunde, Adresse und Notiz vom Gerät. Vorher
sahen alle fünf Fälle gleich aus. Die Codes stehen in `middleware/auth.js` (`GRUND`).

Entwürfe waren schon vorher **pro Nutzer** abgelegt (`entwurf:<id>:<formular>`); ein anderer bekam sie nie
angeboten. Meldet sich jetzt ein anderer an, werden sie zusätzlich gelöscht (`entwuerfeFremderLoeschen`).

**Reihenfolge in `logout()`:** erst `entwuerfeFuerNeuanmeldungSichern()` — solange `S.user` noch steht,
sonst landen die Entwürfe unter `anon` —, dann leeren. Die Liste offener Formulare wird dabei geleert,
damit das `hashchange` beim Sprung zur Anmeldeseite nichts mehr nachsichert. Und `logout()` ist für
den automatischen Fall **einmalig**: Mehrere gleichzeitige 401 (Promise.all) würden sonst die
Rückkehr-Seite mit `/login` überschreiben.

### Gleitend — und wo es nicht gleiten darf

`tokenAusstellen()` ist die einzige Stelle, die Zugangs-Token baut; `anmeldung` im Token hält den
Zeitpunkt der echten Anmeldung fest und wandert beim Erneuern **nicht** mit. Erneuert wird höchstens
stündlich (Kopfzeile `X-Neues-Token`), und zwar **nach** allen Sperr-Prüfungen — ein widerrufenes oder
ausgestelltes Token bekommt nie ein neues. Im Browser übernimmt `tokenUebernehmen()` es nur, solange
noch jemand angemeldet ist, und nur für **denselben** Nutzer; sonst könnte eine verspätete Antwort nach
dem Abmelden oder nach einem Nutzerwechsel eine Sitzung wiederbeleben.

Token von vor der Änderung tragen kein `anmeldung`; dann zählt ihr Ausstellungszeitpunkt. So fliegt
beim Deploy niemand heraus.

### Der zweite Faktor hätte sich still verabschiedet

Der Code wird nur **beim Anmelden** gefragt. Mit einer 30-Tage-Sitzung hätte „wöchentlich" nur noch
monatlich gefragt — im Betrieb ist genau das eingestellt (eigene Stufe eines freiwillig eingerichteten
Authenticators). Deshalb begrenzt die Stufe die Sitzung (`zweifaktor.js`, `sitzungsGrenzeTage`):
„bei jeder Anmeldung" und „täglich" 1 Tag — so oft wie mit der alten 24-Stunden-Sitzung —, „wöchentlich"
7, „monatlich" 30. Ist eine Sitzung älter, gilt sie **sofort** als abgelaufen und nicht erst beim
nächsten Token-Ablauf: Stellt der Chef eine Rolle strenger, soll das nicht drei Tage verschlafen werden.

Tests: `tests/sitzung-gleitend.js` (29, in-process) und `tests/sitzung-entwurf-ui.js` (29, geklickt),
dazu Gegenproben für jeden Baustein — jeweils zurückgenommen, jeweils an der richtigen Stelle rot.

## Zwei Tests, die nur durch Datumsglück grün waren (R21, R22 — 24.09.2026)

Nach einem Datumswechsel kippten zwei Tests, beide auch auf dem Stand vor der jeweils letzten
Änderung — also nicht durch Code, sondern durch den Kalender.

**R22 war nur der Test.** `auszahlung-gesamtbild.js` suchte Werktage in einem Fenster von zwei
Kalendertagen; am 24.09. fiel es auf Samstag/Sonntag. Jetzt fünf Kalendertage (immer mindestens drei
Werktage), plus ein Abbruch mit klarer Meldung, falls die Liste doch leer ist.

**R21 war ein echter Fehler in der App**, den der Test nur zufällig bisher nicht sah. Der
Abwesenheitskalender springt beim Öffnen zu „heute" — und das `scroll`-Ereignis dieser *eigenen*
Bewegung wurde als Benutzer-Wischen gespeichert, als Pixelwert der damaligen Breite. Dieselbe Ansicht
in anderer Breite (Handy gedreht) öffnete dann an der alten Stelle. Jetzt wird nur echtes Wischen
gemerkt; wer auf der automatischen Stelle steht, hat keine gemerkte Position.

Die Lehre für Tests mit Bildschirmlage: **„ist im Bild" ist eine datumsabhängige Aussage**, wenn das
Gezeigte vom heutigen Tag abhängt. Deshalb steht daneben jetzt eine Zusicherung, die nicht am Datum
hängt — die Position muss für die *jetzige* Breite gerechnet sein. Die Gegenprobe (Reparatur
ausgebaut) macht beide rot: 527 statt 779.

## Die Pause schluckt die Arbeitszeit (R6, 24.09.2026)

Gemessen im Bestand: zwei 30-Minuten-Einsätze mit 30 min Pause, gespeichert als **0 Stunden** — eine
Stunde Arbeit, die im Überstundenkonto fehlte. Zwei Lücken griffen ineinander:

1. **Der Vorschlag.** `restPause` rechnet die offene Tagespause, und die kam beim ersten Eintrag des
   Tages voll ins Feld — unabhängig davon, wie lang der Einsatz war. `pausenVorschlagFuer()` begrenzt
   das jetzt: Passt die Pause nicht hinein, wird 0 vorgeschlagen und im Hinweis gesagt, dass sie beim
   nächsten Eintrag kommt. Das Versprechen stimmt, weil `restPause` beim nächsten Eintrag die noch
   fehlende Pause einrechnet — der Test prüft genau das. `restPause` selbst ist unverändert; es wird
   auch anderswo gebraucht, deshalb die Begrenzung eine Ebene darüber.
2. **Keine Prüfung.** `calculateNetHours` klemmt auf 0 und schweigt. Jetzt weisen Server (`POST`
   *und* `PUT`) und Oberfläche „Pause ≥ Arbeitszeit" ab. Beim `PUT` mit den **zusammengeführten**
   Werten — wer an einem Altfall nur die Beschreibung ändert, wird auf die Pause aufmerksam.

Einträge ohne Dauer (07:00–07:00) **und** ohne Pause bleiben erlaubt; im Bestand liegen davon welche,
die sind aber ein eigenes Thema (leer gespeicherte Formulare), nicht dieses.

**Mein Denkfehler in der ersten Fassung — gefunden, weil die Suite nachts lief.** Die Begrenzung griff
auch bei Dauer 0. Aber Dauer 0 beim *Öffnen* heißt „Zeiten noch nicht eingegeben": Nachts steht das
Formular z. B. auf 16:00–16:00, weil „Bis" (= jetzt) nie vor „Von" liegen darf. Daraus wurde Pause 0
statt der Firmenpause. Tagsüber sieht das Formular 07:00–10:00 und alles stimmt — deshalb fielen
zwei Bestandstests (`restpause-ui`, `restpause-firmenwert-ui`) erst um 1 Uhr nachts auf. Jetzt gilt die
Begrenzung nur bei echter Dauer; wer 07:00–07:00 mit Pause speichert, wird beim Absenden aufgehalten.
Die Zusicherung „Von = Bis zeigt die volle Firmenpause" steht jetzt ausdrücklich in `pause-zu-lang-ui`.

Lehre: **Ein Formular, dessen Vorbelegung von der Uhrzeit abhängt, hat nachts andere Ausgangswerte.**
Eine Regel, die an Dauern hängt, muss den Fall „noch nichts eingegeben" von „sehr kurz" unterscheiden.

Dieselbe Nacht brachte noch eine Zeitfalle ans Licht, diesmal nur im Test: `board-ausgeschieden-ui`
bildete „heute" mit `toISOString()` — UTC. Zwischen 0 und 2 Uhr ist das „gestern"; der Server legte
Anna mit dem Berliner Datum an, und der Austritt zum UTC-„heute" lag vor ihrem Eintritt.

Eine Testfalle unterwegs: Der Testnutzer hatte kein Geburtsdatum, die App rechnete deshalb korrekt mit
„unter 18" und schlug für 8 Stunden 60 statt 30 Minuten vor. Der Test setzt jetzt ein Geburtsdatum —
er soll den gewöhnlichen Fall messen, nicht zufällig den Jugendschutz.


## Seiten laden: Fehleranzeige und Veraltet-Wächter (R4 + R5, 25.09.2026)

### Was gemessen wurde

* **R4:** `/api/users` im Browser abgebrochen. Nach 1 s eine Meldung — mit dem falschen Satz
  „es wurde nichts gespeichert", obwohl die Seite nur laden wollte —, nach 3 s war sie weg, nach 6 s
  drehte der Kreisel noch, und es gab keinen Knopf. Andere Seiten zeigten stattdessen eine **leere
  Liste**: „Keine Einträge am Schwarzen Brett", keine Werkzeuge, ein leerer Posteingang, beim
  Impressum „kein Inhalt hinterlegt". Das ist schlimmer als ein Kreisel, weil es nach einer Auskunft
  aussieht.
* **R5:** `/api/projects` um 4 s verzögert, inzwischen auf *Mein Konto* gewechselt. Danach stand das
  Auftrags-Board im Bild, Adresse und Menü sagten „Mein Konto".

### Eine Funktion statt zwei Dinge, an die jede Seite denken muss

Die Bausteine gab es: `renderLoadError()` und `renderToken()`/`renderStale()`. Genutzt haben sie
vier von über zwanzig Seiten. Jetzt gibt es `seiteLaden(laden, nochmal, ziel)` in `app-1-core.js`:
`laden` holt **alles**, was die Seite zum Zeichnen braucht; bei einem Fehler zeigt `seiteLaden` die
Fehleranzeige mit „Erneut versuchen" (der Knopf ruft `nochmal`), und eine Antwort, die zu spät
kommt, wird verworfen. Kommt `null` zurück, ist alles erledigt — die Seite hört einfach auf.
Programmfehler (TypeError …) erscheinen als „Unerwarteter Fehler", die echte Meldung steht in der
Konsole.

Die Marke wird außerdem **zentral** gezogen: in `render()` bei jedem Seitenwechsel und in `logout()`.
So ist ein Ladevorgang auch dann veraltet, wenn die neue Seite selbst gar nichts lädt (das Aushang-
Formular zum Beispiel), und eine Seite, der mitten im Laden die Sitzung wegbricht, zeichnet nicht
mit halben Daten weiter.

### Wo es den Schutz schon gab, wirkte er nicht

Übersicht, Planung und Statistik hatten den Wächter — und fielen im neuen Test trotzdem durch. Sie
zogen die Marke erst in `renderDashboardContent()` usw., also **nach** dem ersten Laden (Projekte,
Mitarbeiter). Kam diese Antwort spät, zog die alte Seite danach eine frische Marke, hielt sich damit
für aktuell und überschrieb die neue. Daraus die Regel, die jetzt an `seiteLaden` steht:
**`seiteLaden()` ist das erste Warten der Seite.** Was vorher geladen werden muss, gehört mit in
`laden`. Genau deshalb wanderte bei den Bestellungen auch `katalogLaden()` in die Ladefunktion.

### Pflicht oder Zugabe

Was die Seite **richtig** zeigen muss, ist Pflicht — scheitert es, kommt die Fehleranzeige. Drei
Fälle, in denen das Weiterlaufen mit Ersatzwerten echten Schaden anrichten konnte:

* **Einstellungen:** Das Formular erschien mit den Werten, die gerade im Browser lagen (oder den
  Standardwerten), und „Speichern" hätte sie über die echten geschrieben. Auch der Speicherstand der
  Dokumente ist deshalb Pflicht — seine Felder fielen sonst auf 500 MB zurück.
* **Planungsformular:** Ohne die Serien-Regel stand die Wiederholung eines Serientermins auf „Keine",
  und Speichern fragte „Wiederholung entfernen – wie?", obwohl das niemand wollte.
* **Projektformular:** Ohne Mitarbeiterliste hätte Speichern dem Auftrag seine Zuweisungen genommen.

Zugaben bleiben Zugaben: die Auszahlungs-Stände in der Mitarbeiterliste, die Feiertage im Board, die
Geburtstage auf der Startseite, die Urlaubskonto-Zahlen, der Abschluss-Hinweis in der Statistik (die
Zahlen selbst rechnet der Server) und der Katalog in den Bestellungen. Auf der **PDF-Seite** dagegen
ist der Abschluss Pflicht: Dort hängt die Karte, mit der Monate abgeschlossen werden, und die hätte
mit dem Rückfallwert „nichts abgeschlossen" angezeigt.

**Mit Absicht anders:** Die Bestellungen erscheinen auch ohne Verbindung — mit dem Katalog aus dem
Gerätespeicher (so gewollt seit dem 09.09.2026). Nur ein Fehler, der *nicht* an der Verbindung liegt,
bekommt dort die Fehleranzeige. *Mein Konto* baut sich kartenweise auf; dort prüft der Test nur, dass
kein Kreisel ewig dreht.

### Was sich sonst ändert

* Formulare (Zeiteintrag, Planung, Aushang bearbeiten, PDF) zeigen den Kreisel **sofort**. Vorher
  blieb die alte Seite stehen, und ein Tipp auf „+ Neuer Eintrag" sah bei langsamem Netz aus, als
  passiere nichts.
* Ein Ladefehler im Formular führt nicht mehr per `navigate()` zur Liste zurück — der Sprung traf bei
  langsamem Netz auch dann, wenn man längst woanders war.
* „Gesehen" (`markSeen`) wird erst gemeldet, wenn die Seite wirklich zu sehen ist.
* Lesende Aufrufe sagen bei fehlender Verbindung nicht mehr „es wurde nichts gespeichert".
  Antworten ohne JSON mit 502/503/504 (Caddy während eines Neustarts) ergeben „Der Server ist gerade
  nicht erreichbar, vermutlich startet er neu" statt „Fehler" — ein Teil von R9.

### Test

`tests/seite-laden-ui.js` geht **jede** Adresse durch, die etwas lädt (33), dazu das Projektformular:

* **A** Netz weg → Fehleranzeige mit Knopf, ohne Kreisel, ohne „gespeichert"; Netz zurück, Knopf →
  die Seite kommt. Dazu ein Serverfehler (500) mit der Meldung des Servers.
* **B** Antworten der alten Seite 1,5 s zurückgehalten, vorher weitergewechselt → die neue Seite steht
  noch. Abwechselnd zwei Ziele: eines, das selbst nichts lädt (nur der zentrale Zähler schützt es),
  und eines, das selbst lädt.
* **C** 401 mitten im Laden → Anmeldeseite, nichts darübergezeichnet, kein Absturz.
* **D** Bestellungen: ohne Netz mit Seite, bei Serverfehler Fehleranzeige.

**Gegenproben** (jeweils ein Teil zurückgebaut, danach byte-genau wiederhergestellt):

| Zurückgebaut | Ergebnis |
|---|---|
| zentraler Zähler in `render()` | 27 rot — genau die Wechsel zu Seiten, die selbst keine Marke ziehen |
| Veraltet-Prüfung in `seiteLaden` | Wechsel rot |
| Fehleranzeige in `seiteLaden` | 36 rot — alle Seiten aus Teil A |
| Lese-Meldung wieder „nichts gespeichert" | Teil A rot |
| Werkzeugseite im alten Stand | nur ihre zwei Prüfungen rot |
| Übersicht: Marke wieder nach dem ersten Warten | ihr Wechsel rot |
| Bestellungen: Katalog wieder vor `seiteLaden` | genau ein Wechsel rot |
| Marke in `logout()` | **bleibt grün** — Doppelschutz: jede Ladefunktion prüft ohnehin selbst auf `null` nach 401 |

Die alte Werkzeugseite wird in Teil B übrigens *nicht* rot: Sie merkte sich `.main` **vor** dem
Warten und schrieb danach in ein Element, das es nicht mehr gab — harmlos, aus Zufall. Ihr Fehler war
nur R4 (leere Liste statt Fehler).

### Nicht erfasst: Neuzeichnen nach dem Speichern (R23)

Knöpfe, die nach `await api(PUT …)` direkt `renderDocuments()` usw. aufrufen, zeichnen ihre Seite
auch dann, wenn man inzwischen woanders ist. Gemessen: Ordner umbenannt, Antwort 2 s verzögert, auf
*Mein Konto* gewechselt → Adresse `#/konto`, im Bild die Dokumente, Menü „Dokumente". `seiteLaden`
kann das nicht abfangen, weil der Aufruf selbst frisch ist. Offen als R23 in der Bugliste.

## Zurückspielen, das mittendrin scheitert (R3, 25.09.2026)

### Was vorher geschah

`POST /api/backup/restore` ersetzte **zuerst** die Datenbank-Datei, schrieb dann die Dateien einzeln
und lud die Datenbank **erst ganz am Ende** neu. Brach es dazwischen ab (volle Platte, fehlende
Rechte), meldete die App „fehlgeschlagen" — auf der Platte lag aber schon die **neue** Datenbank, im
Speicher noch die **alte**, und die Dateien waren halb ersetzt. Welcher Stand danach galt, entschied
das Rennen: Speicherte das Autosave zuerst, die alte; startete der Server vorher neu, die neue.

Die Sicherheitskopie davor war ein **Klartext-Zip** (entgegen der Regel seit 09.09.2026) mit
Datenbank und den obersten Dateien aus `uploads/` — **ohne** Dokumente, Profilbilder und App-Icons.
Sie lag in `backups/`, wo nichts aufräumt: Lokal lagen dort 436 Stück aus Testläufen.

### Fünf Schritte, alles Scheiterbare zuerst

1. **Prüfen** — `datenbankVorbereiten()` (neu in `database/init.js`) öffnet die Datenbank aus der
   Sicherung und zieht sie hoch, *ohne* sie einzusetzen. `reloadFromFile()` benutzt dieselbe Funktion.
2. **Sicherheitskopie** — über dieselbe Dateiliste wie der Download (`sicherungsDateien()`, vorher
   standen die Teile doppelt), verschlüsselt wie die nächtliche, die `.env` nach derselben harten
   Regel nur in die verschlüsselte Fassung. **Ohne Kopie kein Weiter.**
3. **Bereitlegen** — alle neuen Dateien werden geschrieben, und zwar **neben ihr Ziel** in einen
   Arbeitsordner `.rueckspielen-…`. Nur innerhalb eines Dateisystems ist Umbenennen atomar und
   platzfrei; ein Sammelordner in `backups/` hätte auf einem eingehängten Volume erst beim Einsetzen
   versagt.
4. **Einsetzen** — nur noch `rename`. Jede Aktion steht in einem Protokoll, bei Fehler wird es
   rückwärts abgearbeitet. Die Datenbank-Datei kommt **zuerst**, die Datenbank im Speicher (`setDb`)
   **zuletzt** — dazwischen kann nichts sie erreichen.
5. **Aufräumen.**

Schritte 3–5 laufen ohne `await` am Stück, also ohne dass eine andere Anfrage oder das Autosave
dazwischenkommt. Ein zweites Zurückspielen, während das erste an der Sicherheitskopie schreibt, wird
mit 409 abgewiesen.

**Wohin die Sicherheitskopie kommt, hat Alex entschieden:** zu den nächtlichen Sicherungen, nach
deren Namensregel (`arbeitsdoku_backup_<Zeit>_vor-rueckspielen.adbk`). Die Aufräumregel in
`make-backup.js` erfasst sie damit ohne Änderung, und der Mini-PC holt sie mit ab. `make-backup.js`
selbst bleibt unberührt — die nächtliche Sicherung fasst man nicht nebenbei an.

**Bewusst nicht geändert:** Dateien, die nicht in der Sicherung stehen, bleiben liegen. Hätte das
Zurückspielen die Ablage ersetzt statt ergänzt, würde eine alte Sicherung ohne `documents/` die
ganze Dokumentenablage löschen. **Nicht abgedeckt:** ein Stromausfall mitten in Schritt 4 — dann
bleiben die Arbeitsordner liegen (Sicherungen überspringen sie), und der Weg zurück ist die
Sicherheitskopie.

### Test und die Frage, wie man „mittendrin" auslöst

`tests/rueckspielen-abbruch.js` löst die Fehler **echt** aus, ohne Hintertür im Code: fehlende
Schreibrechte genau dort, wo der jeweilige Schritt schreiben muss. Für den Abbruch in Schritt 4 wird
das Profilbild durch einen **schreibgeschützten Ordner gleichen Namens** ersetzt — einen Ordner darf
man unter Linux ohne Schreibrecht an ihm selbst nicht verschieben (sein `..` müsste geändert
werden). Das Bereitlegen gelingt also, das Einsetzen scheitert dort, nachdem Datenbank-Datei und
Dokumente schon getauscht sind. Ob es wirklich in Schritt 4 geschah, liest der Test aus dem
Server-Protokoll. Danach prüft er Dateien byte-genau, die Datenbank-**Datei** direkt mit sql.js und
die App — auch nach einem `SIGKILL`-Neustart, genau dem Fall, in dem früher der Zufall entschied.

**Gegenproben:** Der **alte Code** fällt an genau den erwarteten Stellen durch (Dateien gemischt,
Datei ≠ Speicher, nach Neustart der falsche Stand, keine Kopie am richtigen Ort). Einzeln
zurückgebaut: kein Zurückrollen, Speicher vor den Dateien getauscht, Weitermachen ohne Kopie, Kopie
ohne Dokumente, Kopie unverschlüsselt, kein Aufräumen, `.env` ohne Schlüssel — jede wird genau an
ihrer Stelle rot.

Eine Lehre aus den Gegenproben: Die Probe „kein Aufräumen" ließ Arbeitsordner in den Ablagen des
**Repos** liegen, und die nächste Probe wurde deshalb an zusätzlichen Stellen rot. Die Ablagen
gehören nicht dem Test — er räumt Reste früherer, abgebrochener Läufe jetzt beim Start weg.

## „Bestellt" mit Rückweg (R12, 25.09.2026)

Ein Tipp auf „Bestellt" war endgültig. Zurücknehmen ging nicht, bestellte Einträge löschen durfte
nur der Admin — ein Chef oder ein Mitarbeiter mit Bestellrecht saß nach einem Fehltipp am Handy
fest. Außerdem nahm `PUT /api/orders/:id` Änderungen an bestellten Einträgen an; die Oberfläche bot
das nicht an, die Schnittstelle schon.

**Entschieden (Alex):** keine Rückfrage vor „Bestellt" — wer zehn Positionen abhakt, würde zehnmal
gefragt —, dafür zwei Rückwege: „Rückgängig" in der Meldung (8 s) und dauerhaft „Doch nicht bestellt"
in den letzten Bestellungen (`DELETE /api/orders/:id/order`). Zurücknehmen darf, wer markieren darf
(`darfBestellen`, Rolle oder Einzelrecht). Bestellte Einträge sind **für alle** gesperrt (409), die
Meldung nennt den Weg.

Dafür kann `toast()` jetzt einen Knopf tragen (`aktion: { text, beiKlick }`). Dabei fiel auf: Eine
ausgeblendete Meldung war nur durchsichtig und nach unten geschoben und fing weiter Klicks ab — ein
Knopf darin wäre unsichtbar anklickbar gewesen. `.toast:not(.show)` hat jetzt `pointer-events: none`.

Eine Testfalle unterwegs: Der erste Testlauf klickte „Rückgängig", sobald die Meldung die Klasse
`show` hatte — da fährt sie aber noch 0,3 s ein, und der Knopf lag halb unter dem Bildschirmrand.
Gemessen (Position nach 100/400/1000 ms, `elementFromPoint`), dann erst gewartet. Die App war in
Ordnung; keine andere Meldung überschreibt den Knopf.

**Nachgeschärft (Alex):** Die Meldungen nennen Menge und Produkt — „50 Stk Wago 221-413 als bestellt
markiert" bzw. „… ist wieder offen" (`bestellBezeichnung()`); wer mehrere hintereinander abhakt,
sieht sonst nicht, worauf sich „Rückgängig" bezieht. Gemessen am Handy (390 px): Die Meldung bleibt
195 px schmal in der Mitte und bricht lange Namen um — sie überlappt die „Bestellt"-Knöpfe
(x 297–355) nie, auch nicht mit „Sicherungsautomat B16 Hager MBN116". Die schmale Breite kommt von
`left: 50%` (der verfügbare Platz ist die halbe Breite); das ist hier ein Vorteil und bleibt so.

**Ebenfalls nachgeschärft:** Bestellte Positionen hatten `opacity: 0.5` auf der ganzen Karte — der
neue Knopf „Doch nicht bestellt" sah dadurch ausgegraut aus, obwohl er funktioniert (ein Kind kann
nicht kräftiger sein als sein halbdurchsichtiges Elternteil). Jetzt ist nur `.order-content` blass,
der Knopf hat volle Stärke; auf dem Screenshot von Alex so abgenommen.

`tests/bestellt-rueckweg.js` (25 Prüfungen). **Gegenproben:** alter Code (12 rot), Sperre weg
(die Menge einer bestellten Position wurde durch eine Namensänderung des Chefs gelöscht), Zurücknehmen
ohne Rechteprüfung, Zurücknehmen einer offenen Position, Meldung ohne Knopf, Knopf für alle,
Meldung fängt Klicks ab — jede an ihrer Stelle rot.

## Meldungen auf Deutsch und ohne Innereien (R9 + R10, 25.09.2026)

### Umlaute (R10)

82 Ersatzschreibungen in Texten — Meldungen („Nur der Eigentuemer kann loeschen"), Audit-Texte,
die Test-Benachrichtigung („Push funktioniert auf diesem Geraet"), Server-Protokolle. Korrigiert
wurde **nur in Texten**: Kennungen bleiben, wie sie sind — Routen (`/api/backup/empfaenger`),
Datenfelder (`haendler`, `uebertrag`), Datenbank-Werte (`bestaetigt`), Klassen, Tabellen,
Funktionsnamen. Die umzubenennen hieße, Schnittstellen und gespeicherte Daten zu brechen.

`tests/umlaute-in-texten.js` hält den Stand. Es gibt keinen JS-Parser im Projekt, also zerlegt der
Test selbst: Texte (Zeichenketten, Vorlagen) ja, Kommentare und reguläre Ausdrücke nein, und Code in
`${…}` mit derselben Schleife wie Code außerhalb. Die erste Fassung tat das nicht — ein regulärer
Ausdruck mit Anführungszeichen innerhalb einer Vorlage (Abwesenheitskalender) ließ sie 4000 Zeichen
Code für einen „Text" halten. Deshalb prüft der Test sich selbst: an Beispielen (echte Wörter wie
„neue", „aktuell", „zuerst" und Kennungen dürfen nicht anschlagen) und daran, dass kein gefundener
„Text" nach Code aussieht. Gegenprobe mit dem alten Stand: 16 Funde.

### Fehlermeldungen (R9)

* **Hochladen** (Dokumente, Logo, App-Icon) reichte den Rohtext weiter — gemessen im alten Stand:
  „EACCES: permission denied, open '/home/alex/…/storage/documents/…'". Jetzt übersetzt
  `fehlertext.js` (eine Stelle für alle Upload-Routen und das Zurückspielen); der Rohtext geht ins
  Server-Protokoll.
* **Fehlerbehandler:** zu große Anfrage → 413 mit Erklärung, kaputtes JSON → 400; vorher beides
  „Interner Serverfehler" (500).
* **Feldnamen:** „Die persönliche Notiz ist zu lang (höchstens 2000 Zeichen)." statt
  „Feld 'personal_note' …"; ebenso bei den Großhändler-Angaben. „Mitarbeiter nicht gefunden".
* **Oberfläche:** `toast()` übersetzt rohe Programm- und Netzfehler zentral („Cannot read
  properties of null …" → „Unerwarteter Fehler. Bitte die Seite neu laden."), statt dreißig
  Fangstellen einzeln anzufassen. Nach dem Abmelden wird so eine Meldung ganz unterdrückt — die
  Anmeldeseite erklärt schon, was los ist. Push-Fehler des Browsers (z. B. Brave „push service
  error") bekommen deutsche Erklärungen (`pushFehlerText`).

### Ein Fund am Rand: die feste Dateiliste im Deploy

`deploy.sh` kopierte aus dem Projektstamm nur Dateien einer **festen Liste** — mit dem Hinweis,
jede neue Datei nachzutragen, und einem Verweis auf eine Prüfung `--pruefen`, die es nicht mehr gab.
`fehlertext.js` wäre nicht auf den Server gekommen; der Dienst hätte nach dem Neustart nicht mehr
gestartet, bemerkt erst am `/health`, wenn Prod schon steht. Die Liste wird jetzt aus Git abgeleitet
(`git ls-files -- ':(glob)*.js'`): alle versionierten `.js` im Stamm.

### Messfalle: `cp` fragt nach

Die erste Gegenprobe zu R10 lief still auf dem neuen Code: `cp` ist in der Shell auf `cp -i` gelegt
und überschreibt aus einem Skript heraus nichts. Gegenproben tauschen Dateien deshalb per Skript und
belegen die Wiederherstellung per Prüfsumme.

`tests/meldungen-deutsch.js` (16 Prüfungen) löst jede Fehlerart echt aus — die Schreibrechte-Probe
mit einem schreibgeschützten Dokumentenordner. **Gegenproben:** alter Code (alle Server-Prüfungen
rot, die Oberfläche bricht ab, weil `pushFehlerText` fehlt), Fehlerbehandler ohne 413/400, interner
Feldname, Upload-Rohtext, Meldung ohne Übersetzung, Meldung nach dem Abmelden, Push unübersetzt —
jede an ihrer Stelle rot.

## Lesen können, nichts verlieren (R14, R20, R24 — 25.09.2026)

* **R14 — Meldungen:** Vorher immer 3 s. Jetzt `meldungsDauer()`: nach Textlänge, Fehler 6–15 s;
  wer eine Dauer vorgibt (Bestellt 8 s, Zurückspielen 15 s), behält sie. Antippen schließt.
* **R24 — Sprechblasen** (Hinweis Alex: die Erklärung am „!" war zu kurz lesbar). Nach langem Druck
  bleibt sie jetzt bis zum nächsten Antippen oder Scrollen; das feste 4-s-Ausblenden ist weg — und
  mit ihm ein Fehler: Der Zeitgeber wurde nie zurückgesetzt und schloss auch eine NEUERE Sprechblase,
  wenn man zweimal kurz hintereinander hielt. Am Rechner öffnet das „!" eine Erklärung **zum Lesen**
  (`showTooltipZumLesen`): Sie nimmt die Maus an, man kann auf sie hinübergleiten, beim Verlassen
  0,4 s Kulanz (`tooltipVerlassen`). **Nur dort** — die Eintrags-Sprechblasen wandern mit dem Zeiger
  und könnten am Bildschirmrand unter ihn rutschen; dort bleiben sie für die Maus durchlässig.
* **R20 — Klick daneben:** Es waren nicht nur der Eingabedialog, sondern **14 Fenster** (Produkt
  anlegen, Mitarbeiter, Freigaben …). `klickDanebenSchliesst(overlay, schliessen)` merkt sich, ob der
  Mensch etwas geändert hat (`input`/`change` — was das Programm vorbelegt, zählt nicht). Dann bleibt
  das Fenster offen, mit einem Hinweis.

**Zwei Messfallen im eigenen Test, beide erst durch Gegenproben sichtbar.** Unter dem Warnzeichen
liegt der Eintragsblock mit seiner eigenen Sprechblase: Die Prüfung „eine Sprechblase ist offen" war
auch ohne Reparatur grün — der Test prüft jetzt den **Inhalt** (ArbZG). Und nach dem ersten Fehlschlag
klickte der Test einen Knopf, den es dann nicht mehr gab, und brach ab. Außerdem lag meine erste
Erklärung für einen roten Kulanz-Test daneben: Nicht die Sprechblase lag unter dem Zielpunkt, sondern
der Eintragsblock (nachgemessen mit `elementFromPoint`).

`tests/lesbar-und-sicher-ui.js` (19 Prüfungen). **Gegenproben:** alter Code (9 rot), feste 3 s,
Antippen schließt nicht, Klick daneben trotz Eingabe, 4-s-Ausblenden, Antippen irgendwo schließt
nicht, sofortiges Schließen am Rechner, Sprechblase nimmt die Maus nicht an — jede an ihrer Stelle rot.

**Nachtrag — Meldungen oben (Entscheidung Alex).** Die volle Suite fiel an `abschluss-ui-knoepfe`: Nach
„Speichern abgelehnt" klickte der Test „Löschen", aber der Knopf lag nach dem Scrollen am unteren
Rand — genau unter der Fehlermeldung, die jetzt länger steht. Der Klick schloss nur die Meldung
(gemessen: Knopf bei y 1246, Meldung y 862–918 im 950 hohen Fenster). Kein Testfehler, sondern eine
echte Folge von R14. Alex hat entschieden: Meldungen erscheinen **oben unter der Kopfleiste**. Der
Test ist damit ohne Änderung grün; `lesbar-und-sicher-ui` prüft die Lage ausdrücklich (Gegenprobe:
Meldung unten → rot). Am Handy verdeckt sie oben keinen Knopf in der Mitte (gemessen).

## Zeitfeld: Antippen öffnet wieder die Uhr (R25, 25.09.2026)

Alex bemerkte am Handy: Antippen von „Von"/„Bis" öffnete nicht mehr die Uhr, sondern markierte nur
Stunde oder Minute; die Uhr gab es nur noch über das Symbol rechts. **Die App war es nicht** — das
Zeitfeld ist seit März unverändert, kein Handler unterdrückt den Tipp. Belegt wurde das mit einer
Testseite ohne App: dasselbe Verhalten in Chrome 154 auf Android 10.

Der erste Test der Abhilfe auf claude.ai scheiterte mit „SecurityError" — dort liegt eine Seite in
einem **fremden Rahmen**, aus dem Chrome das Öffnen der Uhr per `showPicker()` verbietet. Fast hätte
das zur Entscheidung für eine Zahlentastatur geführt. Erst eine Testseite auf dem eigenen Server
(eigene Skriptdatei wegen `script-src 'self'`, danach wieder entfernt) zeigte: Ohne Rahmen öffnet
`showPicker()` die Uhr zuverlässig.

Umsetzung in `app-1-core.js`: ein seitenweiter Klick-Handler ruft bei Uhrzeit-Feldern `showPicker()`
auf — **nur** auf Android mit Chrome-artigem Browser (`UHR_HILFE`) und **nur** bei Berührung
(`istMauszeiger()`). iPhone, Firefox und Rechner bleiben unberührt. `tests/uhr-hilfe-ui.js` ersetzt
`showPicker` durch einen Zähler — ein Test-Chrome kann keine Uhr zeigen, aber er sieht, wann die App
sie aufruft. Gegenproben: Hilfe aus, ohne Einschränkung auf Android-Chrome, auch bei Maus, jedes Feld
statt nur Zeitfelder — jede an ihrer Stelle rot.

**Nachtrag 26.09.2026 — Datum:** Dieselbe Umstellung betrifft Datums- und Monatsfelder (Hinweis Alex).
Die Uhr-Hilfe erfasst jetzt `UHR_HILFE_ARTEN` = time, date, month, week, datetime-local — sie hängt an
der Feldart, nicht an einzelnen Feldern, und greift so in allen 21 Datums- und 2 Monatsfeldern und im
Eingabedialog mit Datum. Test um Datum und Monat erweitert (11); Gegenprobe „nur Uhrzeit" → genau
die beiden neuen Prüfungen rot.

## Kleine Sackgassen (R18, R13, R7, R8 — 26.09.2026)

* **R18 — Downloads.** Das Muster „Datei-Adresse erzeugen, Link klicken, freigeben" stand an zehn
  Stellen; an sieben wurde sofort freigegeben (Safari auf dem iPhone kann den Download dann still
  abbrechen), an drei nach 5 s. Jetzt `dateiHerunterladen()` / `dateinameAus()` in `app-1-core.js`,
  Freigabe nach 60 s; der Test prüft, dass `.download =` nur noch dort steht. Dabei gefunden: Der
  **Sicherungs-Download** speicherte jede Antwort — auch eine Fehlermeldung des Servers — als Datei
  mit dem Namen einer Sicherung und meldete „Backup heruntergeladen". Jetzt wird die Antwort geprüft.
  Außerdem trug der Protokoll-Export das UTC-Datum im Namen (zwischen 0 und 2 Uhr der Vortag) — die
  Gegenprobe lief zufällig nach Mitternacht und zeigte genau das.
* **R13 — Zwei-Faktor-Schritt abgelaufen.** Der Server kennzeichnet ihn (`ZWISCHENSCHRITT_ABGELAUFEN`),
  die Oberfläche kehrt mit Hinweis zur Passworteingabe zurück. `api()` gibt Kennungen des Servers
  seitdem allgemein als `err.code` weiter.
* **R7 — Abmelden hing.** `navigator.serviceWorker.ready` wartet ewig, wenn der Hintergrunddienst
  nicht läuft. `hintergrunddienst()` wartet höchstens 3 s; Abmelden zusätzlich höchstens 5 s auf den
  Push-Abbau (Doppelschutz: die Gegenprobe ohne die 3-s-Grenze wird rot, weil Abmelden dann 5 s braucht).
* **R8 — Rechte.** Anmelde-Antwort und `refreshUser()` zählten Rechte einzeln auf; es fehlten
  `can_products_add` bzw. `can_order` und die Lagerrechte. Beide leiten jetzt alle `can_*` aus dem
  Objekt ab — dasselbe Muster wie bei den „parallelen Listen".

`tests/kleine-sackgassen-ui.js` (15). **Gegenproben:** alter Code (12 rot), und jeder Teil einzeln —
Teilliste, aufgezählte Rechte, Server ohne Kennung, Oberfläche bleibt stehen, sofort freigeben,
Sicherung ohne Prüfung, Dienst ohne Zeitgrenze — jede an ihrer Stelle rot.

## Gemeinsame Notizen — Etappe A (ab 26.09.2026)

Alex' Wunsch: Notizen gleichzeitig bearbeiten wie in einem Etherpad — wer drin ist, eine Farbe je
Person, fremde Cursor, alles live, dazu Fett/Kursiv/Unterstrichen, Aufzählungen und Checklisten.
Es ersetzt die Bearbeitungs-Sperre und damit R11. Geplant in drei Etappen mit je eigenem Deploy:
A Live-Notizen, B Drucken und „Speichern als" (PDF/DOCX/ODT/eigene Notiz), C benannte Gäste mit
eigenem Link und Passwort.

**Schritt 1 — Probe am Handy, bevor gebaut wird.** Der bekannte Schwachpunkt eines formatierbaren
Schreibfelds ist die Android-Tastatur (Wortvorschläge, Autokorrektur, Wischen), besonders wenn
jemand anderes gleichzeitig in derselben Zeile schreibt. Eine Probeseite mit dem echten Bündel und
einem nachgestellten Kollegen, der Wörter an den Anfang der eigenen Zeile setzt, hat Alex auf
seinem Handy ausprobiert („Sieht gut aus“). Ein Test-Browser kann das nicht nachstellen.

**Schritt 2 — das Bündel** (`scripts/kollab-buendeln.js`, `public/vendor/kollab.*`, Herkunft in
`public/vendor/HERKUNFT.md`). Drei Dinge, die dabei herauskamen:

* **Kein Herunterübersetzen.** Mit `target: chrome90/safari14` bricht esbuild ab — `lib0` lässt sich
  nicht zurückschreiben. Das Bündel bleibt beim Stand der Quellen.
* **Datei statt Text als Einstieg — und warum die Probe größer war.** Das Bündel der Probe war
  8,6 KB größer als das im Projekt, bei byte-gleichen Eingaben (verglichen über die esbuild-Metadaten).
  Ursache: Der Probe-Ordner hatte `"type": "commonjs"` in seiner `package.json`; esbuild packt dann
  jedes Paket in eine Hülle, die erst beim ersten Zugriff lädt. Im Projekt (ohne `type`) entfällt
  sie. Der Bibliothekscode ist derselbe; die Probeseite wurde danach mit dem Projekt-Bündel neu
  aufgespielt, damit Probe und App wirklich dieselbe Datei laden.
* **Ein gemeinsames Dokument beginnt nie leer.** Quill hat immer einen Schluss-Zeilenumbruch, den
  y-quill bei einem leeren Dokument nicht kennt. Formatiert jemand die letzte Zeile (Checkliste),
  zeigt die Gegenseite eine Leerzeile zu viel — gemessen im ersten Testlauf. Mit einem Zeilenende
  als Startinhalt stimmen beide Seiten überein. **Schritt 3 legt jede Notiz auf dem Server so an.**

`tests/kollab-buendel.js` (18): Bündel passt zu den Paketen, Lizenzen vollständig und erlaubt, lädt
nur bei Bedarf und nur einmal unter der Sicherheitsregel, zwei Felder gleichen sich ab (Text,
Checkliste, fremder Cursor), Server und Browser verstehen dieselben Änderungen, Funkloch beim ersten
Öffnen. Der Funkloch-Teil umgeht den Hintergrunddienst der App — sonst holt der die Datei am Test
vorbei, und die Prüfung wäre aus dem falschen Grund grün (erster Lauf: genau das).
**Gegenproben** (7, jede an ihrer Stelle rot, per Prüfsumme zurückgesetzt): Bündel von Hand
angefasst, `eval` im Bündel, Cursor-Modul nicht registriert, Lader ohne erneuten Versuch, Lader ohne
Doppel-Schutz, Lizenzblock fehlt, Dokument beginnt leer.

**Schritt 3 — der Server** (`notizen-live.js`, `notiz-dokument.js`, `routes/notes.js`). Der Inhalt
einer Notiz ist jetzt ein Yjs-Dokument (`notes.ydoc`); `body` (Klartext) und `body_delta`
(Formatierung) leitet der Server beim Speichern ab — für Suche, Vorschau, Meldungstext,
Datenauskunft. Jede geöffnete Notiz ist ein „Raum" mit dem Dokument, der Anwesenheit (Cursor) und
den Verbindungen: ein Ereignisstrom je Notiz (`GET /api/notes/:id/live?ticket=…`, nur mit dem
60-Sekunden-Ticket), Änderungen und Cursor als kurze POSTs. Kein WebSocket — SSE ist durch Caddy und
das Freifunk-Netz der Zweitanlage erprobt.

* **Die Tür ist der POST, nicht der Strom.** Das Schreibrecht wird bei jeder Änderung neu aus der
  Datenbank geholt. Rechte-Änderungen (Freigaben, „Freigabe verlassen", Löschen, Ausstellen) werfen
  zusätzlich sofort raus bzw. melden Schreiben ↔ Lesen — damit auch das Mitlesen endet.
* **Name und Farbe am Cursor setzt der Server.** Sonst könnte sich jemand im Anwesenheits-Update als
  ein anderer ausgeben; ebenso gehört eine Clientnummer einer Verbindung und lässt sich nicht von
  einer anderen Person übernehmen.
* **Alter Programmstand:** Ein noch nicht aktualisiertes Handy würde beim Speichern Klartext über die
  Formatierung aller schreiben. `PUT` mit `body` und die frühere Sperre antworten deshalb mit 409
  `APP_VERALTET` und dem Hinweis, neu zu laden. Das Lösen der Sperre wird harmlos bestätigt.
* **Speichern** nach 1,5 s Ruhe, spätestens alle 10 s; beim Beenden des Servers (SIGTERM, Deploy)
  sofort. Nur eine inhaltliche Änderung setzt `updated_at`/`updated_by` — Hineinschauen nicht.
* **Meldung je Bearbeitungsrunde** (vorgezogen aus Schritt 5, weil sie im Server sitzt): Eine Runde
  endet beim Verlassen oder nach 2 Minuten Ruhe; gemeldet wird nur bei echter Änderung (auch
  Umbenennen) und nur an die, die nicht drin sind. Die alte Unterregel „Leerzeichen am Rand zählen
  nicht" gibt es nicht mehr — sie kam vom Trimmen beim Speichern; wer live ein Leerzeichen tippt,
  hat etwas geändert.
* **Umstellung alter Notizen** beim ersten Start (`ensureNotizLiveSchema`, auch im Rückspiel-Pfad):
  Klartext → Dokument, `body` zeichengleich, `updated_at` unberührt. Am Prod-Klon: 13 von 13
  zeichengleich, zweiter Start stellt nichts mehr um.
* **Weitergeben ist eine Kopie** (war es schon immer — das Original bleibt beim Absender). Die Kopie
  entsteht jetzt aus der Formatierung des Stands von eben, nicht aus den Bytes des Originals: Sie soll
  dessen Bearbeitungsverlauf nicht mitschleppen.

Zwei Messfallen beim Bau: Der erste Probelauf der Umstellung lief auf einer schon umgestellten
Datei, weil `cp` nachfragte statt zu überschreiben (die Meldung „13 umgestellt" fehlte — daran fiel
es auf). Und in Node ≥ 19 landete ein vom Server beendeter Ereignisstrom im Verbindungs-Pool und riss
eine spätere Anfrage mit („socket hang up"); die Test-Hilfe öffnet Ströme deshalb mit eigener
Verbindung, wie ein Browser.

`tests/notizen-live.js` (34, mehrere „Geräte" über `tests/hilfen/notiz-live-geraet.js`),
`tests/notizen-live-prodklon.js` (10), `tests/push-targeting.js` (Notiz-Teil auf Runden umgestellt,
45). **Gegenproben** (15): Schreibrecht nicht geprüft, Name vom Browser übernommen, fremde
Clientnummer übernehmbar, Freigabe-Änderung ohne Abgleich, Ausstellen ohne Rauswurf, SIGTERM ohne
Sichern, alter Speicherweg offen, Speichern setzt immer den Zeitstempel, Umstellung setzt Zeitstempel,
Meldung auch an Anwesende, kein Zeilenende nach Komplett-Löschen, Binärdokument in der Liste, Kopie
aus dem gespeicherten Stand, Runde endet nie durch Ruhe — jede an ihrer Stelle rot. Die Probe „SIGINT
ohne Sichern" bleibt grün: Der Test beendet mit SIGTERM wie systemd; SIGINT ist nur Strg+C am Rechner.

**Für Schritt 4 festgehalten:** Nach einer abgewiesenen Änderung (403) muss der Browser neu öffnen —
er hat sie bei sich schon eingetragen. Fremde Cursor: quill-cursors legt sie auf Touch-Geräten mit
`z-index:-1` hinter die Karte (Alex sah auf der Probeseite keinen Cursor); eigene Regel +
Namensfähnchen per `toggleFlag`, Test über Bildpunkte statt Elementzahl.

**Schritt 4 — die Oberfläche** (`public/js/notiz-sitzung.js`, Übersicht in `app-8-comm-init.js`).
Zwei Wege zu einer Notiz, auf Alex' Frage hin bewusst getrennt: **Vorschau** in der Übersicht
(Karte antippen, formatiert aus `body_delta`, man ist NICHT drin) und **Öffnen** (`#/notes/<id>`,
gemeinsame Bearbeitung). „← Fertig" — wie jeder Seitenwechsel — beendet die Sitzung und führt an
dieselbe Stelle der Übersicht zurück. Neue Notiz: nur Titel/Projekt, dann öffnet sie sich.

* **Leerzeile zu viel am Ende**, gesehen im ersten Blick mit zwei Browsern: Das Schreibfeld wurde an
  das (noch leere) Dokument gebunden, bevor der Stand vom Server kam; Quills eigenes Schluss-
  Zeilenende blieb dann zusätzlich stehen, und Tom tippte in eine Zeile, die es im Dokument nicht
  gab. Angebunden wird jetzt erst mit dem Stand. Der Test vergleicht Schreibfeld und Dokument
  Zeichen für Zeichen — die Textprobe allein fasst Leerzeilen zusammen und hätte es nicht gesehen.
* **Fremde Cursor** (Fund von der Probeseite): eigene Stilregel gegen `z-index:-1` auf Touch-Geräten,
  Namensfähnchen per `toggleFlag` 3 s nach jeder Bewegung. Geprüft über Bildpunkte in der Farbe der
  Person — mit Touch-Emulation, genau dem Fall, der am Handy fehlte.
* **Übersicht frischt leise auf** (`notizenAuffrischen`): Wer tippt, löst alle paar Sekunden eine
  Speicher-Meldung aus; der frühere volle Neuaufbau mit Ladekreisel hätte im Sekundentakt geflackert.
* **Hintergrund**: nach 1 Minute aus der Notiz abgemeldet (sonst zählt man als „drin" und bekommt keine
  Meldungen), beim Zurückkommen von selbst wieder verbunden. **Funkloch**: Änderungen bleiben in der
  Warteschlange und auf dem Gerät (`localStorage`), Anzeige „Keine Verbindung – wird nachgereicht",
  neuer Versuch alle 3 s; „Fertig" fragt dann nach; beim nächsten Öffnen wird nachgereicht.
* **Nach einer Abweisung** (Leserecht, zu groß, beschädigt) öffnet der Browser die Notiz neu — er hat
  die Änderung bei sich schon eingetragen und muss den Stand des Servers übernehmen.
* Die Sperre ist aus dem Browser verschwunden (`acquireLockAndEdit`, Freigabe beim Schließen per
  synchronem XHR — R11 gibt es damit nicht mehr).

`tests/notizen-live-ui.js` (32, drei Browser mit Touch). **Gegenproben** (13): Cursor-Regel fehlt,
kein Fähnchen, Feld vor dem Stand angebunden, voller Neuaufbau, kein Abmelden im Hintergrund, nichts
auf dem Gerät gesichert, nicht nachgereicht, Rückweg ohne Scrollposition, Vorschau ohne `esc()`,
Knopfleiste bei Leserecht, Rauswurf ohne Rückweg, alte Funkloch-Anzeige, Vorschau tritt bei — jede
an ihrer Stelle rot. Die Probe „voller Neuaufbau" blieb zunächst GRÜN: Tom öffnete die Übersicht
erst, als Anna schon drin war — „Anna ist drin" kam mit dem ersten Laden, aufgefrischt wurde gar
nichts. Reihenfolge im Test umgedreht, danach rot. `tests/seite-laden-ui.js` kennt die neue Seite (79).

**Schritt 5 — Meldungen und Zähler.** Die Meldung je Bearbeitungsrunde kam schon mit Schritt 3. Neu
ist der **Zähler je Notiz**: Wer in einer Notiz ist, sieht die Änderungen der anderen live — nach
jeder Speicherung zeigte der Menüpunkt trotzdem „1", weil der Zähler nur „Notizen insgesamt gesehen"
kannte. `note_gesehen (user_id, note_id, gesehen_am)` hält fest, bis zu welchem gespeicherten Stand
(`updated_at`, nicht „jetzt") jemand die Notiz gesehen hat: beim Öffnen, bei jeder Speicherung für
alle Anwesenden, beim Verlassen. Zähler (`routes/badges.js`) und Kennzeichnung „ungelesen" in der
Liste berücksichtigen ihn in beiden Zweigen (eigene und geteilte Notizen).

**Zwei Fehler in meinen eigenen Gegenproben**, beide erst beim Nachhaken gefunden:
* Die Probe „Merker aus" entfernte das SQL-Stück, ließ aber seinen Parameter stehen → die Abfrage
  stürzte ab. Das Probe-Skript zählte nur ✗-Zeilen und meldete „grün"; im Oberflächen-Test lieferte
  der Zähler einen Serverfehler statt einer Zahl und blieb deshalb bei 0. Seitdem wertet das
  Probe-Skript den Exit-Code aus, und der Merker wird mit `(? IS NULL OR 1 = 1)` abgeschaltet —
  gleiche Parameterzahl, immer wahr.
* Die Prüfung bei Anna (Eigentümerin) maß nichts: Anna tippte im Test NACH Tom, beim Speichern stand
  sie als Bearbeiterin drin, und eigene Änderungen zählen nie. Tom tippt jetzt zuletzt; der Test
  prüft zusätzlich, dass wirklich er als Bearbeiter gespeichert ist.
Danach: beide Zweige einzeln ohne Merker → jeweils rot (`push-targeting` für geteilte,
`notizen-live-ui` für eigene Notizen), Speichern ohne Merker → rot.

**Nachgezogen: Was darf in einer Notiz stehen?** Der Server prüfte, WER schreiben darf, nicht WAS.
Ein manipulierter Browser (in Etappe C auch ein Gast) hätte Bilder, Links, fremde Datenfelder im
Dokument oder unbekannte Listenwerte schicken können — bei allen anderen im Schreibfeld. Jetzt wird
jede Änderung zuerst an einer Kopie ausprobiert (`zulaessig()` in `notiz-dokument.js`): nur Text,
fett/kursiv/unterstrichen, die vier Listenarten; `false` als „nicht formatiert" ist erlaubt
(entfernte Formatierung speichert Yjs gar nicht erst). Zurücknehmen lässt sich in Yjs nichts, darum
die Kopie. Anwesenheits-Meldungen sind auf 4 KB begrenzt. Geprüft außerdem: fett → entfetten → fett
über die Knopfleiste, und **Einfügen aus Word/Webseite** (Überschrift, Link mit `javascript:`, Farbe,
Bild mit `onerror`, Tabelle) — ankommen darf nur Text mit erlaubter Formatierung, und der Server weist
nichts ab. Die Prüfung „weist nichts ab" vergleicht die SITZUNG vor und nach dem Einfügen: Nach einer
Abweisung öffnet die App neu, und „offen" wäre auch die neue Sitzung (Gegenprobe ohne Format-Liste
hat das gezeigt). Tests: `notizen-live` 36, `notizen-live-ui` 37.

**Schritt 6 — Aufräumen.** README-Abschnitt „Notizen" neu (Vorschau/Öffnen/Fertig, Meldung je Runde,
Zähler, Technik; dabei ein echter Name aus dem Beispiel-Text entfernt — das Repo ist öffentlich).
R11 in der Bugliste erledigt (es gibt keine Sperre mehr). Nebenbefund vom Prod-Klon abgeräumt: Die
Umstellung entfernt Freigaben, Angebote und Gesehen-Merker zu Notizen, die es nicht mehr gibt (am
Klon 18 Einträge, echte Freigaben unverändert — `notizen-live-prodklon`), und das Löschen einer Notiz
nimmt sie ausdrücklich mit. Ehrlich festgehalten: Die Gegenprobe ohne dieses Mitlöschen bleibt grün,
weil `ON DELETE CASCADE` heute greift; die Waisen am Klon stammen aus früherer Zeit. Das Mitlöschen
ist ein Netz, keine Reparatur.

**Randfälle vor dem Deploy** (27.09.2026, nachts):
* **Sicherung zurückspielen, während jemand in einer Notiz ist.** Der Raum hält das Dokument aus der
  alten Datenbank im Speicher; der nächste Speichervorgang hätte die zurückgespielte Notiz
  überschrieben. `einsetzen()` ruft jetzt vor dem Tausch `allesVerwerfen()` auf: alle Räume zu, ohne
  Speichern, ohne Meldungen, alle Drinnen mit „Sicherung zurückgespielt" hinaus. Zusätzlich sperrt
  `raum.verworfen` das Speichern. Gemessen: Solange das Verwerfen VOR dem Tausch läuft, genügt die
  Reihenfolge allein (Probe ohne Sperre grün — der letzte Speichervorgang trifft die alte Datenbank);
  mit umgedrehter Reihenfolge hält nur die Sperre (ohne sie rot). `tests/notizen-live-zurueckspielen.js`
  (6), Quelltext-Prüfung der Reihenfolge in `einsetzen()`.
* **Zu große Änderung** (riesiger eingefügter Text): Die Grenze je Sendung (96 KB) lag über der
  JSON-Grenze des Servers (100 KB nach Base64 ≈ 75 KB) — die Anfrage scheiterte schon vorher, ohne
  Kennung, und der Browser hätte sie endlos wiederholt („Keine Verbindung"). Jetzt 70 KB, die 413-
  Antwort trägt `ZU_GROSS`, und der Browser prüft vorab. Jeder der beiden Wege allein genügt (Probe
  ohne Vorprüfung grün), ohne beide rot.
* **Neuladen direkt nach dem Tippen** („Jetzt aktualisieren", Tab zu): Das gebündelte Sichern auf dem
  Gerät wartet 300 ms — genau die letzten Tastendrücke gingen verloren, wenn gleichzeitig eine Sendung
  unterwegs war. `pagehide` sichert jetzt sofort; kommt die Seite aus dem Zwischenspeicher zurück
  (`pageshow`), baut die Editor-Seite die Sitzung neu auf. Test mit künstlich verzögerten Antworten;
  ohne `pagehide` rot.
* Das eigene zweite Fenster (Handy + Rechner) steht in der Anwesenheit nicht als fremde Person.
* **Die Prod-Klon-Vorlage war schon umgestellt.** Ältere Prod-Klon-Tests starten den Server direkt auf
  `/tmp/prodklon.db`; nach meinem Lauf der Bestandstests enthielt die Vorlage bereits umgestellte
  Notizen. `notizen-live-prodklon` nahm „schon umgestellt" als bestanden — seine späteren Läufe
  prüften die Umstellung also gar nicht mehr. Jetzt baut er sie auf einer Kopie zurück (Spalten
  entfernen, SQLite 3.49 kann das) und prüft immer von vorn; liegt die rohe Produktivkopie vor, auch
  an ihr: 13 Notizen zeichengleich, 17 verwaiste Freigaben abgeräumt, 55 echte unverändert (15).
* **Beim Durchlesen gefunden: Das Handy sicherte im Funkloch den GANZEN Stand der Notiz.** Wird
  inzwischen eine Sicherung zurückgespielt, hätte es beim nächsten Öffnen den alten Inhalt wieder in
  die zurückgespielte Notiz gemischt. Jetzt wird nur die Warteschlange (die unversandten Änderungen)
  gesichert; eine Offline-Änderung, deren Vorgänger im Dokument des Servers fehlen, hält Yjs zurück.
  `notizen-live-zurueckspielen` stellt es mit echten Yjs-Bytes nach — und zeigt zum Vergleich, dass
  der ganze Stand „nach der Sicherung" wieder hineingemischt hätte (9).
* **Am Bildschirmfoto für die Präsentation gefunden: Bei Leserecht war die Knopfleiste sichtbar.** Die
  Stilregel `display:flex` der Leiste überstimmte das `hidden`-Attribut; der Test prüfte nur das
  Attribut und war deshalb grün. Jetzt eine eigene `[hidden]`-Regel, und der Test prüft
  `checkVisibility()` (Probe ohne die Regel → rot). Tippen konnte Rita auch vorher nicht — das Feld
  war gesperrt —, aber die Leiste versprach etwas, das nicht ging.
* **Namensfähnchen stapeln sich** (Alex am Bildschirmfoto: zwei Cursor an derselben Stelle, ein
  Fähnchen verdeckte das andere). `faehnchenStapeln()` verschiebt überlappende sichtbare Fähnchen über
  `margin-top` (quill-cursors setzt bei jeder Bewegung Position und Breite neu, den Außenabstand nicht)
  nach oben; in der ersten Zeile, wo oben kein Platz ist, weichen sie unter die Zeile aus. Neu
  gerechnet nach jeder Bewegung, jedem Tippen, Ein-/Ausblenden und `resize`. Zwei Messfallen dabei:
  Ein Ausschnitt-Foto (`screenshot({clip})`) vergrößert die Seite kurz (captureBeyondViewport) — das
  löste ein `resize` aus, und das Foto zeigte den Zwischenzustand; echte Größenänderungen (Tastatur,
  Drehen) stapeln korrekt, geprüft im Nachbau. Die Farbprüfung nimmt jetzt ein Foto des sichtbaren
  Bereichs und schneidet zu. Und „mitten im Text" suchte „Dosen" mit großem D — der Text hat
  „Abzweigdosen", der Test stand also auch dort in der ersten Zeile. Gegenproben: ohne Stapeln rot,
  ohne Ausweichen nach unten rot.
* **Haken „Namensschilder anzeigen"** (zuerst „Namen am Cursor zeigen" — Alex: Der Cursor bleibt ja sichtbar, es geht nur ums Schild; Alex: die Fähnchen verdecken kurz den Text dahinter; halb
  durchsichtig hätte Name und Text beide schlechter lesbar gemacht). Aus = nur der farbige Strich,
  gemerkt je Gerät (`localStorage`, Standard an). Test aus Ritas Sicht: Haken aus → kein Fähnchen
  sichtbar, beide Striche am Bildpunkt zu sehen (an VERSCHIEDENEN Stellen — an derselben lagen die
  zwei 2-px-Striche übereinander und der Test zählte einen), nach Neuladen weiter aus, wieder an →
  Fähnchen da. Gegenproben: Regel ohne Wirkung / nicht gemerkt → rot. `notizen-live-ui` 45.
* **Nah beieinander, nicht an derselben Stelle** (Alex' Frage): Das Stapeln prüft die tatsächlichen
  Flächen der Schilder, nicht die Cursor-Stellen — zwei Zeichen auseinander stapeln sie sich ebenso,
  weit auseinander in derselben Bildschirmzeile wird nichts verschoben. Beides jetzt getestet. Die
  Probe „in derselben Zeile immer stapeln" blieb zweimal grün, beide Male wegen des Tests: erst lag
  Toms Stelle nach dem Zeilenumbruch eine Bildschirmzeile tiefer, dann bewegte sich Anna nicht (sie
  stand schon dort) — ihr Schild erschien nie, es gab nichts zu stapeln. Die Stelle wird jetzt in der
  Ansicht gemessen, und die Prüfung verlangt beide Schilder sichtbar. Danach rot.

**Deploy Etappe A (27.09.2026, `3938112`, Cache 428).** Vorher: zwei Vollsicherungen (11:06 und
12:30, je auf VPS, Mini-PC und Laptop mit gleicher Prüfsumme, Rückspielprobe auf dem Mini-PC), frischer
Prod-Klon, Tabellenvergleich vor/nach Umstellung (47 von 49 Tabellen zeilen- und spaltengleich,
entfernt nur 17 Freigaben + 1 Angebot zu gelöschten Notizen), Durchgang mit allen 12 aktiven Konten
(jede Notizliste mit Rechten zeichengleich) und einer echten Notiz im Browser, komplette Suite 240/240
gegen den frischen Klon. Nachher dieselbe Prüfung an der echten Produktivdatenbank: identisches Bild,
13 von 13 Dokumenten enthalten exakt den bisherigen Text.

**Rückweg, falls nötig:** Code auf `vor-notizen-live-deploy` zurück ist mit der umgestellten Datenbank
verträglich (der alte Stand ignoriert `ydoc`/`body_delta`/`note_gesehen`). ABER: Wird später wieder der
neue Stand eingespielt, gewinnt das dann veraltete `ydoc` über inzwischen geänderten Klartext — vorher
`UPDATE notes SET ydoc = NULL` (die Umstellung baut die Dokumente dann neu aus `body`), oder die
Sicherung `arbeitsdoku_backup_20260927-123033.adbk` zurückspielen.


## Gemeinsame Notizen — Etappe B: Drucken und „Speichern als" (27.09.2026)

Alex' Wunsch: ein Druckknopf, der nur die Notiz im jetzigen Zustand druckt, und „Speichern als: PDF /
DOCX / ODT / Stand als eigene Notiz". Entschieden (Alex): Kopf = Titel + kleine Stand-Zeile, kein
Firmenname; die Kopie darf jeder mit Zugriff anlegen (auch Leserecht), sie gehört dem, der klickt, mit
Projekt, ohne Freigaben; Gäste (Etappe C) dürfen später ebenfalls drucken und herunterladen.

**Wo:** Knopf „⋯" neben „← Fertig" im Kopf der geöffneten Notiz → `choiceModal` mit fünf Einträgen.

* **Drucken im Browser**, nicht als Server-PDF: Das Handy bietet so seinen eigenen Druckdialog (samt
  „Als PDF sichern"). `notizDrucken()` baut `#notiz-druck` aus dem **lokalen** Dokument (also auch
  eben Getipptes) mit derselben sicheren Umwandlung wie die Vorschau (`notizHtml`), setzt
  `body.notiz-druckt`; `@media print` blendet alles andere aus. `@page { margin: 20mm }` — es ist die
  einzige Druckansicht der App. Aufgeräumt wird bei `afterprint`, spätestens nach einer Minute
  (manche Handy-Browser melden `afterprint` nicht).
* **PDF/DOCX/ODT baut der Server** (`notiz-export.js`, `GET /api/notes/:id/export/:format`) aus dem
  Stand im offenen Raum (`live.offenerStand`), sonst aus der Datenbank. Der Browser wartet vorher bis
  zu 3 s, bis seine Warteschlange beim Server ist (`s.bisGesendet`); gelingt das nicht (Funkloch),
  gibt es keine Datei ohne die letzten Änderungen, sondern eine Meldung.
  * PDF: pdfkit mit eingebetteter DejaVu Sans (Paket `dejavu-fonts-ttf`, Laufzeit-Abhängigkeit) —
    die Standardschrift von pdfkit kann weder „→" noch „✓". Zeichen, die die Schrift nicht hat
    (Emojis), werden „□" statt Zeichensalat. Kästchen der Checkliste als Vektor gezeichnet,
    Seitenzahlen ab zwei Seiten. Der Schriftpfad wird erst beim ersten PDF aufgelöst: Fehlt das
    Paket, scheitert nur das PDF — `routes/notes.js` lädt die Datei beim Serverstart, und ein
    fehlendes Paket hätte sonst den ganzen Server am Starten gehindert (einmal nachgestellt:
    Paket weggenommen → Laden ok, PDF sauber abgewiesen, Word weiter ok).
  * DOCX und ODT ohne neue Bibliothek, als ZIP mit `archiver` (schon da). ODT: `mimetype` als erster
    Eintrag, unkomprimiert — sonst erkennt LibreOffice die Datei nicht. Nummerierte Listen beginnen
    nach einer Zwischenzeile wieder bei 1 (Word: eigene `numId` je Lauf mit `startOverride`).
  * Dateiname „Titel – Stand 2026-09-27 14-32.pdf": `filename*=UTF-8''…` für Umlaute, dazu ein
    ASCII-Rückfall; `dateinameAus()` bevorzugt jetzt `filename*`.
* **„Stand als eigene Notiz"** (`POST /api/notes/:id/kopie`): gleicher Weg wie „Weitergeben
  annehmen" (`zeileAusDelta` aus dem Stand von eben), Eigentümer = Klicker, Titel
  „… (Stand TT.MM.JJJJ, HH:MM)", Projekt nur, wenn es das Projekt noch gibt; öffnet sich sofort.

**Am Test gefunden: Die Funkloch-Meldung lag genau über „⋯".** Der nächste Tipp schloss nur die
Meldung (R14), das Menü ging nicht auf — gemessen mit `elementFromPoint`. Die Meldung hat jetzt selbst
den Knopf „Nochmal versuchen".

**Kein Druckfenster?** Ob `window.print()` in jeder Umgebung ein Druckfenster öffnet (z. B. als App
vom Startbildschirm des iPhones), ließ sich hier nicht prüfen. Damit nicht still nichts passiert,
horcht `notizDrucken` auf `beforeprint` und `matchMedia('print')`; kam nach 2,5 s keins von beiden,
erscheint „Falls sich kein Druckfenster geöffnet hat: …" mit dem Knopf „Als PDF speichern". Der
Druckbereich wird dabei NICHT abgeräumt — war das Fenster doch offen (Browser ohne diese Ereignisse),
würde sonst die App gedruckt. Gegenproben: nie Hinweis / immer Hinweis → jeweils rot.

**Kopie einer Kopie** ersetzt den alten „(Stand …)" im Titel, statt einen zweiten anzuhängen.

**Ein Fehler im eigenen Test:** Der Vergleich „Kopie = Original" las das Original aus der Liste,
bevor der Speichertakt (1,5 s) gelaufen war — die Kopie (aus dem Raum) war aktueller als das
gespeicherte Original. Der Test wartet jetzt den Takt ab; dass die Kopie den ungespeicherten Stand
trägt, prüft er gesondert.

`tests/notizen-export.js` (16): Dateien werden wieder GELESEN (pdftotext, LibreOffice) und Zeile für
Zeile verglichen — Umlaute, „→", „✓", Nummerierung, Checklisten, `& < > "`; Schrift eingebettet;
Rechte (Leserecht ja, fremd 403, fehlend/unbekanntes Format 404, ohne Anmeldung 401); ungespeicherte
Änderung steht schon in der Datei; Kopie gehört dem Leser, ohne Freigaben, Original unberührt.
Gegenproben (9, alle rot): Stand aus der DB statt aus dem Raum, `&` nicht maskiert, Export bzw.
Kopie ohne Rechteprüfung, Kopie gehört dem Eigentümer, Emojis ungefiltert, Nummerierung läuft durch,
kein `filename*`, Kopie ohne Projekt.
`tests/notizen-export-ui.js` (23, Handy mit Touch): Menü, Abbrechen, Druck im Druck-Medium gemessen
(nur `#notiz-druck` sichtbar, kein Editor, keine Knopfleiste, kein fremder Cursor; eben Getipptes
dabei; danach alles wie vorher), Downloads abgefangen (Name, Typ, Inhalt per pdftotext samt eine
Sekunde vorher Getipptem), kein Druckfenster → Hinweis + PDF, Funkloch + „Nochmal versuchen",
Leserecht und Kopie. Gegenproben Oberfläche (7) und Word-Nummerierung (1): alle rot.

**Deploy Etappe B (27.09.2026, `a1ade4f`, Cache 429).** Komplette Suite vorher 242/242. Vollsicherung
`arbeitsdoku_backup_20260927-144040.adbk` auf VPS, Mini-PC und Laptop (gleiche Prüfsumme), Rückspielprobe
auf dem Mini-PC; Rückkehrpunkt `vor-notizen-export-deploy` (= `3938112`). `npm install` brachte das
Schriftpaket (auch auf der Zweitanlage); auf dem Server einmal PDF, Word und ODT erzeugt, Stand-Zeit in
deutscher Zeit. Datenbank vorher/nachher: 50 von 50 Tabellen gleich (Etappe B ändert keine Daten).
Vorher zusätzlich alle 12 echten Notizen (Lesekopie) in alle drei Formate umgewandelt und zurückgelesen:
jede Zeile wiedergefunden. Rückweg: Code auf `vor-notizen-export-deploy`, an der Datenbank ist nichts
zurückzudrehen.

## Neue Freigabe leuchtet nur beim neuen Empfänger (R26, 27.09.2026)

Gefunden beim Nachstellen für Alex' Frage, ob eine neue Freigabe weiter Push, Zähler und
Hervorhebung auslöst (ja — unverändert seit vor den Live-Notizen). Dabei fiel auf: Kam später jemand
dazu, leuchtete die Notiz auch bei allen, die schon Zugriff hatten, wieder als neu auf (ohne Push).
`PUT /api/notes/:id/shares` löscht alle Freigaben und legt sie neu an; `created_at` bekam dabei
jedes Mal „jetzt", und genau daran lesen `routes/badges.js` und die Liste „neu freigegeben" ab.
Jetzt übernimmt das Neuanlegen das alte Datum (`COALESCE(?, now)`). Lesen → Schreiben zählt nicht als
neu (Alex, wie beim Push); Entfernen und wieder Hinzufügen schon.

`tests/notiz-freigabe-datum.js` (11). Gegenprobe mit dem alten Verhalten: 5 Prüfungen rot. **Messfalle
im eigenen Test:** Das Datum las ich zuerst aus `GET …/shares` — die Route liefert es gar nicht; der
Vergleich `undefined === undefined` war grün. Jetzt aus der Liste des Empfängers, und ohne Datum ist
die Prüfung rot.

**Deployt:** Prod 27.09.2026 (`2e705e5`), Sicherung `arbeitsdoku_backup_20260927-145612.adbk` (dreifach, Rückspielprobe ok),
Datenbank vorher/nachher 50 von 50 Tabellen gleich; Rückkehrpunkt `vor-r26-deploy`.

## Gemeinsame Notizen — Etappe C: Gäste von außerhalb (27.09.2026)

Alex' Wunsch (26.09.): Leute ohne Konto in eine Notiz holen — erst zwei Sammel-Links (Lesen/Schreiben),
dann „noch besser": **benannte Gäste**, jeder mit eigenem Link, eigenem Passwort, Lesen oder Schreiben,
einzeln entziehbar. Entschieden: alle dürfen für eigene Notizen einladen, Firmenschalter; Gäste sehen
nur Vornamen; Ablaufdatum freiwillig; Kopie/Weitergeben ohne Gäste; Gäste drucken und laden herunter.
Selbst festgelegt (Alex vorab genannt): Gäste nur Text (kein Titel, kein Projekt, keine Kopie), 5
Fehlversuche → 15 min Sperre + Push an die Eigentümerin, Schalter standardmäßig an und Aus behält die
Zugänge, ausgestellte Eigentümerin → ihre Gastzugänge gelten nicht mehr, Umbenennen gilt ab der
nächsten Verbindung.

**Server (Schritt 10).** `note_gaeste` (Schema in `database/init.js`, auch im Rückspiel-Pfad), Regeln in
`notiz-gaeste.js`, Wege in `routes/notiz-gaeste.js` (Verwaltung unter `/api/notes/:id/gaeste`, Gast
unter `/api/gast`).
* **Zwei getrennte Welten.** Die Anmeldung eines Gasts ist ein eigenes Token (`gast`), das Ticket
  seines Ereignisstroms ebenso (`gastTicket`). `middleware/auth.js` führt beide auf der Verbotsliste;
  `/api/events` verlangt jetzt eine Nutzernummer — **vorher prüfte der App-Ereignisstrom nur die
  Unterschrift**, ein Gast-Token wäre durchgekommen (Gegenprobe ohne die Zeile: rot). Umgekehrt
  verlangt jeder Gast-Weg `gast` bzw. `gastTicket`.
* **Kennung hinter dem #.** Sie erreicht nie ein Server-Protokoll und keine Messenger-Vorschau; zum
  Server geht sie nur beim Anmelden, im Körper der Anfrage. Sie bleibt lesbar gespeichert, damit die
  Eigentümerin den Link später erneut kopieren kann — allein nützt sie nichts. Das Passwort nur als
  Hash; `pw_stand` zählt bei jedem neuen Passwort hoch und entwertet genau die Anmeldungen dieses Gasts.
* **Live-Raum** (`notizen-live.js`): Teilnehmer haben jetzt eine Kennung `wer` — Nutzernummer oder
  `'g<Nummer>'`. Gäste zählen nicht beim „gesehen"-Merker, bekommen keine Meldungen, und ihr Name
  landet in `notes.updated_by_gast` (`updated_by` verweist auf Nutzer). **Vornamen:** Die Anwesenheit
  (Cursor mit Namen) wird für Gäste eigens kodiert — `encodeAwarenessUpdate(aw, ids, states)` mit einer
  Kopie der Zustände, in der Mitarbeiter nur ihren Vornamen tragen. Den Namen setzt weiter der Server.
  Kopf für Gäste nur mit Titel. Ein Minutentakt prüft Gäste nach (Ablauf um Mitternacht auch für den,
  der nur mitliest); `nutzerRauswerfen` (Ausstellen) prüft die Gäste mit.
* **Fehlversuch-Bremse** je Gast (5 → 15 min, auch mit dem richtigen Passwort), dazu je Adresse
  `express-rate-limit`. Unbekannte Kennung wird gleich lange geprüft (Dummy-Hash).
* **Umbenennen live?** Verworfen: Eine Anwesenheit mit gleichem Takt übernimmt y-protocols nicht, und
  den Takt vom Server aus hochzusetzen brächte die eigenen Takte des Gasts durcheinander.

`tests/notiz-gaeste.js` (43) — auch mit einem zweiten Teil direkt an der Datenbank, nachdem der
Testserver beendet ist (Ablauf vorbei, Eigentümerin ausgestellt; so läuft nie ein zweiter Prozess auf
derselben Datei). Gegenproben (14): 12 rot, **zwei grün**:
* „Gast-Änderung zählt nicht als neu" blieb grün, weil der Test nur Tom (Empfänger) prüfte — für ihn
  zählte es auch ohne Korrektur („nicht Tom" reicht). Der eigentliche Fall ist die **Eigentümerin**:
  leeres `updated_by` hieß bisher „sie selbst". Test ergänzt, beide Stellen (Zähler, Hervorhebung) → rot.
* „Gast in fremder Notiz" bleibt grün — über die Wege nicht auslösbar (die Gast-Routen nehmen immer
  die eigene Notiz des Gasts); die Prüfung in `zugriffVon` ist die zweite Absicherung.

**Oberfläche (Schritt 11).**
* **Gästeseite** `public/gast.html` + `js/gast.js`, erreichbar unter `/gast` (eigene Route vor dem
  SPA-Rückfall, `noindex`, `no-store`). Sie lädt die App **nicht**: `app-1-core.js` liest die Anmeldung
  eines Mitarbeiters und meldet bei 401 ab — ein Gast auf einem Firmen-Handy stünde sonst halb in der App.
  Kleine Helfer (Meldung, Dialog, Download) sind dort nachgebaut.
* **Dieselbe Sitzung**: `notizSitzungStarten(id, weg)` — alles, was zwischen App und Gästeseite
  verschieden ist (Adressen, Anmeldung, Rauswurf, Menü, Titel speichern), steckt im Weg-Objekt
  (`notizWegeApp`); der gemeinsame Editor-Teil in `notizFeldHtml()`. Die App verhält sich unverändert
  (`notizen-live-ui` 51, `notizen-export-ui` 23).
* **Eigentümerin**: 🔗 an der Karte, „🔗 n Gäste", Dialog; im Editor „⋯ → Gäste verwalten".
  Einstellungen: Schalter mit Rückfrage beim Ausschalten. Cache 430; `gast.html` trägt die Nummer mit
  (der Oberflächen-Test prüft das — beim nächsten Anheben sonst leicht vergessen).
* Zwei Test-Fallen: Ohne Fokus meldet das Schreibfeld keine Auswahl — Annas Cursor kam beim Gast nie
  an, bis ihr Fenster nach vorn geholt wurde (im Live-Test tippen alle, dort fiel es nicht auf). Und
  die Meldung „Gast eingeladen" lag über „⋯" — der Test wartet sie ab wie ein Mensch.

`tests/notiz-gaeste-ui.js` (30). `notizen-export-ui` erwartete „genau fünf Menüeinträge" — für die
Eigentümerin sind es jetzt sechs; der Test prüft nun zusätzlich, dass Rita (Leserecht) „Gäste
verwalten" nicht hat.

Gegenproben Oberfläche (10, alle rot): alte Nummer in `gast.html`, Titel für Gäste änderbar, „Kopie" im
Gast-Menü, neues Passwort ohne Maske, Abmelden vergisst nicht, 🔗 für Nicht-Eigentümer, Zugang nach dem
Einladen nicht angezeigt, Abschalten ohne Rückfrage, Gästeseite lädt die App, Gast sieht Nachnamen.
`push-targeting` (53) prüft zusätzlich die Meldung einer Gast-Runde („Herr Maier (Gast) hat …" an
Eigentümer und Mitleser) und dass eine Sperre nur beim Eigentümer ankommt.

**An einer frischen Kopie der echten Daten umgestellt:** neu nur `note_gaeste` und `notes.updated_by_gast`;
50 von 50 bisherigen Tabellen und alle 12 Notizen zeichengleich. **Rückweg:** Der Code vor Etappe C
verträgt die neue Datenbank. Wird danach der neue Code wieder eingespielt, vorher
`UPDATE notes SET updated_by_gast = NULL WHERE updated_by IS NOT NULL` — sonst stünde nach einer
Mitarbeiter-Änderung mit altem Code noch ein Gast als letzter Bearbeiter da.

**Nach der ersten kompletten Suite (243/245) und Alex' Fragen:**
* **Audit-Log:** Die Gast-Aktionen hatten keine Beschriftung (`audit-beschriftungen` rot). Die
  Verwaltungs-Aktionen liefen über eine Hilfsfunktion `protokoll()`, die der Test nicht als Protokoll-
  Aufruf erkennt — sie hätten auch mit Beschriftung nie als fehlend gegolten. Jetzt `auditGast()`
  (Name mit „audit"), alle sieben beschriftet, Rechte-Änderung als „Lesen → Schreiben" statt
  „read → write". Alex fragte, ob die Gast-Anmeldung protokolliert wird: ja („Notiz: Gast
  angemeldet", mit IP) — aber nur die Anmeldung MIT Passwort; ein gemerktes Gerät (7 Tage) erzeugt
  keinen neuen Eintrag, das zeigt „zuletzt da" in der Gästeübersicht.
* **Gästeübersicht kompakt** (Alex: „Wie und wo kann ich Gäste auswählen und dann bearbeiten?"): je
  Gast eine Zeile (Name, Recht, Zustand, gültig bis), Antippen klappt genau diesen Gast auf (bleibt
  beim Neuzeichnen offen); Einladen hinter „＋ Weiteren Gast einladen", offen solange keiner da ist.
  Vorher war jeder Gast mit allen Feldern aufgeklappt — bei drei Gästen langes Scrollen, das
  Formular ganz unten. `notiz-gaeste-ui` 33.
* **Ein Download-Baustein für beide Seiten:** `kleine-sackgassen-ui` (R18: EINE Stelle für Downloads)
  war rot — die Gästeseite hatte eine eigene Kopie von `dateiHerunterladen`. Jetzt
  `public/js/datei-laden.js`, geladen von `index.html` (vor app-1-core) und `gast.html`.

**Deploy Etappe C (27.09.2026 abends, `67b51cf`, Cache 430).** Vorher: komplette Suite 245/245 auf dem
Endstand, dann noch einmal 245/245 gegen einen **frischen Prod-Klon** (Vorlage `/tmp/prodklon.db` neu aus
einer Lesekopie von 19:24; `/tmp/prodklon-echt.db` bleibt bewusst der Stand vor Etappe A — der
Umstellungs-Test braucht ihn). Vollsicherung `arbeitsdoku_backup_20260927-204654.adbk` (VPS, Mini-PC,
Laptop, gleiche Prüfsumme; Rückspielprobe auf dem Mini-PC), Rückkehrpunkt `vor-notizen-gaeste-deploy`
(= `2e705e5`). Nachher: `/gast` mit `noindex` und `no-store`, lädt keine App; Gast-Wege ohne Anmeldung
401/404; keine Fehler im Protokoll; Datenbank vorher/nachher: neu nur `note_gaeste` und
`notes.updated_by_gast`, 50 von 50 Tabellen und alle 12 Notizen zeichengleich.

## Meldungen in der geöffneten Notiz unter der Knopfreihe (28.09.2026)

Die Meldungen stehen seit R24 oben — in der geöffneten Notiz genau über „⋯" und „← Fertig". Wer direkt
danach tippte, schloss nur die Meldung (R14), das Menü ging nicht auf (aufgefallen im Test zu Etappe B,
Alex zugestimmt). Jetzt rückt sie dort unter die Knopfreihe (`body:has(.notiz-editor) .toast`); überall
sonst unverändert, Gästeseite ebenfalls (ohne App-Kopf liegt sie schon darunter). `notizen-export-ui`
prüft per `elementFromPoint`, dass beide Knöpfe antippbar bleiben — erst nach der 0,3-s-Einblendung
gemessen; mittendrin lag die Meldung noch oberhalb, und „frei" wäre Zufall gewesen. Gegenprobe: rot.
Cache 431.

## Projektnotiz: eine gemeinsame Live-Notiz je Auftrag (28.09.2026)

Alex' Idee: jeder Auftrag hat automatisch eine (anfangs leere) Notiz, erreichbar unter Projekte; lesen
alle, schreiben Chef, Admin und die Zugeteilten. Entschieden: altes Feld „Notiz" heißt „Kurzinfo" und
bleibt; Meldungen nur an die Zugeteilten; erledigt weiter beschreibbar; Gäste laden Chef und Admin ein.

**Die Notiz gehört keiner Person.** `notes.user_id` war NOT NULL (mit Fremdschlüssel und ON DELETE
CASCADE auf das Konto) — eine Projektnotiz einer Person unterzuschieben hätte sie beim endgültigen
Löschen dieses Kontos mitgelöscht. Deshalb einmaliger **Neuaufbau der Tabelle** (`ensureProjektNotizSchema`):
Beschreibung aus der bestehenden abgeleitet (wie beim `absences`-Umbau), alle Zeilen mit Nummern kopiert,
Zählung geprüft, und der **AUTOINCREMENT-Zähler festgehalten** — sonst bekäme eine neue Notiz die Nummer
einer gelöschten, und ein Handy mit alten, ungesendeten Änderungen zu dieser Nummer (`notiz-live:<id>`)
schöbe sie in die neue. Neue Spalte `projekt_notiz_fuer` mit eindeutigem Index (höchstens eine je
Projekt) — bewusst nicht `project_id`, das ist die Verknüpfung einer PERSÖNLICHEN Notiz.
`tests/projektnotiz-umbau-prodklon.js` (18) an Vorlage und alter Rohkopie (vor Etappe A).

**Nebenfund R27:** Die Produktivdaten haben alte Fremdschlüssel-Verstöße (2631 von 3627 Planungs-
Zuweisungen zu gelöschten Planungen u. a.). Mit dem Umbau haben sie nichts zu tun; der Test prüft
deshalb „keine NEUEN Verstöße, keiner auf Notizen" statt „keine". In der Bugliste, Entscheidung offen.

**Die Regel an EINER Stelle:** `projekt-notiz.js` (Zugriff, Gäste, Empfänger, Anlegen). Live-Raum
(`zugriffVon`), `canAccessNote`, Gäste-Verwaltung und Projekt-Routen fragen sie. Folgen, die der Test
prüft: Zuteilung ändern → `zugriffAbgleichen`; Rolle ändern → `alleAbgleichen`; umbenennen → Titel +
`kopfGeaendert`; Papierkorb → alle raus (Grund `projekt-geloescht`, Gäste `geloescht`); endgültig →
Notiz, Gäste, Merker weg. Über die Notiz-Wege ist sie weder umbenenn-, lösch- noch teilbar. Angelegt
wird sie beim ersten Öffnen (`POST /api/projects/:id/notiz`); das Ansehen (`GET`) legt nichts an.
Das Board frischt nur auf, wenn die Notiz von leer zu nicht leer wechselt (📝) — nicht bei jedem Tippen.

**Oberfläche:** Bereich in der aufgeklappten Kachel mit Vorschau, Route `#/projects/<id>/notiz`
(`renderNotizEditor(null, { projektId })`, Menü „Projekte" aktiv), `notizWegeApp(id, projektId)`:
Titel fest, Hinweis statt Projektfeld, „Gäste verwalten" für Chef/Admin, „← Fertig" zurück aufs Board.

Tests: `projektnotiz` (23), `projektnotiz-ui` (11), `push-targeting` (57, Meldung nur an Zugeteilte).
Gegenproben Server 12: zwei blieben zuerst grün bzw. wacklig — (1) „live bei Tom" hing an der zufälligen
Reihenfolge im Dokument, weil Toms Testgerät seinen abgewiesenen Versuch bei sich behielt (jetzt an Beas
Gerät geprüft); (2) „endgültig löschen" prüfte nur, dass niemand mehr hineinkommt — nicht, dass die Zeile
weg ist (Teil 2 sieht in der Datenbank nach). Danach alle an ihrer Stelle rot. Und der UI-Test griff
zuerst die erste Kachel — die frische Datenbank bringt ein Beispielprojekt mit.

**Deploy Projektnotiz + Meldungen im Editor (28.09.2026 morgens, `766c353`, Cache 431).** Suite 248/248
gegen einen frischen Prod-Klon (Lesekopie 06:37; der Umbau-Test prüfte zusätzlich an der frischen
Rohkopie). Vollsicherung `arbeitsdoku_backup_20260928-080103.adbk` (VPS, Mini-PC, Laptop, gleiche
Prüfsumme; Rückspielprobe auf dem Mini-PC), Rückkehrpunkt `vor-projektnotiz-deploy` (= `67b51cf`).
Server-Protokoll: „notes neu aufgebaut … 12 Notizen übernommen", keine Fehler. Datenbank vorher/nachher:
51 von 51 Tabellen gleich (auch der eine echte Gastzugang), alle 12 Notizen gleich, neu nur
`projekt_notiz_fuer`; keine neuen Fremdschlüssel-Verstöße, keiner auf Notizen; `user_id` jetzt ohne
NOT NULL; Nummernzähler 43 → 43; Datei heil. **Rückweg:** Code auf `vor-projektnotiz-deploy` verträgt
die umgebaute Tabelle (Projektnotizen haben kein `user_id` und tauchen in keiner Liste auf); Sicherung
von 08:01 zurückspielen stellt auch die alte Tabellenform wieder her.

## R27: Reste beim Löschen — die Regel an einer Stelle (28.09.2026)

**Der Befund.** Die App schaltete beim Start `PRAGMA foreign_keys = ON` ein, und das Schema ist voller
`ON DELETE CASCADE`. Gewirkt hat es fast nie: sql.js öffnet die Datenbank beim Speichern (`export()`, der
Autosave alle 5 s) intern neu, danach ist der Schutz aus, bis zum nächsten Neustart. Nachgestellt: Die
Kaskade greift vor dem ersten Speichern, danach nicht. In den Produktivdaten lagen 2636 Planungs-Zuweisungen
zu gelöschten Planungen, weil jedes Löschen einer Planung sie liegen ließ. Dazu kam Kleinkram gelöschter
Konten. Und Inhalt mit Verweis ins Leere: Zeiteinträge und Planungen endgültig gelöschter Projekte, 6
Zeiteinträge früh gelöschter Konten.

**Warum nicht einfach einschalten.** Nach jedem `export()` den Schutz wieder anzuschalten wäre eine Zeile.
Dann aber scheitert jedes `UPDATE`, das eine Verweis-Spalte setzt, an einer Zeile, deren Verweis schon ins
Leere zeigt. Das Bearbeiten eines der 32 Zeiteinträge eines gelöschten Projekts wäre damit unmöglich. Und die
Kaskaden im Schema sind nicht alle gewollt: `planning_entries.created_by … CASCADE` hätte beim endgültigen
Löschen eines Kontos die Planungen **anderer** Leute mitgenommen, `entries.project_id … SET NULL` hätte dem
Projekt-Purge widersprochen, der die Nummer bewusst stehen lässt. Einschalten hätte also Verhalten erfunden,
das nie jemand entschieden hat.

**Die Entscheidung:** Schutz **bewusst und verlässlich aus**. Das war die Wirklichkeit, jetzt aber nicht
mehr je nach Uhrzeit. `reste.js` sagt für **jeden** Verweis, was gilt:
**Anhängsel** (Zuweisung, Merker, Einstellung, Verknüpfung: ohne Gegenstück sinnlos, geht mit) oder
**Inhalt** (bleibt immer, auch mit Verweis ins Leere). Lösch-Wege rufen `nachLoeschen(db, '<tabelle>')`, und
die Planung hat dafür eine eigene Funktion `planungenLoeschen` (15 Stellen). Als Netz dient `aufraeumen()`
beim Start, beim Zurückspielen (vor dem Einsetzen) und einmal am Tag, mit Audit-Eintrag „Datenreste
aufgeräumt". Der Tageslauf setzt erst am Folgetag ein: Liefe er 15 s nach dem Booten, verdeckte er im
Test einen Lösch-Weg ohne Aufräumen.

**Tests.** `tests/reste.js` (32): (A) Schutz aus, gemessen am **zweiten** Start. Beim ersten legt init an
und speichert, das Speichern schaltet ihn schon ab, und der alte Stand fiel dort nicht auf (Gegenprobe R5
blieb zuerst grün). (B) Jeder Verweis des Schemas steht genau einmal in einer Liste. (C) Aufräumen an
gebauten Daten, zweite Stufe inklusive, Inhalt zeichengleich, Zurückspielen. (D) Quelltext-Wächter **je
Stelle**: Im Umfeld jedes `DELETE FROM <tabelle mit Anhängseln>` muss aufgeräumt werden. Die erste,
dateiweite Fassung war zu großzügig (`DELETE FROM planning_reminder_sent` an ganz anderer Stelle ließ die
Gegenprobe R8 grün). (E) Die Wege über die Schnittstelle, ohne Neustart.
`tests/reste-prodklon.js` (15) an der frischen Rohkopie: Weg ist genau das, was SQLite selbst als
Anhängsel-Verstoß meldet (2650 Zeilen). Jede andere Zeile jeder Tabelle ist zeichengleich. Die Liste der
Tabellen, die sich ändern dürfen, steht **fest im Test**, unabhängig von `reste.js`, sonst bliebe eine
Fehl-Einordnung dort grün (Gegenprobe P2). Die Nullprobe vergleicht zwei Server, alter und neuer Stand
auf denselben Daten: 698 Abfragen zeichengleich, mit Gegenprobe.

**Nebenfund.** „Mitarbeiter endgültig löschen" versprach im Dialog und im README, alle Zeiteinträge,
Abwesenheiten, Planungen und Notizen zu entfernen. Wegen R27 blieben sie immer stehen (so bei den Konten
vom März). Text jetzt wahr, Verhalten unverändert. Ob der Inhalt mitgehen soll, ist Alex' Entscheidung.

**Und dann wirklich löschen (Alex, 28.09.2026 abends).** Der Nebenfund führte zur Entscheidung: „Endgültig
löschen" (nur Admin, nach dem Ausstellen, für Testkonten) nimmt den Inhalt mit, Bestellungen und Aushänge
bleiben, wer abgerechnet ist, ist gesperrt. `konto-loeschen.js` hält die Regel: `sperre`, `vorschau`
(für den Dialog), `inhaltLoeschen` (ohne eigene Transaktion, der Aufrufer fasst alles in eine),
`altlastenAufraeumen` (einmal, mit Merker in `settings`). Drei Dinge waren nicht offensichtlich:
- **„Bleibt" heißt auch „bleibt sichtbar".** Aushänge, Bestellungen und Planungen verknüpften ihren
  Verfasser fest (`JOIN users`). Mit dem Konto verschwanden sie für **alle**, obwohl sie in der Datenbank
  standen. Das stimmt jetzt über `LEFT JOIN` und `COALESCE(u.name, 'Gelöschtes Konto')` (Gegenproben K4/K5).
- **Serien leben weiter.** Eine Serie, die sie für Tom angelegt hat, materialisiert der Zeitplaner aus der
  Vorlage (`template.assigned_user_ids`). Stünde sie dort noch, teilte er sie jeden Tag wieder ein. Deshalb wird
  sie aus der Vorlage genommen. Steht niemand mehr darin, wird die Serie angehalten, ohne Termine ist sie weg.
- **Reihenfolge beim Start.** Erst die Altlasten, dann die Anhängsel. Umgekehrt nimmt das Aufräumen einer
  Planung, in der nur ein gelöschtes Konto stand, erst die Einteilung weg. Danach sieht sie aus wie eine ohne
  Einteilung und wird nicht mehr als dessen Planung erkannt (Gegenprobe K9 im Prod-Klon-Test).

Die Altlasten folgen der Regel mit einer Ausnahme: Planungen, die ein längst gelöschtes Konto **angelegt** hat,
gehen mit, auch wenn noch jemand eingeteilt ist. Sie waren seit Monaten für niemanden sichtbar (fester
Ersteller-JOIN) und tauchten mit dem `LEFT JOIN` sonst plötzlich wieder auf. Alex hatte sie als Test-Planung
freigegeben. Der Prod-Klon-Test berechnet seine Erwartung selbst, ohne den Code zu fragen. Seine harte
Zusicherung „keine **sichtbare** Planung eines vorhandenen Kontos fehlt" war zuerst ohne „sichtbar" formuliert
und schlug genau bei dieser Planung an. Und er baut sich seinen Klon selbst: Auf dem geteilten
`/tmp/prodklon.db` hatte ein Test aus einem abgebrochenen Suite-Lauf schon aufgeräumt, und die Nullprobe
maß dort nichts mehr. `tests/abschluss-haerte.js` Abschnitt 4 hielt die alte Entscheidung „bewusst nicht
gesperrt" fest und prüft jetzt die Sperre.

**Deploy R27 + endgültig löschen (28.09.2026, 22:13, `b192c0d`, Cache 432).** Suite 252/252. Vollsicherung
`arbeitsdoku_backup_20260928-220151.adbk` (VPS, Mini-PC, Laptop, gleiche Prüfsumme; Rückspielprobe auf dem
Mini-PC); die Datenbank war beim Deploy bytegleich mit dem Stand der Sicherung. Rückkehrpunkt `vor-r27-deploy`
(= `766c353`). Trockenlauf des Prod-Klon-Tests auf genau diesem Stand, danach der Deploy. Server-Protokoll wie
im Trockenlauf: „Inhalt früh gelöschter Konten (Nr. 3, 4, 5): 6 Zeiteinträge, 2 Planungen — dabei mit
weggeräumt: 2640 Planungs-Zuweisungen, 1 Versand-Merker" und „Start: 2 Planungs-Zuweisungen an gelöschte
Konten, 7 Soll-Stunden …, 1 Gesehen-Merker …".
**Vorher/nachher an den echten Daten** (Alex: „Stelle sicher, dass sich an den Produktivdaten und den Stunden
der MA nichts ändert"): (1) Zeile für Zeile, Erwartung unabhängig vom Code berechnet. Weg sind genau die 2659
freigegebenen Zeilen, sonst fehlt oder ändert sich keine Zeile in allen 51 Tabellen, neu sind nur zwei
Protokolleinträge und der Merker. Zeiteinträge vorhandener Konten 1429 → 1429, Datei heil. (2) Stunden: der
alte Code auf den Daten von vorher gegen den neuen auf den Daten von nachher, 130 Statistik-Abfragen, 39
Überstundenstände und 8 Monate Lohn-Export zeichengleich. **Gegenprobe:** Die erste Fassung verlängerte die
gespeicherte Netto-Spalte eines Eintrags von heute und blieb GRÜN. Die App rechnet aus Beginn/Ende/Pause, die
Spalte liest sie dafür nicht. Mit einem um eine Stunde verlängerten Arbeitsende (03.08.) schlugen alle drei
Prüfungen an. **Rückweg:** Code auf `vor-r27-deploy` läuft mit der aufgeräumten Datenbank. Die Sicherung von
22:01 zurückspielen bringt auch die entfernten Zeilen zurück; der nächste Start räumt sie dann wieder weg,
außer man bleibt auf dem alten Code.

## R23: Neu zeichnen nur auf der eigenen Seite (29.09.2026)

**Der Befund** (25.09., beim Bau von R4 + R5): Ordner umbenennen, die Antwort kommt 2 s später, inzwischen ist
„Mein Konto" offen. Danach steht in der Adresse `#/konto`, zu sehen sind die Dokumente, und das Menü springt
mit auf „Dokumente". `seiteLaden()` hilft hier nicht. Der Aufruf `renderDocuments()` nach `await api(…)` ist
frisch, nicht veraltet.

**Zentral statt an jeder Stelle.** Die Suche fand rund hundert Aufrufe von Seiten-Funktionen nach einem
`await api(…)`, nach Abzug der Fehlalarme etwa sechzig echte. Sie einzeln auf einen Helfer umzustellen wäre
fehleranfällig gewesen, und der nächste neue Knopf hätte das Problem wieder. Jetzt weiß die Seite selbst,
ob sie noch dran ist: `render()` ruft `seiteWaehlen()` mit `_imRouter = true`. Jede Seiten-Funktion in
`SEITEN` wird beim Start durch eine Wache ersetzt (`window[name]`, möglich, weil die klassischen Skripte ihre
Funktionen global ablegen). Ruft der Router sie auf, merkt sie sich die Adresse. Jeder spätere Aufruf zeichnet
nur, solange genau diese Adresse gilt. Teil-Zeichner, die in die ganze `.main` schreiben
(`renderDashboardContent`, `renderPlanningContent`, `renderStatisticsContent`, `renderProjectForm`), hängen an
ihrer Seite (`SEITEN_TEILE`).

**Warum die Adresse und nicht der Zähler von `seiteLaden()`.** Den zählen auch Live-Aktualisierungen derselben
Seite hoch. Ein Speichern, dessen Antwort nach einer Live-Meldung kommt, hätte dann nicht mehr neu gezeichnet.
Die Adresse ändert sich nur beim echten Wechsel, und das nur über den Router (geprüft: kein `pushState` /
`replaceState` in der App). Wer weg- und wieder zurückgeht, ist wieder auf der Seite und bekommt die frische
Fassung.

**Vorher geprüft:** alle Aufrufe von Seiten-Funktionen außerhalb ihrer eigenen Seite. Der einzige Fall, der
absichtlich eine fremde Seite zeichnet, ist `renderAbsenceType` (`#/absences/urlaub`), das die Übersicht
**innerhalb** des Router-Aufrufs zeichnet. Dort merkt sich die Übersicht also genau diese Adresse. Nebenwirkung,
gewollt: „Neu beantragen" aus dem Papierkorb malte nach dem Speichern die Abwesenheiten über den Papierkorb.

**Test** `tests/neuzeichnen-ui.js` (14). A: Die Liste wird gegen den Quelltext des Routers geprüft
(`seiteWaehlen.toString()`), denn zwei parallele Listen laufen sonst auseinander. B: Jede Seite in **beide**
Richtungen. Bleibt man, muss derselbe Aufruf neu zeichnen, sonst wäre die Wache ein Ausschalter; Gegenprobe
G3 legt dann die ganze App lahm. Wechselt man, bleibt „Mein Konto". C: echte Klicks mit 1,5 s verzögerter
Antwort, darunter die Messung aus der Bugliste. D: Live-Meldungen zeichnen weiter. Gegenproben 5/5 rot.
**Nebenfund R28:** Dialoge hängen an `<body>` und bleiben bei einem Seitenwechsel (Zurück-Taste) stehen.
Der Test räumt sie zwischen den Schritten weg.

## R28: Zurück schließt den Dialog (29.09.2026)

Gefunden beim Bau von R23: Dialoge hängen an `<body>`, der Router räumte sie nicht weg. Am Handy wechselte
Zurück die Seite **darunter**, der Dialog blieb stehen. Alex entschied: Zurück schließt den Dialog und sichert
den Entwurf, **Abbrechen verwirft** ihn, abgelaufene Entwürfe verschwinden beim Start.

**Mechanik** (`app-1-core.js`, vor `dialogBarrierefrei`): Alle 17 Dialoge laufen durch
`dialogBarrierefrei(overlay, schliessen)`. Das zweite Argument ist neu, der Weg, auf dem der Dialog auf
„Abbrechen“ zugeht. `dialogImVerlauf()` legt dafür einen Verlaufsschritt an (`pushState({dialog: id})`,
gleiche Adresse). `popstate` erkennt „Schritt des obersten Dialogs verlassen“, sichert Entwürfe und ruft
`schliessen()`. Beim normalen Schließen entfernt `history.back()` den Schritt wieder, sonst wäre das nächste
Zurück ein toter Tastendruck.

**Die Falle:** `history.back()` wirkt zeitversetzt. Ein `navigate()` gleich nach dem Schließen (OK → andere
Seite) würde vom verspäteten Zurück wieder rückgängig gemacht. Deshalb reihen sich `navigate()` und neue
Verlaufsschritte hinter das eigene Zurück ein (`_nachEigenemZurueck`). Das zweite ist nötig bei Dialog-Ketten
(Bestätigen → gleich die Begründung): Ohne Warten läge der neue Schritt hinter dem noch nicht entfernten
alten, und nach normalem Ende wäre das nächste Zurück wieder tot. Gefunden erst beim Durchdenken der
Gegenprobe Z10, der Test prüfte die Kette zunächst nur mit Zurück, nicht mit normalem Ende.

**Chrome-Eigenheit:** `popstate` kommt auch bei einem gewöhnlichen Adresswechsel, etwa über einen Link im
Dialog. Der Wächter schließt den Dialog dann schon, bevor der Router ihn erreicht. Gegenprobe Z4 (Router
schließt nicht) blieb deshalb zuerst grün. Jetzt prüft der Test den Router mit `render()` ohne Adresswechsel,
also dem Fall, in dem der Browser nichts meldet. Ungefährlich ist die Eigenheit, weil kein Dialog springt,
solange er offen ist (per Skript über alle Dialog-Funktionen geprüft).

**Werkzeug-Verlauf** liegt **in** der Seite (`#app`). `dialogBarrierefrei()` würde ihn mit der Seite für
Screenreader ausblenden, deshalb bekommt er nur den Verlaufsschritt. **Nebenfund:** Zwei Produkt-Dialoge
riefen `dialogBarrierefrei()` auf, räumten aber nie auf, und nach dem Schließen blieben Tab-Falle und
`aria-hidden` hängen.

Test `tests/zurueck-dialog-ui.js` (22) mit echtem `history.back()` wie die Handy-Taste; Gegenproben 11/11
rot. Bestandstest `longpress-prodklon` malte per Direktaufruf die Übersicht über die Willkommensseite (der
alte Weg, den R23 jetzt verhindert) und wechselt nun vorher auf die Übersicht.
Suite danach 253/254. Rot war nur `avatar-zuschnitt-ui`: Der Test klickte am Ende auf „Abbrechen“ im
**allerersten** Zuschnitt-Fenster, das drei Seitenwechsel überlebt hatte. Das war genau der Fehler. Jetzt
öffnet er für die Abbrechen-Probe ein eigenes Fenster.

**Deploy R23 + R28 (29.09.2026, 17:14, `3dd39fe`, Cache 434).** Suite 253/254 (der eine rote Test war
`avatar-zuschnitt-ui` mit dem alten Weg, danach grün). Vollsicherung `arbeitsdoku_backup_20260929-171259.adbk`
(VPS, Mini-PC, Laptop, gleiche Prüfsumme; Rückspielprobe auf dem Mini-PC). Rückkehrpunkt `vor-r23-r28-deploy`
(= `b192c0d`). Reine Oberflächen-Änderung: Die Datenbank ist vorher/nachher in allen 51 Tabellen gleich, das
Server-Protokoll ohne Fehler. Ausgeliefert sind `seitenWachenEinrichten` und `dialogImVerlauf`.

## R2 + R19: Absturz-Schutz und Mitarbeiter-Anlage ganz oder gar nicht (29.09.2026)

**R2** war herabgestuft: Nachgemessen war kein Auslöser erreichbar. Gebaut ist also ein Netz für künftige
Fehler, `absturzschutz.js`. Express 4 reicht Fehler aus `async`-Routen nicht an die Fehlerbehandlung weiter,
daraus wird eine unbehandelte Ablehnung, und an der beendet sich Node. Die Absicherung ergänzt
`Layer.handle_request` um Promises (wie `express-async-errors`), dazu kommen zwei Prozess-Wächter:
Ablehnungen werden protokolliert und gesichert, der Server läuft weiter. Bei echten Ausnahmen wird erst
gesichert, dann neu gestartet.

**Wie man einen Fehler auslöst, den es nicht gibt:** Sabotage-Trigger in der Test-Datenbank
(`RAISE(ABORT, …)` beim Einfügen der Soll-Stunden bzw. eines bestimmten Namens). So scheitert der **echte**
Server-Code an der richtigen Stelle, nach dem `await` des Passwort-Hashs, ohne Testhaken im Produktivcode.

**Gegenproben mit Lehre:** Ganz ohne Schutz stirbt der Server (S0). Mit Prozess-Wächter, aber ohne
Routen-Schutz (S1), überlebt er, doch die Anfrage bekommt **nie** eine Antwort, und der Test hing sich
dabei auf. Jetzt hat jede Anfrage eine Zeitgrenze, und „keine Antwort“ zählt als Fehler. Das Beispiel zeigt,
warum beide Stufen nötig sind: Der Wächter rettet den Prozess, nicht die Anfrage.

**R19** sitzt an derselben Stelle: Konto, Soll-Stunden und Anstellung stehen jetzt in einer Transaktion,
die Namensprüfung darin schließt den Wettlauf aus R2 (UNIQUE → 409). Der Kommentar „bcrypt blockiert den
Event-Loop nicht“ stimmte nicht (gemessen 24.09.) und ist berichtigt.

## R15, R16, R17: die letzten kleinen Punkte der Bugliste v7 (29.09.2026)

**R15** Auszahlungen: Beim Anlegen stand der Anzeigename, beim Bestätigen, Ablehnen und Zurückziehen der
Benutzername. Jetzt gilt `anzeigenameVon()` an allen drei Stellen. „Wirksam ab“ prüft `zeit.istDatum()`
kalendarisch; vorher ging der „2026-02-31“ durch, und die Gegenprobe zeigt die Folge: Die so angelegte
Auszahlung blockierte jede weitere („bereits offen“).
**R16** Urlaubsübersicht: `toISOString()` → `berlinHeute(now)`. Der Fehler zeigt sich nur zwischen 0 und 2 Uhr.
Getestet wird deshalb mit einem Server, dessen Uhr steht: `node --require tests/hilfen/uhr-stellen.js` mit
`FESTE_UHR='2026-09-30T22:30:00Z'` ersetzt `Date` durch eine Unterklasse mit Versatz. SQLites
`datetime('now')` bleibt echt. Gegenprobe K1 beweist zugleich, dass die gestellte Uhr greift.
**R17** Löschen im Protokoll: Aushang und Bestellung per Knopf (`bulletin_delete`, `order_delete`) und das
automatische Aufräumen (`bulletin_ablauf`, `order_aufgeraeumt`, als „System“). Den Altbestand fürs Aufräumen
(ein Aushang mit abgelaufenem Datum, eine vor Monaten bestellte Bestellung) legt der Test vor dem Start
direkt in die Datenbank, weil die Oberfläche ihn nicht herstellen kann.
Test `tests/bugliste-r15-r16-r17.js` (13), Gegenproben 8/8 rot. **Damit ist die Bugliste v7 (R1 bis R28)
vollständig abgearbeitet.**

**Deploy R2 + R19 + R15 + R16 + R17 (29.09.2026, 19:22, `4c0f81c`, Cache 435).** Suite 255/256. Der eine rote
Test, `auszahlung-ablehnung`, erwartete beim Ablehnen noch den Benutzernamen, das Verhalten vor R15. Jetzt
erwartet er den Anzeigenamen und ist grün. Die Cache-Nummer ging vor dem Deploy noch auf 435, weil die neuen
Protokoll-Beschriftungen die Oberfläche ändern. Vollsicherung `arbeitsdoku_backup_20260929-192152.adbk`
(dreifach, gleiche Prüfsumme, Rückspielprobe). Rückkehrpunkt `vor-r2-r19-r15-deploy` (= `3dd39fe`). Die Datenbank
ist vorher/nachher in allen 51 Tabellen gleich, es gibt keine Umstellung. `absturzschutz.js` liegt auf dem
Server und ist eingebunden.

## R29: Ausgeschiedene nur im Zeitraum ihrer Anstellung (29.09.2026)

Gemeldet von Alex: Ein ausgestellter Mitarbeiter stand in **allen** Statistik-Ansichten. Die Regel gibt es
längst (`employmentOverlaps` im Server, `employedInRange` in der Oberfläche). Sie griff an fünf Stellen nicht,
und jedes Mal lag es an einem anderen Weg:

- **Statistik:** Der Server blendete Ausgeschiedene aus, aber nur in der „alle“-Sicht. Die Seite schickte die
  Nummern aller Mitarbeiter mit, auch wenn niemand ausgewählt war, und damit galt jede Anfrage als „Auswahl“.
  Jetzt prüft der Server die Regel auch für eine Auswahl. Bleibt davon niemand übrig, gelten wieder alle. Die
  Nummern der im Zeitraum Angestellten gehen als `angestellt` mit, und daraus baut die Seite ihre Knöpfe.
- **Planung:** Die Prüfung stand im Code, lief aber ins Leere. Die Seite lädt `/api/users/list`, und das liefert
  nur Aktive, **ohne** Anstellungsdaten. `employedInRange` antwortet ohne Daten mit „ja“. Anstellungsdaten
  aller Kollegen an jeden Mitarbeiter zu schicken wäre ein Datenschutz-Leck, denn die Planung sehen alle. Deshalb
  liefert der Server zur Planungsabfrage nur die **Nummern** der im Zeitraum Angestellten mit, und die Seite lädt
  die Namensliste mit `?all=1`.
- **Urlaubsübersicht:** filterte auf `active = 1`, die umgekehrte Abweichung. Im Austrittsjahr fehlte der
  Ausgeschiedene (dabei ist sein Konto gerade dann wichtig, Stichwort Abgeltung), und wer neu anfing, stand schon
  in den Vorjahren.
- **Abwesenheits-Formular „Für“** bot Ausgestellte an, anders als der Zeiteintrag. **PDF-Nachweis:** Die
  Auswahlliste folgt jetzt dem gewählten Zeitraum.

Test `tests/ausgeschiedene-zeitraum-ui.js` (24): Tim war im Vorjahr vom 01.01. bis 30.06. angestellt, Nora
fängt heute an. So hängt der Test nicht vom Datum ab, an dem er läuft. Eine Falle beim Bau: Die Tagesansicht der
Planung zeigt an Tagen **ohne jede** Planung bewusst gar keine Spalten. Die erste Fassung fand deshalb nichts,
auch nicht die Spalte für Anna, und wurde mit einer Planung je Prüftag gebaut. Gegenprobe A0 stellt den alten
Zustand komplett nach (Seite schickt alle, Server prüft die Auswahl nicht).

**Deploy R29 (29.09.2026, 22:45, `4f02efb`, Cache 436).** Ausgeschiedene erscheinen nur noch im Zeitraum ihrer
Anstellung (Statistik, Planung, Urlaubsübersicht und -PDF, Abwesenheit „Für", PDF-Auswahl). Die Suite lief
257/257. Erstmals liefen die Prod-Klon-Tests vor dem Deploy noch einmal auf einer frischen Kopie (22:13): 19/21.
Die zwei roten Tests scheitern genauso auf dem vorher deployten `main`, sie kommen also nicht von R29.
`reste-prodklon` hielt den Stand vor dem Aufräumen vom 28.09. fest und zählte die alten Protokolleinträge mit.
Jetzt zählt er nur, was sein eigener Start schreibt (Gegenprobe mit eingebauten Resten). `notizen-live-prodklon`
fand eine Notiz, die mit einer Leerzeile endet. Die Umstellung aus Klartext (nur auf dem Rückweg `ydoc = NULL`)
verliert diese Leerzeile, das ist offen und klein. Vollsicherung `arbeitsdoku_backup_20260929-224438.adbk`
(dreifach, gleiche Prüfsumme, Rückspielprobe). Rückkehrpunkt `vor-r29-deploy` (= `4c0f81c`). Die Datenbank ist
vorher/nachher in allen 51 Tabellen gleich. Die Lohn-CSV filterte schon vorher nach Anstellung
(`routes/payroll.js`), an echten Daten nachgemessen: Ein Ausgeschiedener steht bis zum Austrittsmonat drin, ein
Neuer ab dem Eintrittsmonat.

**R30: Meldung antippen → genau dorthin (29.09.2026, abends).** Alex tippte die Meldung „Gast hat bearbeitet“ an
und landete auf der Willkommensseite. Der Service Worker nahm das erste offene Fenster; das war die daneben offene
Gästeseite. Die bekam die Nachricht, und die App blieb stehen. Nach einer Anmeldung ging das Ziel ohnehin
verloren. Jetzt trägt jede Meldung ihr genaues Ziel. Der Service Worker meidet `/gast`, und die App hebt das
Gemeinte hervor. Den Service Worker prüft `tests/meldung-sw.js` ohne Browser: `public/sw.js` läuft in `node:vm` mit
nachgebauten Fenstern, denn eine echte Systemmeldung lässt sich im Test nicht antippen.

**Nebenbei am selben Abend:** Die Notiz-Umwandlung aus Klartext hängt jetzt immer genau ein Zeilenende an, als
Umkehrung von `felder()`. Vorher ging eine Leerzeile am Schluss verloren, gefunden am frischen Prod-Klon.
`tests/lohn-export.js` prüft jetzt auch, dass jemand vor dem Eintritt und nach dem Austritt nicht in der Lohn-CSV
steht. Echte Namen (ein Ausgeschiedener, ein Jugendlicher mit Geburtsdatum) standen in Bugliste, Werkstattbuch und
Testkommentaren. Das Repo ist öffentlich, sie sind jetzt neutral formuliert. In der Git-Geschichte stehen sie
weiter.
Die Suite für R30 lief auf der frischen Kopie von 22:56 mit 258 von 259. Rot war `push-sw`, weil sein
nachgebautes Fenster keine Adresse hatte. An der Adresse erkennt sw.js jetzt die Gästeseite. Das Fenster hat
jetzt eine Adresse wie jedes echte. Gegenprobe: Der alte sw.js ist grün (gleiches Ziel), eine Fensterwahl ohne
Treffer ist rot.

**Deploy R30 (30.09.2026, 05:48, `8ca3263`, Cache 437).** Mit dabei: die Notiz-Umwandlung (Leerzeile am Schluss)
und die Test-Ergänzungen vom Vorabend. Die Suite lief mit 259 Tests auf der Kopie von 22:56. Weil bis zum Deploy
eine Nacht verging, liefen die 21 Prod-Klon-Tests noch einmal auf der Rohkopie von 05:38: alle grün.
Vollsicherung `arbeitsdoku_backup_20260930-053835.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe).
Rückkehrpunkt `vor-r30-deploy` (= `4f02efb`). Die Datenbank ist vorher/nachher in allen 51 Tabellen gleich. Der
Server liefert `sw.js` mit `appFenster`, `app-1-core.js` mit `meldungAnsteuern` und `notiz-dokument.js` (gleiche
Prüfsumme) aus.

**Hinweis zum Service Worker:** Der neue sw.js wirkt erst, wenn die App einmal vollständig neu gestartet wurde
(Aktualisieren-Knopf bzw. App schließen und öffnen). Vorher entscheidet am Handy noch der alte Worker, wohin ein
Antippen führt.

## Meldungen (ab 30.09.2026)

**Anlass (Alex):** ein neuer Hauptpunkt „Meldungen“. Chef und Admin legen Themen an (Allgemein, Auto 1,
Papiermüll …), jeder meldet Probleme dazu. Dazu kommen Stand, History, Coin, Push, Zusammenfassung und
regelmäßige Meldungen („Auto 1 → alle zwei Jahre am 1. März → TÜV“). 32 Rückfragen vorab. Entschieden
wurde: Dringlichkeit ja, Foto nein. Die Themen stehen nebeneinander wie beim Auftrags-Board. Offene
Meldungen eines gelöschten Themas wandern mit in die History. Den Coin sehen alle Chefs und Admins außer
dem, der die Änderung gemacht hat. Regelmäßige Meldungen legen nur Chef und Admin an, mit mehreren
Auslösern (1. und 3. Montag). Das Einzelrecht „Meldungen bearbeiten“ wird gleich mitgebaut. Der Bau läuft
in drei Etappen.

**Etappe 1: Themen, Meldungen, Stand, History, Einzelrecht.**
- **Eine Regel:** `meldungrecht.js` beantwortet zwei Fragen: *bearbeiten* (Chef/Admin oder
  `can_meldungen`) und *verwalten* (nur Chef/Admin). Die Oberfläche fragt nichts selbst nach, der Server
  schickt `darf` mit.
- **Tabellen:** `meldung_themen` (weich gelöscht, sobald eine Meldung daranhängt), `meldungen` und
  `meldung_verlauf` (Name zum Zeitpunkt, bleibt lesbar nach einer Kontolöschung).
- **Einordnung:** Die Verweise stehen in `reste.js`: Der Verlauf ist ein Anhängsel, die Meldung selbst
  Inhalt und bleibt wie Bestellungen.
- **Gefunden beim Bau:**
  - Die Suche in der History läuft in JavaScript. SQLite vergleicht Groß/klein nur bei ASCII, „BLÄTTER“
    fand „blätter“ nicht.
  - Der UI-Test fand einen toten Knopf: Ohne Themen sieht der Chef zwei Knöpfe zum Themen-Dialog, und
    `a || b` band nur den ersten.
  - `konto-loeschen.js` verglich die Löschvorschau Feld für Feld. Er bekam eine Meldung dazu, statt nur
    die neue Zahl zu erwarten.
- **Tests:** `meldungen.js` (76), `meldungen-ui.js` (36) sowie `seite-laden-ui` mit der neuen Seite.
  Gegenproben 10/10 rot an ihrer Stelle, darunter: Einzelrecht wirkungslos, Beschriftung fehlt, Thema
  immer hart gelöscht, Live-Signal fehlt, Verlauf nicht eingeordnet, Knöpfe ohne Rechte-Prüfung.

**Etappe 2: Coin, Hervorheben, Push, Zusammenfassung.**
- **Coin:** Wer bearbeitet, zählt jede Meldung, die ein anderer seit dem letzten Besuch neu angelegt oder
  geändert hat. Alle anderen zählen nur ihre eigenen. Die Regel steht in `routes/badges.js`, und die
  Seite markiert „neu“ oder „geändert“ genau nach derselben Regel.
- **Markierung:** Die Seite merkt sich beim Betreten den alten Gesehen-Stand (`gesehen_bis`) für den
  ganzen Besuch. Sonst verschwänden die Markierungen beim ersten Live-Neuzeichnen.
- **Push:** in der eigenen Kategorie „Meldungen“ mit Megafon-Symbol. Das Symbol ist eine Silhouette aus
  Noto Color Emoji, erzeugt wie die übrigen. Empfänger sind die Bearbeiter und der Melder, nie der
  Handelnde. Das Löschen eines Themas schickt bewusst keine Push.
- **Zusammenfassung:** „davon neu“ zählt nur unter den offenen Meldungen. Beim ersten Stand hieß es
  „2 offene Meldungen (davon 2 neu)“, obwohl eine Neuigkeit eine erledigte Meldung war. Das fiel dem
  eigenen Test auf.
- **Falle wie beim Bestellrecht:** Der Zeitplaner liest den Nutzer selbst aus der Datenbank. Ohne
  `can_meldungen` in seiner Abfrage zählte die Zusammenfassung eines Rechteinhabers still „nichts zu
  tun“. Die Gegenprobe beweist, dass der Test genau das findet.
- **Tests:** `meldungen-zaehler.js` (18, im Prozess), `meldungen-hervor-ui.js` (18) und `meldung-ziel.js`
  (Meldungen im Fangzaun). `benachrichtigungen-umzug.js` bekam den neuen Schalter, ausgeschaltet.
  Gegenproben 10/10.

**Etappe 3: regelmäßige Meldungen** (`meldung-regeln.js`).
- **Warum eigene Rechnung:** Die Planung kennt „jährlich“, aber kein „alle 2 Jahre“, und ihr Monatsschritt
  wandert (31.01. + 1 Monat = 03.03.). Deshalb rechnet `meldung-regeln.js` selbst.
- **Aufbau:** Eine Regel ist eine Vorlage mit beliebig vielen Auslösern: „alle N Tage/Wochen/Monate/Jahre ab
  Datum“ sowie „n-ter oder letzter Wochentag alle N Monate“. Monatsschritte zählen immer vom Start aus, so
  wandert nichts.
- **Zeitplaner (minütlich):**
  - Je Regel entsteht höchstens eine Meldung pro Lauf, nämlich die letzte fällige. Verpasste Fälligkeiten
    kommen nur als „übersprungen“ in den Merker `meldung_regel_lauf`, keine Flut nach einem Ausfall.
  - Ist die letzte Meldung der Regel noch offen, bekommt sie „erneut fällig“.
  - Beim festen Takt gilt `gueltig_ab` = Tag des Anlegens. Vergangenes kommt nie, eine Auslösung von heute
    schon.
- **Gefunden beim Bau:**
  - Bei „ab Erledigung“ gibt es immer nur eine nächste Fälligkeit. Die `gueltig_ab`-Sperre hätte einen
    überfälligen Ölwechsel für immer verschluckt. Dieser Takt ist deshalb davon ausgenommen.
  - Die Vorschau rechnete fest sechs Jahre voraus und zeigte bei „alle 2 Jahre“ nur vier statt fünf
    Termine. Jetzt rechnet sie so weit voraus, bis fünf da sind.
  - Der Test mit gestellter Uhr lief anfangs zeitlich rückwärts. Der Zeitplaner hatte beim Sprung auf
    „Tag 38“ den TÜV (Tag 12) schon ausgelöst. Die gestellte Uhr darf nur vorwärts laufen.
- **Tests:**
  - `meldung-regeln.js` (39, reine Rechnung gegen unabhängig geprüfte Sollwerte)
  - `meldung-regeln-api.js` (40, gestellte Uhr)
  - `meldung-regeln-ui.js` (17): Der echte Zeitplaner des Servers legt eine heute fällige Meldung beim ersten
    Lauf 15 s nach dem Start an, und sie erscheint live im Board.
- **Gegenproben 12/12**, darunter: Monatsende wandert, „letzter“ wird „erster“, immer neu statt „erneut fällig“,
  Nachholen der ersten statt der letzten Fälligkeit, Zeitplaner ohne Regel-Aufruf, Regeln ohne Rechte-Prüfung.
- **Prod-Klon:** `reste-prodklon` verglich jede Zeile vor und nach dem Start und nahm an, dass der Start nur
  aufräumt. Mit neuen Tabellen und Spalten (`users.can_meldungen`, `push_prefs.meldungen`) sah jede Zeile
  „geändert“ aus. Jetzt vergleicht der Test nur Tabellen und Spalten von vorher. Er verlangt zusätzlich,
  dass neue Spalten in alten Zeilen nur ihren Vorgabewert tragen, dass die Umstellung also keine Daten
  schreibt. Gegenproben: Die Umstellung schreibt in die neue Spalte → rot; sie ändert echte Namen → rot.
- **Suite (Kopie 30.09. 08:49):** 265 von 266. Rot war `umlaute-in-texten`: Drei Knopf-Kennungen in
  `querySelector`-Zeichenketten (`rueck`, `zurueck`, `loeschen`) und ein Status-Wert in einem SQL-Stück, das
  nicht mit `SELECT` beginnt, sahen für den Test aus wie Text. Die Kennungen heißen jetzt `antwort`,
  `widerrufen` und `entfernen`, die Status-Werte stehen als Parameter. Danach war er grün, ebenso alle
  Meldungs-Tests.

**Deploy Meldungen (30.09.2026, 15:48, `e586bde`, Cache 438).** Die Suite lief 266 von 266 auf der Kopie von
14:19. Vollsicherung `arbeitsdoku_backup_20260930-154731.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe).
Rückkehrpunkt `vor-meldungen-deploy` (= `8ca3263`). Der Datenbank-Vergleich mit Umstellung ist ein eigenes Skript:
Es vergleicht alte Tabellen nur in ihren alten Spalten Zeile für Zeile.
- **Ergebnis:** 51 → 57 Tabellen, neu sind die sechs `meldung*`-Tabellen, leer. Neue Spalten sind
  `users.can_meldungen` (Vorgabe 0) und `push_prefs.meldungen` (Vorgabe 1), beide in allen Zeilen auf
  ihrer Vorgabe. Keine alte Zeile ist verändert, die Datei ist heil.
- **Server:** Das Protokoll meldet „Migration: can_meldungen Spalte hinzugefügt“ und keine Fehler.
  `app-10-meldungen.js` und das Megafon-Symbol werden ausgeliefert.
- **Nebenbefund:** Heute früh gab es 13 Notizen, beim Deploy 10. Die Eigentümerin selbst hat drei eigene
  Notizen gelöscht. Nur sie darf das, und dieser Weg schreibt keinen Protokolleintrag (`routes/notes.js`),
  deshalb fand sich keine Spur.

**Notiz löschen im Protokoll (30.09.2026, nach dem Deploy der Meldungen).** Beim Deploy fehlten drei Notizen,
ohne Spur. Die Eigentümerin hatte sie gelöscht, und dieser Weg schrieb nichts ins Protokoll. Jetzt entsteht
`notiz_geloescht` („Notiz gelöscht“): mit Titel, wie er beim Löschen hieß, mit der Zahl der Freigaben und
Gäste, ohne Inhalt, denn das Protokoll liest der Admin. `notiz-gaeste.js` prüft es an einer geteilten Notiz
mit Gast; ohne den Eintrag wird er rot. Cache 439.

**Deploy Notiz-Protokoll (30.09.2026, 18:11, `33b8f97`, Cache 439).** Die Suite lief 266 von 266 auf der Kopie von
16:43. Vollsicherung `arbeitsdoku_backup_20260930-181038.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe; darin
schon 3 Meldungs-Themen und 2 Meldungen). Rückkehrpunkt `vor-notiz-protokoll-deploy` (= `e586bde`). Die Datenbank
ist vorher/nachher in allen 57 Tabellen gleich, die Datei heil.

Aufgefallen ist, dass die Sicherung mit 588 KB kleiner war als die um 15:47 (610 KB). Die Datenbankdatei war aber
gleich groß, und zwischen den Ständen kam nur normaler Betrieb dazu (Zeiteinträge, Themen, Meldungen,
Protokoll). Es fiel nichts weg. Der Unterschied liegt nur in der Kompression.

## Gearbeitete Tage und Spesen-Aufteilung (30.09.2026)

**Anlass (Alex):** In der Statistik sollen die gearbeiteten Tage aufgelistet werden (Arbeitstag = mehr als
0 Stunden gebucht). Für die Spesen dazu die Tage mit mehr und mit weniger als 8 Stunden.

**Entschieden:**
- Für die Grenze zählt die Zeit vom ersten Beginn bis zum letzten Ende des Tages, mit Pausen und Lücken. Die
  Pauschale richtet sich nach der Abwesenheit.
- Genau 8:00 zählt zu „bis 8“.
- Alle Arbeitstage zählen.
- Angezeigt wird die Zahl, die Tagesliste lässt sich aufklappen.
- Die Werte stehen auch in Lohn-CSV und PDF.

**Gebaut:**
- **Eine Funktion:** `arbeitstage()` in `routes/user-hours.js` rechnen Statistik, Lohn-CSV und PDF gemeinsam.
  Sie gruppiert die Einträge je Tag, rechnet das Ist wie überall (zeitgleiche Aufträge einmal) und die Spanne
  vom ersten Beginn bis zum letzten Ende.
- **Lohn-CSV:** Die drei Spalten sind hinten angefügt, damit keine vorhandene Spalte ihren Platz wechselt. Den
  Monatsabschluss berühren sie nicht: Er vergleicht nur seine festen Felder.
- **Gefunden beim Test:**
  - Einen Tag mit 0 Stunden kann man gar nicht buchen. Die App weist einen Eintrag ab, der nur aus Pause
    besteht; der Test hält das fest.
  - Ein fremder Eintrag lässt sich nur mit Grund löschen. Ohne Grund blieb er stehen und wurde zu Recht
    mitgezählt.
- **Tests:** `arbeitstage.js` (17, Sollwerte von Hand: Pause, genau 8:00, Mittagslücke, Überlappung, Samstag,
  gelöscht, krank) und `arbeitstage-ui.js` (7). Gegenproben 6/6 rot, darunter: genau 8:00 als „mehr“,
  reine Arbeitszeit statt Beginn bis Ende, Spalten nicht hinten, gelöschte Einträge zählen mit. Cache 440.

**Deploy gearbeitete Tage (30.09.2026, 23:01, `76de33d`, Cache 440).** Die Suite lief 268 von 268 auf der Kopie von
21:33. Vollsicherung `arbeitsdoku_backup_20260930-230124.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe).
Rückkehrpunkt `vor-arbeitstage-deploy` (= `33b8f97`). Die Datenbank ist vorher/nachher in allen 57 Tabellen
gleich, die Datei heil. Es gibt keine Umstellung, die Zahlen werden nur gerechnet.

Die Probe auf echten Daten für 2026 zeigt: Bei 169 von 907 Arbeitstagen macht erst „Beginn bis Ende“ den Tag
zu „mehr als 8 Std.“. Meist ist das der Normaltag 07:00–15:30 mit 30 Min. Pause (8:00 gearbeitet, 8:30
anwesend), selten ein Tag mit großer Lücke. Das folgt der getroffenen Entscheidung. Alex hat es
nach Ansicht der Zahlen bestätigt („Passt so.“, 30.09.2026).

**Handy: Tagesliste ließ sich nicht wischen (30.09.2026, Cache 441).** Alex meldete, dass auf dem Smartphone die
Spalte „Spesen“ abgeschnitten war und seitliches Wischen nicht ging. Die Tabelle stand in einer `.table-scroll`,
für die es keine CSS-Regel gab. Die Klasse stand nur in der Merkliste für Scrollpositionen (`_SCROLLBOX_SEL`).
Die Tabelle ragte deshalb über ihren Kasten hinaus, und `.main` (`overflow-x: hidden`) schnitt sie ab. Die
Regel steht jetzt neben `.table-wrap`. Der Oberflächentest prüft auf 390 px mit einer echten Fingerbewegung.
Gegenprobe ohne Regel: rot.
- **Werkzeug-Falle:** `Input.synthesizeScrollGesture` mit `gestureSourceType: 'touch'` scrollt in
  chrome-headless-shell gar nichts, auch nicht auf einer nackten Probeseite. `page.touchscreen`
  (touchStart/touchMove/touchEnd) scrollt richtig.
- **Echte Daten, Handyformat:** Keine andere Tabelle der Statistik ist abgeschnitten. Die Suche findet ohne
  Regel genau die Tagestabellen, mit Regel keine.

**Deploy Handy-Wischen (01.10.2026, 01:24, `18b8852`, Cache 441).** Die Suite lief 268 von 268 auf der Kopie von
23:57. Vollsicherung `arbeitsdoku_backup_20261001-012415.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe).
Rückkehrpunkt `vor-handy-wischen-deploy` (= `76de33d`). Die Datenbank ist vorher/nachher in allen 57 Tabellen
gleich, die Datei heil. Die Notizen gingen seit 23:01 von 11 auf 10 zurück. Das Protokoll zeigt drei
Löschungen durch den Eigentümer selbst. Damit ist auch das neue `notiz_geloescht` im Echtbetrieb belegt.

## Persönliche Erinnerungen an Meldungen (01.10.2026)

Alex: „Was, wenn man die Nachricht bekommt und der Termin zur Reparatur oder zum TÜV erst in vier Wochen ist?
Bis dahin habe ich den Termin vergessen.“ Gewünscht waren eine oder mehrere Erinnerungen mit Datum und
Uhrzeit, danach wieder Coin, Erinnerungs-Push und Hervorheben. Bei „erledigt“ pausieren sie, beim
Wiederöffnen sind sie wieder aktiv.

**Entschieden (Rückfragen):** Erinnerungen gelten **immer nur für den, der sie stellt**. Stellen dürfen **nur
Bearbeiter** (`darfMeldungenBearbeiten`). Fällt eine Erinnerung in die Pause, **verfällt** sie. Die Push läuft
über den Schalter **„Meldungen“**, es gibt keinen eigenen. Daraus folgt: Erinnerungen stehen nicht im Verlauf
der Meldung, den alle lesen, sondern nur im Protokoll. Wer das Recht verliert oder ausgestellt wird, bekommt
keine mehr.

- **`meldung-erinnerungen.js`** (neu, Stammdatei): Prüfen, eigene lesen, anlegen, ändern, löschen und
  `faelligePruefen` für den Zeitplaner (minütlich in `scheduler.start`).
  - **Zeiten:** `um` ist deutsche Ortszeit `JJJJ-MM-TT HH:MM`. `stand_am` ist UTC wie `updated_at`, weil der
    Zähler es mit `user_seen` vergleicht.
  - **Stand:** `stand` ist wartet, ausgeloest oder verpasst. `grund` ist „Meldung ruhte“ oder „ohne Recht“.
    Ohne den Grund stünde beim entzogenen Recht fälschlich „in der Pause verpasst“.
  - **Kein Doppelversand:** Erst wird der Stand vermerkt (`UPDATE … WHERE stand = 'wartet'`), dann
    gesendet.
  - **Server lief nicht:** Der nächste Lauf holt die Erinnerung nach, sofern die Meldung noch aktiv ist.
- **Tabelle `meldung_erinnerungen`** (in `ensureMeldungenSchema`, also auch auf dem Rückspielweg). In `reste.js`
  ist sie bei beiden Fremdschlüsseln als ANHAENGSEL eingetragen: Meldung gelöscht oder Konto gelöscht, dann
  ist sie weg.
- **Routen:**
  - `POST /api/meldungen/:id/erinnerungen` nur, solange die Meldung aktiv ist (sonst 409); höchstens 20 je
    Person und Meldung.
  - `PUT` und `DELETE /api/meldungen/erinnerungen/:eid` wirken nur auf eigene Erinnerungen, fremde ergeben 404.
    Ändern setzt die Erinnerung wieder auf „wartet“. Löschen geht auch ohne Recht.
  - Listen und Detail liefern je Meldung die **eigenen** Erinnerungen mit.
- **Zähler:** `computeBadgeCounts` zählt ausgelöste Erinnerungen seit dem letzten Besuch zu `meldungen` dazu
  (`meldungenErinnerungen`). Die Zusammenfassung zieht sie wieder ab, weil ihre Push schon kam.
- **Oberfläche (app-10):**
  - **Karte:** zeigt *„🔔 nächste +N“* oder *„🔔 Erinnerung ruht“*. Ist eine Erinnerung seit dem Besuch
    gekommen, trägt sie die Marke **„🔔 Erinnerung“**.
  - **Detail:** Abschnitt „Meine Erinnerungen · nur für dich“, der an Ort und Stelle neu gezeichnet wird. Der
    Dialog bleibt also offen; ein Schließen und Wiederöffnen wäre mit dem zeitversetzten `history.back()`
    (R28) gefährlich.
  - **Formular:** Datum mit Schnellwahl, Uhrzeit = Arbeitsbeginn, Hinweis. Escape schließt nur das Formular.
- **Tests:**
  - `meldung-erinnerungen.js` (43 Prüfungen, gestellte Uhr, die nur vorwärts geht).
  - `meldung-erinnerungen-ui.js` (22 Prüfungen, Port 3364): Der **echte** Zeitplaner löst die Erinnerung
    eines zweiten Chefs aus, gestellt auf die nächste Minute, während die anderen Teile laufen. Coin „1“
    live, Marke an der Karte.
  - **Falle:** Als Chef zählt der zweite Chef jede fremde Änderung mit. Eine „erledigt“-Änderung nach seinem
    Besuch machte aus dem Coin „2“, deshalb liegt sie jetzt vor seinem ersten Besuch.
- **Gegenproben 13 von 13 rot** (Skript im Scratchpad):
  - **Server:** fremde Erinnerungen sichtbar; Pause nicht beachtet; Recht beim Auslösen nicht geprüft;
    Push an alle Bearbeiter; bleibt wartend (Doppelversand); neues Datum macht nicht scharf; Zähler ohne
    Erinnerungen; Zusammenfassung zieht nicht ab; Datenauskunft ohne; Stellen in der History.
  - **Oberfläche:** Marke fehlt; Karte zeigt die nächste nicht; Formular ohne Escape.
  - **Aufgefallen:** Die erste Escape-Gegenprobe blieb grün. Die Schutzbedingung im Detail („nicht schließen,
    solange das Formular offen ist“) war wirkungslos: Formular und Detail sind Geschwister im `body`, ein
    Escape im Formular erreicht das Detail nie. Die Bedingung ist entfernt; die Gegenprobe schaltet jetzt das
    Escape des Formulars ab und wird rot.

**Deploy Meldungs-Erinnerungen (01.10.2026, 13:51, `66f2a13`, Cache 442).** Die Suite lief 270 von 270 auf der
Kopie von 12:23. Vollsicherung `arbeitsdoku_backup_20261001-135117.adbk` (dreifach, gleiche Prüfsumme,
Rückspielprobe). Rückkehrpunkt `vor-meldung-erinnerungen-deploy` (= `18b8852`). Datenbank: 57 → 58 Tabellen,
neu ist `meldung_erinnerungen` (leer). Alte Tabellen und Spalten sind unverändert, die Datei ist heil. Im
Serverprotokoll steht nach mehreren Zeitplaner-Läufen kein Fehler.

## GitGuardian: privater VAPID-Schlüssel im Repo (01.10.2026)

GitGuardian meldete am 01.10.2026 einen privaten VAPID-Schlüssel in `AlexGutzeit/arbeitsdoku`.

- **Befund:** Sieben Tests trugen seit dem 27.06.2026 (erster Push-Test) dasselbe Schlüsselpaar fest im
  Code. Ausgelöst hat die Meldung die siebte Datei, der neue Test `meldung-erinnerungen.js`, weil er den
  Kopf aus einem älteren Test übernommen hatte.
- **Wessen Schlüssel:** Verglichen wurden nur Prüfsummen, kein Wert wurde angezeigt. Es war der Schlüssel der
  **lokalen Entwicklungsumgebung** (Laptop-`.env`). VPS und Mini-PC haben einen anderen Schlüssel. Der
  Prod-Schlüssel stand in keinem der 246 in Frage kommenden 43-Zeichen-Werte der gesamten Git-Geschichte
  (alle Zweige). `.env` und `.env.deploy` wurden nie committet.
- **Risiko:** gering. Mit dem Schlüssel ließen sich nur Pushs an Browser schicken, die sich beim lokalen
  Testserver angemeldet hatten.
- **Behoben:**
  1. Die sieben Tests erzeugen ihr Paar beim Start (`webpush.generateVAPIDKeys()`).
  2. In der lokalen `.env` steht ein neues Paar. Der Dev-Server auf :3000 ist neu gestartet und liefert
     nachweislich den neuen Schlüssel aus. Die `.env` hat jetzt die Rechte 600.
  3. Der neue Wächter `tests/keine-geheimnisse.js` durchsucht jede verfolgte **und jede neue, noch nicht
     committete** Datei nach privaten VAPID- und PEM-Schlüsseln und nach den Werten der geheimen Einträge
     der lokalen `.env`. Gegenproben 3 von 3 rot, jeweils aus dem richtigen Grund: alter Schlüssel, lokales
     `JWT_SECRET`, PEM-Kopf.
  - Das PEM-Beispiel im Test wird zur Laufzeit zusammengesetzt, sonst schlüge er bei sich selbst an.
- **Nicht gemacht:** Die Git-Geschichte wurde nicht umgeschrieben. Das ginge nur per Force-Push und erreicht
  Kopien und Zwischenspeicher trotzdem nicht; der alte Schlüssel ist nach dem Tausch wertlos.
- **Für Alex:** Die Meldung bei GitGuardian als erledigt markieren („revoked“).

## R31: Anmelde-Schleife durch den Browser-Zwischenspeicher (01.10.2026)

Alex' PWA (Chrome, Android) warf ihn ab 20:24 nach jeder Anmeldung sofort wieder heraus, auch mit
Zwei-Faktor-Code. Vivaldi auf demselben Handy ging. Weder das Schließen der App noch das Löschen der
Website-Daten half.

**Spurensuche:**
- **Protokoll:** Darin stand „Anmeldung erfolgreich“ und „Sitzung abgelaufen“ in derselben Sekunde
  (20:30:16, 20:49:39, 21:09:41). Der letzte Fall kam nach dem Löschen der Website-Daten; die App hatte
  wieder den Code verlangt.
- **Server:** Ein frisch ausgestelltes Token mit Alex' echtem Kontostand (Zwei-Faktor wöchentlich,
  Höchstdauer 7 Tage) ließ er in-process durch.
- **Nachstellung:** Sie klappte erst mit dem Zwischenspeicher. Nach dem Neuladen lieferte der Server
  `X-Neues-Token` mit, Chrome hob die Antworten mit ETag auf. Nach der Neuanmeldung kamen `304` für
  `/api/badges`, `/api/auth/me` und `/api/avatare`, Chrome gab die gespeicherten Antworten mit dem alten
  Token heraus, die App übernahm es, und es folgten `401` und `#/login`.

**Lösung (zwei Sicherungen, je einzeln gegengeprüft):**
- **Server:** `app.set('etag', false)` plus `Cache-Control: no-store` für `/api`. Eigene Regeln einzelner
  Routen (Profilbilder `private, max-age=300`) setzen sich danach durch. Die statischen Dateien hatten schon
  vorher kein ETag.
- **App:** `istNeueresToken(neu, aktuell)` (app-1-core.js) lässt nur ein Token mit größerem `iat` und
  `exp` in der Zukunft zu, für `X-Neues-Token` und für das `storage`-Ereignis anderer Tabs.
- **Protokoll:** `session_expired` nennt Anfrage und Alter des Tokens. Die Sperre gegen Wiederholungen gilt
  jetzt je Token statt je Nutzer.
- **Test** `tests/sitzung-zwischenspeicher-ui.js` (12, Port 3365). **Gegenproben 5/5 rot:** Server-Sicherung,
  App-Sicherung (Kopfzeile), App-Sicherung (Tab), beide (die Schleife: zurück auf `#/login`) und das
  Protokoll. Ist nur eine Sicherung weg, bleibt die Schleife aus; das ist gewollt, darum prüft der Test
  jede Sicherung auch einzeln.
- **Sofortlösung bis zum Deploy:** Chrome → Browserdaten löschen → „Bilder und Dateien im Cache“.

**Deploy R31 (01.10.2026, 22:06, `4f81a93`, Cache 443) — auf Alex' Wunsch VOR der Suite** („full backup, dann
gleich den deploy … die Suite dann gerne hinterher“). Vorher liefen der neue Test (12/12) mit 5/5 Gegenproben
und neun bestehende Sitzungs- und Anmeldetests grün. Die volle Suite auf der Kopie von 22:04 lief beim Deploy
schon. `main` wurde per `git branch -f` gesetzt statt per `checkout` + `merge`, damit die laufende Suite nicht
kurz den alten Stand sah. Vollsicherung `arbeitsdoku_backup_20261001-220603.adbk` (dreifach, Rückspielprobe).
Rückkehrpunkt `vor-r31-deploy` (= `66f2a13`). Mit dem Deploy gingen auch die Teständerungen von heute mit
(VAPID-Schlüssel, Wächter). Auf Prod: `/api` mit `cache-control: no-store`, ohne ETag, auch mit If-None-Match
200. Datenbank 58/58 Tabellen gleich, Datei heil.
Die Suite danach (Kopie 22:04, gestartet vor dem Deploy, Dev-Server mit dem neuen Server-Code): **272 von 272
grün** (23:33). Alex bestätigte am Handy: „Ich bin wieder drin.“

## Persönliche Erinnerungen an Notizen (02.10.2026)

Alex: „Was bringt mir eine Notiz ‚Arbeit muss bis zum $Datum erledigt sein', wenn ich die Notiz verlasse und
gleich vergesse?“ Gewünscht war eine Erinnerung am Datum um eine Uhrzeit. Jeder stellt sich seine eigenen,
die Push hängt am Schalter „Notizen“.

**Entschieden (Rückfragen):** Stellen darf jeder, der die Notiz sehen kann. Erinnerungen gibt es nur für die
ganze Notiz, keine Checklisten-Punkte. Alex' Nachtrag: Der Klick auf die Push führt in die Notizen an die
Stelle der Notiz, hervorgehoben und mit „Erinnerung“ gekennzeichnet, wie bei den Meldungen.

**Aufbau:**
- **Gemeinsamer Kern `erinnerungen.js`.** Er enthält Prüfen der Eingabe, `umText`, `erinnerungsArt(def)` mit
  Lesen, Anlegen, Ändern, Löschen und `faelligePruefen` (erst vermerken, dann senden; verfällt statt
  nachzukommen) sowie `SPALTEN_SQL`.
- **Adapter.** Je Art liefert ein Adapter `zustand(db, zeile) → { kommt, grund }`, die Push, die
  Protokoll-Aktionen und den Protokolltext.
  - `meldung-erinnerungen.js` ist jetzt ein solcher Adapter mit unveränderter Schnittstelle. Belegt: 43/43 und
    22/22 vor und nach dem Umbau.
  - `notiz-erinnerungen.js` ist neu.
- **`notiz-zugriff.js`:** Hierher ist `canAccessNote` aus `routes/notes.js` umgezogen. Route und Zeitplaner
  stellen dieselbe Frage.
- **Tabelle `notiz_erinnerungen`** in `ensureErinnerungenSchema`, beim Start und auf dem Rückspielweg. Sie ist
  in `reste.js` eingetragen (Notiz und Konto). Notiz löschen und Konto löschen nehmen sie ausdrücklich mit.
- **Routen:** `GET/POST /api/notes/:id/erinnerungen` (Zugriff nötig, sonst 404) und `PUT/DELETE
  /api/notes/erinnerungen/:eid` (nur eigene; Ändern nur mit Zugriff, Löschen immer).
  - `GET /api/notes` liefert je Notiz die eigenen Erinnerungen und `gesehen_bis`.
- **Zähler und Zusammenfassung:** Der Zähler `notes` zählt `notizErinnerungen` mit, aber nur an Notizen der
  Übersicht, keine Projektnotizen. Die Zusammenfassung zieht sie ab.
- **Push:** über `notes`, mit Ziel `notiz` beziehungsweise `projekt` bei Projektnotizen.
- **Oberfläche:**
  - **Gemeinsame Bausteine** in app-1-core: `erinnerungZeit`, `erinnerungEintraegeHtml`, `erinnerungFormular`.
    Die Meldungen nutzen sie auch; die Kennungen `#ef-*` und `.erinnerung-*` sind neu.
  - **Editor:** Menüpunkt „🔔 Erinnern“ über `notizWegeApp.menue`. Die Gästeseite hat ihr eigenes Menü; der
    Test `notiz-gaeste-ui` verlangt dort weiterhin genau Drucken, PDF, Word und ODT. Dazu kommen die Zeile
    „🔔 Deine Erinnerung“ unter dem Titel und der Dialog „Meine Erinnerungen“.
  - **Übersicht:** Die Karte zeigt die nächste Erinnerung und die Marke „🔔 Erinnerung“. Die Seite merkt sich
    `_notizenSeit` beim Betreten, sonst verschwände die Marke beim stillen Auffrischen der Live-Notizen.
- **Tests:**
  - `notiz-erinnerungen.js` (31, gestellte Uhr).
  - `notiz-erinnerungen-ui.js` (20, Port 3366): Der echte Zeitplaner löst aus, Coin live, der Push-Klick
    führt zur hervorgehobenen Karte mit Marke, auch nach dem Auffrischen.
  - `notizen-export-ui` kennt den neuen Menüpunkt.

**Nachträge (Alex, 02.10.2026):**
- **Marken „neu“ und „bearbeitet“ in der Notizen-Übersicht**, wie bei den Meldungen.
  - **Server:** `GET /api/notes` liefert `ungelesen` (`neu` = neu freigegeben, geht vor; `bearbeitet` = von
    anderen geändert, auch von einem Gast). Mit `?seit=` rechnet er gegen den Stand beim Betreten.
  - **Vorher:** Jede stille Auffrischung rechnete gegen das eben gesetzte „gesehen“, Hervorhebungen
    verschwanden nach Sekunden.
- **Wettlauf beim Betreten, gefunden durch den neuen Test** `notizen-marken-ui` (16):
  - **Ablauf:** Ein Live-Ereignis (hier: ein Gast speichert) kam an, während die Seite noch lud. Die stille
    Auffrischung lief mit dem Stand des **vorigen** Besuchs, kam nach dem Laden an und überschrieb die Marken.
    Jede Notiz war „neu“.
  - **Lösung:** `_notizenSeit = null`, bis die Seite geladen ist, und `notizenAuffrischen` wartet so lange.
  - **Belege:** Gegenprobe ohne Riegel rot, mit Riegel 3 von 3 Läufen grün.
  - **Fehlersuche:** Der Debug-Lauf mit zusätzlichen Ausgaben war grün; er traf das Zeitfenster nicht.
- **Gegenproben der Marken 4 von 4 rot:** Reihenfolge, Auffrischen ohne Besuchsstand, Server ignoriert
  `seit`, Karte ohne Marke.
- **Push nur an wer nicht drin ist, auch bei Gast-Änderungen** (Alex). Das war schon so
  (`notizen-live.js`, Filter `drin`). Neu ist der Fall „Gast schreibt, Mitleserin ist drin“ in
  `push-targeting` (58). Gegenprobe ohne Filter: 4 Prüfungen rot.
- **Fund des Wächters `tests/reste.js` (R27):** Das endgültige Löschen eines Projekts (`/purge`) löschte die
  Projektnotiz mit einer eigenen Tabellenliste. Darin fehlten die neuen Erinnerungen. Jetzt räumt die Route
  nach dem Löschen der Notiz über `reste.nachLoeschen(db, 'notes')` alles ab, was `reste.js` als Anhängsel einer
  Notiz kennt; eine künftige Tabelle kann dort also nicht mehr fehlen. Prüfung im Server-Test (32), Gegenprobe
  ohne den Aufruf rot.

**Deploy Notiz-Erinnerungen + Marken (02.10.2026, 13:41, `12e6652`, Cache 445).** Die Suite lief 275 von 275
auf der Kopie von 12:10. Vollsicherung `arbeitsdoku_backup_20261002-134048.adbk` (dreifach, gleiche Prüfsumme,
Rückspielprobe). Rückkehrpunkt `vor-notiz-erinnerungen-deploy` (= `4f81a93`); `main` wurde per `git branch -f`
gesetzt. Datenbank: 58 → 59 Tabellen, neu ist `notiz_erinnerungen` (leer). In `entries` kam ein Eintrag aus dem
laufenden Betrieb dazu (13:42); alle 1463 alten Zeilen sind unverändert, die Datei heil. Neue Stammdateien
`erinnerungen.js`, `notiz-erinnerungen.js` und `notiz-zugriff.js` liegen auf dem Server. Im Protokoll nach
mehreren Zeitplaner-Läufen kein Fehler.
- **🔔 an der Karte (Alex, 02.10.2026, nach dem Deploy):** In der Übersicht steht links neben ✎ eine Glocke, an
  jeder Karte (auch nur lesend freigegeben). Sie öffnet „Meine Erinnerungen“ direkt, ohne die Notiz zu öffnen
  und ohne die Karte aufzuklappen. Dass die Karte nicht aufklappt, macht übrigens nicht das `stopPropagation`
  des Knopfs, sondern die Karte selbst, die Klicks in `.note-actions` ignoriert; die erste Gegenprobe, die nur
  `stopPropagation` entfernte, blieb deshalb grün. Danach frischt die Liste still auf, damit die Karte die
  nächste Erinnerung zeigt. `notizErinnerungenDialog(id, { titel, nachAenderung })` kennt den Titel jetzt auch
  ohne Editor. Ist eine Erinnerung offen, ist die Glocke blau umrandet. Test `notiz-erinnerungen-ui` (25);
  Gegenproben 3/3 rot: kein Auffrischen; Glocke ganz entfernt (`hidden` allein überstimmt die `.btn`-Regel nicht —
  diese erste Probe blieb grün); Karte ignoriert die Knopfreihe nicht mehr und kein `stopPropagation`.

**Deploy Glocke an der Notizkarte (02.10.2026, 17:36, `889dc89`, Cache 446).** Die Suite lief 275 von 275 auf der
Kopie von 16:04. Vollsicherung `arbeitsdoku_backup_20261002-173550.adbk` (dreifach, gleiche Prüfsumme,
Rückspielprobe). Rückkehrpunkt `vor-glocke-deploy` (= `12e6652`). Die Datenbank ist vorher/nachher in allen
59 Tabellen gleich, die Datei heil.

## Zwei-Faktor: Die Vorgabe der Rolle ist das Minimum (03.10.2026)

Alex fragte: Wer freiwillig „wöchentlich“ eingestellt hat und dann vom Admin „monatlich“ vorgeschrieben
bekommt — bleibt es bei wöchentlich? Bisher nein. Die Vorgabe gewann in **beide** Richtungen, die eigene
Auswahl war gesperrt, und man wurde seltener gefragt, als man wollte.

**Jetzt gilt:** Die Vorgabe ist das Minimum. Strenger geht immer, milder nicht. Es gilt die strengere Stufe.
- **Eine Regel, eine Stelle.** `zweifaktor.js` hat jetzt `STRENGE` (einmal pro Gerät < monatlich < wöchentlich
  < täglich < bei jeder Anmeldung), `wirksamerModus(modus, eigen)` und `erlaubteEigeneModi(modus)`. Die Regel
  „Rolle gewinnt“ stand an **fünf** Stellen: `codeNoetig`, `sitzungsGrenzeTage`, `routes/auth.js` zweimal
  (Gerät merken) und `app-5` (Erklärung der gemerkten Geräte). Jetzt fragen alle `wirksamerModus`; die
  Oberfläche nimmt `wirksam` vom Server.
- **`routes/twofa.js`:**
  - **Status** liefert `wirksam` und `wirksam_text`.
  - **`modi_auswahl`** enthält nur die erlaubten Stufen; wählbar ist sie, sobald mehr als eine erlaubt ist.
  - **Eigene Stufe setzen** weist nur noch eine *mildere* Stufe ab (403 „mindestens …“); bisher wurde jedes
    Umstellen unter Pflicht abgewiesen.
- **Mein Konto:**
  - **Anzeige:** „Abfrage: wöchentlich (von dir gewählt — strenger als die Vorgabe ‚monatlich‘)“.
  - **Auswahl:** zeigt bei einer Vorgabe nur gleich strenge oder strengere Stufen.
  - **Hinweis:** „Für deine Rolle gibt die Verwaltung mindestens … vor — strenger kannst du es jederzeit
    einstellen, milder nicht.“
- **Einstellungen (Admin/Chef):** Ein Satz über den Auswahlfeldern sagt, dass die Stufe je Rolle das Minimum
  ist — vorher stand nirgends, was die Vorgabe mit einem eigenen Wunsch macht.
- **Test:** `twofa-eigenes-intervall` ist auf die neue Regel umgestellt. Der alte Test prüfte ausdrücklich
  „Pflicht monatlich schlägt Wunsch immer“, also die alte Absicht, nicht einen Fehler. Neu sind die
  Rechentabelle (`wirksamerModus`, `erlaubteEigeneModi`, `codeNoetig` mit Vorgabe und Wunsch) und über die
  Schnittstelle: Unter Pflicht ist Milderes 403 und Strengeres 200, und es gilt dann auch.
  - **Alex' Ablauf vom 23.08.** (monatlich → Pflicht wöchentlich → Pflicht weg → wieder monatlich →
    abschalten) gilt unverändert.

**Deploy Zwei-Faktor-Minimum (05.10.2026, 15:23, `3cd5a76`, Cache 447).** Die volle Suite lief 275 von 275 auf der
Kopie vom 03.10. 18:49; vor dem Deploy liefen die 18 Prod-Klon-Tests noch einmal auf einer frischen Kopie von
05.10. 15:13, alle grün. Mit ausgerollt: die README-Ergänzung der Push-Tabelle (Projektnotiz, drei Erinnerungsarten).
Vollsicherung `arbeitsdoku_backup_20261005-152240.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe).
Rückkehrpunkt `vor-2fa-minimum-deploy` (= `889dc89`). Die Datenbank ist vorher/nachher in allen 59 Tabellen
gleich, die Datei heil. Auf Produktion ist keine Rollen-Vorgabe gesetzt; für das eine eingerichtete Konto gilt
vorher wie nachher dieselbe Stufe — der Umbau ändert im Bestand nichts.

## Profilbild an weiteren Stellen (05.10.2026)

Alex: Der Avatar stand in der Planung nur in der **Tagesansicht** — „konsistent auch in der Wochen- und
Monatsansicht". Dazu sollte ich Stellen vorschlagen; genommen hat er 1–7, dazu der Menükopf (sein Foto).

**Ursache der Lücke:** Woche und Monat (`renderPlanningGrid`) schrieben im Spaltenkopf nur den Namen. Das
Nachladen der Bilder läuft app-weit von selbst (MutationObserver auf `#app`), es fehlte nur der Platzhalter.

**Zwei Regeln, je nach Art der Stelle** (beide stehen im Kommentar an `avatarHtml`):
- **Spalten, Menü, Auswahl** (`'weg'`) — Planung Woche/Monat, Menükopf, Abwesenheitskalender, Planungsformular:
  Ohne Bild bleibt alles wie bisher, der Platzhalter ist unsichtbar und nimmt keinen Platz ein. Das ist Alex'
  Regel vom 22.08. und das Versprechen auf „Mein Konto". Deshalb wird auch in senkrechten Namenslisten
  (Kalender, Formular) **kein** Platz freigehalten — so hält es schon die Mitarbeiterliste.
- **Listen mit Namen im Text** (`'initialen'`) — Abwesenheitsanträge, Meldungen (Karte + Detail), Aushänge (Brett +
  Willkommensseite): Ohne Bild steht ein Initialen-Kreis, sonst stünden Namen mit und ohne Bild durcheinander.
  Vorbild war „mit …" auf der Willkommensseite.

**Was dabei zu beachten war:**
- **Gelöschte Konten** heißen in Meldungen und Aushängen „Gelöschtes Konto", die Kennung steht aber noch in
  `created_by`. Ein Initialen-Kreis „GK" wäre falsch. Deshalb liefert der Server die Kennung fürs Bild nur,
  solange das Konto besteht: `cu.id AS melder_id` (routes/meldungen.js), `u.id as author_id`
  (routes/bulletin.js, alle vier Abfragen). Automatische Meldungen (`created_by` NULL) bekommen so auch keinen
  „AU"-Kreis. Kein Namensvergleich im Browser.
- **Das Meldungs-Detail hängt am `<body>`**, nicht in `#app` — den beobachtet das Nachladen nicht. Dort steht
  jetzt ein ausdrückliches `avatareLaden(overlay)`. Wer weitere Dialoge mit Bildern baut: dasselbe.
- **Menükopf:** Ohne Bild verschwindet der ganze Link per `.sidebar-konto:has(> .avatar--leer)`. Sonst bliebe
  ein unsichtbarer Tab-Stopp. `kopfzeileAvatarAktualisieren()` zieht ihn nach Hochladen/Entfernen mit.
- **„Mein Konto"** nannte, wo das Bild erscheint („Planung, Zeitnachweis und Auftrags-Board"). Der Text nennt
  jetzt alle Stellen und sagt ehrlich, dass in Listen ohne Bild Initialen stehen — der alte Satz „Ohne Bild bleibt
  dort alles wie bisher" stimmte für die Listen nicht mehr.

**Nachtrag Zeitnachweis Woche/Monat** (Alex: „gleich mit"): Dieselbe Lücke wie in der Planung, in
`app-3-dashboard.js` beide `grid-col-header` über `rasterBild(col)`. Dieselbe Regel wie in der Tagesansicht:
Sieht ein Mitarbeiter nur sich selbst („Meine Einträge"), steht kein Bild. Gegenproben GZ1 (kein Bild → 4 rot) und
GZ2 (Bild auch beim Mitarbeiter selbst → 2 rot). Sie liefen in einem eigenen Worktree, weil die Suite gerade lief
und die Avatar-Tests den Bilderordner `storage/avatare` löschen — gleichzeitig mit `twofa-anmeldung` oder
`willkommen-avatare-ui` hätten sie die aus dem falschen Grund rot gemacht.

**Test:** `tests/avatar-orte-ui.js` (49, Port 3368) prüft jede Stelle mit einer Person mit Bild und einer
ohne: unsichtbar und ohne Platz bzw. Initialen. Dazu Menükopf (Lage, Klick, Schublade schließt, Handy) und das
Nachziehen nach dem Hochladen. Mit `AVATAR_FOTOS=<ordner>` legt er Bildschirmfotos ab.

Gegenproben, alle an der erwarteten Stelle rot:
- **G1** Woche ohne Avatar → 2 rot.
- **G2** ohne `:has`-Regel → 2 rot.
- **G3** ohne `avatareLaden(overlay)` → 1 rot (Initialen statt Bild).
- **G4** Server ohne `melder_id` → 4 rot.
- **G5** Anträge ohne `'initialen'` → 1 rot.
- **G6** Menükopf zieht nicht mit → 1 rot.

Der Erstlauf war an zwei Stellen rot, beide Male lag es am Test, nicht an der App:
- Das Menü ist auch bei 1280 px eine Schublade. Die Lageprüfung lief außerhalb des Bildschirms und war
  trotzdem grün — erst der Klick fiel um. Jetzt wird aufgeklappt, und es wird geprüft, dass das Bild im
  sichtbaren Bereich liegt.
- „admin" heißt als Rolle „Administrator".

**Suite (Kopie 05.10. 18:14): 275 von 276.** Rot war einmal `scroll-ruckeln-prodklon` mit „Seite ist scrollbar".
Der Test misst, ob die Willkommensseite des Admins mit den echten Daten über 200 px hoch wird, und wartet darauf.
Danach lief er fünfmal allein, alle 30 Prüfungen grün. Das deutet auf die Wartezeit unter Last, nicht auf diese
Änderung (die Willkommensseite hat nur am Aushang ein 18-px-Bild dazubekommen, das macht sie nicht kürzer).
Die vielen 404 in seiner Konsole sind Profilbild-Abrufe: Die Prod-Kopie hat die Einträge in `user_avatars`, aber
nicht die Bilddateien. Mit einem Aufzeichnungsskript belegt, dass nur `/api/avatare/<id>` betroffen ist.

**Deploy Profilbild-Stellen (05.10.2026, 20:14, `537c944`, Cache 448).** Suite 275 von 276 auf der Kopie von 18:14
(der eine Ausreißer s. o., allein fünfmal grün). Vollsicherung `arbeitsdoku_backup_20261005-201424.adbk` (dreifach,
gleiche Prüfsumme, Rückspielprobe samt 6 Profilbild-Dateien). Rückkehrpunkt `vor-avatar-orte-deploy`
(= `3cd5a76`). Die Datenbank ist vorher/nachher in allen 59 Tabellen gleich, die Datei heil.

## Scroll-Tests nachgeschärft (05.10.2026, nach dem Deploy)

Alex fragte, was „das Ruckel-Problem" in der Suite war, und wollte sichergestellt haben, dass die App beim
Scrollen nicht wieder ruckelt (Juli: die Uhr der Willkommensseite löste jede Sekunde eine Wiederherstellung der
Scrollposition aus, `ce14e89`).

**Der Ausreißer war kein Ruckeln.** Rot war nur die Vorbedingung „Seite ist scrollbar". Die eigentliche Messung
auf der Willkommensseite lief auch in dem Lauf und war grün; der Test verkleinert das Fenster, wenn die Seite zu
kurz ist. Gemessen: Mit den echten Daten ist die Willkommensseite des Admins **ohne Wetterkarte gar nicht
scrollbar** (0 px Überstand), mit ihr 322 px. Das Wetter kommt über zwei fremde Dienste; antworten die unter
Last zu spät, fehlt die Karte. → Der Prod-Klon-Test bekommt jetzt eine feste Wetterantwort (7 Tage wie der echte
Dienst; mit 4 Tagen waren es nur 151 px).

**Dabei kam ein echter Mangel heraus.** Beide Scroll-Tests wurden gegen den nachgebauten Juli-Fehler geprüft:
Die Uhr löst bei jedem Tick wieder aus, und die Position wird wieder 120 ms verzögert gemerkt.
- `scroll-ruckeln-ui` fand ihn sofort (840 → 240 px).
- `scroll-ruckeln-prodklon` blieb **grün**. Mit 60-px-Schritten war die kurze echte Seite nach einer halben
  Sekunde unten, bevor die Uhr tickte. Der Fehler konnte dort gar nicht auftreten.

Jetzt richtet sich die Schrittweite nach der Seite (40 Schritte, ≈ 3,6 s, also mindestens drei Ticks). Mit
dem nachgebauten Fehler wird er rot (3 Rücksprünge), mit dem echten Code bleibt er grün (31).

**Profilbilder:** `scroll-ruckeln-ui` scrollt jetzt MIT geladenen Profilbildern (8 Personen) und mit der Seite
Meldungen (15 Meldungen). Er prüft, dass die Bilder wirklich da sind — Inhalt, der während des Scrollens
nachkommt, ist genau die Art Auslöser vom Juli. Das Ergebnis: 23 Prüfungen, kein Rücksprung. Das Nachladen ändert
nur Stil und Text eines vorhandenen Elements, keine Elemente — der Beobachter reagiert darauf gar nicht.

## Menü: Papierkorb wieder zuklappbar (05.10.2026)

Alex: „Das Papierkorb-Menü kann man aufklappen, aber nicht mehr zuklappen." Die Gruppe klappte zusätzlich bei
`:hover` auf (`.nav-group:hover .nav-subitem`). Am Rechner steht der Mauszeiger nach dem Klick noch darüber, am
Handy „klebt" `:hover` nach dem Antippen am Element. Das Tippen nahm `.open` weg, `:hover` hielt die Gruppe offen.
Nachgestellt: am Rechner sofort (2. Klick → `open:false`, aber sichtbar). Die Touch-Simulation des Testbrowsers
bildet das Kleben nicht nach — der Maus-Fall ist deshalb der scharfe.

Jetzt nur noch `.open`. Der Gruppenkopf ist `role="button"` mit `aria-expanded` und lässt sich mit Enter/Leertaste
bedienen; das Binden steht in `navGruppeBinden()` (app-2), weil die Kollegen-Gruppe nach dem Laden ausgetauscht
und neu gebunden wird. Test `menue-gruppen-ui.js` (19; Papierkorb und Kollegen, Maus, Tastatur, Handy).
Gegenproben: Hover wieder an → 4 rot (genau der gemeldete Fall); Kollegen-Gruppe nach dem Austausch nicht neu
gebunden → 3 rot.

## Kollegen (05.10.2026)

Alex' Wunsch: Menüpunkt „Kollegen" mit den aktiven Kollegen als Unterpunkten; je Person Name, Bild, Geburtstag
und Alter (wenn freigegeben) und ein Freitext „Infos für die Kollegen" aus Mein Konto. Dazu Telefon und E-Mail
freiwillig mit Haken (sein Nachtrag). Aus meinen Vorschlägen gewählt: ausgeliehenes Werkzeug, vCard (mit E-Mail),
„Neu im Team". Liste: alle aktiven Konten außer der Rolle admin, ohne einen selbst.

**Server — `routes/kollegen.js`** (die Freigabe-Regel steht NUR dort):
- **Endpunkte:** `GET /` (Liste), `GET /mein-profil` und `PUT /mein-profil` (immer gegen `req.user.id`, vor
  `/:id`), `GET /:id`, `GET /:id/vcard`.
- **Freigabe:** `sichtbar(db, u)` ist die EINE Stelle für Seite und vCard. Telefon und E-Mail nur mit Haken, der
  Geburtstag nur mit `geburtstag_freigabe.zeigen`, das Alter nur mit `alter_auch`. Das Geburtsjahr geht nie
  hinaus (Tag, Monat, berechnetes Alter).
- **Admin:** Für Kollegen ist er 404; die eigene Vorschau ist für jeden abrufbar, auch für den Admin.
- **Neue Tabelle `kollegen_profil`** (`ensureKollegenSchema`, beim Start UND beim Zurückspielen). In `reste.js`
  als Anhängsel eingetragen, damit „Konto endgültig löschen" sie mitnimmt. In der Datenauskunft unter
  `fuer_die_kollegen`.
- **Protokoll** `kollegen_profil`: nur WAS sichtbar ist („Telefon: sichtbar / nur gespeichert / leer"), nie
  Nummer, Adresse oder Text.
- **„Neu im Team":** Gemessen wurde, dass im Bestand ALLE Anstellungszeiträume im März 2026 beginnen, also bei
  der Einführung der App, nicht beim echten Eintritt. Nur „Beginn < 28 Tage" hätte bei jeder Firma, die die App
  neu einführt, vier Wochen lang jeden als „neu" gezeigt. Regel deshalb: erster Eintritt vor weniger als 28 Tagen
  (und nicht in der Zukunft) UND mindestens 28 Tage nach dem frühesten Beginn überhaupt. Wiedereinstellung zählt
  nicht.
- **vCard 3.0:** CRLF, Zeilen auf 75 Byte gefaltet, ohne UTF-8-Zeichen zu zerschneiden. Foto als JPEG 256 px aus
  dem großen Profilbild (`dateiFuer` aus routes/avatare.js exportiert). `BDAY` nur mit Alter-Freigabe — 3.0 kennt
  keinen Geburtstag ohne Jahr. Ohne freigegebenes Telefon oder E-Mail gibt es keine vCard (404, kein Knopf).

**Oberfläche — `public/js/app-11-kollegen.js`:**
- **Menügruppe:** „Alle Kollegen" plus je Kollege ein Eintrag. Sie wird nach `kollegenLaden()` (Start, Anmeldung,
  Übersicht) ausgetauscht.
- **Übersicht, Seite und „Für die Kollegen"** auf Mein Konto, mit Vorschau „So sehen dich deine Kollegen".
- **Geburtstags-Haken** stehen jetzt dort (dieselben IDs `geb-zeigen`/`geb-alter`, gespeichert weiter über
  `/api/users/geburtstag-freigabe`). Die Geburtstagskarte zeigt nur noch das hinterlegte Datum.
- **Profilbild:** überall `'initialen'` — ein Personenverzeichnis.
- **Neue Seiten** stehen in `SEITEN` und in `tests/seite-laden-ui.js`.
- **Sprung zur Karte:** Von einer Kollegen-Seite springt „Mein Konto → Für die Kollegen" direkt zur Karte. Dabei
  fiel auf, dass `scrollIntoView` die Kartenüberschrift HINTER die feste Kopfleiste schob →
  `#konto-kollegen { scroll-margin-top: 72px }`.

**Tests:**
- **`kollegen.js` (57):** Was nicht freigegeben ist, steht in KEINER Antwort — geprüft am Antworttext, nicht nur
  am Feld. „Neu im Team" prüft er über einen Neustart mit zurückdatierten Eintritten.
- **`kollegen-ui.js` (39):** Rechner, Handy, Admin, Mein Konto, Vorschau, vCard über einen abgefangenen
  `dateiHerunterladen`.

**Gegenproben**, alle an der erwarteten Stelle rot:
- **Server:**
  - E-Mail ohne Haken → 2 rot.
  - „Neu" ohne Einführungsregel → 1 rot.
  - Admin in der Liste → 1 rot.
  - Geburtstag ohne Haken → 1 rot. Der erste Versuch ließ den Server abstürzen (500) und war rot aus dem
    falschen Grund. Dabei fiel auf, dass das Zurücknehmen der Freigabe nicht geprüft wurde — jetzt schon.
- **Oberfläche:**
  - Menü ohne Initialen → 1 rot.
  - Telefon-Haken nicht entsperrt → 4 rot.
  - Anruf-Link ungefiltert → 2 rot.
  - Kein Sprung zur Karte → 1 rot.
  - Ohne Abstand zur Kopfleiste → 1 rot.
  - Die Sprung-Prüfung war zuerst ZAHNLOS: Am großen Bildschirm ist die Karte auch ohne Sprung im Bild. Jetzt
    misst sie, dass der Kartenkopf direkt unter der Kopfleiste steht.

## Profilbild fehlt: hängende Verbindungen (05.10.2026, Fund der Suite)

`barrierefrei-prodklon` lief in eine Zeitüberschreitung beim ersten Seitenaufruf (`networkidle2`). Gemessen:
- **Keine Endlosschleife** — in 15 s nur wenige Anfragen.
- **Abrufe `/api/avatare/6` und `/12` blieben im Browser „offen"**, obwohl der Server sofort 404 lieferte. In
  der Prod-Kopie stehen die zwei Bild-Einträge, die Dateien liegen nicht bei.
- **Ursache:** `avatareLaden()` las den Inhalt einer Fehlerantwort nie (`if (!antwort.ok) continue;`). Der Browser
  hielt die Verbindung für belegt. Weil jeder Kreis derselben Person neu fragte, häuften sich die offenen
  Verbindungen. Über HTTP/1.1 sind es höchstens sechs je Server, danach warten auch normale Anfragen der App.
- **Warum erst jetzt?** Das Muster steht seit August im Code. Sichtbar wurde es erst mit dem Kollegen-Menü: Die
  zwei Personen stehen jetzt auf JEDER Seite.

**Behoben** (`avatarHolen()` in app-1-core.js):
- Fehlerantwort verwerfen (`antwort.body.cancel()`).
- 404 für die Sitzung merken (`_avatarFehlt`).
- Laufende Abrufe teilen (`_avatarLaufend`): ein Abruf je Person, Größe und Stand.
- `avatareLaden` arbeitet die Kreise jetzt parallel ab.

**Test `avatar-fehlt-ui.js` (13):** Bild-Eintrag ohne Datei; Kollegen-Übersicht, Durchklicken, Personenseite,
Neuladen. Gegenproben:
- **GA1** nicht verwerfen → 2 rot (Verbindung hängt).
- **GA2** nicht merken → 2 rot (4 bzw. 8 Anfragen).
- **GA3** nicht teilen → zuerst 0 rot. Im Test luden Menü und Karte in getrennten Durchgängen. Den gemeinsamen
  Durchgang gibt es beim Neuladen (beide stehen schon da, bevor die App weiß, wer ein Bild hat) — mit diesem Fall
  im Test: 1 rot, 3 Anfragen statt einer.

**Nebenbei:** Beim Anhalten der Suite traf `kill $(pgrep -f "timeout 900 node tests/")` auch die eigene Shell
(Exit 144). Dieselbe Falle wie `pkill -f`: Der Suchtext stand in ihrer Befehlszeile.

**Deploy Kollegen + Menü-Fix + Profilbild-Fix (06.10.2026, 00:07, `cfbf8b0`, Cache 449).** Suite 280 von 280 auf der
Kopie vom 05.10. 21:57 (zweiter Lauf; den ersten habe ich nach dem Fund angehalten, weil sich mitten im Lauf Code
änderte). Vollsicherung `arbeitsdoku_backup_20261006-000646.adbk` (dreifach, gleiche Prüfsumme, Rückspielprobe
samt 6 Profilbild-Dateien). Rückkehrpunkt `vor-kollegen-deploy` (= `537c944`). Datenbank vorher/nachher: genau eine
neue Tabelle `kollegen_profil` (leer), alle 59 alten unverändert, Datei heil.

## Zeitnachweis: Jahr und Gesamt (06.10.2026)

Alex: „im Zeitnachweis gerne, ähnlich wie in Statistik, zusätzlich zu Tag, Woche, Monat auch Jahr und Gesamt."
Vorschlag angenommen: Zeilen = Zeiträume, Spalten = Personen wie in Woche/Monat; Gesamt nach JAHREN (bleibt auch
nach Jahren übersichtlich), ⚠️ als Anzahl je Zelle.

**Umsetzung (app-3-dashboard.js):**
- **Zeitraum:** `getDateRange`/`getPeriodLabel`/`navDate` kennen `year` und `total`.
- **Gesamt:** lädt ab 2000-01-01 bis heute und setzt danach `range.from` auf den ersten Eintrag (`S._gesamtVon`) —
  wie die Statistik (`routes/statistics.js`: MIN(date) bis heute). Soll und Überstunden sind dadurch in beiden
  gleich. Keine Pfeile, kein „Jetzt".
- **Ein gemeinsames Raster** `zeitraumRasterHtml(zeilen, …)`. Jahr gibt zwölf Monate hinein, Gesamt die Jahre (das
  erste und das laufende nur, soweit der Zeitraum reicht).
- **Zelle:** Nettostunden / Arbeitstage, Abwesenheiten je Art in Tagen (Mo–Fr, wie das Monatsraster) und die
  Verstöße: Tage mit Tages-Verstoß + Wochen mit Wochen-Verstoß, die Woche am MONTAG gezählt, damit sie über den
  Monatswechsel nicht doppelt zählt.
- **Sprung:** `data-jump-view` (month/year) — der bestehende Klick-Handler liest es, sonst wie bisher „Tag".
- **Soll eines Jahres** rechnet wie die Statistik über das ganze Jahr (im Oktober also mit dem Soll bis Dezember).
  Bewusst gleich, damit Zeitnachweis und Statistik dieselben Zahlen zeigen.

**Test `zeitnachweis-jahr-ui.js` (29):** Die Daten liegen in den VORJAHREN, sonst wäre der Test im Januar ein anderer
als im Oktober. Chef, Mitarbeiter, Handy, Filter, Sprung Jahr → Monat und Gesamt → Jahr.

**Gelernt beim ersten Lauf:** „⚠️ 2" statt 1 war richtig. Ohne Geburtsdatum gilt jemand als Jugendlicher, dann ist
schon ein 8-Stunden-Tag mit 30 Min. Pause ein Verstoß. Die Testperson hat jetzt ein Geburtsdatum. Und ein vom Chef
angelegter Urlaub ist noch nicht genehmigt; die Raster zeigen nur Genehmigtes. Jetzt beantragt der Mitarbeiter
selbst, und der Chef genehmigt.

**Gegenproben:**
- Sprung immer zum Tag → 2 rot.
- Gesamt ohne ersten Eintrag als Anfang → 4 rot (Zeilen ab 2000).
- Abwesenheit auch am Wochenende → 1 rot (🌴 3).
- Jahr ohne Filter → 1 rot.

**Zeitfalle in `complex-saldo-versioning` (06.10.2026, Fund der Suite).** Der Test legt seine Testwochen relativ zu
heute (+70, +140, +210 Tage). Am 06.10. traf die erste den 21.–25.12.: Heiligabend und 1. Weihnachtstag sind auf dem
Dev-Server Feiertage, das Soll war 24 statt 40 — zwölf rote Prüfungen ohne Bezug zum Code. Jetzt sucht
`feiertagsfreierMontag()` ab dem Wunschtag die nächste Woche ohne Feiertag (übersprang am 06.10. Weihnachten,
Neujahr und den 6.1. und nahm den 11.01.). Rot vorher, grün nachher, am selben Tag — das ist die Gegenprobe.

**Deploy Zeitnachweis Jahr/Gesamt (06.10.2026, 12:18, `83ba49c`, Cache 450).**
- **Suite:** 280 von 281 auf der Kopie vom 06.10. 10:41. Rot war nur `complex-saldo-versioning` (Zeitfalle
  Weihnachten, im Lauf repariert, einzeln 29/29). Der App-Code ist exakt der geprüfte (`24bda19`); danach kamen
  nur Tests und Doku dazu.
- **Sicherung:** Vollsicherung `arbeitsdoku_backup_20261006-121753.adbk` (dreifach, gleiche Prüfsumme,
  Rückspielprobe). Rückkehrpunkt `vor-jahr-gesamt-deploy` (= `cfbf8b0`).
- **Datenbankvergleich:** 60/60 Tabellen, keine neuen Spalten. EINE Abweichung: `tool_checkouts` 49 → 47. Ursache
  ist `cleanupToolHistory()` (server.js, seit 30.03.2026): Beim Start und täglich werden Ausleihen gelöscht, die
  seit mehr als drei Monaten zurückgegeben sind. Die beiden waren am 06.07. zurückgegeben — genau heute drei Monate
  alt. Gewollt; ein Vergleich über einen Neustart zeigt das immer dann, wenn gerade welche fällig werden.

## Rückfrage bei doppelten Einträgen + Regie-Filter mit allen Arten (06.10.2026)

Anlass war Alex' Filterprobe an den echten Daten (Gesamt = Jahr = Monate, alles gleich — jetzt fester Test
`zeitnachweis-summen-prodklon.js`). Dabei fielen zwei Dinge auf, beide von ihm entschieden:

**Doppelte Einträge — Rückfrage, kein Verbot.**
- **Was gefunden wurde:** Drei Fälle, und jeder war in ALLEN Inhaltsfeldern gleich. Zwei entstanden innerhalb
  einer Sekunde (Doppel-Tipper vor dem Klick-Schutz vom 24.07.), einer wurde über eine Stunde verteilt dreimal von
  Hand eingetragen.
- **Folge:** `calcActualHours` zählt die Zeit einmal, zieht aber die Pause jeder Kopie ab — die Tage standen zu
  knapp da. Die Kopien löscht Alex selbst.
- **Regel (`doppelterEintrag()` in routes/entries.js):** gleiche Person, gleicher Tag, Von, Bis, Pause, Projekt
  (Auswahl/Freitext), Kunde, Adresse, Beschreibung, Regie-Art. Gelöschte zählen nicht, beim Bearbeiten nicht der
  Eintrag selbst. Antwort 409 `EINTRAG_DOPPELT`; das Formular fragt „Trotzdem speichern?" und schickt dann
  `doppelt_ok`.
- **Erster Entwurf „Tag + Zeit + Projekt" war zu grob:** `pause-parallel-ui` (Alex' Kette vom 30.07.) und
  `hoechstarbeitszeit-ui` legen zeitgleiche Aufträge OHNE Projekt an — echte Parallelarbeit. Deshalb jetzt „alle
  Inhaltsfelder", geprüft an den drei echten Doppeln (dort war jedes Feld gleich).
- **Zwei Tests angepasst:** Sie legten zwei in JEDEM Feld gleiche Einträge als „zwei Aufträge" an. Die haben jetzt
  je eine eigene Beschreibung wie im Betrieb. Was sie prüfen (Pause bzw. Höchstzeit bei zeitgleichen Aufträgen),
  bleibt gleich.

**Regie-Filter.**
- **Vorher:** „Regie: Ja" hieß `has_regie > 0` und schloss pauschal (108), Büro (260), Lager (13) und Intern (68)
  mit ein.
- **Jetzt:** `regie=jede` (das alte Verhalten), `regie=1…5` genau eine Art, `regie=0` keine. Die Auswahl entsteht
  aus `REGIE_LABELS`.
- **Gefahrlos:** Nur der Zeitnachweis nutzt den Parameter, kein Bestandstest setzte das alte „Ja" voraus.

**Test `eintrag-doppelt-regie.js` (26):** Server (anlegen, bearbeiten, gelöscht, nur Notiz geändert,
Unterschiede je Feld), Formular (Abbrechen speichert nichts, „Trotzdem speichern" speichert), Regie-Filter Server
und Auswahl.

**Gegenproben**, alle an der erwarteten Stelle rot:
- **GD1** Server prüft nicht → 7 rot.
- **GD2** Formular fragt nicht → 2 rot.
- **GD3a** Projekt ignoriert (erster Entwurf) → 2 rot.
- **GD3b** Beschreibung ignoriert → 1 rot.
- **GD4** „Ja" wieder „jede Art" → 1 rot.

## Suche findet Projekt und Person; Jahr/Gesamt mit Filter nur Stunden (06.10.2026)

Alex, am Handy: „Wenn ich nach Projekt Benkert filtere, kommt mein einer Tag. Wenn ich im Freitext ‚Benk' eingebe,
wird nichts gefunden. Hab ich einen Denkfehler?" — Nein. Die Suche (`routes/entries.js`) schaute nur in Beschreibung,
Adresse, Kunde und `project_text`. Ein aus der LISTE gewähltes Projekt steht in `projects`, `project_text` bleibt leer.
Von 193 Einträgen des Projekts hatten nur 5 den Namen zufällig auch in Beschreibung/Kunde/Adresse. Jetzt sucht sie
zusätzlich in `p.name` und `u.name` (Person; Alex' Wahl).

Auf seinen Bildern stand außerdem mit Projekt-/Suchfilter in jedem Monat „⚠️ 12", „🏥 10" usw. Die gehören zum ganzen
Tag. Entscheidung: Mit Projekt-, Such- oder Regie-Filter zeigen Jahr und Gesamt nur die passenden Stunden, dazu ein
Satz über dem Raster (`nurStunden` in `zeitraumRasterHtml`). Der Abwesenheits-Filter zählt nicht dazu.

Tests: `eintrag-doppelt-regie` +5 (Suche), `zeitnachweis-jahr-ui` +5 (Filteranzeige). Gegenproben: ohne Projektname
→ 1 rot, ohne Person → 1 rot, Filteranzeige immer „alles" → 4 rot. Gebaut im Worktree, solange die Suite für die
Doppel-Rückfrage lief (die durfte nicht mitten im Lauf neuen Code sehen).

**Nachtrag: Groß/klein bei Umlauten.** Alex fragte, ob die Suche die Arbeitsbeschreibung durchsucht („Wechselrichter")
— ja (5 Treffer in den echten Daten), und Groß/klein ist egal. Beim Prüfen fiel auf: SQLites `LIKE` kennt Groß/Klein
nur für A–Z, „übergabe" fand „Übergabe" nicht, „ölwechsel" nicht „Ölwechsel". Die Suche vergleicht deshalb jetzt in JS
nach der Abfrage (`toLocaleLowerCase('de')`, NFC für zerlegt geschickte Umlaute). Die Abfrage hat kein LIMIT, also
wird nichts vorher abgeschnitten. Gegenproben: ohne Kleinschreibung → 4 rot, ohne NFC → 1 rot, ohne Projektnamen →
1 rot.
