// Kollegen (Alex, 05.10.2026): wer im Team ist, mit dem, was jeder SELBST für die anderen freigibt.
//
// Wer steht drin: alle aktiven Konten außer der Rolle „admin" — das ist bei den meisten Betrieben ein
// technisches Konto, kein Kollege. Die eigene Seite ist trotzdem abrufbar (Vorschau „So sehen dich deine
// Kollegen"), auch für einen Admin.
//
// Datenschutz — die Regel steht NUR hier: Was nicht freigegeben ist, verlässt den Server nicht. Telefon und
// E-Mail nur mit eigenem Haken, der Geburtstag nur mit der Geburtstags-Freigabe, das Alter nur mit deren
// zweitem Haken. Der Infotext erscheint, sobald er nicht leer ist — ihn zu schreiben IST die Freigabe.
// Bewusst NICHT: Abwesenheiten (Krankheit = Gesundheitsdaten), Arbeitszeiten, Personalnummer, Eintrittsdatum.
const express = require('express');
const fs = require('fs');
const sharp = require('sharp');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { berlinHeute } = require('../zeit');
const { dateiFuer } = require('./avatare');

const router = express.Router();

const MAX_INFO = 1000, MAX_TELEFON = 30, MAX_EMAIL = 120;
const TELEFON_RE = /^[+0-9 ()/.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// „Neu im Team": die ersten 4 Wochen nach dem ERSTEN Anstellungsbeginn. Wer wieder eingestellt wird, ist nicht
// neu. Und nur, wenn der Eintritt mindestens 4 Wochen nach der Einführung der App liegt (frühester Beginn
// überhaupt): Beim Einführen werden alle Konten auf einmal angelegt — sonst stünde wochenlang JEDER als „neu" da.
const NEU_TAGE = 28;
const tageZwischen = (von, bis) => Math.round((Date.parse(bis + 'T12:00:00Z') - Date.parse(von + 'T12:00:00Z')) / 864e5);
function neuImTeam(db) {
  const heute = berlinHeute();
  const neu = new Set();
  try {
    const einfuehrung = (db.prepare('SELECT MIN(start_date) AS d FROM employment_periods').get() || {}).d;
    if (!einfuehrung) return neu;
    for (const r of db.prepare('SELECT user_id, MIN(start_date) AS beginn FROM employment_periods GROUP BY user_id').all()) {
      if (!r.beginn || r.beginn > heute) continue;
      if (tageZwischen(r.beginn, heute) < NEU_TAGE && tageZwischen(einfuehrung, r.beginn) >= NEU_TAGE) neu.add(r.user_id);
    }
  } catch (_) { /* Altstand ohne Anstellungszeiträume: niemand ist „neu" */ }
  return neu;
}

const profilVon = (db, id) => {
  try { return db.prepare('SELECT * FROM kollegen_profil WHERE user_id = ?').get(id) || null; } catch (_) { return null; }
};
const geburtstagsFreigabe = (db, id) => {
  try { return db.prepare('SELECT zeigen, alter_auch FROM geburtstag_freigabe WHERE user_id = ?').get(id) || null; } catch (_) { return null; }
};

// Geburtstag nur mit Freigabe; das Alter nur mit dem zweiten Haken. Das Geburtsjahr verlässt den Server dabei
// nicht — nur Tag, Monat und (falls freigegeben) das Alter.
function geburtstag(db, user) {
  const f = geburtstagsFreigabe(db, user.id);
  if (!f || !f.zeigen || !/^\d{4}-\d\d-\d\d$/.test(String(user.birth_date || ''))) return null;
  const [j, m, t] = user.birth_date.split('-').map(Number);
  const aus = { monat: m, tag: t };
  if (f.alter_auch) {
    const [hj, hm, ht] = berlinHeute().split('-').map(Number);
    aus.alter = hj - j - ((hm < m || (hm === m && ht < t)) ? 1 : 0);
  }
  return aus;
}

// Wer darf als Kollege gezeigt werden? Aktiv und kein Admin — die eigene Seite immer (Vorschau).
function kollegeOderNull(db, id, selbstId) {
  const u = db.prepare('SELECT id, name, role, birth_date, COALESCE(active, 1) AS active FROM users WHERE id = ?').get(id);
  if (!u || !u.active) return null;
  if (u.role === 'admin' && u.id !== selbstId) return null;
  return u;
}

// Das, was ein Kollege von dieser Person sehen darf — EINE Stelle für Seite und vCard.
function sichtbar(db, u) {
  const p = profilVon(db, u.id) || {};
  return {
    info: p.info && p.info.trim() ? p.info : null,
    telefon: p.telefon_zeigen && p.telefon ? p.telefon : null,
    email: p.email_zeigen && p.email ? p.email : null,
    geburtstag: geburtstag(db, u),
  };
}

// ── Liste ──────────────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const neu = neuImTeam(db);
  const kollegen = db.prepare(`SELECT id, name, role FROM users
      WHERE COALESCE(active, 1) = 1 AND role != 'admin' AND id != ? ORDER BY name COLLATE NOCASE`).all(req.user.id)
    .map(u => ({ id: u.id, name: u.name, role: u.role, neu: neu.has(u.id) }));
  res.json({ kollegen });
});

