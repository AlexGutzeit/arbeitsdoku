// --- Settings ---
// Muss zur Liste in zweifaktor.js passen (MODI) — dort steht die Quelle der Wahrheit, hier nur
// die Beschriftung.
const TWOFA_MODI = ['aus', 'immer', 'geraet', 'taeglich', 'woechentlich', 'monatlich'];
const TWOFA_TEXT = {
  aus: 'aus — kein zweiter Faktor',
  immer: 'bei jeder Anmeldung',
  geraet: 'einmal pro Gerät',
  taeglich: 'täglich',
  woechentlich: 'wöchentlich',
  monatlich: 'monatlich',
};
const TWOFA_ROLLE_TEXT = {
  admin: 'Administrator', chef: 'Chef', buchhalter: 'Buchhalter', mitarbeiter: 'Mitarbeiter',
};

async function renderSettings() {
  if (!canSeeSettings()) { navigate('/'); return; }

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'settings');
  bindLayout();

  try {
    const data = await api('GET', '/api/settings');
    if (data) S.settings = data.settings;
  } catch (e) {}

  // Dokumenten-Speicher (nur Admin)
  let docStorage = null;
  if (isAdmin()) {
    try { const ds = await api('GET', '/api/documents'); if (ds) docStorage = ds.storage; } catch (e) {}
  }
  let docLimitVal = '500', docLimitUnit = 'MB', docUsedStr = '', docLimitStr = '';
  let docFileVal = '5', docFileUnit = 'MB';
  // Wert+Einheit aus Bytes ableiten (GB nur bei glatten GB, sonst MB)
  const splitUnit = (bytes) => {
    const gb = 1024 * 1024 * 1024, mb = 1024 * 1024;
    if (bytes >= gb && bytes % gb === 0) return { val: String(bytes / gb), unit: 'GB' };
    const v = bytes / mb; return { val: (v % 1 === 0) ? String(v) : v.toFixed(2), unit: 'MB' };
  };
  if (docStorage) {
    const s = splitUnit(docStorage.limit); docLimitVal = s.val; docLimitUnit = s.unit;
    const f = splitUnit(docStorage.fileLimit || 5 * 1024 * 1024); docFileVal = f.val; docFileUnit = f.unit;
    docUsedStr = docFormatSize(docStorage.used);
    docLimitStr = docFormatSize(docStorage.limit);
  }
  // Max. Dateigröße für Logo/App-Icon (Admin-konfigurierbar, Default 5 MB)
  let brandVal = '5', brandUnit = 'MB';
  { const b = splitUnit(parseInt(S.settings?.branding_file_limit_bytes, 10) || 5 * 1024 * 1024); brandVal = b.val; brandUnit = b.unit; }

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:600px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:1rem;">Firmen-Einstellungen</h2>
        <form id="settings-form">
          <div class="form-group">
            <label>Firmenname</label>
            <input type="text" class="form-control" id="s-company" value="${esc(S.settings.company_name || '')}">
          </div>
          <div class="form-group">
            <label>Straße + Hausnummer</label>
            <input type="text" class="form-control" id="s-street" value="${esc(S.settings.company_street || '')}" placeholder="Musterstraße 1">
          </div>
          <div class="form-row" style="grid-template-columns:120px 1fr;">
            <div class="form-group">
              <label>PLZ</label>
              <input type="text" class="form-control" id="s-zip" value="${esc(S.settings.company_zip || '')}" placeholder="10115">
            </div>
            <div class="form-group">
              <label>Ort</label>
              <input type="text" class="form-control" id="s-city" value="${esc(S.settings.company_city || '')}" placeholder="Berlin">
            </div>
          </div>
          <hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--border);">
          <h3 style="font-size:1.05rem;margin-bottom:0.35rem;">Arbeitszeiten</h3>
          <p class="push-hint" style="margin-bottom:0.9rem;">
            Gilt als Vorbelegung für die Planung und für den ersten Zeiteintrag eines Tages.
            Bei einzelnen Mitarbeitern lässt sich ein abweichender Arbeitsbeginn hinterlegen —
            wer dort nichts stehen hat, folgt diesen Werten. <strong>Bereits erfasste Zeiten und die
            Soll-Stunden bleiben unberührt.</strong>
          </p>
          <p class="push-hint" style="margin-bottom:0.9rem;">
            Die Pause ist eine <strong>Untergrenze</strong>: Wird ein Tag lang, schlägt der
            Zeitnachweis von sich aus mehr vor — nach Arbeitszeitgesetz, bei unter 18-Jährigen nach
            Jugendarbeitsschutzgesetz. Maßgeblich ist das <strong>Geburtsdatum</strong> beim
            Mitarbeiter; fehlt es, wird vorsichtshalber „unter 18" angenommen. Keine Rechtsberatung —
            Tarifverträge können abweichen.
          </p>
          <div class="form-row" style="grid-template-columns:1fr 1fr 1fr;">
            <div class="form-group">
              <label>Arbeitsbeginn</label>
              <input type="time" class="form-control" id="s-work-start" value="${esc(S.settings.work_start_default || '07:00')}">
            </div>
            <div class="form-group">
              <label>Arbeitszeit pro Tag (h)</label>
              <input type="text" inputmode="decimal" class="form-control" id="s-work-hours" value="${esc(numDe(S.settings.work_hours_per_day || 8))}" placeholder="8">
            </div>
            <div class="form-group">
              <label>Pause pro Tag (min)</label>
              <input type="text" inputmode="numeric" class="form-control" id="s-break" value="${esc(S.settings.break_minutes_default || 30)}" placeholder="30">
            </div>
          </div>
          <p class="push-hint" id="s-zeit-vorschau" style="margin-bottom:1rem;"></p>
          <button type="submit" class="btn btn-primary">Speichern</button>
        </form>
        <hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--border);">
        <div class="form-group">
          <label>Firmenlogo (PNG/JPG)</label>
          ${S.settings.company_logo ? `
            <div style="margin-bottom:0.75rem;">
              <img src="${S.settings.company_logo}" style="max-height:60px;border-radius:4px;" alt="Logo">
              <button class="btn btn-sm btn-danger" id="delete-logo" style="margin-left:0.5rem;">Entfernen</button>
            </div>
          ` : ''}
          <input type="file" class="form-control" id="s-logo" accept=".png,.jpg,.jpeg">
          <button type="button" class="btn btn-outline btn-sm" id="upload-logo" style="margin-top:0.5rem;">Logo hochladen</button>
        </div>
      </div>

      <div class="card">
        <h2 style="margin-bottom:1rem;">Zwei-Faktor-Anmeldung</h2>
        <div class="warning-box" style="margin-bottom:1rem;">
          Wer noch keinen Authenticator eingerichtet hat, wird beim nächsten Aufruf auf
          <strong>Mein Konto</strong> geführt und kommt vorher nicht weiter — auch mitten in der
          Arbeit. Sag den Betroffenen also vorher Bescheid.
        </div>
        <form id="twofa-form">
          ${['admin', 'chef', 'buchhalter', 'mitarbeiter'].map(rolle => `
          <div class="form-group">
            <label>${TWOFA_ROLLE_TEXT[rolle]}${rolle === 'admin' && !isAdmin() ? ' (nur ein Administrator kann das ändern)' : ''}</label>
            <select class="form-control" id="s-twofa-${rolle}"${rolle === 'admin' && !isAdmin() ? ' disabled' : ''}>
              ${TWOFA_MODI.map(w => `<option value="${w}"${(S.settings['twofa_' + rolle] || 'aus') === w ? ' selected' : ''}>${esc(TWOFA_TEXT[w])}</option>`).join('')}
            </select>
          </div>`).join('')}
          <button type="submit" class="btn btn-primary">Zwei-Faktor-Einstellungen speichern</button>
        </form>
      </div>

      <div class="card">
        <h2 style="margin-bottom:1rem;">Rechtliches (Impressum &amp; Datenschutz)</h2>
        <div class="warning-box" style="margin-bottom:1rem;">
          Für den öffentlich erreichbaren Betrieb gesetzlich vorgeschrieben. Sobald ausgefüllt, erscheinen die Texte
          als Links auf der Anmeldeseite und im Menü. (Ersetzt keine Rechtsberatung.)
        </div>
        <form id="legal-form">
          <div class="form-group">
            <label>Impressum</label>
            <textarea class="form-control" id="s-legal-impressum" rows="8" placeholder="Firmenname, Anschrift, Vertretungsberechtigte/r, Kontakt (E-Mail/Telefon), ggf. USt-IdNr. …">${esc(S.settings.legal_impressum || '')}</textarea>
          </div>
          <div class="form-group">
            <label>Datenschutzerklärung</label>
            <textarea class="form-control" id="s-legal-datenschutz" rows="12" placeholder="Verantwortliche Stelle, Zwecke &amp; Rechtsgrundlagen der Verarbeitung, Speicherdauer, Rechte der Betroffenen …">${esc(S.settings.legal_datenschutz || '')}</textarea>
          </div>
          <button type="submit" class="btn btn-primary">Rechtstexte speichern</button>
        </form>
      </div>

      <div class="card">
        <h2 style="margin-bottom:1rem;">App-Branding</h2>
        <div class="warning-box" style="margin-bottom:1rem;">
          App-Name, Farben und Icon der installierten PWA-App. Nach dem Speichern muss die App auf jedem Gerät einmal neu geladen werden (Pull-to-Refresh oder Browser-Reload). Bei bereits installierter PWA (Homescreen-Icon) ggf. neu installieren.
        </div>
        <form id="brand-form">
          <div class="form-group">
            <label>App-Name (Browser-Titel + PWA)</label>
            <input type="text" class="form-control" id="b-app-name" maxlength="60" value="${esc(S.settings.app_name || '')}" placeholder="Arbeitsdoku">
          </div>
          <div class="form-group">
            <label>Short-Name (max. 12 Zeichen, fuer Homescreen-Icon)</label>
            <input type="text" class="form-control" id="b-app-short" maxlength="12" value="${esc(S.settings.app_short_name || '')}" placeholder="Arbeitsdoku">
          </div>
          ${colorPickerHtml('b-theme', 'Theme-Farbe', S.settings.theme_color || '#5DB635')}
          ${colorPickerHtml('b-bg', 'Hintergrund (PWA-Splash)', S.settings.background_color || '#ffffff')}
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button type="submit" class="btn btn-primary">Branding speichern</button>
            <button type="button" class="btn btn-outline" id="brand-reset">Zurücksetzen</button>
          </div>
        </form>
        <hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--border);">
        <div class="form-group">
          <label>App-Icon (PNG/JPG, mind. 256x256 Pixel)</label>
          ${S.settings.app_icon_master ? `
            <div style="margin-bottom:0.75rem;display:flex;align-items:center;gap:0.75rem;">
              <img src="${esc(S.settings.app_icon_master)}?t=${Date.now()}" style="width:64px;height:64px;border-radius:12px;border:1px solid var(--border);" alt="App-Icon">
              <button class="btn btn-sm btn-danger" id="delete-app-icon" type="button">Auf Standard zuruecksetzen</button>
            </div>
          ` : `
            <div style="margin-bottom:0.75rem;display:flex;align-items:center;gap:0.75rem;">
              <img src="/icons/icon-128x128.png?t=${Date.now()}" style="width:64px;height:64px;border-radius:12px;border:1px solid var(--border);opacity:0.6;" alt="Standard-Icon">
              <span style="color:var(--text-light);font-size:0.85rem;">Standard-Icon aktiv</span>
            </div>
          `}
          <input type="file" class="form-control" id="b-icon" accept=".png,.jpg,.jpeg">
          <button type="button" class="btn btn-outline btn-sm" id="upload-app-icon" style="margin-top:0.5rem;">Icon hochladen</button>
        </div>
      </div>

      ${isAdmin() ? `
      <div class="card">
        <h2 style="margin-bottom:1rem;">Speicher- &amp; Größenlimits</h2>
        <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:1rem;">
          Aktuell belegt: <strong>${docUsedStr}</strong> von <strong>${docLimitStr}</strong>.
        </p>
        <div class="form-row" style="grid-template-columns:1fr 110px;">
          <div class="form-group">
            <label>Gesamtlimit</label>
            <input type="text" class="form-control" id="doc-limit-value" value="${esc(docLimitVal)}" inputmode="decimal">
          </div>
          <div class="form-group">
            <label>Einheit</label>
            <select class="form-control" id="doc-limit-unit">
              <option value="MB"${docLimitUnit === 'MB' ? ' selected' : ''}>MB</option>
              <option value="GB"${docLimitUnit === 'GB' ? ' selected' : ''}>GB</option>
            </select>
          </div>
        </div>
        <div class="form-row" style="grid-template-columns:1fr 110px;">
          <div class="form-group">
            <label>Max. Dateigröße (pro Datei)</label>
            <input type="text" class="form-control" id="doc-file-value" value="${esc(docFileVal)}" inputmode="decimal">
          </div>
          <div class="form-group">
            <label>Einheit</label>
            <select class="form-control" id="doc-file-unit">
              <option value="MB"${docFileUnit === 'MB' ? ' selected' : ''}>MB</option>
              <option value="GB"${docFileUnit === 'GB' ? ' selected' : ''}>GB</option>
            </select>
          </div>
        </div>
        <div class="form-row" style="grid-template-columns:1fr 110px;">
          <div class="form-group">
            <label>Max. Dateigröße Logo / App-Icon</label>
            <input type="text" class="form-control" id="brand-file-value" value="${esc(brandVal)}" inputmode="decimal">
          </div>
          <div class="form-group">
            <label>Einheit</label>
            <select class="form-control" id="brand-file-unit">
              <option value="MB"${brandUnit === 'MB' ? ' selected' : ''}>MB</option>
              <option value="GB"${brandUnit === 'GB' ? ' selected' : ''}>GB</option>
            </select>
          </div>
        </div>
        <button class="btn btn-primary" id="doc-limit-save">Speichern</button>
        <p style="color:var(--text-lighter);font-size:0.8rem;margin-top:0.6rem;">
          Bestehende Dateien bleiben immer erhalten. Ein Gesamtlimit unterhalb des belegten Speichers
          blockiert nur neue Uploads, bis genug gelöscht wurde. Die max. Dateigröße darf das Gesamtlimit
          nicht überschreiten. Logo/App-Icon: 1–50 MB. „.“ und „,“ sind beide erlaubt.
        </p>
      </div>` : ''}

      <div class="card">
        <h2 style="margin-bottom:1rem;">Datenbank-Backup</h2>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="btn btn-success" id="backup-download">Backup herunterladen</button>
          <button class="btn btn-outline" id="backup-restore-btn">Backup einspielen</button>
        </div>
        <div id="restore-area" style="display:none;margin-top:1rem;">
          <div class="warning-box">
            <strong>Achtung!</strong> Beim Einspielen eines Backups werden alle aktuellen Daten überschrieben.
            Ein Sicherungs-Backup der aktuellen Datenbank wird automatisch erstellt.
          </div>
          <input type="file" class="form-control" id="backup-file" accept=".adbk,.zip,.sqlite,.db">
          <!-- Erscheint nur, wenn die gewaehlte Datei verschluesselt ist. Entschluesselt wird
               dann HIER im Browser — der Schluessel erreicht den Server nie, das ist der Zweck. -->
          <div id="restore-schluessel" style="display:none;margin-top:.7rem">
            <label for="backup-schluessel"><strong>Diese Sicherung ist verschlüsselt.</strong>
              Bitte den Schlüssel einfügen:</label>
            <textarea class="form-control" id="backup-schluessel" rows="3" spellcheck="false"
                      autocomplete="off" style="font-family:ui-monospace,monospace;font-size:.82rem"
                      placeholder="Privaten Schlüssel hier einfügen (eine lange Zeile)"></textarea>
            <div style="font-size:.78rem;color:var(--text-light);margin-top:.25rem" id="backup-schluessel-info">
              Er wird nur in deinem Browser benutzt und nicht an den Server geschickt.
            </div>
          </div>
          <button class="btn btn-danger" id="restore-confirm" style="margin-top:0.5rem;">Backup jetzt einspielen</button>
        </div>
        <hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--border)">
        <button class="btn btn-outline btn-sm" id="backup-werkzeug">&#128190; Notfall-Entschlüsseler herunterladen</button>
        <p class="push-hint" style="margin-top:.4rem">
          Eine einzelne Datei, die per Doppelklick läuft — ohne Installation und ohne Internet.
          Damit lässt sich eine verschlüsselte Sicherung auch dann öffnen, wenn diese App gerade
          nicht erreichbar ist. <strong>Zusammen mit dem Schlüssel aufbewahren</strong>, nicht auf
          dem Server.
        </p>
      </div>
    </div>`;

  // Vorschau, damit sofort sichtbar ist, was die drei Werte zusammen bedeuten.
  function zeitVorschau() {
    const el = document.getElementById('s-zeit-vorschau');
    if (!el) return;
    const von = document.getElementById('s-work-start').value;
    const std = numFromField('s-work-hours', null, 0.25, 24);
    const pause = numFromField('s-break', null, 0, 480);
    if (!von || std === null || pause === null) { el.textContent = ''; return; }
    const [h, m] = von.split(':').map(Number);
    const ende = h * 60 + m + Math.round(std * 60) + Math.round(pause);
    const g = ((ende % 1440) + 1440) % 1440;
    el.textContent = `Ergibt in der Planung: ${von} – ${String(Math.floor(g / 60)).padStart(2, '0')}:${String(g % 60).padStart(2, '0')} mit ${Math.round(pause)} min Pause.`;
  }
  ['s-work-start', 's-work-hours', 's-break'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', zeitVorschau);
  });
  zeitVorschau();

  // Settings form
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      // Zahlenfelder: Komma erlauben und ungueltige Eingabe MELDEN statt still als 0 zu speichern
      // (dieselbe Regel wie bei den Soll-Stunden).
      const std = numFromField('s-work-hours', null, 0.25, 24);
      if (std === null) { toast('Arbeitszeit pro Tag: bitte eine Zahl zwischen 0,25 und 24 eingeben', 'error'); return; }
      const pause = numFromField('s-break', null, 0, 480);
      if (pause === null) { toast('Pause pro Tag: bitte ganze Minuten zwischen 0 und 480 eingeben', 'error'); return; }
      await api('PUT', '/api/settings', {
        company_name: document.getElementById('s-company').value,
        company_street: document.getElementById('s-street').value,
        company_zip: document.getElementById('s-zip').value,
        company_city: document.getElementById('s-city').value,
        work_start_default: document.getElementById('s-work-start').value,
        work_hours_per_day: String(std),
        break_minutes_default: String(Math.round(pause)),
      });
      S.arbeitszeit = null;   // gemerkte Vorgaben verwerfen, sonst gilt in dieser Sitzung der alte Stand
      zeitVorschau();
      toast('Einstellungen gespeichert', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Zwei-Faktor-Pflicht je Rolle
  document.getElementById('twofa-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const werte = {};
    for (const rolle of ['admin', 'chef', 'buchhalter', 'mitarbeiter']) {
      const feld = document.getElementById('s-twofa-' + rolle);
      // Ein deaktiviertes Feld gar nicht erst mitschicken — sonst antwortet der Server mit 403,
      // obwohl der Chef den Wert nur nicht anfassen wollte.
      if (feld && !feld.disabled) werte['twofa_' + rolle] = feld.value;
    }
    // Wer gerade eine Rolle scharf schaltet, soll wissen, was das ausloest.
    const scharf = Object.entries(werte).filter(([k, v]) => v !== 'aus' && (S.settings[k] || 'aus') === 'aus');
    if (scharf.length) {
      const namen = scharf.map(([k]) => TWOFA_ROLLE_TEXT[k.replace('twofa_', '')]).join(', ');
      const weiter = await confirmModal(
        `Für ${namen} wird die Zwei-Faktor-Anmeldung ab sofort verlangt. Wer noch keinen `
        + 'Authenticator eingerichtet hat, landet beim nächsten Aufruf auf „Mein Konto" und kommt '
        + 'vorher nicht weiter. Fortfahren?');
      if (!weiter) return;

      // Ohne eigenen Authenticator geht es gar nicht — das gleich sagen, statt den Nutzer erst
      // nach einem Code zu fragen, den er nicht haben kann.
      if (!(S.zweiFaktor && S.zweiFaktor.eingerichtet)) {
        toast('Richte die Zwei-Faktor-Anmeldung zuerst für dich selbst ein (Mein Konto). '
            + 'Sonst schreibst du etwas vor, von dem niemand weiß, ob es funktioniert.', 'error');
        renderSettings();
        return;
      }

      // Scharfschalten nur mit einem frischen Code aus der EIGENEN App. Das ist kein Formalismus:
      // Ein QR-Code, den man eingescannt zu haben glaubt, oder eine falsch gestellte Handy-Uhr
      // fallen damit VOR dem Scharfschalten auf — nicht danach, wenn niemand mehr hineinkommt.
      // Der Server prueft es ohnehin; hier wird nur gefragt, statt den Nutzer in einen Fehler
      // laufen zu lassen.
      const code = await promptModal(
        'Gib zur Sicherheit einen aktuellen 6-stelligen Code aus deiner Authenticator-App ein.\n\n'
        + 'Damit ist bewiesen, dass dein Generator wirklich läuft, bevor die Anmeldung für andere '
        + 'Pflicht wird.',
        { title: 'Scharfschalten bestätigen', multiline: false, inputType: 'text',
          placeholder: '123456', required: true, requiredMsg: 'Bitte den Code eingeben.',
          okLabel: 'Scharf schalten' });
      if (code === null) return;
      werte.twofa_code = String(code).trim();
    }
    try {
      const d = await api('PUT', '/api/settings', werte);
      if (d && d.settings) S.settings = d.settings;
      toast('Zwei-Faktor-Einstellungen gespeichert', 'success');
      renderSettings();          // Auswahlfelder auf den gespeicherten Stand zurueckstellen
    } catch (err) {
      toast(err.message, 'error');
      // Nichts wurde gespeichert — die Felder duerfen nicht so stehen bleiben, als waere es
      // gelungen. Sonst glaubt der naechste Blick, die Pflicht sei aktiv.
      renderSettings();
    }
  });

  // Rechtstexte (Chef + Admin) speichern
  document.getElementById('legal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const imp = document.getElementById('s-legal-impressum').value;
    const dat = document.getElementById('s-legal-datenschutz').value;
    try {
      await api('PUT', '/api/settings', { legal_impressum: imp, legal_datenschutz: dat });
      S.hasLegal = { impressum: !!imp.trim(), datenschutz: !!dat.trim() }; // Links/Nav sofort mitziehen
      toast('Rechtstexte gespeichert', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Dokumenten-Limits (Admin): Gesamtspeicher + max. Dateigröße zusammen speichern
  document.getElementById('doc-limit-save')?.addEventListener('click', async () => {
    const toBytes = (raw, unit) => Math.round(parseFloat(raw) * (unit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024));
    const sRaw = document.getElementById('doc-limit-value').value.trim().replace(',', '.');
    const sUnit = document.getElementById('doc-limit-unit').value;
    const fRaw = document.getElementById('doc-file-value').value.trim().replace(',', '.');
    const fUnit = document.getElementById('doc-file-unit').value;
    const sVal = parseFloat(sRaw), fVal = parseFloat(fRaw);
    if (!isFinite(sVal) || sVal <= 0 || !isFinite(fVal) || fVal <= 0) { toast('Bitte für beide Limits eine gültige Zahl größer 0 eingeben', 'error'); return; }
    const storageBytes = toBytes(sRaw, sUnit), fileBytes = toBytes(fRaw, fUnit);
    if (fileBytes > storageBytes) { toast('Max. Dateigröße darf das Gesamtlimit nicht überschreiten', 'error'); return; }
    const usedBytes = docStorage ? docStorage.used : 0;
    if (storageBytes < usedBytes) {
      if (!(await confirmModal(`Aktuell sind ${docFormatSize(usedBytes)} belegt. Ein Gesamtlimit von ${docFormatSize(storageBytes)} blockiert neue Uploads, bis genug gelöscht wurde. Bestehende Dateien bleiben erhalten. Trotzdem speichern?`, { title: 'Speicherlimit', okLabel: 'Speichern', danger: false }))) return;
    }
    // Branding-Limit (Logo/Icon) — separater Admin-Endpunkt
    const bRaw = document.getElementById('brand-file-value').value.trim().replace(',', '.');
    const bUnit = document.getElementById('brand-file-unit').value;
    const bVal = parseFloat(bRaw);
    if (!isFinite(bVal) || bVal <= 0) { toast('Bitte für die Logo-/Icon-Größe eine gültige Zahl größer 0 eingeben', 'error'); return; }
    try {
      await api('PUT', '/api/documents/limits', { storageValue: sRaw, storageUnit: sUnit, fileValue: fRaw, fileUnit: fUnit });
      await api('PUT', '/api/settings/branding-limit', { fileValue: bRaw, fileUnit: bUnit });
      toast('Gespeichert', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Logo upload
  document.getElementById('upload-logo').addEventListener('click', async () => {
    const fileInput = document.getElementById('s-logo');
    if (!fileInput.files.length) { toast('Bitte eine Datei auswählen', 'error'); return; }
    const fd = new FormData();
    fd.append('logo', fileInput.files[0]);
    try {
      await api('POST', '/api/settings/logo', fd, true);
      toast('Logo hochgeladen', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Logo delete
  document.getElementById('delete-logo')?.addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/settings/logo');
      toast('Logo entfernt', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Eigener Farbwaehler fuer Theme- + Hintergrundfarbe (HSV-Regler <-> Hex)
  bindColorPicker('b-theme');
  bindColorPicker('b-bg');

  // Brand-Form (App-Name + Short-Name + Theme-Color + Background-Color)
  document.getElementById('brand-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const appName = document.getElementById('b-app-name').value.trim();
    const shortName = document.getElementById('b-app-short').value.trim();
    const themeColor = document.getElementById('b-theme').value;
    const bgColor = document.getElementById('b-bg').value;
    try {
      await api('PUT', '/api/settings', {
        app_name: appName,
        app_short_name: shortName,
        theme_color: themeColor,
        background_color: bgColor,
      });
      toast('Branding gespeichert — App wird neu geladen', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) { toast(err.message, 'error'); }
  });

  // Branding zuruecksetzen: verwirft ungespeicherte Aenderungen (Name/Farben/Icon-Auswahl),
  // indem die Settings-Ansicht aus dem zuletzt gespeicherten Stand neu aufgebaut wird.
  document.getElementById('brand-reset')?.addEventListener('click', () => {
    renderSettings();
    toast('Auf gespeicherten Stand zurückgesetzt');
  });

  // App-Icon hochladen
  document.getElementById('upload-app-icon').addEventListener('click', async () => {
    const fileInput = document.getElementById('b-icon');
    if (!fileInput.files.length) { toast('Bitte eine Datei auswaehlen', 'error'); return; }
    const fd = new FormData();
    fd.append('icon', fileInput.files[0]);
    try {
      await api('POST', '/api/settings/app-icon', fd, true);
      toast('Icon hochgeladen — App wird neu geladen', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) { toast(err.message, 'error'); }
  });

  // App-Icon zuruecksetzen
  document.getElementById('delete-app-icon')?.addEventListener('click', async () => {
    if (!(await confirmModal('App-Icon auf Standard zuruecksetzen?', { title: 'App-Icon zurücksetzen', okLabel: 'Zurücksetzen' }))) return;
    try {
      await api('DELETE', '/api/settings/app-icon');
      toast('Icon zurueckgesetzt — App wird neu geladen', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) { toast(err.message, 'error'); }
  });

  // Backup download
  document.getElementById('backup-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/backup/download';
    a.style.display = 'none';
    // Add auth header via fetch
    // Der Name kommt vom Server: verschluesselt heisst die Datei .adbk, sonst .zip. Fest
    // „.zip" hiesse, dass eine verschluesselte Sicherung unter falschem Namen auf der Platte
    // landet und spaeter niemand weiss, was sie ist.
    let name = 'arbeitsdoku_backup.zip';
    fetch('/api/backup/download', { headers: { 'Authorization': 'Bearer ' + S.token } })
      .then(r => {
        const cd = r.headers.get('content-disposition') || '';
        const m = /filename="([^"]+)"/.exec(cd);
        if (m) name = m[1];
        return r.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast('Backup heruntergeladen', 'success');
      })
      .catch(() => toast('Backup-Download fehlgeschlagen', 'error'));
  });

  // Backup restore
  document.getElementById('backup-restore-btn').addEventListener('click', () => {
    document.getElementById('restore-area').style.display = 'block';
  });

  // Verschluesselte Datei gewaehlt? Dann das Schluesselfeld zeigen und sagen, wer sie oeffnen kann.
  document.getElementById('backup-file').addEventListener('change', async (e) => {
    const bereich = document.getElementById('restore-schluessel');
    const datei = e.target.files[0];
    if (!datei) { bereich.style.display = 'none'; return; }
    const kopf = new Uint8Array(await datei.slice(0, 4096).arrayBuffer());
    if (!window.SicherungKrypto || !window.SicherungKrypto.istContainer(kopf)) {
      bereich.style.display = 'none';
      return;
    }
    bereich.style.display = 'block';
    const namen = window.SicherungKrypto.empfaengerNamen(kopf);
    document.getElementById('backup-schluessel-info').textContent = namen.length
      ? `Öffnen können sie: ${namen.join(', ')}. Der Schlüssel wird nur in deinem Browser benutzt und nicht an den Server geschickt.`
      : 'Er wird nur in deinem Browser benutzt und nicht an den Server geschickt.';
  });

  // Das Hilfsprogramm fuer den Ernstfall herunterladen.
  document.getElementById('backup-werkzeug').addEventListener('click', async () => {
    try {
      const antwort = await fetch('/api/backup/entschluesseler', { headers: { Authorization: 'Bearer ' + S.token } });
      if (!antwort.ok) throw new Error('Konnte nicht erzeugt werden');
      const url = URL.createObjectURL(await antwort.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'sicherung-entschluesseln.html';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Heruntergeladen — leg die Datei zum Schlüssel', 'success');
    } catch (err) { toast(err.message || 'Download fehlgeschlagen', 'error'); }
  });

  document.getElementById('restore-confirm').addEventListener('click', async () => {
    const fileInput = document.getElementById('backup-file');
    if (!fileInput.files.length) { toast('Bitte eine Backup-Datei auswählen', 'error'); return; }

    // Verschluesselt? Dann JETZT im Browser oeffnen — der Server bekommt nur das fertige Zip.
    let inhalt = fileInput.files[0];
    const rohkopf = new Uint8Array(await inhalt.slice(0, 4096).arrayBuffer());
    if (window.SicherungKrypto && window.SicherungKrypto.istContainer(rohkopf)) {
      const schluessel = (document.getElementById('backup-schluessel').value || '').trim();
      if (!schluessel) { toast('Diese Sicherung ist verschlüsselt — bitte den Schlüssel einfügen', 'error'); return; }
      try {
        const zip = await window.SicherungKrypto.entschluesseln(
          new Uint8Array(await inhalt.arrayBuffer()), schluessel);
        inhalt = new Blob([zip], { type: 'application/zip' });
      } catch (err) {
        toast(err.message || 'Die Sicherung liess sich nicht öffnen', 'error');
        return;
      }
    }

    if (!(await confirmModal('ACHTUNG: Alle aktuellen Daten werden durch das Backup ersetzt!\n\nEin Sicherungs-Backup wird automatisch erstellt.\n\nFortfahren?', { title: 'Backup einspielen', okLabel: 'Fortfahren' }))) return;

    const fd = new FormData();
    fd.append('backup', inhalt, 'sicherung.zip');
    try {
      const result = await api('POST', '/api/backup/restore', fd, true);
      toast('Backup erfolgreich wiederhergestellt! Seite wird neu geladen...', 'success');
      setTimeout(() => {
        logout();
        location.reload();
      }, 2000);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Audit-Log (nur Admin) ---
const AUDIT_LABELS = {
  login_success: 'Login erfolgreich',
  login_failed: 'Login fehlgeschlagen',
  logout: 'Abmeldung (manuell)',
  session_expired: 'Sitzung abgelaufen (Timeout)',
  settings_update: 'Einstellungen geändert',
  backup_download: 'Backup heruntergeladen',
  backup_restore: 'Backup eingespielt',
  user_create: 'Benutzer angelegt',
  user_update: 'Benutzer geändert',
  alle_abgemeldet: 'Auf allen Geräten abgemeldet',
  datenauskunft: 'Datenauskunft heruntergeladen',
  geburtstag_freigabe: 'Geburtstags-Freigabe geändert',
  avatar_gesetzt: 'Profilbild gesetzt',
  avatar_entfernt: 'Profilbild entfernt',
  twofa_aktiviert: 'Zwei-Faktor aktiviert',
  twofa_wieder_aktiviert: 'Zwei-Faktor wieder aktiviert',
  twofa_schluessel_gewechselt: 'Zwei-Faktor: neuer Schlüssel',
  twofa_neuer_schluessel_begonnen: 'Zwei-Faktor: neuer Schlüssel begonnen',
  user_2fa_reset: 'Zwei-Faktor zurückgesetzt (durch Verwaltung)',
  twofa_deaktiviert: 'Zwei-Faktor abgeschaltet',
  twofa_verify_failed: 'Zwei-Faktor: Code falsch',
  twofa_geraet_entzogen: 'Zwei-Faktor: Gerät entzogen',
  twofa_geraete_entzogen: 'Zwei-Faktor: alle Geräte entzogen',
  login_2fa_noetig: 'Anmeldung: Code angefordert',
  login_2fa_erfolg: 'Anmeldung mit Zwei-Faktor',
  login_2fa_fehlgeschlagen: 'Anmeldung: Code falsch',
  password_self_change: 'Passwort selbst geändert',
  password_self_change_failed: 'Passwort ändern fehlgeschlagen',
  user_password_reset: 'Passwort zurückgesetzt',
  user_deactivate: 'Mitarbeiter ausgestellt',
  user_reactivate: 'Mitarbeiter wiedereingestellt',
  user_delete: 'Benutzer gelöscht',
  vacation_create: 'Urlaubsanspruch angelegt',
  vacation_update: 'Urlaubsanspruch geändert',
  vacation_delete: 'Urlaubsanspruch gelöscht',
  vacation_startcarry_update: 'Start-Resturlaub geändert',
  payroll_export: 'Lohn-Export erzeugt',
  closure_create: 'Abrechnung abgeschlossen',
  closure_reopen: 'Abschluss aufgehoben',
  closure_override: 'Änderung im abgerechneten Zeitraum',
  closure_adjust: 'Nachtrag übernommen',
  closure_discard: 'Nachtrag abgelehnt',
};

let _audit = { action: '', from: '', to: '', logs: [], total: 0, offset: 0, limit: 100 };

function auditRowHtml(l) {
  const label = AUDIT_LABELS[l.action] || l.action;
  const who = l.user_name || l.username || '—';
  return `<tr>
    <td style="white-space:nowrap;">${esc(String(l.ts || '').slice(0, 19))}</td>
    <td>${esc(label)}</td>
    <td>${esc(who)}</td>
    <td style="color:var(--text-light);">${esc(l.details || '')}</td>
    <td style="color:var(--text-lighter);">${esc(l.ip || '')}</td>
  </tr>`;
}
function auditQuery(extra) {
  const p = [];
  if (_audit.action) p.push('action=' + encodeURIComponent(_audit.action));
  if (_audit.from) p.push('from=' + _audit.from);
  if (_audit.to) p.push('to=' + _audit.to);
  return p.concat(extra || []).join('&');
}
async function auditLoad(reset) {
  if (reset) { _audit.offset = 0; _audit.logs = []; }
  const data = await api('GET', '/api/audit?' + auditQuery([`limit=${_audit.limit}`, `offset=${_audit.offset}`]));
  if (!data) return;
  _audit.total = data.total;
  _audit.logs = reset ? data.logs : _audit.logs.concat(data.logs);
  _audit.offset = _audit.logs.length;
}
function auditPaint() {
  const tb = document.getElementById('audit-tbody');
  if (!tb) return;
  tb.innerHTML = _audit.logs.map(auditRowHtml).join('') || '<tr><td colspan="5" style="color:var(--text-light);">Keine Einträge.</td></tr>';
  const st = document.getElementById('audit-status');
  if (st) st.textContent = `${_audit.logs.length} von ${_audit.total} angezeigt`;
  const more = document.getElementById('audit-more');
  if (more) more.style.display = _audit.logs.length < _audit.total ? '' : 'none';
}
async function auditExport() {
  try {
    const res = await fetch('/api/audit/export?' + auditQuery(), { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) { toast('Export fehlgeschlagen', 'error'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('Export fehlgeschlagen', 'error'); }
}

async function renderAudit() {
  if (!isAdmin()) { navigate('/'); return; }
  _audit = { action: '', from: '', to: '', logs: [], total: 0, offset: 0, limit: 100 };
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'audit');
  bindLayout();

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:1000px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:0.5rem;">Audit-Log</h2>
        <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:1rem;">
          Protokoll sicherheitsrelevanter Aktionen (Login, Backup, Benutzerverwaltung). Neueste zuerst.
          Zeiteintrags- und Abwesenheits-Änderungen sind zusätzlich im jeweiligen „Änderungsverlauf" einsehbar.
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:flex-end;margin-bottom:1rem;">
          <div class="form-group" style="margin:0;min-width:170px;">
            <label style="font-size:0.8rem;">Aktion</label>
            <select id="audit-f-action" class="form-control">
              <option value="">Alle Aktionen</option>
              ${Object.entries(AUDIT_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin:0;">
            <label style="font-size:0.8rem;">Von</label>
            <input type="date" id="audit-f-from" class="form-control">
          </div>
          <div class="form-group" style="margin:0;">
            <label style="font-size:0.8rem;">Bis</label>
            <input type="date" id="audit-f-to" class="form-control">
          </div>
          <button class="btn btn-primary btn-sm" id="audit-filter">Filtern</button>
          <button class="btn btn-outline btn-sm" id="audit-export">&#11015; CSV-Export</button>
          <span id="audit-status" style="margin-left:auto;color:var(--text-light);font-size:0.85rem;"></span>
        </div>
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;font-size:0.88rem;">
            <thead><tr><th>Zeit</th><th>Aktion</th><th>Benutzer</th><th>Details</th><th>IP</th></tr></thead>
            <tbody id="audit-tbody"></tbody>
          </table>
        </div>
        <div style="text-align:center;margin-top:1rem;">
          <button class="btn btn-outline btn-sm" id="audit-more" style="display:none;">Mehr laden</button>
        </div>
      </div>
    </div>`;

  document.getElementById('audit-filter').addEventListener('click', async () => {
    _audit.action = document.getElementById('audit-f-action').value;
    _audit.from = document.getElementById('audit-f-from').value;
    _audit.to = document.getElementById('audit-f-to').value;
    try { await auditLoad(true); auditPaint(); } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('audit-more').addEventListener('click', async () => {
    try { await auditLoad(false); auditPaint(); } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('audit-export').addEventListener('click', auditExport);

  try { await auditLoad(true); auditPaint(); } catch (e) { toast(e.message, 'error'); }
}

// --- Gelöschte Einträge (Papierkorb). Chef/Admin: alle; Mitarbeiter: nur selbst gelöschte (Server filtert) ---
async function renderDeletedEntries() {
  if (!S.user) { navigate('/'); return; }
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'deleted-entries');
  bindLayout();

  let data;
  try {
    data = await api('GET', '/api/entries/deleted');
  } catch (e) { toast(e.message, 'error'); return; }

  const entries = (data && data.entries) || [];
  const rows = entries.map(e => {
    const proj = e.project_name || e.project_text || '';
    const suchtext = [e.date, e.user_name, proj, e.deleted_by_name, e.delete_reason].filter(Boolean).join(' ');
    return `<tr data-suchtext="${esc(suchtext)}">
      <td style="white-space:nowrap;">${esc(e.date)}</td>
      <td>${esc(e.user_name)}</td>
      <td style="white-space:nowrap;">${esc(e.time_from)}–${esc(e.time_to)}</td>
      <td>${esc(proj)}</td>
      <td style="color:var(--text-light);">${esc(String(e.deleted_at || '').slice(0, 19))}</td>
      <td>${esc(e.deleted_by_name || '—')}</td>
      <td style="color:var(--text-light);">${esc(e.delete_reason || '')}</td>
      <td><button class="btn btn-outline btn-sm restore-entry" data-id="${e.id}" type="button">Wiederherstellen</button></td>
    </tr>`;
  }).join('');

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:0.5rem;">Gelöschte Einträge</h2>
        <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:1rem;">
          Soft-gelöschte Zeiteinträge bleiben für die Revisionssicherheit (GoBD) erhalten und sind hier einsehbar.
          Wiederherstellen setzt den Eintrag zurück; der Vorgang wird im Änderungsverlauf protokolliert.
        </p>
        ${entries.length ? listenSucheHtml('papierkorb-eintraege', 'Datum, Mitarbeiter, Projekt oder Begründung suchen …') : ''}
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;font-size:0.88rem;">
            <thead><tr>
              <th>Datum</th><th>Mitarbeiter</th><th>Zeit</th><th>Projekt</th>
              <th>Gelöscht am</th><th>Gelöscht von</th><th>Begründung</th><th></th>
            </tr></thead>
            <tbody id="trash-entries-tbody">${rows || '<tr><td colspan="8" style="color:var(--text-light);">Keine gelöschten Einträge.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  bindListenSuche('papierkorb-eintraege', '#trash-entries-tbody');

  mainEl.querySelectorAll('.restore-entry').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Diesen Eintrag wiederherstellen?', { title: 'Wiederherstellen', okLabel: 'Wiederherstellen', danger: false }))) return;
      const reason = await promptModal('Begründung für die Wiederherstellung (optional):', { title: 'Begründung' });
      if (reason === null) return; // Abbrechen → bleibt im Papierkorb
      try {
        await api('POST', '/api/entries/' + btn.dataset.id + '/restore', { reason: reason.trim() });
        toast('Eintrag wiederhergestellt', 'success');
        renderDeletedEntries();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// --- Gelöschte Projekte (Papierkorb). Nur Chef/Admin: wiederherstellen oder endgültig löschen ---
async function renderDeletedProjects() {
  if (!isChefOrAdmin()) { navigate('/'); return; }
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'deleted-projects');
  bindLayout();

  let data;
  try { data = await api('GET', '/api/projects/deleted'); } catch (e) { toast(e.message, 'error'); return; }
  const projects = (data && data.projects) || [];
  const rows = projects.map(p => `<tr>
    <td>${esc(p.name)}</td>
    <td>${esc(p.client || '—')}</td>
    <td>${(p.assigned_users || []).length ? esc(p.assigned_users.map(u => u.name).join(', ')) : '—'}</td>
    <td style="color:var(--text-light);white-space:nowrap;">${esc(String(p.deleted_at || '').slice(0, 19))}</td>
    <td>${esc(p.deleted_by_name || '—')}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-outline btn-sm restore-project" data-id="${p.id}" type="button">Wiederherstellen</button>
      <button class="btn btn-danger btn-sm purge-project" data-id="${p.id}" data-name="${esc(p.name)}" type="button">Endgültig löschen</button>
    </td>
  </tr>`).join('');

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:1000px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:0.5rem;">Gelöschte Projekte</h2>
        <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:1rem;">
          Gelöschte Aufträge liegen im Papierkorb – inkl. Zuweisungen und Zwischenzielen – und lassen sich
          wiederherstellen. <strong>Endgültig löschen</strong> entfernt den Auftrag unwiderruflich; der
          Projektname bleibt in vorhandenen Zeitnachweisen/Planungen als Freitext erhalten (die Statistik
          rechnet die Stunden weiter mit). Nur Chef/Admin.
        </p>
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;font-size:0.88rem;">
            <thead><tr><th>Projekt</th><th>Kunde</th><th>Zugewiesen</th><th>Gelöscht am</th><th>Gelöscht von</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" style="color:var(--text-light);">Keine gelöschten Projekte.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  mainEl.querySelectorAll('.restore-project').forEach(btn => btn.addEventListener('click', async () => {
    if (!(await confirmModal('Dieses Projekt wiederherstellen?', { title: 'Wiederherstellen', okLabel: 'Wiederherstellen', danger: false }))) return;
    try { await api('POST', '/api/projects/' + btn.dataset.id + '/restore'); toast('Projekt wiederhergestellt', 'success'); renderDeletedProjects(); } catch (err) { toast(err.message, 'error'); }
  }));
  mainEl.querySelectorAll('.purge-project').forEach(btn => btn.addEventListener('click', async () => {
    if (!(await confirmModal(`„${btn.dataset.name}" wirklich ENDGÜLTIG löschen?\n\nZuweisungen und Zwischenziele werden unwiderruflich entfernt. Der Projektname bleibt in vorhandenen Zeitnachweisen/Planungen als Freitext erhalten.`, { title: 'Endgültig löschen', okLabel: 'Endgültig löschen', danger: true }))) return;
    try { await api('DELETE', '/api/projects/' + btn.dataset.id + '/purge'); toast('Projekt endgültig gelöscht', 'success'); renderDeletedProjects(); } catch (err) { toast(err.message, 'error'); }
  }));
}

// --- Gelöschte Abwesenheiten (Papierkorb). Chef/Admin: alle; Mitarbeiter: nur selbst gelöschte (Server filtert) ---
async function renderDeletedAbsences() {
  if (!S.user) { navigate('/'); return; }
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'deleted-absences');
  bindLayout();

  let data;
  try {
    data = await api('GET', '/api/absences/deleted/list');
  } catch (e) { toast(e.message, 'error'); return; }

  const absences = (data && data.absences) || [];
  const rows = absences.map(a => {
    const t = ABSENCE_TYPES[a.type];
    const typeLabel = t ? `${t.icon} ${t.label}` : a.type;
    return `<tr data-suchtext="${esc([typeLabel, a.user_name, a.date_from, a.date_to, a.status, a.deleted_by_name, a.delete_reason].filter(Boolean).join(' '))}">
      <td>${esc(typeLabel)}</td>
      <td>${esc(a.user_name || '—')}</td>
      <td style="white-space:nowrap;">${esc(a.date_from)}${a.date_to !== a.date_from ? '–' + esc(a.date_to) : ''}</td>
      <td>${esc(a.status)}</td>
      <td style="color:var(--text-light);">${esc(String(a.deleted_at || '').slice(0, 19))}</td>
      <td>${esc(a.deleted_by_name || '—')}</td>
      <td style="color:var(--text-light);">${esc(a.delete_reason || '')}</td>
      <td>${isAdmin()
        ? `<button class="btn btn-outline btn-sm restore-absence" data-id="${a.id}" type="button">Wiederherstellen</button>`
        : `<button class="btn btn-outline btn-sm reapply-absence" data-id="${a.id}" type="button">Neu beantragen</button>`}</td>
    </tr>`;
  }).join('');

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:0.5rem;">Gelöschte Abwesenheiten</h2>
        <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:1rem;">
          Soft-gelöschte Abwesenheiten (Urlaub, Krankheit, FZA …) bleiben für die Revisionssicherheit (GoBD)
          erhalten. ${isAdmin()
            ? 'Als Admin kannst du sie <strong>wiederherstellen</strong> (sie kommen als bereits genehmigt zurück); der Vorgang wird im Verlauf protokolliert.'
            : 'Sie werden <strong>nicht wiederhergestellt</strong> (das brächte sie als bereits genehmigt zurück) – stattdessen kannst du sie mit „Neu beantragen" als frischen Antrag erneut einreichen, der wieder durch die Genehmigung läuft.'}
        </p>
        ${absences.length ? listenSucheHtml('papierkorb-abwesenheiten', 'Typ, Mitarbeiter, Zeitraum oder Begründung suchen …') : ''}
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;font-size:0.88rem;">
            <thead><tr>
              <th>Typ</th><th>Mitarbeiter</th><th>Zeitraum</th><th>Status</th>
              <th>Gelöscht am</th><th>Gelöscht von</th><th>Begründung</th><th></th>
            </tr></thead>
            <tbody id="trash-absences-tbody">${rows || '<tr><td colspan="8" style="color:var(--text-light);">Keine gelöschten Abwesenheiten.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  bindListenSuche('papierkorb-abwesenheiten', '#trash-absences-tbody');

  mainEl.querySelectorAll('.reapply-absence').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = absences.find(x => String(x.id) === btn.dataset.id);
      if (!a) return;
      // Frischer Antrag mit den alten Daten vorbefüllt → läuft wieder durch die Genehmigung.
      showAbsenceForm(null, a.type, a.date_from, a.date_to, a.comment || '', a.user_id);
    });
  });

  // Admin-Ausnahme: echtes Wiederherstellen (un-delete, kommt als genehmigt zurück).
  mainEl.querySelectorAll('.restore-absence').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Diese Abwesenheit wiederherstellen? Sie kommt als bereits genehmigt zurück.', { title: 'Wiederherstellen', okLabel: 'Wiederherstellen', danger: false }))) return;
      const reason = await promptModal('Begründung für die Wiederherstellung (optional):', { title: 'Begründung' });
      if (reason === null) return; // Abbrechen → bleibt im Papierkorb
      try {
        await api('POST', '/api/absences/' + btn.dataset.id + '/restore', { reason: reason.trim() });
        toast('Abwesenheit wiederhergestellt', 'success');
        renderDeletedAbsences();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// --- Ausgestellte Mitarbeiter (Papierkorb). Chef+Admin; Mitarbeiter haben KEINEN Zugriff ---
async function renderDeletedUsers() {
  if (!canManageUsers()) { navigate('/'); return; }
  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'deleted-users');
  bindLayout();

  let data;
  try {
    data = await api('GET', '/api/users/inactive');
  } catch (e) { toast(e.message, 'error'); return; }

  const users = (data && data.users) || [];
  const rows = users.map(u => `<tr>
      <td>${esc(u.name)}</td>
      <td>${esc(u.username)}</td>
      <td><span class="badge badge-${u.role}">${roleName(u.role)}</span></td>
      <td style="white-space:nowrap;">${esc(u.employed_until || '—')}</td>
      <td style="color:var(--text-light);">${esc(String(u.deactivated_at || '').slice(0, 19))}</td>
      <td>${esc(u.deactivated_by_name || '—')}</td>
      <td class="actions" style="white-space:nowrap;">
        <button class="btn btn-outline btn-sm reactivate-user" data-id="${u.id}" data-name="${esc(u.name)}" type="button">Wiedereinstellen</button>
        <button class="btn btn-danger btn-sm purge-user" data-id="${u.id}" data-name="${esc(u.name)}" type="button">Endgültig löschen</button>
      </td>
    </tr>`).join('');

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;">
      <div class="card">
        <h2 style="margin-bottom:0.5rem;">Ausgestellte Mitarbeiter</h2>
        <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:1rem;">
          Ausgestellte Mitarbeiter können sich nicht mehr anmelden, bleiben aber mit allen Zeiten,
          Abwesenheiten und Planungen erhalten und werden für ihren Anstellungszeitraum weiter in
          Statistik und PDF berücksichtigt. <strong>Wiedereinstellen</strong> reaktiviert den Account ab
          einem Wiedereintrittsdatum (die Lücke zählt 0 Soll-Stunden). <strong>Endgültig löschen</strong>
          entfernt den Mitarbeiter samt aller Daten unwiderruflich.
        </p>
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;font-size:0.88rem;">
            <thead><tr>
              <th>Name</th><th>Benutzername</th><th>Rolle</th><th>Austritt</th>
              <th>Ausgestellt am</th><th>Ausgestellt von</th><th></th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="7" style="color:var(--text-light);">Keine ausgestellten Mitarbeiter.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  mainEl.querySelectorAll('.reactivate-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const today = new Date().toLocaleDateString('sv-SE');
      const startDate = await promptModal(
        `"${btn.dataset.name}" wiedereinstellen. Ab dem Wiedereintrittsdatum läuft die Soll-Stunden-Berechnung wieder; die Zeit der Ausstellung bleibt mit 0 Soll-Stunden erhalten.\n\nWiedereintrittsdatum:`,
        { title: 'Wiedereinstellen', okLabel: 'Wiedereinstellen', multiline: false, inputType: 'date', defaultValue: today, required: true, requiredMsg: 'Bitte ein Wiedereintrittsdatum wählen.' }
      );
      if (startDate === null) return;
      try {
        await api('POST', '/api/users/' + btn.dataset.id + '/reactivate', { start_date: startDate.trim() });
        toast('Mitarbeiter wiedereingestellt', 'success');
        renderDeletedUsers();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  mainEl.querySelectorAll('.purge-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal(
        `"${btn.dataset.name}" wirklich ENDGÜLTIG löschen?\n\nAlle Zeiteinträge, Abwesenheiten, Planungen und Notizen dieses Mitarbeiters werden unwiderruflich entfernt. Das kann nur über ein vollständiges Backup rückgängig gemacht werden.`,
        { title: 'Endgültig löschen', okLabel: 'Endgültig löschen', danger: true }))) return;
      try {
        await api('DELETE', '/api/users/' + btn.dataset.id);
        toast('Mitarbeiter endgültig gelöscht', 'success');
        renderDeletedUsers();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// --- Dokumente (Ablage) ---
function docFileIcon(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx', 'odt'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'ods'].includes(ext)) return '📊';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📈';
  if (['png', 'jpg', 'jpeg'].includes(ext)) return '🖼️';
  if (['txt', 'csv', 'md'].includes(ext)) return '📃';
  return '📎';
}
function docFormatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function downloadDocument(id, name) {
  try {
    const res = await fetch('/api/documents/' + id + '/download', { headers: { 'Authorization': 'Bearer ' + S.token } });
    if (!res.ok) throw new Error('Download fehlgeschlagen');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'dokument';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, 'error'); }
}

// Ordner-Auswahldialog fuer "Verschieben". Liefert Ziel-Ordner-ID (oder null = Wurzel),
// oder undefined bei Abbruch. excludeRootId: Ordner (+ Nachkommen), die nicht waehlbar sind.
async function pickTargetFolder(excludeRootId) {
  let all = [];
  try { all = (await api('GET', '/api/documents/folders/all')).folders || []; }
  catch (e) { toast(e.message, 'error'); return undefined; }

  const exclude = new Set();
  if (excludeRootId) {
    exclude.add(excludeRootId);
    let frontier = [excludeRootId];
    while (frontier.length) {
      const next = [];
      all.forEach(f => { if (frontier.includes(f.parent_id)) { exclude.add(f.id); next.push(f.id); } });
      frontier = next;
    }
  }

  function levelHtml(parentId, depth) {
    let html = '';
    all.filter(f => (f.parent_id || null) === parentId && !exclude.has(f.id)).forEach(f => {
      html += `<button class="doc-picker-item" data-id="${f.id}" style="padding-left:${0.6 + depth * 1.3}rem">📁 ${esc(f.name)}</button>`;
      html += levelHtml(f.id, depth + 1);
    });
    return html;
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <h2>Zielordner wählen</h2>
        <div class="doc-picker-list">
          <button class="doc-picker-item" data-id="">📁 Dokumente (Wurzel)</button>
          ${levelHtml(null, 1)}
        </div>
        <div class="modal-actions"><button class="btn btn-outline" id="doc-picker-cancel">Abbrechen</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const aufraeumen = dialogBarrierefrei(overlay);
    const done = (val) => { overlay.remove(); aufraeumen(); resolve(val); };
    overlay.querySelectorAll('.doc-picker-item').forEach(b => b.addEventListener('click', () => {
      done(b.dataset.id ? Number(b.dataset.id) : null);
    }));
    overlay.querySelector('#doc-picker-cancel').addEventListener('click', () => done(undefined));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(undefined); });
  });
}

