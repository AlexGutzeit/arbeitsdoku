// Projektnotiz: EINE gemeinsame Live-Notiz je Projekt (Alex, 28.09.2026).
//
// Technisch eine ganz normale Notiz (Live-Raum, Drucken, Speichern als, Gäste — alles wie gehabt), nur
// ohne persönlichen Eigentümer: `notes.user_id` ist leer, `notes.projekt_notiz_fuer` nennt das Projekt.
// Die Regeln stehen HIER und nur hier — Live-Raum (notizen-live.js), Routen (routes/notes.js,
// routes/projects.js) und Gäste (notiz-gaeste.js, routes/notiz-gaeste.js) fragen alle dieselbe Stelle:
//   * Lesen: jedes aktive Konto.
//   * Schreiben: Chef, Admin und wer dem Projekt zugeteilt ist (Zuteilung ändern gilt sofort).
//   * Projekt im Papierkorb oder weg: kein Zugriff (wie eine gelöschte Notiz).
//   * Erledigte Projekte: unverändert beschreibbar (Alex: Nachträge bleiben möglich).
//   * Gäste einladen: Chef und Admin (Alex).
//   * Meldungen je Bearbeitungsrunde: nur an die Zugeteilten (Alex).
// Angelegt wird die Notiz beim ersten Öffnen (für alle wirkt es, als sei sie immer da gewesen).
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';

const LEITUNG = ['chef', 'admin'];

/** Projekt einer Projektnotiz (auch im Papierkorb) oder null. */
function projektVon(db, note) {
  if (!note || !note.projekt_notiz_fuer) return null;
  return db.prepare('SELECT id, name, deleted_at FROM projects WHERE id = ?').get(note.projekt_notiz_fuer) || null;
}

/**
 * Zugriff eines Nutzers auf eine Projektnotiz: 'write' | 'read' | null (kein Konto/ausgestellt) |
 * undefined (Projekt gelöscht oder weg — für alle wie eine gelöschte Notiz).
 */
function zugriff(db, note, userId) {
  const p = projektVon(db, note);
  if (!p || p.deleted_at) return undefined;
  const u = db.prepare('SELECT role, COALESCE(active, 1) AS active FROM users WHERE id = ?').get(userId);
  if (!u || u.active === 0) return null;
  if (LEITUNG.includes(u.role)) return 'write';
  if (db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(p.id, userId)) return 'write';
  return 'read';
}

/** Darf dieser Nutzer Gäste in die Projektnotiz einladen? (Chef/Admin) */
const darfGaeste = (user) => !!user && LEITUNG.includes(user.role);

/** Wer bekommt die Meldung einer Bearbeitungsrunde: die Zugeteilten. */
function empfaenger(db, projectId) {
  return db.prepare('SELECT user_id FROM project_assignments WHERE project_id = ?').all(projectId).map(r => r.user_id);
}

/** Die Notiz eines Projekts (oder null). */
function notizVon(db, projectId) {
  return db.prepare('SELECT * FROM notes WHERE projekt_notiz_fuer = ?').get(projectId) || null;
}

/**
 * Notiz eines Projekts holen oder — beim ersten Öffnen — anlegen, leer. Liefert die Notiz oder null
 * (Projekt fehlt/gelöscht). Zwei gleichzeitige erste Öffnungen: Der eindeutige Index lässt nur EINE
 * Notiz zu; wer verliert, bekommt die des anderen.
 */
function holenOderAnlegen(db, projectId) {
  const p = db.prepare('SELECT id, name, deleted_at FROM projects WHERE id = ?').get(projectId);
  if (!p || p.deleted_at) return null;
  const da = notizVon(db, p.id);
  if (da) return da;
  const { zeileAusKlartext } = require('./notiz-dokument');
  const z = zeileAusKlartext('');
  try {
    db.prepare(`INSERT INTO notes (user_id, updated_by, title, body, body_delta, ydoc, project_id, project_text, projekt_notiz_fuer, created_at, updated_at)
      VALUES (NULL, NULL, ?, '', ?, ?, NULL, '', ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))`)
      .run(p.name, z.body_delta, z.ydoc, p.id);
  } catch (e) {
    if (!/UNIQUE/.test(e.message)) throw e;
  }
  return notizVon(db, p.id);
}

module.exports = { zugriff, darfGaeste, empfaenger, notizVon, holenOderAnlegen, projektVon, LEITUNG };
