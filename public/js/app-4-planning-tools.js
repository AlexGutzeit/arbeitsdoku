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

  let entries = [];
  let absences = [];
  try {
    const [planData, absData] = await Promise.all([
      api('GET', `/api/planning?date_from=${r.from}&date_to=${r.to}`),
      api('GET', `/api/absences/by-date?from=${r.from}&to=${r.to}&scope=planning`),
    ]);
    if (planData) entries = planData.entries;
    if (absData) absences = filterApprovedAbsences(absData.absences);
  } catch (e) {}

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
      <button id="plan-prev">&#8249;</button>
      <span class="current-period">${label}</span>
      <button id="plan-next">&#8250;</button>
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
      if (e) showTooltip(planEntryTooltipHtml(e), ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => {
      if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
    });
    el.addEventListener('mouseleave', hideTooltip);

    // Mobile: Long-Press (500ms)
    let pressTimer = null;
    let pressX = 0, pressY = 0, moved = false;
    el.addEventListener('touchstart', (ev) => {
      moved = false;
      pressX = ev.touches[0].clientX;
      pressY = ev.touches[0].clientY;
      pressTimer = setTimeout(() => {
        if (!moved && e) {
          hideTooltip();
          showTooltip(planEntryTooltipHtml(e), pressX, pressY);
          // Tooltip nach 4 Sekunden automatisch ausblenden
          setTimeout(hideTooltip, 4000);
        }
      }, 500);
    }, { passive: true });
    el.addEventListener('touchmove', (ev) => {
      const dx = ev.touches[0].clientX - pressX;
      const dy = ev.touches[0].clientY - pressY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        moved = true;
        clearTimeout(pressTimer);
      }
    }, { passive: true });
    el.addEventListener('touchend', () => {
      clearTimeout(pressTimer);
    });

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

      const menu = document.createElement('div');
      menu.className = 'plan-action-menu';
      menu.dataset.for = btn.dataset.id;
      menu.innerHTML = `
        <button class="plan-menu-edit" data-id="${btn.dataset.id}" data-group="${btn.dataset.group || ''}">&#9998; Bearbeiten</button>
        <button class="plan-menu-del" data-id="${btn.dataset.id}">&#10005; L\u00f6schen</button>
      `;
      // Positionierung: unterhalb des Buttons, relativ zum Viewport
      document.body.appendChild(menu);
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 2) + 'px';
      menu.style.left = Math.max(4, rect.right + window.scrollX - menu.offsetWidth) + 'px';

      menu.querySelector('.plan-menu-edit').addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTooltip();
        closePlanMenus();
        if (btn.dataset.group) {
          navigate('/planning/edit-group/' + btn.dataset.group);
        } else {
          navigate('/planning/edit/' + btn.dataset.id);
        }
      });
      menu.querySelector('.plan-menu-del').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        closePlanMenus();
        if (!(await confirmModal('Planung wirklich l\u00f6schen?', { title: 'Planung l\u00f6schen', okLabel: 'L\u00f6schen' }))) return;
        try {
          await api('DELETE', '/api/planning/' + btn.dataset.id);
          toast('Planung gel\u00f6scht', 'success');
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
      // ⋮-Menü: „alle"-Planer/Manager in jeder Spalte; Self-Planer NUR in seiner eigenen Spalte
      // (auch bei geteilten Einträgen, die in mehreren Spalten erscheinen).
      if (canEdit && canEditEntry(e) && (canPlanAll() || col.id === S.user.id)) {
        actionsHtml += `<button type="button" class="plan-menu-btn" data-id="${e.id}" data-group="${e.group_id || ''}" title="Aktionen">&#8942;</button>`;
      }

      const entryColor = e.color || '#f59e0b';
      bodyHtml += `<div class="tl-plan-entry" data-planning-id="${e.id}" style="top:${top}px;height:${height}px;left:${leftPct}%;width:${widthPct}%;right:auto;background:${entryColor}28;border-color:${entryColor};color:#374151;" title="Klicken zum \u00dcbernehmen">
        <div style="display:flex;justify-content:space-between;align-items:center;min-width:0;">
          <span class="tl-e-time" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.series_id ? '<span title="Serientermin">🔁</span> ' : ''}${esc(e.time_from)} - ${esc(e.time_to)}</span>
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
          bodyHtml += `<div class="grid-plan-entry" style="background:${ec}28;border-left-color:${ec};color:#374151;">${e.series_id ? '🔁 ' : ''}${e.time_from}-${e.time_to} ${e.address ? `<button class="nav-to-addr grid-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''} ${esc(proj)}${proj && e.client ? ' – ' : ''}${esc(e.client || '')}</div>`;
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
  } else if (!source || projectSource) {
    // Neue Planung ODER „In Planung übernehmen" (Projekt-Quelle): heute als Standardtag vorbelegen,
    // damit die Übernahme mit einem Klick speicherbar ist. „Auftrag erneut planen" (replanEntry) bleibt
    // bewusst ohne Tag — dort wählt der Planer neue Termine.
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
  let multiMode = isGroupEdit || planDays.length > 1;

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
        <button type="submit" class="btn btn-primary btn-block">${(isEdit || isGroupEdit) ? 'Speichern' : 'Planung erstellen'}</button>
        ${isEdit ? `<button type="button" class="btn btn-outline btn-block" id="replan-entry" style="margin-top:0.5rem">Auftrag erneut planen</button>` : ''}
        ${(isEdit || isGroupEdit) ? '<button type="button" class="btn btn-danger btn-block" id="delete-planning" style="margin-top:0.5rem">Planung löschen</button>' : ''}
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'planning');
  bindLayout();
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';
  bindDateSectionEvents();

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

    try {
      if (isEdit) {
        // Einzeleintrag bearbeiten — bei >1 Tag konvertiert Backend zu Gruppe
        await api('PUT', '/api/planning/' + editId, { ...common, days: daysToSend });
        toast('Planung aktualisiert', 'success');
      } else if (isGroupEdit) {
        // Gruppe aktualisieren — bei =1 Tag schrumpft Backend zu Single
        await api('PUT', '/api/planning/group/' + editGroupId, { ...common, days: daysToSend });
        toast('Planungsgruppe aktualisiert', 'success');
      } else {
        // Neue Planung (einzeln oder Gruppe)
        if (daysToSend.length === 1) {
          const day = daysToSend[0];
          await api('POST', '/api/planning', { ...common, date: day.date, time_from: day.time_from, time_to: day.time_to, break_minutes: day.break_minutes });
        } else {
          await api('POST', '/api/planning', { ...common, days: daysToSend });
        }
        toast('Planung erstellt', 'success');
      }
      navigate('/planning');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('replan-entry')?.addEventListener('click', () => {
    navigate('/planning/replan/' + editId);
  });

  document.getElementById('delete-planning')?.addEventListener('click', async () => {
    if (!(await confirmModal('Planung wirklich löschen?', { title: 'Planung löschen', okLabel: 'Löschen' }))) return;
    try {
      if (isGroupEdit) {
        await api('DELETE', '/api/planning/group/' + editGroupId);
      } else {
        await api('DELETE', '/api/planning/' + editId);
      }
      toast('Planung gelöscht', 'success');
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

      return `<div class="tool-item ${statusClass}">
        <div class="tool-info">
          <strong>${esc(t.name)}</strong>
          <span class="tool-status">${statusText}</span>
          ${locationHtml}
        </div>
        <div class="tool-actions">
          ${actions}
          <button class="btn btn-sm btn-outline tool-history" data-id="${t.id}" data-name="${esc(t.name)}">Historie</button>
          ${canManage ? `<button class="btn btn-sm btn-outline tool-edit" data-id="${t.id}" data-name="${esc(t.name)}">&#9998;</button>` : ''}
          ${canManage ? `<button class="btn btn-sm btn-danger tool-delete" data-id="${t.id}">&#10005;</button>` : ''}
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

