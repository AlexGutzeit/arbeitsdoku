#!/bin/bash
set -e

mkdir -p data
echo "Kopiere Datenbank vom Mini-PC..."
scp alexg@10.83.27.2:/home/alexg/arbeitsdoku/data/arbeitsdoku.db ./data/local.db
echo "Anonymisiere Passwörter..."
node scripts/anonymize-db.js
