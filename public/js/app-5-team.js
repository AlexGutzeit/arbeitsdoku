// --- Welcome Page ---
async function renderWelcomeWeek() {
  const container = document.getElementById('welcome-week-container');
  if (!container) return;

  const today = formatDateISO(new Date());
  const now = new Date();
  const baseDate = new Date(now);
  baseDate.setDate(baseDate.getDate() + S.welcomeWeekOffset * 7);
  const kwDay = baseDate.getDay();
  const monOff = kwDay === 0 ? -6 : 1 - kwDay;
  const kwMon = new Date(baseDate); kwMon.setDate(baseDate.getDate() + monOff);
  const kwSun = new Date(kwMon); kwSun.setDate(kwMon.getDate() + 6);
  const kwFrom = formatDateISO(kwMon);
  const kwTo = formatDateISO(kwSun);

  let plannings = [];
  let weekAbsences = [];
  try {
    const [planData, absData] = await Promise.all([
      api('GET', `/api/planning?date_from=${kwFrom}&date_to=${kwTo}`),
      api('GET', `/api/absences/by-date?from=${kwFrom}&to=${kwTo}`),
    ]);
    if (planData) {
      plannings = planData.entries.filter(e =>
        e.assigned_users.some(u => u.user_id === S.user.id)
      );
      plannings.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (a.time_from !== b.time_from) return a.time_from < b.time_from ? -1 : 1;
        return 0;
      });
    }
    if (absData) {
      weekAbsences = filterApprovedAbsences(absData.absences).filter(a =>
        a.user_id === S.user.id || a.user_id === null
      );
    }
  } catch (e) {}

  // Alle Tage der Woche mit Planungen oder Abwesenheiten zusammenführen
  const shortDays = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  const allDays = new Set();
  plannings.forEach(e => allDays.add(e.date));

  // Abwesenheits-Tage in der KW ermitteln
  const absencesByDay = {};
  const kwStartDate = new Date(kwFrom + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(kwStartDate);
    d.setDate(d.getDate() + i);
    const iso = formatDateISO(d);
    const dayAbs = weekAbsences.filter(a => a.date_from <= iso && a.date_to >= iso);
    if (dayAbs.length > 0) {
      absencesByDay[iso] = dayAbs;
      allDays.add(iso);
    }
  }

  let planHtml = '';
  if (allDays.size === 0) {
    planHtml = '<p style="color:var(--text-light)">Keine Planungen oder Abwesenheiten diese Woche.</p>';
  } else {
    const sortedDays = [...allDays].sort();
    planHtml = sortedDays.map(date => {
      const d = new Date(date + 'T12:00:00');
      const dayLabel = `${shortDays[d.getDay()]}, ${formatDateDE(date)}`;
      const isToday = date === today;
      const dayPlannings = plannings.filter(e => e.date === date);
      const dayAbs = absencesByDay[date] || [];

      const absHtml = dayAbs.map(a => {
        const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '📋' };
        const multiDay = a.date_from !== a.date_to;
        const dateRange = multiDay ? ` (${formatDateDE(a.date_from)} – ${formatDateDE(a.date_to)})` : '';
        const statusLabel = a.status === 'pending' ? ' · Ausstehend' : '';
        return `<div class="welcome-task welcome-task-absence welcome-task-absence--${a.type}${isToday ? ' welcome-task-today' : ''}">
          <div class="welcome-task-time"><strong>${dayLabel}</strong></div>
          <div class="welcome-task-details">
            <span>${t.icon} ${t.label}${dateRange}${statusLabel}</span>
            ${a.comment ? `<span>${esc(a.comment)}</span>` : ''}
          </div>
        </div>`;
      }).join('');

      const planningsHtml = dayPlannings.map(e => {
        const proj = e.project_name || e.project_text || '';
        const colleagues = e.assigned_users.filter(u => u.user_id !== S.user.id).map(u => u.user_name);
        return `<div class="welcome-task${isToday ? ' welcome-task-today' : ''}">
          <div class="welcome-task-time"><strong>${dayLabel}</strong> ${e.time_from} - ${e.time_to}</div>
          <div class="welcome-task-details">
            ${proj ? `<span>&#128193; ${esc(proj)}</span>` : ''}
            ${e.address ? `<span>&#128205; ${esc(e.address)}</span>` : ''}
            ${e.description ? `<span>${esc(e.description)}</span>` : ''}
            ${colleagues.length ? `<span>&#128101; mit ${esc(colleagues.join(', '))}</span>` : ''}
          </div>
          <div class="welcome-task-actions">
            ${e.address ? `<button class="btn btn-sm btn-outline btn-nav nav-to-addr" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''}
            <button class="btn btn-sm btn-success accept-welcome-plan" data-id="${e.id}">Übernehmen</button>
          </div>
        </div>`;
      }).join('');

      return absHtml + planningsHtml;
    }).join('');
  }

  container.innerHTML = `
    <h3 style="display:flex;align-items:center;gap:0.5rem;">
      ${S.welcomeWeekOffset !== 0 ? '<button class="btn btn-sm btn-outline" id="welcome-week-prev">&#8249;</button>' : ''}
      <span>&#128197; ${S.welcomeWeekOffset === 0 ? 'Deine Woche' : 'KW ' + getISOWeek(kwFrom)} (${formatDateDE(kwFrom)} - ${formatDateDE(kwTo)})</span>
      <button class="btn btn-sm btn-outline" id="welcome-week-next">&#8250;</button>
    </h3>
    ${planHtml}`;

  document.getElementById('welcome-week-prev')?.addEventListener('click', () => { S.welcomeWeekOffset--; renderWelcomeWeek(); });
  document.getElementById('welcome-week-next')?.addEventListener('click', () => { S.welcomeWeekOffset++; renderWelcomeWeek(); });
}

// --- Web-Push (Benachrichtigungen) ---

// Browser-Unterstuetzung: Service Worker + Push + Notification muessen alle vorhanden sein.
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// iOS/iPadOS unterstuetzt Push nur in einer zum Home-Bildschirm hinzugefuegten PWA (installiert).
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// VAPID-Public-Key (Base64url) → Uint8Array fuer applicationServerKey.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function getPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Abonnieren: Erlaubnis anfragen → VAPID-Key holen → subscribe → an Server melden.
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden im Browser nicht erlaubt.');
  const keyResp = await api('GET', '/api/push/key');
  if (!keyResp || !keyResp.key) throw new Error('Push ist auf dem Server nicht konfiguriert.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyResp.key),
  });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  // Geraeteweites „Opt-out" aufheben (s. PUSH_OPTOUT_KEY): bewusstes Aktivieren erlaubt wieder
  // das automatische Mitziehen beim Login.
  try { localStorage.removeItem(PUSH_OPTOUT_KEY); } catch (_) {}
}

// Geraeteweite Markierung „auf diesem Geraet bewusst per Knopf ausgeschaltet". Verhindert, dass
// syncPushSubscription() beim naechsten Login/App-Start wieder abonniert. Wird NICHT vom Logout
// gesetzt (dort soll das Abo dem naechsten Login wieder folgen), nur vom „Ausschalten"-Knopf.
const PUSH_OPTOUT_KEY = 'pushOptOut';

// Raw-Abmeldung des Geraete-Abos (Browser + Server). Aendert das Opt-out NICHT — wird auch vom
// manuellen Logout genutzt.
async function disablePush() {
  const sub = await getPushSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (_) {}
    await api('POST', '/api/push/unsubscribe', { endpoint });
  }
}

const PUSH_CATS = [
  { key: 'orders',   label: 'Bestellungen' },
  { key: 'absences', label: 'Abwesenheiten' },
  { key: 'bulletin', label: 'Schwarzes Brett' },
  { key: 'notes',    label: 'Notizen' },
];

