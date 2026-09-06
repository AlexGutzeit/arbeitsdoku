// --- PDF Export ---
// Das PDF-Formular steht an ZWEI Stellen: auf der Abrechnungs-Seite (Chef/Admin/Buchhalter) und
// als Karte auf „Mein Konto" (fuer den Mitarbeiter ist es rein persoenlich, deshalb ist es dort zu
// Hause statt in einem eigenen Menuepunkt). Damit beide dasselbe tun und nicht mit der Zeit
// auseinanderlaufen, steht es hier EINMAL. Markup und Verdrahtung sind getrennt, weil die
// Konto-Seite ihre Karten selbst zusammensetzt.
function pdfZeitraeume() {
  const now = new Date();
  const vorWoche = new Date(now); vorWoche.setDate(vorWoche.getDate() - 7);
  const vorMonat = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  return {
    week: getWeekRange(now),
    lastWeek: getWeekRange(vorWoche),
    month: getMonthRange(now),
    lastMonth: getMonthRange(vorMonat),
  };
}

function pdfFormularHtml({ mitMitarbeiterwahl }) {
  const r = pdfZeitraeume();
  return `
      <form id="pdf-form">
        ${mitMitarbeiterwahl ? `
        <div class="form-group">
          <label for="pdf-user">Mitarbeiter</label>
          <select class="form-control" id="pdf-user">
            <option value="">Alle Mitarbeiter</option>
            ${getWorkerUsers().map(u => `<option value="${u.id}">${workerLabel(u)}</option>`).join('')}
          </select>
        </div>
        ` : ''}
        <div class="form-group">
          <label for="pdf-project">Projekt</label>
          <select class="form-control" id="pdf-project">
            <option value="">Alle Projekte</option>
            ${S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label for="pdf-period">Zeitraum</label>
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
            <label for="pdf-from">Von</label>
            <input type="date" class="form-control" id="pdf-from" value="${r.month.from}">
          </div>
          <div class="form-group">
            <label for="pdf-to">Bis</label>
            <input type="date" class="form-control" id="pdf-to" value="${r.month.to}">
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">PDF herunterladen</button>
      </form>`;
}

