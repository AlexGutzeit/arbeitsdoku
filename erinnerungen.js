// Persönliche Erinnerungen — der gemeinsame Kern (Meldungen 01.10.2026, Notizen 02.10.2026).
//
// Was für jede Art gleich ist, steht HIER und nur hier:
//   * Eine Erinnerung gehört dem, der sie stellt. Sie erinnert nur ihn, andere sehen sie nicht.
//   * Eingabe: Datum + Uhrzeit (deutsche Ortszeit 'JJJJ-MM-TT HH:MM'), in der Zukunft; Hinweis freiwillig.
//   * stand: wartet → ausgeloest | verpasst. `stand_am` ist UTC wie updated_at (der Zähler vergleicht mit
//     user_seen), `grund` sagt, warum eine verpasst ist.
//   * Zur Zeit: Kommt die Erinnerung an (Adapter sagt `kommt`), wird sie vermerkt und gesendet; sonst VERFÄLLT
//     sie — wer zur Zeit keinen Zugang hatte, bekommt sie auch später nicht nachgereicht. Lief der Server zur
//     Zeit nicht, holt der nächste Lauf sie nach, sofern sie dann noch ankommt.
//   * Erst vermerken, dann senden (`UPDATE … WHERE stand = 'wartet'`) — kein Doppelversand.
//   * Ein neues Datum macht eine verfallene oder schon gekommene Erinnerung wieder scharf.
//
// Was je Art verschieden ist, liefert ein Adapter (erinnerungsArt): Tabelle und Zielspalte, ob die Erinnerung
// zur Zeit ankommt (Recht, Zugang, Zustand des Ziels), die Push und der Protokolltext. Siehe
// meldung-erinnerungen.js und notiz-erinnerungen.js.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (aus Git abgeleitet) — sie muss committet sein.

const { berlinJetzt, istDatum, istUhrzeit } = require('./zeit');

const MAX_HINWEIS = 200;
const MAX_JE_ZIEL = 20;             // je Person und Meldung/Notiz; mehr ist ein Versehen
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

/** Tabellen-Spalten, wie sie jede Art hat (CREATE TABLE in database/init.js). */
const SPALTEN_SQL = (zielSpalte) => `
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ${zielSpalte} INTEGER NOT NULL,
        user_id    INTEGER NOT NULL,
        um         TEXT NOT NULL,
        hinweis    TEXT,
        stand      TEXT NOT NULL DEFAULT 'wartet',
        stand_am   TEXT,
        grund      TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        updated_at TEXT`;

/**
 * Eine Art von Erinnerung. def:
 *   tabelle, zielSpalte               z. B. 'notiz_erinnerungen', 'note_id'
 *   zustand(db, zeile) → { kommt, grund, ... }   kommt die Erinnerung zur Zeit an? sonst warum nicht;
 *                                                 alles Weitere geht an push/protokoll
 *   push(db, zeile, info)             die Push an den Inhaber
 *   action: { ausgeloest, verpasst }  Protokoll-Aktionen
 *   protokoll(zeile, info) → Text     Protokoll-Details (ohne Grund; der wird angehängt)
 */
