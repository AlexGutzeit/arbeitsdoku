// --- Planning ---
async function renderPlanning() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'planning');
  bindLayout();

  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    const uData = await api('GET', '/api/users/list');
    if (uData) S.users = uData.users;
  } catch (e) {}

  renderPlanningContent();
}

async function renderPlanningContent() {
  const _tok = renderToken();
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;
  mainEl.classList.add('main-wide');

  const view = S.planningView || 'day';
  const d = S.planningDate || new Date();
  let r, label;
  if (view === 'day') {
    const iso = formatDateISO(d);
    r = { from: iso, to: iso };
    const dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
    label = `${dayNames[d.getDay()]}, ${formatDateDE(iso)}`;
  } else if (view === 'week') {
    r = getWeekRange(d);
    label = `KW ${getISOWeek(formatDateISO(d))} | ${formatDateDE(r.from)} - ${formatDateDE(r.to)}`;
  } else {
    r = getMonthRange(d);
    const mNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    label = `${mNames[d.getMonth()]} ${d.getFullYear()}`;
  }

  // „Planung"-Push-Schalter einmalig laden (steuert den Erinnerungs-Punkt im ⋮-Menü). Wie in
  // initPushCard: nur zeigen, wenn Push auf diesem Gerät aktiv ist UND „Planung" an. Beim ersten Mal
  // ist S.pushPlanning noch nicht gesetzt (Notifications-Seite ggf. nie geöffnet) → hier nachziehen.
  if (S.pushPlanning === undefined) {
    try {
      const active = typeof pushSupported === 'function' && pushSupported() && !!(await getPushSubscription());
      let planningOn = true;
      if (active) { const p = await api('GET', '/api/push/prefs'); planningOn = !!(p && p.planning); }
      S.pushPlanning = active && planningOn;
    } catch (_) { S.pushPlanning = false; }
  }

  // Eigene Erinnerungen laden (für die 🔔-Kennzeichnung an Terminen). Nur wenn das Feature an ist.
  S.planReminders = [];
  if (S.pushPlanning) {
    try {
      const rm = await api('GET', '/api/planning/reminders/mine');
      S.planReminders = (rm && rm.reminders) || [];
    } catch (_) {}
  }

  let entries = [];
  let absences = [];
  try {
    const [planData, absData] = await Promise.all([
      api('GET', `/api/planning?date_from=${r.from}&date_to=${r.to}`),
      api('GET', `/api/absences/by-date?from=${r.from}&to=${r.to}&scope=planning`),
    ]);
    if (planData) entries = planData.entries;
    if (absData) absences = filterApprovedAbsences(absData.absences);
  } catch (e) {
    if (renderStale(_tok)) return;
    renderLoadError('.main', e.message, () => renderPlanningContent());
    return;
  }
  if (renderStale(_tok)) return;   // verspätete Antwort nicht in die neue Seite schreiben

  const canEdit = canEditPlanning();

  // Timeline für Tagesansicht
  let contentHtml = '';
  if (view === 'day') {
    contentHtml = renderPlanningTimeline(entries, absences, canEdit);
  } else {
    contentHtml = renderPlanningGrid(entries, absences, r, view, canEdit);
  }

  mainEl.innerHTML = `
    <div class="view-toggle">
      <button class="${view === 'day' ? 'active' : ''}" data-pview="day">Tag</button>
      <button class="${view === 'week' ? 'active' : ''}" data-pview="week">Woche</button>
      <button class="${view === 'month' ? 'active' : ''}" data-pview="month">Monat</button>
    </div>
    <div class="date-nav">
      <button id="plan-prev" aria-label="Vorheriger Zeitraum" title="Zurück">&#8249;</button>
      <span class="current-period">${label}</span>
      <button id="plan-next" aria-label="Nächster Zeitraum" title="Weiter">&#8250;</button>
      <button id="plan-today" class="date-today-btn">Jetzt</button>
    </div>
    ${contentHtml}`;

  // View toggle
  mainEl.querySelectorAll('.view-toggle button[data-pview]').forEach(btn => {
    btn.addEventListener('click', () => { S.planningView = btn.dataset.pview; renderPlanningContent(); });
  });

  // Date nav
  document.getElementById('plan-prev')?.addEventListener('click', () => {
    const dd = S.planningDate || new Date();
    const v = S.planningView || 'day';
    if (v === 'day') dd.setDate(dd.getDate() - 1);
    else if (v === 'week') dd.setDate(dd.getDate() - 7);
    else dd.setMonth(dd.getMonth() - 1);
    S.planningDate = new Date(dd);
    renderPlanningContent();
  });
  document.getElementById('plan-next')?.addEventListener('click', () => {
    const dd = S.planningDate || new Date();
    const v = S.planningView || 'day';
    if (v === 'day') dd.setDate(dd.getDate() + 1);
    else if (v === 'week') dd.setDate(dd.getDate() + 7);
    else dd.setMonth(dd.getMonth() + 1);
    S.planningDate = new Date(dd);
    renderPlanningContent();
  });
  document.getElementById('plan-today')?.addEventListener('click', () => {
    S.planningDate = new Date();
    renderPlanningContent();
  });

  // Tooltip + Long-Press für Planning-Einträge
  const planEntryMap = {};
  entries.forEach(e => { planEntryMap[e.id] = e; });

  mainEl.querySelectorAll('.tl-plan-entry[data-planning-id]').forEach(el => {
    const e = planEntryMap[el.dataset.planningId];

    // Desktop: Hover-Tooltip
    el.addEventListener('mouseenter', (ev) => {
      if (!istMauszeiger()) return;   // Maus-Ersatzereignis nach einer Beruehrung
      if (e) showTooltip(planEntryTooltipHtml(e), ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => {
      if (!istMauszeiger()) return;
      if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
    });
    el.addEventListener('mouseleave', hideTooltip);

    // Handy: langer Druck zeigt die Details. Gemeinsame Funktion mit dem Zeitnachweis (B7) —
    // sie unterdrueckt zusaetzlich den Klick nach dem Loslassen, der hier vorher noch durchging
    // und den Termin ungewollt uebernommen hat.
    attachLongPressTooltip(el, () => (e ? planEntryTooltipHtml(e) : ''));

    // Click → Eintrag übernehmen (nur ohne Long-Press)
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.plan-action-btn') || ev.target.closest('.plan-menu-btn') || ev.target.closest('.plan-action-menu')) return;
      hideTooltip();
      navigate('/planning/accept/' + el.dataset.planningId);
    });
  });

  // ⋮ Kontextmenü für Planung
  function closePlanMenus() {
    document.querySelectorAll('.plan-action-menu').forEach(m => m.remove());
  }
  mainEl.querySelectorAll('.plan-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      const existingMenu = document.querySelector('.plan-action-menu[data-for="' + btn.dataset.id + '"]');
      closePlanMenus();
      if (existingMenu) return; // Toggle: war offen → schließen

      const canEd = btn.dataset.canedit === '1';
      const canRem = btn.dataset.remind === '1';
      const menu = document.createElement('div');
      menu.className = 'plan-action-menu';
      menu.dataset.for = btn.dataset.id;
      menu.innerHTML =
        (canEd ? `<button class="plan-menu-edit" data-id="${btn.dataset.id}" data-group="${btn.dataset.group || ''}">&#9998; Bearbeiten</button>
        <button class="plan-menu-del" data-id="${btn.dataset.id}">&#10005; L\u00f6schen</button>` : '') +
        (canRem ? `<button class="plan-menu-remind" data-id="${btn.dataset.id}">&#128276; Benachrichtigung</button>` : '');
      // Positionierung: unterhalb des Buttons, relativ zum Viewport
      document.body.appendChild(menu);
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 2) + 'px';
      menu.style.left = Math.max(4, rect.right + window.scrollX - menu.offsetWidth) + 'px';

      const editBtn = menu.querySelector('.plan-menu-edit');
      if (editBtn) editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTooltip();
        closePlanMenus();
        if (btn.dataset.group) {
          navigate('/planning/edit-group/' + btn.dataset.group);
        } else {
          navigate('/planning/edit/' + btn.dataset.id);
        }
      });
      const remindBtn = menu.querySelector('.plan-menu-remind');
      if (remindBtn) remindBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTooltip();
        closePlanMenus();
        openReminderDialog({
          id: btn.dataset.id, group_id: btn.dataset.group || '', series_id: btn.dataset.series || '',
          occurrence_date: btn.dataset.occ || '', client: btn.dataset.client || '', time_from: btn.dataset.time || '',
        });
      });
      const delBtn = menu.querySelector('.plan-menu-del');
      if (delBtn) delBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        closePlanMenus();
        const seriesId = btn.dataset.series;
        const occ = btn.dataset.occ;
        try {
          if (seriesId) {
            const scope = await choiceModal('Dieser Termin geh\u00f6rt zu einer Serie. Was m\u00f6chtest du l\u00f6schen?', [
              { value: 'occurrence', label: '\u2715 Nur diesen Termin', danger: true },
              { value: 'following', label: '\u2715 Diesen + alle folgenden', danger: true },
              { value: 'series', label: '\u2715 Ganze Serie', danger: true },
              { value: 'stop', label: '\u23f9 Serie ab heute beenden (Vergangenes bleibt)' },
            ], { title: 'Serientermin l\u00f6schen' });
            if (!scope) return;
            if (scope === 'stop') await api('POST', '/api/planning/series/' + seriesId + '/stop', {});
            else await api('DELETE', '/api/planning/series/' + seriesId, { scope, occurrence_date: occ });
            toast(scope === 'stop' ? 'Serie beendet' : 'Gel\u00f6scht', 'success');
          } else {
            if (!(await confirmModal('Planung wirklich l\u00f6schen?', { title: 'Planung l\u00f6schen', okLabel: 'L\u00f6schen' }))) return;
            await api('DELETE', '/api/planning/' + btn.dataset.id);
            toast('Planung gel\u00f6scht', 'success');
          }
          renderPlanningContent();
        } catch (e2) { toast(e2.message, 'error'); }
      });
    });
  });
  // Schließen via globalem document-Listener (einmalig im Init registriert)
  // Nav-Buttons in Planungsübersicht
  mainEl.querySelectorAll('.nav-to-addr').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openNav(btn.dataset.addr); });
  });
  // Grid cell click → jump to day
  mainEl.querySelectorAll('[data-plan-jump]').forEach(el => {
    el.addEventListener('click', (e) => {
      const closest = e.target.closest('[data-plan-jump]');
      if (closest) {
        e.stopPropagation();
        S.planningDate = new Date(closest.dataset.planJump + 'T12:00:00');
        S.planningView = 'day';
        renderPlanningContent();
      }
    });
  });

  // Timeline zur Kernarbeitszeit scrollen
  if (view === 'day') {
    const scrollContainer = mainEl.querySelector('.timeline-scroll');
    if (scrollContainer) {
      const scrollY = (TL_SCROLL_TO_HOUR - TL_START_HOUR) * TL_HOUR_PX - 20;
      scrollContainer.scrollTop = Math.max(0, scrollY);
    }
  }
}

