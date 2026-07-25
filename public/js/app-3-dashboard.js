// --- Dashboard ---
async function renderDashboard() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'dashboard');
  bindLayout();

  try {
    const projData = await api('GET', '/api/projects');
    if (projData) S.projects = projData.projects;

    if (canViewAll()) {
      const userData = await api('GET', '/api/users');
      if (userData) S.users = userData.users;
    }
  } catch (e) {}

  renderDashboardContent();
}

async function renderDashboardContent() {
  const range = getDateRange();
  const params = new URLSearchParams({ date_from: range.from, date_to: range.to });
  if (S.filterProjectId) params.set('project_id', S.filterProjectId);
  if (S.filterSearch) params.set('search', S.filterSearch);
  if (S.filterRegie !== '') params.set('regie', S.filterRegie);

  // Ungefilterte Einträge für Soll/Ist-Berechnung laden
  const allParams = new URLSearchParams({ date_from: range.from, date_to: range.to });
  const hasFilter = S.filterProjectId || S.filterSearch || S.filterRegie !== '';

  try {
    const data = await api('GET', '/api/entries?' + params.toString());
    if (!data) return;
    S.entries = data.entries;
    if (hasFilter) {
      const allData = await api('GET', '/api/entries?' + allParams.toString());
      S.allEntries = allData ? allData.entries : S.entries;
    } else {
      S.allEntries = S.entries;
    }
  } catch (e) { toast(e.message, 'error'); return; }

  // Summenstunden: gefilterte Ansicht für Anzeige
  let visibleEntries = S.entries;
  if (canViewAll() && S.hiddenEmployees && S.hiddenEmployees.size > 0) {
    visibleEntries = S.entries.filter(e => !S.hiddenEmployees.has(e.user_id));
  }
  const totalNet = calcActualHours(visibleEntries);
  const weekdays = countWeekdays(range.from, range.to);

  // Soll/Ist: immer auf Basis ALLER Einträge (ohne Projekt-/Suchfilter)
  let allVisibleEntries = S.allEntries;
  if (canViewAll() && S.hiddenEmployees && S.hiddenEmployees.size > 0) {
    allVisibleEntries = S.allEntries.filter(e => !S.hiddenEmployees.has(e.user_id));
  }
  const totalNetAll = calcActualHours(allVisibleEntries);

  let targetHours = 0;
  let cumulativeOvertime = 0;
  if (S.user.role === 'mitarbeiter') {
    try {
      const [th, ot] = await Promise.all([
        api('GET', `/api/statistics/target-hours?date_from=${range.from}&date_to=${range.to}`),
        api('GET', `/api/statistics/overtime?date_to=${range.to}`),
      ]);
      if (th) targetHours = th.target_hours;
      if (ot) cumulativeOvertime = ot.overtime;
    } catch (e) {}
  }

  const diff = totalNetAll - targetHours;
  const diffClass = diff >= 0 ? 'positive' : 'negative';
  const diffSign = diff >= 0 ? '+' : '';
  const otClass = cumulativeOvertime >= 0 ? 'positive' : 'negative';

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;
  mainEl.classList.add('main-wide');

  // Filter (nur Projekt + Suche + Abwesenheitstyp, Mitarbeiter werden per Chips gesteuert)
  const absenceTypeOptions = [
    ['', 'Abwesenheit: Alle'],
    ['krank', '🏥 Krank'],
    ['urlaub', '🌴 Urlaub'],
    ['freizeitausgleich', '⏱️ Freizeitausgleich'],
    ['sonderurlaub', '🎁 Sonderurlaub'],
    ['feiertag', '🎉 Feiertag'],
    ['berufsschule', '🏫 Berufsschule'],
    ['innung', '🔧 Innung'],
  ];
  const filtersHtml = `
    <div class="filters">
      <select id="filter-project">
        <option value="">Alle Projekte</option>
        ${S.projects.map(p => `<option value="${p.id}" ${S.filterProjectId == p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <select id="filter-regie">
        <option value="" ${S.filterRegie === '' ? 'selected' : ''}>Regie: Alle</option>
        <option value="1" ${S.filterRegie === '1' ? 'selected' : ''}>Regie: Ja</option>
        <option value="0" ${S.filterRegie === '0' ? 'selected' : ''}>Regie: Nein</option>
      </select>
      <select id="filter-absence-type">
        ${absenceTypeOptions.map(([v, l]) => `<option value="${v}" ${S.filterAbsenceType === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input type="search" id="filter-search" placeholder="Suchen..." value="${esc(S.filterSearch)}">
    </div>`;

  // Mitarbeiter-Chips für Chef/Admin/Buchhalter
  let chipsHtml = '';
  if (canViewAll()) {
    if (!S.hiddenEmployees) S.hiddenEmployees = new Set();
    const workers = getWorkerUsers().filter(u => (u.role === 'mitarbeiter' || u.role === 'chef' || u.role === 'buchhalter') && employedInRange(u, range.from, range.to));
    chipsHtml = `<div class="employee-chips">
      ${workers.map((u, i) => {
        const c = PALETTE[i % PALETTE.length];
        const active = !S.hiddenEmployees.has(u.id);
        return `<span class="emp-chip ${active ? '' : 'inactive'}" data-uid="${u.id}" style="background:${c}">${esc(u.name)}</span>`;
      }).join('')}
    </div>`;
  }

  // Abwesenheiten für Timeline/Wochenraster
  let absencesForPeriod = [];
  try {
    const absData = await api('GET', `/api/absences/by-date?from=${range.from}&to=${range.to}`);
    if (absData) absencesForPeriod = filterApprovedAbsences(absData.absences);
  } catch (e) {}

  // Abwesenheiten nach Typ filtern
  const filteredAbsences = S.filterAbsenceType
    ? absencesForPeriod.filter(a => a.type === S.filterAbsenceType)
    : absencesForPeriod;

  // Abwesenheitssummary für Mitarbeiter (oder eigene Ansicht)
  let absenceSummary = null;
  if (S.user.role === 'mitarbeiter') {
    try {
      const sd = await api('GET', `/api/absences/summary?from=${range.from}&to=${range.to}`);
      if (sd) absenceSummary = sd;
    } catch(e) {}
  }

  // Entscheidung: Timeline (Tag), Wochenraster, Monatsraster
  let contentHtml = '';
  if (S.view === 'day') {
    contentHtml = renderTimelineHtml(visibleEntries, filteredAbsences);
  } else if (S.view === 'week') {
    contentHtml = renderWeekGridHtml(visibleEntries, range, filteredAbsences);
  } else {
    contentHtml = renderMonthGridHtml(visibleEntries, range, filteredAbsences);
  }

  mainEl.innerHTML = `
    <div class="view-toggle">
      <button class="${S.view === 'day' ? 'active' : ''}" data-view="day">Tag</button>
      <button class="${S.view === 'week' ? 'active' : ''}" data-view="week">Woche</button>
      <button class="${S.view === 'month' ? 'active' : ''}" data-view="month">Monat</button>
    </div>
    <div class="date-nav">
      <button id="date-prev">&#8249;</button>
      <span class="current-period">${getPeriodLabel()}</span>
      <button id="date-next">&#8250;</button>
      <button id="date-today" class="date-today-btn">Jetzt</button>
    </div>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${fmtH(totalNet)}</div>
        <div class="label">Nettostunden</div>
      </div>
      ${S.user.role === 'mitarbeiter' ? `
      <div class="summary-card">
        <div class="value">${fmtH(targetHours)}</div>
        <div class="label">Soll-Stunden</div>
      </div>
      <div class="summary-card ${diffClass}">
        <div class="value">${diff >= 0 ? '+' : ''}${fmtH(diff)}</div>
        <div class="label">${diff >= 0 ? 'Über' : 'Unter'} (Zeitraum)</div>
      </div>
      <div class="summary-card ${otClass}">
        <div class="value">${cumulativeOvertime >= 0 ? '+' : ''}${fmtH(cumulativeOvertime)}</div>
        <div class="label">Überstunden gesamt</div>
      </div>` : `
      <div class="summary-card">
        <div class="value">${visibleEntries.length}</div>
        <div class="label">Einträge</div>
      </div>
      <div class="summary-card">
        <div class="value">${new Set(visibleEntries.map(e => e.user_id)).size}</div>
        <div class="label">Mitarbeiter</div>
      </div>`}
      ${(() => {
        if (!absenceSummary || S.user.role !== 'mitarbeiter') return '';
        const sum = absenceSummary.summary || {};
        if (Object.keys(sum).length === 0) return '';
        const typeLabels = { krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'FZA', sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag', berufsschule: 'Berufsschule', innung: 'Innung' };
        const totalDays = absenceSummary.totalUniqueDays ?? Object.values(sum).reduce((s, v) => s + v, 0);
        const details = Object.entries(sum).map(([t, d]) => `${typeLabels[t] || t}: ${d}`).join(', ');
        return `<div class="summary-card">
          <div class="value">${totalDays}</div>
          <div class="label">Abwesenheitstage<br><small>${details}</small></div>
        </div>`;
      })()}
    </div>
    ${filtersHtml}
    ${chipsHtml}
    ${contentHtml}
  `;

  // --- Event Bindings ---
  // View toggle
  mainEl.querySelectorAll('.view-toggle button').forEach(btn => {
    btn.addEventListener('click', () => { S.view = btn.dataset.view; renderDashboardContent(); });
  });
  // Date nav
  document.getElementById('date-prev')?.addEventListener('click', () => { navDate(-1); renderDashboardContent(); });
  document.getElementById('date-next')?.addEventListener('click', () => { navDate(1); renderDashboardContent(); });
  document.getElementById('date-today')?.addEventListener('click', () => { S.currentDate = new Date(); renderDashboardContent(); });
  // Filters
  document.getElementById('filter-project')?.addEventListener('change', (e) => { S.filterProjectId = e.target.value; renderDashboardContent(); });
  document.getElementById('filter-regie')?.addEventListener('change', (e) => { S.filterRegie = e.target.value; renderDashboardContent(); });
  document.getElementById('filter-absence-type')?.addEventListener('change', (e) => { S.filterAbsenceType = e.target.value; renderDashboardContent(); });
  let searchTimeout;
  document.getElementById('filter-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const val = e.target.value;
    const pos = e.target.selectionStart;
    searchTimeout = setTimeout(async () => {
      S.filterSearch = val;
      await renderDashboardContent();
      // Der Neuaufbau ersetzt das Eingabefeld → Fokus und Cursor zurückholen. Ohne das schließt sich auf dem
      // Handy nach 300 ms die Tastatur und der Cursor springt ans Ende (Tippen wird unmöglich).
      const el = document.getElementById('filter-search');
      if (el && document.activeElement !== el) {
        el.focus();
        try { el.setSelectionRange(pos, pos); } catch (_) {}
      }
    }, 300);
  });
  // Employee chips
  mainEl.querySelectorAll('.emp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const uid = Number(chip.dataset.uid);
      if (S.hiddenEmployees.has(uid)) S.hiddenEmployees.delete(uid);
      else S.hiddenEmployees.add(uid);
      renderDashboardContent();
    });
  });
  // Entry clicks (timeline blocks → edit)
  mainEl.querySelectorAll('.tl-entry[data-entry-id]').forEach(el => {
    el.addEventListener('click', () => { hideTooltip(); navigate('/entry/' + el.dataset.entryId); });
  });
  // Tooltip für Einträge (Tag + Woche)
  const entryMap = {};
  visibleEntries.forEach(e => { entryMap[e.id] = e; });
  mainEl.querySelectorAll('[data-entry-id]').forEach(el => {
    el.addEventListener('mouseenter', (ev) => {
      const e = entryMap[el.dataset.entryId];
      if (e) showTooltip(entryTooltipHtml(e), ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => {
      if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });
  // Nav-Buttons in Übersichten
  mainEl.querySelectorAll('.nav-to-addr').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); hideTooltip(); openNav(btn.dataset.addr); });
  });
  // Grid-Zellen klick → Tagansicht (innerstes data-jump-date gewinnt)
  mainEl.querySelectorAll('[data-jump-date]').forEach(el => {
    el.addEventListener('click', (e) => {
      const closest = e.target.closest('[data-jump-date]');
      if (closest) {
        e.stopPropagation();
        S.currentDate = new Date(closest.dataset.jumpDate + 'T12:00:00');
        S.view = 'day';
        renderDashboardContent();
      }
    });
  });
  mainEl.querySelectorAll('.btn-continue').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); navigate('/entry/continue/' + btn.dataset.id); });
  });
  // Timeline zur Kernarbeitszeit scrollen
  if (S.view === 'day') {
    const scrollContainer = mainEl.querySelector('.timeline-scroll');
    if (scrollContainer) {
      const scrollY = (TL_SCROLL_TO_HOUR - TL_START_HOUR) * TL_HOUR_PX - 20;
      scrollContainer.scrollTop = Math.max(0, scrollY);
    }
  }
}

