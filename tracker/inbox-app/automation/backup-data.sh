#!/bin/bash
# 업무 데이터(tracker/의 할 일·결정·보고 등)를 하루 한 번(19:30, launchd `data-backup`) 백업한다.
# 이 데이터는 코드 저장소에서 일부러 제외돼 있어서(.gitignore) 따로 챙기지 않으면 백업이 전혀 없다. 두 겹이다:
#
#   1. 이 맥 안(모두 — 나와 동료가 같은 기본 동작): 데이터 파일을 ~/workspace-data-backup/daily/YYYY-MM-DD/에
#      복사한다. 임시 폴더에 다 복사한 뒤 이름을 바꿔 넣고(같은 날 다시 돌면 그날 것을 교체), 7일치만 남긴다.
#      update.sh의 업데이트 직전 백업(같은 폴더 바로 아래 YYYY-MM-DD-HHMM)과는 섞이지 않는다 — 여기서는
#      daily/ 안의 이름이 정확히 YYYY-MM-DD인 폴더만 보고, update.sh는 daily/를 보지 않는다.
#   2. GitHub(추가 한 겹): 백업용 Git 저장 공간(data-backup.git)을 만들어 둔 사람만. 저장 공간은 프로젝트 밖에 두고
#      (작업 폴더에 .git을 만들지 않는다), 올릴 파일은 그 안의 info/exclude 허용 목록으로 고정한다.
#
# 결과는 로그에 두 줄로 남는다 — 앱의 설정 › 앱 `데이터 백업` 줄이 이 두 줄을 읽는다:
#   `로컬 성공 · 7일치` / `로컬 실패 — 이유`
#   `GitHub 성공` / `GitHub 실패 — 이유` / `GitHub 건너뜀 — 이유`
# 파일을 읽기만 하므로 앱의 저장을 방해하지 않는다(앱은 파일을 통째로 교체하는 방식으로 저장한다).

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
BACKUP_GIT="${DATA_BACKUP_GIT_DIR:-$HOME/.local/share/workspace-automation/data-backup.git}"
LOG_DIR="${AUTOMATION_LOG_DIR:-$HOME/.local/share/workspace-automation/logs}"
LOG="$LOG_DIR/data-backup.log"
# 업무 데이터가 있는 곳 — update.sh와 같은 규칙(데이터는 tracker/, 실행 중 상태 파일은 tracker/inbox-app/).
DATA_DIR="${WORKSPACE_DATA_DIR:-$WORKSPACE/tracker}"
STATE_DIR="${WORKSPACE_DATA_DIR:-$WORKSPACE/tracker/inbox-app}"
BACKUP_ROOT="${WORKSPACE_BACKUP_DIR:-$HOME/workspace-data-backup}"
DAILY="$BACKUP_ROOT/daily"
DAILY_KEEP=7
DAILY_NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

# 백업할 파일 — update.sh의 DATA_FILES·STATE_FILES와 같은 목록이다(테스트가 두 목록을 견준다).
# 단 접속 암호(.access-token)는 뺀다: 다른 기기에서 여는 암호라 사본을 7벌 늘릴 이유가 없고, 잃어버려도
# 설치할 때 새로 만들어진다(업무 데이터가 아니다).
DATA_FILES="tasks.md decisions.md checks.md ideas.md weekly_reports.md calendar_today.md jira_issues.md slack_inbox.md meeting_drafts.json .trash.json .workflow.json .report-drafts.json .request-ledger.json .mutation-journal.json .data-version"
STATE_FILES=".slack_capture_state.json .weekly_report_state.json .meeting_links.json"

# launchd는 PATH가 거의 비어 있다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LOG_DIR"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }
G() { git --git-dir="$BACKUP_GIT" --work-tree="$WORKSPACE/tracker" "$@"; }
FAILED=0

# ─────────────────────────────  1. 이 맥 안(모두)
DAY="$(date '+%Y-%m-%d')"
TMP="$DAILY/.tmp-$DAY-$$"

