# 작업 기준 (Claude·Codex 공통)

개인 업무 워크스페이스. 앱은 `tracker/inbox-app/`(Node 기본 모듈만 사용), 업무 데이터는 `tracker/`, 자동화 지침은 `.claude/skills/`에 있다. 앱의 현재 동작은 `tracker/inbox-app/README.md`가 기준이다.

## 데이터

- 업무 데이터(`tracker/`의 `tasks.md`, `checks.md`, `decisions.md`, `ideas.md`, `.workflow.json`, `.report-drafts.json` 등)는 직접 편집하지 않는다. 추가·수정은 앱 API로 한다(Slack 수집은 `import-record.js`, 수동 등록은 `/track`). 서버가 꺼져 있으면 파일 수정으로 우회하지 말고 실패를 알린다.
- 예외는 앱이 읽기만 하는 스냅샷이다. `calendar_today.md`, `slack_inbox.md`는 해당 스킬이 덮어쓰고, `meeting_drafts.json`은 끝에 추가만 한다. `jira_issues.md`는 옛 설치의 대비책일 뿐이다 — 새로 쓰는 곳이 없다(앱 서버가 지라를 직접 읽는다).
- 코드와 문서는 평소처럼 직접 수정한다.

## 개발·검증

- 운영 서버(launchd, 4321 포트)는 이 폴더의 코드를 그대로 실행하고, 화면 파일은 저장하는 즉시 열려 있는 브라우저에 반영된다. 실제 업무 데이터로 개발 테스트하지 않는다.
- 검증: `cd tracker/inbox-app && node --test server.test.js client.test.js report-drafts.test.js`. 화면·API 확인은 `node browser-fixture.js`(4322 포트, 데이터·설정·토큰·자동화 폴더·LaunchAgents·`local/`까지 전부 임시 폴더 — 실제 설치 위치를 가리키면 서버가 시작하지 않는다)로 한다.
- 화면·서버 호환성을 확인한 뒤 운영에 반영하고, 운영 반영·재시작 여부를 명확히 알린다.
- 기능을 바꾸면 README와 관련 스킬 설명도 함께 고친다. README에는 현재 동작만 적는다(변경 이력은 Git 기록).
- `tracker/inbox-app/automation/`의 스크립트는 `~/.local/share/workspace-automation/`의 복사본이 실행된다. 고쳤으면 복사본도 갱신한다(`setup.sh`·`update.sh`가 다시 복사한다). 복사본은 설치 위치를 `WORKSPACE_DIR` → `workspace.env` 순서로 찾는다.
- 앱 서버를 다시 시작하는 명령은 `launchctl kickstart -k gui/$(id -u)/com.workspace.app.server`다(launchd 이름은 전부 `com.workspace.app.<작업>`).
- 프로세스를 끝내는 코드는 직접 띄운 프로세스와 그 그룹에만 신호를 보낸다. 프로세스 목록을 훑어 종료 대상을 고르지 않는다(관계없는 프로그램을 강제 종료한 사고가 있었다). 에이전트가 고친 코드는 실행하기 전에 변경분을 먼저 읽는다.
- 화면 파일을 여러 곳 고칠 때는 격리된 복사본(worktree)에서 작업하고 검증한 뒤 한 번에 옮긴다. 제품 차원의 결정과 그 이유는 `DECISIONS.md`에 있다 — 기능을 고치기 전에 관련 결정을 확인한다.

## 협업

- 커밋·푸시·서버 재시작은 사용자가 요청한 범위에서만 한다.
- 코드를 수정하는 에이전트는 한 번에 하나만 둔다. 이어받을 때는 `git status`와 최근 커밋부터 확인한다. 미완료 내용은 커밋 메시지나 보고에 짧게 남기고, 별도 인수인계 문서는 만들지 않는다.
- 사용자는 PM이다. 결론을 먼저 말하고 전문용어는 풀어서 설명한다.

## 디자인

- 화면의 시각 기준은 `DESIGN.md` 하나다(토큰·부품·반응형까지). 기존 앱의 색상·간격·컴포넌트를 우선하고, 디자인 스킬은 부족한 부분만 보완하며, 새로운 시각 방향은 사용자와 합의했을 때만 적용한다.
