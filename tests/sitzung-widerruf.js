// Passwort gewechselt — und der Mitleser ist wirklich draußen? Auch aus dem Live-Kanal?
//
// Bis zum 10.11.2026 beendete nur der Knopf „Auf allen Geräten abmelden" eine Anmeldung. Wer sein
// Passwort wechselte, WEIL jemand mitgelesen hatte, sperrte den Mitleser nicht aus: Dessen Token
// galt weiter (bis zu 30 Tage, durch bloßes Benutzen frisch gehalten). Dasselbe beim Zurücksetzen
// durch Chef/Admin. Und der Ereigniskanal prüfte nur die Unterschrift: Ein widerrufenes Token oder
// das eines ausgestellten Kontos öffnete ihn weiter, ein offener Kanal blieb bis zu einer Stunde.
//
// Geprüft wird in beide Richtungen — dass der Fremde draußen ist UND dass der, der wechselt,
// drinbleibt. Das zweite ist die Hälfte, die man beim Bauen leicht vergisst: Ohne frisches Token
// in der Antwort würfe man sich mit dem eigenen Passwortwechsel hinaus.
//
//   1. Eigener Passwortwechsel: alle anderen Anmeldungen enden, offene Kanäle schließen sich
//   2. Einfaches „Abmelden" bleibt, wie es war (bewusst — Entscheidung vom 10.11.2026)
//   3. Zurücksetzen durch Chef/Admin, auch des eigenen Kontos
//   4. Ausstellen schließt den offenen Kanal
//   5. Gemerkte Geräte der Zwei-Faktor-Anmeldung fallen mit weg
//   6. Ein Widerruf verlängert keine Sitzung (Höchstdauer läuft weiter)
//   7. Ohne eingerichteten zweiten Faktor gibt es auch keinen Kanal
//
//   node tests/sitzung-widerruf.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');
const totp = require('../totp');

const PORT = 3395, DB = '/tmp/sitzung-widerruf.db', LOG = '/tmp/sitzung-widerruf-srv.log';
const GEHEIM = 'test-secret-mindestens-32-zeichen-lang';
// Herzschlag der Kanäle: im Betrieb 30 s (Notizen 25 s). So lange wartet hier niemand.
const PULS_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, cookie) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: {
      'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
      ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (_) {}
        const setzt = (x.headers['set-cookie'] || []).map(String);
        res({ status: x.statusCode, body: j || {}, text: s, kopf: x.headers,
              cookie: setzt.map(c => c.split(';')[0]).join('; ') || null });
      }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Einen Ereignisstrom öffnen und offen HALTEN. `zu` wird wahr, sobald der Server ihn beendet.
