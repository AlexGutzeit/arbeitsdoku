// Produktverzeichnis pflegen — Produkte, Kategorien, Großhändler (Alex, 08./09.09.2026).
//
// Erreichbar nur mit dem Recht „Lagerdaten pflegen" (produktrecht.js auf dem Server,
// darfProduktePflegen() hier). Der Menüpunkt erscheint auch nur dann.
//
// Zwei Dinge sind hier bewusst so und nicht anders:
//
//  1. KEINE inline-Handler. Die Seite läuft unter `script-src 'self'` — ein `onclick="…"` im
//     HTML wird stillschweigend nicht ausgeführt. Alles hängt an Sammel-Handlern.
//
//  2. Der Link eines Händlers wird als TEXT gesetzt und mit `rel="noopener noreferrer"`
//     geöffnet. Ohne das kann die Zielseite über `window.opener` die App-Seite im Hintergrund
//     auf eine nachgebaute Anmeldemaske umleiten. Die Domain steht sichtbar daneben, damit man
//     vor dem Klick sieht, wohin es geht.

function pDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

/** Ein Knopf, der eine hinterlegte Adresse öffnet — samt sichtbarer Domain. */
function pLinkHtml(url, beschriftung) {
  if (!url) return '';
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"
             class="btn btn-sm btn-outline" style="text-decoration:none">${beschriftung}</a>
          <span style="font-size:.78rem;color:var(--text-light);margin-left:.4rem">${esc(pDomain(url))}</span>`;
}

async function renderProdukte(fokusId) {
  $app().innerHTML = layout('<div class="loading">Laden…</div>', 'produkte');
  bindLayout();
  const main = document.querySelector('.main');

  if (!darfProduktePflegen()) {
    main.innerHTML = `<div class="card" style="max-width:640px;margin:0 auto">
      <h2>Produktverzeichnis</h2>
      <p>Zum Pflegen des Verzeichnisses fehlt dir das Recht „Lagerdaten pflegen“.
         Chef oder Admin können es unter <em>Mitarbeiter → Bearbeiten</em> vergeben.</p>
      <p style="color:var(--text-light)">Neue Produkte <strong>anlegen</strong> darfst du auch ohne
         dieses Recht — beim Scannen eines unbekannten Barcodes in den Bestellungen.</p>
    </div>`;
    return;
  }

  let v, hl;
  try {
    const [a, b] = await Promise.all([
      api('GET', '/api/products/verzeichnis'),
      api('GET', '/api/suppliers'),
    ]);
    if (!a || !b) return;
    v = a; hl = b.haendler;
  } catch (e) { toast(e.message, 'error'); return; }

  S.verzeichnis = v;
  S.haendlerListe = hl;

  main.innerHTML = `
    <div class="card" style="max-width:1000px;margin:0 auto">
      <h2>Produktverzeichnis</h2>
      <div class="pv-tabs" id="pv-tabs" role="tablist">
        <button class="pv-tab-btn active" data-tab="produkte" role="tab">Produkte (${v.produkte.length})</button>
        <button class="pv-tab-btn" data-tab="haendler" role="tab">Großhändler (${hl.length})</button>
        <button class="pv-tab-btn" data-tab="papierkorb" role="tab">Gelöscht (${v.geloescht.length})</button>
      </div>
      <div id="pv-produkte" class="pv-tab">${pvProdukteHtml(v)}</div>
      <div id="pv-haendler" class="pv-tab" style="display:none">${pvHaendlerHtml(hl)}</div>
      <div id="pv-papierkorb" class="pv-tab" style="display:none">${pvPapierkorbHtml(v)}</div>
    </div>`;

  pvBinden();
  if (fokusId) pvProduktOeffnen(Number(fokusId));
}

// ── Produkte ────────────────────────────────────────────────────────────────────────────────
function pvProdukteHtml(v) {
  const dub = v.dubletten.length ? `
    <div class="hinweis-box" style="margin:.8rem 0">
      <strong>${v.dubletten.length} mögliche Doppel-Eintragung(en)</strong> — gleiche Namen bis auf
      Schreibweise, Leerzeichen oder Bindestrich:
      ${v.dubletten.map(g => `<div style="margin-top:.4rem">
        ${g.map(p => `<code>${esc(p.name)}</code>`).join(' &nbsp;=&nbsp; ')}
        <button class="btn btn-sm btn-outline pv-dub-btn" data-ids="${g.map(p => p.id).join(',')}"
                style="margin-left:.5rem">Zusammenführen…</button>
      </div>`).join('')}
    </div>` : '';

  return dub + `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.8rem 0">
      <input type="search" id="pv-suche" class="form-control" style="flex:1;min-width:200px"
             placeholder="Produkt, Barcode oder Kategorie suchen …">
      <select id="pv-kat-filter" class="form-control" style="max-width:220px">
        <option value="">Alle Kategorien</option>
        ${v.kategorien.map(k => `<option value="${k.id}">${esc(k.name)} (${k.anzahl})</option>`).join('')}
        <option value="ohne">— ohne Kategorie —</option>
      </select>
    </div>
    <div id="pv-liste">${v.produkte.map(pvProduktZeile).join('') || '<p style="color:var(--text-lighter);text-align:center">Noch keine Produkte im Verzeichnis. Sie entstehen beim Scannen eines unbekannten Barcodes.</p>'}</div>
    <details style="margin-top:1.4rem">
      <summary style="cursor:pointer;font-weight:600">Kategorien verwalten (${v.kategorien.length})</summary>
      <div id="pv-kats" style="margin-top:.6rem">${pvKategorienHtml(v.kategorien)}</div>
    </details>`;
}

function pvProduktZeile(p) {
  const such = [p.name, p.kategorie_name, ...(p.barcodes || [])].filter(Boolean).join(' ');
  return `<details class="pv-produkt" data-id="${p.id}" data-kat="${p.category_id || 'ohne'}"
                   data-suchtext="${esc(such.toLowerCase())}">
    <summary>
      <strong>${esc(p.name)}</strong>
      <span style="color:var(--text-light);font-size:.82rem;margin-left:.5rem">
        ${p.kategorie_name ? esc(p.kategorie_name) : '<em>ohne Kategorie</em>'}
        · ${p.barcodes.length
             ? p.barcodes.length + ' Barcode' + (p.barcodes.length === 1 ? '' : 's')
             : '<span class="pv-ohne-code">ohne Barcode — nur über die Suche</span>'}
        ${p.bestellungen ? ` · ${p.bestellungen} Bestellung${p.bestellungen === 1 ? '' : 'en'}` : ''}
      </span>
    </summary>
    <div class="pv-detail" data-geladen="0"><div class="loading">Laden…</div></div>
  </details>`;
}

/** Der Inhalt einer aufgeklappten Produktzeile — erst beim Öffnen geholt. */
function pvDetailHtml(p, haendlerEintraege) {
  const kats = S.verzeichnis.kategorien;
  return `
    <div class="form-group" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end">
      <label style="flex:2;min-width:180px">Name
        <input type="text" class="form-control pv-f-name" value="${esc(p.name)}"></label>
      <label style="flex:1;min-width:150px">Kategorie
        <select class="form-control pv-f-kat">
          <option value="">— ohne —</option>
          ${kats.map(k => `<option value="${k.id}"${k.id === p.category_id ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}
        </select></label>
      <label style="flex:0 0 110px">Einheit
        <input type="text" class="form-control pv-f-einheit" value="${esc(p.default_unit || '')}" placeholder="Stk"></label>
      <button class="btn btn-primary btn-sm pv-speichern">Speichern</button>
    </div>

    <div style="margin-top:.8rem">
      <strong style="font-size:.9rem">Barcodes</strong>
      <div class="pv-codes">${p.barcodes.map(c => `
        <span class="pv-code">${esc(c)}
          <button class="pv-code-weg" data-code="${esc(c)}" title="Entfernen"
                  aria-label="Barcode ${esc(c)} entfernen">&times;</button></span>`).join('')}
      </div>
      <div style="display:flex;gap:.4rem;margin-top:.4rem">
        <input type="text" class="form-control form-control-sm pv-code-neu" placeholder="Weiteren Barcode eintippen…" style="max-width:260px">
        <button class="btn btn-sm pv-code-add">Anlernen</button>
      </div>
    </div>

    <div style="margin-top:1rem">
      <strong style="font-size:.9rem">Großhändler</strong>
      <div class="pv-haendler-eintraege">${pvEintraegeHtml(haendlerEintraege)}</div>
      ${S.haendlerListe.length ? `
      <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap">
        <select class="form-control form-control-sm pv-h-neu" style="max-width:220px">
          <option value="">Großhändler hinzufügen…</option>
          ${S.haendlerListe.filter(h => !haendlerEintraege.some(e => e.supplier_id === h.id))
            .map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join('')}
        </select>
      </div>` : `<p style="color:var(--text-light);font-size:.85rem;margin:.4rem 0 0">
          Noch kein Großhändler angelegt — das geht im Reiter „Großhändler“.</p>`}
    </div>

    <div style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-sm btn-outline pv-merge">Mit anderem Produkt zusammenführen…</button>
      <button class="btn btn-sm btn-danger pv-loeschen">Produkt löschen</button>
    </div>`;
}

function pvEintraegeHtml(eintraege) {
  if (!eintraege.length) return '<p style="color:var(--text-lighter);font-size:.85rem;margin:.3rem 0">Nichts hinterlegt.</p>';
  return eintraege.map(e => `
    <div class="pv-h-eintrag" data-sid="${e.supplier_id}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem">
        <strong>${esc(e.name)}</strong>
        <button class="btn btn-sm btn-danger pv-h-weg" title="Angaben entfernen"
                aria-label="Angaben zu ${esc(e.name)} entfernen">&times;</button>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem">
        <label style="flex:1;min-width:150px;font-size:.82rem">Bestellnummer
          <input type="text" class="form-control form-control-sm pv-h-nr" value="${esc(e.bestellnummer || '')}"></label>
        <label style="flex:2;min-width:200px;font-size:.82rem">Link
          <input type="text" class="form-control form-control-sm pv-h-link" value="${esc(e.link || '')}"
                 placeholder="shop.example.de/artikel/123"></label>
      </div>
      <label style="font-size:.82rem;display:block;margin-top:.3rem">Kommentar
        <textarea class="form-control form-control-sm pv-h-kom" rows="2">${esc(e.kommentar || '')}</textarea></label>
      <div style="margin-top:.3rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm btn-primary pv-h-speichern">Speichern</button>
        ${pvLinkKnopf(e)}
      </div>
    </div>`).join('');
}

function pvLinkKnopf(e) {
  const teile = [];
  if (e.link) teile.push(pLinkHtml(e.link, 'Artikel öffnen'));
  else if (e.homepage) teile.push(pLinkHtml(e.homepage, 'Händler öffnen'));
  if (e.kundennummer) teile.push(`<span style="font-size:.78rem;color:var(--text-light)">Kd.-Nr. ${esc(e.kundennummer)}</span>`);
  return teile.join(' ');
}

function pvKategorienHtml(kats) {
  if (!kats.length) return '<p style="color:var(--text-lighter)">Noch keine Kategorien.</p>';
  return kats.map(k => `
    <div class="pv-kat" data-id="${k.id}" style="display:flex;gap:.4rem;align-items:center;margin-bottom:.4rem;flex-wrap:wrap">
      <input type="text" class="form-control form-control-sm pv-k-name" value="${esc(k.name)}" style="max-width:220px">
      <span style="font-size:.8rem;color:var(--text-light)">${k.anzahl} Produkt(e)</span>
      <button class="btn btn-sm pv-k-speichern">Umbenennen</button>
      <select class="form-control form-control-sm pv-k-ziel" style="max-width:200px">
        <option value="">verschmelzen mit…</option>
        ${kats.filter(x => x.id !== k.id).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-danger pv-k-weg">Löschen</button>
    </div>`).join('');
}

// ── Großhändler ─────────────────────────────────────────────────────────────────────────────
function pvHaendlerHtml(hl) {
  return `
    <p style="color:var(--text-light);font-size:.88rem">
      Was ein <em>einzelnes Produkt</em> bei einem Händler kostet an Bestellnummer, Link und
      Kommentar, steht beim Produkt. Hier stehen die Angaben zum Händler selbst.</p>
    <div id="pv-h-liste">${hl.map(pvHaendlerKarte).join('') || '<p style="color:var(--text-lighter)">Noch kein Großhändler angelegt.</p>'}</div>
    <details style="margin-top:1rem"><summary style="cursor:pointer;font-weight:600">+ Großhändler anlegen</summary>
      <div style="margin-top:.6rem" id="pv-h-neu-form">${pvHaendlerFelder({})}
        <button class="btn btn-primary btn-sm pv-h-anlegen" style="margin-top:.5rem">Anlegen</button>
      </div>
    </details>`;
}

function pvHaendlerKarte(h) {
  return `<details class="pv-haendler" data-id="${h.id}">
    <summary><strong>${esc(h.name)}</strong>
      <span style="color:var(--text-light);font-size:.82rem;margin-left:.5rem">
        ${h.produkte} Produkt(e)${h.kundennummer ? ' · Kd.-Nr. ' + esc(h.kundennummer) : ''}</span>
    </summary>
    <div style="margin-top:.5rem">
      ${pvHaendlerFelder(h)}
      <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm btn-primary pv-h-save">Speichern</button>
        <button class="btn btn-sm btn-danger pv-h-del">Löschen</button>
        ${h.homepage ? pLinkHtml(h.homepage, 'Webshop öffnen') : ''}
      </div>
      <!-- Die Gegenrichtung: von HIER aus Produkte anhängen. Wer eine Preisliste vor sich hat,
           trägt zwanzig Bestellnummern ein, ohne zwanzigmal ein Produkt aufzuklappen. -->
      <div class="pv-h-produkte" data-geladen="0" style="margin-top:1rem">
        <div class="loading">Laden…</div>
      </div>
    </div>
  </details>`;
}

/** Was dieser Händler führt — Liste, Suchfeld zum Anhängen, und der Weg zu einem neuen Produkt. */
function pvHaendlerProdukteHtml(hId, produkte) {
  return `
    <strong style="font-size:.9rem">Produkte bei diesem Händler (${produkte.length})</strong>
    <div class="pv-hp-liste">${produkte.length ? produkte.map(p => `
      <div class="pv-hp-zeile" data-pid="${p.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem">
          <strong>${esc(p.name)}</strong>
          <span>
            ${(p.barcodes && p.barcodes.length) ? '' : '<span class="pv-ohne-code">ohne Barcode</span>'}
            <button class="btn btn-sm btn-danger pv-hp-weg" title="Zuordnung entfernen"
                    aria-label="Zuordnung zu ${esc(p.name)} entfernen">&times;</button>
          </span>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.3rem">
          <label style="flex:1;min-width:140px;font-size:.82rem">Bestellnummer
            <input type="text" class="form-control form-control-sm pv-hp-nr" value="${esc(p.bestellnummer || '')}"></label>
          <label style="flex:2;min-width:180px;font-size:.82rem">Link
            <input type="text" class="form-control form-control-sm pv-hp-link" value="${esc(p.link || '')}"
                   placeholder="shop.example.de/artikel/123"></label>
        </div>
        <label style="display:block;font-size:.82rem;margin-top:.3rem">Kommentar
          <input type="text" class="form-control form-control-sm pv-hp-kommentar"
                 value="${esc(p.kommentar || '')}" placeholder="z. B. nur im 100er-Gebinde"></label>
        <div style="margin-top:.3rem"><button class="btn btn-sm btn-primary pv-hp-save">Speichern</button></div>
      </div>`).join('') : '<p style="color:var(--text-lighter);font-size:.85rem;margin:.3rem 0">Noch nichts zugeordnet.</p>'}
    </div>
    <div style="margin-top:.6rem">
      <label style="font-size:.82rem;display:block">Produkt suchen und anhängen
        <input type="search" class="form-control form-control-sm pv-hp-suche" data-hid="${hId}"
               placeholder="Name eintippen …" autocomplete="off"></label>
      <ul class="produkt-vorschlaege pv-hp-treffer" style="display:none;position:static;max-height:180px"></ul>
      <button class="btn btn-sm btn-outline pv-hp-neu" data-hid="${hId}" style="margin-top:.4rem">
        + Produkt anlegen, das es noch nicht gibt</button>
    </div>`;
}

function pvHaendlerFelder(h) {
  const f = (kl, label, wert, platz) => `<label style="flex:1;min-width:170px;font-size:.82rem">${label}
    <input type="text" class="form-control form-control-sm ${kl}" value="${esc(wert || '')}"
           ${platz ? `placeholder="${esc(platz)}"` : ''}></label>`;
  return `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      ${f('pv-hf-name', 'Name', h.name, 'Sonepar')}
      ${f('pv-hf-homepage', 'Homepage / Webshop', h.homepage, 'shop.example.de')}
      ${f('pv-hf-kundennummer', 'Kundennummer', h.kundennummer)}
    </div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem">
      ${f('pv-hf-ansprechpartner', 'Ansprechpartner', h.ansprechpartner)}
      ${f('pv-hf-telefon', 'Telefon', h.telefon)}
      ${f('pv-hf-email', 'E-Mail', h.email)}
    </div>
    <label style="font-size:.82rem;display:block;margin-top:.4rem">Notiz
      <textarea class="form-control form-control-sm pv-hf-notiz" rows="2">${esc(h.notiz || '')}</textarea></label>`;
}

function pvPapierkorbHtml(v) {
  const haendler = v.geloeschteHaendler || [];
  if (!v.geloescht.length && !haendler.length) return '<p style="color:var(--text-lighter)">Nichts gelöscht.</p>';
  return (haendler.length ? `<h3 style="font-size:.95rem;margin:.2rem 0 .4rem">Großhändler</h3>`
    + haendler.map(h => `
    <div style="display:flex;gap:.6rem;align-items:center;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border)">
      <div><strong>${esc(h.name)}</strong>
        <span style="font-size:.8rem;color:var(--text-light);margin-left:.4rem">
          gelöscht am ${esc(String(h.deleted_at).slice(0, 10))}${h.eintraege ? ` · ${h.eintraege} hinterlegte Bestellnummer(n) warten` : ''}</span>
      </div>
      <button class="btn btn-sm pv-h-wieder" data-id="${h.id}">Wiederherstellen</button>
    </div>`).join('')
    + (v.geloescht.length ? `<h3 style="font-size:.95rem;margin:1rem 0 .4rem">Produkte</h3>` : '') : '')
    + (v.geloescht.length ? v.geloescht.map(p => `
    <div style="display:flex;gap:.6rem;align-items:center;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border)">
      <div><strong>${esc(p.name)}</strong>
        <span style="font-size:.8rem;color:var(--text-light);margin-left:.4rem">
          ${p.merged_into ? 'aufgegangen in „' + esc(p.aufgegangen_in || '?') + '“' : 'gelöscht am ' + esc(String(p.deleted_at).slice(0, 10))}</span>
      </div>
      ${p.merged_into ? '' : `<button class="btn btn-sm pv-wieder" data-id="${p.id}">Wiederherstellen</button>`}
    </div>`).join('') : '');
}

/**
 * Ein Kollege hat das Verzeichnis geändert — sagen, nicht neu aufbauen.
 *
 * Diese Seite besteht fast nur aus Eingabefeldern: Produktname, Kategorie, Barcodes,
 * Bestellnummern, Kommentare. Ein Neuaufbau mitten in der Arbeit vernichtete alles Angefangene —
 * und zwar genau dann, wenn zwei Leute gleichzeitig aufräumen, also im Ernstfall.
 *
 * Deshalb nur ein Hinweisband mit einem Knopf. Wer nichts offen hat, drückt ihn sofort; wer
 * gerade tippt, tippt zu Ende.
 */
function produktverzeichnisHinweis() {
  const karte = document.querySelector('.main .card');
  if (!karte || document.getElementById('pv-frisch')) return;   // steht schon da
  const band = document.createElement('div');
  band.id = 'pv-frisch';
  band.className = 'hinweis-box';
  band.style.cssText = 'margin:.6rem 0;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap';
  band.innerHTML = '<span>Ein Kollege hat das Verzeichnis geändert.</span>'
    + '<button class="btn btn-sm btn-primary" id="pv-frisch-btn">Neu laden</button>';
  karte.insertBefore(band, karte.children[1] || null);
  document.getElementById('pv-frisch-btn').addEventListener('click', () => renderProdukte());
}

// ── Verdrahtung ─────────────────────────────────────────────────────────────────────────────
function pvBinden() {
  const karte = document.querySelector('.main .card');

  // Reiter
  karte.querySelectorAll('#pv-tabs .pv-tab-btn').forEach(b => b.addEventListener('click', () => {
    karte.querySelectorAll('#pv-tabs .pv-tab-btn').forEach(x => x.classList.toggle('active', x === b));
    for (const t of ['produkte', 'haendler', 'papierkorb'])
      document.getElementById('pv-' + t).style.display = (t === b.dataset.tab) ? '' : 'none';
  }));

  // Suche + Kategoriefilter: beide wirken auf dieselbe Liste, deshalb EINE Funktion.
  const filtern = () => {
    const q = (document.getElementById('pv-suche')?.value || '').trim().toLowerCase();
    const kat = document.getElementById('pv-kat-filter')?.value || '';
    document.querySelectorAll('#pv-liste .pv-produkt').forEach(el => {
      const passtText = !q || el.dataset.suchtext.includes(q);
      const passtKat = !kat || el.dataset.kat === kat;
      el.style.display = (passtText && passtKat) ? '' : 'none';
    });
  };
  document.getElementById('pv-suche')?.addEventListener('input', filtern);
  document.getElementById('pv-kat-filter')?.addEventListener('change', filtern);

  // Produktdetails erst beim Aufklappen holen — bei 300 Produkten wären 300 Abfragen im Voraus
  // sinnlos, und die Händler-Angaben ändern sich ohnehin selten.
  document.querySelectorAll('.pv-produkt').forEach(d => d.addEventListener('toggle', () => {
    if (d.open) pvDetailLaden(d);
  }));
  document.querySelectorAll('.pv-haendler').forEach(d => d.addEventListener('toggle', () => {
    if (d.open) pvHaendlerProdukteLaden(d);
  }));
  karte.addEventListener('input', pvSuchtippen);

  karte.addEventListener('click', pvKlick);
  karte.addEventListener('change', pvAenderung);
}

async function pvDetailLaden(details, erzwingen) {
  const ziel = details.querySelector('.pv-detail');
  if (!erzwingen && ziel.dataset.geladen === '1') return;
  const id = Number(details.dataset.id);
  const p = S.verzeichnis.produkte.find(x => x.id === id);
  if (!p) return;
  try {
    const r = await api('GET', `/api/products/${id}/haendler`);
    ziel.innerHTML = pvDetailHtml(p, (r && r.haendler) || []);
    ziel.dataset.geladen = '1';
  } catch (e) { ziel.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
}

async function pvHaendlerProdukteLaden(details, erzwingen) {
  const ziel = details.querySelector('.pv-h-produkte');
  if (!ziel || (!erzwingen && ziel.dataset.geladen === '1')) return;
  try {
    const r = await api('GET', `/api/suppliers/${details.dataset.id}/produkte`);
    ziel.innerHTML = pvHaendlerProdukteHtml(details.dataset.id, (r && r.produkte) || []);
    ziel.dataset.geladen = '1';
  } catch (e) { ziel.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
}

/**
 * Live-Suche im Händler-Bereich.
 *
 * Sie sucht in S.verzeichnis.produkte — die Liste liegt ohnehin schon da, also braucht es keine
 * Abfrage je Tastendruck. Schon zugeordnete Produkte fallen raus: Ein zweites Mal anhängen ginge
 * ohnehin nicht (ein Eintrag je Paar), und ein Treffer, der beim Klick nichts tut, ist ärgerlicher
 * als gar keiner.
 */
function pvSuchtippen(ev) {
  const feld = ev.target;
  if (!feld.classList || !feld.classList.contains('pv-hp-suche')) return;
  const liste = feld.parentElement.parentElement.querySelector('.pv-hp-treffer');
  const q = vergleichsform(feld.value);
  if (!q) { liste.style.display = 'none'; liste.innerHTML = ''; return; }
  const schon = [...feld.closest('.pv-h-produkte').querySelectorAll('.pv-hp-zeile')].map(z => Number(z.dataset.pid));
  const treffer = (S.verzeichnis.produkte || [])
    .filter(p => !schon.includes(p.id) && vergleichsform(p.name).includes(q)).slice(0, 8);
  if (!treffer.length) { liste.style.display = 'none'; liste.innerHTML = ''; return; }
  liste.innerHTML = treffer.map(p => `<li class="pv-hp-treffer-zeile" data-pid="${p.id}">
      ${esc(p.name)}${p.barcodes && p.barcodes.length ? '' : ' <span class="pv-ohne-code">ohne Barcode</span>'}
    </li>`).join('');
  liste.style.display = '';
}

function pvProduktOeffnen(id) {
  const d = document.querySelector(`.pv-produkt[data-id="${id}"]`);
  if (!d) { toast('Dieses Produkt steht nicht (mehr) im Verzeichnis.', 'error'); return; }
  d.open = true;
  pvDetailLaden(d);
  d.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function pvKlick(ev) {
  // Treffer der Händler-Suche sind <li>, kein <button> — die muessen VOR der Button-Pruefung
  // abgefangen werden, sonst passiert beim Klick nichts.
  const treffer = ev.target.closest('.pv-hp-treffer-zeile');
  if (treffer) {
    const karte = treffer.closest('.pv-haendler');
    try {
      await api('PUT', `/api/products/${treffer.dataset.pid}/haendler/${karte.dataset.id}`, {});
      toast('Angehängt — jetzt Bestellnummer eintragen.', 'success');
      await pvHaendlerProdukteLaden(karte, true);
    } catch (e) { toast(e.message, 'error'); }
    return;
  }
  const b = ev.target.closest('button');
  if (!b) return;
  const details = b.closest('.pv-produkt');
  const id = details ? Number(details.dataset.id) : null;
  const neu = () => renderProdukte(id);

  try {
    // ── Produkt ──
    if (b.classList.contains('pv-speichern')) {
      const rumpf = {
        name: details.querySelector('.pv-f-name').value.trim(),
        category_id: details.querySelector('.pv-f-kat').value || null,
        default_unit: details.querySelector('.pv-f-einheit').value.trim(),
      };
      try {
        await api('PUT', `/api/products/${id}`, rumpf);
      } catch (e) {
        // Der Server meldet ein vorhandenes Produkt gleichen Namens. Das ist eine WARNUNG:
        // Zwei ähnlich benannte Produkte dürfen verschieden sein.
        if (!/bereits/i.test(e.message)) throw e;
        if (!(await confirmModal(e.message + '\n\nTrotzdem so benennen?',
          { title: 'Name gibt es schon', okLabel: 'Trotzdem', danger: false }))) return;
        await api('PUT', `/api/products/${id}`, { ...rumpf, trotzdem: true });
      }
      toast('Gespeichert', 'success'); return neu();
    }

    if (b.classList.contains('pv-code-add')) {
      const feld = details.querySelector('.pv-code-neu');
      const code = feld.value.trim();
      if (!code) return;
      await api('POST', `/api/products/${id}/barcodes`, { code });
      toast('Barcode angelernt', 'success'); return neu();
    }
    if (b.classList.contains('pv-code-weg')) {
      const code = b.dataset.code;
      const codes = (S.verzeichnis.produkte.find(x => x.id === id) || {}).barcodes || [];
      const letzter = codes.length <= 1;
      if (!(await confirmModal(letzter
        ? `${code} ist der letzte Barcode. Ohne ihn lässt sich das Produkt nicht mehr scannen — `
          + 'über die Suche im Bestellformular bleibt es findbar.'
        : `Barcode ${code} von diesem Produkt entfernen?`,
        { title: 'Barcode entfernen', okLabel: 'Entfernen' }))) return;
      // Der Server fragt beim letzten Code selbst noch einmal nach (409). Weil der Benutzer die
      // Folge hier schon schwarz auf weiss bestaetigt hat, geht die Bestaetigung gleich mit.
      await api('DELETE', `/api/products/${id}/barcodes/${encodeURIComponent(code)}`
        + (letzter ? '?trotzdem=1' : ''));
      toast('Barcode entfernt', 'success'); return neu();
    }

    if (b.classList.contains('pv-loeschen')) {
      const p = S.verzeichnis.produkte.find(x => x.id === id);
      if (!(await confirmModal(
        `„${p.name}“ aus dem Verzeichnis löschen?\n\n`
        + 'Bereits geschriebene Bestellungen bleiben unverändert stehen. Wer den Barcode später '
        + 'scannt, bekommt einen Hinweis auf das gelöschte Produkt statt „unbekannt“ — '
        + 'zurückholen geht im Reiter „Gelöscht“.',
        { title: 'Produkt löschen', okLabel: 'Löschen' }))) return;
      await api('DELETE', `/api/products/${id}`);
      toast('Gelöscht', 'success'); return renderProdukte();
    }
    if (b.classList.contains('pv-wieder')) {
      await api('POST', `/api/products/${b.dataset.id}/wiederherstellen`);
      toast('Wiederhergestellt', 'success'); return renderProdukte();
    }
    if (b.classList.contains('pv-h-wieder')) {
      await api('POST', `/api/suppliers/${b.dataset.id}/wiederherstellen`);
      toast('Großhändler wiederhergestellt — die hinterlegten Bestellnummern sind wieder da.', 'success');
      return renderProdukte();
    }

    if (b.classList.contains('pv-merge')) return pvMergeDialog(id);
    if (b.classList.contains('pv-dub-btn')) {
      const ids = b.dataset.ids.split(',').map(Number);
      return pvMergeDialog(ids[0], ids[1]);
    }

    // ── Händler-Angaben AM PRODUKT ──
    if (b.classList.contains('pv-h-speichern')) {
      const zeile = b.closest('.pv-h-eintrag');
      await api('PUT', `/api/products/${id}/haendler/${zeile.dataset.sid}`, {
        bestellnummer: zeile.querySelector('.pv-h-nr').value.trim(),
        link: zeile.querySelector('.pv-h-link').value.trim(),
        kommentar: zeile.querySelector('.pv-h-kom').value.trim(),
      });
      toast('Gespeichert', 'success');
      return pvDetailLaden(details, true);
    }
    if (b.classList.contains('pv-h-weg')) {
      const zeile = b.closest('.pv-h-eintrag');
      if (!(await confirmModal('Die hinterlegten Angaben zu diesem Händler entfernen?',
        { title: 'Angaben entfernen', okLabel: 'Entfernen' }))) return;
      await api('DELETE', `/api/products/${id}/haendler/${zeile.dataset.sid}`);
      toast('Entfernt', 'success');
      return pvDetailLaden(details, true);
    }

    // ── Kategorien ──
    const kat = b.closest('.pv-kat');
    if (kat && b.classList.contains('pv-k-speichern')) {
      await api('PUT', `/api/products/kategorien/${kat.dataset.id}`, { name: kat.querySelector('.pv-k-name').value.trim() });
      toast('Umbenannt', 'success'); return renderProdukte();
    }
    if (kat && b.classList.contains('pv-k-weg')) {
      try {
        await api('DELETE', `/api/products/kategorien/${kat.dataset.id}`);
      } catch (e) {
        if (!/hängen noch/i.test(e.message)) throw e;
        if (!(await confirmModal(e.message + '\n\nDie Produkte bleiben dann ohne Kategorie.',
          { title: 'Kategorie löschen', okLabel: 'Trotzdem löschen' }))) return;
        await api('DELETE', `/api/products/kategorien/${kat.dataset.id}`, { loesen: true });
      }
      toast('Kategorie gelöscht', 'success'); return renderProdukte();
    }

    // ── Produkte AM HÄNDLER (die Gegenrichtung) ──
    const hKarte = b.closest('.pv-haendler');
    if (hKarte && b.classList.contains('pv-hp-save')) {
      const zeile = b.closest('.pv-hp-zeile');
      await api('PUT', `/api/products/${zeile.dataset.pid}/haendler/${hKarte.dataset.id}`, {
        bestellnummer: zeile.querySelector('.pv-hp-nr').value.trim(),
        link: zeile.querySelector('.pv-hp-link').value.trim(),
        kommentar: zeile.querySelector('.pv-hp-kommentar').value.trim(),
      });
      toast('Gespeichert', 'success');
      return pvHaendlerProdukteLaden(hKarte, true);
    }
    if (hKarte && b.classList.contains('pv-hp-weg')) {
      const zeile = b.closest('.pv-hp-zeile');
      if (!(await confirmModal('Die Zuordnung zu diesem Händler entfernen? Das Produkt selbst bleibt.',
        { title: 'Zuordnung entfernen', okLabel: 'Entfernen' }))) return;
      await api('DELETE', `/api/products/${zeile.dataset.pid}/haendler/${hKarte.dataset.id}`);
      toast('Entfernt', 'success');
      return pvHaendlerProdukteLaden(hKarte, true);
    }
    if (b.classList.contains('pv-hp-neu')) return pvNeuesProduktDialog(hKarte);

    // ── Händler-Stammdaten ──
    if (b.classList.contains('pv-h-anlegen')) {
      const box = document.getElementById('pv-h-neu-form');
      await api('POST', '/api/suppliers', pvHaendlerLesen(box));
      toast('Großhändler angelegt', 'success'); return renderProdukte();
    }
    const hk = b.closest('.pv-haendler');
    if (hk && b.classList.contains('pv-h-save')) {
      await api('PUT', `/api/suppliers/${hk.dataset.id}`, pvHaendlerLesen(hk));
      toast('Gespeichert', 'success'); return renderProdukte();
    }
    if (hk && b.classList.contains('pv-h-del')) {
      try {
        await api('DELETE', `/api/suppliers/${hk.dataset.id}`);
      } catch (e) {
        if (!/hängen/i.test(e.message)) throw e;
        if (!(await confirmModal(e.message, { title: 'Großhändler löschen', okLabel: 'Löschen' }))) return;
        await api('DELETE', `/api/suppliers/${hk.dataset.id}`, { trotzdem: true });
      }
      toast('Gelöscht', 'success'); return renderProdukte();
    }
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * Neues Produkt direkt am Händler anlegen — Barcode OPTIONAL.
 *
 * Alex (09.09.2026): „wenn kein Barcode verknüpft wird, kann man das Produkt zum Bestellen nicht
 * scannen, aber über die Suche finden." Genau das steht auch im Dialog, damit niemand hinterher
 * rätselt, warum das Scannen nichts findet.
 */
function pvNeuesProduktDialog(hKarte) {
  const kats = S.verzeichnis.kategorien;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header"><h3>Produkt anlegen</h3></div>
      <div class="modal-body">
        <p style="margin:0 0 .6rem;font-size:.88rem;color:var(--text-light)">
          Der Name steht künftig allen zur Auswahl. Schau kurz, ob es das Produkt schon gibt.</p>
        <label style="display:block;margin-bottom:.5rem">Produktname *
          <input type="text" class="form-control" id="pnp-name" autocomplete="off"></label>
        <label style="display:block;margin-bottom:.5rem">Kategorie
          <select class="form-control" id="pnp-kat">
            <option value="">— keine —</option>
            ${kats.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}
          </select></label>
        <label style="display:block;margin-bottom:.3rem">Barcode <em>(freiwillig)</em>
          <input type="text" class="form-control" id="pnp-code" autocomplete="off"
                 placeholder="leer lassen, wenn der Artikel keinen trägt"></label>
        <p class="hinweis-box" style="margin:.2rem 0 0;font-size:.85rem">
          <strong>Ohne Barcode lässt sich das Produkt nicht scannen</strong> — im Bestellformular
          ist es aber über die Suche zu finden. Nachträglich lässt sich jederzeit einer anlernen.</p>
        <p id="pnp-fehler" style="display:none;color:var(--danger);margin:.5rem 0 0"></p>
      </div>
      <div class="modal-footer" style="display:flex;gap:.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
        <button class="btn btn-primary" data-act="ok">Anlegen und anhängen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (typeof dialogBarrierefrei === 'function') dialogBarrierefrei(overlay);
  overlay.querySelector('#pnp-name').focus();

  overlay.addEventListener('click', async (ev) => {
    if (ev.target === overlay || ev.target.dataset.act === 'cancel') return overlay.remove();
    if (ev.target.dataset.act !== 'ok') return;
    const fehler = overlay.querySelector('#pnp-fehler');
    try {
      const r = await api('POST', '/api/products', {
        name: overlay.querySelector('#pnp-name').value.trim(),
        barcode: overlay.querySelector('#pnp-code').value.trim() || null,
        category_id: overlay.querySelector('#pnp-kat').value || null,
      });
      await api('PUT', `/api/products/${r.produkt.id}/haendler/${hKarte.dataset.id}`, {});
      overlay.remove();
      toast(`„${r.produkt.name}" angelegt und angehängt.`, 'success');
      // Kein Neuaufbau der Seite: Der wuerde die Haendlerkarte zuklappen, in der man gerade
      // arbeitet. Stattdessen wandert das neue Produkt in die Liste im Speicher (damit die Suche
      // es sofort kennt), und nur die eine Haendlerkarte laedt nach.
      if (S.verzeichnis && Array.isArray(S.verzeichnis.produkte)) {
        S.verzeichnis.produkte.push({ ...r.produkt, barcodes: r.produkt.barcodes || [] });
        S.verzeichnis.produkte.sort((x, y) => x.name.localeCompare(y.name, 'de'));
      }
      await pvHaendlerProdukteLaden(hKarte, true);
    } catch (e) { fehler.textContent = e.message; fehler.style.display = ''; }
  });
}

function pvHaendlerLesen(box) {
  const w = kl => (box.querySelector('.pv-hf-' + kl)?.value || '').trim();
  return { name: w('name'), homepage: w('homepage'), kundennummer: w('kundennummer'),
           ansprechpartner: w('ansprechpartner'), telefon: w('telefon'), email: w('email'),
           notiz: (box.querySelector('.pv-hf-notiz')?.value || '').trim() };
}

async function pvAenderung(ev) {
  const sel = ev.target;
  try {
    // „Großhändler hinzufügen…" — legt einen leeren Eintrag an, den man gleich ausfüllt.
    if (sel.classList.contains('pv-h-neu') && sel.value) {
      const details = sel.closest('.pv-produkt');
      await api('PUT', `/api/products/${details.dataset.id}/haendler/${sel.value}`, {});
      return pvDetailLaden(details, true);
    }
    // Kategorien verschmelzen
    if (sel.classList.contains('pv-k-ziel') && sel.value) {
      const kat = sel.closest('.pv-kat');
      const von = S.verzeichnis.kategorien.find(k => k.id === Number(kat.dataset.id));
      const nach = S.verzeichnis.kategorien.find(k => k.id === Number(sel.value));
      if (!(await confirmModal(
        `Alle ${von.anzahl} Produkt(e) aus „${von.name}“ nach „${nach.name}“ verschieben und `
        + `„${von.name}“ danach löschen?`,
        { title: 'Kategorien zusammenführen', okLabel: 'Zusammenführen' }))) { sel.value = ''; return; }
      await api('POST', `/api/products/kategorien/${von.id}/zusammenfuehren`, { nach_id: nach.id });
      toast('Zusammengeführt', 'success');
      return renderProdukte();
    }
  } catch (e) { toast(e.message, 'error'); sel.value = ''; }
}

/**
 * Zusammenführen. Bewusst mit AUSWAHL, WELCHES überlebt und unter welchem Namen — beim
 * Aufräumen zweier Schreibweisen ist genau das die Frage, die man beantworten will.
 */
async function pvMergeDialog(zielId, vorschlagVonId) {
  const alle = S.verzeichnis.produkte;
  const ziel = alle.find(p => p.id === zielId);
  if (!ziel) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header"><h3>Produkte zusammenführen</h3></div>
      <div class="modal-body">
        <label style="display:block;margin-bottom:.6rem">Dieses Produkt geht auf in …
          <select class="form-control" id="pm-ziel">
            ${alle.map(p => `<option value="${p.id}"${p.id === zielId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></label>
        <label style="display:block;margin-bottom:.6rem">… und dieses verschwindet:
          <select class="form-control" id="pm-von">
            <option value="">— bitte wählen —</option>
            ${alle.map(p => `<option value="${p.id}"${p.id === vorschlagVonId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></label>
        <label style="display:block">Name danach
          <input type="text" class="form-control" id="pm-name" value="${esc(ziel.name)}"></label>
        <p style="font-size:.84rem;color:var(--text-light);margin:.7rem 0 0">
          Barcodes, Bestell-Verknüpfungen und Großhändler-Angaben wandern mit. Haben beide
          denselben Großhändler, wird die zweite Bestellnummer an den Kommentar angehängt statt
          verworfen. Der <strong>Text</strong> bereits geschriebener Bestellungen bleibt, wie er ist.</p>
      </div>
      <div class="modal-footer" style="display:flex;gap:.5rem;justify-content:flex-end;padding:1rem">
        <button class="btn btn-outline" data-act="cancel">Abbrechen</button>
        <button class="btn btn-primary" data-act="ok">Zusammenführen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (typeof dialogBarrierefrei === 'function') dialogBarrierefrei(overlay);

  const zu = () => overlay.remove();
  const zielSel = overlay.querySelector('#pm-ziel');
  const nameFeld = overlay.querySelector('#pm-name');
  zielSel.addEventListener('change', () => {
    const p = alle.find(x => x.id === Number(zielSel.value));
    if (p) nameFeld.value = p.name;
  });
  overlay.addEventListener('click', async ev => {
    if (ev.target === overlay || ev.target.dataset.act === 'cancel') return zu();
    if (ev.target.dataset.act !== 'ok') return;
    const zId = Number(zielSel.value), vId = Number(overlay.querySelector('#pm-von').value);
    if (!vId) { toast('Bitte das Produkt wählen, das verschwinden soll.', 'error'); return; }
    if (vId === zId) { toast('Das sind zweimal dasselbe Produkt.', 'error'); return; }
    try {
      const r = await api('POST', `/api/products/${zId}/zusammenfuehren`, { von_id: vId, name: nameFeld.value.trim() });
      zu();
      const v = r.haendler_verschmolzen || [];
      toast('Zusammengeführt' + (v.length ? ` — Angaben bei ${v.join(', ')} in den Kommentar übernommen` : ''), 'success');
      renderProdukte(zId);
    } catch (e) { toast(e.message, 'error'); }
  });
}
