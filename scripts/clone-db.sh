#!/bin/bash
set -e

# Quelle konfigurierbar (oder lokale .env.deploy):
#   DEPLOY_HOST  SSH-Ziel,  DEPLOY_PATH  Projektverzeichnis auf dem Server
[ -f .env.deploy ] && . ./.env.deploy
DEPLOY_HOST="${DEPLOY_HOST:-user@server.example}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/user/arbeitsdoku}"

if [ "$DEPLOY_HOST" = "user@server.example" ]; then
  echo "Fehler: DEPLOY_HOST nicht gesetzt (z. B. in .env.deploy)."
  exit 1
fi

mkdir -p data
echo "Kopiere Datenbank von $DEPLOY_HOST..."
scp "$DEPLOY_HOST:$DEPLOY_PATH/data/arbeitsdoku.db" ./data/local.db
echo "Anonymisiere Passwörter..."
node scripts/anonymize-db.js
