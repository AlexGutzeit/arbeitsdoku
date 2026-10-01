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
// Bis wann waren die Meldungen beim Betreten der Seite gesehen? Daran hängt „neu"/„geändert". Bleibt für den
// ganzen Besuch stehen (Wechsel Offen/History, Live-Neuzeichnen), damit die Markierung nicht beim ersten
// Neuzeichnen verschwindet — erst ein neues Betreten der Seite setzt sie neu.
let _mldSeit = null;

const MLD_STATUS = { offen: 'offen', in_arbeit: 'in Arbeit', erledigt: 'erledigt', zurueckgezogen: 'zurückgezogen' };

function _mldStatusPill(m) {
  const wer = (m.status !== 'offen' && m.status_by_name) ? ' · ' + esc(m.status_by_name) : '';
  return `<span class="mld-status mld-status-${m.status}">${MLD_STATUS[m.status] || esc(m.status)}${wer}</span>`;
}

// Neu oder geändert seit dem letzten Besuch — genau das, was der Zähler am Menü gezählt hat (routes/badges.js):
// nur, was jemand ANDERES getan hat; wer nicht bearbeiten darf, sieht es nur an seinen eigenen Meldungen.
function _mldMarke(m) {
  if (!_mldSeit || !S.user) return null;
  // Eine eigene Erinnerung ist seit dem Besuch gekommen (01.10.2026) — sie hat den Zähler hochgesetzt
  if ((m.erinnerungen || []).some(e => e.stand === 'ausgeloest' && e.stand_am && e.stand_am > _mldSeit)) return '🔔 Erinnerung';
  const vonAnderem = m.updated_by == null || m.updated_by !== S.user.id;
  if (!(m.updated_at > _mldSeit) || !vonAnderem) return null;
  if (!(S.meldungenDarf && S.meldungenDarf.bearbeiten) && !m.eigen) return null;
  return (m.created_at > _mldSeit && m.created_by !== S.user.id) ? 'neu' : 'geändert';
}

function _mldKarte(m, mitThema) {
  const marke = _mldMarke(m);
  return `
    <div class="mld-karte${m.dringend ? ' mld-dringend' : ''}${marke ? ' mld-markiert' : ''}" data-id="${m.id}" tabindex="0" role="button"
         aria-label="Meldung ${esc(m.thema_name)}: ${esc(m.text.slice(0, 80))}">
      ${marke ? `<span class="mld-marke">${marke}</span>` : ''}
      ${mitThema ? `<div class="mld-thema">${esc(m.thema_name)}${m.thema_geloescht ? ' <span class="mld-geloescht">(Thema gelöscht)</span>' : ''}</div>` : ''}
      <div class="mld-text">${m.dringend ? '<span class="mld-dringend-zeichen" title="dringend">🔴</span> ' : ''}${esc(m.text)}</div>
      <div class="mld-meta">${m.regel_id ? '🔁 ' : ''}${esc(m.created_by_name)} · ${esc(formatDateTimeDE(m.created_at))}</div>
      ${m.faellig_am ? `<div class="mld-faellig">fällig am ${esc(formatDateDE(m.faellig_am))}${m.erneut_faellig ? ` · <strong>erneut fällig am ${esc(formatDateDE(m.erneut_faellig))}</strong>` : ''}</div>` : ''}
      ${_mldErinnerungZeile(m)}
      ${_mldStatusPill(m)}
      ${m.rueckmeldung ? `<div class="mld-rueck">↩ ${esc(m.rueckmeldung)}</div>` : ''}
    </div>`;
}