// --- Planungs-Erinnerungen (Push vor einem Termin) ---
const REMINDER_UNITS = [
  { v: 'day', l: 'Tag(e)' },
  { v: 'week', l: 'Woche(n)' },
  { v: 'month', l: 'Monat(e)' },
];
const reminderUnitLabel = (u) => (REMINDER_UNITS.find(x => x.v === u) || {}).l || u;
// Hat der aktuelle Nutzer für dieses Vorkommen eine Erinnerung? Pro-Vorkommen gespeichert → direkter
// Abgleich über group_id (Serie/Mehrtag) bzw. entry_id (Einzeltag).
function entryHasReminder(e) {
  const list = S.planReminders;
  if (!list || !list.length) return false;
  return list.some(r => (r.group_id && r.group_id === e.group_id) || (r.entry_id && r.entry_id === e.id));
}

// Serien-Scope abfragen (nur dieser / dieser + folgende / ganze Serie). Liefert value oder null.
function askReminderScope(title) {
  return choiceModal('Wofür soll das gelten?', [
    { value: 'occurrence', label: 'Nur dieser Termin', primary: true },
    { value: 'following', label: 'Dieser + alle folgenden' },
    { value: 'all', label: 'Ganze Serie' },
  ], { title });
}

// Dialog zum Setzen/Ändern/Entfernen von Erinnerungen für einen Termin.
// e: { id, group_id, series_id, occurrence_date, client, time_from }.
async function openReminderDialog(e) {
  const isSeries = !!e.series_id;
  const q = e.group_id ? ('group_id=' + encodeURIComponent(e.group_id)) : ('entry_id=' + encodeURIComponent(e.id));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header"><h3>&#128276; Benachrichtigung</h3></div>
      <div class="modal-body">
        <p style="margin:0 0 0.8rem;color:#6b7280;font-size:0.9rem">Erinnerung per Push vor dem Termin${e.client ? ' <strong>' + esc(e.client) + '</strong>' : ''}. Vorlauf + Uhrzeit wählen – die Uhrzeit ist mit der Beginn-Zeit des Termins vorbelegt (z. B. 18:00 für eine Abend-Erinnerung).${isSeries ? ' Bei Serien wird gefragt, für welche Termine es gilt.' : ''}</p>
        <div id="rem-list" style="margin-bottom:0.9rem"></div>
        <div style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
          <label style="flex:0 0 auto">Vorlauf<br><input id="rem-num" type="number" min="1" max="999" value="1" class="form-control" style="width:4.5rem"></label>
          <label style="flex:1 1 7rem">Einheit<br><select id="rem-unit" class="form-control">${REMINDER_UNITS.map(u => `<option value="${u.v}"${u.v === 'week' ? ' selected' : ''}>${esc(u.l)}</option>`).join('')}</select></label>
          <label style="flex:0 0 auto">Uhrzeit<br><input id="rem-time" type="time" class="form-control" value="${esc(e.time_from || '')}" style="width:7rem"></label>
        </div>
        <div style="margin-top:0.8rem;display:flex;gap:0.5rem">
          <button class="btn btn-primary btn-sm" id="rem-submit">Erinnerung hinzufügen</button>
          <button class="btn btn-outline btn-sm" id="rem-cancel" style="display:none">Abbrechen</button>
        </div>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="close">Schließen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let changed = false; // beim Schließen die Planung neu rendern (🔔 aktualisieren)
  let editingId = null;
  const aufraeumen = dialogBarrierefrei(overlay);
  const finish = () => { document.removeEventListener('keydown', onKey); overlay.remove(); aufraeumen(); if (changed) renderPlanningContent(); };
  const onKey = (ev) => { if (ev.key === 'Escape') finish(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) finish(); });
  overlay.querySelector('[data-act="close"]').addEventListener('click', finish);

  const numEl = overlay.querySelector('#rem-num');
  const unitEl = overlay.querySelector('#rem-unit');
  const timeEl = overlay.querySelector('#rem-time');
  const submitBtn = overlay.querySelector('#rem-submit');
  const cancelBtn = overlay.querySelector('#rem-cancel');
  const listEl = overlay.querySelector('#rem-list');

  function resetForm() {
    editingId = null; numEl.value = '1'; unitEl.value = 'week'; timeEl.value = e.time_from || '';
    submitBtn.textContent = 'Erinnerung hinzufügen'; cancelBtn.style.display = 'none';
  }
  cancelBtn.addEventListener('click', resetForm);

  async function renderList() {
    let reminders = [];
    try { const r = await api('GET', '/api/planning/reminders?' + q); reminders = (r && r.reminders) || []; } catch (_) {}
    if (!reminders.length) { listEl.innerHTML = '<p style="margin:0;color:var(--text-lighter)">Noch keine Erinnerung.</p>'; return; }
    listEl.innerHTML = reminders.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0;border-bottom:1px solid #f0f0f0">
        <span>${r.lead_num} ${esc(reminderUnitLabel(r.lead_unit))} vorher · um ${esc(r.remind_time || e.time_from || '–')}${r.series_id ? ' · <em>Serie</em>' : ''}</span>
        <span style="display:flex;gap:0.25rem">
          <button class="btn btn-sm btn-outline rem-edit" data-id="${r.id}" data-num="${r.lead_num}" data-unit="${esc(r.lead_unit)}" data-time="${esc(r.remind_time || '')}" data-series="${r.series_id ? '1' : ''}" title="Bearbeiten">&#9998;</button>
          <button class="btn btn-sm btn-outline rem-del" data-id="${r.id}" data-series="${r.series_id ? '1' : ''}" title="Entfernen">&#10005;</button>
        </span>
      </div>`).join('');
    listEl.querySelectorAll('.rem-edit').forEach(b => b.addEventListener('click', () => {
      editingId = b.dataset.id; numEl.value = b.dataset.num; unitEl.value = b.dataset.unit;
      timeEl.value = b.dataset.time || (e.time_from || '');
      submitBtn.textContent = 'Änderung speichern'; cancelBtn.style.display = '';
      numEl.focus();
    }));
    listEl.querySelectorAll('.rem-del').forEach(b => b.addEventListener('click', async () => {
      try {
        let scope = 'occurrence';
        if (b.dataset.series) { scope = await askReminderScope('Benachrichtigung löschen'); if (!scope) return; }
        await api('DELETE', '/api/planning/reminders/' + b.dataset.id + '?scope=' + scope);
        changed = true; if (editingId === b.dataset.id) resetForm(); renderList();
      } catch (err) { toast(err.message || 'Löschen fehlgeschlagen', 'error'); }
    }));
  }

  submitBtn.addEventListener('click', async () => {
    const num = parseInt(numEl.value, 10);
    const unit = unitEl.value;
    const time = timeEl.value;
    if (!Number.isInteger(num) || num < 1) { toast('Bitte eine Zahl ≥ 1 eingeben', 'error'); return; }
    try {
      if (editingId) {
        // Ändern (bestehende Erinnerung)
        let scope = 'occurrence';
        if (isSeries) { scope = await askReminderScope('Änderung übernehmen für'); if (!scope) return; }
        const body = { lead_num: num, lead_unit: unit, scope };
        if (time) body.remind_time = time;
        await api('PUT', '/api/planning/reminders/' + editingId, body);
        toast('Erinnerung geändert', 'success'); changed = true; resetForm(); renderList();
      } else {
        // Neu anlegen
        let scope = 'occurrence';
        if (isSeries) { scope = await askReminderScope('Benachrichtigung setzen für'); if (!scope) return; }
        const body = { lead_num: num, lead_unit: unit };
        if (time) body.remind_time = time;
        if (isSeries) { body.series_id = e.series_id; body.occurrence_date = e.occurrence_date; body.group_id = e.group_id; body.scope = scope; }
        else if (e.group_id) body.group_id = e.group_id; else body.entry_id = e.id;
        await api('POST', '/api/planning/reminders', body);
        toast('Erinnerung gespeichert', 'success'); changed = true; resetForm(); renderList();
      }
    } catch (err) { toast(err.message || 'Speichern fehlgeschlagen', 'error'); }
  });
  renderList();
}

function renderPlanningTimeline(entries, absences, canEdit) {
  const currentDay = formatDateISO(S.planningDate || new Date());
  const dayAbsencesAll = (absences || []).filter(a => a.date_from <= currentDay && a.date_to >= currentDay);

  const globalDayAbsences = dayAbsencesAll.filter(a => !a.user_id);
  if (entries.length === 0 && dayAbsencesAll.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128197;</div><p>Keine Planungen für diesen Tag</p></div>';
  }

  const totalH = (TL_END_HOUR - TL_START_HOUR) * TL_HOUR_PX;

  // Stundenleiste
  let hoursHtml = '<div class="timeline-hours-body" style="height:' + totalH + 'px">';
  for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
    const y = (h - TL_START_HOUR) * TL_HOUR_PX;
    hoursHtml += `<span class="tl-hour-label" style="top:${y}px">${String(h).padStart(2,'0')}:00</span>`;
  }
  hoursHtml += '</div>';

  // Gruppiere nach zugewiesenem Mitarbeiter (Planungseinträge)
  const byUser = {};
  // 1) Alle echten Mitarbeiter immer als Spalte (auch ohne Planung)
  (S.users || [])
    .filter(u => u.role === 'mitarbeiter')
    .forEach(u => { byUser[u.id] = { id: u.id, name: u.name, entries: [] }; });
  // 2) Zusätzlich: User aus Planungen (z.B. Chef/Buchhalter, falls verplant)
  entries.forEach(e => {
    e.assigned_users.forEach(u => {
      if (!byUser[u.user_id]) byUser[u.user_id] = { id: u.user_id, name: u.user_name, entries: [] };
      byUser[u.user_id].entries.push(e);
    });
  });
  // 3) Zusätzlich: User mit Abwesenheit (falls noch nicht enthalten)
  dayAbsencesAll.forEach(a => {
    if (!a.user_id) return;
    if (!byUser[a.user_id]) {
      const u = (S.users || []).find(u => u.id === a.user_id);
      byUser[a.user_id] = { id: a.user_id, name: u ? u.name : (a.user_name || `#${a.user_id}`), entries: [] };
    }
  });
  const columns = Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));

  const globalBannerHtml = globalDayAbsences.map(a => {
    const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
    const comment = a.comment ? `<span class="tl-absence-comment">${esc(a.comment)}</span>` : '';
    return `<div class="tl-absence-banner tl-absence-banner--${a.type}">${t.icon} ${t.label} <span style="font-weight:400;opacity:0.75">(gilt für alle Mitarbeiter)</span>${comment}</div>`;
  }).join('');

  if (columns.length === 0) {
    if (globalBannerHtml) return `<div style="padding:0.75rem">${globalBannerHtml}</div>`;
    return '<div class="empty-state"><div class="icon">&#128197;</div><p>Keine Planungen für diesen Tag</p></div>';
  }

  let colsHtml = '';
  columns.forEach((col, ci) => {
    const colColor = PALETTE[ci % PALETTE.length];
    let bodyHtml = '';
    for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
      const y = (h - TL_START_HOUR) * TL_HOUR_PX;
      bodyHtml += `<div class="tl-hour-line" style="top:${y}px"></div>`;
      if (h < TL_END_HOUR) bodyHtml += `<div class="tl-hour-line half" style="top:${y + TL_HOUR_PX / 2}px"></div>`;
    }

    // Überlappungen berechnen
    const sorted = [...col.entries].sort((a, b) => a.time_from < b.time_from ? -1 : a.time_from > b.time_from ? 1 : 0);
    const lanes = [];
    sorted.forEach(e => {
      const [fh, fm] = e.time_from.split(':').map(Number);
      const [th, tm] = e.time_to.split(':').map(Number);
      e._startMin = fh * 60 + fm;
      e._endMin = th * 60 + tm;
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].end <= e._startMin) { lanes[i].end = e._endMin; e._lane = i; placed = true; break; }
      }
      if (!placed) { e._lane = lanes.length; lanes.push({ end: e._endMin }); }
    });
    const totalLanes = Math.max(1, lanes.length);
    sorted.forEach(e => {
      const top = ((e._startMin - TL_START_HOUR * 60) / 60) * TL_HOUR_PX;
      const height = Math.max(20, ((e._endMin - e._startMin) / 60) * TL_HOUR_PX);
      const projLabel = e.project_name || e.project_text || '';
      const laneW = (100 - 6) / totalLanes;
      const leftPct = 3 + e._lane * laneW;
      const widthPct = laneW - 1;

      let actionsHtml = '';
      if (e.address) {
        actionsHtml += `<button type="button" class="plan-action-btn nav-to-addr" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>`;
      }
      // ⋮-Menü: Bearbeiten/Löschen für Planer (eigene Spalte bzw. „alle"-Planer). Zusätzlich der
      // Erinnerungs-Punkt, sobald „Planung"-Push an ist — auch für Mitarbeiter OHNE Planungsrecht
      // (dann nur „Benachrichtigung"), aber nur in der eigenen Spalte. Chef/Admin überall.
      const mayEditThis = canEdit && canEditEntry(e) && (canPlanAll() || col.id === S.user.id);
      const mayRemindThis = !!S.pushPlanning && (canPlanAll() || col.id === S.user.id);
      if (mayEditThis || mayRemindThis) {
        actionsHtml += `<button type="button" class="plan-menu-btn" data-id="${e.id}" data-group="${e.group_id || ''}" data-series="${e.series_id || ''}" data-occ="${e.occurrence_date || ''}" data-canedit="${mayEditThis ? '1' : ''}" data-remind="${mayRemindThis ? '1' : ''}" data-client="${esc(e.client || e.project_text || '')}" data-time="${esc(e.time_from || '')}" title="Aktionen">&#8942;</button>`;
      }

      const entryColor = e.color || '#f59e0b';
      bodyHtml += `<div class="tl-plan-entry" data-planning-id="${e.id}" style="top:${top}px;height:${height}px;left:${leftPct}%;width:${widthPct}%;right:auto;background:${entryColor}28;border-color:${entryColor};color:#374151;" title="Klicken zum \u00dcbernehmen">
        <div style="display:flex;justify-content:space-between;align-items:center;min-width:0;">
          <span class="tl-e-time" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.series_id ? '<span title="Serientermin">🔁</span> ' : ''}${entryHasReminder(e) ? '<span title="Erinnerung aktiv">🔔</span> ' : ''}${esc(e.time_from)} - ${esc(e.time_to)}</span>
          <span style="display:flex;gap:2px;flex-shrink:0;">${actionsHtml}</span>
        </div>
        ${projLabel || e.client ? `<span class="tl-e-project">${esc(projLabel)}${projLabel && e.client ? ' – ' : ''}${esc(e.client || '')}</span>` : ''}
        ${e.description && height > 50 ? `<span class="tl-e-desc">${esc(e.description)}</span>` : ''}
      </div>`;
    });

    const colAbsences = getAbsencesForDay(col.id, currentDay, absences);
    const planColBannerHtml = colAbsences.map(a => {
      const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
      const comment = a.comment ? `<span class="tl-absence-comment">${esc(a.comment)}</span>` : '';
      return `<div class="tl-absence-banner tl-absence-banner--${a.type}${a.status === 'pending' ? ' tl-absence-banner--pending' : ''}">${t.icon} ${t.label}${comment}</div>`;
    }).join('');
    const planColBannerWrap = planColBannerHtml ? `<div class="tl-col-banner">${planColBannerHtml}</div>` : '';

    colsHtml += `<div class="timeline-column">
      <div class="tl-col-header" style="color:${colColor}">
        <div class="tl-col-header-name">${esc(col.name)}</div>
        ${planColBannerWrap}
      </div>
      <div class="tl-col-body" style="height:${totalH}px">${bodyHtml}</div>
    </div>`;
  });

  return `<div class="timeline-wrapper">
    ${globalBannerHtml ? `<div class="tl-global-banner-row">${globalBannerHtml}</div>` : ''}
    <div class="timeline-scroll">
      <div class="timeline-container">
        <div class="timeline-hours"><div class="tl-col-header" style="visibility:hidden">.</div>${hoursHtml}</div>
        ${colsHtml}
      </div>
    </div>
  </div>`;
}

