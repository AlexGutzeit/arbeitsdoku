// Regelmäßige Meldungen (Etappe 3, 30.09.2026): „Auto 1 → alle zwei Jahre am 1. März → TÜV".
//
// Eine REGEL ist eine Vorlage (Thema, Text, Dringlichkeit) mit Vorlauf, Uhrzeit, Takt und Ende. Daran hängen
// beliebig viele AUSLÖSER (Alex: „mehrere regelmäßige Auslöser, um jeden 1. und 3. Montag bauen zu können"):
//   intervall   alle N Tage / Wochen / Monate / Jahre ab einem Datum       (TÜV, Ölwechsel)
//   wochentag   jeden 1./2./3./4./letzten Wochentag, alle N Monate ab …    (Restmüll 1. + 3. Montag;
//                                                                            alle 12 Monate = „1. Montag im Februar")
// Die Planung kennt „jährlich", aber kein „alle 2 Jahre" — deshalb eine eigene, kleine Rechnung.
//
// Festlegungen (Rückfragen, 30.09.2026):
//   * Vorlauf: die Meldung kommt N Tage/Wochen/Monate VOR dem Fälligkeitstag, zur eingestellten Uhrzeit;
//     sie trägt immer das Fälligkeitsdatum („TÜV fällig am 01.03.2028").
//   * Takt „fest" (TÜV) oder „ab Erledigung" (Ölwechsel: 12 Monate nach dem letzten). Letzteres nur mit
//     GENAU EINEM Intervall-Auslöser — bei „1. und 3. Montag" gibt es kein „danach".
//   * Keine Doppelten: Ist die letzte automatische Meldung noch offen, wenn die nächste fällig wird, bekommt
//     sie „erneut fällig am …", leuchtet wieder auf und schickt eine Push.
//   * Absender „automatisch" (created_by NULL) — für jeden Zähler „jemand anderes".
//   * Lief der Server nicht (Neustart, Ausfall), kommt beim Nachholen nur die LETZTE verpasste Fälligkeit —
//     keine Flut. Beim festen Takt wird Vergangenes VOR dem Anlegen nie nachgeholt (gueltig_ab = Tag des
//     Anlegens) — der TÜV vom letzten März ist erledigt. Bei „ab Erledigung" gibt es dagegen immer nur EINE
//     nächste Fälligkeit; liegt sie zurück („letzter Ölwechsel vor 13 Monaten"), ist sie überfällig und kommt sofort.
//   * Pausiert: nichts; beim Fortsetzen zählt ab dem Tag des Fortsetzens (kein Nachholen der Pause).
//
// Alle Zeiten in deutscher Ortszeit ('JJJJ-MM-TT' bzw. 'JJJJ-MM-TT HH:MM'), wie die Planungs-Erinnerungen.
'use strict';
const { berlinJetzt, berlinHeute, istDatum, istUhrzeit } = require('./zeit');

const EINHEITEN = ['tag', 'woche', 'monat', 'jahr'];
const VORLAUF_EINHEITEN = ['tag', 'woche', 'monat'];
const WOCHENTAGE = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const GRENZE = 2000;   // Sicherheitsnetz gegen Endlosschleifen (täglich über fünf Jahre)

