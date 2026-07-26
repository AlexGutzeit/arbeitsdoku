// Arbeitsnachweis-PDF mit Projektfilter: Soll, Differenz und die Ist-Spalte je Mitarbeiter müssen
// sich auf ALLE Stunden beziehen — nicht auf das gefilterte Projekt.
//
// Vorher stand im Dokument „Projektstunden minus Gesamt-Soll" als Differenz. Bei 8 Stunden auf einem
// Projekt und 168 Stunden Soll ergab das −160, obwohl der Mitarbeiter in Wahrheit ausgeglichen war.
// Der Zeitnachweis macht es längst richtig (zweite, ungefilterte Abfrage) — das PDF zieht nach.
//   node tests/pdf-projektfilter.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const zlib = require('zlib');

const PORT = 3152, DB = '/tmp/pdf-projektfilter.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const pdfHolen = (pfad, token) => new Promise((res, rej) => {
  const r = http.request({ host: 'localhost', port: PORT, path: pfad, headers: { Authorization: 'Bearer ' + token } },
    x => { const t = []; x.on('data', c => t.push(c)); x.on('end', () => res(Buffer.concat(t))); });
  r.on('error', rej); r.end();
});

// pdfkit legt Text hexkodiert in TJ-Feldern ab und komprimiert die Ströme.
function pdfText(buf) {
  const teile = []; let i = 0;
  while (true) {
    const s1 = buf.indexOf('stream', i); if (s1 < 0) break;
    let a = s1 + 6; if (buf[a] === 0x0d) a++; if (buf[a] === 0x0a) a++;
    const s2 = buf.indexOf('endstream', a); if (s2 < 0) break;
    try { teile.push(zlib.inflateSync(buf.subarray(a, s2)).toString('latin1')); } catch (_) {}
    i = s2 + 9;
  }
  // Innerhalb EINES TJ-Feldes sind die Hex-Stuecke Teile desselben Wortes (dazwischen stehen nur
  // Kerning-Zahlen). Wuerde man sie mit Leerzeichen verbinden, entstuende „P eter" statt „Peter"
  // und „Zeitr aum" statt „Zeitraum" — Beschriftungen waeren nicht mehr auffindbar.
  const felder = [];
  for (const feld of teile.join('\n').match(/\[[^\]]*\]\s*TJ/g) || []) {
    const stuecke = (feld.match(/<([0-9A-Fa-f]+)>/g) || [])
      .map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'));
    felder.push(stuecke.join(''));
  }
  return felder.join(' ').replace(/\s+/g, ' ');
}
// „7:30" → 7.5
const std = (s) => { const m = /(-?)(\d+):(\d\d)/.exec(s || ''); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : null; };
const nachLabel = (text, label) => {
  const i = text.indexOf(label);
  if (i < 0) return null;
  return std(text.slice(i + label.length, i + label.length + 20));
};