// --- Timeline Rendering (Tagansicht) ---
function renderTimelineHtml(entries, absences) {
  if (entries.length === 0 && !(absences || []).length) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge an diesem Tag</p></div>';
  }

  const totalH = (TL_END_HOUR - TL_START_HOUR) * TL_HOUR_PX;
  const isSingle = S.user.role === 'mitarbeiter';
  const currentDay = formatDateISO(S.currentDate);

  // Stundenleiste
  let hoursHtml = '<div class="timeline-hours-body" style="height:' + totalH + 'px">';
  for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
    const y = (h - TL_START_HOUR) * TL_HOUR_PX;
    hoursHtml += `<span class="tl-hour-label" style="top:${y}px">${String(h).padStart(2,'0')}:00</span>`;
  }
  hoursHtml += '</div>';

  // Spalten bestimmen
  let columns = [];
  if (isSingle) {
    columns = [{ id: S.user.id, name: S.user.name, entries: entries }];
  } else {
    // Gruppiere nach Mitarbeiter (Zeiteinträge)
    const byUser = {};
    entries.forEach(e => {
      if (!byUser[e.user_id]) byUser[e.user_id] = { id: e.user_id, name: e.user_name, entries: [] };
      byUser[e.user_id].entries.push(e);
    });
    // Auch User mit Abwesenheiten am aktuellen Tag einschließen (ohne Zeiteinträge)
    (absences || []).forEach(a => {
      if (!a.user_id) return; // Feiertage (global) separat
      if (a.date_from > currentDay || a.date_to < currentDay) return;
      if (S.hiddenEmployees && S.hiddenEmployees.has(a.user_id)) return;
      if (!byUser[a.user_id]) {
        const u = (S.users || []).find(u => u.id === a.user_id);
        byUser[a.user_id] = { id: a.user_id, name: u ? u.name : (a.user_name || `#${a.user_id}`), entries: [] };
      }
    });
    columns = Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));
  }

  if (columns.length === 0) {
    // Noch auf globale Feiertage prüfen
    const globalAbsences = (absences || []).filter(a => !a.user_id && a.date_from <= currentDay && a.date_to >= currentDay);
    if (globalAbsences.length === 0) {
      return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge an diesem Tag</p></div>';
    }
    // Feiertag ohne Mitarbeiter-Spalten: als einzelne Spalte darstellen
    columns = [{ id: null, name: 'Feiertag', entries: [] }];
  }

  // Jetzt-Linie berechnen
  const now = new Date();
  const today = formatDateISO(now);
  let nowLineHtml = '';
  if (today === currentDay) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMin = TL_START_HOUR * 60;
    const y = ((nowMinutes - startMin) / 60) * TL_HOUR_PX;
    if (y >= 0 && y <= totalH) {
      nowLineHtml = `<div class="tl-now-line" style="top:${y}px"></div>`;
    }
  }

  // Spalten-HTML
  let colsHtml = '';
  columns.forEach((col, ci) => {
    const colColor = PALETTE[ci % PALETTE.length];
    let bodyHtml = '';
    // Stundenlinien
    for (let h = TL_START_HOUR; h <= TL_END_HOUR; h++) {
      const y = (h - TL_START_HOUR) * TL_HOUR_PX;
      bodyHtml += `<div class="tl-hour-line" style="top:${y}px"></div>`;
      if (h < TL_END_HOUR) {
        bodyHtml += `<div class="tl-hour-line half" style="top:${y + TL_HOUR_PX / 2}px"></div>`;
      }
    }
    bodyHtml += nowLineHtml;
    // Einträge - Überlappungen nebeneinander anordnen
    const sorted = [...col.entries].sort((a, b) => a.time_from < b.time_from ? -1 : a.time_from > b.time_from ? 1 : 0);
    // Spalten für Überlappungen berechnen
    const lanes = []; // [{end: minuten, entries: [...]}]
    sorted.forEach(e => {
      const [fh, fm] = e.time_from.split(':').map(Number);
      const [th, tm] = e.time_to.split(':').map(Number);
      e._startMin = fh * 60 + fm;
      e._endMin = th * 60 + tm;
      // Finde freie Spur
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].end <= e._startMin) {
          lanes[i].end = e._endMin;
          e._lane = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e._lane = lanes.length;
        lanes.push({ end: e._endMin });
      }
    });
    const totalLanes = Math.max(1, lanes.length);
    sorted.forEach(e => {
      const top = ((e._startMin - TL_START_HOUR * 60) / 60) * TL_HOUR_PX;
      const height = Math.max(20, ((e._endMin - e._startMin) / 60) * TL_HOUR_PX);
      const bg = e.project_id ? colorFor(e.project_id) : colColor;
      const projLabel = e.project_name || e.project_text || '';
      const laneW = (100 - 6) / totalLanes; // 6% padding gesamt
      const leftPct = 3 + e._lane * laneW;
      const widthPct = laneW - 1; // 1% gap

      const regieTag = regieHtmlBadge(e, 'font-size:0.65rem;');
      const projClientLabel = projLabel + (projLabel && e.client ? ' – ' : '') + (e.client || '');
      const navBtn = e.address ? `<button class="nav-to-addr tl-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : '';
      const isCompact = height < 50;
      if (isCompact) {
        // Kompakt-Horizontallayout: alles in einer Zeile
        const parts = [
          `<span class="tl-e-time" style="white-space:nowrap;flex-shrink:0">${esc(e.time_from)}-${esc(e.time_to)}</span>`
        ];
        if (projClientLabel) parts.push(`<span class="tl-e-sep" style="opacity:0.5;flex-shrink:0">·</span><span class="tl-e-project" style="white-space:nowrap;flex-shrink:1;overflow:hidden;text-overflow:ellipsis">${esc(projClientLabel)}</span>`);
        if (e.description) parts.push(`<span class="tl-e-sep" style="opacity:0.5;flex-shrink:0">·</span><span class="tl-e-desc" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.description)}</span>`);
        bodyHtml += `<div class="tl-entry" data-entry-id="${e.id}" style="top:${top}px;height:${height}px;background:${bg};left:${leftPct}%;width:${widthPct}%;right:auto;flex-direction:row;align-items:center;gap:4px;">
          ${parts.join('')}
          ${navBtn}
        </div>`;
      } else {
        bodyHtml += `<div class="tl-entry" data-entry-id="${e.id}" style="top:${top}px;height:${height}px;background:${bg};left:${leftPct}%;width:${widthPct}%;right:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="tl-e-time">${esc(e.time_from)} - ${esc(e.time_to)}</span>
            ${navBtn}
          </div>
          ${projClientLabel ? `<span class="tl-e-project">${esc(projClientLabel)}</span>` : ''}
          ${e.description && height > 50 ? `<span class="tl-e-desc">${esc(e.description)}</span>` : ''}
          ${e.break_minutes > 0 && height > 40 ? `<span class="tl-e-break">Pause: ${e.break_minutes} min</span>` : ''}
          ${height > 35 ? regieTag : ''}
        </div>`;
      }
    });

    const headerLabel = isSingle ? 'Meine Einträge' : esc(col.name);
    const dayAbsences = getAbsencesForDay(col.id, currentDay, absences);
    const colBannerHtml = dayAbsences.map(a => {
      const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
      const pendingCls = a.status === 'pending' ? ' tl-absence-banner--pending' : '';
      const comment = a.comment ? `<span class="tl-absence-comment">${esc(a.comment)}</span>` : '';
      return `<div class="tl-absence-banner tl-absence-banner--${a.type}${pendingCls}">${t.icon} ${t.label}${comment}</div>`;
    }).join('');
    const colBannerWrap = colBannerHtml ? `<div class="tl-col-banner">${colBannerHtml}</div>` : '';
    colsHtml += `<div class="timeline-column">
      <div class="tl-col-header" style="${!isSingle ? 'color:' + colColor : ''}">
        <div class="tl-col-header-name">${headerLabel}</div>
        ${colBannerWrap}
      </div>
      <div class="tl-col-body" style="height:${totalH}px">${bodyHtml}</div>
    </div>`;
  });

  return `<div class="timeline-wrapper">
    <div class="timeline-scroll">
      <div class="timeline-container">
        <div class="timeline-hours"><div class="tl-col-header" style="visibility:hidden">.</div>${hoursHtml}</div>
        ${colsHtml}
      </div>
    </div>
  </div>`;
}

// --- Wochenraster ---
function renderWeekGridHtml(entries, range, absences) {
  const dayNames = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
  const dayNamesShort = ['Mo','Di','Mi','Do','Fr','Sa','So'];

  // 7 Tage der Woche ermitteln (Mo-So)
  const weekStart = new Date(range.from + 'T12:00:00');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(formatDateISO(d));
  }

  // Spalten (Mitarbeiter) bestimmen
  const columns = getGridColumns(entries, range);
  if (columns.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge in dieser Woche</p></div>';
  }

  // Einträge nach Tag+User gruppieren
  const lookup = {};
  entries.forEach(e => {
    const key = e.date + '_' + e.user_id;
    if (!lookup[key]) lookup[key] = [];
    lookup[key].push(e);
  });

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
    columns.forEach((col) => {
      const cellEntries = lookup[day + '_' + col.id] || [];
      const totalH = calcActualHours(cellEntries);
      const dayAbsences = getAbsencesForDay(col.id, day, absences);
      bodyHtml += `<td class="grid-cell" data-jump-date="${day}">`;
      if (dayAbsences.length > 0) {
        bodyHtml += `<div class="grid-absence-chips">${dayAbsences.map(a => {
          const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
          const pendCls = a.status === 'pending' ? ' grid-absence-chip--pending' : '';
          const comment = a.comment ? `<span class="grid-absence-chip-comment">${esc(a.comment)}</span>` : '';
          return `<span class="grid-absence-chip grid-absence-chip--${a.type}${pendCls}">${t.icon} ${t.label}${comment}</span>`;
        }).join('')}</div>`;
      }
      if (cellEntries.length > 0) {
        cellEntries.forEach(e => {
          const bg = e.project_id ? colorFor(e.project_id) : '#64748b';
          const regieHtml = regieHtmlBadge(e);
          bodyHtml += `<div class="grid-entry" data-entry-id="${e.id}" style="border-left-color:${bg}">
            <span class="grid-e-time">${esc(e.time_from)}-${esc(e.time_to)} ${e.address ? `<button class="nav-to-addr grid-nav-btn" data-addr="${esc(e.address)}" title="Navigieren">&#128506;</button>` : ''}</span>
            <span class="grid-e-proj">${esc(e.project_name || e.project_text || '')}${e.client ? ' – ' + esc(e.client) : ''}</span>
            <span class="grid-e-hours">${fmtH(e.net_hours)}</span>
            <span class="grid-e-regie">${regieHtml}</span>
          </div>`;
        });
        bodyHtml += `<div class="grid-cell-total">${fmtH(totalH)}</div>`;
      }
      bodyHtml += '</td>';
    });
    bodyHtml += '</tr>';
  });

  return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table></div></div>`;
}