// ── Datumsrechnung (UTC-Mittag-frei: reine Kalendertage) ───────────────────────────────────────────────
const alsDatum = (iso) => new Date(iso + 'T00:00:00Z');
const alsIso = (d) => d.toISOString().slice(0, 10);
function plusTage(iso, n) { const d = alsDatum(iso); d.setUTCDate(d.getUTCDate() + n); return alsIso(d); }
const tageImMonat = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
// Monatsende festhalten: 31.01. + 1 Monat = 28./29.02. (nicht 03.03. wie bei setUTCMonth)
function plusMonate(iso, n) {
  const d = alsDatum(iso);
  const ziel = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  ziel.setUTCDate(Math.min(d.getUTCDate(), tageImMonat(ziel.getUTCFullYear(), ziel.getUTCMonth())));
  return alsIso(ziel);
}
function schritt(iso, einheit, n) {
  if (einheit === 'tag') return plusTage(iso, n);
  if (einheit === 'woche') return plusTage(iso, 7 * n);
  if (einheit === 'monat') return plusMonate(iso, n);
  return plusMonate(iso, 12 * n);   // jahr
}
// n-ter Wochentag (1 = Montag … 7 = Sonntag) im Monat; nth -1 = der letzte. null, wenn es ihn nicht gibt.
function nterWochentag(y, m, wochentag, nth) {
  const jsTag = wochentag % 7;   // JS: 0 = Sonntag
  if (nth === -1) {
    const letzter = tageImMonat(y, m);
    const zurueck = (new Date(Date.UTC(y, m, letzter)).getUTCDay() - jsTag + 7) % 7;
    return alsIso(new Date(Date.UTC(y, m, letzter - zurueck)));
  }
  const vor = (jsTag - new Date(Date.UTC(y, m, 1)).getUTCDay() + 7) % 7;
  const tag = 1 + vor + (nth - 1) * 7;
  return tag > tageImMonat(y, m) ? null : alsIso(new Date(Date.UTC(y, m, tag)));
}
function vorlaufAbziehen(iso, zahl, einheit) {
  if (!zahl) return iso;
  if (einheit === 'monat') return plusMonate(iso, -zahl);
  return plusTage(iso, -(einheit === 'woche' ? 7 * zahl : zahl));
}

// ── Prüfen ─────────────────────────────────────────────────────────────────────────────────────────────
const ganz = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

function ausloeserPruefen(a) {
  if (!a || typeof a !== 'object') return { fehler: 'Ein Auslöser ist unvollständig.' };
  if (!istDatum(a.start_datum)) return { fehler: 'Bitte bei jedem Auslöser ein gültiges Startdatum angeben.' };
  const n = ganz(a.n == null ? 1 : a.n, 1, 120);
  if (n == null) return { fehler: '„Alle N …" braucht eine Zahl zwischen 1 und 120.' };
  if (a.art === 'intervall') {
    if (!EINHEITEN.includes(a.einheit)) return { fehler: 'Unbekannte Einheit (Tage, Wochen, Monate, Jahre).' };
    return { a: { art: 'intervall', einheit: a.einheit, n, start_datum: a.start_datum, nth: null, wochentag: null } };
  }
  if (a.art === 'wochentag') {
    const nth = Number(a.nth);
    if (![1, 2, 3, 4, -1].includes(nth)) return { fehler: 'Bitte wählen: 1., 2., 3., 4. oder letzter.' };
    const wt = ganz(a.wochentag, 1, 7);
    if (wt == null) return { fehler: 'Bitte einen Wochentag wählen.' };
    return { a: { art: 'wochentag', einheit: 'monat', n, start_datum: a.start_datum, nth, wochentag: wt } };
  }
  return { fehler: 'Unbekannte Art des Auslösers.' };
}

