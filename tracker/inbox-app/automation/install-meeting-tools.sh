#!/bin/bash
# 회의 녹음 전사·화자 구분에 쓰는 도구를 이 맥에 한 번 깐다(무료·이 맥 안에서만 돎). 사람이 터미널에서 직접 실행한다.
#   - Homebrew: whisper-cpp(음성 인식, MIT) · ffmpeg(소리 변환)
#   - ~/.local/share/workspace-meeting/
#       models/ggml-large-v3-turbo.bin                      약 1.6GB  (허깅페이스 ggerganov/whisper.cpp)
#       models/sherpa-onnx-pyannote-segmentation-3-0/      약 7MB    (k2-fsa/sherpa-onnx 공개 모델, 말소리 구간)
#       models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx  약 40MB (목소리 구분)
#       sherpa/sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts/ 약 60MB   (화자 구분 프로그램, Apache-2.0)
# 이미 있는 것은 건너뛴다. 애플 실리콘(arm64) 맥만 지원한다.
set -euo pipefail

HOME_DIR="${WORKSPACE_MEETING_TOOLS:-$HOME/.local/share/workspace-meeting}"
SHERPA_VERSION="v2.0.1"
SHERPA_NAME="sherpa-onnx-$SHERPA_VERSION-osx-arm64-shared-no-tts"
BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"

if [ "$(uname -m)" != "arm64" ]; then echo "애플 실리콘 맥에서만 쓸 수 있어요."; exit 1; fi
command -v brew >/dev/null || { echo "Homebrew가 없어요 — https://brew.sh 에서 먼저 설치해 주세요."; exit 1; }

mkdir -p "$HOME_DIR/models" "$HOME_DIR/sherpa"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "1/4 whisper-cpp · ffmpeg"
brew list whisper-cpp >/dev/null 2>&1 || brew install whisper-cpp
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg

echo "2/4 화자 구분 프로그램"
if [ ! -x "$HOME_DIR/sherpa/$SHERPA_NAME/bin/sherpa-onnx-offline-speaker-diarization" ]; then
  curl -fL --progress-bar -o "$TMP/sherpa.tar.bz2" "$BASE/$SHERPA_VERSION/$SHERPA_NAME.tar.bz2"
  tar -xjf "$TMP/sherpa.tar.bz2" -C "$HOME_DIR/sherpa"
fi

echo "3/4 화자 구분 모델"
if [ ! -f "$HOME_DIR/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" ]; then
  curl -fL --progress-bar -o "$TMP/seg.tar.bz2" "$BASE/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  tar -xjf "$TMP/seg.tar.bz2" -C "$HOME_DIR/models"
fi
EMB="3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
if [ ! -f "$HOME_DIR/models/$EMB" ]; then
  # 끊긴 반쪽 파일이 제자리에 남지 않게 임시 이름으로 받고, 다 받은 뒤에만 옮긴다.
  curl -fL --progress-bar -o "$HOME_DIR/models/$EMB.part" "$BASE/speaker-recongition-models/$EMB"
  mv "$HOME_DIR/models/$EMB.part" "$HOME_DIR/models/$EMB"
fi

echo "4/4 음성 인식 모델(약 1.6GB — 몇 분 걸려요)"
MODEL="$HOME_DIR/models/ggml-large-v3-turbo.bin"
if [ ! -f "$MODEL" ]; then
  curl -fL --progress-bar -o "$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
  mv "$MODEL.part" "$MODEL"
fi

echo "다 깔았어요. 회의 탭의 녹음본에서 \`전사·요약 시작\`(또는 실패한 줄의 \`다시 시도\`)을 눌러 주세요."
