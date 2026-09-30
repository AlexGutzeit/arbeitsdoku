// Meldungen — Server: Themen, Melden, Rechte, Status, History (Alex, 30.09.2026).
//
// Alex: Chef/Admin legen Themen an (Auto 1, Papiermüll …), jeder meldet Probleme dazu. Jeder ändert nach dem
// Speichern nur seine eigenen; Chef/Admin alle und setzen „in Arbeit"/„erledigt"; erledigt → History; ein
// gelöschtes Thema bleibt in der History, sobald eine Meldung daran hängt; der Admin kann endgültig löschen.
// Dazu (Rückfragen, entschieden): Einzelrecht „Meldungen bearbeiten" (Status, alle ändern — aber keine Themen),
// ändern/zurückziehen nur solange offen, Rückmeldung nur Bearbeiter, wieder öffnen, Verlauf mit Vortext,
// offene Meldungen eines gelöschten Themas wandern mit in die History und sind dort nur zu lesen.
//
//   node tests/meldungen.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const initSqlJs = require('sql.js');

const PORT = 3358, DB = '/tmp/meldungen-test.db', LOG = '/tmp/meldungen-test.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let beendet = false;
  const beenden = async () => { if (beendet) return; beendet = true; srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 4000); }); };
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const id = {}, t = {};
    for (const [u, n, r, extra] of [['carla', 'Carla Chef', 'chef', {}], ['anna', 'Anna Berger', 'mitarbeiter', {}],
      ['moritz', 'Moritz Muster', 'mitarbeiter', {}], ['vera', 'Vera Vorarbeit', 'mitarbeiter', { can_meldungen: true }],
      ['bea', 'Bea Buchhalt', 'buchhalter', {}]]) {
      const a = await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r, ...extra });
      id[u] = a.body.user.id;
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }

    console.log('Einzelrecht');
    {
      const vera = (await req('GET', '/api/auth/me', t.vera)).body.user;
      ok('Vera hat „Meldungen bearbeiten" (kommt über /api/auth/me an)', vera && Number(vera.can_meldungen) === 1, JSON.stringify(vera && vera.can_meldungen));
      const c = await req('PUT', `/api/users/${id.carla}`, admin, { can_meldungen: true });
      ok('bei Chef/Admin wird das Häkchen geleert (sie haben es per Rolle)', c.body.user.can_meldungen === 0, JSON.stringify(c.body.user.can_meldungen));
      const neu = await req('POST', '/api/users', admin, { username: 'otto', password: 'Test1234!', name: 'Otto Oben', role: 'admin', can_meldungen: true });
      ok('… auch beim Anlegen', neu.body.user.can_meldungen === 0);
      const daten = (await req('GET', '/api/users/meine-daten', t.vera)).body;
      ok('Datenauskunft nennt das Recht', daten && daten.stammdaten && daten.stammdaten.can_meldungen === 1);
    }

    console.log('Themen');
    const thema = {};
    {
      ok('Mitarbeiter legt kein Thema an', (await req('POST', '/api/meldungen/themen', t.anna, { name: 'Test' })).status === 403);
      ok('auch mit Einzelrecht nicht (Themen: nur Chef/Admin)', (await req('POST', '/api/meldungen/themen', t.vera, { name: 'Test' })).status === 403);
      for (const n of ['Allgemein', 'Auto 1', 'Auto 2', 'Papiermüll', 'Leer']) {
        const r = await req('POST', '/api/meldungen/themen', t.carla, { name: n });
        thema[n] = r.body && r.body.thema && r.body.thema.id;
      }
      ok('Chef legt fünf Themen an', Object.values(thema).every(Boolean), JSON.stringify(thema));
      ok('doppelter Name (Groß/klein egal) → 409', (await req('POST', '/api/meldungen/themen', admin, { name: 'auto 1' })).status === 409);
      ok('leerer Name → 400', (await req('POST', '/api/meldungen/themen', admin, { name: '  ' })).status === 400);
      const um = await req('PUT', `/api/meldungen/themen/${thema['Papiermüll']}`, t.carla, { name: 'Papiermüll blau' });
      ok('umbenennen', um.status === 200 && um.body.thema.name === 'Papiermüll blau');
      const folge = [thema['Auto 2'], thema['Allgemein'], thema['Auto 1'], thema['Papiermüll'], thema['Leer']];
      ok('Reihenfolge setzen', (await req('PUT', '/api/meldungen/themen-reihenfolge', t.carla, { ids: folge })).status === 200);
      ok('unvollständige Reihenfolge → 409', (await req('PUT', '/api/meldungen/themen-reihenfolge', t.carla, { ids: folge.slice(1) })).status === 409);
      const liste = (await req('GET', '/api/meldungen', t.anna)).body;
      ok('alle sehen die Themen in der gesetzten Reihenfolge', JSON.stringify(liste.themen.map(x => x.id)) === JSON.stringify(folge), JSON.stringify(liste.themen));
      ok('„darf" für den Mitarbeiter: nichts', !liste.darf.bearbeiten && !liste.darf.verwalten && !liste.darf.loeschen, JSON.stringify(liste.darf));
      const dv = (await req('GET', '/api/meldungen', t.vera)).body.darf;
      ok('„darf" mit Einzelrecht: bearbeiten, nicht verwalten', dv.bearbeiten && !dv.verwalten && !dv.loeschen, JSON.stringify(dv));
      const da = (await req('GET', '/api/meldungen', admin)).body.darf;
      ok('„darf" für den Admin: alles', da.bearbeiten && da.verwalten && da.loeschen, JSON.stringify(da));
    }

    console.log('Melden');
    let oel, wischer, voll;
    {
      const r = await req('POST', '/api/meldungen', t.anna, { thema_id: thema['Auto 2'], text: '  Ölwechsel fällig  ', dringend: true });
      oel = r.body && r.body.meldung;
      ok('Anna meldet „Ölwechsel" (dringend), Text getrimmt', r.status === 201 && oel.text === 'Ölwechsel fällig' && oel.dringend === true && oel.status === 'offen',
        JSON.stringify(r.body));
      ok('… von wem, wann', oel.created_by_name === 'Anna Berger' && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(oel.created_at));
      wischer = (await req('POST', '/api/meldungen', t.moritz, { thema_id: thema['Auto 2'], text: 'Wischer quietscht' })).body.meldung;
      voll = (await req('POST', '/api/meldungen', t.moritz, { thema_id: thema['Papiermüll'], text: 'voll' })).body.meldung;
      ok('ohne Thema → 400', (await req('POST', '/api/meldungen', t.anna, { text: 'x' })).status === 400);
      ok('ohne Text → 400', (await req('POST', '/api/meldungen', t.anna, { thema_id: thema['Auto 1'], text: ' ' })).status === 400);
      ok('zu langer Text → 400', (await req('POST', '/api/meldungen', t.anna, { thema_id: thema['Auto 1'], text: 'x'.repeat(2001) })).status === 400);
      const liste = (await req('GET', '/api/meldungen', t.moritz)).body.meldungen;
      ok('alle sehen alle offenen Meldungen (Moritz sieht Annas)', liste.some(m => m.id === oel.id) && liste.length === 3, JSON.stringify(liste.map(m => m.id)));
      ok('„eigen" stimmt je Betrachter', liste.find(m => m.id === oel.id).eigen === false && liste.find(m => m.id === wischer.id).eigen === true);
      ok('dringende stehen vorn', liste[0].id === oel.id);
    }

    console.log('Ändern — eigene nur solange offen');
    {
      const r = await req('PUT', `/api/meldungen/${oel.id}`, t.anna, { text: 'Ölwechsel überfällig', dringend: false });
      ok('Anna ändert ihre offene Meldung', r.status === 200 && r.body.meldung.text === 'Ölwechsel überfällig' && r.body.meldung.dringend === false);
      ok('Moritz ändert Annas Meldung nicht (403)', (await req('PUT', `/api/meldungen/${oel.id}`, t.moritz, { text: 'x' })).status === 403);
      ok('Anna schreibt keine Rückmeldung (403)', (await req('PUT', `/api/meldungen/${oel.id}`, t.anna, { rueckmeldung: 'x' })).status === 403);
      ok('Anna setzt keinen Stand (403)', (await req('POST', `/api/meldungen/${oel.id}/status`, t.anna, { status: 'erledigt' })).status === 403);
      ok('Buchhalter ohne Häkchen setzt keinen Stand (403)', (await req('POST', `/api/meldungen/${oel.id}/status`, t.bea, { status: 'in_arbeit' })).status === 403);
      const gleich = await req('PUT', `/api/meldungen/${oel.id}`, t.anna, { text: 'Ölwechsel überfällig' });
      ok('ohne echte Änderung: nichts geschrieben', gleich.body.unveraendert === true);
      const d = (await req('GET', `/api/meldungen/${oel.id}`, t.moritz)).body;
      const arten = d.verlauf.map(v => v.art);
      ok('Verlauf: gemeldet, bearbeitet (mit Vortext), Dringlichkeit', JSON.stringify(arten) === '["gemeldet","bearbeitet","dringlichkeit"]'
        && d.verlauf[1].vorher === 'Ölwechsel fällig' && d.verlauf[1].nachher === 'Ölwechsel überfällig' && d.verlauf[1].user_name === 'Anna Berger', JSON.stringify(d.verlauf));
      const th = await req('PUT', `/api/meldungen/${oel.id}`, t.anna, { thema_id: thema['Auto 1'] });
      ok('Thema wechseln (falsch einsortiert)', th.status === 200 && th.body.meldung.thema_id === thema['Auto 1']);
      await req('PUT', `/api/meldungen/${oel.id}`, t.anna, { thema_id: thema['Auto 2'] });
    }

    console.log('Stand setzen (Chef, Einzelrecht)');
    {
      const r = await req('POST', `/api/meldungen/${oel.id}/status`, t.carla, { status: 'in_arbeit' });
      ok('Chef setzt „in Arbeit" — von wem, wann', r.status === 200 && r.body.meldung.status === 'in_arbeit' && r.body.meldung.status_by_name === 'Carla Chef' && !!r.body.meldung.status_at);
      ok('jetzt ändert Anna nicht mehr (409)', (await req('PUT', `/api/meldungen/${oel.id}`, t.anna, { text: 'y' })).status === 409);
      ok('… und zieht nicht mehr zurück (409)', (await req('POST', `/api/meldungen/${oel.id}/zurueckziehen`, t.anna)).status === 409);
      const rm = await req('PUT', `/api/meldungen/${oel.id}`, t.carla, { rueckmeldung: 'Werkstatt am 05.10.' });
      ok('Chef schreibt eine Rückmeldung', rm.status === 200 && rm.body.meldung.rueckmeldung === 'Werkstatt am 05.10.' && rm.body.meldung.updated_by_name === 'Carla Chef');
      const v = await req('PUT', `/api/meldungen/${wischer.id}`, t.vera, { text: 'Wischerblätter vorne tauschen' });
      ok('Einzelrecht: Vera ändert die Meldung von Moritz',v.status === 200 && v.body.meldung.text === 'Wischerblätter vorne tauschen');
      ok('Einzelrecht: Vera setzt „erledigt"', (await req('POST', `/api/meldungen/${wischer.id}/status`, t.vera, { status: 'erledigt' })).body.meldung.status === 'erledigt');
      ok('unbekannter Stand → 400', (await req('POST', `/api/meldungen/${oel.id}/status`, t.carla, { status: 'zurueckgezogen' })).status === 400);
      const e = await req('POST', `/api/meldungen/${oel.id}/status`, t.carla, { status: 'erledigt' });
      ok('Chef setzt „erledigt"', e.body.meldung.status === 'erledigt' && e.body.meldung.in_history === true);
      const offen = (await req('GET', '/api/meldungen', t.anna)).body.meldungen.map(m => m.id);
      ok('erledigte stehen nicht mehr bei den offenen', !offen.includes(oel.id) && !offen.includes(wischer.id) && offen.includes(voll.id), JSON.stringify(offen));
      const h = (await req('GET', '/api/meldungen/history', t.anna)).body;
      ok('… sondern in der History (neueste zuerst)', h.meldungen.map(m => m.id).join() === [oel.id, wischer.id].join(), JSON.stringify(h.meldungen.map(m => m.id)));
      const w = await req('POST', `/api/meldungen/${oel.id}/status`, t.carla, { status: 'offen' });
      ok('wieder öffnen', w.body.meldung.status === 'offen' && (await req('GET', '/api/meldungen', t.anna)).body.meldungen.some(m => m.id === oel.id));
      const d = (await req('GET', `/api/meldungen/${oel.id}`, t.anna)).body.verlauf.filter(x => x.art === 'status').map(x => `${x.vorher}>${x.nachher}:${x.user_name}`);
      ok('Verlauf der Stände mit Namen', JSON.stringify(d) === JSON.stringify(['offen>in_arbeit:Carla Chef', 'in_arbeit>erledigt:Carla Chef', 'erledigt>offen:Carla Chef']), JSON.stringify(d));
    }

    console.log('Zurückziehen');
    {
      ok('Moritz zieht Annas Meldung nicht zurück (403)', (await req('POST', `/api/meldungen/${oel.id}/zurueckziehen`, t.moritz)).status === 403);
      ok('auch der Chef nicht (nur der Melder)', (await req('POST', `/api/meldungen/${voll.id}/zurueckziehen`, t.carla)).status === 403);
      const z = await req('POST', `/api/meldungen/${voll.id}/zurueckziehen`, t.moritz);
      ok('Moritz zieht seine offene Meldung zurück → History', z.status === 200 && z.body.meldung.status === 'zurueckgezogen' && z.body.meldung.in_history);
    }

    console.log('History: Filter und Suche');
    {
      const nachThema = (await req('GET', `/api/meldungen/history?thema_id=${thema['Papiermüll']}`, t.anna)).body.meldungen.map(m => m.id);
      ok('nach Thema', JSON.stringify(nachThema) === JSON.stringify([voll.id]), JSON.stringify(nachThema));
      const such = (await req('GET', '/api/meldungen/history?q=' + encodeURIComponent('wischerBLÄTTER'), t.anna)).body.meldungen.map(m => m.id);
      ok('Suche im Text (Groß/klein egal, auch bei Umlauten)', JSON.stringify(such) === JSON.stringify([wischer.id]), JSON.stringify(such));
      const nachName = (await req('GET', '/api/meldungen/history?q=' + encodeURIComponent('moritz'), t.anna)).body.meldungen.map(m => m.id);
      ok('Suche nach dem Melder', JSON.stringify(nachName) === JSON.stringify([voll.id, wischer.id]), JSON.stringify(nachName));
      const seiteSuche = (await req('GET', '/api/meldungen/history?q=moritz&limit=1', t.anna)).body;
      ok('Suche seitenweise', seiteSuche.meldungen.length === 1 && seiteSuche.mehr === true);
      const prozent = (await req('GET', '/api/meldungen/history?q=' + encodeURIComponent('%'), t.anna)).body.meldungen;
      ok('„%" sucht wörtlich (kein Platzhalter)', prozent.length === 0, prozent.length);
      const seite = (await req('GET', '/api/meldungen/history?limit=1', t.anna)).body;
      ok('seitenweise: „mehr" gemeldet', seite.meldungen.length === 1 && seite.mehr === true);
    }

    console.log('Thema löschen');
    let offenImGeloeschten;
    {
      offenImGeloeschten = (await req('POST', '/api/meldungen', t.anna, { thema_id: thema['Auto 2'], text: 'Reifendruck prüfen' })).body.meldung;
      ok('Mitarbeiter löscht kein Thema', (await req('DELETE', `/api/meldungen/themen/${thema['Auto 2']}`, t.anna)).status === 403);
      ok('Einzelrecht löscht kein Thema', (await req('DELETE', `/api/meldungen/themen/${thema['Auto 2']}`, t.vera)).status === 403);
      const d = await req('DELETE', `/api/meldungen/themen/${thema['Auto 2']}`, t.carla);
      // offen: „Reifendruck" und der wieder geöffnete „Ölwechsel"
      ok('Thema mit Meldungen: gelöscht, 3 bleiben in der History, 2 davon offen', d.status === 200 && d.body.inHistory === 3 && d.body.offen === 2, JSON.stringify(d.body));
      const l = (await req('GET', '/api/meldungen', t.anna)).body;
      ok('Thema und seine offene Meldung sind aus der Übersicht', !l.themen.some(x => x.id === thema['Auto 2']) && !l.meldungen.some(m => m.id === offenImGeloeschten.id));
      const h = (await req('GET', `/api/meldungen/history?thema_id=${thema['Auto 2']}`, t.anna)).body;
      const m = h.meldungen.find(x => x.id === offenImGeloeschten.id);
      ok('die offene Meldung steht in der History, Status „offen", Vermerk „Thema gelöscht"', m && m.status === 'offen' && m.thema_geloescht === true && m.thema_name === 'Auto 2', JSON.stringify(m));
      ok('der Themen-Filter der History kennt das gelöschte Thema', h.themen.some(x => x.id === thema['Auto 2'] && x.geloescht === true), JSON.stringify(h.themen));
      const v = (await req('GET', `/api/meldungen/${offenImGeloeschten.id}`, t.anna)).body.verlauf.map(x => x.art);
      ok('Verlauf: „Thema gelöscht"', v.includes('thema_geloescht'), JSON.stringify(v));
      ok('dort nur noch zu lesen: kein Stand (409)', (await req('POST', `/api/meldungen/${offenImGeloeschten.id}/status`, t.carla, { status: 'erledigt' })).status === 409);
      ok('… keine Änderung (409)', (await req('PUT', `/api/meldungen/${offenImGeloeschten.id}`, t.anna, { text: 'z' })).status === 409);
      ok('… und kein Melden auf das gelöschte Thema (400)', (await req('POST', '/api/meldungen', t.anna, { thema_id: thema['Auto 2'], text: 'z' })).status === 400);
      const leer = await req('DELETE', `/api/meldungen/themen/${thema['Leer']}`, t.carla);
      ok('Thema ohne Meldungen: ganz weg', leer.status === 200 && leer.body.inHistory === 0);
      const neuGleich = await req('POST', '/api/meldungen/themen', t.carla, { name: 'Auto 2' });
      ok('der Name eines gelöschten Themas ist wieder frei', neuGleich.status === 201, JSON.stringify(neuGleich.body));
    }

    console.log('Endgültig löschen');
    {
      ok('Chef löscht nicht endgültig (403)', (await req('DELETE', `/api/meldungen/${voll.id}`, t.carla)).status === 403);
      ok('Einzelrecht auch nicht', (await req('DELETE', `/api/meldungen/${voll.id}`, t.vera)).status === 403);
      const d = await req('DELETE', `/api/meldungen/${voll.id}`, admin);
      ok('Admin löscht endgültig', d.status === 200 && (await req('GET', `/api/meldungen/${voll.id}`, admin)).status === 404);
    }

    console.log('Protokoll, Kontolöschung, Datenauskunft');
    {
      const a = (await req('GET', '/api/audit?limit=500', admin)).body;
      const arten = new Set(((a && (a.logs || a.entries)) || []).map(x => x.action));
      const fehlt = ['meldung_create', 'meldung_update', 'meldung_status', 'meldung_zurueckgezogen', 'meldung_delete',
        'meldung_thema_create', 'meldung_thema_update', 'meldung_thema_reihenfolge', 'meldung_thema_delete'].filter(x => !arten.has(x));
      ok('jede Aktion steht im Protokoll', fehlt.length === 0, 'fehlt: ' + fehlt.join(', '));
      const geloescht = ((a && (a.logs || a.entries)) || []).find(x => x.action === 'meldung_delete');
      ok('… das endgültige Löschen mit Text und Melder', geloescht && /voll/.test(geloescht.details) && /Moritz Muster/.test(geloescht.details), geloescht && geloescht.details);
      // Die Vorschau gibt es nur für Ausgestellte: Anstellung rückdatieren, dann zum Vortag ausstellen
      const tag = (n) => { const x = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      await req('POST', `/api/statistics/targets/${id.anna}`, t.carla, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: tag(-30) });
      const aus = await req('POST', `/api/users/${id.anna}/deactivate`, admin, { employed_until: tag(-1) });
      ok('Anna ausgestellt (für die Vorschau)', aus.status === 200, JSON.stringify(aus.body));
      const vs = (await req('GET', `/api/users/${id.anna}/loeschen-vorschau`, admin)).body;
      ok('Löschvorschau: Annas Meldungen bleiben', vs && vs.bleibt && vs.bleibt.meldungen === 2, JSON.stringify(vs && vs.bleibt));
      const daten = (await req('GET', '/api/users/meine-daten', t.moritz)).body;
      ok('Datenauskunft: eigene Meldungen', daten.meldungen_von_mir && daten.meldungen_von_mir.length === 1, JSON.stringify(daten.meldungen_von_mir && daten.meldungen_von_mir.length));
    }
    await beenden();

    console.log('Datenbank danach');
    {
      const SQL = await initSqlJs(); const d = new SQL.Database(fs.readFileSync(DB));
      const n = (s) => d.exec(s)[0].values[0][0];
      ok('kein Verlauf ohne Meldung (endgültig gelöscht = mit Verlauf weg)', n('SELECT COUNT(*) FROM meldung_verlauf WHERE meldung_id NOT IN (SELECT id FROM meldungen)') === 0);
      ok('gelöschtes Thema mit Meldungen: weich (deleted_at gesetzt)', n(`SELECT COUNT(*) FROM meldung_themen WHERE id = ${thema['Auto 2']} AND deleted_at IS NOT NULL`) === 1);
      ok('leeres Thema: ganz weg', n(`SELECT COUNT(*) FROM meldung_themen WHERE id = ${thema['Leer']}`) === 0);
      d.close();
    }
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    await beenden();
  }
  console.log(`\nMeldungen (Server): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
