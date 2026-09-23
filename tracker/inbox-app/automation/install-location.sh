#!/bin/bash
# 설치 위치 지키기 — setup.sh·update.sh가 맨 앞에서 source해서 부른다(둘이 같은 판단을 쓴다).
#
#   install_location_guard <설치 폴더> <스크립트 이름> [원래 인자...]
#
# - 회사(playio) 폴더 안이면 **묻지 않고** ~/workspace로 옮긴 뒤, 새 위치의 같은 스크립트로 이어서
#   실행한다(exec — 돌아오지 않는다). 옮겼다는 표시로 WORKSPACE_RELOCATED=1을 넘긴다.
# - 옮길 수 없으면(대상이 이미 있음·다른 디스크·mv 실패) 이유를 말하고 1을 돌려준다 — 부른 쪽이 멈춘다.
#   아무것도 지우지 않는다(옮기기는 mv 한 번뿐이다).
# - 그 밖의 폴더는 어디든 그대로 쓴다. 바탕화면·문서·iCloud 아래면 경고 한 줄만 남긴다.
#
# 테스트는 대상 경로(WORKSPACE_RELOCATE_TARGET)만 바꿔 끼운다. 기본은 $HOME/workspace.

# 설치 폴더의 실제 경로(심볼릭 링크를 푼 것).
install_location_real() {
  (cd "$1" 2>/dev/null && pwd -P)
}

# 회사(playio) 폴더인가: 실제 경로의 어느 칸이든 playio를 포함하거나(대소문자 무시),
# 설치 폴더 **바깥쪽** git 저장소(설치 폴더 자신의 .git 말고)의 remote 주소에 playio가 있으면.
install_location_is_playio() {
  local real parent top remotes
  real="$(install_location_real "$1")" || return 1
  [ -n "$real" ] || return 1
  case "$(printf '%s' "$real" | tr '[:upper:]' '[:lower:]')" in
    *playio*) return 0 ;;
  esac
  parent="$(dirname "$real")"
  top="$(git -C "$parent" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$top" ] || return 1
  remotes="$(git -C "$top" remote -v 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  case "$remotes" in
    *playio*) return 0 ;;
  esac
  return 1
}

# 폴더가 있는 디스크의 장치 번호(맥은 stat -f, 리눅스는 stat -c). 테스트는 이 함수를 바꿔 끼운다.
install_location_device() {
  stat -f %d "$1" 2>/dev/null || stat -c %d "$1" 2>/dev/null
}

install_location_guard() {
  local workspace="$1" script="$2"
  shift 2
  local target="${WORKSPACE_RELOCATE_TARGET:-$HOME/workspace}"
  local shown="$target" real
  case "$target" in
    "$HOME"/*) shown="~${target#"$HOME"}" ;;
  esac
  local lead="회사(playio) 폴더 안에 설치돼 있어서 ${shown}로 옮겨야 하는데,"

  if install_location_is_playio "$workspace"; then
    # 무엇이든(파일·폴더·링크) 이미 있으면 건드리지 않는다.
    if [ -e "$target" ] || [ -L "$target" ]; then
      echo "  ✗ $lead ${shown}가 이미 있어요. 그 폴더 이름을 바꾼 뒤 다시 실행해 주세요."
      return 1
    fi
    # 다른 디스크면 이름 바꾸기 한 번으로 옮길 수 없다 — 복사는 시도하지 않는다.
    local from_dev to_dev
    from_dev="$(install_location_device "$workspace")"
    to_dev="$(install_location_device "$(dirname "$target")")"
    if [ -z "$from_dev" ] || [ -z "$to_dev" ] || [ "$from_dev" != "$to_dev" ]; then
      echo "  ✗ $lead 다른 디스크라 한 번에 옮길 수 없어요. 폴더를 직접 ${shown}로 옮긴 뒤 다시 실행해 주세요."
      return 1
    fi
    if ! mv "$workspace" "$target" 2>/dev/null; then
      if [ -d "$workspace" ] && [ ! -e "$target" ]; then
        echo "  ✗ $lead 옮기지 못했어요. 아무것도 옮겨지지 않았어요 — 폴더를 직접 ${shown}로 옮긴 뒤 다시 실행해 주세요."
      else
        echo "  ✗ $lead 옮기다 멈췄어요. $workspace 와 $shown 를 확인해 주세요."
      fi
      return 1
    fi
    export WORKSPACE_RELOCATED=1
    exec bash "$target/$script" "$@"
  fi

  real="$(install_location_real "$workspace")"
  case "$real/" in
    "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Library/Mobile Documents/"*)
      echo "  ! 바탕화면·문서·iCloud 폴더는 동기화 때문에 느리거나 파일이 꼬일 수 있어요 — 권장 위치는 ~/workspace예요."
      ;;
  esac
  return 0
}
