#!/bin/bash
# 워크스페이스 설치 스크립트
#
# 새 맥에서 이걸 한 번 실행하면:
#   1. 필요한 프로그램이 있는지 확인하고
#   2. 설정 파일을 만들고 (처음이면 채워달라고 안내)
#   3. 자동화 스크립트를 실행 위치로 복사하고
#   4. 맥 스케줄러(launchd)에 등록하고
#   5. Dock에 올릴 앱을 만든다
#
#   실행: bash setup.sh

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$WORKSPACE/tracker/inbox-app"
INSTALL_DIR="$HOME/.local/share/workspace-automation"
AGENTS_DIR="$HOME/Library/LaunchAgents"
CONFIG="$WORKSPACE/workspace.config.json"
APP_BUNDLE="$HOME/Applications/워크스페이스.app"

ok()   { echo "  ✓ $1"; }
warn() { echo "  ! $1"; }
die()  { echo "  ✗ $1"; echo; echo "설치를 멈춥니다."; exit 1; }

echo
echo "워크스페이스 설치를 시작합니다"
echo "  위치: $WORKSPACE"
echo

# ─────────────────────────────────────────────
echo "[1/5] 필요한 프로그램 확인"

command -v node >/dev/null 2>&1 || die "node가 없습니다. https://nodejs.org 에서 설치해주세요."
ok "node $(node -v)"

if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  warn "claude CLI가 없습니다. 앱은 동작하지만 슬랙·캘린더·지라 자동 갱신은 안 됩니다."
fi

command -v python3 >/dev/null 2>&1 || die "python3가 없습니다."
ok "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"

# ─────────────────────────────────────────────
echo
echo "[2/5] 설정 파일"

if [ ! -f "$CONFIG" ]; then
  cp "$WORKSPACE/workspace.config.example.json" "$CONFIG"
  echo
  echo "  설정 파일을 새로 만들었습니다: workspace.config.json"
  echo "  아래 항목을 채운 뒤 이 스크립트를 다시 실행해주세요."
  echo
  echo "    title           — 화면에 표시할 이름"
  echo "    slack.workspaceUrl — 회사 슬랙 주소 (예: https://회사.slack.com)"
  echo "    slack.tokenFile — 슬랙 토큰을 저장한 파일 경로"
  echo "    slack.channels  — 나만 보는 비공개 채널 4개의 ID"
  echo "                      (슬랙에서 채널 → 세부정보 맨 아래에 있습니다)"
  echo
  exit 0
fi
ok "설정 파일 있음"

# 안 쓰는 도구는 검사도 등록도 하지 않는다
uses() {
  python3 -c "
import json
c = json.load(open('$CONFIG')).get('integrations', {})
print('yes' if c.get('$1', True) else 'no')
"
}
USE_SLACK=$(uses slack); USE_CAL=$(uses calendar); USE_JIRA=$(uses jira)

USING=""
[ "$USE_SLACK" = "yes" ] && USING="$USING 슬랙"
[ "$USE_CAL" = "yes" ] && USING="$USING 캘린더"
[ "$USE_JIRA" = "yes" ] && USING="$USING 지라"
ok "연동:${USING:- (없음 — 직접 입력만 사용)}"

