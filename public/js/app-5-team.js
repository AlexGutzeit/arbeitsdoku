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
        // Die ganzen Objekte behalten, nicht nur die Namen — fuer die Profilbilder braucht es die id.
        const colleagues = e.assigned_users.filter(u => u.user_id !== S.user.id);
        // Anklickbar wie die Aushaenge: fuehrt in die Tagesansicht der Planung zu genau diesem
        // Termin. Die Knoepfe darin (Navigieren/Uebernehmen) fangen ihre Klicks selbst ab.
        return `<div class="welcome-task welcome-task--klickbar${isToday ? ' welcome-task-today' : ''}"
            role="button" tabindex="0" data-planung="${e.id}" data-planung-tag="${date}"
            aria-label="Termin ${e.time_from} bis ${e.time_to} in der Tagesansicht öffnen">
          <div class="welcome-task-time"><strong>${dayLabel}</strong> ${e.time_from} - ${e.time_to}</div>
          <div class="welcome-task-details">
            ${proj ? `<span>&#128193; ${esc(proj)}</span>` : ''}
            ${e.address ? `<span>&#128205; ${esc(e.address)}</span>` : ''}
            ${e.description ? `<span>${esc(e.description)}</span>` : ''}
            ${colleagues.length ? `<span class="welcome-task-mit">&#128101; mit ${colleagues.map(u =>
              // Bild direkt VOR dem Namen, nicht alle Bilder in einer Reihe: Sonst muesste man
              // Reihenfolge mit Reihenfolge abgleichen, um zu wissen, wer wer ist.
              // 'initialen' statt leerer Kreise — wer kein Bild hinterlegt hat, ist so trotzdem
              // auf einen Blick zu unterscheiden.
              `<span class="welcome-mit-person">${avatarHtml({ id: u.user_id, name: u.user_name }, 20, 'initialen')}${esc(u.user_name)}</span>`
            ).join('')}</span>` : ''}
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
      ${S.welcomeWeekOffset !== 0 ? '<button class="btn btn-sm btn-outline" id="welcome-week-prev" aria-label="Vorherige Woche" title="Woche zurück">&#8249;</button>' : ''}
      <span>&#128197; ${S.welcomeWeekOffset === 0 ? 'Deine Woche' : 'KW ' + getISOWeek(kwFrom)} (${formatDateDE(kwFrom)} - ${formatDateDE(kwTo)})</span>
      <button class="btn btn-sm btn-outline" id="welcome-week-next" aria-label="Nächste Woche" title="Woche weiter">&#8250;</button>
    </h3>
    ${planHtml}`;

  document.getElementById('welcome-week-prev')?.addEventListener('click', () => { S.welcomeWeekOffset--; renderWelcomeWeek(); });
  document.getElementById('welcome-week-next')?.addEventListener('click', () => { S.welcomeWeekOffset++; renderWelcomeWeek(); });
  // KEIN eigenes avatareLaden hier: Der MutationObserver in app-1-core.js (initViewStateKeeper)
  // beobachtet #app mit subtree und laedt die Bilder nach JEDER strukturellen Aenderung nach —
  // auch nach diesem nachtraeglichen Fuellen und beim Blaettern zwischen den Wochen.
  // Nachgemessen: Mit einem Aufruf hier verhaelt sich die Seite genauso wie ohne.
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
  { key: 'planning', label: 'Planung' },
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
// Die eigene Seite „Benachrichtigungen" gibt es nicht mehr — die Karte steht seit dem 22.08.2026
// auf „Mein Konto" (public/js/app-1-core.js lenkt die alte Adresse dorthin um). An den
// Einstellungen selbst hat sich dabei NICHTS geaendert: Es sind dieselben Schalter, dieselbe
// Tabelle, dieselben Werte je Nutzer.

// Baut die Benachrichtigungs-Karte (jetzt auf „Mein Konto").
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

  let prefs = { orders: true, absences: true, bulletin: true, notes: true, planning: true };
  if (active) {
    try { const p = await api('GET', '/api/push/prefs'); if (p) prefs = p; } catch (_) {}
  }
  // Fuer das Planungs-⋮-Menue merken: Erinnerungs-Punkt nur zeigen, wenn Push aktiv + „Planung" an.
  S.pushPlanning = active && prefs.planning !== false;

  const iosHint = isIOS() && !isStandalone()
    ? `<p class="push-hint">📱 Auf dem iPhone/iPad: App über „Teilen → Zum Home-Bildschirm" installieren, damit Benachrichtigungen ankommen.</p>`
    : '';

  let statusHtml, controlsHtml = '';
  if (denied) {
    statusHtml = `<span class="push-status push-off">Im Browser blockiert</span>`;
    controlsHtml = `<p class="push-hint">Benachrichtigungen sind für diese Seite im Browser blockiert. Bitte in den Browser-/Seiteneinstellungen erlauben.</p>`;
  } else if (active) {
    statusHtml = `<span class="push-status push-on">Aktiv</span>`;
    // Bestell-Push gehen an Chef, Admin und Rechteinhaber — fuer alle anderen den Schalter
    // ausblenden. Wird das Recht entzogen, raeumt der Server die Einstellung mit auf.
    const cats = PUSH_CATS.filter(c => c.key !== 'orders' || darfBestellen());
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
      try {
        await api('PUT', '/api/push/prefs', body); toast('Gespeichert', 'success');
        // „Planung"-Schalter beeinflusst den Erinnerungs-Punkt im Planungs-⋮-Menue sofort.
        if (cb.dataset.cat === 'planning') S.pushPlanning = cb.checked;
      }
      catch (e) { toast('Konnte Einstellung nicht speichern', 'error'); cb.checked = !cb.checked; }
    });
  });

  if (active) initSummarySection();
}

// --- Geplante Zusammenfassungen (Digest-Push) ---
const SUMMARY_WD = [{ n: 1, l: 'Mo' }, { n: 2, l: 'Di' }, { n: 3, l: 'Mi' }, { n: 4, l: 'Do' }, { n: 5, l: 'Fr' }, { n: 6, l: 'Sa' }, { n: 7, l: 'So' }];
function summaryCatOptions() {
  // 'planning' ist ereignisbasiert (Planungs-Erinnerungen) und keine zaehlerbasierte Digest-Kategorie.
  return PUSH_CATS.filter(c => c.key !== 'planning')
    .filter(c => c.key !== 'orders' || darfBestellen());
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

// Gratulation für die angemeldete Person selbst — ohne Alter und ohne Absender: Das Team bekommt
// den Geburtstag gar nicht angezeigt, „das ganze Team wünscht dir" wäre also schlicht nicht wahr.
// Die Schalttags-Regel ist dieselbe wie serverseitig in routes/users.js: Wer am 29. Februar geboren
// ist, wird in Nicht-Schaltjahren am 28. gefeiert — sonst hätte er in drei von vier Jahren keinen.
function eigeneGratulationHtml(geburtsdatum) {
  if (!geburtsdatum) return '';
  const [, gMonat, gTag] = String(geburtsdatum).split('-').map(Number);
  if (!gMonat || !gTag) return '';
  const heute = new Date();
  const jahr = heute.getFullYear(), monat = heute.getMonth() + 1, tag = heute.getDate();
  const schaltjahr = (jahr % 4 === 0 && jahr % 100 !== 0) || jahr % 400 === 0;
  const echterTag = gMonat === monat && gTag === tag;
  const vorgezogen = !schaltjahr && monat === 2 && tag === 28 && gMonat === 2 && gTag === 29;
  if (!echterTag && !vorgezogen) return '';
  return `<div class="welcome-section" id="welcome-eigener-geburtstag">
    <h3>&#127874; Alles Gute zum Geburtstag!</h3>
    <div class="welcome-bulletin">
      <div class="welcome-bulletin-text">Schön, dass du da bist.</div>
      ${vorgezogen
        ? '<div class="welcome-bulletin-text">Geboren am 29. Februar — den gibt es dieses Jahr nicht, deshalb heute.</div>'
        : ''}
    </div>
  </div>`;
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
      newBulletins = data.entries.filter(b => b.created_at && datumAusZeitstempel(b.created_at) === today);
      const in3 = new Date(now); in3.setDate(in3.getDate() + 3);
      const day3 = formatDateISO(in3);
      eventBulletins = data.entries.filter(b => b.event_date && b.event_date >= today && b.event_date <= day3);
    }
  } catch (e) {}

  // Anklickbar: fuehrt zum Schwarzen Brett und dort direkt zu diesem Aushang. Als Knopf statt als
  // div, damit er auch per Tastatur erreichbar ist (die Barrierefreiheits-Pruefung achtet darauf).
  const bulletinCard = b => `<div class="welcome-bulletin welcome-bulletin--klickbar"
      role="button" tabindex="0" data-aushang="${b.id}"
      aria-label="Aushang ${esc(b.title)} am Schwarzen Brett öffnen">
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

  // Geburtstags-Einblendung. Fuer JEDE Rolle abgefragt — der Server entscheidet, was man sieht:
  // Chef/Admin/Buchhalter wie bisher alle mit Alter, alle uebrigen nur die Kollegen, die sich
  // selbst freigegeben haben (und deren Alter nur bei ausdruecklicher Freigabe).
  let geburtstage = [];
  try {
    const g = await api('GET', '/api/users/geburtstage');
    if (g) geburtstage = g.geburtstage || [];
  } catch (e) {}
  let geburtstagHtml = '';
  if (geburtstage.length > 0) {
    geburtstagHtml = `<div class="welcome-section">
      <h3>&#127874; Geburtstag heute</h3>
      ${geburtstage.map(g => `<div class="welcome-bulletin">
        <div class="welcome-bulletin-header">${avatarHtml(g, 24)} <strong>${esc(g.name)} ${g.alter === undefined ? 'hat heute Geburtstag' : `wird heute ${g.alter}`} &#127881;</strong></div>
        ${g.am_29_februar
          ? '<div class="welcome-bulletin-text">Geboren am 29. Februar — den gibt es dieses Jahr nicht, deshalb heute.</div>'
          : ''}
      </div>`).join('')}
    </div>`;
  }

  // Gratulation für das Geburtstagskind selbst (Alex, 08.08.2026). Sieht NUR die betroffene Person,
  // und zwar jede — auch Mitarbeiter, die von den Geburtstagen der anderen nichts angezeigt bekommen.
  // Datenschutzrechtlich unbedenklich, weil es die eigene Angabe ist und kein Dritter vorkommt;
  // heikel wäre nur die Anzeige für die ganze Belegschaft (siehe oben).
  // Es wird KEIN neues Datum vom Server geholt: `S.user.birth_date` liegt ohnehin im Browser,
  // die Pausen-Vorbelegung braucht es für das Jugendarbeitsschutzgesetz.
  const eigenerGeburtstagHtml = eigeneGratulationHtml(S.user && S.user.birth_date);

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
      ${eigenerGeburtstagHtml}
      ${geburtstagHtml}
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
  // Alten Timer sicher beenden: Die Selbst-Abschaltung unten greift nur, wenn das Element VERSCHWINDET —
  // bei einem Neuaufbau der Willkommensseite (z. B. durch SSE) gibt es aber sofort wieder ein #welcome-clock,
  // sodass sich sonst mit jedem Ereignis ein weiterer Sekundentakt ansammelt (Akku/Ruckeln auf Tablets).
  if (window._welcomeClockInterval) clearInterval(window._welcomeClockInterval);
  window._welcomeClockInterval = setInterval(() => {
    if (!document.getElementById('welcome-clock')) { clearInterval(window._welcomeClockInterval); window._welcomeClockInterval = null; return; }
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
      const byDay = groupHoursByDay(h);
      const todayStr = new Date().toLocaleDateString('sv-SE');
      const todayHours = (byDay.get(todayStr) || []).filter(e => e.hour >= 6 && e.hour <= 22);

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
        ${hourlyStripHtml(h, todayHours, new Date().getHours())}
        ${weekForecastHtml(h, byDay, todayStr)}`;
    }
  } catch (e) {
    const wDiv = document.getElementById('welcome-weather');
    if (wDiv) wDiv.innerHTML = '<h3>&#9925; Wetter</h3><p style="color:var(--text-light)">Wetterdaten nicht verfügbar.</p>';
  }

  // Wochen-Planung laden
  await renderWelcomeWeek();

  // Tastaturbedienung fuer die anklickbaren Aushaenge (Enter/Leertaste wie ein Knopf)
  mainEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const aushang = e.target.closest('[data-aushang]');
    if (aushang) {
      e.preventDefault();
      S._aushangZiel = Number(aushang.dataset.aushang);
      navigate('/bulletin');
      return;
    }
    const termin = e.target.closest('[data-planung]');
    if (termin) {
      e.preventDefault();
      S._planungZiel = Number(termin.dataset.planung);
      S.planningDate = new Date(termin.dataset.planungTag + 'T12:00:00');
      S.planningView = 'day';
      navigate('/planning');
    }
  });

  // Navigation starten (delegiert, da Inhalt dynamisch)
  mainEl.addEventListener('click', (e) => {
    const navBtn = e.target.closest('.nav-to-addr');
    if (navBtn) { openNav(navBtn.dataset.addr); return; }
    const acceptBtn = e.target.closest('.accept-welcome-plan');
    if (acceptBtn) { S._uebernahmeVon = '/welcome'; navigate('/planning/accept/' + acceptBtn.dataset.id); return; }
    // Termin antippen → Planung, Tagesansicht, dort zum Termin springen.
    // Knoepfe im Termin (Navigieren/Uebernehmen) sind oben schon behandelt und kommen nicht hierher.
    const termin = e.target.closest('[data-planung]');
    if (termin && !e.target.closest('button')) {
      S._planungZiel = Number(termin.dataset.planung);
      S.planningDate = new Date(termin.dataset.planungTag + 'T12:00:00');
      S.planningView = 'day';
      navigate('/planning');
      return;
    }
    // Aushang antippen → Schwarzes Brett, dort zum Eintrag springen
    const aushang = e.target.closest('[data-aushang]');
    if (aushang) { S._aushangZiel = Number(aushang.dataset.aushang); navigate('/bulletin'); return; }
    // Wetter-Vorschau: Tag antippen → stündlichen Verlauf auf-/zuklappen
    const wwRow = e.target.closest('.ww-row[data-day]');
    if (wwRow) {
      const detail = wwRow.parentElement?.querySelector('.ww-detail');
      if (detail) {
        const wasOpen = !detail.hasAttribute('hidden');
        if (wasOpen) detail.setAttribute('hidden', ''); else detail.removeAttribute('hidden');
        wwRow.classList.toggle('ww-open', !wasOpen);
      }
      return;
    }
  });
}

// Stundenwerte nach Kalendertag gruppieren — über die Zeitstempel, NICHT per Index-Rechnung
// (robust gegen Zeitumstellung: 23-/25-Stunden-Tage).
function groupHoursByDay(h) {
  const byDay = new Map();
  (h && h.time ? h.time : []).forEach((t, i) => {
    const [day, hm] = String(t).split('T');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ i, hour: parseInt(hm, 10) });
  });
  return byDay;
}

