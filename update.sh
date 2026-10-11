#!/usr/bin/env bash
# Fahrtenbuch aktualisieren: neuesten Stand von GitHub holen und neu starten.
# Die Datenbank in data/ wird dabei nicht angefasst.
set -euo pipefail
cd "$(dirname "$0")"
cp data/fahrtenbuch.db "data/fahrtenbuch.backup-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null || true
git pull --ff-only
npm install --omit=dev
systemctl restart fahrtenbuch
echo "Fahrtenbuch aktualisiert ✓"
