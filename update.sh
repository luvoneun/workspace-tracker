#!/bin/bash
# 워크스페이스 업데이트 스크립트
#
#   bash update.sh              새 버전 받기 (6단계)
#   bash update.sh --rollback   이전 버전과 백업 데이터로 되돌리기
#   bash update.sh --yes        묻지 않고 기본 선택으로 진행(고친 파일은 그대로 둔다)
#
# 순서: (위치) → 확인 → 백업 → 받기 → 변환 → 재시작 → 점검.
# 회사(playio) 폴더 안에 설치돼 있으면 맨 먼저 묻지 않고 ~/workspace로 옮긴 뒤 새 위치에서 이어서 돈다
# (automation/install-location.sh — setup.sh와 같은 판단). 옮길 수 없으면 아무것도 바꾸지 않고 멈춘다.
# **업무 데이터는 이 스크립트가 지우지 않는다.** 코드만 갈아끼우고, 데이터는 먼저 복사해 둔 뒤
# 형식 변환만 한다. 어느 단계든 실패하면 이전 코드와 백업 데이터로 되돌릴 수 있다(--rollback).
#
# 프로세스를 이름으로 찾아 끝내는 일은 하지 않는다 — 앱을 다시 띄우는 것은 맥 스케줄러(launchd)에
# 등록된 정확한 이름 하나(com.workspace.app.server)에만 부탁한다.

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0. 설치 위치 지키기 — 회사(playio) 폴더면 ~/workspace로 옮기고 새 위치의 update.sh로 이어서 돈다(돌아오지 않는다).
if [ -f "$WORKSPACE/tracker/inbox-app/automation/install-location.sh" ]; then
  # shellcheck source=tracker/inbox-app/automation/install-location.sh
  . "$WORKSPACE/tracker/inbox-app/automation/install-location.sh"
  install_location_guard "$WORKSPACE" "update.sh" "$@" || { echo; echo "업데이트를 멈췄어요. 앱과 데이터는 그대로예요."; exit 1; }
fi
cd "$WORKSPACE" || exit 1
APP_DIR="$WORKSPACE/tracker/inbox-app"
CONFIG="$WORKSPACE/workspace.config.json"
# 업무 데이터가 있는 곳(기본은 이 폴더 안 tracker/).
DATA_DIR="${WORKSPACE_DATA_DIR:-$WORKSPACE/tracker}"
# 앱이 실행 중에 남기는 상태 파일 3개가 있는 곳.
STATE_DIR="${WORKSPACE_DATA_DIR:-$APP_DIR}"
BACKUP_ROOT="${WORKSPACE_BACKUP_DIR:-$HOME/workspace-data-backup}"
INSTALL_DIR="${WORKSPACE_INSTALL_DIR:-$HOME/.local/share/workspace-automation}"
LAST_GOOD="$WORKSPACE/.workspace-last-good"
LABEL="com.workspace.app.server"
BACKUP_KEEP=5
BACKUP_NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$'

ok()   { echo "  ✓ $1"; }
warn() { echo "  ! $1"; }
die()  {
  echo "  ✗ $1"
  # 앱 안 `업데이트 받기`로 돌고 있으면 화면이 이유를 보여 주게 상태 파일에도 남긴다.
  declare -F status_write >/dev/null && status_write failed "$1"
  echo; echo "업데이트를 멈췄어요. 앱과 데이터는 그대로예요."; exit 1
}

ASSUME_YES=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --rollback) ROLLBACK=1 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    *) echo "모르는 옵션이에요: $arg"; exit 2 ;;
  esac
done

# 업무 데이터로 세는 파일들. .gitignore의 "내 개인 업무 데이터"·"실행 중 생기는 상태"와 같은 목록이다.
# 잠금 파일(.mutation.lock)은 되돌릴 대상이 아니라서 뺀다. 매일 백업(automation/backup-data.sh)도 같은 목록을 쓴다
# (거기서는 접속 암호 .access-token만 뺀다 — 테스트가 두 목록을 견준다).
DATA_FILES="tasks.md decisions.md checks.md ideas.md weekly_reports.md calendar_today.md jira_issues.md slack_inbox.md meeting_drafts.json .trash.json .workflow.json .report-drafts.json .access-token .request-ledger.json .mutation-journal.json .data-version"
STATE_FILES=".slack_capture_state.json .weekly_report_state.json .meeting_links.json"