// Stündlicher Verlaufsstreifen (Temperatur-Balken + Symbol + Regen + Uhrzeit) für eine Stundenliste.
// Wird für den heutigen Tag UND für die aufklappbaren Tage der Vorschau genutzt.
function hourlyStripHtml(h, entries, highlightHour) {
  if (!entries || !entries.length) return '';
  const temps = entries.map(e => h.temperature_2m?.[e.i]).filter(v => typeof v === 'number');
  if (!temps.length) return '';
  const tempMin = Math.min(...temps), tempMax = Math.max(...temps);
  const range = (tempMax - tempMin) || 1;
  const cols = entries.map(e => {
    const temp = h.temperature_2m?.[e.i];
    const code = h.weather_code?.[e.i] ?? 0;
    const rain = h.precipitation_probability?.[e.i] ?? 0;
    const barPct = typeof temp === 'number' ? Math.round(((temp - tempMin) / range) * 100) : 0;
    const isNow = highlightHour !== null && highlightHour !== undefined && e.hour === highlightHour;
    return `<div class="wh-col${isNow ? ' wh-now' : ''}">
      <div class="wh-temp">${typeof temp === 'number' ? Math.round(temp) + '°' : '–'}</div>
      <div class="wh-bar-wrap"><div class="wh-bar" style="height:${Math.max(barPct, 8)}%"></div></div>
      <div class="wh-icon">${weatherIcon(code)}</div>
      <div class="wh-rain">${rain > 0 ? rain + '%' : '&nbsp;'}</div>
      <div class="wh-time">${e.hour}h</div>
    </div>`;
  }).join('');
  return `<div class="wh-scroll"><div class="wh-timeline">${cols}</div></div>`;
}

