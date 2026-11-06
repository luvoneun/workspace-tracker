#!/bin/bash
# 회의 녹음 전사·요약 — launchd `com.workspace.app.meeting-transcribe`(요청 파일 requests/meeting-transcribe.request가
# 바뀌면 한 번)가 설치 위치 복사본으로 부른다. 앱 서버는 요청 파일만 쓴다(프로세스를 띄우지 않는다).
# 할 일은 전부 tracker/inbox-app/meeting-transcribe.js(node)가 한다 — ffmpeg·whisper·sherpa·claude는 그 node가 직접 띄운
# 자식이고, 제한 시간이 넘으면 그 자식에게만 신호를 보낸다. 이 셸은 프로세스를 끝내는 일을 하지 않는다.

set -uo pipefail

# 설치 위치는 사람마다 다르다(run-task.sh와 같은 규칙): WORKSPACE_DIR → workspace.env → 멈춤.
if [ -z "${WORKSPACE_DIR:-}" ]; then
  WORKSPACE_ENV="${WORKSPACE_ENV_FILE:-$HOME/.local/share/workspace-automation/workspace.env}"
  # shellcheck source=/dev/null
  [ -f "$WORKSPACE_ENV" ] && . "$WORKSPACE_ENV"
fi
WORKSPACE="${WORKSPACE_DIR:-}"
if [ -z "$WORKSPACE" ]; then
  echo "설치 정보를 찾을 수 없어요 — setup.sh를 먼저 실행해 주세요" >&2
  exit 1
fi

# launchd는 PATH가 거의 비어 있다(run-task.sh와 같은 자리).
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "node를 찾지 못했어요" >&2
  exit 1
fi

# 요약에 쓰는 Claude — 백그라운드에서 로그인 갱신이 안 되는 맥은 앱에 붙여 둔 토큰을 쓴다(run-task.sh와 같은 파일).
# 값은 로그·화면에 남기지 않는다.
CLAUDE_TOKEN_FILE="${WORKSPACE_CLAUDE_TOKEN_FILE:-$HOME/.config/workspace-claude-token}"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$CLAUDE_TOKEN_FILE" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$CLAUDE_TOKEN_FILE")"
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && export CLAUDE_CODE_OAUTH_TOKEN || unset CLAUDE_CODE_OAUTH_TOKEN
fi

cd "$WORKSPACE" || exit 1
exec "$NODE" "$WORKSPACE/tracker/inbox-app/meeting-transcribe.js"
