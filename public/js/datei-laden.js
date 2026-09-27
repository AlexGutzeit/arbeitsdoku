// Datei herunterladen — der EINE Baustein für App (index.html) und Gästeseite (gast.html).
// Eigene Datei, weil die Gästeseite app-1-core.js bewusst nicht lädt (Etappe C, 27.09.2026), die
// Regel aus R18 aber bleiben soll: eine Stelle für alle Downloads (tests/kleine-sackgassen-ui.js).
'use strict';

// ── Datei herunterladen (R18) ──
// EINE Stelle für alle Downloads (PDF, CSV, Sicherung, Dokumente, Datenauskunft …). Vorher stand das
// Muster an zehn Stellen, und an sieben wurde die Datei-Adresse SOFORT nach dem Klick wieder
// freigegeben. Safari auf dem iPhone liest die Datei aber erst danach — der Download konnte still
// abbrechen. Freigegeben wird deshalb erst nach einer Minute.
const DOWNLOAD_FREIGABE_MS = 60000;
function dateiHerunterladen(blob, dateiname) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = dateiname;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_FREIGABE_MS);
}
// Dateiname aus der Server-Antwort (Content-Disposition), sonst der Ersatzname.
function dateinameAus(antwort, ersatz) {
  const kopf = antwort.headers.get('Content-Disposition') || '';
  // Zuerst die UTF-8-Fassung (filename*): Umlaute und „–" gehen nur so heil durch (Notiz-Export, 27.09.2026)
  const utf8 = (kopf.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
  if (utf8) { try { return decodeURIComponent(utf8); } catch (_) { /* weiter mit der einfachen Fassung */ } }
  return (kopf.match(/filename="([^"]+)"/) || [])[1] || ersatz;
}
