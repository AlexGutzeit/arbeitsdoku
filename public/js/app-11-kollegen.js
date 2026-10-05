// ================================================================
// Kollegen (Alex, 05.10.2026)
// ================================================================
// Menüpunkt „Kollegen" mit allen aktiven Kollegen als Unterpunkten, eine Übersicht und je Person eine Seite mit
// dem, was sie SELBST freigegeben hat (Mein Konto → „Für die Kollegen"). Was der Server nicht freigibt, kommt
// hier gar nicht erst an (routes/kollegen.js) — diese Datei zeigt nur an.
//
// Profilbild: Das hier ist ein Personenverzeichnis, also überall ein Kreis — ohne Bild mit Initialen
// ('initialen', wie in Listen mit Namen; Regel siehe avatarHtml in app-1-core.js).

// Kollegen fürs Menü — einmal beim Start, nach der Anmeldung und bei jedem Besuch der Übersicht.
async function kollegenLaden() {
  try {
    const d = await api('GET', '/api/kollegen');
    if (!d) return;
    S.kollegen = d.kollegen || [];
    kollegenMenueAktualisieren();
  } catch (_) { /* ohne Liste bleibt im Menü nur „Alle Kollegen" */ }
}

const kollegeNeuMarke = () => '<span class="kollege-neu" title="seit weniger als 4 Wochen dabei">neu</span>';

// Die Menü-Gruppe. activeNav: 'kollegen' (Übersicht) oder 'kollegen:<id>' (eine Person).
function kollegenMenueHtml(activeNav) {
  const hier = String(activeNav || '').startsWith('kollegen');
  return `<div class="nav-group nav-kollegen${hier ? ' open' : ''}" id="nav-kollegen">
    <div class="nav-group-label" id="nav-kollegen-label" role="button" tabindex="0" aria-controls="nav-kollegen"
         aria-expanded="${hier ? 'true' : 'false'}">
      <span class="icon">&#129309;</span> Kollegen
      <span class="nav-caret">&#9656;</span>
    </div>
    <a href="#/kollegen" class="nav-subitem ${activeNav === 'kollegen' ? 'active' : ''}">Alle Kollegen</a>
    ${(S.kollegen || []).map(k => `<a href="#/kollegen/${k.id}" class="nav-subitem nav-kollege ${activeNav === 'kollegen:' + k.id ? 'active' : ''}">
      ${avatarHtml({ id: k.id, name: k.name }, 22, 'initialen')}<span class="nav-kollege-name">${esc(k.name)}</span>${k.neu ? kollegeNeuMarke() : ''}</a>`).join('')}
  </div>`;
}

// Nach dem Laden die Gruppe austauschen, ohne die ganze Seite neu zu bauen — den Auf-/Zu-Zustand behalten.
function kollegenMenueAktualisieren() {
  const alt = document.getElementById('nav-kollegen');
  if (!alt) return;
  const offen = alt.classList.contains('open');
  const aktiv = alt.querySelector('.nav-subitem.active');
  const vorlage = document.createElement('div');
  vorlage.innerHTML = kollegenMenueHtml(aktiv ? (aktiv.getAttribute('href') === '#/kollegen' ? 'kollegen' : 'kollegen:' + aktiv.getAttribute('href').split('/').pop()) : '');
  const neu = vorlage.firstElementChild;
  neu.classList.toggle('open', offen);
  neu.querySelector('.nav-group-label').setAttribute('aria-expanded', offen ? 'true' : 'false');
  alt.replaceWith(neu);
  navGruppeBinden(neu.querySelector('.nav-group-label'));
  avatareLaden(neu);
}