// Vorschau der Folgetage: je Tag früh (6–11) / mittag (12–17) / abend (18–22).
// Tage innerhalb WEATHER_HOURLY_DAYS rechnen auf den hochauflösenden Modellen → dort ist zusätzlich der
// STÜNDLICHE Verlauf per Antippen aufklappbar. Weiter voraus gibt es keine belastbaren Daten — darauf weist
// eine Fußzeile hin. (Backend liefert aktuell genau diese 7 Tage.)
const WEATHER_HOURLY_DAYS = 7;
function weekForecastHtml(h, byDay, todayStr) {
  if (!byDay) return '';
  // Die Liste beginnt mit MORGEN. Der heutige Tag steht schon oben als stündlicher Verlauf; in der
  // Liste kam er ein zweites Mal vor — aufgeklappt sogar mit demselben Streifen direkt darunter
  // (Alex, 30.07.2026). ISO-Datumsangaben lassen sich als Text vergleichen.
  const tage = [...byDay.entries()].filter(([dayStr]) => dayStr > todayStr);
  if (!tage.length) return '';
  const SLOTS = [{ label: 'früh', from: 6, to: 11 }, { label: 'mittag', from: 12, to: 17 }, { label: 'abend', from: 18, to: 22 }];
  const items = [];
  let dayIdx = 0;
  for (const [dayStr, entries] of tage) {
    const cells = SLOTS.map(s => {
      const idx = entries.filter(e => e.hour >= s.from && e.hour <= s.to).map(e => e.i);
      if (!idx.length) return '<div class="ww-cell ww-empty">–</div>';
      const temps = idx.map(i => h.temperature_2m?.[i]).filter(v => typeof v === 'number');
      const avg = temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null;
      const counts = {};
      idx.forEach(i => { const c = h.weather_code?.[i]; if (c !== undefined && c !== null) counts[c] = (counts[c] || 0) + 1; });
      const codes = Object.keys(counts);
      const code = codes.length ? Number(codes.sort((a, b) => counts[b] - counts[a])[0]) : 0;
      const rains = idx.map(i => h.precipitation_probability?.[i]).filter(v => typeof v === 'number');
      const rain = rains.length ? Math.max(...rains) : 0;
      return `<div class="ww-cell">
        <div class="ww-icon">${weatherIcon(code)}</div>
        <div class="ww-temp">${avg !== null ? avg + '°' : '–'}</div>
        <div class="ww-rain">${rain > 0 ? rain + '%' : '&nbsp;'}</div>
      </div>`;
    }).join('');
    const dObj = new Date(dayStr + 'T12:00:00');
    const label = dObj.toLocaleDateString('de-DE', { weekday: 'short' });
    const short = dObj.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    // Stündlich nur für die ersten Tage (dort sind die Daten fein genug). Keine „jetzt"-Markierung
    // mehr — die gäbe es nur für heute, und heute steht nicht mehr in dieser Liste.
    const hourly = dayIdx < WEATHER_HOURLY_DAYS
      ? hourlyStripHtml(h, entries.filter(e => e.hour >= 6 && e.hour <= 22), null)
      : '';
    items.push(`<div class="ww-item">
      <div class="ww-row${hourly ? ' ww-clickable' : ''}"${hourly ? ` data-day="${dayStr}"` : ''}>
        <div class="ww-day"><strong>${label}</strong><span>${short}</span>${hourly ? '<span class="ww-caret">&#9656;</span>' : ''}</div>${cells}
      </div>
      ${hourly ? `<div class="ww-detail" hidden>${hourly}</div>` : ''}
    </div>`);
    dayIdx++;
  }
  if (!items.length) return '';
  return `<div class="weather-week">
    <div class="ww-row ww-head"><div class="ww-day"></div>${SLOTS.map(s => `<div class="ww-cell">${s.label}</div>`).join('')}</div>
    ${items.join('')}
    <p class="ww-note">Tag antippen zeigt den stündlichen Verlauf. Für weiter entfernte Tage liegen keine Vorhersagedaten vor.</p>
  </div>`;
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
      return `<div class="bulletin-card${b.is_unread ? ' bulletin-card--unread' : ''}" data-id="${b.id}">
        <div class="bulletin-header">
          <h3 class="bulletin-title">${esc(b.title)}</h3>
          ${canEdit ? `<div class="bulletin-actions">
            <button class="btn btn-sm edit-bulletin" data-id="${b.id}"
              title="Bearbeiten" aria-label="Aushang ${esc(b.title)} bearbeiten">&#9998;</button>
            <button class="btn btn-sm del-btn del-bulletin" data-id="${b.id}"
              title="Löschen" aria-label="Aushang ${esc(b.title)} löschen">&times;</button>
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

  // Von der Willkommensseite hergesprungen? Dann zum gemeinten Aushang scrollen und ihn kurz
  // hervorheben — sonst landet man bei vielen Aushaengen oben und sucht den, den man angetippt hat.
  if (S._aushangZiel) {
    const ziel = mainEl.querySelector(`.bulletin-card[data-id="${S._aushangZiel}"]`);
    S._aushangZiel = null;
    if (ziel) {
      ziel.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ziel.classList.add('bulletin-card--hervor');
      setTimeout(() => ziel.classList.remove('bulletin-card--hervor'), 2500);
    }
  }

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
    // A17: Ist der Aushang inzwischen weg (Auto-Löschdatum abgelaufen oder von jemand anderem gelöscht),
    // darf das Formular NICHT stillschweigend in den Anlege-Modus kippen — sonst tippt man in ein
    // scheinbares „Bearbeiten"-Formular und erzeugt in Wahrheit einen zweiten Eintrag.
    if (!entry) { toast('Dieser Aushang existiert nicht mehr.', 'error'); navigate('/bulletin'); return; }
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

  const bfEntwurf = 'aushang:' + (isEdit ? editId : 'neu');
  initDraftKeeper(document.getElementById('bulletin-form'), bfEntwurf);

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
      entwurfLoeschen(bfEntwurf);
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
/**
 * Ist fuer diesen Mitarbeiter ein Austritt VORGEMERKT? Dann das Datum, sonst null.
 *
 * Die Vormerkung hat kein eigenes Feld — sie ist die Kombination, die es vorher nicht geben
 * konnte: Konto aktiv UND der juengste Anstellungszeitraum hat schon ein Ende. Ein ausgestellter
 * Mitarbeiter hat dasselbe Ende, aber `active = 0`; deshalb steht die Pruefung hier zusammen.
 */
function austrittVorgemerktAm(u) {
  if (!u || Number(u.active) === 0) return null;
  const zeiten = (u.employment || []).filter(p => p && p.e);
  if (!zeiten.length) return null;
  return zeiten.map(p => p.e).sort().pop();
}

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
      ${listenSucheHtml('mitarbeiter', 'Name, Benutzername oder Rolle suchen …')}
      <div class="table-wrap">
        <table class="data-table mitarbeiter-tabelle">
          <thead>
            <tr>
              <th>Name</th>
              <th>Benutzername</th>
              <th>Rolle</th>
              <th>Soll h/Woche</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody id="users-tbody">
            ${S.users.filter(u => u.active !== 0).map(u => `
              <tr data-suchtext="${esc([u.name, u.username, roleName(u.role)].join(' '))}">
                <td><span class="zelle-mit-bild">${avatarHtml(u, 26)}<span>${esc(u.name)}</span>${
                  austrittVorgemerktAm(u) ? `<span class="austritt-vormerkung" title="Der Zugang bleibt bis einschließlich diesem Tag bestehen">scheidet aus zum ${formatDateDE(austrittVorgemerktAm(u))}</span>` : ''
                }</span></td>
                <td>${esc(u.username)}</td>
                <td><span class="badge badge-${u.role}">${roleName(u.role)}</span></td>
                <td>${u.target_hours_per_week}</td>
                <td class="actions">
                  <button class="btn btn-sm btn-outline edit-user" data-id="${u.id}">Bearbeiten</button>
                  ${u.id === S.user.id ? '' : austrittVorgemerktAm(u)
                    ? `<button class="btn btn-sm btn-outline austritt-aufheben" data-id="${u.id}">Vormerkung aufheben</button>`
                    : `<button class="btn btn-sm btn-warning deactivate-user" data-id="${u.id}">Ausstellen</button>`}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  bindListenSuche('mitarbeiter', '#users-tbody');

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
        `"${user?.name}" ausstellen. Alle Daten bleiben erhalten und werden weiter angezeigt.\n\n`
        + `Bis einschließlich zum letzten Arbeitstag bleibt der Zugang bestehen — er kann also bis zuletzt `
        + `seine Stunden buchen. Danach wird das Konto automatisch geschlossen; erst dann werden `
        + `Zwei-Faktor und Push-Benachrichtigungen gelöscht.\n\n`
        + `Liegt der Tag bereits in der Vergangenheit, wirkt das Ausstellen sofort.\n\n`
        + `Letzter Arbeitstag (Austrittsdatum):`,
        { title: 'Mitarbeiter ausstellen', okLabel: 'Ausstellen', multiline: false, inputType: 'date', defaultValue: today, required: true, requiredMsg: 'Bitte ein Austrittsdatum wählen.' }
      );
      if (employedUntil === null) return; // Abbrechen
      try {
        const r = await api('POST', '/api/users/' + btn.dataset.id + '/deactivate', { employed_until: employedUntil.trim() });
        toast(r && r.vorgemerkt
          ? `Austritt zum ${formatDateDE(employedUntil.trim())} vorgemerkt — der Zugang bleibt bis dahin bestehen`
          : 'Mitarbeiter ausgestellt', 'success', r && r.vorgemerkt ? 6000 : undefined);
        renderUsers();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  mainEl.querySelectorAll('.austritt-aufheben').forEach(btn => {
    btn.addEventListener('click', async () => {
      const user = S.users.find(u => u.id === Number(btn.dataset.id));
      const wann = austrittVorgemerktAm(user);
      if (!(await confirmModal(
        `Der Austritt von "${user?.name}" zum ${formatDateDE(wann)} wird zurückgenommen. `
        + `Der Anstellungszeitraum läuft dann wieder offen weiter.`,
        { title: 'Vormerkung aufheben', okLabel: 'Aufheben' }))) return;
      try {
        await api('POST', '/api/users/' + btn.dataset.id + '/austritt-aufheben');
        toast('Vormerkung aufgehoben', 'success');
        renderUsers();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

async function showUserModal(user) {
  await ladeArbeitszeit();   // Firmenwert fuer den Hinweis „leer = …"
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
        <div class="form-group">
          <label>Personalnummer <span class="push-hint">(optional, fürs Lohnbüro)</span></label>
          <input type="text" class="form-control" id="um-personnel-no" value="${esc(user?.personnel_no || '')}"
            maxlength="32" inputmode="text" autocomplete="off" placeholder="z. B. 0042">
        </div>
        <div class="form-group">
          <label>Arbeitsbeginn
            <span class="push-hint">(leer = Firmenwert ${esc(arbeitszeitJetzt().work_start_default)})</span>
          </label>
          <input type="time" class="form-control" id="um-work-start" value="${esc(user?.work_start || '')}">
          <span class="push-hint">Nur ausfüllen, wenn dieser Mitarbeiter abweichend beginnt.
            Vorschlag für den ersten Zeiteintrag des Tages.</span>
        </div>
        <div class="form-group">
          <label>Geburtsdatum</label>
          <input type="date" class="form-control" id="um-birth-date" value="${esc(user?.birth_date || '')}" max="${new Date().toLocaleDateString("sv-SE")}">
          <small class="push-hint">Nur für die Pausenregeln: Unter 18 gilt das
            Jugendarbeitsschutzgesetz mit längeren Pausen. <strong>Bleibt das Feld leer, rechnet die
            App vorsichtshalber mit „unter 18"</strong> — lieber eine zu lange Pause vorschlagen als
            eine zu kurze.</small>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <button type="button" class="btn btn-outline btn-sm" id="um-reset-pw-btn">&#128274; Passwort zurücksetzen</button>
          <div id="um-reset-pw-form" style="display:none;margin-top:0.5rem;">
            <input type="password" class="form-control" id="um-pw-new" placeholder="Neues Passwort" style="margin-bottom:0.4rem;">
            <ul class="pw-reqs" id="um-pw-reqs2"></ul>
            <input type="password" class="form-control" id="um-pw-repeat" placeholder="Wiederholen">
            <div style="display:flex;gap:0.5rem;margin-top:0.4rem;">
              <button type="button" class="btn btn-primary btn-sm" id="um-pw-save">Speichern</button>
              <button type="button" class="btn btn-outline btn-sm" id="um-pw-cancel">Abbrechen</button>
            </div>
          </div>
        </div>
        <div class="form-group">
          <button type="button" class="btn btn-outline btn-sm" id="um-2fa-reset-btn">&#128241; Zwei-Faktor zurücksetzen</button>
          <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem">
            Bei verlorenem oder neuem Handy. Löscht den Authenticator und alle gemerkten Geräte —
            die Person richtet ihn danach neu ein.
          </div>
        </div>` : `
        <div class="form-group">
          <label>Passwort</label>
          <input type="password" class="form-control" id="um-password" required>
          <ul class="pw-reqs" id="um-pw-reqs"></ul>
          <input type="password" class="form-control" id="um-password-repeat" placeholder="Passwort wiederholen" style="margin-top:0.4rem;">
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
            <input type="text" inputmode="decimal" class="form-control" id="um-start-overtime" value="${numDe(user?.start_overtime ?? 0)}">
          </div>
        </div>
        <div class="form-group" id="um-rights-role-hint" style="display:none;">
          <p class="push-hint" style="margin:0;">Chef und Admin haben Planungs-, Schwarzes-Brett- und Upload-Recht automatisch (per Rolle) – Einzelrechte sind hier nicht nötig.</p>
        </div>
        <div class="form-group" id="um-rights-group">
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
        <!-- Bewusst eine EIGENE Gruppe: Beim Bestellen hat auch der Buchhalter das Recht per
             Rolle, bei Planung/Brett/Upload nicht. Die beiden Bloecke werden deshalb nach
             unterschiedlichen Regeln aus- und eingeblendet. -->
        <div class="form-group" id="um-order-group">
          <label style="display:block;margin-bottom:0.3rem;">Bestellungen</label>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
            <input type="checkbox" id="um-can-order" ${user?.can_order ? 'checked' : ''}>
            Bestellungen abschließen
          </label>
          <p class="push-hint" style="margin:0.25rem 0 0;">
            Darf offene Bestellungen auf „Bestellt" setzen und fremde Einträge korrigieren –
            z. B. Vorarbeiter, oder als Vertretung während des Urlaubs. Bestellte Einträge löschen
            bleibt beim Admin.
          </p>
        </div>
        <div class="form-group" id="um-order-role-hint" style="display:none;">
          <p class="push-hint" style="margin:0;">Chef, Admin und Buchhalter dürfen Bestellungen ohnehin abschließen (per Rolle).</p>
        </div>
        ${isEdit ? `
        <div class="form-section">
          <label class="form-section-title">Soll-Stunden pro Tag</label>
          <div id="um-targets-list"><div class="loading"><div class="spinner"></div></div></div>
          <div class="targets-add-days">
            <div class="day-hours-row">
              <label>Mo <input type="text" inputmode="decimal" id="um-target-mon" value="8" class="form-control form-control-sm"></label>
              <label>Di <input type="text" inputmode="decimal" id="um-target-tue" value="8" class="form-control form-control-sm"></label>
              <label>Mi <input type="text" inputmode="decimal" id="um-target-wed" value="8" class="form-control form-control-sm"></label>
              <label>Do <input type="text" inputmode="decimal" id="um-target-thu" value="8" class="form-control form-control-sm"></label>
              <label>Fr <input type="text" inputmode="decimal" id="um-target-fri" value="6" class="form-control form-control-sm"></label>
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
            <label>Mo <input type="text" inputmode="decimal" class="form-control form-control-sm" id="um-h-mon" value="8"></label>
            <label>Di <input type="text" inputmode="decimal" class="form-control form-control-sm" id="um-h-tue" value="8"></label>
            <label>Mi <input type="text" inputmode="decimal" class="form-control form-control-sm" id="um-h-wed" value="8"></label>
            <label>Do <input type="text" inputmode="decimal" class="form-control form-control-sm" id="um-h-thu" value="8"></label>
            <label>Fr <input type="text" inputmode="decimal" class="form-control form-control-sm" id="um-h-fri" value="6"></label>
          </div>
        </div>`}
        ${isEdit ? `
        <div class="form-section">
          <label class="form-section-title">Urlaubsanspruch</label>
          <div class="vac-startcarry">
            <label>Start-Resturlaub (Übertrag) <input type="text" inputmode="decimal" id="um-vac-startcarry" value="0" placeholder="z.B. 5 oder -0,5" class="form-control form-control-sm"></label>
            <button type="button" class="btn btn-outline btn-sm" id="um-vac-startcarry-save">Übernehmen</button>
            <span class="vac-startcarry-hint">Stand VOR der App / einmaliger Übertrag ins erste erfasste Anspruchsjahr</span>
          </div>
          <div id="um-vac-list"><div class="loading"><div class="spinner"></div></div></div>
          <div class="vac-add-row">
            <label>Tage <input type="text" inputmode="decimal" id="um-vac-days" value="0" placeholder="z.B. 30 oder 2,5" class="form-control form-control-sm"></label>
            <label>Rest verfällt
              <select id="um-vac-mode" class="form-control form-control-sm">
                <option value="yearend">zum Jahreswechsel</option>
                <option value="never">nie</option>
                <option value="date">am … (Folgejahr)</option>
              </select>
            </label>
            <input type="text" id="um-vac-until" class="form-control form-control-sm" placeholder="MM-TT" value="03-31" style="display:none;max-width:5.5rem">
            <label>gültig ab <input type="date" id="um-vac-from" class="form-control form-control-sm"></label>
            <button type="button" class="btn btn-primary btn-sm" id="um-vac-add">Hinzufügen</button>
          </div>
          <div id="um-vac-stand" class="vac-stand"></div>
        </div>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" id="um-cancel">Abbrechen</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Speichern' : 'Erstellen'}</button>
        </div>
      </form>
    </div>`;

  document.body.appendChild(overlay);

  const umAufraeumen = dialogBarrierefrei(overlay);
  const umSchliessen = () => { overlay.remove(); umAufraeumen(); };
  document.getElementById('um-cancel').addEventListener('click', umSchliessen);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) umSchliessen(); });

  // Live-Passwort-Prüfung (Feld färbt sich rot/grün, Checkliste ✓/✗). Anlegen: Passwortfeld; Bearbeiten:
  // das Zurücksetzen-Feld (existiert im DOM, auch wenn eingeklappt).
  if (!isEdit) wirePwField(document.getElementById('um-password'), document.getElementById('um-pw-reqs'));
  else wirePwField(document.getElementById('um-pw-new'), document.getElementById('um-pw-reqs2'));

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

  // #9: Chef/Admin planen/verwalten ohnehin per Rolle → den Einzelrechte-Block ausblenden (Hinweis zeigen).
  const roleSel = document.getElementById('um-role');
  const rightsGroup = document.getElementById('um-rights-group');
  const rightsHint = document.getElementById('um-rights-role-hint');
  const syncRightsVisibility = () => {
    const isMgr = roleSel.value === 'chef' || roleSel.value === 'admin';
    if (rightsGroup) rightsGroup.style.display = isMgr ? 'none' : '';
    if (rightsHint) rightsHint.style.display = isMgr ? '' : 'none';
  };
  // Bestellrecht: drei Rollen haben es per Rolle (inkl. Buchhalter) — eigene Sichtbarkeit.
  const orderGroup = document.getElementById('um-order-group');
  const orderHint = document.getElementById('um-order-role-hint');
  const syncOrderVisibility = () => {
    const perRolle = ['chef', 'admin', 'buchhalter'].includes(roleSel.value);
    if (orderGroup) orderGroup.style.display = perRolle ? 'none' : '';
    if (orderHint) orderHint.style.display = perRolle ? '' : 'none';
  };
  roleSel.addEventListener('change', () => { syncRightsVisibility(); syncOrderVisibility(); });
  syncRightsVisibility();
  syncOrderVisibility();

  // Zwei-Faktor zuruecksetzen (nur bei Bearbeitung) — der Weg zurueck bei verlorenem Handy.
  if (isEdit) {
    document.getElementById('um-2fa-reset-btn')?.addEventListener('click', async () => {
      const weiter = await confirmModal(
        `Zwei-Faktor-Anmeldung von ${user.name} zurücksetzen? Der Authenticator und alle gemerkten `
        + 'Geräte werden gelöscht. Ist die Rolle zur Zwei-Faktor-Anmeldung verpflichtet, muss die '
        + 'Person sie beim nächsten Aufruf neu einrichten.');
      if (!weiter) return;
      try {
        await api('POST', `/api/users/${user.id}/twofa-reset`);
        toast('Zwei-Faktor zurückgesetzt', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

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
      if (!passwordAllOk(pw1)) { toast('Passwort erfüllt die Anforderungen nicht', 'error'); return; }
      if (pw1.toLowerCase() === user.username.toLowerCase()) { toast('Passwort darf nicht dem Benutzernamen entsprechen', 'error'); return; }
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
      // A6: ungültige Eingabe melden statt still 0 zu speichern (fließt direkt in die Soll-/Überstunden).
      const body = { valid_from: from };
      for (const [id, key, label] of [['um-target-mon', 'hours_mon', 'Montag'], ['um-target-tue', 'hours_tue', 'Dienstag'],
        ['um-target-wed', 'hours_wed', 'Mittwoch'], ['um-target-thu', 'hours_thu', 'Donnerstag'], ['um-target-fri', 'hours_fri', 'Freitag']]) {
        const v = numFromField(id, 0, 0, 24);
        if (v === null) { toast(`Soll-Stunden ${label}: bitte eine Zahl zwischen 0 und 24 eingeben`, 'error'); return; }
        body[key] = v;
      }
      try {
        await api('POST', `/api/statistics/targets/${user.id}`, body);
        toast('Soll-Stunden gespeichert', 'success');
        await loadUserTargets(user.id);
      } catch (e) { toast(e.message, 'error'); }
    });

    // Urlaubsanspruch-Verlauf + aktueller Stand
    await loadUserVacation(user.id);
    await loadUserVacationStand(user.id);
    const vacMode = document.getElementById('um-vac-mode');
    const vacUntil = document.getElementById('um-vac-until');
    const syncVacUntil = () => { vacUntil.style.display = vacMode.value === 'date' ? '' : 'none'; };
    vacMode.addEventListener('change', syncVacUntil); syncVacUntil();
    document.getElementById('um-vac-add').addEventListener('click', async () => {
      const from = document.getElementById('um-vac-from').value;
      if (!from) { toast('Gültig-ab-Datum eingeben', 'error'); return; }
      // B4: ungültige Eingabe nicht still zu 0 machen, sondern melden.
      const daysRaw = String(document.getElementById('um-vac-days').value).trim().replace(',', '.');
      const days = parseFloat(daysRaw);
      if (daysRaw === '' || !isFinite(days)) { toast('Bitte eine gültige Zahl für die Urlaubstage eingeben', 'error'); return; }
      const body = {
        valid_from: from,
        days,
        carryover_mode: vacMode.value,
        carryover_until: vacMode.value === 'date' ? vacUntil.value.trim() : null,
      };
      try {
        await api('POST', `/api/statistics/vacation/${user.id}`, body);
        toast('Urlaubsanspruch gespeichert', 'success');
        await loadUserVacation(user.id);
        await loadUserVacationStand(user.id);
      } catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('um-vac-startcarry-save').addEventListener('click', async () => {
      // B4: leer = 0 (bewusst erlaubt), aber unsinnige Eingabe nicht still zu 0 machen.
      const raw = String(document.getElementById('um-vac-startcarry').value).trim().replace(',', '.');
      const days = raw === '' ? 0 : parseFloat(raw);
      if (raw !== '' && !isFinite(days)) { toast('Bitte eine gültige Zahl für den Start-Resturlaub eingeben', 'error'); return; }
      try {
        await api('PUT', `/api/statistics/vacation/${user.id}/start-carry`, { days });
        toast('Start-Resturlaub gespeichert', 'success');
        await loadUserVacationStand(user.id);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  document.getElementById('user-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return; // B3: Anfrage schon unterwegs → Doppel-Submit verhindern
    // A6: ungültige Zahlen NICHT still zu 0 machen — sie gehen direkt in die Überstundenrechnung.
    const startOt = numFromField('um-start-overtime', 0);
    if (startOt === null) { toast('Start-Überstunden: bitte eine gültige Zahl eingeben', 'error'); return; }
    const body = {
      name: document.getElementById('um-name').value,
      username: document.getElementById('um-username').value,
      personnel_no: document.getElementById('um-personnel-no').value,
      work_start: document.getElementById('um-work-start').value,
      birth_date: document.getElementById('um-birth-date').value,
      role: document.getElementById('um-role').value,
      start_overtime: startOt,
      can_plan: document.getElementById('um-can-plan').checked,
      can_plan_all: document.getElementById('um-can-plan-all').checked,
      can_bulletin: document.getElementById('um-can-bulletin').checked,
      can_order: document.getElementById('um-can-order').checked,
      can_upload: document.getElementById('um-can-upload').checked,
    };
    // Bei neuem User Tages-Stunden setzen
    if (!isEdit) {
      const dayIds = [['um-h-mon', 'hours_mon', 'Montag'], ['um-h-tue', 'hours_tue', 'Dienstag'], ['um-h-wed', 'hours_wed', 'Mittwoch'],
        ['um-h-thu', 'hours_thu', 'Donnerstag'], ['um-h-fri', 'hours_fri', 'Freitag']];
      for (const [id, key, label] of dayIds) {
        const v = numFromField(id, 0, 0, 24);
        if (v === null) { toast(`Soll-Stunden ${label}: bitte eine Zahl zwischen 0 und 24 eingeben`, 'error'); return; }
        body[key] = v;
      }
      body.target_hours_per_week = body.hours_mon + body.hours_tue + body.hours_wed + body.hours_thu + body.hours_fri;
    }
    if (submitBtn) submitBtn.disabled = true; // B3
    try {
      if (isEdit) {
        await api('PUT', '/api/users/' + user.id, body);
        toast('Mitarbeiter aktualisiert', 'success');
      } else {
        const pw = document.getElementById('um-password').value;
        const pwRepeat = document.getElementById('um-password-repeat').value;
        if (!pw) { toast('Passwort erforderlich', 'error'); return; }
        if (!passwordAllOk(pw)) { toast('Passwort erfüllt die Anforderungen nicht', 'error'); return; }
        if (pw.toLowerCase() === (body.username || '').toLowerCase()) { toast('Passwort darf nicht dem Benutzernamen entsprechen', 'error'); return; }
        if (pw !== pwRepeat) { toast('Passwörter stimmen nicht überein', 'error'); return; }
        body.password = pw;
        await api('POST', '/api/users', body);
        toast('Mitarbeiter erstellt', 'success');
      }
      overlay.remove();
      renderUsers();
    } catch (err) { toast(err.message, 'error'); }
    finally { if (submitBtn) submitBtn.disabled = false; } // B3: Button wieder freigeben (bei Fehler/Validierungs-Abbruch)
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
          <td><input type="text" inputmode="decimal" class="form-control form-control-sm t-mon" value="${numDe(t.hours_mon||0)}"></td>
          <td><input type="text" inputmode="decimal" class="form-control form-control-sm t-tue" value="${numDe(t.hours_tue||0)}"></td>
          <td><input type="text" inputmode="decimal" class="form-control form-control-sm t-wed" value="${numDe(t.hours_wed||0)}"></td>
          <td><input type="text" inputmode="decimal" class="form-control form-control-sm t-thu" value="${numDe(t.hours_thu||0)}"></td>
          <td><input type="text" inputmode="decimal" class="form-control form-control-sm t-fri" value="${numDe(t.hours_fri||0)}"></td>
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
        // A6: ungültige Eingabe melden statt still 0 zu speichern.
        const body = { valid_from: from };
        for (const [sel, key, label] of [['.t-mon', 'hours_mon', 'Montag'], ['.t-tue', 'hours_tue', 'Dienstag'],
          ['.t-wed', 'hours_wed', 'Mittwoch'], ['.t-thu', 'hours_thu', 'Donnerstag'], ['.t-fri', 'hours_fri', 'Freitag']]) {
          const v = numFromField(tr.querySelector(sel), 0, 0, 24);
          if (v === null) { toast(`Soll-Stunden ${label}: bitte eine Zahl zwischen 0 und 24 eingeben`, 'error'); return; }
          body[key] = v;
        }
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

// Urlaubsanspruch-Verlauf (versioniert wie Soll-Stunden): je Zeile Gültig-ab, Tage, Verfall-Regel.
const VAC_MODE_LABELS = { yearend: 'zum Jahreswechsel', never: 'nie', date: 'am … (Folgejahr)' };
async function loadUserVacation(userId) {
  const container = document.getElementById('um-vac-list');
  if (!container) return;
  try {
    const data = await api('GET', `/api/statistics/vacation/${userId}`);
    if (!data) return;
    const sc = document.getElementById('um-vac-startcarry');
    if (sc) sc.value = String(data.start_carry || 0).replace('.', ',');
    const ents = data.entitlements || [];
    if (!ents.length) {
      container.innerHTML = '<div class="vac-empty">Noch kein Urlaubsanspruch hinterlegt – es wird mit 0 gerechnet.</div>';
      return;
    }
    container.innerHTML = `<table class="data-table targets-table vac-table">
      <tr><th>Gültig ab</th><th>Tage</th><th>Rest verfällt</th><th></th></tr>
      ${ents.map(t => `
        <tr data-vac-id="${t.id}">
          <td><input type="date" class="form-control form-control-sm vac-from" value="${t.valid_from}"></td>
          <td><input type="text" inputmode="decimal" class="form-control form-control-sm vac-days" value="${String(t.days).replace('.', ',')}"></td>
          <td>
            <select class="form-control form-control-sm vac-mode">
              <option value="yearend" ${t.carryover_mode === 'yearend' ? 'selected' : ''}>zum Jahreswechsel</option>
              <option value="never" ${t.carryover_mode === 'never' ? 'selected' : ''}>nie</option>
              <option value="date" ${t.carryover_mode === 'date' ? 'selected' : ''}>am … (Folgejahr)</option>
            </select>
            <input type="text" class="form-control form-control-sm vac-until" placeholder="MM-TT" value="${esc(t.carryover_until || '03-31')}" style="max-width:5rem;${t.carryover_mode === 'date' ? '' : 'display:none'}">
          </td>
          <td class="actions target-actions">
            <button type="button" class="btn btn-sm btn-outline save-vac" title="Speichern">&#10003;</button>
            <button type="button" class="btn btn-sm btn-danger del-vac" title="Löschen">&#10005;</button>
          </td>
        </tr>`).join('')}
    </table>`;
    container.querySelectorAll('tr[data-vac-id]').forEach(tr => {
      const mode = tr.querySelector('.vac-mode'), until = tr.querySelector('.vac-until');
      mode.addEventListener('change', () => { until.style.display = mode.value === 'date' ? '' : 'none'; });
    });
    container.querySelectorAll('.save-vac').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const from = tr.querySelector('.vac-from').value;
        if (!from) { toast('Datum eingeben', 'error'); return; }
        const mode = tr.querySelector('.vac-mode').value;
        const body = {
          valid_from: from,
          days: parseFloat(String(tr.querySelector('.vac-days').value).replace(',', '.')) || 0,
          carryover_mode: mode,
          carryover_until: mode === 'date' ? tr.querySelector('.vac-until').value.trim() : null,
        };
        try {
          await api('PUT', `/api/statistics/vacation/${userId}/${tr.dataset.vacId}`, body);
          toast('Gespeichert', 'success');
          await loadUserVacation(userId); await loadUserVacationStand(userId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    container.querySelectorAll('.del-vac').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('tr').dataset.vacId;
        try {
          await api('DELETE', `/api/statistics/vacation/${userId}/${id}`);
          toast('Eintrag gelöscht', 'success');
          await loadUserVacation(userId); await loadUserVacationStand(userId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) {}
}

// Aktueller Urlaubsstand (read-only) mit Jahr-Auswahl — deckt die Chef/Admin-Sicht je MA ab.
async function loadUserVacationStand(userId, year) {
  const box = document.getElementById('um-vac-stand');
  if (!box) return;
  const cur = new Date().getFullYear();
  const y = year || cur;
  const years = [];
  for (let yy = cur + 1; yy >= cur - 3; yy--) years.push(yy);
  try {
    const data = await api('GET', `/api/absences/summary?user_id=${userId}&from=${y}-01-01&to=${y}-12-31`);
    const v = (data && data.vacation) || { anspruch: 0, uebertrag: 0, verfuegbar: 0, genommen: 0, geplant: 0, nochZuPlanen: 0, configured: false };
    const yearSel = `<span class="vac-stand-year">Stand
        <select class="form-control form-control-sm vac-stand-select">
          ${years.map(yy => `<option value="${yy}" ${yy === y ? 'selected' : ''}>${yy}</option>`).join('')}
        </select>:
      </span>`;
    box.innerHTML = v.configured
      ? `${yearSel}
        <strong>${v.genommen}</strong> genommen · <strong>${v.geplant}</strong> geplant ·
        <strong>${v.nochZuPlanen}</strong> noch zu planen
        <span class="vac-stand-detail">(Anspruch ${v.anspruch} + Übertrag ${v.uebertrag} = ${v.verfuegbar})</span>`
      : `${yearSel} <strong>${v.genommen}</strong> genommen · <span class="vac-stand-detail">noch kein Anspruch hinterlegt – Resturlaub wird erst mit Anspruch berechnet</span>`;
    box.querySelector('.vac-stand-select').addEventListener('change', (e) => loadUserVacationStand(userId, Number(e.target.value)));
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
let _expandedProjects = new Set(); // aufgeklappte Kacheln (überlebt Re-Render/SSE)
let _statsOpen = new Set(); // Projekt-Kacheln mit geöffnetem Statistik-Reiter (Manager)

// Auftrags-Statistik (gebuchte Netto-Stunden je Nutzer) lazy in einen Container laden.
async function loadProjStats(id, container) {
  if (!container) return;
  container.innerHTML = '<div class="proj-meta">Lädt…</div>';
  try {
    const data = await api('GET', '/api/projects/' + id + '/stats');
    if (!data) return;
    const rows = data.per_user || [];
    if (!rows.length) { container.innerHTML = '<div class="proj-meta">Noch keine Stunden gebucht.</div>'; return; }
    container.innerHTML = '<table class="proj-stats-table"><tbody>'
      + rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmtH(r.hours)} h</td><td class="num muted">${r.entries}×</td></tr>`).join('')
      + `<tr class="total"><td>Gesamt</td><td class="num">${fmtH(data.total_hours)} h</td><td class="num muted">${data.total_entries}×</td></tr>`
      + '</tbody></table>'
      + `<button type="button" class="btn btn-sm btn-outline proj-csv-btn" data-id="${id}">&#11015; CSV-Export</button>`;
    const csvBtn = container.querySelector('.proj-csv-btn');
    if (csvBtn) csvBtn.addEventListener('click', (e) => { e.stopPropagation(); exportProjectCsv(id); });
  } catch (e) { container.innerHTML = '<div class="proj-meta">Fehler beim Laden.</div>'; }
}

