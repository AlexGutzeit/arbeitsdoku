// Arbeitsnachweis-PDF: zweizeilige Adressen stehen vollständig und ohne „…", nur wirklich zu lange Zellen werden gekürzt.
//
// Bis pdfkit 0.16 hängte die Option `ellipsis` bei Text, der GENAU zwei Zeilen hoch war, ein „…" an die erste Zeile —
// eine Rundungsfrage in „y + 2 Zeilenhöhen > Unterkante". Meist stand die zweite Zeile trotzdem da („Straße 6…" über
// „PLZ Ort"), manchmal fehlte sie ganz. Im Vorher/Nachher-Vergleich vom 24.10.2026 an der Prod-Kopie: 1070 „…" in 126
// PDFs, mit pdfkit 0.20 noch 18; in 34 PDFs stand danach mehr Text, in keinem weniger.
//   node tests/pdf-zellen-kuerzen.js        (braucht pdftotext)
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3380, DB = '/tmp/pdf-zellen-kuerzen.db', LOG = '/tmp/pdf-zellen-kuerzen-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const s = []; x.on('data', c => s.push(c)); x.on('end', () => { const buf = Buffer.concat(s); let j = null; try { j = JSON.parse(buf); } catch (_) {} res({ status: x.statusCode, body: j, buf }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}

(async () => {
  if (spawnSync('which', ['pdftotext']).status !== 0) { console.log('pdftotext fehlt — Test übersprungen.'); process.exit(0); }
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(150); }
    const apw = (fs.readFileSync(LOG, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'zk_ma', password: 'Test1234!', name: 'Zelle Kurz', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 })).body.user;

    // Werktage im Vormonat — liegen sicher in der Vergangenheit, und ein frischer Server hat keinen Abschluss.
    const jetzt = new Date(); const tage = [];
    for (let d = new Date(jetzt.getFullYear(), jetzt.getMonth() - 1, 1); tage.length < 6; d.setDate(d.getDate() + 1)) {
      if (d.getDay() >= 1 && d.getDay() <= 5) tage.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    // Die Route bricht „Straße, PLZ Ort" vor der PLZ um → genau zwei Zeilen.
    const adressen = ['Musterweg 6, 96126 Musterhausen', 'Am Beispielgrund 3, 97491 Probstadt', 'Hans-Probe-Straße 11, 97461 Testheim',
      'Lindenallee 27, 12345 Neudorf am Bach'];
    for (let i = 0; i < adressen.length; i++) {
      await req('POST', '/api/entries', admin, { date: tage[i], time_from: '07:00', time_to: '11:00', user_id: ma.id, address: adressen[i], description: 'Kurz' });
    }
    const lang = Array.from({ length: 80 }, (_, i) => 'Satzteil' + (i + 1)).join(' ') + ' ENDE-DER-BESCHREIBUNG';
    await req('POST', '/api/entries', admin, { date: tage[4], time_from: '07:00', time_to: '15:00', user_id: ma.id, address: 'Musterweg 6', description: lang });

    const r = await req('GET', `/api/pdf/export?user_id=${ma.id}&date_from=${tage[0]}&date_to=${tage[5]}`, admin);
    ok('PDF kommt', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF', String(r.status));
    const datei = '/tmp/pdf-zellen-kuerzen.pdf'; fs.writeFileSync(datei, r.buf);
    const text = spawnSync('pdftotext', ['-layout', datei, '-'], { encoding: 'utf8' }).stdout;

    console.log('── Zweizeilige Adressen ──');
    for (const a of adressen) {
      const [strasse, ort] = a.split(', ');
      ok(`„${strasse}" steht da, ohne „…"`, text.includes(strasse) && !text.includes(strasse + '…'),
        (text.split('\n').find(z => z.includes(strasse.slice(0, 8))) || '(fehlt)').trim());
      ok(`zweite Zeile „${ort}" steht da`, text.includes(ort));
    }
    console.log('── Wirklich zu lang ──');
    ok('überlange Beschreibung endet mit „…"', /Satzteil\d+…/.test(text), (text.match(/Satzteil\d+\S*/g) || []).slice(-1)[0]);
    ok('… und ihr Ende ist abgeschnitten', !text.includes('ENDE-DER-BESCHREIBUNG'));
    ok('ihr Anfang steht da', text.includes('Satzteil1 '));
    const auslassungen = (text.match(/…/g) || []).length;
    ok('genau eine Auslassung im ganzen Dokument', auslassungen === 1, String(auslassungen));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (_) {} }
  console.log(`\nPDF-Zellen kürzen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
