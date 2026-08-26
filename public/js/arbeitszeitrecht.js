// Arbeitszeitgesetz und Jugendarbeitsschutzgesetz — als Maschine, nicht als Fliesstext.
//
// Diese Regeln gab es schon: als lokale Funktionen INNERHALB von renderEntryForm(). Sie liefen nur
// beim Buchen, waren nirgends exportiert und gaben einen fertigen Satz zurueck. Fuer die Uebersicht
// (Alex, 26.08.2026) brauchte es beides anders: an mehreren Stellen aufrufbar, und mit einer
// Auskunft, die man auswerten kann statt sie mit einem Suchmuster zu zerlegen.
//
// Ein Verstoss ist ein Objekt:
//   { art, ebene, user_id, datum, ist, grenze, gesetz, hinweis, text }
// `ist` und `grenze` in MINUTEN. Damit laesst sich datengetrieben pruefen, ohne auf Textmuster
// angewiesen zu sein — die alte Warnung konnte man nur per Regex befragen.
//
// Alle Vergleiche sind STRIKT: Genau 10:00 ist erlaubt, genau 11:00 Ruhezeit ist erlaubt. Das war
// schon vorher so und ist in tests/hoechstarbeitszeit-ui.js festgenagelt.
//
// ZEITRECHNUNG: Dieses Modul rechnet ausschliesslich in UTC (`T12:00:00Z`) und gibt ISO-Strings
// zurueck. Die Ansicht rechnet an anderen Stellen lokal (getISOWeek, getWeekRange). Beides ist fuer
// sich richtig; das MISCHEN liegt an Sommerzeitgrenzen einen Tag daneben. Deshalb wandert zwischen
// Modul und Ansicht nie ein Date-Objekt, immer nur ein ISO-String.
//
// BEWUSST NICHT umgesetzt (damit es niemand als vermeintlichen Fehler „repariert"):
//   * § 3 ArbZG, 24-Wochen-Ausgleich — die App kennt den Betrachtungszeitraum nicht und soll ihn
//     nicht erfinden. Deshalb ist die 48-Stunden-Woche hier ein HINWEIS, kein Verstoss.
//   * § 5 Abs. 2 ArbZG, verkuerzte Ruhezeit mit Ausgleich (Krankenhaus, Gaststaetten) — fuer einen
//     Handwerksbetrieb gegenstandslos.
//   * Ruhezeit INNERHALB eines Tages. Geprueft wird der Nachtabstand zwischen zwei Tagen; das ist
//     die richtige Lesart von § 5.
//   * § 15/16 JArbSchG (Fuenf-Tage-Woche, Samstagsruhe).
//
// Es bleibt ein HINWEIS, keine Sperre — wer elf Stunden gearbeitet hat, muss das eintragen koennen.
// Und es ist keine Rechtsberatung: Tarifvertraege und § 7 ArbZG kennen Abweichungen.

// ── Grenzen ─────────────────────────────────────────────────────────────────────────────────────
// § 3 ArbZG: werktaeglich 8 Stunden, verlaengerbar auf 10, wenn der Schnitt ueber 24 Wochen bei 8
// bleibt. 10 Stunden sind die harte Decke.
// § 8 JArbSchG: 8 Stunden taeglich UND 40 Stunden woechentlich. 8½ an einzelnen Tagen nur, wenn an
// einem anderen Werktag derselben Woche verkuerzt wird — das ist keine freie Option, sondern eine
// Bedingung. Die App nennt sie im Text und ueberlaesst die Beurteilung dem Menschen (Alex' Wahl).
const AZ_MAX_TAG_ERWACHSEN   = 10 * 60;
const AZ_MAX_TAG_JUGEND      =  8 * 60;
const AZ_MAX_WOCHE_JUGEND    = 40 * 60;
// 8 Stunden an sechs Werktagen. KEINE harte Decke — siehe Kommentar oben.
const AZ_MAX_WOCHE_ERWACHSEN = 48 * 60;
const AZ_RUHE_ERWACHSEN      = 11 * 60;   // § 5 ArbZG
const AZ_RUHE_JUGEND         = 12 * 60;   // § 13 JArbSchG

// ── Kleine Helfer (aus renderEntryForm hierher gezogen, unveraendert) ───────────────────────────

function azMinuten(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (Number.isFinite(h) && Number.isFinite(m)) ? h * 60 + m : null;
}

