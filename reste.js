// Reste beim Löschen (R27, 28.09.2026).
//
// Die Datenbank läuft OHNE Fremdschlüssel-Schutz (database/init.js schaltet ihn bewusst ab): sql.js hat
// ihn beim Speichern ohnehin jedes Mal abgeschaltet, und ihn wirklich einzuschalten würde das Speichern
// alter Zeilen scheitern lassen, deren Verweis ins Leere zeigt (z. B. Zeiteinträge eines endgültig
// gelöschten Projekts — der Name steht als Text dabei, die Nummer bleibt). Die „ON DELETE CASCADE"-Angaben
// im Schema wirken also NIE. Was mit abhängigen Zeilen geschieht, steht deshalb HIER, an einer Stelle:
//
//   * ANHAENGSEL — Zeilen ohne eigenen Inhalt (Zuweisung, Merker, Einstellung, Verknüpfung), ohne ihr
//     Gegenstück sinnlos. Wer das Gegenstück hart löscht, ruft danach `nachLoeschen(db, '<tabelle>')`.
//     `aufraeumen()` fängt beim Start, nach dem Zurückspielen und einmal am Tag auf, was trotzdem liegen
//     blieb, und schreibt ins Protokoll, was es entfernt hat.
//   * BLEIBT — Inhalt (Zeiteinträge, Abwesenheiten, Planungen, Notizen, Belege …). Wird hier NIE gelöscht,
//     auch wenn der Verweis ins Leere zeigt. Wer so etwas löschen will, tut es ausdrücklich im Lösch-Weg.
//
// Jeder Fremdschlüssel im Schema MUSS in genau einer der beiden Listen stehen — tests/reste.js prüft das
// an einer frisch angelegten Datenbank. Neue Tabelle mit Verweis → hier einordnen, sonst wird der Test rot.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';

// Reihenfolge zählt: erst die Anhängsel der Konten, Notizen, Projekte …, dann die Anhängsel der
// Anhängsel (Versand-Merker hängen an Erinnerungen, die selbst an einem Konto hängen).
const ANHAENGSEL = [
  ['planning_assignments', 'planning_id', 'planning_entries', 'Planungs-Zuweisungen zu gelöschten Planungen'],
  ['planning_assignments', 'user_id', 'users', 'Planungs-Zuweisungen an gelöschte Konten'],
  ['planning_reminders', 'user_id', 'users', 'Erinnerungen gelöschter Konten'],
  ['note_shares', 'note_id', 'notes', 'Freigaben gelöschter Notizen'],
  ['note_shares', 'user_id', 'users', 'Freigaben an gelöschte Konten'],
  ['note_offers', 'note_id', 'notes', 'Angebote gelöschter Notizen'],
  ['note_offers', 'to_user_id', 'users', 'Angebote an gelöschte Konten'],
  ['note_offers', 'from_user_id', 'users', 'Angebote gelöschter Konten'],
  ['project_assignments', 'project_id', 'projects', 'Projekt-Zuteilungen gelöschter Projekte'],
  ['project_assignments', 'user_id', 'users', 'Projekt-Zuteilungen gelöschter Konten'],
  ['project_category_links', 'project_id', 'projects', 'Kategorie-Zuordnungen gelöschter Projekte'],
  ['project_category_links', 'category_id', 'project_categories', 'Zuordnungen gelöschter Kategorien'],
  ['project_milestones', 'project_id', 'projects', 'Zwischenziele gelöschter Projekte'],
  ['product_barcodes', 'product_id', 'products', 'Barcodes gelöschter Produkte'],
  ['product_suppliers', 'product_id', 'products', 'Bezugsquellen gelöschter Produkte'],
  ['product_suppliers', 'supplier_id', 'suppliers', 'Bezugsquellen gelöschter Großhändler'],
  ['tool_checkouts', 'tool_id', 'tools', 'Ausleihen gelöschter Werkzeuge'],
  ['employment_periods', 'user_id', 'users', 'Anstellungszeiträume gelöschter Konten'],
  ['user_target_hours', 'user_id', 'users', 'Soll-Stunden gelöschter Konten'],
  ['vacation_entitlements', 'user_id', 'users', 'Urlaubsansprüche gelöschter Konten'],
  ['user_seen', 'user_id', 'users', 'Gesehen-Merker gelöschter Konten'],
  ['user_sitzung', 'user_id', 'users', 'Sitzungen gelöschter Konten'],
  ['user_avatars', 'user_id', 'users', 'Profilbilder gelöschter Konten'],
  ['geburtstag_freigabe', 'user_id', 'users', 'Geburtstags-Freigaben gelöschter Konten'],
  ['push_prefs', 'user_id', 'users', 'Meldungs-Einstellungen gelöschter Konten'],
  ['push_subscriptions', 'user_id', 'users', 'Push-Anmeldungen gelöschter Konten'],
  ['summary_schedules', 'user_id', 'users', 'Zusammenfassungen gelöschter Konten'],
  ['warnung_prefs', 'user_id', 'users', 'Warn-Einstellungen gelöschter Konten'],
  ['twofa_secrets', 'user_id', 'users', 'Zwei-Faktor-Schlüssel gelöschter Konten'],
  ['twofa_devices', 'user_id', 'users', 'Gemerkte Geräte gelöschter Konten'],
  ['meldung_verlauf', 'meldung_id', 'meldungen', 'Verlauf gelöschter Meldungen'],
  ['meldung_ausloeser', 'regel_id', 'meldung_regeln', 'Auslöser gelöschter Regeln'],
  ['meldung_regel_lauf', 'regel_id', 'meldung_regeln', 'Auslöse-Merker gelöschter Regeln'],
  // zweite Stufe
  ['planning_reminder_sent', 'reminder_id', 'planning_reminders', 'Versand-Merker gelöschter Erinnerungen'],
].map(([tabelle, spalte, auf, text]) => ({ tabelle, spalte, auf, text }));

