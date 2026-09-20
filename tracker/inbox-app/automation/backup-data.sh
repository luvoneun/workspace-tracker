#!/bin/bash
# 업무 데이터(tracker/의 할 일·결정·보고 등)를 하루 한 번 Git으로 백업한다.
# 이 데이터는 코드 저장소에서 일부러 제외돼 있어서(.gitignore) 따로 챙기지 않으면 백업이 전혀 없다.
#
# 백업용 Git 저장 공간은 프로젝트 밖에 두고(작업 폴더에 .git을 만들지 않는다), 올릴 파일은
# 그 안의 info/exclude 허용 목록으로 고정한다 — 접속 암호·잠금·.backups는 절대 올라가지 않는다.
# 파일을 읽기만 하므로 앱의 저장을 방해하지 않는다(앱은 파일을 통째로 교체하는 방식으로 저장한다).

set -uo pipefail

WORKSPACE="${WORKSPACE_DIR:-$HOME/personal}"
BACKUP_GIT="${DATA_BACKUP_GIT_DIR:-$HOME/.local/share/workspace-automation/data-backup.git}"
LOG_DIR="${AUTOMATION_LOG_DIR:-$HOME/.local/share/workspace-automation/logs}"
LOG="$LOG_DIR/data-backup.log"

# launchd는 PATH가 거의 비어 있다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LOG_DIR"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }
G() { git --git-dir="$BACKUP_GIT" --work-tree="$WORKSPACE/tracker" "$@"; }

if [ ! -d "$BACKUP_GIT" ]; then
  say "백업 실패 — 백업 저장 공간이 없음 ($BACKUP_GIT)"
  exit 1
fi

G add -A >> "$LOG" 2>&1 || { say "백업 실패 — 파일을 담지 못함"; exit 1; }
if G diff --cached --quiet; then
  say "변경 없음"
else
  G commit -q -m "자동 백업 $(date '+%Y-%m-%d %H:%M')" >> "$LOG" 2>&1 || { say "백업 실패 — 커밋하지 못함"; exit 1; }
  say "백업 커밋 완료"
fi

# 원격(비공개 저장소)이 연결돼 있으면 올린다. 맥이 고장 나도 복구할 수 있는 건 이 단계 덕분이다.
if G remote get-url origin >/dev/null 2>&1; then
  if G push -q origin main >> "$LOG" 2>&1; then say "원격 업로드 완료"; else say "백업 실패 — 원격 업로드 실패 (로컬 커밋은 남아 있음)"; exit 1; fi
fi

tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