// Beim Login/App-Start: wenn die Browser-Erlaubnis bereits erteilt ist, das Geraete-Abo
// (ein Endpoint pro Browser) auf den AKTUELL eingeloggten Nutzer umziehen/auffrischen.
// So „folgt" das Abo dem angemeldeten User (wichtig bei geteilten Geraeten + beim Testen).
// Fragt NIE nach Erlaubnis — bei 'default'/'denied' passiert nichts.
async function syncPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  // Auf diesem Geraet bewusst ausgeschaltet → nicht heimlich wieder abonnieren.
  try { if (localStorage.getItem(PUSH_OPTOUT_KEY) === '1') return; } catch (_) {}
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyResp = await api('GET', '/api/push/key');
      if (!keyResp || !keyResp.key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyResp.key),
      });
    }
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  } catch (_) { /* still: Push bleibt einfach beim alten Stand */ }
}

// Eigene Seite „Benachrichtigungen" (Seitenleisten-Punkt, alle Rollen).
async function renderNotifications() {
  $app().innerHTML = layout(`
    <div class="welcome-page">
      <div class="welcome-header"><h1>&#128276; Benachrichtigungen</h1></div>
      <div class="erprobung-banner">
        <strong>&#129514; Erprobung</strong>
        <p>Diese Funktion ist noch in der Testphase. Bitte verlass dich noch nicht zu 100 % darauf – einzelne Benachrichtigungen können verspätet kommen oder ausbleiben. Rückmeldung (klappt / klappt nicht) gerne an den Admin. Danke!</p>
      </div>
      <div class="welcome-section" id="push-card">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>`, 'notifications');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';
  initPushCard();
}

// Baut die Benachrichtigungs-Karte (auf der Benachrichtigungen-Seite).
async function initPushCard() {
  const card = document.getElementById('push-card');
  if (!card) return;
  if (!pushSupported()) {
    card.innerHTML = `<h3>&#128276; Benachrichtigungen</h3>
      <p class="push-hint">Dieses Gerät bzw. dieser Browser unterstützt keine Push-Benachrichtigungen.</p>`;
    return;
  }

  // Hat der Server Push überhaupt eingerichtet (VAPID-Schlüssel)? /key liefert sonst 503.
  // Dann gar nicht erst „Aktivieren" anbieten (sonst Browser-Abfrage → Fehlermeldung).
  let pushConfigured = true;
  try {
    const r = await fetch('/api/push/key', { headers: S.token ? { Authorization: 'Bearer ' + S.token } : {} });
    if (r.status === 503) pushConfigured = false; // 200 = eingerichtet; Netzfehler → nicht hart sperren
  } catch (_) { /* Netzproblem: Karte normal anzeigen, nicht faelschlich „nicht eingerichtet" */ }
  if (!pushConfigured) {
    const adminHint = (S.user && S.user.role === 'admin')
      ? ' Zum Aktivieren VAPID-Schlüssel in der <code>.env</code> setzen (siehe README/Konfiguration).'
      : '';
    card.innerHTML = `<h3>&#128276; Benachrichtigungen</h3>
      <p class="push-hint">Push-Benachrichtigungen sind auf diesem Server nicht eingerichtet.${adminHint}</p>`;
    return;
  }

  const denied = Notification.permission === 'denied';
  let active = false;
  try { active = !!(await getPushSubscription()); } catch (_) {}

  let prefs = { orders: true, absences: true, bulletin: true, notes: true };
  if (active) {
    try { const p = await api('GET', '/api/push/prefs'); if (p) prefs = p; } catch (_) {}
  }

  const iosHint = isIOS() && !isStandalone()
    ? `<p class="push-hint">📱 Auf dem iPhone/iPad: App über „Teilen → Zum Home-Bildschirm" installieren, damit Benachrichtigungen ankommen.</p>`
    : '';

  let statusHtml, controlsHtml = '';
  if (denied) {
    statusHtml = `<span class="push-status push-off">Im Browser blockiert</span>`;
    controlsHtml = `<p class="push-hint">Benachrichtigungen sind für diese Seite im Browser blockiert. Bitte in den Browser-/Seiteneinstellungen erlauben.</p>`;
  } else if (active) {
    statusHtml = `<span class="push-status push-on">Aktiv</span>`;
    // Bestell-Push gehen nur an Chef + Admin — fuer alle anderen den Schalter ausblenden.
    const cats = PUSH_CATS.filter(c => c.key !== 'orders' || S.user.role === 'chef' || S.user.role === 'admin');
    const toggles = cats.map(c => `
      <label class="push-cat">
        <input type="checkbox" data-cat="${c.key}" ${prefs[c.key] ? 'checked' : ''}>
        <span>${c.label}</span>
      </label>`).join('');
    controlsHtml = `
      <div class="push-cats">${toggles}</div>
      <div class="push-actions">
        <button class="btn btn-sm" id="push-test">Test-Benachrichtigung</button>
        <button class="btn btn-sm btn-outline" id="push-disable">Ausschalten</button>
      </div>
      <div id="summary-section" class="summary-section"></div>`;
  } else {
    statusHtml = `<span class="push-status push-off">Aus</span>`;
    controlsHtml = `
      <p class="push-hint">Erhalte eine Benachrichtigung auf dieses Gerät, auch wenn die App geschlossen ist – z. B. bei neuer Bestellung, genehmigtem Urlaub oder neuem Aushang.</p>
      <div class="push-actions"><button class="btn btn-sm btn-primary" id="push-enable">Benachrichtigungen aktivieren</button></div>`;
  }

  card.style.display = '';
  card.innerHTML = `<h3>&#128276; Benachrichtigungen ${statusHtml}</h3>${controlsHtml}${iosHint}`;

  const enableBtn = document.getElementById('push-enable');
  if (enableBtn) enableBtn.addEventListener('click', async () => {
    enableBtn.disabled = true;
    try { await enablePush(); toast('Benachrichtigungen aktiviert'); initPushCard(); }
    catch (e) { toast(e.message || 'Aktivierung fehlgeschlagen', 'error'); enableBtn.disabled = false; }
  });

  const disableBtn = document.getElementById('push-disable');
  if (disableBtn) disableBtn.addEventListener('click', async () => {
    disableBtn.disabled = true;
    try {
      await disablePush();
      // Bewusstes Ausschalten merken → bleibt aus, bis wieder „Aktivieren" gedrückt wird.
      try { localStorage.setItem(PUSH_OPTOUT_KEY, '1'); } catch (_) {}
      toast('Benachrichtigungen ausgeschaltet'); initPushCard();
    }
    catch (e) { toast(e.message || 'Fehler', 'error'); disableBtn.disabled = false; }
  });

  const testBtn = document.getElementById('push-test');
  if (testBtn) testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try { await api('POST', '/api/push/test'); toast('Test-Benachrichtigung gesendet'); }
    catch (e) { toast(e.message || 'Senden fehlgeschlagen', 'error'); }
    testBtn.disabled = false;
  });

  card.querySelectorAll('input[data-cat]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const body = {}; body[cb.dataset.cat] = cb.checked;
      try { await api('PUT', '/api/push/prefs', body); toast('Gespeichert', 'success'); }
      catch (e) { toast('Konnte Einstellung nicht speichern', 'error'); cb.checked = !cb.checked; }
    });
  });

  if (active) initSummarySection();
}

// --- Geplante Zusammenfassungen (Digest-Push) ---
const SUMMARY_WD = [{ n: 1, l: 'Mo' }, { n: 2, l: 'Di' }, { n: 3, l: 'Mi' }, { n: 4, l: 'Do' }, { n: 5, l: 'Fr' }, { n: 6, l: 'Sa' }, { n: 7, l: 'So' }];
function summaryCatOptions() {
  return PUSH_CATS.filter(c => c.key !== 'orders' || S.user.role === 'chef' || S.user.role === 'admin');
}
const summaryCatLabel = (key) => (PUSH_CATS.find(c => c.key === key) || {}).label || key;
const summaryDaysLabel = (arr) => SUMMARY_WD.filter(w => arr.includes(w.n)).map(w => w.l).join(', ');