# 임시 폴더를 비우고 지운다 — 우리가 복사한 이름만 지운다(폴더째 지우지 않는다).
drop_tmp() {
  local f
  [ -d "$TMP" ] || return 0
  for f in $DATA_FILES $STATE_FILES; do rm -f "$TMP/$f"; done
  rmdir "$TMP" 2>/dev/null
  return 0
}

# 날짜 폴더 하나를 지운다 — 이름이 정확히 YYYY-MM-DD일 때만, 그 경로 하나만.
drop_day() {
  local name="$1"
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  [ -n "$DAILY" ] && [ -d "$DAILY/$name" ] || return 0
  rm -rf -- "$DAILY/$name"
}

local_backup() {
  local f
  mkdir -p "$DAILY" || { say "로컬 실패 — 백업 폴더를 만들지 못함 ($DAILY)"; return 1; }
  drop_tmp
  mkdir "$TMP" || { say "로컬 실패 — 임시 폴더를 만들지 못함"; return 1; }
  for f in $DATA_FILES; do
    [ -f "$DATA_DIR/$f" ] || continue
    cp -p "$DATA_DIR/$f" "$TMP/$f" || { drop_tmp; say "로컬 실패 — 파일을 복사하지 못함 ($f)"; return 1; }
  done
  for f in $STATE_FILES; do
    [ -f "$STATE_DIR/$f" ] || continue
    cp -p "$STATE_DIR/$f" "$TMP/$f" || { drop_tmp; say "로컬 실패 — 파일을 복사하지 못함 ($f)"; return 1; }
  done
  # 다 복사한 뒤에만 오늘 것을 바꿔 넣는다(같은 날 다시 돌면 그날 것을 교체).
  drop_day "$DAY" || { drop_tmp; say "로컬 실패 — 오늘 폴더를 바꾸지 못함"; return 1; }
  mv "$TMP" "$DAILY/$DAY" || { drop_tmp; say "로컬 실패 — 오늘 폴더를 만들지 못함"; return 1; }

  # 7일치만 남긴다 — 이름이 정확히 날짜인 폴더만, 날짜순으로 가장 오래된 것부터.
  local all total old
  all="$(ls -1 "$DAILY" 2>/dev/null | grep -E "$DAILY_NAME_RE" | sort)"
  total="$(printf '%s\n' "$all" | grep -c .)"
  if [ "$total" -gt "$DAILY_KEEP" ]; then
    printf '%s\n' "$all" | sed -n "1,$((total - DAILY_KEEP))p" | while IFS= read -r old; do
      [ -n "$old" ] && drop_day "$old"
    done
    total="$DAILY_KEEP"
  fi
  say "로컬 성공 · ${total}일치"
  return 0
}
local_backup || FAILED=1

# ─────────────────────────────  2. GitHub(추가 한 겹 — 저장 공간이 있을 때만)
github_backup() {
  if [ ! -d "$BACKUP_GIT" ]; then
    say "GitHub 건너뜀 — 백업 저장 공간을 만들지 않음"
    return 0
  fi
  G add -A >> "$LOG" 2>&1 || { say "GitHub 실패 — 파일을 담지 못함"; return 1; }
  if ! G diff --cached --quiet; then
    G commit -q -m "자동 백업 $(date '+%Y-%m-%d %H:%M')" >> "$LOG" 2>&1 || { say "GitHub 실패 — 커밋하지 못함"; return 1; }
  fi
  # 원격(비공개 저장소)이 연결돼 있으면 올린다. 맥이 고장 나도 복구할 수 있는 건 이 단계 덕분이다.
  if G remote get-url origin >/dev/null 2>&1; then
    if G push -q origin main >> "$LOG" 2>&1; then
      say "GitHub 성공"
    else
      say "GitHub 실패 — 원격 업로드 실패 (이 맥의 백업 커밋은 남아 있음)"
      return 1
    fi
  else
    say "GitHub 건너뜀 — 원격 저장소가 연결되지 않음 (이 맥에만 커밋함)"
  fi
  return 0
}
github_backup || FAILED=1

tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit "$FAILED"
