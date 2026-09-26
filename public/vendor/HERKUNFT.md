# Mitgelieferte Fremdbibliotheken

## zxing.min.js

* Paket: `@zxing/library` 0.23.0 (UMD-Bündel `umd/index.min.js`)
* Lizenz: Apache-2.0 — Wortlaut in `zxing-LICENSE.txt`
* Herkunft: `npm pack @zxing/library@0.23.0`

**Warum mitgeliefert statt nachgeladen:** Die Sicherheitsregel der App ist `script-src 'self'` —
Code von fremden Servern wird vom Browser abgewiesen. Das ist Absicht und bleibt so.

**Warum reines JavaScript statt WASM:** Ein WASM-Decoder wäre schneller, bräuchte aber
`wasm-unsafe-eval` in der Regel. Diese Lockerung ist der falsche Preis für ein paar Scans am Tag.

**Warum überhaupt ein Decoder:** Die eingebaute Schnittstelle `BarcodeDetector` gibt es nur in
Chrome/Android. Im Betrieb sind auch iPhones (Safari) und Firefox — dort gäbe es sonst keinen
Scanner. Wo `BarcodeDetector` vorhanden ist, wird sie bevorzugt; dieses Bündel ist der Rückfallweg.

Beim Aktualisieren: Version hier und in der Prüfseite nachziehen, danach auf einem echten iPhone
UND einem Android-Gerät gegenprüfen.

## kollab.min.js, kollab.css, kollab-LIZENZEN.txt

* Inhalt: das Schreibfeld für die gemeinsamen Notizen — `yjs` 13.6.33 (gemeinsames Dokument),
  `quill` 2.0.3 (Schreibfeld mit Fett/Kursiv/Unterstrichen, Listen, Checklisten), `y-quill` 1.0.0
  (Anbindung), `quill-cursors` 4.3.0 (farbige Cursor der anderen), `y-protocols` 1.0.7 (wer ist
  gerade drin) samt ihren Unterpaketen. Liste mit Version und Lizenztext: `kollab-LIZENZEN.txt`.
* Lizenzen: MIT, BSD-3-Clause, Apache-2.0 — `tests/kollab-buendel.js` lässt keine andere zu.
* Herkunft: **gebaut, nicht heruntergeladen.** Die Pakete stehen mit fester Version in
  `package.json`; `node scripts/kollab-buendeln.js` fasst sie mit esbuild zu einer klassischen
  Datei zusammen (`window.Kollab`), der Einstieg ist `scripts/kollab-eintrag.js`.
  `node scripts/kollab-buendeln.js --pruefen` vergleicht die eingecheckten Dateien mit einem
  frischen Bau.

**Warum ein Bündel:** Die Pakete sind ES-Module mit vielen Einzeldateien, die App hat keinen
Build-Schritt und lädt nur eigene Skripte (`script-src 'self'`). Zwei Stellen im Bündel enthalten
`new Function` — beides tote Pfade für uralte Browser (`ActiveXObject`, fehlendes `globalThis`),
die kein heutiger Browser erreicht; der Test prüft, dass beim Laden keine Verletzung der
Sicherheitsregel auftritt.

**Warum ohne Herunterübersetzen:** esbuild kann `lib0` (Teil von Yjs) nicht auf ältere Browser
zurückschreiben. Das Bündel bleibt beim Stand der Quellen.

Geladen wird es erst, wenn eine Notiz geöffnet wird (`notizEditorLaden()` in `app-8-comm-init.js`).

Beim Aktualisieren: Versionen in `package.json` fest setzen, `npm install`, neu bauen,
`node tests/kollab-buendel.js`, danach **auf einem echten Android-Handy tippen** (Wortvorschläge,
Checkliste, jemand anderes schreibt in derselben Zeile) — das kann kein Test-Browser nachstellen.
