#!/bin/bash
# 팀 전용 설치 파일 만들기 (만드는 사람만 쓴다).
#
#   bash make-team-installer.sh            ~/Desktop/워크스페이스-설치.zip 을 만든다
#   bash make-team-installer.sh <폴더>      그 폴더에 만든다
#
# 만든 zip을 동료에게 DM으로 보내면, 동료는 zip을 풀고 터미널에 `bash `를 친 뒤 `설치.command`를 끌어다 놓고 Enter 한 번으로 끝난다
# (최신 macOS는 인터넷에서 받은 .command를 우클릭 → 열기로도 막는다 — 시스템 설정 › 개인정보 보호 및 보안 › 그래도 열기로도 된다)
# (git·node 확인 → ~/workspace에 받기 → 팀 값 채우기 → setup.sh). 이미 설치한 사람이 열면(workspace.env가 이 저장소
# 폴더를 가리키면) 새로 받지 않고 그 폴더에서 update.sh → setup.sh로 업데이트한다. 메신저로 보내면 실행 권한이 빠지는데
# zip이 그걸 지켜 준다.
#
# 지키는 것:
#   - 내 workspace.config.json에서 **허용 목록 값만** 담는다 — slack.workspaceUrl · slack.appUrl · slack.clientId(팀이 다른
#     슬랙 앱을 쓸 때만 적는 값 — 비밀이 아니다) · jira.siteUrl, 그리고 받는 갈래(내 설정과 무관하게 stable — TEAM_UPDATE_CHANNEL=main일 때만 main). 토큰·토큰 파일·이메일·이름·채널·extraHost·
#     chromeProfile·제목·앱 이름(dockName)·캘린더는 절대 담지 않는다.
#     슬랙 연결 방식(slack.auth)·갱신 정보 파일(slack.oauthFile)도 담지 않는다 — 연결은 사람마다 자기 맥에서 `허용`을 눌러 한다.
#   - 값마다 https 주소 규칙을 확인하고, 어긋난 값은 그 값만 빼고 알린다.
#   - 저장소 주소는 이 폴더의 origin(https://github.com/…)에서만 가져온다.
#   - 이미 같은 이름의 zip이 있으면 덮어쓰지 않고 멈춘다.
#   - 담은 값 목록을 화면에 보여 준다(비밀이 아닌 값만이라 보여 줘도 된다).

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$WORKSPACE/workspace.config.json"
OUT_DIR="${1:-$HOME/Desktop}"
ZIP_NAME="워크스페이스-설치.zip"
COMMAND_NAME="설치.command"

ok()   { echo "  ✓ $1"; }
warn() { echo "  ! $1"; }
die()  { echo "  ✗ $1"; echo; echo "설치 파일을 만들지 않았어요."; exit 1; }

echo
echo "팀 전용 설치 파일을 만들어요"
echo

[ -d "$OUT_DIR" ] || die "만들 폴더가 없어요: $OUT_DIR"
ZIP="$OUT_DIR/$ZIP_NAME"
if [ -e "$ZIP" ] || [ -L "$ZIP" ]; then
  die "$ZIP 가 이미 있어요 — 옮기거나 이름을 바꾼 뒤 다시 실행해 주세요(덮어쓰지 않아요)."
fi
command -v node >/dev/null 2>&1 || die "node가 없어요."
command -v ditto >/dev/null 2>&1 || die "ditto가 없어요(맥에서 실행해 주세요)."
[ -f "$CONFIG" ] || die "workspace.config.json이 없어요 — 먼저 bash setup.sh 를 실행해 주세요."

# 저장소 주소 — origin이 https://github.com/<소유자>/<저장소>(.git)일 때만.
REPO_URL="$(git -C "$WORKSPACE" remote get-url origin 2>/dev/null)"
if ! printf '%s' "$REPO_URL" | grep -Eqx 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?'; then
  die "이 폴더의 origin이 https://github.com/… 주소가 아니에요 — 동료가 받을 수 있는 주소가 필요해요."
fi