// ── Das eigene Profil (Mein Konto → „Für die Kollegen") ─────────────────────────────────────────
// Immer gegen req.user.id — es gibt keinen Weg, darüber das Profil eines anderen zu ändern. MUSS vor "/:id".
router.get('/mein-profil', authenticate, (req, res) => {
  const db = getDb();
  const p = profilVon(db, req.user.id) || {};
  const f = geburtstagsFreigabe(db, req.user.id) || {};
  res.json({
    info: p.info || '', telefon: p.telefon || '', telefon_zeigen: !!p.telefon_zeigen,
    email: p.email || '', email_zeigen: !!p.email_zeigen,
    geburtstag_zeigen: !!f.zeigen, alter_zeigen: !!f.alter_auch,
    geburtsdatum_hinterlegt: !!req.user.birth_date,
  });
});

router.put('/mein-profil', authenticate, (req, res) => {
  const b = req.body || {};
  const text = (v) => (typeof v === 'string' ? v : '');
  // Steuerzeichen raus (außer Zeilenumbruch), Windows-Umbrüche vereinheitlichen
  const info = text(b.info).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  const telefon = text(b.telefon).trim();
  const email = text(b.email).trim();
  if (info.length > MAX_INFO) return res.status(400).json({ error: `Der Text ist zu lang (höchstens ${MAX_INFO} Zeichen).` });
  if (telefon && (telefon.length > MAX_TELEFON || !TELEFON_RE.test(telefon) || (telefon.match(/\d/g) || []).length < 5)) {
    return res.status(400).json({ error: 'Telefonnummer: bitte nur Ziffern, Leerzeichen und + ( ) / - . — z. B. 0171 2345678' });
  }
  if (email && (email.length > MAX_EMAIL || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: 'Die E-Mail-Adresse sieht nicht gültig aus, z. B. name@beispiel.de' });
  }
  // Ein Haken ohne Inhalt ergibt keinen Sinn — der Server räumt das gerade (wie bei Geburtstag/Alter).
  const telefonZeigen = !!b.telefon_zeigen && !!telefon;
  const emailZeigen = !!b.email_zeigen && !!email;
  const db = getDb();
  try {
    db.prepare(`INSERT INTO kollegen_profil (user_id, info, telefon, telefon_zeigen, email, email_zeigen, geaendert)
                VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
                ON CONFLICT(user_id) DO UPDATE SET info = excluded.info, telefon = excluded.telefon,
                  telefon_zeigen = excluded.telefon_zeigen, email = excluded.email,
                  email_zeigen = excluded.email_zeigen, geaendert = excluded.geaendert`)
      .run(req.user.id, info || null, telefon || null, telefonZeigen ? 1 : 0, email || null, emailZeigen ? 1 : 0);
    // Ins Protokoll gehört, WAS sichtbar ist — nicht der Inhalt (Nummer, Adresse, Text bleiben draußen).
    const stand = (wert, zeigen) => !wert ? 'leer' : (zeigen ? 'sichtbar' : 'nur gespeichert');
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'kollegen_profil',
      details: `Infotext: ${info ? 'sichtbar' : 'leer'} · Telefon: ${stand(telefon, telefonZeigen)} · E-Mail: ${stand(email, emailZeigen)}`, ip: req.ip });
    res.json({ info, telefon, telefon_zeigen: telefonZeigen, email, email_zeigen: emailZeigen });
  } catch (e) {
    console.error('Kollegen-Profil fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Seite eines Kollegen ────────────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const u = Number.isInteger(id) ? kollegeOderNull(db, id, req.user.id) : null;
  if (!u) return res.status(404).json({ error: 'Diese Person gibt es nicht (mehr) im Team.' });
  const s = sichtbar(db, u);
  // Ausgeliehenes Werkzeug: Die Werkzeugliste zeigt das ohnehin allen — hier steht nichts Neues.
  let werkzeug = [];
  try {
    werkzeug = db.prepare(`SELECT t.name, tc.checked_out_at, COALESCE(p.name, tc.project_text) AS projekt
        FROM tool_checkouts tc JOIN tools t ON t.id = tc.tool_id LEFT JOIN projects p ON p.id = tc.project_id
        WHERE tc.user_id = ? AND tc.returned_at IS NULL ORDER BY t.name COLLATE NOCASE`).all(u.id);
  } catch (_) { /* Altstand ohne Werkzeugliste */ }
  res.json({
    id: u.id, name: u.name, role: u.role, selbst: u.id === req.user.id, neu: neuImTeam(db).has(u.id),
    ...s, werkzeug, vcard: !!(s.telefon || s.email),
  });
});

