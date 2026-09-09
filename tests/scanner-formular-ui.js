// Der Scanner im Bestellformular — mit GESTELLTEM Decoder.
//
// Eine echte Kamera lässt sich hier nicht nachstellen, ein Barcode auch nicht. Was sich prüfen
// lässt, ist alles, was DANACH passiert — und genau dort sitzen die Entscheidungen:
//   * bekannter Code  → Produkt eingesetzt, Einheit und Kategorie vorbelegt
//   * unbekannter Code → Maske, mit Live-Abgleich gegen bestehende Namen
//   * ein ähnlicher Name → Barcode ans BESTEHENDE Produkt anlernen statt ein Doppel anzulegen
//   * Code eines gelöschten Produkts → die App FRAGT, statt still zu entscheiden
//
// `scannerOeffnen` wird dafür ersetzt. Das ist ehrlich: Die Kamera selbst wurde auf echten
// Geräten geprüft (public/scanner-probe.html); hier geht es um die Logik dahinter.
//
//   node tests/scanner-formular-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3307, DB = '/tmp/scanner-formular-ui.db', LOG = '/tmp/scanner-formular-ui.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const tok = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body.token;

    const kat = (await req('POST', '/api/products/kategorien', tok, { name: 'Befestigung' })).body.kategorie;
    const bekannt = (await req('POST', '/api/products', tok, {
      name: 'Kabelbinder 200 mm', barcode: '4050821808435', category_id: kat.id, default_unit: 'Beutel' })).body.produkt;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1100, height: 900 });
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'max'); await seite.type('#login-pass', pw('max'));
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForSelector('a[href="#/statistics"]'); await sleep(900);

    // Den Scanner ersetzen: liefert den Code, den wir vorgeben.
    const scanVorgeben = (code) => seite.evaluate((c) => { window.scannerOeffnen = async () => c; }, code);

    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#order-add-btn'); await sleep(800);

    console.log('── Die Wahl unter mehreren gelesenen Codes ──');
    // Im Lager gemessen: Auf einem Karton lagen 043899923098 (UPC-A, 3x) und 4003899923098
    // (EAN-13, 12x) — 239 ms auseinander, beide mit gueltiger Pruefziffer. Wer den ERSTEN nimmt,
    // der die Schwelle erreicht, bekommt den schwaecheren.
    const wahl = await seite.evaluate(() => {
      const e = (code, n) => [code, { n, format: 'EAN_13' }];
      const q = (code, n) => [code, { n, format: 'QR_CODE' }];
      const f = (paare) => scannerBesterTreffer(new Map(paare));
      return {
        lagerfall: f([e('043899923098', 3), e('4003899923098', 12)]),
        knappDarunter: f([e('A', 2), e('B', 5)]),
        keinerReicht: f([e('A', 1), e('B', 2)]),
        einziger: f([e('A', 7)]),
        // Valentins Fall: echte Hersteller-QRs, einmal bzw. zweimal gelesen.
        qrEinmal: f([q('https://id.abb/2CKA006800A3087', 1)]),
        qrZweimal: f([q('https://qr.fischer.id/p/568010', 2)]),
        // Ein 2D-Code schlaegt einen 1D-Code, SOLANGE der 1D-Code keine gueltige GTIN ist.
        // („A" ist keine.) Fuer den umgekehrten Fall siehe „Rangfolge" weiter unten.
        qrGegenAndere: f([['HAUSNUMMER-7', { n: 10, format: 'CODE_39' }], q('https://id.abb/2CKA006800A3087', 1)]),
        // GESTAPELTE ETIKETTEN (Alex, 09.09.2026: „teilweise 3 Barcodes direkt uebereinander").
        // Aus seinem Crafter-Lauf, 225 ms auseinander und mit GLEICHER Trefferzahl: eine interne
        // Nummer und die Artikelnummer. Ohne Vorzug entschiede der Zufall — und eine Charge- oder
        // Hausnummer im Katalog waere pro Packung verschieden.
        gestapelt: f([['2003145', { n: 5, format: 'CODE_39' }], ['4251786213047', { n: 5, format: 'CODE_39' }]]),
        // INNERHALB der Artikelnummern entscheidet die Trefferzahl — und genau das faengt die
        // Fehllesungen ab. Der echte Fall aus dem Crafter-Lauf: die Fehllesung 8050124027874 (5x)
        // trat GEMEINSAM mit der richtigen 4050821027874 (12x) auf.
        //
        // Frueher stand hier die Erwartung, ein oft gelesener Nicht-GTIN-Code muesse eine schwach
        // gelesene GTIN schlagen. Das war ein konstruierter Fall: Ein Decoder meldet „ean_13" nur
        // bei GUELTIGER Pruefziffer, eine solche Fehllesung setzt also eine echte EAN auf
        // derselben Etikette voraus — und die wird zuverlaessig oefter gelesen. In Alex' Daten
        // gilt das ausnahmslos fuer alle acht Fehllesungen mit gueltiger Pruefziffer.
        zweiArtikelnummern: f([['8050124027874', { n: 5, format: 'EAN_13' }], ['4050821027874', { n: 12, format: 'EAN_13' }]]),
      };
    });
    ok('der öfter gelesene 1D-Code gewinnt', wahl.lagerfall === '4003899923098', JSON.stringify(wahl));
    ok('… wer die Schwelle verfehlt, zählt nicht', wahl.knappDarunter === 'B', JSON.stringify(wahl));
    ok('… reicht keiner, gibt es keinen Treffer', wahl.keinerReicht === null, JSON.stringify(wahl));
    ok('… ein einziger reicht auch', wahl.einziger === 'A', JSON.stringify(wahl));
    ok('ein QR gilt schon nach EINER Lesung (Fehlerkorrektur)',
      wahl.qrEinmal === 'https://id.abb/2CKA006800A3087', JSON.stringify(wahl.qrEinmal));
    ok('… auch der zweite echte Hersteller-QR', wahl.qrZweimal === 'https://qr.fischer.id/p/568010', JSON.stringify(wahl.qrZweimal));
    ok('… und ein QR schlägt eine Haus-/Bestellnummer daneben',
      wahl.qrGegenAndere === 'https://id.abb/2CKA006800A3087', JSON.stringify(wahl.qrGegenAndere));

    console.log('\n── Plausibilität: was gar nicht erst gezählt wird ──');
    // Im Buecherregal las der Pruefstand ZWOELF achtstellige ITF-Codes, neun davon mit „00"
    // beginnend — auf Gegenstaenden, die garantiert kein ITF tragen. Neun davon wurden 9- bis
    // 16-mal gelesen: Gegen eine STABILE Fehllesung hilft Wiederholung nicht.
    const plaus = await seite.evaluate(() => ({
      itfAcht:      scannerPlausibel('00041285', 'itf'),
      itfVierzehn:  scannerPlausibel('00012345678905', 'itf'),
      ean13:        scannerPlausibel('4011395319475', 'EAN_13'),
      ean13Kurz:    scannerPlausibel('401139531947', 'EAN_13'),
      ean8:         scannerPlausibel('23198982', 'EAN_8'),
      upcA:         scannerPlausibel('043899923098', 'upc_a'),
      code39Kurz:   scannerPlausibel('S', 'CODE_39'),
      // „K" als Data-Matrix, 19x gelesen (Alex, 08.09.2026). Besonders heikel: 2D gilt schon nach
      // EINER Lesung, die Laengenpruefung ist dort der einzige Riegel.
      matrixEinBuchstabe: scannerPlausibel('K', 'data_matrix'),
      matrixEchterInhalt: scannerPlausibel('0004036034', 'data_matrix'),
      code128:      scannerPlausibel('A2026052700123', 'code_128'),
      qr:           scannerPlausibel('https://id.abb/2CKA006800A3087', 'QR_CODE'),
    }));
    ok('achtstelliges ITF wird gar nicht erst gezählt', plaus.itfAcht === false, JSON.stringify(plaus));
    ok('… ITF-14 dagegen schon (Karton-Standard)', plaus.itfVierzehn === true, JSON.stringify(plaus));
    ok('… ein einzelner Buchstabe als Code-39 auch nicht', plaus.code39Kurz === false, JSON.stringify(plaus));
    ok('… und „K" als Data-Matrix erst recht nicht (2D gilt schon nach EINER Lesung)',
      plaus.matrixEinBuchstabe === false, JSON.stringify(plaus));
    ok('… ein echter Data-Matrix-Inhalt bleibt', plaus.matrixEchterInhalt === true, JSON.stringify(plaus));
    ok('… ein zu kurzes EAN-13 ebenfalls nicht', plaus.ean13Kurz === false, JSON.stringify(plaus));
    ok('echte Codes bleiben unangetastet',
      plaus.ean13 && plaus.ean8 && plaus.upcA && plaus.code128 && plaus.qr, JSON.stringify(plaus));

    console.log('\n── GS1: die Artikelnummer aus dem Code lösen ──');
    // Auf einer Packung im Feld: 010979857524203121SA3AUXMS78F7POQ4CZ7Z
    // 01 = GTIN (14 Stellen), 21 = Seriennummer — und die ist PRO STUECK verschieden. Wer die
    // Rohzeichenkette speichert, legt fuer jede Packung ein neues Produkt an.
    const gs1 = await seite.evaluate(() => ({
      ausFeld:    scannerCodeNormalisieren('010979857524203121SA3AUXMS78F7POQ4CZ7Z'),
      mitKennung: scannerCodeNormalisieren(']d2010979857524203121SA3AUXMS78F7POQ4CZ7Z'),
      // Realistischer Fall: Das Kennzeichen 01 hat FESTE Laenge 14, dahinter steht nie ein
      // Trenner. Der folgt einem Kennzeichen mit VARIABLER Laenge — hier 10 (Charge).
      // Mein erster Testfall hatte nur 13 GTIN-Ziffern und war schlicht kein gueltiger GS1-Code.
      mitTrenner: scannerCodeNormalisieren('010979857524203110CHARGE7\x1d21SERIAL9'),
      ohneGs1:    scannerCodeNormalisieren('A2026052700123'),
      schlichteEan: scannerCodeNormalisieren('4011395319475'),
      andererMatrix: scannerCodeNormalisieren('0004036034'),
      // GS1 Digital Link: die Artikelnummer steckt in einer Internetadresse.
      // Im Feld: der QR und der Strichcode DERSELBEN Packung.
      edekaQr:    scannerCodeNormalisieren('https://herkunft.edeka.de/?01=04311501706954'),
      digiPfad:   scannerCodeNormalisieren('https://id.gs1.org/01/04311501706954'),
      digiMehr:   scannerCodeNormalisieren('https://example.de/x?lang=de&01=04311501706954&y=1'),
      schlichterQr: scannerCodeNormalisieren('https://burti.de'),
      qrOhneGtin: scannerCodeNormalisieren('https://qrfy.io/Jew6mKzNNF'),
    }));
    ok('aus dem Feld-Code wird die Artikelnummer 9798575242031',
      gs1.ausFeld.code === '9798575242031', JSON.stringify(gs1.ausFeld));
    ok('… das ist genau der EAN-13 von derselben Packung', gs1.ausFeld.artikelnummer === '9798575242031');
    ok('… auch mit vorangestellter Symbolkennung', gs1.mitKennung.code === '9798575242031', JSON.stringify(gs1.mitKennung));
    ok('… und mit Gruppentrenner im Code', gs1.mitTrenner.code === '9798575242031', JSON.stringify(gs1.mitTrenner));
    ok('ein Lageretikett bleibt unangetastet', gs1.ohneGs1.code === 'A2026052700123' && gs1.ohneGs1.artikelnummer === null, JSON.stringify(gs1.ohneGs1));
    ok('… ein schlichter EAN-13 ebenso', gs1.schlichteEan.code === '4011395319475', JSON.stringify(gs1.schlichteEan));
    ok('… und ein Data-Matrix ohne GS1-Aufbau auch', gs1.andererMatrix.code === '0004036034', JSON.stringify(gs1.andererMatrix));
    ok('aus dem EDEKA-QR wird derselbe Code wie vom Strichcode',
      gs1.edekaQr.code === '4311501706954', JSON.stringify(gs1.edekaQr));
    ok('… auch in der Pfad-Schreibweise', gs1.digiPfad.code === '4311501706954', JSON.stringify(gs1.digiPfad));
    ok('… und zwischen anderen Abfrage-Werten', gs1.digiMehr.code === '4311501706954', JSON.stringify(gs1.digiMehr));
    ok('ein QR ohne Artikelnummer bleibt, wie er ist',
      gs1.schlichterQr.code === 'https://burti.de' && gs1.qrOhneGtin.code === 'https://qrfy.io/Jew6mKzNNF',
      JSON.stringify([gs1.schlichterQr.code, gs1.qrOhneGtin.code]));

    ok('bei gestapelten Codes gewinnt die Artikelnummer, nicht die interne Nummer',
      wahl.gestapelt === '4251786213047', JSON.stringify(wahl.gestapelt));
    ok('… und unter zwei Artikelnummern gewinnt die öfter gelesene (so fallen Fehllesungen raus)',
      wahl.zweiArtikelnummern === '4050821027874', JSON.stringify(wahl.zweiArtikelnummern));

    console.log('\n── Rangfolge: Artikelnummer vor allem anderen (Lager 09.09.2026, 10:54) ──');
    // Der Lauf mit eingeschraenktem Sichtfeld lieferte den entscheidenden Fall: Auf DERSELBEN
    // Etikette standen die EAN (49x gelesen) und ein Haendler-QR (21x). Mit dem alten festen
    // 2D-Bonus gewann die Haendler-Adresse — die bezeichnet den Artikel zwar auch, aber die GTIN
    // ist die Nummer, die JEDER kennt. Das kehrt eine fruehere Entscheidung um: „2D schlaegt 1D
    // immer" war damit begruendet, dass eine EAN ZUFAELLIG daneben im Bild liegen koenne. Mit dem
    // Zielrahmen liegt nichts mehr zufaellig daneben.
    const rang2 = await seite.evaluate(() => {
      const c = (code, n, format) => [code, { n, format }];
      const f = (paare) => scannerBesterTreffer(new Map(paare));
      return {
        eltropa:   f([c('4003899947209', 49, 'ean_13'), c('https://www.eltropa.de/produkt/2811369', 21, 'qr_code')]),
        qrAllein:  f([c('https://qr.fischer.id/p/551442', 16, 'qr_code')]),
        qrGegenSchwache: f([c('wmqr.eu/1422030000', 11, 'qr_code'), c('10501184', 1, 'upc_e')]),
        viervier:  f([c('4311', 30, 'qr_code'), c('4050118225723', 15, 'ean_13')]),
        werbungAllein: f([c('https://www.digitus.info/', 11, 'qr_code')]),
        // Die Etikette aus Alex' Foto (09.09.2026): ein QR „4311" (57x) und ein Data-Matrix
        // „801036963840" (11x). Das Foto loeste es auf — es ist ein LIEFERSCHEIN-Etikett des
        // Grosshaendlers: „Etiketten ID 801036963840" steht im Klartext darunter, daneben TOUR
        // und BOX. Die Artikelnummern stehen nur als TEXT darauf.
        //
        // Also ist KEINER von beiden eine Artikelnummer, und die App kann hier nichts Richtiges
        // waehlen — sie nimmt den oefter gelesenen und WARNT in der Anlege-Maske. Das ist der
        // ehrliche Zustand; alles andere waere vorgetaeuschte Sicherheit.
        beideKeineArtikelnummer: f([c('4311', 57, 'qr_code'), c('801036963840', 11, 'data_matrix')]),
        kurzzahlAllein:  f([c('4311', 57, 'qr_code')]),
        // Aus fuenf Feldlaeufen ausgezaehlt: `4311` kam in VIER davon vor, 121x insgesamt, neben
        // wechselnden Nachbarn — klebt also auf vielen Etiketten. Unter allen 64 gemessenen Codes
        // ist er der einzige mit hoechstens fuenf Ziffern; die naechstkuerzeren echten Nummern
        // haben sieben (2003145, 2004922) und bleiben waehlbar.
        kurzzahlAbgewiesen: scannerNichtUebernehmen('4311'),
        siebenStellig1:     scannerNichtUebernehmen('2003145'),
        siebenStellig2:     scannerNichtUebernehmen('2004922'),
        etikettIdNichtAbgewiesen: scannerNichtUebernehmen('801036963840'),
        // Gegen einen ECHTEN Artikelcode verlieren dagegen beide.
        kurzzahlGegenEchten: f([c('4311', 57, 'qr_code'), c('https://qr.fischer.id/p/551442', 5, 'qr_code')]),
        // Die Etiketten-ID aus dem Foto gegen einen echten Hersteller-QR mit VIEL weniger
        // Lesungen: Ein Data-Matrix ist zwar verlaesslich GELESEN, sein INHALT ist deshalb noch
        // keine Artikelnummer.
        etikettIdGegenQr: f([c('801036963840', 20, 'data_matrix'), c('https://qr.fischer.id/p/551442', 5, 'qr_code')]),
      };
    });
    ok('die EAN schlägt den Händler-QR auf derselben Etikette',
      rang2.eltropa === '4003899947209', JSON.stringify(rang2.eltropa));
    ok('… ein QR allein gewinnt weiterhin (Valentins Fall)',
      rang2.qrAllein === 'https://qr.fischer.id/p/551442', JSON.stringify(rang2.qrAllein));
    ok('… gegen einen einmal gelesenen Strichcode ebenso (der erreicht die Schwelle nicht)',
      rang2.qrGegenSchwache === 'wmqr.eu/1422030000', JSON.stringify(rang2.qrGegenSchwache));
    // Der Fall, der die ganze Einschraenkung ausgeloest hat.
    ok('… und „4311" verliert gegen eine Artikelnummer, trotz doppelt so vieler Lesungen',
      rang2.viervier === '4050118225723', JSON.stringify(rang2.viervier));
    ok('ein Werbecode wird allein trotzdem zurückgegeben (um ihn zu erklären)',
      rang2.werbungAllein === 'https://www.digitus.info/', JSON.stringify(rang2.werbungAllein));
    ok('auf dem Lieferschein-Etikett bleibt nur die Etiketten-ID übrig (die Tournummer wird abgewiesen)',
      rang2.beideKeineArtikelnummer === '801036963840', JSON.stringify(rang2.beideKeineArtikelnummer));
    ok('„4311" wird abgewiesen — er klebt auf vielen Etiketten',
      rang2.kurzzahlAbgewiesen === 'kurzzahl', JSON.stringify(rang2.kurzzahlAbgewiesen));
    ok('… siebenstellige Händlernummern dagegen NICHT (die können ein Produkt bezeichnen)',
      rang2.siebenStellig1 === null && rang2.siebenStellig2 === null,
      JSON.stringify([rang2.siebenStellig1, rang2.siebenStellig2]));
    ok('… und eine Etiketten-ID wird nur zurückgestuft, nicht abgewiesen',
      rang2.etikettIdNichtAbgewiesen === null, JSON.stringify(rang2.etikettIdNichtAbgewiesen));
    ok('… gegen einen echten Artikelcode verliert er ohnehin, trotz elffacher Lesungen',
      rang2.kurzzahlGegenEchten === 'https://qr.fischer.id/p/551442', JSON.stringify(rang2.kurzzahlGegenEchten));
    ok('… allein gelesen wird sie trotzdem zurückgegeben (um sie zu erklären)',
      rang2.kurzzahlAllein === '4311', JSON.stringify(rang2.kurzzahlAllein));
    ok('eine Etiketten-ID verliert gegen einen Hersteller-QR, trotz vierfacher Lesungen',
      rang2.etikettIdGegenQr === 'https://qr.fischer.id/p/551442', JSON.stringify(rang2.etikettIdGegenQr));

    console.log('\n── Rundgang vom 09.09.2026: zusammengesetzte Codes und Werbe-QR ──');
    // Zwei Funde aus einem Lager-Rundgang. Beide hätten still Doppel-Einträge erzeugt.
    const rund = await seite.evaluate(() => ({
      // Auf DERSELBEN Packung: Data-Matrix mit Artikelnummer, Charge und Menge — und daneben der
      // schlichte EAN-13/Code-128. Ungelöst wären das zwei Einträge für denselben Artikel.
      matrixA: scannerCodeNormalisieren('4043377228871,22SL22118P0205002,100'),
      eanA:    scannerCodeNormalisieren('4043377228871'),
      matrixB: scannerCodeNormalisieren('4043377079275,21010589,50'),
      eanB:    scannerCodeNormalisieren('4043377079275'),
      // Ein Lageretikett mit Komma darf NICHT zerlegt werden — das erste Feld ist keine GTIN.
      etikett: scannerCodeNormalisieren('A2026052700123,charge7'),
      // 13 Ziffern, aber falsche Prüfziffer: also keine GTIN, also unangetastet.
      falschePruef: scannerCodeNormalisieren('1234567890123,x'),
      werbung: scannerIstWerbecode('https://bauer-solar.de/solarmodule/'),
      // Charge mit Verfallsdatum, im Lager gemessen: *202511182 06/17/26 (Data-Matrix, 18x).
      // Bewusst ENG: nur DREI durch Schraegstrich getrennte Zahlengruppen. Alex war sich nicht
      // sicher, ob Artikelnummern je einen Schraegstrich tragen — „bezweifeln" ist nicht
      // „ausschliessen", also faellt nicht jeder Schraegstrich darunter.
      charge:       scannerNichtUebernehmen('*202511182 06/17/26'),
      chargeKurz:   scannerNichtUebernehmen('1/1/26'),
      bindestrich:  scannerNichtUebernehmen('AEH-25-100'),
      einSchraegstrich: scannerNichtUebernehmen('LOT/2026'),
      jahrMitStrich:    scannerNichtUebernehmen('4051/22'),
      echteEan:     scannerNichtUebernehmen('4003899947209'),
      werbungGrund: scannerNichtUebernehmen('https://www.digitus.info/'),
      // Reine Zahl ohne gueltige Pruefziffer — Etiketten-, Tour- oder Hausnummer.
      etikettId:    scannerIstNummerOhnePruefziffer('801036963840'),
      tourNummer:   scannerIstNummerOhnePruefziffer('4311'),
      echteGtin:    scannerIstNummerOhnePruefziffer('4003899947209'),
      mitBuchstabe: scannerIstNummerOhnePruefziffer('S78037524'),
      adresse:      scannerIstNummerOhnePruefziffer('wmqr.eu/1422030000'),
      digital: scannerIstWerbecode(scannerCodeNormalisieren('https://herkunft.edeka.de/?01=04311501706954').code),
      // ROH, ohne vorherige Normalisierung: Die Antwort darf nicht davon abhaengen, in welcher
      // Reihenfolge die beiden Funktionen aufgerufen werden.
      digitalRoh: scannerIstWerbecode('https://herkunft.edeka.de/?01=04311501706954'),
      // Valentins Hersteller-QRs bezeichnen ARTIKEL — die duerfen nicht als Werbung gelten.
      abb: scannerIstWerbecode('https://id.abb/2CKA006800A3087'),
      fischer: scannerIstWerbecode('https://qr.fischer.id/p/568010'),
      merkblatt: scannerIstWerbecode('https://www.latrivenetacavi.com/download/environment_label.pdf'),
      echterCode: scannerIstWerbecode('4043377228871'),
    }));
    ok('aus dem Data-Matrix wird die reine Artikelnummer',
      rund.matrixA.code === '4043377228871', JSON.stringify(rund.matrixA));
    ok('… genau die, die daneben als Strichcode klebt', rund.matrixA.code === rund.eanA.code);
    ok('… ebenso beim zweiten Fund', rund.matrixB.code === '4043377079275' && rund.matrixB.code === rund.eanB.code,
      JSON.stringify([rund.matrixB.code, rund.eanB.code]));
    ok('ein Lageretikett mit Komma bleibt unangetastet',
      rund.etikett.code === 'A2026052700123,charge7', JSON.stringify(rund.etikett));
    ok('… und dreizehn Ziffern mit falscher Prüfziffer auch',
      rund.falschePruef.code === '1234567890123,x', JSON.stringify(rund.falschePruef));
    ok('eine Hersteller-Adresse gilt als Werbecode', rund.werbung === true);
    ok('eine Charge mit Verfallsdatum wird nicht übernommen', rund.charge === 'charge', JSON.stringify(rund.charge));
    ok('… auch in kurzer Schreibweise', rund.chargeKurz === 'charge', JSON.stringify(rund.chargeKurz));
    ok('… ein Bindestrich in der Artikelnummer bleibt unberührt', rund.bindestrich === null, JSON.stringify(rund.bindestrich));
    ok('… EIN Schrägstrich reicht nicht als Merkmal', rund.einSchraegstrich === null && rund.jahrMitStrich === null,
      JSON.stringify([rund.einSchraegstrich, rund.jahrMitStrich]));
    ok('… und eine EAN erst recht nicht', rund.echteEan === null, JSON.stringify(rund.echteEan));
    ok('… der Werbecode nennt seinen eigenen Grund', rund.werbungGrund === 'werbung', JSON.stringify(rund.werbungGrund));
    ok('eine Etiketten-ID gilt als Zahl ohne Prüfziffer', rund.etikettId === true, JSON.stringify(rund.etikettId));
    ok('… „4311" ebenso', rund.tourNummer === true, JSON.stringify(rund.tourNummer));
    ok('… eine echte EAN dagegen nicht', rund.echteGtin === false, JSON.stringify(rund.echteGtin));
    ok('… und alles mit Buchstaben bleibt unberührt (dort ist keine Prüfziffer zu erwarten)',
      rund.mitBuchstabe === false && rund.adresse === false, JSON.stringify([rund.mitBuchstabe, rund.adresse]));
    ok('… ein GS1 Digital Link dagegen NICHT (daraus wird die Artikelnummer)', rund.digital === false);
    ok('… auch roh, vor der Normalisierung', rund.digitalRoh === false);
    ok('… und Valentins Hersteller-QRs erst recht nicht (die BEZEICHNEN Artikel)',
      rund.abb === false && rund.fischer === false, JSON.stringify([rund.abb, rund.fischer]));
    ok('ein Merkblatt-PDF gilt dagegen als Werbecode', rund.merkblatt === true);
    ok('… und ein gewöhnlicher Code erst recht nicht', rund.echterCode === false);

    // Die Rangfolge: Der Werbe-QR wurde 13x gelesen, der echte EAN daneben nur 5x. Ohne
    // Sonderbehandlung gewaenne die Herstelleradresse — samt 2D-Bonus.
    const rang = await seite.evaluate(() => ({
      mitEan: scannerBesterTreffer(new Map([
        ['https://bauer-solar.de/solarmodule/', { n: 13, format: 'qr_code' }],
        ['4061975617484', { n: 5, format: 'ean_13' }]])),
      allein: scannerBesterTreffer(new Map([
        ['https://bauer-solar.de/solarmodule/', { n: 13, format: 'qr_code' }]])),
    }));
    ok('der echte Artikelcode schlägt den Werbe-QR, trotz weniger Lesungen',
      rang.mitEan === '4061975617484', JSON.stringify(rang.mitEan));
    ok('… allein gescannt wird er trotzdem zurückgegeben (um ihn zu erklären, nicht zu verschweigen)',
      rang.allein === 'https://bauer-solar.de/solarmodule/', JSON.stringify(rang.allein));

    console.log('\n── Bekannter Code wird eingesetzt ──');
    await seite.click('#order-add-btn'); await sleep(500);
    ok('der Scan-Knopf ist da', await seite.$('#of-scan') !== null);
    await scanVorgeben('4050821808435');
    await seite.click('#of-scan'); await sleep(1200);
    const eingesetzt = await seite.evaluate(() => ({
      produkt: document.getElementById('of-product').value,
      einheit: document.getElementById('of-unit').value,
      kat: document.getElementById('of-kategorie') ? document.getElementById('of-kategorie').value : null,
      id: document.getElementById('of-product').dataset.produktId || null,
    }));
    ok('das Produkt steht im Feld', eingesetzt.produkt === 'Kabelbinder 200 mm', JSON.stringify(eingesetzt));
    ok('… die Einheit ist vorbelegt', eingesetzt.einheit === 'Beutel', JSON.stringify(eingesetzt));
    ok('… die Kategorie auch', eingesetzt.kat === String(kat.id), JSON.stringify(eingesetzt));
    ok('… und die Verknüpfung ist gemerkt', eingesetzt.id === String(bekannt.id), JSON.stringify(eingesetzt));

    console.log('\n── Unbekannter Code öffnet die Maske ──');
    await scanVorgeben('4046281411223');
    await seite.click('#of-scan'); await sleep(1200);
    ok('die Anlege-Maske erscheint', await seite.$('#np-name') !== null);
    const maske = await seite.evaluate(() => (document.querySelector('.modal') || document.body).innerText);
    ok('… sie nennt den Barcode', /4046281411223/.test(maske), maske.slice(0, 150));
    ok('… und bittet um Sorgfalt', /schon gibt|sucht mit/i.test(maske), maske.slice(0, 260));
    ok('… ohne Sonderwarnung, denn das ist eine gültige Artikelnummer',
      !/Prüfziffer/.test(maske), maske.slice(0, 200));

    // Alex hat die Etikette fotografiert (09.09.2026): „Etiketten ID 801036963840" steht im
    // Klartext unter dem Data-Matrix. Ein LIEFERSCHEIN-Etikett — die Artikelnummern stehen nur
    // als Text darauf. Eine Etiketten-ID ist bei jeder Lieferung eine andere; als Barcode
    // gespeichert waere das Produkt beim naechsten Mal wieder unbekannt.
    await seite.evaluate(() => { const b = [...document.querySelectorAll('.modal button')].find(x => /Abbrechen/.test(x.textContent)); if (b) b.click(); });
    await sleep(500);
    await scanVorgeben('801036963840');
    await seite.click('#of-scan'); await sleep(1200);
    const maskeEtikett = await seite.evaluate(() => (document.querySelector('.modal') || document.body).innerText);
    ok('eine Zahl ohne gültige Prüfziffer wird eigens angesprochen',
      /Prüfziffer/.test(maskeEtikett), maskeEtikett.slice(0, 200));
    ok('… mit dem Hinweis auf Lieferschein-Etiketten',
      /Lieferschein/.test(maskeEtikett) && /jeder Lieferung/.test(maskeEtikett), maskeEtikett.slice(0, 300));
    // Alex hat DENSELBEN Karton von der anderen Seite fotografiert: Dort klebt das
    // Hersteller-Etikett von Schletter mit EAN-13 4262371512483 (gueltige Pruefziffer) zum
    // Artikel 973000-075. Meine Aussage „auf diesem Karton gibt es gar keinen Artikel-Barcode"
    // war also falsch — sie galt nur fuer das Lieferschein-Etikett. Der Hinweis sagt jetzt, wo
    // man wirklich nachschauen muss.
    ok('… und sagt, wo der Artikel-Barcode stattdessen steht',
      /andere[nr]? Seite/.test(maskeEtikett) && /Hersteller/.test(maskeEtikett), maskeEtikett.slice(0, 400));
    await seite.evaluate(() => { const b = [...document.querySelectorAll('.modal button')].find(x => /Abbrechen/.test(x.textContent)); if (b) b.click(); });
    await sleep(500);
    await scanVorgeben('4046281411223');
    await seite.click('#of-scan'); await sleep(1200);

    console.log('\n── Live-Abgleich bietet das bestehende Produkt an ──');
    await seite.type('#np-name', 'kabelbinder', { delay: 20 });
    await sleep(400);
    const aehnlich = await seite.evaluate(() => {
      const k = document.getElementById('np-aehnlich');
      return { sichtbar: k.style.display !== 'none',
               knoepfe: [...k.querySelectorAll('[data-anlernen]')].map(b => b.textContent.trim()) };
    });
    ok('das bestehende Produkt wird vorgeschlagen',
      aehnlich.sichtbar && aehnlich.knoepfe.includes('Kabelbinder 200 mm'), JSON.stringify(aehnlich));

    console.log('\n── Anlernen statt Doppel anlegen ──');
    await seite.evaluate(() => document.querySelector('[data-anlernen]').click());
    await sleep(1500);
    const nachher = await req('GET', '/api/products/barcode/4046281411223', tok);
    ok('der neue Code hängt am BESTEHENDEN Produkt',
      nachher.body.gefunden && nachher.body.produkt.id === bekannt.id, JSON.stringify(nachher.body.produkt && nachher.body.produkt.id));
    ok('… das Produkt hat jetzt zwei Codes',
      nachher.body.produkt.barcodes.length === 2, JSON.stringify(nachher.body.produkt.barcodes));
    const katalog = await req('GET', '/api/products/katalog', tok);
    ok('… und es gibt KEIN zweites Produkt', katalog.body.produkte.length === 1,
      JSON.stringify(katalog.body.produkte.map(p => p.name)));

    // ── Ein Produkt OHNE Barcode bekommt im Lager seinen Code ───────────────────────────────
    //
    // Alex am 09.09.2026: „dem Produkt ohne Barcode soll später im Lager von einem MA beim Scannen
    // ein Barcode zugeordnet werden können." Entscheidend ist das „von einem MA": max ist ein
    // gewöhnlicher Mitarbeiter OHNE „Lagerdaten pflegen". Anlegen darf er nur mit Barcode —
    // anlernen an ein bestehendes Produkt aber sehr wohl, sonst stünde er im Regal fest.
    console.log('\n── Ein barcodeloses Produkt bekommt im Lager seinen Code ──');
    const adminTok = (await req('POST', '/api/auth/login', null,
      { username: 'admin', password: pw('admin') })).body.token;
    const ohneCode = (await req('POST', '/api/products', adminTok, { name: 'Erdungsband 30x3' })).body.produkt;
    ok('das barcodelose Produkt existiert', !!ohneCode && (ohneCode.barcodes || []).length === 0,
      JSON.stringify(ohneCode));
    await sleep(1200);   // die SSE-Meldung frischt den Spiegel im Browser auf
    ok('… und ist im Spiegel des Browsers angekommen (ohne Neuladen)',
      await seite.evaluate(n => ((S.produktKatalog || {}).produkte || []).some(p => p.name === n), 'Erdungsband 30x3'),
      await seite.evaluate(() => JSON.stringify(((S.produktKatalog || {}).produkte || []).map(p => p.name))));

    await scanVorgeben('4260999999996');
    await seite.click('#of-scan'); await sleep(1200);
    await seite.type('#np-name', 'erdungsband', { delay: 20 });
    await sleep(400);
    const vorschlag = await seite.evaluate(() => {
      const k = document.getElementById('np-aehnlich');
      return { sichtbar: k.style.display !== 'none', html: k.innerHTML,
               knoepfe: [...k.querySelectorAll('[data-anlernen]')].map(b => b.textContent.trim()) };
    });
    ok('das barcodelose Produkt wird zum Anlernen angeboten',
      vorschlag.sichtbar && vorschlag.knoepfe.some(t => /Erdungsband/.test(t)), JSON.stringify(vorschlag.knoepfe));
    ok('… und ist als „noch ohne Barcode" gekennzeichnet',
      /noch ohne Barcode/.test(vorschlag.html), vorschlag.html.slice(0, 200));
    await seite.evaluate(() => {
      const b = [...document.querySelectorAll('[data-anlernen]')].find(x => /Erdungsband/.test(x.textContent));
      b.click();
    });
    await sleep(1500);
    const angelernt = await req('GET', '/api/products/barcode/4260999999996', tok);
    ok('ein Mitarbeiter ohne Pflegerecht darf den Code anlernen',
      angelernt.body.gefunden && angelernt.body.produkt.id === ohneCode.id, JSON.stringify(angelernt.body).slice(0, 120));
    const imFeldE = await seite.evaluate(() => document.getElementById('of-product').value);
    ok('… und das Produkt steht danach im Bestellformular', imFeldE === 'Erdungsband 30x3', imFeldE);

    console.log('\n── Wirklich neues Produkt anlegen ──');
    await scanVorgeben('4104640010552');
    await seite.click('#of-scan'); await sleep(1200);
    await seite.type('#np-name', 'Schrauben-Sortiment', { delay: 15 });
    await seite.evaluate(() => { document.getElementById('np-einheit').value = 'Koffer'; });
    await seite.evaluate(() => document.querySelector('[data-act="ok"]').click());
    await sleep(1800);
    const neu = await req('GET', '/api/products/barcode/4104640010552', tok);
    ok('das neue Produkt ist angelegt',
      neu.body.gefunden && neu.body.produkt.name === 'Schrauben-Sortiment', JSON.stringify(neu.body.produkt && neu.body.produkt.name));
    const imFeld = await seite.evaluate(() => document.getElementById('of-product').value);
    ok('… und steht gleich im Formular', imFeld === 'Schrauben-Sortiment', imFeld);

    // KEIN PERSONENNAME IN SICHTBAREN TEXTEN.
    //
    // Die App liegt oeffentlich auf GitHub und laeuft auch in anderen Betrieben — dort gibt es
    // keinen „Alex". Alex am 09.09.2026: „ist nicht richtig, da die app ja frei ab git liegt.
    // Somit eher, sag deinem admin bescheid." Betroffen waren drei Stellen, die ich selbst
    // geschrieben hatte; gefunden hat sie nicht der Test, sondern er.
    //
    // Geprueft wird der GERENDERTE Text (der Anmelde-Benutzer heisst hier „max", kein Grund fuer
    // einen Fehlalarm), und zwar auf der Bestellseite mit geoeffnetem Formular — dort stehen die
    // Hinweise, in denen es passiert ist.
    const sichtbar = await seite.evaluate(() => document.querySelector('.main').innerText);
    ok('kein Personenname in sichtbaren Texten (die App läuft auch anderswo)',
      !/\bAlex\b/i.test(sichtbar),
      (sichtbar.match(/.{0,50}[Aa]lex.{0,50}/) || [])[0]);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close(); srv.kill(); }

  console.log(`\nScanner im Formular: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
