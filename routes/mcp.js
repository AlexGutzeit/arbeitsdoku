// MCP-Schnittstelle (Model Context Protocol) unter /mcp (Alex, 14.11.2026).
//
// Transport „Streamable HTTP", zustandslos: Jede Anfrage ist ein POST mit EINER JSON-RPC-Nachricht, die
// Antwort kommt als JSON. Einen Ereignisstrom (GET) und Sitzungen (Mcp-Session-Id) bieten wir nicht an —
// beides erlaubt die Spezifikation. Schlanker Eigenbau statt des offiziellen Pakets (Entscheidung A): Gebraucht
// werden fünf Methoden; das Paket brächte 17 Abhängigkeiten mit. Dass echte Clients damit klarkommen, prüft
// tests/mcp-protokoll.js mit dem offiziellen Client.
//
// Anmeldung NUR mit Zugangsschlüssel (schluessel.js). Die Werkzeuge (mcp-werkzeuge.js) greifen über die
// normalen Routen zu — Rechte und Prüfungen gelten dort, nicht hier.
//
// Protokolliert wird jede Anfrage in mcp_zugriffe: Zeit, Schlüssel, Methode, Werkzeug, Ergebnis, Dauer,
// Adresse — ohne Inhalte (keine Parameter, keine Antworten).
const express = require('express');
const { getDb } = require('../database/init');
const { schluesselPruefen, zuletztMerken } = require('../middleware/auth');
const { berlinNow } = require('../audit');
const { berlinJetzt } = require('../zeit');
const schluessel = require('../schluessel');
const werkzeuge = require('../mcp-werkzeuge');
const { version } = require('../package.json');

const router = express.Router();
// Neueste zuerst. Fragt ein Client eine Fassung an, die wir kennen, antworten wir in dieser; sonst in der neuesten.
const VERSIONEN = ['2025-11-25', '2025-06-18', '2025-03-26'];
const AUFBEWAHRUNG_TAGE = 90;

const ANLEITUNG = 'Arbeitsdoku: Zeiterfassung, Einsatzplanung und Aufträge eines Handwerksbetriebs. '
  + 'Datumsangaben immer JJJJ-MM-TT, Stunden sind Nettostunden (ohne Pause). Mitarbeiter gibst du per Name (Teil genügt) oder Nummer an. '
  + 'Für „wie viele Stunden …" nimm stunden_summe — sie rechnet wie der Zeitnachweis der App. Für relative Zeitangaben liefert angemeldet_als das heutige Datum. '
  + 'Listen kommen seitenweise (seite, pro_seite). Du siehst nur, was der Benutzer dieses Schlüssels in der App sehen darf.';

let _seitAufraeumen = 0;
function protokollieren(db, z) {
  try {
    db.prepare('INSERT INTO mcp_zugriffe (ts, schluessel_id, methode, werkzeug, ergebnis, dauer_ms, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(berlinNow(), z.schluesselId || null, String(z.methode || '').slice(0, 40), z.werkzeug ? String(z.werkzeug).slice(0, 64) : null,
        z.ergebnis, z.dauer, String(z.ip || '').slice(0, 64));
    // Gelegentlich aufräumen: älter als 90 Tage geht weg.
    if (++_seitAufraeumen >= 500) {
      _seitAufraeumen = 0;
      const grenze = berlinJetzt(new Date(Date.now() - AUFBEWAHRUNG_TAGE * 864e5));
      db.prepare('DELETE FROM mcp_zugriffe WHERE ts < ?').run(grenze);
    }
  } catch (e) { console.error('mcp_zugriffe nicht geschrieben:', e.message); }
}

const fehlerAntwort = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

// Ein Browser schickt immer „Origin" mit. Fremde Seiten dürfen /mcp nicht ansprechen (DNS-Rebinding,
// verlangt die Spezifikation). Programme wie Hermes schicken keinen Origin.
function originErlaubt(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  try { return new URL(o).host === String(req.headers.host || ''); } catch (_) { return false; }
}

