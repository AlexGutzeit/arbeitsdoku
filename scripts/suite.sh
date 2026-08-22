#!/usr/bin/env bash
# Laeuft die komplette Testsuite und meldet am Ende das TESTergebnis als Exit-Code.
#
# Zwei Dinge, die hier aus Erfahrung drinstecken:
#
#  1. SPERRE. Zwei gleichzeitig laufende Suiten streiten sich um die festen Testports und
#     schreiben in dasselbe Protokoll — das Ergebnis ist dann wertlos. Am 18.08.2026 liefen
#     versehentlich drei; das Protokoll meldete "248 von 151 durchgelaufen".
#  2. Der Exit-Code kommt vom TESTergebnis, nicht vom letzten Befehl. Vorher meldete ein
#     erfolgreicher Lauf "failed", weil die letzte Zeile eine nicht zutreffende Bedingung war.
#
# Aufruf:  scripts/suite.sh        (Protokoll: /tmp/arbeitsdoku-suite.log)
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${SUITE_LOG:-/tmp/arbeitsdoku-suite.log}"
LOCK="/tmp/arbeitsdoku-suite.lock"

exec 9>"$LOCK"
if ! flock -n 9; then echo "ABBRUCH: es laeuft bereits eine Suite (Sperre $LOCK)"; exit 2; fi

cd "$REPO" || exit 1
: > "$LOG"
echo "START $(date '+%Y-%m-%d %H:%M:%S')  PID $$" >> "$LOG"
gut=0; schlecht=0; kaputt=()
for f in tests/*.js; do
  name=$(basename "$f" .js)
  ausgabe=$(timeout 900 node "$f" 2>&1)
  rc=$?
  echo "===== $name (rc=$rc) =====" >> "$LOG"
  echo "$ausgabe" | tail -4 >> "$LOG"
  if [ $rc -eq 0 ]; then gut=$((gut+1)); else schlecht=$((schlecht+1)); kaputt+=("$name(rc=$rc)"); fi
done
echo "" >> "$LOG"
echo "SUITE FERTIG: $gut ok, $schlecht fehlgeschlagen  ($(date '+%H:%M:%S'))" >> "$LOG"
if [ $schlecht -gt 0 ]; then
  printf 'FEHLGESCHLAGEN: %s\n' "${kaputt[*]}" >> "$LOG"
  tail -3 "$LOG"
  exit 1
fi
tail -2 "$LOG"
exit 0
