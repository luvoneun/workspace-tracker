#!/bin/bash
# 슬랙 채널 히스토리를 JSON으로 가져온다.
# 토큰 위치는 workspace.config.json의 slack.tokenFile에서 읽는다.
#
# 사용법: ./fetch_slack_channel.sh <channel_id> [limit] [oldest_ts]
#   oldest_ts: 주면 그 이후 메시지만 가져온다 (매번 전체를 다시 훑지 않기 위함)
set -euo pipefail

CHANNEL_ID="${1:?channel id required}"
LIMIT="${2:-100}"
OLDEST="${3:-}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${WORKSPACE_CONFIG:-$APP_DIR/../../workspace.config.json}"

if [ ! -f "$CONFIG" ]; then
  echo "설정 파일이 없습니다: $CONFIG" >&2
  exit 1
fi

# 설정에서 토큰 경로를 읽고 ~ 를 홈 디렉터리로 펼친다
TOKEN_FILE=$(python3 -c "
import json, os, sys
with open('$CONFIG') as f:
    cfg = json.load(f)
p = cfg.get('slack', {}).get('tokenFile', '')
print(os.path.expanduser(p))
")

if [ -z "$TOKEN_FILE" ] || [ ! -f "$TOKEN_FILE" ]; then
  echo "슬랙 토큰 파일을 찾을 수 없습니다: ${TOKEN_FILE:-(설정 없음)}" >&2
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE")

URL="https://slack.com/api/conversations.history?channel=${CHANNEL_ID}&limit=${LIMIT}"
if [ -n "$OLDEST" ]; then
  URL="${URL}&oldest=${OLDEST}"
fi

curl -s -H "Authorization: Bearer $TOKEN" "$URL"
