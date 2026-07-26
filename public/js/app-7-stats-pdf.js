// --- PDF Export ---
async function renderPdfExport() {
  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    if (canViewAll()) {
      const uData = await api('GET', '/api/users');
      if (uData) S.users = uData.users;
    }
  } catch (e) {}

  const now = new Date();
  const weekRange = getWeekRange(now);
  const monthRange = getMonthRange(now);
  const lastWeekDate = new Date(now); lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeekRange = getWeekRange(lastWeekDate);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const lastMonthRange = getMonthRange(lastMonthDate);

  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <h2 style="margin-bottom:1rem;">PDF-Export</h2>
      <form id="pdf-form">
        ${canViewAll() ? `
        <div class="form-group">
          <label>Mitarbeiter</label>
          <select class="form-control" id="pdf-user">
            <option value="">Alle Mitarbeiter</option>
            ${getWorkerUsers().map(u => `<option value="${u.id}">${workerLabel(u)}</option>`).join('')}
          </select>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Projekt</label>
          <select class="form-control" id="pdf-project">
            <option value="">Alle Projekte</option>
            ${S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Zeitraum</label>
          <select class="form-control" id="pdf-period">
            <option value="week">Aktuelle Woche</option>
            <option value="lastWeek">Vergangene Woche</option>
            <option value="month" selected>Aktueller Monat</option>
            <option value="lastMonth">Vergangener Monat</option>
            <option value="custom">Benutzerdefiniert</option>
          </select>
        </div>
        <div class="form-row" id="pdf-custom-dates" style="display:none;">
          <div class="form-group">
            <label>Von</label>
            <input type="date" class="form-control" id="pdf-from" value="${monthRange.from}">
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="date" class="form-control" id="pdf-to" value="${monthRange.to}">
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">PDF herunterladen</button>
      </form>
    </div>`;

  $app().innerHTML = layout(content, 'pdf');
  bindLayout();

  const RANGES = { week: weekRange, lastWeek: lastWeekRange, month: monthRange, lastMonth: lastMonthRange };

  document.getElementById('pdf-period').addEventListener('change', (e) => {
    document.getElementById('pdf-custom-dates').style.display = e.target.value === 'custom' ? 'grid' : 'none';
    const r = RANGES[e.target.value];
    if (r) {
      document.getElementById('pdf-from').value = r.from;
      document.getElementById('pdf-to').value = r.to;
    }
  });

  document.getElementById('pdf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const period = document.getElementById('pdf-period').value;
    let dateFrom, dateTo;
    if (RANGES[period]) { dateFrom = RANGES[period].from; dateTo = RANGES[period].to; }
    else { dateFrom = document.getElementById('pdf-from').value; dateTo = document.getElementById('pdf-to').value; }

    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    const userId = document.getElementById('pdf-user')?.value;
    if (userId) params.set('user_id', userId);
    const projectId = document.getElementById('pdf-project').value;
    if (projectId) params.set('project_id', projectId);

    try {
      const res = await fetch('/api/pdf/export?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + S.token }
      });
      if (!res.ok) throw new Error('PDF-Export fehlgeschlagen');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `arbeitsdoku_${dateFrom}_${dateTo}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('PDF heruntergeladen', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Statistik ---
async function renderStatistics() {
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'statistics');
  bindLayout();

  // State für Statistik
  if (!S.statsPeriod) S.statsPeriod = 'month';
  if (!S.statsDate) S.statsDate = new Date();
  if (!S.statsSelectedUsers) S.statsSelectedUsers = new Set();

  try {
    if (canViewAll()) {
      const ud = await api('GET', '/api/users');
      if (ud) S.users = ud.users;
    }
  } catch (e) {}

  renderStatisticsContent();
}

async function renderStatisticsContent() {
  const _tok = renderToken();
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const period = S.statsPeriod;
  const refDate = S.statsDate;

  // User-IDs bestimmen
  let userIds = [];
  if (S.user.role === 'mitarbeiter') {
    userIds = [S.user.id];
  } else if (S.statsSelectedUsers.size > 0) {
    userIds = [...S.statsSelectedUsers];
  } else {
    userIds = getWorkerUsers().map(u => u.id);
  }

  const dateStr = formatDateISO(refDate);
  const params = new URLSearchParams({ period, date: dateStr });
  if (userIds.length > 0) params.set('user_ids', userIds.join(','));

  let stats;
  try {
    stats = await api('GET', '/api/statistics?' + params.toString());
    if (!stats) return;
  } catch (e) {
    if (renderStale(_tok)) return;
    toast(e.message, 'error');
    renderLoadError('.main', e.message, () => renderStatisticsContent());
    return;
  }
  if (renderStale(_tok)) return;   // verspätete Antwort verwerfen

  // Period-Label
  const periodLabels = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr', total: 'Gesamt' };

  // Navigation
  function navStatsDate(dir) {
    if (period === 'day') S.statsDate.setDate(S.statsDate.getDate() + dir);
    else if (period === 'week') S.statsDate.setDate(S.statsDate.getDate() + dir * 7);
    else if (period === 'month') S.statsDate.setMonth(S.statsDate.getMonth() + dir);
    else if (period === 'year') S.statsDate.setFullYear(S.statsDate.getFullYear() + dir);
  }

  // Mitarbeiter-Chips
  let chipsHtml = '';
  if (canViewAll()) {
    const workers = getWorkerUsers();
    chipsHtml = '<div class="emp-chips stats-chips">';
    workers.forEach((u, i) => {
      const active = S.statsSelectedUsers.size === 0 || S.statsSelectedUsers.has(u.id);
      const color = colorFor(u.id);
      chipsHtml += `<button class="emp-chip ${active ? '' : 'inactive'}" data-uid="${u.id}" style="background:${color}">${workerLabel(u)}</button>`;
    });
    chipsHtml += '</div>';
  }

  const c = stats.combined;
  const showNav = period !== 'total';

  mainEl.innerHTML = `
    <div class="stats-page">
      <div class="view-toggle stats-periods">
        ${['day','week','month','year','total'].map(p =>
          `<button class="${period === p ? 'active' : ''}" data-period="${p}">${periodLabels[p]}</button>`
        ).join('')}
      </div>
      ${showNav ? `
      <div class="date-nav">
        <button id="stats-prev">&#8249;</button>
        <span class="current-period">${stats.range.label}</span>
        <button id="stats-next">&#8250;</button>
        <button id="stats-today" class="date-today-btn">Jetzt</button>
      </div>` : `<div class="date-nav"><span class="current-period">${stats.range.label}</span></div>`}
      ${chipsHtml}
      <div class="stats-summary">
        <div class="summary-card">
          <div class="value">${fmtH(c.ist)}</div>
          <div class="label">Ist-Stunden</div>
        </div>
        <div class="summary-card">
          <div class="value">${fmtH(c.soll)}</div>
          <div class="label">Soll-Stunden</div>
        </div>
        <div class="summary-card ${c.ueber >= 0 ? 'positive' : 'negative'}">
          <div class="value">${c.ueber >= 0 ? '+' : ''}${fmtH(c.ueber)}</div>
          <div class="label">Zeitraum +/-</div>
        </div>
        ${c.start_overtime ? `<div class="summary-card ${c.ueber_gesamt >= 0 ? 'positive' : 'negative'}">
          <div class="value">${c.ueber_gesamt >= 0 ? '+' : ''}${fmtH(c.ueber_gesamt)}</div>
          <div class="label">Gesamt (inkl. Start)</div>
        </div>` : ''}
      </div>
      <div class="stats-charts">
        <div class="stats-chart-card">
          <h3>Ist / Soll / Überstunden</h3>
          <canvas id="pie-chart" width="300" height="300"></canvas>
        </div>
        <div class="stats-chart-card stats-chart-wide">
          <h3>Zeitverlauf</h3>
          <canvas id="time-chart" width="800" height="300"></canvas>
        </div>
      </div>
      ${stats.users.length > 1 ? `
      <div class="stats-user-details">
        <h3>Pro Mitarbeiter</h3>
        <table class="data-table">
          <tr><th>Name</th><th>Ist</th><th>Soll</th><th>+/-</th><th>Start-Ü.</th><th>Gesamt</th></tr>
          ${stats.users.map(u => `
            <tr>
              <td>${esc(u.user_name)}</td>
              <td>${fmtH(u.ist)}</td>
              <td>${fmtH(u.soll)}</td>
              <td class="${u.ueber >= 0 ? 'positive' : 'negative'}">${u.ueber >= 0 ? '+' : ''}${fmtH(u.ueber)}</td>
              <td>${u.start_overtime ? fmtH(u.start_overtime) : '-'}</td>
              <td class="${u.ueber_gesamt >= 0 ? 'positive' : 'negative'}">${u.ueber_gesamt >= 0 ? '+' : ''}${fmtH(u.ueber_gesamt)}</td>
            </tr>
          `).join('')}
        </table>
      </div>` : ''}
      <div id="stats-absences-block"></div>
    </div>`;

  // Diagramme zeichnen
  drawPieChart(document.getElementById('pie-chart'), c);
  drawTimeChart(document.getElementById('time-chart'), stats.combinedTimeline, stats.users.length > 1 ? null : stats.users);

  // Chart-Abwesenheitsbänder: nur die AUSGEWÄHLTEN Mitarbeiter (1 = dieser, mehrere = alle gewählten;
  // keine explizite Auswahl = alle) + globale Feiertage. Behebt das Einblenden fremder Abwesenheiten.
  if (period !== 'total') {
    try {
      const selExplicit = S.statsSelectedUsers && S.statsSelectedUsers.size > 0;
      const userQ = selExplicit ? `&user_id=${[...S.statsSelectedUsers].join(',')}` : '';
      const byDate = await api('GET', `/api/absences/by-date?from=${stats.range.from}&to=${stats.range.to}${userQ}`);
      const absenceColors = {
        krank: '#dc2626', urlaub: '#1d4ed8', freizeitausgleich: '#7c3aed',
        sonderurlaub: '#9a3412', berufsschule: '#0369a1', innung: '#0f766e',
        feiertag: '#b45309',
      };
      const chartAbsences = (byDate?.absences || [])
        .filter(a => a.status === 'active' || a.status === 'approved')
        .map(a => ({ type: a.type, from: a.date_from, to: a.date_to, color: absenceColors[a.type] || '#64748b' }));
      const canvas = document.getElementById('time-chart');
      const highlightFn = drawTimeChart(canvas, stats.combinedTimeline, stats.users.length > 1 ? null : stats.users, chartAbsences, null);
      window._statsChartHighlight = highlightFn;
    } catch (e) {}
  }

  // Abwesenheits-Zusammenfassung (Tabelle) nur bei Einzeluser-Ansicht
  if (period !== 'total' && userIds.length === 1) {
    try {
      const uid_param = userIds[0] !== S.user.id ? `&user_id=${userIds[0]}` : '';
      const sd = await api('GET', `/api/absences/summary?from=${stats.range.from}&to=${stats.range.to}${uid_param}`);
      const absenceColors = {
        krank: '#dc2626', urlaub: '#1d4ed8', freizeitausgleich: '#7c3aed',
        sonderurlaub: '#9a3412', berufsschule: '#0369a1', innung: '#0f766e',
        feiertag: '#b45309',
      };

      if (sd && Object.keys(sd.summary || {}).length > 0) {
        const typeLabels = { krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'FZA', sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag', berufsschule: 'Berufsschule', innung: 'Innung' };
        const rows = Object.entries(sd.summary).map(([t, d]) =>
          `<tr class="abs-hover-row" data-abs-type="${t}" style="cursor:pointer">
            <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${absenceColors[t]||'#64748b'};margin-right:6px"></span>${typeLabels[t] || t}</td>
            <td>${d} ${d === 1 ? 'Tag' : 'Tage'}</td>
          </tr>`
        ).join('');
        const absBlock = document.getElementById('stats-absences-block');
        if (absBlock) {
          absBlock.innerHTML = `<div class="stats-user-details" style="margin-top:1rem">
            <h3>&#128197; Abwesenheiten im Zeitraum</h3>
            <table class="data-table">
              <tr><th>Typ</th><th>Arbeitstage</th></tr>
              ${rows}
            </table>
            ${(sd.vacation && sd.vacation.configured) ? `<p style="margin-top:0.5rem;font-size:0.9rem">Urlaub ${sd.year || new Date().getFullYear()}: <strong>${sd.vacation.genommen}</strong> genommen · <strong>${sd.vacation.geplant}</strong> geplant · <strong>${sd.vacation.nochZuPlanen}</strong> noch zu planen <span style="color:#666">(Anspruch ${sd.vacation.anspruch} + Übertrag ${sd.vacation.uebertrag} = ${sd.vacation.verfuegbar} Arbeitstage)</span></p>`
              : (sd.urlaubTageJahr > 0 ? `<p style="margin-top:0.5rem;font-size:0.9rem">Urlaubstage genommen (${new Date().getFullYear()}): <strong>${sd.urlaubTageJahr} Arbeitstage</strong></p>` : '')}
          </div>`;

          // Bidirektionales Hover: Tabellenzeile → Chart hervorheben
          absBlock.querySelectorAll('.abs-hover-row').forEach(row => {
            row.addEventListener('mouseenter', () => {
              if (window._statsChartHighlight) window._statsChartHighlight(row.dataset.absType);
            });
            row.addEventListener('mouseleave', () => {
              if (window._statsChartHighlight) window._statsChartHighlight(null);
            });
          });
        }
      }
    } catch(e) {}
  }

  // Events
  mainEl.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.statsPeriod = btn.dataset.period;
      if (S.statsPeriod === 'total') S.statsDate = new Date();
      renderStatisticsContent();
    });
  });

  if (showNav) {
    document.getElementById('stats-prev')?.addEventListener('click', () => {
      navStatsDate(-1);
      renderStatisticsContent();
    });
    document.getElementById('stats-next')?.addEventListener('click', () => {
      navStatsDate(1);
      renderStatisticsContent();
    });
    document.getElementById('stats-today')?.addEventListener('click', () => {
      S.statsDate = new Date();
      renderStatisticsContent();
    });
  }

  // Mitarbeiter-Chips
  mainEl.querySelectorAll('.stats-chips .emp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const uid = Number(chip.dataset.uid);
      if (S.statsSelectedUsers.has(uid)) {
        S.statsSelectedUsers.delete(uid);
        if (S.statsSelectedUsers.size === 0) { /* alle wieder sichtbar */ }
      } else {
        S.statsSelectedUsers.add(uid);
      }
      renderStatisticsContent();
    });
  });

}

// --- Canvas-Diagramme ---
function drawPieChart(canvas, data) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 30;

  ctx.clearRect(0, 0, w, h);

  const soll = Math.max(data.soll, 0.01);
  const ist = Math.max(data.ist, 0);
  const ueber = Math.max(data.ueber, 0);
  const unter = Math.max(-data.ueber, 0);

  let slices = [];
  if (data.ueber >= 0) {
    // Ist besteht aus Soll + Überstunden
    const sollAnteil = Math.max(ist - ueber, 0);
    slices = [
      { value: sollAnteil, color: '#3b82f6', label: `Soll: ${fmtH(sollAnteil)}` },
      { value: ueber, color: '#22c55e', label: `Über: +${fmtH(ueber)}` },
    ];
  } else {
    // Ist < Soll
    slices = [
      { value: ist, color: '#3b82f6', label: `Ist: ${fmtH(ist)}` },
      { value: unter, color: '#ef4444', label: `Unter: -${fmtH(unter)}` },
    ];
  }

  slices = slices.filter(s => s.value > 0);
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) {
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Keine Daten', cx, cy);
    return;
  }

  let startAngle = -Math.PI / 2;
  slices.forEach(sl => {
    const sliceAngle = (sl.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = sl.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    const midAngle = startAngle + sliceAngle / 2;
    const lx = cx + Math.cos(midAngle) * r * 0.65;
    const ly = cy + Math.sin(midAngle) * r * 0.65;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (sliceAngle > 0.3) ctx.fillText(sl.label, lx, ly);

    startAngle += sliceAngle;
  });

  // Legende unten
  let lx = 10;
  ctx.font = '12px system-ui';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  slices.forEach(sl => {
    ctx.fillStyle = sl.color;
    ctx.fillRect(lx, h - 16, 12, 12);
    ctx.fillStyle = '#334155';
    ctx.fillText(sl.label, lx + 16, h - 4);
    lx += ctx.measureText(sl.label).width + 30;
  });
}

function drawTimeChart(canvas, timeline, users, absences = [], highlightType = null) {
  if (!canvas || !timeline || timeline.length === 0) return null;

  // Alte Event-Listener entfernen (AbortController)
  if (canvas._chartAC) canvas._chartAC.abort();
  const ac = new AbortController();
  canvas._chartAC = ac;
  const sig = ac.signal;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Canvas-Größe an Container anpassen
  const rect = canvas.parentElement.getBoundingClientRect();
  const displayW = rect.width - 20;
  const displayH = 280;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const cw = displayW - pad.left - pad.right;
  const ch = displayH - pad.top - pad.bottom;

  ctx.clearRect(0, 0, displayW, displayH);

  // Max-Wert
  let maxVal = 0;
  timeline.forEach(t => { maxVal = Math.max(maxVal, t.ist, t.soll); });
  maxVal = Math.ceil(maxVal * 1.15) || 10;

  const xStep = cw / Math.max(timeline.length - 1, 1);

  // Achsen
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;

  // Y-Achse Linien
  const ySteps = 5;
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxVal / ySteps) * i;
    const y = pad.top + ch - (val / maxVal) * ch;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + cw, y);
    ctx.stroke();
    ctx.fillText(fmtH(val), pad.left - 5, y);
  }

  // X-Achse Labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelEvery = timeline.length > 20 ? Math.ceil(timeline.length / 15) : 1;
  timeline.forEach((t, i) => {
    if (i % labelEvery !== 0 && i !== timeline.length - 1) return;
    const x = pad.left + i * xStep;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(t.label, x, pad.top + ch + 8);
  });

  // Abwesenheitsbänder im Hintergrund zeichnen
  if (absences.length > 0 && timeline.length > 1) {
    absences.forEach(ab => {
      const isHL = highlightType === ab.type;
      const isDimmed = highlightType !== null && !isHL;
      const alpha = isDimmed ? 0.05 : (isHL ? 0.35 : 0.15);

      // Finde die Timeline-Indizes die den Abwesenheitszeitraum überschneiden
      let startX = null, endX = null;
      timeline.forEach((t, i) => {
        const tFrom = t.from || t.label;
        const tTo   = t.to   || t.from || t.label;
        if (tTo >= ab.from && tFrom <= ab.to) {
          const x = pad.left + i * xStep;
          if (startX === null) startX = x - xStep / 2;
          endX = x + xStep / 2;
        }
      });
      if (startX !== null && endX !== null) {
        ctx.fillStyle = ab.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
        ctx.fillRect(Math.max(startX, pad.left), pad.top, Math.min(endX, pad.left + cw) - Math.max(startX, pad.left), ch);
        if (isHL) {
          ctx.strokeStyle = ab.color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(Math.max(startX, pad.left), pad.top, Math.min(endX, pad.left + cw) - Math.max(startX, pad.left), ch);
          ctx.setLineDash([]);
        }
      }
    });
  }

  // Soll-Linie (grün, gestrichelt)
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + ch - (t.soll / maxVal) * ch;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Ist-Linie (blau, durchgezogen)
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + ch - (t.ist / maxVal) * ch;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fläche unter Ist
  ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + ch);
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top + ch - (t.ist / maxVal) * ch;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.left + (timeline.length - 1) * xStep, pad.top + ch);
  ctx.closePath();
  ctx.fill();

  // Datenpunkte
  timeline.forEach((t, i) => {
    const x = pad.left + i * xStep;
    // Soll-Punkt
    const ys = pad.top + ch - (t.soll / maxVal) * ch;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(x, ys, 3, 0, Math.PI * 2);
    ctx.fill();
    // Ist-Punkt
    const yi = pad.top + ch - (t.ist / maxVal) * ch;
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(x, yi, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legende
  const legY = 8;
  ctx.font = '12px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pad.left, legY); ctx.lineTo(pad.left + 25, legY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#334155';
  ctx.fillText('Soll', pad.left + 30, legY);

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(pad.left + 80, legY); ctx.lineTo(pad.left + 105, legY); ctx.stroke();
  ctx.fillStyle = '#334155';
  ctx.fillText('Ist', pad.left + 110, legY);

  // Tooltip
  let tooltip = canvas.parentElement.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(tooltip);
  }

  function findNearest(clientX) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    let closest = 0, minDist = Infinity;
    for (let i = 0; i < timeline.length; i++) {
      const x = pad.left + i * xStep;
      const d = Math.abs(mx - x);
      if (d < minDist) { minDist = d; closest = i; }
    }
    return closest;
  }

  // Abwesenheitstypen für ein Timeline-Datum ermitteln
  function getAbsencesAtIndex(idx) {
    const t = timeline[idx];
    if (!t || !absences.length) return [];
    const tFrom = t.from || t.label;
    const tTo   = t.to   || t.from || t.label;
    return absences.filter(ab => ab.to >= tFrom && ab.from <= tTo);
  }

  function showTooltip(clientX) {
    const idx = findNearest(clientX);
    const t = timeline[idx];
    const diff = t.ist - t.soll;
    const prefix = diff >= 0 ? '+' : '';
    const absHere = getAbsencesAtIndex(idx);
    const absHtml = absHere.map(ab => {
      const info = ABSENCE_TYPES[ab.type] || { label: ab.type, icon: '' };
      return `<br><span style="color:${ab.color}">${info.icon} ${info.label}</span>`;
    }).join('');
    tooltip.innerHTML = `<strong>${t.label}</strong><br>Ist: ${fmtH(t.ist)}<br>Soll: ${fmtH(t.soll)}<br>Diff: ${prefix}${fmtH(diff)}${absHtml}`;
    tooltip.style.display = 'block';

    const rect = canvas.getBoundingClientRect();
    const x = pad.left + idx * xStep;
    const tooltipW = tooltip.offsetWidth;
    let left = x - tooltipW / 2;
    if (left < 0) left = 0;
    if (left + tooltipW > rect.width) left = rect.width - tooltipW;
    tooltip.style.left = left + 'px';
    tooltip.style.top = '30px';
  }

  canvas.addEventListener('mousemove', e => showTooltip(e.clientX), { signal: sig });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; }, { signal: sig });
  canvas.addEventListener('touchstart', e => { showTooltip(e.touches[0].clientX); }, { passive: true, signal: sig });
  canvas.addEventListener('touchmove', e => { showTooltip(e.touches[0].clientX); }, { passive: true, signal: sig });
  canvas.addEventListener('touchend', () => { setTimeout(() => { tooltip.style.display = 'none'; }, 2000); }, { signal: sig });

  // Gibt eine Highlight-Funktion zurück (Typ hervorheben, null = Reset)
  return (type) => {
    drawTimeChart(canvas, timeline, users, absences, type);
  };
}

