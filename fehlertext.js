// Fehler für Menschen übersetzen (R9, 25.09.2026).
//
// Der Rohtext eines Datei- oder Upload-Fehlers ist englisch und nennt Serverpfade — z. B. bei
// voller Platte „ENOSPC: no space left on device, open '/home/…'" oder „Unexpected field". Er
// gehört ins Server-Protokoll, nicht in die Meldung an den Nutzer. Diese Datei ist die EINE Stelle,
// an der daraus ein deutscher Satz wird; wer eine neue Upload-Route baut, benutzt sie.

// Fehler des Dateisystems (Node setzt `code`, z. B. ENOSPC). Liefert einen Satzteil ohne Punkt,
// damit der Aufrufer ihn einbetten kann: „Hochladen fehlgeschlagen: kein Speicherplatz mehr frei."
function dateiFehlerText(e) {
  const code = e && e.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'kein Speicherplatz mehr frei';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'fehlende Schreibrechte';
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EEXIST') return 'ein Ordner fehlt oder ist keiner';
  if (code === 'EMFILE' || code === 'ENFILE') return 'zu viele Dateien gleichzeitig geöffnet';
  return 'unerwarteter Fehler — Einzelheiten im Server-Protokoll';
}

// Fehler aus multer (Upload) — oder aus dem Dateisystem darunter, oder die eigene, schon deutsche
// Meldung eines Dateifilters („Nur PDF, Word … erlaubt"). Nur letztere wird durchgereicht.
function uploadFehlerText(err) {
  if (!err) return 'Hochladen fehlgeschlagen.';
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return 'Die Datei ist zu groß.';
    if (err.code === 'LIMIT_FILE_COUNT') return 'Zu viele Dateien auf einmal.';
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return 'Die Datei kam nicht über das vorgesehene Formularfeld an. Bitte über die Seite hochladen.';
    return 'Hochladen fehlgeschlagen.';
  }
  if (err.code && /^E[A-Z]+$/.test(err.code)) return `Hochladen fehlgeschlagen: ${dateiFehlerText(err)}.`;
  return err.message || 'Hochladen fehlgeschlagen.';
}

module.exports = { dateiFehlerText, uploadFehlerText };