async function renderMeldungen() {
  const neuerBesuch = _imRouter || _mldSeit === null;   // vor dem ersten await lesen (R23)
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
  if (neuerBesuch) _mldSeit = d.gesehen_bis || '2000-01-01 00:00:00';
  markSeen('meldungen');   // erst wenn man die Meldungen wirklich zu sehen bekommt
  S.badges.meldungen = 0;
  refreshBadges();

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
      const regelnT = (d.regeln || []).filter(r => r.thema_id === t.id);
      return `
        <div class="board-col mld-col" data-thema-id="${t.id}">
          <div class="board-col-head mld-col-head">${esc(t.name)}${liste.length ? ` <span class="board-count">${liste.length}</span>` : ''}${
            d.darf.verwalten ? `<button class="mld-regel-knopf" data-thema-id="${t.id}" title="Regelmäßige Meldungen" aria-label="Regelmäßige Meldungen für ${esc(t.name)}">🔁</button>` : ''}</div>
          <div class="board-col-body">
            <button class="btn btn-sm btn-outline mld-melden" data-thema-id="${t.id}">+ Melden</button>
            ${regelnT.length ? `<div class="mld-regeln">${regelnT.map(r => `<div class="mld-regel-zeile" title="${esc(r.beschreibung.join(' + '))}">🔁 ${esc(r.text.length > 30 ? r.text.slice(0, 29) + '…' : r.text)} · ${_mldRegelStand(r)}</div>`).join('')}</div>` : ''}
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
  mainEl.querySelectorAll('.mld-regel-knopf').forEach(b => b.addEventListener('click', () =>
    _mldRegelnDialog(Number(b.dataset.themaId), d.themen)));
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

  // Aus einer Push-Meldung (R30): hinspringen und kurz hervorheben. Steht sie nicht (mehr) im Board — erledigt,
  // zurückgezogen, Thema gelöscht —, dann in der History.
  if (S._meldungZiel != null) {
    const karte = mainEl.querySelector(`.mld-karte[data-id="${S._meldungZiel}"]`);
    if (!karte && _mldAnsicht === 'offen') {
      _mldAnsicht = 'history'; _mldHist = { thema: '', q: '', offset: 0 };
      return renderMeldungen();
    }
    S._meldungZiel = null;
    if (karte) hervorheben(karte);
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
  else if (v.art === 'erneut_faellig') was = `erneut fällig am ${esc(formatDateDE(v.nachher))} — die Meldung war noch offen (fällig am ${esc(formatDateDE(v.vorher))})`;
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
        ${m.faellig_am ? `<p class="mld-faellig">🔁 Regelmäßige Meldung · fällig am ${esc(formatDateDE(m.faellig_am))}${m.erneut_faellig ? ` · <strong>erneut fällig am ${esc(formatDateDE(m.erneut_faellig))}</strong>` : ''}</p>` : ''}
        <p class="mld-meta">Gemeldet von ${esc(m.created_by_name)} am ${esc(formatDateTimeDE(m.created_at))}${
          m.updated_by_name && m.updated_at !== m.created_at ? ` · zuletzt geändert von ${esc(m.updated_by_name)} am ${esc(formatDateTimeDE(m.updated_at))}` : ''}</p>
        ${m.rueckmeldung ? `<div class="mld-rueck-block"><strong>Rückmeldung:</strong> ${esc(m.rueckmeldung)}</div>` : ''}
        ${knoepfe.length ? `<div class="mld-knoepfe">${knoepfe.map(([s, t, k]) => `<button class="btn btn-sm ${k}" data-status="${s}">${t}</button>`).join('')}</div>` : ''}
        <div class="mld-knoepfe">
          ${bearbeiter || eigenOffen ? '<button class="btn btn-sm btn-outline" data-act="bearbeiten">Bearbeiten</button>' : ''}
          ${bearbeiter ? `<button class="btn btn-sm btn-outline" data-act="antwort">${m.rueckmeldung ? 'Rückmeldung ändern' : 'Rückmeldung schreiben'}</button>` : ''}
          ${eigenOffen ? '<button class="btn btn-sm btn-outline" data-act="widerrufen">Zurückziehen</button>' : ''}
          ${darf.loeschen ? '<button class="btn btn-sm btn-danger" data-act="entfernen">Endgültig löschen</button>' : ''}
        </div>
        ${_mldErinnerungenHtml(m, darf)}
        <details class="mld-verlauf"><summary>Verlauf (${d.verlauf.length})</summary>
          <ul>${d.verlauf.map(_mldVerlaufZeile).join('')}</ul></details>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="zu">Schließen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let erinnerungGeaendert = false;    // dann beim Schließen die Karten neu zeichnen (nächste Erinnerung)
  const schliessen = () => { overlay.remove(); aufraeumen(); if (erinnerungGeaendert) renderMeldungen(); };
  const aufraeumen = dialogBarrierefrei(overlay, schliessen);
  klickDanebenSchliesst(overlay, schliessen);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.mld-erinnerung-form')) schliessen(); });
  overlay.querySelector('[data-act="zu"]').addEventListener('click', schliessen);
  const nachher = (text) => { erinnerungGeaendert = false; schliessen(); if (text) toast(text, 'success'); renderMeldungen(); };

  // Meine Erinnerungen: an Ort und Stelle neu zeichnen — der Dialog bleibt offen
  const erinnerungenBinden = () => {
    const box = overlay.querySelector('.mld-erinnerungen');
    if (!box) return;
    const neu = box.querySelector('[data-act="erinnern"]');
    if (neu) neu.addEventListener('click', async () => {
      await ladeArbeitszeit();
      const liste = await _mldErinnerungFormular(m, null);
      if (liste) erneuern(liste, 'Erinnerung gestellt.');
    });
    box.querySelectorAll('[data-e]').forEach(b => b.addEventListener('click', async () => {
      const e = (m.erinnerungen || []).find(x => x.id === Number(b.closest('[data-eid]').dataset.eid));
      if (!e) return;
      if (b.dataset.e === 'aendern') {
        const liste = await _mldErinnerungFormular(m, e);
        if (liste) erneuern(liste, 'Erinnerung gespeichert.');
        return;
      }
      if (!await confirmModal(`Erinnerung vom ${_mldUm(e.um)} löschen?`, { okLabel: 'Löschen' })) return;
      try {
        const r = await api('DELETE', '/api/meldungen/erinnerungen/' + e.id);
        if (r) erneuern(r.erinnerungen, 'Erinnerung gelöscht.');
      } catch (err) { toast(err.message, 'error'); }
    }));
  };
  const erneuern = (liste, text) => {
    m.erinnerungen = liste;
    erinnerungGeaendert = true;
    const alt = overlay.querySelector('.mld-erinnerungen');
    if (alt) alt.outerHTML = _mldErinnerungenHtml(m, darf);
    erinnerungenBinden();
    if (text) toast(text, 'success');
  };
  erinnerungenBinden();

  overlay.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/meldungen/${m.id}/status`, { status: b.dataset.status });
      if (r) nachher(`Auf „${MLD_STATUS[b.dataset.status]}" gesetzt.`);
    } catch (e) { toast(e.message, 'error'); }
  }));
  const bearb = overlay.querySelector('[data-act="bearbeiten"]');
  if (bearb) bearb.addEventListener('click', () => { schliessen(); _mldFormular(m, themen); });
  const rueck = overlay.querySelector('[data-act="antwort"]');
  if (rueck) rueck.addEventListener('click', async () => {
    const text = await promptModal('Was soll der Melder erfahren? (z. B. „Werkstatt am 05.10.")',
      { title: 'Rückmeldung', defaultValue: m.rueckmeldung || '', okLabel: 'Speichern' });
    if (text === null) return;
    try {
      const r = await api('PUT', '/api/meldungen/' + m.id, { rueckmeldung: text });
      if (r) nachher('Rückmeldung gespeichert.');
    } catch (e) { toast(e.message, 'error'); }
  });
  const zurueck = overlay.querySelector('[data-act="widerrufen"]');
  if (zurueck) zurueck.addEventListener('click', async () => {
    if (!await confirmModal('Meldung zurückziehen? Sie steht danach als „zurückgezogen" in der History.', { okLabel: 'Zurückziehen' })) return;
    try {
      const r = await api('POST', `/api/meldungen/${m.id}/zurueckziehen`);
      if (r) nachher('Zurückgezogen.');
    } catch (e) { toast(e.message, 'error'); }
  });
  const loeschen = overlay.querySelector('[data-act="entfernen"]');
  if (loeschen) loeschen.addEventListener('click', async () => {
    if (!await confirmModal('Diese Meldung endgültig löschen — mit ihrem Verlauf? Das lässt sich nicht rückgängig machen '
      + '(nur über eine Sicherung). Im Protokoll bleibt ein Vermerk.', { okLabel: 'Endgültig löschen', danger: true })) return;
    try {
      const r = await api('DELETE', '/api/meldungen/' + m.id);
      if (r) nachher('Gelöscht.');
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ── Erinnerungen (Alex, 01.10.2026) ────────────────────────────────────────────────────────────────────
// Persönlich: Jeder sieht nur seine eigenen (der Server schickt auch nur die). Stellen darf, wer Meldungen
// bearbeitet. Steht die Meldung in der History, ruhen sie; fällt ihre Zeit in diese Pause, verfallen sie.

// „Di 27.10.2026, 07:00" aus der Ortszeit 'JJJJ-MM-TT HH:MM' (so speichert der Server, meldung-erinnerungen.js)
function _mldUm(um) {
  const t = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(String(um || ''));
  if (!t) return String(um || '');
  const wt = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(`${t[1]}-${t[2]}-${t[3]}T12:00:00Z`).getUTCDay()];
  return `${wt} ${t[3]}.${t[2]}.${t[1]}, ${t[4]}`;
}
const _mldAktiv = (m) => (m.status === 'offen' || m.status === 'in_arbeit') && !m.thema_geloescht;

// An der Karte: die nächste wartende Erinnerung — oder dass sie ruhen
function _mldErinnerungZeile(m) {
  const wartend = (m.erinnerungen || []).filter(e => e.stand === 'wartet');
  if (!wartend.length) return '';
  if (!_mldAktiv(m)) {
    return `<div class="mld-erinnerung mld-erinnerung-ruht">🔔 ${wartend.length === 1 ? 'Erinnerung ruht' : `${wartend.length} Erinnerungen ruhen`}</div>`;
  }
  return `<div class="mld-erinnerung" title="Deine nächste Erinnerung">🔔 ${esc(_mldUm(wartend[0].um))}${
    wartend.length > 1 ? ` <span class="mld-erinnerung-mehr">+${wartend.length - 1}</span>` : ''}</div>`;
}

function _mldErinnerungStand(e, aktiv) {
  if (e.stand === 'ausgeloest') return `gekommen am ${esc(formatDateTimeDE(e.stand_am))}`;
  if (e.stand === 'verpasst') return e.grund === 'ohne Recht' ? 'verfallen — ohne Bearbeitungsrecht' : 'in der Pause verpasst';
  return aktiv ? '' : 'ruht';
}

function _mldErinnerungenHtml(m, darf) {
  const liste = m.erinnerungen || [];
  const aktiv = _mldAktiv(m);
  if (!darf.bearbeiten && !liste.length) return '';
  return `
    <div class="mld-erinnerungen">
      <div class="mld-erinnerungen-kopf"><strong>🔔 Meine Erinnerungen</strong> <span class="mld-v-zeit">nur für dich</span></div>
      ${liste.length ? `<ul>${liste.map(e => {
        const stand = _mldErinnerungStand(e, aktiv);
        return `
        <li class="mld-e mld-e-${e.stand}${e.stand === 'wartet' && !aktiv ? ' mld-e-ruht' : ''}" data-eid="${e.id}">
          <span class="mld-e-zeit">${esc(_mldUm(e.um))}</span>${stand ? ` <span class="mld-e-stand">${stand}</span>` : ''}
          ${e.hinweis ? `<span class="mld-e-hinweis">${esc(e.hinweis)}</span>` : ''}
          <span class="mld-e-knoepfe">
            ${darf.bearbeiten ? `<button class="btn btn-xs btn-outline" data-e="aendern">${e.stand === 'wartet' ? 'Ändern' : 'Neues Datum'}</button>` : ''}
            <button class="btn btn-xs btn-outline" data-e="loeschen" aria-label="Erinnerung vom ${esc(_mldUm(e.um))} löschen">Löschen</button>
          </span>
        </li>`; }).join('')}</ul>` : ''}
      ${darf.bearbeiten && aktiv ? '<button class="btn btn-sm btn-outline" data-act="erinnern">🔔 Erinnern</button>'
        : darf.bearbeiten ? '<p class="mld-hinweis">Solange die Meldung in der History steht, ruhen Erinnerungen. Öffnest du sie wieder, kannst du eine neue stellen.</p>' : ''}
    </div>`;
}

// Formular: Datum (mit „morgen / in 1 Woche / in 4 Wochen"), Uhrzeit (Arbeitsbeginn), Hinweis.
// Liefert die neue Liste der eigenen Erinnerungen an dieser Meldung — oder null (abgebrochen).
function _mldErinnerungFormular(m, e) {
  return new Promise((fertig) => {
    const tag = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return formatDateISO(d); };
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog-modal mld-erinnerung-form';
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><h3>${e ? 'Erinnerung ändern' : '🔔 Erinnern'}</h3></div>
        <div class="modal-body mld-form">
          <p class="mld-meta">${esc(m.thema_name)}: ${esc(m.text.length > 80 ? m.text.slice(0, 79) + '…' : m.text)}</p>
          <label>Am <input id="mld-ef-datum" type="date" class="form-control" min="${tag(0)}" value="${esc(e ? e.um.slice(0, 10) : tag(1))}"></label>
          <div class="mld-ef-schnell" role="group" aria-label="Schnellauswahl">
            ${[[1, 'morgen'], [7, 'in 1 Woche'], [28, 'in 4 Wochen']].map(([n, t]) => `<button type="button" class="btn btn-xs btn-outline" data-tage="${n}">${t}</button>`).join('')}
          </div>
          <label>Um <input id="mld-ef-uhr" type="time" class="form-control" value="${esc(e ? e.um.slice(11, 16) : (arbeitszeitJetzt().work_start_default || '07:00'))}"></label>
          <label>Hinweis (freiwillig)
            <input id="mld-ef-hinweis" class="form-control" maxlength="200" placeholder="z. B. Werkstatt Müller, 9 Uhr" value="${esc(e && e.hinweis ? e.hinweis : '')}"></label>
          <p class="mld-hinweis">Die Erinnerung bekommst nur du — als Push und am Zähler. Ist die Meldung bis dahin erledigt, ruht sie.</p>
          <div id="mld-ef-fehler" class="mld-fehler" style="display:none"></div>
        </div>
        <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
          <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
          <button class="btn btn-primary" data-act="ok">${e ? 'Speichern' : 'Erinnern'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const schliessen = (liste) => { overlay.remove(); aufraeumen(); fertig(liste || null); };
    const aufraeumen = dialogBarrierefrei(overlay, () => schliessen(null));
    klickDanebenSchliesst(overlay, () => schliessen(null));
    overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); schliessen(null); } });
    $('[data-act="cancel"]').addEventListener('click', () => schliessen(null));
    overlay.querySelectorAll('[data-tage]').forEach(b => b.addEventListener('click', () => { $('#mld-ef-datum').value = tag(Number(b.dataset.tage)); }));
    $('[data-act="ok"]').addEventListener('click', async () => {
      const body = { datum: $('#mld-ef-datum').value, uhrzeit: $('#mld-ef-uhr').value, hinweis: $('#mld-ef-hinweis').value };
      try {
        const r = e ? await api('PUT', '/api/meldungen/erinnerungen/' + e.id, body)
                    : await api('POST', `/api/meldungen/${m.id}/erinnerungen`, body);
        if (r) schliessen(r.erinnerungen);
      } catch (err) { $('#mld-ef-fehler').textContent = err.message; $('#mld-ef-fehler').style.display = ''; }
    });
    $('#mld-ef-datum').focus();
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

// ── Regelmäßige Meldungen (Etappe 3; nur Chef/Admin verwalten, alle sehen „demnächst") ────────────────────
const MLD_EINHEIT = { tag: ['Tag', 'Tage'], woche: ['Woche', 'Wochen'], monat: ['Monat', 'Monate'], jahr: ['Jahr', 'Jahre'] };
const MLD_WT = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function _mldRegelStand(r) {
  if (r.pausiert) return 'pausiert';
  if (r.wartet_auf_erledigung) return 'nach Erledigung';
  return r.naechste ? esc(formatDateDE(r.naechste.faellig)) : 'beendet';
}

async function _mldRegelnDialog(themaId, themen) {
  const thema = themen.find(t => t.id === themaId) || { name: '' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = `
    <div class="modal mld-regeln-dialog" style="max-width:560px">
      <div class="modal-header"><h3>Regelmäßige Meldungen: ${esc(thema.name)}</h3></div>
      <div class="modal-body">
        <div id="mld-r-liste"><div class="loading">Laden…</div></div>
        <button class="btn btn-primary" id="mld-r-neu" style="margin-top:0.75rem">+ Regel</button>
        <p class="mld-hinweis">Eine Regel legt die Meldung von selbst an — zum Beispiel „TÜV" alle 2 Jahre, oder „Restmüll" am
          1. und 3. Montag. Ist die letzte noch offen, wird sie „erneut fällig" statt doppelt.</p>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="zu">Fertig</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let geaendert = false;
  const schliessen = () => { overlay.remove(); aufraeumen(); if (geaendert) renderMeldungen(); };
  const aufraeumen = dialogBarrierefrei(overlay, schliessen);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.mld-regel-form')) schliessen(); });
  overlay.querySelector('[data-act="zu"]').addEventListener('click', schliessen);
  const liste = overlay.querySelector('#mld-r-liste');
  const laden = async () => {
    let d;
    try { d = await api('GET', '/api/meldungen/regeln?thema_id=' + themaId); } catch (e) { liste.innerHTML = `<p class="mld-fehler">${esc(e.message)}</p>`; return; }
    if (!d) return;
    liste.innerHTML = d.regeln.length ? d.regeln.map(r => `
      <div class="mld-regel" data-id="${r.id}">
        <div class="mld-regel-kopf"><strong>${r.dringend ? '🔴 ' : ''}${esc(r.text)}</strong>${r.pausiert ? ' <span class="mld-status mld-status-zurueckgezogen">pausiert</span>' : ''}</div>
        <div class="mld-meta">${r.beschreibung.map(esc).join(' + ')}${r.vorlauf_zahl ? ` · ${r.vorlauf_zahl} ${MLD_EINHEIT[r.vorlauf_einheit][r.vorlauf_zahl === 1 ? 0 : 1]} vorher` : ''} · ${esc(r.uhrzeit)} Uhr${r.takt === 'ab_erledigung' ? ' · zählt ab Erledigung' : ''}</div>
        <div class="mld-meta">Nächste: ${r.pausiert ? '— (pausiert)' : r.wartet_auf_erledigung ? 'erst nach Erledigung der offenen Meldung'
          : r.naechste ? `fällig am ${esc(formatDateDE(r.naechste.faellig))} (Meldung am ${esc(formatDateDE(r.naechste.ausloesung.slice(0, 10)))}, ${esc(r.naechste.ausloesung.slice(11))} Uhr)` : 'keine mehr (Ende erreicht)'}</div>
        <div class="mld-knoepfe">
          <button class="btn btn-xs btn-outline" data-r="bearbeiten">Bearbeiten</button>
          <button class="btn btn-xs btn-outline" data-r="pause">${r.pausiert ? 'Fortsetzen' : 'Pausieren'}</button>
          <button class="btn btn-xs btn-outline" data-r="loeschen">Löschen</button>
        </div>
      </div>`).join('') : '<p class="mld-leer">Noch keine regelmäßige Meldung für dieses Thema.</p>';
    liste.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', async () => {
      const r = d.regeln.find(x => x.id === Number(b.closest('.mld-regel').dataset.id));
      try {
        if (b.dataset.r === 'bearbeiten') {
          if (await _mldRegelFormular(r, themaId, themen)) { geaendert = true; laden(); }
        } else if (b.dataset.r === 'pause') {
          await api('POST', `/api/meldungen/regeln/${r.id}/pause`, { pausiert: !r.pausiert });
          geaendert = true; laden();
        } else if (await confirmModal(`Regel „${r.text}" löschen? Schon angelegte Meldungen bleiben stehen.`, { okLabel: 'Löschen' })) {
          await api('DELETE', '/api/meldungen/regeln/' + r.id);
          geaendert = true; laden();
        }
      } catch (e) { toast(e.message, 'error'); }
    }));
  };
  overlay.querySelector('#mld-r-neu').addEventListener('click', async () => {
    if (await _mldRegelFormular(null, themaId, themen)) { geaendert = true; laden(); }
  });
  laden();
}

