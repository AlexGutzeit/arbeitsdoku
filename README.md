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
  - [Einstieg](#einstieg) · [Zeit erfassen und abrechnen](#zeit-erfassen-und-abrechnen) ·
    [Arbeit organisieren](#arbeit-organisieren) · [Zusammenarbeit](#zusammenarbeit) ·
    [Verwaltung](#verwaltung)
- [Was überall gilt](#was-überall-gilt)
- [📱 Für die Baustelle gedacht](#-für-die-baustelle-gedacht)
- [🔔 Push-Benachrichtigungen](#-push-benachrichtigungen-web-push)
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

> Diese Datei beschreibt den **aktuellen Stand**. Warum einzelnes so gebaut ist, wie es gebaut ist,
> und was sich wann geändert hat, steht in [`ENTWICKLUNG.md`](ENTWICKLUNG.md).

---

## Funktionsumfang

Jeder Punkt entspricht einem Menüpunkt in der App. Die Übersicht nennt in einem Satz, worum
es geht; die Abschnitte darunter beschreiben es im Einzelnen.

**Einstieg**

- [👤 Mein Konto](#-mein-konto) — Profilbild, eigenes Passwort, Zwei-Faktor-Anmeldung, Geburtstags-Freigabe, Benachrichtigungen, die eigenen Stammdaten und (für Mitarbeiter) der eigene PDF-Nachweis. Für **jede** Rolle.
- [🏠 Willkommen](#-willkommen) — Persönliches Dashboard: anstehende Planung, eigene Abwesenheiten, Wetter, Geburtstage.

**Zeit erfassen und abrechnen**

- [📊 Zeitnachweis](#-zeitnachweis) — Die Kern-Zeiterfassung samt Vorbelegung von Zeiten und Pausen.
- [🏖️ Abwesenheit](#-abwesenheit) — Krank, Urlaub, Freizeitausgleich und Co. — mit Genehmigungs-Ablauf.
- [📈 Statistik](#-statistik) — Ist/Soll/Überstunden je Zeitraum, als Diagramm und Zahl.
- [🧾 Abrechnung](#-abrechnung) *(Chef/Admin/Buchhalter)* — PDF-Nachweis, Lohn-Export und Monatsabschluss. Mitarbeiter finden ihren eigenen PDF-Nachweis unter [👤 Mein Konto](#-mein-konto).
- [🔒 Abrechnungs-Abschluss](#-abrechnungs-abschluss) — Abgerechnete Monate festschreiben, damit bezahlte Stunden sich nicht mehr verschieben.

**Arbeit organisieren**

- [📅 Planung](#-planung) — Einsatz- und Schichtplanung, auch als Serientermin mit Erinnerung.
- [📁 Projekte und Aufträge](#-projekte-und-aufträge) — Auftrags-Board mit Zuweisung, Zwischenzielen, Fristen und Statistik.
- [🔧 Werkzeugliste](#-werkzeugliste) — Wer hat welches Werkzeug — mit Ausleih-Historie.
- [🛒 Bestellungen](#-bestellungen) — Was fehlt auf der Baustelle; Chef und Admin sehen es sofort.

**Zusammenarbeit**

- [📌 Schwarzes Brett](#-schwarzes-brett) — Aushänge fürs Team, auf der Willkommensseite eingeblendet.
- [📝 Notizen](#-notizen) — Eigene Notizen, einzeln freigebbar.
- [🗂️ Dokumente](#-dokumente) — Dateiablage mit Ordnern und Speicherlimits.

**Verwaltung**

- [👥 Mitarbeiter](#-mitarbeiter) — Konten, Soll-Stunden, Urlaubsanspruch, Ein- und Austritt.
- [⚙️ Einstellungen](#-einstellungen) — Arbeitszeit-Vorgaben, Zwei-Faktor-Pflicht je Rolle, Branding, Rechtstexte, Backup.
- [📜 Audit-Log](#-audit-log) — Wer hat wann was geändert.
- [🗑️ Papierkorb](#-papierkorb) — Gelöschtes bleibt erhalten und ist wiederherstellbar (GoBD).

### Einstieg

#### 🏠 Willkommen

Persönliches Dashboard: anstehende Planung, eigene Abwesenheiten, Schnellüberblick. **Karten sind anklickbar:** Ein Antippen führt beim **Termin** in die Tagesansicht der Planung zum richtigen Tag und hebt den angetippten Termin dort kurz hervor, beim **Aushang** zum Schwarzen Brett und dort zu diesem Eintrag — per Tastatur mit Enter oder Leertaste. Die Knöpfe *Navigieren* und *Übernehmen* in der Termin-Karte behalten ihre eigene Wirkung; Abwesenheiten sind bewusst nicht anklickbar. **Wetter** zum Firmenort (aus *Einstellungen → Firmen-Einstellungen*): aktuelle Lage, stündlicher Tagesverlauf und eine **7-Tage-Vorschau** mit je **früh / mittag / abend** (Symbol, Temperatur, Regenwahrscheinlichkeit). **Der heutige Tag steht nur oben** als stündlicher Verlauf; die Liste darunter beginnt mit
**morgen**. Jeder Tag der Liste lässt sich **antippen** und zeigt dann seinen **stündlichen** Verlauf – so weit reichen die hochauflösenden Modelle, darüber hinaus gibt es keine belastbaren Vorhersagedaten. Ohne hinterlegten Ort erscheint statt des Wetters ein Hinweis. **🎂 Eigener Geburtstag:** Wer selbst Geburtstag hat, sieht ganz oben *„Alles Gute zum Geburtstag! — Schön, dass du da bist."* — **jede** Person, auch Mitarbeiter, und **nur sie selbst**. Ohne Alter und ohne Absender, denn fremde Geburtstage bekommt das Team gar nicht angezeigt. Dafür wird nichts vom Server geholt: Das eigene Geburtsdatum liegt für die Pausen-Vorbelegung ohnehin im Browser. Wer am **29. Februar** geboren ist, wird in Nicht-Schaltjahren am 28. gefeiert, mit Vermerk. **🎂 Geburtstag heute:** Hat jemand Geburtstag, steht ganz oben *„Tina Torte wird heute 36 🎉"* — wie die Schwarzes-Brett-Einblendungen einfach da, nichts zum Wegklicken, am nächsten Tag von selbst weg. **Nur Chef/Admin/Buchhalter** sehen das: Diese drei bekommen das Geburtsdatum über die Mitarbeiterliste ohnehin, eine Anzeige für die **ganze Belegschaft** wäre dagegen einwilligungspflichtig (§ 26 BDSG trägt sie nicht). Der eigene Geburtstag wird ausgelassen, ausgestellte Mitarbeiter erscheinen nicht, und das Geburtsdatum selbst verlässt den Server nicht — übertragen werden nur Name und Alter. Wer am **29. Februar** geboren ist, erscheint in Nicht-Schaltjahren am 28. mit dem Vermerk „Geboren am 29. Februar — den gibt es dieses Jahr nicht, deshalb heute."

### Zeit erfassen und abrechnen

#### 👤 Mein Konto

Die persönliche Seite — für **alle** Rollen sichtbar, auch für Mitarbeiter.

**Zwei Wege dorthin:** der Menüpunkt **👤 Mein Konto** im Seitenmenü, oder ein Klick auf das
eigene **Profilbild bzw. den Namen oben rechts** in der Kopfzeile. Beides führt an dieselbe
Stelle.

**Profilbild:** Jeder kann ein Bild hochladen; es erscheint neben dem eigenen Namen in der
Kopfzeile und in den Spalten von Planung, Zeitnachweis und Auftrags-Board sowie in der
Mitarbeiterliste. **Wer kein Bild hochlädt, ändert für die anderen nichts** — die Ansicht bleibt
genau wie vorher. Jedes Bild lässt sich jederzeit wieder **entfernen**.

**Du wählst den Ausschnitt selbst.** Nach der Dateiwahl geht ein Fenster auf: Der Kreis steht
fest, das Foto wird darunter verschoben und gezoomt — am Rechner mit Maus, Mausrad oder Regler,
am Handy mit einem Finger zum Schieben und zwei zum Zoomen. Daneben stehen zwei Vorschauen, groß
wie auf dieser Seite und klein wie in Listen und Spalten, damit man gleich sieht, ob das Gesicht
auch als 26-px-Punkt noch erkennbar ist. Gespeichert wird erst mit **„Übernehmen"**; wer abbricht,
lädt nichts hoch.

**Später ändern geht ohne neues Foto.** Das Original bleibt auf dem Server liegen, deshalb gibt es
neben „Anderes Bild wählen" den Knopf **„Ausschnitt ändern"**. Ohne das wäre ein schiefer
Ausschnitt endgültig gewesen — man hätte das Foto von Hand zurechtschneiden und neu hochladen
müssen.

Technisch: Beim Hochladen wird das Foto auf zwei quadratische WebP-Größen gerechnet — **96 px** für
den Alltag (Kopfzeile, Spalten, Listen; rund 3 kB) und **512 px** für die Vorschau und eine
spätere Kollegen-Profilansicht. Dazu das **Original**, auf 1600 px längste Kante gerechnet
(typisch ein paar hundert kB; bei extrem unruhigen Fotos bis ~760 kB) — es ist die Grundlage für
jeden späteren Ausschnitt und wird bei „Entfernen" mitgelöscht. Ein 12-MB-Handyfoto landet damit
insgesamt als Bruchteil davon auf der Platte; über 12 MB lehnt der Server mit einer klaren Meldung
ab. Die Ausrichtung wird aus dem Foto übernommen (sonst lägen Handyfotos quer). Kommt kein
Ausschnitt mit — etwa bei einem direkten Aufruf der Schnittstelle —, rät die App wie früher auf
den „interessantesten" Bildbereich. **Die Bilder liegen hinter der Anmeldung** (nicht im
öffentlichen `uploads/` wie das Firmenlogo) — ohne Login kommt niemand heran, und das **Original
bekommt nur der Besitzer selbst**, nie ein Kollege: Es zeigt mehr als der Kreis, den man
freigegeben hat.

**Geburtstag:** Die Seite zeigt das Geburtsdatum, das die Verwaltung hinterlegt hat — damit ein
Zahlendreher demjenigen auffällt, den er betrifft (das Datum steuert auch die gesetzlichen
Pausenzeiten). Dazu zwei Schalter: **„Meinen Geburtstag im Team zeigen"** und darunter
**„… und auch mein Alter"**. Ohne Freigabe sehen weiterhin nur Chef, Admin und Buchhaltung den
Geburtstag. Die zweite Stufe gibt es, weil „das Team darf gratulieren" nicht dasselbe ist wie
„das Team darf mein Alter kennen"; sie lässt sich jederzeit zurücknehmen.

**Benachrichtigungen:** Die Push-Kategorien und die geplanten Zusammenfassungen sind seit dem
22.08.2026 hier zu finden statt auf einer eigenen Seite. An den Einstellungen selbst hat sich
nichts geändert.

**Meine Daten:** Soll-Stunden, Urlaubsanspruch, Eintritt, Personalnummer, Arbeitsbeginn und
zusätzliche Rechte — nur lesend, „so hat die Verwaltung dich hinterlegt".

**Zeitnachweis als PDF** *(nur Mitarbeiter)*: Die eigenen erfassten Zeiten als druckfertiges PDF,
gefiltert nach Zeitraum und Projekt. Es ist dasselbe Formular wie unter [🧾 Abrechnung](#-abrechnung),
nur ohne die Mitarbeiter-Auswahl — hier gibt es ausschließlich die eigenen Zeiten. Wer Zugriff auf
die Abrechnung hat, findet es weiterhin dort: Neben Lohn-Export und Monatsabschluss hätte es auf
einer persönlichen Seite nichts zu suchen.

**Sitzungen und Daten:** **„Auf allen Geräten abmelden"** macht jede andere Anmeldung sofort
ungültig — der Weg für ein verlorenes Handy, ohne auf jemanden warten zu müssen.

*Auf dem Gerät, von dem aus du klickst, bleibst du angemeldet.* Technisch wird auch dein eigenes
Anmelde-Zeichen entwertet; die Antwort liefert deshalb sofort ein frisches, das die App übernimmt —
auch in **weiteren offenen Tabs desselben Geräts**, die davon über den Browser-Speicher erfahren.
Sollte die Antwort einmal unterwegs verloren gehen (Funkloch im dümmsten Moment), bist du lediglich
abgemeldet, nicht ausgesperrt: einmal neu anmelden genügt.

Mit zurückgesetzt werden die **gemerkten Geräte** der Zwei-Faktor-Anmeldung — das ist der Sinn der
Sache, denn sonst käme das verlorene Handy weiterhin ohne Code hinein. Folge: Bei der nächsten
Anmeldung fragt die App auch auf **diesem** Gerät wieder nach einem Code.

**„Meine Daten herunterladen"** gibt alles Gespeicherte als Datei aus (Auskunft nach Art. 15 DSGVO),
ohne Passwort und ohne den Zwei-Faktor-Schlüssel.

**Passwort ändern:** Jeder ändert sein eigenes Passwort selbst; das aktuelle Passwort ist dabei
Pflicht (sonst könnte an einem unbeaufsichtigten, noch angemeldeten Gerät jemand den Zugang
übernehmen). Es gelten dieselben Regeln wie beim Anlegen, mit derselben Live-Prüfliste.
**Der Weg über Chef/Admin bleibt daneben bestehen** — für vergessene Passwörter.

**Zwei-Faktor-Anmeldung (TOTP):** Zusätzlich zum Passwort ein 6-stelliger Code aus einer
Authenticator-App (Google Authenticator, Aegis, 2FAS, Microsoft Authenticator …). Einrichtung per
QR-Code; wer nicht scannen kann — etwa weil die App auf demselben Handy läuft — tippt den
darunter angezeigten Schlüssel ab. Erst ein gültiger Code macht die Einrichtung scharf; ein
Abbruch dazwischen verbaut nichts.

**Gemerkte Geräte:** Wer beim Anmelden „Diesem Gerät vertrauen" wählt, sieht das Gerät hier
aufgelistet und kann ihm das Vertrauen einzeln oder in einem Rutsch wieder entziehen. Ohne diese
Liste wäre ein verlorenes Handy bei „einmal pro Gerät" dauerhaft berechtigt. Die Karte sagt
darunter, was auf diesen Geräten **tatsächlich** gilt — bei „einmal pro Gerät" wird gar kein Code
mehr verlangt, bei „wöchentlich" eben höchstens einmal pro Woche. (Die Überschrift hieß bis zum
24.08.2026 „Geräte ohne Code-Abfrage" und war damit nur für eine der Stufen richtig.)

**Wie oft ein Code verlangt wird, entscheidet die Rolle** — einstellbar in
[⚙ Einstellungen](#-einstellungen): *aus · bei jeder Anmeldung · einmal pro Gerät · täglich ·
wöchentlich · monatlich*. Ist die Zwei-Faktor-Anmeldung für eine Rolle vorgeschrieben und noch
nicht eingerichtet, führt die App die betroffene Person auf diese Seite und lässt sie erst weiter,
wenn ein Code bestätigt wurde. Abschalten kann man den zweiten Faktor nur, wenn die eigene Rolle
ihn nicht verlangt — und nur mit gültigem Code.

**Wie oft ein Code nötig ist, wählt jeder selbst** — solange die Rolle nichts vorschreibt. Auf
„Mein Konto" stehen fünf Stufen zur Wahl: *bei jeder Anmeldung · einmal pro Gerät · täglich ·
wöchentlich · monatlich*. Vorbelegt ist „einmal pro Gerät", die mildeste. Das Umstellen verlangt
einen gültigen Code — sonst könnte an einem unbeaufsichtigten, noch angemeldeten Gerät jemand die
Absicherung lockern —, und die gemerkten Geräte werden dabei zurückgesetzt, damit eine strengere
Einstellung sofort greift. **Gibt die Verwaltung etwas vor, gewinnt sie**; der eigene Wunsch bleibt
gespeichert und gilt wieder, sobald die Pflicht aufgehoben wird.

**Pflicht und Freiwilligkeit sind ein ODER.** Gefragt wird, wer einen Authenticator eingerichtet
hat — egal ob die Rolle es verlangt oder er sich freiwillig abgesichert hat. Ohne Vorgabe gilt
dann die mildeste Stufe „einmal pro Gerät". Daraus folgt eine Einbahnstraße, die man kennen
sollte: **Solange die Rolle die Anmeldung verlangt, kann man eine einmal freiwillig eingerichtete
Zwei-Faktor-Anmeldung nicht mehr zurücknehmen** — auch ein Administrator kann sie nicht
abschalten, er kann den Schlüssel nur *zurücksetzen* (verlorenes Handy), woraufhin sofort ein
neuer einzurichten ist. Abschalten geht erst wieder, wenn die Pflicht für diese Rolle aufgehoben
wird. Der Moment, es sich anders zu überlegen, liegt also **vor** dem Scharfschalten.

**Der Schlüssel bleibt erhalten.** Wird die Zwei-Faktor-Anmeldung abgeschaltet — vom Nutzer selbst
oder weil die Verwaltung die Pflicht zurücknimmt —, wird der Schlüssel nur **stillgelegt**, nicht
gelöscht. Schaltet man später wieder ein, funktioniert **dieselbe Authenticator-App weiter**; es
genügt ein Code, ein neuer QR-Code ist nicht nötig. Nur die vertrauten Geräte werden dabei
zurückgesetzt.

**Neuen Schlüssel erzeugen** (z. B. beim Wechsel aufs neue Handy): Der Knopf würfelt einen neuen
Schlüssel und zeigt einen neuen QR-Code. **Der bisherige gilt so lange weiter, bis der neue mit
einem Code bestätigt ist** — man kann sich dabei also nicht aussperren, auch nicht, wenn man
mittendrin abbricht. Vorher fragt ein Dialog ausdrücklich nach.

**Handy verloren?** Chef oder Admin setzen die Zwei-Faktor-Anmeldung im Mitarbeiter-Dialog zurück
(neben „Passwort zurücksetzen"). Das löscht den Authenticator **und alle gemerkten Geräte**; die
Person richtet ihn danach neu ein. An ein **Admin-Konto** kommt nur ein Admin — wie beim Passwort.
Verliert der einzige Admin sein Handy, hilft der Notfall-Schalter
(siehe [Konfiguration](#konfiguration-env-variablen)).

#### 📊 Zeitnachweis

Kern-Zeiterfassung. Eintrag mit Datum, Von/Bis, Pause, Arbeitsort, Kunde, Projekt, Beschreibung und optionalem „Regie"-Vermerk. **Vorbelegung der Zeiten:** „Von" schließt an den letzten Eintrag des Tages an; gibt es keinen, gilt die geplante Startzeit, sonst der **Arbeitsbeginn** (je Mitarbeiter, sonst Firmenwert). „Bis" ist die aktuelle Uhrzeit — und **nie vor „Von"**: Wer um 06:30 bucht, obwohl der Arbeitsbeginn 07:00 ist, bekommt 06:30–06:30 statt einer unmöglichen Spanne. Läge die Endzeit eines bereits gebuchten Eintrags nach „jetzt" (Tag im Voraus gebucht), bleibt „Von" stehen und „Bis" zieht nach. **Die Pause wird mit dem REST zur Firmenpause vorbelegt:** `max(0, Firmenpause − heute schon erfasste Pausen)` für denselben Mitarbeiter am selben Tag. Firmenpause 30 → erster Auftrag 30, danach 0; wurden im ersten nur 15 genommen, schlägt der nächste 15 vor, davon 10 genommen → der dritte 5, bis 0. Es zählen **alle** Einträge des Tages, auch vom Chef nachgetragene: Es ist der Arbeitstag des Mitarbeiters, unabhängig davon, wer ihn erfasst hat. Steht schon etwas, erklärt eine kleine Zeile unter dem Feld warum („Firmenpause 30 min · heute schon 20 min erfasst"); beim ersten Eintrag bleibt sie leer. Bei **Übernahme aus der Planung** gilt der geplante Wert nur, solange der Tag leer ist; sonst gewinnt die Restpause. **Beim Bearbeiten** bleibt die gespeicherte Pause unangetastet.

**Am Handy scrollt die Seite, nicht der Kasten.** Bleibt für den Tagesverlauf weniger als rund 440 px
übrig, bekommt er keine Höhenbegrenzung mehr und die **Seite scrollt als Ganzes** — wie im Wochen-
und Monatsraster. Dazu zeichnet das Raster nur noch die Stunden, die der Tag wirklich braucht: eine
Stunde vor dem ersten Eintrag bis eine Stunde nach dem letzten, mindestens acht Stunden. Vorher
waren es immer 00:00–24:00, also oben sechs und unten meist sieben Stunden leeres Raster, das man
erst wegscrollen musste. Am Rechner ist genug Platz, dort bleibt die eigene Scrollfläche.

**Was am einzelnen Eintrag steht:** In der **Tagesansicht** zeigt ein Block die Spanne und daneben
die **Nettostunden** — `07:30 – 15:30 · 7:30`; die gebuchte Pause steht darunter. Ist ein Block zu
kurz für das volle Layout (unter einer Stunde), erscheinen Netto und Pause **nur dann**, wenn eine
Pause gebucht ist: Ohne Pause sagt „0:45" dasselbe wie „08:00–08:45", und die Zahl würde nur den
Projektnamen aus der engen Zeile drängen. In der **Wochenansicht** steht die Pause hinter den
Nettostunden (`9:00 · P30`).

**Was unter jedem Namen steht:** In allen drei Ansichten trägt der Spaltenkopf die Summe der Person
für den angezeigten Zeitraum — `8:15 · 30 min Pause` am Tag, `42:30 · 2:00 Pause` in der Woche,
`180:15 · 10:00 Pause` im Monat. Gerechnet wird mit derselben überlappungsfreien Rechnung wie die
große Zahl oben: **Die Spaltensummen ergeben zusammen genau die Gesamtsumme.** Spalten ohne Eintrag
bleiben leer statt „0:00" zu zeigen — ein leerer Tag soll nicht wie eine gebuchte Null aussehen.
Pausen unter einer Stunde stehen in Minuten, darüber als Zeit (`2:30 Pause` statt „150 min").

**Gesetzliche Mindestpause (§ 4 ArbZG):** Geht der Tag über **9 Stunden** Arbeitszeit, hebt die Vorbelegung von sich aus auf **45 Minuten** an — auch wenn der Firmenwert niedriger ist; der Firmenwert bleibt dabei die **Untergrenze**, das Gesetz kann ihn nur anheben. Ein Satz unter dem Feld erklärt es („Der Tag kommt auf 10 Std Anwesenheit. Ab 9 Stunden Arbeitszeit schreibt das Arbeitszeitgesetz 45 min Pause vor …"). Der Vorschlag zieht **beim Bearbeiten von „Von"/„Bis"** nach, sobald die Uhrzeit vollständig ist — nicht bei jedem Tastendruck.

**Zeitgleiche Aufträge zählen nur einmal.** Wer zwei Aufträge parallel dokumentiert (zweimal
07:00–12:00 — beim Kunden 10 Stunden), war trotzdem nur **5 Stunden anwesend**; gerechnet wird die
**überlappungsfreie** Anwesenheit. Liegen die Aufträge **nacheinander** (07:00–12:00 und
12:00–17:00), sind es echte 10 Stunden und die gesetzliche Anhebung greift.

Die Rechnung sucht die **kleinste** Pause, mit der die Vorschrift erfüllt ist — Pause und Arbeitszeit bedingen sich gegenseitig: Bei 9:45 Anwesenheit ergäben 30 Minuten Pause 9:15 Arbeitszeit (über 9 → 45 nötig), 45 Minuten aber 9:00 (nicht über 9 → 30 genügten). Damit ist auch die **Sechs-Stunden-Grenze** abgedeckt: 6:20 Anwesenheit ohne Pause wären 6:20 Arbeit am Stück, also sind 30 Minuten fällig.

**Warnung bei Überschreitung der Höchstarbeitszeit:** Geht der **ganze Tag** über die gesetzliche
Decke, erscheint unter den Netto-Stunden ein gelber Hinweis — bei Erwachsenen über **10 Stunden**
(§ 3 ArbZG), bei unter 18-Jährigen über **8 Stunden** (§ 8 JArbSchG, samt der Bedingung, unter der
8½ zulässig wären) und zusätzlich über **40 Stunden in der Woche**. Gerechnet werden **alle Einträge
des Tages überlappungsfrei**, nicht nur die aktuelle Buchung: Wer zwei Aufträge **zeitgleich**
dokumentiert (7–11 und noch einmal 7–11) und danach bis 15:30 weiterarbeitet, hat 12 abgerechnete,
aber nur **8 gearbeitete** Stunden — dann erscheint keine Warnung. Beim Bearbeiten wird der eigene
gespeicherte Eintrag herausgerechnet. **Es ist ein Hinweis, keine Sperre:** Wer elf Stunden
gearbeitet hat, muss das eintragen können. Der Hinweis gilt für neue Einträge wie fürs Bearbeiten.

**Verstöße in der Übersicht (Tag, Woche, Monat):** Derselbe Maßstab greift nicht nur beim Buchen,
sondern auch beim Draufschauen. Wo eine Grenze gerissen ist, erscheint ein **gelbes Warnzeichen ⚠️
und ein Rahmen** — in der **Tagesansicht** am Spaltenkopf des Mitarbeiters, in der **Wochenansicht**
an der Tageszelle (und am Spaltenkopf, wenn die *Woche* zu lang ist), in der **Monatsansicht** an
der Tageszeile und an der Kalenderwoche. **Mouseover oder langer Druck** (Handy) zeigt die
Erklärung samt Paragraf. Sichtbar für Chef, Buchhalter und Admin — und **für den Mitarbeiter in
seiner eigenen Ansicht**.

Geprüft wird gegen fünf Grenzen, je nach Alter am Tag des Eintrags:

| | ab 18 | unter 18 |
|---|---|---|
| Arbeitszeit je Tag | über 10 Std (§ 3 ArbZG) | über 8 Std (§ 8 JArbSchG) |
| Ruhepause | § 4 ArbZG (30 min ab 6 Std, 45 ab 9) | § 11 JArbSchG (30 min ab 4½ Std, 60 ab 6) |
| Ruhezeit bis zum nächsten Arbeitsbeginn | unter 11 Std (§ 5 ArbZG) | unter 12 Std (§ 13 JArbSchG) |
| Arbeitszeit je Woche | über 48 Std — **Hinweis**, kein Verstoß | über 40 Std (§ 8 JArbSchG) |

Die **48-Stunden-Woche** ist bewusst anders formuliert als der Rest: § 3 ArbZG erlaubt 10 Stunden
täglich und damit mehr als 48 in der Woche, **solange der Schnitt über 24 Wochen bei 8 Stunden
werktäglich bleibt**. Die App kennt diesen Zeitraum nicht und behauptet deshalb keinen Verstoß,
sondern nennt die Ausgleichspflicht.

Zwei Eigenheiten, die man kennen sollte: Für die Prüfung wird ein **etwas weiterer Zeitraum
geladen** als angezeigt wird — ein Tag davor (die Ruhezeit braucht den Feierabend des Vortags) und
volle Kalenderwochen (eine Wochengrenze ist nur an einer vollständigen Woche zu beurteilen). Im
Monatsraster kann eine Randwoche deshalb einen Rahmen tragen, obwohl die angezeigte Summe darunter
liegt; der Tooltip nennt dann beide Zahlen. Und: Die Marker rechnen **immer den ganzen Tag**,
unabhängig von einem gesetzten Projektfilter — das Gesetz kennt keinen Filter. Auch das sagt der
Tooltip.

**Warnungen für sich ausblenden:** Unter *Mein Konto → Gesetzliche Warnungen* kann jede Person drei
Häkchen setzen — **Pausen**, **Arbeitszeit**, **Ruhezeit**. Standard ist **an**; wer nichts
einstellt, bekommt die Hinweise, abschalten muss man bewusst. Zwei Dinge dazu:

- Es gilt die Einstellung des **Betrachters**, nicht der betroffenen Person. Wer die
  Pausen-Hinweise abschaltet, sieht sie nirgends mehr — auch nicht bei Kollegen. Umgekehrt kann
  **niemand seine eigenen Verstöße vor anderen verstecken**.
- Die Schalter betreffen **nur die Übersichten**. Beim **Eintragen einer Zeit** erscheint der
  Hinweis weiterhin und lässt sich dort nicht abschalten — das ist der Moment, in dem sich etwas
  richtigstellen lässt.

Ausblenden ändert keine Zahl und keine Pflicht; jede Änderung steht im Audit-Log. Gruppiert ist
nach **Thema** statt nach Gesetz, weil nach Gesetz bei jedem Menschen die Hälfte der Schalter
wirkungslos wäre (ein Erwachsener sieht nie eine JArbSchG-Warnung, ein Minderjähriger nie eine nach
ArbZG).

Es bleibt ein **Hinweis, keine Rechtsberatung**: Tarifverträge und § 7 ArbZG kennen Abweichungen,
die die App nicht kennt. Nicht geprüft werden der 24-Wochen-Ausgleich, die verkürzte Ruhezeit nach
§ 5 Abs. 2 ArbZG und die Fünf-Tage-Woche nach § 15 JArbSchG.

**Zwei Alterstabellen (§ 4 ArbZG / § 11 JArbSchG):** Für **Jugendliche unter 18** gelten längere Pausen — **30 Minuten ab 4½** und **60 Minuten ab 6 Stunden** Arbeitszeit. Die App entscheidet das selbst: Aus dem **Geburtsdatum** des Mitarbeiters (Mitarbeiter → bearbeiten) errechnet sie das Alter **am Tag des Eintrags**, nicht am heutigen Tag — wer im Juli 18 wird, bekommt für einen nachgetragenen Juni-Eintrag noch die Jugendschutz-Werte. Der Hinweis unter dem Feld nennt jeweils das **zutreffende** Gesetz. **Ist das Geburtsdatum leer, rechnet die App vorsichtshalber „unter 18"** und sagt das im Hinweis dazu — lieber eine zu lange Pause vorschlagen als eine unzulässig kurze. Praktische Folge: Solange keine Geburtsdaten gepflegt sind, schlägt schon ein normaler 8-Stunden-Tag **60 Minuten** vor. Das Geburtsdatum wird beim Öffnen des Formulars frisch ausgewertet; die Sitzung des Mitarbeiters holt einen nachgetragenen Wert beim nächsten Wechsel zurück in die App ab — ohne neues Anmelden. Keine Rechtsberatung; Tarifverträge können abweichen. Nettostunden werden automatisch berechnet; überlappende Einträge werden nicht doppelt gezählt.

#### 🏖️ Abwesenheit

Krank, Urlaub, Freizeitausgleich, Sonderurlaub, Feiertag, Berufsschule, Innung. Urlaub/FZA/Sonderurlaub durchlaufen einen **Genehmigungs-Workflow**. Prioritätsbewusste Tageszählung (Feiertag > Krank > Schule/Innung > Urlaub/FZA) und korrekte Soll-Stunden-/Überstunden-Verrechnung. **Arbeiten trotz Abwesenheit ist möglich** und wird sauber verrechnet: an Urlaub/Schule/Feiertag-Tagen zählt gebuchte Zeit voll als Überstunden, bei **FZA** sinkt nur der Abzug. **Krank** ist überstundenneutral bis zur normalen Tagesleistung (Soll = min(gearbeitete Stunden, Normal-Soll)) – Mehrarbeit darüber hinaus zählt als Überstunden. **Urlaubskonto** (sobald ein Anspruch hinterlegt ist – sonst bleibt es bei der alten Anzeige „Urlaub JAHR: X Arbeitstage"): jeder Mitarbeiter sieht im Kopf seinen Stand „Urlaub JAHR: X genommen · Y geplant · Z verbleibend". **Genommen** = genehmigt & in der Vergangenheit, **geplant** = genehmigt & in der Zukunft. Wird eine Abwesenheit **gelöscht**, fließen die Tage automatisch wieder zurück. Übersteigt ein Antrag den Resturlaub, erscheint ein **Warnhinweis** (blockiert aber nicht). **Chef/Admin/Buchhalter** haben zusätzlich den Reiter **„Urlaubsübersicht"** (erscheint erst, sobald irgendwo ein Anspruch gepflegt ist) mit einer Tabelle je Mitarbeiter (Jahr-Auswahl, Namenssuche, Stand-Datum, **PDF-Download**): Anspruch · Übriger Anspruch vom Vorjahr · Gesamtanspruch · Genommen · Geplant und akzeptiert · Noch zu planen · **Beantragt (offen)** · Krank · FZA. Mitarbeiter **ohne** hinterlegten Anspruch erscheinen mit **„–"** in den Anspruch-Spalten (ihre echten Abwesenheiten werden trotzdem gezählt). Auch der **Arbeitsnachweis-PDF** zeigt das Urlaubskonto (bzw. ohne Anspruch die alte Zeile „Urlaubstage genommen"). Der Anspruch samt Verfall-Regel und Start-Resturlaub wird je Mitarbeiter unter **👥 Mitarbeiter** gepflegt.

#### 📈 Statistik

Soll-/Ist-Stunden und Überstunden je Zeitraum und Mitarbeiter, mit Diagrammen.

#### 🧾 Abrechnung

Der Menüpunkt ist **Chef, Admin und Buchhaltung vorbehalten**. Für einen Mitarbeiter war die Seite nur der PDF-Download seiner eigenen Zeiten — das ist eine persönliche Sache und sitzt deshalb seit dem 23.08.2026 als Karte **„Zeitnachweis als PDF" auf [👤 Mein Konto](#-mein-konto)**; die Adresse `#/pdf` führt ihn dorthin, alte Lesezeichen bleiben also heil. Sammelt beide Ausgabewege. **PDF:** druckfertiger Arbeitsnachweis (Einträge + Abwesenheiten + Stunden-Zusammenfassung), gefiltert nach Zeitraum/Mitarbeiter/Projekt. **Lohn-Export (CSV)** *(Chef/Admin/Buchhalter)*: Monat wählen (voreingestellt der Vormonat) → eine Tabelle mit **einer Zeile je Mitarbeiter** — Personalnummer, Soll-/Ist-Stunden, Saldo, Überstunden gesamt sowie Urlaubs-, Krank-, FZA-, Sonderurlaubs-, Berufsschul-, Innungs- und Feiertage, dazu eine Summenzeile. Semikolon-getrennt mit UTF-8-BOM, öffnet sich direkt in Excel. Enthalten sind alle Rollen außer Admin, die im Monat angestellt waren — **auch bereits ausgeschiedene**, mit Austrittsdatum in der Spalte „Beschäftigt bis" (sonst fehlte der letzte Monat in der Abrechnung). Der Export wird im Audit-Log vermerkt. Spart das monatliche Abtippen aus dem PDF — dort erscheinen Urlaubs-/Krank-/FZA-Tage nämlich nur, wenn man **einen einzelnen** Mitarbeiter auswählt. Die **Personalnummer** wird je Mitarbeiter unter *👥 Mitarbeiter* gepflegt (optional).

#### 🔒 Abrechnungs-Abschluss

Ein abgeschlossener Monat ist **schreibgeschützt** und seine Zahlen sind **festgehalten**. Hintergrund: Der Überstundenstand wurde bisher bei jeder Abfrage vom allerersten Tag an neu gerechnet — wer einen Mai-Eintrag korrigierte, veränderte damit seinen **heutigen** Stand, obwohl die Mai-Stunden längst bezahlt waren. Nach dem Abschluss rechnet der Stand auf dem festgehaltenen Wert weiter. **Auf der Statistik
gehört der Hinweis zum angewählten Zeitraum:** Wer den Mai ansieht, sieht den Mai-Abschluss samt
dessen Zahlen; ist der Monat noch offen, erscheint **gar kein** Hinweis. Bei Jahr/Gesamt
überschneiden sich mehrere Abschlüsse — dann bleibt es beim Satz „Abgerechnet bis …" mit dem
letzten davon. Bedient wird das auf der Seite **🧾 Abrechnung**, direkt unter dem Lohn-Export: Zielmonat wählen und
**„Abschließen bis einschließlich …"** — alle offenen Monate bis dahin werden der Reihe nach
festgeschrieben, damit man nach längerer Pause nicht Monat für Monat klicken muss. Ein dezenter
Hinweis nennt offene Monate; abgeschlossene Zeiträume stehen darunter mit **„Abweichungen prüfen"**.
Im **Zeitnachweis** zeigt ein gesperrter Eintrag statt der Knöpfe den Grund, und der Admin wird vorab
auf die Begründungspflicht hingewiesen. In der **📈 Statistik** sieht jeder den Stichtag, Mitarbeiter
zusätzlich ihre eigenen abgerechneten Zahlen. **Abschließen** dürfen Chef/Admin/Buchhalter, immer nur
den nächsten offenen Monat und nur **lückenlos**; offene Urlaubs-/Krankanträge im Zeitraum müssen vorher entschieden sein. Gesperrt sind **alle** Wege, die Zahlen rückwirkend verschieben — Zeiteinträge, Abwesenheiten samt Genehmigen/Ablehnen, Soll-Stunden, Urlaubsanspruch, Ein-/Austrittsdaten, Start-Überstunden und das Wiederherstellen aus dem Papierkorb. **Der Ausweg:** Der **Admin** kommt weiterhin durch, aber nur mit **Pflichtbegründung**; der Eingriff steht im Audit-Log, der festgehaltene Wert bleibt stehen, und die Differenz wird als *„bezahlt X — heute berechnet Y"* ausgewiesen. **Und dann muss sie übernommen werden:** Ein Nachtrag im bezahlten Monat ist zwar sofort im Zeitnachweis und in der Monatsstatistik sichtbar, steckt aber in **keinem Überstundenstand** — genau der geht nächsten Monat ans Lohnbüro. Erst „Differenz übernehmen" schreibt die Stunden dem laufenden Zeitraum gut, womit sie in den nächsten Lohn-Export gehen; der abgeschlossene Monat bleibt als Beleg unverändert. Dabei ist ein **Kommentar Pflicht** — sonst stünden im Folgemonat Stunden, die niemand zuordnen kann. Gekennzeichnet wird an allen drei Stellen, an denen sie auftauchen: im Lohn-Export in **zwei eigenen Spalten** („Nachtrag Vormonat" und „Nachtrag Herkunft", z. B. *„April 2026: +4,00 h (Krankmeldung nachgereicht)"*) — bewusst **nicht** in den Ist-Stunden, denn gearbeitet wurden sie im Vormonat; beim Mitarbeiter in seiner Statistik mit Herkunftsmonat, Kommentar und dem, der übernommen hat; und im Audit-Log. Damit es niemand vergisst, **blockiert eine offene Differenz den nächsten Monatsabschluss** — wie ein unentschiedener Urlaubsantrag. Deshalb gibt es **zwei** Wege heraus: **übernehmen** (gutschreiben) oder **ablehnen** (bewusst *nicht* gutschreiben, etwa weil die Stunden bereits bar oder mit Freizeit abgegolten wurden). Beides verlangt eine Begründung und steht im Protokoll; abgelehnte Stunden erscheinen in **keinem** Lohn-Export, der Mitarbeiter sieht sie aber mit dem Grund — sonst verschwänden sie lautlos. Eine Sperre mit nur einem Ausgang wäre keine Entscheidung, sondern ein Zwang zur Buchung. Der Mitarbeiter sieht in seiner Statistik, dass sein Stand eine noch nicht übernommene Korrektur nicht enthält. Den **letzten** Abschluss kann der Admin mit Begründung wieder öffnen; dabei werden bereits übernommene Nachträge aus genau diesem Zeitraum **zurückgenommen** — sonst zählten dieselben Stunden doppelt, weil die Einträge des wieder offenen Monats erneut direkt mitrechnen. Mitarbeiter sehen den Stichtag und **ihre eigenen** abgerechneten Zahlen. Nicht abfangbar und deshalb bewusst offen: **Backup einspielen** und **Mitarbeiter endgültig löschen** — beide vermerken im Audit-Log, wenn abgerechnete Zeiträume betroffen sind.

### Arbeit organisieren

#### 📅 Planung

**Die Zeitleiste nutzt den vorhandenen Platz:** Ihre Höhe wird auf jedem Gerät gemessen — vom kleinen Handy bis zum großen Monitor reicht sie bis knapp an den unteren Rand, beim Drehen zieht sie nach. Gescrollt wird innerhalb der Leiste, die Seite selbst bleibt stehen.

Einsatz-/Schichtplanung: Termine mit Uhrzeit, Ort, Kunde, Projekt – einzeln oder als Gruppe, farblich markierbar. Mitarbeiter sehen ihre Einsätze. **Serientermine (Wiederholung):** ein Termin (auch mehrtägig) kann sich **wöchentlich**, **monatlich am Datum** (z. B. jeden 8.), **monatlich am n-ten Wochentag** (z. B. jeder 2. Mittwoch), **jährlich am Datum** oder **jährlich am n-ten Wochentag eines Monats** (z. B. 1. Montag im Februar) wiederholen. Das Muster wird aus dem Starttag abgeleitet; bei mehrtägigen Terminen wiederholt sich der **ganze Block** (Starttag + Folgetage). Ende **nie / nach N Terminen / bis Datum**; „nie" läuft rollierend ~24 Monate voraus (täglich nachgefüllt). Eine **Live-Vorschau** zeigt die nächsten Termine (mehrtägig als Bereich) und **warnt bei Überschneidung**; überlappende Termine erscheinen in der Ansicht **nebeneinander** (wie zwei gleichzeitige Termine). Serientermine tragen ein **🔁**; **Bearbeiten** und **Löschen** fragen den Umfang (**nur dieser / dieser + folgende / ganze Serie**); Feld-Änderungen (z. B. Mitarbeiter, Kunde) mit „dieser + folgende"/„ganze Serie" wirken über die **gesamte Herkunft** – also auch über eine umgetaktete Fortsetzung hinweg (durchgehend gleiche Zuweisung), zusätzlich **„Serie beenden"** (ab heute, Vergangenes bleibt). Setzt man die Wiederholung im Bearbeiten auf **„Keine"**, fragt die App **„ab diesem Termin beenden" (frühere bleiben)** oder **„nur diesen Termin behalten" (Serie auflösen, Rest löschen)**. Schrumpft eine Serie dadurch auf **ein** Vorkommen, wird daraus wieder eine **echte Einzelplanung** (kein 🔁 mehr). „Nur diesen behalten" erfasst dabei auch aus **Umtakten** hervorgegangene Folge-Serien derselben Herkunft (z. B. eine später monatliche Fortsetzung) – es bleibt wirklich nur der eine Termin. Rechte wie sonst: Selbstplaner nur eigene Serien. Über das **⋮-Menü** lassen sich pro Termin **Push-Erinnerungen** mit frei wählbarem Vorlauf setzen (siehe [Push-Benachrichtigungen](#-push-benachrichtigungen-web-push)).

#### 📁 Projekte und Aufträge

**Auftrags-Board** (für alle sichtbar): Mitarbeiter waagerecht, darunter ihre Aufträge als Kacheln – sortiert nach **Dringlichkeit** (🔴 dringend → 🟠 → 🟡 → 🟢, bei Gleichstand ältester oben). Aufträge ohne Zuweisung stehen in der Spalte **„Nicht zugewiesen"**, sodass sich jeder freie Arbeit ziehen kann. Ein Auftrag hat **Name, Kunde, Adresse, Notiz, Dringlichkeit** und kann **mehreren Nutzern** zugedacht sein – **alle Rollen außer Admin** (auch Chef/Buchhalter, z. B. für Arbeiten im Haus). Der Auftrag erscheint unter jedem Zugewiesenen. Mitarbeiter haben immer eine Spalte; **Chef/Buchhalter erscheinen – wie in der Planung – erst als Spalte, sobald ihnen etwas zugewiesen ist.** Klick auf eine Kachel zeigt Details + Aktionen: **„In Planung übernehmen"** (Admin/Chef/Planungsberechtigte inkl. Selbstplaner) und **„Als Zeitnachweis übernehmen"** (alle) übertragen Projekt/Kunde/Adresse/Notiz vorbefüllt ins jeweilige Formular; bei hinterlegter Adresse gibt es einen **Navigations-Button**. Anlegen über den großen **FAB „+"** mit vollem Formular; **Bearbeiten / Erledigt / Löschen** nur Chef/Admin. „Erledigt" nimmt den Auftrag vom Board (bleibt archiviert). **„Löschen" verschiebt in den Papierkorb** (Soft-Delete, inkl. Zuweisungen/Zwischenziele) – von dort können **Chef/Admin** ihn **wiederherstellen** oder **endgültig löschen** (mit Bestätigung); der Projektname wird **schon beim Löschen** (Papierkorb) in vorhandenen Planungen/Zeitnachweisen/Werkzeugen/Notizen als Freitext gesichert, bleibt also erhalten – nach Wiederherstellen hat der Live-Name wieder Vorrang. Die Projektauswahl im **Zeitnachweis-/Planungsformular** füllt Adresse/Kunde/Notiz automatisch. Chef/Admin können die **Dringlichkeit direkt über die Ampel** (Klick auf die Farbe) ändern und **erledigte Aufträge** über „Erledigte anzeigen" einsehen und **wieder öffnen**. Das Board **aktualisiert sich live** (SSE) über alle Geräte. **Zwischenziele & Fortschritt:** Chef/Admin legen im Bearbeiten-Formular **Zwischenziele** mit geschätzter **Dauer** an (z. B. „Hauptverteiler | 2 Tage"). Zugeteilte Nutzer (+ Chef/Admin) schalten je Ziel den Status **offen (rot) / in Arbeit (gelb) / erledigt (grün)**; daraus wird ein **nach Dauer gewichteter Fortschrittsbalken** („X % fertig · Y % in Arbeit · Z % offen") berechnet und – live für **jeden** sichtbar – angezeigt. Ohne Zwischenziele gibt es keinen Balken. Eine **Farb-Legende** im Board-Kopf erklärt die Dringlichkeits-, Fortschritts- und Termin-Farben (inkl. hellblauer „Luft bis Frist"). **Statistik-Reiter** (Admin/Chef/Buchhalter): auf der aufgeklappten Kachel zeigt „📊 Statistik" die **gebuchten Netto-Stunden je Nutzer** (alle Bucher außer Admin) + Anzahl Einträge + **Gesamtsumme** – gezählt werden Zeiteinträge mit dem Projekt (Dropdown) **oder** dem Projektnamen im Freitext, funktioniert also auch für Bestands-Aufträge und über ein zwischenzeitliches Löschen/Neu-Anlegen hinweg. Ein **CSV-Export** listet jeden Einzeleintrag (Benutzer, Datum, Uhrzeit von-bis, Pause, Netto) nach Datum sortiert samt Gesamtsumme. **Fällig bis:** optionales Termin-Datum je Auftrag → Kachel zeigt „noch X Arbeitstage" (bzw. „X Arbeitstage überfällig"). **Gerechnet wird in Arbeitstagen** – Samstag, Sonntag und die in der App gepflegten **Feiertage** zählen nicht (passend zu den Zwischenziel-Dauern, die ebenfalls Arbeitstage sind). Ohne Zwischenziele ist die Badge-Farbe rein kalendarisch (überfällig rot · ≤ 3 Arbeitstage orange · sonst neutral); mit Zwischenzielen färbt sie sich nach der **Zeit-Gesundheit**. Sind Zwischenziele gesetzt, erscheint im (weiter dreifarbigen) Fortschrittsbalken eine **Frist-Markierung**: liegt sie im offenen/in-Arbeit-Teil, reißt man die Frist (rot, „X AT über Frist"); ist Puffer da, wird der Arbeitsbalken kürzer und die restliche Zeit als **hellblaues „Luft"-Segment** bis zur Frist-Markierung gezeigt (grün, „X AT Luft"). Restaufwand = offene + in-Arbeit-Ziele in Arbeitstagen (erledigte zählen nicht); grün < 85 % der Restzeit · orange 85–99 % · rot ≥ 100 %. Alles rein visuell – **ändert die Kachel-Reihenfolge nicht** und aktualisiert sich **live** (SSE) über alle Geräte. Ungültige Datumsangaben (z. B. 30.02.) werden serverseitig abgewiesen. *(Erstellen/Ändern/Erledigen: Chef/Admin; Ziel-Status: Zugeteilte + Chef/Admin)*

#### 🔧 Werkzeugliste

Werkzeug-Inventar mit Ausleihe/Rückgabe: wer hat was wann entnommen, inkl. Historie und Übernahme.

#### 🛒 Bestellungen

Material-/Bestellanforderungen der Mitarbeiter; Chef sieht offene Bestellungen (Badge).

### Zusammenarbeit

#### 📌 Schwarzes Brett

Aushänge/Ankündigungen fürs ganze Team, mit Benachrichtigungs-Badge. Ein **neuer** Aushang meldet sich bei allen außer dem Autor; beim **Bearbeiten** nur dann, wenn sich inhaltlich etwas geändert hat – wer einen Aushang nur aufmacht und speichert, löst weder Meldung noch Zähler aus. Aushänge lassen sich **bearbeiten und löschen** (Bleistift und ×, rechts neben dem Titel — Chef/Admin und wer das Einzelrecht hat). Wird ein Aushang auf der **Willkommensseite** eingeblendet, führt ein Antippen zum Schwarzen Brett und **direkt zu diesem Eintrag**, der dort kurz hervorgehoben wird; per Tastatur mit Enter oder Leertaste. Dasselbe gilt für die **Termine** der eigenen Woche: Antippen führt in die **Tagesansicht der Planung** zum richtigen Tag, der angetippte Termin wird dort hervorgehoben. Die Knöpfe *Navigieren* und *Übernehmen* in der Karte behalten ihre eigene Wirkung.

#### 📝 Notizen

Persönliche und **geteilte** Notizen (Lese-/Schreibrechte pro Benutzer), mit Bearbeitungs-Sperre gegen gleichzeitiges Editieren. Empfänger können eine geteilte Notiz per **„Freigabe verlassen"** selbst aus ihrer Liste entfernen; beim Eigentümer verschwindet der Haken, er kann sie durch erneutes Anhaken wieder freigeben. Filterbar nach **eigenen / freigegebenen** Notizen (sowie gezielt **nach jedem einzelnen Freigeber**), Projekt und Suchtext. **Bearbeitet jemand eine geteilte Notiz, bekommen Eigentümer und Mitleser eine Push-Meldung** („Notiz bearbeitet – Bastian Budau hat ‚Oberhohenried‘ bearbeitet“) – der Bearbeiter selbst natürlich nicht, und nur wer den Kategorie-Schalter „Notizen“ an hat. **Nur bei einer echten Änderung:** Wer eine Notiz nur aufmacht, hineinschaut und speichert, löst weder eine Meldung noch den Zähler aus – der Zeitstempel der Notiz bleibt dann unangetastet (reine Leerzeichen am Rand zählen ebenfalls nicht als Änderung). Die Bearbeitungs-Sperre wird trotzdem gelöst.

#### 🗂️ Dokumente

Dateiablage mit Ordnern/Unterordnern. Upload (PDF, MS-Office `docx/xlsx/pptx`, OpenDocument `odt/ods/odp`, Bilder PNG/JPG, `txt/csv/md`; max. Dateigröße standardmäßig 5 MB, vom Admin einstellbar, Magic-Byte-Prüfung gegen umbenannte `.exe`), Verschieben, Umbenennen, rekursives Löschen. Konfigurierbares Gesamt-Speicherlimit **und** Pro-Datei-Limit. Mitarbeiter laden nur herunter – außer sie bekommen das Upload-Recht.

### Verwaltung

#### 👥 Mitarbeiter

Benutzerverwaltung (anlegen/bearbeiten/Rolle setzen), **Soll-Stunden pro Woche** (mit Historie), Start-Überstunden, Passwort zurücksetzen, Einzelrechte vergeben – darunter **Bestellungen abschließen**: Damit darf auch ein Mitarbeiter (z. B. Vorarbeiter oder Urlaubsvertretung) offene Bestellungen auf *Bestellt* setzen und fremde Einträge korrigieren, was sonst Chef, Admin und Buchhalter vorbehalten ist. Bestellte Einträge löschen bleibt beim Admin. **Zähler und Push-Meldung folgen dem Recht** – sonst hätte man den Knopf, erführe aber nie, dass etwas zu bestellen ist. Wird das Recht entzogen (auch durch einen Rollenwechsel), schaltet der Server den Push-Schalter für Bestellungen ab und streicht die Kategorie aus geplanten Zusammenfassungen; bleibt dort keine Kategorie übrig, wird die Zusammenfassung gelöscht und der Vorgang protokolliert. **Arbeitsbeginn** je Mitarbeiter (optional, leer = Firmenwert aus den Einstellungen) — nur für Ausnahmen, die früher oder später anfangen. **Geburtsdatum** (optional): daraus entscheidet die App, ob das Arbeitszeitgesetz oder das Jugendarbeitsschutzgesetz gilt — für die Pausen-Vorbelegung **und** für die gesetzlichen Warnungen (Tages- und Wochengrenze, Ruhezeit). Gerechnet wird das Alter **am Tag des Eintrags**, nicht am heutigen. **Leer heißt „unter 18"**, nicht „unbekannt, also Erwachsener"; ein Hinweis am Feld sagt das. Zukünftige und unmögliche Daten werden abgewiesen, jede Änderung steht im Protokoll. Bei allen Stunden-/Tage-Feldern sind „**,**" und „**.**" als Dezimaltrenner erlaubt (z. B. `7,5`); eine unlesbare Eingabe wird **gemeldet** statt still als 0 gespeichert. **Passwort-Anforderungen** (beim Anlegen & Zurücksetzen, serverseitig erzwungen): mind. 8 Zeichen, je 1× Groß-/Kleinbuchstabe, Ziffer und Sonderzeichen, und ≠ Benutzername – die Bedingungen werden beim Tippen **live** angezeigt (grüner Haken/rotes ✗, Feld färbt sich rot/grün). Bestehende Anmeldungen bleiben davon unberührt. **Urlaubsanspruch (versioniert):** je Mitarbeiter lassen sich – analog zu den Soll-Stunden – **mehrere Anspruchszeilen** „X Tage, **gültig ab** Datum" per „+" anlegen und rückwirkend ändern/löschen (z. B. Start-Anspruch bei Eintritt, Erhöhung im 2. Jahr). **Ohne Eintrag zählt 0** (kein Default), und solange keine Zeile existiert, bleibt überall die **alte Ansicht** (nur genommene Tage) – die Resturlaub-Anzeigen erscheinen erst mit hinterlegtem Anspruch. Jede Zeile trägt ihre **eigene Verfall-Regel** – Resturlaub verfällt **nie / zum Jahreswechsel / an einem Datum im Folgejahr** –, sodass sich der Modus über die Zeit **umstellen lässt, ohne die Vergangenheit zu verändern** (ein Moduswechsel wirkt nur ab dem jeweiligen „gültig ab" vorwärts). Der Anspruch ist **jahresbezogen**: pro Jahr gilt die Zeile mit dem **jüngsten „gültig ab" bis Jahresende** (mehrere Zeilen im selben Jahr → die späteste gewinnt); die Rechnung beginnt am **frühesten** „gültig ab"-Jahr, nicht bei der Mitarbeiter-Anlage. Ein Feld **„Start-Resturlaub (Übertrag)"** trägt den Stand **vor** Einführung der App als einmaligen Übertrag ins erste erfasste Jahr (analog Start-Überstunden) – so lassen sich Bestands-Mitarbeiter ohne Nachtragen aller Vorjahre übernehmen. Eine Stand-Anzeige mit Jahr-Auswahl zeigt sofort genommen/geplant/verbleibend. **Ausstellen statt Löschen:** ausgeschiedene Mitarbeiter werden mit Austrittsdatum ausgestellt (kein Login mehr, eine laufende Sitzung fliegt sofort heraus), ihre Zeiten/Abwesenheiten/Planungen bleiben aber vollständig erhalten und für ihren Anstellungszeitraum in Statistik und PDF berücksichtigt. Wiedereinstellen ist jederzeit möglich (auch mehrfach) – die Lücke zählt 0 Soll-Stunden. **Beim Ausstellen werden zwei Dinge entfernt:** die Push-Abos der Geräte und die **Zwei-Faktor-Anmeldung** samt gemerkter Geräte. Letzteres, weil der Authenticator auf dem privaten Handy das Ausstellen sonst überlebt – käme der Account je versehentlich zurück, wäre das alte Handy sofort wieder ein gültiger zweiter Faktor, teils wochenlang ohne Code-Abfrage. Bei einer Wiedereinstellung wird er neu eingerichtet, wie beim Handywechsel. **Alles andere bleibt stehen** – Profilbild, Einzelrechte, Soll-Stunden, Start-Überstunden, Urlaubsanspruch, Personalnummer, Arbeitsbeginn, Geburtsdatum –, damit nach der Wiedereinstellung wirklich alles ist wie zuvor. *(Chef/Admin)*

#### ⚙️ Einstellungen

**Zwei-Faktor-Anmeldung je Rolle** *(Chef/Admin; die Zeile für Administratoren nur Admin)*: Für jede
der vier Rollen lässt sich einstellen, wie oft ein Code aus der Authenticator-App verlangt wird —
*aus · bei jeder Anmeldung · einmal pro Gerät · täglich · wöchentlich · monatlich*. Vorgabe ist
**aus**; nach einem Update ändert sich also für niemanden etwas, bis jemand bewusst umstellt.

Beim Scharfschalten fragt die App nach und nennt die betroffenen Rollen — denn ab diesem Moment
landet **jeder** in dieser Rolle, der noch keinen Authenticator hat, beim nächsten Aufruf auf
[👤 Mein Konto](#-mein-konto) und kommt vorher nicht weiter, auch mitten in der Arbeit.
Die Pflicht für **Administratoren** kann nur ein Administrator ändern — sonst könnte ein Chef
ausgerechnet die Absicherung des stärksten Kontos abschalten.

Zur Häufigkeit: Eine Anmeldung gilt 24 Stunden. „Bei jeder Anmeldung" heißt deshalb in der Praxis
höchstens einmal täglich — und sofort wieder, wenn sich jemand abmeldet.

**Arbeitszeiten** (Arbeitsbeginn, Arbeitszeit pro Tag, Pause pro Tag — Vorgabe 07:00 / 8 h / 30 min): dienen als **Vorbelegung** für die Planung (von/bis/Pause) und für den ersten Zeiteintrag eines Tages. Eine Vorschauzeile zeigt beim Tippen, was die drei Werte zusammen ergeben. **Erfasste Zeiten und Soll-Stunden bleiben davon unberührt.** White-Label-Branding (Logo + App-Icon; **max. Bild-Dateigröße admin-einstellbar, Default 5 MB**), **Impressum & Datenschutz** (konfigurierbare Rechtstexte, erscheinen als Links auf Login-Seite + Menü), Dokumenten-Speicherlimit (Gesamt + pro Datei), Datenbank-Backup/Restore. *(Chef/Admin; Größenlimits nur Admin)*

#### 📜 Audit-Log

Revisionssicheres Protokoll: An-/Abmeldungen (Login erfolgreich/fehlgeschlagen, manuelle Abmeldung, Sitzungs-Timeout), Benutzeränderungen, Einstellungs-/Branding-Änderungen, Backups u. a. Benutzeranlage mit allen Parametern, Änderungen feldgenau als „alt → neu" (Passwörter nie). Mit Filter (Aktion/Zeitraum), seitenweisem Nachladen und CSV-Export fürs Archiv. *(Admin)*

#### 🗑️ Papierkorb

Gelöschte Einträge und Abwesenheiten bleiben mit Begründung erhalten (GoBD). **Gelöschte Zeit­einträge** können wiederhergestellt werden – jeder sieht/stellt wieder her, was er selbst gelöscht hat; Chef/Admin alles. **Gelöschte Abwesenheiten** werden für Chef/Mitarbeiter/Buchhalter **nicht** wiederhergestellt (das brächte sie als bereits genehmigt zurück und könnte mit zwischenzeitlicher Planung kollidieren) – stattdessen „**Neu beantragen**": ein frischer Antrag mit den alten Daten, der wieder durch die Genehmigung läuft. Nur der **Admin** kann eine Abwesenheit echt **wiederherstellen** (Ausnahme für versehentliche Löschungen). Im Unterreiter **Mitarbeiter** liegen ausgestellte Mitarbeiter zum Wiedereinstellen (**Chef/Admin** – Mitarbeiter haben darauf keinen Zugriff); endgültiges Löschen (mit allen Daten) ist dort nur als Admin und nur für zuvor ausgestellte Mitarbeiter möglich. Im Unterreiter **Projekte** liegen gelöschte Aufträge (inkl. Zuweisungen/Zwischenziele); **Chef/Admin** können sie **wiederherstellen** oder **endgültig löschen** (mit Bestätigung).

---

## Was überall gilt

Echtzeit-Updates über alle Geräte (Server-Sent Events), **Push-Benachrichtigungen
aufs Handy auch bei geschlossener App** (Web Push, optional je Gerät aktivierbar), **Navigations-Button mit
freier Wahl der Karten-App/des -Dienstes** (Auswahl-Dialog statt fester Google-Bindung – Android zeigt die
Geräte-Auswahl der installierten Apps, iOS/Desktop eine kuratierte Liste; Wahl merkbar), rollenbasierte
Sichtbarkeit, mobil-optimiert/installierbar (PWA), Brute-Force-Schutz am Login, durchgehend
parametrisierte SQL-Abfragen und HTML-Escaping (XSS-Schutz).

## 📱 Für die Baustelle gedacht

Die App wird überwiegend mit dem Handy in der Hand bedient – teils in der Sonne, teils mit Handschuhen.
Darauf ist sie ausgelegt:

* **Entwürfe gehen nicht verloren.** Kommt mitten im Ausfüllen ein Anruf, geht die App in den Hintergrund –
  bei knappem Speicher **beendet das Betriebssystem sie**, ohne Rückfrage. Deshalb sichert die App den
  Formularinhalt in genau dem Moment, in dem sie in den Hintergrund geht (und nebenbei beim Tippen).
  Beim nächsten Öffnen desselben Formulars erscheint oben eine Leiste **„Nicht gespeicherter Entwurf von
  14:32 gefunden – Wiederherstellen / Verwerfen"**. Nichts wird heimlich eingesetzt. Gilt für **alle**
  Formulare (Zeiteintrag, Planung, Aushang, Notiz, Bestellung, Auftrag, Abwesenheit) – bei der Planung
  inklusive der Mehrtages-Auswahl. Entwürfe verfallen nach 24 Stunden, verschwinden nach dem Speichern
  und werden **beim Abmelden gelöscht** (geteilte Geräte). Wer ein Formular versehentlich verlässt, sieht
  kurz **„Entwurf gesichert"** statt eines blockierenden Dialogs.
* **Details ohne Umweg ansehen:** Einen Eintrag im Zeitnachweis oder einen Termin in der Planung
  **gedrückt halten** zeigt Kunde, Ort, Beschreibung und Pause als Sprechblase – am Rechner erscheinen
  dieselben Angaben beim Drüberfahren mit der Maus. Kurz antippen öffnet wie gewohnt.
* **Suche in jeder langen Liste:** Werkzeuge, Mitarbeiter, Dokumente, Bestellungen und beide
  Papierkorb-Ansichten haben ein Suchfeld – **immer sichtbar**, direkt über der Liste. Gesucht wird über
  alle sichtbaren Angaben (beim Werkzeug also auch danach, **wer** es hat und **wo** es ist), mehrere
  Wörter werden UND-verknüpft, Groß-/Kleinschreibung ist egal. Gefiltert wird im Gerät – kein Nachladen,
  kein Warten. Der Zähler zeigt „3 von 34"; der Suchbegriff **überlebt Live-Aktualisierungen** durch
  Kollegen. Besonders im Papierkorb hilft das, weil der wegen der Revisionssicherheit dauerhaft wächst.
* **Zoom ist nicht gesperrt** – Aufziehen mit zwei Fingern funktioniert überall.
* **Große Trefferflächen:** Auf Touchgeräten haben kleine Symbol- und Textknöpfe eine unsichtbar
  vergrößerte Fläche, ohne dass sich das Aussehen ändert. Mit Maus bleibt alles wie gewohnt.
* **Mit Tastatur und Screenreader bedienbar:** Dialoge sind als solche gekennzeichnet und tragen ihren
  Titel als Beschriftung; der Fokus **springt hinein und bleibt darin** (kein blindes Tippen in die Seite
  dahinter), **Escape** schließt, und danach kehrt der Fokus **zum auslösenden Knopf** zurück. Während ein
  Dialog offen ist, wird der Hintergrund für Screenreader ausgeblendet. Rückmeldungen („gespeichert",
  Fehlermeldungen) werden als Statusbereich **vorgelesen** statt nur eingeblendet. Kopfleiste, Navigation
  und Hauptbereich sind als Bereiche benannt, der aktive Menüpunkt als *aktuelle Seite*; Symbol-Knöpfe
  (‹ › ✎ ✕ ⋮) haben einen lesbaren Namen.
* **Lesbare Nebentexte:** Graue Zusatzangaben erfüllen den WCAG-AA-Kontrast (4,5:1) – auch auf den
  hellgrauen Flächen und den eingefärbten Karten, nicht nur auf Weiß.

**Die Zähler holen sich den Stand nach jeder Verbindungslücke selbst.** Sie leben von der
Live-Verbindung (SSE), die ein Handy kappt, sobald der Bildschirm ausgeht oder der Browser in den
Hintergrund rutscht. Deshalb wird der echte Stand **nach jedem Verbindungsaufbau** und **bei jeder
Rückkehr zum Tab** nachgeholt.

## 🔔 Push-Benachrichtigungen (Web Push)

Zusätzlich zu den Live-Zählern (die nur bei geöffneter App hochzählen) kann jeder Nutzer über den
Menüpunkt **„👤 Mein Konto"** echte Geräte-Benachrichtigungen aktivieren – sie kommen auch
an, wenn die App geschlossen ist. Gemeldet wird genau das, was auch den jeweiligen Zähler erhöhen würde,
**außer für den Auslöser selbst**:

| Ereignis | Benachrichtigt wird |
|---|---|
| Neue Bestellung | Chef + Admin |
| Neuer Aushang bzw. **inhaltlich geänderter** Aushang | alle außer dem Autor |
| Notiz geteilt/angeboten | die betroffenen Empfänger |
| Geteilte Notiz **inhaltlich geändert** | Eigentümer + Mitleser, außer dem Bearbeiter |
| Neuer Abwesenheitsantrag bzw. Krank-/Schule-/Innung-Meldung | alle Manager (Chef/Admin/Buchhalter) |
| Urlaub genehmigt/abgelehnt bzw. Abwesenheit vom Chef bearbeitet | der betroffene Mitarbeiter |

Pro Nutzer lassen sich die Kategorien (Abwesenheiten / Schwarzes Brett / Notizen / **Planung**, für Chef/Admin
zusätzlich Bestellungen) einzeln ein- und ausschalten (wird sofort gespeichert).

**Planungs-Erinnerungen:** Ist der Kategorie-Schalter **„Planung"** an, erscheint in der Tagesansicht im
**⋮-Menü** eines Termins der Punkt **„🔔 Benachrichtigung"** – auch für Mitarbeiter **ohne** Planungsrecht (die
bekommen dadurch überhaupt erst das Menü, mit nur diesem einen Punkt), aber nur an **eigenen** Terminen;
Chef/Admin an **allen** (um sich an Termine der Mitarbeiter erinnern zu lassen). Im Dialog lassen sich
**mehrere** Erinnerungen je Termin setzen – jeweils **Vorlauf (Zahl + Tage/Wochen/Monate)** und eine
**Uhrzeit**. Die Uhrzeit ist mit der **Beginn-Zeit des Termins** vorbelegt: „1 Woche vorher" kommt dann zur
Termin-Uhrzeit. Stellt man die Uhrzeit z. B. auf **18:00** (oder legt eine zweite Erinnerung damit an), erhält
man eine **Abend-Erinnerung**. Die Push lautet „Am Fr 10.07. um 07:00: Kunde XY" bzw. für Chef „Anna hat am
Fr 10.07. um 07:00 einen Termin: …". Bestehende Erinnerungen lassen sich im Dialog **bearbeiten (✏️)** und
**entfernen (✕)**. Bei **Serienterminen** wird bei Anlegen, Ändern und Löschen jeweils gefragt, für welche
Termine es gilt: **„nur dieser Termin" / „dieser + alle folgenden" / „ganze Serie"** — „nur dieser" ist dabei
eine echte **Ausnahme** auf genau diesem Vorkommen (die anderen bleiben). Löscht man „für alle", ist die
Erinnerung überall weg. Wird aus einer **Einzelplanung mit gesetzter Erinnerung** eine Serie gemacht, fragt die
App, wie die Erinnerung übernommen werden soll. Bei **nie endenden** Serien wächst eine „für alle" bzw.
„ab hier" gesetzte Erinnerung automatisch mit den rollierend nachgeschobenen Terminen mit. Wird ein Termin
**verschoben**, wandert die Erinnerung mit (der Tag folgt dem Termin, die eingestellte Uhrzeit bleibt); beim
**Umtakten** einer Serie (z. B. monatlich → wöchentlich) wird eine dauerhafte Erinnerung auf die neue Taktung
übernommen; „ab hier neu takten" ersetzt dabei alles ab dem gewählten Termin über die **gesamte Herkunft** (auch
eine bereits früher umgetaktete, jetzt überholte Fortsetzung). Hat ein Termin
**mindestens eine** Erinnerung, zeigen **Tages- und Wochenansicht** eine **🔔** – unabhängig vom **🔁** der
Serien (eine Serie mit Erinnerung trägt beide). Schaltet man „Planung" wieder **aus**, bleiben alle gesetzten Erinnerungen erhalten und sind nur
**pausiert**; nach dem Wieder-Einschalten kommen sie wieder (noch zukünftige Termine als Nachhol-Erinnerung).

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
| **Mitarbeiter** | Nur die **eigenen** Daten (Zeiten, Abwesenheiten, Planung) + globale Feiertage. Papierkorb: sieht/stellt nur **selbst Gelöschtes** wieder her (kein Zugriff auf ausgestellte Mitarbeiter). Ausnahme: das **Auftrags-Board** ist bewusst für alle sichtbar (damit sich jeder freie Arbeit ziehen kann); anlegen/ändern/erledigen bleibt Chef/Admin. |

> **Aussperr-Schutz:** Der **letzte** verbleibende (aktive) Admin kann weder herabgestuft noch ausgestellt werden – die App würde sonst ohne Administrator dastehen. Lege zuerst einen weiteren Admin an; bei mehreren Admins sind Herabstufen und Ausstellen ganz normal möglich.

**Zusätzliche Einzelrechte** (pro Benutzer unter *Mitarbeiter → Bearbeiten* vergebbar):

- **Planungsrecht** – zwei Stufen, getrennt vergebbar:
  - **sich** – darf nur sich selbst verplanen. In der Planung fällt die Mitarbeiter-Auswahl weg (Planung läuft auf den Nutzer selbst); fremde Abwesenheiten bleiben unsichtbar. Hat ein „alle"-Planer ihn einer **gemeinsamen** Planung zugewiesen, kann er diese für sich anpassen: Löschen klinkt nur ihn aus, eine Zeitänderung teilt den Eintrag auf (er bekommt seinen eigenen, die anderen bleiben unverändert).
  - **alle** – darf alle Mitarbeiter verplanen und sieht in der **Planungsansicht** deren Abwesenheiten (Typ, **ohne** Kommentar). Schließt „sich" automatisch ein.
- **Schwarzes Brett bearbeiten** – darf Aushänge verfassen
- **Dokumente hochladen** – darf in der Dateiablage hochladen/verwalten

> Diese Einzelrechte gelten nur für **Mitarbeiter/Buchhalter**. **Chef und Admin** haben Planung, Schwarzes Brett und Datei-Upload ohnehin über ihre Rolle – im Bearbeiten-Formular werden die Checkboxen für sie darum ausgeblendet (und die Flags nicht gespeichert).

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
   unter **👤 Mein Konto** die Benachrichtigungen aktivieren (am Handy am besten als installierte PWA). Details im Abschnitt
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
| `TWOFA_KEY` | nein, **empfohlen** | aus `JWT_SECRET` abgeleitet | Schlüssel, mit dem die Authenticator-Geheimnisse in der Datenbank verschlüsselt werden. 32 Byte als hex oder base64 (`openssl rand -base64 32`). Ohne diesen Wert wird einer aus `JWT_SECRET` abgeleitet — dann gilt: **Wer `JWT_SECRET` austauscht, macht alle Authenticator-Einrichtungen ungültig.** Der Wert gehört auf **jede** Anlage (auch die Zweitanlage) und liegt **nicht** im Backup. |
| `BACKUP_EMPFAENGER` | nein | leer → Klartext-ZIP | Öffentliche Schlüssel der Sicherungs-Empfänger, mit Komma getrennt (`minipc:MFkw…,offline:MFkw…`). Gesetzt ⇒ Downloads sind verschlüsselte `.adbk`-Dateien, die der Server selbst **nicht** lesen kann. Paar erzeugen: `node scripts/backup-schluessel.js <name>`. |
| `BACKUP_SCHLUESSEL` | nein | leer | **Privater** Schlüssel dieser Maschine. Gehört **nicht** auf den Hauptserver (der soll nur verschlüsseln können), wohl aber auf die Zweitanlage, damit `notfall-umschalten.sh` ohne Menschen entschlüsselt. |
| `TWOFA_AUS` | nein | – | **Notfall-Schalter.** Auf `1` gesetzt wird kein zweiter Faktor mehr verlangt: kein Code beim Anmelden, keine erzwungene Einrichtung. Es wird nichts gelöscht — Variable entfernen, Dienst neu starten, alles greift wie zuvor. |
| `CHROME_BIN` | nein | – | Nur für die Browser-Tests (Puppeteer), nicht für den Betrieb. |

> **Ausgesperrt? So kommt man zurück.**
> Verliert der **einzige Administrator** sein Handy, kann ihn niemand zurücksetzen — er kommt ja
> nicht hinein, um es selbst zu tun. Der Weg zurück:
> 1. Auf dem Server in die `.env` die Zeile `TWOFA_AUS=1` eintragen
> 2. Dienst neu starten (`sudo systemctl restart arbeitsdoku`)
> 3. Normal anmelden, unter **Mein Konto** den Authenticator neu einrichten
> 4. `TWOFA_AUS` wieder entfernen und erneut neu starten
>
> Es geht dabei nichts verloren. Wer keinen Serverzugriff haben möchte, führt schlicht **zwei
> Administrator-Konten** — dann setzt einer den anderen zurück.

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

### Verschlüsselte Sicherungen

Ein Backup ist eine vollständige Kopie aller Kundendaten — Namen, Adressen, Geburtsdaten,
Abwesenheits-Kommentare. Solche Kopien liegen auf mehreren Rechnern und werden Jahre alt. Deshalb
lassen sie sich verschlüsseln, und zwar **asymmetrisch**: Der Server bekommt nur die *öffentlichen*
Schlüssel. Er kann Sicherungen erzeugen, aber keine mehr lesen. Wer den Server übernimmt, kommt an
den laufenden Datenbestand — nicht an die Historie.

Eingeschaltet wird das über die Liste **„Wer kann Sicherungen öffnen?"** in *Einstellungen →
Backup* — oder über `BACKUP_EMPFAENGER` in der `.env`. Ist beides leer, bleibt alles wie bisher
(Klartext-ZIP); Bestandsinstallationen müssen nichts ändern.

**Beide Quellen gelten gleichzeitig.** Der `.env`-Eintrag ist der feste Anker: Er hängt an der
Maschine, kein Restore verschiebt ihn, und über die Oberfläche kann ihn niemand entfernen oder
überschreiben. Die Liste in der Datenbank ist der bequeme Weg für alle, die keinen SSH-Zugang
haben.

**Rechte:** Sehen dürfen die Liste Chef und Admin (wie die ganze Backup-Karte). **Ändern darf sie
nur ein Admin** — wer sie ändert, entscheidet, wer den gesamten Datenbestand lesen kann, und
könnte im Vorbeigehen den Schlüssel der Zweitanlage entfernen und damit die Notfall-Umschaltung
stilllegen. Jede Änderung steht im Audit-Log. „Prüfen" darf auch der Chef, weil der Besitznachweis
am Zugriff nichts ändert.

Ein Schlüsselpaar entsteht auf drei Wegen:

```bash
node scripts/backup-schluessel.js minipc     # 1. mitgeliefertes Skript
```

2. **Im Browser**, direkt in der Backup-Karte („Schlüssel hier erzeugen"). Der private Teil wird
   einmal angezeigt — in die Zwischenablage oder als Datei — und danach vergessen; er geht an
   keinen Server. Zur Zwischenablage: Windows führt mit Win+V einen Verlauf, der auf Wunsch
   zwischen Geräten synchronisiert, und manche Programme lesen mit — also sofort in die
   Passwortverwaltung und danach etwas anderes kopieren.
3. **Mit `openssl`** (Linux, macOS, Windows über Git Bash oder WSL) — nachgemessen, nicht
   abgeschrieben:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out privat.pem
openssl pkcs8 -topk8 -nocrypt -in privat.pem -outform der | base64 | tr -d '\n' > privat.txt
openssl ec -in privat.pem -pubout -outform der | base64 | tr -d '\n' > oeffentlich.txt
```

Ein hinterlegter Schlüssel lässt sich **prüfen**: Der Server verschlüsselt ein paar Zufallsbytes
an genau diesen Empfänger, der Browser entschlüsselt sie mit dem privaten Teil und schickt sie
zurück. Damit weiss der *Server*, dass der Schlüssel wirklich passt — ein Browser, der nur „hat
geklappt" meldet, würde nichts beweisen. So fällt ein Schlüssel auf, dessen privaten Teil niemand
mehr hat: die gefährlichste Störung dieses Verfahrens, weil die Sicherungen dann weiterlaufen und
unlesbar sind.

Zwei Empfänger sind der Regelfall: die Zweitanlage (damit `notfall-umschalten.sh` ohne Menschen
läuft) und ein Offline-Schlüssel in der Passwortverwaltung. Die Datei heißt dann `.adbk` statt
`.zip`; sie beginnt mit `ADBK1` und enthält AES-256-GCM über dem ZIP, dessen Schlüssel für jeden
Empfänger einzeln per ECDH P-256 + HKDF-SHA256 verpackt ist.

**Entschlüsselt wird nie auf dem Server** — das wäre der Widerspruch zum Zweck. Es gibt drei Wege:

| Lage | Weg |
|---|---|
| Normalfall | *Einstellungen → Backup einspielen*: Datei wählen, es erscheint ein Feld für den Schlüssel, einfügen, einspielen. Der **Browser** entschlüsselt; der Schlüssel verlässt das Gerät nicht, der Server bekommt nur das fertige ZIP. |
| Hauptanlage ausgefallen | Die Zweitanlage hält einen eigenen privaten Schlüssel (`BACKUP_SCHLUESSEL`) und entschlüsselt selbst — niemand muss etwas eingeben. |
| Beide Anlagen weg | `werkzeuge/sicherung-entschluesseln.html` — eine einzelne Datei, Doppelklick, ohne Installation und ohne Internet. In der App unter *Einstellungen → Backup* als **„Notfall-Entschlüsseler herunterladen"** erhältlich, **zusammen mit dem Schlüssel aufbewahren** (nicht auf dem Server, dort nützt sie im Ernstfall nichts). |

Landet ein `.adbk` doch einmal direkt beim Server, antwortet er mit dieser Erklärung statt mit
einem Fehler.

**Vorhandene Klartext-Sicherungen** stellt ein eigenes Skript um. Es verschlüsselt, entschlüsselt
sofort wieder, vergleicht Byte für Byte — und löscht das Klartext-ZIP **erst danach**. Scheitert
die Rückprobe, bleibt das ZIP unangetastet liegen. Ohne privaten Schlüssel (also auf dem Server)
wird verschlüsselt, aber nichts gelöscht.

```bash
node scripts/backup-altbestand-verschluesseln.js ~/arbeitsdoku-backups --trocken
node scripts/backup-altbestand-verschluesseln.js ~/arbeitsdoku-backups
```

**Die `.env` liegt nicht im Backup** — und das ist Absicht: Auf der Zweitanlage steht dort der
*private* Sicherungsschlüssel, der sonst in der abgeschlossenen Kiste läge. Ein Restore bringt also
die Daten zurück, nicht die Geheimnisse. Drei Werte gehören deshalb neben den Sicherungsschlüssel
in die Passwortverwaltung: `JWT_SECRET`, `TWOFA_KEY` (ohne ihn ist jede Zwei-Faktor-Einrichtung
wertlos) und auf der Zweitanlage `BACKUP_SCHLUESSEL`.

> **Der eine wirklich gefährliche Punkt:** Wer *alle* privaten Schlüssel verliert, verliert die
> gesamte Sicherungs-Historie — endgültig, ohne Hintertür. Der zweite Schlüssel gehört deshalb an
> zwei getrennte Orte, bevor die erste verschlüsselte Sicherung entsteht.

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

### Impressum & Datenschutz (rechtlich)

Da die App öffentlich erreichbar ist, sind in DE i. d. R. ein **Impressum** (§5 DDG) und eine
**Datenschutzerklärung** (Art. 13 DSGVO) nötig. Beide Texte sind **admin-/chef-konfigurierbar** (nicht
hartkodiert, white-label-tauglich): *Einstellungen → Rechtliches (Impressum & Datenschutz)*.

- Sobald ein Text hinterlegt ist, erscheint der jeweilige Link **auf der Anmeldeseite** (bewusst **ohne Login**
  erreichbar – Impressumspflicht) und **im Menü** (für alle Rollen). Leere Texte blenden den Link aus.
- Öffentlicher Endpunkt `GET /api/legal` (auth-frei) liefert die Texte; die Anzeige ist HTML-escaped
  (kein Rich-Text, XSS-sicher).
- **Hinweis:** Die App stellt nur die technische Möglichkeit bereit. Inhalte (v. a. wegen der Beschäftigten-
  und Krankheitsdaten) sollte der/die Datenschutzbeauftragte bzw. eine Rechtsberatung prüfen und einfügen.

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
| `node scripts/generate-test-index.js` | Schreibt die vollständige Testliste in `tests/README.md` (Beschreibung = erste Kommentarzeile jedes Tests). |

Automatisierte Tests liegen unter `tests/` (Berechnungs-/Logiktests sowie echte Browser-Klick-Tests
mit Puppeteer). **Jeder Test startet sich seinen eigenen Server und legt seine eigene Datenbank an** —
vorzubereiten ist nichts außer dem Chromium für die Browser-Tests.

Die **vollständige Liste aller Tests** steht in [`tests/README.md`](tests/README.md) und wird erzeugt;
`node tests/testliste-vollstaendigkeit.js` schlägt an, sobald sie nicht mehr zum Stand von `tests/`
passt. Warum einzelne Tests so gebaut sind, wie sie gebaut sind, steht in
[`ENTWICKLUNG.md`](ENTWICKLUNG.md).

Ein einzelner Test:

```bash
node tests/pause-beispiele.js
```

Alle nacheinander (dauert etwa eine Dreiviertelstunde):

```bash
for t in tests/*.js; do
  printf '%-40s' "$(basename "$t")"
  timeout 700 node "$t" >/dev/null 2>&1 && echo OK || echo FEHLER
done
```

Browser-Tests brauchen einmalig `chrome-headless-shell` (Anleitung in
[`tests/README.md`](tests/README.md)). Tests mit `-prodklon` im Namen arbeiten gegen eine **Kopie**
der Produktivdaten unter `/tmp/prodklon.db` und überspringen sich, wenn die Kopie fehlt.

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
node -e "const b=require('bcryptjs'),fs=require('fs'),i=require('sql.js'); i().then(S=>{const db=new S.Database(fs.readFileSync('./data/arbeitsdoku.db')); db.run('UPDATE users SET password_hash=? WHERE username=?',[b.hashSync('NeuesPasswort123!',10),'admin']); fs.writeFileSync('./data/arbeitsdoku.db',Buffer.from(db.export())); console.log('Admin-Passwort gesetzt.');});"
```
Danach mit `admin` / `NeuesPasswort123!` anmelden und in der App ändern.

**Mehrfach auf „Speichern" geklickt (langsames Netz) – wird jetzt doppelt angelegt?**
Nein. Die App fängt versehentliches Mehrfach-Speichern app-weit ab: Beim Absenden wird der Speichern-Button
gesperrt, und identische, gleichzeitig laufende Aktionen werden zu **einer** zusammengefasst – es entsteht nur
**ein** Eintrag. Für Planungen greift zusätzlich ein Server-Riegel (identische Planung innerhalb weniger
Sekunden wird nicht doppelt eingefügt), der auch bei Verbindungsabbruch mit automatischem Neuversuch schützt.

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
