// Test-Hilfe (kein eigener Test): ein „Gerät", das eine Live-Notiz öffnet — Ereignisstrom + Yjs,
// so wie es der Browser tut, nur ohne Oberfläche. Für Server-Tests der Live-Notizen.
//
//   const g = await geraetOeffnen({ port, ticket, noteId, token });
//   Als Gast einer Notiz (Etappe C):  geraetOeffnen({ port, ticket, token, basis: '/api/gast' })
//   if (g.status !== 200) … ;                   // abgewiesen (401/403/404)
//   await g.schreibe(t => t.insert(0, 'Hallo'));  // → { status, body } der POST-Antwort
//   await g.warte('aenderung');                   // nächstes Ereignis dieser Art
//   g.text(); g.zugriff; g.ereignisse; g.offen
//   g.schliessen();
const http = require('http');
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const ausB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

function post(port, pfad, token, daten) {
  return new Promise((ok, fehler) => {
    const d = JSON.stringify(daten);
    const r = http.request({ host: 'localhost', port, path: pfad, method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d),
      ...(token ? { Authorization: 'Bearer ' + token } : {}) } },
    (res) => { let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} ok({ status: res.statusCode, body: j }); }); });
    r.on('error', fehler); r.write(d); r.end();
  });
}

function geraetOeffnen({ port, ticket, noteId, token, basis }) {
  const wurzel = basis || `/api/notes/${noteId}`;
  return new Promise((fertig) => {
    const g = { status: 0, ereignisse: [], offen: false, doc: null, aw: null, zugriff: null, verbindung: null };
    const warter = [];
    const melden = (typ, daten) => {
      g.ereignisse.push({ typ, daten });
      for (const w of [...warter]) if (w.typ === typ && w.pruef(daten)) { warter.splice(warter.indexOf(w), 1); w.ok(daten); }
    };
    // agent: false — eigene Verbindung wie bei einem Browser-Ereignisstrom. Mit dem Verbindungs-Pool
    // (Node ≥ 19: keep-alive) landete ein vom Server beendeter Strom wieder im Pool und riss eine
    // spätere Anfrage mit („socket hang up", gemessen 26.09.2026).
    const anfrage = http.get({ agent: false, host: 'localhost', port, path: `${wurzel}/live?ticket=${encodeURIComponent(ticket || '')}` }, (res) => {
      g.status = res.statusCode;
      if (res.statusCode !== 200) { res.resume(); return fertig(g); }
      g.offen = true;
      res.setEncoding('utf8');
      let puffer = '';
      res.on('data', (stueck) => {
        puffer += stueck;
        let i;
        while ((i = puffer.indexOf('\n\n')) >= 0) {
          const block = puffer.slice(0, i); puffer = puffer.slice(i + 2);
          const typ = (block.match(/^event: (.+)$/m) || [])[1];
          const zeile = (block.match(/^data: (.+)$/m) || [])[1];
          if (!typ || !zeile) continue;
          const daten = JSON.parse(zeile);
          if (typ === 'start') {
            g.doc = new Y.Doc();
            Y.applyUpdate(g.doc, ausB64(daten.stand), 'server');
            g.aw = new awarenessProtocol.Awareness(g.doc);
            if (daten.anwesenheit) awarenessProtocol.applyAwarenessUpdate(g.aw, ausB64(daten.anwesenheit), 'server');
            g.zugriff = daten.zugriff; g.verbindung = daten.verbindung; g.du = daten.du;
            melden(typ, daten);
            fertig(g);
            continue;
          }
          if (typ === 'aenderung') Y.applyUpdate(g.doc, ausB64(daten.update), 'server');
          if (typ === 'anwesenheit') awarenessProtocol.applyAwarenessUpdate(g.aw, ausB64(daten.update), 'server');
          if (typ === 'zugriff') g.zugriff = daten.zugriff;
          melden(typ, daten);
        }
      });
      res.on('end', () => { g.offen = false; melden('ende', {}); });
      res.on('error', () => { g.offen = false; });
    });
    anfrage.on('error', () => { g.offen = false; fertig(g); });

    g.text = () => g.doc.getText('notiz').toString();
    g.delta = () => g.doc.getText('notiz').toDelta();
    g.schreibe = async (aenderung) => {
      const sv = Y.encodeStateVector(g.doc);
      g.doc.transact(() => aenderung(g.doc.getText('notiz')));
      return post(port, `${wurzel}/live/aenderung`, token, { verbindung: g.verbindung, update: b64(Y.encodeStateAsUpdate(g.doc, sv)) });
    };
    g.rohSenden = (update, verbindung) => post(port, `${wurzel}/live/aenderung`, token, { verbindung: verbindung || g.verbindung, update });
    g.cursor = (index, zusatz = {}) => {
      const pos = Y.createRelativePositionFromTypeIndex(g.doc.getText('notiz'), index);
      g.aw.setLocalState({ user: { name: 'selbst erfunden', color: '#000000' }, cursor: { anchor: pos, head: pos }, ...zusatz });
      return post(port, `${wurzel}/live/anwesenheit`, token,
        { verbindung: g.verbindung, update: b64(awarenessProtocol.encodeAwarenessUpdate(g.aw, [g.doc.clientID])) });
    };
    g.anwesenheitRoh = (update) => post(port, `${wurzel}/live/anwesenheit`, token, { verbindung: g.verbindung, update });
    g.warte = (typ, pruef = () => true, ms = 4000) => {
      const schon = g.ereignisse.find(e => e.typ === typ && pruef(e.daten) && !e.abgeholt);
      if (schon) { schon.abgeholt = true; return Promise.resolve(schon.daten); }
      return new Promise((ok) => {
        const w = { typ, pruef, ok: (d) => { clearTimeout(t); const e = g.ereignisse.find(x => x.daten === d); if (e) e.abgeholt = true; ok(d); } };
        const t = setTimeout(() => { warter.splice(warter.indexOf(w), 1); ok(null); }, ms);
        warter.push(w);
      });
    };
    g.schliessen = () => { try { anfrage.destroy(); } catch (_) {} if (g.aw) g.aw.destroy(); g.offen = false; };
  });
}

module.exports = { geraetOeffnen, b64, ausB64 };
