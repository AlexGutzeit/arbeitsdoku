// Persönliche Erinnerungen an eine Meldung (01.10.2026): „TÜV-Termin in vier Wochen — erinnere mich am 27.10.
// um 7 Uhr". Ohne sie vergisst man den Termin, weil die Meldung längst gelesen ist (Alex).
//
// Was für alle Erinnerungen gilt (persönlich, Datum + Uhrzeit, verfällt statt nachzukommen, kein Doppelversand),
// steht im gemeinsamen Kern erinnerungen.js. Hier nur, was für MELDUNGEN eigen ist (Alex, 01.10.2026):
//   * Anlegen dürfen nur Bearbeiter (meldungrecht.js). Wer das Recht verliert oder ausgestellt wird, bekommt
//     keine mehr — seine Erinnerungen verfallen zu ihrer Zeit („ohne Recht").
//   * Steht die Meldung in der History (erledigt, zurückgezogen, Thema gelöscht), RUHT die Erinnerung. Fällt ihre
//     Zeit in diese Pause, verfällt sie („Meldung ruhte") und kommt beim Wiederöffnen nicht nach. Spätere sind
//     nach dem Wiederöffnen wieder aktiv.
//   * Push über den Schalter „Meldungen"; Antippen führt zur Meldung und hebt sie hervor.
//   * Einmalig. Was wiederkehrt, sind regelmäßige Meldungen (meldung-regeln.js).
//   * Nicht im Verlauf der Meldung (den alle lesen), nur im Protokoll.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (aus Git abgeleitet) — sie muss committet sein.

const kern = require('./erinnerungen');
const { darfMeldungenBearbeiten } = require('./meldungrecht');

/** Aktiv = offen oder in Arbeit, Thema nicht gelöscht. Sonst steht sie in der History, und Erinnerungen ruhen. */
const meldungAktiv = (m) => !!m && (m.status === 'offen' || m.status === 'in_arbeit') && !m.thema_geloescht_am;

function zustand(db, z) {
  const m = db.prepare(`SELECT m.id, m.status, m.text, t.name AS thema_name, t.deleted_at AS thema_geloescht_am FROM meldungen m
    LEFT JOIN meldung_themen t ON t.id = m.thema_id WHERE m.id = ?`).get(z.meldung_id);
  const u = db.prepare('SELECT role, can_meldungen, active, username FROM users WHERE id = ?').get(z.user_id);
  const darf = !!u && Number(u.active ?? 1) === 1 && darfMeldungenBearbeiten(u);
  const aktiv = meldungAktiv(m);
  return { kommt: darf && aktiv, grund: !darf ? 'ohne Recht' : !aktiv ? 'Meldung ruhte' : null, m, u };
}

// Push an den einen, der die Erinnerung gestellt hat — über den Schalter „Meldungen" (Alex). Antippen führt zur
// Meldung und hebt sie hervor (ziel, wie seit R30 überall).
function pushAnInhaber(db, z, info) {
  const m = (info && info.m) || {};
  require('./push').notifyUsers(db, [z.user_id], 'meldungen', {
    title: `🔔 Erinnerung: ${m.thema_name || 'Meldung'}`,
    body: (z.hinweis ? `${z.hinweis} — ` : '') + kern.kurz(m.text, 100),
    url: '/#/meldungen',
    ziel: { art: 'meldung', id: z.meldung_id },
  }, null);
}

const art = kern.erinnerungsArt({
  tabelle: 'meldung_erinnerungen',
  zielSpalte: 'meldung_id',
  zustand,
  push: pushAnInhaber,
  action: { ausgeloest: 'meldung_erinnerung_ausgeloest', verpasst: 'meldung_erinnerung_verpasst' },
  protokoll: (z, info) => `Nr. ${z.meldung_id} · ${(info.m && info.m.thema_name) || '?'} · für ${(info.u && info.u.username) || 'Gelöschtes Konto'}`
    + ` · „${kern.kurz(info.m && info.m.text, 40)}"`,
});

/** Wie früher: Ergebnis je Erinnerung mit `meldung` statt des allgemeinen `ziel`. */
function faelligePruefen(db, jetzt, benachrichtigen) {
  return art.faelligePruefen(db, jetzt, benachrichtigen).map(p => ({ ...p, meldung: p.ziel }));
}

module.exports = {
  MAX_HINWEIS: kern.MAX_HINWEIS, MAX_JE_MELDUNG: kern.MAX_JE_ZIEL, STAND: kern.STAND, umText: kern.umText, pruefen: kern.pruefen,
  meldungAktiv, eigeneZu: art.eigeneZu, eigene: art.eigene, anzahl: art.anzahl, anlegen: art.anlegen, aendern: art.aendern,
  entfernen: art.entfernen, faelligePruefen, pushAnInhaber,
};
