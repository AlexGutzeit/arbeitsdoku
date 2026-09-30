// ================================================================
// Meldungen (30.09.2026) — Probleme zu festen Themen melden
// ================================================================
// Alex: Chef/Admin legen Themen an (Allgemein, Auto 1, Papiermüll …), jeder meldet Probleme dazu
// („Auto 2 → Ölwechsel"). Die Themen stehen NEBENEINANDER wie beim Auftrags-Board, die Meldungen darunter
// (am Handy seitlich wischen). Erledigte und zurückgezogene wandern in die History, ebenso alles eines
// gelöschten Themas.
// Wer was darf, entscheidet der Server (meldungrecht.js) und schickt es als `darf` mit — die Oberfläche
// zeigt nur an, was er erlaubt, und prüft nichts selbst nach.

let _mldAnsicht = 'offen';                  // 'offen' | 'history'
let _mldHist = { thema: '', q: '', offset: 0 };

const MLD_STATUS = { offen: 'offen', in_arbeit: 'in Arbeit', erledigt: 'erledigt', zurueckgezogen: 'zurückgezogen' };

function _mldStatusPill(m) {
  const wer = (m.status !== 'offen' && m.status_by_name) ? ' · ' + esc(m.status_by_name) : '';
  return `<span class="mld-status mld-status-${m.status}">${MLD_STATUS[m.status] || esc(m.status)}${wer}</span>`;
}

function _mldKarte(m, mitThema) {
  return `
    <div class="mld-karte${m.dringend ? ' mld-dringend' : ''}" data-id="${m.id}" tabindex="0" role="button"
         aria-label="Meldung ${esc(m.thema_name)}: ${esc(m.text.slice(0, 80))}">
      ${mitThema ? `<div class="mld-thema">${esc(m.thema_name)}${m.thema_geloescht ? ' <span class="mld-geloescht">(Thema gelöscht)</span>' : ''}</div>` : ''}
      <div class="mld-text">${m.dringend ? '<span class="mld-dringend-zeichen" title="dringend">🔴</span> ' : ''}${esc(m.text)}</div>
      <div class="mld-meta">${esc(m.created_by_name)} · ${esc(formatDateTimeDE(m.created_at))}</div>
      ${_mldStatusPill(m)}
      ${m.rueckmeldung ? `<div class="mld-rueck">↩ ${esc(m.rueckmeldung)}</div>` : ''}
    </div>`;
}

