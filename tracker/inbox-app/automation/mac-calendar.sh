#!/bin/bash
# 캘린더 `맥 캘린더` 갈래 — 맥 기본 캘린더 앱의 오늘 일정을 읽어 tracker/calendar_today.md에 쓴다(Claude 없이).
# launchd가 설치 위치 복사본으로 부른다:
#   mac-calendar.sh run  — com.workspace.app.mac-calendar(매일 8–20시 30분마다 + 등록될 때 한 번). 맥 캘린더 갈래일 때만 읽는다.
#   mac-calendar.sh now  — com.workspace.app.mac-calendar-now(요청 파일 requests/mac-calendar.request가 바뀌면 한 번).
#                          앱의 `허용하고 확인`(mode=check — 스냅샷은 쓰지 않는다)·`지금 가져오기`가 그 파일을 쓴다.
# 읽기·기록·60초 제한은 전부 calendar-mac.js(node)가 한다 — osascript는 그 node가 직접 띄운 자식 하나이고,
# 제한 시간이 넘으면 그 자식에게만 신호를 보낸다. 이 셸은 프로세스를 끝내는 일을 하지 않는다.

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

MODE="${1:-run}"
case "$MODE" in
  run|now) ;;
  *) MODE="run" ;;
esac

# launchd는 PATH가 거의 비어 있다. 실행 파일을 찾기 전에 먼저 채워 준다(slack-capture.sh와 같은 자리).
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="${PATH:+$PATH:}${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "node를 찾지 못했어요" >&2
  exit 1
fi

cd "$WORKSPACE" || exit 1
exec "$NODE" "$WORKSPACE/tracker/inbox-app/calendar-mac.js" "$MODE"
