// Mitarbeiter endgültig löschen (Alex, 28.09.2026).
//
// Nur der Admin, nur ein zuvor ausgestelltes Konto — gedacht für Testkonten. Der Chef kann ohnehin nur
// ausstellen, dabei geht nichts verloren. Beim endgültigen Löschen geht dann wirklich, was NUR dieser Person
// gehört; was andere betrifft, bleibt:
//   geht:     Zeiteinträge (auch im Papierkorb) samt Änderungsverlauf, Abwesenheiten samt Verlauf, eigene
//             Notizen (auch geteilte, samt Gästen), Planungen, in denen nur sie eingeteilt ist, Werkzeug-
//             Ausleihen — und alle Anhängsel des Kontos (Einstellungen, Soll-Stunden, Urlaub, Einteilungen …,
//             reste.js) samt Profilbild-Dateien.
//   bleibt:   Planungen mit anderen (sie wird ausgetragen), Planungen und Serien, die sie für andere angelegt
//             hat, Bestellungen und Aushänge (die löschen sich nach ihrer Frist selbst), Meldungen (History), Projektnotizen,
//             Dokumente, Audit-Log. Wo der Name fehlt, zeigt die App „Gelöschtes Konto".
//   gesperrt: Wer in einer abgeschlossenen Abrechnung, einem übernommenen Nachtrag oder einer Überstunden-
//             Auszahlung steht — sonst käme die Abrechnung durcheinander (Alex). Dort bleibt es beim Ausstellen.
//
// Bis R27 versprach der Knopf genau das, ließ den Inhalt aber stehen (der Fremdschlüssel-Schutz, auf den er
// sich verließ, wirkte nie). `altlastenAufraeumen` holt das für die früh gelöschten Testkonten EINMAL nach.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';

const fs = require('fs');
const reste = require('./reste');
const planung = () => require('./routes/planning');   // erst beim Aufruf: die Route lädt ihrerseits die Datenbank

const SPERRE = [
  ['payroll_closure_rows', 'in einer abgeschlossenen Abrechnung'],
  ['payroll_adjustments', 'in einem übernommenen Nachtrag'],
  ['overtime_payouts', 'in einer Überstunden-Auszahlung'],
];
const zahl = (db, sql, ...p) => { try { return db.prepare(sql).get(...p).n; } catch (_) { return 0; } };

/** Warum dieses Konto NICHT endgültig gelöscht werden darf — oder null. */
function sperre(db, userId) {
  const wo = SPERRE.filter(([t]) => zahl(db, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, userId) > 0).map(([, w]) => w);
  if (!wo.length) return null;
  return `Dieses Konto steht ${wo.join(' und ')}. Endgültig löschen würde die Abrechnung durcheinanderbringen — `
    + 'ausgestellt bleibt es mit allen Daten erhalten.';
}

// Planungen, in denen NUR diese Person eingeteilt ist (Einteilungen an längst gelöschte Konten zählen nicht mit)
const NUR_SIE = `SELECT pe.id FROM planning_entries pe
  WHERE EXISTS (SELECT 1 FROM planning_assignments pa WHERE pa.planning_id = pe.id AND pa.user_id = ?)
    AND NOT EXISTS (SELECT 1 FROM planning_assignments pa JOIN users u ON u.id = pa.user_id
                     WHERE pa.planning_id = pe.id AND pa.user_id <> ?)`;
const nurSie = (db, userId) => db.prepare(NUR_SIE).all(userId, userId).map(r => r.id);

/** Was beim endgültigen Löschen geht und was bleibt — für den Bestätigungsdialog. */
function vorschau(db, userId) {
  const weg = nurSie(db, userId);
  const liste = weg.length ? weg.join(',') : '0';
  return {
    geht: {
      eintraege: zahl(db, 'SELECT COUNT(*) AS n FROM entries WHERE user_id = ?', userId),
      abwesenheiten: zahl(db, 'SELECT COUNT(*) AS n FROM absences WHERE user_id = ?', userId),
      notizen: zahl(db, 'SELECT COUNT(*) AS n FROM notes WHERE user_id = ?', userId),
      planungen: weg.length,
      werkzeug: zahl(db, 'SELECT COUNT(*) AS n FROM tool_checkouts WHERE user_id = ?', userId),
    },
    bleibt: {
      planungenMitAnderen: zahl(db, `SELECT COUNT(DISTINCT planning_id) AS n FROM planning_assignments
        WHERE user_id = ? AND planning_id IN (SELECT id FROM planning_entries) AND planning_id NOT IN (${liste})`, userId),
      planungenFuerAndere: zahl(db, `SELECT COUNT(*) AS n FROM planning_entries WHERE created_by = ? AND id NOT IN (${liste})
        AND id NOT IN (SELECT planning_id FROM planning_assignments WHERE user_id = ?)`, userId, userId),
      bestellungen: zahl(db, 'SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', userId),
      aushaenge: zahl(db, 'SELECT COUNT(*) AS n FROM bulletin_entries WHERE created_by = ?', userId),
      meldungen: zahl(db, 'SELECT COUNT(*) AS n FROM meldungen WHERE created_by = ?', userId),
    },
  };
}

