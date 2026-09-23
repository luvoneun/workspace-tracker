#!/bin/bash
# Dock에 올릴 앱(~/Applications/<Dock 이름>.app)을 만든다.
#
# 두 군데서 쓴다:
#   - setup.sh의 마지막 단계(설치·업데이트 때)
#   - 앱의 설정 › 꾸미기에서 아이콘·Dock 이름을 저장했을 때 — 앱 서버는 프로세스를 띄우지 않고 요청 표시 파일
#     (requests/app-refresh.request)만 쓰고, 그걸 지켜보던 launchd 에이전트(com.workspace.app.app-refresh)가
#     이 스크립트를 한 번 돌린다.
#
# 지키는 것:
#   - Dock 이름이 바뀌면 옛 앱은 **이 스크립트가 적어 둔 이름 기록 파일의 이전 이름 하나만** 지운다.
#     목록을 훑어 지울 대상을 고르지 않고, `~/Applications/<이름>.app` 그 정확한 경로이면서 이 스크립트가
#     만든 앱(스크립트 앱의 main.scpt가 있는 것)일 때만 지운다.
#   - Dock 프로세스를 다시 시작하지 않는다 — 바뀐 아이콘·이름은 앱을 닫고 다시 열면 보인다.
#
#   실행: bash app-refresh.sh   (WORKSPACE_DIR 또는 setup.sh가 적어 둔 workspace.env로 설치 위치를 찾는다)

set -uo pipefail

# 설치 위치는 사람마다 다르다. plist가 넘겨주는 WORKSPACE_DIR을 먼저 보고, 없으면 setup.sh가
# 적어 둔 workspace.env를 읽는다(run-task.sh와 같은 규칙).
INSTALL_DIR="${WORKSPACE_INSTALL_DIR:-$HOME/.local/share/workspace-automation}"
if [ -z "${WORKSPACE_DIR:-}" ]; then
  WORKSPACE_ENV="${WORKSPACE_ENV_FILE:-$INSTALL_DIR/workspace.env}"
  # shellcheck source=/dev/null
  [ -f "$WORKSPACE_ENV" ] && . "$WORKSPACE_ENV"
fi
WORKSPACE="${WORKSPACE_DIR:-}"
if [ -z "$WORKSPACE" ]; then
  echo "설치 정보를 찾을 수 없어요 — setup.sh를 먼저 실행해 주세요" >&2
  exit 1
fi

# launchd는 PATH가 거의 비어 있다. 지금 PATH를 앞에 두고(테스트의 가짜 명령이 먼저 잡히게) 흔한 자리를 덧붙인다.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="${PATH:+$PATH:}$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

APP_DIR="$WORKSPACE/tracker/inbox-app"
CONFIG="${WORKSPACE_CONFIG:-$WORKSPACE/workspace.config.json}"
APPS_DIR="$HOME/Applications"
NAME_RECORD="$INSTALL_DIR/app-bundle-name"
LSREGISTER="${LSREGISTER_BIN:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"

ok()   { echo "  ✓ $1"; }
warn() { echo "  ! $1"; }

# 설정에서 포트·크롬 프로필·Dock 이름을 읽는다. 규칙에 맞지 않는 값은 빈 값(→ 기본값)으로 읽는다.
read_config() {
  node -e '
const fs = require("fs");
let config = {};
try { config = JSON.parse(fs.readFileSync(process.argv[1], "utf-8")); } catch (error) { config = {}; }
const server = config && typeof config.server === "object" && config.server ? config.server : {};
const key = process.argv[2];
if (key === "port") {
  process.stdout.write(/^\d{2,5}$/.test(String(server.port || "")) ? String(server.port) : "");
} else if (key === "chromeProfile") {
  const value = String(server.chromeProfile || "");
  process.stdout.write(/^[A-Za-z0-9 _-]{1,40}$/.test(value) ? value : "");
} else if (key === "dockName") {
  // 앱의 설정 › 꾸미기와 같은 규칙: 1~30자, / : 줄바꿈 없음, 점으로 시작하지 않음.
  const value = String(server.dockName || "").trim();
  process.stdout.write(value && [...value].length <= 30 && !/[/:\r\n\t\0]/.test(value) && !value.startsWith(".") ? value : "");
}
' "$CONFIG" "$1" 2>/dev/null
}

