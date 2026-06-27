// Service-Worker-Push-Test: lädt public/sw.js in einer Sandbox (kein Browser nötig) und prüft die
// push- und notificationclick-Handler. Start:  node tests/push-sw.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } }

// Mock-Service-Worker-Umgebung
const listeners = {};
let lastNotification = null;
let openedUrl = null;
let focusedClient = null;
const fakeClients = [];

const sandbox = {
  CACHE_VERSION: null,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  URL,
  caches: { keys: () => Promise.resolve([]), open: () => Promise.resolve({ put() {}, match() {} }), delete: () => Promise.resolve(), match: () => Promise.resolve() },
  self: {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(fakeClients),
      openWindow: (url) => { openedUrl = url; return Promise.resolve(); },
    },
    registration: {
      showNotification: (title, opts) => { lastNotification = { title, opts }; return Promise.resolve(); },
    },
  },
};
sandbox.self.self = sandbox.self;

(async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  vm.runInNewContext(code, sandbox);

  ok('push-Listener registriert', typeof listeners.push === 'function');
  ok('notificationclick-Listener registriert', typeof listeners.notificationclick === 'function');

  // 1. push mit gültigem Payload
  const waits = [];
  const ev = {
    data: { json: () => ({ title: 'Neue Bestellung', body: '3× Kabeltrommel — von Max', url: '/#/orders', icon: '/uploads/icons/icon-192x192.png' }) },
    waitUntil: (p) => waits.push(p),
  };
  listeners.push(ev);
  await Promise.all(waits);
  ok('showNotification Titel', lastNotification && lastNotification.title === 'Neue Bestellung', JSON.stringify(lastNotification));
  ok('showNotification Body', lastNotification.opts.body === '3× Kabeltrommel — von Max');
  ok('showNotification icon aus Payload (Branding)', lastNotification.opts.icon === '/uploads/icons/icon-192x192.png');
  ok('showNotification badge monochrom', lastNotification.opts.badge === '/icons/badge-96x96.png');
  ok('showNotification data.url', lastNotification.opts.data.url === '/#/orders');
  ok('showNotification ohne tag (jede Meldung einzeln)', lastNotification.opts.tag === undefined);

  // 2. push ohne/kaputten Payload → generische Meldung, kein Crash
  lastNotification = null;
  const waits2 = [];
  listeners.push({ data: { json: () => { throw new Error('bad'); } }, waitUntil: (p) => waits2.push(p) });
  await Promise.all(waits2);
  ok('kaputter Payload → generischer Titel', lastNotification && lastNotification.title === 'Arbeitsdoku');

  // 3. notificationclick ohne offenes Fenster → openWindow(url)
  openedUrl = null; focusedClient = null;
  const waits3 = [];
  listeners.notificationclick({ notification: { data: { url: '/#/absences' }, close() {} }, waitUntil: (p) => waits3.push(p) });
  await Promise.all(waits3);
  ok('notificationclick ohne Fenster → openWindow', openedUrl === '/#/absences', String(openedUrl));

  // 4. notificationclick mit offenem Fenster → focus + navigate
  let navigatedTo = null;
  fakeClients.push({ focus: () => { focusedClient = 'focused'; return Promise.resolve(); }, navigate: (u) => { navigatedTo = u; return Promise.resolve(); } });
  openedUrl = null;
  const waits4 = [];
  listeners.notificationclick({ notification: { data: { url: '/#/bulletin' }, close() {} }, waitUntil: (p) => waits4.push(p) });
  await Promise.all(waits4);
  ok('notificationclick mit Fenster → focus', focusedClient === 'focused');
  ok('notificationclick mit Fenster → navigate(url)', navigatedTo === '/#/bulletin', String(navigatedTo));
  ok('notificationclick öffnet KEIN neues Fenster wenn fokussiert', openedUrl === null);

  console.log(`\nPush-SW: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