// CSV-Download aller Einzeleinträge eines Auftrags (server-generiert, wie der Audit-Export).
async function exportProjectCsv(id) {
  try {
    const res = await fetch('/api/projects/' + id + '/entries.csv', { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) { toast('Export fehlgeschlagen', 'error'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || ('projekt-' + id + '.csv');
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('Export fehlgeschlagen', 'error'); }
}

// Zwischenziel-Status → Label + Farbe; Reihenfolge für die 3-Farb-Auswahl
const MS_META = { offen: { label: 'offen', color: '#dc2626' }, doing: { label: 'in Arbeit', color: '#eab308' }, done: { label: 'erledigt', color: '#16a34a' } };
const MS_ORDER = ['offen', 'doing', 'done'];
// Dauer robust als Zahl (Komma ODER Punkt); ungültig → 0.
const msDays = (v) => { const d = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(d) && d >= 0 ? d : 0; };
// Fortschritt nach Dauer gewichtet (Ziel ohne Dauer zählt als 1 Tag)
function projectProgress(ms) {
  const w = m => (msDays(m.est_days) > 0 ? msDays(m.est_days) : 1);
  const tot = ms.reduce((s, m) => s + w(m), 0) || 1;
  const sum = st => ms.filter(m => m.status === st).reduce((s, m) => s + w(m), 0);
  return { done: sum('done') / tot * 100, doing: sum('doing') / tot * 100, offen: sum('offen') / tot * 100 };
}
const msBar = (prog, cls, goalPct, fillPct) => {
  const f = (fillPct == null ? 100 : fillPct) / 100;
  const buffer = (goalPct != null && fillPct != null && goalPct > fillPct) ? (goalPct - fillPct) : 0;
  return `<div class="ms-bar ${cls || ''}">`
    + `<span style="width:${prog.done * f}%;background:${MS_META.done.color}"></span>`
    + `<span style="width:${prog.doing * f}%;background:${MS_META.doing.color}"></span>`
    + `<span style="width:${prog.offen * f}%;background:${MS_META.offen.color}"></span>`
    + (buffer > 0 ? `<span class="ms-buffer" style="width:${buffer}%" title="Luft bis zur Frist"></span>` : '')
    + (goalPct != null ? `<span class="ms-goal" style="left:${Math.max(0, Math.min(100, goalPct))}%" title="Frist"></span>` : '')
    + '</div>';
};

// Fälligkeit + Zeitbudget. Restaufwand = Σ Tage der NICHT erledigten Ziele (offen + in Arbeit; erledigte raus).
const SCHED = { rot: '#dc2626', orange: '#ea580c', gruen: '#16a34a', neutral: '#6b7280', luft: '#93c5fd' };
const todayISO = () => formatDateISO(new Date());
// Arbeitstag = Mo–Fr und kein Feiertag. holidaySet = Set von ISO-Tagen (globale Feiertage).
const isWorkday = (d, holidaySet) => { const wd = d.getDay(); return wd !== 0 && wd !== 6 && !(holidaySet && holidaySet.has(formatDateISO(d))); };
// Arbeitstage NACH heute bis einschließlich due; negativ = überfällig (Arbeitstage nach due bis heute).
// Sa/So und Feiertage zählen nicht — konsistent mit den Zwischenziel-Dauern (est_days = Arbeitstage).
function workdaysUntil(dueISO, holidaySet) {
  const today = todayISO();
  if (dueISO === today) return 0;
  const past = dueISO < today;
  const start = new Date((past ? dueISO : today) + 'T00:00:00');
  const end = new Date((past ? today : dueISO) + 'T00:00:00');
  let count = 0;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + 1); // ab dem Tag nach 'start'
  while (cur <= end) { if (isWorkday(cur, holidaySet)) count++; cur.setDate(cur.getDate() + 1); }
  return past ? -count : count;
}
const msRemainingDays = (ms) => ms.filter(m => m.status !== 'done').reduce((s, m) => s + (msDays(m.est_days) > 0 ? msDays(m.est_days) : 1), 0);
// Liefert Fälligkeits-Infos für eine Kachel (oder null, wenn kein Datum). available in ARBEITSTAGEN.
function scheduleInfo(p, showDone, holidaySet) {
  if (!p.due_date) return null;
  const available = workdaysUntil(p.due_date, holidaySet);
  const label = available < 0 ? `${-available} ${-available === 1 ? 'Arbeitstag' : 'Arbeitstage'} überfällig`
    : available === 0 ? 'heute fällig' : `noch ${available} ${available === 1 ? 'Arbeitstag' : 'Arbeitstage'}`;
  const ms = p.milestones || [];
  const hasSchedule = !showDone && !p.done && ms.length > 0;
  let color = SCHED.neutral, goalPct = null, fillPct = null, remaining = 0, delta = 0;
  if (hasSchedule) {
    remaining = msRemainingDays(ms);
    const ratio = remaining / Math.max(available, 0.5);
    color = (available <= 0 || ratio >= 1) ? SCHED.rot : (ratio >= 0.85 ? SCHED.orange : SCHED.gruen);
    const w = m => (msDays(m.est_days) > 0 ? msDays(m.est_days) : 1);
    const doneDays = ms.filter(m => m.status === 'done').reduce((s, m) => s + w(m), 0);
    const totalDays = ms.reduce((s, m) => s + w(m), 0) || 1;
    // Skala = Restaufwand-Ende ODER Frist (der Größere). Bei Puffer wird der Arbeitsbalken kürzer, die Frist
    // rückt nach rechts → dazwischen die „Luft". Arbeitsbalken bleibt min. 40 % breit (extreme Puffer nicht winzig).
    const deadlinePos = doneDays + Math.max(available, 0);
    let scaleMax = Math.min(Math.max(totalDays, deadlinePos, 1), totalDays / 0.4);
    fillPct = Math.min(100, totalDays / scaleMax * 100);
    goalPct = Math.min(100, deadlinePos / scaleMax * 100);
    delta = remaining - available; // >0 = Frist gerissen (T über); <0 = T Luft
  } else {
    color = available < 0 ? SCHED.rot : (available <= 3 ? SCHED.orange : SCHED.neutral);
  }
  return { available, label, color, hasSchedule, remaining, delta, goalPct, fillPct };
}

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

  // Feiertage im relevanten Bereich laden (für die Arbeitstag-Berechnung der Fälligkeit) — nur wenn Fristen da sind.
  const holidaySet = new Set();
  const dueDates = projects.filter(p => p.due_date).map(p => p.due_date);
  if (dueDates.length) {
    const today = todayISO();
    const lo = dueDates.reduce((m, d) => d < m ? d : m, today);
    const hi = dueDates.reduce((m, d) => d > m ? d : m, today);
    try {
      const fData = await api('GET', `/api/absences?type=feiertag&from=${lo}&to=${hi}`);
      for (const a of ((fData && fData.absences) || [])) {
        for (const c = new Date(a.date_from + 'T00:00:00'), e = new Date((a.date_to || a.date_from) + 'T00:00:00'); c <= e; c.setDate(c.getDate() + 1)) holidaySet.add(formatDateISO(c));
      }
    } catch (_) { /* Feiertage optional — ohne sie zählen nur Sa/So nicht */ }
  }

  // Gruppieren: unter jedem zugewiesenen User; ohne Zuweisung → „Nicht zugewiesen"
  const byUser = {}; const unassigned = [];
  for (const p of projects) {
    if (!p.assigned_users || !p.assigned_users.length) unassigned.push(p);
    else for (const u of p.assigned_users) (byUser[u.user_id] || (byUser[u.user_id] = [])).push(p);
  }
  // Basis-Spalten: immer alle aktiven Mitarbeiter. Chef/Buchhalter (Nicht-MA) erscheinen wie in der Planung
  // NUR, wenn ihnen wirklich ein Auftrag zugewiesen ist (über die „extra zugewiesene"-Ergänzung unten).
  const cols = _boardUsers.filter(u => u.role === 'mitarbeiter' && u.active !== 0).map(u => ({ id: u.id, name: u.name }));
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
  const myId = S.user && S.user.id;
  const tileHtml = (p) => {
    const u = projUrg(p.urgency);
    const ms = p.milestones || [];
    const prog = ms.length ? projectProgress(ms) : null;
    const sched = scheduleInfo(p, showDone, holidaySet);
    const goal = sched && sched.hasSchedule ? sched.goalPct : null;
    const fill = sched && sched.hasSchedule ? sched.fillPct : null;
    const dT = (n) => String(Math.round(n * 10) / 10).replace('.', ',') + ' AT';
    // Status ändern dürfen Zugeteilte + Chef/Admin
    const canMs = manage || (p.assigned_users || []).some(x => x.user_id === myId);
    const expanded = _expandedProjects.has(String(p.id));
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
    const msList = ms.map(m => {
      const meta = MS_META[m.status] || MS_META.offen;
      const ctrl = canMs
        ? `<span class="ms-picker">${MS_ORDER.map(s => `<button type="button" class="ms-opt${m.status === s ? ' active' : ''}" data-id="${p.id}" data-mid="${m.id}" data-status="${s}" style="background:${MS_META[s].color}" title="${MS_META[s].label}"></button>`).join('')}</span>`
        : `<span class="ms-dot" style="background:${meta.color}" title="${meta.label}"></span>`;
      return `<div class="ms-row">${ctrl}<span class="ms-title">${esc(m.title)}</span><span class="ms-days" title="Arbeitstage">${String(m.est_days).replace('.', ',')} AT</span></div>`;
    }).join('');
    return `<div class="proj-tile${showDone ? ' proj-tile-done' : ''}${expanded ? ' expanded' : ''}" data-id="${p.id}" style="border-left:5px solid ${u.color}">
      <div class="proj-tile-top"><span class="proj-name">${esc(p.name)}</span>${flag}</div>
      ${p.client ? `<div class="proj-client">${esc(p.client)}</div>` : ''}
      ${sched ? `<div class="proj-due" style="color:${sched.color}">&#128197; ${sched.label}</div>` : ''}
      ${prog ? msBar(prog, 'ms-bar-slim', goal, fill) : ''}
      <div class="proj-detail" style="display:${expanded ? 'block' : 'none'}">
        ${p.note ? `<p class="proj-note">${esc(p.note)}</p>` : ''}
        ${p.address ? `<div class="proj-addr">&#128205; ${esc(p.address)} <button class="btn btn-xs proj-nav" data-addr="${esc(p.address)}" title="Navigieren">&#128506;</button></div>` : ''}
        <div class="proj-meta">Dringlichkeit: ${u.label} · erstellt ${formatDateTimeDE(p.created_at)}${showDone && p.done_at ? ' · erledigt ' + formatDateTimeDE(p.done_at) : ''}</div>
        <div class="proj-meta">Für: ${(p.assigned_users && p.assigned_users.length) ? p.assigned_users.map(x => esc(x.name)).join(', ') : '– (nicht zugewiesen)'}</div>
        ${sched ? `<div class="proj-meta" style="color:${sched.color}">&#128197; Fällig bis ${formatDateDE(p.due_date)} · ${sched.label}${sched.hasSchedule ? ` · Restaufwand ${dT(sched.remaining)} · ${sched.delta > 0 ? dT(sched.delta) + ' über Frist' : (sched.delta < 0 ? dT(-sched.delta) + ' Luft' : 'punktgenau')}` : ''}</div>` : ''}
        ${ms.length ? `<div class="ms-list">${msList}</div>${msBar(prog, null, goal, fill)}<div class="proj-meta">${Math.round(prog.done)}% fertig · ${Math.round(prog.doing)}% in Arbeit · ${Math.round(prog.offen)}% offen</div>` : ''}
        ${canViewAll() ? `<button type="button" class="proj-stats-btn" data-id="${p.id}">&#128202; Statistik ${_statsOpen.has(String(p.id)) ? '&#9652;' : '&#9662;'}</button><div class="proj-stats" data-id="${p.id}"></div>` : ''}
        <div class="proj-actions">${actions}</div>
      </div>
    </div>`;
  };

  const colsHtml = columns.map(c => `
    <div class="board-col">
      <div class="board-col-head">${c.id ? avatarHtml({ id: c.id, name: c.name }, 20) + ' ' : ''}${esc(c.name)}${c.list.length ? ` <span class="board-count">${c.list.length}</span>` : ''}</div>
      <div class="board-col-body">${c.list.map(tileHtml).join('') || '<div class="board-empty">–</div>'}</div>
    </div>`).join('');

  // Farb-Legende — getrennt für Dringlichkeit (Flagge/Ampel) und Fortschritt (Ziele/Balken),
  // da dieselben Farben je Kontext etwas anderes bedeuten.
  const legDot = (color) => `<span class="legend-dot" style="background:${color}"></span>`;
  const legItem = (color, label) => `<span class="legend-item">${legDot(color)}${label}</span>`;
  const legendHtml = `
    <div class="board-legend">
      <span class="legend-group"><span class="legend-label">Dringlichkeit:</span> ${PROJECT_URGENCY.map(u => legItem(u.color, u.label)).join('')}</span>
      <span class="legend-group"><span class="legend-label">Fortschritt:</span> ${['done', 'doing', 'offen'].map(k => legItem(MS_META[k].color, MS_META[k].label)).join('')}</span>
      <span class="legend-group"><span class="legend-label" title="Berechnet in Arbeitstagen – Sa/So und Feiertage zählen nicht">Termin (Arbeitstage):</span> ${legItem(SCHED.gruen, 'in der Zeit')}${legItem(SCHED.orange, 'wird knapp')}${legItem(SCHED.rot, 'zu spät')}${legItem(SCHED.luft, 'Luft bis Frist')}</span>
    </div>`;

  const mainEl = document.querySelector('.main');
  mainEl.classList.add('main-wide'); // Board volle Bildschirmbreite (wie Planung/Zeitnachweis)
  mainEl.innerHTML = `
    <div class="board-wrap">
      <div class="board-head">
        <h2>${showDone ? 'Erledigte Aufträge' : 'Projekte / Aufträge'}</h2>
        ${manage ? `<button class="btn btn-sm btn-outline" id="board-archive-toggle">${showDone ? '← Offene Aufträge' : 'Erledigte anzeigen'}</button>` : ''}
      </div>
      ${legendHtml}
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
      if (!det) return;
      const open = det.style.display === 'none';
      det.style.display = open ? 'block' : 'none';
      tile.classList.toggle('expanded', open);
      if (open) _expandedProjects.add(String(tile.dataset.id)); else _expandedProjects.delete(String(tile.dataset.id));
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
  // Statistik-Reiter (Manager): auf-/zuklappen + lazy laden; offene nach Re-Render neu befüllen
  mainEl.querySelectorAll('.proj-stats-btn').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = String(b.dataset.id);
    const cont = b.parentElement.querySelector(`.proj-stats[data-id="${id}"]`);
    if (_statsOpen.has(id)) { _statsOpen.delete(id); if (cont) cont.innerHTML = ''; b.innerHTML = '\u{1F4CA} Statistik ▾'; }
    else { _statsOpen.add(id); b.innerHTML = '\u{1F4CA} Statistik ▴'; loadProjStats(id, cont); }
  }));
  mainEl.querySelectorAll('.proj-stats').forEach(c => { if (_statsOpen.has(String(c.dataset.id))) loadProjStats(c.dataset.id, c); });
  // Zwischenziel-Status setzen (Zugeteilte + Chef/Admin) — Kachel bleibt via _expandedProjects offen
  mainEl.querySelectorAll('.ms-opt').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api('PATCH', '/api/projects/' + b.dataset.id + '/milestones/' + b.dataset.mid + '/status', { status: b.dataset.status }); renderProjects(); } catch (err) { toast(err.message, 'error'); }
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
    if (!(await confirmModal('Projekt in den Papierkorb verschieben? Es lässt sich von dort (Chef/Admin) wiederherstellen.', { title: 'In den Papierkorb', okLabel: 'Löschen' }))) return;
    try { await api('DELETE', '/api/projects/' + pid(b)); toast('In den Papierkorb verschoben', 'success'); renderProjects(); } catch (err) { toast(err.message, 'error'); }
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
    <div class="card" id="projekt-form" style="max-width:700px;margin:0 auto;">
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
      <div class="form-group"><label>Fällig bis (optional)</label>
        <input type="date" class="form-control" id="pf2-due" value="${esc(p.due_date || '')}"></div>
      <div class="form-group"><label>Zugedachte Mitarbeiter</label>
        <div class="planning-user-checkboxes">${workers.map(u => `<label><input type="checkbox" class="pf2-assignee" value="${u.id}" ${assignedIds.has(u.id) ? 'checked' : ''}> ${esc(u.name)}${u.role !== 'mitarbeiter' ? ` <span class="push-hint">(${esc(roleName(u.role))})</span>` : ''}</label>`).join('') || '<span class="push-hint">Keine Nutzer vorhanden</span>'}</div></div>
      <div class="form-group"><label>Zwischenziele (für den Fortschrittsbalken)</label>
        <div id="pf2-ms-list"></div>
        <button type="button" class="btn btn-outline btn-sm" id="pf2-ms-add" style="margin-top:0.4rem">+ Zwischenziel</button>
      </div>
      <button class="btn btn-primary btn-block" id="pf2-save">${isEdit ? 'Speichern' : 'Projekt erstellen'}</button>
    </div>`;

  // Zwischenziel-Editor (dynamische Zeilen; msRows ist die Wahrheit, Inputs syncen live)
  const msRows = (p.milestones || []).map(m => ({ id: m.id, title: m.title, est_days: m.est_days }));
  const msListEl = document.getElementById('pf2-ms-list');
  const renderMsRows = () => {
    msListEl.innerHTML = msRows.map((r, i) => `<div class="ms-edit-row" data-idx="${i}">
      <input class="form-control ms-edit-title" data-idx="${i}" value="${esc(r.title || '')}" placeholder="z.B. Kabel verlegen">
      <input type="text" inputmode="decimal" class="form-control ms-edit-days" data-idx="${i}" value="${r.est_days != null ? String(r.est_days).replace('.', ',') : '1'}" placeholder="z.B. 1,5">
      <span class="ms-edit-unit" title="Arbeitstage (Sa/So & Feiertage zählen nicht)">Arbeitstage</span>
      <button type="button" class="btn btn-sm btn-danger ms-edit-del" data-idx="${i}" title="Entfernen">&times;</button>
    </div>`).join('') || '<div class="push-hint">Noch keine Zwischenziele – mit „+ Zwischenziel" hinzufügen.</div>';
  };
  renderMsRows();
  msListEl.addEventListener('input', (e) => {
    const idx = Number(e.target.dataset.idx); if (!msRows[idx]) return;
    if (e.target.classList.contains('ms-edit-title')) msRows[idx].title = e.target.value;
    else if (e.target.classList.contains('ms-edit-days')) msRows[idx].est_days = e.target.value;
  });
  msListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.ms-edit-del'); if (!btn) return;
    msRows.splice(Number(btn.dataset.idx), 1); renderMsRows();
  });
  document.getElementById('pf2-ms-add').addEventListener('click', () => {
    msRows.push({ title: '', est_days: 1 }); renderMsRows();
    const inputs = msListEl.querySelectorAll('.ms-edit-title'); if (inputs.length) inputs[inputs.length - 1].focus();
  });

  // Entwurfs-Sicherung (B4): Zwischenziele (msRows) und die Haken der Zuweisung haben keine
  // eigene Kennung — beides ueber den Zusatz-Haken mitnehmen.
  const entwurfName = 'projekt:' + (isEdit ? project.id : 'neu');
  initDraftKeeper(document.getElementById('projekt-form'), entwurfName, {
    zusatzLesen: () => ({
      ziele: msRows.map(r => ({ id: r.id, title: r.title, est_days: r.est_days })),
      zugewiesen: [...document.querySelectorAll('.pf2-assignee:checked')].map(cb => cb.value),
    }),
    zusatzSchreiben: z => {
      if (Array.isArray(z.ziele)) { msRows.length = 0; z.ziele.forEach(r => msRows.push(r)); renderMsRows(); }
      if (Array.isArray(z.zugewiesen)) {
        document.querySelectorAll('.pf2-assignee').forEach(cb => { cb.checked = z.zugewiesen.includes(cb.value); });
      }
    },
  });

  document.getElementById('pf2-back').addEventListener('click', () => renderProjects());
  document.getElementById('pf2-nav').addEventListener('click', () => { const a = document.getElementById('pf2-address').value.trim(); if (a) openNav(a, { force: true }); else toast('Keine Adresse eingetragen', 'error'); });
  document.getElementById('pf2-save').addEventListener('click', async () => {
    // Zwischenziele: Dauer als Komma ODER Punkt akzeptieren; ungültige Zahl → Abbruch mit Hinweis.
    const msParsed = msRows.filter(r => (r.title || '').trim()).map(r => ({ id: r.id, title: r.title.trim(), est_days: parseFloat(String(r.est_days).replace(',', '.')) }));
    const badMs = msParsed.find(m => !(m.est_days >= 0));
    if (badMs) { toast(`Ungültige Dauer bei „${badMs.title}" – bitte eine Zahl ≥ 0 eingeben (z. B. 1,5).`, 'error'); return; }
    const body = {
      name: document.getElementById('pf2-name').value.trim(),
      client: document.getElementById('pf2-client').value.trim(),
      address: document.getElementById('pf2-address').value.trim(),
      note: document.getElementById('pf2-note').value.trim(),
      urgency: document.getElementById('pf2-urgency').value,
      due_date: document.getElementById('pf2-due').value || null,
      assigned_user_ids: [...document.querySelectorAll('.pf2-assignee:checked')].map(cb => Number(cb.value)),
      milestones: msParsed,
    };
    if (!body.name) { toast('Projektname ist erforderlich', 'error'); return; }
    try {
      if (isEdit) await api('PUT', '/api/projects/' + project.id, body);
      else await api('POST', '/api/projects', body);
      toast('Gespeichert', 'success');
      entwurfLoeschen(entwurfName);
      renderProjects();
    } catch (err) { toast(err.message, 'error'); }
  });
}


