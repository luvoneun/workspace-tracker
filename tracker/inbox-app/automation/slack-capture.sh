#!/bin/bash
# 슬랙 캡처는 5분마다 도는데(launchd StartInterval 300초) 대부분은 가져올 게 없다.
# 먼저 새 메시지가 있는지 확인하고(slack-collect.js), 있을 때만 Claude를 부른다 — 분류만, 도구 없이.
# (확인만 한 경우에도 checkedAt은 남겨서, 캡처가 멈추면 앱이 알아챌 수 있게 한다)

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
APP="$WORKSPACE/tracker/inbox-app"
STATE="$APP/.slack_capture_state.json"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
# 로그·잠금 폴더는 앱의 연동 카드(상태 줄·최근 기록)가 읽는 고정 경로다. 테스트에서만 임시 폴더로 바꿔 끼운다.
LOG_DIR="${AUTOMATION_LOG_DIR:-$HOME/.local/share/workspace-automation/logs}"
LOG="$LOG_DIR/slack-capture.log"
LOCK_DIR="$LOG_DIR/.slack-capture.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
LOCK_OWNED=0

mkdir -p "$LOG_DIR"
cd "$WORKSPACE" || exit 1

CONFIG="${WORKSPACE_CONFIG:-$WORKSPACE/workspace.config.json}"
# 앱의 연동 탭에서 슬랙 수집을 껐으면 여기서 멈춘다 — 껐는데 5분마다 계속 도는 일이 없게.
# 칸이 없으면 켜진 것으로 본다(서버 USES·setup.sh와 같은 규칙). 설정을 읽지 못하면 예전처럼 진행한다.
if [ "$("$NODE" -e '
const fs = require("fs");
try {
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  const uses = (config && config.integrations) || {};
  process.stdout.write(uses.slack === false ? "off" : "on");
} catch (error) { process.stdout.write("on"); }
' "$CONFIG" 2>/dev/null)" = "off" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') 슬랙 수집이 꺼져 있어 건너뛰어요" >> "$LOG"
  exit 0
fi

# 5분마다 깨어나는 방식이라, 여기서 시간대(9~19시)인지 직접 판단해서 아니면 조용히 빠진다.
# 평일만 도는 줄 알았는데 주말에도 돌게 해달라고 하셔서 요일 제한은 뺐다 — 시간대만 본다.
# (테스트에서만 SLACK_CAPTURE_IGNORE_HOURS=1로 이 판단을 끄고, SLACK_CAPTURE_TEST_HOUR로 지금 시각을 끼운다)
# 앱의 `지금 가져오기`로 부른 실행(launchd `slack-capture-now`가 SLACK_CAPTURE_MANUAL=1을 준다)은 사람이
# 지금 원한 것이라 시간대를 보지 않는다. 연동 끔 검사(위)와 잠금(아래)은 그대로다 — 5분 주기 실행과 겹치면
# 잠금으로 한쪽만 돈다. SLACK_CAPTURE_MANUAL은 slack-collect.js까지 그대로 내려가 실패 줄에 `(지금 가져오기)`를 붙인다.
# 시간대 값은 서버의 SLACK_CAPTURE_HOURS(쉬는 시간이면 카드가 `대기 중`)와 같아야 한다 — automation.test.js가 맞춰 본다.
CAPTURE_FROM=9
CAPTURE_UNTIL=19
if [ "${SLACK_CAPTURE_IGNORE_HOURS:-0}" != "1" ] && [ "${SLACK_CAPTURE_MANUAL:-0}" != "1" ]; then
  hour=$((10#${SLACK_CAPTURE_TEST_HOUR:-$(date '+%H')}))
  if [ "$hour" -lt "$CAPTURE_FROM" ] || [ "$hour" -ge "$CAPTURE_UNTIL" ]; then
    exit 0
  fi
fi

# 직전 실행이 아직 안 끝났으면(캡처가 오래 걸리는 중) 겹쳐 돌지 않게 건너뛴다.
# macOS 기본 bash엔 flock이 없어서 mkdir의 원자성으로 잠금을 대신한다.
#
# 예전엔 "잠금이 30분 넘었으면 죽은 것으로 보고 삭제"였는데, 이건 두 방향 모두 틀린다.
#  - 캡처가 30분 넘게 정상적으로 도는 중이어도 다음 실행이 잠금을 뺏어 겹쳐 돈다.
#  - 반대로 잠금을 쥔 채 죽은 경우엔 30분 동안 아무것도 못 한다.
# 그래서 시간 대신 "주인이 아직 살아 있는 이 스크립트인가"를 직접 확인한다.

# PID는 재사용된다(다른 프로그램이 같은 번호를 물려받을 수 있다). 번호만 보고 살아 있다고
# 판단하면 엉뚱한 프로세스 때문에 캡처가 영원히 멈추므로, 명령줄까지 같이 확인한다.
holder_is_capture() {
  case "$(ps -o command= -p "$1" 2>/dev/null)" in
    *slack-capture*) return 0 ;;
    *) return 1 ;;
  esac
}