function erinnerungsArt(def) {
  const { tabelle, zielSpalte } = def;

  /** Die eigenen Erinnerungen zu einer Reihe von Zielen: Map ziel → [{ id, um, hinweis, stand, stand_am, grund }]. */
  function eigeneZu(db, userId, zielIds) {
    const aus = new Map();
    if (!zielIds.length) return aus;
    let zeilen = [];
    try {
      for (let i = 0; i < zielIds.length; i += 400) {
        const teil = zielIds.slice(i, i + 400);
        zeilen = zeilen.concat(db.prepare(`SELECT id, ${zielSpalte} AS ziel, um, hinweis, stand, stand_am, grund FROM ${tabelle}
          WHERE user_id = ? AND ${zielSpalte} IN (${teil.map(() => '?').join(',')}) ORDER BY um, id`).all(userId, ...teil));
      }
    } catch (_) { return aus; }   // Tabelle fehlt (sehr alte Sicherung)
    for (const z of zeilen) {
      if (!aus.has(z.ziel)) aus.set(z.ziel, []);
      aus.get(z.ziel).push({ id: z.id, um: z.um, hinweis: z.hinweis, stand: z.stand, stand_am: z.stand_am, grund: z.grund });
    }
    return aus;
  }
  const liste = (db, userId, zielId) => eigeneZu(db, userId, [zielId]).get(zielId) || [];

  /** Eine eigene Erinnerung (fremde gibt es für den Fragenden nicht). */
  const eigene = (db, userId, id) => db.prepare(`SELECT * FROM ${tabelle} WHERE id = ? AND user_id = ?`).get(Number(id), userId);
  const anzahl = (db, userId, zielId) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabelle} WHERE user_id = ? AND ${zielSpalte} = ?`).get(userId, zielId).n;
  const anlegen = (db, userId, zielId, e) => db.prepare(`INSERT INTO ${tabelle} (${zielSpalte}, user_id, um, hinweis) VALUES (?, ?, ?, ?)`)
    .run(zielId, userId, e.um, e.hinweis).lastInsertRowid;
  /** Neues Datum/Hinweis. Eine gekommene oder verfallene Erinnerung wird damit wieder scharf. */
  const aendern = (db, id, e) => db.prepare(`UPDATE ${tabelle} SET um = ?, hinweis = ?, stand = ?, stand_am = NULL, grund = NULL, updated_at = ${JETZT} WHERE id = ?`)
    .run(e.um, e.hinweis, STAND.wartet, id);
  const entfernen = (db, id) => db.prepare(`DELETE FROM ${tabelle} WHERE id = ?`).run(id);

  /**
   * Der Zeitplaner (minütlich): alle wartenden Erinnerungen, deren Zeit erreicht ist — auslösen oder verfallen.
   * Liefert, was passiert ist (Tests). `benachrichtigen(db, zeile, info)` schickt die Push; Tests reichen eine
   * eigene herein, `null` schickt keine.
   */
  function faelligePruefen(db, jetzt, benachrichtigen) {
    jetzt = jetzt || new Date();
    if (benachrichtigen === undefined) benachrichtigen = def.push;
    let zeilen;
    try {
      zeilen = db.prepare(`SELECT * FROM ${tabelle} WHERE stand = ? AND um <= ? ORDER BY um, id`).all(STAND.wartet, berlinJetzt(jetzt).slice(0, 16));
    } catch (_) { return []; }   // Tabelle fehlt (sehr alte Sicherung)
    const passiert = [];
    for (const z of zeilen) {
      let info;
      try { info = def.zustand(db, z) || { kommt: false, grund: 'unbekannt' }; } catch (_) { continue; }   // nächster Lauf versucht es wieder
      const stand = info.kommt ? STAND.ausgeloest : STAND.verpasst;
      const grund = info.kommt ? null : (info.grund || 'unbekannt');
      // Erst vermerken, dann senden: Läuft der nächste Takt dazwischen, käme sonst eine zweite Push
      const n = db.prepare(`UPDATE ${tabelle} SET stand = ?, stand_am = ${JETZT}, grund = ? WHERE id = ? AND stand = ?`)
        .run(stand, grund, z.id, STAND.wartet).changes;
      if (!n) continue;
      auditErinnerung(db, info.kommt ? def.action.ausgeloest : def.action.verpasst,
        `${def.protokoll(z, info)} · ${umText(z.um)}${grund ? ` (${grund})` : ''}`);
      passiert.push({ id: z.id, ziel: z[zielSpalte], user: z.user_id, stand, grund });
      if (info.kommt && benachrichtigen) {
        try { benachrichtigen(db, z, info); } catch (err) { console.error(`${tabelle}: Push fehlgeschlagen:`, err && err.message); }
      }
    }
    return passiert;
  }

  return { tabelle, zielSpalte, eigeneZu, liste, eigene, anzahl, anlegen, aendern, entfernen, faelligePruefen };
}

function auditErinnerung(db, action, details) {
  require('./audit').logAudit(db, { userId: null, username: 'System', action, details });
}

module.exports = { MAX_HINWEIS, MAX_JE_ZIEL, STAND, SPALTEN_SQL, kurz, umText, pruefen, erinnerungsArt };