// ── „Mein Konto" ───────────────────────────────────────────────────────────────────────────────
// Die erste persönliche Seite der App. Bis hierher konnte ein Mitarbeiter weder sein Passwort
// ändern noch irgendetwas an seinem Konto einstellen — beides ging nur über Chef oder Admin.
//
// Ist die Zwei-Faktor-Einrichtung fällig, ist das hier die EINZIGE erreichbare Seite (Router in
// app-1-core.js, serverseitig abgesichert in middleware/auth.js).
async function renderKonto() {
  const faellig = !!(S.zweiFaktor && S.zweiFaktor.einrichtung_noetig);
  $app().innerHTML = layout(`
    <div class="welcome-page">
      <div class="welcome-header"><h1>&#128100; Mein Konto</h1></div>
      ${faellig ? `<div class="warning-box" style="margin-bottom:1rem">
        <strong>Zwei-Faktor-Anmeldung einrichten</strong><br>
        Für deine Rolle ist ein zweiter Faktor vorgeschrieben. Bis du ihn eingerichtet hast, kommst
        du nicht in die App.
      </div>` : ''}
      <div class="welcome-section" id="konto-avatar"></div>
      <div class="welcome-section" id="konto-geburtstag"></div>
      <div class="welcome-section" id="konto-warnungen"></div>
      <div class="welcome-section" id="konto-2fa"><div class="loading"><div class="spinner"></div></div></div>
      <div class="welcome-section" id="konto-passwort"></div>
      <div class="welcome-section" id="konto-geraete" style="display:none"></div>
      <div class="welcome-section" id="push-card"><div class="loading"><div class="spinner"></div></div></div>
      <div class="welcome-section" id="konto-stammdaten"></div>
      ${canViewAll() ? '' : '<div class="welcome-section" id="konto-pdf"></div>'}
      <div class="welcome-section" id="konto-sicherheit"></div>
    </div>`, 'konto');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';
  await kontoAvatarKarte();
  await kontoGeburtstagKarte();
  await kontoWarnungenKarte();
  kontoPasswortKarte();
  await kontoZweiFaktorKarte();
  // Benachrichtigungen: dieselbe Karte wie bisher, nur an einem anderen Ort. initPushCard() baut
  // sie in #push-card — die Einstellungen jedes Nutzers bleiben unberuehrt, es wird nichts
  // zurueckgesetzt und nichts neu gefragt.
  // initPushCard() baut den Digest-Abschnitt selbst mit auf (nur wenn ein Abo aktiv ist) —
  // ein zusaetzlicher Aufruf waere doppelt und kaeme zu frueh.
  initPushCard();
  await kontoStammdatenKarte();
  await kontoPdfKarte();
  kontoSicherheitKarte();
}

