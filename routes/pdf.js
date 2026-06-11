const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { calcTargetHours, calcActualHours, countScheduledDays, fmtDate, getEarliestTargetDate, clampFrom } = require('./statistics');

function fmtH(val) {
  const neg = val < 0;
  const totalMin = Math.round(Math.abs(val) * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return (neg ? '-' : '') + h + ':' + String(m).padStart(2, '0');
}

const router = express.Router();

const PALETTE = ['#4f46e5','#059669','#d97706','#dc2626','#7c3aed','#2563eb','#db2777','#65a30d','#0891b2','#ea580c','#6d28d9','#0d9488'];

router.get('/export', authenticate, (req, res) => {
  const db = getDb();
  const { date_from, date_to, user_id, project_id } = req.query;
  const role = req.user.role;

  // Einträge abfragen
  let sql = `
    SELECT e.*, u.name as user_name, u.target_hours_per_week, p.name as project_name, ru.name as regie_user_name
    FROM entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN projects p ON e.project_id = p.id
    LEFT JOIN users ru ON e.regie_user_id = ru.id
    WHERE 1=1 AND e.deleted_at IS NULL
  `;
  const params = [];

  if (role === 'mitarbeiter') {
    sql += ' AND e.user_id = ?';
    params.push(req.user.id);
  } else if (user_id) {
    sql += ' AND e.user_id = ?';
    params.push(Number(user_id));
  }

  if (date_from) {
    sql += ' AND e.date >= ?';
    params.push(date_from);
  }
  if (date_to) {
    sql += ' AND e.date <= ?';
    params.push(date_to);
  }
  if (project_id) {
    sql += ' AND e.project_id = ?';
    params.push(Number(project_id));
  }

  sql += ' ORDER BY e.date ASC, e.time_from ASC';
  const entries = db.prepare(sql).all(...params);

  // Abwesenheiten pro Tag aufschlüsseln
  const targetUidForAbs = role === 'mitarbeiter' ? req.user.id : (user_id ? Number(user_id) : null);
  const absencesByDate = {};
  if (targetUidForAbs && date_from && date_to) {
    const absTypeLabels = {
      krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'Freizeitausgleich',
      sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag',
      berufsschule: 'Berufsschule', innung: 'Innung', dienstreise: 'Dienstreise',
    };
    const absRows = db.prepare(`
      SELECT type, date_from, date_to, comment FROM absences
      WHERE (user_id = ? OR user_id IS NULL)
        AND status IN ('active','approved')
        AND date_from <= ? AND date_to >= ?
    `).all(targetUidForAbs, date_to, date_from);
    for (const ab of absRows) {
      const f = ab.date_from > date_from ? ab.date_from : date_from;
      const t = ab.date_to   < date_to   ? ab.date_to   : date_to;
      const cur = new Date(f + 'T12:00:00');
      const end = new Date(t + 'T12:00:00');
      while (cur <= end) {
        const ds = fmtDate(cur);
        if (!absencesByDate[ds]) absencesByDate[ds] = [];
        absencesByDate[ds].push({ label: absTypeLabels[ab.type] || ab.type, comment: ab.comment || '' });
        cur.setDate(cur.getDate() + 1);
      }
    }
  }

  // Alle darzustellenden Daten: Zeiteinträge + Abwesenheitstage zusammenführen
  const allDates = [...new Set([...entries.map(e => e.date), ...Object.keys(absencesByDate)])].sort();

  // Einstellungen laden
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of settingsRows) settings[r.key] = r.value;

  const companyName = settings.company_name || 'Firma';
  const logoPath = settings.company_logo ? path.join(__dirname, '..', settings.company_logo) : null;

  // PDF erstellen
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="arbeitsdoku_${date_from || 'export'}.pdf"`);
  doc.pipe(res);

  // -- Kopfzeile --
  const pageW = doc.page.width - 80;
  doc.fontSize(16).font('Helvetica-Bold').text(companyName, 40, 40, { width: pageW - 120 });

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, doc.page.width - 140, 25, { fit: [100, 50], align: 'right', valign: 'top' });
    } catch (e) { /* Logo konnte nicht geladen werden */ }
  }

  doc.moveDown(0.5);
  doc.fontSize(13).font('Helvetica-Bold').text('Arbeitsdokumentation', 40);
  doc.fontSize(10).font('Helvetica');

  // Mitarbeitername
  if (role === 'mitarbeiter') {
    doc.text(`Mitarbeiter: ${req.user.name}`);
  } else if (user_id) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(user_id));
    if (u) doc.text(`Mitarbeiter: ${u.name}`);
  } else {
    doc.text('Alle Mitarbeiter');
  }

  if (date_from && date_to) {
    doc.text(`Zeitraum: ${formatDateDE(date_from)} - ${formatDateDE(date_to)}`);
  }
  doc.moveDown(0.5);

  // -- Tabelle --
  const cols = [
    { label: 'Datum', width: 58 },
    { label: 'Von', width: 28 },
    { label: 'Bis', width: 28 },
    { label: 'Pause', width: 33 },
    { label: 'Netto', width: 35 },
    { label: 'Mitarbeiter', width: 90 },
    { label: 'Arbeitsort', width: 105 },
    { label: 'Kunde', width: 75 },
    { label: 'Projekt', width: 82 },
    { label: 'Beschreibung', width: 110 },
    { label: 'Regie', width: 117 },
  ];

  // Mitarbeiter-Spalte nur wenn mehrere MA
  const showEmployee = role !== 'mitarbeiter' && !user_id;
  const filteredCols = showEmployee ? cols : cols.filter(c => c.label !== 'Mitarbeiter');

  let x = 40;
  let y = doc.y;

  // Kopfzeile der Tabelle
  doc.fontSize(8).font('Helvetica-Bold');
  for (const col of filteredCols) {
    doc.text(col.label, x, y, { width: col.width, height: 14 });
    x += col.width;
  }
  y += 14;
  doc.moveTo(40, y).lineTo(40 + filteredCols.reduce((s, c) => s + c.width, 0), y).stroke();
  y += 4;

  // Einträge + Abwesenheiten gemischt ausgeben
  doc.font('Helvetica').fontSize(7);
  let lastDate = null;
  const tableW = filteredCols.reduce((s, c) => s + c.width, 0);
  const regieLabels = { 0: 'Nein', 1: 'Ja', 2: 'pauschal', 3: 'Büro', 4: 'Lager', 5: 'Intern' };

  for (const date of allDates) {
    const dayEntries = entries.filter(e => e.date === date);
    const dayAbsences = absencesByDate[date] || [];

    // Trennlinie zwischen Tagen
    if (lastDate && lastDate !== date) {
      doc.moveTo(40, y).lineTo(40 + tableW, y).lineWidth(0.3).strokeColor('#cbd5e1').stroke();
      y += 2;
    }
    lastDate = date;

    // Zeiteinträge dieses Tages
    for (const entry of dayEntries) {
      if (y > doc.page.height - 80) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 });
        y = 40;
      }
      x = 40;
      const rowData = [];
      rowData.push({ text: formatDateDE(entry.date), width: filteredCols[0].width });
      rowData.push({ text: entry.time_from, width: filteredCols[1].width });
      rowData.push({ text: entry.time_to, width: filteredCols[2].width });
      rowData.push({ text: entry.break_minutes + ' min', width: filteredCols[3].width });
      rowData.push({ text: fmtH(entry.net_hours), width: filteredCols[4].width });
      let idx = 5;
      if (showEmployee) { rowData.push({ text: entry.user_name || '', width: filteredCols[idx].width }); idx++; }
      const rawAddr = entry.address || '';
      const addr = rawAddr.replace(/,\s*(\d{4,5}\s)/, '\n$1');
      rowData.push({ text: addr, width: filteredCols[idx].width }); idx++;
      rowData.push({ text: entry.client || '', width: filteredCols[idx].width }); idx++;
      rowData.push({ text: entry.project_name || entry.project_text || '', width: filteredCols[idx].width }); idx++;
      rowData.push({ text: entry.description || '', width: filteredCols[idx].width }); idx++;
      const rv = entry.has_regie || 0;
      rowData.push({ text: rv === 0 ? 'Nein' : rv === 1 ? ('Ja – ' + (entry.regie_user_name || '')) : (regieLabels[rv] || 'Ja'), width: filteredCols[idx].width });

      let rowH = 12;
      for (const cell of rowData) {
        const cellH = doc.heightOfString(cell.text || ' ', { width: cell.width - 2 });
        if (cellH > rowH) rowH = cellH;
      }
      rowH = Math.min(rowH, 80);
      doc.fillColor('#333');
      for (const cell of rowData) {
        doc.text(cell.text, x, y, { width: cell.width, height: rowH });
        x += cell.width;
      }
      y += rowH + 1;
    }

    // Abwesenheitszeilen dieses Tages
    for (const ab of dayAbsences) {
      if (y > doc.page.height - 80) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 });
        y = 40;
      }
      x = 40;
      const absText = ab.comment ? `${ab.label} — ${ab.comment}` : ab.label;
      // Datum
      doc.fillColor('#64748b').font('Helvetica-Oblique').fontSize(7);
      doc.text(formatDateDE(date), x, y, { width: filteredCols[0].width }); x += filteredCols[0].width;
      // Von/Bis/Pause/Netto leer
      doc.text('', x, y, { width: filteredCols[1].width }); x += filteredCols[1].width;
      doc.text('', x, y, { width: filteredCols[2].width }); x += filteredCols[2].width;
      doc.text('', x, y, { width: filteredCols[3].width }); x += filteredCols[3].width;
      doc.text('', x, y, { width: filteredCols[4].width }); x += filteredCols[4].width;
      let idx = 5;
      if (showEmployee) { doc.text('', x, y, { width: filteredCols[idx].width }); x += filteredCols[idx].width; idx++; }
      // Abwesenheitstext über Arbeitsort+Kunde+Projekt+Beschreibung+Regie
      const restWidth = filteredCols.slice(idx).reduce((s, c) => s + c.width, 0);
      const absH = Math.max(12, Math.min(doc.heightOfString(absText, { width: restWidth - 2 }), 40));
      doc.text(absText, x, y, { width: restWidth, height: absH });
      doc.font('Helvetica').fillColor('#333').fontSize(7);
      y += absH + 1;
    }
  }

  const totalNet = calcActualHours(entries);

  // -- Zusammenfassung --
  y += 10;
  if (y > doc.page.height - 60) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 });
    y = 40;
  }

  doc.moveTo(40, y).lineTo(300, y).stroke();
  y += 8;
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text(`Gesamtstunden: ${fmtH(totalNet)}`, 40, y);
  y += 14;

  // Statistik-Daten berechnen
  if (date_from && date_to) {
    // Welche User betroffen?
    let statsUserIds = [];
    if (role === 'mitarbeiter') {
      statsUserIds = [req.user.id];
    } else if (user_id) {
      statsUserIds = [Number(user_id)];
    } else {
      const uniqueUsers = [...new Set(entries.map(e => e.user_id))];
      statsUserIds = uniqueUsers;
    }

    // Pro-User Soll/Ist berechnen
    const userStats = [];
    for (const uid of statsUserIds) {
      const u = db.prepare('SELECT id, name, start_overtime FROM users WHERE id = ?').get(uid);
      if (!u) continue;
      const earliest = getEarliestTargetDate(db, uid);
      const userFrom = clampFrom(date_from, earliest);
      const startOT = u.start_overtime || 0;
      if (userFrom > date_to) {
        userStats.push({ name: u.name, ist: 0, soll: 0, ueber: 0, ueber_gesamt: startOT });
        continue;
      }
      // Zeitraum-spezifisch
      const userEntries = entries.filter(e => e.user_id === uid && e.date >= userFrom);
      const ist = calcActualHours(userEntries);
      const soll = calcTargetHours(db, uid, userFrom, date_to);
      // Kumuliert: vom allerersten Tag bis date_to
      let ueberGesamt = startOT;
      if (earliest) {
        const allEntries = db.prepare(
          'SELECT date, time_from, time_to, break_minutes, net_hours, user_id FROM entries WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL'
        ).all(uid, earliest, date_to);
        ueberGesamt = startOT + calcActualHours(allEntries) - calcTargetHours(db, uid, earliest, date_to);
      }
      userStats.push({ name: u.name, ist, soll, ueber: ist - soll, ueber_gesamt: Math.round(ueberGesamt * 100) / 100 });
    }

    const totalSoll = userStats.reduce((s, u) => s + u.soll, 0);
    const totalUeber = totalNet - totalSoll;
    const totalUeberGesamt = userStats.reduce((s, u) => s + u.ueber_gesamt, 0);

    // Zusammenfassung Text
    doc.font('Helvetica').fontSize(9);
    doc.text(`Soll-Stunden: ${fmtH(totalSoll)}`, 40, y);
    y += 14;
    const prefix = totalUeber >= 0 ? '+' : '';
    doc.text(`Differenz (Zeitraum): ${prefix}${fmtH(totalUeber)}`, 40, y);
    y += 14;
    const prefixG = totalUeberGesamt >= 0 ? '+' : '';
    doc.text(`Überstunden gesamt: ${prefixG}${fmtH(totalUeberGesamt)}`, 40, y);
    y += 14;

    // Abwesenheitsblock (nur wenn konkreter User)
    const targetUid = role === 'mitarbeiter' ? req.user.id : (user_id ? Number(user_id) : null);
    if (targetUid) {
      const pdfAbsences = db.prepare(`
        SELECT type, date_from, date_to FROM absences
        WHERE user_id = ? AND status IN ('active','approved')
        AND date_from <= ? AND date_to >= ?
      `).all(targetUid, date_to, date_from);

      if (pdfAbsences.length > 0) {
        // Arbeitstage pro Typ zählen (begrenzt auf date_from/date_to des Zeitraums)
        const typeDays = {};
        for (const ab of pdfAbsences) {
          const from = ab.date_from > date_from ? ab.date_from : date_from;
          const to   = ab.date_to < date_to     ? ab.date_to   : date_to;
          if (from > to) continue;
          typeDays[ab.type] = (typeDays[ab.type] || 0) + countScheduledDays(db, targetUid, from, to);
        }

        if (Object.keys(typeDays).length > 0) {
          const typeLabels = {
            krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'FZA',
            sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag',
            berufsschule: 'Berufsschule', innung: 'Innung', dienstreise: 'Dienstreise'
          };
          const parts = Object.entries(typeDays).map(([t, d]) => `${d} ${d === 1 ? 'Tag' : 'Tage'} ${typeLabels[t] || t}`);
          doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('Abwesenheiten im Zeitraum:', 40, y);
          y += 13;
          doc.font('Helvetica').text(parts.join(', '), 40, y);
          y += 13;

          // Urlaubstage approved im aktuellen Kalenderjahr
          const thisYear = new Date().getFullYear().toString();
          const urlaubRows = db.prepare(`
            SELECT date_from, date_to FROM absences
            WHERE user_id = ? AND type = 'urlaub' AND status = 'approved'
            AND date_from <= ? AND date_to >= ?
          `).all(targetUid, thisYear + '-12-31', thisYear + '-01-01');
          let urlaubJahr = 0;
          for (const ur of urlaubRows) {
            const f = ur.date_from > (thisYear + '-01-01') ? ur.date_from : (thisYear + '-01-01');
            const t2 = ur.date_to < (thisYear + '-12-31') ? ur.date_to : (thisYear + '-12-31');
            if (f <= t2) urlaubJahr += countScheduledDays(db, targetUid, f, t2);
          }
          doc.text(`Urlaubstage genommen (${thisYear}): ${urlaubJahr} Arbeitstage`, 40, y);
          y += 14;
        }
      }
    }

    // === STATISTIK-SEITE ===
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 });
    doc.fontSize(14).font('Helvetica-Bold').text('Statistik', 40, 40);
    doc.fontSize(9).font('Helvetica').text(`Zeitraum: ${formatDateDE(date_from)} - ${formatDateDE(date_to)}`, 40);
    if (userStats.length === 1) {
      doc.text(`Mitarbeiter: ${userStats[0].name}`);
    }
    doc.moveDown(0.5);

    // --- Tortendiagramm ---
    const pieX = 180, pieY = 200, pieR = 100;
    doc.fontSize(10).font('Helvetica-Bold').text('Ist / Soll', pieX - pieR, pieY - pieR - 25, { width: pieR * 2, align: 'center' });

    const ist = totalNet;
    const ueber = Math.max(totalUeber, 0);
    const unter = Math.max(-totalUeber, 0);

    let slices;
    if (totalUeber >= 0) {
      const sollAnteil = Math.max(ist - ueber, 0);
      slices = [
        { value: sollAnteil, color: '#3b82f6', label: `Soll: ${fmtH(sollAnteil)}` },
        { value: ueber, color: '#22c55e', label: `Über: +${fmtH(ueber)}` },
      ];
    } else {
      slices = [
        { value: ist, color: '#3b82f6', label: `Ist: ${fmtH(ist)}` },
        { value: unter, color: '#ef4444', label: `Unter: -${fmtH(unter)}` },
      ];
    }
    slices = slices.filter(s => s.value > 0);
    const sliceTotal = slices.reduce((s, sl) => s + sl.value, 0);

    if (sliceTotal > 0) {
      let startAngle = -Math.PI / 2;
      slices.forEach(sl => {
        const sliceAngle = (sl.value / sliceTotal) * Math.PI * 2;
        drawPieSlice(doc, pieX, pieY, pieR, startAngle, startAngle + sliceAngle, sl.color);
        startAngle += sliceAngle;
      });

      // Legende
      let legY = pieY + pieR + 20;
      slices.forEach(sl => {
        doc.rect(pieX - pieR, legY, 10, 10).fill(sl.color);
        doc.fontSize(8).font('Helvetica').fillColor('#333').text(sl.label, pieX - pieR + 15, legY + 1);
        legY += 16;
      });
    }

    // --- Zeitdiagramm ---
    // Timeline berechnen: Monats-Aufschlüsselung
    const timeline = buildTimeline(db, statsUserIds, date_from, date_to);

    if (timeline.length > 0) {
      const chartLeft = 380, chartTop = 120, chartW = 380, chartH = 200;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Zeitverlauf', chartLeft, chartTop - 30, { width: chartW, align: 'center' });

      let maxVal = 0;
      timeline.forEach(t => { maxVal = Math.max(maxVal, t.ist, t.soll); });
      maxVal = Math.ceil(maxVal * 1.15) || 10;

      const xStep = timeline.length > 1 ? chartW / (timeline.length - 1) : chartW;

      // Y-Achse
      doc.fontSize(7).font('Helvetica').fillColor('#94a3b8');
      for (let i = 0; i <= 5; i++) {
        const val = (maxVal / 5) * i;
        const ly = chartTop + chartH - (val / maxVal) * chartH;
        doc.moveTo(chartLeft, ly).lineTo(chartLeft + chartW, ly).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
        doc.text(fmtH(val), chartLeft - 30, ly - 4, { width: 25, align: 'right' });
      }

      // X-Achse Labels
      const labelEvery = timeline.length > 20 ? Math.ceil(timeline.length / 12) : 1;
      timeline.forEach((t, i) => {
        if (i % labelEvery !== 0 && i !== timeline.length - 1) return;
        const x = chartLeft + i * xStep;
        doc.fontSize(6).fillColor('#94a3b8').text(t.label, x - 15, chartTop + chartH + 6, { width: 30, align: 'center' });
      });

      // Soll-Linie (grün, gestrichelt)
      doc.lineWidth(1.5).strokeColor('#22c55e').dash(4, { space: 3 });
      doc.moveTo(chartLeft, chartTop + chartH - (timeline[0].soll / maxVal) * chartH);
      timeline.forEach((t, i) => {
        const x = chartLeft + i * xStep;
        const ly = chartTop + chartH - (t.soll / maxVal) * chartH;
        doc.lineTo(x, ly);
      });
      doc.stroke();
      doc.undash();

      // Ist-Linie (blau)
      doc.lineWidth(2).strokeColor('#3b82f6');
      doc.moveTo(chartLeft, chartTop + chartH - (timeline[0].ist / maxVal) * chartH);
      timeline.forEach((t, i) => {
        const x = chartLeft + i * xStep;
        const ly = chartTop + chartH - (t.ist / maxVal) * chartH;
        doc.lineTo(x, ly);
      });
      doc.stroke();

      // Datenpunkte
      timeline.forEach((t, i) => {
        const x = chartLeft + i * xStep;
        doc.circle(x, chartTop + chartH - (t.soll / maxVal) * chartH, 2).fill('#22c55e');
        doc.circle(x, chartTop + chartH - (t.ist / maxVal) * chartH, 2.5).fill('#3b82f6');
      });

      // Legende
      const legX = chartLeft;
      const legLineY = chartTop + chartH + 30;
      doc.lineWidth(1.5).strokeColor('#22c55e').dash(4, { space: 3 });
      doc.moveTo(legX, legLineY).lineTo(legX + 20, legLineY).stroke();
      doc.undash();
      doc.fontSize(8).font('Helvetica').fillColor('#333').text('Soll', legX + 25, legLineY - 4);

      doc.lineWidth(2).strokeColor('#3b82f6');
      doc.moveTo(legX + 70, legLineY).lineTo(legX + 90, legLineY).stroke();
      doc.fillColor('#333').text('Ist', legX + 95, legLineY - 4);
    }

    // --- Pro-Mitarbeiter-Tabelle (nur bei mehreren) ---
    if (userStats.length > 1) {
      let ty = pieY + pieR + 80;
      if (ty > doc.page.height - 120) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 });
        ty = 40;
      }
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Pro Mitarbeiter', 40, ty);
      ty += 18;

      doc.fontSize(8).font('Helvetica-Bold');
      doc.text('Name', 40, ty, { width: 120 });
      doc.text('Ist', 160, ty, { width: 60 });
      doc.text('Soll', 220, ty, { width: 60 });
      doc.text('+/-', 280, ty, { width: 60 });
      ty += 14;
      doc.moveTo(40, ty).lineTo(340, ty).lineWidth(0.5).strokeColor('#ccc').stroke();
      ty += 4;

      doc.font('Helvetica').fontSize(8);
      for (const u of userStats) {
        doc.fillColor('#333').text(u.name, 40, ty, { width: 120 });
        doc.text(fmtH(u.ist), 160, ty, { width: 60 });
        doc.text(fmtH(u.soll), 220, ty, { width: 60 });
        doc.fillColor(u.ueber >= 0 ? '#16a34a' : '#dc2626')
           .text((u.ueber >= 0 ? '+' : '') + fmtH(u.ueber), 280, ty, { width: 60 });
        ty += 14;
      }
    }
  }

  doc.end();
});

function formatDateDE(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function countWeekdays(from, to) {
  let count = 0;
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  const current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

function drawPieSlice(doc, cx, cy, r, startAngle, endAngle, color) {
  const steps = Math.max(Math.ceil(Math.abs(endAngle - startAngle) / 0.05), 1);
  doc.save();
  doc.moveTo(cx, cy);
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (endAngle - startAngle) * (i / steps);
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) doc.lineTo(x, y); else doc.lineTo(x, y);
  }
  doc.lineTo(cx, cy);
  doc.fill(color);
  doc.restore();
}

function buildTimeline(db, userIds, dateFrom, dateTo) {
  const startD = new Date(dateFrom + 'T12:00:00');
  const endD = new Date(dateTo + 'T12:00:00');

  // Bestimme Granularität
  const diffDays = Math.round((endD - startD) / 86400000);
  const timeline = [];
  const monthNames = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

  if (diffDays <= 7) {
    // Tage
    const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const cur = new Date(startD);
    while (cur <= endD) {
      const ds = fmtDate(cur);
      timeline.push({ from: ds, to: ds, label: dayNames[cur.getDay()] });
      cur.setDate(cur.getDate() + 1);
    }
  } else if (diffDays <= 31) {
    // Tage
    const cur = new Date(startD);
    while (cur <= endD) {
      const ds = fmtDate(cur);
      timeline.push({ from: ds, to: ds, label: String(cur.getDate()) });
      cur.setDate(cur.getDate() + 1);
    }
  } else {
    // Monate
    const cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while (cur <= endD) {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const last = new Date(y, m + 1, 0);
      const to = fmtDate(last);
      timeline.push({ from, to, label: `${monthNames[m]} ${String(y).slice(2)}` });
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  // Daten berechnen (Zeitraum vor User-Erstellung ausblenden)
  return timeline.map(t => {
    let ist = 0, soll = 0;
    for (const uid of userIds) {
      const tFrom = clampFrom(t.from, getEarliestTargetDate(db, uid));
      if (tFrom > t.to) continue;
      const rows = db.prepare(
        'SELECT date, time_from, time_to, break_minutes, net_hours, user_id FROM entries WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL'
      ).all(uid, tFrom, t.to);
      ist += calcActualHours(rows);
      soll += calcTargetHours(db, uid, tFrom, t.to);
    }
    return { label: t.label, ist: Math.round(ist * 100) / 100, soll: Math.round(soll * 100) / 100 };
  });
}

module.exports = router;
