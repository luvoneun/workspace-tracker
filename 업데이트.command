#!/bin/bash
# 더블클릭하면 업데이트가 돈다(터미널 창이 뜬다).
# 업데이트가 끝나면 setup.sh를 한 번 더 돌린다 — 앱의 `설정 > 연동`에서 새로 켠 것이 있으면
# 그때 맥 스케줄러(launchd)에 등록된다. setup.sh는 묻는 것이 없고 여러 번 돌려도 안전하다.
# 업데이트가 설치 폴더를 ~/workspace로 옮겼을 수 있어서(회사 폴더 안이었을 때) setup.sh는 지금 폴더의 실제 위치에서 부른다.
cd "$(dirname "$0")" && bash update.sh && cd "$(pwd -P)" && bash setup.sh
echo; read -n 1 -s -r -p "아무 키나 누르면 닫혀요"