function renderPlanningGrid(entries, absences, range, view, canEdit) {
  const dayNamesShort = ['Mo','Di','Mi','Do','Fr','Sa','So'];

  // Spalten = im Zeitraum angestellte Mitarbeiter + zusätzlich verplante/abwesende (auch ausgestellte mit Bezug)
  const colMap = {};
  (S.users || [])
    .filter(u => u.role === 'mitarbeiter' && (!range || employedInRange(u, range.from, range.to)))
    .forEach(u => { colMap[u.id] = { id: u.id, name: u.name }; });
  entries.forEach(e => {
    e.assigned_users.forEach(u => {
      if (!colMap[u.user_id]) colMap[u.user_id] = { id: u.user_id, name: u.user_name };
    });
  });
  (absences || []).forEach(a => {
    if (!a.user_id) return;
    if (!colMap[a.user_id]) {
      const u = (S.users || []).find(u => u.id === a.user_id);
      colMap[a.user_id] = { id: a.user_id, name: u ? u.name : (a.user_name || `#${a.user_id}`) };
    }
  });
  const columns = Object.values(colMap).sort((a, b) => a.name.localeCompare(b.name));
  const globalGridAbsences = (absences || []).filter(a => !a.user_id);

  if (columns.length === 0) {
    if (globalGridAbsences.length > 0) {
      const banners = globalGridAbsences.map(a => {
        const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
        const comment = a.comment ? `<span class="tl-absence-comment">${esc(a.comment)}</span>` : '';
        return `<div class="tl-absence-banner tl-absence-banner--${a.type}">${t.icon} ${t.label} <span style="font-weight:400;opacity:0.75">(gilt für alle Mitarbeiter)</span>${comment}</div>`;
      }).join('');
      return `<div style="padding:0.75rem">${banners}</div>`;
    }
    return `<div class="empty-state"><div class="icon">&#128197;</div><p>Keine Planungen für diesen Zeitraum</p></div>`;
  }

  // Einträge nach Tag+User gruppieren (ein Eintrag kann mehreren Usern zugewiesen sein)
  const lookup = {};
  entries.forEach(e => {
    e.assigned_users.forEach(u => {
      const key = e.date + '_' + u.user_id;
      if (!lookup[key]) lookup[key] = [];
      lookup[key].push(e);
    });
  });

  if (view === 'week') {
    const weekStart = new Date(range.from + 'T12:00:00');
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(formatDateISO(d));
    }

    let headerHtml = '<th class="grid-row-header">Tag</th>';
    columns.forEach((col, i) => {
      const c = PALETTE[i % PALETTE.length];
      headerHtml += `<th class="grid-col-header" style="color:${c}">${esc(col.name)}</th>`;
    });

    let bodyHtml = '';
    days.forEach((day, di) => {
      const isWeekend = di >= 5;
      const today = formatDateISO(new Date());
      const isToday = day === today;
      bodyHtml += `<tr class="${isWeekend ? 'grid-weekend' : ''} ${isToday ? 'grid-today' : ''}">`;
      bodyHtml += `<td class="grid-row-header"><strong>${dayNamesShort[di]}</strong><br><span class="grid-date">${formatDateDE(day)}</span></td>`;
      columns.forEach(col => {
        const cellEntries = lookup[day + '_' + col.id] || [];
        const cellAbsences = getAbsencesForDay(col.id, day, absences);
        bodyHtml += `<td class="grid-cell" data-plan-jump="${day}">`;
        cellAbsences.forEach(a => {
          const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
          const comment = a.comment ? `<span class="grid-absence-chip-comment">${esc(a.comment)}</span>` : '';
          bodyHtml += `<div class="grid-absence-chip grid-absence-chip--${a.type}${a.status === 'pending' ? ' grid-absence-chip--pending' : ''}" title="${t.label}">${t.icon} ${t.label}${comment}</div>`;
        });
        cellEntries.forEach(e => {
          const proj = e.project_name || e.project_text || '';
          const ec = e.color || '#f59e0b';
          bodyHtml += `<div class="grid-plan-entry" style="background:${ec}28;border-left-color:${ec};color:#374151;">${e.series_id ? '🔁 ' : ''}${entryHasReminder(e) ? '🔔 ' : ''}${e.time_from}-${e.time_to} ${e.address ? `<button class="nav-to-addr grid-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''} ${esc(proj)}${proj && e.client ? ' – ' : ''}${esc(e.client || '')}</div>`;
        });
        bodyHtml += '</td>';
      });
      bodyHtml += '</tr>';
    });

    return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table></div></div>`;
  }

  // Monatsansicht — nach KW gruppiert
  const weeks = getCalendarWeeks(range.from, range.to);
  const kwLookup = {};
  entries.forEach(e => {
    const kw = getISOWeek(e.date);
    e.assigned_users.forEach(u => {
      const key = kw + '_' + u.user_id;
      if (!kwLookup[key]) kwLookup[key] = [];
      kwLookup[key].push(e);
    });
  });

  let headerHtml = '<th class="grid-row-header">KW</th>';
  columns.forEach((col, i) => {
    const c = PALETTE[i % PALETTE.length];
    headerHtml += `<th class="grid-col-header" style="color:${c}">${esc(col.name)}</th>`;
  });

  let bodyHtml = '';
  weeks.forEach(w => {
    bodyHtml += '<tr>';
    bodyHtml += `<td class="grid-row-header"><strong>KW ${w.kw}</strong><br><span class="grid-date">${formatDateDE(w.from)} -<br>${formatDateDE(w.to)}</span></td>`;
    columns.forEach(col => {
      const cellEntries = kwLookup[w.kw + '_' + col.id] || [];
      bodyHtml += `<td class="grid-cell" data-plan-jump="${w.from}">`;

      // Abwesenheits-Chips pro Tag dieser KW
      const kwDaysWithAbsences = {};
      (absences || []).forEach(a => {
        if (a.user_id !== null && a.user_id !== col.id) return;
        // Alle Tage dieser KW die von der Abwesenheit betroffen sind
        const kwStart = new Date(w.from + 'T12:00:00');
        const kwEnd   = new Date(w.to   + 'T12:00:00');
        const abFrom  = new Date(a.date_from + 'T12:00:00');
        const abTo    = new Date(a.date_to   + 'T12:00:00');
        const cur = new Date(Math.max(kwStart, abFrom));
        const end = new Date(Math.min(kwEnd,   abTo));
        while (cur <= end) {
          const iso = formatDateISO(cur);
          if (!kwDaysWithAbsences[iso]) kwDaysWithAbsences[iso] = [];
          kwDaysWithAbsences[iso].push(a);
          cur.setDate(cur.getDate() + 1);
        }
      });

      // Tage der KW zusammenführen: Planungen + Abwesenheiten
      const allDays = new Set([
        ...Object.keys(kwDaysWithAbsences),
        ...(cellEntries.length > 0 ? cellEntries.map(e => e.date) : []),
      ]);
      [...allDays].sort().forEach(day => {
        const dayAbsences = kwDaysWithAbsences[day] || [];
        const dayEntries = cellEntries.filter(e => e.date === day);
        const dn = getDayNameShort(day);
        if (dayAbsences.length > 0) {
          dayAbsences.forEach(a => {
            const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
            const comment = a.comment ? `<span class="grid-absence-chip-comment">${esc(a.comment)}</span>` : '';
            bodyHtml += `<div class="grid-absence-chip grid-absence-chip--${a.type}${a.status === 'pending' ? ' grid-absence-chip--pending' : ''}" style="display:flex;gap:4px;" title="${t.label}"><span>${dn}</span><span>${t.icon} ${t.label}</span>${comment}</div>`;
          });
        }
        if (dayEntries.length > 0) {
          const firstColor = dayEntries[0]?.color || '#f59e0b';
          bodyHtml += `<div class="grid-kw-day grid-plan-entry" data-plan-jump="${day}" style="background:${firstColor}28;border-left-color:${firstColor};color:#374151;">
            <span class="grid-kw-dayname">${dn}</span>
            <span class="grid-kw-dayhours">${dayEntries.length} Planung${dayEntries.length > 1 ? 'en' : ''}</span>
          </div>`;
        }
      });
      bodyHtml += '</td>';
    });
    bodyHtml += '</tr>';
  });

  return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table></div></div>`;
}