async function initSummarySection() {
  const box = document.getElementById('summary-section');
  if (!box) return;
  let data = { schedules: [], pausedAll: false };
  try { data = await api('GET', '/api/push/summaries'); } catch (_) {}
  const rows = (data.schedules || []).map(s => `
    <div class="summary-row${s.paused || data.pausedAll ? ' paused' : ''}" data-id="${s.id}">
      <div class="summary-row-main">
        <strong>${esc(s.name || 'Zusammenfassung')}</strong>${s.paused ? ' <span class="summary-tag">pausiert</span>' : ''}
        <div class="summary-row-sub">${summaryDaysLabel(s.weekdays)} · ${esc(s.time)} · ${s.cats.map(summaryCatLabel).map(esc).join(', ')}</div>
      </div>
      <div class="summary-row-actions">
        <button class="btn btn-xs" data-sum="toggle" data-id="${s.id}">${s.paused ? 'Fortsetzen' : 'Pause'}</button>
        <button class="btn btn-xs btn-outline" data-sum="edit" data-id="${s.id}">Bearbeiten</button>
        <button class="btn btn-xs btn-danger" data-sum="del" data-id="${s.id}">Löschen</button>
      </div>
    </div>`).join('');

  box.innerHTML = `
    <div class="summary-head">
      <h4>&#128340; Geplante Zusammenfassung</h4>
      <label class="summary-pauseall"><input type="checkbox" id="sum-pause-all" ${data.pausedAll ? 'checked' : ''}> Alle pausieren</label>
    </div>
    <p class="push-hint">Erhalte zu festen Zeiten eine Übersicht offener Aufgaben – unabhängig von den Kategorie-Schaltern oben.</p>
    <div class="summary-list">${rows || '<p class="push-hint">Noch keine Zusammenfassung angelegt.</p>'}</div>
    <div id="sum-form"></div>
    <button class="btn btn-sm btn-primary" id="sum-add">+ Zusammenfassung hinzufügen</button>`;

  document.getElementById('sum-pause-all').addEventListener('change', async (e) => {
    try { await api('PUT', '/api/push/summaries/pause-all', { paused: e.target.checked }); toast('Gespeichert', 'success'); initSummarySection(); }
    catch (err) { toast(err.message || 'Fehler', 'error'); }
  });
  document.getElementById('sum-add').addEventListener('click', () => openSummaryForm(null));
  box.querySelectorAll('[data-sum]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const sched = (data.schedules || []).find(x => String(x.id) === String(id));
    if (btn.dataset.sum === 'edit') { openSummaryForm(sched); return; }
    if (btn.dataset.sum === 'toggle') {
      try { await api('PUT', '/api/push/summaries/' + id, { paused: !sched.paused }); initSummarySection(); }
      catch (err) { toast(err.message || 'Fehler', 'error'); }
      return;
    }
    if (btn.dataset.sum === 'del') {
      if (!(await confirmModal('Diese geplante Zusammenfassung löschen?', { title: 'Löschen', okLabel: 'Löschen' }))) return;
      try { await api('DELETE', '/api/push/summaries/' + id); toast('Gelöscht', 'success'); initSummarySection(); }
      catch (err) { toast(err.message || 'Fehler', 'error'); }
    }
  }));
}

function openSummaryForm(sched) {
  const box = document.getElementById('sum-form');
  if (!box) return;
  const isEdit = !!sched;
  const name = sched ? sched.name : '';
  const days = sched ? sched.weekdays : [1, 2, 3, 4, 5];
  const time = sched ? sched.time : '08:00';
  const selCats = sched ? sched.cats : summaryCatOptions().map(c => c.key);
  box.innerHTML = `
    <div class="summary-form">
      <input id="sf-name" class="form-control" maxlength="40" placeholder="Name (z. B. Einkaufen)" value="${esc(name)}">
      <div class="sf-weekdays">${SUMMARY_WD.map(w => `<label><input type="checkbox" class="sf-wd" value="${w.n}" ${days.includes(w.n) ? 'checked' : ''}> ${w.l}</label>`).join('')}</div>
      <label class="sf-time-label">Uhrzeit <input id="sf-time" type="time" class="form-control" value="${esc(time)}"></label>
      <div class="sf-cats">${summaryCatOptions().map(c => `<label><input type="checkbox" class="sf-cat" value="${c.key}" ${selCats.includes(c.key) ? 'checked' : ''}> ${c.label}</label>`).join('')}</div>
      <div class="sf-actions">
        <button class="btn btn-sm btn-primary" id="sf-save">Speichern</button>
        <button class="btn btn-sm btn-outline" id="sf-cancel">Abbrechen</button>
      </div>
    </div>`;
  document.getElementById('sf-cancel').addEventListener('click', () => { box.innerHTML = ''; });
  document.getElementById('sf-save').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('sf-name').value.trim(),
      weekdays: [...box.querySelectorAll('.sf-wd:checked')].map(cb => Number(cb.value)),
      time: document.getElementById('sf-time').value,
      cats: [...box.querySelectorAll('.sf-cat:checked')].map(cb => cb.value),
    };
    if (!body.weekdays.length) { toast('Mindestens einen Wochentag wählen', 'error'); return; }
    if (!body.time) { toast('Uhrzeit wählen', 'error'); return; }
    if (!body.cats.length) { toast('Mindestens eine Kategorie wählen', 'error'); return; }
    try {
      if (isEdit) await api('PUT', '/api/push/summaries/' + sched.id, body);
      else await api('POST', '/api/push/summaries', body);
      toast('Gespeichert', 'success');
      initSummarySection();
    } catch (err) { toast(err.message || 'Fehler', 'error'); }
  });
}