# 설정에서 받는 갈래(stable=배포된 버전만 / main=만드는 중인 것까지)와 포트를 읽는다.
read_config() {
  python3 - "$CONFIG" << 'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f:
        config = json.load(f)
except Exception:
    config = {}
server = config.get('server') or {}
print(server.get('updateChannel') or 'stable')
print(server.get('port') or 4321)
PY
}
CFG="$(read_config)"
CHANNEL="$(printf '%s\n' "$CFG" | sed -n 1p)"
PORT="$(printf '%s\n' "$CFG" | sed -n 2p)"
[ -n "$CHANNEL" ] || CHANNEL="stable"
[ -n "$PORT" ] || PORT=4321

VERSION="$(tr -d '[:space:]' < "$WORKSPACE/VERSION" 2>/dev/null)"

# 진행 상황 파일 — 앱의 설정 › 앱 `업데이트 받기`가 2초마다 읽는다(update-runner.sh가 WORKSPACE_UPDATE_STATUS=1을 준다).
# 환경변수가 없으면(터미널·업데이트.command) 아무것도 쓰지 않는다. 임시 파일에 쓴 뒤 이름을 바꿔 한 번에 바뀐다.
STATUS_FILE="$INSTALL_DIR/update-status.json"
STATUS_ACTION="update"
[ "$ROLLBACK" = "1" ] && STATUS_ACTION="rollback"
STATUS_STEP=0
STATUS_FROM="$VERSION"
STATUS_TO=""
STATUS_STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
UPDATE_STEP_NAMES="고친 파일 확인|데이터 백업|새 버전 받기|데이터 형식 변환|앱 다시 시작|잘 떴는지 확인"
ROLLBACK_STEP_NAMES="코드 되돌리기|데이터 되돌리기|앱 다시 시작|잘 떴는지 확인"
STATUS_WRITER='
const fs = require("fs");
const [file, action, from, to, stepText, state, message, startedAt, names] = process.argv.slice(1);
const step = Number(stepText) || 0;
const steps = names.split("|").map((name, index) => {
  const n = index + 1;
  let mark = n < step ? "done" : (n === step ? "doing" : "todo");
  if (n === step && state === "failed") mark = "failed";
  if (state === "done") mark = "done";
  return { name, state: mark };
});
const now = new Date().toISOString();
const body = { action, from: from || null, to: to || null, step, steps, state, startedAt, updatedAt: now };
if (message) body.message = message;
if (state !== "running") body.finishedAt = now;
const temp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(body)}\n`);
fs.renameSync(temp, file);
'
# status_write <running|done|failed> [한 줄 이유]
status_write() {
  [ -n "${WORKSPACE_UPDATE_STATUS:-}" ] || return 0
  local names="$UPDATE_STEP_NAMES"
  [ "$STATUS_ACTION" = "rollback" ] && names="$ROLLBACK_STEP_NAMES"
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null
  node -e "$STATUS_WRITER" "$STATUS_FILE" "$STATUS_ACTION" "$STATUS_FROM" "$STATUS_TO" "$STATUS_STEP" "$1" "${2:-}" "$STATUS_STARTED" "$names" 2>/dev/null || true
}
status_step() { STATUS_STEP="$1"; status_write running; }

# 추적 파일 중 고친 것·지운 것만 센다(미추적·gitignore는 빠지므로 업무 데이터는 절대 잡히지 않는다).
changed_files() {
  git status --porcelain 2>/dev/null | awk '
    {
      state = substr($0, 1, 2); name = substr($0, 4)
      if (index(state, "?") || index(state, "!")) next
      if (index(state, "M") || index(state, "D")) { sub(/^.* -> /, "", name); print name }
    }'
}

# vX.Y.Z 태그 중 가장 높은 것
latest_tag() {
  git tag -l 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1
}

# 업데이트 직전 백업 목록 — 이 스크립트가 만든 이름(2026-09-23-1930)만 본다. 같은 폴더 안의 `daily/`
# (backup-data.sh의 매일 백업, 그 안은 YYYY-MM-DD)는 이름이 달라 목록·정리·되돌리기 어디에도 잡히지 않는다.
backup_dirs() {
  ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -E "$BACKUP_NAME_RE" | sort
}

copy_one() {
  [ -f "$1" ] || return 0
  cp -p "$1" "$2" || die "파일을 복사하지 못했어요: $1"
}

# 앱을 다시 띄운다. 이름을 정확히 지정해 맥 스케줄러에만 부탁한다.
restart_app() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    if launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      ok "앱을 다시 시작했어요"
      return 0
    fi
    warn "앱을 다시 시작하지 못했어요 — 맥을 다시 로그인하면 떠요."
    return 1
  fi
  warn "앱이 맥 스케줄러에 등록돼 있지 않아요 — 먼저 bash setup.sh 를 실행해 주세요."
  return 1
}

# 앱이 새 버전으로 떴는지 10초까지 기다려 본다.
health_check() {
  local i body
  for i in 1 2 3 4 5 6 7 8 9 10; do
    body="$(curl -s --max-time 2 "http://127.0.0.1:$PORT/api/about" 2>/dev/null)"
    case "$body" in
      *"\"version\":\"$VERSION\""*) return 0 ;;
    esac
    sleep 1
  done
  return 1
}

restore_backup() {
  local from="$1" f
  for f in $DATA_FILES; do
    [ -f "$from/$f" ] && cp -p "$from/$f" "$DATA_DIR/$f"
  done
  for f in $STATE_FILES; do
    [ -f "$from/$f" ] && cp -p "$from/$f" "$STATE_DIR/$f"
  done
  [ -f "$from/workspace.config.json" ] && cp -p "$from/workspace.config.json" "$CONFIG"
  return 0
}

# ─────────────────────────────────────────────  되돌리기
if [ "$ROLLBACK" = "1" ]; then
  echo
  echo "이전 버전으로 되돌려요"
  echo
  status_step 1
  [ -f "$LAST_GOOD" ] || die "되돌릴 자리를 찾지 못했어요 — 업데이트한 기록이 없어요."
  REF="$(tr -d '[:space:]' < "$LAST_GOOD")"
  [ -n "$REF" ] || die "되돌릴 자리를 찾지 못했어요."
  git checkout --detach --quiet "$REF" || die "이전 코드로 되돌리지 못했어요 — 고친 파일이 있는지 확인해 주세요."
  ok "코드를 이전 자리($REF)로 되돌렸어요"
  STATUS_TO="$(tr -d '[:space:]' < "$WORKSPACE/VERSION" 2>/dev/null)"
  status_step 2
  LAST_BACKUP="$(backup_dirs | tail -1)"
  if [ -n "$LAST_BACKUP" ]; then
    restore_backup "$BACKUP_ROOT/$LAST_BACKUP"
    ok "백업($LAST_BACKUP)의 데이터를 되돌렸어요"
  else
    warn "되돌릴 백업이 없어 데이터는 그대로 뒀어요."
  fi
  status_step 3
  restart_app
  status_step 4
  VERSION="$(tr -d '[:space:]' < "$WORKSPACE/VERSION" 2>/dev/null)"
  if health_check; then
    ok "v${VERSION}으로 돌아왔어요"
    status_write done
  else
    warn "앱이 아직 응답하지 않아요 — 잠시 뒤 앱을 열어 확인해 주세요."
    status_write failed "앱이 아직 응답하지 않아요 — 잠시 뒤 앱을 열어 확인해 주세요"
  fi
  # 두 번 되돌리지 않는다.
  rm -f "$LAST_GOOD"
  echo
  exit 0
fi

echo
echo "워크스페이스 업데이트 (지금 v${VERSION:-알 수 없음} · ${CHANNEL})"
[ "${WORKSPACE_RELOCATED:-}" = "1" ] && echo "0. 설치 위치 옮기기 — 회사 폴더 밖 ~/workspace로 옮겼어요"
echo

# ─────────────────────────────────────────────  1. 확인
echo "[1/6] 고친 파일 확인"
status_step 1
CHANGED="$(changed_files)"
if [ -n "$CHANGED" ]; then
  echo "  고친 파일이 있어요: $(printf '%s' "$CHANGED" | tr '\n' ' ')"
  if [ "$ASSUME_YES" = "1" ]; then
    ANSWER="n"
  else
    read -r -p "  되돌리고 받을까요? [y] / 그대로 둘까요? [n] " ANSWER
  fi
  case "$ANSWER" in
    y|Y)
      STAMP="$(date '+%Y-%m-%d-%H%M%S')"
      # 지금 고친 내용을 커밋 하나로 만들어 가지로 남긴다(작업 폴더는 건드리지 않는 방법).
      # 이게 실패하면(빈 값) 고친 내용이 어디에도 남아 있지 않다 — 그 상태로 되돌리면 그대로 사라지므로
      # 지우지 않고 멈춘다. 명령은 테스트에서만 바꿔 끼운다(빈 값이 나오는 상황을 흉내 내려고).
      SAVED="$(${WORKSPACE_STASH_CREATE:-git stash create} 2>/dev/null)"
      [ -n "$SAVED" ] || die "고친 내용을 보관하지 못해 멈췄어요 — 고친 파일을 직접 정리한 뒤 다시 실행해 주세요"
      git branch "local-changes-$STAMP" "$SAVED" >/dev/null 2>&1 \
        || die "고친 내용을 보관하지 못해 멈췄어요 — 고친 파일을 직접 정리한 뒤 다시 실행해 주세요"
      ok "고친 내용을 local-changes-$STAMP 가지에 담아 뒀어요"
      git checkout -- . || die "고친 파일을 되돌리지 못했어요."
      ok "고친 파일을 원래대로 돌렸어요"
      ;;
    *)
      ok "고친 파일은 그대로 둬요"
      ;;
  esac
else
  ok "고친 파일 없음"
fi

# ─────────────────────────────────────────────  2. 백업
echo "[2/6] 데이터 백업"
status_step 2
STAMP="$(date '+%Y-%m-%d-%H%M')"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST" || die "백업 폴더를 만들지 못했어요: $DEST"
for f in $DATA_FILES; do copy_one "$DATA_DIR/$f" "$DEST/$f"; done
for f in $STATE_FILES; do copy_one "$STATE_DIR/$f" "$DEST/$f"; done
copy_one "$CONFIG" "$DEST/workspace.config.json"
COPIED="$(ls -1 "$DEST" 2>/dev/null | wc -l | tr -d ' ')"
ok "$DEST 에 파일 ${COPIED}개를 복사했어요"
# 오래된 백업은 최근 5개만 남긴다 — 이 스크립트가 만든 이름(2026-09-23-1930)에 맞는 폴더만 본다.
ALL="$(backup_dirs)"
TOTAL="$(printf '%s\n' "$ALL" | grep -c .)"
if [ "$TOTAL" -gt "$BACKUP_KEEP" ]; then
  printf '%s\n' "$ALL" | sed -n "1,$((TOTAL - BACKUP_KEEP))p" | while IFS= read -r old; do
    [ -n "$old" ] && rm -rf "$BACKUP_ROOT/$old"
  done
  ok "오래된 백업을 정리해 최근 ${BACKUP_KEEP}개만 남겼어요"
fi

# ─────────────────────────────────────────────  3. 받기
echo "[3/6] 새 버전 받기"
status_step 3
BEFORE="$(git rev-parse HEAD 2>/dev/null)"
[ -n "$BEFORE" ] || die "코드 저장소를 찾지 못했어요."
printf '%s\n' "$BEFORE" > "$LAST_GOOD"
git fetch --tags --quiet origin 2>/dev/null || die "새 버전을 받아오지 못했어요 — 인터넷 연결을 확인해 주세요."
UPDATED=0
if [ "$CHANNEL" = "main" ]; then
  TARGET="$(git rev-parse origin/main 2>/dev/null)"
  [ -n "$TARGET" ] || die "origin/main 을 찾지 못했어요."
  if [ "$TARGET" = "$BEFORE" ]; then
    ok "이미 최신이에요"
  else
    git merge --ff-only origin/main >/dev/null 2>&1 || die "고친 파일 때문에 업데이트를 이어 갈 수 없어요"
    UPDATED=1
  fi
else
  TAG="$(latest_tag)"
  [ -n "$TAG" ] || die "받을 버전을 찾지 못했어요 — 아직 배포된 버전이 없어요."
  TARGET="$(git rev-parse "$TAG^{commit}" 2>/dev/null)"
  if [ "$TARGET" = "$BEFORE" ]; then
    ok "이미 최신이에요 ($TAG)"
  else
    git checkout --detach --quiet "$TAG" || die "고친 파일 때문에 업데이트를 이어 갈 수 없어요"
    UPDATED=1
  fi
fi
if [ "$UPDATED" = "1" ]; then
  VERSION="$(tr -d '[:space:]' < "$WORKSPACE/VERSION" 2>/dev/null)"
  ok "v${VERSION}을 받았어요"
  # 자동화 스크립트는 저장소 밖 복사본이 돈다. 새 코드로 함께 갱신한다.
  if [ -d "$INSTALL_DIR" ]; then
    cp "$APP_DIR/automation/run-task.sh" "$APP_DIR/automation/slack-capture.sh" "$APP_DIR/automation/backup-data.sh" "$INSTALL_DIR/" 2>/dev/null \
      && chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null \
      && ok "자동화 스크립트 복사본도 갱신했어요"
    # 설치 위치 판단(setup.sh·update.sh가 같이 쓰는 것)도 복사본 규칙대로 함께 둔다. 없는 옛 버전이면 건너뛴다.
    [ -f "$APP_DIR/automation/install-location.sh" ] && cp "$APP_DIR/automation/install-location.sh" "$INSTALL_DIR/" 2>/dev/null
    # Dock 앱 만들기(설정 › 꾸미기가 부른다)도 복사본이 돈다. 이 파일이 없는 옛 버전이면 건너뛴다.
    [ -f "$APP_DIR/automation/app-refresh.sh" ] && cp "$APP_DIR/automation/app-refresh.sh" "$INSTALL_DIR/" 2>/dev/null \
      && chmod +x "$INSTALL_DIR/app-refresh.sh" 2>/dev/null
    # 앱 안 `업데이트 받기` 실행기도 복사본이 돈다(지금 이 실행기가 돌고 있어도 안전하다 — 실행기는 통째로 읽고 시작한다).
    [ -f "$APP_DIR/automation/update-runner.sh" ] && cp "$APP_DIR/automation/update-runner.sh" "$INSTALL_DIR/" 2>/dev/null \
      && chmod +x "$INSTALL_DIR/update-runner.sh" 2>/dev/null
  fi
fi

STATUS_TO="$VERSION"

# ─────────────────────────────────────────────  4. 변환
echo "[4/6] 데이터 형식 변환"
status_step 4
if [ "$UPDATED" = "0" ]; then
  ok "받은 것이 없어 건너뛰어요"
else
  MIG_OUT="$(node "$APP_DIR/migrate.js" --data "$DATA_DIR" 2>&1)"
  CODE=$?
  if [ "$CODE" = "3" ]; then
    die "이 데이터는 더 새 버전의 앱이 만든 거예요. 앱을 업데이트해 주세요."
  elif [ "$CODE" != "0" ]; then
    [ -n "$MIG_OUT" ] && echo "    $MIG_OUT"
    echo "  ✗ 데이터 형식을 바꾸지 못했어요."
    status_write failed "데이터 형식을 바꾸지 못했어요"
    echo "    이전 버전과 백업 데이터로 되돌리려면:  bash update.sh --rollback"
    exit 1
  fi
  [ -n "$MIG_OUT" ] && ok "$MIG_OUT"
fi

# ─────────────────────────────────────────────  5. 재시작
echo "[5/6] 앱 다시 시작"
status_step 5
if [ "${WORKSPACE_RELOCATED:-}" = "1" ]; then
  # 폴더를 옮겼으면 launchd에 적힌 경로가 옛 자리다 — 다시 시작만 하면 뜨지 않는다. 새 위치의 setup.sh(묻는 것 없음)로
  # launchd 경로·workspace.env·Dock 앱을 다시 적고, 그 등록이 앱을 새 위치에서 띄운다.
  if WORKSPACE_RELOCATED= bash "$WORKSPACE/setup.sh"; then
    ok "새 위치($WORKSPACE)로 자동화·앱을 다시 등록했어요"
  else
    warn "새 위치로 다시 등록하지 못했어요 — bash $WORKSPACE/setup.sh 를 한 번 실행해 주세요."
  fi
else
  restart_app
fi

# ─────────────────────────────────────────────  6. 점검
echo "[6/6] 잘 떴는지 확인"
status_step 6
if health_check; then
  if [ "$UPDATED" = "1" ]; then ok "v${VERSION}으로 업데이트했어요"; else ok "이미 최신이에요 · v${VERSION}이 잘 떠 있어요"; fi
  status_write done
  echo
  exit 0
fi
echo "  ! 앱이 응답하지 않아요"
# 앱 안에서 돌 때(--yes)는 묻지 않고 되돌리지도 않는다 — 상태 파일에 실패를 남기고, 화면에서 사람이 `이전 버전으로 되돌리기`를 누른다.
status_write failed "앱이 응답하지 않아요"
if [ "$ASSUME_YES" = "1" ]; then
  ANSWER="n"
else
  read -r -p "  이전 버전으로 되돌릴까요? [y/n] " ANSWER
fi
case "$ANSWER" in
  y|Y) exec /bin/bash "$WORKSPACE/update.sh" --rollback ;;
  *)   echo "    그대로 뒀어요. 되돌리려면:  bash update.sh --rollback"; echo; exit 1 ;;
esac
