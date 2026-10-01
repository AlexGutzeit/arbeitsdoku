// Persönliche Erinnerungen an eine Meldung (01.10.2026): „TÜV-Termin in vier Wochen — erinnere mich am 27.10.
// um 7 Uhr". Ohne sie vergisst man den Termin, weil die Meldung längst gelesen ist (Alex).
//
// Festlegungen (Alex, 01.10.2026):
//   * Eine Erinnerung gehört NUR dem, der sie anlegt. Sie erinnert nur ihn, andere sehen sie nicht. Deshalb steht
//     sie nicht im Verlauf der Meldung (den alle lesen), sondern nur im Protokoll.
//   * Anlegen dürfen nur Bearbeiter (meldungrecht.js). Wer das Recht verliert oder ausgestellt wird, bekommt
//     keine mehr — seine Erinnerungen verfallen zu ihrer Zeit.
//   * Zur Zeit `um` (deutsche Ortszeit, 'JJJJ-MM-TT HH:MM'): Push (Schalter „Meldungen"), Zähler am Menü und die
//     Marke „🔔 Erinnerung" an der Karte.
//   * Steht die Meldung in der History (erledigt, zurückgezogen, Thema gelöscht), RUHT die Erinnerung. Fällt ihre
//     Zeit in diese Pause, VERFÄLLT sie („in der Pause verpasst") und kommt beim Wiederöffnen nicht nach. Spätere
//     sind nach dem Wiederöffnen wieder aktiv. Gelöscht wird dabei nichts; ein neues Datum macht eine verfallene
//     oder schon ausgelöste Erinnerung wieder scharf.
//   * Einmalig. Was wiederkehrt, sind regelmäßige Meldungen (meldung-regeln.js).
//
// stand:  wartet → ausgeloest | verpasst. `stand_am` ist UTC wie updated_at — der Zähler (routes/badges.js)
// vergleicht es mit user_seen. Lief der Server zur Zeit `um` nicht, holt der nächste Lauf die Erinnerung nach,
// sofern die Meldung dann noch aktiv ist: „verpasst" heißt nur, die Meldung ruhte oder das Recht fehlte.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (aus Git abgeleitet) — sie muss committet sein.

const { berlinJetzt, istDatum, istUhrzeit } = require('./zeit');
const { darfMeldungenBearbeiten } = require('./meldungrecht');

const MAX_HINWEIS = 200;
const MAX_JE_MELDUNG = 20;          // je Person und Meldung; mehr ist ein Versehen
const JETZT = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const STAND = { wartet: 'wartet', ausgeloest: 'ausgeloest', verpasst: 'verpasst' };

