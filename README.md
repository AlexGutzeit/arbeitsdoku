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
| **🏠 Willkommen** | Persönliches Dashboard: anstehende Planung, eigene Abwesenheiten, Schnellüberblick. **Wetter** zum Firmenort (aus *Einstellungen → Firmen-Einstellungen*): aktuelle Lage, stündlicher Tagesverlauf und eine **7-Tage-Vorschau** mit je **früh / mittag / abend** (Symbol, Temperatur, Regenwahrscheinlichkeit). Jeder Tag lässt sich **antippen** und zeigt dann seinen **stündlichen** Verlauf – so weit reichen die hochauflösenden Modelle, darüber hinaus gibt es keine belastbaren Vorhersagedaten. Ohne hinterlegten Ort erscheint statt des Wetters ein Hinweis. **🎂 Geburtstag heute:** Hat jemand Geburtstag, steht ganz oben *„Tina Torte wird heute 36 🎉"* — wie die Schwarzes-Brett-Einblendungen einfach da, nichts zum Wegklicken, am nächsten Tag von selbst weg. **Nur Chef/Admin/Buchhalter** sehen das: Diese drei bekommen das Geburtsdatum über die Mitarbeiterliste ohnehin, eine Anzeige für die **ganze Belegschaft** wäre dagegen einwilligungspflichtig (§ 26 BDSG trägt sie nicht). Der eigene Geburtstag wird ausgelassen, ausgestellte Mitarbeiter erscheinen nicht, und das Geburtsdatum selbst verlässt den Server nicht — übertragen werden nur Name und Alter. Wer am **29. Februar** geboren ist, erscheint in Nicht-Schaltjahren am 28. mit dem Vermerk „Geboren am 29. Februar — den gibt es dieses Jahr nicht, deshalb heute." |
| **📊 Zeitnachweis** | Kern-Zeiterfassung. Eintrag mit Datum, Von/Bis, Pause, Arbeitsort, Kunde, Projekt, Beschreibung und optionalem „Regie"-Vermerk. **Vorbelegung der Zeiten:** „Von" schließt an den letzten Eintrag des Tages an; gibt es keinen, gilt die geplante Startzeit, sonst der **Arbeitsbeginn** (je Mitarbeiter, sonst Firmenwert). „Bis" ist die aktuelle Uhrzeit — und **nie vor „Von"**: Wer um 06:30 bucht, obwohl der Arbeitsbeginn 07:00 ist, bekommt 06:30–06:30 statt einer unmöglichen Spanne. Läge dagegen die Endzeit eines bereits gebuchten Eintrags nach „jetzt" (Tag im Voraus gebucht), bleibt „Von" stehen und „Bis" zieht nach — sonst liefe der neue Eintrag in den vorhandenen hinein. **Die Pause wird mit dem REST zur Firmenpause vorbelegt:** `max(0, Firmenpause − heute schon erfasste Pausen)` für denselben Mitarbeiter am selben Tag. Firmenpause 30 → erster Auftrag 30, danach 0; wurden im ersten nur 15 genommen, schlägt der nächste 15 vor, davon 10 genommen → der dritte 5, bis 0. Es zählen **alle** Einträge des Tages, auch vom Chef nachgetragene — es ist sein Arbeitstag, unabhängig davon, wer getippt hat. Steht schon etwas, erklärt eine kleine Zeile unter dem Feld warum („Firmenpause 30 min · heute schon 20 min erfasst"); beim ersten Eintrag bleibt sie leer. Bei **Übernahme aus der Planung** gilt der geplante Wert nur, solange der Tag leer ist — sonst gewinnt die Restpause, sonst stünde die Pause zweimal im Tag. **Beim Bearbeiten** bleibt die gespeicherte Pause unangetastet: Dort die Restpause zu rechnen, zeigte bei einem Eintrag mit voller Pause plötzlich 0 — und einmal Speichern löschte sie.

