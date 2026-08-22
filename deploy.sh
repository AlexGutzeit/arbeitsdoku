#!/bin/bash
set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Fehler: Nur von 'main' deployen! Aktuell auf Branch: $BRANCH"
  echo "Tipp: git checkout main && git merge develop"
  exit 1
fi

# Ziel-Server konfigurierbar über Umgebungsvariablen (oder eine lokale .env.deploy):
#   DEPLOY_HOST     SSH-Ziel, z. B. user@server.example
#   DEPLOY_PATH     Zielverzeichnis auf dem Server
#   DEPLOY_SERVICE  systemd --user Service-Name, der nach dem Sync neu gestartet wird
[ -f .env.deploy ] && . ./.env.deploy
DEPLOY_HOST="${DEPLOY_HOST:-user@server.example}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/user/arbeitsdoku}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-arbeitsdoku}"
# Optional: Verzeichnis der node/npm-Binaries auf dem Server, falls node dort nicht im
# (nicht-interaktiven SSH-)PATH liegt — z. B. ein entpacktes node-Tarball. In .env.deploy setzen.
DEPLOY_NODE_BIN="${DEPLOY_NODE_BIN:-}"

# Optionale ZWEITANLAGE (Rueckfallebene). Sie bekommt denselben Code, wird aber NICHT gestartet:
# Zwei laufende Anlagen auf denselben Daten waeren schlimmer als gar keine Rueckfallebene. Ihr
# Datenstand ist eingefroren; beim Umschalten zuerst die juengste Sicherung einspielen.
DEPLOY_STANDBY_HOST="${DEPLOY_STANDBY_HOST:-}"
DEPLOY_STANDBY_PATH="${DEPLOY_STANDBY_PATH:-$DEPLOY_PATH}"
DEPLOY_STANDBY_NODE_BIN="${DEPLOY_STANDBY_NODE_BIN:-}"

if [ "$DEPLOY_HOST" = "user@server.example" ]; then
  echo "Fehler: DEPLOY_HOST nicht gesetzt. Beispiel:"
  echo "  DEPLOY_HOST=user@server DEPLOY_PATH=/home/user/arbeitsdoku ./deploy.sh"
  echo "  (oder Werte in eine lokale, nicht eingecheckte .env.deploy schreiben)"
  exit 1
fi