async function renderWelcome() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'welcome');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const today = formatDateISO(new Date());
  const dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const mNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const now = new Date();
  const dateStr = `${dayNames[now.getDay()]}, ${now.getDate()}. ${mNames[now.getMonth()]} ${now.getFullYear()}`;

  // Schwarzes Brett laden
  let newBulletins = [];
  let eventBulletins = [];
  try {
    const data = await api('GET', '/api/bulletin');
    if (data) {
      newBulletins = data.entries.filter(b => b.created_at && b.created_at.slice(0, 10) === today);
      const in3 = new Date(now); in3.setDate(in3.getDate() + 3);
      const day3 = formatDateISO(in3);
      eventBulletins = data.entries.filter(b => b.event_date && b.event_date >= today && b.event_date <= day3);
    }
  } catch (e) {}

  const bulletinCard = b => `<div class="welcome-bulletin">
    <div class="welcome-bulletin-header">
      <strong>${esc(b.title)}</strong>
      ${b.event_date ? `<span class="welcome-bulletin-event">&#128197; ${formatDateDE(b.event_date)}</span>` : ''}
    </div>
    ${b.text ? `<div class="welcome-bulletin-text">${esc(b.text)}</div>` : ''}
    <div class="welcome-bulletin-meta">von ${esc(b.author_name)} am ${formatDateDE(b.created_at?.slice(0, 10) || '')}</div>
  </div>`;

  let newBulletinHtml = '';
  if (newBulletins.length > 0) {
    newBulletinHtml = `<div class="welcome-section">
      <h3>&#128204; Neu auf dem Schwarzen Brett</h3>
      ${newBulletins.map(bulletinCard).join('')}
    </div>`;
  }

  let eventBulletinHtml = '';
  if (eventBulletins.length > 0) {
    eventBulletinHtml = `<div class="welcome-section">
      <h3>&#127937; Ereignisse in den nächsten 3 Tagen</h3>
      ${eventBulletins.map(bulletinCard).join('')}
    </div>`;
  }

  mainEl.innerHTML = `
    <div class="welcome-page">
      <div class="welcome-header">
        <div class="welcome-date">${dateStr}</div>
        <div class="welcome-clock" id="welcome-clock"></div>
        <h1>Willkommen, ${esc(S.user.name)}!</h1>
      </div>
      <div class="welcome-section" id="welcome-week-container">
        <div class="loading"><div class="spinner"></div></div>
      </div>
      ${eventBulletinHtml}
      ${newBulletinHtml}
      <div class="welcome-section" id="welcome-weather">
        <h3>&#9925; Wetter</h3>
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>`;

  // Live-Uhr
  function updateClock() {
    const el = document.getElementById('welcome-clock');
    if (!el) return;
    const n = new Date();
    el.textContent = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
  }
  updateClock();
  const clockInterval = setInterval(() => {
    if (!document.getElementById('welcome-clock')) { clearInterval(clockInterval); return; }
    updateClock();
  }, 1000);

  // Wetter laden: komplett serverseitig (Geocoding + Wetter)
  try {
    const w = await api('GET', '/api/settings/weather');
    const wDiv = document.getElementById('welcome-weather');
    if (!wDiv) throw new Error();
    if (w.error) {
      wDiv.innerHTML = `<h3>&#9925; Wetter</h3><p style="color:var(--text-light)">${esc(w.error)}. Bitte Ort in den Einstellungen hinterlegen.</p>`;
    } else if (w.current && w.hourly) {
      const c = w.current;
      const d = w.daily;
      const h = w.hourly;
      const nowHour = new Date().getHours();

      // Stündlichen Verlauf bauen (nur 6-22 Uhr)
      let hourlyHtml = '';
      const tempMin = Math.min(...h.temperature_2m.slice(6, 23));
      const tempMax = Math.max(...h.temperature_2m.slice(6, 23));
      const tempRange = tempMax - tempMin || 1;
      for (let i = 6; i <= 22; i++) {
        const temp = h.temperature_2m[i];
        const code = h.weather_code[i];
        const rain = h.precipitation_probability[i];
        const barPct = Math.round(((temp - tempMin) / tempRange) * 100);
        const isNow = i === nowHour;
        hourlyHtml += `<div class="wh-col${isNow ? ' wh-now' : ''}">
          <div class="wh-temp">${Math.round(temp)}°</div>
          <div class="wh-bar-wrap"><div class="wh-bar" style="height:${Math.max(barPct, 8)}%"></div></div>
          <div class="wh-icon">${weatherIcon(code)}</div>
          ${rain > 0 ? `<div class="wh-rain">${rain}%</div>` : '<div class="wh-rain">&nbsp;</div>'}
          <div class="wh-time">${i}h</div>
        </div>`;
      }

      wDiv.innerHTML = `<h3>&#9925; Wetter in ${esc(w.city)}</h3>
        <div class="weather-current">
          <div class="weather-icon">${weatherIcon(c.weather_code)}</div>
          <div class="weather-info">
            <span class="weather-temp">${c.temperature_2m}°C</span>
            <span class="weather-desc">${weatherDescription(c.weather_code)}</span>
          </div>
          <div class="weather-minmax">
            &#9650; ${d.temperature_2m_max[0]}° &nbsp; &#9660; ${d.temperature_2m_min[0]}°
          </div>
          <div class="weather-extra">
            &#128168; ${c.wind_speed_10m} km/h &nbsp; &#128167; ${c.relative_humidity_2m}%
          </div>
        </div>
        <div class="wh-scroll"><div class="wh-timeline">${hourlyHtml}</div></div>`;
    }
  } catch (e) {
    const wDiv = document.getElementById('welcome-weather');
    if (wDiv) wDiv.innerHTML = '<h3>&#9925; Wetter</h3><p style="color:var(--text-light)">Wetterdaten nicht verfügbar.</p>';
  }

  // Wochen-Planung laden
  await renderWelcomeWeek();

  // Navigation starten (delegiert, da Inhalt dynamisch)
  mainEl.addEventListener('click', (e) => {
    const navBtn = e.target.closest('.nav-to-addr');
    if (navBtn) { openNav(navBtn.dataset.addr); return; }
    const acceptBtn = e.target.closest('.accept-welcome-plan');
    if (acceptBtn) { navigate('/planning/accept/' + acceptBtn.dataset.id); return; }
  });
}

function weatherDescription(code) {
  const map = {0:'Klar',1:'Überwiegend klar',2:'Teilweise bewölkt',3:'Bewölkt',45:'Nebel',48:'Nebel mit Reif',
    51:'Leichter Nieselregen',53:'Nieselregen',55:'Starker Nieselregen',61:'Leichter Regen',63:'Regen',65:'Starker Regen',
    71:'Leichter Schneefall',73:'Schneefall',75:'Starker Schneefall',77:'Schneekörner',80:'Leichte Regenschauer',
    81:'Regenschauer',82:'Starke Regenschauer',85:'Leichte Schneeschauer',86:'Starke Schneeschauer',
    95:'Gewitter',96:'Gewitter mit Hagel',99:'Starkes Gewitter mit Hagel'};
  return map[code] || 'Unbekannt';
}

function weatherIcon(code) {
  if (code === 0) return '&#9728;&#65039;';
  if (code <= 2) return '&#9925;';
  if (code === 3) return '&#9729;&#65039;';
  if (code <= 48) return '&#127787;&#65039;';
  if (code <= 55) return '&#127782;&#65039;';
  if (code <= 65) return '&#127783;&#65039;';
  if (code <= 77) return '&#127784;&#65039;';
  if (code <= 82) return '&#127783;&#65039;';
  if (code <= 86) return '&#127784;&#65039;';
  return '&#9889;';
}

