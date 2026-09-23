#!/bin/bash
# 워크스페이스 업데이트 스크립트
#
#   bash update.sh              새 버전 받기 (6단계)
#   bash update.sh --rollback   이전 버전과 백업 데이터로 되돌리기
#   bash update.sh --yes        묻지 않고 기본 선택으로 진행(고친 파일은 그대로 둔다)
#
# 순서: 확인 → 백업 → 받기 → 변환 → 재시작 → 점검.
# **업무 데이터는 이 스크립트가 지우지 않는다.** 코드만 갈아끼우고, 데이터는 먼저 복사해 둔 뒤
# 형식 변환만 한다. 어느 단계든 실패하면 이전 코드와 백업 데이터로 되돌릴 수 있다(--rollback).
#
# 프로세스를 이름으로 찾아 끝내는 일은 하지 않는다 — 앱을 다시 띄우는 것은 맥 스케줄러(launchd)에
# 등록된 정확한 이름 하나(com.workspace.app.server)에만 부탁한다.

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
die()  { echo "  ✗ $1"; echo; echo "업데이트를 멈췄어요. 앱과 데이터는 그대로예요."; exit 1; }

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
# 잠금 파일(.mutation.lock)은 되돌릴 대상이 아니라서 뺀다.
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
  [ -f "$LAST_GOOD" ] || die "되돌릴 자리를 찾지 못했어요 — 업데이트한 기록이 없어요."
  REF="$(tr -d '[:space:]' < "$LAST_GOOD")"
  [ -n "$REF" ] || die "되돌릴 자리를 찾지 못했어요."
  git checkout --detach --quiet "$REF" || die "이전 코드로 되돌리지 못했어요 — 고친 파일이 있는지 확인해 주세요."
  ok "코드를 이전 자리($REF)로 되돌렸어요"
  LAST_BACKUP="$(backup_dirs | tail -1)"
  if [ -n "$LAST_BACKUP" ]; then
    restore_backup "$BACKUP_ROOT/$LAST_BACKUP"
    ok "백업($LAST_BACKUP)의 데이터를 되돌렸어요"
  else
    warn "되돌릴 백업이 없어 데이터는 그대로 뒀어요."
  fi
  restart_app
  VERSION="$(tr -d '[:space:]' < "$WORKSPACE/VERSION" 2>/dev/null)"
  if health_check; then ok "v${VERSION}으로 돌아왔어요"; else warn "앱이 아직 응답하지 않아요 — 잠시 뒤 앱을 열어 확인해 주세요."; fi
  # 두 번 되돌리지 않는다.
  rm -f "$LAST_GOOD"
  echo
  exit 0
fi

echo
echo "워크스페이스 업데이트 (지금 v${VERSION:-알 수 없음} · ${CHANNEL})"
echo

# ─────────────────────────────────────────────  1. 확인
echo "[1/6] 고친 파일 확인"
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
      SAVED="$(git stash create 2>/dev/null)"
      if [ -n "$SAVED" ]; then
        git branch "local-changes-$STAMP" "$SAVED" >/dev/null 2>&1 && ok "고친 내용을 local-changes-$STAMP 가지에 담아 뒀어요"
      fi
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
  fi
fi

# ─────────────────────────────────────────────  4. 변환
echo "[4/6] 데이터 형식 변환"
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
    echo "    이전 버전과 백업 데이터로 되돌리려면:  bash update.sh --rollback"
    exit 1
  fi
  [ -n "$MIG_OUT" ] && ok "$MIG_OUT"
fi

# ─────────────────────────────────────────────  5. 재시작
echo "[5/6] 앱 다시 시작"
restart_app

# ─────────────────────────────────────────────  6. 점검
echo "[6/6] 잘 떴는지 확인"
if health_check; then
  if [ "$UPDATED" = "1" ]; then ok "v${VERSION}으로 업데이트했어요"; else ok "이미 최신이에요 · v${VERSION}이 잘 떠 있어요"; fi
  echo
  exit 0
fi
echo "  ! 앱이 응답하지 않아요"
if [ "$ASSUME_YES" = "1" ]; then
  ANSWER="n"
else
  read -r -p "  이전 버전으로 되돌릴까요? [y/n] " ANSWER
fi
case "$ANSWER" in
  y|Y) exec /bin/bash "$WORKSPACE/update.sh" --rollback ;;
  *)   echo "    그대로 뒀어요. 되돌리려면:  bash update.sh --rollback"; echo; exit 1 ;;
esac