# ── Zweitanlage nachziehen ────────────────────────────────────────────────────────────────────
# Damit im Zweifel umgeschaltet werden kann, OHNE erst eine alte Fassung vorzufinden. Nur Dateien:
# kein Dienst-Neustart, kein /health — die Anlage soll ja gerade NICHT laufen.
# Schlaegt es fehl (Rechner aus), ist das eine Warnung, kein Fehler: Die Hauptanlage steht bereits.
standby_nachziehen() {
  [ -n "$DEPLOY_STANDBY_HOST" ] || return 0
  echo
  echo "Ziehe die Zweitanlage nach: $DEPLOY_STANDBY_HOST:$DEPLOY_STANDBY_PATH ..."
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEPLOY_STANDBY_HOST" true 2>/dev/null; then
    echo "WARNUNG: $DEPLOY_STANDBY_HOST ist nicht erreichbar — Zweitanlage bleibt auf altem Stand."
    return 0
  fi
  rsync -az --delete public/ "$DEPLOY_STANDBY_HOST:$DEPLOY_STANDBY_PATH/public/" &&
  rsync -az database/ "$DEPLOY_STANDBY_HOST:$DEPLOY_STANDBY_PATH/database/" &&
  rsync -az routes/ "$DEPLOY_STANDBY_HOST:$DEPLOY_STANDBY_PATH/routes/" &&
  rsync -az middleware/ "$DEPLOY_STANDBY_HOST:$DEPLOY_STANDBY_PATH/middleware/" &&
  rsync -az $STAMMDATEIEN "$DEPLOY_STANDBY_HOST:$DEPLOY_STANDBY_PATH/" &&
  ssh "$DEPLOY_STANDBY_HOST" "${DEPLOY_STANDBY_NODE_BIN:+export PATH=\"$DEPLOY_STANDBY_NODE_BIN:\$PATH\"; }cd $DEPLOY_STANDBY_PATH && npm install --omit=dev --no-audit --no-fund >/dev/null" ||
  { echo "WARNUNG: Die Zweitanlage konnte nicht vollstaendig nachgezogen werden."; return 0; }

  # STARTPROBE. Dateien kopiert zu haben heisst nicht, dass die Anlage im Ernstfall hochkommt —
  # eine vergessene Datei oder eine andere Node-Fassung faellt sonst erst auf, wenn man sie braucht.
  # Deshalb hier ein Probestart, der NICHTS anfasst:
  #   * eigener Port (3999), damit nichts mit dem echten Dienst kollidiert
  #   * KOPIE der Datenbank in /tmp, die echte bleibt unberuehrt
  #   * VAPID leer -> der Zeitplaner kann keine Push-Meldungen verschicken
  # Danach wird der Probelauf beendet und die Kopie geloescht.
  echo "Probestart auf der Zweitanlage ..."
  # Wichtig: den Hintergrundstart NICHT an eine &&-Kette haengen. `cd … && cp … && node … &`
  # schiebt die GANZE Kette in den Hintergrund, und $! ist dann die Nummer der Kette statt die
  # von node — der kill danach trifft ins Leere und der Probelauf bleibt stehen (so geschehen).
  if ssh "$DEPLOY_STANDBY_HOST" "${DEPLOY_STANDBY_NODE_BIN:+export PATH=\"$DEPLOY_STANDBY_NODE_BIN:\$PATH\"; }
      set -e
      cd $DEPLOY_STANDBY_PATH
      cp data/arbeitsdoku.db /tmp/startprobe.db
      set +e
      PORT=3999 DB_PATH=/tmp/startprobe.db VAPID_PUBLIC= VAPID_PRIVATE= VAPID_SUBJECT= nohup node server.js >/tmp/startprobe.log 2>&1 &
      probe_pid=\$!
      sleep 6
      erg=\$(curl -sf -m 5 http://localhost:3999/health || echo FEHLER)
      kill \$probe_pid 2>/dev/null
      sleep 2
      # Sicherheitsnetz: falls doch etwas auf dem Port haengt, gezielt ueber den Port beenden.
      rest=\$(ss -lntp 2>/dev/null | grep ':3999' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
      [ -n \"\$rest\" ] && kill \$rest 2>/dev/null
      sleep 1
      rm -f /tmp/startprobe.db
      offen=\$(ss -lnt 2>/dev/null | grep -c ':3999')
      [ \"\$offen\" = 0 ] || echo '  WARNUNG: Probelauf haengt noch auf Port 3999'
      [ \"\$erg\" != FEHLER ] && echo \"  Probestart ok: \$erg\" || { echo '  Probestart FEHLGESCHLAGEN'; tail -5 /tmp/startprobe.log; exit 1; }"; then
    echo "Zweitanlage steht auf demselben Stand und startet (Dienst bleibt bewusst aus)."
  else
    echo "WARNUNG: Die Zweitanlage hat die Dateien, startet damit aber NICHT. Im Ernstfall waere sie unbrauchbar."
  fi
}

echo "Deploye auf $DEPLOY_HOST:$DEPLOY_PATH ..."
git push
rsync -az --delete public/ "$DEPLOY_HOST:$DEPLOY_PATH/public/"
rsync -az database/ "$DEPLOY_HOST:$DEPLOY_PATH/database/"
rsync -az routes/ "$DEPLOY_HOST:$DEPLOY_PATH/routes/"
rsync -az middleware/ "$DEPLOY_HOST:$DEPLOY_PATH/middleware/"
# ACHTUNG: Dies ist eine FESTE Liste — eine neue Datei im Projektstamm landet sonst NICHT auf dem
# Server, und der Dienst startet nach dem Neustart gar nicht mehr (require schlaegt fehl).
# Beim Anlegen einer neuen Datei hier eintragen. Die Probe unten (--pruefen) faengt es ab.
STAMMDATEIEN="server.js audit.js push.js sse.js scheduler.js planning-recurrence.js csv.js zeit.js abschluss.js totp.js geheimnis.js zweifaktor.js .puppeteerrc.cjs package.json package-lock.json"
rsync -az $STAMMDATEIEN "$DEPLOY_HOST:$DEPLOY_PATH/"
# Produktions-Dependencies abgleichen (z. B. neu hinzugekommenes web-push). --omit=dev laesst
# Puppeteer & Co. aussen vor; ist nichts zu tun, ist der Schritt praktisch ein No-op.
ssh "$DEPLOY_HOST" "${DEPLOY_NODE_BIN:+export PATH=\"$DEPLOY_NODE_BIN:\$PATH\"; }cd $DEPLOY_PATH && npm install --omit=dev --no-audit --no-fund"
ssh "$DEPLOY_HOST" "systemctl --user restart $DEPLOY_SERVICE"

# Nachsehen, ob der Dienst wirklich wieder da ist. Ohne diese Probe meldet das Skript auch dann
# "erfolgreich", wenn der Server nach dem Neustart gar nicht mehr hochkommt — etwa weil eine neue
# Datei im Projektstamm oben in der festen Liste fehlt.
echo "Warte auf den Dienst ..."
gesund=0
for i in $(seq 1 20); do
  if ssh "$DEPLOY_HOST" "curl -sf -o /dev/null http://localhost:3000/health" 2>/dev/null; then
    gesund=1; break
  fi
  sleep 2
done
if [ "$gesund" = "1" ]; then
  echo "Erfolgreich deployed. (/health antwortet)"
  standby_nachziehen
  exit 0
fi
{
  echo "FEHLER: Der Dienst antwortet nach 40 s nicht auf /health."
  echo "Protokoll ansehen mit:"
  echo "  ssh $DEPLOY_HOST 'journalctl --user -u $DEPLOY_SERVICE -n 40 --no-pager'"
  exit 1
}