const jahr = new Date().getFullYear() + 1;
const MONAT = `${jahr}-04`;
const tag = (d) => `${MONAT}-${String(d).padStart(2, '0')}`;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/pdf-projektfilter-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/pdf-projektfilter-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;

    const werktage = [];
    const letzterTag = new Date(Date.UTC(jahr, Number(MONAT.slice(5)), 0)).getUTCDate();
    for (let d = 1; d <= letzterTag; d++) {
      const wd = new Date(`${tag(d)}T12:00:00`).getDay();
      if (wd >= 1 && wd <= 5) werktage.push(d);
    }

    const ma = (await req('POST', '/api/users', admin, {
      username: 'pf_ma', password: 'Test1234!', name: 'Peter Filter', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
    })).body.user;
    const projA = (await req('POST', '/api/projects', admin, { name: 'Halle Nord' })).body.project;
    const projB = (await req('POST', '/api/projects', admin, { name: 'Halle Süd' })).body.project;

    // 3 Tage auf Projekt A (je 8 h), 2 Tage auf Projekt B (je 8 h) → 24 h A, 16 h B, 40 h gesamt
    for (let i = 0; i < 3; i++) await req('POST', '/api/entries', admin, { date: tag(werktage[i]), time_from: '07:00', time_to: '15:00', user_id: ma.id, project_id: projA.id });
    for (let i = 3; i < 5; i++) await req('POST', '/api/entries', admin, { date: tag(werktage[i]), time_from: '07:00', time_to: '15:00', user_id: ma.id, project_id: projB.id });

    const sollGesamt = werktage.length * 8;
    const von = tag(1), bis = tag(letzterTag);
    const basis = `/api/pdf/export?date_from=${von}&date_to=${bis}&user_id=${ma.id}`;

    // ── Ohne Filter ───────────────────────────────────────────────────────
    console.log('Ohne Projektfilter:');
    const ohne = pdfText(await pdfHolen(basis, admin));
    ok('PDF-Text wird gelesen', ohne.length > 200, ohne.slice(0, 80));
    ok('Gesamtstunden 40', nachLabel(ohne, 'Gesamtstunden:') === 40, String(nachLabel(ohne, 'Gesamtstunden:')));
    ok(`Soll-Stunden ${sollGesamt}`, nachLabel(ohne, 'Soll-Stunden:') === sollGesamt, String(nachLabel(ohne, 'Soll-Stunden:')));
    ok(`Differenz ${40 - sollGesamt}`, Math.abs(nachLabel(ohne, 'Differenz (Zeitraum):') - (40 - sollGesamt)) < 0.02,
      String(nachLabel(ohne, 'Differenz (Zeitraum):')));
    ok('keine Zusatzzeile „alle Projekte" ohne Filter', !ohne.includes('alle Projekte'));

    // ── Mit Filter auf Projekt A ──────────────────────────────────────────
    console.log('Mit Projektfilter „Halle Nord" (24 von 40 Stunden):');
    const mit = pdfText(await pdfHolen(basis + `&project_id=${projA.id}`, admin));
    ok('gefilterte Summe wird als Projektsumme ausgewiesen', /Gesamtstunden \(Halle Nord\)/.test(mit), mit.slice(0, 200));
    ok('Projektsumme 24', nachLabel(mit, 'Gesamtstunden (Halle Nord):') === 24, String(nachLabel(mit, 'Gesamtstunden (Halle Nord):')));
    ok('Gesamtsumme aller Projekte 40 wird zusätzlich gezeigt',
      nachLabel(mit, 'Gesamtstunden (alle Projekte):') === 40, String(nachLabel(mit, 'Gesamtstunden (alle Projekte):')));
    ok(`Soll-Stunden bleiben ${sollGesamt}`, nachLabel(mit, 'Soll-Stunden:') === sollGesamt, String(nachLabel(mit, 'Soll-Stunden:')));
    ok(`Differenz jetzt ${40 - sollGesamt} (NICHT ${24 - sollGesamt})`,
      Math.abs(nachLabel(mit, 'Differenz (Zeitraum):') - (40 - sollGesamt)) < 0.02,
      String(nachLabel(mit, 'Differenz (Zeitraum):')));
    ok('Überstunden gesamt unverändert',
      nachLabel(mit, 'Überstunden gesamt:') === nachLabel(ohne, 'Überstunden gesamt:'),
      `${nachLabel(mit, 'Überstunden gesamt:')} vs ${nachLabel(ohne, 'Überstunden gesamt:')}`);

    // Die Eintragsliste selbst MUSS weiterhin gefiltert sein
    ok('Eintragsliste zeigt nur das gefilterte Projekt',
      mit.includes('Halle Nord') && !/Halle Süd/.test(mit), mit.includes('Halle Süd') ? 'Halle Süd taucht auf' : 'ok');

    // ── Mehrere Mitarbeiter, Sicht „alle" ─────────────────────────────────
    console.log('Alle Mitarbeiter mit Projektfilter:');
    const alle = pdfText(await pdfHolen(`/api/pdf/export?date_from=${von}&date_to=${bis}&project_id=${projA.id}`, admin));
    ok('auch dort die Projektsumme benannt', /Gesamtstunden \(Halle Nord\)/.test(alle));
    ok('und die Gesamtsumme daneben', /Gesamtstunden \(alle Projekte\)/.test(alle));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPDF-Projektfilter: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