// --- Bulletin Board (Schwarzes Brett) ---
async function renderBulletin() {
  S.badges.bulletin = 0;
  refreshBadges();
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'bulletin');
  bindLayout();

  let entries = [];
  try {
    const data = await api('GET', '/api/bulletin');
    markSeen('bulletin');
    if (data) entries = data.entries;
  } catch (e) {}

  const canEdit = canEditBulletin();
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  let cardsHtml = '';
  if (entries.length === 0) {
    cardsHtml = '<div class="empty-state"><div class="icon">&#128204;</div><p>Keine Einträge am Schwarzen Brett.</p></div>';
  } else {
    cardsHtml = entries.map(b => {
      const createdDate = formatDateDE(b.created_at?.slice(0, 10) || '');
      return `<div class="bulletin-card${b.is_unread ? ' bulletin-card--unread' : ''}">
        <div class="bulletin-header">
          <h3 class="bulletin-title">${esc(b.title)}</h3>
          ${canEdit ? `<div class="bulletin-actions">
            <button class="btn btn-sm btn-outline edit-bulletin" data-id="${b.id}">Bearbeiten</button>
            <button class="btn btn-sm btn-danger del-bulletin" data-id="${b.id}">Löschen</button>
          </div>` : ''}
        </div>
        ${b.text ? `<div class="bulletin-text">${esc(b.text).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="bulletin-meta">
          <span>&#128100; ${esc(b.author_name)}</span>
          <span>&#128197; Erstellt: ${createdDate}</span>
          ${b.event_date ? `<span>&#127937; Event: ${formatDateDE(b.event_date)}</span>` : ''}
          ${b.auto_delete_date ? `<span>&#128465; Läuft ab: ${formatDateDE(b.auto_delete_date)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  mainEl.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>&#128204; Schwarzes Brett</h2>
      </div>
      <div class="bulletin-list">${cardsHtml}</div>
    </div>`;

  mainEl.querySelectorAll('.edit-bulletin').forEach(btn => {
    btn.addEventListener('click', () => navigate('/bulletin/edit/' + btn.dataset.id));
  });
  mainEl.querySelectorAll('.del-bulletin').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Eintrag wirklich löschen?', { title: 'Eintrag löschen', okLabel: 'Löschen' }))) return;
      try {
        await api('DELETE', '/api/bulletin/' + btn.dataset.id);
        toast('Eintrag gelöscht', 'success');
        renderBulletin();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function renderBulletinForm(editId) {
  let entry = null;
  if (editId) {
    try {
      const data = await api('GET', '/api/bulletin');
      if (data) entry = data.entries.find(e => e.id === Number(editId));
    } catch (e) { toast(e.message, 'error'); navigate('/bulletin'); return; }
  }

  const isEdit = !!entry;
  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <div class="card-header">
        <h2>${isEdit ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</h2>
        <button class="btn btn-outline btn-sm" id="back-btn">Zurück</button>
      </div>
      <form id="bulletin-form">
        <div class="form-group">
          <label>Überschrift *</label>
          <input type="text" class="form-control" id="bf-title" value="${esc(entry?.title || '')}" required>
        </div>
        <div class="form-group">
          <label>Text</label>
          <textarea class="form-control" id="bf-text" rows="5" placeholder="Nachricht...">${esc(entry?.text || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Event-Datum (optional)</label>
            <input type="date" class="form-control" id="bf-event-date" value="${entry?.event_date || ''}">
          </div>
          <div class="form-group">
            <label>Automatisch löschen am (optional)</label>
            <input type="date" class="form-control" id="bf-auto-delete" value="${entry?.auto_delete_date || ''}">
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Speichern' : 'Erstellen'}</button>
        ${isEdit ? '<button type="button" class="btn btn-danger btn-block" id="delete-bulletin" style="margin-top:0.5rem">Eintrag löschen</button>' : ''}
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'bulletin');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  document.getElementById('back-btn').addEventListener('click', () => navigate('/bulletin'));

  document.getElementById('bulletin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: document.getElementById('bf-title').value,
      text: document.getElementById('bf-text').value,
      event_date: document.getElementById('bf-event-date').value || null,
      auto_delete_date: document.getElementById('bf-auto-delete').value || null,
    };
    try {
      if (isEdit) {
        await api('PUT', '/api/bulletin/' + editId, body);
        toast('Eintrag aktualisiert', 'success');
      } else {
        await api('POST', '/api/bulletin', body);
        toast('Eintrag erstellt', 'success');
      }
      navigate('/bulletin');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('delete-bulletin')?.addEventListener('click', async () => {
    if (!(await confirmModal('Eintrag wirklich löschen?', { title: 'Eintrag löschen', okLabel: 'Löschen' }))) return;
    try {
      await api('DELETE', '/api/bulletin/' + editId);
      toast('Eintrag gelöscht', 'success');
      navigate('/bulletin');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Users Management ---
async function renderUsers() {
  if (!canManageUsers()) { navigate('/'); return; }

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'users');
  bindLayout();

  try {
    const data = await api('GET', '/api/users');
    if (!data) return;
    S.users = data.users;
  } catch (e) { toast(e.message, 'error'); return; }

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>Mitarbeiter</h2>
        <button class="btn btn-primary btn-sm" id="add-user-btn">+ Neuer Mitarbeiter</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Benutzername</th>
              <th>Rolle</th>
              <th>Soll h/Woche</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            ${S.users.filter(u => u.active !== 0).map(u => `
              <tr>
                <td>${esc(u.name)}</td>
                <td>${esc(u.username)}</td>
                <td><span class="badge badge-${u.role}">${roleName(u.role)}</span></td>
                <td>${u.target_hours_per_week}</td>
                <td class="actions">
                  <button class="btn btn-sm btn-outline edit-user" data-id="${u.id}">Bearbeiten</button>
                  ${u.id !== S.user.id ? `<button class="btn btn-sm btn-warning deactivate-user" data-id="${u.id}">Ausstellen</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('add-user-btn').addEventListener('click', () => showUserModal());

  mainEl.querySelectorAll('.edit-user').forEach(btn => {
    btn.addEventListener('click', () => {
      const user = S.users.find(u => u.id === Number(btn.dataset.id));
      if (user) showUserModal(user);
    });
  });

  mainEl.querySelectorAll('.deactivate-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const user = S.users.find(u => u.id === Number(btn.dataset.id));
      const today = new Date().toLocaleDateString('sv-SE');
      const employedUntil = await promptModal(
        `"${user?.name}" ausstellen. Der Account kann sich dann nicht mehr anmelden, aber alle Daten bleiben erhalten und werden weiter angezeigt.\n\nLetzter Arbeitstag (Austrittsdatum):`,
        { title: 'Mitarbeiter ausstellen', okLabel: 'Ausstellen', multiline: false, inputType: 'date', defaultValue: today, required: true, requiredMsg: 'Bitte ein Austrittsdatum wählen.' }
      );
      if (employedUntil === null) return; // Abbrechen
      try {
        await api('POST', '/api/users/' + btn.dataset.id + '/deactivate', { employed_until: employedUntil.trim() });
        toast('Mitarbeiter ausgestellt', 'success');
        renderUsers();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function showUserModal(user) {
  const isEdit = !!user;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide">
      <h2>${isEdit ? 'Mitarbeiter bearbeiten' : 'Neuer Mitarbeiter'}</h2>
      <form id="user-modal-form">
        <div class="form-group">
          <label>Name</label>
          <input type="text" class="form-control" id="um-name" value="${esc(user?.name || '')}" required>
        </div>
        <div class="form-group">
          <label>Benutzername</label>
          <input type="text" class="form-control" id="um-username" value="${esc(user?.username || '')}" required>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <button type="button" class="btn btn-outline btn-sm" id="um-reset-pw-btn">&#128274; Passwort zurücksetzen</button>
          <div id="um-reset-pw-form" style="display:none;margin-top:0.5rem;">
            <input type="password" class="form-control" id="um-pw-new" placeholder="Neues Passwort" style="margin-bottom:0.4rem;">
            <input type="password" class="form-control" id="um-pw-repeat" placeholder="Wiederholen">
            <div style="display:flex;gap:0.5rem;margin-top:0.4rem;">
              <button type="button" class="btn btn-primary btn-sm" id="um-pw-save">Speichern</button>
              <button type="button" class="btn btn-outline btn-sm" id="um-pw-cancel">Abbrechen</button>
            </div>
          </div>
        </div>` : `
        <div class="form-group">
          <label>Passwort</label>
          <input type="password" class="form-control" id="um-password" required>
        </div>`}
        <div class="form-row">
          <div class="form-group">
            <label>Rolle</label>
            <select class="form-control" id="um-role">
              <option value="mitarbeiter" ${user?.role === 'mitarbeiter' ? 'selected' : ''}>Mitarbeiter</option>
              <option value="buchhalter" ${user?.role === 'buchhalter' ? 'selected' : ''}>Buchhalter</option>
              <option value="chef" ${user?.role === 'chef' ? 'selected' : ''}>Chef</option>
              ${S.user.role === 'admin' ? `<option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>` : ''}
            </select>
          </div>
          <div class="form-group">
            <label>Start-Überstunden (h)</label>
            <input type="number" class="form-control" id="um-start-overtime" value="${user?.start_overtime ?? 0}" step="0.01">
          </div>
        </div>
        <div class="form-group">
          <label style="display:block;margin-bottom:0.3rem;">Planungsrecht</label>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
            <input type="checkbox" id="um-can-plan" ${user?.can_plan ? 'checked' : ''}>
            sich – darf sich selbst verplanen
          </label>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-top:0.3rem;">
            <input type="checkbox" id="um-can-plan-all" ${user?.can_plan_all ? 'checked' : ''}>
            alle – darf alle Mitarbeiter verplanen (schließt „sich" ein)
          </label>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-top:0.6rem;">
            <input type="checkbox" id="um-can-bulletin" ${user?.can_bulletin ? 'checked' : ''}>
            Schwarzes-Brett-Recht (darf Einträge erstellen/bearbeiten)
          </label>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-top:0.3rem;">
            <input type="checkbox" id="um-can-upload" ${user?.can_upload ? 'checked' : ''}>
            Datei-Upload-Recht (darf Dokumente hochladen &amp; verwalten)
          </label>
        </div>
        ${isEdit ? `
        <div class="form-section">
          <label class="form-section-title">Soll-Stunden pro Tag</label>
          <div id="um-targets-list"><div class="loading"><div class="spinner"></div></div></div>
          <div class="targets-add-days">
            <div class="day-hours-row">
              <label>Mo <input type="number" id="um-target-mon" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Di <input type="number" id="um-target-tue" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Mi <input type="number" id="um-target-wed" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Do <input type="number" id="um-target-thu" step="0.01" min="0" max="24" value="8" class="form-control form-control-sm"></label>
              <label>Fr <input type="number" id="um-target-fri" step="0.01" min="0" max="24" value="6" class="form-control form-control-sm"></label>
            </div>
            <div class="targets-add-bottom">
              <input type="date" id="um-target-from" class="form-control">
              <button type="button" class="btn btn-primary btn-sm" id="um-target-add">Hinzufügen</button>
            </div>
          </div>
        </div>` : `
        <div class="form-section">
          <label class="form-section-title">Soll-Stunden pro Tag</label>
          <div class="day-hours-row">
            <label>Mo <input type="number" class="form-control form-control-sm" id="um-h-mon" value="8" min="0" max="24" step="0.01"></label>
            <label>Di <input type="number" class="form-control form-control-sm" id="um-h-tue" value="8" min="0" max="24" step="0.01"></label>
            <label>Mi <input type="number" class="form-control form-control-sm" id="um-h-wed" value="8" min="0" max="24" step="0.01"></label>
            <label>Do <input type="number" class="form-control form-control-sm" id="um-h-thu" value="8" min="0" max="24" step="0.01"></label>
            <label>Fr <input type="number" class="form-control form-control-sm" id="um-h-fri" value="6" min="0" max="24" step="0.01"></label>
          </div>
        </div>`}
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" id="um-cancel">Abbrechen</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Speichern' : 'Erstellen'}</button>
        </div>
      </form>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('um-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Planungsrecht-Stufen koppeln: „alle" schließt „sich" zwingend ein.
  const planSelfCb = document.getElementById('um-can-plan');
  const planAllCb = document.getElementById('um-can-plan-all');
  const syncPlanRights = () => {
    if (planAllCb.checked) { planSelfCb.checked = true; planSelfCb.disabled = true; }
    else { planSelfCb.disabled = false; }
  };
  planAllCb.addEventListener('change', syncPlanRights);
  // „sich" abwählen → „alle" kann nicht mehr gelten (greift nur, solange „sich" nicht gesperrt ist).
  planSelfCb.addEventListener('change', () => { if (!planSelfCb.checked) planAllCb.checked = false; });
  syncPlanRights();

  // Passwort zurücksetzen (nur bei Bearbeitung)
  if (isEdit) {
    document.getElementById('um-reset-pw-btn').addEventListener('click', () => {
      document.getElementById('um-reset-pw-form').style.display = '';
      document.getElementById('um-pw-new').focus();
    });
    document.getElementById('um-pw-cancel').addEventListener('click', () => {
      document.getElementById('um-reset-pw-form').style.display = 'none';
      document.getElementById('um-pw-new').value = '';
      document.getElementById('um-pw-repeat').value = '';
    });
    document.getElementById('um-pw-save').addEventListener('click', async () => {
      const pw1 = document.getElementById('um-pw-new').value;
      const pw2 = document.getElementById('um-pw-repeat').value;
      if (!pw1) { toast('Passwort eingeben', 'error'); return; }
      if (pw1 !== pw2) { toast('Passwörter stimmen nicht überein', 'error'); return; }
      try {
        await api('POST', `/api/users/${user.id}/reset-password`, { password: pw1 });
        toast('Passwort gesetzt', 'success');
        document.getElementById('um-reset-pw-form').style.display = 'none';
        document.getElementById('um-pw-new').value = '';
        document.getElementById('um-pw-repeat').value = '';
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // Soll-Stunden-Verlauf laden (nur bei Bearbeitung)
  if (isEdit) {
    await loadUserTargets(user.id);

    document.getElementById('um-target-add')?.addEventListener('click', async () => {
      const from = document.getElementById('um-target-from').value;
      if (!from) { toast('Gültig-ab-Datum eingeben', 'error'); return; }
      const body = {
        hours_mon: parseFloat(document.getElementById('um-target-mon').value) || 0,
        hours_tue: parseFloat(document.getElementById('um-target-tue').value) || 0,
        hours_wed: parseFloat(document.getElementById('um-target-wed').value) || 0,
        hours_thu: parseFloat(document.getElementById('um-target-thu').value) || 0,
        hours_fri: parseFloat(document.getElementById('um-target-fri').value) || 0,
        valid_from: from,
      };
      try {
        await api('POST', `/api/statistics/targets/${user.id}`, body);
        toast('Soll-Stunden gespeichert', 'success');
        await loadUserTargets(user.id);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  document.getElementById('user-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('um-name').value,
      username: document.getElementById('um-username').value,
      role: document.getElementById('um-role').value,
      start_overtime: parseFloat(document.getElementById('um-start-overtime').value) || 0,
      can_plan: document.getElementById('um-can-plan').checked,
      can_plan_all: document.getElementById('um-can-plan-all').checked,
      can_bulletin: document.getElementById('um-can-bulletin').checked,
      can_upload: document.getElementById('um-can-upload').checked,
    };
    // Bei neuem User Tages-Stunden setzen
    if (!isEdit) {
      body.hours_mon = parseFloat(document.getElementById('um-h-mon').value) || 0;
      body.hours_tue = parseFloat(document.getElementById('um-h-tue').value) || 0;
      body.hours_wed = parseFloat(document.getElementById('um-h-wed').value) || 0;
      body.hours_thu = parseFloat(document.getElementById('um-h-thu').value) || 0;
      body.hours_fri = parseFloat(document.getElementById('um-h-fri').value) || 0;
      body.target_hours_per_week = body.hours_mon + body.hours_tue + body.hours_wed + body.hours_thu + body.hours_fri;
    }
    try {
      if (isEdit) {
        await api('PUT', '/api/users/' + user.id, body);
        toast('Mitarbeiter aktualisiert', 'success');
      } else {
        const pw = document.getElementById('um-password').value;
        if (!pw) { toast('Passwort erforderlich', 'error'); return; }
        body.password = pw;
        await api('POST', '/api/users', body);
        toast('Mitarbeiter erstellt', 'success');
      }
      overlay.remove();
      renderUsers();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function loadUserTargets(userId) {
  const container = document.getElementById('um-targets-list');
  if (!container) return;
  try {
    const data = await api('GET', `/api/statistics/targets/${userId}`);
    if (!data) return;
    container.innerHTML = `<table class="data-table targets-table targets-days-table">
      <tr><th>Gültig ab</th><th>Mo</th><th>Di</th><th>Mi</th><th>Do</th><th>Fr</th><th>Summe</th><th></th></tr>
      ${data.targets.map(t => {
        const sum = ((t.hours_mon||0)+(t.hours_tue||0)+(t.hours_wed||0)+(t.hours_thu||0)+(t.hours_fri||0)).toFixed(2);
        return `
        <tr data-target-id="${t.id}">
          <td><input type="date" class="form-control form-control-sm target-from" value="${t.valid_from}"></td>
          <td><input type="number" class="form-control form-control-sm t-mon" value="${t.hours_mon||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-tue" value="${t.hours_tue||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-wed" value="${t.hours_wed||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-thu" value="${t.hours_thu||0}" step="0.01" min="0" max="24"></td>
          <td><input type="number" class="form-control form-control-sm t-fri" value="${t.hours_fri||0}" step="0.01" min="0" max="24"></td>
          <td class="target-sum">${sum}h</td>
          <td class="actions target-actions">
            <button type="button" class="btn btn-sm btn-outline save-target" title="Speichern">&#10003;</button>
            ${data.targets.length > 1 ? `<button type="button" class="btn btn-sm btn-danger del-target" title="Löschen">&#10005;</button>` : ''}
          </td>
        </tr>`;
      }).join('')}
    </table>`;
    // Live-Summe aktualisieren
    container.querySelectorAll('tr[data-target-id]').forEach(tr => {
      tr.querySelectorAll('input[type="number"]').forEach(inp => {
        inp.addEventListener('input', () => {
          const m = parseFloat(tr.querySelector('.t-mon').value)||0;
          const t2 = parseFloat(tr.querySelector('.t-tue').value)||0;
          const w = parseFloat(tr.querySelector('.t-wed').value)||0;
          const t4 = parseFloat(tr.querySelector('.t-thu').value)||0;
          const f = parseFloat(tr.querySelector('.t-fri').value)||0;
          tr.querySelector('.target-sum').textContent = (m+t2+w+t4+f).toFixed(2) + 'h';
        });
      });
    });
    container.querySelectorAll('.save-target').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const id = tr.dataset.targetId;
        const from = tr.querySelector('.target-from').value;
        if (!from) { toast('Datum eingeben', 'error'); return; }
        const body = {
          hours_mon: parseFloat(tr.querySelector('.t-mon').value)||0,
          hours_tue: parseFloat(tr.querySelector('.t-tue').value)||0,
          hours_wed: parseFloat(tr.querySelector('.t-wed').value)||0,
          hours_thu: parseFloat(tr.querySelector('.t-thu').value)||0,
          hours_fri: parseFloat(tr.querySelector('.t-fri').value)||0,
          valid_from: from,
        };
        try {
          await api('PUT', `/api/statistics/targets/${userId}/${id}`, body);
          toast('Gespeichert', 'success');
          await loadUserTargets(userId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    container.querySelectorAll('.del-target').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('tr').dataset.targetId;
        try {
          await api('DELETE', `/api/statistics/targets/${userId}/${id}`);
          toast('Eintrag gelöscht', 'success');
          await loadUserTargets(userId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) {}
}

// --- Projects ---
// Dringlichkeitsstufen (Farbe + Rang für die Sortierung: rot zuerst)
const PROJECT_URGENCY = [
  { key: 'rot',    label: 'Dringend', color: '#dc2626', rank: 0 },
  { key: 'orange', label: 'Hoch',     color: '#ea580c', rank: 1 },
  { key: 'gelb',   label: 'Mittel',   color: '#eab308', rank: 2 },
  { key: 'gruen',  label: 'Niedrig',  color: '#16a34a', rank: 3 },
];
const projUrg = (key) => PROJECT_URGENCY.find(u => u.key === key) || PROJECT_URGENCY[2];
let _boardUsers = [];

// Auftrags-Board: Mitarbeiter waagerecht, darunter ihre Aufträge nach Dringlichkeit (rot oben), tie = ältester oben.
let _boardShowDone = false; // Chef/Admin: Archiv (erledigte Aufträge) einblenden

async function renderProjects() {
  const manage = isChefOrAdmin();
  const showDone = _boardShowDone && manage;
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'projects');
  bindLayout();

  let projects = [];
  try {
    const [pData, uData] = await Promise.all([api('GET', '/api/projects' + (showDone ? '?done=1' : '')), api('GET', '/api/users/list')]);
    if (!pData) return;
    projects = pData.projects || [];
    _boardUsers = (uData && uData.users) || [];
  } catch (e) { toast(e.message, 'error'); return; }
  S.projects = projects;

  // Gruppieren: unter jedem zugewiesenen User; ohne Zuweisung → „Nicht zugewiesen"
  const byUser = {}; const unassigned = [];
  for (const p of projects) {
    if (!p.assigned_users || !p.assigned_users.length) unassigned.push(p);
    else for (const u of p.assigned_users) (byUser[u.user_id] || (byUser[u.user_id] = [])).push(p);
  }
  const cols = _boardUsers.filter(u => u.role !== 'admin' && u.active !== 0).map(u => ({ id: u.id, name: u.name }));
  const seen = new Set(cols.map(c => c.id));
  for (const p of projects) for (const u of (p.assigned_users || [])) if (!seen.has(u.user_id)) { seen.add(u.user_id); cols.push({ id: u.user_id, name: u.name }); }
  cols.sort((a, b) => a.name.localeCompare(b.name));

  const sortTiles = (list) => [...list].sort((a, b) =>
    (projUrg(a.urgency).rank - projUrg(b.urgency).rank) ||
    (String(a.created_at) < String(b.created_at) ? -1 : (String(a.created_at) > String(b.created_at) ? 1 : 0)));
  const columns = [{ id: 'unassigned', name: 'Nicht zugewiesen', list: sortTiles(unassigned) },
    ...cols.map(c => ({ id: c.id, name: c.name, list: sortTiles(byUser[c.id] || []) }))];

  const canPlanTake = canEditPlanning();
  const urgOpts = (p) => PROJECT_URGENCY.map(o => `<button type="button" class="urg-opt" data-id="${p.id}" data-urg="${o.key}" style="background:${o.color}" title="${o.label}"></button>`).join('');
  const tileHtml = (p) => {
    const u = projUrg(p.urgency);
    // Dringlichkeitsampel: Chef/Admin können die Farbe direkt (ohne „Bearbeiten") ändern.
    const flag = (manage && !showDone)
      ? `<span class="proj-flag-wrap"><button type="button" class="proj-flag proj-flag-btn" data-id="${p.id}" style="background:${u.color}" title="Dringlichkeit ändern (${u.label})"></button><span class="urg-picker" style="display:none">${urgOpts(p)}</span></span>`
      : `<span class="proj-flag" style="background:${u.color}" title="${u.label}"></span>`;
    const actions = showDone
      ? `${manage ? `<button class="btn btn-xs btn-success proj-reopen" data-id="${p.id}">Wieder öffnen</button>` : ''}
         ${manage ? `<button class="btn btn-xs btn-danger proj-del" data-id="${p.id}">Löschen</button>` : ''}`
      : `${canPlanTake ? `<button class="btn btn-xs btn-primary proj-plan" data-id="${p.id}">In Planung übernehmen</button>` : ''}
         <button class="btn btn-xs proj-entry" data-id="${p.id}">Als Zeitnachweis übernehmen</button>
         ${manage ? `<button class="btn btn-xs btn-outline proj-edit" data-id="${p.id}">Bearbeiten</button>` : ''}
         ${manage ? `<button class="btn btn-xs btn-success proj-done" data-id="${p.id}">Erledigt</button>` : ''}
         ${manage ? `<button class="btn btn-xs btn-danger proj-del" data-id="${p.id}">Löschen</button>` : ''}`;
    return `<div class="proj-tile${showDone ? ' proj-tile-done' : ''}" data-id="${p.id}" style="border-left:5px solid ${u.color}">
      <div class="proj-tile-top"><span class="proj-name">${esc(p.name)}</span>${flag}</div>
      ${p.client ? `<div class="proj-client">${esc(p.client)}</div>` : ''}
      <div class="proj-detail" style="display:none">
        ${p.note ? `<p class="proj-note">${esc(p.note)}</p>` : ''}
        ${p.address ? `<div class="proj-addr">&#128205; ${esc(p.address)} <button class="btn btn-xs proj-nav" data-addr="${esc(p.address)}" title="Navigieren">&#128506;</button></div>` : ''}
        <div class="proj-meta">Dringlichkeit: ${u.label} · erstellt ${formatDateTimeDE(p.created_at)}${showDone && p.done_at ? ' · erledigt ' + formatDateTimeDE(p.done_at) : ''}</div>
        <div class="proj-meta">Für: ${(p.assigned_users && p.assigned_users.length) ? p.assigned_users.map(x => esc(x.name)).join(', ') : '– (nicht zugewiesen)'}</div>
        <div class="proj-actions">${actions}</div>
      </div>
    </div>`;
  };

  const colsHtml = columns.map(c => `
    <div class="board-col">
      <div class="board-col-head">${esc(c.name)}${c.list.length ? ` <span class="board-count">${c.list.length}</span>` : ''}</div>
      <div class="board-col-body">${c.list.map(tileHtml).join('') || '<div class="board-empty">–</div>'}</div>
    </div>`).join('');

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="board-wrap">
      <div class="board-head">
        <h2>${showDone ? 'Erledigte Aufträge' : 'Projekte / Aufträge'}</h2>
        ${manage ? `<button class="btn btn-sm btn-outline" id="board-archive-toggle">${showDone ? '← Offene Aufträge' : 'Erledigte anzeigen'}</button>` : ''}
      </div>
      <div class="board-scroll"><div class="board-columns">${colsHtml}</div></div>
    </div>`;
  // Im Archiv kein „Neues Projekt"-FAB anbieten
  if (showDone) { const fab = document.getElementById('fab-new'); if (fab) fab.style.display = 'none'; }

  // Kachel auf-/zuklappen
  mainEl.querySelectorAll('.proj-tile').forEach(tile => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      mainEl.querySelectorAll('.urg-picker').forEach(x => x.style.display = 'none');
      const det = tile.querySelector('.proj-detail');
      if (det) det.style.display = det.style.display === 'none' ? 'block' : 'none';
    });
  });
  const pid = (b) => b.dataset.id;
  const at = document.getElementById('board-archive-toggle');
  if (at) at.addEventListener('click', () => { _boardShowDone = !_boardShowDone; renderProjects(); });
  mainEl.querySelectorAll('.proj-nav').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openNav(b.dataset.addr); }));
  mainEl.querySelectorAll('.proj-plan').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); navigate('/planning/from-project/' + pid(b)); }));
  mainEl.querySelectorAll('.proj-entry').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); navigate('/entry/from-project/' + pid(b)); }));
  mainEl.querySelectorAll('.proj-edit').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); renderProjectForm(S.projects.find(x => x.id == pid(b))); }));
  // Dringlichkeitsampel: Flag öffnet Farbauswahl; Klick auf Farbe speichert direkt
  mainEl.querySelectorAll('.proj-flag-btn').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const pick = b.parentElement.querySelector('.urg-picker');
    const open = pick.style.display !== 'none';
    mainEl.querySelectorAll('.urg-picker').forEach(x => x.style.display = 'none');
    pick.style.display = open ? 'none' : 'inline-flex';
  }));
  mainEl.querySelectorAll('.urg-opt').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api('PUT', '/api/projects/' + b.dataset.id, { urgency: b.dataset.urg }); toast('Dringlichkeit geändert', 'success'); renderProjects(); } catch (err) { toast(err.message, 'error'); }
  }));
  mainEl.querySelectorAll('.proj-reopen').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api('POST', '/api/projects/' + pid(b) + '/reopen'); toast('Wieder geöffnet', 'success'); renderProjects(); } catch (err) { toast(err.message, 'error'); }
  }));
  mainEl.querySelectorAll('.proj-done').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await confirmModal('Auftrag als erledigt markieren? Er verschwindet vom Board (bleibt archiviert).', { title: 'Erledigt', okLabel: 'Erledigt', danger: false }))) return;
    try { await api('POST', '/api/projects/' + pid(b) + '/done'); toast('Als erledigt markiert', 'success'); renderProjects(); } catch (err) { toast(err.message, 'error'); }
  }));
  mainEl.querySelectorAll('.proj-del').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await confirmModal('Projekt wirklich löschen? Vorhandene Planungen/Zeitnachweise behalten den Namen.', { title: 'Projekt löschen', okLabel: 'Löschen' }))) return;
    try { await api('DELETE', '/api/projects/' + pid(b)); toast('Projekt gelöscht', 'success'); renderProjects(); } catch (err) { toast(err.message, 'error'); }
  }));
}