function pdfFormularBinden() {
  const RANGES = pdfZeitraeume();
  const feld = (id) => document.getElementById(id);
  if (!feld('pdf-form')) return;

  feld('pdf-period').addEventListener('change', (e) => {
    feld('pdf-custom-dates').style.display = e.target.value === 'custom' ? 'grid' : 'none';
    const r = RANGES[e.target.value];
    if (r) { feld('pdf-from').value = r.from; feld('pdf-to').value = r.to; }
  });

  feld('pdf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const period = feld('pdf-period').value;
    let dateFrom, dateTo;
    if (RANGES[period]) { dateFrom = RANGES[period].from; dateTo = RANGES[period].to; }
    else { dateFrom = feld('pdf-from').value; dateTo = feld('pdf-to').value; }

    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    const userId = feld('pdf-user')?.value;
    if (userId) params.set('user_id', userId);
    const projectId = feld('pdf-project').value;
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

async function renderPdfExport() {
  try {
    const pData = await api('GET', '/api/projects');
    if (pData) S.projects = pData.projects;
    if (canViewAll()) {
      const uData = await api('GET', '/api/users');
      if (uData) S.users = uData.users;
    }
  } catch (e) {}

  await ladeAbschluss(true);   // frisch: der Stand aendert sich genau auf dieser Seite

  // Lohn-Export: der Vormonat ist der Regelfall — der laufende Monat ist noch nicht abgeschlossen.
  const lastMonthDate = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15);
  const vormonat = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const content = `
    <div class="card" style="max-width:600px;margin:0 auto;">
      <h2 style="margin-bottom:1rem;">PDF-Export</h2>
      ${pdfFormularHtml({ mitMitarbeiterwahl: canViewAll() })}
    </div>
    ${canViewAll() ? `
    <div class="card" style="max-width:600px;margin:1rem auto 0;">
      <h2 style="margin-bottom:0.5rem;">Lohn-Export (CSV)</h2>
      <p class="push-hint" style="margin-bottom:1rem;">
        Eine Zeile je Mitarbeiter mit Soll-, Ist- und Überstunden sowie Urlaubs-, Krank- und
        FZA-Tagen des Monats — zum Öffnen in Excel.
      </p>
      <form id="lohn-form">
        <div class="form-group">
          <label for="lohn-monat">Monat</label>
          <input type="month" class="form-control" id="lohn-monat" value="${vormonat}" required>
        </div>
        <button type="submit" class="btn btn-primary btn-block" id="lohn-btn">CSV herunterladen</button>
      </form>
    </div>
    <div class="card" style="max-width:600px;margin:1rem auto 0;" id="abschluss-karte">
      <h2 style="margin-bottom:0.5rem;">Abrechnungs-Abschluss</h2>
      ${abschlussKarteHtml()}
    </div>` : ''}`;

  $app().innerHTML = layout(content, 'pdf');
  bindLayout();
  bindAbschlussKarte();

  // Lohn-Export: nur Chef/Admin/Buchhalter. Die Route prueft die Rolle zusaetzlich serverseitig —
  // ausgeblendet ist nicht gesperrt.
  document.getElementById('lohn-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const monat = document.getElementById('lohn-monat').value;
    if (!monat) { toast('Bitte einen Monat wählen', 'error'); return; }
    try {
      const res = await fetch('/api/payroll/monat.csv?month=' + encodeURIComponent(monat), {
        headers: { 'Authorization': 'Bearer ' + S.token },
      });
      if (!res.ok) throw new Error('Lohn-Export fehlgeschlagen');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a2 = document.createElement('a');
      a2.href = url;
      a2.download = `Lohn_${monat}.csv`;
      document.body.appendChild(a2);
      a2.click();
      a2.remove();
      URL.revokeObjectURL(url);
      toast('Lohn-Export heruntergeladen', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  pdfFormularBinden();
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
  await ladeAbschluss(true);   // Stichtag + eigene abgerechnete Zahlen

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
      ${abgerechnetHinweisHtml(stats.range)}
      <div class="view-toggle stats-periods">
        ${['day','week','month','year','total'].map(p =>
          `<button class="${period === p ? 'active' : ''}" data-period="${p}">${periodLabels[p]}</button>`
        ).join('')}
      </div>
      ${showNav ? `
      <div class="date-nav">
        <button id="stats-prev" aria-label="Vorheriger Zeitraum" title="Zurück">&#8249;</button>
        <span class="current-period">${stats.range.label}</span>
        <button id="stats-next" aria-label="Nächster Zeitraum" title="Weiter">&#8250;</button>
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
        ${c.ausgezahlt ? `<div class="summary-card" title="Bereits im Gesamtstand abgezogen">
          <div class="value">${fmtH(c.ausgezahlt)}</div>
          <div class="label">davon ausgezahlt</div>
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
    ctx.fillStyle = '#6b7280';
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
  ctx.fillStyle = '#6b7280';
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
    ctx.fillStyle = '#6b7280';
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


// ── Abrechnungs-Abschluss (Karte auf der Export-Seite) ───────────────────────────────────────
// Hier, weil der Abschluss direkt am Lohn-Export hängt: erst die CSV ziehen, dann den Monat
// festschreiben. Die Karte ist reine Bedienung — geprüft und gesperrt wird serverseitig.

const ABSCHLUSS_MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function monatLabel(m) {
  const t = /^(\d{4})-(\d{2})$/.exec(String(m || ''));
  return t ? `${ABSCHLUSS_MONATE[Number(t[2]) - 1]} ${t[1]}` : String(m || '');
}

// Letzter vollständig vergangener Monat — weiter darf nicht abgeschlossen werden.
function letzterVollerMonat() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function abschlussKarteHtml() {
  const a = S.abschluss || { bis: null, perioden: [], naechsterMonat: null };
  const grenze = letzterVollerMonat();
  const naechster = a.naechsterMonat;
  const offen = !!(naechster && naechster <= grenze);
  const perioden = (a.perioden || []).slice().reverse();   // neueste zuerst

  return `
    <p class="push-hint" style="margin-bottom:0.75rem;">
      Ein abgeschlossener Monat ist schreibgeschützt und seine Zahlen sind festgehalten — der
      Überstundenstand rechnet danach auf diesem Wert weiter. Nachträgliche Korrekturen sind nur
      dem Administrator und nur mit Begründung möglich.
    </p>
    <p style="margin-bottom:0.75rem;">
      ${a.bis
        ? `<strong>Abgerechnet bis ${esc(datumDe(a.bis))}</strong>`
        : '<strong>Bisher wurde noch kein Monat abgeschlossen.</strong> Solange das so bleibt, ändert sich nichts am bisherigen Verhalten.'}
    </p>
    ${offen ? `
      <div class="push-hint" id="abschluss-offen" style="border-left:3px solid var(--warning,#e0a800);padding-left:0.6rem;margin-bottom:0.75rem;">
        ${naechster === grenze
          ? `${esc(monatLabel(naechster))} ist noch nicht abgeschlossen.`
          : `Noch offen ab ${esc(monatLabel(naechster))} — bis einschließlich ${esc(monatLabel(grenze))}.`}
      </div>` : ''}
    ${offen ? `
      <form id="abschluss-form">
        <div class="form-group">
          <label for="abschluss-monat">Abschließen bis einschließlich</label>
          <input type="month" class="form-control" id="abschluss-monat" value="${esc(grenze)}"
                 min="${esc(naechster)}" max="${esc(grenze)}" required>
          <small class="push-hint">Zeiträume dürfen keine Lücken haben: alle offenen Monate bis
          dahin werden der Reihe nach abgeschlossen.</small>
        </div>
        <button type="submit" class="btn btn-primary btn-block" id="abschluss-btn">Abschließen</button>
      </form>` : `
      <p class="push-hint">${a.bis ? 'Alle vergangenen Monate sind abgeschlossen.' : ''}</p>`}
    ${perioden.length ? `
      <h3 style="margin:1rem 0 0.5rem;font-size:1rem;">Abgeschlossene Zeiträume</h3>
      <ul style="list-style:none;padding:0;margin:0;">
        ${perioden.map((p, i) => `
          <li style="padding:0.5rem 0;border-top:1px solid var(--border,#ddd);">
            <div><strong>${esc(datumDe(p.periodFrom))} – ${esc(datumDe(p.periodTo))}</strong>
              <span class="push-hint"> · ${p.zeilen.length} Mitarbeiter${p.closedByName ? ' · ' + esc(p.closedByName) : ''}</span></div>
            <div style="margin-top:0.35rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
              <button class="btn btn-outline btn-sm abschluss-abweichung" data-id="${p.id}">Abweichungen prüfen</button>
              ${i === 0 && isAdmin() ? `<button class="btn btn-danger btn-sm" id="abschluss-oeffnen" data-id="${p.id}">Wieder öffnen</button>` : ''}
            </div>
            <div class="abschluss-abw-box" id="abw-${p.id}" style="margin-top:0.5rem;"></div>
          </li>`).join('')}
      </ul>` : ''}`;
}

function bindAbschlussKarte() {
  const karte = document.getElementById('abschluss-karte');
  if (!karte) return;

  const neuZeichnen = async () => {
    await ladeAbschluss(true);
    karte.innerHTML = '<h2 style="margin-bottom:0.5rem;">Abrechnungs-Abschluss</h2>' + abschlussKarteHtml();
    bindAbschlussKarte();
  };

  document.getElementById('abschluss-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('abschluss-btn');
    if (btn && btn.disabled) return;
    const monat = document.getElementById('abschluss-monat').value;
    if (!monat) { toast('Bitte einen Monat wählen', 'error'); return; }
    const bestaetigt = await confirmModal(
      `Alle offenen Monate bis einschließlich ${monatLabel(monat)} abschließen?\n\n`
      + 'Danach sind diese Zeiträume schreibgeschützt. Änderungen daran kann nur noch der '
      + 'Administrator vornehmen, und nur mit Begründung.',
      // danger:false — Abschliessen ist kein Loeschen. Sonst waere die Bestaetigung rot und
      // Enter wuerde nicht bestaetigen (confirmModal sperrt das bei destruktiven Dialogen).
      { title: 'Abrechnung abschließen', okLabel: 'Abschließen', danger: false });
    if (!bestaetigt) return;
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/closure/bis', { month: monat });
      const n = (r.erledigt || []).length;
      toast(n === 1 ? `${monatLabel(r.erledigt[0].monat)} abgeschlossen`
        : `${n} Monate abgeschlossen`, 'success');
      // Ein Hindernis ist keine Fehlermeldung, sondern eine Auskunft: alles davor ist erledigt.
      if (r.hindernis) toast(r.hindernis, 'error', 8000);
      await neuZeichnen();
    } catch (err) {
      toast(err.message, 'error', 8000);
      if (btn) btn.disabled = false;
    }
  });

  karte.querySelectorAll('.abschluss-abweichung').forEach(b => {
    b.addEventListener('click', async () => {
      const box = document.getElementById('abw-' + b.dataset.id);
      box.textContent = 'Prüfe…';
      try {
        const r = await api('GET', `/api/closure/${b.dataset.id}/abweichung`);
        box.innerHTML = abweichungHtml(r.abweichungen || [], r.offenGesamt || 0, b.dataset.id);
        // Ablehnen: bewusst NICHT gutschreiben. Ohne diesen Weg gäbe es nur einen Ausgang aus der
        // Sperre, und man müsste Stunden buchen, die längst anders abgegolten sind.
        box.querySelector('.abschluss-ablehnen')?.addEventListener('click', async (ev) => {
          const knopf = ev.currentTarget;
          if (!(await confirmModal(
            'Die offenen Differenzen ablehnen?\n\n'
            + 'Die Stunden werden dem Mitarbeiter NICHT gutgeschrieben und tauchen in keinem '
            + 'Lohn-Export auf. Sinnvoll, wenn sie bereits anders abgegolten wurden — bar oder '
            + 'mit Freizeit.\n\nDer Zeitraum gilt danach als entschieden.',
            { title: 'Differenz ablehnen', okLabel: 'Ablehnen', danger: true }))) return;
          const grund = await promptModal(
            'Warum werden diese Stunden nicht gutgeschrieben? Der Text erscheint beim Mitarbeiter und im Protokoll.',
            { title: 'Begründung der Ablehnung', placeholder: 'z. B. bereits bar ausgezahlt',
              required: true, requiredMsg: 'Pflicht — hier verfallen Stunden, das darf nie kommentarlos passieren.' });
          if (grund === null || !grund.trim()) return;
          knopf.disabled = true;
          try {
            await api('POST', `/api/closure/${knopf.dataset.id}/ablehnen`, { reason: grund.trim() });
            toast('Differenz abgelehnt — nicht gutgeschrieben', 'success', 6000);
            await neuZeichnen();
          } catch (err) { toast(err.message, 'error'); knopf.disabled = false; }
        });

        box.querySelector('.abschluss-uebernehmen')?.addEventListener('click', async (ev) => {
          const knopf = ev.currentTarget;
          if (!(await confirmModal(
            'Die offenen Differenzen jetzt übernehmen?\n\n'
            + 'Sie werden dem laufenden Zeitraum gutgeschrieben und gehen damit in den nächsten '
            + 'Lohn-Export. Der abgeschlossene Monat bleibt als Beleg unverändert.',
            { title: 'Nachtrag übernehmen', okLabel: 'Übernehmen', danger: false }))) return;
          // Kommentar: Er steht spaeter im Lohn-Export, beim Mitarbeiter und im Protokoll — damit
          // niemand raetselt, warum in diesem Monat zusaetzliche Stunden auftauchen.
          const grund = await promptModal(
            'Wofür sind diese Stunden? Der Text erscheint im Lohn-Export und beim Mitarbeiter.',
            { title: 'Kommentar zum Nachtrag', placeholder: 'z. B. Krankmeldung nachgereicht',
              required: true, requiredMsg: 'Pflicht — ohne Kommentar kann später niemand zuordnen, woher die Stunden kommen.' });
          if (grund === null || !grund.trim()) return;
          knopf.disabled = true;
          try {
            const u = await api('POST', `/api/closure/${knopf.dataset.id}/uebernehmen`, { reason: grund.trim() });
            toast(`Übernommen, wirksam ab ${datumDe(u.wirksamAb)}`, 'success');
            await neuZeichnen();
          } catch (err) { toast(err.message, 'error'); knopf.disabled = false; }
        });
      } catch (err) { box.textContent = err.message; }
    });
  });

  document.getElementById('abschluss-oeffnen')?.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id;
    if (!(await confirmModal(
      'Diesen Abschluss wieder öffnen?\n\nDer Zeitraum wird danach wieder normal bearbeitbar, '
      + 'und der Überstundenstand rechnet ihn wieder mit. Bereits übernommene Nachträge aus diesem '
      + 'Zeitraum werden dabei zurückgenommen — sonst zählten dieselben Stunden doppelt.\n\n'
      + 'Der Vorgang wird protokolliert.',
      { title: 'Abschluss aufheben', okLabel: 'Wieder öffnen', danger: true }))) return;
    const grund = await promptModal('Warum wird der Abschluss aufgehoben? (Pflicht)',
      { title: 'Begründung', required: true });
    if (grund === null || !grund.trim()) return;
    try {
      const r = await api('DELETE', '/api/closure/' + id, { reason: grund.trim() });
      toast(r.nachtraegeZurueckgenommen
        ? `Abschluss aufgehoben — ${r.nachtraegeZurueckgenommen} Nachtrag/Nachträge über `
          + `${String(Math.round(Number(r.stunden) * 100) / 100).replace('.', ',')} h zurückgenommen`
        : 'Abschluss aufgehoben', 'success', 6000);
      await neuZeichnen();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// „bezahlt X — heute berechnet Y". Bewusst mit Erklaerung: Dass die Monatszahlen abweichen, der
// Gesamtstand aber stehen bleibt, sieht sonst wie ein Rechenfehler aus — es ist genau der Zweck.
function abweichungHtml(abw, offenGesamt, id) {
  if (!abw.length) {
    return '<span class="push-hint">Keine Abweichung — die Zahlen entsprechen noch genau dem, was abgerechnet wurde.</span>';
  }
  const LABEL = { soll: 'Soll', ist: 'Ist', saldo: 'Saldo', ueberstundenGesamt: 'Überstunden gesamt',
    urlaub: 'Urlaub', krank: 'Krank', fza: 'FZA', sonderurlaub: 'Sonderurlaub',
    berufsschule: 'Berufsschule', innung: 'Innung', feiertage: 'Feiertage' };
  const zahl = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',');
  const mitVorzeichen = (n) => (Number(n) > 0 ? '+' : '') + zahl(n);
  const offen = Math.round(Number(offenGesamt || 0) * 100) / 100;
  return `
    <div class="push-hint" style="border-left:3px solid var(--warning,#e0a800);padding-left:0.6rem;">
      Nach dem Abschluss wurde hier noch etwas geändert. Der abgeschlossene Monat bleibt als
      <strong>Beleg unverändert</strong> — bezahlt wurde damals, was damals bezahlt wurde.
      ${offen !== 0
        ? `<strong>Noch nicht übernommen: ${mitVorzeichen(offen)} h.</strong> Diese Stunden stecken derzeit in
           keinem Überstundenstand und würden ohne Übernahme nie ausgezahlt.`
        : 'Die Differenz ist bereits übernommen und im laufenden Zeitraum gutgeschrieben.'}
    </div>
    ${offen !== 0 ? `<div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm abschluss-uebernehmen" data-id="${esc(String(id))}">Differenz übernehmen (${mitVorzeichen(offen)} h)</button>
        <button class="btn btn-outline btn-sm abschluss-ablehnen" data-id="${esc(String(id))}">Differenz ablehnen</button>
      </div>
      <div class="push-hint" style="margin-top:0.35rem;">Ablehnen heißt: Die Stunden werden
        <strong>nicht</strong> gutgeschrieben — etwa weil sie bereits bar oder mit Freizeit
        abgegolten wurden. Der Zeitraum gilt dann als entschieden und der nächste Abschluss ist
        wieder möglich.</div>` : ''}
    <ul style="list-style:none;padding:0;margin:0.5rem 0 0;">
      ${abw.map(a => `
        <li style="padding:0.25rem 0;">
          <strong>${esc(a.name || '')}</strong>${a.entfernt ? ' <span class="push-hint">(nicht mehr in der Abrechnung)</span>' : ''}
          ${a.uebernommen ? `<span class="push-hint"> · ${mitVorzeichen(a.uebernommen)} h übernommen</span>` : ''}
          ${a.abgelehnt ? `<span class="push-hint"> · ${mitVorzeichen(a.abgelehnt)} h <strong>abgelehnt</strong></span>` : ''}
          ${a.kommentar ? `<span class="push-hint"> · „${esc(a.kommentar)}"</span>` : ''}
          <ul style="margin:0.2rem 0 0 1rem;padding:0;">
            ${Object.entries(a.felder).map(([f, v]) => `
              <li>${esc(LABEL[f] || f)}: bezahlt ${zahl(v.bezahlt)} — heute ${zahl(v.jetzt)}
                <strong>(${mitVorzeichen(v.differenz)})</strong></li>`).join('')}
          </ul>
        </li>`).join('')}
    </ul>`;
}

// Hinweis auf der Statistik-Seite: bis wann abgerechnet ist — und für den Mitarbeiter, welche
// Zahlen für ihn festgehalten wurden. Er soll nachvollziehen können, was ans Lohnbüro ging,
// statt sich zu wundern, warum sein Eintrag nicht mehr änderbar ist.
/**
 * Hinweis „abgerechnet" — bezogen auf den ANGEWÄHLTEN Zeitraum, nicht auf den letzten Abschluss.
 *
 * Vorher stand auf jeder Ansicht derselbe Satz („Abgerechnet bis 30.06.") samt der Juni-Zahlen —
 * auch wenn man den Mai ansah (Alex, 30.07.2026). Jetzt gilt: Es zählen die Abschlüsse, die sich
 * mit dem angezeigten Zeitraum ÜBERSCHNEIDEN. Ist keiner dabei — etwa weil der Monat noch offen
 * ist —, erscheint gar kein Hinweis.
 *
 * Bei Jahr/Gesamt überschneiden sich mehrere; dann bleibt es beim „bis"-Satz mit dem letzten davon.
 *
 * @param {{from:string,to:string}} [bereich] angezeigter Zeitraum; ohne Angabe wie bisher alles
 */
function abgerechnetHinweisHtml(bereich) {
  const a = S.abschluss;
  if (!a || !a.bis) return '';
  const zahl = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',');
  const mitVorzeichen = (n) => (Number(n) > 0 ? '+' : '') + zahl(n);
  // Überschneidung zweier Datumsspannen — ISO-Daten lassen sich als Text vergleichen.
  const trifft = (von, bis) => !bereich || !bereich.from || !bereich.to
    || (String(von) <= String(bereich.to) && String(bis) >= String(bereich.from));
  const perioden = (a.perioden || []).filter(p => trifft(p.periodFrom, p.periodTo));
  if (!perioden.length) return '';
  const letzte = perioden[perioden.length - 1];
  const einMonat = perioden.length === 1;
  // Deckt der Abschluss den GANZEN angezeigten Zeitraum ab? Eine Woche kann über den Monatswechsel
  // reichen (29.06.–05.07.) und ein Jahr über den letzten Stichtag hinaus. Dann stimmt „ist
  // abgerechnet" zwar für den genannten Monat, aber nicht für alles, was auf dem Schirm steht —
  // und das gehört dazugesagt. (Abschlüsse sind lückenlos, deshalb genügen Anfang und Ende.)
  const vollstaendig = !bereich || !bereich.from || !bereich.to
    || (String(bereich.from) >= String(perioden[0].periodFrom) && String(bereich.to) <= String(letzte.periodTo));
  const nachtraege = (a.nachtraege || []).filter(n => trifft(n.herkunftVon || n.wirksamAb, n.herkunftBis || n.wirksamAb));
  const offeneKorrektur = Math.round(perioden
    .reduce((s, p) => s + (Number(p.offenGesamt) || 0), 0) * 100) / 100;
  // Die jüngste Periode, in der eigene Zahlen stehen. Manager sehen hier alle Zeilen — für sie
  // ist die ausführliche Ansicht die Karte auf der Abrechnungs-Seite, deshalb nur der Stichtag.
  let eigene = null;
  if (S.user.role === 'mitarbeiter') {
    for (const p of perioden) {
      const z = (p.zeilen || []).find(x => Number(x.user_id) === Number(S.user.id));
      if (z) eigene = { p, z };
    }
  }
  return `
    <div class="card" style="margin-bottom:0.75rem;">
      <div>🔒 <strong>${einMonat
        ? esc(monatLabel(String(letzte.periodFrom).slice(0, 7))) + ' ist abgerechnet.'
        : 'Abgerechnet bis ' + esc(datumDe(letzte.periodTo)) + '.'}</strong>
        <span class="push-hint">${einMonat
          ? 'Die Zeiten dieses Monats sind festgeschrieben und nicht mehr änderbar.'
          : 'Zeiten bis zu diesem Tag sind festgeschrieben und nicht mehr änderbar.'}</span>
        ${vollstaendig ? '' : '<span class="push-hint">Der angezeigte Zeitraum enthält auch Tage, die nicht abgerechnet sind.</span>'}</div>
      ${eigene ? `
      <div style="margin-top:0.5rem;">
        <div class="push-hint">Für Sie abgerechnet
          (${esc(datumDe(eigene.p.periodFrom))} – ${esc(datumDe(eigene.p.periodTo))}):</div>
        <div>Soll ${zahl(eigene.z.soll)} h · Ist ${zahl(eigene.z.ist)} h ·
          Saldo ${zahl(eigene.z.saldo)} h · <strong>Überstunden gesamt ${zahl(eigene.z.ueberstunden_gesamt)} h</strong></div>
      </div>` : ''}
      ${nachtraege.filter(n => n.wirksam !== false).length ? `
      <div style="margin-top:0.5rem;">
        <div class="push-hint">Im aktuellen Stand enthalten — nachträglich gutgeschrieben:</div>
        <ul style="margin:0.2rem 0 0;padding-left:1.1rem;">
          ${nachtraege.filter(n => n.wirksam !== false).map(n => `<li><strong>${mitVorzeichen(n.stunden)} h</strong> aus
            ${esc(n.herkunft)}${n.grund ? ` — „${esc(n.grund)}"` : ''}
            <span class="push-hint">(gutgeschrieben ab ${esc(datumDe(n.wirksamAb))}${n.uebernommenVon ? ', ' + esc(n.uebernommenVon) : ''})</span></li>`).join('')}
        </ul>
      </div>` : ''}
      ${nachtraege.filter(n => n.wirksam === false).length ? `
      <div style="margin-top:0.5rem;border-left:3px solid var(--warning,#e0a800);padding-left:0.6rem;">
        <div class="push-hint">Nachträglich festgestellt, aber <strong>nicht</strong> gutgeschrieben:</div>
        <ul style="margin:0.2rem 0 0;padding-left:1.1rem;">
          ${nachtraege.filter(n => n.wirksam === false).map(n => `<li><strong>${mitVorzeichen(n.stunden)} h</strong> aus
            ${esc(n.herkunft)}${n.grund ? ` — „${esc(n.grund)}"` : ''}
            <span class="push-hint">(${n.uebernommenVon ? esc(n.uebernommenVon) : 'entschieden'})</span></li>`).join('')}
        </ul>
      </div>` : ''}
      ${offeneKorrektur ? `
      <div style="margin-top:0.5rem;border-left:3px solid var(--warning,#e0a800);padding-left:0.6rem;">
        In einem abgerechneten Monat wurde nachträglich etwas korrigiert
        (${mitVorzeichen(offeneKorrektur)} h). Diese Stunden sind noch <strong>nicht</strong> in Ihrem
        Überstundenstand enthalten — sie werden mit der nächsten Abrechnung gutgeschrieben.
      </div>` : ''}
    </div>`;
}
