// Anmeldebremse je Konto (Sicherheitspruefung 10.11.2026, P5).
//
// Die Bremse von express-rate-limit zaehlt je ADRESSE. Wer von vielen Adressen kommt, konnte ein
// einzelnes Konto deshalb beliebig oft durchprobieren. Diese zweite Bremse zaehlt je
// BENUTZERNAMEN — und sie BREMST, sie sperrt nicht:
//
//   * Die ersten Versuche laufen ohne Wartezeit (Tippfehler kosten nichts).
//   * Danach waechst die Pause bis zum naechsten Versuch: 1, 2, 4 … Sekunden, hoechstens eine Minute.
//   * Ein Versuch WAEHREND der Pause wird abgewiesen, ohne das Passwort zu pruefen, und verlaengert
//     die Pause nicht. Wuerde er sie verlaengern, koennte man ein Konto durch blosses Anklopfen
//     dauerhaft zuhalten — genau die Sperre, die es nicht geben soll.
//   * Die richtige Anmeldung setzt den Zaehler zurueck; ohne weitere Versuche ist er nach einer
//     Viertelstunde vergessen.
//
// Gezaehlt wird der Name, WIE ER GETIPPT WURDE — auch wenn es das Konto nicht gibt. Bremste man
// nur vorhandene Konten, verriete die Bremse, welche Namen es gibt.
//
// Gezaehlt wird beim ANKLOPFEN, nicht erst nach der Passwortpruefung: Die Pruefung braucht Zeit,
// und zwanzig gleichzeitige Versuche saehen sonst alle noch den alten Zaehlerstand.
//
// Der Stand liegt im Arbeitsspeicher (wie bei express-rate-limit) und ist nach einem Neustart leer.

function kontobremse({
  frei = 5,                       // so viele Versuche ohne Wartezeit
  basisS = 1,                     // erste Pause in Sekunden, danach jeweils das Doppelte
  hoechstS = 60,                  // laengste Pause
  vergessenMs = 15 * 60 * 1000,   // so lange nach dem letzten Versuch bleibt der Zaehler stehen
  maxKonten = 10000,              // Obergrenze der gemerkten Namen (Schutz des Arbeitsspeichers)
  jetzt = Date.now,
} = {}) {
  const konten = new Map();       // Name -> { versuche, letzter, naechster, gemeldet }

  function aufraeumen(t) {
    for (const [name, k] of konten) if (t - k.letzter > vergessenMs) konten.delete(name);
    // Immer noch voll: die aeltesten Namen gehen (eine Map merkt sich die Reihenfolge des Eintragens).
    for (const name of konten.keys()) { if (konten.size < maxKonten) break; konten.delete(name); }
  }

  function pauseNach(versuche) {
    if (versuche < frei) return 0;
    return Math.min(hoechstS, basisS * Math.pow(2, versuche - frei));
  }

  // Vor jeder Passwortpruefung. Liefert { wartenS: 0 } (darf pruefen) oder { wartenS: n, erstmals }.
  // `erstmals` ist genau einmal je Bremsphase wahr — fuer EINE Zeile im Audit-Protokoll.
  function anklopfen(name) {
    const t = jetzt();
    let k = konten.get(name);
    if (k && t - k.letzter > vergessenMs) { konten.delete(name); k = null; }
    if (k && t < k.naechster) {
      const erstmals = !k.gemeldet;
      k.gemeldet = true;
      return { wartenS: Math.max(1, Math.ceil((k.naechster - t) / 1000)), erstmals, versuche: k.versuche };
    }
    if (!k) {
      if (konten.size >= maxKonten) aufraeumen(t);
      k = { versuche: 0, letzter: t, naechster: 0, gemeldet: false };
      konten.set(name, k);
    }
    k.versuche++;
    k.letzter = t;
    k.naechster = t + pauseNach(k.versuche) * 1000;
    return { wartenS: 0 };
  }

  // Das Passwort stimmte: Zaehler weg.
  function erfolg(name) { konten.delete(name); }

  return { anklopfen, erfolg, anzahl: () => konten.size };
}

module.exports = { kontobremse };
