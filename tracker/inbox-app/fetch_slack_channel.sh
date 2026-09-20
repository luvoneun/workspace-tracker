#!/bin/bash
# Fetch every page; failed/partial responses never advance the capture cursor.
set -euo pipefail
CHANNEL_ID="${1:?channel id required}"
LIMIT="${2:-100}"
OLDEST="${3:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="${NODE_BIN:+$NODE_BIN:}$PATH"
exec node "$APP_DIR/slack-history.js" "$CHANNEL_ID" "$LIMIT" "$OLDEST"
