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

# 같은 이름의 앱이 이미 있으면 이 스크립트가 만든 앱(스크립트 앱)일 때만 바꾼다 —
# Dock 이름을 다른 앱과 같게 지었을 때 그 앱을 지우지 않게.
if [ -e "$APP_BUNDLE" ] && [ ! -f "$APP_BUNDLE/Contents/Resources/Scripts/main.scpt" ]; then
  warn "$APP_BUNDLE 은 다른 앱이라 그대로 뒀어요 — 설정 › 꾸미기에서 Dock 이름을 바꿔 주세요."
  exit 1
fi
# 새 앱은 임시 폴더에 먼저 다 만든 뒤(osacompile·아이콘·서명) 성공했을 때만 기존 앱과 바꾼다 —
# 도중에 실패하면 기존 앱은 그대로 남는다.
NEW_BUNDLE="$WORK/new.app"
# 크롬이 있으면 창 하나짜리 앱 모양으로, 없으면 기본 브라우저로 연다. 크롬이 사용자 폴더(~/Applications)에
# 깔린 맥도 있다(동료 사례) — 두 자리를 다 본다.
CHROME_APP=""
for candidate in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
  [ -d "$candidate" ] && { CHROME_APP="$candidate"; break; }
done
if [ -n "$CHROME_APP" ]; then
# 이미 열려 있는 앱 창이 있으면 새 창을 띄우지 않고 그 창을 앞으로 가져온다(Dock을 누를 때마다 창이 늘던 것).
# 처음 한 번 맥이 "크롬을 제어하도록 허용할까요?"를 묻는다 — 거절해도 try로 넘어가 예전처럼 새 창을 연다.
cat > "$WORK/launcher.applescript" << SCRIPT
set theURL to "$URL"
try
  if application "Google Chrome" is running then
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if (URL of t) starts with theURL then
            set index of w to 1
            activate
            return
          end if
        end repeat
      end repeat
    end tell
  end if
end try
do shell script "URL=$URL; for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null --max-time 1 \$URL && break; sleep 0.5; done; '$CHROME_APP/Contents/MacOS/Google Chrome' $PROFILE_ARG--app=\$URL > /dev/null 2>&1 &"
SCRIPT
else
cat > "$WORK/launcher.applescript" << SCRIPT
do shell script "URL=$URL; for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null --max-time 1 \$URL && break; sleep 0.5; done; open \$URL"
SCRIPT
  warn "크롬이 없어 기본 브라우저로 열어요"
fi

if ! osacompile -o "$NEW_BUNDLE" "$WORK/launcher.applescript" 2>/dev/null || [ ! -d "$NEW_BUNDLE" ]; then
  warn "앱을 만들지 못했어요 — 기존 앱은 그대로 뒀어요. 브라우저에서 $URL 로 직접 열어 주세요."
  exit 1
fi

# 아이콘(icns)은 $WORK/ws.icns 하나로 만든다.
#   - 내 그림(local/icon.png — 업데이트해도 그 폴더는 그대로 남는다)이 없으면 저장소에 미리 만들어 둔 기본 토끼
#     `icons/app.icns`를 그대로 복사한다. python3를 부르지 않는다 — 맥 기본 python3에는 Pillow가 없다.
#   - 내 그림이 있으면: 꾸미기 화면이 둥근 모서리를 깎아 저장한 그림(모서리가 투명)은 맥 기본 `sips`로 크기만
#     바꾼다. 모서리가 투명하지 않은 옛 그림은 Pillow가 있으면 지금처럼 둥글게, 없으면 sips로 각진 채 넣고 한 줄 남긴다.
#   - 어느 쪽도 못 만들면 조용히 넘어가지 않고 한 줄 남긴 뒤 기본 토끼로 둔다.
ICON_USER="$WORKSPACE/local/icon.png"
ICON_DEFAULT="$APP_DIR/icons/app.icns"

# 꾸미기 화면이 둥글게 깎아 저장한 그림인가(왼쪽 위 픽셀이 투명한가) — personalize.js의 iconRounded와 같은 판단.
icon_rounded() {
  node -e 'process.exit(require(process.argv[1]).iconRounded(require("fs").readFileSync(process.argv[2])) ? 0 : 1)' \
    "$APP_DIR/personalize.js" "$1" 2>/dev/null
}

# sips로 크기만 바꿔 iconset → icns. JPEG도 PNG로 바꿔 쓴다. 새로 만든 폴더(sips.iconset)에만 쓴다.
icns_by_sips() {
  local src="$1" set="$WORK/sips.iconset" s
  command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1 || return 1
  mkdir "$set" 2>/dev/null || return 1
  for s in 16 32 128 256 512; do
    sips -s format png -z "$s" "$s" "$src" --out "$set/icon_${s}x${s}.png" >/dev/null 2>&1 || return 1
    sips -s format png -z "$((s * 2))" "$((s * 2))" "$src" --out "$set/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || return 1
  done
  iconutil -c icns "$set" -o "$WORK/ws.icns" 2>/dev/null
  [ -f "$WORK/ws.icns" ]
}

# Pillow로 둥근 모서리까지(옛 그림용). Pillow가 없으면 파이썬이 실패하고 ws.icns가 생기지 않는다.
icns_by_pillow() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1" "$WORK" << 'PY' 2>/dev/null
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
  [ -f "$WORK/ws.icns" ]
}

if [ -f "$ICON_USER" ]; then
  if icon_rounded "$ICON_USER"; then
    icns_by_sips "$ICON_USER"
  elif icns_by_pillow "$ICON_USER"; then
    :
  elif icns_by_sips "$ICON_USER"; then
    ok "내 그림을 둥근 모서리 없이 넣었어요 — 설정 › 꾸미기에서 그림을 다시 저장하면 둥글게 돼요"
  fi
  if [ ! -f "$WORK/ws.icns" ]; then
    warn "아이콘을 만들지 못했어요 — 기본 아이콘으로 둬요"
    [ -f "$ICON_DEFAULT" ] && cp "$ICON_DEFAULT" "$WORK/ws.icns"
  fi
elif [ -f "$ICON_DEFAULT" ]; then
  cp "$ICON_DEFAULT" "$WORK/ws.icns"
fi
if [ -f "$WORK/ws.icns" ]; then
  cp "$WORK/ws.icns" "$NEW_BUNDLE/Contents/Resources/applet.icns"
  # 에셋 카탈로그를 가리키는 키가 남아있으면 파일 아이콘이 무시된다
  plutil -remove CFBundleIconName "$NEW_BUNDLE/Contents/Info.plist" 2>/dev/null
  # 아이콘을 바꾸면 osacompile이 해둔 서명이 깨져서 macOS가 기본 아이콘으로 떨어뜨린다
  codesign --force --deep -s - "$NEW_BUNDLE" 2>/dev/null
fi

# 다 만들었으면 바꾼다. 기존 앱은 위에서 이 스크립트가 만든 앱(스크립트 앱)인 것을 확인했다.
mkdir -p "$APPS_DIR"
[ -d "$APP_BUNDLE" ] && rm -rf "$APP_BUNDLE"
if ! mv "$NEW_BUNDLE" "$APP_BUNDLE"; then
  warn "앱을 옮기지 못했어요 — 브라우저에서 $URL 로 직접 열어 주세요."
  exit 1
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
