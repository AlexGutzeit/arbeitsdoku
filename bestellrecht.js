// Wer darf eine Bestellung abschliessen?
//
// Bis hierher hing das allein an der Rolle: Admin, Chef und Buchhalter durften offene
// Bestellungen auf „Bestellt" setzen, sonst niemand. Sind Chef und Chefin im Urlaub, kann also
// niemand mehr bestellen — genau der Fall, den Alex beschrieben hat (25.08.2026).
//
// Deshalb gibt es jetzt zusaetzlich das Einzelrecht `can_order`, wie bei der Planung. Es steht
// bewusst hier und nicht in routes/orders.js: Auch users.js, badges.js und der Zeitplaner muessen
// dieselbe Frage stellen, und drei Fassungen derselben Regel driften auseinander.
//
// ACHTUNG bei den Rollen: Beim Bestellen zaehlt der BUCHHALTER mit — anders als bei Planung,
// Schwarzem Brett und Upload, wo er das Recht NICHT implizit hat. Die vorhandene
// Normalisierung fuer chef/admin darf deshalb nicht einfach um can_order erweitert werden,
// sonst naehme man dem Buchhalter im Vorbeigehen seine Planungsrechte weg.
const ROLLEN_MIT_BESTELLRECHT = ['admin', 'chef', 'buchhalter'];

// user: { role, can_order } — reicht aus, was middleware/auth.js an jede Anfrage haengt.
function darfBestellen(user) {
  if (!user) return false;
  if (ROLLEN_MIT_BESTELLRECHT.includes(user.role)) return true;
  return Number(user.can_order) === 1;
}

// Ein Recht wegzunehmen ist nicht das Gegenteil vom Geben: Es bleibt etwas liegen.
// Wer das Bestellrecht verliert, darf auch keine Bestell-Meldungen mehr bekommen — weder die
// einzelne Push noch die Kategorie in einer geplanten Zusammenfassung.
//
// Laeuft nach JEDER Aenderung an Rolle oder Recht, nicht nur beim Haekchen-Wegnehmen: Wird ein
// Chef zum Mitarbeiter zurueckgestuft, verliert er das Recht ebenfalls — nur implizit ueber die
// Rolle. Dieser Weg waere sonst offen geblieben.
//
// Rueckgabe beschreibt, was aufgeraeumt wurde (fuer das Audit-Log); null, wenn nichts zu tun war.
function bestellmeldungenAufraeumen(db, userId) {
  const user = db.prepare('SELECT id, role, can_order FROM users WHERE id = ?').get(userId);
  if (!user || darfBestellen(user)) return null;

  let pushAus = false;
  try {
    const pref = db.prepare('SELECT orders FROM push_prefs WHERE user_id = ?').get(userId);
    if (pref && Number(pref.orders) === 1) {
      db.prepare('UPDATE push_prefs SET orders = 0 WHERE user_id = ?').run(userId);
      pushAus = true;
    }
  } catch (_) { /* alte Staende ohne push_prefs */ }

  const gekuerzt = [];
  const entfernt = [];
  try {
    const plaene = db.prepare('SELECT id, name, cats FROM summary_schedules WHERE user_id = ?').all(userId);
    for (const p of plaene) {
      const cats = String(p.cats || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!cats.includes('orders')) continue;
      const rest = cats.filter(c => c !== 'orders');
      const name = (p.name || '').trim() || 'ohne Namen';
      if (rest.length) {
        db.prepare('UPDATE summary_schedules SET cats = ? WHERE id = ?').run(rest.join(','), p.id);
        gekuerzt.push(name);
      } else {
        // Eine Zusammenfassung, die nichts mehr zusammenfassen kann, ist Ballast (Alex,
        // 25.08.2026). Sie wird entfernt und der Vorgang steht im Protokoll.
        db.prepare('DELETE FROM summary_schedules WHERE id = ?').run(p.id);
        entfernt.push(name);
      }
    }
  } catch (_) { /* alte Staende ohne summary_schedules */ }

  if (!pushAus && !gekuerzt.length && !entfernt.length) return null;
  const teile = [];
  if (pushAus) teile.push('Push „Bestellungen" abgeschaltet');
  if (gekuerzt.length) teile.push(`Kategorie aus Zusammenfassung entfernt: ${gekuerzt.join(', ')}`);
  if (entfernt.length) teile.push(`Zusammenfassung ohne verbleibende Kategorie gelöscht: ${entfernt.join(', ')}`);
  return { pushAus, gekuerzt, entfernt, text: teile.join('; ') };
}

module.exports = { ROLLEN_MIT_BESTELLRECHT, darfBestellen, bestellmeldungenAufraeumen };