# 허용 목록 값만 뽑는다. 결과: 1줄째 팀 설정 JSON, 2줄째 받는 갈래, 그 뒤는 `담음|키|값` 또는 `뺌|키`.
PICKED="$(node -e '
const fs = require("fs");
let config;
try { config = JSON.parse(fs.readFileSync(process.argv[1], "utf-8")); } catch (error) { process.exit(3); }
const group = (name) => (config && typeof config[name] === "object" && config[name]) || {};
const rules = [
  ["slack", "workspaceUrl", /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.slack\.com\/?$/],
  ["slack", "appUrl", /^https:\/\/api\.slack\.com\/apps\/[A-Za-z0-9]+(\/[A-Za-z0-9_\/-]*)?$/],
  // 슬랙 앱의 Client ID(숫자.숫자) — 허용 화면 주소에 그대로 실리는 값이라 비밀이 아니다. 내 설정에 적어 뒀을 때만 담긴다
  // (비어 있으면 코드 기본값을 쓴다). 연결 방식·갱신 정보·토큰은 이 목록에 없다.
  ["slack", "clientId", /^[0-9]{6,20}\.[0-9]{6,20}$/],
  ["jira", "siteUrl", /^https:\/\/[A-Za-z0-9-]+\.atlassian\.net\/?$/],
];
const team = {};
const lines = [];
for (const [name, key, rule] of rules) {
  const value = group(name)[key];
  if (value === undefined || value === null || value === "") continue;
  if (typeof value === "string" && rule.test(value)) {
    (team[name] = team[name] || {})[key] = value;
    lines.push(`담음|${name}.${key}|${value}`);
  } else {
    lines.push(`뺌|${name}.${key}`);
  }
}
// 받는 갈래는 내 설정을 따르지 않는다 — 나는 main(만드는 중)을 받아도 팀은 배포된 버전(stable)이 기본이다.
// 팀에 main을 주려면 TEAM_UPDATE_CHANNEL=main으로 따로 정한다.
const channel = process.env.TEAM_UPDATE_CHANNEL === "main" ? "main" : "stable";
team.server = { updateChannel: channel };
lines.push(`담음|server.updateChannel|${channel}`);
process.stdout.write([JSON.stringify(team), channel, ...lines].join("\n") + "\n");
' "$CONFIG")" || die "workspace.config.json을 읽지 못했어요."

TEAM_CONFIG="$(printf '%s\n' "$PICKED" | sed -n 1p)"
CHANNEL="$(printf '%s\n' "$PICKED" | sed -n 2p)"
# 쉘 글자 안에 그대로 넣으므로, 규칙을 통과한 값에는 작은따옴표·역슬래시가 없다는 것을 한 번 더 확인한다.
case "$TEAM_CONFIG$REPO_URL$CHANNEL" in *"'"*|*'\'*) die "담을 값에 쓸 수 없는 글자가 있어요." ;; esac

FOLDER_NAME="워크스페이스-설치"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/workspace-team-installer.XXXXXX")" || die "임시 폴더를 만들지 못했어요."
FOLDER="$STAGE/$FOLDER_NAME"
mkdir "$FOLDER" || die "임시 폴더를 만들지 못했어요."
COMMAND="$FOLDER/$COMMAND_NAME"
cleanup() { rm -f "$COMMAND"; rmdir "$FOLDER" 2>/dev/null; rmdir "$STAGE" 2>/dev/null; }
trap cleanup EXIT