/** Eine Regel aus der Eingabe (ohne Thema — das prüft die Route gegen die Datenbank). */
function regelPruefen(b) {
  const text = String((b && b.text) || '').trim();
  if (!text) return { fehler: 'Bitte einen Text für die Meldung angeben (z. B. „TÜV").' };
  if (text.length > 2000) return { fehler: 'Der Text ist zu lang (höchstens 2000 Zeichen).' };
  const liste = Array.isArray(b.ausloeser) ? b.ausloeser : [];
  if (!liste.length) return { fehler: 'Bitte mindestens einen Auslöser angeben.' };
  if (liste.length > 20) return { fehler: 'Höchstens 20 Auslöser je Regel.' };
  const ausloeser = [];
  for (const x of liste) { const r = ausloeserPruefen(x); if (r.fehler) return r; ausloeser.push(r.a); }
  const vorlauf_zahl = ganz(b.vorlauf_zahl == null || b.vorlauf_zahl === '' ? 0 : b.vorlauf_zahl, 0, 365);
  if (vorlauf_zahl == null) return { fehler: 'Der Vorlauf muss eine Zahl zwischen 0 und 365 sein.' };
  const vorlauf_einheit = VORLAUF_EINHEITEN.includes(b.vorlauf_einheit) ? b.vorlauf_einheit : 'tag';
  const uhrzeit = b.uhrzeit == null || b.uhrzeit === '' ? '07:00' : String(b.uhrzeit);
  if (!istUhrzeit(uhrzeit)) return { fehler: 'Ungültige Uhrzeit (erwartet HH:MM).' };
  const takt = b.takt === 'ab_erledigung' ? 'ab_erledigung' : 'fest';
  if (takt === 'ab_erledigung' && !(ausloeser.length === 1 && ausloeser[0].art === 'intervall')) {
    return { fehler: '„Ab Erledigung neu zählen" geht nur mit genau einem Auslöser der Art „alle N …".' };
  }
  const ende_typ = ['nie', 'anzahl', 'datum'].includes(b.ende_typ) ? b.ende_typ : 'nie';
  let ende_anzahl = null, ende_datum = null;
  if (ende_typ === 'anzahl') { ende_anzahl = ganz(b.ende_anzahl, 1, 999); if (ende_anzahl == null) return { fehler: 'Ende nach … Mal: bitte eine Zahl zwischen 1 und 999.' }; }
  if (ende_typ === 'datum') { if (!istDatum(b.ende_datum)) return { fehler: 'Ende am: bitte ein gültiges Datum.' }; ende_datum = b.ende_datum; }
  return { r: { text, dringend: b.dringend ? 1 : 0, vorlauf_zahl, vorlauf_einheit, uhrzeit, takt, ende_typ, ende_anzahl, ende_datum, ausloeser } };
}

// ── Beschreiben ────────────────────────────────────────────────────────────────────────────────────────
const deDatum = (iso) => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
function ausloeserText(a) {
  if (a.art === 'intervall') {
    const namen = { tag: ['Tag', 'Tage'], woche: ['Woche', 'Wochen'], monat: ['Monat', 'Monate'], jahr: ['Jahr', 'Jahre'] }[a.einheit];
    const jede = { tag: 'jeden Tag', woche: 'jede Woche', monat: 'jeden Monat', jahr: 'jedes Jahr' }[a.einheit];
    return `${a.n === 1 ? jede : `alle ${a.n} ${namen[1]}`} ab ${deDatum(a.start_datum)}`;
  }
  const wer = `${a.nth === -1 ? 'letzten' : a.nth + '.'} ${WOCHENTAGE[a.wochentag]}`;
  const startMonat = MONATE[Number(a.start_datum.slice(5, 7)) - 1];
  if (a.n === 1) return `jeden ${wer} im Monat`;
  if (a.n === 12) return `jedes Jahr am ${wer} im ${startMonat}`;
  return `jeden ${wer} alle ${a.n} Monate ab ${startMonat} ${a.start_datum.slice(0, 4)}`;
}

// ── Fälligkeiten ───────────────────────────────────────────────────────────────────────────────────────
function einesAusloesers(a, bis) {
  const aus = [];
  if (a.art === 'intervall') {
    for (let k = 0; k < GRENZE; k++) {
      const d = schritt(a.start_datum, a.einheit, k * a.n);
      if (d > bis) break;
      aus.push(d);
    }
  } else {
    const s = alsDatum(a.start_datum);
    for (let k = 0; k < GRENZE; k++) {
      const m0 = s.getUTCMonth() + k * a.n;
      const y = s.getUTCFullYear() + Math.floor(m0 / 12), m = ((m0 % 12) + 12) % 12;
      if (alsIso(new Date(Date.UTC(y, m, 1))) > bis) break;
      const d = nterWochentag(y, m, a.wochentag, a.nth);
      if (d && d >= a.start_datum && d <= bis) aus.push(d);
    }
  }
  return aus;
}

/**
 * Alle Fälligkeitstage einer Regel bis `bis` (einschließlich), sortiert, ohne Doppel, mit Ende.
 * `basis` nur für Takt „ab Erledigung": das Datum, an dem die letzte Meldung erledigt wurde (oder null).
 */
