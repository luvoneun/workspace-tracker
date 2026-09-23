#!/bin/bash
# 더블클릭하면 업데이트가 돈다(터미널 창이 뜬다).
cd "$(dirname "$0")" && bash update.sh; echo; read -n 1 -s -r -p "아무 키나 누르면 닫혀요"
