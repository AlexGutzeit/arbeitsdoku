// --- Bestellungen ---
async function renderOrders() {
  $app().innerHTML = layout('<div class="loading">Laden…</div>', 'orders');
  bindLayout();

  const manage = darfBestellen();   // Rolle ODER Einzelrecht (s. app-1-core.js)
  let orders = [];
  try {
    const [oData, pData] = await Promise.all([
      api('GET', '/api/orders'),
      api('GET', '/api/projects')
    ]);
    if (!oData) return;
    orders = oData.orders;
    if (pData) S.projects = pData.projects;
  } catch (e) { toast(e.message, 'error'); return; }

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div class="card" style="max-width:900px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2>Bestellungen</h2>
        <button class="btn btn-primary" id="order-add-btn">+ Hinzuf&uuml;gen</button>
      </div>
      <div id="order-form-area"></div>
      ${orders.length ? listenSucheHtml('bestellung', 'Produkt, Ort, Notiz oder Person suchen …') : ''}
      <div id="order-list">${renderOrderList(orders, manage)}</div>
      <div style="margin-top:2rem">
        <button class="btn btn-outline" id="toggle-ordered" style="width:100%">Letzte Bestellungen anzeigen</button>
        <div id="ordered-list" style="display:none;margin-top:1rem"></div>
      </div>
    </div>
  `;

  bindListenSuche('bestellung', '#order-list');

  document.getElementById('order-add-btn').addEventListener('click', () => {
    showOrderForm(null, orders, manage);
  });

  const toggleBtn = document.getElementById('toggle-ordered');
  let orderedLoaded = false;
  toggleBtn.addEventListener('click', async () => {
    const area = document.getElementById('ordered-list');
    if (area.style.display !== 'none') {
      area.style.display = 'none';
      toggleBtn.textContent = 'Letzte Bestellungen anzeigen';
      return;
    }
    if (!orderedLoaded) {
      area.innerHTML = '<div class="loading">Laden…</div>';
      try {
        const data = await api('GET', '/api/orders/ordered');
        if (!data) return;
        area.innerHTML = renderOrderedList(data.orders);
        bindOrderedEvents(data.orders);
        orderedLoaded = true;
      } catch (e) { toast(e.message, 'error'); return; }
    }
    area.style.display = 'block';
    toggleBtn.textContent = 'Letzte Bestellungen ausblenden';
  });

  bindOrderEvents(orders, manage);
}

function fmtOrderQty(o) {
  if (!o.quantity) return '';
  if (o.unit) return `<strong>${esc(String(o.quantity))} ${esc(o.unit)}</strong> `;
  return `<strong>${esc(String(o.quantity))}x</strong> `;
}

function fmtOrderLocation(o) {
  if (!o.location_text || o.location_text === 'Lager') return '';
  return ` <span class="order-location">&rarr; ${esc(o.location_text)}</span>`;
}

function renderOrderList(orders, manage) {
  if (!orders.length) return '<p style="color:var(--text-lighter);text-align:center">Keine offenen Bestellungen</p>';
  return orders.map(o => {
    const isOwn = o.user_id === S.user.id;
    const canEdit = isOwn || manage;
    const created = o.created_at ? formatDateTimeDE(o.created_at) : '';
    const suchtext = [fmtOrderQty(o), o.product, o.location_text, o.comment, o.user_name].filter(Boolean).join(' ');
    return `<div class="order-item" data-id="${o.id}" data-suchtext="${esc(suchtext)}">
      <div class="order-content">
        <div class="order-product">${fmtOrderQty(o)}${esc(o.product)}${fmtOrderLocation(o)}</div>
        ${o.comment ? `<div class="order-comment">${esc(o.comment)}</div>` : ''}
        <div class="order-meta">von ${esc(o.user_name)} am ${created}</div>
      </div>
      <div class="order-actions">
        ${canEdit ? `<button class="btn btn-sm order-edit-btn" data-id="${o.id}" title="Bearbeiten">&#9998;</button>` : ''}
        ${canEdit ? `<button class="btn btn-sm btn-danger order-del-btn" data-id="${o.id}" title="L&ouml;schen">&times;</button>` : ''}
        ${manage ? `<button class="btn btn-sm btn-primary order-mark-btn" data-id="${o.id}">Bestellt</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderOrderedList(orders) {
  if (!orders.length) return '<p style="color:var(--text-lighter);text-align:center">Keine Bestellungen im letzten Monat</p>';
  const isAdmin = S.user.role === 'admin';
  return orders.map(o => {
    const requestedDate = o.created_at ? formatDateTimeDE(o.created_at) : '';
    const orderedDate = o.ordered_at ? formatDateTimeDE(o.ordered_at) : '';
    return `<div class="order-item order-done" data-id="${o.id}">
      <div class="order-content">
        <div class="order-product">${fmtOrderQty(o)}${esc(o.product)}${fmtOrderLocation(o)}</div>
        ${o.comment ? `<div class="order-comment">${esc(o.comment)}</div>` : ''}
        <div class="order-meta">Bestellt von ${esc(o.user_name)} am ${requestedDate}</div>
        <div class="order-meta">Bestellung ausgelöst${o.ordered_by_name ? ' von ' + esc(o.ordered_by_name) : ''} am ${orderedDate}</div>
      </div>
      ${isAdmin ? `<div class="order-actions"><button class="btn btn-sm btn-danger ordered-del-btn" data-id="${o.id}" aria-label="Bestellung ${esc(o.product)} löschen" title="Löschen">&times;</button></div>` : ''}
    </div>`;
  }).join('');
}


function showOrderForm(editOrder, orders, manage) {
  const area = document.getElementById('order-form-area');
  const qty = editOrder && editOrder.quantity ? editOrder.quantity : '';
  const unit = editOrder ? (editOrder.unit || '') : '';
  const product = editOrder ? editOrder.product : '';
  const comment = editOrder ? (editOrder.comment || '') : '';
  const projId = editOrder ? (editOrder.project_id || '') : '';
  const projectOptions = (S.projects || []).map(p =>
    `<option value="${p.id}" ${p.id === projId ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
  area.innerHTML = `
    <form id="order-form" class="order-form" style="margin-bottom:1rem">
      <div class="form-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Produkt *</label>
          <input type="text" id="of-product" class="form-control" value="${esc(product)}" required>
        </div>
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Kommentar</label>
          <input type="text" id="of-comment" class="form-control" value="${esc(comment)}">
        </div>
      </div>
      <div class="form-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-top:0.25rem">
        <div class="form-group" style="width:70px">
          <label>Anzahl</label>
          <input type="number" id="of-qty" class="form-control" value="${qty}" min="0" placeholder="-">
        </div>
        <div class="form-group" style="width:100px">
          <label>Einheit</label>
          <input type="text" id="of-unit" class="form-control" value="${esc(unit)}" placeholder="Stk, Bund…">
        </div>
        <div class="form-group" style="flex:1;min-width:140px">
          <label>Verwendungsort</label>
          <select id="of-location" class="form-control">
            <option value="" ${!projId ? 'selected' : ''}>Lager</option>
            ${projectOptions}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
        <button type="submit" class="btn btn-primary">${editOrder ? 'Speichern' : 'Hinzuf\u00fcgen'}</button>
        <button type="button" class="btn btn-outline" id="of-cancel">Abbrechen</button>
      </div>
    </form>
  `;

  document.getElementById('of-product').focus();
  document.getElementById('of-cancel').addEventListener('click', () => { area.innerHTML = ''; });

  const ofEntwurf = 'bestellung:' + (editOrder ? editOrder.id : 'neu');
  initDraftKeeper(document.getElementById('order-form'), ofEntwurf);

  document.getElementById('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const qtyVal = document.getElementById('of-qty').value.trim();
    const qtyNum = qtyVal ? parseInt(qtyVal, 10) : 0;
    const locVal = document.getElementById('of-location').value;
    const body = {
      quantity: qtyNum > 0 ? qtyNum : null,
      unit: document.getElementById('of-unit').value.trim(),
      product: document.getElementById('of-product').value.trim(),
      comment: document.getElementById('of-comment').value.trim(),
      project_id: locVal ? Number(locVal) : null
    };
    try {
      if (editOrder) {
        await api('PUT', '/api/orders/' + editOrder.id, body);
        toast('Aktualisiert', 'success');
      } else {
        await api('POST', '/api/orders', body);
        toast('Hinzugef\u00fcgt', 'success');
      }
      entwurfLoeschen(ofEntwurf);
      renderOrders();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindOrderEvents(orders, manage) {
  // Bearbeiten
  document.querySelectorAll('.order-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const o = orders.find(x => x.id === Number(btn.dataset.id));
      if (o) showOrderForm(o, orders, manage);
    });
  });
  // Löschen
  document.querySelectorAll('.order-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Eintrag l\u00f6schen?', { title: 'Eintrag l\u00f6schen', okLabel: 'L\u00f6schen' }))) return;
      try {
        await api('DELETE', '/api/orders/' + btn.dataset.id);
        toast('Gel\u00f6scht', 'success');
        renderOrders();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  // Bestellt markieren
  document.querySelectorAll('.order-mark-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/orders/' + btn.dataset.id + '/order');
        await loadBadges();
        toast('Als bestellt markiert', 'success');
        renderOrders();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function bindOrderedEvents(orders) {
  document.querySelectorAll('.ordered-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Eintrag endg\u00fcltig l\u00f6schen?', { title: 'Endg\u00fcltig l\u00f6schen', okLabel: 'Endg\u00fcltig l\u00f6schen' }))) return;
      try {
        await api('DELETE', '/api/orders/' + btn.dataset.id);
        toast('Gel\u00f6scht', 'success');
        btn.closest('.order-item').remove();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// --- Notizen ---
let _notizen = [];
let _notizenFilter = { projectId: '', search: '', owner: '' };
let _expandedNoteId = null;
let _editingNoteLockId = null;

async function renderNotizen() {
  S.badges.notes = 0;
  refreshBadges();
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'notes');
  bindLayout();

  let notes = [], offers = [];
  try {
    const [nData, pData, oData] = await Promise.all([
      api('GET', '/api/notes'),
      api('GET', '/api/projects'),
      api('GET', '/api/notes/offers')
    ]);
    markSeen('notes');
    if (!nData) return;
    notes = nData.notes || [];
    if (pData) S.projects = pData.projects;
    offers = (oData && oData.offers) || [];
  } catch (e) { toast(e.message, 'error'); return; }

  _notizen = notes;
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  // Eingehende Angebote
  let offersHtml = '';
  if (offers.length) {
    offersHtml = `<div class="note-offers-section">
      <h3>Eingehende Notizen</h3>
      ${offers.map(o => `
        <div class="note-offer-item" data-offer-id="${o.id}">
          <div>
            <strong>${esc(o.title)}</strong>
            <span class="note-meta">von ${esc(o.from_user_name)}</span>
          </div>
          <div class="note-actions">
            <button class="btn btn-sm btn-primary offer-accept-btn" data-id="${o.id}">Annehmen</button>
            <button class="btn btn-sm btn-outline offer-decline-btn" data-id="${o.id}">Ablehnen</button>
          </div>
        </div>
      `).join('')}
    </div>`;
  }

  // Projekte für Filter
  const projOpts = (S.projects || []).map(p =>
    `<option value="${p.id}" ${_notizenFilter.projectId == p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  // Nutzer, die MIR etwas freigegeben haben (aus den geteilten Notizen), alphabetisch — je eigene Filteroption.
  const _seenOwners = new Set();
  const sharers = [];
  for (const n of notes) {
    if (n.user_id !== S.user.id && !_seenOwners.has(n.user_id)) {
      _seenOwners.add(n.user_id);
      sharers.push({ id: n.user_id, name: n.owner_name || ('#' + n.user_id) });
    }
  }
  sharers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  // Steht der Filter auf einem Freigeber, der jetzt keine Notiz mehr hat (z. B. letzte entfernt),
  // auf „Alle" zurücksetzen — sonst zeigt der Select einen nicht mehr existierenden Eintrag.
  if (_notizenFilter.owner && _notizenFilter.owner.startsWith('u:') && !_seenOwners.has(Number(_notizenFilter.owner.slice(2)))) {
    _notizenFilter.owner = '';
  }
  const sharerOpts = sharers.map(s =>
    `<option value="u:${s.id}" ${_notizenFilter.owner === 'u:' + s.id ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');

  mainEl.innerHTML = `
    <div class="card" style="max-width:900px;margin:0 auto">
      <h2 style="margin-bottom:1rem">Notizen</h2>
      ${offersHtml}
      <div class="note-filters">
        <select id="note-filter-owner" class="form-control">
          <option value="">Alle Notizen</option>
          <option value="own" ${_notizenFilter.owner === 'own' ? 'selected' : ''}>Eigene</option>
          <option value="shared" ${_notizenFilter.owner === 'shared' ? 'selected' : ''}>Freigegeben (von anderen)</option>
          ${sharerOpts}
        </select>
        <select id="note-filter-project" class="form-control">
          <option value="">Alle Projekte</option>
          <option value="none" ${_notizenFilter.projectId === 'none' ? 'selected' : ''}>Kein Projekt</option>
          ${projOpts}
        </select>
        <input type="text" id="note-filter-search" class="form-control" placeholder="Suche..." value="${esc(_notizenFilter.search)}">
      </div>
      <div id="note-form-area"></div>
      <div id="note-list">${renderNoteList(filterNotizen())}</div>
    </div>
  `;

  // Filter-Events
  document.getElementById('note-filter-owner').addEventListener('change', (e) => {
    _notizenFilter.owner = e.target.value;
    document.getElementById('note-list').innerHTML = renderNoteList(filterNotizen());
    bindNoteEvents();
  });
  document.getElementById('note-filter-project').addEventListener('change', (e) => {
    _notizenFilter.projectId = e.target.value;
    document.getElementById('note-list').innerHTML = renderNoteList(filterNotizen());
    bindNoteEvents();
  });
  document.getElementById('note-filter-search').addEventListener('input', (e) => {
    _notizenFilter.search = e.target.value;
    document.getElementById('note-list').innerHTML = renderNoteList(filterNotizen());
    bindNoteEvents();
  });

  // Offer-Events
  document.querySelectorAll('.offer-accept-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/notes/offers/' + btn.dataset.id + '/accept');
        toast('Notiz angenommen', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll('.offer-decline-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/notes/offers/' + btn.dataset.id + '/decline');
        toast('Abgelehnt', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  bindNoteEvents();
}

function filterNotizen() {
  let list = _notizen;
  const of = _notizenFilter.owner;
  if (of === 'own') list = list.filter(n => n.user_id === S.user.id);
  else if (of === 'shared') list = list.filter(n => n.user_id !== S.user.id);
  else if (of && of.startsWith('u:')) { const uid = Number(of.slice(2)); list = list.filter(n => n.user_id === uid); }
  const pf = _notizenFilter.projectId;
  if (pf === 'none') {
    list = list.filter(n => !n.project_id && !n.project_text);
  } else if (pf) {
    list = list.filter(n => n.project_id == pf);
  }
  const sf = _notizenFilter.search.toLowerCase().trim();
  if (sf) {
    list = list.filter(n =>
      (n.title || '').toLowerCase().includes(sf) ||
      (n.body || '').toLowerCase().includes(sf) ||
      (n.project_text || '').toLowerCase().includes(sf)
    );
  }
  return list;
}

function renderNoteList(notes) {
  if (!notes.length) return '<p style="color:var(--text-lighter);margin-top:1rem">Keine Notizen</p>';
  const uid = S.user.id;
  return notes.map(n => {
    const isOwner = n.user_id === uid;
    const canWrite = isOwner || n.access_level === 'write';
    const projDisplay = n.project_text ? `<div class="note-project">${esc(n.project_text)}</div>` : '';
    const preview = (n.body || '').length > 120 ? esc(n.body.substring(0, 120)) + '...' : esc(n.body || '');
    const ownerInfo = !isOwner ? `<span>von ${esc(n.owner_name)}</span>` : '';
    const sharesInfo = (n.shares && n.shares.length)
      ? `<span>Geteilt mit: ${n.shares.map(s => esc(s.user_name)).join(', ')}</span>` : '';
    const accessBadge = !isOwner ? `<span class="badge badge-${n.access_level === 'write' ? 'chef' : 'mitarbeiter'}">${n.access_level === 'write' ? 'Schreibzugriff' : 'Lesezugriff'}</span>` : '';
    const isExpanded = _expandedNoteId === n.id;
    const lockBadge = (n.editing_by && n.editing_by !== uid)
      ? `<span class="badge badge-lock">&#128274; ${esc(n.editing_by_name || '')}</span>` : '';

    return `<div class="note-card${n.is_unread ? ' note-card--unread' : ''}${isExpanded ? ' note-card-expanded' : ''}" data-id="${n.id}">
      <div class="note-card-row">
        <div class="note-content" style="flex:1;min-width:0">
          <div class="note-title">${esc(n.title)} ${accessBadge} ${lockBadge}</div>
          ${projDisplay}
          ${isExpanded
            ? `<div class="note-body-full">${esc(n.body || '')}</div>`
            : `<div class="note-preview">${preview}</div>`}
          <div class="note-meta">
            ${ownerInfo}
            ${sharesInfo}
            <span>Bearbeitet ${formatDateTimeDE(n.updated_at)}${n.updated_by_name ? ' von ' + esc(n.updated_by_name) : ''}</span>
          </div>
        </div>
        <div class="note-actions">
          ${canWrite ? `<button class="btn btn-sm note-edit-btn" data-id="${n.id}" title="Bearbeiten">&#9998;</button>` : ''}
          ${isOwner ? `<button class="btn btn-sm note-share-btn" data-id="${n.id}" title="Freigabe">&#128101;</button>` : ''}
          ${isOwner ? `<button class="btn btn-sm note-offer-btn" data-id="${n.id}" title="Weitergeben">&#10145;</button>` : ''}
          ${isOwner ? `<button class="btn btn-sm btn-danger note-del-btn" data-id="${n.id}" title="L\u00f6schen">&times;</button>` : ''}
          ${!isOwner ? `<button class="btn btn-sm note-leave-btn" data-id="${n.id}" title="Freigabe verlassen (aus meiner Liste entfernen)">&#128682;</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function bindNoteEvents() {
  // Expand/Collapse auf Kachel-Klick
  document.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.note-actions')) return;
      const noteId = Number(card.dataset.id);
      _expandedNoteId = (_expandedNoteId === noteId) ? null : noteId;
      const listEl = document.getElementById('note-list');
      if (listEl) {
        listEl.innerHTML = renderNoteList(filterNotizen());
        bindNoteEvents();
      }
    });
  });
  document.querySelectorAll('.note-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = _notizen.find(x => x.id === Number(btn.dataset.id));
      if (n) acquireLockAndEdit(n);
    });
  });
  document.querySelectorAll('.note-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await confirmModal('Notiz wirklich l\u00f6schen?', { title: 'Notiz l\u00f6schen', okLabel: 'L\u00f6schen' }))) return;
      try {
        await api('DELETE', '/api/notes/' + btn.dataset.id);
        toast('Gel\u00f6scht', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll('.note-share-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = _notizen.find(x => x.id === Number(btn.dataset.id));
      if (n) showShareDialog(n);
    });
  });
  document.querySelectorAll('.note-offer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = _notizen.find(x => x.id === Number(btn.dataset.id));
      if (n) showOfferDialog(n);
    });
  });
  document.querySelectorAll('.note-leave-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await confirmModal('Diese geteilte Notiz aus deiner Liste entfernen? Der Eigentümer kann dich später wieder hinzufügen.', { title: 'Freigabe verlassen', okLabel: 'Entfernen' }))) return;
      try {
        await api('DELETE', '/api/notes/' + btn.dataset.id + '/share/self');
        toast('Aus deiner Liste entfernt', 'success');
        renderNotizen();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

async function acquireLockAndEdit(note) {
  const isShared = note.shares && note.shares.length > 0;
  if (isShared) {
    try {
      await api('POST', '/api/notes/' + note.id + '/lock');
      _editingNoteLockId = note.id;
    } catch (err) {
      toast(err.message || 'Notiz ist gerade in Bearbeitung', 'error');
      return;
    }
  }
  showNoteForm(note);
}

function showNoteForm(editNote) {
  const area = document.getElementById('note-form-area');
  if (!area) return;

  const projId = editNote ? editNote.project_id : null;
  const projText = editNote ? (editNote.project_text || '') : '';
  const hasProject = !!projId;

  const projOpts = (S.projects || []).map(p =>
    `<option value="${p.id}" ${p.id === projId ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  area.innerHTML = `
    <form id="note-form" class="note-form" style="margin-bottom:1rem;padding:1rem;border:1px solid var(--border);border-radius:8px;background:#f8fafc">
      <div class="form-group">
        <label>Titel *</label>
        <input type="text" id="nf-title" class="form-control" value="${editNote ? esc(editNote.title) : ''}" required>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Projekt</label>
          <select id="nf-project" class="form-control">
            <option value="">-- Kein Projekt --</option>
            ${projOpts}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:150px">
          <label>Projekt (Freitext)</label>
          <input type="text" id="nf-project-text" class="form-control" value="${!hasProject ? esc(projText) : ''}" placeholder="z.B. Baustelle XY" ${hasProject ? 'disabled' : ''}>
        </div>
      </div>
      <div class="form-group">
        <label>Notiz</label>
        <textarea id="nf-body" class="form-control note-body-textarea" rows="8">${editNote ? esc(editNote.body || '') : ''}</textarea>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
        <button type="submit" class="btn btn-primary">${editNote ? 'Speichern' : 'Erstellen'}</button>
        <button type="button" class="btn btn-outline" id="nf-cancel">Abbrechen</button>
      </div>
    </form>
  `;

  // Projekt-Dropdown / Freitext gegenseitig ausschließen
  const projSelect = document.getElementById('nf-project');
  const projTextInput = document.getElementById('nf-project-text');
  projSelect.addEventListener('change', () => {
    if (projSelect.value) {
      projTextInput.value = '';
      projTextInput.disabled = true;
    } else {
      projTextInput.disabled = false;
    }
  });
  projTextInput.addEventListener('input', () => {
    if (projTextInput.value.trim()) {
      projSelect.value = '';
    }
  });

  document.getElementById('nf-cancel').addEventListener('click', async () => {
    if (_editingNoteLockId) {
      try { await api('POST', '/api/notes/' + _editingNoteLockId + '/unlock'); } catch(e) {}
      _editingNoteLockId = null;
    }
    renderNotizen();
  });
  const nfEntwurf = 'notiz:' + (editNote ? editNote.id : 'neu');
  initDraftKeeper(document.getElementById('note-form'), nfEntwurf);

  document.getElementById('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: document.getElementById('nf-title').value.trim(),
      body: document.getElementById('nf-body').value,
      project_id: projSelect.value ? Number(projSelect.value) : null,
      project_text: projSelect.value ? '' : projTextInput.value.trim()
    };
    try {
      if (editNote) {
        await api('PUT', '/api/notes/' + editNote.id, body);
        _editingNoteLockId = null;
        toast('Gespeichert', 'success');
      } else {
        await api('POST', '/api/notes', body);
        toast('Erstellt', 'success');
      }
      entwurfLoeschen(nfEntwurf);
      renderNotizen();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('nf-title').focus();
}

async function showShareDialog(note) {
  let users = [], shares = [];
  try {
    const [uData, sData] = await Promise.all([
      api('GET', '/api/users/list'),
      api('GET', '/api/notes/' + note.id + '/shares')
    ]);
    users = (uData && uData.users) || [];
    shares = (sData && sData.shares) || [];
  } catch (e) { toast(e.message, 'error'); return; }

  // Owner aus Liste entfernen
  users = users.filter(u => u.id !== note.user_id);
  if (!users.length) { toast('Keine anderen Benutzer vorhanden', 'info'); return; }

  const shareMap = {};
  for (const s of shares) shareMap[s.user_id] = s.permission;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div class="modal-header">
        <h3>Freigabe: ${esc(note.title)}</h3>
      </div>
      <div class="modal-body">
        <table class="share-matrix">
          <thead><tr><th>Benutzer</th><th style="text-align:center">Lesen</th><th style="text-align:center">Schreiben</th></tr></thead>
          <tbody>
            ${users.map(u => {
              const perm = shareMap[u.id] || '';
              return `<tr data-uid="${u.id}">
                <td>${esc(u.name)}</td>
                <td style="text-align:center"><input type="checkbox" class="share-read" data-uid="${u.id}" ${perm === 'read' || perm === 'write' ? 'checked' : ''}></td>
                <td style="text-align:center"><input type="checkbox" class="share-write" data-uid="${u.id}" ${perm === 'write' ? 'checked' : ''}></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" id="share-cancel">Abbrechen</button>
        <button class="btn btn-primary" id="share-save">Speichern</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Write angehakt → Read automatisch mit
  overlay.querySelectorAll('.share-write').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        overlay.querySelector(`.share-read[data-uid="${cb.dataset.uid}"]`).checked = true;
      }
    });
  });
  // Read abgehakt → Write automatisch aus
  overlay.querySelectorAll('.share-read').forEach(cb => {
    cb.addEventListener('change', () => {
      if (!cb.checked) {
        overlay.querySelector(`.share-write[data-uid="${cb.dataset.uid}"]`).checked = false;
      }
    });
  });

  const aufraeumen = dialogBarrierefrei(overlay);
  const close = () => { overlay.remove(); aufraeumen(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#share-cancel').addEventListener('click', close);
  overlay.querySelector('#share-save').addEventListener('click', async () => {
    const newShares = [];
    overlay.querySelectorAll('.share-read').forEach(cb => {
      if (cb.checked) {
        const uid = Number(cb.dataset.uid);
        const isWrite = overlay.querySelector(`.share-write[data-uid="${uid}"]`).checked;
        newShares.push({ user_id: uid, permission: isWrite ? 'write' : 'read' });
      }
    });
    try {
      await api('PUT', '/api/notes/' + note.id + '/shares', { shares: newShares });
      toast('Freigaben gespeichert', 'success');
      close();
      renderNotizen();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function showOfferDialog(note) {
  let users = [];
  try {
    const uData = await api('GET', '/api/users/list');
    users = (uData && uData.users) || [];
  } catch (e) { toast(e.message, 'error'); return; }

  users = users.filter(u => u.id !== note.user_id);
  if (!users.length) { toast('Keine anderen Benutzer vorhanden', 'info'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <h3>Notiz weitergeben</h3>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:0.75rem;color:var(--text-light);font-size:0.85rem">W\u00e4hle Empf\u00e4nger f\u00fcr eine Kopie von "${esc(note.title)}":</p>
        ${users.map(u => `
          <label style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;cursor:pointer">
            <input type="checkbox" class="offer-user-cb" value="${u.id}">
            <span>${esc(u.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" id="offer-cancel">Abbrechen</button>
        <button class="btn btn-primary" id="offer-send">Senden</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const aufraeumen = dialogBarrierefrei(overlay);
  const close = () => { overlay.remove(); aufraeumen(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#offer-cancel').addEventListener('click', close);
  overlay.querySelector('#offer-send').addEventListener('click', async () => {
    const userIds = [];
    overlay.querySelectorAll('.offer-user-cb:checked').forEach(cb => userIds.push(Number(cb.value)));
    if (!userIds.length) { toast('Bitte mindestens einen Empf\u00e4nger w\u00e4hlen', 'error'); return; }
    try {
      await api('POST', '/api/notes/' + note.id + '/offer', { user_ids: userIds });
      toast('Notiz angeboten', 'success');
      close();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Abwesenheit ---

const ABSENCE_TYPES = {
  krank:             { label: 'Krank',              icon: '🏥', workflow: 'notify' },
  urlaub:            { label: 'Urlaub',             icon: '🌴', workflow: 'approve' },
  freizeitausgleich: { label: 'Freizeitausgleich',  icon: '⏱️', workflow: 'approve' },
  sonderurlaub:      { label: 'Sonderurlaub',       icon: '🎁', workflow: 'approve' },
  berufsschule:      { label: 'Berufsschule',       icon: '🏫', workflow: 'notify' },
  innung:            { label: 'Innung',             icon: '🔧', workflow: 'notify' },
  feiertag:          { label: 'Feiertag',           icon: '🎉', workflow: 'none' },
};

function absenceStatusClass(status) {
  if (status === 'pending')  return 'absence-card--pending';
  if (status === 'rejected') return 'absence-card--rejected';
  return 'absence-card--active';
}

function absenceStatusLabel(status) {
  if (status === 'pending')  return '<span class="absence-status absence-status--pending">Offen</span>';
  if (status === 'rejected') return '<span class="absence-status absence-status--rejected">Abgelehnt</span>';
  if (status === 'approved') return '<span class="absence-status absence-status--approved">Genehmigt</span>';
  return '<span class="absence-status absence-status--active">Aktiv</span>';
}

function formatDateRange(from, to) {
  if (from === to) return formatDateDE(from);
  return formatDateDE(from) + ' – ' + formatDateDE(to);
}

const APPROVAL_REQUIRED_TYPES = ['urlaub', 'sonderurlaub', 'freizeitausgleich'];

// Konflikt-Gruppen (Spiegel des Backends in routes/absences.js): zwei Abwesenheiten
// derselben Gruppe duerfen sich pro Tag nicht ueberschneiden -> harte Sperre.
const ABSENCE_CONFLICT_GROUPS = [
  ['urlaub', 'freizeitausgleich', 'sonderurlaub'],
  ['berufsschule', 'innung'],
  ['krank'],
];
function absenceGroup(type) {
  return ABSENCE_CONFLICT_GROUPS.find(g => g.includes(type)) || null;
}
function sameAbsenceGroup(a, b) {
  const g = absenceGroup(a);
  return g ? g.includes(b) : false;
}
// Prioritaet fuer die Tageszaehlung (kleiner = hoeher, gewinnt):
// Feiertag > Krank > Berufsschule/Innung > Urlaub/FZA/Sonderurlaub.
const ABSENCE_PRIORITY = {
  feiertag: 0, krank: 1, berufsschule: 2, innung: 2,
  urlaub: 3, freizeitausgleich: 3, sonderurlaub: 3,
};
function filterApprovedAbsences(absences) {
  return (absences || []).filter(a =>
    // Pending Urlaub/FZA/Sonderurlaub ausblenden — AUSSER wenn ein Vorschlag hängt
    // (dann sind alte genehmigte Daten noch gültig und werden angezeigt)
    !(APPROVAL_REQUIRED_TYPES.includes(a.type) && a.status === 'pending' && !a.proposed_date_from)
  );
}

function getAbsencesForDay(userId, date, absences) {
  return (absences || []).filter(a => {
    if (a.date_from > date || a.date_to < date) return false;
    if (a.user_id === null) return true;
    return a.user_id === userId;
  });
}

function isManagerRole() {
  return S.user && (S.user.role === 'admin' || S.user.role === 'chef' || S.user.role === 'buchhalter');
}

function renderAbsenceCard(a, opts = {}) {
  const type = ABSENCE_TYPES[a.type] || { label: a.type, icon: '📋' };
  // Schreibaktionen auf Abwesenheiten nur Chef/Admin (Buchhalter ist read-only); eigene bleiben editierbar.
  const canEdit = isChefOrAdmin() || a.user_id === S.user?.id;
  const isManagerEntry = a.created_by && a.created_by !== a.user_id;
  const isSelfChefAdmin = a.user_id === S.user?.id && ['admin','chef'].includes(S.user?.role);
  const canApprove = isChefOrAdmin() && a.status === 'pending' && !isManagerEntry && (a.user_id !== S.user?.id || isSelfChefAdmin);
  const canAcknowledge = isChefOrAdmin() && a.status === 'active' && ['krank','berufsschule','innung'].includes(a.type) && !a.notified_at && (a.user_id !== S.user?.id || isSelfChefAdmin);
  // MA-Akzeptanz für Manager-eingetragene pending-Einträge
  const canMaAccept = !isManagerRole() && a.user_id === S.user?.id && isManagerEntry && a.status === 'pending' && !a.ma_needs_ack;
  // MA quittiert/akzeptiert Manager-Änderung (dates/comment edit)
  const canMaAck = a.user_id === S.user?.id && !!a.ma_needs_ack;
  // Ablehnen nur wenn Manager einen Datums-Vorschlag gemacht hat (proposed_date_from gesetzt)
  const canMaRejectEdit = canMaAck && !!a.proposed_date_from;

  // Vorschlags-Anzeige (für MA-Posteingang UND Manager-Ansicht)
  const hasProposal = !!a.proposed_date_from;
  let datesHtml;
  if (hasProposal) {
    const who = a.processed_by_name || 'Vorgesetzte/r';
    datesHtml = `
      <div class="absence-proposal-block">
        <div class="absence-proposal-new">${esc(who)} schlägt vor: <strong>${formatDateRange(a.proposed_date_from, a.proposed_date_to)}</strong></div>
        <div class="absence-proposal-old">Bisheriger Zeitraum: ${formatDateRange(a.date_from, a.date_to)}</div>
      </div>`;
  } else {
    datesHtml = `<div class="absence-card-dates">${formatDateRange(a.date_from, a.date_to)}</div>`;
  }

  const maAckBanner = canMaAck && !hasProposal
    ? `<div class="absence-ma-ack-banner">Bearbeitet von: ${esc(a.processed_by_name || 'Vorgesetzter')} — Bitte bestätigen</div>`
    : '';

  // Bearbeiten-Button: bei Vorschlag den vorgeschlagenen Zeitraum vorausfüllen
  const editFrom = hasProposal ? a.proposed_date_from : a.date_from;
  const editTo   = hasProposal ? a.proposed_date_to   : a.date_to;

  return `<div class="absence-card ${absenceStatusClass(a.status)}${canMaAck ? ' absence-card--needs-ack' : ''}" data-id="${a.id}">
    <div class="absence-card-header">
      <span class="absence-type-icon">${type.icon}</span>
      <strong>${esc(type.label)}</strong>
      ${isManagerRole() && a.user_name ? `<span class="absence-user">${esc(a.user_name)}</span>` : ''}
      ${absenceStatusLabel(a.status)}
    </div>
    ${datesHtml}
    ${a.comment ? `<div class="absence-card-comment">${esc(a.comment)}</div>` : ''}
    ${isManagerEntry && a.created_by_name && !canMaAck && !hasProposal ? `<div class="absence-created-by">Eingetragen von: ${esc(a.created_by_name)}</div>` : ''}
    ${maAckBanner}
    ${a.processed_by_name && !canMaAck && !hasProposal ? `<div class="absence-card-meta">Bearbeitet von ${esc(a.processed_by_name)}</div>` : ''}
    <div class="absence-card-timestamps">
      Erstellt: ${formatDateTimeDE(a.created_at)}${a.updated_at && a.updated_at !== a.created_at ? ` &nbsp;·&nbsp; Geändert: ${formatDateTimeDE(a.updated_at)}` : ''}
    </div>
    <div class="absence-card-actions">
      ${canApprove ? `<button class="btn btn-sm btn-primary absence-approve" data-id="${a.id}">Genehmigen</button>
                      <button class="btn btn-sm btn-danger absence-reject" data-id="${a.id}">Ablehnen</button>` : ''}
      ${canMaAccept ? `<button class="btn btn-sm btn-primary absence-accept" data-id="${a.id}">Akzeptieren</button>
                       <button class="btn btn-sm btn-danger absence-reject-ma" data-id="${a.id}">Ablehnen</button>` : ''}
      ${canAcknowledge ? `<button class="btn btn-sm btn-primary absence-acknowledge" data-id="${a.id}">Quittieren</button>` : ''}
      ${canMaAck && !canMaRejectEdit ? `<button class="btn btn-sm btn-primary absence-ack-ma" data-id="${a.id}">Quittieren</button>` : ''}
      ${canMaRejectEdit ? `<button class="btn btn-sm btn-success absence-ack-ma" data-id="${a.id}">Akzeptieren</button>
                           <button class="btn btn-sm btn-danger absence-reject-edit" data-id="${a.id}">Ablehnen</button>` : ''}
      ${canEdit ? `<button class="btn btn-sm btn-outline absence-edit" data-id="${a.id}" data-type="${a.type}" data-from="${editFrom}" data-to="${editTo}" data-comment="${esc(a.comment||'')}">Bearbeiten</button>` : ''}
      ${(isChefOrAdmin() || a.user_id === S.user?.id) ? `<button class="btn btn-sm btn-danger absence-delete" data-id="${a.id}">Löschen</button>` : ''}
    </div>
    ${isChefOrAdmin() ? `
    <details class="absence-changelog" data-id="${a.id}">
      <summary>Änderungsverlauf</summary>
      <div class="absence-changelog-body" data-id="${a.id}"></div>
    </details>` : ''}
  </div>`;
}

// Die Karten eines Verlaufs-Monats nachzeichnen. Eigene Funktion, weil es ZWEI Ausloeser gibt:
// das Aufklappen durch den Nutzer (`toggle`) und den Sprung aus dem Kalender. Letzterer darf sich
// NICHT auf das Ereignis verlassen — `toggle` feuert asynchron, und der Sprung stuende danach vor
// einem noch leeren Monat.
function verlaufMonatZeichnen(d) {
  const body = d.querySelector('.absence-history-month-body');
  if (!body || body.dataset.rendered) return;
  body.dataset.rendered = '1';
  const items = _absHistory[d.dataset.absKey] || [];
  body.innerHTML = items.map(a => renderAbsenceCard(a)).join('');
  bindAbsenceCardActions(body); // Aktionen + Änderungsverlauf der frisch gebauten Karten binden
}

function bindAbsenceCardActions(container) {
  // Lazy-Render: Karten eines Verlauf-Monats erst beim Aufklappen ins DOM bauen (einmalig),
  // danach deren Aktionen binden. Spart DOM-Knoten bei vielen Einträgen über die Jahre.
  container.querySelectorAll('details.absence-history-month').forEach(d => {
    d.addEventListener('toggle', () => { if (d.open) verlaufMonatZeichnen(d); });
  });

  // Änderungsverlauf (chef/admin): beim ersten Aufklappen laden
  container.querySelectorAll('details.absence-changelog').forEach(d => {
    d.addEventListener('toggle', async () => {
      if (!d.open) return;
      const body = d.querySelector('.absence-changelog-body');
      if (body.dataset.loaded) return;
      body.dataset.loaded = '1';
      body.textContent = 'Lade…';
      try {
        const data = await api('GET', '/api/absences/' + d.dataset.id + '/history');
        const hist = (data && data.history) || [];
        if (!hist.length) { body.textContent = 'Keine Änderungen protokolliert.'; return; }
        body.innerHTML = hist.map(h => {
          const s = h.snapshot || {};
          const act = h.action === 'delete' ? 'Gelöscht' : (h.action === 'restore' ? 'Wiederhergestellt' : 'Geändert');
          const vorher = formatDateRange(s.date_from, s.date_to) + (s.status ? `, Status ${esc(s.status)}` : '');
          return `<div class="absence-changelog-row">
            <strong>${act}</strong> am ${esc(String(h.changed_at || '').slice(0, 19))} von ${esc(h.changed_by_name || '—')}
            ${h.reason ? ` — <em>${esc(h.reason)}</em>` : ''}
            <br><span class="absence-changelog-before">Vorher: ${vorher}</span>
          </div>`;
        }).join('');
      } catch (e) { body.textContent = 'Fehler: ' + e.message; }
    });
  });

  container.querySelectorAll('.absence-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { const r = await api('POST', '/api/absences/' + btn.dataset.id + '/approve'); if (r && r.warning) toast(r.warning, 'warning', 6000); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-reject').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/reject'); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-accept').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/accept', {}); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-reject-ma').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/reject-ma', {}); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-acknowledge').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/acknowledge'); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-ack-ma').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/acknowledge-ma'); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-reject-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', '/api/absences/' + btn.dataset.id + '/reject-manager-edit'); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Abwesenheit wirklich löschen?', { title: 'Abwesenheit löschen', okLabel: 'Löschen' }))) return;
      // Begruendung optional (eigene), Pflicht bei fremder — Backend erzwingt das
      const reason = await promptModal('Begründung für das Löschen (bei fremder Abwesenheit Pflicht):', { title: 'Begründung' });
      if (reason === null) return; // Abbrechen → Abwesenheit NICHT löschen
      try { await api('DELETE', '/api/absences/' + btn.dataset.id, { reason: reason.trim() }); renderAbsences(); } catch(e) { toast(e.message, 'error'); }
    });
  });
  container.querySelectorAll('.absence-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      showAbsenceForm(btn.dataset.id, btn.dataset.type, btn.dataset.from, btn.dataset.to, btn.dataset.comment);
    });
  });
}

function showAbsenceForm(editId, preType, preFrom, preTo, preComment, preUser) {
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const role = S.user?.role;
  const managerOnly = ['feiertag'];
  const availableTypes = Object.entries(ABSENCE_TYPES).filter(([t]) => {
    if (managerOnly.includes(t)) return isChefOrAdmin();
    return true;
  });

  const typeOpts = availableTypes.map(([t, info]) =>
    `<option value="${t}" ${preType === t ? 'selected' : ''}>${info.icon} ${info.label}</option>`
  ).join('');

  // Mitarbeiterauswahl nur für Chef/Admin (Buchhalter trägt nur für sich selbst ein)
  let userSelectHtml = '';
  if (isChefOrAdmin() && !editId) {
    const allOtherUsers = S.users.filter(u => u.id !== S.user.id).sort((a, b) => a.name.localeCompare(b.name));
    const isFeiertag = preType === 'feiertag';
    userSelectHtml = `
      <div class="form-group" id="abs-user-group"${isFeiertag ? ' style="display:none"' : ''}>
        <label>Für</label>
        <select id="abs-user" class="form-control">
          <option value="${S.user.id}">Für mich selbst</option>
          ${allOtherUsers.map(u => `<option value="${u.id}">${esc(u.name)} (${roleName(u.role)})</option>`).join('')}
        </select>
      </div>
      <div id="abs-feiertag-hint" class="absence-feiertag-hint"${isFeiertag ? '' : ' style="display:none"'}>Gilt für alle Mitarbeiter</div>`;
  }

  // „Heute" in Europe/Berlin (nicht UTC) — sonst schlägt das Formular zwischen 00:00 und 02:00 den Vortag vor.
  const today = new Date().toLocaleDateString('sv-SE');
  const formHtml = `
    <div class="absence-form-overlay" id="absence-form-overlay">
      <div class="absence-form-card">
        <h3>${editId ? 'Abwesenheit bearbeiten' : 'Abwesenheit eintragen'}</h3>
        ${userSelectHtml}
        <div class="form-group">
          <label>Typ</label>
          <select id="abs-type" class="form-control" ${editId ? 'disabled' : ''}>
            ${typeOpts || `<option value="${esc(preType)}">${esc(preType)}</option>`}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Von</label>
            <input type="date" id="abs-from" class="form-control" value="${esc(preFrom || today)}">
          </div>
          <div class="form-group">
            <label>Bis</label>
            <input type="date" id="abs-to" class="form-control" value="${esc(preTo || today)}">
          </div>
        </div>
        <div class="form-group">
          <label>Kommentar (optional)</label>
          <textarea id="abs-comment" class="form-control" rows="2">${esc(preComment || '')}</textarea>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" id="abs-save">${editId ? 'Speichern' : 'Eintragen'}</button>
          <button class="btn btn-outline" id="abs-cancel">Abbrechen</button>
        </div>
      </div>
    </div>
  `;

  // A5: Ein bereits offenes Formular zuerst entfernen. Sonst lägen zwei Overlays übereinander und alle
  // Handler (getElementById) griffen auf das ERSTE zu — man tippt sichtbar ins zweite, gespeichert würden
  // die Werte des unsichtbaren ersten.
  document.getElementById('absence-form-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.innerHTML = formHtml;
  document.body.appendChild(overlay.firstElementChild);
  const absAufraeumen = dialogBarrierefrei(document.getElementById('absence-form-overlay'));
  const absSchliessen = () => { document.getElementById('absence-form-overlay')?.remove(); absAufraeumen(); };
  // Escape schliesst den Dialog — wie bei allen anderen auch.
  const absOnKey = (e) => {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', absOnKey);
    absSchliessen();
  };
  document.addEventListener('keydown', absOnKey);

  // Manager, der für jemanden „neu beantragt": Ziel-Mitarbeiter vorauswählen.
  if (preUser) {
    const us = document.getElementById('abs-user');
    if (us) us.value = String(preUser);
  }

  document.getElementById('abs-cancel').addEventListener('click', () => {
    document.removeEventListener('keydown', absOnKey);
    absSchliessen();
  });

  document.getElementById('abs-type')?.addEventListener('change', () => {
    const isFeiertag = document.getElementById('abs-type').value === 'feiertag';
    const grp = document.getElementById('abs-user-group');
    const hint = document.getElementById('abs-feiertag-hint');
    if (grp) grp.style.display = isFeiertag ? 'none' : '';
    if (hint) hint.style.display = isFeiertag ? '' : 'none';
  });

  const absEntwurf = 'abwesenheit:' + (editId ? editId : 'neu');
  // Behaelter ist die KARTE, nicht das Overlay — sonst schwebte die Entwurfs-Leiste
  // ausserhalb des Dialogs auf dem abgedunkelten Hintergrund.
  initDraftKeeper(document.querySelector('#absence-form-overlay .absence-form-card'), absEntwurf);

  document.getElementById('abs-save').addEventListener('click', async () => {
    const type = editId ? preType : document.getElementById('abs-type').value;
    const date_from = document.getElementById('abs-from').value;
    const date_to   = document.getElementById('abs-to').value;
    const comment   = document.getElementById('abs-comment').value;
    const target_user_id = document.getElementById('abs-user')?.value
      ? Number(document.getElementById('abs-user').value)
      : S.user.id;

    if (!date_from || !date_to) { toast('Datum erforderlich', 'error'); return; }
    if (date_from > date_to) { toast('Datum von muss vor bis liegen', 'error'); return; }

    try {
      // Überlappungsprüfung für den gewählten User (globale Feiertage haben user_id=null
      // und sind hier bewusst ausgenommen)
      const existingParams = `from=${date_from}&to=${date_to}` + (target_user_id !== S.user.id ? `&user_id=${target_user_id}` : '');
      const existing = await api('GET', `/api/absences?${existingParams}`);
      const overlaps = (existing?.absences || []).filter(a => String(a.id) !== String(editId) && a.user_id === target_user_id);
      const lbl = (t) => ABSENCE_TYPES[t]?.label || t;

      // 1) Gleiche Stufe → harte Sperre (kein Speichern; Backend erzwingt es zusätzlich)
      const sameTier = overlaps.find(a => sameAbsenceGroup(type, a.type));
      if (sameTier) {
        const grp = absenceGroup(type).map(lbl).join('/');
        toast(`Pro Tag ist nur eine Abwesenheit aus ${grp} möglich (bereits „${lbl(sameTier.type)}" eingetragen).`, 'error');
        return;
      }
      // 2) Andere Stufe → Hinweis mit erklärter Priorität, Speichern bestätigen lassen
      const crossTier = overlaps[0];
      if (crossTier) {
        const winner = ABSENCE_PRIORITY[type] <= ABSENCE_PRIORITY[crossTier.type] ? type : crossTier.type;
        const loser  = winner === type ? crossTier.type : type;
        const proceed = await confirmModal(
          `An diesem Tag besteht bereits „${lbl(crossTier.type)}".\n`
          + `Beide bleiben erfasst – gezählt wird der Tag als „${lbl(winner)}" (höhere Priorität), `
          + `„${lbl(loser)}" wird an diesem Tag nicht gezählt.\n\nTrotzdem speichern?`,
          { title: 'Überschneidung', okLabel: 'Trotzdem speichern', danger: false });
        if (!proceed) return;
      }

      if (editId) {
        // Begruendung optional (eigene), Pflicht bei fremder — Backend erzwingt das
        const reason = await promptModal('Begründung für die Änderung (bei fremder Abwesenheit Pflicht):', { title: 'Begründung' });
        if (reason === null) return; // Abbrechen → Bearbeitung verwerfen
        await api('PUT', '/api/absences/' + editId, { date_from, date_to, comment, reason: reason.trim() });
      } else {
        const resp = await api('POST', '/api/absences', { type, date_from, date_to, comment, target_user_id });
        if (resp && resp.warning) toast(resp.warning, 'warning', 6000);
      }
      document.removeEventListener('keydown', absOnKey);
      absSchliessen();
      entwurfLoeschen(absEntwurf);
      toast(editId ? 'Abwesenheit aktualisiert' : 'Abwesenheit eingetragen', 'success');

      renderAbsences();
    } catch(e) { toast(e.message, 'error'); }
  });
}

let _inboxUserFilter = '';
let _allAbsenceUserFilter = '';
let _absTab = 'list';                         // Manager-Reiter: 'list' | 'vacation' | 'kalender'
let _vacOverviewYear = new Date().getFullYear();
let _vacOverviewSearch = '';
// Lazy-Render-Cache der Verlauf-Monate: Key "type|YYYY-MM" -> Array der Abwesenheiten.
// Die Karten eines Monats werden erst beim Aufklappen ins DOM gebaut (spart Knoten bei vielen Einträgen).
let _absHistory = {};
let _collapsedSections;
try { _collapsedSections = new Set(JSON.parse(localStorage.getItem('absenceCollapsed') || '[]')); } catch(e) { _collapsedSections = new Set(); }

async function renderAbsences() {
  const _tok = renderToken();
  const topicToMark = isManagerRole() ? 'absences' : 'absence_status';
  S.badges.absences = 0;
  refreshBadges();
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'absences');
  bindLayout();

  // S.users nachladen falls noch nicht vorhanden (z.B. direkter Seitenaufruf)
  if (isManagerRole() && (!S.users || S.users.length <= 1)) {
    try {
      const uData = await api('GET', '/api/users');
      if (uData) S.users = uData.users;
    } catch(e) {}
  }

  let absences = [];
  try {
    const data = await api('GET', '/api/absences');
    markSeen(topicToMark);
    if (data) absences = data.absences;
  } catch(e) {}

  // Eigener Posteingang: alle Einträge die eine Aktion des aktuellen Users erfordern
  const myAckItems = absences.filter(a => {
    if (a.user_id !== S.user?.id) return false;
    // Manager hat bestehende Abwesenheit bearbeitet → Quittieren/Akzeptieren nötig
    if (a.ma_needs_ack) return true;
    // Manager hat pending Urlaub/FZA/Sonderurlaub für diesen User eingetragen → Akzeptieren/Ablehnen nötig
    if (!isManagerRole() && a.created_by && a.created_by !== a.user_id
        && APPROVAL_REQUIRED_TYPES.includes(a.type) && a.status === 'pending') return true;
    return false;
  });
  const myAckItemIds = new Set(myAckItems.map(a => a.id));

  const mainEl = document.querySelector('.main');
  if (!mainEl || renderStale(_tok)) return;   // inzwischen andere Seite offen

  const thisYear = new Date().getFullYear().toString();
  let urlaubTageJahr = 0, myVac = null, anyVacCfg = false;
  try {
    const sd = await api('GET', `/api/absences/summary?from=${thisYear}-01-01&to=${thisYear}-12-31`);
    if (sd) { urlaubTageJahr = sd.urlaubTageJahr || 0; myVac = sd.vacation || null; anyVacCfg = !!sd.anyVacationConfigured; }
  } catch(e) {}

  // Mein Posteingang (für alle Rollen): Manager-Änderungen die quittiert werden müssen
  let maInboxHtml = '';
  if (myAckItems.length > 0) {
    maInboxHtml = `
      <div class="absence-inbox absence-inbox--user">
        <div class="absence-inbox-header">
          <h3>📬 Mein Posteingang (${myAckItems.length})</h3>
        </div>
        ${myAckItems.map(a => renderAbsenceCard(a)).join('')}
      </div>`;
  }

  // Posteingang für Manager: neue Meldungen von Mitarbeitern
  let inboxHtml = '';
  if (isManagerRole()) {
    const pending = absences.filter(a =>
      a.status === 'pending' ||
      (a.status === 'active' && ['krank','berufsschule','innung'].includes(a.type) && !a.notified_at)
    );
    if (pending.length > 0) {
      // Eindeutige User aus dem Posteingang für Filter
      const inboxUsers = [];
      const seenUids = new Set();
      for (const a of pending) {
        if (a.user_id && !seenUids.has(a.user_id)) {
          seenUids.add(a.user_id);
          inboxUsers.push({ id: a.user_id, name: a.user_name || `#${a.user_id}` });
        }
      }
      inboxUsers.sort((a, b) => a.name.localeCompare(b.name));

      const filteredPending = _inboxUserFilter
        ? pending.filter(a => String(a.user_id) === String(_inboxUserFilter))
        : pending;

      inboxHtml = `
        <div class="absence-inbox">
          <div class="absence-inbox-header">
            <h3>📬 Posteingang (${pending.length})</h3>
            ${inboxUsers.length > 1 ? `
              <select class="absence-inbox-filter" id="inbox-user-filter">
                <option value="">Alle Mitarbeiter</option>
                ${inboxUsers.map(u => `<option value="${u.id}" ${_inboxUserFilter == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
              </select>` : ''}
          </div>
          ${filteredPending.length > 0
            ? filteredPending.map(a => renderAbsenceCard(a)).join('')
            : '<p class="absence-empty">Keine Einträge für diesen Mitarbeiter.</p>'}
        </div>`;
    }
  }

  // Cutoff: ein Eintrag bleibt "recent" solange das Ende (date_to) noch weniger als 7 Tage
  // in der Vergangenheit liegt. Pending-Anträge bleiben immer sichtbar.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoff = cutoffDate.toISOString().substring(0, 10);


  const monthNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

  // Alle Abwesenheiten nach User filtern (nur für Manager)
  // Für Nicht-Manager: Posteingang-Items aus der Hauptliste ausblenden (kein Duplikat)
  const listAbsences = (() => {
    const base = (isManagerRole() && _allAbsenceUserFilter)
      ? absences.filter(a => String(a.user_id) === String(_allAbsenceUserFilter))
      : absences;
    return isManagerRole() ? base : base.filter(a => !myAckItemIds.has(a.id));
  })();

  // Gefilterte Abwesenheiten neu gruppieren
  const filteredGrouped = {};
  for (const a of listAbsences) {
    if (!filteredGrouped[a.type]) filteredGrouped[a.type] = { recent: [], history: {} };
    if (a.status === 'pending' || a.date_to >= cutoff) {
      filteredGrouped[a.type].recent.push(a);
    } else {
      const mk = a.date_from.substring(0, 7);
      if (!filteredGrouped[a.type].history[mk]) filteredGrouped[a.type].history[mk] = [];
      filteredGrouped[a.type].history[mk].push(a);
    }
  }

  // User-Filter Dropdown für "Alle Abwesenheiten" (Manager)
  let allUsersForFilter = [];
  if (isManagerRole()) {
    const seenIds = new Set();
    for (const a of absences) {
      if (a.user_id && !seenIds.has(a.user_id)) {
        seenIds.add(a.user_id);
        allUsersForFilter.push({ id: a.user_id, name: a.user_name || `#${a.user_id}` });
      }
    }
    allUsersForFilter.sort((a, b) => a.name.localeCompare(b.name));
  }

  _absHistory = {}; // Lazy-Render-Cache pro Render neu aufbauen
  const listHtml = Object.entries(ABSENCE_TYPES).map(([type, info]) => {
    const g = filteredGrouped[type] || { recent: [], history: {} };
    const allEntries = [...g.recent, ...Object.values(g.history).flat()];
    const totalCount = allEntries.length;
    if (totalCount === 0 && !isManagerRole()) return '';

    const cGood = allEntries.filter(a => a.status === 'approved' || a.status === 'active').length;
    const cPending = allEntries.filter(a => a.status === 'pending').length;
    const cRejected = allEntries.filter(a => a.status === 'rejected').length;

    const recentHtml = g.recent.length > 0
      ? g.recent.map(a => renderAbsenceCard(a)).join('')
      : (Object.keys(g.history).length === 0 ? '<p class="absence-empty">Keine Einträge</p>' : '');

    const historyKeys = Object.keys(g.history).sort().reverse(); // YYYY-MM, neueste zuerst
    const historyCount = Object.values(g.history).reduce((s, v) => s + v.length, 0);
    // Monate nach Jahr buendeln: Verlauf -> Jahr -> Monat -> Karten (jede Ebene eigenes <details>)
    const byYear = {};
    for (const mk of historyKeys) {
      const y = mk.substring(0, 4);
      (byYear[y] || (byYear[y] = [])).push(mk);
    }
    const yearKeys = Object.keys(byYear).sort().reverse();
    const historyHtml = historyKeys.length > 0 ? `
      <details class="absence-history">
        <summary class="absence-history-summary">Verlauf (${historyCount})</summary>
        <div class="absence-history-body">
          ${yearKeys.map(y => {
            const yearCount = byYear[y].reduce((s, mk) => s + g.history[mk].length, 0);
            return `
            <details class="absence-history-year">
              <summary class="absence-history-year-summary">${y} (${yearCount})</summary>
              <div class="absence-history-year-body">
                ${byYear[y].map(mk => {
                  // Karten NICHT sofort rendern — Daten merken, Body bleibt leer bis zum Aufklappen
                  _absHistory[`${type}|${mk}`] = g.history[mk];
                  return `
                  <details class="absence-history-month" data-abs-key="${type}|${mk}">
                    <summary class="absence-history-month-summary">${monthNames[parseInt(mk.substring(5, 7), 10) - 1]} (${g.history[mk].length})</summary>
                    <div class="absence-history-month-body"></div>
                  </details>`;
                }).join('')}
              </div>
            </details>`;
          }).join('')}
        </div>
      </details>` : '';

    const collapsed = _collapsedSections.has(type);
    return `<div class="absence-section" data-section-type="${type}">
      <div class="absence-section-header absence-section-toggle" data-section-type="${type}">
        <span class="absence-section-chevron">${collapsed ? '▶' : '▼'}</span>
        <span>${info.icon} ${info.label}</span>
        ${totalCount > 0 ? `<span class="absence-section-count">${totalCount}</span>` : ''}
        ${cGood > 0 ? `<span class="absence-count-badge absence-count-good">✓ ${cGood}</span>` : ''}
        ${cPending > 0 ? `<span class="absence-count-badge absence-count-pending">${cPending} offen</span>` : ''}
        ${cRejected > 0 ? `<span class="absence-count-badge absence-count-rejected">✕ ${cRejected}</span>` : ''}
        ${(type === 'feiertag' && !isChefOrAdmin()) ? '' : `<button class="btn btn-sm btn-outline absence-new" data-type="${type}">+ Eintragen</button>`}
      </div>
      <div class="absence-section-body${collapsed ? ' collapsed' : ''}">
        ${recentHtml}
        ${historyHtml}
      </div>
    </div>`;
  }).join('');

  const isMgr = isManagerRole();
  // Der KALENDER braucht keine Voraussetzung — er zeigt, wer wann fehlt, und das gilt immer.
  // Die URLAUBSÜBERSICHT dagegen erst, wenn irgendwo ein Anspruch hinterlegt ist: ohne Anspruch
  // stuende dort ueberall 0, und die Ansicht bliebe wie vor ihrer Einfuehrung.
  const showTabs = isMgr;
  const showVac = isMgr && anyVacCfg && _absTab === 'vacation';
  const showCal = isMgr && _absTab === 'kalender';
  const tabBar = showTabs ? `
      <div class="absence-tabs">
        <button class="absence-tab ${_absTab === 'list' ? 'active' : ''}" data-tab="list">Liste</button>
        ${anyVacCfg ? `<button class="absence-tab ${_absTab === 'vacation' ? 'active' : ''}" data-tab="vacation">Urlaubsübersicht</button>` : ''}
        <button class="absence-tab ${_absTab === 'kalender' ? 'active' : ''}" data-tab="kalender">Kalender</button>
      </div>` : '';
  mainEl.innerHTML = `
    <div class="card" style="max-width:${(showVac || showCal) ? '1200px' : '900px'};margin:0 auto">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <h2>&#128197; Abwesenheit</h2>
        ${!isMgr ? `<span class="absence-counter">Urlaub ${thisYear}: ${(myVac && myVac.configured)
          ? `<strong>${myVac.genommen}</strong> genommen · <strong>${myVac.geplant}</strong> geplant · <strong>${myVac.nochZuPlanen}</strong> verbleibend <span class="absence-counter-of">(von ${myVac.verfuegbar})</span>`
          : `<strong>${urlaubTageJahr} Arbeitstage</strong>`}</span>` : ''}
        ${(showVac || showCal) ? '' : '<button class="btn btn-primary" id="absence-new-btn">+ Eintragen</button>'}
      </div>
      ${tabBar}
      ${showCal ? '<div id="abscal-wrap"></div>' : showVac ? '<div id="vac-overview-wrap"><div class="loading"><div class="spinner"></div></div></div>' : `
      ${maInboxHtml}
      ${inboxHtml}
      <div class="absence-all-header">
        <span>Alle Abwesenheiten</span>
        ${allUsersForFilter.length > 1 ? `
          <select class="absence-inbox-filter" id="all-absence-user-filter">
            <option value="">Alle Mitarbeiter</option>
            ${allUsersForFilter.map(u => `<option value="${u.id}" ${_allAbsenceUserFilter == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select>` : ''}
      </div>
      ${listHtml || '<p class="absence-empty">Keine Abwesenheiten eingetragen.</p>'}`}
    </div>`;

  mainEl.querySelectorAll('.absence-tab').forEach(btn => {
    btn.addEventListener('click', () => { _absTab = btn.dataset.tab; renderAbsences(); });
  });
  if (showVac) renderVacationOverview();
  // Der Kalender rechnet aus den bereits geladenen Daten — keine weitere Anfrage.
  if (showCal) {
    Abwesenheitskalender.zeichnen(document.getElementById('abscal-wrap'), absences, S.users || [], {
      // Antippen fuehrt in die Liste, genau zu diesem Eintrag — wie ein Termin auf der
      // Willkommensseite in die Tagesansicht der Planung fuehrt.
      beiKlick: (a) => { _absTab = 'list'; S._abwesenheitZiel = a.id; renderAbsences(); },
    });
  }


  mainEl.querySelectorAll('.absence-new').forEach(btn => {
    btn.addEventListener('click', () => showAbsenceForm(null, btn.dataset.type, null, null, null));
  });
  document.getElementById('absence-new-btn')?.addEventListener('click', () => showAbsenceForm(null, 'krank', null, null, null));
  document.getElementById('inbox-user-filter')?.addEventListener('change', (e) => {
    _inboxUserFilter = e.target.value;
    renderAbsences();
  });
  document.getElementById('all-absence-user-filter')?.addEventListener('change', (e) => {
    _allAbsenceUserFilter = e.target.value;
    renderAbsences();
  });

  // Sektionen auf-/zuklappen
  mainEl.querySelectorAll('.absence-section-toggle').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.absence-new')) return;
      const type = header.dataset.sectionType;
      const section = mainEl.querySelector(`.absence-section[data-section-type="${type}"]`);
      const body = section?.querySelector('.absence-section-body');
      const chevron = header.querySelector('.absence-section-chevron');
      if (!body) return;
      const isNowCollapsed = !_collapsedSections.has(type);
      if (isNowCollapsed) { _collapsedSections.add(type); } else { _collapsedSections.delete(type); }
      body.classList.toggle('collapsed', isNowCollapsed);
      if (chevron) chevron.textContent = isNowCollapsed ? '▶' : '▼';
      try { localStorage.setItem('absenceCollapsed', JSON.stringify([..._collapsedSections])); } catch(e) {}
    });
  });

  bindAbsenceCardActions(mainEl);

  // MUSS nach bindAbsenceCardActions stehen: Der Sprung klappt ggf. einen Monat im Verlauf
  // auf, und dessen Karten entstehen erst durch den `toggle`-Zeichner, der dort angemeldet
  // wird. Stand der Sprung davor, feuerte `open = true` ins Leere und die Karte fehlte.
  // Von dort gekommen? Den Eintrag aufdecken, hinscrollen und kurz hervorheben.
  //
  // „Aufdecken" ist hier die eigentliche Arbeit: Die Liste ist bis zu vier Ebenen tief zugeklappt
  // (Typ-Abschnitt -> Verlauf -> Jahr -> Monat). Ohne das Oeffnen aller Huellen scrollte man zu
  // etwas Unsichtbarem und stuende scheinbar vor einer leeren Seite.
  if (S._abwesenheitZiel != null && !showVac && !showCal) {
    const zielId = S._abwesenheitZiel;
    S._abwesenheitZiel = null;
    // Ein AELTERER Eintrag steht noch gar nicht im Dokument: Die Monate im Verlauf werden erst
    // beim Aufklappen gezeichnet (`_absHistory` haelt die Daten, `toggle` baut die Karten). Wer
    // im Kalender auf einen Urlaub vom Juni tippt, faende hier sonst nichts — und der Sprung
    // taete stillschweigend gar nichts. Also zuerst den richtigen Monat oeffnen.
    for (const [schluessel, eintraege] of Object.entries(_absHistory)) {
      if (!eintraege.some(x => x.id === zielId)) continue;
      const monat = mainEl.querySelector(`details.absence-history-month[data-abs-key="${schluessel}"]`);
      if (!monat) continue;
      for (let el = monat; el && el !== mainEl; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
      }
      verlaufMonatZeichnen(monat);   // direkt, nicht ueber `toggle` — das feuert erst spaeter
      break;
    }

    // ALLE Kopien, nicht nur die erste: Ein Eintrag, der noch eine Aktion braucht, steht
    // zusaetzlich im Posteingang ganz oben. Nur die erste zu nehmen hiesse, die Karte in der
    // Liste bliebe zugeklappt und unmarkiert — man findet sie beim Weiterlesen nicht wieder.
    const karten = [...mainEl.querySelectorAll(`.absence-card[data-id="${zielId}"]`)];
    for (const karte of karten) {
      for (let el = karte.parentElement; el && el !== mainEl; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
        if (el.classList.contains('absence-section-body') && el.classList.contains('collapsed')) {
          el.classList.remove('collapsed');
          const kopf = el.previousElementSibling;
          const pfeil = kopf && kopf.querySelector('.absence-section-chevron');
          if (pfeil) pfeil.textContent = '▼';
          const typ = kopf && kopf.dataset ? kopf.dataset.sectionType : null;
          if (typ) { _collapsedSections.delete(typ); localStorage.setItem('absenceCollapsed', JSON.stringify([..._collapsedSections])); }
        }
      }
      karte.classList.add('absence-card--hervor');
      setTimeout(() => karte.classList.remove('absence-card--hervor'), 2500);
    }
    if (karten.length) karten[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderAbsenceType(type) {
  if (!ABSENCE_TYPES[type]) { renderAbsences(); return; }
  showAbsenceForm(null, type, null, null, null);
  renderAbsences();
}

// Manager-Reiter „Urlaubsübersicht": Urlaubskonto je Mitarbeiter (Jahr-Auswahl, Suche, PDF/CSV).
async function renderVacationOverview() {
  const wrap = document.getElementById('vac-overview-wrap');
  if (!wrap) return;
  const cur = new Date().getFullYear();
  const years = [];
  for (let y = cur + 1; y >= cur - 3; y--) years.push(y);
  let data;
  try { data = await api('GET', `/api/absences/vacation-overview?year=${_vacOverviewYear}`); }
  catch (e) { wrap.innerHTML = '<p class="absence-empty">Konnte Urlaubsübersicht nicht laden.</p>'; return; }
  const rows = data.rows || [];
  const standDE = data.stand ? data.stand.split('-').reverse().join('.') : '';
  wrap.innerHTML = `
    <div class="vac-ov-controls">
      <select id="vac-ov-year" class="form-control form-control-sm">
        ${years.map(y => `<option value="${y}" ${y === _vacOverviewYear ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <input type="search" id="vac-ov-search" class="form-control form-control-sm" placeholder="Mitarbeiter suchen…" value="${esc(_vacOverviewSearch)}">
      <span class="vac-ov-stand">Stand: ${standDE}</span>
      <button class="btn btn-outline btn-sm" id="vac-ov-pdf">PDF herunterladen</button>
    </div>
    <div class="vac-ov-scroll">
      <table class="data-table vac-ov-table">
        <thead><tr>
          <th>Mitarbeiter</th><th>Anspruch</th><th>Übriger Vorjahr</th><th>Gesamt&shy;anspruch</th>
          <th>Genommen</th><th>Geplant &amp; akzeptiert</th><th>Noch zu planen</th>
          <th>Beantragt (offen)</th><th>Krank</th><th>FZA</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => { const cfg = r.configured; const d = '–'; return `<tr data-name="${esc(r.name.toLowerCase())}">
            <td class="vac-ov-name">${esc(r.name)}</td>
            <td>${cfg ? r.anspruch : d}</td><td>${cfg ? r.uebertrag : d}</td><td><strong>${cfg ? r.gesamtanspruch : d}</strong></td>
            <td>${r.genommen}</td><td>${r.geplant}</td>
            <td class="${cfg && r.nochZuPlanen < 0 ? 'vac-ov-neg' : ''}"><strong>${cfg ? r.nochZuPlanen : d}</strong></td>
            <td>${r.beantragt}</td><td>${r.krank}</td><td>${r.fza}</td>
          </tr>`; }).join('') : '<tr><td colspan="10" class="absence-empty">Keine Mitarbeiter.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  document.getElementById('vac-ov-year').addEventListener('change', e => { _vacOverviewYear = Number(e.target.value); _vacOverviewSearch = ''; renderVacationOverview(); });
  const searchEl = document.getElementById('vac-ov-search');
  const applyFilter = () => {
    const q = _vacOverviewSearch.toLowerCase();
    wrap.querySelectorAll('tbody tr[data-name]').forEach(tr => {
      tr.style.display = (!q || tr.dataset.name.includes(q)) ? '' : 'none';
    });
  };
  searchEl.addEventListener('input', e => { _vacOverviewSearch = e.target.value; applyFilter(); });
  applyFilter();
  document.getElementById('vac-ov-pdf').addEventListener('click', () => exportVacationOverviewPdf(_vacOverviewYear));
}

// Echtes Server-PDF der Urlaubsübersicht herunterladen (fetch mit Token → Blob, wie exportProjectCsv).
async function exportVacationOverviewPdf(year) {
  try {
    const res = await fetch(`/api/absences/vacation-overview.pdf?year=${year}`, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) { toast('PDF-Export fehlgeschlagen', 'error'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || `Urlaubsuebersicht_${year}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('PDF-Export fehlgeschlagen', 'error'); }
}

// --- Init ---
async function releaseCurrentLock() {
  if (_editingNoteLockId) {
    try { await api('POST', '/api/notes/' + _editingNoteLockId + '/unlock'); } catch(e) {}
    _editingNoteLockId = null;
  }
}
// Planungs-Kontextmenü global schließen (einmalig registriert)
document.addEventListener('click', () => {
  document.querySelectorAll('.plan-action-menu').forEach(m => m.remove());
});
// Doppel-Submit-Schutz fürs Auge (Ebene 2, app-weit): beim Absenden eines Formulars den Speichern-Button
// ausgrauen, damit man nicht 5× klickt (die Korrektheit garantiert ohnehin api() über Request-Coalescing).
// Bubble-Phase + „:not([disabled])": läuft NACH dem eigenen Submit-Handler des Formulars, sodass ein bereits
// vorhandener Schutz (z. B. B3 im Mitarbeiter-Formular) nicht doppelt/aushebelnd wirkt.
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form || typeof form.querySelector !== 'function') return;
  const btn = form.querySelector('button[type="submit"]:not([disabled])');
  if (!btn) return;
  btn.disabled = true;
  const reenable = () => { btn.disabled = false; };
  const t = setTimeout(reenable, 1500); // Failsafe – deckt den Klick-Sturm ab; danach wieder bedienbar
  form.addEventListener('input', () => { clearTimeout(t); reenable(); }, { once: true }); // Validierungsfehler → sofort frei
});
window.addEventListener('hashchange', () => {
  releaseCurrentLock();
  // Echter Seitenwechsel: gemerkte Ansicht der alten Seite verwerfen, damit die neue oben startet.
  viewStateReset();
  render();
});
window.addEventListener('beforeunload', () => {
  if (_editingNoteLockId && S.token) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/notes/' + _editingNoteLockId + '/unlock', false);
    xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    try { xhr.send('{}'); } catch(e) {}
    _editingNoteLockId = null;
  }
});
window.addEventListener('DOMContentLoaded', () => {
  initViewStateKeeper();   // Scrollposition + aufgeklappte Bereiche über Neuaufbauten hinweg erhalten
  if (!S.token) navigate('/login');
  render();
  loadLegalFlags(); // öffentlich; blendet Impressum/Datenschutz-Links ein (auch ausgeloggt)
  // avatarStandLaden() zuerst und mit await: Ohne die Frischemarken wuesste avatarHtml() nicht,
  // wer ueberhaupt ein Bild hat, und es blieben ueberall Initialen stehen.
  if (S.token) { avatarStandLaden().then(() => avatareLaden(document)); initSSE(); loadBadges(); syncPushSubscription(); refreshUser(); }
});
// Beim Zurückkehren zum Tab Rechte/Rolle auffrischen (greift ohne F5, sobald der Tab wieder sichtbar ist)
// — und die Zähler gleich mit. Am Handy trennt das Betriebssystem den SSE-Kanal, sobald der Bildschirm
// ausgeht; alles, was in dieser Zeit passiert, kommt nie an. Ohne dieses Nachziehen zeigte der Coin
// noch eine offene Bestellung, die längst erledigt war.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.token) { refreshUser(); loadBadges(); }
});
