# Tests

Jeder Test **startet sich seinen eigenen Server** auf einem eigenen Port und legt seine eigene
Datenbank unter `/tmp` an; danach räumt er beides wieder weg. Es muss also **nichts vorbereitet
werden** — ein einzelner Test läuft so:

```bash
node tests/pause-beispiele.js
```

Alles auf einmal (dauert etwa eine Dreiviertelstunde):

```bash
for t in tests/*.js; do
  printf '%-40s' "$(basename "$t")"
  timeout 700 node "$t" >/dev/null 2>&1 && echo OK || echo FEHLER
done
```

Zwei Ausnahmen von „nichts vorbereiten":

* **Browser-Tests** brauchen einmalig `chrome-headless-shell` (siehe ganz unten).
* **`*-prodklon.js`** arbeiten gegen eine **Kopie** der Produktivdaten unter `/tmp/prodklon.db`.
  Fehlt die Kopie, überspringen sie sich mit Hinweis statt zu scheitern. Holen mit:

  ```bash
  scp <server>:/pfad/arbeitsdoku/data/arbeitsdoku.db /tmp/prodklon.db
  ```

  Die Kopie liegt bewusst außerhalb des Projekts und wird von den Tests **nie beschrieben**; sie
  prüfen das am Ende sogar per SHA-256 nach.

