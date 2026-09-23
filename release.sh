#!/bin/bash
# 새 버전을 내보내는 스크립트(만드는 사람만 쓴다).
#
#   bash release.sh              지금 버전 보기
#   bash release.sh 1.2.0        테스트 → VERSION 갱신·커밋 → v1.2.0 태그
#   bash release.sh 1.2.0 --push 위와 같고 올리기까지
#
# 동료들은 `stable` 갈래에서 이 태그만 받는다(update.sh). 태그를 만들기 전에 테스트를 전부 돌려서,
# 깨진 코드가 배포된 버전이 되지 않게 한다.

set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WORKSPACE" || exit 1
VERSION_FILE="$WORKSPACE/VERSION"

ok()  { echo "  ✓ $1"; }
die() { echo "  ✗ $1"; echo; echo "릴리스를 멈췄어요."; exit 1; }

CURRENT="$(tr -d '[:space:]' < "$VERSION_FILE" 2>/dev/null)"

if [ "$#" -eq 0 ]; then
  echo
  echo "지금 버전: ${CURRENT:-(VERSION 파일 없음)}"
  echo "  새 버전을 내려면:  bash release.sh 1.2.0 [--push]"
  echo
  exit 0
fi

NEW="$1"
PUSH=0
[ "${2:-}" = "--push" ] && PUSH=1
echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "버전은 1.2.0 처럼 적어 주세요."

echo
echo "v$NEW 릴리스 준비 (지금 ${CURRENT:-?})"
echo

# 추적 파일에 고친 것이 남아 있으면 무엇이 태그에 담기는지 알 수 없다(미추적 파일은 보지 않는다).
DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null)"
[ -z "$DIRTY" ] || die "커밋하지 않은 변경이 있어요 — 먼저 정리해 주세요.
$DIRTY"
ok "작업 폴더 깨끗함"

git rev-parse "v$NEW" >/dev/null 2>&1 && die "v$NEW 태그가 이미 있어요."

echo "  테스트를 돌려요 (조금 걸려요)"
( cd "$WORKSPACE/tracker/inbox-app" && node --test server.test.js client.test.js report-drafts.test.js ) || die "테스트가 통과하지 않았어요."
ok "테스트 통과"

# VERSION이 이미 그 값이면(첫 릴리스처럼) 커밋할 것이 없다 — 그때는 태그만 단다.
if [ "$CURRENT" = "$NEW" ]; then
  git tag "v$NEW" || die "태그를 만들지 못했어요."
  ok "VERSION은 이미 $NEW · v$NEW 태그"
else
  printf '%s\n' "$NEW" > "$VERSION_FILE"
  git add "$VERSION_FILE" || die "VERSION을 담지 못했어요."
  git commit -q -m "릴리스 v$NEW" || die "커밋하지 못했어요."
  git tag "v$NEW" || die "태그를 만들지 못했어요."
  ok "VERSION 갱신 · 커밋 · v$NEW 태그"
fi

echo
if [ "$PUSH" = "1" ]; then
  git push origin main --tags || die "올리지 못했어요."
  ok "origin에 올렸어요 — 동료의 앱은 다음 업데이트에서 v$NEW 를 받아요"
else
  echo "  아직 올리지 않았어요. 올리려면:  git push origin main --tags"
fi
echo