function faelligkeiten(regel, ausloeser, bis, basis) {
  if (regel.takt === 'ab_erledigung') {
    const a = ausloeser[0];
    if (!a) return [];
    const d = basis ? schritt(basis, a.einheit, a.n) : a.start_datum;
    return d <= bis && (!regel.ende_datum || d <= regel.ende_datum) ? [d] : [];
  }
  const alle = [...new Set(ausloeser.flatMap(a => einesAusloesers(a, bis)))].sort();
  let liste = regel.ende_datum ? alle.filter(d => d <= regel.ende_datum) : alle;
  if (regel.ende_typ === 'anzahl' && regel.ende_anzahl) liste = liste.slice(0, regel.ende_anzahl);
  return liste;
}
const ausloeseMoment = (regel, faellig) => `${vorlaufAbziehen(faellig, regel.vorlauf_zahl, regel.vorlauf_einheit)} ${regel.uhrzeit}`;
// Wie weit muss man vorausrechnen, damit jede Fälligkeit mit Vorlauf erfasst ist?
const vorlaufTage = (regel) => (regel.vorlauf_zahl || 0) * ({ tag: 1, woche: 7, monat: 31 }[regel.vorlauf_einheit] || 1);

/** Die nächsten `anzahl` Fälligkeiten, deren Auslösung noch bevorsteht (Vorschau). */
function vorschau(regel, ausloeser, jetzt, anzahl, basis) {
  const jetztText = berlinJetzt(jetzt).slice(0, 16);
  anzahl = anzahl || 5;
  // So weit vorausrechnen, bis genug da sind — „alle 2 Jahre" braucht für fünf Termine zehn Jahre
  let liste = [];
  for (const jahre of [2, 6, 12, 25, 50]) {
    const bis = plusTage(berlinHeute(jetzt), 366 * jahre + vorlaufTage(regel));
    liste = faelligkeiten(regel, ausloeser, bis, basis)
      .map(d => ({ faellig: d, ausloesung: ausloeseMoment(regel, d) }))
      .filter(x => x.ausloesung > jetztText);
    if (liste.length >= anzahl) break;
  }
  return liste.slice(0, anzahl);
}

// ── Datenbank ──────────────────────────────────────────────────────────────────────────────────────────
const JETZT = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const ausloeserVon = (db, regelId) => db.prepare('SELECT art, einheit, n, start_datum, nth, wochentag FROM meldung_ausloeser WHERE regel_id = ? ORDER BY id').all(regelId);

// „Ab Erledigung": wann wurde die letzte Meldung dieser Regel erledigt (Kalendertag bei uns)?
function letzteErledigung(db, regelId) {
  const r = db.prepare("SELECT status_at FROM meldungen WHERE regel_id = ? AND status = 'erledigt' AND status_at IS NOT NULL ORDER BY status_at DESC LIMIT 1").get(regelId);
  return r ? berlinHeute(new Date(String(r.status_at).replace(' ', 'T') + 'Z')) : null;
}
const offeneMeldung = (db, regelId) =>
  db.prepare("SELECT * FROM meldungen WHERE regel_id = ? AND status IN ('offen', 'in_arbeit') ORDER BY id DESC LIMIT 1").get(regelId);