> Die frühere Anleitung („Server auf :3000 mit `npm run clone-db` vorbereiten, alle Passwörter
> `test`") galt nur noch für eine Handvoll alter Tests und führte in die Irre — sie ist ersetzt.
> Die wenigen Tests, die eine besondere Vorbereitung brauchen, sagen es im Kopf der Datei.

## Vollständige Liste

<!-- TESTLISTE:START — erzeugt von scripts/generate-test-index.js, nicht von Hand ändern -->

**159 Tests.** Die Beschreibung ist jeweils die erste Kommentarzeile der Datei.

| Test | prüft |
|---|---|
| `abnahme-undeployed-ui.js` | ABNAHME-TEST über ALLE noch nicht deployten Änderungen (Bugliste v6, Runden 1–4). |
| `abschluss-audit-ui.js` | Das Protokoll des Abrechnungs-Abschlusses — im Browser gelesen und gefiltert. |
| `abschluss-ausstellen.js` | Ausstellen von Mitarbeitern unter dem Abrechnungs-Abschluss. |
| `abschluss-gleichheit.js` | DIE zentrale Probe zum Abrechnungs-Abschluss: Ändert das Abschließen eine angezeigte Zahl? |
| `abschluss-haerte.js` | Härtetest für den Abrechnungs-Abschluss: gezielt die Fälle, in denen die Mechanik brechen KANN. |
| `abschluss-nachtrag.js` | Nachträge in einem bereits abgerechneten Monat: kommen die Stunden am Ende beim Mitarbeiter an? |
| `abschluss-prodklon.js` | Abrechnungs-Abschluss gegen eine KOPIE der Produktivdaten. |
| `abschluss-statistik-monat-ui.js` | Der „abgerechnet"-Hinweis auf der Statistik gehört zum ANGEWÄHLTEN Zeitraum. |
| `abschluss-statistik-prodklon.js` | Der zeitraum-bezogene „abgerechnet"-Hinweis an ECHTEN Daten. |
| `abschluss-ui-knoepfe.js` | Jeder Knopf und jeder Dialog des Abrechnungs-Abschlusses — im echten Browser bedient. |
| `abschluss-ui.js` | Abrechnungs-Abschluss in der Oberfläche. |
| `abschluss.js` | Abrechnungs-Abschluss: Wächter, Abschluss-Ablauf und Admin-Ausweg. |
| `absence-conflict.js` | Test: Doppelbuchung innerhalb derselben Stufe wird verhindert, stufenübergreifend bleibt erlaubt. |
| `absence-overlap.js` | Regressionstest: prioritätsbewusste Abwesenheits-Zählung (gemeinsame Quelle für |
| `absence-reapply-ui.js` | UI-Smoke (Puppeteer): Abwesenheits-Papierkorb bietet „Neu beantragen" (kein „Wiederherstellen"), |
| `ansicht-erhalten-ui.js` | Puppeteer-Test (B10): Ansicht bleibt über Neuaufbauten hinweg erhalten. |
| `arbeitsbeginn-prodklon.js` | Abwaertskompatibilitaet des Arbeitsbeginns — der Aussperr-Fall. |
| `arbeitsbeginn-ui.js` | Arbeitsbeginn je Mitarbeiter + Zeit-Vorbelegung, die nie unmöglich ist. |
| `audit-events.js` | Audit-Events-Test: prüft, dass login_success, logout (manuell), session_expired (abgelaufenes |
| `aushang-sprung-ui.js` | Aushänge auf der Willkommensseite sind anklickbar (Alex, 07.08.2026). |
| `auth-active-guard.js` | API-Test (B1): Ein bereits ausgestelltes JWT wird sofort abgelehnt (401), sobald der Nutzer ausgestellt ist — |
| `backup-restore.js` | Backup-Round-Trip + dynamisches Restore-Limit: Backup herunterladen → wieder einspielen (200), |
| `badge-nachziehen-ui.js` | Der Coin zeigte eine offene Bestellung an, obwohl die Liste leer war (Alex, 29.07.2026, Handy). |
| `barrierefrei-prodklon.js` | Prod-Klon-Pruefung fuer B8b (Tastatur/Screenreader). |
| `barrierefrei-ui.js` | Puppeteer-Test (B8b): Bedienung per Tastatur und mit Screenreader. |
| `board-archive-ampel-ui.js` | Archiv/Reopen + Dringlichkeitsampel (Chef/Admin). MA hat weder Ampel noch Archiv-Zugriff. |
| `board-assign-all-ui.js` | Zuteilbarkeit: ALLE Nutzer außer Admin (Chef, Buchhalter, Mitarbeiter) sind im Projekt-Formular auswählbar |
| `board-live-buffer-ui.js` | Live-Test (3 Browser): ändert Client A einen Zielstatus, müssen Client B und C OHNE Reload |
| `board-live-ui.js` | Multi-Client-Live-Test (mehrere Puppeteer-Clients gleichzeitig): Chef legt/erledigt/öffnet einen Auftrag, |
| `board-mobile-ui.js` | Mobile-Ansicht des Boards (390×844): Spalten horizontal wischbar, vertikal scrollbar, Kachel/Detail, |
| `board-permissions-workflow.js` | Umfassender Rechte-/Workflow-Test (Puppeteer + API) rund um das Auftrags-Board: |
| `browser-absences.js` | Headless-Browser-Test (Puppeteer) für die Abwesenheits-Logik — echte UI-Klicks. |
| `browser-smoke.js` | Headless-Browser-Smoke-Test (Puppeteer) — klickt echte UI-Abläufe durch, rollenbasiert. |
| `bugliste-v6-api.js` | API-Test Bugliste v6: |
| `bugliste-v6-ui.js` | Puppeteer-Test Bugliste v6 (Frontend): |
| `bugliste-v6b-api.js` | Unit/API-Test Bugliste v6, Runde 2: |
| `bugliste-v6b-ui.js` | Test Bugliste v6, Runde 2 (API + UI): |
| `complex-saldo-versioning.js` | Komplexer Integrationstest: Berechnung (Soll/Ist/Ueber) + Versionierung (Papierkorb/History) |
| `deploy-vollstaendigkeit.js` | Probe: Überträgt deploy.sh WIRKLICH alles, was der Server zum Starten braucht? |
| `doc-limits.js` | Dokument-Limits-Test: kombinierter /limits-Endpunkt (Validierung + Pro-Datei≤Gesamt) und das |
| `double-submit-ui.js` | Puppeteer-Test: globaler Doppel-Submit-Schutz. |
| `entry-start-and-note-ui.js` | Puppeteer-Test: |
| `entwurf-prodklon.js` | Prod-Klon-Pruefung fuer B4 (Entwurfs-Sicherung). |
| `entwurf-sicherung-ui.js` | Puppeteer-Test (B4): Entwurfs-Sicherung fuer Formulare. |
| `form-hardening-ui.js` | Puppeteer-UI-Test (B3 + B4): |
| `geburtsdatum-feld-ui.js` | Das Geburtsdatums-FELD in Mitarbeiter → bearbeiten — über die echte Oberfläche bedient. |
| `geburtstag-eigener-ui.js` | Gratulation für das Geburtstagskind selbst (Alex, 08.08.2026). |
| `geburtstag-ui.js` | Geburtstags-Einblendung auf der Willkommensseite. |
| `geheimnis-krypto.js` | Verschlüsselung der TOTP-Geheimnisse und der Notfall-Schalter (geheimnis.js). |
| `hardening-b5b6.js` | API-Test (B5 + B6): |
| `hoechstarbeitszeit-ui.js` | Hinweis bei Überschreitung der gesetzlichen Höchstarbeitszeit. |
| `hoechstzeit-komplex-ui.js` | Die unangenehmen Fälle rund um Anwesenheit, Warnung und Pausenvorschlag. |
| `hoechstzeit-prodklon.js` | Die Höchstarbeitszeit-Warnung an ECHTEN Daten: warnt sie nur — oder verändert sie etwas? |
| `jugendschutz-uebergang-prodklon.js` | Der 18. Geburtstag am ECHTEN Datenstand: Kippt die Pausenregel am richtigen Tag? |
| `legal-pages-ui.js` | Puppeteer-UI-Test: Impressum/Datenschutz — Admin füllt in Einstellungen, Links auf Login-Seite (pre-login) |
| `legal-pages.js` | API-Test: Impressum/Datenschutz als admin/chef-konfigurierbare Settings + öffentlicher Endpunkt. |
| `limits-ui.js` | UI-Test (Puppeteer) der Admin-Karte „Speicher- & Größenlimits": |
| `listen-suche-prodklon.js` | Prod-Klon-Pruefung fuer B6 (Suche in den Listen). |
| `listen-suche-ui.js` | Puppeteer-Test (B6): Suchfeld in den Listen. |
| `live-dashboard-and-rights-ui.js` | Puppeteer-UI-Test: |
| `lohn-export-prodklon.js` | Lohn-Export gegen eine KOPIE der Produktivdaten — nur lesend. |
| `lohn-export-ui.js` | Puppeteer-Test (C1): Bedienung des Lohn-Exports. |
| `lohn-export.js` | Lohn-Export (C1): Zahlen und Dateiformat. |
| `longpress-details-ui.js` | Puppeteer-Test (B7): Details per langem Druck auf dem Handy. |
| `longpress-prodklon.js` | Prod-Klon-Pruefung fuer B7 (langer Druck zeigt Details). |
| `manager-rights-api.js` | API-Test (#9): Beim Anlegen/Bearbeiten werden die Einzelrecht-Flags (can_plan/can_plan_all/ |
| `manager-rights-normalize.js` | Unit-Test (#9): normalizeManagerRights() nullt die redundanten Einzelrecht-Flags von Chef/Admin |
| `menue-abrechnung-ui.js` | Der Menüpunkt hinter #/pdf heißt je nach Rolle anders. |
| `milestone-days-input.js` | Test: Zwischenziel-Dauer akzeptiert Komma UND Punkt (1,5 === 1.5), ungültige Werte werden abgefangen |
| `nav-chooser.js` | Navigations-Auswahl-Test (Puppeteer, headless). Prüft Plattform-Optionen, URL-Builder, Auswahl-Dialog, |
| `note-leave-ui.js` | UI-Test (Puppeteer): Empfänger sieht bei einer geteilten Notiz den „Freigabe verlassen"-Button und |
| `note-leave.js` | API-Test „Freigabe verlassen": Empfänger entfernt sich selbst aus einer geteilten Notiz; beim |
| `password-policy-ui.js` | UI-Test (Puppeteer): Passwort-Policy im Anlege-Formular — Live-Checkliste (✓/✗), Feld-Einfärbung (rot/grün), |
| `password-policy.js` | API-Test (B3): Passwort-Policy beim Anlegen + Zurücksetzen. |
| `passwort-selbst-aendern.js` | Jeder darf sein eigenes Passwort ändern (PUT /api/auth/password). |
| `pause-beispiele.js` | Beispiel-Tabelle zur Pausenlogik — gemessen an der echten Oberfläche, nicht ausgerechnet. |
| `pause-gesetz-ui.js` | Gesetzliche Mindestpause (§ 4 ArbZG) in der Vorbelegung. |
| `pause-jugendschutz-ui.js` | Zwei Alterstabellen: § 4 ArbZG ab 18, § 11 JArbSchG darunter. |
| `pause-parallel-ui.js` | Zwei ZEITGLEICHE Aufträge und der Pausenvorschlag (Alex, 30.07.2026). |
| `pdf-projektfilter.js` | Arbeitsnachweis-PDF mit Projektfilter: Soll, Differenz und die Ist-Spalte je Mitarbeiter müssen |
| `permission-refresh.js` | Rechte-Aktualisierung ohne Re-Login: Gibt/Entzieht ein Admin das Planungsrecht, muss sich das |
| `planner-absences.js` | Planer-Sichtbarkeit-Test: Mitarbeiter mit „alle"-Planungsrecht (can_plan_all) sehen im Planungskontext |
| `planning-audit.js` | Audit-Test: Planungsrecht wird semantisch als EINE Stufe protokolliert (keins / nur sich / alle), |
| `planning-recurrence.js` | Unit-Tests der Serien-Engine (rein, ohne Server/DB). Start: node tests/planning-recurrence.js |
| `planning-reminder-time-lineage-api.js` | API-Test: Benachrichtigungs-ZEIT über Takt-Sprünge hinweg. Serie → Takt ab 5 → Takt ab 9 → Zeit ab 7 |
| `planning-reminders-api.js` | API-Test: Planungs-Erinnerungen (pro-Vorkommen-Modell). CRUD, Rechte, Serien-Scope (nur dieser/ |
| `planning-reminders-scheduler.js` | In-Process-Test der Erinnerungs-Feuerlogik (scheduler.firePlanningReminders + Digest-Bündelung in tick). |
| `planning-reminders-ui.js` | UI-Test: Erinnerungs-Punkt im ⋮-Menü der Tagesansicht + Dialog. MA ohne Planungsrecht sieht nur |
| `planning-replan-default-ui.js` | UI-Test: „Auftrag erneut planen" hat heute als Standardtag und ist mit einem Klick speicherbar |
| `planning-retakt-lineage-api.js` | API-Test: Mehrfaches Umtakten in EINER Herkunft. Ab dem 7./9. → 3 Taktungen; dann ab dem 5. → 2; dann ab |
| `planning-retakt-ma-api.js` | API-Test: Mehrfaches Umtakten MIT wechselnder MA-Zuweisung je Serie + eine Einzel-MA-Ausnahme. |
| `planning-right-transitions.js` | Planungsrecht-Übergänge (dynamisch, ohne Re-Login) für einen Mitarbeiter „Alex": |
| `planning-series-editdays-ui.js` | UI-Test: In einer mehrtägigen Serie im Bearbeiten-Formular einen Tag löschen und „Diesen + alle |
| `planning-series-editdelete-ui.js` | UI-Test: Der „Planung löschen"-Button IM Bearbeiten-Formular zeigt bei Serienterminen denselben |
| `planning-series-form-ui.js` | UI-Test: Serie über das Formular anlegen — Wiederholungs-Auswahl, Live-Vorschau, Absenden. |
| `planning-series-recur-edit-ui.js` | UI-Test: Wiederholung IM Bearbeiten-Formular — normale Planung → Serie machen; Serie umtakten |
| `planning-series-scheduler.js` | In-Process-Test der rollierenden Serien-Verlängerung (scheduler.extendSeries). |
| `planning-series-stophere-ui.js` | UI-Test: „Ab hier keine Wiederholung mehr" im Bearbeiten-Formular + geführter Folgeschritt. |
| `planning-series-ui.js` | UI-Test: Serien-Marker (🔁) + Scope-Dialog beim Löschen (nur dieser / folgende / Serie / beenden). |
| `planning-series.js` | API-Test: Serientermine anlegen (Materialisierung, Vorkommen, Overlap-Flag, never-Horizont, Rechte). |
| `planung-sprung-ui.js` | Termine auf der Willkommensseite sind anklickbar (Alex, 07.08.2026) — wie zuvor die Aushänge. |
| `platznutzung-ui.js` | Scrollflächen nutzen den Platz, der wirklich da ist (Alex, 07.08.2026). |
| `project-csv.js` | API-Test CSV-Export der Projekt-Einträge: nach Datum sortiert, Netto (ohne Pause), Summe, Admin |
| `project-due-ui.js` | UI-Test „Fällig bis" + Frist-Marker: Countdown-Badge (farbcodiert), Goal-Marker im Balken (Position), |
| `project-due.js` | API-Test „Fällig bis": gültiges/ungültiges/leeres Datum, GET liefert es, PUT ohne Feld unverändert. |
| `project-milestones-ui.js` | UI-Test Zwischenziele + Fortschrittsbalken: Editor im Formular, gewichteter Balken, Status-Picker-Rechte |
| `project-milestones.js` | API-Test Zwischenziele: CRUD via POST/PUT (Merge erhält Status), Status-PATCH (Rechte), Löschen kaskadiert. |
| `project-stats-ui.js` | UI-Test Statistik-Reiter: Manager (Admin/Chef/Buchhalter) sehen „📊 Statistik" auf der Kachel und |
| `project-stats.js` | API-Test Auftrags-Statistik: Netto-Stunden je Bucher (alle außer Admin), Dropdown + Freitext, |
| `project-trash-ui.js` | UI-Test Projekt-Papierkorb: Chef löscht vom Board → Papierkorb→Projekte → Wiederherstellen bzw. |
| `project-trash.js` | API-Test Projekt-Papierkorb: Soft-Delete, /deleted (Chef/Admin), Restore (Ziele/Zuweisungen bleiben), |
| `project-workdays-ui.js` | UI-Test: Fälligkeit rechnet in ARBEITSTAGEN — Sa/So UND globale Feiertage zählen nicht. |
| `projects-board-ui.js` | UI-Test (Puppeteer) Auftrags-Board: FAB-Formular, Spalten je MA + „Nicht zugewiesen", Dringlichkeits- |
| `projects-board.js` | API-Test Auftrags-Board: projects mit Kunde/Notiz/Dringlichkeit/Zuweisung/Erledigt; Rollen-Gating; |
| `push-api.js` | Push-API-Test: startet einen echten Server (Kind-Prozess), meldet sich an und prueft |
| `push-summaries-ui.js` | UI-Test (Puppeteer) der Zusammenfassungs-Sektion: anlegen (+ mit Name), bearbeiten (Zeit ändern), |
| `push-summaries.js` | API-Test der geplanten Zusammenfassungen (Digest-Push): CRUD, Validierung, Ownership, Rollenfilter |
| `push-sw.js` | Service-Worker-Push-Test: lädt public/sw.js in einer Sandbox (kein Browser nötig) und prüft die |
| `push-targeting.js` | Push-Targeting-Test (in-process). Mockt web-push.sendNotification und prueft fuer jedes |
| `restpause-firmenwert-ui.js` | Was passiert mit der Restpause, wenn die Firmenpause MITTEN im Betrieb umgestellt wird? |
| `restpause-ui.js` | Restpausen-Vorbelegung (#13): Die Pause wird nur noch mit dem REST zur Firmenpause vorbelegt. |
| `robustheit-v6-ui.js` | Test der Robustheits-Runde (letzte offene Punkte der Bugliste v6): |
| `scenario-shared-planning.js` | Komplexer Szenario-Test gegen den PROD-KLON (data/local.db, anonymisiert → Passwort 'test'). |
| `scheduler-tick.js` | In-Process-Test des Zusammenfassungs-Schedulers: reine Funktionen isDue()/buildSummaryText() + |
| `scroll-ruckeln-prodklon.js` | Prod-Klon-Pruefung: Kein Zurueckspringen beim Scrollen — mit den ECHTEN Daten, |
| `scroll-ruckeln-ui.js` | Puppeteer-Test: Beim Scrollen darf die Seite NICHT zurückspringen. |
| `self-planning-ui.js` | UI-Smoke (Puppeteer) für das zweistufige Planungsrecht: |
| `self-planning.js` | Self-Planung-Test: Planungsrecht-Stufen „sich" (can_plan) vs. „alle" (can_plan_all). |
| `shot-notifications.js` | Einmal-Screenshot der Benachrichtigungen-Seite — ein Werkzeug, kein Test. |
| `sse-live-schutz-ui.js` | Zwei-BROWSER-Test (echtes SSE): Was passiert bei mir, wenn ein KOLLEGE in seinem eigenen Browser |
| `stunden-vorher-nachher.js` | BEWEIS: Die ausgewiesenen Stunden und Überstunden ändern sich durch die Zusammenlegung der |
| `targets-date-guard.js` | API-Test: Soll-Stunden-Routen validieren valid_from (Nachzug zu B4, gleiche Lösung wie beim Urlaubsanspruch). |
| `testliste-vollstaendigkeit.js` | Wächter über die Testliste in tests/README.md. |
| `token-haertung.js` | Sonder-Token dürfen keine Zugangs-Token sein — und was heute funktioniert, muss weiter gehen. |
| `tooltip-escape-ui.js` | Puppeteer-UI-Test (B2): Ein bösartiger Regie-Mitarbeitername darf im Eintrags-Tooltip NICHT als HTML landen. |
| `totp-rfc.js` | TOTP-Kern gegen die NORM prüfen, nicht gegen sich selbst (RFC 6238 / RFC 4226 / RFC 4648). |
| `touch-ux-ui.js` | Puppeteer-Test (UX-Runde 1: B3 + B2 + B8a) |
| `trash-access.js` | Papierkorb-Zugriff: „Chef voll, Mitarbeiter Eigenes". |
| `trash-matrix-ui.js` | KOMPLEXER Papierkorb-/Lösch-Matrix-Test (Puppeteer) — Abwesenheits- UND Eintrags-Logik über alle Rollen. |
| `trash-nav-ui.js` | UI-Smoke (Puppeteer): Papierkorb-Navigation je Rolle. |
| `twofa-anmeldung.js` | Der ganze Weg: Authenticator einrichten, damit anmelden, Gerät merken, Einrichtung erzwingen. |
| `twofa-konto-ui.js` | Die Oberfläche: Seite „Mein Konto", Code-Abfrage beim Anmelden, Einrichtungs-Zwang. |
| `twofa-regeln.js` | Die Regeln der Zwei-Faktor-Anmeldung: Wer muss wie oft einen Code eingeben? |
| `twofa-schema.js` | Die 2FA-Tabellen müssen auf JEDEM Altstand crashfrei nachwachsen — und zwar auf BEIDEN Wegen. |
| `uebernahme-zurueck-ui.js` | Puppeteer-Test: „Zurück" nach dem Übernehmen einer Planung führt dorthin zurück, wo das |
| `ueberschneidung-kette-ui.js` | Drei sich überschneidende Aufträge — Pausenvorschlag UND Arbeitszeit-Warnung, Schritt für Schritt. |
| `user-hours-gleichheit.js` | Gleichheitsbeweis fuer die Zusammenlegung der Stunden-Rechnung (C1). |
| `user-role-guard.js` | API-Test (B1): Rollen-Absicherung von POST/PUT /api/users. |
| `ux-runde1-prodklon.js` | Prod-Klon-Pruefung der UX-Runde 1 (B3 Zoom + B2 Tap-Ziele + B8a Kontrast). |
| `vacation-account.js` | Unit-Test: Urlaubskonto-Berechnung (entitlementFor + vacationAccount) gegen eine frische Temp-DB. |
| `vacation-api.js` | API-Test: Urlaubskonto-Endpunkte. Entitlement-CRUD (+Rechte), summary.vacation, vacation-overview |
| `vacation-audit-ui.js` | UI-Test (Puppeteer): Audit-Protokollierung des Urlaubsanspruchs. |
| `vacation-comma-ui.js` | UI-Test (Puppeteer): Urlaubstage/Start-Resturlaub akzeptieren Komma UND Punkt als Dezimaltrenner, |
| `vacation-employment-gap.js` | Unit-Test: Anstellungslücke (ausgestellt→wieder eingestellt). Ein volles Jahr in der Lücke bekommt 0 Anspruch, |
| `vacation-multi-ui.js` | UI-Test (Puppeteer): mehrere Mitarbeiter parallel mit unterschiedlichem Anspruch/Verfall über Jahre. |
| `vacation-multi.js` | Unit-Test: mehrere Mitarbeiter PARALLEL, jeder mit eigenem Anspruchsverlauf über mehrere Jahre und |
| `vacation-ui.js` | UI-Test (Puppeteer) Urlaubskonto: |
| `wetter-heute-ui.js` | Die Wetterkarte zeigte den heutigen Tag ZWEIMAL (Alex, 30.07.2026). |
| `willkommen-unveraendert-ui.js` | RÜCKSCHRITTS-PRÜFUNG der Willkommensseite (Alex, 07.08.2026). |

<!-- TESTLISTE:ENDE -->

## Einzelne Tests im Detail

## Integrationstest (API/Berechnung)

```bash
node tests/complex-saldo-versioning.js
```
Prüft Soll/Ist/Überstunden + Revisionssicherheit (Soft-Delete, History, Papierkorb) über
ein komplexes Szenario (krank → FZA → löschen → Urlaub) inkl. Überlappung, Feiertag, Restore.

## Abwesenheits-Überschneidung (Logik, kein Server nötig)

```bash
node tests/absence-overlap.js
```
Prüft die prioritätsbewusste Tageszählung (`routes/absence-days.js`), die `/api/absences/summary`
**und** die PDF gemeinsam nutzen: Krank verdrängt Urlaub/FZA an überschnittenen Tagen, Feiertag
verdrängt alles, Wochenenden zählen nie — inkl. „Urlaubstage genommen (Jahr)". Läuft gegen eine
frische Temp-DB.

## Abwesenheits-Doppelbuchung (Logik, kein Server nötig)

```bash
node tests/absence-conflict.js
```
Prüft `sameTierConflict` (`routes/absences.js`): Doppelbuchung innerhalb derselben Stufe wird
verhindert (Urlaub/FZA/Sonderurlaub untereinander, Berufsschule/Innung, Krank gegen Krank),
während stufenübergreifende Überschneidungen (Krank über Urlaub usw.) erlaubt bleiben.

## Abwesenheiten im Browser (echte UI-Klicks, Puppeteer)

```bash
node tests/browser-absences.js   # BASE per ENV setzbar (Default :3000)
```
Fährt das komplette Szenario durch: FZA buchen (Soll bleibt 8) → Urlaub am selben Tag =
Fehlermeldung → FZA löschen, Urlaub buchen + als Admin genehmigen (Soll 0, 1 Urlaubstag) →
Krank am selben Tag (verdrängt Urlaub) → Krank+Krank und Berufsschule+Innung = Fehler.

Braucht eine **frische DB**, in der `max` und `admin` das Passwort `test` haben und `max` 8h
Mo-Fr hinterlegt hat. Setup-Skript (Beispiel, gegen eigene Temp-DB):

```js
// setup.js — dann:  DB_PATH=/tmp/bro.db JWT_SECRET=<32+ Zeichen> node setup.js
process.env.DB_PATH = '/tmp/bro.db';
const bcrypt = require('bcryptjs');
const { initDatabase, getDb, saveToFile } = require('./database/init');
(async () => {
  await initDatabase(); const db = getDb();
  const h = bcrypt.hashSync('test', 10);
  db.prepare("UPDATE users SET password_hash=? WHERE username IN ('max','admin')").run(h);
  const id = db.prepare("SELECT id FROM users WHERE username='max'").get().id;
  db.prepare('DELETE FROM user_target_hours WHERE user_id=?').run(id);
  db.prepare(`INSERT INTO user_target_hours (user_id,hours_per_week,hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from)
    VALUES (?,40,8,8,8,8,8,'2020-01-01')`).run(id);
  saveToFile(); process.exit(0);
})();
```
Dann Server gegen diese DB starten und `BASE=http://localhost:<port> node tests/browser-absences.js`.

## Bedienung auf dem Handy: Zoom, Trefferflächen, Kontrast (Puppeteer)

```bash
node tests/touch-ux-ui.js          # frische Test-DB
node tests/ux-runde1-prodklon.js   # gegen eine KOPIE der Produktivdaten (nur lesend)
```

Beide Tests messen die **Wirklichkeit im Browser**, nicht die CSS-Angabe:

* **Trefferfläche** — der Test tastet mit `document.elementFromPoint()` rund um einen Knopf ab und
  ermittelt, wo ein Tipp den Knopf tatsächlich trifft. So fällt auch auf, wenn eine vergrößerte
  Fläche vom `overflow: hidden` des Eintrags beschnitten wird oder einen Nachbarknopf verschluckt.
* **Kontrast** — die gerenderten Farben werden ausgelesen, halbtransparente Hintergründe von unten
  nach oben überlagert (sonst misst man z. B. das Rollen-Abzeichen auf der farbigen Kopfleiste
  falsch) und daraus das WCAG-Verhältnis gerechnet. Gefordert sind 4,5:1 für graue Nebentexte.
* **Gegenprobe mit Maus** — mit `pointer: fine` darf sich nichts verändern; die Touch-Regeln greifen
  ausschließlich auf Touchgeräten.

Den Prod-Klon vorher holen (er liegt bewusst außerhalb des Projekts und wird nie beschrieben):

```bash
scp <server>:/pfad/arbeitsdoku/data/arbeitsdoku.db /tmp/prodklon.db
```

Fehlt die Kopie, überspringt sich `ux-runde1-prodklon.js` mit Hinweis statt zu scheitern.

## Browser-Smoke-Test (echte UI-Klicks, Puppeteer)

```bash
node tests/browser-smoke.js
```
Klickt durch: Login → Dokumente → Ordner anlegen → Datei hochladen → umbenennen → löschen.

**Chromium-Browser bereitstellen** (wird bewusst NICHT bei `npm install` geladen, siehe
`.puppeteerrc.cjs`). Einmalig `chrome-headless-shell` besorgen, z. B.:

```bash
# Variante A: ueber Puppeteer (braucht 'unzip' im PATH)
npx puppeteer browsers install chrome-headless-shell

# Variante B: manuell (falls unzip fehlt) — Zip laden + mit 7z/bsdtar entpacken
VER=149.0.7827.22
curl -sL -o /tmp/chs.zip "https://storage.googleapis.com/chrome-for-testing-public/$VER/linux64/chrome-headless-shell-linux64.zip"
DEST=~/.cache/puppeteer/chrome-headless-shell/linux-$VER
mkdir -p "$DEST" && 7z x /tmp/chs.zip -o"$DEST" -y
chmod +x "$DEST/chrome-headless-shell-linux64/chrome-headless-shell"
```

Der Test sucht die Binary unter dem Standard-Cache-Pfad oder via `CHROME_BIN`:

```bash
CHROME_BIN=/pfad/zu/chrome-headless-shell node tests/browser-smoke.js
```

> Hinweis: Puppeteer ist eine **devDependency** und kommt nie auf Prod (Deploy nutzt
> `npm install --omit=dev`).