// --- Monatsraster ---
function renderMonthGridHtml(entries, range, absences = []) {
  // Kalenderwochen des Monats ermitteln
  const weeks = getCalendarWeeks(range.from, range.to);
  const columns = getGridColumns(entries, range);

  if (columns.length === 0) {
    return '<div class="empty-state"><div class="icon">&#128203;</div><p>Keine Einträge in diesem Monat</p></div>';
  }

  // Einträge nach KW+User gruppieren
  const lookup = {};
  entries.forEach(e => {
    const kw = getISOWeek(e.date);
    const key = kw + '_' + e.user_id;
    if (!lookup[key]) lookup[key] = [];
    lookup[key].push(e);
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
      const cellEntries = lookup[w.kw + '_' + col.id] || [];
      const totalH = calcActualHours(cellEntries);
      const days = new Set(cellEntries.map(e => e.date)).size;
      // Klick auf Zelle → erster Tag der KW
      // Alle Arbeitstage der KW im Monatsbereich für Abwesenheits-Anzeige sammeln
      const kwStart = new Date(Math.max(new Date(w.from + 'T12:00:00'), new Date(range.from + 'T12:00:00')));
      const kwEnd   = new Date(Math.min(new Date(w.to   + 'T12:00:00'), new Date(range.to   + 'T12:00:00')));
      const allDaysInKW = [];
      for (let d = new Date(kwStart); d <= kwEnd; d.setDate(d.getDate() + 1)) {
        const wd = d.getDay();
        if (wd !== 0 && wd !== 6) allDaysInKW.push(formatDateISO(d));
      }

      bodyHtml += `<td class="grid-cell" data-jump-date="${w.from}">`;
      // Gruppiere Einträge nach Tag
      const byDay = {};
      cellEntries.forEach(e => {
        if (!byDay[e.date]) byDay[e.date] = [];
        byDay[e.date].push(e);
      });
      // Zeige alle Tage mit Eintrag ODER Abwesenheit
      const daysToShow = new Set([...Object.keys(byDay), ...allDaysInKW.filter(d => getAbsencesForDay(col.id, d, absences).length > 0)]);
      const sortedDays = [...daysToShow].sort();
      sortedDays.forEach(day => {
        const dayEntries = byDay[day] || [];
        const dn = getDayNameShort(day);
        const dayH = calcActualHours(dayEntries);
        const dayAbsences = getAbsencesForDay(col.id, day, absences);
        const absChips = dayAbsences.map(a => {
          const t = ABSENCE_TYPES[a.type] || { label: a.type, icon: '' };
          const pendingCls = a.status === 'pending' ? ' grid-absence-chip--pending' : '';
          return `<span class="grid-absence-chip grid-absence-chip--${a.type}${pendingCls}" title="${t.label}">${t.icon}</span>`;
        }).join('');
        bodyHtml += `<div class="grid-kw-day" data-jump-date="${day}">
          <span class="grid-kw-dayname">${dn}</span>
          ${absChips ? `<span class="grid-month-abs-chips">${absChips}</span>` : ''}
          ${dayH > 0 ? `<span class="grid-kw-dayhours">${fmtH(dayH)}</span>` : ''}
        </div>`;
      });
      if (cellEntries.length > 0) {
        const days = new Set(cellEntries.map(e => e.date)).size;
        bodyHtml += `<div class="grid-cell-total">${fmtH(totalH)} / ${days} Tage</div>`;
      }
      bodyHtml += '</td>';
    });
    bodyHtml += '</tr>';
  });

  return `<div class="grid-wrapper"><div class="grid-scroll"><table class="week-month-grid">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table></div></div>`;
}