// Projekt-Formular (Chef/Admin) — via FAB (neu) oder „Bearbeiten" (mit Projekt).
async function renderProjectForm(project) {
  if (!isChefOrAdmin()) { navigate('/projects'); return; }
  if (!_boardUsers.length) { try { const uData = await api('GET', '/api/users/list'); _boardUsers = (uData && uData.users) || []; } catch (_) {} }
  const isEdit = !!(project && project.id);
  const p = project || { name: '', client: '', address: '', note: '', urgency: 'gelb', assigned_users: [] };
  const assignedIds = new Set((p.assigned_users || []).map(u => u.user_id));
  // Alle Nutzer außer Admin sind zuteilbar (Chef/Buchhalter können sich auch Arbeit zuweisen).
  const workers = _boardUsers.filter(u => u.role !== 'admin' && (u.active !== 0 || assignedIds.has(u.id)));

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'projects');
  bindLayout();
  const fab = document.getElementById('fab-new'); if (fab) fab.style.display = 'none';
  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="card" style="max-width:700px;margin:0 auto;">
      <div class="card-header">
        <h2>${isEdit ? 'Projekt bearbeiten' : 'Neues Projekt / Auftrag'}</h2>
        <button class="btn btn-outline btn-sm" id="pf2-back">Zurück</button>
      </div>
      <div class="form-group"><label>Projektname *</label><input class="form-control" id="pf2-name" value="${esc(p.name)}"></div>
      <div class="form-group"><label>Kunde</label><input class="form-control" id="pf2-client" value="${esc(p.client || '')}"></div>
      <div class="form-group"><label>Adresse / Arbeitsort</label>
        <div style="display:flex;gap:0.4rem;">
          <input class="form-control" id="pf2-address" value="${esc(p.address || '')}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
          <button type="button" class="btn btn-outline" id="pf2-nav" title="Navigieren">&#128506;</button>
        </div></div>
      <div class="form-group"><label>Notiz</label><textarea class="form-control" id="pf2-note" rows="3">${esc(p.note || '')}</textarea></div>
      <div class="form-group"><label>Dringlichkeit</label>
        <select class="form-control" id="pf2-urgency">
          ${PROJECT_URGENCY.map(u => `<option value="${u.key}" ${p.urgency === u.key ? 'selected' : ''}>${u.label}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Zugedachte Mitarbeiter</label>
        <div class="planning-user-checkboxes">${workers.map(u => `<label><input type="checkbox" class="pf2-assignee" value="${u.id}" ${assignedIds.has(u.id) ? 'checked' : ''}> ${esc(u.name)}${u.role !== 'mitarbeiter' ? ` <span class="push-hint">(${esc(roleName(u.role))})</span>` : ''}</label>`).join('') || '<span class="push-hint">Keine Nutzer vorhanden</span>'}</div></div>
      <button class="btn btn-primary btn-block" id="pf2-save">${isEdit ? 'Speichern' : 'Projekt erstellen'}</button>
    </div>`;

  document.getElementById('pf2-back').addEventListener('click', () => renderProjects());
  document.getElementById('pf2-nav').addEventListener('click', () => { const a = document.getElementById('pf2-address').value.trim(); if (a) openNav(a, { force: true }); else toast('Keine Adresse eingetragen', 'error'); });
  document.getElementById('pf2-save').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('pf2-name').value.trim(),
      client: document.getElementById('pf2-client').value.trim(),
      address: document.getElementById('pf2-address').value.trim(),
      note: document.getElementById('pf2-note').value.trim(),
      urgency: document.getElementById('pf2-urgency').value,
      assigned_user_ids: [...document.querySelectorAll('.pf2-assignee:checked')].map(cb => Number(cb.value)),
    };
    if (!body.name) { toast('Projektname ist erforderlich', 'error'); return; }
    try {
      if (isEdit) await api('PUT', '/api/projects/' + project.id, body);
      else await api('POST', '/api/projects', body);
      toast('Gespeichert', 'success');
      renderProjects();
    } catch (err) { toast(err.message, 'error'); }
  });
}

