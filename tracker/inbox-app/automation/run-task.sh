#!/bin/bash
# launchd가 부르는 공통 실행기.
# launchd는 PATH가 거의 비어 있어서 실행 파일 경로를 직접 잡아준다.
#
#   run-task.sh <작업이름> <프롬프트> <허용도구> [권한모드] [금지도구]
#
# 4·5번째는 선택이다. 안 주면 예전과 똑같이 동작하므로 캘린더·지라 plist는 고칠 게 없다.

set -uo pipefail

NAME="$1"
PROMPT="$2"
TOOLS="$3"
# acceptEdits는 허용도구 목록과 무관하게 파일 수정을 전부 자동 승인한다. 파일을 고쳐야 하는
# 작업(캘린더·지라)은 그대로 두고, 그럴 필요가 없는 작업만 manual 같은 모드로 부른다.
MODE="${4:-acceptEdits}"
# --allowedTools는 "물어보지 않고 자동 승인할 목록"이지 화이트리스트가 아니다. 확실히 막으려면
# 여기에 적어야 한다(예: Write,Edit). 비워두면 금지 목록 없이 예전과 같다.
DENY="${5:-}"

WORKSPACE="${WORKSPACE_DIR:-$HOME/personal}"
# 로그 폴더는 앱의 상태 탭이 읽는 고정 경로다. 테스트에서만 임시 폴더로 바꿔 끼운다.
LOG_DIR="${AUTOMATION_LOG_DIR:-$HOME/.local/share/workspace-automation/logs}"
LOG="$LOG_DIR/$NAME.log"

# claude가 응답 없이 매달리면 launchd는 그 작업이 끝날 때까지 다음 실행을 시작하지 않는다
# — 한 번 매달리면 그 작업은 영원히 안 돈다. 그래서 제한 시간을 둔다.
# 아래에서 1초씩 세는 방식이라 맥이 잠든 시간은 거의 포함되지 않는다. 로그에 45~66분짜리
# 정상 완료가 있지만 잠든 시간이 섞인 기록이고, 깨어 있는 동안의 정상 실행은 10초~6분이었다.
# 그 5배인 30분으로 잡는다 — 정상 실행을 끊지 않고 "매달린 실행"만 끊는 게 목적이다.
TIMEOUT_SECONDS="${TASK_TIMEOUT_SECONDS:-1800}"
# TERM을 보낸 뒤 스스로 정리할 시간을 주고, 그래도 남으면 KILL 한다.
GRACE_SECONDS="${TASK_KILL_GRACE_SECONDS:-10}"

# launchd는 PATH가 거의 비어 있다. 실행 파일을 찾기 전에 먼저 채워준다.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# 테스트에서 가짜 실행 파일로 바꿔 끼울 수 있게 해둔다. 지정하지 않으면 예전과 같다.
CLAUDE="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

mkdir -p "$LOG_DIR"
cd "$WORKSPACE" || exit 1

# 프로세스 그룹에 좀비가 아닌 프로세스가 아직 남아 있는지 본다.
# (죽은 뒤 아직 수거되지 않은 좀비는 "살아 있음"으로 세면 안 된다)
group_alive() {
  ps -o state= -g "$1" 2>/dev/null | grep -qv '^[[:space:]]*Z'
}

echo "───── $(date '+%Y-%m-%d %H:%M:%S') $NAME 시작" >> "$LOG"

# claude는 MCP 서버 등을 자식 프로세스로 띄운다. 시간이 넘쳤을 때 부모만 죽이면 자식이 남아
# 같은 문제가 반복되므로, set -m(잡 제어)으로 claude를 자기만의 프로세스 그룹에 넣고
# 그룹째 정리한다. 이 맥에는 timeout/gtimeout/setsid가 없어서 bash 기능으로 대신한다.
# 신호는 반드시 우리가 만든 그 그룹(-PID)이나 claude 자신에게만 보낸다 — 프로세스 표를
# 훑어 대상을 고르는 방식은 잘못 고르면 관계없는 프로그램까지 죽이므로 쓰지 않는다.
# 잡 제어를 켜면 백그라운드 잡의 표준 입력이 자동으로 /dev/null이 되지 않아(터미널에서
# 부르면 SIGTTIN으로 멈출 수 있다) 직접 끊어준다 — claude -p는 stdin을 쓰지 않는다.
CLAUDE_ARGS=(-p "$PROMPT" --permission-mode "$MODE" --allowedTools "$TOOLS")
[ -n "$DENY" ] && CLAUDE_ARGS+=(--disallowedTools "$DENY")

set -m
"$CLAUDE" "${CLAUDE_ARGS[@]}" >> "$LOG" 2>&1 </dev/null &
TASK_PID=$!
set +m

# 아래 블록의 stderr만 버리는 이유: 잡 제어로 띄운 잡을 신호로 끝내면 bash가
# "Terminated: 15 ..." 같은 알림을 스크립트 stderr(launchd의 .err 파일)에 찍는다.
# 시간 초과는 우리가 로그에 따로 남기므로 그 알림은 필요 없다.
{
waited=0
timed_out=0
while kill -0 "$TASK_PID" 2>/dev/null; do
  if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then timed_out=1; break; fi
  sleep 1
  waited=$((waited + 1))
done

if [ "$timed_out" -eq 1 ]; then
  echo "" >> "$LOG"
  echo "$(date '+%Y-%m-%d %H:%M:%S') $NAME 시간 초과 (${TIMEOUT_SECONDS}초) — 실행을 강제로 끝냅니다" >> "$LOG"
  kill -TERM -"$TASK_PID" 2>/dev/null || kill -TERM "$TASK_PID" 2>/dev/null
  grace=0
  while [ "$grace" -lt "$GRACE_SECONDS" ] && group_alive "$TASK_PID"; do
    sleep 1
    grace=$((grace + 1))
  done
  if group_alive "$TASK_PID"; then
    kill -KILL -"$TASK_PID" 2>/dev/null || kill -KILL "$TASK_PID" 2>/dev/null
    confirm=0
    while [ "$confirm" -lt 5 ] && group_alive "$TASK_PID"; do
      sleep 1
      confirm=$((confirm + 1))
    done
  fi
  wait "$TASK_PID" 2>/dev/null
  if group_alive "$TASK_PID"; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') $NAME 강제 종료 후에도 남은 프로세스가 있습니다 (그룹 $TASK_PID)" >> "$LOG"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') $NAME 자식 프로세스까지 정리 완료" >> "$LOG"
  fi
  # 정상 종료(0)나 claude 자체의 실패 코드와 구분되는 값으로 알린다.
  STATUS=124
else
  wait "$TASK_PID"
  STATUS=$?
fi
} 2>/dev/null

echo "" >> "$LOG"
echo "───── $(date '+%Y-%m-%d %H:%M:%S') $NAME 종료 (exit $STATUS)" >> "$LOG"

# 로그가 무한정 커지지 않게 최근 2000줄만 남긴다
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exit $STATUS