/**
 * Den Inhalt eines Kontos löschen (nicht das Konto selbst, nicht seine Anhängsel — das macht der Aufrufer
 * danach mit reste.nachLoeschen). Öffnet KEINE Transaktion: der Aufrufer fasst alles in eine.
 * Liefert { zahlen, notizen } — die Notiz-Nummern, damit der Aufrufer offene Live-Räume schließen kann.
 */
function inhaltLoeschen(db, userId) {
  const { planungenLoeschen, pruneOrphanReminders } = planung();
  const z = { planungen: 0, eintraege: 0, abwesenheiten: 0, notizen: 0, werkzeug: 0 };

  // Planungen nur mit ihr — in Paketen (Obergrenze für Platzhalter), Einteilungen gehen mit
  const ids = nurSie(db, userId);
  for (let i = 0; i < ids.length; i += 400) {
    const teil = ids.slice(i, i + 400);
    z.planungen += planungenLoeschen(db, `id IN (${teil.map(() => '?').join(',')})`, ...teil).changes;
  }
  if (ids.length) pruneOrphanReminders(db);   // Erinnerungen anderer an diese Termine

  // Serien: ohne verbliebene Termine weg; sonst sie aus der Vorlage nehmen, damit der Zeitplaner sie nicht
  // wieder einteilt — und eine Serie, in deren Vorlage niemand mehr steht, anhalten.
  for (const s of db.prepare('SELECT series_id, created_by, template FROM planning_series').all()) {
    let tpl; try { tpl = JSON.parse(s.template || '{}'); } catch (_) { tpl = {}; }
    const vorlage = Array.isArray(tpl.assigned_user_ids) ? tpl.assigned_user_ids.map(Number) : [];
    if (s.created_by !== Number(userId) && !vorlage.includes(Number(userId))) continue;
    if (!zahl(db, 'SELECT COUNT(*) AS n FROM planning_entries WHERE series_id = ?', s.series_id)) {
      db.prepare('DELETE FROM planning_series WHERE series_id = ?').run(s.series_id);
      continue;
    }
    if (vorlage.includes(Number(userId))) {
      tpl.assigned_user_ids = vorlage.filter(id => id !== Number(userId));
      db.prepare('UPDATE planning_series SET template = ?, active = CASE WHEN ? = 0 THEN 0 ELSE active END WHERE series_id = ?')
        .run(JSON.stringify(tpl), tpl.assigned_user_ids.length, s.series_id);
    }
  }

  // Zeiteinträge und Abwesenheiten — auch die im Papierkorb — samt ihrem Änderungsverlauf
  db.prepare('DELETE FROM entry_history WHERE entry_id IN (SELECT id FROM entries WHERE user_id = ?)').run(userId);
  z.eintraege = db.prepare('DELETE FROM entries WHERE user_id = ?').run(userId).changes;
  db.prepare('DELETE FROM absence_history WHERE absence_id IN (SELECT id FROM absences WHERE user_id = ?)').run(userId);
  z.abwesenheiten = db.prepare('DELETE FROM absences WHERE user_id = ?').run(userId).changes;

  // Eigene Notizen (Projektnotizen haben keinen Eigentümer und bleiben) — mit Freigaben, Angeboten, Merkern, Gästen
  const notizen = db.prepare('SELECT id FROM notes WHERE user_id = ?').all(userId).map(r => r.id);
  for (const id of notizen) {
    for (const t of ['note_shares', 'note_offers', 'note_gesehen', 'note_gaeste', 'notiz_erinnerungen']) {
      try { db.prepare(`DELETE FROM ${t} WHERE note_id = ?`).run(id); } catch (_) { /* Tabelle fehlt in alten Ständen */ }
    }
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }
  z.notizen = notizen.length;

  z.werkzeug = db.prepare('DELETE FROM tool_checkouts WHERE user_id = ?').run(userId).changes;
  return { zahlen: z, notizen };
}

