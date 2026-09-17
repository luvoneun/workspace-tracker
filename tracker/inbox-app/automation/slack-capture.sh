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
for entry in $CHANNELS; do
  id="${entry%%:*}"
  key="${entry##*:}"
  cursor=$("$NODE" -e "try{const s=require('$STATE');process.stdout.write(s['$key']||'')}catch(e){}" 2>/dev/null)
  count=$(bash "$APP/fetch_slack_channel.sh" "$id" 100 "$cursor" 2>/dev/null \
    | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(String(JSON.parse(d).messages.length))}catch(e){process.stdout.write('0')}})" 2>/dev/null)
  [ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null && found=$((found + count))
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

exec "$HOME/.local/share/workspace-automation/run-task.sh" "slack-capture" \
  ".claude/skills/ 폴더의 slack-todos.md, slack-alignments.md, slack-someday.md, slack-waiting.md 파일을 차례로 읽고 각 지시대로 실행해라. 새로 캡처된 항목이 있으면 몇 개인지, 어떤 내용인지 간단히 한국어로 보고해라 (원본 스레드를 못 읽은 항목, 중복이라 건너뛴 항목은 반드시 별도로 알려라). 새 항목이 전혀 없으면 \"(새 항목 없음)\" 한 줄만 출력하고 끝내라." \
  "mcp__slack,Read,Write,Edit,Bash,ToolSearch"
