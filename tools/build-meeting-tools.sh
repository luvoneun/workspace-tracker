#!/bin/bash
# 회의 녹음 음성 인식 도구 꾸러미(meeting-tools-arm64-<판>.tar.gz)를 만든다 — 만든 사람 맥에서 한 번, 손으로 돌린다.
# 꾸러미 안: bin/whisper-cli(whisper.cpp, 정적 · Metal 내장) · bin/ffmpeg(FFmpeg 최소 LGPL, 정적) · LICENSES/ · BUILD.txt
# 둘 다 macOS 기본 라이브러리만 쓴다(otool -L로 확인) — 받는 맥에 Homebrew·관리자 암호가 없어도 돈다.
# 만든 뒤 찍히는 sha256을 tracker/inbox-app/meeting-tools.js의 꾸러미 값에 적고, 파일은 저장소 릴리스
# (태그 meeting-tools-v<판>)에 사람이 올린다. 이 스크립트는 아무 데도 올리지 않는다.
#
# 쓰는 법: tools/build-meeting-tools.sh <작업 폴더> [판=1]
#   <작업 폴더>에 whisper.cpp·ffmpeg 소스가 이미 있으면 그대로 쓰고(빌드 결과가 있으면 다시 빌드하지 않음), 없으면 받는다.
#   cmake가 PATH에 없으면 CMAKE=<cmake 경로>로 알려 준다(예: python3 -m venv v && v/bin/pip install cmake).
set -euo pipefail

WORK="${1:?작업 폴더를 알려 주세요 — tools/build-meeting-tools.sh <작업 폴더> [판]}"
VERSION="${2:-1}"
WHISPER_TAG="v1.9.5"
FFMPEG_TAG="n7.1.1"
CMAKE="${CMAKE:-$(command -v cmake || true)}"
MIN_MACOS="13.0"
NAME="meeting-tools-arm64-$VERSION"

[ "$(uname -m)" = "arm64" ] || { echo "애플 실리콘 맥에서 만들어요."; exit 1; }
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"

# ---------- whisper.cpp ----------
if [ ! -d "$WORK/whisper.cpp" ]; then
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$WORK/whisper.cpp"
fi
if [ ! -x "$WORK/whisper.cpp/build/bin/whisper-cli" ]; then
  [ -n "$CMAKE" ] || { echo "cmake를 찾지 못했어요 — CMAKE=<경로>로 알려 주세요."; exit 1; }
  ( cd "$WORK/whisper.cpp" \
    && "$CMAKE" -B build -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
    && "$CMAKE" --build build -j 6 --target whisper-cli )
fi

# ---------- ffmpeg(최소 LGPL: 녹음본 webm·ogg·m4a·wav → 16kHz wav만) ----------
if [ ! -d "$WORK/ffmpeg" ]; then
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg "$WORK/ffmpeg"
fi
FFMPEG_CONFIGURE=(--disable-everything --disable-autodetect --disable-doc --disable-network --disable-debug --disable-ffplay
  --disable-ffprobe --enable-ffmpeg --enable-protocol=file,pipe --enable-demuxer=matroska,ogg,mov,wav
  --enable-decoder=opus,vorbis,aac,pcm_s16le,pcm_f32le --enable-parser=opus,vorbis,aac --enable-encoder=pcm_s16le
  --enable-muxer=wav --enable-filter=aresample,aformat,anull,abuffer,abuffersink --enable-swresample
  --extra-cflags=-mmacosx-version-min=$MIN_MACOS --extra-ldflags=-mmacosx-version-min=$MIN_MACOS)
if [ ! -x "$WORK/ffmpeg/ffmpeg" ]; then
  ( cd "$WORK/ffmpeg" && ./configure "${FFMPEG_CONFIGURE[@]}" && make -j6 ffmpeg )
fi

# ---------- 확인: macOS 기본 라이브러리만 ----------
for bin in "$WORK/whisper.cpp/build/bin/whisper-cli" "$WORK/ffmpeg/ffmpeg"; do
  if otool -L "$bin" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/)' | grep -q .; then
    echo "macOS 밖의 라이브러리를 써요 — $bin"; otool -L "$bin"; exit 1
  fi
done

# ---------- 꾸러미 ----------
STAGE="$WORK/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/LICENSES"
cp "$WORK/whisper.cpp/build/bin/whisper-cli" "$STAGE/bin/whisper-cli"
cp "$WORK/ffmpeg/ffmpeg" "$STAGE/bin/ffmpeg"
chmod 755 "$STAGE/bin/"*
# 애플 실리콘은 서명 없는 실행 파일을 돌리지 않는다 — 링커가 붙인 임시 서명을 확실히 다시 붙인다(인증서 없이).
codesign --force --sign - "$STAGE/bin/whisper-cli" "$STAGE/bin/ffmpeg"
cp "$WORK/whisper.cpp/LICENSE" "$STAGE/LICENSES/whisper.cpp-LICENSE.txt"
cp "$WORK/ffmpeg/COPYING.LGPLv2.1" "$STAGE/LICENSES/ffmpeg-COPYING.LGPLv2.1.txt"
cp "$WORK/ffmpeg/LICENSE.md" "$STAGE/LICENSES/ffmpeg-LICENSE.md"
cat > "$STAGE/BUILD.txt" << EOF
meeting-tools-arm64-$VERSION — 회의 녹음 전사에 쓰는 음성 인식 도구(애플 실리콘 맥, macOS $MIN_MACOS 이상)

whisper-cli: whisper.cpp $WHISPER_TAG (MIT) — https://github.com/ggml-org/whisper.cpp/tree/$WHISPER_TAG
  cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=$MIN_MACOS
  cmake --build build --target whisper-cli

ffmpeg: FFmpeg $FFMPEG_TAG (LGPL v2.1 이상, GPL 부분 없음) — 소스: https://github.com/FFmpeg/FFmpeg/tree/$FFMPEG_TAG
  ./configure ${FFMPEG_CONFIGURE[*]}
  make ffmpeg

만든 스크립트: tools/build-meeting-tools.sh (https://github.com/luvoneun/workspace-tracker)
EOF

OUT="$WORK/$NAME.tar.gz"
rm -f "$OUT"
# 파일 주인·이름은 지운다(만든 사람 계정 이름이 꾸러미에 남지 않게).
( cd "$WORK" && COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname wheel -czf "$OUT" -C "$STAGE" bin LICENSES BUILD.txt )
rm -rf "$STAGE"

echo "꾸러미: $OUT"
echo "크기: $(stat -f %z "$OUT") 바이트"
echo "sha256: $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
echo "올릴 자리: 저장소 릴리스 태그 meeting-tools-v$VERSION 에 이 파일 그대로(이름 바꾸지 않기)"
