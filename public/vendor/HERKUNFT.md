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
