#!/bin/bash
# 회의 녹음 전사·화자 구분 도구를 손으로 까는 대비책 — 보통은 필요 없다. 회의 카드에서 `● 녹음`을 처음 누르면
# launchd `meeting-transcribe`가 같은 일을 저절로 한다. 그 실행기가 등록돼 있지 않은 맥에서만 터미널로 한 번 돌린다.
# Homebrew·관리자 암호가 필요 없다(애플 실리콘 맥만). 받는 것·확인 값(sha256)·자리는 tracker/inbox-app/meeting-tools.js 한 곳에 있다:
#   ~/.local/share/workspace-meeting/
#     bin/whisper-cli · bin/ffmpeg                          약 3MB(압축)  (이 저장소 릴리스 meeting-tools-v1 — tools/build-meeting-tools.sh로 만든 것)
#     sherpa/sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts/    약 19MB       (화자 구분 프로그램, Apache-2.0)
#     models/sherpa-onnx-pyannote-segmentation-3-0/        약 7MB        (말소리 구간)
#     models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx  약 40MB (목소리 구분)
#     models/ggml-large-v3-turbo-q5_0.bin                   약 574MB      (허깅페이스 ggerganov/whisper.cpp)
# 이미 있는 것(예전 Homebrew whisper-cpp·ffmpeg, 예전 큰 모델 ggml-large-v3-turbo.bin 포함)은 건너뛴다.
# 받는 중에는 `.part`로 받고 확인 값이 맞을 때만 제자리로 옮긴다 — 끊겨도 반쪽 파일이 완성본처럼 남지 않는다.
set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "node를 찾지 못했어요 — 앱 설치(setup.sh)를 먼저 해 주세요."
  exit 1
fi
exec "$NODE" "$APP_DIR/meeting-transcribe.js" --install
