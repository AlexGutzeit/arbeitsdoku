'use strict';
const clients = new Set();

function addClient(res) { clients.add(res); }
function removeClient(res) { clients.delete(res); }
function getClientCount() { return clients.size; }

function broadcast(type, originTab) {
  const msg = `data: ${JSON.stringify({ type, originTab: originTab || null })}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

module.exports = { addClient, removeClient, broadcast, getClientCount };