# 이 스크립트가 적어 둔 이전 이름의 앱 하나만 지운다. 이름에 경로 글자가 있거나 `~/Applications/` 밖을
# 가리키거나, 이 스크립트가 만든 앱(스크립트 앱)이 아니면 건드리지 않는다.
remove_old_bundle() {
  local name="$1" target
  case "$name" in
    ''|*/*|*:*|.*) warn "이전 이름 기록이 이상해서 옛 앱은 지우지 않았어요"; return 0 ;;
  esac
  target="$APPS_DIR/$name.app"
  case "$target" in
    "$APPS_DIR"/*.app) ;;
    *) warn "옛 앱 경로가 ~/Applications 밖이라 지우지 않았어요"; return 0 ;;
  esac
  [ -d "$target" ] || return 0
  if [ ! -f "$target/Contents/Resources/Scripts/main.scpt" ]; then
    warn "$target 은 이 설치가 만든 앱이 아니라서 그대로 뒀어요"
    return 0
  fi
  rm -rf "$target"
  ok "옛 이름의 앱을 지웠어요: $target"
}

PORT="$(read_config port)"
[ -n "$PORT" ] || PORT=4321
CHROME_PROFILE="$(read_config chromeProfile)"
DOCK_NAME="$(read_config dockName)"
[ -n "$DOCK_NAME" ] || DOCK_NAME="Workspace"
APP_BUNDLE="$APPS_DIR/$DOCK_NAME.app"
OLD_NAME=""
[ -f "$NAME_RECORD" ] && OLD_NAME="$(head -n 1 "$NAME_RECORD" 2>/dev/null)"

URL="http://localhost:$PORT"
# 프로필을 정해 두면 앱 창과 거기서 여는 링크가 늘 그 프로필(회사 계정)에서 열린다.
PROFILE_ARG=""
[ -n "$CHROME_PROFILE" ] && PROFILE_ARG="--profile-directory='$CHROME_PROFILE' "

# 만드는 동안 쓰는 임시 폴더 — 끝나면 통째로 지운다(이 스크립트가 만든 폴더만).
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ws-app.XXXXXX")" || { warn "임시 폴더를 만들지 못했어요"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# 같은 이름의 앱이 이미 있으면 이 스크립트가 만든 앱(스크립트 앱)일 때만 지우고 다시 만든다 —
# Dock 이름을 다른 앱과 같게 지었을 때 그 앱을 지우지 않게.
if [ -e "$APP_BUNDLE" ] && [ ! -f "$APP_BUNDLE/Contents/Resources/Scripts/main.scpt" ]; then
  warn "$APP_BUNDLE 은 다른 앱이라 그대로 뒀어요 — 설정 › 꾸미기에서 Dock 이름을 바꿔 주세요."
  exit 1
fi
rm -rf "$APP_BUNDLE"
mkdir -p "$APPS_DIR"
# 크롬이 있으면 창 하나짜리 앱 모양으로, 없으면 기본 브라우저로 연다.
if [ -d "/Applications/Google Chrome.app" ]; then
cat > "$WORK/launcher.applescript" << SCRIPT
do shell script "URL=$URL; for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null --max-time 1 \$URL && break; sleep 0.5; done; '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' $PROFILE_ARG--app=\$URL > /dev/null 2>&1 &"
SCRIPT
else
cat > "$WORK/launcher.applescript" << SCRIPT
do shell script "URL=$URL; for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null --max-time 1 \$URL && break; sleep 0.5; done; open \$URL"
SCRIPT
  warn "크롬이 없어 기본 브라우저로 열어요"
fi

if ! osacompile -o "$APP_BUNDLE" "$WORK/launcher.applescript" 2>/dev/null; then
  warn "앱을 만들지 못했어요 — 브라우저에서 $URL 로 직접 열어 주세요."
  exit 1
fi

# 아이콘은 local/icon.png가 있으면 그것을 먼저 쓴다(업데이트해도 그 폴더는 그대로 남는다).
ICON_SRC="$APP_DIR/icons/icon-512.png"
[ -f "$WORKSPACE/local/icon.png" ] && ICON_SRC="$WORKSPACE/local/icon.png"
if [ -f "$ICON_SRC" ]; then
  python3 - "$ICON_SRC" "$WORK" << 'PY' 2>/dev/null
from PIL import Image, ImageDraw
import subprocess, sys, os, shutil
src, work = sys.argv[1], sys.argv[2]
iconset = os.path.join(work, "ws.iconset")
base = Image.open(src).convert("RGBA")
os.makedirs(iconset, exist_ok=True)
for s in (16, 32, 64, 128, 256, 512, 1024):
    img = base.resize((s, s), Image.LANCZOS)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s-1, s-1], radius=int(s*0.22), fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(os.path.join(work, f"ws_{s}.png"))
for s in (16, 32, 128, 256, 512):
    shutil.copy(os.path.join(work, f"ws_{s}.png"), os.path.join(iconset, f"icon_{s}x{s}.png"))
    if os.path.exists(os.path.join(work, f"ws_{s*2}.png")):
        shutil.copy(os.path.join(work, f"ws_{s*2}.png"), os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(work, "ws.icns")], check=False)
PY
  if [ -f "$WORK/ws.icns" ]; then
    cp "$WORK/ws.icns" "$APP_BUNDLE/Contents/Resources/applet.icns"
    # 에셋 카탈로그를 가리키는 키가 남아있으면 파일 아이콘이 무시된다
    plutil -remove CFBundleIconName "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null
    # 아이콘을 바꾸면 osacompile이 해둔 서명이 깨져서 macOS가 기본 아이콘으로 떨어뜨린다
    codesign --force --deep -s - "$APP_BUNDLE" 2>/dev/null
  fi
fi
touch "$APP_BUNDLE"
# 내려받은 폴더에서 만들면 격리 표시가 따라붙어 "확인되지 않은 개발자"로 막힌다.
xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null
"$LSREGISTER" -f "$APP_BUNDLE" 2>/dev/null
ok "$APP_BUNDLE"

# 이름 기록을 새 이름으로 바꾼 뒤, 이름이 바뀌었으면 옛 앱 하나를 지운다.
mkdir -p "$INSTALL_DIR"
printf '%s\n' "$DOCK_NAME" > "$NAME_RECORD"
if [ -n "$OLD_NAME" ] && [ "$OLD_NAME" != "$DOCK_NAME" ]; then
  remove_old_bundle "$OLD_NAME"
fi
exit 0