// Der Zeitnachweis als PDF — NUR fuer Mitarbeiter. Fuer sie ist das eine rein persoenliche Sache
// (die eigenen Zeiten, kein fremder Datensatz), deshalb steht sie hier statt in einem eigenen
// Menuepunkt. Chef, Admin und Buchhaltung finden dasselbe Formular unter „Abrechnung" — dort
// zusammen mit Lohn-CSV und Abschluss, was auf einer persoenlichen Seite nichts zu suchen haette.
async function kontoPdfKarte() {
  const k = document.getElementById('konto-pdf');
  if (!k) return;                      // Rolle mit Abrechnungs-Zugriff: Karte gibt es hier nicht
  // Das Formular filtert nach Projekt — ohne diese Liste stuende dort nur „Alle Projekte".
  try { const d = await api('GET', '/api/projects'); if (d) S.projects = d.projects; } catch (_) {}
  k.innerHTML = `
    <h3>&#128196; Zeitnachweis als PDF</h3>
    <p style="margin:0 0 .8rem">Deine erfassten Zeiten als PDF — für die Ablage oder zum Ausdrucken.</p>
    ${pdfFormularHtml({ mitMitarbeiterwahl: false })}`;
  pdfFormularBinden();
}

// ================================================================
// Zuschnitt-Fenster fuers Profilbild
// ================================================================
// Vorher hat die App geraten (`sharp` mit `position: attention` — Luminanz, Saettigung,
// Hauttoene; KEINE Gesichtserkennung). Das trifft ein Portrait meistens, aber bei einem
// Gruppenfoto oder jemandem am Bildrand eben nicht, und der Nutzer konnte nichts dagegen tun.
//
// Bedient wird nicht der Rahmen, sondern das BILD: Der Kreis steht fest, das Foto wird darunter
// geschoben und gezoomt. Am Handy ist das die vertraute Geste (schieben, mit zwei Fingern
// aufziehen), und der Rahmen kann nie aus dem Bild laufen.
//
// Gerechnet wird in Bildpunkten des ORIGINALS, nicht in Bildschirmpunkten: `mx`/`my` ist der
// Punkt des Fotos, der in der Mitte des Kreises steht. Damit ist das Ergebnis unabhaengig davon,
// wie gross das Fenster gerade ist — und genau diese Zahlen gehen an den Server.
//
// @param {{datei?: File, url?: string}} quelle
// @returns {Promise<null | {links:number, oben:number, breite:number, hoehe:number, bildBreite:number, bildHoehe:number}>}
function avatarZuschnittDialog(quelle) {
  return new Promise((resolve) => {
    const objektUrl = quelle.datei ? URL.createObjectURL(quelle.datei) : null;
    const quellUrl = objektUrl || quelle.url;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog-modal';
    overlay.innerHTML = `
      <div class="modal zuschnitt-modal">
        <div class="modal-header"><h3>Ausschnitt wählen</h3></div>
        <div class="modal-body">
          <p class="zuschnitt-hinweis">Bild verschieben, mit zwei Fingern oder dem Regler zoomen.
             Was im Kreis steht, wird dein Profilbild.</p>
          <div class="zuschnitt-buehne" id="zs-buehne">
            <img id="zs-bild" alt="" draggable="false">
            <div class="zuschnitt-maske"></div>
          </div>
          <div class="zuschnitt-regler">
            <span aria-hidden="true">&#128269;</span>
            <input type="range" id="zs-zoom" min="100" max="400" value="100" step="1"
                   aria-label="Vergrößerung">
          </div>
          <div class="zuschnitt-vorschau-zeile">
            <span class="zuschnitt-vorschau" id="zs-vorschau-gross" aria-hidden="true"></span>
            <span class="zuschnitt-vorschau klein" id="zs-vorschau-klein" aria-hidden="true"></span>
            <span class="zuschnitt-vorschau-text">So sieht es aus — groß auf dieser Seite,
              klein in Listen und Spalten.</span>
          </div>
        </div>
        <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
          <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
          <button class="btn btn-primary" data-act="ok" id="zs-ok" disabled>Übernehmen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const aufraeumen = dialogBarrierefrei(overlay);

    const buehne = overlay.querySelector('#zs-buehne');
    const bild = overlay.querySelector('#zs-bild');
    const regler = overlay.querySelector('#zs-zoom');
    const vorschauGross = overlay.querySelector('#zs-vorschau-gross');
    const vorschauKlein = overlay.querySelector('#zs-vorschau-klein');

    let natB = 0, natH = 0;      // Masse des Fotos, wie der Browser es sieht (EXIF beruecksichtigt)
    let mx = 0, my = 0;          // Punkt des Fotos in der Mitte des Kreises
    let zoom = 1;
    const kante = () => buehne.clientWidth || 1;
    const basis = () => kante() / Math.min(natB, natH);   // Zoom 1 = kuerzere Seite fuellt den Kreis
    const seite = () => kante() / (basis() * zoom);       // Fenstergroesse in Bildpunkten

    function begrenzen() {
      const h = seite() / 2;
      mx = Math.max(h, Math.min(mx, natB - h));
      my = Math.max(h, Math.min(my, natH - h));
    }
    function zeichnen() {
      if (!natB) return;
      begrenzen();
      const s = basis() * zoom;
      bild.style.width = (natB * s) + 'px';
      bild.style.height = (natH * s) + 'px';
      bild.style.left = (kante() / 2 - mx * s) + 'px';
      bild.style.top = (kante() / 2 - my * s) + 'px';
      // Die Vorschauen zeigen denselben Ausschnitt — als Hintergrundbild, damit sie unabhaengig
      // von der Buehnengroesse stimmen.
      for (const [el, px] of [[vorschauGross, 84], [vorschauKlein, 30]]) {
        const f = px / seite();
        el.style.backgroundImage = `url("${quellUrl}")`;
        el.style.backgroundSize = `${natB * f}px ${natH * f}px`;
        el.style.backgroundPosition = `${-(mx - seite() / 2) * f}px ${-(my - seite() / 2) * f}px`;
      }
    }

    bild.onload = () => {
      natB = bild.naturalWidth; natH = bild.naturalHeight;
      mx = natB / 2; my = natH / 2; zoom = 1;
      regler.value = '100';
      overlay.querySelector('#zs-ok').disabled = false;
      zeichnen();
    };
    bild.onerror = () => { fertig(null); toast('Das Bild konnte nicht geladen werden.', 'error'); };
    bild.src = quellUrl;

    // --- Schieben und Zoomen -------------------------------------------------
    const zeiger = new Map();
    let letzteMitte = null, letzterAbstand = 0;
    buehne.addEventListener('pointerdown', (e) => {
      // In try/catch: Bei einem synthetischen Zeiger (Test, Hilfstechnik) kennt der Browser die
      // Kennung nicht und wirft — das darf das Schieben nicht verhindern.
      try { buehne.setPointerCapture(e.pointerId); } catch (_) {}
      zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });
      letzteMitte = null; letzterAbstand = 0;
      e.preventDefault();
    });
    buehne.addEventListener('pointermove', (e) => {
      if (!zeiger.has(e.pointerId) || !natB) return;
      zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const punkte = [...zeiger.values()];
      const s = basis() * zoom;
      if (punkte.length === 1) {
        const p = punkte[0];
        if (letzteMitte) { mx -= (p.x - letzteMitte.x) / s; my -= (p.y - letzteMitte.y) / s; }
        letzteMitte = { x: p.x, y: p.y };
      } else {
        // Zwei Finger: Abstand steuert den Zoom, die Mitte zwischen ihnen das Schieben.
        const [a, b] = punkte;
        const abstand = Math.hypot(a.x - b.x, a.y - b.y);
        const mitte = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (letzterAbstand > 0 && abstand > 0) zoomSetzen(zoom * (abstand / letzterAbstand));
        if (letzteMitte) { const s2 = basis() * zoom; mx -= (mitte.x - letzteMitte.x) / s2; my -= (mitte.y - letzteMitte.y) / s2; }
        letzterAbstand = abstand; letzteMitte = mitte;
      }
      zeichnen();
      e.preventDefault();
    });
    const loslassen = (e) => {
      zeiger.delete(e.pointerId);
      if (zeiger.size < 2) letzterAbstand = 0;
      if (zeiger.size === 0) letzteMitte = null;
      else letzteMitte = null;   // beim Wechsel der Fingerzahl neu ansetzen, sonst springt es
    };
    buehne.addEventListener('pointerup', loslassen);
    buehne.addEventListener('pointercancel', loslassen);
    buehne.addEventListener('wheel', (e) => {
      if (!natB) return;
      zoomSetzen(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      zeichnen();
      e.preventDefault();
    }, { passive: false });

    function zoomSetzen(z) {
      zoom = Math.max(1, Math.min(4, z));
      regler.value = String(Math.round(zoom * 100));
    }
    regler.addEventListener('input', () => { zoomSetzen(Number(regler.value) / 100); zeichnen(); });
    window.addEventListener('resize', zeichnen);

    // --- Schliessen ----------------------------------------------------------
    function fertig(wert) {
      window.removeEventListener('resize', zeichnen);
      document.removeEventListener('keydown', beiTaste);
      overlay.remove(); aufraeumen();
      if (objektUrl) URL.revokeObjectURL(objektUrl);
      resolve(wert);
    }
    const beiTaste = (e) => { if (e.key === 'Escape') fertig(null); };
    document.addEventListener('keydown', beiTaste);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fertig(null); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => fertig(null));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => {
      if (!natB) return fertig(null);
      begrenzen();
      const sw = seite();
      fertig({
        links: Math.round(mx - sw / 2), oben: Math.round(my - sw / 2),
        breite: Math.round(sw), hoehe: Math.round(sw),
        bildBreite: natB, bildHoehe: natH,
      });
    });
  });
}

async function kontoAvatarKarte() {
  const k = document.getElementById('konto-avatar');
  if (!k) return;
  await avatarStandLaden();
  const hatBild = !!(S.avatarStand || {})[S.user.id];
  k.innerHTML = `
    <h3>&#128100; Profilbild</h3>
    <div style="display:flex; gap:1rem; align-items:center; flex-wrap:wrap">
      <span id="avatar-vorschau">${avatarHtml(S.user, 96, 'initialen')}</span>
      <div style="flex:1; min-width:200px">
        <p style="margin:0 0 .5rem">Erscheint neben deinem Namen und in den Spalten von Planung,
           Zeitnachweis und Auftrags-Board. <strong>Ohne Bild bleibt dort alles wie bisher</strong> —
           du musst also keines hochladen.</p>
        <input type="file" id="avatar-datei" accept="image/*" style="display:none">
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" id="avatar-waehlen">${hatBild ? 'Anderes Bild wählen' : 'Bild hochladen'}</button>
          ${hatBild ? '<button class="btn btn-outline btn-sm" id="avatar-ausschnitt">Ausschnitt ändern</button>' : ''}
          ${hatBild ? '<button class="btn btn-outline btn-sm" id="avatar-weg">Entfernen</button>' : ''}
        </div>
        <div style="font-size:.78rem;color:var(--text-light);margin-top:.4rem">
          Du wählst selbst, welcher Ausschnitt in den Kreis kommt — und kannst das später jederzeit
          ändern, ohne das Foto noch einmal herauszusuchen. Nur angemeldete Kolleginnen und Kollegen
          sehen es, entfernen kannst du es immer.
        </div>
      </div>
    </div>`;
  // Das Bild in der Vorschau nachladen (falls schon eines da ist).
  avatareLaden(k);

  const datei = document.getElementById('avatar-datei');
  document.getElementById('avatar-waehlen').addEventListener('click', () => datei.click());
  datei.addEventListener('change', async () => {
    if (!datei.files || !datei.files[0]) return;
    const gewaehlt = datei.files[0];
    // Das Feld leeren, sonst loest dieselbe Datei beim naechsten Mal kein `change` aus.
    datei.value = '';
    const rechteck = await avatarZuschnittDialog({ datei: gewaehlt });
    if (!rechteck) return;                    // abgebrochen — nichts hochladen
    const fd = new FormData();
    fd.append('bild', gewaehlt);
    fd.append('zuschnitt', JSON.stringify(rechteck));
    try {
      await api('POST', '/api/avatare', fd, true);
      toast('Profilbild gespeichert', 'success');
      await kontoAvatarKarte();
      kopfzeileAvatarAktualisieren();
    } catch (err) { toast(err.message || 'Hochladen fehlgeschlagen', 'error'); }
  });

  // Ausschnitt aendern, ohne neues Foto: Das Original liegt auf dem Server.
  const ausschnitt = document.getElementById('avatar-ausschnitt');
  if (ausschnitt) ausschnitt.addEventListener('click', async () => {
    let url = null;
    try {
      // Mit Anmelde-Token holen — das Original liegt hinter der Anmeldung, ein blosses <img src>
      // koennte den Token nicht mitschicken.
      const antwort = await fetch('/api/avatare/original', { headers: { Authorization: 'Bearer ' + S.token } });
      if (!antwort.ok) throw new Error('Zu diesem Bild ist kein Original gespeichert. Bitte lade es einmal neu hoch.');
      url = URL.createObjectURL(await antwort.blob());
      const rechteck = await avatarZuschnittDialog({ url });
      if (!rechteck) return;
      await api('POST', '/api/avatare/zuschnitt', { zuschnitt: rechteck });
      toast('Ausschnitt gespeichert', 'success');
      await kontoAvatarKarte();
      kopfzeileAvatarAktualisieren();
    } catch (err) { toast(err.message || 'Ausschnitt konnte nicht geändert werden', 'error'); }
    finally { if (url) URL.revokeObjectURL(url); }
  });
  const weg = document.getElementById('avatar-weg');
  if (weg) weg.addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/avatare');
      toast('Profilbild entfernt', 'success');
      await kontoAvatarKarte();
      kopfzeileAvatarAktualisieren();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// Eigenes Geburtsdatum anzeigen — damit ein Zahlendreher demjenigen auffaellt, der ihn am besten
// erkennt. Dazu die Freigabe fuers Team, zweistufig.
async function kontoGeburtstagKarte() {
  const k = document.getElementById('konto-geburtstag');
  if (!k) return;
  let d;
  try { d = await api('GET', '/api/users/geburtstag-freigabe'); }
  catch (_) { k.style.display = 'none'; return; }

  const datum = d.geburtsdatum
    ? new Date(d.geburtsdatum + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
    : null;

  k.innerHTML = `
    <h3>&#127874; Geburtstag</h3>
    ${datum
      ? `<p>Die Verwaltung hat hinterlegt: <strong>${esc(datum)}</strong>.<br>
           <span style="color:var(--text-light);font-size:.85rem">Stimmt das nicht? Dann sag bitte
           im Büro Bescheid — das Datum steuert auch die gesetzlichen Pausenzeiten.</span></p>`
      : `<p>Es ist <strong>kein Geburtsdatum</strong> hinterlegt.
           <span style="color:var(--text-light);font-size:.85rem">Solange das so ist, rechnet die App
           bei den Pausen vorsichtshalber mit den strengeren Regeln für Jugendliche.</span></p>`}
    <hr style="margin:.85rem 0; border:none; border-top:1px solid var(--border)">
    <label style="display:flex; align-items:center; gap:.5rem; cursor:pointer">
      <input type="checkbox" id="geb-zeigen" style="width:auto"${d.zeigen ? ' checked' : ''}${datum ? '' : ' disabled'}>
      <span>Meinen Geburtstag im Team zeigen</span>
    </label>
    <label style="display:flex; align-items:center; gap:.5rem; cursor:pointer; margin-top:.4rem; margin-left:1.5rem">
      <input type="checkbox" id="geb-alter" style="width:auto"${d.alter_auch ? ' checked' : ''}${d.zeigen && datum ? '' : ' disabled'}>
      <span>… und auch mein Alter</span>
    </label>
    <div style="font-size:.78rem;color:var(--text-light);margin-top:.5rem">
      Ohne Freigabe sehen nur Chef, Admin und Buchhaltung deinen Geburtstag — die haben das Datum
      ohnehin in der Mitarbeiterverwaltung. Du kannst das jederzeit wieder zurücknehmen.
    </div>`;

  const zeigen = document.getElementById('geb-zeigen');
  const alter = document.getElementById('geb-alter');
  const speichern = async () => {
    // „Alter" ergibt ohne „Geburtstag" keinen Sinn — die Oberflaeche sperrt es, der Server raeumt
    // es zusaetzlich gerade (doppelt, damit kein widerspruechlicher Zustand entstehen kann).
    alter.disabled = !zeigen.checked;
    if (!zeigen.checked) alter.checked = false;
    try {
      await api('PUT', '/api/users/geburtstag-freigabe', { zeigen: zeigen.checked, alter_auch: alter.checked });
      toast('Gespeichert', 'success');
    } catch (err) {
      toast(err.message || 'Konnte nicht gespeichert werden', 'error');
      zeigen.checked = !zeigen.checked;   // zuruecknehmen, damit die Anzeige nicht luegt
    }
  };
  if (zeigen && !zeigen.disabled) zeigen.addEventListener('change', speichern);
  if (alter) alter.addEventListener('change', speichern);
}

// Gesetzliche Warnungen im Zeitnachweis ein- und ausblenden (Alex, 26.08.2026).
//
// Es ist eine Einstellung des BETRACHTERS: Wer die Pausen-Hinweise abschaltet, sieht sie nirgends
// mehr — auch nicht bei Kollegen. Niemand kann damit seine eigenen Verstoesse vor anderen
// verstecken, und niemandem wird von aussen etwas ausgeblendet.
//
// Gruppiert nach THEMA statt nach Gesetz: Nach Gesetz waere fuer einen Erwachsenen der
// Jugendschutz-Schalter tot und fuer einen Minderjaehrigen der ArbZG-Schalter. So wirkt jeder.
async function kontoWarnungenKarte() {
  const k = document.getElementById('konto-warnungen');
  if (!k) return;
  let d;
  try { d = await api('GET', '/api/users/warnungen'); }
  catch (_) { k.style.display = 'none'; return; }

  const schalter = [
    ['pausen', 'Zu kurze Pausen', '§ 4 ArbZG bzw. § 11 JArbSchG'],
    ['arbeitszeit', 'Zu lange Arbeitszeit (Tag und Woche)', '§ 3 ArbZG bzw. § 8 JArbSchG'],
    ['ruhezeit', 'Zu kurze Ruhezeit bis zum nächsten Tag', '§ 5 ArbZG bzw. § 13 JArbSchG'],
  ];
  k.innerHTML = `
    <h3>&#9888;&#65039; Gesetzliche Warnungen</h3>
    <p style="margin-top:0">In der Tages-, Wochen- und Monatsübersicht erscheint ein Warnzeichen,
      wenn ein Tag oder eine Woche über einer gesetzlichen Grenze liegt. Hier kannst du einzelne
      davon für dich ausblenden.</p>
    ${schalter.map(([key, titel, gesetz]) => `
      <label style="display:flex; align-items:flex-start; gap:.5rem; cursor:pointer; margin-top:.5rem">
        <input type="checkbox" class="warn-schalter" data-key="${key}" style="width:auto;margin-top:.25rem"${d[key] !== false ? ' checked' : ''}>
        <span>${esc(titel)}<br><span style="font-size:.78rem;color:var(--text-light)">${esc(gesetz)}</span></span>
      </label>`).join('')}
    <div style="font-size:.78rem;color:var(--text-light);margin-top:.7rem">
      Die Einstellung gilt nur für <strong>deine</strong> Ansicht — bei anderen bleiben die Hinweise
      sichtbar, und niemand blendet dir etwas aus. Sie betrifft nur die <strong>Übersichten</strong>:
      Beim Eintragen einer Zeit erscheint der Hinweis weiterhin, dort lässt er sich nicht
      abschalten. Ausblenden ändert nichts an den Zeiten und nichts an den gesetzlichen Pflichten
      des Betriebs; es nimmt nur das Zeichen weg.
    </div>`;

  const speichern = async () => {
    const werte = {};
    k.querySelectorAll('.warn-schalter').forEach(cb => { werte[cb.dataset.key] = cb.checked; });
    try {
      const neu = await api('PUT', '/api/users/warnungen', werte);
      // Sofort wirksam machen: sonst stimmte der Zeitnachweis erst nach dem naechsten Anmelden.
      S.warnungen = { pausen: neu.pausen !== false, arbeitszeit: neu.arbeitszeit !== false, ruhezeit: neu.ruhezeit !== false };
      toast('Gespeichert', 'success');
    } catch (err) {
      toast(err.message || 'Konnte nicht gespeichert werden', 'error');
    }
  };
  k.querySelectorAll('.warn-schalter').forEach(cb => cb.addEventListener('change', speichern));
}

// Eigene Stammdaten, nur lesend. „So hat die Verwaltung dich hinterlegt."
async function kontoStammdatenKarte() {
  const k = document.getElementById('konto-stammdaten');
  if (!k) return;
  let d;
  try { d = (await api('GET', '/api/users/meine-stammdaten')).stammdaten; }
  catch (_) { k.style.display = 'none'; return; }

  const datum = (t) => t ? new Date(t + 'T12:00:00').toLocaleDateString('de-DE') : null;
  const zeile = (bez, wert, hinweis) => wert === null || wert === undefined || wert === ''
    ? ''
    : `<tr><td style="padding:.3rem .75rem .3rem 0; color:var(--text-light); white-space:nowrap">${esc(bez)}</td>
           <td style="padding:.3rem 0"><strong>${esc(String(wert))}</strong>${hinweis ? ` <span style="color:var(--text-light);font-size:.8rem">${esc(hinweis)}</span>` : ''}</td></tr>`;

  const anstellung = (d.anstellung || []).map(a =>
    datum(a.start_date) + (a.end_date ? ' – ' + datum(a.end_date) : ' – heute')).join('<br>');

  const rechte = [
    d.rechte.planen_alle ? 'Planung für alle' : (d.rechte.planen ? 'eigene Planung' : null),
    d.rechte.schwarzes_brett ? 'Schwarzes Brett' : null,
    d.rechte.dateien_hochladen ? 'Dateien hochladen' : null,
  ].filter(Boolean).join(', ');

  k.innerHTML = `
    <h3>&#128203; Meine Daten</h3>
    <p style="color:var(--text-light); font-size:.85rem; margin-top:0">
      So hat die Verwaltung dich hinterlegt. Stimmt etwas nicht, sag im Büro Bescheid —
      ändern kann es nur Chef oder Admin.</p>
    <table style="border-collapse:collapse">
      ${zeile('Name', d.name)}
      ${zeile('Benutzername', d.benutzername)}
      ${zeile('Rolle', roleName(d.rolle))}
      ${zeile('Personalnummer', d.personalnummer)}
      ${zeile('Geburtsdatum', datum(d.geburtsdatum))}
      ${zeile('Soll-Stunden', d.soll_stunden_woche != null ? d.soll_stunden_woche + ' h/Woche' : null)}
      ${zeile('Arbeitsbeginn', d.arbeitsbeginn, '(sonst gilt der Firmenwert)')}
      ${zeile('Urlaubsanspruch', d.urlaubstage_jahr != null ? d.urlaubstage_jahr + ' Tage/Jahr' : null)}
      ${zeile('Startsaldo Überstunden', d.start_ueberstunden ? d.start_ueberstunden + ' h' : null)}
      ${anstellung ? `<tr><td style="padding:.3rem .75rem .3rem 0; color:var(--text-light); vertical-align:top">Anstellung</td>
                          <td style="padding:.3rem 0"><strong>${anstellung}</strong></td></tr>` : ''}
      ${zeile('Zusätzliche Rechte', rechte || 'keine')}
    </table>`;
}

// „Überall abmelden" und die Datenauskunft — zwei Dinge, die man selten braucht und dann sofort.
function kontoSicherheitKarte() {
  const k = document.getElementById('konto-sicherheit');
  if (!k) return;
  k.innerHTML = `
    <h3>&#128272; Sitzungen und Daten</h3>
    <button class="btn btn-outline btn-sm" id="alle-abmelden">Auf allen Geräten abmelden</button>
    <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem;margin-bottom:.9rem">
      Beendet jede Anmeldung — auch auf einem verlorenen Handy. Hier bleibst du angemeldet.
      Gemerkte Geräte der Zwei-Faktor-Anmeldung werden dabei ebenfalls zurückgesetzt.
    </div>
    <button class="btn btn-outline btn-sm" id="daten-auskunft">Meine Daten herunterladen</button>
    <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem">
      Alles, was über dich gespeichert ist, als Datei (Auskunft nach Art. 15 DSGVO).
    </div>`;

  document.getElementById('alle-abmelden').addEventListener('click', async () => {
    const weiter = await confirmModal(
      'Auf allen Geräten abmelden?\n\n'
      + 'Jede andere Anmeldung wird sofort ungültig — Handy, Tablet, Rechner beim Kunden. '
      + 'Auf DIESEM Gerät bleibst du angemeldet.');
    if (!weiter) return;
    try {
      const d = await api('POST', '/api/auth/alle-abmelden');
      // Frisches Token uebernehmen, sonst wuerde man sich mit dem eigenen Klick hinauswerfen.
      if (d && d.token) { S.token = d.token; localStorage.setItem('token', d.token); }
      toast('Alle anderen Anmeldungen wurden beendet', 'success');
      await kontoZweiFaktorKarte();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('daten-auskunft').addEventListener('click', async () => {
    try {
      // Mit Anmelde-Token holen und als Datei anbieten — ein einfacher Link koennte den Token
      // nicht mitschicken.
      const antwort = await fetch('/api/users/meine-daten', { headers: { Authorization: 'Bearer ' + S.token } });
      if (!antwort.ok) throw new Error('Auskunft nicht möglich');
      const url = URL.createObjectURL(await antwort.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `arbeitsdoku-meine-daten-${(S.user.username || 'daten')}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Datei wird heruntergeladen', 'success');
    } catch (err) { toast(err.message || 'Auskunft nicht möglich', 'error'); }
  });
}