/** Profilbild-Dateien des Kontos von der Platte (die Zeile in user_avatars ist ein Anhängsel, reste.js). */
function profilbildWeg(userId) {
  try {
    const { dateiFuer, GROESSEN } = require('./routes/avatare');
    for (const g of [...Object.keys(GROESSEN), 'original']) { try { fs.unlinkSync(dateiFuer(userId, g)); } catch (_) { /* schon weg */ } }
  } catch (_) { /* ohne Profilbild-Modul nichts zu tun */ }
}

/** „142 Zeiteinträge, 3 Abwesenheiten …" — nur was es gab. */
function beschreiben(z) {
  const teile = [[z.eintraege, 'Zeiteintrag', 'Zeiteinträge'], [z.abwesenheiten, 'Abwesenheit', 'Abwesenheiten'],
    [z.notizen, 'Notiz', 'Notizen'], [z.planungen, 'Planung', 'Planungen'], [z.werkzeug, 'Werkzeug-Ausleihe', 'Werkzeug-Ausleihen']]
    .filter(([n]) => n).map(([n, e, m]) => `${n} ${n === 1 ? e : m}`);
  return teile.length ? teile.join(', ') : 'kein Inhalt';
}

const MERKER = 'altlasten_geloeschte_konten';

/**
 * EINMAL: Inhalt früh gelöschter Konten (Alex, 28.09.2026: „Können weg. Waren Testläufe."). Nach derselben
 * Regel wie oben — und dazu die Planungen, die diese Konten angelegt haben: Die Planung zeigte bis R27 nur
 * Termine mit vorhandenem Ersteller, sie waren also seither unsichtbar und tauchten sonst jetzt wieder auf.
 * Konten, die in einer Abrechnung stehen, bleiben unberührt. Der Merker verhindert einen zweiten Lauf.
 */
function altlastenAufraeumen(db) {
  try { if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MERKER)) return null; } catch (_) { return null; }
  const quellen = ['SELECT user_id AS id FROM entries', 'SELECT user_id FROM absences', 'SELECT user_id FROM notes',
    'SELECT user_id FROM planning_assignments', 'SELECT created_by FROM planning_entries', 'SELECT user_id FROM tool_checkouts',
    'SELECT created_by FROM planning_series'];
  let fehlend = [];
  try {
    fehlend = db.prepare(`SELECT DISTINCT id FROM (${quellen.join(' UNION ')}) WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM users) ORDER BY id`)
      .all().map(r => r.id);
  } catch (e) { console.error('altlastenAufraeumen: Bestand nicht lesbar:', e.message); return null; }

  const summe = { planungen: 0, eintraege: 0, abwesenheiten: 0, notizen: 0, werkzeug: 0 };
  const konten = [];
  // Beim Löschen der Planungen räumt reste.nachLoeschen ALLE Einteilungen ohne Planung mit ab — beim ersten
  // Lauf auch die seit Monaten liegengebliebenen. Damit das Protokoll jede entfernte Zeile erklärt, wird der
  // Stand der Anhängsel-Tabellen vorher und nachher gezählt.
  const namen = {};
  for (const a of reste.ANHAENGSEL) if (!namen[a.tabelle]) namen[a.tabelle] = a.text.replace(/ (zu|an|gelöschter|gelöschten|gelöschte)\b.*$/, '');
  const stand = () => Object.fromEntries(Object.keys(namen).map(t => [t, zahl(db, `SELECT COUNT(*) AS n FROM ${t}`)]));
  const vorher = stand();
  db.transaction(() => {
    for (const id of fehlend) {
      if (sperre(db, id)) continue;
      const { zahlen } = inhaltLoeschen(db, id);
      zahlen.planungen += planung().planungenLoeschen(db, 'created_by = ?', id).changes;
      for (const k of Object.keys(summe)) summe[k] += zahlen[k];
      if (Object.values(zahlen).some(n => n)) konten.push(id);
      profilbildWeg(id);
    }
    planung().pruneOrphanReminders(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, strftime('%Y-%m-%d %H:%M', 'now'))").run(MERKER);
  })();
  if (konten.length) {
    const nachher = stand();
    const dabei = Object.keys(namen).filter(t => vorher[t] > nachher[t]).map(t => `${vorher[t] - nachher[t]} ${namen[t]}`);
    const details = `Inhalt früh gelöschter Konten (Nr. ${konten.join(', ')}): ${beschreiben(summe)}`
      + (dabei.length ? ` — dabei mit weggeräumt: ${dabei.join(', ')}` : '');
    console.log('[reste] ' + details);
    require('./audit').logAudit(db, { userId: null, username: 'System', action: 'reste_aufgeraeumt', details });
  }
  return { konten, zahlen: summe };
}

module.exports = { sperre, vorschau, inhaltLoeschen, profilbildWeg, beschreiben, altlastenAufraeumen, MERKER };