# 죽은 주인이 남긴 잠금 회수. "확인 → 삭제" 사이에 다른 실행이 새 잠금을 잡을 수 있으므로,
# 회수 자체를 또 하나의 mkdir(원자적)로 감싸서 한 번에 한 명만 하게 한다.
reclaim_lock() {
  local seen="$1" guard="$LOCK_DIR.reclaim" current
  if ! mkdir "$guard" 2>/dev/null; then
    # 회수는 1초도 안 걸린다. 표시가 오래 남아 있으면 회수 도중에 죽은 흔적이라 치운다.
    if [ -n "$(find "$guard" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rm -rf "$guard"; fi
    return 1
  fi
  current=$(cat "$LOCK_PID_FILE" 2>/dev/null)
  # 내가 보던 그 죽은 잠금일 때만 지운다. 그 사이 다른 실행이 새로 잡았으면 건드리지 않는다.
  if [ "$current" = "$seen" ]; then rm -rf "$LOCK_DIR"; fi
  rmdir "$guard" 2>/dev/null
  return 0
}

acquire_lock() {
  local attempt=0 holder
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_PID_FILE"
      LOCK_OWNED=1
      return 0
    fi
    holder=$(cat "$LOCK_PID_FILE" 2>/dev/null)
    if [ -n "$holder" ] && holder_is_capture "$holder"; then
      return 1
    fi
    if [ -z "$holder" ] && [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      # 잠금 폴더는 생겼는데 pid를 아직 못 쓴 찰나일 수 있다. 방금 생긴 잠금은 살아 있다고 본다.
      return 1
    fi
    # 주인이 죽었거나 남의 프로세스다 — 회수하고 다시 잡아본다.
    # 다른 실행이 먼저 회수 중이면 그쪽에 양보하고 이번 턴은 건너뛴다.
    reclaim_lock "$holder" || return 1
  done
  return 1
}

release_lock() {
  # 내가 만든 잠금만 푼다 — 남이 쥐고 있는 잠금은 절대 지우지 않는다.
  [ "$LOCK_OWNED" -eq 1 ] || return 0
  [ "$(cat "$LOCK_PID_FILE" 2>/dev/null)" = "$$" ] || return 0
  rm -f "$LOCK_PID_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null
}

trap release_lock EXIT
if ! acquire_lock; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') 이전 실행이 아직 진행 중 — 건너뜀" >> "$LOG"
  exit 0
fi

# 여기부터는 slack-collect.js 한 번이다(Node 기본 모듈만). 가져오기·원본 스레드 읽기·저장·커서·상태 기록은
# 그 스크립트가 하고, Claude는 도구 없이 분류만 한다 — Claude가 Bash로 조회·등록 명령을 부르던 예전 방식은
# Claude Code 버전과 명령 모양에 따라 허용 목록 검사("자동 분류기")에 막혀 수집이 통째로 멈췄다.
#  - 새 메시지가 없으면 Claude를 부르지 않는다("새 메시지 없음 — Claude 호출 생략" 한 줄).
#  - 뺀 채널(`off: true`)은 읽지 않고, 어디서부터는 커서와 `since` 중 큰 값이다.
#  - 채널 확인 실패는 "<my-키> 채널 확인 실패 — 이유" 한 줄, 처리한 회차는 시작/종료 블록 하나로 남긴다.
# 토큰은 설정의 tokenFile을 node가 읽는다(bash의 [ -f ]/cat이 launchd 밑에서 막히는 맥이 있었다).
# Claude 호출은 이 스크립트 옆(설치 위치)의 run-task.sh로 한다 — 시간 제한·로그인 토큰·모델 고정을 그대로 쓴다.
"$NODE" "$APP/slack-collect.js" "$CONFIG" "$STATE" "$LOG" "$HOME/.local/share/workspace-automation/run-task.sh"
status=$?
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit "$status"