router.all('/', async (req, res) => {
  const start = Date.now();
  const db = getDb();
  const ip = req.ip;
  const z = { ip, methode: req.method === 'POST' ? '' : req.method };
  const ende = (status, json, ergebnis) => {
    z.ergebnis = ergebnis; z.dauer = Date.now() - start;
    protokollieren(db, z);
    if (json === null) return res.status(status).end();
    return res.status(status).json(json);
  };

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json(fehlerAntwort(null, -32000, 'Nur POST. Diese Schnittstelle bietet keinen Ereignisstrom an.'));
  }
  if (schluessel.bremsen.ip.zaehlen(ip)) return ende(429, fehlerAntwort(null, -32000, 'Zu viele Anfragen. Bitte kurz warten.'), 'zu_viele');
  if (!originErlaubt(req)) return ende(403, fehlerAntwort(null, -32000, 'Herkunft nicht erlaubt.'), 'abgewiesen');

  // ── Anmeldung ──
  const kopf = String(req.headers.authorization || '');
  const roh = kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
  if (!schluessel.istSchluessel(roh)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="arbeitsdoku"');
    return ende(401, fehlerAntwort(null, -32001, 'Zugangsschlüssel fehlt. Anlegen unter „Mein Konto" → Zugangsschlüssel.'), 'abgewiesen');
  }
  if (schluessel.bremsen.fehlversuch.gesperrt(ip)) return ende(429, fehlerAntwort(null, -32000, 'Zu viele ungültige Versuche. Bitte in einer Minute erneut.'), 'zu_viele');
  const p = schluesselPruefen(db, roh);
  if (!p.eintrag) {
    if (p.code === 'SCHLUESSEL_UNGUELTIG') schluessel.bremsen.fehlversuch.zaehlen(ip);
    res.setHeader('WWW-Authenticate', 'Bearer realm="arbeitsdoku", error="invalid_token"');
    return ende(401, fehlerAntwort(null, -32001, p.error), 'abgewiesen');
  }
  const { eintrag, user } = p;
  z.schluesselId = eintrag.id;
  if (schluessel.bremsen.schluessel.zaehlen(eintrag.id)) return ende(429, fehlerAntwort(null, -32000, 'Zu viele Anfragen mit diesem Schlüssel. Bitte kurz warten.'), 'zu_viele');
  zuletztMerken(db, eintrag, ip);

  const pv = req.headers['mcp-protocol-version'];
  if (pv !== undefined && !VERSIONEN.includes(String(pv))) {
    return ende(400, fehlerAntwort(null, -32600, `Protokollversion ${String(pv).slice(0, 20)} wird nicht unterstützt (${VERSIONEN.join(', ')}).`), 'fehler');
  }

  // ── Nachricht ──
  const n = req.body;
  if (!n || typeof n !== 'object' || Array.isArray(n) || n.jsonrpc !== '2.0') {
    return ende(400, fehlerAntwort(null, -32600, 'Erwartet: genau eine JSON-RPC-2.0-Nachricht.'), 'fehler');
  }
  z.methode = typeof n.method === 'string' ? n.method : 'antwort';
  // Benachrichtigungen (ohne id) und Antworten des Clients: angenommen, keine Antwort.
  if (n.id === undefined || typeof n.method !== 'string') return ende(202, null, 'ok');
  const id = n.id;
  const params = (n.params && typeof n.params === 'object') ? n.params : {};

  try {
    if (n.method === 'initialize') {
      const gewuenscht = params.protocolVersion;
      return ende(200, { jsonrpc: '2.0', id, result: {
        protocolVersion: VERSIONEN.includes(gewuenscht) ? gewuenscht : VERSIONEN[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'arbeitsdoku', title: 'Arbeitsdoku', version },
        instructions: ANLEITUNG,
      } }, 'ok');
    }
    if (n.method === 'ping') return ende(200, { jsonrpc: '2.0', id, result: {} }, 'ok');
    if (n.method === 'tools/list') {
      return ende(200, { jsonrpc: '2.0', id, result: { tools: werkzeuge.fuer(eintrag.recht).map(werkzeuge.beschreibung) } }, 'ok');
    }
    if (n.method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      z.werkzeug = name;
      const w = werkzeuge.fuer(eintrag.recht).find(x => x.name === name);
      if (!w) return ende(200, fehlerAntwort(id, -32602, `Unbekanntes Werkzeug „${name.slice(0, 64)}".`), 'fehler');
      const ergebnis = (text, isError, daten) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(daten ? { structuredContent: daten } : {}), isError } });
      const falsch = werkzeuge.eingabePruefen(w, params.arguments);
      if (falsch) return ende(200, ergebnis(falsch, true), 'fehler');
      const ktx = { roh, ip, werkzeug: name, user, schluessel: { id: eintrag.id, name: eintrag.name, recht: eintrag.recht } };
      try {
        const daten = await w.ausfuehren(params.arguments || {}, ktx);
        return ende(200, ergebnis(JSON.stringify(daten), false, daten), 'ok');
      } catch (e) {
        if (e instanceof werkzeuge.Hinweis) return ende(200, ergebnis(e.message, true), 'fehler');
        console.error(`MCP-Werkzeug ${name}:`, e && e.message);
        return ende(200, ergebnis('Das hat nicht geklappt (interner Fehler). Bitte später erneut versuchen.', true), 'fehler');
      }
    }
    return ende(200, fehlerAntwort(id, -32601, `Unbekannte Methode „${n.method.slice(0, 64)}".`), 'fehler');
  } catch (e) {
    console.error('MCP:', e && e.message);
    return ende(500, fehlerAntwort(id, -32603, 'Interner Fehler.'), 'fehler');
  }
});

module.exports = router;