if [ "$USE_SLACK" = "yes" ]; then
  grep -q "여기에_채널ID" "$CONFIG" && die "workspace.config.json의 채널 ID를 아직 채우지 않았습니다."
  TOKEN_FILE=$(python3 -c "
import json, os
with open('$CONFIG') as f: c = json.load(f)
print(os.path.expanduser(c.get('slack', {}).get('tokenFile', '')))
")
  if [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
    ok "슬랙 토큰 있음"
  else
    warn "슬랙 토큰 파일이 없습니다: ${TOKEN_FILE:-(설정 안 됨)} — 슬랙 캡처는 동작하지 않습니다."
  fi
fi

# ─────────────────────────────────────────────
echo
echo "[3/5] 자동화 스크립트 설치"
# macOS가 Desktop 폴더를 보호해서 launchd가 그 안의 스크립트를 실행하지 못한다.
# 그래서 보호 대상이 아닌 곳으로 복사해서 쓴다.
mkdir -p "$INSTALL_DIR/logs"
cp "$APP_DIR/automation/run-task.sh" "$APP_DIR/automation/slack-capture.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR"/*.sh
ok "$INSTALL_DIR 에 복사"

# ─────────────────────────────────────────────
echo
echo "[4/5] 맥 스케줄러(launchd) 등록"

NODE_PATH="$(command -v node)"
PORT=$(python3 -c "import json;print(json.load(open('$CONFIG')).get('server',{}).get('port',4321))")
EXTRA_HOST=$(python3 -c "import json;print(json.load(open('$CONFIG')).get('server',{}).get('extraHost','') or '')")

mkdir -p "$AGENTS_DIR"

# 평일 9·11·13·15·17·19시의 지정한 분에 도는 일정표를 만든다
calendar_intervals() {
  local minute="$1"
  for wd in 1 2 3 4 5; do
    for h in 9 11 13 15 17 19; do
      echo "    <dict><key>Weekday</key><integer>$wd</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$minute</integer></dict>"
    done
  done
}

write_task_agent() {
  local name="$1" minute="$2" prompt="$3" tools="$4"
  cat > "$AGENTS_DIR/com.luvon.workspace.$name.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.luvon.workspace.$name</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/run-task.sh</string>
    <string>$name</string>
    <string>$prompt</string>
    <string>$tools</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKSPACE_DIR</key>
    <string>$WORKSPACE</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
$(calendar_intervals "$minute")
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/logs/$name.err</string>
</dict>
</plist>
PLIST
}

# 슬랙 캡처 — 새 메시지가 있을 때만 Claude를 부른다
if [ "$USE_SLACK" = "yes" ]; then
cat > "$AGENTS_DIR/com.luvon.workspace.slack-capture.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.luvon.workspace.slack-capture</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/slack-capture.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKSPACE_DIR</key>
    <string>$WORKSPACE</string>
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/logs/slack-capture.err</string>
</dict>
</plist>
PLIST
fi

[ "$USE_CAL" = "yes" ] && write_task_agent "calendar-sync" 13 \
  ".claude/skills/calendar-sync.md 파일을 읽고 그 지시대로 오늘 캘린더 일정을 갱신해라. 결과는 일정 수와 제목만 간단히 한국어로 보고해라." \
  "mcp__claude_ai_Google_Calendar,Read,Write,Edit,Bash,ToolSearch"

[ "$USE_JIRA" = "yes" ] && write_task_agent "jira-sync" 17 \
  ".claude/skills/jira-sync.md 파일을 읽고 그 지시대로 담당 지라 이슈 캐시를 갱신해라. 조회된 이슈 수와 변동사항만 2줄 이내로 보고해라." \
  "mcp__atlassian,Read,Write,Edit,Bash,ToolSearch"

# 앱 서버 — 로그인하면 뜨고, 꺼지면 다시 뜬다
cat > "$AGENTS_DIR/com.luvon.workspace.server.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.luvon.workspace.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$APP_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKSPACE_NO_OPEN</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/logs/server.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/logs/server.err</string>
</dict>
</plist>
PLIST

# 로그인하면 앱 창을 띄운다
cat > "$AGENTS_DIR/com.luvon.workspace.open-at-login.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.luvon.workspace.open-at-login</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>sleep 8; open -a "\$HOME/Applications/워크스페이스.app"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/logs/open-at-login.err</string>
</dict>
</plist>
PLIST

# 껐는데 예전에 등록돼 있던 것은 내리고 지운다
remove_agent() {
  local plist="$AGENTS_DIR/com.luvon.workspace.$1.plist"
  [ -f "$plist" ] || return 0
  launchctl unload "$plist" 2>/dev/null
  rm -f "$plist"
  ok "$1 해제 (안 쓰는 도구)"
}
[ "$USE_SLACK" = "yes" ] || remove_agent slack-capture
[ "$USE_CAL" = "yes" ] || remove_agent calendar-sync
[ "$USE_JIRA" = "yes" ] || remove_agent jira-sync

for f in server slack-capture calendar-sync jira-sync open-at-login; do
  plist="$AGENTS_DIR/com.luvon.workspace.$f.plist"
  [ -f "$plist" ] || continue
  plutil -lint "$plist" >/dev/null 2>&1 || die "설정 파일 형식 오류: $f"
  launchctl unload "$plist" 2>/dev/null
  launchctl load "$plist" 2>/dev/null && ok "$f 등록"
done

# ─────────────────────────────────────────────
echo
echo "[5/5] Dock에 올릴 앱 만들기"

URL="http://localhost:$PORT"
rm -rf "$APP_BUNDLE"
mkdir -p "$HOME/Applications"
cat > /tmp/ws-launcher.applescript << SCRIPT
do shell script "URL=$URL; for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null --max-time 1 \$URL && break; sleep 0.5; done; '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --app=\$URL > /dev/null 2>&1 &"
SCRIPT

if osacompile -o "$APP_BUNDLE" /tmp/ws-launcher.applescript 2>/dev/null; then
  ICON_SRC="$APP_DIR/icons/icon-512.png"
  if [ -f "$ICON_SRC" ]; then
    python3 - "$ICON_SRC" << 'PY' 2>/dev/null
from PIL import Image, ImageDraw
import subprocess, sys, os, shutil
src = sys.argv[1]
base = Image.open(src).convert("RGBA")
os.makedirs("/tmp/ws.iconset", exist_ok=True)
for s in (16, 32, 64, 128, 256, 512, 1024):
    img = base.resize((s, s), Image.LANCZOS)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s-1, s-1], radius=int(s*0.22), fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(f"/tmp/ws_{s}.png")
for s in (16, 32, 128, 256, 512):
    shutil.copy(f"/tmp/ws_{s}.png", f"/tmp/ws.iconset/icon_{s}x{s}.png")
    if os.path.exists(f"/tmp/ws_{s*2}.png"):
        shutil.copy(f"/tmp/ws_{s*2}.png", f"/tmp/ws.iconset/icon_{s}x{s}@2x.png")
subprocess.run(["iconutil", "-c", "icns", "/tmp/ws.iconset", "-o", "/tmp/ws.icns"], check=False)
PY
    if [ -f /tmp/ws.icns ]; then
      cp /tmp/ws.icns "$APP_BUNDLE/Contents/Resources/applet.icns"
      # 에셋 카탈로그를 가리키는 키가 남아있으면 파일 아이콘이 무시된다
      plutil -remove CFBundleIconName "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null
      # 아이콘을 바꾸면 osacompile이 해둔 서명이 깨져서 macOS가 기본 아이콘으로 떨어뜨린다
      codesign --force --deep -s - "$APP_BUNDLE" 2>/dev/null
    fi
    rm -rf /tmp/ws.iconset /tmp/ws_*.png /tmp/ws.icns
  fi
  rm -f /tmp/ws-launcher.applescript
  touch "$APP_BUNDLE"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" 2>/dev/null
  ok "$APP_BUNDLE"
else
  warn "앱 만들기 실패 — 브라우저에서 $URL 로 직접 여세요."
fi

# ─────────────────────────────────────────────
echo
echo "설치 완료"
echo
echo "  앱 주소   : $URL"
[ -n "$EXTRA_HOST" ] && echo "  다른 기기 : http://$EXTRA_HOST:$PORT"
echo "  Dock 추가 : $APP_BUNDLE 을 Dock으로 끌어다 놓으세요"
echo
echo "  자동화 상태 확인 : launchctl list | grep luvon.workspace"
echo "  로그             : $INSTALL_DIR/logs/"
echo
echo "  남은 일:"
CONNECT=""
[ "$USE_SLACK" = "yes" ] && CONNECT="$CONNECT 슬랙"
[ "$USE_CAL" = "yes" ] && CONNECT="$CONNECT 구글캘린더"
[ "$USE_JIRA" = "yes" ] && CONNECT="$CONNECT 지라(Atlassian)"
[ -n "$CONNECT" ] && echo "   · Claude Code에서$CONNECT 를 본인 계정으로 연결 (/mcp)"
[ -n "$EXTRA_HOST" ] || echo "   · 폰에서 보려면 Tailscale 설치 후 workspace.config.json의 server.extraHost에 주소 입력"
echo