// ── Übersicht ─────────────────────────────────────────────────────────────────────────────────────
async function renderKollegen() {
  $app().innerHTML = layout('<div class="loading">Laden…</div>', 'kollegen');
  bindLayout();
  const d = await seiteLaden(() => api('GET', '/api/kollegen'), () => renderKollegen());
  if (!d) return;
  S.kollegen = d.kollegen || [];
  kollegenMenueAktualisieren();
  const main = document.querySelector('.main');
  main.innerHTML = `
    <div class="kollegen-seite">
      <h1 class="kollegen-titel">&#129309; Kollegen</h1>
      <p class="kollegen-hinweis">Was hier steht, hat jeder selbst freigegeben. Deine eigenen Angaben:
        <a href="#/konto" data-ziel="konto-kollegen">Mein Konto → Für die Kollegen</a>.</p>
      ${S.kollegen.length ? `<div class="kollegen-raster">${S.kollegen.map(k => `
        <a class="kollegen-karte" href="#/kollegen/${k.id}">
          ${avatarHtml({ id: k.id, name: k.name }, 56, 'initialen')}
          <span class="kollegen-karte-text">
            <strong>${esc(k.name)}</strong>
            <span class="kollegen-rolle">${esc(roleName(k.role))}${k.neu ? ' ' + kollegeNeuMarke() : ''}</span>
          </span>
        </a>`).join('')}</div>`
        : '<div class="empty-state"><p>Außer dir ist noch niemand im Team.</p></div>'}
    </div>`;
  kollegenKontoLinkBinden(main);
}

// „Mein Konto → Für die Kollegen" springt direkt zur Karte
function kollegenKontoLinkBinden(wurzel) {
  wurzel.querySelectorAll('a[data-ziel="konto-kollegen"]').forEach(a => a.addEventListener('click', () => {
    S._kontoZiel = 'konto-kollegen';
  }));
}

// ── Seite einer Person ────────────────────────────────────────────────────────────────────────────
const KOLLEGE_MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
// Für den Anruf-Link nur Ziffern und ein führendes Plus
const kollegeTelLink = (nr) => 'tel:' + String(nr).replace(/(?!^\+)[^\d]/g, '');

