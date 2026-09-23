# 워크스페이스

슬랙·구글 캘린더·지라에서 할 일과 결정사항을 모아 하루 단위로 정리하는 개인 업무 대시보드예요.

**이 맥에서만 돌고, 데이터는 밖으로 나가지 않아요**(연결한 지라·슬랙에만 물어봐요). 맥 전용이고 이 컴퓨터 한 대에서만 써요 — 폰이나 다른 맥에서는 못 봐요.

## 설치

1. 터미널을 열어요(Spotlight → `터미널`).
2. 아래를 그대로 붙여 넣고 Enter.
   ```sh
   git clone https://github.com/luvoneun/workspace-tracker.git workspace && cd workspace && bash setup.sh
   ```
3. 끝나면 Dock에 `Workspace` 앱이 생겨요.

**질문은 하나도 없어요.**

- `Node가 없어요` 같은 말이 나오면 [nodejs.org](https://nodejs.org)에서 LTS 버전을 설치하고 같은 터미널 창에서 2번을 다시 실행해요.
- `"확인되지 않은 개발자"` 경고가 뜨면 앱을 우클릭 → 열기 한 번이면 돼요(그다음부터는 그냥 열려요).

## 처음 5분

앱을 열면 `오늘` 탭에 `시작하기` 카드가 있어요. 거기서 할 일 하나만 적어 보세요. **처음 한 주는 할 일만 써도 충분해요** — 프로젝트·회의·주간요약은 필요해질 때 켜면 돼요.

## 연동은 나중에, 앱 안에서

`설정`(톱니바퀴) → `연동`에서 하나씩 켜요. 설치할 때 아무것도 묻지 않는 이유예요.

| 연동 | 필요한 것 | 누가 할 수 있나 |
|---|---|---|
| 지라 | 지라 API 토큰 | 누구나 |
| 슬랙 수집 | 팀 슬랙 앱의 본인 토큰 + 비공개 채널 + Claude Code | Claude Code 있는 사람(Claude 없이 도는 기본 수집은 준비 중) |
| 캘린더 | Claude Code | Claude Code 있는 사람 |
| 회의록 | 티로 + Claude Code(또는 직접 옮기기) | 직접 옮기기는 누구나 |

**피그마·기타 알림**: 슬랙 알림을 그 채널에 공유하면 할 일로 들어와요 · 필요한 것: 슬랙 수집(위와 같음).

각 연동의 단계는 앱 화면(`설정 > 연동`)이 그 자리에서 안내해요. 토큰을 어디서 받는지만 미리 적어 둘게요.

- **지라**: [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)에서 `API 토큰 만들기`.
- **슬랙**: 앱 안의 `토큰 받는 곳 열기 ↗`를 누르면 팀 슬랙 앱 페이지가 열려요(`Install to Workspace` → `User OAuth Token` 복사). 채널은 링크를 붙여 넣거나 앱이 대신 만들어 줘요 — 자세한 단계는 캡처와 함께 [`docs/연동.md`](docs/연동.md)에 있어요.

**토큰은 채팅이나 메일로 보내지 말고, 앱의 그 칸에만 붙여 넣어 주세요.**

## 업데이트

앱 폴더의 `업데이트.command`를 더블클릭해요(터미널 창이 뜨는 게 정상이에요 — 6줄쯤 지나고 아무 키나 누르면 닫혀요). `설정`에 `새 버전이 있어요`가 뜰 때만 하면 돼요.

데이터는 업데이트 전에 먼저 백업되고, 업데이트가 지우는 일은 없어요. 문제가 생기면 `bash update.sh --rollback`으로 되돌려요.

## 문제가 생기면

`설정 > 상태` 맨 아래 `문제 보고`를 눌러요. 버전·연동 상태·최근 오류가 클립보드에 복사돼요(업무 내용은 안 들어가요). 그걸 그대로 슬랙 DM으로 보내 주세요.

## 내 마음대로 바꿔도 되나요

`local/icon.png`·`local/local.css`와 `설정 > 연동`의 값만 지원해요. 코드를 고치면 `설정 > 상태`에 `수정된 파일 N개`로 표시되고, 그 상태는 지원하지 않아요. 좋은 수정은 fork → PR로 보내 주세요.

## 백업

업무 데이터는 `tracker/` 폴더 안에 있어요(맥 타임머신을 권해요). 더 직접 챙기고 싶으면 `tracker/inbox-app/README.md`의 `업무 데이터 백업` 절을 봐요.

<details>
<summary>만드는 사람용</summary>

### 폴더 구조

```
workspace.config.json       사람/회사마다 다른 값 (git에 안 올라감, 앱의 설정 > 연동이 씀)
VERSION                     지금 버전 (release.sh만 고친다)
setup.sh                    설치 스크립트 (질문 0개)
update.sh  업데이트.command  업데이트 6단계 / 더블클릭용
release.sh                  새 버전 내보내기 (만드는 사람용)
local/                      이 컴퓨터에만 두는 것 (icon.png·local.css, 업데이트해도 남는다)
tracker/*.md                내 업무 데이터 (git에 안 올라감)
tracker/inbox-app/          앱 — 회사·개인 정보가 들어있지 않다
  server.js                 서버·API
  index.html  app.js        화면 뼈대 / 화면 동작 (workflows.js·report-ui.js는 기능별 화면)
  ui.css  report-ui.css      토큰·공용 부품 / 주간요약 문서 (기준은 DESIGN.md)
  automation/               자동화 스크립트 원본
.claude/skills/             수집 작업 지시서 (슬랙/캘린더/지라)
docs/연동.md  docs/원칙.md   동료용 상세 문서
```

`workspace.config.json`은 `설정 > 연동`이 저장하는 파일이지만, 손으로 고쳐도 된다(값 종류는 위 설치 절과 `tracker/inbox-app/README.md`의 `지라 연결 설정`을 본다). 고친 뒤에는 `launchctl kickstart -k gui/$(id -u)/com.workspace.app.server`로 다시 시작한다.

### 새 버전 내보내기

`bash release.sh 1.2.0`(테스트를 전부 돌린 뒤 `VERSION` 갱신·커밋·태그). `bash release.sh 1.2.0 --push`면 올리기까지. 동료는 `stable` 갈래에서 태그만 받고(`update.sh`), `workspace.config.json`의 `server.updateChannel`을 `main`으로 두면 만드는 중인 것까지 받는다.

### 검증

```sh
cd tracker/inbox-app && node --test server.test.js client.test.js report-drafts.test.js
```

화면 확인은 `node browser-fixture.js`(4322 포트, 임시 데이터)로 한다.

### 문서 지도

- `AGENTS.md` — 작업 기준(데이터를 API로만 고치는 규칙 등)
- `DECISIONS.md` — 제품 결정과 이유
- `DESIGN.md` — 화면의 시각 기준 하나
- `tracker/inbox-app/README.md` — 앱의 지금 동작 전체
- `docs/연동.md`·`docs/원칙.md` — 동료용

</details>

라이선스: MIT (Luvon)