const offene = [];
function strom(pfad) {
  return new Promise((res, rej) => {
    const r = http.get({ host: 'localhost', port: PORT, path: pfad }, x => {
      const s = { status: x.statusCode, text: '', zu: false, schliessen: () => { try { r.destroy(); } catch (_) {} } };
      x.on('data', c => { s.text += c; });
      x.on('end', () => { s.zu = true; }); x.on('close', () => { s.zu = true; }); x.on('error', () => { s.zu = true; });
      offene.push(s);
      res(s);
    });
    r.on('error', rej);
  });
}
const warteBis = async (fn, ms) => { const ende = Date.now() + ms; while (Date.now() < ende) { if (fn()) return true; await sleep(40); } return !!fn(); };
// „Binnen eines Herzschlags" mit Luft: Der Takt läuft je Verbindung, dazu kommt die Laufzeit.
const FRIST_MS = PULS_MS * 5;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: GEHEIM, SSE_PULS_MS: String(PULS_MS),
           TWOFA_KEY: 'FSuaZ0oS0k9m1qJ0m5b3fS0mF0mZ0aS0k9m1qJ0m5b3=' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmelden = (u, p, cookie) => req('POST', '/api/auth/login', null, { username: u, password: p }, cookie);
    const ticketFuer = async (t) => (await req('GET', '/api/events/ticket', t)).body.ticket;
    const kanal = (t) => strom('/api/events?token=' + encodeURIComponent(t));
    const kanalMitTicket = (ticket) => strom('/api/events?ticket=' + encodeURIComponent(ticket));

    let adminToken = (await anmelden('admin', pw('admin'))).body.token;
    let chefPw = pw('chef');
    let chefToken = (await anmelden('chef', chefPw)).body.token;
    const monteur = (await req('POST', '/api/users', adminToken,
      { username: 'monteur', password: 'Start1234!', name: 'Manfred Monteur', role: 'mitarbeiter' })).body.user;
    const lehrling = (await req('POST', '/api/users', adminToken,
      { username: 'lehrling', password: 'Start1234!', name: 'Lena Lehrling', role: 'mitarbeiter' })).body.user;
    ok('Vorbereitung: Admin, Chef und zwei Mitarbeiter stehen', !!adminToken && !!chefToken && !!monteur && !!lehrling);

    console.log('\n── 1. Eigener Passwortwechsel ──');
    // Zwei Anmeldungen desselben Kontos: Am „Rechner" sitzt der Besitzer, das „Handy" hat ein Fremder.
    const handy = (await anmelden('monteur', 'Start1234!')).body.token;
    const rechner = (await anmelden('monteur', 'Start1234!')).body.token;
    const notiz = (await req('POST', '/api/notes', handy, { title: 'Baustelle', body: 'vertraulicher Inhalt' })).body.note;

    // Der Fremde hat alles offen, was es an Live-Drähten gibt — auf beiden Wegen in den Kanal.
    const fremdLang = await kanal(handy);
    const fremdTicket = await kanalMitTicket(await ticketFuer(handy));
    const fremdNotiz = await strom(`/api/notes/${notiz.id}/live?ticket=` + encodeURIComponent(await ticketFuer(handy)));
    const ticketVonVorher = await ticketFuer(handy);      // geholt VOR dem Wechsel, benutzt danach
    const chefKanal = await kanal(chefToken);             // Gegenprobe: ein Unbeteiligter
    ok('vorher: Kanal mit langem Token offen', fremdLang.status === 200, String(fremdLang.status));
    ok('vorher: Kanal mit Ticket offen', fremdTicket.status === 200, String(fremdTicket.status));
    ok('vorher: Notiz-Strom offen', fremdNotiz.status === 200, String(fremdNotiz.status));
    await warteBis(() => /event: start/.test(fremdNotiz.text), 1500);
    ok('… und er liefert den Inhalt der Notiz', /event: start/.test(fremdNotiz.text), fremdNotiz.text.slice(0, 60));
    // Der Herzschlag darf eine GÜLTIGE Sitzung nicht hinauswerfen — sonst wäre „Kanal schließt
    // sich" weiter unten kein Beleg für irgendetwas.
    await sleep(PULS_MS * 4);
    ok('eine gültige Sitzung übersteht mehrere Herzschläge', !fremdLang.zu && !fremdTicket.zu && !fremdNotiz.zu,
      `lang ${fremdLang.zu}, Ticket ${fremdTicket.zu}, Notiz ${fremdNotiz.zu}`);
    ok('… und bekommt ihren Puls', /: ping/.test(fremdLang.text), JSON.stringify(fremdLang.text.slice(0, 60)));

    const wechsel = await req('PUT', '/api/auth/password', rechner, { aktuell: 'Start1234!', neu: 'Frisch2026!' });
    ok('Wechsel klappt', wechsel.status === 200, `${wechsel.status} ${wechsel.text.slice(0, 80)}`);
    ok('… und liefert ein frisches Token', !!wechsel.body.token, 'ohne das würfe man sich selbst hinaus');
    const nachWechsel = await req('GET', '/api/entries', handy);
    ok('das Token des Fremden gilt NICHT mehr', nachWechsel.status === 401, String(nachWechsel.status));
    ok('… mit der Kennung „beendet" (die Oberfläche räumt dann alles weg)',
      nachWechsel.body.code === 'SITZUNG_BEENDET', JSON.stringify(nachWechsel.body));
    ok('das Token, mit dem gewechselt wurde, ebenfalls nicht (es ist ja auch alt)',
      (await req('GET', '/api/entries', rechner)).status === 401);
    const rechnerNeu = wechsel.body.token;
    ok('… aber das frische funktioniert', (await req('GET', '/api/entries', rechnerNeu)).status === 200);

    ok('der offene Kanal des Fremden (langer Token) schließt sich', await warteBis(() => fremdLang.zu, FRIST_MS));
    ok('der offene Kanal des Fremden (Ticket) schließt sich', await warteBis(() => fremdTicket.zu, FRIST_MS));
    ok('der offene Notiz-Strom des Fremden schließt sich', await warteBis(() => fremdNotiz.zu, FRIST_MS));
    ok('neu öffnen kann er den Kanal nicht', (await kanal(handy)).status === 401);
    ok('… auch nicht mit einem Ticket, das er sich VORHER geholt hat', (await kanalMitTicket(ticketVonVorher)).status === 401);
    ok('… und die Notiz ebenso wenig',
      (await strom(`/api/notes/${notiz.id}/live?ticket=` + encodeURIComponent(ticketVonVorher))).status === 401);
    ok('ein neues Ticket bekommt er gar nicht erst', (await req('GET', '/api/events/ticket', handy)).status === 401);
    ok('der Kanal des Chefs ist davon unberührt', !chefKanal.zu);
    const eigenerKanal = await kanalMitTicket(await ticketFuer(rechnerNeu));
    await sleep(PULS_MS * 3);
    ok('der Wechselnde selbst hat mit dem frischen Token wieder einen Kanal', eigenerKanal.status === 200 && !eigenerKanal.zu);

    console.log('\n── 2. Einfaches „Abmelden" bleibt, wie es war ──');
    // Bewusst so entschieden (10.11.2026): „Abmelden" meint dieses Gerät, es gibt keine Sperrliste
    // einzelner Token. Wer ein Gerät verloren hat, nimmt „überall abmelden" oder wechselt das
    // Passwort — beides beendet jetzt alles. Der Test hält fest, dass niemand das versehentlich
    // ändert und dabei alle anderen Geräte mit abmeldet.
    const geraetA = (await anmelden('monteur', 'Frisch2026!')).body.token;
    await req('POST', '/api/auth/logout', geraetA);
    ok('die anderen Anmeldungen desselben Kontos laufen weiter', (await req('GET', '/api/entries', rechnerNeu)).status === 200);

    console.log('\n── 3. Zurücksetzen durch Chef/Admin ──');
    const vorReset = (await anmelden('monteur', 'Frisch2026!')).body.token;
    const vorResetKanal = await kanalMitTicket(await ticketFuer(vorReset));
    const reset = await req('POST', `/api/users/${monteur.id}/reset-password`, chefToken, { password: 'ChefSetzt1!' });
    ok('Chef setzt das Passwort', reset.status === 200, `${reset.status} ${reset.text.slice(0, 80)}`);
    ok('… und bekommt KEIN Token des Mitarbeiters in die Hand', !reset.body.token, JSON.stringify(reset.body));
    const nachReset = await req('GET', '/api/entries', vorReset);
    ok('die laufende Anmeldung des Mitarbeiters ist beendet',
      nachReset.status === 401 && nachReset.body.code === 'SITZUNG_BEENDET', `${nachReset.status} ${JSON.stringify(nachReset.body)}`);
    ok('… auch die vom Rechner', (await req('GET', '/api/entries', rechnerNeu)).status === 401);
    ok('… sein offener Kanal schließt sich', await warteBis(() => vorResetKanal.zu, FRIST_MS));
    ok('der Chef selbst bleibt angemeldet', (await req('GET', '/api/entries', chefToken)).status === 200);
    ok('mit dem gesetzten Passwort kommt der Mitarbeiter wieder hinein', (await anmelden('monteur', 'ChefSetzt1!')).status === 200);

    // Der Admin setzt sein EIGENES Passwort über denselben Weg (Mitarbeiter-Dialog).
    const selbst = await req('POST', '/api/users/1/reset-password', adminToken, { password: 'AdminNeu2026!' });
    ok('Admin setzt sein eigenes Passwort', selbst.status === 200, `${selbst.status} ${selbst.text.slice(0, 80)}`);
    ok('… und bekommt dafür ein frisches Token', !!selbst.body.token, 'sonst flöge er mit dem nächsten Klick hinaus');
    ok('… das alte gilt nicht mehr', (await req('GET', '/api/entries', adminToken)).status === 401);
    adminToken = selbst.body.token;
    ok('… das frische schon', (await req('GET', '/api/users', adminToken)).status === 200);

    console.log('\n── 4. Ausstellen ──');
    const lehrlingToken = (await anmelden('lehrling', 'Start1234!')).body.token;
    const lehrlingKanal = await kanal(lehrlingToken);
    ok('vorher: Kanal offen', lehrlingKanal.status === 200 && !lehrlingKanal.zu);
    const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
    const aus = await req('POST', `/api/users/${lehrling.id}/deactivate`, adminToken, { employed_until: heute });
    ok('ausgestellt', aus.status === 200, `${aus.status} ${aus.text.slice(0, 80)}`);
    ok('der offene Kanal schließt sich', await warteBis(() => lehrlingKanal.zu, FRIST_MS));
    ok('… und lässt sich nicht neu öffnen', (await kanal(lehrlingToken)).status === 401);

    console.log('\n── 5. Gemerkte Geräte der Zwei-Faktor-Anmeldung ──');
    // Ein gemerktes Gerät kommt ohne Code hinein. Bliebe es nach dem Passwortwechsel gemerkt,
    // bräuchte der Mitleser nur noch das neue Passwort — der Widerruf wäre die halbe Wahrheit.
    let mTok = (await anmelden('monteur', 'ChefSetzt1!')).body.token;
    const einrichtung = await req('POST', '/api/auth/2fa/setup', mTok);
    const scharf = await req('POST', '/api/auth/2fa/verify', mTok, { code: totp.code(einrichtung.body.geheim) });
    ok('Authenticator eingerichtet', scharf.status === 200, `${scharf.status} ${scharf.text.slice(0, 80)}`);
    const schritt1 = await anmelden('monteur', 'ChefSetzt1!');
    ok('Anmeldung verlangt jetzt den Code', schritt1.body.zwei_faktor_erforderlich === true, JSON.stringify(schritt1.body).slice(0, 80));
    // Ein Code gilt nur einmal; der nächste Zeitschritt wird vom Server noch angenommen (Fenster ±1).
    const schritt2 = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: schritt1.body.zwischen_token, code: totp.code(einrichtung.body.geheim, Date.now() + 30000), geraet_merken: true });
    ok('… mit Code und „Gerät merken" angemeldet', schritt2.status === 200 && !!schritt2.body.token && !!schritt2.cookie,
      `${schritt2.status} ${schritt2.text.slice(0, 80)}`);
    const gemerkt = schritt2.cookie;
    const bekannt = await anmelden('monteur', 'ChefSetzt1!', gemerkt);
    ok('das gemerkte Gerät kommt ohne Code hinein', !!bekannt.body.token && !bekannt.body.zwei_faktor_erforderlich,
      JSON.stringify(bekannt.body).slice(0, 80));
    mTok = bekannt.body.token;
    ok('… und steht in der Geräteliste', ((await req('GET', '/api/auth/2fa/geraete', mTok)).body.geraete || []).length === 1);

    const wechsel2 = await req('PUT', '/api/auth/password', mTok, { aktuell: 'ChefSetzt1!', neu: 'Nochmal2026!' });
    ok('Passwort gewechselt', wechsel2.status === 200 && !!wechsel2.body.token, `${wechsel2.status} ${wechsel2.text.slice(0, 80)}`);
    ok('die Geräteliste ist leer',
      ((await req('GET', '/api/auth/2fa/geraete', wechsel2.body.token)).body.geraete || [1]).length === 0);
    const danach = await anmelden('monteur', 'Nochmal2026!', gemerkt);
    ok('das vormals gemerkte Gerät braucht wieder den Code', danach.body.zwei_faktor_erforderlich === true && !danach.body.token,
      JSON.stringify(danach.body).slice(0, 80));
    ok('der Authenticator selbst ist NICHT gelöscht (nur das Vertrauen in Geräte)',
      ((await req('GET', '/api/auth/2fa/status', wechsel2.body.token)).body.zwei_faktor || {}).eingerichtet === true);

    console.log('\n── 6. Ein Widerruf verlängert keine Sitzung ──');
    // Die Höchstdauer (30 Tage, mit zweitem Faktor kürzer) zählt ab der echten Anmeldung. Vorher
    // begann die Uhr bei „überall abmelden" neu: Wer den Knopf alle paar Wochen drückte, kam nie
    // an die Grenze — und damit nie wieder an der Abfrage des zweiten Faktors vorbei.
    const jetzt = Math.floor(Date.now() / 1000);
    const vorZehnTagen = jetzt - 10 * 86400;
    const alteSitzung = (stand) => jwt.sign(
      { userId: jwt.decode(chefToken).userId, role: 'chef', sitzung: stand, anmeldung: vorZehnTagen, iat: jetzt - 2 * 3600 },
      GEHEIM, { expiresIn: '3d' });
    // Zwei Stunden altes Token: Die gleitende Erneuerung legt bei JEDER Antwort ein neues bei.
    let alt = alteSitzung(jwt.decode(chefToken).sitzung);
    const probe = await req('GET', '/api/entries', alt);
    ok('Voraussetzung: ein zwei Stunden altes Token wird sonst gleitend erneuert',
      probe.status === 200 && !!probe.kopf['x-neues-token'], `${probe.status} ${probe.kopf['x-neues-token'] ? 'mit' : 'ohne'} Kopfzeile`);

    const ueberall = await req('POST', '/api/auth/alle-abmelden', alt);
    const tokenU = jwt.decode(ueberall.body.token || '') || {};
    ok('„überall abmelden" klappt', ueberall.status === 200 && !!ueberall.body.token, `${ueberall.status} ${ueberall.text.slice(0, 80)}`);
    ok('… die Anmeldung zählt weiter ab dem alten Zeitpunkt', tokenU.anmeldung === vorZehnTagen,
      `anmeldung ${tokenU.anmeldung}, erwartet ${vorZehnTagen}`);
    ok('… das neue Token reicht nicht über die Höchstdauer hinaus', tokenU.exp <= vorZehnTagen + 30 * 86400, String(tokenU.exp));
    // Sonst läge in DERSELBEN Antwort ein zweites Token mit dem alten, eben entwerteten Stand —
    // und andere Tabs desselben Geräts blieben darauf sitzen.
    ok('… und die Antwort trägt kein zweites Token in der Kopfzeile', !ueberall.kopf['x-neues-token']);
    ok('… das Token aus der Antwort gilt', (await req('GET', '/api/entries', ueberall.body.token)).status === 200);

    alt = alteSitzung(tokenU.sitzung);
    const wechsel3 = await req('PUT', '/api/auth/password', alt, { aktuell: chefPw, neu: 'ChefNeu2026!' });
    const tokenW = jwt.decode(wechsel3.body.token || '') || {};
    chefPw = 'ChefNeu2026!';
    ok('Passwortwechsel: dasselbe', wechsel3.status === 200 && tokenW.anmeldung === vorZehnTagen && !wechsel3.kopf['x-neues-token'],
      `${wechsel3.status} anmeldung ${tokenW.anmeldung}, Kopfzeile ${wechsel3.kopf['x-neues-token'] ? 'da' : 'fehlt'}`);
    ok('… und der Stand im Token ist gestiegen', tokenW.sitzung > tokenU.sitzung, `${tokenU.sitzung} → ${tokenW.sitzung}`);
    ok('der Kanal des Chefs von ganz oben ist damit ebenfalls zu', await warteBis(() => chefKanal.zu, FRIST_MS));

    console.log('\n── 7. Ohne eingerichteten zweiten Faktor: kein Kanal ──');
    // Verlangt die Rolle einen zweiten Faktor und ist keiner eingerichtet, gibt es keine Datenrouten
    // — und kein Ticket. Der lange Token kam am Kanal aber daran vorbei.
    await req('POST', '/api/users', adminToken, { username: 'scharfschalter', password: 'Test1234!', name: 'Scharf Schalter', role: 'admin' });
    const sTok = (await anmelden('scharfschalter', 'Test1234!')).body.token;
    const sGeheim = (await req('POST', '/api/auth/2fa/setup', sTok, {})).body.geheim;
    await req('POST', '/api/auth/2fa/verify', sTok, { code: totp.code(sGeheim) });
    chefToken = (await anmelden('chef', chefPw)).body.token;
    const chefVorher = await kanal(chefToken);
    ok('vorher: der Chef hat einen Kanal', chefVorher.status === 200, String(chefVorher.status));
    const pflicht = await req('PUT', '/api/settings', sTok, { twofa_chef: 'woechentlich', twofa_code: totp.code(sGeheim, Date.now() + 30000) });
    ok('Zwei-Faktor für Chefs zur Pflicht gemacht', pflicht.status === 200, `${pflicht.status} ${pflicht.text.slice(0, 80)}`);
    const gesperrt = await req('GET', '/api/entries', chefToken);
    ok('Voraussetzung: die API verlangt vom Chef jetzt die Einrichtung',
      gesperrt.status === 403 && gesperrt.body.code === 'ZWEI_FAKTOR_EINRICHTUNG', `${gesperrt.status} ${JSON.stringify(gesperrt.body).slice(0, 80)}`);
    ok('der offene Kanal schließt sich', await warteBis(() => chefVorher.zu, FRIST_MS));
    ok('… und mit dem langen Token gibt es keinen neuen', (await kanal(chefToken)).status === 401);

    console.log('\n── Im Audit-Log ──');
    const eintraege = (await req('GET', '/api/audit?limit=200', sTok)).body;
    const zeilen = eintraege.entries || eintraege.logs || eintraege.rows || [];
    const wechselZeile = zeilen.find(z => z.action === 'password_self_change');
    const resetZeile = zeilen.find(z => z.action === 'user_password_reset');
    ok('der Passwortwechsel nennt die beendeten Anmeldungen', !!wechselZeile && /beendet/.test(wechselZeile.details || ''),
      JSON.stringify(wechselZeile && wechselZeile.details));
    ok('das Zurücksetzen ebenfalls', !!resetZeile && /beendet/.test(resetZeile.details || ''), JSON.stringify(resetZeile && resetZeile.details));
    ok('… und kein Passwort steht darin', !/Frisch2026!|ChefSetzt1!|Nochmal2026!|AdminNeu2026!|ChefNeu2026!/.test(JSON.stringify(zeilen)));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    for (const s of offene) s.schliessen();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nSitzungs-Widerruf: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
