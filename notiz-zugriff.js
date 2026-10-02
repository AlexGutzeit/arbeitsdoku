// Wer darf eine Notiz sehen — und wie? (aus routes/notes.js herausgezogen, 02.10.2026)
//
// Die Route und der Zeitplaner der Notiz-Erinnerungen (notiz-erinnerungen.js) stellen dieselbe Frage. Damit die
// Antwort nicht an zwei Stellen auseinanderläuft, steht sie hier einmal.
//   'owner'            eigene Notiz
//   'write' | 'read'   Freigabe; bei einer Projektnotiz Rolle und Zuteilung (projekt-notiz.js)
//   null               kein Zugriff
// Eine Projektnotiz, deren Projekt gelöscht ist (Papierkorb), gibt es für niemanden: { note: null }.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (aus Git abgeleitet) — sie muss committet sein.
const projektNotiz = require('./projekt-notiz');

function canAccessNote(db, noteId, userId) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  if (!note) return { note: null, access: null };
  // Projektnotiz: Rolle und Zuteilung (projekt-notiz.js); Projekt gelöscht → wie nicht vorhanden
  if (note.projekt_notiz_fuer) {
    const z = projektNotiz.zugriff(db, note, userId);
    return z === undefined ? { note: null, access: null } : { note, access: z };
  }
  if (note.user_id === userId) return { note, access: 'owner' };
  const share = db.prepare('SELECT permission FROM note_shares WHERE note_id = ? AND user_id = ?').get(noteId, userId);
  if (!share) return { note, access: null };
  return { note, access: share.permission };
}

module.exports = { canAccessNote };
