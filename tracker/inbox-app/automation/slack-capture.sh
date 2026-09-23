#!/bin/bash
# 슬랙 캡처는 5분마다 도는데(launchd StartInterval 300초) 대부분은 가져올 게 없다.
# curl로 먼저 새 메시지가 있는지만 확인하고, 있을 때만 Claude를 부른다.
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
# 로그·잠금 폴더는 앱 상태 탭이 읽는 고정 경로다. 테스트에서만 임시 폴더로 바꿔 끼운다.
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
# (테스트에서만 SLACK_CAPTURE_IGNORE_HOURS=1로 이 판단을 끈다)
# 앱의 `지금 가져오기`로 부른 실행(launchd `slack-capture-now`가 SLACK_CAPTURE_MANUAL=1을 준다)은 사람이
# 지금 원한 것이라 시간대를 보지 않는다. 연동 끔 검사(위)와 잠금(아래)은 그대로다 — 5분 주기 실행과 겹치면
# 잠금으로 한쪽만 돈다.
if [ "${SLACK_CAPTURE_IGNORE_HOURS:-0}" != "1" ] && [ "${SLACK_CAPTURE_MANUAL:-0}" != "1" ]; then
  hour=$(date '+%H')
  if [ "$hour" -lt 9 ] || [ "$hour" -ge 19 ]; then
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

# launchd가 백그라운드로 부를 때 이 컴퓨터의 python3가 가끔
# "PermissionError: Operation not permitted"로 조용히 막혀서(2>/dev/null에 삼켜짐)
# CHANNELS가 통째로 비어버리고, 그러면 아무 채널도 확인 안 하고 매번 "새 메시지 없음"으로
# 끝나버렸다 — 실제로 몇 시간씩 못 가져온 원인이 이거였다. 이미 잘 되던 node로 바꾼다.
CHANNELS=$("$NODE" -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
const ch = (c.slack && c.slack.channels) || {};
process.stdout.write(Object.entries(ch).map(([k, v]) => v.id + ':my-' + k).join(' '));
" 2>>"$LOG")

# 토큰 파일도 bash의 [ -f ]/cat이 아니라 node로 읽는다 — 같은 Desktop 밑 파일인데도
# node로 읽은 workspace.config.json은 되고 bash 내장 test/cat으로 읽은 .slack_token은
# launchd 밑에서 "파일 없음"으로 막히는 게 실제로 관찰됐다(바이너리별로 TCC 권한 상태가
# 다른 것으로 추정). 토큰 파일 경로 계산과 읽기를 전부 node 한 번으로 묶는다.
TOKEN=$("$NODE" -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
const p = (c.slack && c.slack.tokenFile) || '';
const file = p.replace(/^~(?=\/|\$)/, require('os').homedir());
try { process.stdout.write(fs.readFileSync(file, 'utf-8').trim()); } catch (e) {}
" 2>>"$LOG")

found=0
successes=0
failures=0
if [ -z "$CHANNELS" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') 채널 확인 실패 — 설정된 채널을 읽을 수 없음" >> "$LOG"
  exit 1
fi
# 예전엔 fetch가 실패해도(네트워크 오류, 슬랙 API 오류 등) 전부 "새 메시지 0개"로
# 뭉뚱그려져서 로그에 아무 흔적도 안 남았다 — 그래서 몇 시간씩 못 가져와도 몰랐다.
# 이제는 실패와 "진짜 0개"를 구분해서, 실패는 로그에 채널명과 이유를 남긴다.
#
# fetch_slack_channel.sh를 따로 실행(bash .../fetch_slack_channel.sh)하지 않고 curl을 직접
# 여기서 부른다 — 그 스크립트는 ~/Desktop 아래에 있는데, launchd가 부른 프로세스가 그 밑의
# 실행 파일을 "Operation not permitted"로 막는 경우가 있어서(읽기는 되는데 실행이 막힘),
# 아예 Desktop 밑의 실행 파일을 부르지 않는 쪽으로 피해간다.
for entry in $CHANNELS; do
  id="${entry%%:*}"
  key="${entry##*:}"
  cursor=$("$NODE" -e "try{const s=require('$STATE');process.stdout.write(s['$key']||'')}catch(e){}" 2>/dev/null)
  if [ -z "$TOKEN" ]; then
    failures=$((failures + 1))
    echo "$(date '+%Y-%m-%d %H:%M:%S') $key 채널 확인 실패 — 슬랙 토큰을 읽을 수 없음" >> "$LOG"
    continue
  fi
  url="https://slack.com/api/conversations.history?channel=${id}&limit=100"
  [ -n "$cursor" ] && url="${url}&oldest=${cursor}"
  raw=$(curl --connect-timeout 10 --max-time 25 -s -H "Authorization: Bearer $TOKEN" "$url" 2>>"$LOG")
  fetch_status=$?
  result=$(echo "$raw" | "$NODE" -e "
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.ok === false) { process.stdout.write('ERR:' + (j.error || 'unknown')); return; }
        process.stdout.write(String((j.messages || []).length));
      } catch (e) { process.stdout.write('ERR:parse_failed'); }
    });
  " 2>/dev/null)
  if [ "$fetch_status" -ne 0 ] || [ "${result#ERR:}" != "$result" ]; then
    failures=$((failures + 1))
    echo "$(date '+%Y-%m-%d %H:%M:%S') $key 채널 확인 실패 — ${result:-fetch 실패 (exit $fetch_status)}" >> "$LOG"
    continue
  fi
  successes=$((successes + 1))
  [ -n "$result" ] && [ "$result" -gt 0 ] 2>/dev/null && found=$((found + result))