**Gesetzliche Mindestpause (§ 4 ArbZG):** Geht der Tag über **9 Stunden** Arbeitszeit, hebt die Vorbelegung von sich aus auf **45 Minuten** an — auch wenn der Firmenwert niedriger ist; der Firmenwert bleibt dabei die **Untergrenze**, das Gesetz kann ihn nur anheben. Ein Satz unter dem Feld erklärt es („Der Tag kommt auf 10 Std Anwesenheit. Ab 9 Stunden Arbeitszeit schreibt das Arbeitszeitgesetz 45 min Pause vor …"). Der Vorschlag zieht **beim Bearbeiten von „Von"/„Bis"** nach, sobald die Uhrzeit vollständig ist — nicht bei jedem Tastendruck, sonst spränge er bei halb getippten Zeiten.

Die Rechnung sucht die **kleinste** Pause, mit der die Vorschrift erfüllt ist. Das ist nötig, weil sich Pause und Arbeitszeit gegenseitig bedingen: Bei 9:45 Anwesenheit ergäben 30 Minuten Pause 9:15 Arbeitszeit (über 9 → 45 nötig), 45 Minuten aber 9:00 (nicht über 9 → 30 genügte). Ohne diese Formulierung pendelte der Vorschlag. Nebenbei fängt sie die **Sechs-Stunden-Falle**: 6:20 Anwesenheit ohne Pause wären 6:20 Arbeit am Stück, also sind 30 Minuten fällig.

**Zwei Alterstabellen (§ 4 ArbZG / § 11 JArbSchG):** Für **Jugendliche unter 18** gelten längere Pausen — **30 Minuten ab 4½** und **60 Minuten ab 6 Stunden** Arbeitszeit. Die App entscheidet das selbst: Aus dem **Geburtsdatum** des Mitarbeiters (Mitarbeiter → bearbeiten) errechnet sie das Alter **am Tag des Eintrags**, nicht am heutigen Tag — wer im Juli 18 wird, bekommt für einen nachgetragenen Juni-Eintrag noch die Jugendschutz-Werte. Der Hinweis unter dem Feld nennt jeweils das **zutreffende** Gesetz. **Ist das Geburtsdatum leer, rechnet die App vorsichtshalber „unter 18"** und sagt das im Hinweis dazu — lieber eine zu lange Pause vorschlagen als eine unzulässig kurze. Praktische Folge: Solange keine Geburtsdaten gepflegt sind, schlägt schon ein normaler 8-Stunden-Tag **60 Minuten** vor. Das Geburtsdatum wird beim Öffnen des Formulars frisch ausgewertet; die Sitzung des Mitarbeiters holt einen nachgetragenen Wert beim nächsten Wechsel zurück in die App ab — ohne neues Anmelden. Keine Rechtsberatung; Tarifverträge können abweichen. Nettostunden werden automatisch berechnet; überlappende Einträge werden nicht doppelt gezählt. |
| **👥 Mitarbeiter** | Benutzerverwaltung (anlegen/bearbeiten/Rolle setzen), **Soll-Stunden pro Woche** (mit Historie), Start-Überstunden, Passwort zurücksetzen, Einzelrechte vergeben. **Arbeitsbeginn** je Mitarbeiter (optional, leer = Firmenwert aus den Einstellungen) — nur für Ausnahmen, die früher oder später anfangen. **Geburtsdatum** (optional): einziger Zweck ist die Pausen-Vorbelegung — daraus entscheidet die App, ob das Arbeitszeitgesetz oder das Jugendarbeitsschutzgesetz gilt. **Leer heißt „unter 18"**, nicht „unbekannt, also Erwachsener"; ein Hinweis am Feld sagt das. Zukünftige und unmögliche Daten werden abgewiesen, jede Änderung steht im Protokoll. Bei allen Stunden-/Tage-Feldern sind „**,**" und „**.**" als Dezimaltrenner erlaubt (z. B. `7,5`); eine unlesbare Eingabe wird **gemeldet** statt still als 0 gespeichert. **Passwort-Anforderungen** (beim Anlegen & Zurücksetzen, serverseitig erzwungen): mind. 8 Zeichen, je 1× Groß-/Kleinbuchstabe, Ziffer und Sonderzeichen, und ≠ Benutzername – die Bedingungen werden beim Tippen **live** angezeigt (grüner Haken/rotes ✗, Feld färbt sich rot/grün). Bestehende Anmeldungen bleiben davon unberührt. **Urlaubsanspruch (versioniert):** je Mitarbeiter lassen sich – analog zu den Soll-Stunden – **mehrere Anspruchszeilen** „X Tage, **gültig ab** Datum" per „+" anlegen und rückwirkend ändern/löschen (z. B. Start-Anspruch bei Eintritt, Erhöhung im 2. Jahr). **Ohne Eintrag zählt 0** (kein Default), und solange keine Zeile existiert, bleibt überall die **alte Ansicht** (nur genommene Tage) – die Resturlaub-Anzeigen erscheinen erst mit hinterlegtem Anspruch. Jede Zeile trägt ihre **eigene Verfall-Regel** – Resturlaub verfällt **nie / zum Jahreswechsel / an einem Datum im Folgejahr** –, sodass sich der Modus über die Zeit **umstellen lässt, ohne die Vergangenheit zu verändern** (ein Moduswechsel wirkt nur ab dem jeweiligen „gültig ab" vorwärts). Der Anspruch ist **jahresbezogen**: pro Jahr gilt die Zeile mit dem **jüngsten „gültig ab" bis Jahresende** (mehrere Zeilen im selben Jahr → die späteste gewinnt); die Rechnung beginnt am **frühesten** „gültig ab"-Jahr, nicht bei der Mitarbeiter-Anlage. Ein Feld **„Start-Resturlaub (Übertrag)"** trägt den Stand **vor** Einführung der App als einmaligen Übertrag ins erste erfasste Jahr (analog Start-Überstunden) – so lassen sich Bestands-Mitarbeiter ohne Nachtragen aller Vorjahre übernehmen. Eine Stand-Anzeige mit Jahr-Auswahl zeigt sofort genommen/geplant/verbleibend. **Ausstellen statt Löschen:** ausgeschiedene Mitarbeiter werden mit Austrittsdatum ausgestellt (kein Login mehr), ihre Zeiten/Abwesenheiten/Planungen bleiben aber vollständig erhalten und für ihren Anstellungszeitraum in Statistik und PDF berücksichtigt. Wiedereinstellen ist jederzeit möglich (auch mehrfach) – die Lücke zählt 0 Soll-Stunden. *(Chef/Admin)* |
| **📁 Projekte / Aufträge** | **Auftrags-Board** (für alle sichtbar): Mitarbeiter waagerecht, darunter ihre Aufträge als Kacheln – sortiert nach **Dringlichkeit** (🔴 dringend → 🟠 → 🟡 → 🟢, bei Gleichstand ältester oben). Aufträge ohne Zuweisung stehen in der Spalte **„Nicht zugewiesen"**, sodass sich jeder freie Arbeit ziehen kann. Ein Auftrag hat **Name, Kunde, Adresse, Notiz, Dringlichkeit** und kann **mehreren Nutzern** zugedacht sein – **alle Rollen außer Admin** (auch Chef/Buchhalter, z. B. für Arbeiten im Haus). Der Auftrag erscheint unter jedem Zugewiesenen. Mitarbeiter haben immer eine Spalte; **Chef/Buchhalter erscheinen – wie in der Planung – erst als Spalte, sobald ihnen etwas zugewiesen ist.** Klick auf eine Kachel zeigt Details + Aktionen: **„In Planung übernehmen"** (Admin/Chef/Planungsberechtigte inkl. Selbstplaner) und **„Als Zeitnachweis übernehmen"** (alle) übertragen Projekt/Kunde/Adresse/Notiz vorbefüllt ins jeweilige Formular; bei hinterlegter Adresse gibt es einen **Navigations-Button**. Anlegen über den großen **FAB „+"** mit vollem Formular; **Bearbeiten / Erledigt / Löschen** nur Chef/Admin. „Erledigt" nimmt den Auftrag vom Board (bleibt archiviert). **„Löschen" verschiebt in den Papierkorb** (Soft-Delete, inkl. Zuweisungen/Zwischenziele) – von dort können **Chef/Admin** ihn **wiederherstellen** oder **endgültig löschen** (mit Bestätigung); der Projektname wird **schon beim Löschen** (Papierkorb) in vorhandenen Planungen/Zeitnachweisen/Werkzeugen/Notizen als Freitext gesichert, bleibt also erhalten – nach Wiederherstellen hat der Live-Name wieder Vorrang. Die Projektauswahl im **Zeitnachweis-/Planungsformular** füllt Adresse/Kunde/Notiz automatisch. Chef/Admin können die **Dringlichkeit direkt über die Ampel** (Klick auf die Farbe) ändern und **erledigte Aufträge** über „Erledigte anzeigen" einsehen und **wieder öffnen**. Das Board **aktualisiert sich live** (SSE) über alle Geräte. **Zwischenziele & Fortschritt:** Chef/Admin legen im Bearbeiten-Formular **Zwischenziele** mit geschätzter **Dauer** an (z. B. „Hauptverteiler | 2 Tage"). Zugeteilte Nutzer (+ Chef/Admin) schalten je Ziel den Status **offen (rot) / in Arbeit (gelb) / erledigt (grün)**; daraus wird ein **nach Dauer gewichteter Fortschrittsbalken** („X % fertig · Y % in Arbeit · Z % offen") berechnet und – live für **jeden** sichtbar – angezeigt. Ohne Zwischenziele gibt es keinen Balken. Eine **Farb-Legende** im Board-Kopf erklärt die Dringlichkeits-, Fortschritts- und Termin-Farben (inkl. hellblauer „Luft bis Frist"). **Statistik-Reiter** (Admin/Chef/Buchhalter): auf der aufgeklappten Kachel zeigt „📊 Statistik" die **gebuchten Netto-Stunden je Nutzer** (alle Bucher außer Admin) + Anzahl Einträge + **Gesamtsumme** – gezählt werden Zeiteinträge mit dem Projekt (Dropdown) **oder** dem Projektnamen im Freitext, funktioniert also auch für Bestands-Aufträge und über ein zwischenzeitliches Löschen/Neu-Anlegen hinweg. Ein **CSV-Export** listet jeden Einzeleintrag (Benutzer, Datum, Uhrzeit von-bis, Pause, Netto) nach Datum sortiert samt Gesamtsumme. **Fällig bis:** optionales Termin-Datum je Auftrag → Kachel zeigt „noch X Arbeitstage" (bzw. „X Arbeitstage überfällig"). **Gerechnet wird in Arbeitstagen** – Samstag, Sonntag und die in der App gepflegten **Feiertage** zählen nicht (passend zu den Zwischenziel-Dauern, die ebenfalls Arbeitstage sind). Ohne Zwischenziele ist die Badge-Farbe rein kalendarisch (überfällig rot · ≤ 3 Arbeitstage orange · sonst neutral); mit Zwischenzielen färbt sie sich nach der **Zeit-Gesundheit**. Sind Zwischenziele gesetzt, erscheint im (weiter dreifarbigen) Fortschrittsbalken eine **Frist-Markierung**: liegt sie im offenen/in-Arbeit-Teil, reißt man die Frist (rot, „X AT über Frist"); ist Puffer da, wird der Arbeitsbalken kürzer und die restliche Zeit als **hellblaues „Luft"-Segment** bis zur Frist-Markierung gezeigt (grün, „X AT Luft"). Restaufwand = offene + in-Arbeit-Ziele in Arbeitstagen (erledigte zählen nicht); grün < 85 % der Restzeit · orange 85–99 % · rot ≥ 100 %. Alles rein visuell – **ändert die Kachel-Reihenfolge nicht** und aktualisiert sich **live** (SSE) über alle Geräte. Ungültige Datumsangaben (z. B. 30.02.) werden serverseitig abgewiesen. *(Erstellen/Ändern/Erledigen: Chef/Admin; Ziel-Status: Zugeteilte + Chef/Admin)* |
| **📅 Planung** | Einsatz-/Schichtplanung: Termine mit Uhrzeit, Ort, Kunde, Projekt – einzeln oder als Gruppe, farblich markierbar. Mitarbeiter sehen ihre Einsätze. **Serientermine (Wiederholung):** ein Termin (auch mehrtägig) kann sich **wöchentlich**, **monatlich am Datum** (z. B. jeden 8.), **monatlich am n-ten Wochentag** (z. B. jeder 2. Mittwoch), **jährlich am Datum** oder **jährlich am n-ten Wochentag eines Monats** (z. B. 1. Montag im Februar) wiederholen. Das Muster wird aus dem Starttag abgeleitet; bei mehrtägigen Terminen wiederholt sich der **ganze Block** (Starttag + Folgetage). Ende **nie / nach N Terminen / bis Datum**; „nie" läuft rollierend ~24 Monate voraus (täglich nachgefüllt). Eine **Live-Vorschau** zeigt die nächsten Termine (mehrtägig als Bereich) und **warnt bei Überschneidung**; überlappende Termine erscheinen in der Ansicht **nebeneinander** (wie zwei gleichzeitige Termine). Serientermine tragen ein **🔁**; **Bearbeiten** und **Löschen** fragen den Umfang (**nur dieser / dieser + folgende / ganze Serie**); Feld-Änderungen (z. B. Mitarbeiter, Kunde) mit „dieser + folgende"/„ganze Serie" wirken über die **gesamte Herkunft** – also auch über eine umgetaktete Fortsetzung hinweg (durchgehend gleiche Zuweisung), zusätzlich **„Serie beenden"** (ab heute, Vergangenes bleibt). Setzt man die Wiederholung im Bearbeiten auf **„Keine"**, fragt die App **„ab diesem Termin beenden" (frühere bleiben)** oder **„nur diesen Termin behalten" (Serie auflösen, Rest löschen)**. Schrumpft eine Serie dadurch auf **ein** Vorkommen, wird daraus wieder eine **echte Einzelplanung** (kein 🔁 mehr). „Nur diesen behalten" erfasst dabei auch aus **Umtakten** hervorgegangene Folge-Serien derselben Herkunft (z. B. eine später monatliche Fortsetzung) – es bleibt wirklich nur der eine Termin. Rechte wie sonst: Selbstplaner nur eigene Serien. Über das **⋮-Menü** lassen sich pro Termin **Push-Erinnerungen** mit frei wählbarem Vorlauf setzen (siehe [Push-Benachrichtigungen](#-push-benachrichtigungen-web-push)). |
| **📌 Schwarzes Brett** | Aushänge/Ankündigungen fürs ganze Team, mit Benachrichtigungs-Badge. |
| **🔧 Werkzeugliste** | Werkzeug-Inventar mit Ausleihe/Rückgabe: wer hat was wann entnommen, inkl. Historie und Übernahme. |
| **🛒 Bestellungen** | Material-/Bestellanforderungen der Mitarbeiter; Chef sieht offene Bestellungen (Badge). |
| **📝 Notizen** | Persönliche und **geteilte** Notizen (Lese-/Schreibrechte pro Benutzer), mit Bearbeitungs-Sperre gegen gleichzeitiges Editieren. Empfänger können eine geteilte Notiz per **„Freigabe verlassen"** selbst aus ihrer Liste entfernen; beim Eigentümer verschwindet der Haken, er kann sie durch erneutes Anhaken wieder freigeben. Filterbar nach **eigenen / freigegebenen** Notizen (sowie gezielt **nach jedem einzelnen Freigeber**), Projekt und Suchtext. |
| **🗂️ Dokumente** | Dateiablage mit Ordnern/Unterordnern. Upload (PDF, MS-Office `docx/xlsx/pptx`, OpenDocument `odt/ods/odp`, Bilder PNG/JPG, `txt/csv/md`; max. Dateigröße standardmäßig 5 MB, vom Admin einstellbar, Magic-Byte-Prüfung gegen umbenannte `.exe`), Verschieben, Umbenennen, rekursives Löschen. Konfigurierbares Gesamt-Speicherlimit **und** Pro-Datei-Limit. Mitarbeiter laden nur herunter – außer sie bekommen das Upload-Recht. |
| **🏖️ Abwesenheit** | Krank, Urlaub, Freizeitausgleich, Sonderurlaub, Feiertag, Berufsschule, Innung. Urlaub/FZA/Sonderurlaub durchlaufen einen **Genehmigungs-Workflow**. Prioritätsbewusste Tageszählung (Feiertag > Krank > Schule/Innung > Urlaub/FZA) und korrekte Soll-Stunden-/Überstunden-Verrechnung. **Arbeiten trotz Abwesenheit ist möglich** und wird sauber verrechnet: an Urlaub/Schule/Feiertag-Tagen zählt gebuchte Zeit voll als Überstunden, bei **FZA** sinkt nur der Abzug. **Krank** ist überstundenneutral bis zur normalen Tagesleistung (Soll = min(gearbeitete Stunden, Normal-Soll)) – Mehrarbeit darüber hinaus zählt als Überstunden. **Urlaubskonto** (sobald ein Anspruch hinterlegt ist – sonst bleibt es bei der alten Anzeige „Urlaub JAHR: X Arbeitstage"): jeder Mitarbeiter sieht im Kopf seinen Stand „Urlaub JAHR: X genommen · Y geplant · Z verbleibend". **Genommen** = genehmigt & in der Vergangenheit, **geplant** = genehmigt & in der Zukunft. Wird eine Abwesenheit **gelöscht**, fließen die Tage automatisch wieder zurück. Übersteigt ein Antrag den Resturlaub, erscheint ein **Warnhinweis** (blockiert aber nicht). **Chef/Admin/Buchhalter** haben zusätzlich den Reiter **„Urlaubsübersicht"** (erscheint erst, sobald irgendwo ein Anspruch gepflegt ist) mit einer Tabelle je Mitarbeiter (Jahr-Auswahl, Namenssuche, Stand-Datum, **PDF-Download**): Anspruch · Übriger Anspruch vom Vorjahr · Gesamtanspruch · Genommen · Geplant und akzeptiert · Noch zu planen · **Beantragt (offen)** · Krank · FZA. Mitarbeiter **ohne** hinterlegten Anspruch erscheinen mit **„–"** in den Anspruch-Spalten (ihre echten Abwesenheiten werden trotzdem gezählt). Auch der **Arbeitsnachweis-PDF** zeigt das Urlaubskonto (bzw. ohne Anspruch die alte Zeile „Urlaubstage genommen"). Der Anspruch samt Verfall-Regel und Start-Resturlaub wird je Mitarbeiter unter **👥 Mitarbeiter** gepflegt. |
| **📈 Statistik** | Soll-/Ist-Stunden und Überstunden je Zeitraum und Mitarbeiter, mit Diagrammen. |
| **📄 Export** | Sammelt beide Ausgabewege. **PDF:** druckfertiger Arbeitsnachweis (Einträge + Abwesenheiten + Stunden-Zusammenfassung), gefiltert nach Zeitraum/Mitarbeiter/Projekt. **Lohn-Export (CSV)** *(Chef/Admin/Buchhalter)*: Monat wählen (voreingestellt der Vormonat) → eine Tabelle mit **einer Zeile je Mitarbeiter** — Personalnummer, Soll-/Ist-Stunden, Saldo, Überstunden gesamt sowie Urlaubs-, Krank-, FZA-, Sonderurlaubs-, Berufsschul-, Innungs- und Feiertage, dazu eine Summenzeile. Semikolon-getrennt mit UTF-8-BOM, öffnet sich direkt in Excel. Enthalten sind alle Rollen außer Admin, die im Monat angestellt waren — **auch bereits ausgeschiedene**, mit Austrittsdatum in der Spalte „Beschäftigt bis" (sonst fehlte der letzte Monat in der Abrechnung). Der Export wird im Audit-Log vermerkt. Spart das monatliche Abtippen aus dem PDF — dort erscheinen Urlaubs-/Krank-/FZA-Tage nämlich nur, wenn man **einen einzelnen** Mitarbeiter auswählt. Die **Personalnummer** wird je Mitarbeiter unter *👥 Mitarbeiter* gepflegt (optional). |
| **🔒 Abrechnungs-Abschluss** | Ein abgeschlossener Monat ist **schreibgeschützt** und seine Zahlen sind **festgehalten**. Hintergrund: Der Überstundenstand wurde bisher bei jeder Abfrage vom allerersten Tag an neu gerechnet — wer einen Mai-Eintrag korrigierte, veränderte damit seinen **heutigen** Stand, obwohl die Mai-Stunden längst bezahlt waren. Nach dem Abschluss rechnet der Stand auf dem festgehaltenen Wert weiter. Bedient wird das auf der Seite **📄 Export**, direkt unter dem Lohn-Export: Zielmonat wählen und
**„Abschließen bis einschließlich …"** — alle offenen Monate bis dahin werden der Reihe nach
festgeschrieben, damit man nach längerer Pause nicht Monat für Monat klicken muss. Ein dezenter
Hinweis nennt offene Monate; abgeschlossene Zeiträume stehen darunter mit **„Abweichungen prüfen"**.
Im **Zeitnachweis** zeigt ein gesperrter Eintrag statt der Knöpfe den Grund, und der Admin wird vorab
auf die Begründungspflicht hingewiesen. In der **📈 Statistik** sieht jeder den Stichtag, Mitarbeiter
zusätzlich ihre eigenen abgerechneten Zahlen. **Abschließen** dürfen Chef/Admin/Buchhalter, immer nur
den nächsten offenen Monat und nur **lückenlos**; offene Urlaubs-/Krankanträge im Zeitraum müssen vorher entschieden sein. Gesperrt sind **alle** Wege, die Zahlen rückwirkend verschieben — Zeiteinträge, Abwesenheiten samt Genehmigen/Ablehnen, Soll-Stunden, Urlaubsanspruch, Ein-/Austrittsdaten, Start-Überstunden und das Wiederherstellen aus dem Papierkorb. **Der Ausweg:** Der **Admin** kommt weiterhin durch, aber nur mit **Pflichtbegründung**; der Eingriff steht im Audit-Log, der festgehaltene Wert bleibt stehen, und die Differenz wird als *„bezahlt X — heute berechnet Y"* ausgewiesen. **Und dann muss sie übernommen werden:** Ein Nachtrag im bezahlten Monat ist zwar sofort im Zeitnachweis und in der Monatsstatistik sichtbar, steckt aber in **keinem Überstundenstand** — genau der geht nächsten Monat ans Lohnbüro. Erst „Differenz übernehmen" schreibt die Stunden dem laufenden Zeitraum gut, womit sie in den nächsten Lohn-Export gehen; der abgeschlossene Monat bleibt als Beleg unverändert. Dabei ist ein **Kommentar Pflicht** — sonst stünden im Folgemonat Stunden, die niemand zuordnen kann. Gekennzeichnet wird an allen drei Stellen, an denen sie auftauchen: im Lohn-Export in **zwei eigenen Spalten** („Nachtrag Vormonat" und „Nachtrag Herkunft", z. B. *„April 2026: +4,00 h (Krankmeldung nachgereicht)"*) — bewusst **nicht** in den Ist-Stunden, denn gearbeitet wurden sie im Vormonat; beim Mitarbeiter in seiner Statistik mit Herkunftsmonat, Kommentar und dem, der übernommen hat; und im Audit-Log. Damit es niemand vergisst, **blockiert eine offene Differenz den nächsten Monatsabschluss** — wie ein unentschiedener Urlaubsantrag. Deshalb gibt es **zwei** Wege heraus: **übernehmen** (gutschreiben) oder **ablehnen** (bewusst *nicht* gutschreiben, etwa weil die Stunden bereits bar oder mit Freizeit abgegolten wurden). Beides verlangt eine Begründung und steht im Protokoll; abgelehnte Stunden erscheinen in **keinem** Lohn-Export, der Mitarbeiter sieht sie aber mit dem Grund — sonst verschwänden sie lautlos. Eine Sperre mit nur einem Ausgang wäre keine Entscheidung, sondern ein Zwang zur Buchung. Der Mitarbeiter sieht in seiner Statistik, dass sein Stand eine noch nicht übernommene Korrektur nicht enthält. Den **letzten** Abschluss kann der Admin mit Begründung wieder öffnen; dabei werden bereits übernommene Nachträge aus genau diesem Zeitraum **zurückgenommen** — sonst zählten dieselben Stunden doppelt, weil die Einträge des wieder offenen Monats erneut direkt mitrechnen. Mitarbeiter sehen den Stichtag und **ihre eigenen** abgerechneten Zahlen. Nicht abfangbar und deshalb bewusst offen: **Backup einspielen** und **Mitarbeiter endgültig löschen** — beide vermerken im Audit-Log, wenn abgerechnete Zeiträume betroffen sind. |
| **⚙️ Einstellungen** | **Arbeitszeiten** (Arbeitsbeginn, Arbeitszeit pro Tag, Pause pro Tag — Vorgabe 07:00 / 8 h / 30 min): dienen als **Vorbelegung** für die Planung (von/bis/Pause) und für den ersten Zeiteintrag eines Tages. Eine Vorschauzeile zeigt beim Tippen, was die drei Werte zusammen ergeben. **Erfasste Zeiten und Soll-Stunden bleiben davon unberührt.** White-Label-Branding (Logo + App-Icon; **max. Bild-Dateigröße admin-einstellbar, Default 5 MB**), **Impressum & Datenschutz** (konfigurierbare Rechtstexte, erscheinen als Links auf Login-Seite + Menü), Dokumenten-Speicherlimit (Gesamt + pro Datei), Datenbank-Backup/Restore. *(Chef/Admin; Größenlimits nur Admin)* |
| **📜 Audit-Log** | Revisionssicheres Protokoll: An-/Abmeldungen (Login erfolgreich/fehlgeschlagen, manuelle Abmeldung, Sitzungs-Timeout), Benutzeränderungen, Einstellungs-/Branding-Änderungen, Backups u. a. Benutzeranlage mit allen Parametern, Änderungen feldgenau als „alt → neu" (Passwörter nie). Mit Filter (Aktion/Zeitraum), seitenweisem Nachladen und CSV-Export fürs Archiv. *(Admin)* |
| **🗑️ Papierkorb** | Gelöschte Einträge und Abwesenheiten bleiben mit Begründung erhalten (GoBD). **Gelöschte Zeit­einträge** können wiederhergestellt werden – jeder sieht/stellt wieder her, was er selbst gelöscht hat; Chef/Admin alles. **Gelöschte Abwesenheiten** werden für Chef/Mitarbeiter/Buchhalter **nicht** wiederhergestellt (das brächte sie als bereits genehmigt zurück und könnte mit zwischenzeitlicher Planung kollidieren) – stattdessen „**Neu beantragen**": ein frischer Antrag mit den alten Daten, der wieder durch die Genehmigung läuft. Nur der **Admin** kann eine Abwesenheit echt **wiederherstellen** (Ausnahme für versehentliche Löschungen). Im Unterreiter **Mitarbeiter** liegen ausgestellte Mitarbeiter zum Wiedereinstellen (**Chef/Admin** – Mitarbeiter haben darauf keinen Zugriff); endgültiges Löschen (mit allen Daten) ist dort nur als Admin und nur für zuvor ausgestellte Mitarbeiter möglich. Im Unterreiter **Projekte** liegen gelöschte Aufträge (inkl. Zuweisungen/Zwischenziele); **Chef/Admin** können sie **wiederherstellen** oder **endgültig löschen** (mit Bestätigung). |

**Querschnitts-Features:** Echtzeit-Updates über alle Geräte (Server-Sent Events), **Push-Benachrichtigungen
aufs Handy auch bei geschlossener App** (Web Push, optional je Gerät aktivierbar), **Navigations-Button mit
freier Wahl der Karten-App/des -Dienstes** (Auswahl-Dialog statt fester Google-Bindung – Android zeigt die
Geräte-Auswahl der installierten Apps, iOS/Desktop eine kuratierte Liste; Wahl merkbar), rollenbasierte
Sichtbarkeit, mobil-optimiert/installierbar (PWA), Brute-Force-Schutz am Login, durchgehend
parametrisierte SQL-Abfragen und HTML-Escaping (XSS-Schutz).

### 📱 Für die Baustelle gedacht

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
Live-Verbindung (SSE), und die kappt ein Handy, sobald der Bildschirm ausgeht oder der Browser in den
Hintergrund rutscht. Alles, was in dieser Zeit passiert, käme nie an — der Zähler bliebe auf einem
Stand stehen, den es nicht mehr gibt. Deshalb wird der echte Stand **nach jedem Verbindungsaufbau**
und **bei jeder Rückkehr zum Tab** nachgeholt. Wichtig zu wissen, wenn man einem falschen Zähler
nachgeht: **Liste und Zähler holen ihre Daten getrennt** — eine leere Bestellliste neben einem Zähler
mit „1" ist deshalb kein Widerspruch, sondern genau dieses Symptom.

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

Automatisierte Tests liegen unter `tests/` (Berechnungs-/Logiktests sowie echte Browser-Klick-Tests
mit Puppeteer). Details in [`tests/README.md`](tests/README.md).

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

Jugendarbeitsschutz: `node tests/pause-jugendschutz-ui.js` — die drei Fälle nebeneinander (über 18,
16-jährig, **ohne** Geburtsdatum), der Übergang am 18. Geburtstag, das Alter am **Eintragsdatum**
statt am heutigen, und ein nachgetragenes Geburtsdatum. Beim Bau dieses Tests wurden fünf ältere
Pausen-Tests rot: Ihre Testnutzer hatten kein Geburtsdatum und wurden damit als Jugendliche
gerechnet. Sie tragen jetzt ausdrücklich ein Erwachsenen-Datum samt Begründung im Kommentar — sonst
hätten sie unbemerkt die falsche Tabelle geprüft.

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