// ── vCard („Ins Telefonbuch übernehmen") ────────────────────────────────────────────────────────
// vCard 3.0 — die lesen Android und iPhone gleichermaßen. Enthält nur, was auch die Seite zeigt. Den Geburtstag
// nur MIT Alter-Freigabe: In 3.0 gibt es keinen Geburtstag ohne Jahr, und das Jahr verrät das Alter.
const vEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
// Zeilen über 75 Byte werden gefaltet (Zeilenumbruch + Leerzeichen) — Pflicht der Norm, wichtig beim Foto.
function falten(zeile) {
  const buf = Buffer.from(zeile, 'utf8');
  if (buf.length <= 75) return zeile;
  const teile = []; let start = 0, grenze = 75;
  while (start < buf.length) {
    let ende = Math.min(start + grenze, buf.length);
    while (ende < buf.length && (buf[ende] & 0xc0) === 0x80) ende--;   // kein UTF-8-Zeichen zerschneiden
    teile.push(buf.slice(start, ende).toString('utf8'));
    start = ende; grenze = 74;                                         // Folgezeilen beginnen mit Leerzeichen
  }
  return teile.join('\r\n ');
}

router.get('/:id/vcard', authenticate, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const u = Number.isInteger(id) ? kollegeOderNull(db, id, req.user.id) : null;
  if (!u) return res.status(404).json({ error: 'Diese Person gibt es nicht (mehr) im Team.' });
  const s = sichtbar(db, u);
  if (!s.telefon && !s.email) return res.status(404).json({ error: 'Keine Telefonnummer oder E-Mail freigegeben.' });

  // Letztes Wort = Nachname, der Rest Vorname(n). Ein einzelnes Wort („Chef") steht nur im Nachnamen.
  const teile = u.name.trim().split(/\s+/);
  const nachname = teile[teile.length - 1];
  const vorname = teile.slice(0, -1).join(' ');
  let firma = '';
  try { firma = (db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get() || {}).value || ''; } catch (_) {}
  const zeilen = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEsc(nachname)};${vEsc(vorname)};;;`, `FN:${vEsc(u.name)}`];
  if (firma) zeilen.push(`ORG:${vEsc(firma)}`);
  if (s.telefon) zeilen.push(`TEL;TYPE=CELL:${vEsc(s.telefon)}`);
  if (s.email) zeilen.push(`EMAIL;TYPE=INTERNET:${vEsc(s.email)}`);
  if (s.geburtstag && s.geburtstag.alter !== undefined) zeilen.push(`BDAY:${u.birth_date}`);
  try {
    const hatBild = db.prepare('SELECT 1 FROM user_avatars WHERE user_id = ?').get(u.id);
    const datei = dateiFuer(u.id, 'gross');
    if (hatBild && fs.existsSync(datei)) {
      const jpeg = await sharp(datei).resize(256, 256, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
      zeilen.push(`PHOTO;ENCODING=b;TYPE=JPEG:${jpeg.toString('base64')}`);
    }
  } catch (_) { /* ohne Foto ist die Karte trotzdem brauchbar */ }
  zeilen.push('END:VCARD');

  const dateiname = `${u.name}.vcf`;
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${dateiname.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(dateiname)}`);
  res.send(zeilen.map(falten).join('\r\n') + '\r\n');
});

module.exports = router;