const kurz = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** „2026-10-27 07:00" → „Di 27.10.2026, 07:00" */
function umText(um) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(String(um || ''));
  if (!m) return String(um || '');
  const wt = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`).getUTCDay()];
  return `${wt} ${m[3]}.${m[2]}.${m[1]}, ${m[4]}`;
}

/** Eingabe prüfen: Datum + Uhrzeit (deutsche Ortszeit), in der Zukunft; Hinweis freiwillig. */
function pruefen(b, jetzt) {
  b = b || {};
  const datum = String(b.datum || ''), uhrzeit = String(b.uhrzeit || '');
  if (!istDatum(datum)) return { fehler: 'Bitte wähle ein Datum.' };
  if (!istUhrzeit(uhrzeit)) return { fehler: 'Bitte gib eine Uhrzeit an (z. B. 07:00).' };
  const um = `${datum} ${uhrzeit}`;
  if (um <= berlinJetzt(jetzt).slice(0, 16)) return { fehler: 'Dieser Zeitpunkt ist schon vorbei — bitte einen späteren wählen.' };
  const hinweis = String(b.hinweis == null ? '' : b.hinweis).replace(/\s+/g, ' ').trim();
  if (hinweis.length > MAX_HINWEIS) return { fehler: `Der Hinweis ist zu lang (höchstens ${MAX_HINWEIS} Zeichen).` };
  return { um, hinweis: hinweis || null };
}

/** Aktiv = offen oder in Arbeit, Thema nicht gelöscht. Sonst steht sie in der History, und Erinnerungen ruhen. */
const meldungAktiv = (m) => !!m && (m.status === 'offen' || m.status === 'in_arbeit') && !m.thema_geloescht_am;

/** Die eigenen Erinnerungen zu einer Reihe von Meldungen: Map meldung_id → [{ id, um, hinweis, stand, stand_am, grund }]. */
function eigeneZu(db, userId, meldungIds) {
  const aus = new Map();
  if (!meldungIds.length) return aus;
  let zeilen = [];
  try {
    for (let i = 0; i < meldungIds.length; i += 400) {
      const teil = meldungIds.slice(i, i + 400);
      zeilen = zeilen.concat(db.prepare(`SELECT id, meldung_id, um, hinweis, stand, stand_am, grund FROM meldung_erinnerungen
        WHERE user_id = ? AND meldung_id IN (${teil.map(() => '?').join(',')}) ORDER BY um, id`).all(userId, ...teil));
    }
  } catch (_) { return aus; }   // Tabelle fehlt (sehr alte Sicherung)
  for (const z of zeilen) {
    if (!aus.has(z.meldung_id)) aus.set(z.meldung_id, []);
    aus.get(z.meldung_id).push({ id: z.id, um: z.um, hinweis: z.hinweis, stand: z.stand, stand_am: z.stand_am, grund: z.grund });
  }
  return aus;
}

/** Eine eigene Erinnerung (fremde gibt es für den Fragenden nicht). */
function eigene(db, userId, id) {
  return db.prepare('SELECT * FROM meldung_erinnerungen WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

function anzahl(db, userId, meldungId) {
  return db.prepare('SELECT COUNT(*) AS n FROM meldung_erinnerungen WHERE user_id = ? AND meldung_id = ?').get(userId, meldungId).n;
}

function anlegen(db, userId, meldungId, e) {
  return db.prepare('INSERT INTO meldung_erinnerungen (meldung_id, user_id, um, hinweis) VALUES (?, ?, ?, ?)')
    .run(meldungId, userId, e.um, e.hinweis).lastInsertRowid;
}

/** Neues Datum/Hinweis. Eine ausgelöste oder verfallene Erinnerung wird damit wieder scharf. */
function aendern(db, id, e) {
  db.prepare(`UPDATE meldung_erinnerungen SET um = ?, hinweis = ?, stand = ?, stand_am = NULL, grund = NULL, updated_at = ${JETZT} WHERE id = ?`)
    .run(e.um, e.hinweis, STAND.wartet, id);
}

function entfernen(db, id) {
  db.prepare('DELETE FROM meldung_erinnerungen WHERE id = ?').run(id);
}

// Push an den einen, der die Erinnerung gestellt hat — über den Schalter „Meldungen" (Alex). Antippen führt zur
// Meldung und hebt sie hervor (ziel, wie seit R30 überall).
function pushAnInhaber(db, e) {
  require('./push').notifyUsers(db, [e.user_id], 'meldungen', {
    title: `🔔 Erinnerung: ${e.thema_name}`,
    body: (e.hinweis ? `${e.hinweis} — ` : '') + kurz(e.text, 100),
    url: '/#/meldungen',
    ziel: { art: 'meldung', id: e.meldung_id },
  }, null);
}

/**
 * Der Zeitplaner (minütlich): alle wartenden Erinnerungen, deren Zeit erreicht ist. Aktive Meldung und Recht
 * vorhanden → auslösen (Push), sonst → verfällt. Liefert, was passiert ist (Tests). `benachrichtigen(db, e)`
 * schickt die Push; Tests reichen eine eigene herein.
 */
function faelligePruefen(db, jetzt, benachrichtigen) {
  jetzt = jetzt || new Date();
  if (benachrichtigen === undefined) benachrichtigen = pushAnInhaber;
  let zeilen;
  try {
    zeilen = db.prepare(`SELECT e.*, m.status, m.text, t.name AS thema_name, t.deleted_at AS thema_geloescht_am,
        u.role, u.can_meldungen, u.active, u.username
      FROM meldung_erinnerungen e
      JOIN meldungen m ON m.id = e.meldung_id
      LEFT JOIN meldung_themen t ON t.id = m.thema_id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.stand = ? AND e.um <= ? ORDER BY e.um, e.id`).all(STAND.wartet, berlinJetzt(jetzt).slice(0, 16));
  } catch (_) { return []; }   // Tabellen fehlen (sehr alte Sicherung)
  const passiert = [];
  for (const e of zeilen) {
    const darf = e.role != null && Number(e.active ?? 1) === 1 && darfMeldungenBearbeiten(e);
    const aktiv = meldungAktiv(e);
    const stand = darf && aktiv ? STAND.ausgeloest : STAND.verpasst;
    const grund = !darf ? 'ohne Recht' : !aktiv ? 'Meldung ruhte' : null;
    // Erst vermerken, dann senden: Läuft der nächste Takt dazwischen, käme sonst eine zweite Push
    const n = db.prepare(`UPDATE meldung_erinnerungen SET stand = ?, stand_am = ${JETZT}, grund = ? WHERE id = ? AND stand = ?`)
      .run(stand, grund, e.id, STAND.wartet).changes;
    if (!n) continue;
    auditErinnerung(db, stand === STAND.ausgeloest ? 'meldung_erinnerung_ausgeloest' : 'meldung_erinnerung_verpasst',
      `Nr. ${e.meldung_id} · ${e.thema_name || '?'} · für ${e.username || 'Gelöschtes Konto'} · ${umText(e.um)}`
        + (grund ? ` (${grund})` : '') + `: ${kurz(e.text, 40)}`);
    passiert.push({ id: e.id, meldung: e.meldung_id, user: e.user_id, stand, grund });
    if (stand === STAND.ausgeloest && benachrichtigen) {
      try { benachrichtigen(db, e); } catch (err) { console.error('Meldungs-Erinnerung: Push fehlgeschlagen:', err && err.message); }
    }
  }
  return passiert;
}

function auditErinnerung(db, action, details) {
  require('./audit').logAudit(db, { userId: null, username: 'System', action, details });
}

module.exports = { MAX_HINWEIS, MAX_JE_MELDUNG, STAND, umText, pruefen, meldungAktiv, eigeneZu, eigene, anzahl,
  anlegen, aendern, entfernen, faelligePruefen, pushAnInhaber };