// Formular für eine Regel. Liefert true, wenn gespeichert wurde.
function _mldRegelFormular(regel, themaId, themen) {
  return new Promise((fertig) => {
    const heute = formatDateISO(new Date());
    let ausl = regel ? regel.ausloeser.map(a => ({ ...a })) : [{ art: 'intervall', einheit: 'jahr', n: 1, start_datum: heute, nth: 1, wochentag: 1 }];
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog-modal mld-regel-form';
    const opt = (werte, aktiv) => werte.map(([w, t]) => `<option value="${w}"${String(w) === String(aktiv) ? ' selected' : ''}>${t}</option>`).join('');
    overlay.innerHTML = `
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><h3>${regel ? 'Regel bearbeiten' : 'Neue regelmäßige Meldung'}</h3></div>
        <div class="modal-body mld-form">
          <label>Thema <select id="mld-rf-thema" class="form-control">${opt(themen.map(t => [t.id, esc(t.name)]), regel ? regel.thema_id : themaId)}</select></label>
          <label>Was soll gemeldet werden? <input id="mld-rf-text" class="form-control" maxlength="2000" placeholder="z. B. TÜV, Ölwechsel, Restmüll rausstellen" value="${regel ? esc(regel.text) : ''}"></label>
          <label class="mld-f-dringend"><input type="checkbox" id="mld-rf-dringend"${regel && regel.dringend ? ' checked' : ''}> 🔴 dringend</label>
          <fieldset class="mld-rf-gruppe"><legend>Wann? (mehrere Auslöser möglich, z. B. 1. und 3. Montag)</legend>
            <div id="mld-rf-ausl"></div>
            <button type="button" class="btn btn-xs btn-outline" id="mld-rf-ausl-neu">+ Auslöser</button>
          </fieldset>
          <div class="mld-rf-zeile">Meldung <input id="mld-rf-vz" type="number" min="0" max="365" class="form-control mld-rf-zahl" value="${regel ? regel.vorlauf_zahl : 0}" aria-label="Vorlauf">
            <select id="mld-rf-ve" class="form-control mld-rf-klein" aria-label="Vorlauf-Einheit">${opt([['tag', 'Tage'], ['woche', 'Wochen'], ['monat', 'Monate']], regel ? regel.vorlauf_einheit : 'tag')}</select>
            vorher, um <input id="mld-rf-uhr" type="time" class="form-control mld-rf-klein" value="${regel ? esc(regel.uhrzeit) : '07:00'}" aria-label="Uhrzeit"> Uhr</div>
          <fieldset class="mld-rf-gruppe"><legend>Takt</legend>
            <label class="mld-rf-radio"><input type="radio" name="mld-rf-takt" value="fest"${!regel || regel.takt === 'fest' ? ' checked' : ''}> fest (z. B. TÜV)</label>
            <label class="mld-rf-radio"><input type="radio" name="mld-rf-takt" value="ab_erledigung"${regel && regel.takt === 'ab_erledigung' ? ' checked' : ''}> ab Erledigung neu zählen (z. B. Ölwechsel)</label>
          </fieldset>
          <fieldset class="mld-rf-gruppe"><legend>Ende</legend>
            <label class="mld-rf-radio"><input type="radio" name="mld-rf-ende" value="nie"${!regel || regel.ende_typ === 'nie' ? ' checked' : ''}> nie</label>
            <label class="mld-rf-radio"><input type="radio" name="mld-rf-ende" value="anzahl"${regel && regel.ende_typ === 'anzahl' ? ' checked' : ''}> nach
              <input id="mld-rf-anzahl" type="number" min="1" max="999" class="form-control mld-rf-zahl" value="${regel && regel.ende_anzahl ? regel.ende_anzahl : 5}" aria-label="Anzahl"> Mal</label>
            <label class="mld-rf-radio"><input type="radio" name="mld-rf-ende" value="datum"${regel && regel.ende_typ === 'datum' ? ' checked' : ''}> am
              <input id="mld-rf-bis" type="date" class="form-control mld-rf-klein" value="${regel && regel.ende_datum ? esc(regel.ende_datum) : ''}" aria-label="Ende am"></label>
          </fieldset>
          <div class="mld-rf-vorschau" id="mld-rf-vorschau" aria-live="polite"></div>
          <div id="mld-rf-fehler" class="mld-fehler" style="display:none"></div>
        </div>
        <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
          <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
          <button class="btn btn-primary" data-act="ok">Speichern</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const schliessen = (gespeichert) => { overlay.remove(); aufraeumen(); fertig(!!gespeichert); };
    const aufraeumen = dialogBarrierefrei(overlay, () => schliessen(false));
    klickDanebenSchliesst(overlay, () => schliessen(false));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); schliessen(false); } });
    $('[data-act="cancel"]').addEventListener('click', () => schliessen(false));

    const auslZeichnen = () => {
      $('#mld-rf-ausl').innerHTML = ausl.map((a, i) => `
        <div class="mld-rf-ausl" data-i="${i}">
          <select class="form-control mld-rf-klein" data-f="art" aria-label="Art">${opt([['intervall', 'alle …'], ['wochentag', 'jeden n-ten Wochentag']], a.art)}</select>
          ${a.art === 'intervall' ? `
            <input type="number" min="1" max="120" class="form-control mld-rf-zahl" data-f="n" value="${a.n || 1}" aria-label="alle N">
            <select class="form-control mld-rf-klein" data-f="einheit" aria-label="Einheit">${opt([['tag', 'Tage'], ['woche', 'Wochen'], ['monat', 'Monate'], ['jahr', 'Jahre']], a.einheit || 'jahr')}</select>
            ab <input type="date" class="form-control mld-rf-klein" data-f="start_datum" value="${esc(a.start_datum || heute)}" aria-label="ab (erste Fälligkeit)">` : `
            <select class="form-control mld-rf-klein" data-f="nth" aria-label="der wievielte">${opt([[1, '1.'], [2, '2.'], [3, '3.'], [4, '4.'], [-1, 'letzten']], a.nth || 1)}</select>
            <select class="form-control mld-rf-klein" data-f="wochentag" aria-label="Wochentag">${opt(MLD_WT.slice(1).map((w, j) => [j + 1, w]), a.wochentag || 1)}</select>
            alle <input type="number" min="1" max="120" class="form-control mld-rf-zahl" data-f="n" value="${a.n || 1}" aria-label="alle N Monate"> Monate ab
            <input type="date" class="form-control mld-rf-klein" data-f="start_datum" value="${esc(a.start_datum || heute)}" aria-label="ab">`}
          ${ausl.length > 1 ? `<button type="button" class="btn btn-xs btn-outline" data-weg="${i}" aria-label="Auslöser entfernen">✕</button>` : ''}
        </div>`).join('');
      $('#mld-rf-ausl').querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => {
        const a = ausl[Number(el.closest('.mld-rf-ausl').dataset.i)];
        const f = el.dataset.f;
        a[f] = ['n', 'nth', 'wochentag'].includes(f) ? Number(el.value) : el.value;
        if (f === 'art') { if (a.art === 'intervall' && !a.einheit) a.einheit = 'jahr'; auslZeichnen(); }
        pruefen();
      }));
      $('#mld-rf-ausl').querySelectorAll('[data-weg]').forEach(b => b.addEventListener('click', () => { ausl.splice(Number(b.dataset.weg), 1); auslZeichnen(); pruefen(); }));
    };
    const daten = () => ({
      thema_id: Number($('#mld-rf-thema').value), text: $('#mld-rf-text').value.trim(), dringend: $('#mld-rf-dringend').checked,
      ausloeser: ausl.map(a => a.art === 'intervall'
        ? { art: 'intervall', einheit: a.einheit || 'jahr', n: Number(a.n) || 1, start_datum: a.start_datum }
        : { art: 'wochentag', nth: Number(a.nth) || 1, wochentag: Number(a.wochentag) || 1, n: Number(a.n) || 1, start_datum: a.start_datum }),
      vorlauf_zahl: Number($('#mld-rf-vz').value) || 0, vorlauf_einheit: $('#mld-rf-ve').value, uhrzeit: $('#mld-rf-uhr').value,
      takt: (overlay.querySelector('input[name="mld-rf-takt"]:checked') || {}).value || 'fest',
      ende_typ: (overlay.querySelector('input[name="mld-rf-ende"]:checked') || {}).value || 'nie',
      ende_anzahl: Number($('#mld-rf-anzahl').value) || null, ende_datum: $('#mld-rf-bis').value || null,
    });
    // „ab Erledigung" gibt es nur mit genau einem „alle …"-Auslöser
    const taktSperre = () => {
      const moeglich = ausl.length === 1 && ausl[0].art === 'intervall';
      const r = overlay.querySelector('input[name="mld-rf-takt"][value="ab_erledigung"]');
      r.disabled = !moeglich;
      if (!moeglich && r.checked) overlay.querySelector('input[name="mld-rf-takt"][value="fest"]').checked = true;
    };
    let warte = null, nr = 0;
    const pruefen = () => {
      taktSperre();
      clearTimeout(warte);
      warte = setTimeout(async () => {
        const meine = ++nr;
        const b = daten();
        if (!b.text) b.text = '…';   // die Vorschau braucht nur die Zeiten
        try {
          const v = await api('POST', '/api/meldungen/regeln/vorschau', b);
          if (meine !== nr || !v) return;
          $('#mld-rf-vorschau').innerHTML = `<strong>${v.beschreibung.map(esc).join(' + ')}</strong><br>`
            + (v.naechste.length ? 'Nächste: ' + v.naechste.map(x => `${esc(formatDateDE(x.faellig))}${x.ausloesung.slice(0, 10) !== x.faellig ? ` <span class="mld-v-zeit">(Meldung am ${esc(formatDateDE(x.ausloesung.slice(0, 10)))})</span>` : ''}`).join(' · ')
              : 'Es kommt keine Fälligkeit mehr.');
          $('#mld-rf-fehler').style.display = 'none';
        } catch (e) {
          if (meine !== nr) return;
          $('#mld-rf-vorschau').innerHTML = '';
          $('#mld-rf-fehler').textContent = e.message; $('#mld-rf-fehler').style.display = '';
        }
      }, 300);
    };
    overlay.querySelectorAll('input, select').forEach(el => { if (!el.closest('#mld-rf-ausl')) el.addEventListener('change', pruefen); });
    $('#mld-rf-ausl-neu').addEventListener('click', () => {
      const letzter = ausl[ausl.length - 1] || {};
      ausl.push({ art: letzter.art || 'wochentag', einheit: letzter.einheit || 'jahr', n: letzter.n || 1, start_datum: letzter.start_datum || heute,
                  nth: Math.min((letzter.nth || 1) + 2, 4), wochentag: letzter.wochentag || 1 });
      auslZeichnen(); pruefen();
    });
    $('[data-act="ok"]').addEventListener('click', async () => {
      const b = daten();
      try {
        const r = regel ? await api('PUT', '/api/meldungen/regeln/' + regel.id, b) : await api('POST', '/api/meldungen/regeln', b);
        if (!r) return;
        toast(regel ? 'Regel gespeichert.' : 'Regel angelegt.', 'success');
        schliessen(true);
      } catch (e) { $('#mld-rf-fehler').textContent = e.message; $('#mld-rf-fehler').style.display = ''; }
    });
    auslZeichnen(); pruefen();
    $('#mld-rf-text').focus();
  });
}