function stundenText(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h + ' Std' + (m ? ' ' + m + ' min' : '');
}

function montagDer(datum) {
  const d = new Date(datum + 'T12:00:00Z');
  const wt = d.getUTCDay();                       // 0 = Sonntag
  d.setUTCDate(d.getUTCDate() + (wt === 0 ? -6 : 1 - wt));
  return d.toISOString().slice(0, 10);
}
function plusTage(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Gesetzlich vorgeschriebene Mindestpause nach § 4 Arbeitszeitgesetz, bezogen auf die
 * ANWESENHEIT eines Tages (Brutto, also inklusive Pause).
 *
 * Das Gesetz bemisst die Pause an der Arbeitszeit — und die ist Anwesenheit MINUS Pause.
 * Daraus wird schnell ein Ringelspiel: 9:45 Anwesenheit ergibt mit 30 min Pause 9:15
 * Arbeitszeit (über 9 → 45 nötig), mit 45 min aber 9:00 (nicht über 9 → 30 genügt).
 * Deshalb wird hier die KLEINSTE Pause gesucht, mit der die Vorschrift erfüllt ist — bei
 * 9:45 also 45, weil 30 sie verletzen würde. Damit gibt es keine Schwingung.
 *
 * Fängt nebenbei die bekannte Sechs-Stunden-Falle: 6:20 Anwesenheit braucht 30 min Pause,
 * sonst wären es 6:20 Arbeit am Stück.
 */
function gesetzlichePause(bruttoMin, jugendlich) {
  // § 11 JArbSchG (unter 18): über 4½ bis 6 Std → 30 min, über 6 Std → 60 min.
  // § 4 ArbZG (ab 18):        über 6 bis 9 Std → 30 min, über 9 Std → 45 min.
  const noetig = jugendlich
    ? (a) => a > 6 * 60 ? 60 : (a > 4.5 * 60 ? 30 : 0)
    : (a) => a > 9 * 60 ? 45 : (a > 6 * 60 ? 30 : 0);
  // Kandidaten sind die im Gesetz genannten Werte — nur sie ergeben eine erklärbare Zahl.
  for (const p of (jugendlich ? [0, 30, 60] : [0, 30, 45])) {
    if (noetig(bruttoMin - p) <= p) return p;
  }
  return jugendlich ? 60 : 45;
}

/**
 * Anwesenheit eines Tages in Minuten — überlappende Einträge zählen NICHT doppelt.
 *
 * Zeitgleich dokumentierte Aufträge sind bei SenTec ausdrücklich gewollt (zwei Baustellen auf
 * einem Beleg, Regie neben Festpreis). Für alles, was das Gesetz an der Anwesenheit festmacht,
 * zählt aber die Uhr und nicht die Anzahl der Belege.
 */
function anwesenheitMinuten(liste, aktuellVon, aktuellBis) {
  const spannen = [];
  for (const e of liste) {
    const a = azMinuten(e.time_from), b = azMinuten(e.time_to);
    if (a !== null && b !== null && b > a) spannen.push([a, b]);
  }
  const a = azMinuten(aktuellVon), b = azMinuten(aktuellBis);
  if (a !== null && b !== null && b > a) spannen.push([a, b]);
  if (!spannen.length) return 0;
  spannen.sort((x, y) => x[0] - y[0]);
  let summe = 0, von = spannen[0][0], bis = spannen[0][1];
  for (let i = 1; i < spannen.length; i++) {
    if (spannen[i][0] <= bis) bis = Math.max(bis, spannen[i][1]);
    else { summe += bis - von; von = spannen[i][0]; bis = spannen[i][1]; }
  }
  return summe + (bis - von);
}

// Netto-Minuten einer Menge von Einträgen — über calcActualHours, damit sich überlappende
// Einträge nicht doppelt zählen (dieselbe Rechnung wie in Statistik und PDF).
function nettoMinuten(eintraege) {
  return Math.round(calcActualHours(eintraege) * 60);
}

function restPause(liste, aktuellVon, aktuellBis, jugendlich, geburtBekannt) {
  const firma = Number(arbeitszeitJetzt().break_minutes_default) || 0;
  const genommen = liste.reduce((s, e) => s + (Number(e.break_minutes) || 0), 0);

  // Anwesenheit des GANZEN Tages — ÜBERLAPPUNGSFREI, nicht als Summe der Einträge.
  //
  // Wer zwei Aufträge zeitgleich dokumentiert (zweimal 07:00–12:00, beim Kunden 10 Stunden), war
  // trotzdem nur 5 Stunden da. Die frühere Summe kam hier auf 10 Stunden und hob die Pause nach
  // § 4 ArbZG auf 45 Minuten an — für eine Arbeitszeit, die es nie gab, und mit einem Gesetz
  // begründet, das gar nicht greift. (Gefunden von Alex, 30.07.2026.)
  const bruttoTag = anwesenheitMinuten(liste, aktuellVon, aktuellBis);
  const gesetzlich = gesetzlichePause(bruttoTag, jugendlich);

  // Der Firmenwert ist die Untergrenze — das Gesetz kann ihn nur ANHEBEN, nie senken.
  const ziel = Math.max(firma, gesetzlich);
  return {
    rest: Math.max(0, ziel - genommen), genommen, firma, gesetzlich, ziel,
    bruttoTag, hatEintraege: liste.length > 0, jugendlich, geburtBekannt: !!geburtBekannt,
    gesetzGreift: gesetzlich > firma,
  };
}

// ── Alter ───────────────────────────────────────────────────────────────────────────────────────

// ZUERST der angemeldete Nutzer selbst: Ein Mitarbeiter darf /api/users nicht laden, für ihn
// ist S.users leer — derselbe Grund wie beim Arbeitsbeginn.
function geburtsdatumVon(userId) {
  const id = userId ? Number(userId) : (S.user && Number(S.user.id));
  if (S.user && Number(S.user.id) === id && S.user.birth_date) return S.user.birth_date;
  const u = (S.users || []).find(x => Number(x.id) === id);
  return (u && u.birth_date) || null;
}

/**
 * Ist die Person am `datum` noch keine 18?
 *
 * OHNE Geburtsdatum wird „ja" angenommen — lieber eine zu lange Pause vorschlagen als eine zu
 * kurze bei einem Minderjährigen. Gerechnet wird auf den Eintragstag, nicht auf heute: Wer im
 * Mai 18 wird, fällt für einen Eintrag aus dem März noch unter den Jugendschutz.
 *
 * In der ÜBERSICHT kehrt sich die Wirkung um: Dort erzeugt die strenge Annahme ein Warnzeichen.
 * Alex hat sich am 26.08.2026 bewusst dafür entschieden, es trotzdem streng zu lassen — eine Regel
 * für die ganze App statt zweier Fassungen — und den Grund stattdessen im Tooltip zu nennen.
 */
function istJugendlich(userId, datum) {
  const geburt = geburtsdatumVon(userId);
  if (!geburt) return true;                                   // unbekannt → strengere Regel
  const achtzehn = new Date(String(geburt) + 'T12:00:00Z');
  if (isNaN(achtzehn.getTime())) return true;
  achtzehn.setUTCFullYear(achtzehn.getUTCFullYear() + 18);
  return String(datum || '') < achtzehn.toISOString().slice(0, 10);
}

// ── Ruhezeit ────────────────────────────────────────────────────────────────────────────────────

// Einträge mit bis <= von fallen ueberall weg: Im Bestand liegen Platzhalter mit 07:00–07:00
// (18 Stueck am 26.08.2026 gezaehlt). Ohne diesen Filter gaelte so ein Platzhalter als
// Arbeitsbeginn und erzeugte einen Dauerverstoss auf einem Eintrag, der gar keine Zeit enthaelt.
const azEchte = (liste) => (liste || []).filter(e => {
  const a = azMinuten(e.time_from), b = azMinuten(e.time_to);
  return a !== null && b !== null && b > a;
});

const azLetztesEnde  = (l) => azEchte(l).reduce((m, e) => Math.max(m, azMinuten(e.time_to)), -1);
const azErsterBeginn = (l) => azEchte(l).reduce((m, e) => Math.min(m, azMinuten(e.time_from)), 24 * 60 + 1);

/**
 * Ruhezeit zwischen Feierabend am Vortag und Arbeitsbeginn am Tag, in Minuten.
 * null, wenn an einem der beiden Tage nichts Zaehlbares steht — dann gibt es nichts zu beurteilen.
 *
 * Naechtliche Eintraege ueber Mitternacht gibt es nicht (time_from < time_to ist erzwungen),
 * deshalb genuegt die einfache Rechnung.
 */
function ruhezeitMinuten(vortagEintraege, tagEintraege) {
  const ende = azLetztesEnde(vortagEintraege);
  const beginn = azErsterBeginn(tagEintraege);
  if (ende < 0 || beginn > 24 * 60) return null;
  return (24 * 60 - ende) + beginn;
}

// ── Die Regeln ──────────────────────────────────────────────────────────────────────────────────

function azVerstoss(art, ebene, userId, datum, ist, grenze, gesetz, text, hinweis) {
  return { art, ebene, user_id: Number(userId), datum, ist, grenze, gesetz, text, hinweis: !!hinweis };
}

/**
 * Verstoesse eines (Mitarbeiter, Tag): Tagesarbeitszeit, Pause, Ruhezeit zum Vortag.
 *
 * @param {object} opt  { ladeVon } — der erste geladene Tag. Fuer ihn wird die Ruhezeit NICHT
 *   geprueft: „kein Vortag geladen" und „am Vortag nicht gearbeitet" sehen in den Daten gleich aus,
 *   und der Fehler waere unsichtbar, weil er nur FEHLENDE Warnungen erzeugt.
 */
function verstoesseTag(userId, datum, tagEintraege, vortagEintraege, jugendlich, opt) {
  const raus = [];
  const tag = azEchte(tagEintraege);
  if (!tag.length) return raus;

  // 1. Taegliche Hoechstarbeitszeit
  const netto = nettoMinuten(tag);
  const grenzeTag = jugendlich ? AZ_MAX_TAG_JUGEND : AZ_MAX_TAG_ERWACHSEN;
  if (netto > grenzeTag) {
    raus.push(azVerstoss(jugendlich ? 'tag-jugend' : 'tag-erwachsen', 'tag', userId, datum,
      netto, grenzeTag, jugendlich ? '§ 8 JArbSchG' : '§ 3 ArbZG',
      jugendlich
        ? `Der Tag kommt auf ${stundenText(netto)} Arbeitszeit. Für unter 18-Jährige sind höchstens `
          + `8 Stunden erlaubt; 8½ nur, wenn an einem anderen Tag derselben Woche verkürzt wird `
          + `(§ 8 Jugendarbeitsschutzgesetz).`
        : `Der Tag kommt auf ${stundenText(netto)} Arbeitszeit. Das Arbeitszeitgesetz erlaubt `
          + `höchstens 10 Stunden (§ 3 ArbZG).`));
  }

  // 2. Ruhepause
  const anwesend = anwesenheitMinuten(tag);
  const noetig = gesetzlichePause(anwesend, jugendlich);
  const genommen = tag.reduce((s, e) => s + (Number(e.break_minutes) || 0), 0);
  if (genommen < noetig) {
    raus.push(azVerstoss(jugendlich ? 'pause-jugend' : 'pause-erwachsen', 'tag', userId, datum,
      genommen, noetig, jugendlich ? '§ 11 JArbSchG' : '§ 4 ArbZG',
      `Bei ${stundenText(anwesend)} Anwesenheit sind ${noetig} Minuten Pause vorgeschrieben, `
      + `eingetragen ${genommen === 0 ? 'ist keine' : 'sind ' + genommen + ' Minuten'} `
      + `(${jugendlich ? '§ 11 Jugendarbeitsschutzgesetz' : '§ 4 ArbZG'}).`));
  }

  // 3. Ruhezeit zum Vortag
  if (!opt || !opt.ladeVon || datum > opt.ladeVon) {
    const ruhe = ruhezeitMinuten(vortagEintraege, tag);
    const grenzeRuhe = jugendlich ? AZ_RUHE_JUGEND : AZ_RUHE_ERWACHSEN;
    if (ruhe !== null && ruhe < grenzeRuhe) {
      const ende = azLetztesEnde(vortagEintraege), beginn = azErsterBeginn(tag);
      const uhr = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
      raus.push(azVerstoss(jugendlich ? 'ruhezeit-jugend' : 'ruhezeit-erwachsen', 'tag', userId, datum,
        ruhe, grenzeRuhe, jugendlich ? '§ 13 JArbSchG' : '§ 5 ArbZG',
        `Zwischen Feierabend am Vortag (${uhr(ende)}) und Arbeitsbeginn (${uhr(beginn)}) liegen nur `
        + `${stundenText(ruhe)} Ruhezeit. Vorgeschrieben sind ${jugendlich ? 12 : 11} Stunden `
        + `ununterbrochen (${jugendlich ? '§ 13 Jugendarbeitsschutzgesetz' : '§ 5 ArbZG'}).`));
    }
  }
  return raus;
}

/**
 * Verstoesse eines (Mitarbeiter, Woche). `montag` ist der ISO-Montag, nicht die KW-Nummer:
 * KW-Nummern kollidieren ueber Jahresgrenzen.
 */
function verstoesseWoche(userId, montag, wochenEintraege, jugendlich) {
  const raus = [];
  const woche = azEchte(wochenEintraege);
  if (!woche.length) return raus;
  const netto = nettoMinuten(woche);

  if (jugendlich) {
    if (netto > AZ_MAX_WOCHE_JUGEND) {
      raus.push(azVerstoss('woche-jugend', 'woche', userId, montag, netto, AZ_MAX_WOCHE_JUGEND,
        '§ 8 JArbSchG',
        `Die Woche kommt auf ${stundenText(netto)}. Für unter 18-Jährige sind höchstens 40 Stunden `
        + `pro Woche erlaubt (§ 8 Jugendarbeitsschutzgesetz).`));
    }
  } else if (netto > AZ_MAX_WOCHE_ERWACHSEN) {
    // HINWEIS, kein Verstoss: § 3 ArbZG erlaubt 10 Std taeglich, also bis zu 60 in der Woche —
    // solange der Schnitt ueber 24 Wochen bei 8 Std werktaeglich bleibt. Die App kennt diesen
    // Zeitraum nicht und darf deshalb nichts behaupten (Entscheidung Alex, 26.08.2026).
    raus.push(azVerstoss('woche-erwachsen', 'woche', userId, montag, netto, AZ_MAX_WOCHE_ERWACHSEN,
      '§ 3 ArbZG',
      `Die Woche kommt auf ${stundenText(netto)}. Das Arbeitszeitgesetz geht von höchstens `
      + `8 Stunden an sechs Werktagen aus — 48 Stunden. Mehr ist zulässig, wenn es innerhalb von `
      + `24 Wochen ausgeglichen wird (§ 3 ArbZG).`, true));
  }
  return raus;
}

// ── Sammelaufruf ────────────────────────────────────────────────────────────────────────────────

/**
 * Prueft eine Menge von Eintraegen und liefert einen INDEX zum Nachschlagen — keine Liste.
 * Die Ansichten fragen je Zelle nach, statt eine Liste zu durchsuchen.
 *
 * @param {Array}  eintraege  ALLE geladenen Eintraege, auch die ausserhalb des sichtbaren Bereichs
 * @param {object} opt        { ladeVon, ladeBis }
 * @returns {{tag: Object, woche: Object}}  Schluessel 'userId|datum' bzw. 'userId|montag'
 */
function pruefeEintraege(eintraege, opt) {
  const index = { tag: {}, woche: {} };
  if (!eintraege || !eintraege.length) return index;

  const nachTag = {}, nachWoche = {}, personen = {};
  for (const e of eintraege) {
    const uid = Number(e.user_id);
    personen[uid] = true;
    (nachTag[uid + '|' + e.date] = nachTag[uid + '|' + e.date] || []).push(e);
    const mo = montagDer(e.date);
    (nachWoche[uid + '|' + mo] = nachWoche[uid + '|' + mo] || []).push(e);
  }

  for (const schluessel of Object.keys(nachTag)) {
    const [uid, datum] = schluessel.split('|');
    const vortag = nachTag[uid + '|' + plusTage(datum, -1)] || [];
    const liste = verstoesseTag(uid, datum, nachTag[schluessel], vortag, istJugendlich(uid, datum), opt);
    if (liste.length) index.tag[schluessel] = liste;
  }
  for (const schluessel of Object.keys(nachWoche)) {
    const [uid, montag] = schluessel.split('|');
    // Das Alter am Montag entscheidet fuer die ganze Woche. Wer mitten in der Woche 18 wird,
    // faellt fuer diese Woche noch unter den Jugendschutz — die strengere Lesart.
    const liste = verstoesseWoche(uid, montag, nachWoche[schluessel], istJugendlich(uid, montag));
    if (liste.length) index.woche[schluessel] = liste;
  }
  return index;
}

const verstossTag   = (index, userId, datum) => (index && index.tag[Number(userId) + '|' + datum]) || [];
const verstossWoche = (index, userId, datum) => (index && index.woche[Number(userId) + '|' + montagDer(datum)]) || [];
