// Lohn-Export (C1): Zahlen und Dateiformat.
//
// Prueft die kniffligen Faelle mit BEKANNTEN Sollwerten (Krank, FZA, Urlaub, Feiertag,
// ueberlappende Eintraege, Austritt mitten im Monat) und stellt die CSV-Werte zusaetzlich gegen
// genau die Endpunkte, aus denen das Buero die Zahlen heute abliest.
//   node tests/lohn-export.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3144, DB = '/tmp/lohnexport.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// CSV mit Semikolon und Anfuehrungszeichen zerlegen (bewusst eigenstaendig, damit der Test nicht
// dieselbe Funktion benutzt, die er pruefen soll).
function parseCsv(text) {
  const ohneBom = text.replace(/^﻿/, '');
  return ohneBom.split('\r\n').filter(z => z !== '').map(zeile => {
    const felder = []; let cur = ''; let inQ = false;
    for (let i = 0; i < zeile.length; i++) {
      const c = zeile[i];
      if (inQ) {
        if (c === '"' && zeile[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ';') { felder.push(cur); cur = ''; }
      else cur += c;
    }
    felder.push(cur);
    return felder;
  });
}
const zahl = (s) => Number(String(s).replace(',', '.'));

// Ein Monat, der sicher komplett in der Zukunft liegt → keine Ueberschneidung mit Seed-Daten.
const jahr = new Date().getFullYear() + 1;
const MONAT = `${jahr}-03`;               // März: 2 volle Wochen reichen
const tag = (d) => `${MONAT}-${String(d).padStart(2, '0')}`;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/lohnexport-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/lohnexport-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;

    // ALLE Werktage des Monats — nicht nur bis zum 28.: der Export deckt den ganzen Monat ab,
    // sonst weicht die erwartete Soll-Zahl um die letzten Tage ab.
    const letzterTag = new Date(Date.UTC(jahr, Number(MONAT.slice(5)), 0)).getUTCDate();
    const werktage = [];
    for (let d = 1; d <= letzterTag; d++) {
      const wd = new Date(`${MONAT}-${String(d).padStart(2, '0')}T12:00:00`).getDay();
      if (wd >= 1 && wd <= 5) werktage.push(d);
    }

    const mkMa = async (username, name, personalNr) => {
      const r = await req('POST', '/api/users', admin, {
        username, password: 'Test1234!', name, role: 'mitarbeiter', personnel_no: personalNr,
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40,
      });
      return r.body.user;
    };
    const eintrag = (uid, d, von, bis, pause) => req('POST', '/api/entries', admin,
      { date: tag(d), time_from: von, time_to: bis, break_minutes: pause || 0, user_id: uid });
    // Urlaub, FZA und Sonderurlaub durchlaufen einen Genehmigungs-Workflow: unbestaetigt stehen sie
    // auf 'pending' und zaehlen NICHT — weder in der Uebersicht noch im Soll. Also mitgenehmigen.
    const abwesend = async (uid, typ, vonTag, bisTag) => {
      const r = await req('POST', '/api/absences', admin,
        { type: typ, date_from: tag(vonTag), date_to: tag(bisTag), target_user_id: uid });
      const id = r.body && r.body.absence && r.body.absence.id;
      if (id && ['urlaub', 'freizeitausgleich', 'sonderurlaub'].includes(typ)) {
        await req('POST', `/api/absences/${id}/approve`, admin, {});
      }
      return r;
    };

    // ── A: gearbeitet, krank, Urlaub, FZA, Überlappung ────────────────────
    const a = await mkMa('lohn_a', 'AA Vollfall', '0042');
    ok('Personalnummer beim Anlegen übernommen', a && a.personnel_no === '0042', JSON.stringify(a && a.personnel_no));
    await eintrag(a.id, werktage[0], '07:00', '16:00', 30);      // 8,5 h
    await eintrag(a.id, werktage[1], '07:00', '12:00', 0);       // 5 h
    await eintrag(a.id, werktage[1], '11:00', '15:00', 0);       // überlappt → zusammen 8 h
    await abwesend(a.id, 'krank', werktage[2], werktage[2]);
    await abwesend(a.id, 'urlaub', werktage[3], werktage[4]);
    await abwesend(a.id, 'freizeitausgleich', werktage[5], werktage[5]);

    // ── B: gar nichts gebucht ─────────────────────────────────────────────
    const b = await mkMa('lohn_b', 'BB Ohne alles', '');

    // ── C: Austritt mitten im Monat ───────────────────────────────────────
    const c = await mkMa('lohn_c', 'CC Ausgestellt', '77');
    await eintrag(c.id, werktage[0], '07:00', '15:00', 0);       // 8 h vor dem Austritt
    const austritt = tag(werktage[2]);
    const aus = await req('POST', `/api/users/${c.id}/deactivate`, admin, { employed_until: austritt });
    ok('Mitarbeiter zum Monatsmitte ausgestellt', aus.status === 200, aus.status + ' ' + JSON.stringify(aus.body).slice(0, 80));

    // ── Export holen ──────────────────────────────────────────────────────
    const res = await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, admin);
    ok('Export liefert 200', res.status === 200, String(res.status));
    ok('Datei beginnt mit BOM (Excel zeigt Umlaute richtig)', res.text.charCodeAt(0) === 0xFEFF);
    ok('Zeilen mit CRLF getrennt', res.text.includes('\r\n'));

    const rows = parseCsv(res.text);
    const kopf = rows[0];
    ok('Kopfzeile stimmt', kopf[0] === 'Personalnummer' && kopf[1] === 'Name' && kopf.includes('Überstunden gesamt'), JSON.stringify(kopf.slice(0, 4)));
    const finde = (name) => rows.find(r => r[1] === name);
    const spalte = (name) => kopf.indexOf(name);

    const rA = finde('AA Vollfall'), rB = finde('BB Ohne alles'), rC = finde('CC Ausgestellt');
    ok('alle drei Mitarbeiter in der Datei', !!rA && !!rB && !!rC);

    // A: Ist = 8,5 + 8 = 16,5 (Überlappung NICHT doppelt)
    ok('A · Ist-Stunden 16,5 (Überlappung nur einmal)', zahl(rA[spalte('Ist-Stunden')]) === 16.5, rA[spalte('Ist-Stunden')]);
    ok('A · Personalnummer in der Datei', rA[0] === '0042', rA[0]);
    ok('A · Urlaub 2 Tage', zahl(rA[spalte('Urlaub')]) === 2, rA[spalte('Urlaub')]);
    ok('A · Krank 1 Tag', zahl(rA[spalte('Krank')]) === 1, rA[spalte('Krank')]);
    ok('A · FZA 1 Tag', zahl(rA[spalte('FZA')]) === 1, rA[spalte('FZA')]);
    // Soll: alle Werktage 8h, minus Urlaub (2×8) minus Krank (Ist an dem Tag = 0 → 0), FZA bleibt 8
    const sollErwartet = werktage.length * 8 - 2 * 8 - 8;
    ok(`A · Soll-Stunden ${sollErwartet} (Urlaub 0, Krank 0, FZA voll)`,
      zahl(rA[spalte('Soll-Stunden')]) === sollErwartet, rA[spalte('Soll-Stunden')]);
    ok('A · Saldo = Ist − Soll', Math.abs(zahl(rA[spalte('Saldo')]) - (16.5 - sollErwartet)) < 0.001, rA[spalte('Saldo')]);

    // B: nichts gebucht → Ist 0, Soll voll
    ok('B · ohne Buchung: Ist 0', zahl(rB[spalte('Ist-Stunden')]) === 0, rB[spalte('Ist-Stunden')]);
    ok('B · ohne Buchung: volles Soll', zahl(rB[spalte('Soll-Stunden')]) === werktage.length * 8, rB[spalte('Soll-Stunden')]);
    ok('B · leere Personalnummer bleibt leer', rB[0] === '', JSON.stringify(rB[0]));

    // C: ausgestellt → gekennzeichnet, Soll nur bis zum Austritt
    ok('C · ist trotz Austritt in der Datei', !!rC);
    ok('C · Austrittsdatum ausgewiesen', rC[spalte('Beschäftigt bis')] === austritt, rC[spalte('Beschäftigt bis')]);
    ok('C · Ist-Stunden 8', zahl(rC[spalte('Ist-Stunden')]) === 8, rC[spalte('Ist-Stunden')]);
    const werktageBisAustritt = werktage.filter(d => tag(d) <= austritt).length;
    ok(`C · Soll endet mit dem Austritt (${werktageBisAustritt} Tage)`,
      zahl(rC[spalte('Soll-Stunden')]) === werktageBisAustritt * 8, rC[spalte('Soll-Stunden')]);

    // Summenzeile
    const summe = rows[rows.length - 1];
    ok('letzte Zeile ist die Summe', summe[1] === 'Summe', JSON.stringify(summe.slice(0, 3)));
    const summeIst = rows.slice(1, -1).reduce((s, r) => s + zahl(r[spalte('Ist-Stunden')]), 0);
    ok('Summe der Ist-Stunden stimmt', Math.abs(zahl(summe[spalte('Ist-Stunden')]) - summeIst) < 0.01,
      `${summe[spalte('Ist-Stunden')]} vs ${summeIst}`);
    ok('Überstunden gesamt wird NICHT aufsummiert (wäre bedeutungslos)', summe[spalte('Überstunden gesamt')] === '');

    // ── Gegenprobe: dieselben Zahlen wie in Statistik und Abwesenheits-Übersicht ──
    console.log('Deckungsgleich mit der Anzeige:');
    for (const [uid, name] of [[a.id, 'AA Vollfall'], [b.id, 'BB Ohne alles'], [c.id, 'CC Ausgestellt']]) {
      const zeile = finde(name);
      const st = await req('GET', `/api/statistics?user_ids=${uid}&period=month&date=${tag(15)}`, admin);
      const u = st.body && st.body.users && st.body.users[0];
      const sum = await req('GET', `/api/absences/summary?from=${tag(1)}&to=${tag(letzterTag)}&user_id=${uid}`, admin);
      const s = (sum.body && sum.body.summary) || {};
      const gleich = u
        && Math.abs(u.ist - zahl(zeile[spalte('Ist-Stunden')])) < 0.005
        && Math.abs(u.soll - zahl(zeile[spalte('Soll-Stunden')])) < 0.005
        && Math.abs(u.ueber - zahl(zeile[spalte('Saldo')])) < 0.005
        && Math.abs(u.ueber_gesamt - zahl(zeile[spalte('Überstunden gesamt')])) < 0.005
        && Math.abs((s.urlaub || 0) - zahl(zeile[spalte('Urlaub')])) < 0.005
        && Math.abs((s.krank || 0) - zahl(zeile[spalte('Krank')])) < 0.005;
      ok(`${name}: CSV = Statistik + Abwesenheits-Übersicht`, gleich,
        u ? `CSV ist/soll/saldo/ges ${zeile[spalte('Ist-Stunden')]}/${zeile[spalte('Soll-Stunden')]}/${zeile[spalte('Saldo')]}/${zeile[spalte('Überstunden gesamt')]} vs API ${u.ist}/${u.soll}/${u.ueber}/${u.ueber_gesamt}` : 'kein Nutzer in der Statistik');
    }

    // ── Rechte ────────────────────────────────────────────────────────────
    console.log('Rechte:');
    const maTok = (await req('POST', '/api/auth/login', null, { username: 'lohn_a', password: 'Test1234!' })).body.token;
    const verboten = await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, maTok);
    ok('Mitarbeiter bekommt 403', verboten.status === 403, String(verboten.status));
    const ohne = await req('GET', `/api/payroll/monat.csv?month=${MONAT}`);
    ok('ohne Anmeldung 401', ohne.status === 401, String(ohne.status));
    const buchTok = (await req('POST', '/api/auth/login', null, { username: 'buchhalter', password: (fs.readFileSync('/tmp/lohnexport-srv.log', 'utf8').match(/buchhalter\s+->\s+(\S+)/) || [])[1] })).body.token;
    const buch = await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, buchTok);
    ok('Buchhalter darf exportieren', buch.status === 200, String(buch.status));

    console.log('Eingabeprüfung:');
    for (const schlecht of ['', '2026-13', 'Juli', '2026-7', '2026-07-01']) {
      const r = await req('GET', `/api/payroll/monat.csv?month=${encodeURIComponent(schlecht)}`, admin);
      ok(`ungültiger Monat „${schlecht}" → 400`, r.status === 400, String(r.status));
    }

    console.log('Protokollierung:');
    const audit = await req('GET', '/api/audit?action=payroll_export', admin);
    const eintraege = (audit.body && audit.body.logs) || [];
    ok('Export steht im Audit-Log', eintraege.length >= 1, JSON.stringify(audit.body).slice(0, 120));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nLohn-Export: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