/** Eine Regel speichern (neu oder geändert). `r` kommt aus regelPruefen. Liefert die Nummer. Keine Transaktion. */
function regelSpeichern(db, id, themaId, r, user, jetzt) {
  // Gültig ab dem Tag des Anlegens bzw. Änderns: Vergangenes wird nie nachgeholt, eine Auslösung HEUTE schon
  const gueltig = berlinHeute(jetzt) + ' 00:00';
  if (id) {
    db.prepare(`UPDATE meldung_regeln SET thema_id = ?, text = ?, dringend = ?, vorlauf_zahl = ?, vorlauf_einheit = ?, uhrzeit = ?,
      takt = ?, ende_typ = ?, ende_anzahl = ?, ende_datum = ?, gueltig_ab = ?, updated_at = ${JETZT}, updated_by = ? WHERE id = ?`)
      .run(themaId, r.text, r.dringend, r.vorlauf_zahl, r.vorlauf_einheit, r.uhrzeit, r.takt, r.ende_typ, r.ende_anzahl, r.ende_datum, gueltig, user.id, id);
    db.prepare('DELETE FROM meldung_ausloeser WHERE regel_id = ?').run(id);
  } else {
    id = db.prepare(`INSERT INTO meldung_regeln (thema_id, text, dringend, vorlauf_zahl, vorlauf_einheit, uhrzeit, takt, ende_typ, ende_anzahl,
      ende_datum, gueltig_ab, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(themaId, r.text, r.dringend, r.vorlauf_zahl, r.vorlauf_einheit, r.uhrzeit, r.takt, r.ende_typ, r.ende_anzahl, r.ende_datum, gueltig, user.id).lastInsertRowid;
  }
  const ins = db.prepare('INSERT INTO meldung_ausloeser (regel_id, art, einheit, n, start_datum, nth, wochentag) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const a of r.ausloeser) ins.run(id, a.art, a.einheit, a.n, a.start_datum, a.nth, a.wochentag);
  return id;
}

/** Regeln (nicht gelöschte) mit Auslösern, Beschreibung und nächster Fälligkeit — für Anzeige und Verwaltung. */
function regelnLesen(db, jetzt, themaId) {
  const zeilen = db.prepare(`SELECT r.*, COALESCE(u.name, 'Gelöschtes Konto') AS von_name FROM meldung_regeln r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.deleted_at IS NULL ${themaId ? 'AND r.thema_id = ?' : ''} ORDER BY r.id`).all(...(themaId ? [themaId] : []));
  return zeilen.map(r => {
    const ausloeser = ausloeserVon(db, r.id);
    const offen = r.takt === 'ab_erledigung' ? offeneMeldung(db, r.id) : null;
    const naechste = r.pausiert || offen ? null : (vorschau(r, ausloeser, jetzt, 1, r.takt === 'ab_erledigung' ? letzteErledigung(db, r.id) : null)[0] || null);
    return { ...r, dringend: !!r.dringend, pausiert: !!r.pausiert, ausloeser,
      beschreibung: ausloeser.map(ausloeserText), naechste, wartet_auf_erledigung: !!offen };
  });
}

// Push einer automatischen Meldung: an alle, die bearbeiten dürfen (einen Melder gibt es nicht).
function pushAnBearbeiter(db, m, titel, text) {
  const { SQL_MELDUNGSBERECHTIGT, SQL_MELDUNGSROLLEN } = require('./meldungrecht');
  let ids = [];
  try {
    ids = db.prepare(`SELECT id FROM users WHERE ${SQL_MELDUNGSBERECHTIGT} AND COALESCE(active,1) = 1`).all(...SQL_MELDUNGSROLLEN).map(x => x.id);
  } catch (_) { return; }
  require('./push').notifyUsers(db, ids, 'meldungen', {
    title: titel, body: text,
    url: '/#/meldungen',
    ziel: { art: 'meldung', id: m.id },
  }, null);
}

/**
 * Der Zeitplaner (minütlich): Was ist fällig? Je Regel höchstens EINE Meldung pro Lauf — die letzte fällige;
 * ältere, verpasste Fälligkeiten werden nur vermerkt (keine Flut nach einem Ausfall). Ist die letzte Meldung der
 * Regel noch offen, bekommt sie „erneut fällig am …" statt einer zweiten. Liefert, was passiert ist (Tests).
 * `benachrichtigen(db, meldung, titel, text)` schickt die Push (routes/meldungen.js reicht sie herein).
 */
function regelnPruefen(db, jetzt, benachrichtigen) {
  jetzt = jetzt || new Date();
  if (benachrichtigen === undefined) benachrichtigen = pushAnBearbeiter;
  const jetztText = berlinJetzt(jetzt).slice(0, 16), heute = berlinHeute(jetzt);
  let regeln;
  try {
    regeln = db.prepare(`SELECT r.*, t.name AS thema_name, COALESCE(u.name, 'Gelöschtes Konto') AS von_name FROM meldung_regeln r
      JOIN meldung_themen t ON t.id = r.thema_id AND t.deleted_at IS NULL
      LEFT JOIN users u ON u.id = r.created_by
      WHERE r.deleted_at IS NULL AND r.pausiert = 0`).all();
  } catch (_) { return []; }   // Tabellen fehlen (sehr alte Sicherung)
  const passiert = [];
  for (const r of regeln) {
    if (r.takt === 'ab_erledigung' && offeneMeldung(db, r.id)) continue;   // erst erledigen, dann zählt es neu
    const ausloeser = ausloeserVon(db, r.id);
    const schon = new Set(db.prepare('SELECT faellig_am FROM meldung_regel_lauf WHERE regel_id = ?').all(r.id).map(x => x.faellig_am));
    const faellig = faelligkeiten(r, ausloeser, plusTage(heute, vorlaufTage(r) + 1), r.takt === 'ab_erledigung' ? letzteErledigung(db, r.id) : null)
      .filter(d => !schon.has(d))
      .filter(d => { const m = ausloeseMoment(r, d); return m <= jetztText && (r.takt === 'ab_erledigung' || m >= r.gueltig_ab); });
    if (!faellig.length) continue;
    const letzte = faellig[faellig.length - 1];
    const ergebnis = db.transaction(() => {
      const offen = offeneMeldung(db, r.id);
      let meldungId, art;
      if (offen) {
        db.prepare(`UPDATE meldungen SET erneut_faellig = ?, updated_at = ${JETZT}, updated_by = NULL WHERE id = ?`).run(letzte, offen.id);
        db.prepare("INSERT INTO meldung_verlauf (meldung_id, art, user_id, user_name, vorher, nachher) VALUES (?, 'erneut_faellig', NULL, 'automatisch', ?, ?)")
          .run(offen.id, offen.erneut_faellig || offen.faellig_am, letzte);
        meldungId = offen.id; art = 'erneut';
      } else {
        meldungId = db.prepare(`INSERT INTO meldungen (thema_id, text, dringend, created_by, updated_by, regel_id, faellig_am)
          VALUES (?, ?, ?, NULL, NULL, ?, ?)`).run(r.thema_id, r.text, r.dringend, r.id, letzte).lastInsertRowid;
        db.prepare("INSERT INTO meldung_verlauf (meldung_id, art, user_id, user_name, vorher, nachher) VALUES (?, 'gemeldet', NULL, ?, NULL, ?)")
          .run(meldungId, `automatisch (Regel von ${r.von_name})`, r.text);
        art = 'neu';
      }
      const lauf = db.prepare('INSERT OR IGNORE INTO meldung_regel_lauf (regel_id, faellig_am, ergebnis, meldung_id) VALUES (?, ?, ?, ?)');
      for (const d of faellig) lauf.run(r.id, d, d === letzte ? art : 'uebersprungen', d === letzte ? meldungId : null);
      require('./audit').logAudit(db, { userId: null, username: 'System', action: 'meldung_automatisch',
        details: `Nr. ${meldungId} · ${r.thema_name}: ${r.text.slice(0, 60)} — ${art === 'neu' ? 'fällig' : 'erneut fällig'} am ${deDatum(letzte)} (Regel Nr. ${r.id}`
          + (faellig.length > 1 ? `, ${faellig.length - 1} verpasste Fälligkeit(en) übersprungen)` : ')') });
      return { regel: r.id, meldung: meldungId, art, faellig: letzte, uebersprungen: faellig.slice(0, -1) };
    })();
    passiert.push(ergebnis);
    if (benachrichtigen) {
      const m = db.prepare('SELECT * FROM meldungen WHERE id = ?').get(ergebnis.meldung);
      benachrichtigen(db, m, ergebnis.art === 'neu' ? `Neue Meldung: ${r.thema_name}` : `Meldung erneut fällig: ${r.thema_name}`,
        `${ergebnis.art === 'neu' ? '' : 'Noch offen: '}${r.text.slice(0, 100)} — fällig am ${deDatum(letzte)}`);
    }
  }
  return passiert;
}

module.exports = { EINHEITEN, VORLAUF_EINHEITEN, WOCHENTAGE, regelPruefen, ausloeserPruefen, ausloeserText, faelligkeiten,
  ausloeseMoment, vorlaufTage, vorschau, plusMonate, plusTage, nterWochentag, schritt, deDatum,
  regelSpeichern, regelnLesen, regelnPruefen, letzteErledigung, pushAnBearbeiter };