function kontoPasswortKarte() {
  const k = document.getElementById('konto-passwort');
  if (!k) return;
  k.innerHTML = `
    <h3>&#128273; Passwort ändern</h3>
    <div class="error-msg" id="pw-fehler"></div>
    <form id="konto-pw-form">
      <div class="form-group">
        <label>Aktuelles Passwort</label>
        <input type="password" class="form-control" id="pw-alt" autocomplete="current-password" required>
      </div>
      <div class="form-group">
        <label>Neues Passwort</label>
        <input type="password" class="form-control" id="pw-neu" autocomplete="new-password" required>
        <ul class="pw-reqs" id="pw-neu-reqs"></ul>
      </div>
      <div class="form-group">
        <label>Neues Passwort wiederholen</label>
        <input type="password" class="form-control" id="pw-neu2" autocomplete="new-password" required>
      </div>
      <button type="submit" class="btn btn-primary">Passwort ändern</button>
    </form>`;
  // Dieselbe Live-Prüfliste wie im Mitarbeiter-Dialog — eine Darstellung der Regeln, nicht zwei.
  // Erwartet ELEMENTE, nicht Kennungen (app-1-core.js:915) — hier hatte ich zuerst Kennungen
  // uebergeben, dann waere die Liste stumm geblieben.
  wirePwField(document.getElementById('pw-neu'), document.getElementById('pw-neu-reqs'));
  document.getElementById('konto-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fehler = document.getElementById('pw-fehler');
    fehler.style.display = 'none';
    const alt = document.getElementById('pw-alt').value;
    const neu = document.getElementById('pw-neu').value;
    const neu2 = document.getElementById('pw-neu2').value;
    if (neu !== neu2) {
      fehler.textContent = 'Die beiden neuen Passwörter stimmen nicht überein';
      fehler.style.display = 'block';
      return;
    }
    try {
      await api('PUT', '/api/auth/password', { aktuell: alt, neu });
      toast('Passwort geändert', 'success');
      document.getElementById('konto-pw-form').reset();
      const reqs = document.getElementById('pw-neu-reqs'); if (reqs) reqs.innerHTML = '';
    } catch (err) {
      fehler.textContent = err.message;
      fehler.style.display = 'block';
    }
  });
}

