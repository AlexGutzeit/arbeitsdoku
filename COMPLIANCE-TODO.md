# Compliance-TODO — Rechtskonformität & Rollout

Offene Schritte, damit die App „offiziell" (Arbeitsrecht/GoBD/DSGVO) bei anderen Firmen
einsetzbar ist. Rollout-Modell: **Self-Hosting je Kunde** (jede Firma = eigener Verantwortlicher).

> ⚠️ **Keine Rechtsberatung.** Für eine offizielle Freigabe/Vermarktung verbindlich einbeziehen:
> Fachanwalt für Arbeitsrecht, Steuerberater (GoBD-Verfahrensdokumentation), ggf. Datenschutzbeauftragter.

---

## ✅ Stufe 1 — Revisionssicherheit (ERLEDIGT, deployed 2026-06-11)

- [x] Soft-Delete statt Hard-Delete (`deleted_at`/`deleted_by`), alle Lese-Queries gefiltert
- [x] Unveränderlicher Änderungsverlauf (`entry_history`, Snapshot + Wer/Wann/Warum)
- [x] Audit-Log (`audit_logs`): Login, Backup, Benutzerverwaltung
- [x] Begründungspflicht bei fremdem Eintrag (Admin), optional bei eigenem
- [x] Admin-Ansichten „Audit-Log" + „Gelöschte Einträge" (Papierkorb mit Wiederherstellen)
- [x] Zeitstempel in Europe/Berlin
- [x] Schließt Bug B20
- [x] **Abwesenheiten** ebenso revisionssicher (Soft-Delete + Verlauf + Papierkorb), da
  sie den Soll-/Überstundensaldo beeinflussen. Scope: saldorelevante Änderungen (Löschen +
  Datum/Edit); Status-Übergänge (genehmigen/ablehnen) nicht versioniert.

---

## ⬜ Stufe 2 — DSGVO-Betroffenenrechte & Aufbewahrung

- [ ] **Pro-Mitarbeiter-Datenexport (CSV/JSON)** — Art. 20 DSGVO. Neuer Endpoint, nutzt die
  bestehende Filter-Logik aus `routes/entries.js` GET wieder. (Auskunft Art. 15 ist aktuell
  über den PDF-Export manuell erfüllbar — der saubere Export ist Komfort, nicht „Tag 1"-Pflicht.)
- [ ] **Lösch-/Aufbewahrungskonzept technisch abbilden:** Feld „Mitarbeiter ausgeschieden am",
  automatische Anonymisierung erst **nach** Ablauf der GoBD-Frist (Job analog `cleanupToolHistory`
  in `server.js`). Balanciert DSGVO-Löschpflicht vs. GoBD-Aufbewahrung (2/6/10 Jahre).
- [ ] **Datenschutzhinweise in der App** (Login-Footer oder Settings-Link).

## ⬜ Stufe 3 — Dokumentation & Server-Härtung (wenig/kein Code)

- [ ] **Verfahrensdokumentation (GoBD)** — *Pflicht*, aber ein Dokument. Vorlage erstellen,
  vom Steuerberater abnehmen lassen. (Beschreibt: System, Rollen, Datenfluss, Backup, Aufbewahrung.)
- [ ] **TOM-Beschreibung** (technisch-organisatorische Maßnahmen, Art. 32 DSGVO) — 1-Seiten-Vorlage
  für Kunden: Rollen, bcrypt, TLS, Rate-Limit, Audit-Log, Backup, Verschlüsselung.
- [ ] **LUKS-Festplattenverschlüsselung** des Mini-PC / Kundenservers (Verschlüsselung at-rest) +
  im README dokumentieren. Reine Server-Einrichtung, kein App-Code.
- [ ] **Betreiber-Leitfaden** (README erweitern): Aufbewahrungsfristen, Backup-Routine, Rollen.
- [ ] **AVV-Vorlage** — nur falls später doch Fernwartung mit Zugriff auf Kunden-Live-Daten
  angeboten wird (bei reinem Self-Hosting nicht nötig).

---

## Rechtlicher Rahmen (Kurzreferenz)

| Bereich | Kernpflicht |
|---|---|
| **ArbZG/BAG** | Arbeitszeit (Beginn/Ende/Dauer) erfassen; seit BAG 13.09.2022 Pflicht; elektronisch ab ArbZG-Novelle 2026; manipulations-/revisionssicher; Bußgeld bis 30.000 € |
| **GoBD** | Unveränderbarkeit + protokollierte Korrekturen; Aufbewahrung 2/6/10 Jahre; Verfahrensdokumentation |
| **DSGVO** | TLS, Zugriffskontrolle, Protokollierung, Lösch-/Aufbewahrungskonzept, Auskunft/Export; Self-Hosting → kein AVV |
| **MiLoG** | Aufzeichnung v. a. Bau/Gastro/Logistik/Gebäudereinigung (Handwerks-/Bau-Kunden relevant) |

_Detail-Plan mit Datei-/Zeilenhinweisen: `~/.claude/plans/sleepy-munching-backus.md`._
