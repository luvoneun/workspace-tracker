#!/bin/bash
# 슬랙 캡처는 30분마다 도는데 대부분은 가져올 게 없다.
# curl로 먼저 새 메시지가 있는지만 확인하고, 있을 때만 Claude를 부른다.
# (확인만 한 경우에도 checkedAt은 남겨서, 캡처가 멈추면 앱이 알아챌 수 있게 한다)

set -uo pipefail

WORKSPACE="${WORKSPACE_DIR:-$HOME/Desktop/personal}"
APP="$WORKSPACE/tracker/inbox-app"
STATE="$APP/.slack_capture_state.json"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
LOG_DIR="$HOME/.local/share/workspace-automation/logs"
LOG="$LOG_DIR/slack-capture.log"
LOCK_DIR="$LOG_DIR/.slack-capture.lock"

mkdir -p "$LOG_DIR"
cd "$WORKSPACE" || exit 1

# 5분마다 깨어나는 방식이라, 여기서 업무시간(평일 9~19시)인지 직접 판단해서
# 아니면 조용히 빠진다. (예: 슬랙 조회조차 하지 않는다)
dow=$(date '+%u')   # 1=월 ... 7=일
hour=$(date '+%H')
if [ "$dow" -gt 5 ] || [ "$hour" -lt 9 ] || [ "$hour" -ge 19 ]; then
  exit 0
fi

# 직전 실행이 아직 안 끝났으면(캡처가 오래 걸리는 중) 겹쳐 돌지 않게 건너뛴다.
# macOS 기본 bash엔 flock이 없어서 mkdir의 원자성으로 잠금을 대신한다.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # 잠금이 30분 넘게 남아있으면 죽은 잠금으로 보고 정리한다
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') 이전 실행이 아직 진행 중 — 건너뜀" >> "$LOG"
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

CONFIG="${WORKSPACE_CONFIG:-$WORKSPACE/workspace.config.json}"
CHANNELS=$(python3 -c "
import json
with open('$CONFIG') as f: c = json.load(f)
ch = c.get('slack', {}).get('channels', {})
print(' '.join(f\"{v['id']}:my-{k if k!='todo' else 'todo'}\" for k, v in ch.items()))
" 2>/dev/null)

found=0
# 예전엔 fetch가 실패해도(네트워크 오류, 슬랙 API 오류 등) 전부 "새 메시지 0개"로
# 뭉뚱그려져서 로그에 아무 흔적도 안 남았다 — 그래서 몇 시간씩 못 가져와도 몰랐다.
# 이제는 실패와 "진짜 0개"를 구분해서, 실패는 로그에 채널명과 이유를 남긴다.
for entry in $CHANNELS; do
  id="${entry%%:*}"
  key="${entry##*:}"
  cursor=$("$NODE" -e "try{const s=require('$STATE');process.stdout.write(s['$key']||'')}catch(e){}" 2>/dev/null)
  raw=$(bash "$APP/fetch_slack_channel.sh" "$id" 100 "$cursor" 2>>"$LOG")
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
    echo "$(date '+%Y-%m-%d %H:%M:%S') $key 채널 확인 실패 — ${result:-fetch 실패 (exit $fetch_status)}" >> "$LOG"
    continue
  fi
  [ -n "$result" ] && [ "$result" -gt 0 ] 2>/dev/null && found=$((found + result))
done

# 확인했다는 사실은 언제나 기록한다
"$NODE" -e "
const fs=require('fs');
const p='$STATE';
let s={};
try { s=JSON.parse(fs.readFileSync(p,'utf-8')); } catch(e) {}
const d=new Date(), pad=n=>String(n).padStart(2,'0');
const off=-d.getTimezoneOffset(), sign=off>=0?'+':'-';
s.checkedAt=\`\${d.getFullYear()}-\${pad(d.getMonth()+1)}-\${pad(d.getDate())}T\${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\${sign}\${pad(Math.floor(Math.abs(off)/60))}:\${pad(Math.abs(off)%60)}\`;
fs.writeFileSync(p, JSON.stringify(s,null,2));
" 2>>"$LOG"

if [ "$found" -eq 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') 새 메시지 없음 — Claude 호출 생략" >> "$LOG"
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  exit 0
fi

# exec로 넘기면 이 프로세스 자체가 대체되어 위에서 건 EXIT trap(잠금 해제)이 실행되지 않는다.
# 그래서 실제로 캡처가 일어날 때마다 잠금이 안 풀려서, 다음 최대 30분치 실행이 전부
# "이전 실행이 아직 진행 중"으로 건너뛰어지는 문제가 있었다 — 그냥 호출해서 trap이 돌게 둔다.
"$HOME/.local/share/workspace-automation/run-task.sh" "slack-capture" \
  ".claude/skills/ 폴더의 slack-todos.md, slack-alignments.md, slack-someday.md, slack-waiting.md 파일을 차례로 읽고 각 지시대로 실행해라. 새로 캡처된 항목이 있으면 몇 개인지, 어떤 내용인지 간단히 한국어로 보고해라 (원본 스레드를 못 읽은 항목, 중복이라 건너뛴 항목은 반드시 별도로 알려라). 새 항목이 전혀 없으면 \"(새 항목 없음)\" 한 줄만 출력하고 끝내라." \
  "mcp__slack,Read,Write,Edit,Bash,ToolSearch"
