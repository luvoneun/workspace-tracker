#!/bin/bash
# Fetch every page; failed/partial responses never advance the capture cursor.
set -euo pipefail
CHANNEL_ID="${1:?channel id required}"
LIMIT="${2:-100}"
OLDEST="${3:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# nvm이 없는 맥(nodejs.org로 설치)에서는 ls가 실패한다 — set -e·pipefail 때문에 여기서 말없이 exit 1로
# 끝나던 것(동료 맥에서 슬랙 수집이 4채널 모두 멈춘 원인). 못 찾으면 빈 값으로 넘어간다.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
export PATH="${NODE_BIN:+$NODE_BIN:}$PATH"
exec node "$APP_DIR/slack-history.js" "$CHANNEL_ID" "$LIMIT" "$OLDEST"