async function renderMeldungen() {
  $app().innerHTML = layout('<div class="loading">Laden…</div>', 'meldungen');
  bindLayout();
  const geladen = await seiteLaden(async () => {
    const d = await api('GET', '/api/meldungen');
    if (!d) return null;
    let h = null;
    if (_mldAnsicht === 'history') {
      const p = new URLSearchParams({ limit: String(50 + _mldHist.offset) });
      if (_mldHist.thema) p.set('thema_id', _mldHist.thema);
      if (_mldHist.q) p.set('q', _mldHist.q);
      h = await api('GET', '/api/meldungen/history?' + p.toString());
      if (!h) return null;
    }
    return { d, h };
  }, () => renderMeldungen());
  if (!geladen) return;
  const { d, h } = geladen;
  S.meldungenDarf = d.darf;

  const mainEl = document.querySelector('.main');
  mainEl.classList.add('main-wide');
  const kopf = `
    <div class="board-head">
      <h2>Meldungen</h2>
      <div class="board-ansicht" role="group" aria-label="Ansicht">
        ${[['offen', 'Offen'], ['history', 'History']].map(([k, t]) =>
          `<button class="btn btn-sm board-ansicht-btn${_mldAnsicht === k ? ' active' : ''}" data-mld-ansicht="${k}"
                   aria-pressed="${_mldAnsicht === k}">${t}</button>`).join('')}
      </div>
      ${d.darf.verwalten ? '<button class="btn btn-sm btn-outline" id="mld-themen">Themen verwalten</button>' : ''}
    </div>`;

  let inhalt;
  if (_mldAnsicht === 'history') {
    const themenOpt = (h.themen || []).map(t => `<option value="${t.id}"${String(_mldHist.thema) === String(t.id) ? ' selected' : ''}>${esc(t.name)}${t.geloescht ? ' (gelöscht)' : ''}</option>`).join('');
    inhalt = `
      <div class="mld-hist-filter">
        <label>Thema <select id="mld-hist-thema" class="form-control"><option value="">alle</option>${themenOpt}</select></label>
        <input id="mld-hist-q" type="search" class="form-control" placeholder="Text, Rückmeldung oder Name suchen …" value="${esc(_mldHist.q)}" aria-label="History durchsuchen">
      </div>
      <div class="mld-hist-liste">${h.meldungen.length
        ? h.meldungen.map(m => _mldKarte(m, true)).join('')
        : '<p class="mld-leer">Noch nichts in der History.</p>'}</div>
      ${h.mehr ? '<button class="btn btn-outline" id="mld-hist-mehr" style="width:100%;margin-top:0.75rem">Ältere anzeigen</button>' : ''}`;
  } else if (!d.themen.length) {
    inhalt = `<div class="card mld-leer-karte"><p>Es gibt noch keine Themen.</p>
      ${d.darf.verwalten ? '<button class="btn btn-primary" id="mld-themen-leer">Themen anlegen</button>'
        : '<p class="mld-leer">Chef oder Admin legen die Themen an (z. B. „Allgemein", „Auto 1", „Papiermüll").</p>'}</div>`;
  } else {
    const spalten = d.themen.map(t => {
      const liste = d.meldungen.filter(m => m.thema_id === t.id);
      return `
        <div class="board-col mld-col" data-thema-id="${t.id}">
          <div class="board-col-head">${esc(t.name)}${liste.length ? ` <span class="board-count">${liste.length}</span>` : ''}</div>
          <div class="board-col-body">
            <button class="btn btn-sm btn-outline mld-melden" data-thema-id="${t.id}">+ Melden</button>
            ${liste.map(m => _mldKarte(m, false)).join('')}
          </div>
        </div>`;
    }).join('');
    inhalt = `<div class="board-scroll"><div class="board-columns">${spalten}</div></div>`;
  }
  mainEl.innerHTML = `<div class="board-wrap meldungen-seite">${kopf}${inhalt}</div>`;

  mainEl.querySelectorAll('[data-mld-ansicht]').forEach(b => b.addEventListener('click', () => {
    if (_mldAnsicht === b.dataset.mldAnsicht) return;
    _mldAnsicht = b.dataset.mldAnsicht;
    _mldHist.offset = 0;
    renderMeldungen();
  }));
  // Beide Knöpfe: oben „Themen verwalten" steht für Chef/Admin IMMER da, „Themen anlegen" nur ohne Themen
  for (const idK of ['mld-themen', 'mld-themen-leer']) {
    const b = document.getElementById(idK);
    if (b) b.addEventListener('click', () => _mldThemenDialog(d.themen));
  }
  mainEl.querySelectorAll('.mld-melden').forEach(b => b.addEventListener('click', () =>
    _mldFormular(null, d.themen, Number(b.dataset.themaId))));
  mainEl.querySelectorAll('.mld-karte').forEach(k => {
    const oeffnen = () => _mldDetail(Number(k.dataset.id), d.themen);
    k.addEventListener('click', oeffnen);
    k.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); oeffnen(); } });
  });
  if (_mldAnsicht === 'history') {
    document.getElementById('mld-hist-thema').addEventListener('change', (e) => { _mldHist.thema = e.target.value; _mldHist.offset = 0; renderMeldungen(); });
    let warte = null;
    document.getElementById('mld-hist-q').addEventListener('input', (e) => {
      clearTimeout(warte);
      warte = setTimeout(async () => {
        _mldHist.q = e.target.value.trim(); _mldHist.offset = 0;
        await renderMeldungen();
        const feld = document.getElementById('mld-hist-q');
        if (feld) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }
      }, 350);
    });
    const mehr = document.getElementById('mld-hist-mehr');
    if (mehr) mehr.addEventListener('click', () => { _mldHist.offset += 50; renderMeldungen(); });
  }
}

