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

if [ "$DEPLOY_HOST" = "user@server.example" ]; then
  echo "Fehler: DEPLOY_HOST nicht gesetzt. Beispiel:"
  echo "  DEPLOY_HOST=user@server DEPLOY_PATH=/home/user/arbeitsdoku ./deploy.sh"
  echo "  (oder Werte in eine lokale, nicht eingecheckte .env.deploy schreiben)"
  exit 1
fi

echo "Deploye auf $DEPLOY_HOST:$DEPLOY_PATH ..."
git push
rsync -az --delete public/ "$DEPLOY_HOST:$DEPLOY_PATH/public/"
rsync -az database/ "$DEPLOY_HOST:$DEPLOY_PATH/database/"
rsync -az routes/ "$DEPLOY_HOST:$DEPLOY_PATH/routes/"
rsync -az middleware/ "$DEPLOY_HOST:$DEPLOY_PATH/middleware/"
rsync -az server.js audit.js push.js sse.js scheduler.js planning-recurrence.js .puppeteerrc.cjs package.json package-lock.json "$DEPLOY_HOST:$DEPLOY_PATH/"
# Produktions-Dependencies abgleichen (z. B. neu hinzugekommenes web-push). --omit=dev laesst
# Puppeteer & Co. aussen vor; ist nichts zu tun, ist der Schritt praktisch ein No-op.
ssh "$DEPLOY_HOST" "${DEPLOY_NODE_BIN:+export PATH=\"$DEPLOY_NODE_BIN:\$PATH\"; }cd $DEPLOY_PATH && npm install --omit=dev --no-audit --no-fund"
ssh "$DEPLOY_HOST" "systemctl --user restart $DEPLOY_SERVICE"
echo "Erfolgreich deployed."
