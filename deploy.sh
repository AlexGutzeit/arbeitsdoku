#!/bin/bash
set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Fehler: Nur von 'main' deployen! Aktuell auf Branch: $BRANCH"
  echo "Tipp: git checkout main && git merge develop"
  exit 1
fi

echo "Deploye auf Produktion (Mini-PC)..."
git push
rsync -az --delete public/ alexg@10.83.27.2:/home/alexg/arbeitsdoku/public/
rsync -az database/ alexg@10.83.27.2:/home/alexg/arbeitsdoku/database/
rsync -az routes/ alexg@10.83.27.2:/home/alexg/arbeitsdoku/routes/
rsync -az middleware/ alexg@10.83.27.2:/home/alexg/arbeitsdoku/middleware/
rsync -az server.js audit.js .puppeteerrc.cjs package.json package-lock.json alexg@10.83.27.2:/home/alexg/arbeitsdoku/
ssh alexg@10.83.27.2 "systemctl --user restart arbeitsdoku"
echo "Erfolgreich deployed."
