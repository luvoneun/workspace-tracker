#!/bin/bash
# launchd가 부르는 공통 실행기.
# launchd는 PATH가 거의 비어 있어서 실행 파일 경로를 직접 잡아준다.
#
#   run-task.sh <작업이름> <프롬프트> <허용도구>

set -uo pipefail

NAME="$1"
PROMPT="$2"
TOOLS="$3"

WORKSPACE="${WORKSPACE_DIR:-$HOME/personal}"
LOG_DIR="$HOME/.local/share/workspace-automation/logs"
LOG="$LOG_DIR/$NAME.log"

# launchd는 PATH가 거의 비어 있다. 실행 파일을 찾기 전에 먼저 채워준다.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"

mkdir -p "$LOG_DIR"
cd "$WORKSPACE" || exit 1

echo "───── $(date '+%Y-%m-%d %H:%M:%S') $NAME 시작" >> "$LOG"
"$CLAUDE" -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools "$TOOLS" >> "$LOG" 2>&1
STATUS=$?
echo "" >> "$LOG"
echo "───── $(date '+%Y-%m-%d %H:%M:%S') $NAME 종료 (exit $STATUS)" >> "$LOG"

# 로그가 무한정 커지지 않게 최근 2000줄만 남긴다
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exit $STATUS