done

# 상태도 앱의 저장 경로를 사용한다. 수집 전에는 성공으로 기록하지 않는다.
record_health() {
  "$NODE" -e 'process.stdout.write(JSON.stringify({success:process.argv[1]==="true",error:process.argv[2]}))' "$1" "${2:-}" |
    "$NODE" "$APP/import-record.js" health >> "$LOG" 2>&1
}
if [ "$failures" -gt 0 ]; then
  record_health false "일부 채널을 확인하지 못했습니다."
elif [ "$found" -eq 0 ]; then
  record_health true || exit 1
fi

if [ "$found" -eq 0 ]; then
  if [ "$failures" -gt 0 ]; then exit 1; fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') 새 메시지 없음 — Claude 호출 생략" >> "$LOG"
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  exit 0
fi

# exec로 넘기면 이 프로세스 자체가 대체되어 위에서 건 EXIT trap(잠금 해제)이 실행되지 않는다.
# 그래서 실제로 캡처가 일어날 때마다 잠금이 안 풀려서, 다음 최대 30분치 실행이 전부
# "이전 실행이 아직 진행 중"으로 건너뛰어지는 문제가 있었다 — 그냥 호출해서 trap이 돌게 둔다.
# 이 실행은 파일을 고칠 일이 없다 — 슬랙을 읽고 앱 API로 등록만 한다. 그래서
#  - acceptEdits(허용 목록과 무관하게 파일 수정을 전부 자동 승인)를 쓰지 않고,
#  - Write·Edit·NotebookEdit는 아예 금지 목록에 넣고,
#  - 통째로 열어두던 Bash 대신 스킬이 실제로 쓰는 두 명령만 허용한다.
# 사람이 보는 앞이 아닌 자동 실행에서 실수로 파일을 건드리는 걸 막는 안전장치다
# (OS 수준의 격리가 아니다 — 같은 계정 권한으로 도는 건 그대로다).
"$HOME/.local/share/workspace-automation/run-task.sh" "slack-capture" \
  ".claude/skills/ 폴더의 slack-todos.md, slack-alignments.md, slack-someday.md, slack-waiting.md 파일을 차례로 읽고 각 지시대로 실행해라. 새로 캡처된 항목이 있으면 몇 개인지, 어떤 내용인지 간단히 한국어로 보고해라 (원본 스레드를 못 읽은 항목, 중복이라 건너뛴 항목은 반드시 별도로 알려라). 새 항목이 전혀 없으면 \"(새 항목 없음)\" 한 줄만 출력하고 끝내라." \
  "mcp__slack,Read,ToolSearch,Bash(node tracker/inbox-app/import-record.js:*),Bash(bash tracker/inbox-app/fetch_slack_channel.sh:*)" \
  "manual" \
  "Write,Edit,NotebookEdit"
capture_status=$?
if [ "$capture_status" -ne 0 ] || [ "$failures" -gt 0 ]; then
  record_health false "Slack 수집을 완료하지 못했습니다."
  exit 1
fi
# 각 채널의 저장 성공 여부는 해당 수집 단계가 health API로 남긴다.
exit 0