// ── Melden / Bearbeiten ─────────────────────────────────────────────────────────────────────────────────
function _mldFormular(meldung, themen, themaId) {
  const neu = !meldung;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  const gewaehlt = neu ? themaId : meldung.thema_id;
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header"><h3>${neu ? 'Melden' : 'Meldung bearbeiten'}</h3></div>
      <div class="modal-body mld-form">
        <label>Thema
          <select id="mld-f-thema" class="form-control">${themen.map(t =>
            `<option value="${t.id}"${t.id === gewaehlt ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        </label>
        <label>Was ist los?
          <textarea id="mld-f-text" class="form-control" rows="4" maxlength="2000" placeholder="z. B. Ölwechsel fällig, Tonne voll …">${neu ? '' : esc(meldung.text)}</textarea>
        </label>
        <label class="mld-f-dringend"><input type="checkbox" id="mld-f-dringend"${!neu && meldung.dringend ? ' checked' : ''}> 🔴 dringend</label>
        <div id="mld-f-fehler" class="mld-fehler" style="display:none"></div>
      </div>
      <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
        <button class="btn btn-primary" data-act="ok">${neu ? 'Melden' : 'Speichern'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const schliessen = () => { overlay.remove(); aufraeumen(); };
  const aufraeumen = dialogBarrierefrei(overlay, schliessen);
  klickDanebenSchliesst(overlay, schliessen);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') schliessen(); });
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', schliessen);
  const textEl = overlay.querySelector('#mld-f-text');
  const fehlerEl = overlay.querySelector('#mld-f-fehler');
  overlay.querySelector('[data-act="ok"]').addEventListener('click', async () => {
    const text = textEl.value.trim();
    if (!text) {
      fehlerEl.textContent = 'Bitte beschreibe kurz, was los ist.'; fehlerEl.style.display = '';
      textEl.setAttribute('aria-invalid', 'true'); textEl.setAttribute('aria-describedby', 'mld-f-fehler'); textEl.focus();
      return;
    }
    const body = { thema_id: Number(overlay.querySelector('#mld-f-thema').value), text,
                   dringend: overlay.querySelector('#mld-f-dringend').checked };
    try {
      const r = neu ? await api('POST', '/api/meldungen', body) : await api('PUT', '/api/meldungen/' + meldung.id, body);
      if (!r) return;
      schliessen();
      toast(neu ? 'Gemeldet.' : 'Gespeichert.', 'success');
      renderMeldungen();
    } catch (e) {
      fehlerEl.textContent = e.message; fehlerEl.style.display = '';
    }
  });
  textEl.focus();
}

// ── Detail mit Verlauf und Knöpfen ──────────────────────────────────────────────────────────────────────
function _mldVerlaufZeile(v) {
  const wer = `<strong>${esc(v.user_name || 'automatisch')}</strong>`;
  const zit = (s) => `„${esc(s || '')}"`;
  let was;
  if (v.art === 'gemeldet') was = 'hat gemeldet';
  else if (v.art === 'bearbeitet') was = `hat den Text geändert — vorher: ${zit(v.vorher)}`;
  else if (v.art === 'dringlichkeit') was = `Dringlichkeit: ${esc(v.vorher)} → ${esc(v.nachher)}`;
  else if (v.art === 'thema') was = `Thema: ${esc(v.vorher)} → ${esc(v.nachher)}`;
  else if (v.art === 'rueckmeldung') was = v.nachher ? `Rückmeldung: ${zit(v.nachher)}` : 'hat die Rückmeldung entfernt';
  else if (v.art === 'status') was = v.nachher === 'zurueckgezogen' ? 'hat die Meldung zurückgezogen'
    : v.nachher === 'offen' ? 'hat die Meldung wieder geöffnet'
    : `Stand: ${MLD_STATUS[v.vorher] || esc(v.vorher)} → ${MLD_STATUS[v.nachher] || esc(v.nachher)}`;
  else if (v.art === 'thema_geloescht') was = `hat das Thema ${zit(v.vorher)} gelöscht — die Meldung steht jetzt in der History`;
  else was = esc(v.art);
  return `<li><span class="mld-v-zeit">${esc(formatDateTimeDE(v.at))}</span> ${wer} ${was}</li>`;
}

async function _mldDetail(id, themen) {
  let d;
  try { d = await api('GET', '/api/meldungen/' + id); } catch (e) { toast(e.message, 'error'); return; }
  if (!d) return;
  const m = d.meldung;
  const darf = S.meldungenDarf || {};
  const lesen = m.thema_geloescht;                                   // gelöschtes Thema: nur noch lesen
  const bearbeiter = darf.bearbeiten && !lesen;
  const eigenOffen = m.eigen && m.status === 'offen' && !lesen;
  const knoepfe = [];
  if (bearbeiter) {
    if (m.status === 'offen') knoepfe.push(['in_arbeit', 'In Arbeit', 'btn-primary'], ['erledigt', 'Erledigt', 'btn-success']);
    if (m.status === 'in_arbeit') knoepfe.push(['erledigt', 'Erledigt', 'btn-success'], ['offen', 'Zurück auf offen', 'btn-outline']);
    if (m.status === 'erledigt' || m.status === 'zurueckgezogen') knoepfe.push(['offen', 'Wieder öffnen', 'btn-outline']);
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = `
    <div class="modal mld-detail" style="max-width:560px">
      <div class="modal-header"><h3>${esc(m.thema_name)}${lesen ? ' <span class="mld-geloescht">(Thema gelöscht)</span>' : ''}</h3></div>
      <div class="modal-body">
        <div class="mld-detail-kopf">${_mldStatusPill(m)}${m.dringend ? ' <span class="mld-dringend-etikett">🔴 dringend</span>' : ''}</div>
        <p class="mld-detail-text">${esc(m.text)}</p>
        <p class="mld-meta">Gemeldet von ${esc(m.created_by_name)} am ${esc(formatDateTimeDE(m.created_at))}${
          m.updated_by_name && m.updated_at !== m.created_at ? ` · zuletzt geändert von ${esc(m.updated_by_name)} am ${esc(formatDateTimeDE(m.updated_at))}` : ''}</p>
        ${m.rueckmeldung ? `<div class="mld-rueck-block"><strong>Rückmeldung:</strong> ${esc(m.rueckmeldung)}</div>` : ''}
        ${knoepfe.length ? `<div class="mld-knoepfe">${knoepfe.map(([s, t, k]) => `<button class="btn btn-sm ${k}" data-status="${s}">${t}</button>`).join('')}</div>` : ''}
        <div class="mld-knoepfe">
          ${bearbeiter || eigenOffen ? '<button class="btn btn-sm btn-outline" data-act="bearbeiten">Bearbeiten</button>' : ''}
          ${bearbeiter ? `<button class="btn btn-sm btn-outline" data-act="rueck">${m.rueckmeldung ? 'Rückmeldung ändern' : 'Rückmeldung schreiben'}</button>` : ''}
          ${eigenOffen ? '<button class="btn btn-sm btn-outline" data-act="zurueck">Zurückziehen</button>' : ''}
          ${darf.loeschen ? '<button class="btn btn-sm btn-danger" data-act="loeschen">Endgültig löschen</button>' : ''}
        </div>
        <details class="mld-verlauf"><summary>Verlauf (${d.verlauf.length})</summary>
          <ul>${d.verlauf.map(_mldVerlaufZeile).join('')}</ul></details>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="zu">Schließen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const schliessen = () => { overlay.remove(); aufraeumen(); };
  const aufraeumen = dialogBarrierefrei(overlay, schliessen);
  klickDanebenSchliesst(overlay, schliessen);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') schliessen(); });
  overlay.querySelector('[data-act="zu"]').addEventListener('click', schliessen);
  const nachher = (text) => { schliessen(); if (text) toast(text, 'success'); renderMeldungen(); };

  overlay.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/meldungen/${m.id}/status`, { status: b.dataset.status });
      if (r) nachher(`Auf „${MLD_STATUS[b.dataset.status]}" gesetzt.`);
    } catch (e) { toast(e.message, 'error'); }
  }));
  const bearb = overlay.querySelector('[data-act="bearbeiten"]');
  if (bearb) bearb.addEventListener('click', () => { schliessen(); _mldFormular(m, themen); });
  const rueck = overlay.querySelector('[data-act="rueck"]');
  if (rueck) rueck.addEventListener('click', async () => {
    const text = await promptModal('Was soll der Melder erfahren? (z. B. „Werkstatt am 05.10.")',
      { title: 'Rückmeldung', defaultValue: m.rueckmeldung || '', okLabel: 'Speichern' });
    if (text === null) return;
    try {
      const r = await api('PUT', '/api/meldungen/' + m.id, { rueckmeldung: text });
      if (r) nachher('Rückmeldung gespeichert.');
    } catch (e) { toast(e.message, 'error'); }
  });
  const zurueck = overlay.querySelector('[data-act="zurueck"]');
  if (zurueck) zurueck.addEventListener('click', async () => {
    if (!await confirmModal('Meldung zurückziehen? Sie steht danach als „zurückgezogen" in der History.', { okLabel: 'Zurückziehen' })) return;
    try {
      const r = await api('POST', `/api/meldungen/${m.id}/zurueckziehen`);
      if (r) nachher('Zurückgezogen.');
    } catch (e) { toast(e.message, 'error'); }
  });
  const loeschen = overlay.querySelector('[data-act="loeschen"]');
  if (loeschen) loeschen.addEventListener('click', async () => {
    if (!await confirmModal('Diese Meldung endgültig löschen — mit ihrem Verlauf? Das lässt sich nicht rückgängig machen '
      + '(nur über eine Sicherung). Im Protokoll bleibt ein Vermerk.', { okLabel: 'Endgültig löschen', danger: true })) return;
    try {
      const r = await api('DELETE', '/api/meldungen/' + m.id);
      if (r) nachher('Gelöscht.');
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ── Themen verwalten (Chef/Admin) ──────────────────────────────────────────────────────────────────────
function _mldThemenDialog(themenStart) {
  let themen = themenStart.slice();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header"><h3>Themen verwalten</h3></div>
      <div class="modal-body">
        <ul class="mld-themen-liste" id="mld-t-liste"></ul>
        <div class="mld-themen-neu">
          <input id="mld-t-neu" class="form-control" maxlength="60" placeholder="Neues Thema, z. B. Auto 3" aria-label="Neues Thema">
          <button class="btn btn-primary" id="mld-t-add">Hinzufügen</button>
        </div>
        <p class="mld-hinweis">Ein Thema mit Meldungen bleibt beim Löschen in der History erhalten — seine Meldungen auch.</p>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="zu">Fertig</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let geaendert = false;
  const schliessen = () => { overlay.remove(); aufraeumen(); if (geaendert) renderMeldungen(); };
  const aufraeumen = dialogBarrierefrei(overlay, schliessen);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') schliessen(); });
  overlay.querySelector('[data-act="zu"]').addEventListener('click', schliessen);
  const liste = overlay.querySelector('#mld-t-liste');

  const neuLaden = async () => {
    const d = await api('GET', '/api/meldungen');
    if (d) { themen = d.themen; zeichnen(); }
  };
  const zeichnen = () => {
    liste.innerHTML = themen.length ? themen.map((t, i) => `
      <li data-id="${t.id}">
        <span class="mld-t-name">${esc(t.name)}</span>
        <button class="btn btn-xs btn-outline" data-t="hoch" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t.name)} nach oben">↑</button>
        <button class="btn btn-xs btn-outline" data-t="runter" ${i === themen.length - 1 ? 'disabled' : ''} aria-label="${esc(t.name)} nach unten">↓</button>
        <button class="btn btn-xs btn-outline" data-t="umbenennen" aria-label="${esc(t.name)} umbenennen">✏️</button>
        <button class="btn btn-xs btn-outline" data-t="loeschen" aria-label="${esc(t.name)} löschen">🗑</button>
      </li>`).join('') : '<li class="mld-leer">Noch keine Themen.</li>';
    liste.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => aktion(b.dataset.t, Number(b.closest('li').dataset.id))));
  };
  const aktion = async (was, id) => {
    const t = themen.find(x => x.id === id);
    try {
      if (was === 'hoch' || was === 'runter') {
        const ids = themen.map(x => x.id);
        const i = ids.indexOf(id), j = was === 'hoch' ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await api('PUT', '/api/meldungen/themen-reihenfolge', { ids });
      } else if (was === 'umbenennen') {
        const name = await promptModal('Neuer Name:', { title: 'Thema umbenennen', defaultValue: t.name, multiline: false, required: true, okLabel: 'Umbenennen' });
        if (name === null) return;
        await api('PUT', '/api/meldungen/themen/' + id, { name });
      } else if (was === 'loeschen') {
        const alle = await api('GET', '/api/meldungen');
        const offen = alle ? alle.meldungen.filter(m => m.thema_id === id).length : 0;
        const frage = `Thema „${t.name}" löschen?` + (offen
          ? `\n\n${offen} ${offen === 1 ? 'Meldung ist' : 'Meldungen sind'} noch offen — ${offen === 1 ? 'sie wandert' : 'sie wandern'} mit in die History und ${offen === 1 ? 'ist' : 'sind'} dort nur noch zu lesen.`
          : '\n\nHat es schon Meldungen, bleibt es mit ihnen in der History erhalten.');
        if (!await confirmModal(frage, { okLabel: 'Löschen', danger: true })) return;
        await api('DELETE', '/api/meldungen/themen/' + id);
      }
      geaendert = true;
      await neuLaden();
    } catch (e) { toast(e.message, 'error'); }
  };
  const neuFeld = overlay.querySelector('#mld-t-neu');
  const hinzu = async () => {
    const name = neuFeld.value.trim();
    if (!name) { neuFeld.focus(); return; }
    try {
      const r = await api('POST', '/api/meldungen/themen', { name });
      if (!r) return;
      neuFeld.value = ''; geaendert = true;
      await neuLaden();
      neuFeld.focus();
    } catch (e) { toast(e.message, 'error'); }
  };
  overlay.querySelector('#mld-t-add').addEventListener('click', hinzu);
  neuFeld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); hinzu(); } });
  zeichnen();
  neuFeld.focus();
}