// --- Grid-Hilfsfunktionen ---
function getGridColumns(entries, range) {
  if (S.user.role === 'mitarbeiter') {
    return [{ id: S.user.id, name: S.user.name }];
  }
  const byUser = {};
  // MA mit Einträgen im Zeitraum immer zeigen (sie waren angestellt + haben Daten)
  entries.forEach(e => {
    if (!byUser[e.user_id]) byUser[e.user_id] = { id: e.user_id, name: e.user_name };
  });
  // MA ohne Einträge nur zeigen, wenn sie im Zeitraum angestellt waren (sonst leere Spalte ausblenden)
  getWorkerUsers().forEach(u => {
    if (byUser[u.id]) return;
    if (S.hiddenEmployees && S.hiddenEmployees.has(u.id)) return;
    if (range && !employedInRange(u, range.from, range.to)) return;
    byUser[u.id] = { id: u.id, name: u.name };
  });
  return Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));
}

function getCalendarWeeks(fromStr, toStr) {
  const weeks = [];
  const seen = new Set();
  const start = new Date(fromStr + 'T12:00:00');
  const end = new Date(toStr + 'T12:00:00');
  const cur = new Date(start);
  while (cur <= end) {
    const kw = getISOWeek(formatDateISO(cur));
    if (!seen.has(kw)) {
      seen.add(kw);
      // Montag der KW
      const d = new Date(cur);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diff));
      const sun = new Date(mon);
      sun.setDate(sun.getDate() + 6);
      weeks.push({ kw, from: formatDateISO(mon), to: formatDateISO(sun) });
    }
    cur.setDate(cur.getDate() + 1);
  }
  return weeks;
}

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 4);
  yearStart.setDate(yearStart.getDate() + 3 - ((yearStart.getDay() + 6) % 7));
  return Math.round((d - yearStart) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function getDayNameShort(dateStr) {
  const names = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  return names[new Date(dateStr + 'T12:00:00').getDay()];
}

function getDateRange() {
  if (S.view === 'day') {
    const d = formatDateISO(S.currentDate);
    return { from: d, to: d };
  } else if (S.view === 'week') {
    return getWeekRange(S.currentDate);
  } else {
    return getMonthRange(S.currentDate);
  }
}

function getPeriodLabel() {
  const months = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const days = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  if (S.view === 'day') {
    return `${days[S.currentDate.getDay()]}, ${formatDateDE(formatDateISO(S.currentDate))}`;
  } else if (S.view === 'week') {
    const r = getWeekRange(S.currentDate);
    return `KW ${getISOWeek(formatDateISO(S.currentDate))} | ${formatDateDE(r.from)} - ${formatDateDE(r.to)}`;
  } else {
    return `${months[S.currentDate.getMonth()]} ${S.currentDate.getFullYear()}`;
  }
}

function navDate(dir) {
  if (S.view === 'day') S.currentDate.setDate(S.currentDate.getDate() + dir);
  else if (S.view === 'week') S.currentDate.setDate(S.currentDate.getDate() + dir * 7);
  else S.currentDate.setMonth(S.currentDate.getMonth() + dir);
}

// --- Entry Form ---
async function renderEntryForm(editId, continueId, planningId, fromProjectId) {
  let entry = null;
  let continueEntry = null;
  let planningEntry = null;
  let projectSource = null;

  if (editId) {
    try {
      const data = await api('GET', '/api/entries/' + editId);
      if (data) entry = data.entry;
    } catch (e) { toast(e.message, 'error'); navigate('/'); return; }
  }

  if (continueId) {
    try {
      const data = await api('GET', '/api/entries/' + continueId);
      if (data) continueEntry = data.entry;
    } catch (e) {}
  }

  if (planningId) {
    try {
      const data = await api('GET', '/api/planning/' + planningId);
      if (data) planningEntry = data.entry;
    } catch (e) {}
  }

  if (fromProjectId) {
    try {
      const data = await api('GET', '/api/projects/' + fromProjectId);
      if (data && data.project) {
        const pr = data.project;
        projectSource = { address: pr.address || '', client: pr.client || '', project_id: pr.id, project_text: '', description: pr.note || '' };
      }
    } catch (e) {}
  }

  // Projekte und Benutzerliste laden
  let regieUsers = [];
  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    if (canViewAll()) {
      const uData = await api('GET', '/api/users');
      if (uData) S.users = uData.users;
    }
    // Regie-Dropdown: alle Non-Admin-User für jeden Benutzer
    const rData = await api('GET', '/api/users/list');
    if (rData) regieUsers = rData.users;
  } catch (e) {}

  const isEdit = !!entry;
  const source = continueEntry || planningEntry || projectSource;
  const today = formatDateISO(new Date());
  const title = isEdit ? 'Eintrag bearbeiten' : (projectSource ? 'Auftrag als Zeitnachweis übernehmen' : (planningEntry ? 'Eintrag aus Planung erstellen' : (continueEntry ? 'Weiter arbeiten' : 'Neuer Eintrag')));

  const nowTime = `${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`;
  const date = isEdit ? entry.date : today;
  const timeFrom = isEdit ? entry.time_from : (planningEntry ? planningEntry.time_from : '07:00');
  const timeTo = isEdit ? entry.time_to : nowTime;
  const breakMin = isEdit ? entry.break_minutes : (planningEntry ? planningEntry.break_minutes : 30);
  const address = isEdit ? entry.address : (source ? source.address : '');
  const client = isEdit ? entry.client : (source ? source.client : '');
  const projectId = isEdit ? (entry.project_id || '') : (source ? (source.project_id || '') : '');
  const projectText = isEdit ? (entry.project_text || '') : (source ? (source.project_text || '') : '');
  const description = isEdit ? entry.description : (projectSource ? (projectSource.description || '') : (planningEntry ? planningEntry.description : ''));
  const personalNote = isEdit ? (entry.personal_note || '') : '';
  const regieVal = isEdit ? (entry.has_regie || 0) : 0;
  const regieUserId = isEdit ? (entry.regie_user_id || S.user.id) : S.user.id;

  const netHours = isEdit ? entry.net_hours : 0;

  const allUsers = regieUsers.length > 0 ? regieUsers : [{ id: S.user.id, name: S.user.name }];
  const showNotes = S.user.role === 'admin' || S.user.role === 'mitarbeiter';
  const canDelete = isEdit && (S.user.role === 'admin' || entry.user_id === S.user.id);
  // GoBD: Bearbeiten/Loeschen eines fremden Eintrags (nur Admin) erfordert eine Begruendung
  const isForeign = isEdit && !!entry && entry.user_id !== S.user.id;
  const showHistory = isEdit && isChefOrAdmin();

  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <div class="card-header">
        <h2>${title}</h2>
        <button class="btn btn-outline btn-sm" id="back-btn">Zurück</button>
      </div>
      <form id="entry-form">
        ${isAdmin() && !isEdit ? `
        <div class="form-group">
          <label>Mitarbeiter</label>
          <select class="form-control" id="ef-user" required>
            <option value="">-- Mitarbeiter wählen --</option>
            ${getActiveWorkerUsers().map(u => `<option value="${u.id}" ${entry?.user_id == u.id ? 'selected' : ''}>${esc(u.name)} (${roleName(u.role)})</option>`).join('')}
          </select>
        </div>
        ` : ''}
        ${isAdmin() && isEdit ? `
        <div class="form-group">
          <label>Mitarbeiter</label>
          <input type="text" class="form-control" value="${esc(entry?.user_name || '')}" disabled>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Datum</label>
          <input type="date" class="form-control" id="ef-date" value="${date}" ${!planningEntry && !isAdmin() && S.user.role !== 'chef' ? `max="${today}"` : ''} required>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Von</label>
            <input type="time" class="form-control" id="ef-from" value="${timeFrom}" required>
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="time" class="form-control" id="ef-to" value="${timeTo}" required>
          </div>
        </div>
        <div class="form-group">
          <label>Pause (Minuten)</label>
          <input type="number" class="form-control" id="ef-break" value="${breakMin}" min="0" step="5">
        </div>
        <div class="net-hours-display" id="ef-net">Netto: ${fmtH(netHours)}</div>
        <div class="form-group">
          <label>Adresse / Arbeitsort</label>
          <div class="input-with-btn">
            <input type="text" class="form-control" id="ef-address" value="${esc(address)}" placeholder="z.B. Musterstraße 1, 12345 Berlin">
            <button type="button" class="btn btn-outline btn-sm btn-nav" id="ef-nav" title="Navigation starten">&#128506;</button>
          </div>
          ${navPref() ? '<button type="button" class="link-btn nav-change-link" id="ef-nav-change">Navigations-App ändern</button>' : ''}
        </div>
        <div class="form-group">
          <label>Kunde</label>
          <input type="text" class="form-control" id="ef-client" value="${esc(client)}" placeholder="Kundenname">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Projekt (Auswahl)</label>
            <select class="form-control" id="ef-project">
              <option value="">-- Kein Projekt --</option>
              ${S.projects.map(p => `<option value="${p.id}" ${p.id == projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Oder Freitext</label>
            <input type="text" class="form-control" id="ef-project-text" value="${projectId ? '' : esc(projectText)}" placeholder="Projektname" ${projectId ? 'disabled' : ''}>
          </div>
        </div>
        <div class="form-group">
          <label>Arbeitsbeschreibung</label>
          <textarea class="form-control" id="ef-desc" rows="3" placeholder="Kurze Beschreibung der Arbeit">${esc(description)}</textarea>
        </div>
        <div class="form-group">
          <label>Regiezettel</label>
          <div class="form-row" style="align-items:center;">
            <select class="form-control" id="ef-regie" style="max-width:120px;">
              <option value="0" ${regieVal === 0 ? 'selected' : ''}>Nein</option>
              <option value="1" ${regieVal === 1 ? 'selected' : ''}>Ja</option>
              <option value="2" ${regieVal === 2 ? 'selected' : ''}>pauschal</option>
              <option value="3" ${regieVal === 3 ? 'selected' : ''}>Büro</option>
              <option value="4" ${regieVal === 4 ? 'selected' : ''}>Lager</option>
              <option value="5" ${regieVal === 5 ? 'selected' : ''}>Intern</option>
            </select>
            <select class="form-control" id="ef-regie-user" style="${regieVal === 1 ? '' : 'display:none;'}">
              ${allUsers.map(u => `<option value="${u.id}" ${u.id == regieUserId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        ${showNotes ? `
        <div class="form-group">
          <label>Persönliche Notiz (nur für Sie sichtbar)</label>
          <textarea class="form-control" id="ef-note" rows="2" placeholder="Private Notiz...">${esc(personalNote)}</textarea>
        </div>` : ''}
        <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Speichern' : 'Eintrag erstellen'}</button>
        ${isEdit ? `<button type="button" class="btn btn-outline btn-block" id="continue-entry" style="margin-top:0.5rem">Auftrag fortsetzen</button>` : ''}
        ${canDelete ? '<button type="button" class="btn btn-danger btn-block" id="delete-entry" style="margin-top:0.5rem">Eintrag löschen</button>' : ''}
      </form>
    </div>
    ${showHistory ? `
    <div class="card" style="max-width:600px;margin:1rem auto 0;">
      <div class="card-header">
        <h3 style="margin:0;">Änderungsverlauf</h3>
        <button class="btn btn-outline btn-sm" id="load-history" type="button">Anzeigen</button>
      </div>
      <div id="entry-history" style="margin-top:0.75rem;color:var(--text-light);font-size:0.9rem;"></div>
    </div>` : ''}`;

  $app().innerHTML = layout(content, '');
  bindLayout();
  // Hide FAB on form
  const fab = document.getElementById('fab-new');
  if (fab) fab.style.display = 'none';

  // Netto-Stunden live berechnen
  const updateNet = () => {
    const f = document.getElementById('ef-from').value;
    const t = document.getElementById('ef-to').value;
    const b = parseInt(document.getElementById('ef-break').value) || 0;
    const net = calcNetHours(f, t, b);
    document.getElementById('ef-net').textContent = `Netto: ${fmtH(net)}`;
  };
  document.getElementById('ef-from').addEventListener('change', updateNet);
  document.getElementById('ef-to').addEventListener('change', updateNet);
  updateNet();

  // Regie-Toggle
  document.getElementById('ef-regie').addEventListener('change', (e) => {
    document.getElementById('ef-regie-user').style.display = e.target.value === '1' ? '' : 'none';
  });

  document.getElementById('ef-break').addEventListener('input', updateNet);

  // Projekt-Auswahl: Adresse/Kunde/Notiz übernehmen + Freitext steuern
  document.getElementById('ef-project').addEventListener('change', (e) => {
    const proj = S.projects.find(p => p.id == e.target.value);
    if (proj) {
      if (proj.address) document.getElementById('ef-address').value = proj.address;
      if (proj.client) document.getElementById('ef-client').value = proj.client;
      if (proj.note) document.getElementById('ef-desc').value = proj.note;
    }
    const ft = document.getElementById('ef-project-text');
    if (e.target.value) {
      ft.value = '';
      ft.disabled = true;
    } else {
      ft.disabled = false;
    }
  });

  document.getElementById('ef-nav').addEventListener('click', () => {
    const addr = document.getElementById('ef-address').value.trim();
    if (addr) openNav(addr); else toast('Keine Adresse eingetragen', 'error');
  });
  const efNavChange = document.getElementById('ef-nav-change');
  if (efNavChange) efNavChange.addEventListener('click', () => {
    const addr = document.getElementById('ef-address').value.trim();
    if (addr) openNav(addr, { force: true }); else toast('Keine Adresse eingetragen', 'error');
  });

  document.getElementById('back-btn').addEventListener('click', () => navigate(planningEntry ? '/planning' : '/'));

  // Form submit
  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      date: document.getElementById('ef-date').value,
      time_from: document.getElementById('ef-from').value,
      time_to: document.getElementById('ef-to').value,
      break_minutes: parseInt(document.getElementById('ef-break').value) || 0,
      address: document.getElementById('ef-address').value,
      client: document.getElementById('ef-client').value,
      project_id: document.getElementById('ef-project').value || null,
      project_text: document.getElementById('ef-project-text').value,
      description: document.getElementById('ef-desc').value,
      personal_note: document.getElementById('ef-note')?.value || '',
      has_regie: Number(document.getElementById('ef-regie').value),
      regie_user_id: document.getElementById('ef-regie').value === '1' ? Number(document.getElementById('ef-regie-user').value) : null,
    };
    // Admin muss Mitarbeiter auswählen
    const userSelect = document.getElementById('ef-user');
    if (userSelect) {
      if (!userSelect.value) { toast('Bitte einen Mitarbeiter auswählen', 'error'); return; }
      body.user_id = Number(userSelect.value);
    }
    if (body.time_from > body.time_to) {
      toast('Bis-Zeit muss nach Von-Zeit liegen', 'error');
      return;
    }

    // GoBD: Begruendung abfragen — bei fremdem Eintrag Pflicht, bei eigenem optional
    if (isEdit) {
      const reason = await promptModal(isForeign
        ? 'Begründung für die Änderung dieses fremden Eintrags (Pflicht):'
        : 'Begründung für die Änderung (optional):',
        { title: 'Begründung', required: isForeign });
      if (reason === null) return; // Abbrechen → Bearbeitung verwerfen (nicht speichern)
      if (isForeign && !reason.trim()) {
        toast('Begründung erforderlich', 'error'); return;
      }
      body.reason = reason.trim();
    }

    try {
      if (isEdit) {
        await api('PUT', '/api/entries/' + editId, body);
        toast('Eintrag aktualisiert', 'success');
      } else {
        await api('POST', '/api/entries', body);
        toast('Eintrag erstellt', 'success');
      }
      navigate('/');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Continue
  document.getElementById('continue-entry')?.addEventListener('click', () => {
    navigate('/entry/continue/' + editId);
  });

  // Delete (Soft-Delete; Begruendung abfragen — fremd Pflicht, eigen optional)
  document.getElementById('delete-entry')?.addEventListener('click', async () => {
    if (!(await confirmModal('Eintrag wirklich löschen?', { title: 'Eintrag löschen', okLabel: 'Löschen' }))) return;
    const body = {};
    const reason = await promptModal(isForeign
      ? 'Begründung für das Löschen dieses fremden Eintrags (Pflicht):'
      : 'Begründung für das Löschen (optional):',
      { title: 'Begründung', required: isForeign });
    if (reason === null) return; // Abbrechen → Eintrag NICHT löschen (gilt auch bei optionalem Grund)
    if (isForeign && !reason.trim()) {
      toast('Begründung erforderlich', 'error'); return;
    }
    body.reason = reason.trim();
    try {
      await api('DELETE', '/api/entries/' + editId, body);
      toast('Eintrag gelöscht', 'success');
      navigate('/');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Änderungsverlauf laden (chef/admin)
  document.getElementById('load-history')?.addEventListener('click', async () => {
    const box = document.getElementById('entry-history');
    box.textContent = 'Lade…';
    try {
      const data = await api('GET', '/api/entries/' + editId + '/history');
      const hist = (data && data.history) || [];
      if (!hist.length) { box.textContent = 'Keine Änderungen protokolliert.'; return; }
      box.innerHTML = hist.map(h => {
        const s = h.snapshot || {};
        const actLabel = h.action === 'delete' ? 'Gelöscht' : 'Geändert';
        const vorher = `${esc(s.date || '')} ${esc(s.time_from || '')}–${esc(s.time_to || '')}, Pause ${esc(String(s.break_minutes ?? ''))}min` +
          (s.description ? `, „${esc(s.description)}"` : '');
        return `<div style="padding:0.5rem 0;border-bottom:1px solid var(--border);">
          <strong>${actLabel}</strong> am ${esc(String(h.changed_at || '').slice(0, 19))} von ${esc(h.changed_by_name || '—')}
          ${h.reason ? `<br><em>Grund: ${esc(h.reason)}</em>` : ''}
          <br><span style="color:var(--text-lighter);">Vorher: ${vorher}</span>
        </div>`;
      }).join('');
    } catch (err) { box.textContent = 'Fehler: ' + err.message; }
  });
}

