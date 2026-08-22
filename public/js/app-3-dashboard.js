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
  const _tok = renderToken();
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
  } catch (e) {
    if (renderStale(_tok)) return;                 // inzwischen woanders → nichts überschreiben
    toast(e.message, 'error');
    renderLoadError('.main', e.message, () => renderDashboardContent()); // kein ewiger Spinner
    return;
  }
  if (renderStale(_tok)) return;                   // verspätete Antwort verwerfen

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
      <button id="date-prev" aria-label="Vorheriger Zeitraum" title="Zurück">&#8249;</button>
      <span class="current-period">${getPeriodLabel()}</span>
      <button id="date-next" aria-label="Nächster Zeitraum" title="Weiter">&#8250;</button>
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
      if (!istMauszeiger()) return;   // Maus-Ersatzereignis nach einer Beruehrung
      const e = entryMap[el.dataset.entryId];
      if (e) showTooltip(entryTooltipHtml(e), ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => {
      if (!istMauszeiger()) return;
      if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
    });
    // Auch beim Verlassen auf ein echtes Maus-Ereignis pruefen. Chrome schickt nach jeder
    // Beruehrung Maus-Ersatzereignisse; verschiebt sich dabei etwas unter dem Finger, kam ein
    // mouseleave — und die per langem Druck geoeffnete Sprechblase war beim Loslassen wieder weg.
    el.addEventListener('mouseleave', () => { if (istMauszeiger()) hideTooltip(); });
    // Auf dem Handy dasselbe per langem Druck (B7) — die Planung kann das laengst.
    attachLongPressTooltip(el, () => {
      const e = entryMap[el.dataset.entryId];
      return e ? entryTooltipHtml(e) : '';
    });
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
        <div class="tl-col-header-name">${isSingle ? '' : avatarHtml({ id: col.id, name: col.name }, 22) + ' '}${headerLabel}</div>
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
  await ladeArbeitszeit();   // Firmenvorgaben fuer die Vorbelegung (einmal je Sitzung)
  await ladeAbschluss();     // Stichtag der Abrechnung (fuer den Hinweis, gesperrt wird serverseitig)
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

  // Endzeit des letzten Eintrags dieses Mitarbeiters an DIESEM Datum — oder null, wenn noch nichts gebucht ist.
  // Alle Einträge eines Tages für EINEN Mitarbeiter. Startzeit-Vorschlag und Restpause brauchen
  // dieselbe Liste — sie wird deshalb einmal geholt und beiden gereicht.
  async function tagesEintraege(dateStr, userId) {
    if (!dateStr) return [];
    try {
      const params = new URLSearchParams({ date_from: dateStr, date_to: dateStr });
      if (userId) params.set('user_id', String(userId));
      const data = await api('GET', '/api/entries?' + params.toString());
      return ((data && data.entries) || []).filter(e => !userId || e.user_id === Number(userId));
    } catch (_) { return []; }
  }

  function letzteEndzeit(liste) {
    if (!liste.length) return null;
    const max = liste.reduce((m, e) => (e.time_to && e.time_to > m ? e.time_to : m), '00:00');
    return max === '00:00' ? null : max;
  }

  /**
   * Gesetzlich vorgeschriebene Mindestpause nach § 4 Arbeitszeitgesetz, bezogen auf die
   * ANWESENHEIT eines Tages (Brutto, also inklusive Pause).
   *
   * Das Gesetz bemisst die Pause an der Arbeitszeit — und die ist Anwesenheit MINUS Pause.
   * Daraus wird schnell ein Ringelspiel: 9:45 Anwesenheit ergibt mit 30 min Pause 9:15
   * Arbeitszeit (über 9 → 45 nötig), mit 45 min aber 9:00 (nicht über 9 → 30 genügt).
   * Deshalb wird hier die KLEINSTE Pause gesucht, mit der die Vorschrift erfüllt ist — bei
   * 9:45 also 45, weil 30 sie verletzen würde. Damit gibt es keine Schwingung.
   *
   * Fängt nebenbei die bekannte Sechs-Stunden-Falle: 6:20 Anwesenheit braucht 30 min Pause,
   * sonst wären es 6:20 Arbeit am Stück.
   */
  function gesetzlichePause(bruttoMin, jugendlich) {
    // § 11 JArbSchG (unter 18): über 4½ bis 6 Std → 30 min, über 6 Std → 60 min.
    // § 4 ArbZG (ab 18):        über 6 bis 9 Std → 30 min, über 9 Std → 45 min.
    const noetig = jugendlich
      ? (a) => a > 6 * 60 ? 60 : (a > 4.5 * 60 ? 30 : 0)
      : (a) => a > 9 * 60 ? 45 : (a > 6 * 60 ? 30 : 0);
    // Kandidaten sind die im Gesetz genannten Werte — nur sie ergeben eine erklärbare Zahl.
    for (const p of (jugendlich ? [0, 30, 60] : [0, 30, 45])) {
      if (noetig(bruttoMin - p) <= p) return p;
    }
    return jugendlich ? 60 : 45;
  }

  /**
   * Ist die Person am `datum` noch keine 18?
   *
   * OHNE Geburtsdatum wird „ja" angenommen — lieber eine zu lange Pause vorschlagen als eine zu
   * kurze bei einem Minderjährigen. Gerechnet wird auf den Eintragstag, nicht auf heute: Wer im
   * Mai 18 wird, fällt für einen Eintrag aus dem März noch unter den Jugendschutz.
   */
  // ZUERST der angemeldete Nutzer selbst: Ein Mitarbeiter darf /api/users nicht laden, für ihn
  // ist S.users leer — derselbe Grund wie beim Arbeitsbeginn.
  function geburtsdatumVon(userId) {
    const id = userId ? Number(userId) : (S.user && Number(S.user.id));
    if (S.user && Number(S.user.id) === id && S.user.birth_date) return S.user.birth_date;
    const u = (S.users || []).find(x => Number(x.id) === id);
    return (u && u.birth_date) || null;
  }

  function istJugendlich(userId, datum) {
    const geburt = geburtsdatumVon(userId);
    if (!geburt) return true;                                   // unbekannt → strengere Regel
    const achtzehn = new Date(String(geburt) + 'T12:00:00Z');
    if (isNaN(achtzehn.getTime())) return true;
    achtzehn.setUTCFullYear(achtzehn.getUTCFullYear() + 18);
    return String(datum || '') < achtzehn.toISOString().slice(0, 10);
  }

  const bruttoMinuten = (von, bis) => {
    const [vh, vm] = String(von || '').split(':').map(Number);
    const [bh, bm] = String(bis || '').split(':').map(Number);
    if ([vh, vm, bh, bm].some(n => !Number.isFinite(n))) return 0;
    return Math.max(0, (bh * 60 + bm) - (vh * 60 + vm));
  };

  /**
   * Wie viel Pause ist an diesem Tag noch offen?
   *
   * Firmenpause minus alles, was am Tag schon eingetragen ist — nie unter 0. Damit steht beim
   * zweiten Auftrag nicht noch einmal die volle Pause im Feld: Wer sie morgens genommen hat,
   * nimmt sie nachmittags nicht ein zweites Mal.
   *
   * Es zählen ALLE Einträge des Tages, auch die, die jemand anderes für ihn erfasst hat — es ist
   * sein Arbeitstag, unabhängig davon, wer getippt hat.
   *
   * @returns {{ rest: number, genommen: number, firma: number, hatEintraege: boolean }}
   */
  /**
   * Anwesenheit eines Tages in Minuten — überlappende Einträge zählen NICHT doppelt.
   *
   * Zeitgleich dokumentierte Aufträge sind bei SenTec ausdrücklich gewollt (zwei Baustellen auf
   * einem Beleg, Regie neben Festpreis). Für alles, was das Gesetz an der Anwesenheit festmacht,
   * zählt aber die Uhr und nicht die Anzahl der Belege.
   */
  function anwesenheitMinuten(liste, aktuellVon, aktuellBis) {
    const zuMin = (s) => {
      const [h, m] = String(s || '').split(':').map(Number);
      return (Number.isFinite(h) && Number.isFinite(m)) ? h * 60 + m : null;
    };
    const spannen = [];
    for (const e of liste) {
      const a = zuMin(e.time_from), b = zuMin(e.time_to);
      if (a !== null && b !== null && b > a) spannen.push([a, b]);
    }
    const a = zuMin(aktuellVon), b = zuMin(aktuellBis);
    if (a !== null && b !== null && b > a) spannen.push([a, b]);
    if (!spannen.length) return 0;
    spannen.sort((x, y) => x[0] - y[0]);
    let summe = 0, von = spannen[0][0], bis = spannen[0][1];
    for (let i = 1; i < spannen.length; i++) {
      if (spannen[i][0] <= bis) bis = Math.max(bis, spannen[i][1]);
      else { summe += bis - von; von = spannen[i][0]; bis = spannen[i][1]; }
    }
    return summe + (bis - von);
  }

  function restPause(liste, aktuellVon, aktuellBis, jugendlich, geburtBekannt) {
    const firma = Number(arbeitszeitJetzt().break_minutes_default) || 0;
    const genommen = liste.reduce((s, e) => s + (Number(e.break_minutes) || 0), 0);

    // Anwesenheit des GANZEN Tages — ÜBERLAPPUNGSFREI, nicht als Summe der Einträge.
    //
    // Wer zwei Aufträge zeitgleich dokumentiert (zweimal 07:00–12:00, beim Kunden 10 Stunden), war
    // trotzdem nur 5 Stunden da. Die frühere Summe kam hier auf 10 Stunden und hob die Pause nach
    // § 4 ArbZG auf 45 Minuten an — für eine Arbeitszeit, die es nie gab, und mit einem Gesetz
    // begründet, das gar nicht greift. (Gefunden von Alex, 30.07.2026.)
    const bruttoTag = anwesenheitMinuten(liste, aktuellVon, aktuellBis);
    const gesetzlich = gesetzlichePause(bruttoTag, jugendlich);

    // Der Firmenwert ist die Untergrenze — das Gesetz kann ihn nur ANHEBEN, nie senken.
    const ziel = Math.max(firma, gesetzlich);
    return {
      rest: Math.max(0, ziel - genommen), genommen, firma, gesetzlich, ziel,
      bruttoTag, hatEintraege: liste.length > 0, jugendlich, geburtBekannt: !!geburtBekannt,
      gesetzGreift: gesetzlich > firma,
    };
  }

  // ── Höchstarbeitszeit ──────────────────────────────────────────────────────────────────────
  //
  // § 3 ArbZG: werktäglich 8 Stunden, verlängerbar auf 10, wenn der Schnitt über 24 Wochen bei 8
  // bleibt. 10 Stunden sind die harte Decke.
  // § 8 JArbSchG: 8 Stunden täglich UND 40 Stunden wöchentlich. 8½ an einzelnen Tagen nur, wenn an
  // einem anderen Werktag derselben Woche verkürzt wird — das ist keine freie Option, sondern eine
  // Bedingung. Die App nennt sie im Text und überlässt die Beurteilung dem Menschen (Alex' Wahl).
  const MAX_TAG_ERWACHSEN = 10 * 60;
  const MAX_TAG_JUGEND    = 8 * 60;
  const MAX_WOCHE_JUGEND  = 40 * 60;

  // Netto-Minuten einer Menge von Einträgen — über calcActualHours, damit sich überlappende
  // Einträge nicht doppelt zählen (dieselbe Rechnung wie in Statistik und PDF).
  function nettoMinuten(eintraege) {
    return Math.round(calcActualHours(eintraege) * 60);
  }

  // Der Tag/die Woche MIT dem, was gerade im Formular steht. Beim Bearbeiten muss der eigene
  // gespeicherte Eintrag raus, sonst zählt er doppelt — dieselbe Falle wie bei der Restpause.
  function mitFormular(liste, eigeneId, userId, datum, von, bis, pause) {
    const ohneSichSelbst = liste.filter(e => !eigeneId || Number(e.id) !== Number(eigeneId));
    const jetzt = (von && bis && bis > von)
      ? [{ user_id: Number(userId), date: datum, time_from: von, time_to: bis, break_minutes: Number(pause) || 0 }]
      : [];
    return ohneSichSelbst.concat(jetzt);
  }

  function montagDer(datum) {
    const d = new Date(datum + 'T12:00:00Z');
    const wt = d.getUTCDay();                       // 0 = Sonntag
    d.setUTCDate(d.getUTCDate() + (wt === 0 ? -6 : 1 - wt));
    return d.toISOString().slice(0, 10);
  }
  function plusTage(iso, n) {
    const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Text der Warnung — leer, solange alles im Rahmen ist.
   * @returns {string}
   */
  function hoechstzeitWarnung(tagMin, wochenMin, jugendlich) {
    const grenze = jugendlich ? MAX_TAG_JUGEND : MAX_TAG_ERWACHSEN;
    const saetze = [];
    if (tagMin > grenze) {
      saetze.push(jugendlich
        ? `Der Tag kommt auf ${STUNDEN(tagMin)} Arbeitszeit. Für unter 18-Jährige sind höchstens `
          + `8 Stunden erlaubt; 8½ nur, wenn an einem anderen Tag derselben Woche verkürzt wird `
          + `(§ 8 Jugendarbeitsschutzgesetz).`
        : `Der Tag kommt auf ${STUNDEN(tagMin)} Arbeitszeit. Das Arbeitszeitgesetz erlaubt `
          + `höchstens 10 Stunden (§ 3 ArbZG).`);
    }
    // Die Wochengrenze reisst man mit fünf normalen Tagen schneller als die Tagesgrenze — und beim
    // Buchen fällt es niemandem auf, weil man immer nur einen Tag vor sich hat.
    if (jugendlich && wochenMin !== null && wochenMin > MAX_WOCHE_JUGEND) {
      saetze.push(`Die Woche kommt damit auf ${STUNDEN(wochenMin)}. Für unter 18-Jährige sind `
        + `höchstens 40 Stunden pro Woche erlaubt (§ 8 Jugendarbeitsschutzgesetz).`);
    }
    return saetze.join(' ');
  }

  async function lastEndOfDay(dateStr, userId) {
    return letzteEndzeit(await tagesEintraege(dateStr, userId));
  }

  // Arbeitsbeginn des Mitarbeiters (je Person einstellbar, Vorgabe 07:00). Für den angemeldeten
  // Nutzer aus S.user, für einen vom Admin gewählten aus S.users.
  // Reihenfolge: eigener Wert des Mitarbeiters → Firmenwert aus den Einstellungen → 07:00.
  // Leer beim Mitarbeiter heisst ausdruecklich „es gilt der Firmenwert" — nur so wirkt eine spaetere
  // Umstellung der Firmenvorgabe auch bei den Bestandsmitarbeitern.
  function arbeitsbeginnVon(userId) {
    const id = userId ? Number(userId) : (S.user && Number(S.user.id));
    // ZUERST der angemeldete Nutzer selbst: ein Mitarbeiter darf /api/users nicht laden, S.users ist
    // bei ihm also leer — sein eigener Wert stuende sonst nirgends und er bekaeme faelschlich den
    // Firmenwert. Erst danach in der Nutzerliste suchen (Admin hat dort einen anderen MA gewaehlt).
    let eigener = (S.user && Number(S.user.id) === id) ? S.user.work_start : null;
    if (!eigener) {
      const u = (S.users || []).find(x => Number(x.id) === id);
      eigener = u && u.work_start;
    }
    return eigener || arbeitszeitJetzt().work_start_default || '07:00';
  }

  // Startzeit-Vorschlag. Reihenfolge bewusst so:
  //   1. Endzeit des letzten Eintrags des Tages — die REALITÄT hat Vorrang. Auch wenn eine Planung eine
  //      frühere Startzeit vorsieht: Endete der Auftrag davor erst um 11, darf nicht 10 vorgeschlagen
  //      werden, sonst entstünde eine Überlappung (doppelt gebuchte Zeit).
  //   2. sonst die geplante Startzeit (erster Auftrag des Tages aus der Planung)
  //   3. sonst der Arbeitsbeginn des Mitarbeiters
  // Immer nur ein Vorschlag — jederzeit überschreibbar (z. B. für Nachträge).
  //
  // Mitgeliefert wird, WOHER der Vorschlag stammt: 'echt' = Endzeit eines gebuchten Eintrags,
  // 'annahme' = Planung oder Arbeitsbeginn. Der Unterschied entscheidet, wie eine Zeit korrigiert
  // wird, die nach der aktuellen Uhrzeit läge (siehe zeitenAbgleichen).
  async function suggestStart(dateStr, userId, plannedFrom, liste) {
    const lastEnd = liste ? letzteEndzeit(liste) : await lastEndOfDay(dateStr, userId);
    if (lastEnd) return { zeit: lastEnd, quelle: 'echt' };
    return { zeit: plannedFrom || arbeitsbeginnVon(userId), quelle: 'annahme' };
  }

  // „Bis" darf nie vor „Von" liegen — sonst schlägt das Formular eine unmögliche Spanne vor und das
  // Speichern scheitert an einer Prüfung, obwohl der Nutzer nichts falsch gemacht hat (Fall: vor
  // dem Arbeitsbeginn einen Eintrag anlegen, etwa um 06:15 bei Arbeitsbeginn 07:00).
  //
  // WIE korrigiert wird, hängt davon ab, woher der Vorschlag kommt:
  //   * 'annahme' (Arbeitsbeginn/Planung) → beide auf jetzt. Wer um 06:30 anfängt, hat um 06:30
  //     angefangen; die Annahme 07:00 ist dann schlicht falsch.
  //   * 'echt' (Endzeit eines gebuchten Eintrags) → „Von" bleibt stehen, „Bis" zieht hoch. Sonst
  //     liefe der neue Eintrag IN den vorhandenen hinein (doppelt gebuchte Zeit) — genau das, was
  //     die Reihenfolge oben verhindern soll. Fall: morgens den ganzen Tag im Voraus gebucht.
  function zeitenAbgleichen(von, bis, quelle) {
    if (von <= bis) return { von, bis };                       // Normalfall, nichts zu tun
    return quelle === 'echt' ? { von, bis: von } : { von: bis, bis };
  }
  const title = isEdit ? 'Eintrag bearbeiten' : (projectSource ? 'Auftrag als Zeitnachweis übernehmen' : (planningEntry ? 'Eintrag aus Planung erstellen' : (continueEntry ? 'Weiter arbeiten' : 'Neuer Eintrag')));

  const nowTime = `${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`;
  const date = isEdit ? entry.date : today;
  // Neue Einträge: an den letzten Eintrag des Tages anschließen; sonst geplante Startzeit; sonst 07:00.
  let timeFrom, timeTo;
  if (isEdit) {
    timeFrom = entry.time_from;
    timeTo = entry.time_to;
  } else {
    const v = await suggestStart(date, isAdmin() ? null : S.user.id, planningEntry ? planningEntry.time_from : null);
    const abgeglichen = zeitenAbgleichen(v.zeit, nowTime, v.quelle);
    timeFrom = abgeglichen.von;
    timeTo = abgeglichen.bis;
  }
  // Pause. Beim BEARBEITEN bleibt der gespeicherte Wert unangetastet — würde hier die Restpause
  // gerechnet, zeigte ein Eintrag mit voller Pause plötzlich 0, und einmal Speichern löschte sie.
  //
  // Sonst: Was am Tag schon erfasst ist, gewinnt immer (auch gegen eine übernommene Planung —
  // sonst stünde die Pause zweimal im Tag). Ist der Tag noch leer, gilt der Planungswert, sonst
  // der Firmenwert.
  // Muss VOR der Vorbelegung stehen: const wird nicht hochgezogen.
  /**
   * Der vorgeschlagene Wert fürs Pausenfeld.
   *
   * `info.rest` trägt bereits alles: Firmenwert als Untergrenze, gesetzliche Anhebung, minus dem
   * am Tag schon Erfassten. Eine übernommene Planung gilt nur auf einem noch leeren Tag — aber
   * auch sie kann das Gesetz nicht unterbieten.
   */
  const pausenVorschlag = (info, planungsPause) => {
    if (info.hatEintraege) return info.rest;
    if (planungsPause != null) return Math.max(Number(planungsPause) || 0, info.gesetzlich || 0);
    return info.rest;
  };

  // Ohne Tagesbezug (Admin, noch kein Mitarbeiter gewählt): Es ist nichts erfasst, also steht die
  // VOLLE Firmenpause offen. `rest: 0` wäre falsch — das Feld zeigte dann 0 statt 30.
  const leerePausenInfo = () => {
    const f = Number(arbeitszeitJetzt().break_minutes_default) || 0;
    return { rest: f, genommen: 0, firma: f, gesetzlich: 0, ziel: f, bruttoTag: 0, hatEintraege: false, gesetzGreift: false };
  };
  let pausenInfo = leerePausenInfo();
  let breakMin;
  if (isEdit) {
    breakMin = entry.break_minutes;
  } else {
    // Ohne gewählten Mitarbeiter (Admin beim Öffnen) gibt es keinen Tagesbezug — dann Firmenwert;
    // refreshVorschlag zieht nach, sobald jemand ausgewählt ist.
    const uidFuerTag = isAdmin() ? null : S.user.id;
    if (uidFuerTag) {
      pausenInfo = restPause(await tagesEintraege(date, uidFuerTag), timeFrom, timeTo,
        istJugendlich(uidFuerTag, date), !!geburtsdatumVon(uidFuerTag));
    }
    breakMin = pausenVorschlag(pausenInfo, planningEntry ? planningEntry.break_minutes : null);
  }
  // Der Text erklärt die Zahl im Feld. Ohne ihn wirkt eine 0 wie ein Fehler und ein Nachschlag
  // von 15 min wie Willkür.
  const STUNDEN = (min) => {
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} Std ${m} min` : `${h} Std`;
  };
  const pausenHinweis = (info) => {
    if (info.gesetzGreift) {
      const schwelle = info.jugendlich ? (info.gesetzlich === 60 ? 6 : '4½') : (info.gesetzlich === 45 ? 9 : 6);
      // Die App kennt das Alter jetzt selbst und nennt deshalb das ZUTREFFENDE Gesetz.
      const gesetz = info.jugendlich ? 'Jugendarbeitsschutzgesetz' : 'Arbeitszeitgesetz';
      const kern = `Der Tag kommt auf ${STUNDEN(info.bruttoTag)} Anwesenheit. Ab ${schwelle} Stunden `
        + `Arbeitszeit schreibt das ${gesetz} ${info.gesetzlich} min Pause vor `
        + `(Firmenwert: ${info.firma} min).`;
      // Nur wenn ohne Geburtsdatum gerechnet wurde, muss man sagen, worauf die Annahme beruht.
      const jugend = (info.jugendlich && !info.geburtBekannt)
        ? ' (Ohne Geburtsdatum wird vorsichtshalber „unter 18" angenommen.)' : '';
      // Drei Fälle, drei Sätze. „es fehlen 0 min" wäre Unsinn, und ein Kleinbuchstabe nach dem
      // Punkt liest sich wie ein Tippfehler — beides von tests/pause-beispiele.js aufgedeckt.
      if (info.genommen === 0) return kern + jugend;
      if (info.rest === 0) return `${kern} Bisher ${info.genommen} min erfasst — damit ist sie erfüllt.` + jugend;
      return `${kern} Bisher ${info.genommen} min erfasst, es fehlen ${info.rest} min.` + jugend;
    }
    if (info.hatEintraege && info.genommen > 0) {
      return `Firmenpause ${info.firma} min · heute schon ${info.genommen} min erfasst`;
    }
    return '';
  };
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

  // Abrechnungs-Abschluss: Liegt der Eintrag in einem bezahlten Zeitraum, wird hier NICHT der
  // Knopf ausgeblendet — das waere nur Kosmetik, gesperrt wird ohnehin serverseitig. Stattdessen
  // erklaert ein Hinweis, warum das Speichern gleich abgelehnt wird, und der Admin bekommt vorab
  // gesagt, dass er eine Begruendung angeben muss.
  const entryDatum = isEdit ? entry.date : null;
  const gesperrt = isEdit && istAbgerechnet(entryDatum);
  const darfTrotzdem = gesperrt && isAdmin();

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
          <small class="push-hint" id="ef-break-hinweis" ${pausenHinweis(pausenInfo) ? '' : 'style="display:none"'}>${esc(pausenHinweis(pausenInfo))}</small>
        </div>
        <div class="net-hours-display" id="ef-net">Netto: ${fmtH(netHours)}</div>
        <div class="warning-box" id="ef-zeit-warnung" role="status" style="display:none"></div>
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
        ${gesperrt ? `
        <div class="push-hint" id="abgerechnet-hinweis" style="border-left:3px solid var(--warning,#e0a800);padding-left:0.6rem;margin-bottom:0.75rem;">
          🔒 ${esc(ABGERECHNET_HINWEIS(abgerechnetBisJetzt()))}
          ${darfTrotzdem
            ? ' Als Administrator können Sie ihn dennoch ändern — Sie werden nach einer Begründung gefragt, und die Änderung wird protokolliert.'
            : ' Wenden Sie sich an den Administrator.'}
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

  // Höchstarbeitszeit prüfen — gilt für NEUE Einträge wie fürs Bearbeiten. Gerechnet wird der ganze
  // Tag (alle Einträge dieser Person, überlappungsfrei), nicht nur die aktuelle Buchung: Genau so
  // reisst man die Grenze unbemerkt — dreimal vier Stunden auf drei Auftraege.
  // Es ist ein HINWEIS, keine Sperre. Wer elf Stunden gearbeitet hat, muss das eintragen können,
  // sonst wird falsch dokumentiert — das wäre das groessere Problem.
  const warnEl = document.getElementById('ef-zeit-warnung');
  const pruefeHoechstzeit = async () => {
    if (!warnEl) return;
    const d = document.getElementById('ef-date')?.value;
    const uSel = document.getElementById('ef-user');
    const uid = uSel ? Number(uSel.value) : (isEdit ? Number(entry.user_id) : S.user.id);
    const von = document.getElementById('ef-from')?.value;
    const bis = document.getElementById('ef-to')?.value;
    const pause = document.getElementById('ef-break')?.value;
    if (!d || !uid || !von || !bis) { warnEl.style.display = 'none'; return; }

    const jugendlich = istJugendlich(uid, d);
    const tagListe = await tagesEintraege(d, uid);
    const eigeneId = isEdit ? entry.id : null;
    const tagMin = nettoMinuten(mitFormular(tagListe, eigeneId, uid, d, von, bis, pause));

    // Die Woche wird nur geholt, wenn sie ueberhaupt eine Grenze hat (unter 18).
    let wochenMin = null;
    if (jugendlich) {
      const mo = montagDer(d);
      try {
        const params = new URLSearchParams({ date_from: mo, date_to: plusTage(mo, 6), user_id: String(uid) });
        const data = await api('GET', '/api/entries?' + params.toString());
        const woche = ((data && data.entries) || []).filter(e => e.user_id === uid);
        wochenMin = nettoMinuten(mitFormular(woche, eigeneId, uid, d, von, bis, pause));
      } catch (_) { wochenMin = null; }
    }

    const txt = hoechstzeitWarnung(tagMin, wochenMin, jugendlich);
    warnEl.textContent = txt ? '⚠️ ' + txt : '';
    warnEl.style.display = txt ? '' : 'none';
  };
  for (const id of ['ef-date', 'ef-user', 'ef-from', 'ef-to', 'ef-break']) {
    // Bewusst 'change' und nicht 'input': Sonst liefe bei jedem Tastendruck in der Pause eine
    // Abfrage los, und bei halb getippten Uhrzeiten stuende kurz eine unsinnige Warnung da.
    document.getElementById(id)?.addEventListener('change', pruefeHoechstzeit);
  }
  pruefeHoechstzeit();

  // Startzeit-Vorschlag nachziehen, wenn Datum oder Mitarbeiter gewechselt wird (nur bei NEUEN Einträgen und
  // nur solange der Vorschlag unverändert ist — hat der Nutzer die Zeit selbst gesetzt, bleibt sie stehen).
  if (!isEdit) {
    let lastSuggested = timeFrom;
    let letztePause = String(breakMin);
    // Zieht Startzeit UND Restpause nach, wenn Datum oder Mitarbeiter wechseln. Beide haben ihre
    // EIGENE „manuell geändert"-Erkennung: Wer nur die Pause angefasst hat, dem soll trotzdem die
    // Startzeit nachgezogen werden — und umgekehrt.
    const refreshVorschlag = async () => {
      const fromEl = document.getElementById('ef-from');
      const breakEl = document.getElementById('ef-break');
      const d = document.getElementById('ef-date')?.value;
      const uSel = document.getElementById('ef-user');
      const uid = uSel ? Number(uSel.value) : (isAdmin() ? null : S.user.id);
      // EINE Abfrage für beides.
      const liste = uid ? await tagesEintraege(d, uid) : [];

      if (fromEl && fromEl.value === lastSuggested) {
        const v = await suggestStart(d, uid, planningEntry ? planningEntry.time_from : null, uid ? liste : undefined);
        const toEl = document.getElementById('ef-to');
        const a = zeitenAbgleichen(v.zeit, (toEl && toEl.value) || nowTime, v.quelle);
        if (fromEl.value === lastSuggested) {
          fromEl.value = a.von;
          lastSuggested = a.von;                               // den KORRIGIERTEN Wert merken,
          // sonst hält die „manuell geändert"-Erkennung den Vorschlag für eine Nutzereingabe.
          if (toEl && toEl.value !== a.bis) toEl.value = a.bis;
        }
      }

      if (breakEl && breakEl.value === letztePause) {
        const vonJetzt = (document.getElementById('ef-from') || {}).value;
        const bisJetzt = (document.getElementById('ef-to') || {}).value;
        const info = uid
          ? restPause(liste, vonJetzt, bisJetzt, istJugendlich(uid, d), !!geburtsdatumVon(uid))
          : leerePausenInfo();
        const neu = pausenVorschlag(info, planningEntry ? planningEntry.break_minutes : null);
        if (breakEl.value === letztePause) {
          breakEl.value = String(neu);
          letztePause = String(neu);
        }
        const hinweisEl = document.getElementById('ef-break-hinweis');
        if (hinweisEl) {
          const txt = pausenHinweis(info);
          hinweisEl.textContent = txt;
          hinweisEl.style.display = txt ? '' : 'none';
        }
      }
      updateNet();
    };
    document.getElementById('ef-date')?.addEventListener('change', refreshVorschlag);
    document.getElementById('ef-user')?.addEventListener('change', refreshVorschlag);
    // Auch bei den Uhrzeiten: Erst wenn jemand „Bis" verlängert, geht der Tag über 9 Stunden —
    // und genau dann muss der Pausenvorschlag mitwachsen.
    document.getElementById('ef-from')?.addEventListener('change', refreshVorschlag);
    document.getElementById('ef-to')?.addEventListener('change', refreshVorschlag);
    // Admin: beim Öffnen steht schon ein Mitarbeiter im Feld → dessen Tag nachziehen
    if (document.getElementById('ef-user')) refreshVorschlag();
  }

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

  document.getElementById('back-btn').addEventListener('click', () => {
    // Bei einer übernommenen Planung dorthin zurück, wo das Übernehmen ausgelöst wurde
    // (Willkommensseite oder Planung). Ohne Merker — etwa nach einem Neuladen — wie bisher zur Planung.
    const ziel = planningEntry ? (S._uebernahmeVon || '/planning') : '/';
    S._uebernahmeVon = null;
    navigate(ziel);
  });

  // Entwurfs-Sicherung (B4). Schluessel je Datensatz, damit der Entwurf von Eintrag 42 nicht in
  // Eintrag 43 auftaucht; „neu" bekommt zusaetzlich die Herkunft (Planung/Fortsetzen/Projekt).
  const entwurfName = isEdit ? 'eintrag:' + editId
    : 'eintrag:neu' + (planningId ? ':plan' + planningId : '') + (continueId ? ':weiter' + continueId : '')
      + (fromProjectId ? ':projekt' + fromProjectId : '');
  initDraftKeeper(document.getElementById('entry-form'), entwurfName);

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
      has_regie: Number(document.getElementById('ef-regie').value),
      regie_user_id: document.getElementById('ef-regie').value === '1' ? Number(document.getElementById('ef-regie-user').value) : null,
    };
    // A16: Die persönliche Notiz nur mitschicken, wenn das Feld überhaupt angezeigt wird. Für Chef/Buchhalter
    // ist es ausgeblendet — vorher wurde trotzdem '' gesendet und damit die private Notiz des Mitarbeiters
    // beim Bearbeiten seines Eintrags stillschweigend gelöscht.
    const noteEl = document.getElementById('ef-note');
    if (noteEl) body.personal_note = noteEl.value;
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

    // GoBD: Begruendung abfragen — bei fremdem Eintrag Pflicht, bei eigenem optional.
    // Im abgerechneten Zeitraum ist sie fuer den Admin ebenfalls Pflicht (der Server verlangt sie);
    // fuer alle anderen bleibt sie optional, weil das Speichern ohnehin abgelehnt wird.
    if (isEdit) {
      const pflicht = isForeign || darfTrotzdem;
      const reason = await promptModal(
        darfTrotzdem ? 'Warum wird dieser bereits abgerechnete Eintrag geändert? (Pflicht)'
          : isForeign ? 'Begründung für die Änderung dieses fremden Eintrags (Pflicht):'
          : 'Begründung für die Änderung (optional):',
        { title: darfTrotzdem ? 'Änderung im abgerechneten Zeitraum' : 'Begründung', required: pflicht });
      if (reason === null) return; // Abbrechen → Bearbeitung verwerfen (nicht speichern)
      if (pflicht && !reason.trim()) {
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
      entwurfLoeschen(entwurfName);   // gespeichert → Entwurf hat sich erledigt
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
    const pflicht = isForeign || darfTrotzdem;
    const reason = await promptModal(
      darfTrotzdem ? 'Warum wird dieser bereits abgerechnete Eintrag gelöscht? (Pflicht)'
        : isForeign ? 'Begründung für das Löschen dieses fremden Eintrags (Pflicht):'
        : 'Begründung für das Löschen (optional):',
      { title: darfTrotzdem ? 'Löschen im abgerechneten Zeitraum' : 'Begründung', required: pflicht });
    if (reason === null) return; // Abbrechen → Eintrag NICHT löschen (gilt auch bei optionalem Grund)
    if (pflicht && !reason.trim()) {
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

