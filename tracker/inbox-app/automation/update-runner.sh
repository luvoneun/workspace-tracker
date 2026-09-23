#!/bin/bash
# 앱 안 `업데이트 받기`(설정 › 앱)의 작은 실행기.
#
# 앱 서버는 프로세스를 띄우지 않는다 — 요청 표시 파일(requests/update.request) 하나만 쓰고, 그걸 지켜보던
# launchd 에이전트(com.workspace.app.update)가 설치 위치 복사본의 이 스크립트를 한 번 돌린다.
#
#   update   → bash update.sh --yes, 성공하면 bash setup.sh (업데이트.command와 같은 순서)
#   rollback → bash update.sh --rollback --yes
#
# 지키는 것:
#   - 요청 파일에서는 action 두 값(update·rollback)만 비교한다. 그 밖의 글자는 명령·경로로 쓰지 않는다.
#     모양이 틀린 요청이면 그 요청 파일 하나만 지우고 아무것도 하지 않는다.
#   - 한 번에 하나만 돈다(mkdir 잠금 — slack-capture와 같은 방식). 잠금은 rmdir로만 푼다.
#   - 진행 상황은 update.sh가 update-status.json에 쓴다(WORKSPACE_UPDATE_STATUS=1). 그 전에 멈추면
#     (옮기기 실패 등) 여기서 실패 한 줄을 남긴다. 실패해도 자동으로 되돌리지 않는다 — 사람이 화면에서 누른다.
#   - 프로세스를 끝내는 일은 하지 않는다. 앱을 다시 띄우는 것은 update.sh가 launchd의 정확한 이름 하나에만 부탁한다.
#
# 업데이트가 이 파일의 복사본을 새 것으로 바꿔도 안전하게, 본문을 함수 하나로 감싸 통째로 읽은 뒤 시작한다.

