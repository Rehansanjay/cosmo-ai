#!/bin/bash
# Launch Cartographer with voice.
#
#   ./run.sh              talk to it (mic)
#   ./run.sh --demo       self-driving: connects and types a seed idea for you
#   ./run.sh --websocket  talk to the local one-process OSS server
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

DEMO=0
WEBSOCKET=0
for ARG in "$@"; do
  case "$ARG" in
    --demo) DEMO=1 ;;
    --websocket) WEBSOCKET=1 ;;
    *) echo "usage: $0 [--demo] [--websocket]" >&2; exit 2 ;;
  esac
done

# No credential check here: the SDK resolves COSMO_API_KEY or the
# `cosmo login` credentials file itself, and reports what is missing.
[ -d "$ROOT/build/Cartographer.app" ] || "$ROOT/bundle.sh"

if [ "$WEBSOCKET" = "1" ]; then
  export COSMO_TRANSPORT=websocket
  export COSMO_BASE_URL="${COSMO_BASE_URL:-http://localhost:8080}"
  export COSMO_API_KEY=local
fi

if [ "$DEMO" = "1" ]; then
  export CARTO_AUTOSTART=1
  export CARTO_SEED="I want to start a small weekend bakery. I'm torn between sourdough bread and laminated pastries. Bread needs a big oven and long overnight proofs, pastry needs a sheeter and a cold room. Money is the real constraint, and I only have Saturdays and Sundays."
fi

exec "$ROOT/build/Cartographer.app/Contents/MacOS/Cartographer"
