// Persönliche Erinnerungen an eine Notiz (02.10.2026). Alex: „Was bringt mir eine Notiz ‚Arbeit muss bis zum
// $Datum erledigt sein', wenn ich die Notiz verlasse und gleich vergesse?"
//
// Was für alle Erinnerungen gilt (persönlich, Datum + Uhrzeit, verfällt statt nachzukommen, kein Doppelversand),
// steht im gemeinsamen Kern erinnerungen.js. Hier nur, was für NOTIZEN eigen ist (Alex, 02.10.2026):
//   * Stellen darf jeder, der die Notiz sehen kann — Eigentümer, Freigaben (auch nur lesend), bei einer
//     Projektnotiz alle, die sie lesen dürfen (notiz-zugriff.js). Eine Erinnerung ändert an der Notiz nichts.
//   * Nur für die ganze Notiz, nicht für einzelne Checklisten-Punkte (vielleicht später).
//   * Push über den Schalter „Notizen". Antippen führt in die Notizen zur Notiz, hebt sie hervor, und sie trägt
//     die Marke „🔔 Erinnerung". Projektnotizen stehen nicht in der Übersicht — dort führt sie zum Auftrag.
//   * Kann man die Notiz zur Zeit nicht sehen (Freigabe entzogen, Projekt im Papierkorb, ausgestellt), verfällt
//     sie („kein Zugriff"). Wird die Notiz endgültig gelöscht, gehen ihre Erinnerungen mit.
//   * Im Protokoll steht nur der Titel, nie der Inhalt — die Notiz ist persönlich.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (aus Git abgeleitet) — sie muss committet sein.

const kern = require('./erinnerungen');
const { canAccessNote } = require('./notiz-zugriff');

function zustand(db, z) {
  const u = db.prepare('SELECT username, COALESCE(active, 1) AS active FROM users WHERE id = ?').get(z.user_id);
  const { note, access } = canAccessNote(db, z.note_id, z.user_id);
  const kommt = !!u && Number(u.active) === 1 && !!note && !!access;
  return { kommt, grund: kommt ? null : 'kein Zugriff', note, u };
}

/** Wohin der Klick auf die Push führt: in die Notizen — oder bei einer Projektnotiz zum Auftrag. */
function ziel(note) {
  return note && note.projekt_notiz_fuer
    ? { url: '/#/projects', ziel: { art: 'projekt', id: note.projekt_notiz_fuer } }
    : { url: '/#/notes', ziel: { art: 'notiz', id: note ? note.id : null } };
}

function pushAnInhaber(db, z, info) {
  const note = info && info.note;
  const wohin = ziel(note);
  require('./push').notifyUsers(db, [z.user_id], 'notes', {
    title: `🔔 Erinnerung: ${kern.kurz(note ? note.title : 'Notiz', 60)}`,
    body: z.hinweis || 'Du wolltest an diese Notiz erinnert werden.',
    url: wohin.url,
    ziel: wohin.ziel,
  }, null);
}

const art = kern.erinnerungsArt({
  tabelle: 'notiz_erinnerungen',
  zielSpalte: 'note_id',
  zustand,
  push: pushAnInhaber,
  action: { ausgeloest: 'notiz_erinnerung_ausgeloest', verpasst: 'notiz_erinnerung_verpasst' },
  protokoll: (z, info) => `Notiz ${z.note_id} „${kern.kurz(info.note ? info.note.title : '?', 40)}" · für ${(info.u && info.u.username) || 'Gelöschtes Konto'}`,
});

module.exports = { ...art, pushAnInhaber, ziel, zustand };
