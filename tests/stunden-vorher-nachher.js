// BEWEIS: Die ausgewiesenen Stunden und Überstunden ändern sich durch die Zusammenlegung der
// Berechnung (routes/user-hours.js) NICHT — niemand hat morgen mehr oder weniger Überstunden.
//
// Kein Unit-Vergleich, sondern Ende zu Ende: ZWEI Server, einer mit dem ALTEN Code (git-Stand vor
// der Änderung), einer mit dem NEUEN — beide gegen eine eigene Kopie DERSELBEN Produktivdaten.
// Verglichen wird, was die App tatsächlich ausliefert, für JEDEN Mitarbeiter über viele Zeiträume.
//
// Voraussetzung: /tmp/prodklon.db und ein Arbeitsverzeichnis mit dem alten Stand unter
//   git worktree add /tmp/vorher-stand <commit-vor-der-aenderung>
//   ln -sfn <projekt>/node_modules /tmp/vorher-stand/node_modules
// Fehlt eines von beidem, überspringt sich der Test.
//   node tests/stunden-vorher-nachher.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const ALT_DIR = '/tmp/vorher-stand';
const QUELLE = '/tmp/prodklon.db';
const PORT_ALT = 3147, PORT_NEU = 3148;
const DB_ALT = '/tmp/vgl-alt.db', DB_NEU = '/tmp/vgl-neu.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function hole(port, pfad, token) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port, path: pfad, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); r.end();
  });
}
const gesund = (port) => new Promise(res => {
  const r = http.request({ host: 'localhost', port, path: '/health', method: 'GET' }, x => { x.resume(); res(x.statusCode === 200); });
  r.on('error', () => res(false)); r.end();
});
const rund = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test uebersprungen.'); process.exit(0); }
  if (!fs.existsSync(path.join(ALT_DIR, 'server.js'))) {
    console.log('Alter Codestand unter ' + ALT_DIR + ' fehlt — Test uebersprungen.');
    console.log('  Anlegen mit: git worktree add ' + ALT_DIR + ' <commit>');
    process.exit(0);
  }
  fs.copyFileSync(QUELLE, DB_ALT);
  fs.copyFileSync(QUELLE, DB_NEU);

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(QUELLE));
  const nutzer = db.exec("SELECT id, name, role FROM users ORDER BY id")[0].values.map(v => ({ id: v[0], name: v[1], role: v[2] }));
  const [adminId] = db.exec("SELECT id FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
  const monate = db.exec("SELECT DISTINCT substr(date,1,7) m FROM entries WHERE deleted_at IS NULL ORDER BY m")[0].values.map(v => v[0]);
  db.close();
  const token = jwt.sign({ userId: adminId, role: 'admin' }, SECRET, { expiresIn: '4h' });

  console.log(`  ${nutzer.length} Nutzer · ${monate.length} Monate mit Buchungen (${monate[0]} bis ${monate[monate.length - 1]})`);

  const start = (dir, port, dbPfad, log) => spawn('node', ['server.js'], {
    cwd: dir, env: { ...process.env, PORT: String(port), DB_PATH: dbPfad, JWT_SECRET: SECRET },
    stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log + '.err', 'w')],
  });

  const alt = start(ALT_DIR, PORT_ALT, DB_ALT, '/tmp/vgl-alt.log');
  const neu = start(process.cwd(), PORT_NEU, DB_NEU, '/tmp/vgl-neu.log');
  try {
    for (let i = 0; i < 80; i++) { if (await gesund(PORT_ALT) && await gesund(PORT_NEU)) break; await sleep(250); }
    ok('alter Stand läuft', await gesund(PORT_ALT));
    ok('neuer Stand läuft', await gesund(PORT_NEU));

    // ── Statistik: Ist, Soll, Saldo, Start-Überstunden, Überstunden gesamt ──────────────────────
    console.log('Statistik (Ist · Soll · Saldo · Überstunden gesamt):');
    let vergleiche = 0; const abweichungen = [];
    const perioden = [];
    for (const m of monate) perioden.push(['month', `${m}-15`]);
    const jahre = [...new Set(monate.map(m => m.slice(0, 4)))];
    for (const j of jahre) { perioden.push(['year', `${j}-06-15`]); perioden.push(['total', `${j}-12-31`]); }

    for (const u of nutzer) {
      for (const [period, datum] of perioden) {
        const pfad = `/api/statistics?user_ids=${u.id}&period=${period}&date=${datum}`;
        const [a, n] = await Promise.all([hole(PORT_ALT, pfad, token), hole(PORT_NEU, pfad, token)]);
        const ua = a.body && a.body.users && a.body.users[0];
        const un = n.body && n.body.users && n.body.users[0];
        vergleiche++;
        if (!ua && !un) continue;                       // beide leer → gleich
        if (!ua || !un) { abweichungen.push(`${u.name} ${period}/${datum}: Zeile fehlt (alt ${!!ua}, neu ${!!un})`); continue; }
        for (const f of ['ist', 'soll', 'ueber', 'start_overtime', 'ueber_gesamt']) {
          if (rund(ua[f]) !== rund(un[f])) abweichungen.push(`${u.name} ${period}/${datum} ${f}: alt ${rund(ua[f])} vs neu ${rund(un[f])}`);
        }
        // Auch die Monatsbalken der Zeitleiste
        const ta = ua.timeline || [], tn = un.timeline || [];
        if (ta.length !== tn.length) abweichungen.push(`${u.name} ${period}/${datum}: Zeitleiste ${ta.length} vs ${tn.length}`);
        else for (let i = 0; i < ta.length; i++) {
          if (rund(ta[i].ist) !== rund(tn[i].ist) || rund(ta[i].soll) !== rund(tn[i].soll)) {
            abweichungen.push(`${u.name} ${period}/${datum} Zeitleiste ${ta[i].label}: alt ${ta[i].ist}/${ta[i].soll} vs neu ${tn[i].ist}/${tn[i].soll}`);
          }
        }
      }
    }
    ok(`Statistik identisch (${vergleiche} Abfragen über alle Nutzer und Zeiträume)`,
      abweichungen.length === 0, abweichungen.slice(0, 5).join(' | '));

    // ── Überstunden-Endpunkt (der Stand, der im Dashboard steht) ────────────────────────────────
    console.log('Überstundenstand:');
    const otAbw = [];
    let otVergleiche = 0;
    for (const u of nutzer) {
      for (const stichtag of [monate[monate.length - 1] + '-28', monate[0] + '-15', '2027-12-31']) {
        const pfad = `/api/statistics/overtime?user_id=${u.id}&date_to=${stichtag}`;
        const [a, n] = await Promise.all([hole(PORT_ALT, pfad, token), hole(PORT_NEU, pfad, token)]);
        otVergleiche++;
        if (rund(a.body && a.body.overtime) !== rund(n.body && n.body.overtime)) {
          otAbw.push(`${u.name} bis ${stichtag}: alt ${a.body && a.body.overtime} vs neu ${n.body && n.body.overtime}`);
        }
      }
    }
    ok(`Überstundenstand identisch (${otVergleiche} Abfragen)`, otAbw.length === 0, otAbw.slice(0, 5).join(' | '));

    // ── Abwesenheitstage (unverändert, aber zur Sicherheit) ────────────────────────────────────
    console.log('Abwesenheitstage:');
    const absAbw = [];
    for (const u of nutzer) {
      for (const m of monate.slice(-6)) {
        const letzter = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
        const pfad = `/api/absences/summary?from=${m}-01&to=${m}-${letzter}&user_id=${u.id}`;
        const [a, n] = await Promise.all([hole(PORT_ALT, pfad, token), hole(PORT_NEU, pfad, token)]);
        if (JSON.stringify(a.body && a.body.summary) !== JSON.stringify(n.body && n.body.summary)) {
          absAbw.push(`${u.name} ${m}: ${JSON.stringify(a.body && a.body.summary)} vs ${JSON.stringify(n.body && n.body.summary)}`);
        }
      }
    }
    ok('Abwesenheitstage identisch', absAbw.length === 0, absAbw.slice(0, 3).join(' | '));

    // ── PDF: Byte für Byte gleich? (ohne Projektfilter UND mit) ────────────────────────────────
    console.log('Arbeitsnachweis-PDF:');
    const pdfBytes = (port, pfad) => new Promise((res, rej) => {
      const r = http.request({ host: 'localhost', port, path: pfad, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
        x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => res(Buffer.concat(teile))); });
      r.on('error', rej); r.end();
    });
    // Die Rohbytes taugen nicht zum Vergleich: das PDF traegt einen Erzeugungszeitstempel, und
    // die Inhalte sind FlateDecode-KOMPRIMIERT — im Rohtext steht nichts Lesbares.
    // Also die Stroeme entpacken und den echten Text herausziehen. Genau daran haette ich mich fast
    // selbst getaeuscht: eine Suche im Rohtext findet nur Metadaten und wirkt trotzdem „stabil".
    const zlib = require('zlib');
    // pdfkit legt Text HEXKODIERT in TJ-Feldern ab: [<53746174697374696b> 0] TJ  ("Statistik").
    // Eine Suche im Rohtext findet daher nichts Brauchbares — und ein Vergleich zweier leerer
    // Ergebnisse waere immer „gleich". Deshalb: Stroeme entpacken, Hex dekodieren, Zahlen sammeln.
    const textAusPdf = (buf) => {
      const teile = [];
      let i2 = 0;
      while (true) {
        const s1 = buf.indexOf('stream', i2);
        if (s1 < 0) break;
        let anfang = s1 + 6;
        if (buf[anfang] === 0x0d) anfang++;
        if (buf[anfang] === 0x0a) anfang++;
        const s2 = buf.indexOf('endstream', anfang);
        if (s2 < 0) break;
        try { teile.push(zlib.inflateSync(buf.subarray(anfang, s2)).toString('latin1')); } catch (_) {}
        i2 = s2 + 9;
      }
      const inhalt = teile.join('\n');
      // Stuecke INNERHALB eines TJ-Feldes gehoeren zu einem Wort (dazwischen nur Kerning-Zahlen).
      const felder = [];
      for (const feld of inhalt.match(/\[[^\]]*\]\s*TJ/g) || []) {
        const stuecke = (feld.match(/<([0-9A-Fa-f]+)>/g) || [])
          .map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'));
        felder.push(stuecke.join(''));
      }
      const text = felder.join(' ');
      return (text.match(/-?\d+[:,.]\d+/g) || []).join(',');
    };
    const zahlenAusPdf = textAusPdf;
    const pdfFaelle = [];
    const letzterMonat = monate[monate.length - 1];
    const lt = new Date(Date.UTC(Number(letzterMonat.slice(0, 4)), Number(letzterMonat.slice(5, 7)), 0)).getUTCDate();
    pdfFaelle.push(['alle Mitarbeiter', `/api/pdf/export?date_from=${letzterMonat}-01&date_to=${letzterMonat}-${lt}`]);
    for (const u of nutzer.slice(0, 6)) {
      pdfFaelle.push([`nur ${u.name}`, `/api/pdf/export?date_from=${letzterMonat}-01&date_to=${letzterMonat}-${lt}&user_id=${u.id}`]);
    }
    const pdfAbw = [];
    let gefundeneZahlen = 0;
    for (const [label, pfad] of pdfFaelle) {
      const [a, n] = await Promise.all([pdfBytes(PORT_ALT, pfad), pdfBytes(PORT_NEU, pfad)]);
      const za = zahlenAusPdf(a), zn = zahlenAusPdf(n);
      gefundeneZahlen = Math.max(gefundeneZahlen, za.split(',').filter(Boolean).length);
      if (za !== zn) pdfAbw.push(label);
    }
    // WICHTIG: Ein Vergleich zweier LEERER Ergebnisse waere immer „gleich" und wuerde nichts
    // beweisen. Also erst sicherstellen, dass wirklich Zahlen aus dem PDF gelesen wurden.
    ok(`PDF-Text wird wirklich gelesen (${gefundeneZahlen} Zahlen im größten Dokument)`,
      gefundeneZahlen >= 20, 'zu wenige Zahlen gefunden — Vergleich wäre wertlos');
    ok(`PDF-Zahlen identisch (${pdfFaelle.length} Varianten)`, pdfAbw.length === 0, pdfAbw.join(', '));

    // Und der Sonderfall Projektfilter — der MUSS ebenfalls unverändert sein
    const projekt = (await hole(PORT_NEU, '/api/projects', token)).body;
    const p1 = projekt && projekt.projects && projekt.projects[0];
    if (p1) {
      const pfad = `/api/pdf/export?date_from=${monate[0]}-01&date_to=${letzterMonat}-${lt}&project_id=${p1.id}`;
      const [a, n] = await Promise.all([pdfBytes(PORT_ALT, pfad), pdfBytes(PORT_NEU, pfad)]);
      const za = zahlenAusPdf(a), zn = zahlenAusPdf(n);
      ok('PDF mit Projektfilter: Zahlen gelesen', za.split(',').filter(Boolean).length >= 5, za.slice(0, 60));
      ok('PDF mit Projektfilter ebenfalls identisch', za === zn, `Projekt „${p1.name}"`);
    } else ok('Projekt für den Filtertest vorhanden', false, 'keine Projekte im Klon');

  } finally {
    alt.kill('SIGTERM'); neu.kill('SIGTERM'); await sleep(1500);
  }
  console.log(`\nVorher/Nachher: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  for (const f of [DB_ALT, DB_NEU]) { try { fs.unlinkSync(f); } catch (_) {} }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