// --- Planning Form ---
async function renderPlanningForm(editId, replanId, editGroupId, fromProjectId) {
  suppressTooltip();
  let entry = null;
  let replanEntry = null;
  let groupEntries = null;
  let groupAssigned = null;
  let projectSource = null;

  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    const uData = await api('GET', '/api/users/list');
    if (uData) S.users = uData.users;
  } catch (e) {}

  if (editId) {
    try {
      const data = await api('GET', '/api/planning/' + editId);
      if (data) entry = data.entry;
    } catch (e) { toast(e.message, 'error'); navigate('/planning'); return; }
  }

  if (replanId) {
    try {
      const data = await api('GET', '/api/planning/' + replanId);
      if (data) replanEntry = data.entry;
    } catch (e) { toast(e.message, 'error'); navigate('/planning'); return; }
  }

  if (editGroupId) {
    try {
      const data = await api('GET', '/api/planning/group/' + editGroupId);
      if (data) { groupEntries = data.entries; groupAssigned = data.assigned_users; }
    } catch (e) { toast(e.message, 'error'); navigate('/planning'); return; }
  }

  if (fromProjectId) {
    try {
      const data = await api('GET', '/api/projects/' + fromProjectId);
      if (data && data.project) {
        const pr = data.project;
        // Quelle wie ein Planungseintrag aufbauen → Adresse/Kunde/Projekt/Notiz/zugedachte User werden vorbefüllt.
        projectSource = { address: pr.address || '', client: pr.client || '', project_id: pr.id, project_text: '', description: pr.note || '', assigned_users: pr.assigned_users || [] };
      }
    } catch (e) {}
  }

  const isEdit = !!entry;
  const isGroupEdit = !!groupEntries;
  // Serien-Verknüpfung der bearbeiteten Occurrence (Einzel- oder Gruppen-Eintrag)
  const seriesLink = (entry && entry.series_id) ? { series_id: entry.series_id, occurrence_date: entry.occurrence_date, entry_id: entry.id }
    : (groupEntries && groupEntries[0] && groupEntries[0].series_id) ? { series_id: groupEntries[0].series_id, occurrence_date: groupEntries[0].occurrence_date, entry_id: groupEntries[0].id }
    : null;
  // Serien-Taktung laden (nur beim Bearbeiten eines Serientermins) — für die Anzeige im Formular.
  let seriesRule = null;
  if (seriesLink) { try { seriesRule = await api('GET', '/api/planning/series/' + seriesLink.series_id); } catch (_) {} }
  const seriesInfoLine = (seriesLink && seriesRule) ? (() => {
    const s = seriesRule.series || {};
    const end = s.end_type === 'count' ? ` · endet nach ${s.end_count} Terminen` : (s.end_type === 'until' ? ` · bis ${formatDateDE(s.end_until)}` : ' · läuft fortlaufend');
    // Spanne der Occurrence (mehrtägig → Bereich) aus den geladenen Tagen
    const occDates = (groupEntries ? groupEntries.map(e => e.date) : (entry ? [entry.date] : [])).slice().sort();
    const occSpan = occDates.length ? Math.round((new Date(occDates[occDates.length - 1] + 'T12:00:00') - new Date(occDates[0] + 'T12:00:00')) / 86400000) : 0;
    const addD = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return formatDateISO(d); };
    const fmtOcc = (iso) => occSpan > 0 ? `${formatDateDE(iso)}–${formatDateDE(addD(iso, occSpan))}` : formatDateDE(iso);
    const ups = seriesRule.upcoming || [];
    const moreN = (seriesRule.totalUpcoming || 0) - ups.length;
    const upLine = ups.length ? `<div style="margin-top:0.35rem">Nächste Termine: ${ups.map(fmtOcc).join(' · ')}${moreN > 0 ? ` (+${moreN} weitere)` : ''}</div>` : '';
    return `🔁 Wiederholung: ${esc(seriesRule.label)}${end}${upLine}`;
  })() : '';
  const source = replanEntry || projectSource;
  const ref = entry || (groupEntries && groupEntries[0]) || source;
  const title = isEdit ? 'Planung bearbeiten' : (isGroupEdit ? 'Planungsgruppe bearbeiten' : (projectSource ? 'Auftrag in Planung übernehmen' : (source ? 'Auftrag erneut planen' : 'Neue Planung')));
  const assignedIds = entry ? entry.assigned_users.map(u => u.user_id) : (groupAssigned ? groupAssigned.map(u => u.user_id) : (source ? source.assigned_users.map(u => u.user_id) : []));
  // Neue Planung nur mit aktiven Mitarbeitern; bereits zugewiesene (evtl. inzwischen ausgestellte) bleiben erhalten
  const _assignedSet = new Set(assignedIds);
  const workers = getWorkerUsers().filter(u => u.active !== 0 || _assignedSet.has(u.id));

  // Self-Planer (nur „sich"-Recht): keine Mitarbeiter-Auswahl, Planung läuft auf ihn selbst.
  const selfOnly = !canPlanAll();
  // Bearbeitet ein Self-Planer eine GETEILTE Planung, klinkt er sich aus und legt seine eigene an.
  const sharedEdit = selfOnly && (isEdit || isGroupEdit) && assignedIds.some(id => id !== S.user.id);

  // Tage-State für dynamische Liste
  let planDays = [];
  if (isGroupEdit) {
    planDays = groupEntries.map(e => ({ date: e.date, time_from: e.time_from, time_to: e.time_to, break_minutes: e.break_minutes }));
  } else if (isEdit) {
    planDays = [{ date: entry.date, time_from: entry.time_from, time_to: entry.time_to, break_minutes: entry.break_minutes }];
  } else {
    // Neue Planung, „In Planung übernehmen" (Projekt-Quelle) UND „Auftrag erneut planen": heute als
    // echten Standardtag (ein Tag) vorbelegen → mit einem Klick speicherbar, weiter änderbar.
    const today = formatDateISO(S.planningDate || new Date());
    planDays = [{ date: today, time_from: '07:00', time_to: '15:30', break_minutes: 30 }];
  }

  function renderDayRows() {
    if (!planDays.length) return '<div class="empty-state" style="padding:1rem;font-size:0.85rem;">Keine Tage ausgewählt</div>';
    const dayNames = ['So','Mo','Di','Mi','Do','Fr','Sa'];
    return planDays.map((d, i) => {
      const dt = new Date(d.date + 'T12:00:00');
      const dn = dayNames[dt.getDay()];
      return `<div class="plan-day-row" data-idx="${i}">
        <button type="button" class="btn btn-danger btn-sm plan-day-del" data-idx="${i}" title="Tag entfernen">&#10005;</button>
        <span class="plan-day-label">${dn}, ${formatDateDE(d.date)}</span>
        <input type="time" class="form-control plan-day-from" data-idx="${i}" value="${d.time_from}">
        <span>–</span>
        <input type="time" class="form-control plan-day-to" data-idx="${i}" value="${d.time_to}">
        <span>Pause</span>
        <input type="number" class="form-control plan-day-break" data-idx="${i}" value="${d.break_minutes}" min="0" step="5" style="width:60px">
        <span>min</span>
      </div>`;
    }).join('');
  }

  function getDateRange() {
    if (!planDays.length) return { from: formatDateISO(new Date()), to: formatDateISO(new Date()) };
    const sorted = planDays.map(d => d.date).sort();
    return { from: sorted[0], to: sorted[sorted.length - 1] };
  }

  function generateWeekdays(from, to) {
    const days = [];
    const start = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    const cur = new Date(start);
    const maxDays = 100; // ~3 Monate Sicherheit
    let count = 0;
    while (cur <= end && count < maxDays) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) {
        days.push(formatDateISO(cur));
      }
      cur.setDate(cur.getDate() + 1);
      count++;
    }
    return days;
  }

  function rebuildDaysFromRange() {
    const from = document.getElementById('pf-date-from').value;
    const to = document.getElementById('pf-date-to').value;
    if (!from || !to || from > to) return;
    // Prüfe 3-Monats-Limit
    const diffMs = new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00');
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays > 93) { toast('Maximaler Zeitraum: 3 Monate', 'error'); return; }
    const newDates = generateWeekdays(from, to);
    // Bestehende Zeiten beibehalten wenn Tag schon existiert
    const existing = {};
    planDays.forEach(d => { existing[d.date] = d; });
    planDays = newDates.map(date => existing[date] || { date, time_from: '07:00', time_to: '15:30', break_minutes: 30 });
    refreshDayList();
  }

  function refreshDayList() {
    const container = document.getElementById('plan-days-list');
    if (container) container.innerHTML = renderDayRows();
    bindDayEvents();
    if (typeof updateRecurAll === 'function') updateRecurAll(); // Serien-Vorschau/Labels an Datum anpassen
  }

  function bindDayEvents() {
    document.querySelectorAll('.plan-day-del').forEach(btn => {
      btn.addEventListener('click', () => {
        planDays.splice(Number(btn.dataset.idx), 1);
        refreshDayList();
      });
    });
    document.querySelectorAll('.plan-day-from').forEach(inp => {
      inp.addEventListener('change', () => { planDays[Number(inp.dataset.idx)].time_from = inp.value; });
    });
    document.querySelectorAll('.plan-day-to').forEach(inp => {
      inp.addEventListener('change', () => { planDays[Number(inp.dataset.idx)].time_to = inp.value; });
    });
    document.querySelectorAll('.plan-day-break').forEach(inp => {
      inp.addEventListener('change', () => { planDays[Number(inp.dataset.idx)].break_minutes = parseInt(inp.value) || 0; });
    });
  }

  const dateRange = getDateRange();
  // „Mehrere Tage" nur bei tatsächlich >1 Tag. (Eintägige Serien-Occurrences sind zwar Gruppen,
  // sollen aber als Einzeltag erscheinen — daher nicht pauschal isGroupEdit.)
  let multiMode = planDays.length > 1;

  function renderSingleDaySection() {
    const day = planDays[0] || { date: formatDateISO(new Date()), time_from: '07:00', time_to: '15:30', break_minutes: 30 };
    return `
      <div class="form-row">
        <div class="form-group">
          <label>Datum</label>
          <input type="date" class="form-control" id="pf-single-date" value="${day.date}">
        </div>
        <div class="form-group">
          <label>Von</label>
          <input type="time" class="form-control" id="pf-single-from" value="${day.time_from}">
        </div>
        <div class="form-group">
          <label>Bis</label>
          <input type="time" class="form-control" id="pf-single-to" value="${day.time_to}">
        </div>
        <div class="form-group">
          <label>Pause (min)</label>
          <input type="number" class="form-control" id="pf-single-break" value="${day.break_minutes}" min="0" step="5" style="width:80px">
        </div>
      </div>`;
  }

  function renderMultiDaySection() {
    const dr = getDateRange();
    return `
      <div class="form-row">
        <div class="form-group">
          <label>Von-Datum</label>
          <input type="date" class="form-control" id="pf-date-from" value="${dr.from}">
        </div>
        <div class="form-group">
          <label>Bis-Datum</label>
          <input type="date" class="form-control" id="pf-date-to" value="${dr.to}">
        </div>
        <div class="form-group" style="display:flex;align-items:flex-end;">
          <button type="button" class="btn btn-outline btn-sm" id="pf-gen-days">Tage generieren</button>
        </div>
      </div>
      <div class="form-group">
        <label>Tage</label>
        <div id="plan-days-list" class="plan-days-list">
          ${renderDayRows()}
        </div>
        <div class="plan-day-add" style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:center;">
          <input type="date" class="form-control" id="pf-add-day" style="width:auto;">
          <button type="button" class="btn btn-outline btn-sm" id="pf-add-day-btn">+ Tag hinzufügen</button>
        </div>
      </div>`;
  }

  function refreshDateSection() {
    const container = document.getElementById('plan-date-section');
    if (!container) return;
    container.innerHTML = multiMode ? renderMultiDaySection() : renderSingleDaySection();
    bindDateSectionEvents();
  }

  function bindDateSectionEvents() {
    if (multiMode) {
      document.getElementById('pf-gen-days')?.addEventListener('click', rebuildDaysFromRange);
      document.getElementById('pf-date-from')?.addEventListener('change', rebuildDaysFromRange);
      document.getElementById('pf-date-to')?.addEventListener('change', rebuildDaysFromRange);
      document.getElementById('pf-add-day-btn')?.addEventListener('click', () => {
        const dateInput = document.getElementById('pf-add-day');
        const newDate = dateInput.value;
        if (!newDate) { toast('Bitte Datum auswählen', 'error'); return; }
        if (planDays.some(d => d.date === newDate)) { toast('Tag bereits vorhanden', 'error'); return; }
        planDays.push({ date: newDate, time_from: '07:00', time_to: '15:30', break_minutes: 30 });
        planDays.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
        dateInput.value = '';
        refreshDayList();
      });
      bindDayEvents();
    } else {
      // Einzeltag-Inputs live in planDays[0] syncen
      const syncSingle = () => {
        const d = document.getElementById('pf-single-date')?.value;
        const f = document.getElementById('pf-single-from')?.value;
        const t = document.getElementById('pf-single-to')?.value;
        const b = parseInt(document.getElementById('pf-single-break')?.value) || 0;
        planDays = [{ date: d, time_from: f, time_to: t, break_minutes: b }];
      };
      document.getElementById('pf-single-date')?.addEventListener('change', syncSingle);
      document.getElementById('pf-single-from')?.addEventListener('change', syncSingle);
      document.getElementById('pf-single-to')?.addEventListener('change', syncSingle);
      document.getElementById('pf-single-break')?.addEventListener('change', syncSingle);
    }
  }

  const content = `
    <div class="card" style="max-width:700px;margin:0 auto;">
      <div class="card-header">
        <h2>${title}</h2>
        <button class="btn btn-outline btn-sm" id="back-btn">Zurück</button>
      </div>
      <form id="planning-form">
        ${seriesInfoLine ? `<div class="form-group"><div class="planning-series-banner" style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:0.6rem 0.8rem;font-size:0.9rem;">${seriesInfoLine}<div style="color:var(--text-light);font-size:0.82rem;margin-top:0.2rem;">Änderungen fragen den Umfang ab (nur dieser / folgende / ganze Serie). Die Taktung kannst du unten unter „Wiederholung" ändern (gilt ab diesem Termin oder ganze Serie).</div></div></div>` : ''}
        ${selfOnly ? `
        <div class="form-group">
          <label>Geplant für</label>
          <div class="planning-self-target">${esc(S.user.name)} (nur du)</div>
          ${sharedEdit ? `<div class="form-hint">Du klinkst dich aus der gemeinsamen Planung aus und legst deine eigene an.</div>` : ''}
        </div>` : `
        <div class="form-group">
          <label>Mitarbeiter zuweisen</label>
          <div class="planning-user-checkboxes">
            ${workers.map(u => `
              <label><input type="checkbox" name="assigned" value="${u.id}" ${assignedIds.includes(u.id) ? 'checked' : ''}> ${esc(u.name)} (${roleName(u.role)})</label>
            `).join('')}
          </div>
        </div>`}
        <div class="plan-mode-toggle">
          <span class="${!multiMode ? 'active' : ''}" id="lbl-single">Einzeltag</span>
          <label class="toggle-switch">
            <input type="checkbox" id="pf-multi-toggle" ${multiMode ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span class="${multiMode ? 'active' : ''}" id="lbl-multi">Mehrere Tage</span>
        </div>
        <div id="plan-date-section">
          ${multiMode ? renderMultiDaySection() : renderSingleDaySection()}
        </div>
        <div class="form-group">
          <label>Adresse / Arbeitsort</label>
          <div class="input-with-btn">
            <input type="text" class="form-control" id="pf-address" value="${esc(ref?.address || '')}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
            <button type="button" class="btn btn-outline btn-sm btn-nav" id="pf-nav" title="Navigation starten">&#128506;</button>
          </div>
          ${navPref() ? '<button type="button" class="link-btn nav-change-link" id="pf-nav-change">Navigations-App ändern</button>' : ''}
        </div>
        <div class="form-group">
          <label>Kunde</label>
          <input type="text" class="form-control" id="pf-client" value="${esc(ref?.client || '')}" placeholder="Kundenname">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Projekt (Auswahl)</label>
            <select class="form-control" id="pf-project">
              <option value="">-- Kein Projekt --</option>
              ${S.projects.map(p => `<option value="${p.id}" ${p.id == (ref?.project_id || '') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Oder Freitext</label>
            <input type="text" class="form-control" id="pf-project-text" value="${ref?.project_id ? '' : esc(ref?.project_text || '')}" placeholder="Projektname" ${ref?.project_id ? 'disabled' : ''}>
          </div>
        </div>
        <div class="form-group">
          <label>Beschreibung</label>
          <textarea class="form-control" id="pf-desc" rows="3" placeholder="Was soll gemacht werden?">${esc(ref?.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Farbe</label>
          <div class="color-picker-row">
            <input type="color" id="pf-color" class="color-picker-input" value="${ref?.color || '#f59e0b'}">
            <span class="color-swatches">
              <span class="color-swatch" data-color="#f59e0b" style="background:#f59e0b" title="Orange"></span>
              <span class="color-swatch" data-color="#3b82f6" style="background:#3b82f6" title="Blau"></span>
              <span class="color-swatch" data-color="#22c55e" style="background:#22c55e" title="Gr\u00fcn"></span>
              <span class="color-swatch" data-color="#ef4444" style="background:#ef4444" title="Rot"></span>
              <span class="color-swatch" data-color="#a855f7" style="background:#a855f7" title="Lila"></span>
              <span class="color-swatch" data-color="#14b8a6" style="background:#14b8a6" title="T\u00fcrkis"></span>
            </span>
          </div>
        </div>
        <div class="form-group" id="pf-recur-group">
          <label>${seriesLink ? 'Wiederholung (Taktung ändern)' : 'Wiederholung (Serientermin)'}</label>
          <select class="form-control" id="pf-recur">
            <option value="">Keine (einmalig)</option>
            <option value="weekly"></option>
            <option value="monthly_date"></option>
            <option value="monthly_weekday"></option>
            <option value="yearly_weekday"></option>
            <option value="yearly"></option>
          </select>
          <div id="pf-recur-end" style="display:none;margin-top:0.6rem;font-size:0.9rem">
            <div style="margin-bottom:0.3rem"><label style="font-weight:normal"><input type="radio" name="pfrend" value="never" checked> kein Ende (läuft weiter)</label></div>
            <div style="margin-bottom:0.3rem"><label style="font-weight:normal"><input type="radio" name="pfrend" value="count"> nach <input type="number" id="pf-recur-count" value="10" min="1" max="500" style="width:70px"> Terminen</label></div>
            <div><label style="font-weight:normal"><input type="radio" name="pfrend" value="until"> bis <input type="date" id="pf-recur-until" style="width:auto"></label></div>
          </div>
          <div id="pf-recur-preview" class="push-hint" style="display:none;margin-top:0.5rem"></div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">${(isEdit || isGroupEdit) ? 'Speichern' : 'Planung erstellen'}</button>
        ${(isEdit || isGroupEdit) ? `<button type="button" class="btn btn-outline btn-block" id="replan-entry" style="margin-top:0.5rem">Auftrag erneut planen</button>` : ''}
        ${((isEdit || isGroupEdit) && seriesLink) ? `<button type="button" class="btn btn-outline btn-block" id="series-stop-here" style="margin-top:0.5rem">🔁✕ Ab hier keine Wiederholung mehr</button>` : ''}
        ${(isEdit || isGroupEdit) ? '<button type="button" class="btn btn-danger btn-block" id="delete-planning" style="margin-top:0.5rem">Planung löschen</button>' : ''}
      </form>
    </div>`;

  // ——— Wiederholung/Serientermin (nur Neu-Anlegen) ———
  const WD_DE = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const MO_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  function recurLabelJS(freq, anchorISO) {
    const d = new Date(anchorISO + 'T12:00:00'); const day = d.getDate(); const w = d.getDay(); const m = d.getMonth();
    const nth = ['', '1.', '2.', '3.', '4.', '5.'][Math.floor((day - 1) / 7) + 1] || '';
    return { weekly:`wöchentlich (jeden ${WD_DE[w]})`, monthly_date:`monatlich (jeden Monat am ${day}.)`, monthly_weekday:`monatlich (jeden ${nth} ${WD_DE[w]})`, yearly:`jährlich (am ${day}.${m + 1}.)`, yearly_weekday:`jährlich (${nth} ${WD_DE[w]} im ${MO_DE[m]})` }[freq] || '';
  }
  const currentAnchor = () => getDateRange().from;
  function fillRecurOptions() {
    const sel = document.getElementById('pf-recur'); if (!sel) return;
    const a = currentAnchor();
    ['weekly','monthly_date','monthly_weekday','yearly_weekday','yearly'].forEach(f => { const o = sel.querySelector(`option[value="${f}"]`); if (o) o.textContent = recurLabelJS(f, a); });
  }
  function getRecurrence() {
    const sel = document.getElementById('pf-recur'); if (!sel || !sel.value) return null;
    const end = document.querySelector('input[name="pfrend"]:checked')?.value || 'never';
    const r = { freq: sel.value, end_type: end };
    if (end === 'count') r.end_count = Number(document.getElementById('pf-recur-count').value) || 1;
    if (end === 'until') r.end_until = document.getElementById('pf-recur-until').value;
    return r;
  }
  let recurTimer = null;
  async function updateRecurPreview() {
    const box = document.getElementById('pf-recur-preview'); const endBox = document.getElementById('pf-recur-end');
    if (!box) return;
    const rec = getRecurrence();
    if (endBox) endBox.style.display = rec ? '' : 'none';
    if (!rec || (rec.end_type === 'until' && !rec.end_until)) { box.style.display = 'none'; return; }
    const sorted = planDays.map(d => d.date).sort();
    const spanDays = sorted.length ? Math.round((new Date(sorted[sorted.length - 1] + 'T12:00:00') - new Date(sorted[0] + 'T12:00:00')) / 86400000) : 0;
    try {
      const r = await api('POST', '/api/planning/series/preview', { recurrence: rec, anchor_date: currentAnchor(), span_days: spanDays });
      const endOf = (iso) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + spanDays); return formatDateDE(formatDateISO(d)); };
      const dates = r.occurrences.map(d => spanDays > 0 ? `${formatDateDE(d)} – ${endOf(d)}` : formatDateDE(d)).join(' · ');
      const more = r.bounded ? `${r.total} Termine` : 'läuft weiter …';
      box.style.display = '';
      box.innerHTML = `🔁 ${esc(r.label)} — ${more}<br>Nächste: ${dates}${r.occurrences.length < r.total ? ' …' : ''}`
        + (r.overlap ? `<br><span style="color:#b45309">⚠ Die Wiederholungen überschneiden sich – die Termine werden dann nebeneinander angezeigt.</span>` : '');
    } catch (_) { box.style.display = 'none'; }
  }
  const updateRecurAll = () => { if (!document.getElementById('pf-recur')) return; fillRecurOptions(); updateRecurPreview(); };
  function setupRecurrence() {
    const sel = document.getElementById('pf-recur'); if (!sel) return;
    fillRecurOptions();
    // Bestehende Serie: aktuelle Taktung vorbelegen (damit man sie sieht und ändern kann)
    if (seriesLink && seriesRule && seriesRule.series) {
      const s = seriesRule.series;
      sel.value = s.freq || '';
      const endRadio = document.querySelector(`input[name="pfrend"][value="${s.end_type || 'never'}"]`);
      if (endRadio) endRadio.checked = true;
      if (s.end_type === 'count' && document.getElementById('pf-recur-count')) document.getElementById('pf-recur-count').value = s.end_count || 1;
      if (s.end_type === 'until' && document.getElementById('pf-recur-until')) document.getElementById('pf-recur-until').value = s.end_until || '';
    }
    const deb = () => { clearTimeout(recurTimer); recurTimer = setTimeout(updateRecurPreview, 250); };
    sel.addEventListener('change', updateRecurPreview);
    document.querySelectorAll('input[name="pfrend"]').forEach(r => r.addEventListener('change', updateRecurPreview));
    document.getElementById('pf-recur-count')?.addEventListener('input', () => { const c = document.querySelector('input[name="pfrend"][value="count"]'); if (c) c.checked = true; deb(); });
    document.getElementById('pf-recur-until')?.addEventListener('change', () => { const u = document.querySelector('input[name="pfrend"][value="until"]'); if (u) u.checked = true; updateRecurPreview(); });
    document.getElementById('pf-single-date')?.addEventListener('change', () => setTimeout(updateRecurAll, 0));
    updateRecurPreview(); // Bei bestehender Serie: Ende-Optionen + Vorschau direkt zeigen
  }

  $app().innerHTML = layout(content, 'planning');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';
  bindDateSectionEvents();
  setupRecurrence();

  document.querySelectorAll('.color-swatch').forEach(s => {
    s.addEventListener('click', () => {
      document.getElementById('pf-color').value = s.dataset.color;
    });
  });

  document.getElementById('back-btn').addEventListener('click', () => navigate('/planning'));

  // Toggle Einzeltag / Mehrere Tage
  document.getElementById('pf-multi-toggle').addEventListener('change', (e) => {
    multiMode = e.target.checked;
    document.getElementById('lbl-single').classList.toggle('active', !multiMode);
    document.getElementById('lbl-multi').classList.toggle('active', multiMode);
    if (multiMode && planDays.length === 0) {
      planDays = [{ date: formatDateISO(new Date()), time_from: '07:00', time_to: '15:30', break_minutes: 30 }];
    }
    refreshDateSection();
  });

  // Projekt-Auswahl: Adresse/Kunde/Notiz übernehmen + Freitext steuern
  document.getElementById('pf-project').addEventListener('change', (e) => {
    const proj = S.projects.find(p => p.id == e.target.value);
    if (proj) {
      if (proj.address) document.getElementById('pf-address').value = proj.address;
      if (proj.client) document.getElementById('pf-client').value = proj.client;
      const d = document.getElementById('pf-desc'); if (d && proj.note) d.value = proj.note;
    }
    const ft = document.getElementById('pf-project-text');
    if (e.target.value) {
      ft.value = '';
      ft.disabled = true;
    } else {
      ft.disabled = false;
    }
  });

  document.getElementById('pf-nav').addEventListener('click', () => {
    const addr = document.getElementById('pf-address').value.trim();
    if (addr) openNav(addr); else toast('Keine Adresse eingetragen', 'error');
  });
  const pfNavChange = document.getElementById('pf-nav-change');
  if (pfNavChange) pfNavChange.addEventListener('click', () => {
    const addr = document.getElementById('pf-address').value.trim();
    if (addr) openNav(addr, { force: true }); else toast('Keine Adresse eingetragen', 'error');
  });

  // Entwurfs-Sicherung (B4). Die ausgewaehlten Tage stehen NICHT in Feldern mit Kennung, sondern
  // in planDays — deshalb ueber den Zusatz-Haken mitsichern, sonst ginge die Mehrtages-Auswahl
  // beim Wiederherstellen verloren.
  const entwurfName = 'planung:' + (editId ? 'e' + editId : editGroupId ? 'g' + editGroupId
    : replanId ? 'r' + replanId : fromProjectId ? 'p' + fromProjectId : 'neu');
  initDraftKeeper(document.getElementById('planning-form'), entwurfName, {
    zusatzLesen: () => ({ tage: planDays, mehrtags: multiMode }),
    zusatzSchreiben: z => {
      if (Array.isArray(z.tage)) planDays = z.tage;
      if (typeof z.mehrtags === 'boolean') {
        multiMode = z.mehrtags;
        const t = document.getElementById('pf-multi-toggle');
        if (t) { t.checked = multiMode; t.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      refreshDayList();
    },
  });

  document.getElementById('planning-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Self-Planer: immer auf sich selbst; sonst die angehakten Mitarbeiter.
    const checked = selfOnly ? [S.user.id] : [...document.querySelectorAll('input[name="assigned"]:checked')].map(cb => Number(cb.value));
    if (!checked.length) { toast('Mindestens einen Mitarbeiter zuweisen', 'error'); return; }
    if (!planDays.length) { toast('Mindestens einen Tag hinzufügen', 'error'); return; }

    const common = {
      address: document.getElementById('pf-address').value,
      client: document.getElementById('pf-client').value,
      project_id: document.getElementById('pf-project').value || null,
      project_text: document.getElementById('pf-project-text').value,
      description: document.getElementById('pf-desc').value,
      color: document.getElementById('pf-color').value,
      assigned_user_ids: checked,
    };

    // Im Single-Modus nur Tag 1 senden, im Multi-Modus alle Tage
    const daysToSend = multiMode ? planDays : (planDays.length ? [planDays[0]] : []);
    if (!daysToSend.length) { toast('Mindestens einen Tag hinzufügen', 'error'); return; }

    const seriesInfo = seriesLink;
    const rec = getRecurrence();
    if (rec && rec.end_type === 'until' && !rec.end_until) { toast('Bitte ein Enddatum für die Serie wählen', 'error'); return; }

    try {
      // A) Normale Planung im Bearbeiten → in eine Serie umwandeln
      if ((isEdit || isGroupEdit) && !seriesInfo && rec) {
        const body = { ...common, days: daysToSend, recurrence: rec };
        if (isGroupEdit) body.group_id = editGroupId; else body.entry_id = editId;
        // Ist für diese Planung eine eigene Benachrichtigung gesetzt? → fragen, wie sie auf die Serie übergeht.
        try {
          const qs = isGroupEdit ? ('group_id=' + encodeURIComponent(editGroupId)) : ('entry_id=' + encodeURIComponent(editId));
          const rl = await api('GET', '/api/planning/reminders?' + qs);
          if (rl && rl.reminders && rl.reminders.length) {
            const remScope = await choiceModal('Für diese Planung ist eine Benachrichtigung gesetzt. Wie soll sie auf die Serie übertragen werden?', [
              { value: 'all', label: 'Für alle Termine der Serie', primary: true },
              { value: 'following', label: 'Für diesen + alle folgenden' },
              { value: 'occurrence', label: 'Nur für diesen Termin' },
            ], { title: 'Benachrichtigung übertragen' });
            if (!remScope) return; // abgebrochen → nichts tun
            body.reminder_scope = remScope;
          }
        } catch (_) {}
        const r = await api('POST', '/api/planning/to-series', body);
        toast(`Serie erstellt (${r.count} Termine)`, 'success');
        navigate('/planning'); return;
      }
      // B) Serientermin bearbeiten
      if ((isEdit || isGroupEdit) && seriesInfo) {
        const sr = (seriesRule && seriesRule.series) || {};
        const sameRec = rec && rec.freq === sr.freq && rec.end_type === sr.end_type
          && (rec.end_type !== 'count' || Number(rec.end_count) === Number(sr.end_count))
          && (rec.end_type !== 'until' || rec.end_until === (sr.end_until || ''));
        // B1) Taktung auf „Keine" → Wiederholung entfernen: ab hier beenden ODER nur diesen behalten
        if (!rec) {
          const how = await choiceModal('Wiederholung entfernen – wie?', [
            { value: 'stop', label: 'Ab diesem Termin beenden (frühere Termine bleiben)', primary: true },
            { value: 'keep', label: 'Nur diesen Termin behalten (Serie auflösen, Rest löschen)' },
          ], { title: 'Wiederholung entfernen' });
          if (!how) return;
          if (how === 'keep') {
            await api('POST', '/api/planning/series/' + seriesInfo.series_id + '/keep-single', { occurrence_date: seriesInfo.occurrence_date });
            toast('Serie aufgelöst – dieser Termin bleibt als Einzelplanung', 'success');
          } else {
            await api('POST', '/api/planning/series/' + seriesInfo.series_id + '/stop', { after: seriesInfo.occurrence_date });
            toast('Wiederholung ab hier beendet', 'success');
          }
          navigate('/planning'); return;
        }
        // B2) Taktung geändert → Umtakten (Split): ab wann?
        if (!sameRec) {
          const scope = await choiceModal('Die neue Taktung – ab wann soll sie gelten? (Vergangenes bleibt immer unverändert.)', [
            { value: 'following', label: 'Ab diesem Termin (spätere neu takten)', primary: true },
            { value: 'series', label: 'Ab heute (alle künftigen neu takten)' },
          ], { title: 'Wiederholung ändern' });
          if (!scope) return;
          const r = await api('POST', '/api/planning/series/' + seriesInfo.series_id + '/retakt', { scope, occurrence_date: seriesInfo.occurrence_date, ...common, days: daysToSend, recurrence: rec });
          toast(`Wiederholung geändert (${r.count} Termine)`, 'success'); navigate('/planning'); return;
        }
        // B3) Taktung unverändert → Felder/Tage mit Umfang-Dialog
        const scope = await choiceModal('Serientermin bearbeiten: Was soll geändert werden?', [
          { value: 'occurrence', label: 'Nur diesen Termin' },
          { value: 'following', label: 'Diesen + alle folgenden' },
          { value: 'series', label: 'Ganze Serie' },
        ], { title: 'Serientermin bearbeiten', primary: true });
        if (!scope) return;
        if (scope === 'occurrence') {
          if (isGroupEdit) await api('PUT', '/api/planning/group/' + editGroupId, { ...common, days: daysToSend });
          else await api('PUT', '/api/planning/' + editId, { ...common, days: daysToSend });
        } else {
          const d0 = daysToSend[0] || {};
          await api('PUT', '/api/planning/series/' + seriesInfo.series_id, { scope, occurrence_date: seriesInfo.occurrence_date, ...common, days: daysToSend, time_from: d0.time_from, time_to: d0.time_to, break_minutes: d0.break_minutes });
        }
        toast('Gespeichert', 'success');
        entwurfLoeschen(entwurfName);
        navigate('/planning');
        return;
      }
      if (isEdit) {
        // Einzeleintrag bearbeiten — bei >1 Tag konvertiert Backend zu Gruppe
        await api('PUT', '/api/planning/' + editId, { ...common, days: daysToSend });
        toast('Planung aktualisiert', 'success');
      } else if (isGroupEdit) {
        // Gruppe aktualisieren — bei =1 Tag schrumpft Backend zu Single
        await api('PUT', '/api/planning/group/' + editGroupId, { ...common, days: daysToSend });
        toast('Planungsgruppe aktualisiert', 'success');
      } else {
        // Neue Planung (einzeln, Gruppe ODER Serie)
        const recurrence = getRecurrence();
        if (recurrence) {
          if (recurrence.end_type === 'until' && !recurrence.end_until) { toast('Bitte ein Enddatum für die Serie wählen', 'error'); return; }
          const r = await api('POST', '/api/planning', { ...common, days: daysToSend, recurrence });
          toast(r.overlap ? `Serie erstellt (${r.count} Termine) – Hinweis: Wiederholungen überschneiden sich` : `Serie erstellt (${r.count} Termine)`, r.overlap ? 'info' : 'success');
        } else if (daysToSend.length === 1) {
          const day = daysToSend[0];
          await api('POST', '/api/planning', { ...common, date: day.date, time_from: day.time_from, time_to: day.time_to, break_minutes: day.break_minutes });
          toast('Planung erstellt', 'success');
        } else {
          await api('POST', '/api/planning', { ...common, days: daysToSend });
          toast('Planung erstellt', 'success');
        }
      }
      entwurfLoeschen(entwurfName);   // gespeichert → Entwurf hat sich erledigt
      navigate('/planning');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('replan-entry')?.addEventListener('click', () => {
    navigate('/planning/replan/' + (editId || (groupEntries && groupEntries[0] && groupEntries[0].id)));
  });

  // „Ab hier keine Wiederholung mehr": diese Occurrence + Vergangenes bleiben, spätere weg.
  // Danach optional direkt eine neue (ggf. anders getaktete) Serie ab hier planen.
  document.getElementById('series-stop-here')?.addEventListener('click', async () => {
    if (!seriesLink) return;
    if (!(await confirmModal('Ab diesem Termin keine Wiederholung mehr?\n\nDieser Termin und alle vergangenen bleiben erhalten – alle späteren Wiederholungen werden entfernt.', { title: 'Wiederholung ab hier beenden', okLabel: 'Ab hier beenden' }))) return;
    try {
      await api('POST', '/api/planning/series/' + seriesLink.series_id + '/stop', { after: seriesLink.occurrence_date });
      const next = await choiceModal('Wiederholung ab hier beendet. Möchtest du ab hier eine neue Serie planen (z. B. mit anderer Taktung)?', [
        { value: 'new', label: '＋ Neue Serie ab hier planen', primary: true },
        { value: 'done', label: 'Nein, fertig' },
      ], { title: 'Fertig' });
      if (next === 'new') navigate('/planning/replan/' + seriesLink.entry_id);
      else { toast('Wiederholung ab hier beendet', 'success'); navigate('/planning'); }
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('delete-planning')?.addEventListener('click', async () => {
    try {
      if (seriesLink) {
        // Serientermin → gleicher Umfang-Dialog wie im ⋮-Menü der Tagesansicht
        const scope = await choiceModal('Dieser Termin gehört zu einer Serie. Was möchtest du löschen?', [
          { value: 'occurrence', label: '✕ Nur diesen Termin', danger: true },
          { value: 'following', label: '✕ Diesen + alle folgenden', danger: true },
          { value: 'series', label: '✕ Ganze Serie', danger: true },
          { value: 'stop', label: '⏹ Serie ab heute beenden (Vergangenes bleibt)' },
        ], { title: 'Serientermin löschen' });
        if (!scope) return;
        if (scope === 'stop') await api('POST', '/api/planning/series/' + seriesLink.series_id + '/stop', {});
        else await api('DELETE', '/api/planning/series/' + seriesLink.series_id, { scope, occurrence_date: seriesLink.occurrence_date });
        toast(scope === 'stop' ? 'Serie beendet' : 'Gelöscht', 'success');
      } else {
        if (!(await confirmModal('Planung wirklich löschen?', { title: 'Planung löschen', okLabel: 'Löschen' }))) return;
        if (isGroupEdit) await api('DELETE', '/api/planning/group/' + editGroupId);
        else await api('DELETE', '/api/planning/' + editId);
        toast('Planung gelöscht', 'success');
      }
      entwurfLoeschen(entwurfName);   // Datensatz ist weg → ein Entwurf dazu waere sinnlos
      navigate('/planning');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Werkzeugliste ---
async function renderTools() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'tools');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  let tools = [];
  let projects = [];
  try {
    const data = await api('GET', '/api/tools');
    if (data) tools = data.tools;
    const pData = await api('GET', '/api/projects');
    if (pData) projects = pData.projects;
  } catch (e) {}

  const canManage = S.user.role === 'admin' || S.user.role === 'chef';

  const fmtDT = (dt) => {
    if (!dt) return '';
    const [d, t] = dt.split(' ');
    const [y, m, dd] = d.split('-');
    return `${dd}.${m}.${y} ${t ? t.slice(0, 5) : ''}`;
  };

  const projectOptions = `<option value="">-- Kein Projekt --</option>` +
    projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  function checkoutFormHtml(toolId, confirmLabel, endpoint) {
    return `<div class="tool-checkout-form" id="tcf-${toolId}" style="display:none;">
      <div class="form-row">
        <div class="form-group" style="flex:1;min-width:140px;">
          <label>Projekt</label>
          <select class="form-control" id="tcf-proj-${toolId}">${projectOptions}</select>
        </div>
        <div class="form-group" style="flex:1;min-width:120px;">
          <label>Oder Freitext</label>
          <input type="text" class="form-control" id="tcf-text-${toolId}" placeholder="Projektname">
        </div>
        <div class="form-group" style="flex:2;min-width:160px;">
          <label>Adresse</label>
          <input type="text" class="form-control" id="tcf-addr-${toolId}" placeholder="Adresse (optional)">
        </div>
        <div style="display:flex;gap:0.4rem;align-items:flex-end;padding-bottom:0.1rem;">
          <button class="btn btn-outline btn-sm tcf-cancel" data-id="${toolId}">Abbrechen</button>
          <button class="btn btn-primary btn-sm tcf-confirm" data-id="${toolId}" data-endpoint="${endpoint}">${confirmLabel}</button>
        </div>
      </div>
    </div>`;
  }

  let toolsHtml = '';
  if (tools.length === 0) {
    toolsHtml = '<p style="color:var(--text-light)">Noch keine Werkzeuge angelegt.</p>';
  } else {
    toolsHtml = tools.map(t => {
      const isOut = !!t.checkout_id;
      const isMine = isOut && t.checked_out_by === S.user.id;
      const statusClass = isOut ? 'tool-out' : 'tool-in';

      const locationParts = [
        t.checkout_project_name || t.checkout_project_text || '',
        t.checkout_address || ''
      ].filter(Boolean);
      const locationHtml = isOut && locationParts.length
        ? `<span style="font-size:0.78rem;color:var(--text-light);">&#128205; ${esc(locationParts.join(' / '))}</span>`
        : '';

      const statusText = isOut
        ? `${esc(t.checked_out_by_name)} seit ${fmtDT(t.checked_out_at)}`
        : 'Im Lager';

      let actions = '';
      let inlineForm = '';
      if (!isOut) {
        actions = `<button class="btn btn-sm btn-primary tool-checkout" data-id="${t.id}">Entnehmen</button>`;
        inlineForm = checkoutFormHtml(t.id, '&#10003; Entnehmen', 'checkout');
      } else if (isMine) {
        actions = `<button class="btn btn-sm btn-success tool-return" data-id="${t.id}">Zurückgeben</button>`;
      } else {
        actions = `<button class="btn btn-sm btn-outline tool-takeover" data-id="${t.id}">Übernehmen</button>`;
        inlineForm = checkoutFormHtml(t.id, '&#10003; Übernehmen', 'takeover');
      }

      // Suchtext (B6): Name, wer es hat und wo — genau die Angaben, die auch sichtbar sind.
      const suchtext = [t.name, statusText, locationParts.join(' ')].filter(Boolean).join(' ');
      return `<div class="tool-item ${statusClass}" data-suchtext="${esc(suchtext)}">
        <div class="tool-info">
          <strong>${esc(t.name)}</strong>
          <span class="tool-status">${statusText}</span>
          ${locationHtml}
        </div>
        <div class="tool-actions">
          ${actions}
          <button class="btn btn-sm btn-outline tool-history" data-id="${t.id}" data-name="${esc(t.name)}">Historie</button>
          ${canManage ? `<button class="btn btn-sm btn-outline tool-edit" data-id="${t.id}" data-name="${esc(t.name)}" aria-label="Werkzeug ${esc(t.name)} umbenennen" title="Umbenennen">&#9998;</button>` : ''}
          ${canManage ? `<button class="btn btn-sm btn-danger tool-delete" data-id="${t.id}" aria-label="Werkzeug ${esc(t.name)} löschen" title="Löschen">&#10005;</button>` : ''}
        </div>
        ${inlineForm}
      </div>`;
    }).join('');
  }

  mainEl.innerHTML = `
    <div class="card" style="max-width:800px;margin:0 auto;">
      <div class="card-header">
        <h2>&#128295; Werkzeugliste</h2>
      </div>
      ${canManage ? `
      <div class="form-row" style="margin-bottom:1rem;gap:0.5rem;">
        <input type="text" class="form-control" id="tool-name" placeholder="Werkzeugname" style="flex:1;">
        <button class="btn btn-primary" id="tool-add">Hinzufügen</button>
      </div>` : ''}
      ${tools.length ? listenSucheHtml('werkzeug', 'Werkzeug, Person oder Ort suchen …') : ''}
      <div id="tools-list">${toolsHtml}</div>
    </div>
    <div id="tool-history-modal" class="modal-overlay" style="display:none;">
      <div class="card" style="max-width:500px;margin:2rem auto;max-height:80vh;overflow-y:auto;">
        <div class="card-header">
          <h3 id="history-title">Historie</h3>
          <button class="btn btn-outline btn-sm" id="history-close">Schließen</button>
        </div>
        <div id="history-content"></div>
      </div>
    </div>`;

  bindListenSuche('werkzeug', '#tools-list');

  // Werkzeug hinzufügen
  document.getElementById('tool-add')?.addEventListener('click', async () => {
    const nameEl = document.getElementById('tool-name');
    const name = nameEl.value.trim();
    if (!name) { toast('Bitte einen Namen eingeben', 'error'); return; }
    try {
      await api('POST', '/api/tools', { name });
      toast('Werkzeug hinzugefügt', 'success');
      renderTools();
    } catch (e) { toast(e.message, 'error'); }
  });

  document.getElementById('tool-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('tool-add')?.click();
  });

  // Entnehmen / Übernehmen — Inline-Form öffnen
  mainEl.querySelectorAll('.tool-checkout, .tool-takeover').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById(`tcf-${btn.dataset.id}`);
      if (!form) return;
      form.style.display = form.style.display === 'none' ? '' : 'none';
      // Projekt-Dropdown und Freitext verknüpfen
      const projSel = document.getElementById(`tcf-proj-${btn.dataset.id}`);
      const projText = document.getElementById(`tcf-text-${btn.dataset.id}`);
      const addrInp = document.getElementById(`tcf-addr-${btn.dataset.id}`);
      if (projSel && !projSel._bound) {
        projSel._bound = true;
        projSel.addEventListener('change', () => {
          const proj = projects.find(p => p.id == projSel.value);
          if (proj) {
            if (proj.address) addrInp.value = proj.address;
            projText.value = '';
            projText.disabled = true;
          } else {
            projText.disabled = false;
          }
        });
      }
    });
  });

  // Inline-Form Bestätigen
  mainEl.querySelectorAll('.tcf-confirm').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const endpoint = btn.dataset.endpoint;
      const project_id = document.getElementById(`tcf-proj-${id}`)?.value || null;
      const project_text = document.getElementById(`tcf-text-${id}`)?.value || null;
      const address = document.getElementById(`tcf-addr-${id}`)?.value || null;
      try {
        await api('POST', `/api/tools/${id}/${endpoint}`, { project_id: project_id || null, project_text, address });
        toast(endpoint === 'checkout' ? 'Werkzeug entnommen' : 'Werkzeug übernommen', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // Inline-Form Abbrechen
  mainEl.querySelectorAll('.tcf-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById(`tcf-${btn.dataset.id}`);
      if (form) form.style.display = 'none';
    });
  });

  // Zurückgeben
  mainEl.querySelectorAll('.tool-return').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/tools/${btn.dataset.id}/return`);
        toast('Werkzeug zurückgegeben', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // Bearbeiten
  mainEl.querySelectorAll('.tool-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newName = await promptModal('Werkzeug umbenennen:', { title: 'Umbenennen', defaultValue: btn.dataset.name, multiline: false, required: true });
      if (newName === null || !newName.trim()) return;
      api('PUT', `/api/tools/${btn.dataset.id}`, { name: newName.trim() })
        .then(() => { toast('Werkzeug umbenannt', 'success'); renderTools(); })
        .catch(e => toast(e.message, 'error'));
    });
  });

  // Löschen
  mainEl.querySelectorAll('.tool-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Werkzeug wirklich löschen?', { title: 'Werkzeug löschen', okLabel: 'Löschen' }))) return;
      try {
        await api('DELETE', `/api/tools/${btn.dataset.id}`);
        toast('Werkzeug gelöscht', 'success');
        renderTools();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // Historie
  mainEl.querySelectorAll('.tool-history').forEach(btn => {
    btn.addEventListener('click', async () => {
      const modal = document.getElementById('tool-history-modal');
      const toolId = btn.dataset.id;
      document.getElementById('history-title').textContent = `Historie: ${btn.dataset.name}`;
      document.getElementById('history-content').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      modal.style.display = '';
      try {
        const data = await api('GET', `/api/tools/${toolId}/history`);
        if (data && data.history.length > 0) {
          const th = `<th style="text-align:left;padding:0.5rem 0.75rem;border-bottom:2px solid var(--border);">`;
          const td = `padding:0.4rem 0.75rem;border-bottom:1px solid var(--border);`;
          document.getElementById('history-content').innerHTML = `<table class="table" style="font-size:0.85rem;width:100%;border-collapse:separate;border-spacing:0;">
            <thead><tr>${th}Wer</th>${th}Entnommen</th>${th}Zurück</th>${th}Projekt / Ort</th></tr></thead>
            <tbody>${data.history.map(h => {
              const loc = [h.project_name || h.project_text || '', h.address || ''].filter(Boolean).join(' / ');
              return `<tr>
                <td style="${td}">${esc(h.user_name)}</td>
                <td style="${td}white-space:nowrap;">${fmtDT(h.checked_out_at)}</td>
                <td style="${td}white-space:nowrap;">${h.returned_at ? fmtDT(h.returned_at) : '<em>unterwegs</em>'}</td>
                <td style="${td}font-size:0.8rem;color:var(--text-light);">${loc ? esc(loc) : '–'}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
          ${isAdmin() ? `<button class="btn btn-danger btn-sm" id="clear-history" data-id="${toolId}" style="margin-top:0.5rem;">Historie zurücksetzen</button>` : ''}`;
          document.getElementById('clear-history')?.addEventListener('click', async () => {
            if (!(await confirmModal('Komplette Historie dieses Werkzeugs wirklich löschen?', { title: 'Historie löschen', okLabel: 'Löschen' }))) return;
            try {
              await api('DELETE', `/api/tools/${toolId}/history`);
              toast('Historie zurückgesetzt', 'success');
              modal.style.display = 'none';
              renderTools();
            } catch (e) { toast(e.message, 'error'); }
          });
        } else {
          document.getElementById('history-content').innerHTML = '<p style="color:var(--text-light);padding:1rem;">Noch keine Einträge.</p>';
        }
      } catch (e) { document.getElementById('history-content').innerHTML = '<p>Fehler beim Laden.</p>'; }
    });
  });

  // Modal schließen
  document.getElementById('history-close')?.addEventListener('click', () => {
    document.getElementById('tool-history-modal').style.display = 'none';
  });
  document.getElementById('tool-history-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'tool-history-modal') e.target.style.display = 'none';
  });
}

