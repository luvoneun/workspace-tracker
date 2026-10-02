#!/bin/bash
# 써 보기 서버(가짜 데이터로 앱을 눌러 보는 자리)를 맥이 항상 켜 두게 한다 — 만든 사람 맥 전용이다.
#   ./tryout.sh install     launchd에 올린다(로그인하면 켜지고, 꺼지면 다시 켠다) → http://localhost:4340
#   ./tryout.sh restart     서버 코드를 고친 뒤 다시 켠다(가짜 데이터도 처음 상태로 돌아간다)
#   ./tryout.sh status      떠 있는지와 주소
#   ./tryout.sh uninstall   내리고 등록 파일 하나를 지운다
# setup.sh·update.sh는 이 서버를 모른다 — 이 스크립트를 직접 돌렸을 때만 생긴다(동료 설치본에는 없다).
# 다루는 것은 자기 이름표(com.workspace.app.tryout) 하나뿐이고, 프로세스 목록을 훑거나 다른 프로그램을 끝내지 않는다.
# 서버는 저장소의 tracker/inbox-app/tryout-server.js를 그대로 실행한다(데이터·설정·토큰은 전부 임시 폴더).

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$WORKSPACE/tracker/inbox-app"
LABEL="com.workspace.app.tryout"
PORT="${TRYOUT_PORT:-4340}"
# 아래 넷은 시험이 가짜 자리를 끼우는 길이다(평소에는 기본값 그대로).
AGENTS_DIR="${TRYOUT_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${TRYOUT_LOG_DIR:-$HOME/.local/share/workspace-automation/logs}"
CONFIG="${TRYOUT_CONFIG:-$WORKSPACE/workspace.config.json}"
LAUNCHCTL="${TRYOUT_LAUNCHCTL:-launchctl}"
PLIST="$AGENTS_DIR/$LABEL.plist"
URL="http://localhost:$PORT"

ok()   { echo "  ✓ $1"; }
warn() { echo "  ! $1"; }
die()  { echo "  ✗ $1"; exit 1; }

# 받는 갈래가 main(만든 사람의 설치)일 때만 올린다 — 동료 설치본에서 실수로 돌려도 아무것도 바꾸지 않는다.
channel() {
  node -e '
    let channel = "";
    try { channel = (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).server || {}).updateChannel || ""; } catch { channel = ""; }
    process.stdout.write(String(channel));
  ' "$CONFIG" 2>/dev/null
}

# 포트가 비었는지 직접 열어 본다(누가 쓰는지 찾거나 끝내지 않는다). 방금 내린 내 서버가 닫힐 틈을 3초까지 준다.
port_free() {
  node -e '
    const net = require("node:net"), port = Number(process.argv[1]);
    let left = 6;
    const attempt = () => {
      const probe = net.createServer();
      probe.once("error", () => { if (--left > 0) setTimeout(attempt, 500); else process.exit(1); });
      probe.listen(port, "127.0.0.1", () => probe.close(() => process.exit(0)));
    };
    attempt();
  ' "$PORT"
}

install() {
  command -v node >/dev/null 2>&1 || die "Node가 없어요."
  case "$PORT" in ''|*[!0-9]*) die "포트는 숫자여야 해요: $PORT" ;; esac
  if [ "$PORT" -ge 4321 ] && [ "$PORT" -le 4331 ]; then die "$PORT 포트는 운영 앱·슬랙 연결 자리예요 — 4321~4331 밖의 포트를 골라 주세요."; fi
  if [ "$(channel)" != "main" ]; then
    echo "  써 보기 서버는 앱을 만드는 사람의 맥 전용이에요(받는 갈래 main) — 이 설치에는 올리지 않았어요. 아무것도 바꾸지 않았어요."
    exit 0
  fi
  [ -f "$APP_DIR/tryout-server.js" ] || die "tryout-server.js가 없어요: $APP_DIR"
  # 이미 올려 둔 내 것이 있으면 먼저 내린다(그 포트는 내 것이므로).
  [ -f "$PLIST" ] && "$LAUNCHCTL" unload "$PLIST" 2>/dev/null
  if ! port_free; then
    [ -f "$PLIST" ] && "$LAUNCHCTL" load "$PLIST" 2>/dev/null
    die "$PORT 포트를 다른 프로그램이 쓰고 있어요 — 그 프로그램은 건드리지 않았어요. 끄고 다시 돌리거나 TRYOUT_PORT로 다른 포트를 골라 주세요."
  fi
  mkdir -p "$AGENTS_DIR" "$LOG_DIR"
  cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$APP_DIR/tryout-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TRYOUT_PORT</key>
    <string>$PORT</string>
    <key>TRYOUT_KEEPALIVE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/tryout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/tryout.err</string>
</dict>
</plist>
PLIST
  "$LAUNCHCTL" load "$PLIST" || die "launchd에 올리지 못했어요: $PLIST"
  ok "써 보기 서버를 올렸어요 — $URL (처음 상태로: $URL/__tryout)"
  echo "    기록: $LOG_DIR/tryout.log · tryout.err"
}

uninstall() {
  if [ ! -f "$PLIST" ]; then ok "올려 둔 써 보기 서버가 없어요."; return 0; fi
  "$LAUNCHCTL" unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  ok "써 보기 서버를 내리고 등록 파일을 지웠어요: $PLIST"
}

restart() {
  [ -f "$PLIST" ] || die "아직 올리지 않았어요 — ./tryout.sh install 을 먼저 돌려 주세요."
  "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL" || die "다시 켜지 못했어요 — ./tryout.sh install 을 다시 돌려 주세요."
  ok "써 보기 서버를 다시 켰어요 — $URL"
}

status() {
  if [ ! -f "$PLIST" ]; then echo "  써 보기 서버를 올리지 않았어요 (./tryout.sh install)"; return 0; fi
  if "$LAUNCHCTL" list "$LABEL" >/dev/null 2>&1; then ok "launchd에 올라가 있어요 ($LABEL)"; else warn "등록 파일은 있는데 launchd에 올라가 있지 않아요 — ./tryout.sh install"; fi
  if curl -s -o /dev/null --max-time 3 "$URL/__tryout"; then ok "응답해요 — $URL"; else warn "$URL 이 응답하지 않아요 — 기록: $LOG_DIR/tryout.err"; fi
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  restart) restart ;;
  status) status ;;
  *) echo "쓰는 법: ./tryout.sh install | uninstall | restart | status"; exit 2 ;;
esac
