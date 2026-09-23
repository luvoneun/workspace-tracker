#!/bin/bash
# 연동 저장 뒤 켠 자동화를 launchd에 등록하는 작은 실행기(설정 › 연동).
#
# 앱 서버는 프로세스를 띄우지 않는다 — 연동 저장이 등록에 영향을 주는 값(켬/끔·캘린더 갈래·슬랙 채널)을
# 바꿨으면 요청 표시 파일(requests/apply.request) 하나만 쓰고, 그걸 지켜보던 launchd 에이전트
# (com.workspace.app.apply)가 설치 위치 복사본의 이 스크립트를 한 번 돌린다.
#
#   apply → 저장소의 bash setup.sh (WORKSPACE_APPLY_RUNNER=1 — apply·update 에이전트는 다시 올리지 않고,
#           server 등록 내용이 그대로면 서버도 다시 올리지 않는다)
#
# 지키는 것:
#   - 요청 파일에서는 action 한 값(apply)만 비교한다. 그 밖의 글자는 명령·경로로 쓰지 않는다.
#     모양이 틀린 요청이면 그 요청 파일 하나만 지우고 아무것도 하지 않는다.
#   - 한 번에 하나만 돈다(mkdir 잠금 — update-runner와 같은 방식). 잠금은 rmdir로만 푼다.
#     도는 사이에 새 요청이 오면 끝난 뒤 이어서 한 번 더 돈다(최대 세 번).
#   - 결과는 logs/apply.log에 한 줄(`시각 자동화 등록 완료` / `시각 자동화 등록 실패 — …`)만 남긴다.
#     setup.sh의 출력은 logs/apply-setup.log에 (그 실행 것만) 둔다.
#   - 프로세스를 끝내는 일은 하지 않는다.
#
# setup.sh가 이 파일의 복사본을 새 것으로 바꿔도 안전하게, 본문을 함수 하나로 감싸 통째로 읽은 뒤 시작한다.

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

  local request="$install_dir/requests/apply.request"
  local log_dir="${AUTOMATION_LOG_DIR:-$install_dir/logs}"
  local log="$log_dir/apply.log"
  local setup_log="$log_dir/apply-setup.log"
  local lock="$log_dir/.apply.lock"
  mkdir -p "$log_dir"

  local round=0
  while [ "$round" -lt 3 ]; do
    round=$((round + 1))
    request_ok "$request" || return 0

    # 한 번에 하나만. 잠금을 쥔 주인이 이미 없으면(비정상 종료) 그 잠금만 치운다 — 주인 확인은 명령줄로 한다.
    if ! mkdir "$lock" 2>/dev/null; then
      local holder
      holder="$(cat "$lock/pid" 2>/dev/null)"
      case "$holder" in ''|*[!0-9]*) holder="" ;; esac
      if [ -n "$holder" ]; then
        case "$(ps -o command= -p "$holder" 2>/dev/null)" in
          # 도는 실행기가 끝난 뒤 남은 요청을 이어서 처리한다(요청 파일은 그대로 둔다).
          *apply-runner*) return 0 ;;
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
    rm -f "$request"

    local code=0
    if cd "$workspace" 2>/dev/null; then
      {
        echo "───── $(date '+%Y-%m-%d %H:%M:%S') apply-runner 시작"
        WORKSPACE_APPLY_RUNNER=1 bash ./setup.sh
        code=$?
        echo "───── $(date '+%Y-%m-%d %H:%M:%S') apply-runner 종료 (exit $code)"
      } > "$setup_log" 2>&1
    else
      code=1
    fi
    if [ "$code" = "0" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') 자동화 등록 완료" >> "$log"
    else
      echo "$(date '+%Y-%m-%d %H:%M:%S') 자동화 등록 실패 — 업데이트.command를 한 번 실행해 주세요" >> "$log"
    fi
    tail -n 200 "$log" > "$log.tmp-$$" && mv -f "$log.tmp-$$" "$log"

    rm -f "$lock/pid"
    rmdir "$lock" 2>/dev/null
    # 도는 사이에 새 요청이 왔으면 한 번 더(없으면 여기서 끝난다).
  done
  return 0
}

# 요청 파일이 앱 서버가 쓰는 모양 그대로(`{"action":"apply","requestedAt":"…"}` 한 줄)인가.
# 모양이 틀리면 그 파일 하나만 지운다(남겨 두면 다음에 다시 깨울 뿐이다). 내용은 어디에도 쓰지 않는다.
request_ok() {
  local request="$1"
  [ -f "$request" ] || return 1
  if [ "$(grep -c '' "$request" 2>/dev/null)" = "1" ] \
    && grep -Eqx '\{"action":"apply","requestedAt":"[0-9T:.Z-]{10,40}"\}' "$request" 2>/dev/null; then
    return 0
  fi
  rm -f "$request"
  return 1
}

main "$@"; exit $?