// Inhalt: bleibt stehen, auch wenn der Verweis ins Leere zeigt. Grund steht dabei.
const BLEIBT = [
  ['entries', 'user_id', 'users', 'Zeiteinträge: Aufbewahrung'],
  ['entries', 'project_id', 'projects', 'Zeiteinträge: Projektname steht als Text dabei'],
  ['absences', 'user_id', 'users', 'Abwesenheiten: Aufbewahrung'],
  ['absences', 'processed_by', 'users', 'nur Vermerk, wer bearbeitet hat'],
  ['planning_entries', 'created_by', 'users', 'Planung: gehört allen Eingeteilten, nicht dem Ersteller'],
  ['planning_entries', 'project_id', 'projects', 'Planung: Projektname steht als Text dabei'],
  ['planning_series', 'created_by', 'users', 'Serien-Regel: gehört zu ihren Planungen'],
  ['notes', 'user_id', 'users', 'Notiz-Inhalt'],
  ['notes', 'project_id', 'projects', 'Notiz-Inhalt; Projektname steht als Text dabei'],
  ['orders', 'user_id', 'users', 'Bestellung'],
  ['orders', 'ordered_by', 'users', 'nur Vermerk, wer bestellt hat'],
  ['bulletin_entries', 'created_by', 'users', 'Aushang'],
  ['documents', 'folder_id', 'doc_folders', 'Dokument mit Datei auf der Platte — nur der Ordner-Löschweg entfernt es'],
  ['documents', 'uploaded_by', 'users', 'nur Vermerk, wer hochgeladen hat'],
  ['doc_folders', 'parent_id', 'doc_folders', 'Ordner mit Inhalt — nur der Ordner-Löschweg entfernt ihn'],
  ['doc_folders', 'created_by', 'users', 'nur Vermerk, wer angelegt hat'],
  ['payroll_closure_rows', 'closure_id', 'payroll_closures', 'Abrechnungs-Beleg — nur mit seinem Abschluss zu löschen'],
  ['products', 'category_id', 'product_categories', 'Produkt'],
  ['tool_checkouts', 'user_id', 'users', 'Ausleih-Verlauf'],
  ['tool_checkouts', 'project_id', 'projects', 'Ausleih-Verlauf; Projektname steht als Text dabei'],
  ['meldungen', 'thema_id', 'meldung_themen', 'Meldung — ihr Thema bleibt weich gelöscht erhalten (History)'],
  ['meldungen', 'created_by', 'users', 'Meldung (bleibt wie Bestellungen; Name „Gelöschtes Konto")'],
  ['meldung_regeln', 'thema_id', 'meldung_themen', 'Regel — weich gelöscht mit ihrem Thema'],
].map(([tabelle, spalte, auf, grund]) => ({ tabelle, spalte, auf, grund }));

const loeschSql = (a) =>
  `DELETE FROM ${a.tabelle} WHERE ${a.spalte} IS NOT NULL AND ${a.spalte} NOT IN (SELECT id FROM ${a.auf})`;

// Welche Beziehungen hängen (auch über eine Stufe) an diesen Tabellen?
function betroffen(tabellen) {
  const eltern = new Set(tabellen);
  let mehr = true;
  while (mehr) {
    mehr = false;
    for (const a of ANHAENGSEL) if (eltern.has(a.auf) && !eltern.has(a.tabelle)) { eltern.add(a.tabelle); mehr = true; }
  }
  return ANHAENGSEL.filter(a => eltern.has(a.auf));
}

function entfernen(db, liste) {
  const weg = [];
  for (const a of liste) {
    let n = 0;
    try { n = db.prepare(loeschSql(a)).run().changes; } catch (_) { /* Tabelle fehlt (ältere Sicherung) */ }
    if (n) weg.push({ text: a.text, anzahl: n });
  }
  return weg;
}

/**
 * Nach einem harten Löschen: die Anhängsel der genannten Tabelle(n) mit entfernen. Leise, ohne Protokoll —
 * das Löschen selbst ist protokolliert (oder bewusst nicht). Liefert [{ text, anzahl }].
 */
function nachLoeschen(db, ...tabellen) {
  return entfernen(db, betroffen(tabellen));
}

/**
 * Alles Liegengebliebene entfernen (Start, Zurückspielen, Tageslauf). Schreibt ins Protokoll, wenn etwas
 * da war. Liefert [{ text, anzahl }].
 */
function aufraeumen(db, anlass) {
  const weg = entfernen(db, ANHAENGSEL);
  if (weg.length) {
    const details = `${anlass || 'Aufräumen'}: ` + weg.map(w => `${w.anzahl} ${w.text}`).join(', ');
    console.log('[reste] ' + details);
    try {
      require('./audit').logAudit(db, { userId: null, username: 'System', action: 'reste_aufgeraeumt', details });
    } catch (e) { console.error('reste: Protokoll fehlgeschlagen:', e.message); }
  }
  return weg;
}

module.exports = { ANHAENGSEL, BLEIBT, nachLoeschen, aufraeumen };
