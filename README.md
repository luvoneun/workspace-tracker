# 워크스페이스

슬랙·구글 캘린더·지라에서 할 일과 결정사항을 모아 하루 단위로 정리하는 개인 업무 대시보드.
데이터는 전부 마크다운 파일로 이 폴더 안에 있고, 외부로 나가지 않는다.

## 새 맥에서 시작하기

```sh
git clone <저장소 주소> workspace
cd workspace
bash setup.sh
```

**묻는 것이 하나도 없다.** 설정 파일(`workspace.config.json`)이 없으면 기본값으로 만들고,
앱 서버·Dock 앱까지 등록한 뒤 주소를 알려 준다. 이미 있는 설정은 그대로 두므로 여러 번 실행해도 안전하다.

처음 만든 설정은 연동이 전부 꺼져 있다(직접 입력만 쓰는 상태). 아래 값을 채우면 그만큼 켜진다.

| 항목 | 설명 |
|---|---|
| `title` | 화면에 표시할 이름 (기본은 맥 계정 이름을 따 `○○의 워크스페이스`) |
| `integrations` | 쓰는 도구만 `true`로 둔다. 끄면 자동화도, "동기화 안 됨" 경고도 안 뜬다 |
| `slack.workspaceUrl` | 회사 슬랙 주소 (예: `https://회사.slack.com`) |
| `slack.tokenFile` | 슬랙 토큰을 저장한 파일 경로 (기본 `~/.config/workspace-slack-token`) |
| `slack.channels` | 나만 보는 비공개 채널 4개의 ID |
| `server.extraHost` | (선택) 폰·다른 기기에서 접근할 주소. Tailscale 주소를 넣는다 |
| `server.chromeProfile` | (선택) Dock 앱을 열 크롬 프로필 폴더 이름(예: `Default`, `Profile 1`). 비우면 크롬이 마지막에 쓴 프로필로 열려, 앱에서 누른 링크(`지라에서 열기`·슬랙 원문 등)가 다른 계정에서 열릴 수 있다. 바꾼 뒤 `./setup.sh`를 다시 실행한다 |
| `server.updateChannel` | `stable`(기본, 배포된 버전만 받는다) 또는 `main`(만드는 중인 것까지 받는다) |

값을 바꾼 뒤에는 `launchctl kickstart -k gui/$(id -u)/com.workspace.app.server` 로 앱을 다시 시작한다.

슬랙·구글 캘린더·지라를 쓰려면 **Claude Code에서 `/mcp`로 본인 계정에 연결**해야 한다.
이 연결은 계정 단위라 파일로 옮겨지지 않는다.

`local/` 폴더에 둔 것(`icon.png`·`local.css`)은 업데이트해도 그대로 남는다.

## 업데이트

`업데이트.command`를 더블클릭하거나 `bash update.sh`를 실행한다. 순서는 늘 같다.

1. 고친 파일 확인 (있으면 되돌릴지 그대로 둘지 묻는다 — 되돌릴 때도 `local-changes-…` 가지에 담아 둔다)
2. **업무 데이터 백업** — `~/workspace-data-backup/<날짜-시각>/`에 복사하고 최근 5개를 남긴다
3. 새 버전 받기 (`stable`은 가장 높은 `vX.Y.Z` 태그, `main`은 `origin/main`)
4. 데이터 형식 변환 (`tracker/inbox-app/migrate.js`)
5. 앱 다시 시작 (`com.workspace.app.server`)
6. 잘 떴는지 확인 — 안 되면 되돌릴지 묻는다

`bash update.sh --rollback`은 이전 코드와 **그때 백업한 데이터**를 함께 되돌린다.
업데이트는 업무 데이터를 지우지 않는다(데이터는 Git에서 빠져 있어 코드를 갈아끼워도 그대로 남는다).

새 버전을 내보내는 쪽은 `bash release.sh 1.2.0`을 쓴다(테스트를 전부 돌린 뒤 `VERSION` 갱신·커밋·태그).

### 슬랙 채널 4개

나만 보는 비공개 채널을 만들고, 거기에 메시지를 공유(포워드)하는 것이 곧 "이건 할 일이다"라는 표시가 된다.

| 채널 | 용도 |
|---|---|
| `#my-todo` | 해야 할 일 |
| `#my-align` | 정해진 정책·얼라인 |
| `#my-someday` | 언젠가 참고할 것 |
| `#my-waiting` | 남의 확인을 기다리는 것 |

채널 ID는 슬랙에서 채널 → 세부정보 맨 아래에 있다.

## 구조

```
workspace.config.json       사람/회사마다 다른 값 (git에 안 올라감)
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
```

## 자동화

평일 9·11·13·15·17·19시에 돈다. 자세한 내용과 관리 방법은
`~/.local/share/workspace-automation/README.md` 참고.

| 작업 | 분 |
|---|---|
| 슬랙 캡처 | 07분 |
| 캘린더 갱신 | 13분 |
| 지라 갱신 | 17분 |

앱 서버는 로그인 시 자동으로 뜨고, 꺼지면 다시 뜬다.

## 다른 업무 환경에서 쓸 때

### 슬랙·캘린더·지라를 안 쓴다면

`integrations`에서 끄면 된다. 끈 도구는 자동화가 등록되지 않고 "동기화 안 됨" 경고도 뜨지 않는다.

```json
"integrations": { "slack": false, "calendar": true, "jira": false }
```

**셋 다 꺼도 앱은 그대로 동작한다.** 할 일·정책·확인 대기를 직접 입력해서 쓰면 되고,
그룹도 지라 티켓 대신 손으로 만든 이름(예: `웹 커뮤니티`)을 쓰면 된다.

### 다른 도구를 쓴다면

앱은 고칠 필요가 없다. **수집 지시서(`.claude/skills/`)만 새로 쓰면 된다.**
앱은 아래 형식의 파일만 읽기 때문에, 어떤 도구에서 가져오든 형식만 맞으면 된다.

| 파일 | 형식 | 지금 채우는 것 | 예시 대체재 |
|---|---|---|---|
| `tracker/calendar_today.md` | `- 15:00-16:00 \| 제목` | 구글 캘린더 | Outlook, 네이버 캘린더 |
| `tracker/jira_issues.md` | `- 키 \| 타입 \| 상태 \| 요약` | 지라 | Notion, Linear, Asana |
| `tracker/tasks.md` | `- 내용 #task[id:... status:... created:...]` | 슬랙 캡처 | Teams, 이메일 |

### 환경이 통째로 바뀐다면

`workspace.config.json`의 슬랙 값을 바꾸고 `/mcp`로 새 계정에 연결하면 된다.
지라는 `assignee = currentUser()`로, 캘린더는 primary를 쓰므로 계정만 바꾸면 그대로 동작한다.
쌓인 데이터를 비우려면 `tracker/*.md`의 항목 줄만 지우면 된다.

라이선스: MIT
