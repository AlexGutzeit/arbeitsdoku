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
von Jakob Wolf (26.–28.05. und 01.06.) warteten dauerhaft auf seine Quittierung.

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