async function renderKollege(id) {
  $app().innerHTML = layout('<div class="loading">Laden…</div>', 'kollegen:' + id);
  bindLayout();
  const k = await seiteLaden(() => api('GET', '/api/kollegen/' + encodeURIComponent(id)), () => renderKollege(id));
  if (!k) return;
  const vorname = String(k.name).split(/\s+/)[0];
  const zeilen = [];
  if (k.geburtstag) {
    zeilen.push(`<div class="kollege-zeile"><span class="kollege-zeichen" aria-hidden="true">&#127874;</span>
      <span><span class="kollege-feld">Geburtstag</span>${k.geburtstag.tag}. ${KOLLEGE_MONATE[k.geburtstag.monat - 1]}${
        k.geburtstag.alter !== undefined ? ` · ${k.geburtstag.alter} Jahre` : ''}</span></div>`);
  }
  if (k.telefon) {
    zeilen.push(`<div class="kollege-zeile"><span class="kollege-zeichen" aria-hidden="true">&#128222;</span>
      <span><span class="kollege-feld">Telefon</span><a href="${esc(kollegeTelLink(k.telefon))}">${esc(k.telefon)}</a></span></div>`);
  }
  if (k.email) {
    zeilen.push(`<div class="kollege-zeile"><span class="kollege-zeichen" aria-hidden="true">&#9993;&#65039;</span>
      <span><span class="kollege-feld">E-Mail</span><a href="mailto:${esc(k.email)}">${esc(k.email)}</a></span></div>`);
  }
  const werkzeug = (k.werkzeug || []).map(w => `<li>${esc(w.name)}${w.projekt ? ` <span class="kollege-leise">· ${esc(w.projekt)}</span>` : ''}${
    w.checked_out_at ? ` <span class="kollege-leise">· seit ${esc(formatDateDE(String(w.checked_out_at).slice(0, 10)))}</span>` : ''}</li>`).join('');
  const nichts = !zeilen.length && !k.info && !werkzeug;

  document.querySelector('.main').innerHTML = `
    <div class="kollegen-seite">
      <a href="#/kollegen" class="kollege-zurueck">&larr; Alle Kollegen</a>
      ${k.selbst ? `<div class="kollege-vorschau">So sehen dich deine Kollegen. Ändern kannst du das unter
        <a href="#/konto" data-ziel="konto-kollegen">Mein Konto → Für die Kollegen</a>.</div>` : ''}
      <div class="kollege-kopf">
        ${avatarHtml({ id: k.id, name: k.name }, 96, 'initialen')}
        <div>
          <h1 class="kollege-name">${esc(k.name)}</h1>
          <span class="role-badge kollege-rolle-badge">${esc(roleName(k.role))}</span>${k.neu ? ' ' + kollegeNeuMarke().replace('>neu<', '>Neu im Team<') : ''}
        </div>
      </div>
      ${zeilen.length ? `<div class="kollege-angaben">${zeilen.join('')}</div>` : ''}
      ${k.info ? `<div class="kollege-info"><div class="kollege-feld">Infos für die Kollegen</div>
        <div class="kollege-info-text">${esc(k.info).replace(/\n/g, '<br>')}</div></div>` : ''}
      ${werkzeug ? `<div class="kollege-werkzeug"><div class="kollege-feld">&#128295; Hat gerade ausgeliehen</div><ul>${werkzeug}</ul></div>` : ''}
      ${nichts ? `<p class="kollege-leise">${k.selbst ? 'Du hast noch nichts' : esc(vorname) + ' hat noch nichts'} für die Kollegen freigegeben.</p>` : ''}
      ${k.vcard ? `<button class="btn btn-outline" id="kollege-vcard">&#128199; Ins Telefonbuch übernehmen</button>` : ''}
    </div>`;
  kollegenKontoLinkBinden(document.querySelector('.main'));
  const knopf = document.getElementById('kollege-vcard');
  if (knopf) knopf.addEventListener('click', async () => {
    knopf.disabled = true;
    try {
      const antwort = await fetch('/api/kollegen/' + k.id + '/vcard', { headers: { Authorization: 'Bearer ' + S.token } });
      if (!antwort.ok) throw new Error((await antwort.json().catch(() => ({}))).error || 'Konnte die Kontaktkarte nicht laden');
      dateiHerunterladen(await antwort.blob(), dateinameAus(antwort, k.name + '.vcf'));
    } catch (e) { toast(e.message, 'error'); }
    finally { knopf.disabled = false; }
  });
}

// ── Mein Konto → „Für die Kollegen" ───────────────────────────────────────────────────────────────
// Alles Freiwillige an einer Stelle: Infotext, Telefon, E-Mail (je mit Haken), Geburtstag und Alter.
// Der Geburtstag wird weiter über /api/users/geburtstag-freigabe gespeichert (eigene Tabelle, auch die
// Willkommensseite liest sie) — hier nur mit bedient.
async function kontoKollegenKarte() {
  const k = document.getElementById('konto-kollegen');
  if (!k) return;
  let p;
  try { p = await api('GET', '/api/kollegen/mein-profil'); } catch (_) { k.style.display = 'none'; return; }
  if (!p) return;
  k.innerHTML = `
    <h3>&#129309; Für die Kollegen</h3>
    <p class="kollegen-konto-hinweis">Was du hier freigibst, sehen alle angemeldeten Kolleginnen und Kollegen unter
      <strong>Kollegen</strong>. Alles ist freiwillig — ohne Haken sieht niemand etwas, und du kannst es jederzeit
      zurücknehmen.</p>
    <div class="error-msg" id="kk-fehler"></div>
    <form id="kollegen-profil-form">
      <div class="form-group">
        <label for="kk-info">Infos für die Kollegen</label>
        <textarea class="form-control" id="kk-info" rows="3" maxlength="1000"
          placeholder="z. B. Ansprechpartner für Heizung · spreche Polnisch · morgens ab 6 Uhr erreichbar">${esc(p.info)}</textarea>
        <div class="kk-zaehler"><span id="kk-zeichen">${p.info.length}</span> / 1000 — erscheint, sobald etwas drinsteht</div>
      </div>
      <div class="form-group">
        <label for="kk-telefon">Telefon</label>
        <input type="tel" class="form-control" id="kk-telefon" maxlength="30" autocomplete="tel" value="${esc(p.telefon)}" placeholder="0171 2345678">
        <label class="kk-haken"><input type="checkbox" id="kk-telefon-zeigen"${p.telefon_zeigen ? ' checked' : ''}${p.telefon ? '' : ' disabled'}> für die Kollegen sichtbar</label>
      </div>
      <div class="form-group">
        <label for="kk-email">E-Mail</label>
        <input type="email" class="form-control" id="kk-email" maxlength="120" autocomplete="email" value="${esc(p.email)}" placeholder="name@beispiel.de">
        <label class="kk-haken"><input type="checkbox" id="kk-email-zeigen"${p.email_zeigen ? ' checked' : ''}${p.email ? '' : ' disabled'}> für die Kollegen sichtbar</label>
      </div>
      <div class="form-group">
        <span class="kk-label">Geburtstag</span>
        <label class="kk-haken"><input type="checkbox" id="geb-zeigen"${p.geburtstag_zeigen ? ' checked' : ''}${p.geburtsdatum_hinterlegt ? '' : ' disabled'}> meinen Geburtstag zeigen</label>
        <label class="kk-haken kk-eingerueckt"><input type="checkbox" id="geb-alter"${p.alter_zeigen ? ' checked' : ''}${p.geburtstag_zeigen && p.geburtsdatum_hinterlegt ? '' : ' disabled'}> … und auch mein Alter</label>
        <div class="kk-zaehler">${p.geburtsdatum_hinterlegt
          ? 'Freigegeben steht er auf deiner Kollegen-Seite und am Tag selbst auf der Willkommensseite. Ohne Freigabe sehen ihn nur Chef, Admin und Buchhaltung.'
          : 'Es ist kein Geburtsdatum hinterlegt — siehe oben unter „Geburtstag".'}</div>
      </div>
      <div class="kk-knoepfe">
        <button type="submit" class="btn btn-primary">Speichern</button>
        <a href="#/kollegen/${S.user.id}" class="btn btn-outline">So sehen dich deine Kollegen &rarr;</a>
      </div>
    </form>`;

  const $k = (id) => document.getElementById(id);
  $k('kk-info').addEventListener('input', () => { $k('kk-zeichen').textContent = $k('kk-info').value.length; });
  // Ein Haken ohne Inhalt ergibt keinen Sinn (der Server räumt es ohnehin gerade)
  for (const [feld, haken] of [['kk-telefon', 'kk-telefon-zeigen'], ['kk-email', 'kk-email-zeigen']]) {
    $k(feld).addEventListener('input', () => {
      const leer = !$k(feld).value.trim();
      $k(haken).disabled = leer;
      if (leer) $k(haken).checked = false;
    });
  }
  $k('geb-zeigen').addEventListener('change', () => {
    $k('geb-alter').disabled = !$k('geb-zeigen').checked;
    if (!$k('geb-zeigen').checked) $k('geb-alter').checked = false;
  });
  $k('kollegen-profil-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $k('kk-fehler').textContent = '';
    try {
      await api('PUT', '/api/kollegen/mein-profil', {
        info: $k('kk-info').value, telefon: $k('kk-telefon').value, telefon_zeigen: $k('kk-telefon-zeigen').checked,
        email: $k('kk-email').value, email_zeigen: $k('kk-email-zeigen').checked,
      });
      if (p.geburtsdatum_hinterlegt) {
        await api('PUT', '/api/users/geburtstag-freigabe', { zeigen: $k('geb-zeigen').checked, alter_auch: $k('geb-alter').checked });
      }
      toast('Gespeichert', 'success');
    } catch (err) {
      $k('kk-fehler').textContent = err.message || 'Konnte nicht gespeichert werden';
    }
  });
  // Von „Mein Konto → Für die Kollegen" auf einer Kollegen-Seite hierher gesprungen? Dann die Karte zeigen.
  if (S._kontoZiel === 'konto-kollegen') {
    S._kontoZiel = null;
    k.scrollIntoView({ block: 'start' });
  }
}