async function renderDocuments() {
  const route = getRoute();
  const m = route.match(/^\/documents\/(\d+)/);
  const folderId = m ? Number(m[1]) : null;

  $app().innerHTML = layout('<div class="loading"><div class="spinner"></div></div>', 'documents');
  bindLayout();

  let data;
  try {
    data = await api('GET', '/api/documents' + (folderId ? '?folder_id=' + folderId : ''));
  } catch (e) { toast(e.message, 'error'); return; }

  const manage = isChefOrAdmin() || (S.user && S.user.can_upload);
  const crumbs = [{ id: null, name: 'Dokumente' }].concat(data.breadcrumb || []);
  const breadcrumbHtml = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    return last
      ? `<span class="doc-crumb-current">${esc(c.name)}</span>`
      : `<a href="#/documents${c.id ? '/' + c.id : ''}">${esc(c.name)}</a>`;
  }).join('<span class="doc-crumb-sep"> / </span>');

  const folderRows = (data.folders || []).map(f => `
    <div class="doc-row" data-suchtext="${esc(f.name)}">
      <a class="doc-link" href="#/documents/${f.id}"><span class="doc-icon">📁</span> ${esc(f.name)}</a>
      <span class="doc-meta">${f.subfolder_count} Ordner · ${f.document_count} Dateien</span>
      ${manage ? `<span class="doc-actions">
        <button class="btn btn-sm btn-outline doc-folder-rename" data-id="${f.id}" data-name="${esc(f.name)}">Umbenennen</button>
        <button class="btn btn-sm btn-outline doc-folder-move" data-id="${f.id}" data-name="${esc(f.name)}">Verschieben</button>
        <button class="btn btn-sm btn-danger doc-folder-delete" data-id="${f.id}" data-name="${esc(f.name)}">Löschen</button>
      </span>` : ''}
    </div>`).join('');

  const docRows = (data.documents || []).map(d => {
    const label = d.title || d.original_name;
    return `<div class="doc-row" data-suchtext="${esc([label, d.original_name, d.uploaded_by_name].filter(Boolean).join(' '))}">
      <span class="doc-link"><span class="doc-icon">${docFileIcon(d.original_name)}</span> ${esc(label)}</span>
      <span class="doc-meta">${docFormatSize(d.size)}${d.uploaded_by_name ? ` · ${esc(d.uploaded_by_name)}` : ''}</span>
      <span class="doc-actions">
        <button class="btn btn-sm btn-primary doc-download" data-id="${d.id}" data-name="${esc(d.original_name)}">Herunterladen</button>
        ${manage ? `<button class="btn btn-sm btn-outline doc-rename" data-id="${d.id}" data-name="${esc(d.original_name)}">Umbenennen</button>
        <button class="btn btn-sm btn-outline doc-move" data-id="${d.id}">Verschieben</button>
        <button class="btn btn-sm btn-danger doc-delete" data-id="${d.id}" data-name="${esc(label)}">Löschen</button>` : ''}
      </span>
    </div>`;
  }).join('');

  const st = data.storage || { used: 0, limit: 0 };
  const realPct = st.limit ? Math.round((st.used / st.limit) * 100) : 0;
  const barPct = Math.min(100, realPct);
  const over = realPct >= 90;
  // Belegungsbalken nur fuer Nutzer mit Verwaltungs-/Upload-Recht
  const storageHtml = (manage && st.limit) ? `
    <div class="doc-storage">
      <div class="doc-storage-bar"><div class="doc-storage-fill${over ? ' doc-storage-fill--full' : ''}" style="width:${barPct}%"></div></div>
      <span class="doc-storage-text${realPct > 100 ? ' doc-storage-text--over' : ''}">${docFormatSize(st.used) || '0 B'} / ${docFormatSize(st.limit)} belegt (${realPct}%)${realPct > 100 ? ' — Limit überschritten' : ''}</span>
    </div>` : '';

  const mainEl = document.querySelector('.main');
  mainEl.innerHTML = `
    <div style="max-width:900px;margin:0 auto;">
      <div class="card">
        <div class="doc-breadcrumb">${breadcrumbHtml}</div>
        ${storageHtml}
        ${manage ? `<div class="doc-toolbar">
          <button class="btn btn-sm btn-outline" id="doc-new-folder">+ Neuer Ordner</button>
          <button class="btn btn-sm btn-primary" id="doc-upload-btn">⬆ Datei hochladen</button>
          <input type="file" id="doc-file-input" style="display:none" accept=".pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.png,.jpg,.jpeg,.txt,.csv,.md">
          <span class="doc-toolbar-hint">PDF, Word/Excel/PowerPoint, OpenDocument (odt/ods/odp), PNG, JPG, TXT, CSV, Markdown — max. ${docFormatSize(st.fileLimit || 5 * 1024 * 1024)}</span>
        </div>` : ''}
        ${(folderRows || docRows) ? listenSucheHtml('dokument', 'Ordner oder Datei suchen …') : ''}
        <div class="doc-list">
          ${folderRows}${docRows}
          ${(!folderRows && !docRows) ? '<p class="absence-empty">Dieser Ordner ist leer.</p>' : ''}
        </div>
      </div>
    </div>`;

  bindListenSuche('dokument', '.doc-list');

  // Downloads (alle Rollen)
  mainEl.querySelectorAll('.doc-download').forEach(btn => {
    btn.addEventListener('click', () => downloadDocument(btn.dataset.id, btn.dataset.name));
  });

  if (!manage) return;

  // Neuer Ordner
  document.getElementById('doc-new-folder')?.addEventListener('click', async () => {
    const name = await promptModal('Name des neuen Ordners:', { title: 'Neuer Ordner', multiline: false, required: true });
    if (name === null || !name.trim()) return;
    try {
      await api('POST', '/api/documents/folders', { name: name.trim(), parent_id: folderId });
      renderDocuments();
    } catch (e) { toast(e.message, 'error'); }
  });

  // Ordner umbenennen
  mainEl.querySelectorAll('.doc-folder-rename').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = await promptModal('Neuer Name:', { title: 'Ordner umbenennen', defaultValue: btn.dataset.name, multiline: false, required: true });
      if (name === null || !name.trim()) return;
      try { await api('PUT', '/api/documents/folders/' + btn.dataset.id, { name: name.trim() }); renderDocuments(); }
      catch (e) { toast(e.message, 'error'); }
    });
  });

  // Ordner verschieben
  mainEl.querySelectorAll('.doc-folder-move').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = await pickTargetFolder(Number(btn.dataset.id));
      if (target === undefined) return;
      try { await api('PUT', '/api/documents/folders/' + btn.dataset.id + '/move', { parent_id: target }); renderDocuments(); }
      catch (e) { toast(e.message, 'error'); }
    });
  });

  // Ordner löschen (rekursiv)
  mainEl.querySelectorAll('.doc-folder-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal(`Ordner „${btn.dataset.name}" mit allen Unterordnern und Dokumenten löschen?`, { title: 'Ordner löschen', okLabel: 'Löschen' }))) return;
      try { await api('DELETE', '/api/documents/folders/' + btn.dataset.id); renderDocuments(); }
      catch (e) { toast(e.message, 'error'); }
    });
  });

  // Datei hochladen
  const fileInput = document.getElementById('doc-file-input');
  document.getElementById('doc-upload-btn')?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', async () => {
    if (!fileInput.files.length) return;
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    if (folderId) fd.append('folder_id', folderId);
    try {
      await api('POST', '/api/documents/upload', fd, true);
      toast('Datei hochgeladen', 'success');
      renderDocuments();
    } catch (e) { toast(e.message, 'error'); }
  });

  // Dokument umbenennen (Endung bleibt erhalten)
  mainEl.querySelectorAll('.doc-rename').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cur = btn.dataset.name || '';
      const dot = cur.lastIndexOf('.');
      const base = dot > 0 ? cur.slice(0, dot) : cur;
      const ext = dot > 0 ? cur.slice(dot) : '';
      const name = await promptModal(`Neuer Name${ext ? ' (' + ext + ' bleibt erhalten)' : ''}:`, { title: 'Datei umbenennen', defaultValue: base, multiline: false, required: true });
      if (name === null || !name.trim()) return;
      try { await api('PUT', '/api/documents/' + btn.dataset.id, { name: name.trim() }); renderDocuments(); }
      catch (e) { toast(e.message, 'error'); }
    });
  });

  // Dokument verschieben
  mainEl.querySelectorAll('.doc-move').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = await pickTargetFolder(null);
      if (target === undefined) return;
      try { await api('PUT', '/api/documents/' + btn.dataset.id + '/move', { folder_id: target }); renderDocuments(); }
      catch (e) { toast(e.message, 'error'); }
    });
  });

  // Dokument löschen
  mainEl.querySelectorAll('.doc-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal(`Dokument „${btn.dataset.name}" löschen?`, { title: 'Dokument löschen', okLabel: 'Löschen' }))) return;
      try { await api('DELETE', '/api/documents/' + btn.dataset.id); renderDocuments(); }
      catch (e) { toast(e.message, 'error'); }
    });
  });
}