main() {
  set -uo pipefail

  local install_dir="${WORKSPACE_INSTALL_DIR:-$HOME/.local/share/workspace-automation}"
  if [ -z "${WORKSPACE_DIR:-}" ]; then
    local env_file="${WORKSPACE_ENV_FILE:-$install_dir/workspace.env}"
    # shellcheck source=/dev/null
    [ -f "$env_file" ] && . "$env_file"
  fi
  local workspace="${WORKSPACE_DIR:-}"
  if [ -z "$workspace" ]; then
    echo "설치 정보를 찾을 수 없어요 — setup.sh를 먼저 실행해 주세요" >&2
    return 1
  fi

  # launchd는 PATH가 거의 비어 있다. 지금 PATH를 앞에 두고(테스트의 가짜 명령이 먼저 잡히게) 흔한 자리를 덧붙인다.
  local node_bin
  node_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
  export PATH="${PATH:+$PATH:}$HOME/.local/bin:${node_bin:+$node_bin:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  local request="$install_dir/requests/update.request"
  local status_file="$install_dir/update-status.json"
  local log_dir="${AUTOMATION_LOG_DIR:-$install_dir/logs}"
  local log="$log_dir/update.log"
  local lock="$log_dir/.update.lock"
  mkdir -p "$log_dir"

  # 요청 파일은 앱 서버가 쓰는 모양 그대로(`{"action":"update","requestedAt":"…"}` 한 줄)일 때만 받는다.
  # action은 두 값과 견주기만 하고, 파일의 다른 글자는 어디에도 쓰지 않는다.
  local action="" stamp='"requestedAt":"[0-9T:.Z-]{10,40}"'
  if [ -f "$request" ]; then
    if grep -Eqx "\{\"action\":\"update\",$stamp\}" "$request" 2>/dev/null; then
      action="update"
    elif grep -Eqx "\{\"action\":\"rollback\",$stamp\}" "$request" 2>/dev/null; then
      action="rollback"
    else
      # 모양이 틀린 요청은 그 파일 하나만 지운다(남겨 두면 다음에 다시 깨울 뿐이다). 내용은 어디에도 쓰지 않는다.
      rm -f "$request"
    fi
  fi
  [ -n "$action" ] || return 0

  # 한 번에 하나만. 잠금을 쥔 주인이 이미 없으면(비정상 종료) 그 잠금만 치운다 — 주인 확인은 명령줄로 한다.
  if ! mkdir "$lock" 2>/dev/null; then
    local holder
    holder="$(cat "$lock/pid" 2>/dev/null)"
    case "$holder" in ''|*[!0-9]*) holder="" ;; esac
    if [ -n "$holder" ]; then
      case "$(ps -o command= -p "$holder" 2>/dev/null)" in
        *update-runner*) echo "$(date '+%Y-%m-%d %H:%M:%S') 이미 도는 중이라 건너뛰어요" >> "$log"; return 0 ;;
      esac
    elif [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      # 방금 생긴 잠금(pid를 아직 못 쓴 찰나)은 살아 있다고 본다.
      return 0
    fi
    rm -f "$lock/pid"
    rmdir "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || return 0
  fi
  echo "$$" > "$lock/pid"

  # 요청은 한 번만 처리한다(이 파일이 지워지는 것도 launchd를 깨우지만, 그때는 파일이 없어 그냥 끝난다).
  # 지난 실행의 진행 상황 파일도 치운다 — 이번 실행이 처음부터 다시 쓴다.
  rm -f "$request" "$status_file"

  local started
  started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "───── $(date '+%Y-%m-%d %H:%M:%S') update-runner $action 시작" >> "$log"
  cd "$workspace" || { finish_failed "$status_file" "$action" "$started" "설치 폴더를 찾지 못했어요"; release_lock "$lock"; return 1; }

  local code=0
  if [ "$action" = "update" ]; then
    WORKSPACE_UPDATE_STATUS=1 WORKSPACE_INSTALL_DIR="$install_dir" bash ./update.sh --yes >> "$log" 2>&1
    code=$?
    if [ "$code" = "0" ]; then
      # 업데이트가 폴더를 옮겼을 수 있다(회사 폴더 안이었을 때) — 지금 폴더의 실제 위치에서 setup.sh를 부른다.
      # setup.sh는 이 실행기를 도는 update 에이전트는 다시 올리지 않는다(WORKSPACE_UPDATE_RUNNER=1 — 올리면 이 실행이 끊긴다).
      cd "$(pwd -P)" && WORKSPACE_UPDATE_RUNNER=1 bash ./setup.sh >> "$log" 2>&1
      code=$?
    fi
  else
    WORKSPACE_UPDATE_STATUS=1 WORKSPACE_INSTALL_DIR="$install_dir" bash ./update.sh --rollback --yes >> "$log" 2>&1
    code=$?
  fi
  echo "───── $(date '+%Y-%m-%d %H:%M:%S') update-runner $action 종료 (exit $code)" >> "$log"

  # update.sh가 실패를 적지 못하고 멈췄으면(상태 파일이 없거나 아직 running이면) 한 줄을 남긴다.
  # 멈춘 단계 번호(숫자만)는 이어 적는다 — ③ 새 버전 받기 이후에 멈췄으면 화면이 `이전 버전으로 되돌리기`를 보여 줘야 해서.
  if [ "$code" != "0" ] && ! grep -Eq '"state"[[:space:]]*:[[:space:]]*"(failed|done)"' "$status_file" 2>/dev/null; then
    local stopped
    stopped="$(grep -Eo '"step":[0-9]{1,2}' "$status_file" 2>/dev/null | head -n 1 | cut -d: -f2)"
    finish_failed "$status_file" "$action" "$started" "업데이트를 끝내지 못했어요 — 업데이트.command를 더블클릭해 주세요" "${stopped:-0}"
  fi
  release_lock "$lock"
  return 0
}

release_lock() {
  rm -f "$1/pid"
  rmdir "$1" 2>/dev/null
}

# 실행기가 직접 남기는 실패 한 줄. 글자는 이 파일에 적힌 고정 문구뿐이다.
finish_failed() {
  local file="$1" action="$2" started="$3" message="$4" step="${5:-0}" now temp
  case "$step" in ''|*[!0-9]*) step=0 ;; esac
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  temp="$file.tmp-$$"
  printf '{"action":"%s","from":null,"to":null,"step":%d,"steps":[],"state":"failed","message":"%s","startedAt":"%s","updatedAt":"%s","finishedAt":"%s"}\n' \
    "$action" "$((10#$step))" "$message" "$started" "$now" "$now" > "$temp" && mv -f "$temp" "$file"
}

main "$@"; exit $?