{
  echo '#!/bin/bash'
  echo "# 워크스페이스 설치 파일 — $(date '+%Y-%m-%d') 에 만들었어요. 묻는 것 없이 ~/workspace에 설치해요(이미 설치돼 있으면 업데이트)."
  echo '# 더블클릭이 막히면: 터미널에 bash (띄어쓰기) 친 뒤 이 파일을 끌어다 놓고 Enter.'
  echo
  echo "REPO_URL='$REPO_URL'"
  echo "CHANNEL='$CHANNEL'"
  echo "TEAM_CONFIG='$TEAM_CONFIG'"
  cat << 'INSTALLER'

set -uo pipefail
TARGET="$HOME/workspace"
SHOWN="~${TARGET#"$HOME"}"
[ "$SHOWN" = "~$TARGET" ] && SHOWN="$TARGET"

ok()   { echo "  ✓ $1"; }
finish() {
  echo
  # 더블클릭으로 연 터미널 창이면 바로 닫히지 않게 한 번 기다린다.
  [ -t 0 ] && read -n 1 -s -r -p "아무 키나 누르면 닫혀요"
  exit "$1"
}
stop() { echo "  ✗ $1"; echo; echo "설치를 멈춰요."; finish 1; }

echo
echo "워크스페이스를 설치해요"
echo

# 1. git·node 확인 — 없으면 설치 방법을 한 줄씩 알리고 멈춘다(대신 설치하지 않는다).
MISSING=0
if ! git --version >/dev/null 2>&1; then
  echo "  ✗ git이 없어요 — 터미널에서 xcode-select --install 을 실행해 설치한 뒤 이 파일을 다시 열어 주세요."
  MISSING=1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node가 없어요 — https://nodejs.org 에서 LTS를 설치한 뒤 이 파일을 다시 열어 주세요."
  MISSING=1
fi
if [ "$MISSING" = "1" ]; then echo; echo "설치를 멈춰요."; finish 1; fi
ok "git·node 있음"

# 2. 기존 설치 찾기 → ~/workspace에 받기.
# 이 앱이 이미 설치돼 있으면(setup.sh가 적어 둔 workspace.env가 이 저장소 폴더를 가리키면) 새로 받지 않고 그 폴더를
# 업데이트한다 — 다른 폴더에 설치한 사람이 열어도 빈 데이터로 새로 설치되지 않게.
# 없으면 ~/workspace에 새로 받고(stable이면 배포된 최신 버전으로), 이미 이 앱이면 그대로 이어 간다.
repo_at() {
  local dir="$1" have want
  have="$(git -C "$dir" remote get-url origin 2>/dev/null)"
  # SSH 주소(git@github.com:소유자/저장소)로 받은 설치도 같은 저장소로 알아본다.
  case "$have" in git@github.com:*) have="https://github.com/${have#git@github.com:}" ;; esac
  have="${have%/}"; have="${have%.git}"
  want="${REPO_URL%/}"; want="${want%.git}"
  [ -d "$dir/.git" ] && [ -n "$have" ] && [ "$have" = "$want" ]
}
same_repo() { repo_at "$TARGET"; }
real_dir() { (cd "$1" 2>/dev/null && pwd -P); }
shown_path() {
  case "$1" in
    "$HOME"/*) printf '%s' "~${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}
# workspace.env는 실행하지 않고 WORKSPACE_DIR="…" 한 줄만 글자로 읽는다(setup.sh가 쓰는 형식).
EXISTING=""
ENV_FILE="$HOME/.local/share/workspace-automation/workspace.env"
if [ -f "$ENV_FILE" ]; then
  ENV_LINE="$(grep -m 1 '^WORKSPACE_DIR=' "$ENV_FILE" 2>/dev/null)"
  ENV_DIR="${ENV_LINE#WORKSPACE_DIR=}"
  ENV_DIR="${ENV_DIR#\"}"; ENV_DIR="${ENV_DIR%\"}"
  case "$ENV_DIR" in
    /*) [ -d "$ENV_DIR" ] && repo_at "$ENV_DIR" && EXISTING="$ENV_DIR" ;;
  esac
fi
MODE="install"
if [ -n "$EXISTING" ]; then
  EXISTING_SHOWN="$(shown_path "$EXISTING")"
  # ~/workspace에 이 앱이 한 벌 더 있으면 어느 쪽이 진짜인지 고르지 않고 멈춘다(아무것도 바꾸지 않는다).
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    if same_repo && [ "$(real_dir "$TARGET")" != "$(real_dir "$EXISTING")" ]; then
      stop "이미 설치된 앱(${EXISTING_SHOWN})과 ${SHOWN}에 한 벌이 더 있어요. 쓰던 데이터는 ${EXISTING_SHOWN}에 있어요. ${SHOWN} 폴더 이름을 바꾼 뒤(예: workspace-old) 다시 열어 주세요."
    fi
  fi
  ok "이미 설치돼 있어요(${EXISTING_SHOWN}) — 업데이트로 진행할게요"
  TARGET="$EXISTING"
  SHOWN="$EXISTING_SHOWN"
  MODE="update"
elif [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  same_repo || stop "${SHOWN}가 이미 있어요 — 이름을 바꾼 뒤 다시 실행해 주세요"
  # workspace.env가 없는데 받아 둔 폴더만 있으면 설치가 끝나지 않은 것 — 업데이트 말고 설치(setup)만 마저 한다.
  ok "$SHOWN 에 이미 받아 뒀어요 — 그대로 이어서 설치해요"
else
  git clone --quiet "$REPO_URL" "$TARGET" || stop "앱을 받아오지 못했어요 — 인터넷 연결을 확인해 주세요."
  if [ "$CHANNEL" = "stable" ]; then
    TAG="$(git -C "$TARGET" tag -l 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
    if [ -n "$TAG" ]; then
      git -C "$TARGET" checkout --detach --quiet "$TAG" || stop "배포된 버전($TAG)으로 옮기지 못했어요."
      ok "$SHOWN 에 받았어요 ($TAG)"
    else
      ok "$SHOWN 에 받았어요"
    fi
  else
    ok "$SHOWN 에 받았어요 (main)"
  fi
fi

# 3. 설정 파일 — 없으면 예시 파일에 팀 값을 채워 만들고, 있으면 비어 있는 팀 칸만 채운다(다른 칸은 그대로).
# 새로 만들 때는 setup.sh와 같게 4321을 이미 쓰고 있으면 빈 포트를 고른다.
NEW_PORT=4321
if [ ! -f "$TARGET/workspace.config.json" ] && command -v lsof >/dev/null 2>&1; then
  tries=0
  while [ "$tries" -lt 10 ] && lsof -nP -iTCP:"$NEW_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    NEW_PORT=$((NEW_PORT + 1))
    tries=$((tries + 1))
  done
fi
CONFIG_RESULT="$(node -e '
const fs = require("fs");
const [file, example, teamText, port] = process.argv.slice(1);
const team = JSON.parse(teamText);
const fresh = !fs.existsSync(file);
let config;
try { config = JSON.parse(fs.readFileSync(fresh ? example : file, "utf-8")); } catch (error) { process.exit(3); }
// 예시 파일의 자리 표시(내회사)는 빈 칸으로 본다.
const empty = (value) => value === undefined || value === null || value === "" || (typeof value === "string" && value.includes("내회사"));
let changed = fresh;
for (const [group, values] of Object.entries(team)) {
  if (!config[group] || typeof config[group] !== "object") config[group] = {};
  for (const [key, value] of Object.entries(values)) {
    if (fresh || empty(config[group][key])) {
      if (config[group][key] !== value) changed = true;
      config[group][key] = value;
    }
  }
}
if (fresh) {
  // setup.sh가 새로 만들 때와 같게 — 제목은 맥 계정 이름에서.
  let name = "";
  try { name = require("child_process").execFileSync("id", ["-F"], { encoding: "utf-8" }).trim(); } catch (error) { name = ""; }
  config.title = name ? `${name}의 워크스페이스` : "워크스페이스";
  if (!config.server || typeof config.server !== "object") config.server = {};
  config.server.port = Number(port) || 4321;
}
if (changed) fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
process.stdout.write(fresh ? "new" : (changed ? "filled" : "same"));
' "$TARGET/workspace.config.json" "$TARGET/workspace.config.example.json" "$TEAM_CONFIG" "$NEW_PORT")" \
  || stop "설정 파일을 만들지 못했어요."
case "$CONFIG_RESULT" in
  new)    ok "설정 파일을 만들고 팀 값을 채웠어요" ;;
  filled) ok "설정 파일의 빈 팀 칸을 채웠어요 (다른 칸은 그대로)" ;;
  *)      ok "설정 파일 있음 (그대로 둬요)" ;;
esac

# 4. 설치 — 끝나면 앱 주소를 연다(크롬이 있으면 크롬으로). 이미 받아 둔 폴더면 먼저 update.sh로 코드를 새 버전으로 바꾼다
# (업데이트.command와 같은 순서 — update.sh가 폴더를 ~/workspace로 옮겼을 수 있어서 setup.sh는 실제 위치에서 부른다).
echo
cd "$TARGET" || stop "$SHOWN 로 들어가지 못했어요."
if [ "$MODE" = "update" ]; then
  bash update.sh || finish 1
  cd "$(pwd -P)" || finish 1
  echo
fi
WORKSPACE_OPEN_APP=1 bash setup.sh
finish $?
INSTALLER
} > "$COMMAND" || die "설치 파일을 쓰지 못했어요."
chmod 755 "$COMMAND"

# 설명서 파일은 zip에 넣지 않는다 — 앱이 바뀔 때마다 zip을 다시 만들지 않게. 여는 법은 아래 `보낼 문구`로 함께 보내고,
# 설치 뒤 안내는 설치 화면과 앱의 사용설명서가 맡는다.
ditto -c -k --sequesterRsrc --keepParent "$FOLDER" "$ZIP" || die "zip으로 묶지 못했어요."
ok "$ZIP 를 만들었어요"
echo
echo "  담은 값"
echo "    저장소 : $REPO_URL"
printf '%s\n' "$PICKED" | sed -n '3,$p' | while IFS='|' read -r kind key value; do
  case "$kind" in
    담음) echo "    $key = $value" ;;
    뺌)   echo "  ! $key — 규칙에 맞지 않아 뺐어요" ;;
  esac
done
echo
echo "  토큰·이메일·채널 같은 개인 값은 담지 않았어요."
echo "  이 zip을 동료에게 DM으로 보내 주세요. 아래 문구를 같이 보내면 돼요."
echo
cat << 'MESSAGE'
  ── 보낼 문구 ──
  워크스페이스 설치 파일이에요. (5분)
  1. zip을 풀어요.
  2. 터미널을 열고(⌘+스페이스 → 터미널) bash 를 치고 한 칸 띄운 뒤,
     「설치.command」를 터미널 창으로 끌어다 놓고 Enter.
     (더블클릭은 맥이 막아요 — 위험한 파일이 아니라 애플 인증이 없어서예요)
  3. 끝나면 앱이 열려요. 오늘 탭 사용설명서의 「설치하기」를 눌러 주세요.
  막히면 터미널 화면을 캡처해서 보내 주세요.
  ────────────────
MESSAGE
echo