// Anmerkung zu den Kennungen: Sie heissen `zfa-…` und nicht `2fa-…`. Eine CSS-Kennung darf nicht
// mit einer Ziffer beginnen — `getElementById` verzeiht das zwar, aber `querySelector('#2fa-start')`
// wirft einen Syntaxfehler, und eine CSS-Regel griffe nie. Im Oberflaechen-Test ist genau das
// aufgeschlagen.
//
// Drei Zustaende, die man auseinanderhalten muss:
//   nichts eingerichtet → „Einrichten"
//   stillgelegt         → „Wieder aktivieren" (die App kennt den Schluessel noch!)
//   aktiv               → ggf. „Abschalten" + „Neuen Schluessel erzeugen"
async function kontoZweiFaktorKarte() {
  const k = document.getElementById('konto-2fa');
  if (!k) return;
  let z;
  try { z = (await api('GET', '/api/auth/2fa/status')).zwei_faktor; }
  catch (_) { k.innerHTML = '<h3>&#128274; Zwei-Faktor-Anmeldung</h3><p>Zustand nicht abrufbar.</p>'; return; }
  S.zweiFaktor = z;

  if (z.notabschaltung) {
    k.innerHTML = `<h3>&#128274; Zwei-Faktor-Anmeldung</h3>
      <div class="warning-box">Die Zwei-Faktor-Anmeldung ist serverweit per Notfall-Schalter
      abgeschaltet. Es wird derzeit kein Code verlangt.</div>`;
    return;
  }

  const kopf = '<h3>&#128274; Zwei-Faktor-Anmeldung</h3>';
  const neuerSchluesselKnopf = `
    <hr style="margin:1rem 0; border:none; border-top:1px solid var(--border)">
    <button class="btn btn-outline btn-sm" id="zfa-neu">&#127922; Neuen Schlüssel erzeugen</button>
    <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem">
      Für ein neues Handy. Der bisherige Schlüssel gilt so lange weiter, bis der neue bestätigt ist.
    </div>`;

  if (z.eingerichtet) {
    // Wie oft ein Code verlangt wird, darf jeder selbst bestimmen — solange die Rolle nichts
    // vorschreibt (Alex, 23.08.2026). Gibt die Verwaltung etwas vor, gewinnt sie; der eigene
    // Wunsch bleibt gespeichert und greift wieder, sobald die Pflicht aufgehoben wird.
    const intervallHtml = z.eigen_modus_waehlbar ? `
      <hr style="margin:1rem 0; border:none; border-top:1px solid var(--border)">
      <div class="error-msg" id="zfa-intervall-fehler"></div>
      <form id="zfa-intervall" style="display:flex; gap:.5rem; flex-wrap:wrap; align-items:flex-end">
        <div class="form-group" style="margin:0">
          <label for="zfa-modus">Wie oft soll ein Code verlangt werden?</label>
          <select class="form-control" id="zfa-modus" style="min-width:12rem">
            ${(z.modi_auswahl || []).map(m => `<option value="${esc(m.wert)}"${m.wert === z.eigen_modus ? ' selected' : ''}>${esc(m.text)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label for="zfa-modus-code">Aktueller Code</label>
          <input type="text" class="form-control" id="zfa-modus-code" inputmode="numeric" maxlength="7" placeholder="123456" required style="width:9rem">
        </div>
        <button type="submit" class="btn btn-primary">Übernehmen</button>
      </form>
      <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem">
        Der Code ist nötig, damit an einem unbeaufsichtigten Gerät niemand deine Absicherung
        lockern kann. Beim Umstellen werden die gemerkten Geräte zurückgesetzt — sonst würde eine
        strengere Einstellung dort nicht greifen.
      </div>` : '';

    k.innerHTML = `${kopf}
      <p><strong style="color:var(--success)">Aktiv.</strong>
         Abfrage: <strong>${esc(z.pflicht ? z.modus_text : z.eigen_modus_text)}</strong>${z.pflicht ? ' (von der Verwaltung vorgegeben)' : ' (von dir gewählt)'}.</p>
      ${intervallHtml}
      ${z.abschaltbar
        ? `<div class="error-msg" id="zfa-aus-fehler"></div>
           <form id="konto-2fa-aus" style="display:flex; gap:.5rem; flex-wrap:wrap; align-items:flex-end">
             <div class="form-group" style="margin:0">
               <label>Zum Abschalten: aktueller Code</label>
               <input type="text" class="form-control" id="zfa-aus-code" inputmode="numeric" maxlength="7" placeholder="123456" required style="width:9rem">
             </div>
             <button type="submit" class="btn del-btn">Abschalten</button>
           </form>
           <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem">
             Der Schlüssel bleibt erhalten — schaltest du später wieder ein, funktioniert dieselbe
             App weiter. Nur die Geräte, die ohne Code hineinkommen, werden dabei zurückgesetzt.
           </div>`
        : `<p style="color:var(--text-light)">Solange deine Rolle die Zwei-Faktor-Anmeldung
             verlangt, lässt sie sich <strong>nicht abschalten</strong> — auch nicht von einem
             Administrator. Der kann den Schlüssel nur <em>zurücksetzen</em>, etwa bei einem
             verlorenen Handy; du müsstest dann sofort einen neuen einrichten. Wirklich abschalten
             kannst du erst, wenn die Verwaltung die Pflicht für deine Rolle wieder aufhebt.</p>`}
      ${neuerSchluesselKnopf}
      <div id="zfa-einrichtung" style="display:none; margin-top:1rem"></div>`;
    const intervall = document.getElementById('zfa-intervall');
    if (intervall) intervall.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fehler = document.getElementById('zfa-intervall-fehler');
      fehler.style.display = 'none';
      try {
        await api('POST', '/api/auth/2fa/eigener-modus', {
          modus: document.getElementById('zfa-modus').value,
          code: document.getElementById('zfa-modus-code').value.replace(/\s/g, ''),
        });
        toast('Gespeichert', 'success');
        await kontoZweiFaktorKarte();
      } catch (err) {
        fehler.textContent = err.message || 'Konnte nicht gespeichert werden';
        fehler.style.display = 'block';
      }
    });

    const form = document.getElementById('konto-2fa-aus');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fehler = document.getElementById('zfa-aus-fehler'); fehler.style.display = 'none';
      try {
        await api('POST', '/api/auth/2fa/aus', { code: document.getElementById('zfa-aus-code').value.replace(/\s/g, '') });
        toast('Zwei-Faktor-Anmeldung abgeschaltet', 'success');
        await kontoZweiFaktorKarte();
        await kontoGeraeteKarte();
      } catch (err) { fehler.textContent = err.message; fehler.style.display = 'block'; }
    });
    zfaNeuKnopfVerdrahten(true);
    await kontoGeraeteKarte();
    return;
  }

  if (z.stillgelegt) {
    // Der Schluessel ist noch da — nur nicht in Benutzung. Hier waere „Einrichten" mit neuem
    // QR-Code der falsche Weg: Die App der Person kennt den alten ja noch.
    k.innerHTML = `${kopf}
      <p>Du hast bereits einen Authenticator eingerichtet, er ist zurzeit nur <strong>nicht in
         Benutzung</strong>.${z.pflicht ? ` Für deine Rolle ist er jetzt <strong>vorgeschrieben</strong> (${esc(z.modus_text)}) — bitte wieder aktivieren.` : ''}</p>
      <div class="error-msg" id="zfa-fehler"></div>
      <form id="zfa-verify" style="display:flex; gap:.5rem; align-items:flex-end; flex-wrap:wrap">
        <div class="form-group" style="margin:0">
          <label>Code aus deiner Authenticator-App</label>
          <input type="text" class="form-control" id="zfa-code" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="7" placeholder="123456" required style="width:9rem; font-size:1.2rem; letter-spacing:.2em; text-align:center">
        </div>
        <button type="submit" class="btn btn-primary">Wieder aktivieren</button>
      </form>
      ${neuerSchluesselKnopf}
      <div id="zfa-einrichtung" style="display:none; margin-top:1rem"></div>`;
    zfaCodeFormularVerdrahten();
    zfaNeuKnopfVerdrahten(true);
    return;
  }

  // Noch gar nichts eingerichtet
  k.innerHTML = `${kopf}
    <p>Zusätzlich zum Passwort ein 6-stelliger Code aus einer Authenticator-App
       (Google Authenticator, Aegis, 2FAS …).${z.pflicht ? ` Für deine Rolle <strong>vorgeschrieben</strong> (${esc(z.modus_text)}).` : ''}</p>
    <button class="btn btn-primary" id="zfa-start">Einrichten</button>
    <div id="zfa-einrichtung" style="display:none; margin-top:1rem"></div>`;
  document.getElementById('zfa-start').addEventListener('click', (e) => {
    e.target.style.display = 'none';
    zfaEinrichtungStarten(false);
  });
}

// „Neuen Schlüssel erzeugen" — mit deutlicher Warnung, denn der alte wird dabei ungültig.
function zfaNeuKnopfVerdrahten(warnen) {
  const knopf = document.getElementById('zfa-neu');
  if (!knopf) return;
  knopf.addEventListener('click', async () => {
    if (warnen) {
      const weiter = await confirmModal(
        'Neuen Schlüssel erzeugen?\n\n'
        + 'Du bekommst einen neuen QR-Code und musst deine Authenticator-App NEU einlernen. '
        + 'Der bisherige Eintrag in der App wird damit wertlos — lösche ihn danach dort.\n\n'
        + 'Bis du den neuen Code bestätigt hast, gilt weiterhin der alte. Du sperrst dich also '
        + 'nicht aus, wenn du hier abbrichst.');
      if (!weiter) return;
    }
    knopf.disabled = true;
    zfaEinrichtungStarten(true);
  });
}

// Holt einen (neuen) Schlüssel und zeigt QR + Eingabefeld.
async function zfaEinrichtungStarten(istNeu) {
  const bereich = document.getElementById('zfa-einrichtung');
  if (!bereich) return;
  try {
    const d = await api('POST', '/api/auth/2fa/setup', istNeu ? { neu: true } : {});
    bereich.style.display = 'block';
    // Der QR-Code kommt als fertiges SVG vom Server und wird EINGEBETTET — die
    // Sicherheitsrichtlinie der App erlaubt Bilder nur von der eigenen Herkunft, ein
    // data:-Bild würde der Browser stumm verwerfen.
    bereich.innerHTML = `
      ${istNeu ? `<div class="warning-box" style="margin-bottom:.75rem">
        <strong>Neuer Schlüssel.</strong> Erst wenn du unten einen Code aus dem NEUEN Eintrag
        bestätigst, wird er gültig. Bis dahin funktioniert dein bisheriger weiter.
      </div>` : ''}
      <p>1. In der Authenticator-App diesen Code scannen:</p>
      <div id="zfa-qr" style="background:#fff; padding:.5rem; display:inline-block; border-radius:8px">${d.qr_svg}</div>
      <p style="margin-top:.75rem">Kein Scannen möglich (z. B. weil die App auf demselben Handy läuft)?
         Dann diesen Schlüssel eintippen:</p>
      <code style="display:block; word-break:break-all; background:var(--bg); padding:.5rem; border-radius:6px">${esc(d.geheim)}</code>
      <p style="margin-top:.75rem">2. Den angezeigten 6-stelligen Code hier eingeben:</p>
      <div class="error-msg" id="zfa-fehler"></div>
      <form id="zfa-verify" style="display:flex; gap:.5rem; align-items:flex-end; flex-wrap:wrap">
        <div class="form-group" style="margin:0">
          <input type="text" class="form-control" id="zfa-code" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="7" placeholder="123456" required style="width:9rem; font-size:1.2rem; letter-spacing:.2em; text-align:center">
        </div>
        <button type="submit" class="btn btn-primary">Bestätigen</button>
      </form>`;
    zfaCodeFormularVerdrahten();
  } catch (err) {
    toast(err.message || 'Einrichtung nicht möglich', 'error');
    const knopf = document.getElementById('zfa-neu'); if (knopf) knopf.disabled = false;
    const start = document.getElementById('zfa-start'); if (start) start.style.display = '';
  }
}

function zfaCodeFormularVerdrahten() {
  const form = document.getElementById('zfa-verify');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fehler = document.getElementById('zfa-fehler');
    if (fehler) fehler.style.display = 'none';
    try {
      const r = await api('POST', '/api/auth/2fa/verify', { code: document.getElementById('zfa-code').value.replace(/\s/g, '') });
      S.zweiFaktor = r.zwei_faktor;
      try { localStorage.setItem('zwei_faktor', JSON.stringify(r.zwei_faktor)); } catch (_) {}
      toast('Zwei-Faktor-Anmeldung ist aktiv', 'success');
      await kontoZweiFaktorKarte();
      // War die Einrichtung erzwungen, ist der Weg jetzt frei.
      if (!r.zwei_faktor.einrichtung_noetig) render();
    } catch (err) {
      if (fehler) { fehler.textContent = err.message; fehler.style.display = 'block'; }
      else toast(err.message, 'error');
    }
  });
}

// Liste der Geräte, die ohne Code hineinkommen. Ohne sie wäre ein verlorenes Handy bei
// „einmal pro Gerät" dauerhaft berechtigt.
async function kontoGeraeteKarte() {
  const k = document.getElementById('konto-geraete');
  if (!k) return;
  let geraete = [];
  try { geraete = (await api('GET', '/api/auth/2fa/geraete')).geraete || []; } catch (_) { }
  if (!geraete.length) { k.style.display = 'none'; return; }
  k.style.display = '';
  const datum = (t) => t ? new Date(String(t).replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  // Die Ueberschrift hiess frueher „Geraete ohne Code-Abfrage" — das stimmte nur bei „einmal pro
  // Geraet". Bei „woechentlich" wird sehr wohl gefragt, nur seltener (Alex, 24.08.2026). Also
  // neutral benennen und darunter sagen, was auf diesen Geraeten wirklich gilt.
  const zf = S.zweiFaktor || {};
  const wirksam = zf.pflicht ? zf.modus : (zf.eigen_modus || 'geraet');
  const ERKLAERUNG = {
    geraet: 'Auf diesen Geräten wird kein Code mehr verlangt.',
    taeglich: 'Auf diesen Geräten wird höchstens einmal am Tag ein Code verlangt.',
    woechentlich: 'Auf diesen Geräten wird höchstens einmal pro Woche ein Code verlangt.',
    monatlich: 'Auf diesen Geräten wird höchstens einmal im Monat ein Code verlangt.',
    immer: 'Weil bei jeder Anmeldung ein Code verlangt wird, hilft ein gemerktes Gerät hier nicht.',
  };
  k.innerHTML = `
    <h3>&#128241; Gemerkte Geräte</h3>
    <p style="margin:0 0 .7rem; font-size:.88rem; color:var(--text-light)">
      ${esc(ERKLAERUNG[wirksam] || 'Auf diesen Geräten wird seltener ein Code verlangt.')}
    </p>
    <div class="tool-list">
      ${geraete.map(g => `
        <div class="tool-item">
          <div>
            <strong>${esc(g.bezeichnung)}</strong>${g.dieses_geraet ? ' <span style="color:var(--success)">(dieses Gerät)</span>' : ''}
            <div style="font-size:.8rem; color:var(--text-light)">zuletzt ${datum(g.zuletzt_benutzt)}</div>
          </div>
          <button class="del-btn" data-geraet="${g.id}" title="Vertrauen entziehen">&times;</button>
        </div>`).join('')}
    </div>
    <button class="btn" id="geraete-alle" style="margin-top:.5rem">Allen Geräten das Vertrauen entziehen</button>`;
  k.querySelectorAll('[data-geraet]').forEach(b => b.addEventListener('click', async () => {
    try { await api('DELETE', '/api/auth/2fa/geraete/' + b.dataset.geraet); toast('Gerät entzogen', 'success'); await kontoGeraeteKarte(); }
    catch (err) { toast(err.message, 'error'); }
  }));
  document.getElementById('geraete-alle').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/2fa/geraete/alle-entziehen'); toast('Alle Geräte entzogen', 'success'); await kontoGeraeteKarte(); }
    catch (err) { toast(err.message, 'error'); }
  });
}
