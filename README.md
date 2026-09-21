# 워크스페이스

슬랙·구글 캘린더·지라에서 할 일과 결정사항을 모아 하루 단위로 정리하는 개인 업무 대시보드.
데이터는 전부 마크다운 파일로 이 폴더 안에 있고, 외부로 나가지 않는다.

## 새 맥에서 시작하기

```sh
bash setup.sh
```

처음 실행하면 `workspace.config.json`을 만들고 멈춘다. 아래를 채운 뒤 다시 실행하면 된다.

| 항목 | 설명 |
|---|---|
| `title` | 화면에 표시할 이름 |
| `integrations` | 쓰는 도구만 `true`로 둔다. 끄면 자동화도, "동기화 안 됨" 경고도 안 뜬다 |
| `slack.workspaceUrl` | 회사 슬랙 주소 (예: `https://회사.slack.com`) |
| `slack.tokenFile` | 슬랙 토큰을 저장한 파일 경로 |
| `slack.channels` | 나만 보는 비공개 채널 4개의 ID |
| `server.extraHost` | (선택) 폰·다른 기기에서 접근할 주소. Tailscale 주소를 넣는다 |

설치가 끝나면 서버·자동화·Dock 앱이 모두 등록된다.

**마지막으로 Claude Code에서 `/mcp`로 슬랙·구글 캘린더·지라를 본인 계정에 연결해야 한다.**
이 연결은 계정 단위라 파일로 옮겨지지 않는다.

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
setup.sh                    설치 스크립트
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
