#!/usr/bin/env bash
# 합친 뒤 정리 도구 — 가지가 main에 들어간 걸 확인하고 세션 종료 → 복사본(worktree) 삭제 → 가지 삭제 → 장부 두 줄.
# 세션은 이름표로만 고른다(launched/<이름표>.json 또는 장부의 sessionId). 프로세스 목록·이름 글자로 훑지 않고, kill 계열·강제 삭제는 쓰지 않는다.
# 시험용으로 AFTER_MERGE_CLAUDE(claude 명령)·AFTER_MERGE_LEDGER_JS(장부 스크립트)·AFTER_MERGE_BOARD(~/.session-board 자리)를 바꿔 끼울 수 있다.
set -euo pipefail

usage() { echo "쓰는 법: tools/after-merge.sh <가지> [--task <이름표>] [--merge-task <합치기 이름표>] [--dry-run]" >&2; exit 2; }

CLAUDE_BIN="${AFTER_MERGE_CLAUDE:-claude}"
LEDGER_JS="${AFTER_MERGE_LEDGER_JS:-/Users/luvon/session-board/app/lib/ledger.js}"
BOARD="${AFTER_MERGE_BOARD:-$HOME/.session-board}"
BASE=main

branch="" task="" merge_task="" dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --task) [ $# -ge 2 ] || usage; task="$2"; shift 2 ;;
    --merge-task) [ $# -ge 2 ] || usage; merge_task="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --*) usage ;;
    *) [ -z "$branch" ] || usage; branch="$1"; shift ;;
  esac
done
[ -n "$branch" ] || usage
for t in "$task" "$merge_task"; do
  case "$t" in *[!A-Za-z0-9._-]*) echo "오류: 이름표는 영문·숫자·._- 만 쓸 수 있음: $t" >&2; exit 2 ;; esac
done
[ "$branch" != "$BASE" ] || { echo "멈춤: main 은 정리 대상이 아님" >&2; exit 1; }

root=$(git rev-parse --show-toplevel)
cd "$root"

# 1. 확인 먼저
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null || { echo "멈춤: 가지가 없음: $branch" >&2; exit 1; }
if ! git merge-base --is-ancestor "$branch" "$BASE"; then
  echo "멈춤: $branch 는 아직 $BASE 에 합쳐지지 않았음(아무것도 안 함)" >&2
  exit 1
fi
short=$(git rev-parse --short "$BASE")

# 복사본 찾기(주 작업 트리와 지금 있는 트리는 대상이 아님)
wt=""
cur=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) cur="${line#worktree }" ;;
    "branch refs/heads/$branch") wt="$cur" ;;
  esac
done < <(git worktree list --porcelain)
main_wt=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
if [ -n "$wt" ] && { [ "$wt" = "$main_wt" ] || [ "$wt" = "$root" ]; }; then
  echo "멈춤: $branch 의 복사본이 주 작업 트리이거나 지금 있는 폴더라 지울 수 없음: $wt" >&2
  exit 1
fi
if [ -n "$wt" ]; then
  dirty=$(git -C "$wt" status --short)
  if [ -n "$dirty" ]; then
    echo "멈춤: 복사본에 커밋 안 된 파일이 있음($wt) — 사람이 보고 결정:" >&2
    echo "$dirty" >&2
    exit 1
  fi
fi

# 세션 id 찾기 — 이름표로만
find_sid() { # <이름표>
  [ -n "$1" ] || return 0
  node -e '
    const fs = require("fs"), path = require("path");
    const [board, task] = process.argv.slice(1);
    let sid = "";
    try { sid = JSON.parse(fs.readFileSync(path.join(board, "launch-queue", "launched", task + ".json"), "utf8")).sessionId || ""; } catch {}
    if (!sid) {
      try {
        for (const l of fs.readFileSync(path.join(board, "ledger", task + ".jsonl"), "utf8").split("\n")) {
          if (!l.trim()) continue;
          try { const o = JSON.parse(l); if (o.sessionId) sid = o.sessionId; } catch {}
        }
      } catch {}
    }
    process.stdout.write(/^[0-9a-f-]{8,}$/i.test(sid) ? sid : "");
  ' "$BOARD" "$1"
}
sid=$(find_sid "$task")
alive=""
if [ -n "$sid" ]; then
  if "$CLAUDE_BIN" agents --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      try { process.exit(JSON.parse(s).some((a) => a.sessionId === process.argv[1]) ? 0 : 1); } catch { process.exit(1); }
    });' "$sid"; then alive=1; fi
fi

did=() skipped=()
plan() { echo "[할 일] $*"; }

# 2. 세션 종료
if [ -z "$task" ]; then
  skipped+=("세션 종료: --task 없음")
elif [ -z "$sid" ]; then
  skipped+=("세션 종료: '$task' 의 세션 id 를 못 찾음")
elif [ -z "$alive" ]; then
  skipped+=("세션 종료: 세션 ${sid:0:8} 은 이미 살아 있지 않음")
elif [ "$dry" = 1 ]; then
  plan "claude stop ${sid:0:8}  (이름표 $task)"
else
  "$CLAUDE_BIN" stop "${sid:0:8}" && did+=("세션 ${sid:0:8} 종료(이름표 $task)")
fi

# 3. 복사본 삭제
if [ -z "$wt" ]; then
  skipped+=("복사본 삭제: $branch 의 복사본이 없음")
elif [ "$dry" = 1 ]; then
  plan "git worktree remove $wt"
else
  git worktree remove "$wt" && did+=("복사본 삭제: $wt")
fi

# 4. 가지 삭제
if [ "$dry" = 1 ]; then
  plan "git branch -d $branch"
else
  git branch -d "$branch" >/dev/null && did+=("가지 삭제: $branch")
fi

# 5. 장부
for t in "$merge_task" "$task"; do
  [ -n "$t" ] || continue
  json="{\"task\":\"$t\",\"state\":\"done\",\"say\":\"합쳐졌어요. main $short.\"}"
  if [ "$dry" = 1 ]; then
    plan "장부: $json"
  elif node "$LEDGER_JS" add "$json" >/dev/null; then
    did+=("장부: $t done")
  else
    skipped+=("장부: $t 줄 쓰기 실패")
  fi
done
[ -n "$merge_task$task" ] || skipped+=("장부: 이름표 없음")

# 6. 보고
if [ "$dry" = 1 ]; then
  [ ${#skipped[@]} -eq 0 ] || printf '[건너뜀] %s\n' "${skipped[@]}"
  echo "(dry-run: 아무것도 바꾸지 않음)"
else
  [ ${#did[@]} -eq 0 ] || printf '[함] %s\n' "${did[@]}"
  [ ${#skipped[@]} -eq 0 ] || printf '[건너뜀] %s\n' "${skipped[@]}"
fi
