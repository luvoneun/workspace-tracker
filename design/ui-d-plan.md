# D안 구현 계획 (워크트리 `ui-d`)

읽은 것: `DESIGN.md`, `design/mockup/mockup-spec.md`, `design/mockup/feature-parity.md`, `design/mockup/workspace-d.html`(구조·클래스·JS 함수 목록), `AGENTS.md`, `DECISIONS.md`, 워크트리의 `index.html`·`app.js`·`workflows.js`·`workflows.css`·`report-ui.js`·`server.js`·`task-batch.js`·`client.test.js`·`browser-fixture.js`, 최근 두 커밋(`c8e5cb6` 서버 = 회의 초안 오늘/나중·회신 기한·되돌리기, `20ac376` 화면 = 회의 정리/모아보기 재구성).

모든 경로는 워크트리 기준:
`/private/tmp/claude-501/-Users-luvon-personal/6f353f74-919b-4ae5-bc78-682eb9b15160/scratchpad/ui-d/tracker/inbox-app/` (아래에서는 `<WT>`로 줄여 씀)

---

## 1. 아키텍처 결정

### 1-1. `index.html`은 껍데기로 남기고, CSS는 새 파일 하나(`ui.css`)로 통째 교체한다
- 지금 CSS는 `index.html:15-1100`의 `<style>` 한 덩이(약 1,086줄) + `workflows.css`(200줄 상당의 dense 규칙, 실제 18KB) + `report-ui.css`다. 마크업 골격은 `index.html:1104-1249`(약 145줄)뿐이라 **골격은 살리고 CSS만 갈아끼우는 것이 가장 싸다**.
- **새 파일 `ui.css` 하나를 추가한다.** 추가 비용은 정확히 세 줄이다:
  - `server.js:1463` 정적 화이트리스트 배열에 `'/ui.css'` 추가
  - `server.js:1183` `appVersion` mtime 목록에 `'ui.css'` 추가(이게 빠지면 CSS만 고쳤을 때 열린 앱이 자동 새로고침되지 않는다)
  - `index.html:1101` 위에 `<link rel="stylesheet" href="/ui.css">` (workflows.css보다 **먼저**)
  - MIME는 `server.js:1040`에 `.css`가 이미 있고, 인증 예외(DECISIONS "아이콘·manifest만 예외")는 건드리지 않는다. `server.test.js:26-28`에 `/ui.css` → 200 한 줄만 보탠다.
- **파일은 더 쪼개지 않는다.** 최종 형태는 `ui.css`(토큰+공용 컴포넌트+모든 탭) + `report-ui.css`(주간요약 문서 전용, 이미 경계가 뚜렷함) 두 개, `workflows.css`는 내용이 `ui.css`로 흡수된 뒤 마지막 배치에서 삭제(화이트리스트·appVersion·`<link>`에서 함께 제거). 빌드 단계는 없다(DECISIONS 개발·운영).
- **옛/새 혼재를 막는 장치:** `ui.css` 맨 위에 D 토큰(`--bg --rail --rail-hover --surface --field --hover --border --hair --text --muted --dim --accent --accent-text --accent-soft --on-fill --urgent --warn --success --mark --scrim --pop --shadow --r --r-sm --r-xs --pad --row --grp --wp --wm --ease`)을 라이트/다크(`@media (prefers-color-scheme: dark)` + `:root[data-theme]`)로 선언하고, 그 **바로 아래에 옛 토큰 alias 블록**(`--card: var(--surface); --text-xs: 12px; --radius: var(--r); …` 약 20줄)을 둔다. 그러면 `index.html`의 옛 `:root`(16-64)를 1배치에서 지워도 아직 남은 옛 컴포넌트 CSS가 그대로 돈다. 배치가 진행되며 `<style>` 안의 옛 규칙이 구역별로 삭제되고, 마지막 배치에서 `<style>` 전체와 alias 블록이 함께 사라진다.
- 대비 보정값은 `DESIGN.md` frontmatter 값을 쓴다(`--dim #5b6270`, `--warn #8f5200`, `--urgent #b82e2e`). **파란 글자는 `--accent-text #1d54d0`**, 채움·밑줄·체크박스·포커스 외곽선은 `--accent #2563eb`. 다크는 `--accent-text: var(--accent)`.

### 1-2. `app.js`는 파일로 쪼개지 않고, 안에서 "D 컴포넌트 층"을 새로 만든다
전역 함수 공유 구조(`workflows.js`·`report-ui.js`가 `app.js`의 `request`·`load`·`diffDays`·`todayStr`를 그대로 쓴다)를 깨면 회귀 위험만 커진다. 대신 `app.js` 상단(`// ---------- D 공용 부품 ----------`)에 다음을 새로 만들고, 옛 렌더러를 배치마다 하나씩 이 부품으로 갈아끼운다.

| 새 함수 | 하는 일 | 대체 대상 |
|---|---|---|
| `uiIcon(name)` | 14px 인라인 SVG 한 벌(stroke 1.5, currentColor) | `index.html`에 흩어진 SVG, `⋮`·`✕` 글리프 |
| `uiKoDate(s)` | `9월 22일 (화)` | `formatKoreanDate`(app.js:437) 확장 |
| `uiDueText(due, where)` | `2일 지남`/`오늘까지`/`내일까지`/`9월 27일까지`, 목록에서는 먼 기한 생략 | `taskBadges`(app.js:892)의 기한 분기, `wfItemRow`(workflows.js:317-320) |
| `uiCarryText(scheduled)` | `어제부터`/`3일 전부터` | `taskBadges`의 `stale` 배지 |
| `uiDateField({value,label,onChange,clearable})` | 빈 값이면 `+ 기한`, 누르면 date input + 지우기 | `wfDateField`(workflows.js:86-108)와 `overflow-date-input`(app.js:932-943, 1309-1318)을 **하나로** |
| `uiMenu(anchorBtn, sections)` | 한 벌 더보기 메뉴: `position: fixed`, 304px, 위/아래 뒤집기, 첫 항목 포커스, ↑↓, Esc→버튼 복귀, 한 번에 하나 | `renderOverflowMenu`(app.js:1734-1794) + `overflowField`(1724-1732) |
| `uiRow(spec)` | D 행 anatomy: `24px minmax(0,1fr) 92px 164px`, 체크 \| 제목 \| 프로젝트 \| 상태열, 동작은 상태열 위에 절대 배치 | `renderTaskCard`(app.js:1017-1082) |
| `uiMetaCells(item, ctx)` | 밀린 표시 → 우선순위(5px 점) → 기한 순의 글자 셀 | `taskBadges`+`renderPriorityBadge`(app.js:867-907) |
| `uiGroupHeading(label, count, opts)` | 28px sticky 그룹 제목, 접기 꺾쇠, hover `+` | `today-group-header`, `renderGroupAddInput`(app.js:1441) |
| `uiSurface()` / `uiQuickAdd(...)` | 흰 면 하나 / 면 첫 줄 빠른 추가 | `.card` 중첩, `index.html`의 `.quick-add` |
| `panelOpen(view)` / `panelRender()` | 오른쪽 340px 한 자리 | 1-3 참고 |
| `palOpen(state)` / `palRender()` | ⌘K 팔레트 | 1-4 참고 |

시안(`workspace-d.html:1638-`)의 `taskRow`·`metaCells`·`moreMenu`/`placeMenu`·`dueMeta`/`dueFull`/`dueDetail`·`renderDetail`을 **마크업·클래스 이름·상호작용의 참고**로 쓰되 상태 관리는 베끼지 않는다(시안은 mock 상태).

### 1-3. 상세는 한 자리·한 벌로 합친다
오늘 지금 상세는 **두 벌**이다: 인라인 패널(`app.js:1241-1270` `renderTaskDetail`/`openTaskDetail`, `closeTaskDetail` 1084-1092)과 모달 안 항목 보기(`workflows.js:656-669` `wfItemView` + `taskCoreFields` 647-655 + `workflowFields` 598-646). 여기에 인라인 회의 정리(`app.js:1098-1232`)와 모달 회의 정리(`workflows.js:403-465`)가 또 따로 있다.

→ **`panel` 하나로 합친다.**
```
panelState = { kind: 'task'|'check'|'meeting', id, mode:'today'|'later',
               anchorTop, back: [], result: null }   // result = 회의 담기 결과 카드
panelOpen(view) / panelClose() / panelRender()
  ├ panelTask(item)     : detail-title(클릭→textarea) + <dl> 언제 할지·기한·우선순위·프로젝트
  │                        + primary `완료로 표시` 하나 + quiet `내일`·`나중에`/`오늘로`·`프로젝트 보기`
  │                        + `기다리는 답변`·`결과 한 줄`(기본 펼침, 자동 저장) + `자동으로 저장됩니다`
  ├ panelCheck(item)    : `결정으로 남기기` 상시 + 다시 확인할 날짜 + 회신 기한 + 누구에게 + 프로젝트
  └ panelMeeting(event) : 제목 + `미팅 노트` + 결과 카드 + 초안 카드들 + 담기 바 + 항목 목록 + 직접 담기
```
- 저장 경로는 **전부 기존 API 그대로**: `/api/track/set-description|set-due|set-scheduled|set-priority|set-group|set-jira|toggle|remove|restore|seen`, `/api/workflow/item|capture|link|review|review-undo`. 서버 변경 없음(예외는 B7의 일괄 완료 하나).
- `workflowFields`(598-646)의 `blockedBy`/`outcome`/`followUp`/`contacted` 저장 로직은 **그대로 옮긴다**(저장 버튼만 없애고 change 이벤트 자동 저장으로). `wfItem(item.id) || item` 재조회, 변경분만 보내는 `initial` 비교는 유지한다.
- 인라인 회의 정리(`app.js:1098-1232`)는 **삭제**한다. `openMeetingPanel`(1106)은 `.workflow.json`에 기록된 회의를 찾아 `panelOpen({kind:'meeting'})`로 보내고, 기록이 없는 회의는 패널에 `아직 기록되지 않은 회의입니다` 한 줄 + 직접 담기만 띄운다. 이때 **`담을 프로젝트` 입력은 되살리지 않는다**(DECISIONS 화면: "회의 상세에는 프로젝트·반복 회의 입력을 두지 않는다").
- 패널은 누른 행 높이에 맞춰 연다(`anchorTop`, 최소 위 10px). ≤1120px에서는 오른쪽 고정 360px + `--pop`, ≤900px에서는 아래에서 올라오는 시트.

### 1-4. `<dialog>`는 뷰 단위로 해체하고 마지막에 제거한다
`wfOpen`/`wfRender`(workflows.js:141-172)가 5개 뷰(`search`·`meetings`·`projects`/`project`·`meeting`·`item`)를 한 모달에 담고 있다. 한 번에 뜯지 않는다 — **`wfOpen`을 라우터로 바꿔 놓고 배치마다 한 `kind`씩 새 집으로 보낸다.**

| kind | 새 집 | 배치 |
|---|---|---|
| `item` | 오른쪽 패널 `panelOpen` | B3 |
| `search` | ⌘K 팔레트 | B5 |
| `meetings` | 팔레트의 `회의` 필터(+ `검토 필요` 먼저) | B5 |
| `meeting` | 오른쪽 패널 | B6 |
| `projects`/`project` | 프로젝트 탭 | B7 |

`wfRender`는 `if (!workflowDialog) return;`(154)로 이미 안전하다. 마지막 kind가 옮겨진 B7에서 `wfOpen`·`wfRender`·`wfRow`·`workflowDialog` 전역·`wf-dialog` CSS를 지운다. 호출처(`workflows.js:309, 606, 642, 643, 667, 692, 699-702`, `app.js:1421`, `report-ui.js:95`)는 라우터 덕분에 **한 줄도 안 고치고** 마지막에 `panelOpen`/`palOpen`으로 일괄 치환된다.

### 1-5. 더보기 메뉴 한 벌 / 날짜 칸 한 벌
- 지금 메뉴는 `renderOverflowMenu`(app.js:1734-1794) 하나뿐인데 **버튼 안에 접히는 드롭다운**이라 행이 잘리고(`.card:has(.overflow-menu){padding-right:44px}`) 화면 밖으로 넘친다. D는 `position: fixed` + 뒤집기 + 키보드 순환이 필수다. `uiMenu`로 새로 만들고, 메뉴 **내용**은 데이터(`sections`)로만 받는다:
  - 업무: `진행 중으로 표시` · 언제 할지(`오늘`/`내일`/`나중에`/`날짜…`) · 기한 · 우선순위 · 프로젝트 · 구분선 · `삭제`
  - 확인 대기: `결정으로 남기기` · `오늘 확인 요청함` · 다시 확인할 날짜 · 회신 기한 · 누구에게 · 프로젝트 · `삭제`
  - 회의 행 / 보고 문장 / 아이디어 · 결정도 같은 컴포넌트에 항목만 더한다.
- 날짜는 `uiDateField` 하나로 통일한다. 한국어 표시는 `uiKoDate`, 의미 문구는 `uiDueText`. `wfDateLabel`(workflows.js:110, `할 일→마감일`/`확인 대기→회신 기한`/`결정→없음`)은 **그대로 유지**(client.test.js:198이 고정하고 있고 DECISIONS 2026-09-21과 직결).

### 1-6. 테스트 재조준 방침
`client.test.js:8-9`는 `app.js`를 문자열 `"setupQuickAdd('todayTaskInput'"`에서 잘라 "정의부만" VM에 넣는다. 1배치에서 **자르는 지점을 명시 표식으로 바꾼다**:
```js
// app.js 안, 실행 코드가 시작되는 지점
// ---- client.test.js는 이 줄 위까지만 읽는다 (아래는 실행 코드) ----
const script = ...; const definitions = script.slice(0, script.indexOf('// ---- client.test.js는 이 줄 위까지만'));
```
그 뒤로는 구조가 바뀌어도 테스트가 안 깨진다. 검증 **의도**는 그대로 옮긴다(입력 보존·실패 처리·한글 조합 Enter·복구 필요 안내·행 표시 규칙·프로젝트 선택지). 유지할 문구: `저장을 확인하지 못했습니다` · `복구 필요 상태` · `저장을 멈췄습니다` · `저장했습니다`. 가짜 DOM(client.test.js:10-23)은 `dataset`·`querySelector`·`style`·`classList.add/remove`가 없으므로, 정의부에서 DOM을 만지는 코드를 **실행하지 않도록** 새 부품은 전부 "호출될 때만" DOM을 만든다.

---

## 2. 배치 계획 (9개)

공통 완료 조건(모든 배치): `node --test server.test.js client.test.js report-drafts.test.js` 전부 통과 · `node --check` 통과 · `git diff --check` 깨끗 · 워크트리 fixture 서버에서 오늘 탭이 1440×900에서 오늘 할 일 6줄 이상 · 다크 모드와 `prefers-reduced-motion`에서 깨지지 않음 · 저장 실패 시 입력이 남고 `다시 시도`가 보임.

### B1 — 토큰·껍데기·공용 부품 (기반)
- **목표:** 새 CSS 파일과 D 헤더·탭·배너·알림·공용 부품을 깔고, 나머지 화면은 alias 토큰 위에서 그대로 돌게 한다.
- **파일/영역:** `ui.css`(신규 ~430줄: 토큰·alias·리셋·타이포·버튼 3등급·링크·아이콘 버튼·세그먼트·포커스·모션·헤더·탭·레이아웃 grid·배너·토스트) · `index.html:15-64` 삭제(`:root`·다크), `:66-260`의 `.page/.page-header/.search-pill/.date-bar/.tab-bar/.stat*` 삭제, `:1101` 위 `<link>` 추가, 마크업 `1107-1126` 재작성(48px 한 줄 헤더: 앱 이름 → 날짜 → 자동화 경고 → 탭 → 검색 버튼 → 설정), `1129`의 `.stats` 3칸 → 레일 한 줄 요약 자리로 치환 · `app.js`: `uiIcon`·`uiKoDate`·`uiDueText`·`uiCarryText`·`uiDateField`·`uiMenu`·`uiToast` 추가, `renderDateBar`(290-319) 재작성, `renderStorageBanner`(75-87) 마크업만 교체(**문구·로직 금지**), `showNotice`(19-71) 마크업/클래스만 교체(타이머·되돌리기·`다시 시도`·`닫기`·`lastRemovedId` 분기 **그대로**) · `server.js:1183`, `server.js:1463`
- **삭제:** 옛 `:root` 토큰, `.search-pill`, `.date-chip`, `.sync-chip`, `.stat*` CSS, 헤더 SVG 하드코딩
- **서버:** 화이트리스트/appVersion 두 줄만. 엔드포인트 없음.
- **테스트:** `client.test.js` 슬라이스 표식 교체(1-6) · `server.test.js:26` 근처에 `/ui.css` 200 확인 1줄 · 새 `uiDueText`/`uiKoDate` 순수 함수 테스트 6줄
- **수동 확인:** 헤더가 48px 한 줄인가 · ⌘Z 되돌리기 알림이 뜨는가 · `복구 필요` 배너가 띠로 뜨고 **스스로 사라지지 않는가** · 다크 모드 · 탭 화살표/Home/End
- **parity:** A5, A6(헤더 표시), B(알림·되돌리기·입력 보존)
- **규모:** app.js 약 +230/−90, index.html −190, ui.css +430

### B2 — 오늘 본문 (새로 들어온 것 + 제안 + 목록 면 + D 행)
- **목표:** 오늘 탭 가운데 열 전체를 D로. "한 화면에 옛것/새것 섞임"을 여기서 끝낸다.
- **파일/영역:** `app.js` `renderInbox`(1274-1354) · `renderSuggestions`(387-436) · `renderTodayTasks`(1356-1439) · `renderTaskCard`(1017-1082)→`uiTaskRow` · `taskBadges`(892-907)·`taskEyebrow`(911-916)·`taskPlanActions`(990-1015)·`taskMenuActions`(931-987) 재작성 · `renderGroupAddInput`(1441-1478) → `uiGroupHeading`의 hover `+` · `renderPlanningMode`(276-288)·`planningMode` 전역(12) **삭제** · `index.html:1155-1180` 재작성, `1161`의 `planningToggle` 삭제, `1162`의 `today-toolbar` → 머리줄 오른쪽 조용한 두 칸 전환
- **새 함수:** `uiTaskRow`, `uiMetaCells`, `uiGroupHeading`, `uiSurface`, `uiQuickAdd`, `uiResultLine`(완료 행 `결과 한 줄 적기` → `/api/workflow/item` `outcome`), `uiSuggestLine`
- **삭제:** `.card`/`.badge`/`.today-group*`/`.inbox-*`/`.suggest-*`/`.plan-*` CSS 구역, `계획·정리` 관련 전부
- **서버:** 없음
- **테스트:** `client.test.js`의 `taskBadges`/`taskEyebrow` 테스트(115-138)를 `uiMetaCells`/`uiDueText` 기준으로 재작성 — 같은 의도(지남·오늘·내일·밀림·진행 중·이스케이프) 유지
- **수동 확인:** 1440×900에서 `새로 들어온 것` 위에 둔 채 오늘 6줄 · 체크 → 완료 그룹으로 이동 후 `결과 한 줄 적기` · 밀린 줄의 `오늘 할게요` · 그룹 제목 hover `+` 추가 후 **포커스가 같은 입력으로 돌아오는가** · ⌘Z
- **parity:** A1, A3, A4(할 일·새로 들어온 것), A7, A8(행 아이콘), A9(프로젝트 열 표시), A17, C(계획 모드 제거·결과 한 줄·용어)
- **규모:** app.js 약 +470/−420, ui.css +260, index.html −180

### B3 — 상세 패널 한 벌 (업무 + 확인 대기) + 더보기 메뉴 이식
- **목표:** 상세 두 벌을 한 벌로. `item` kind를 모달에서 빼낸다.
- **파일/영역:** `app.js` `renderTaskDetail`(1241-1262)·`openTaskDetail`(1264-1270)·`closeTaskDetail`(1084-1092) → `panelOpen/panelRender/panelClose` · `workflows.js` `wfItemView`(656-669)·`taskCoreFields`(647-655) 삭제, `workflowFields`(598-646)는 `panelTask`/`panelCheck` 안으로 이동 · `renderOverflowMenu`(1734-1794)·`overflowField`(1724-1732) 삭제 후 `uiMenu` 전면 사용 · `index.html:1175-1178` 세 번째 열로 재배치
- **새 함수:** `panelOpen/panelClose/panelRender/panelTask/panelCheck`, `panelBackLink`, `panelTitleEdit`
- **서버:** 없음
- **테스트:** `client.test.js`에 패널 필드 저장 payload 테스트(변경분만 보내는지) 2건 추가
- **수동 확인:** 행 클릭 → 패널이 그 행 높이에 맞춰 열림 · 제목 클릭 편집 → 저장 버튼 없이 저장 · `기다리는 답변`·`결과 한 줄` 기본 펼침 · 더보기가 화면 아래 끝에서 **위로 뒤집히는가** · Esc 순서(메뉴 → 상세) · 확인 대기 상세의 `결정으로 남기기`
- **parity:** A8(상세), A9, A16(상세), C(업무 상세 한 벌·확인 대기 결정으로 남기기)
- **규모:** app.js 약 +430/−300, workflows.js −120, ui.css +200

### B4 — 왼쪽 레일 + 확인 대기 + 나중에 서랍
- **목표:** 오늘 탭 완성.
- **파일/영역:** `app.js` `renderCalendar`(321-382)·`renderReminders`(475-501)·`renderWaiting`/`renderWaitingCard`(695-806)·`renderLaterTasks`(807-861) 재작성 · `workflows.js:704-711`(다시 확인할 항목/답변이 해결된 업무)은 레일 하단 구역으로 · `index.html:1128-1191` 레일·서랍 마크업 재작성(`<details>` 서랍 → 헤더 아래 붙는 404px 서랍, 본문을 `padding-right`로 밀어냄)
- **새 함수:** `uiRailRow`, `drawerOpen/drawerClose/drawerRender`
- **서버:** 없음
- **테스트:** 확인 대기 정렬(기한 있는 것 먼저)과 `3일째` 강조 경계 테스트 2건
- **수동 확인:** 서랍이 본문을 **덮지 않고 미는가**(>900px) · 서랍 빠른 추가 · `오늘로` · ≤900px에서 시트로 바뀌는가 · 레일 미팅 행의 `초안 N`
- **parity:** A4(확인 대기), A16, B(리마인드는 높은 우선순위만), C(정리 모드 제거의 나머지)
- **규모:** app.js 약 +400/−340, ui.css +180, index.html ±90

### B5 — ⌘K 검색 팔레트 (검색 + 회의 필터)
- **목표:** `search`·`meetings` 두 kind를 모달에서 빼낸다.
- **파일/영역:** `workflows.js` `wfSearch`(182-217)·`wfMeetingList`(359-389) → `palOpen/palRender`(app.js) · `wfSearchMatches`(178-181)·`wfMeetingChips`(332-343)·`wfMeetingOrder`(467)·`wfDebounce`(17-20)는 **그대로 재사용**(테스트가 고정) · 헤더 검색 버튼 배선(`workflows.js:689-693`) 이동
- **새 함수:** `palOpen`, `palRender`, `palResultRow`, `palFilterChips`, `palHighlight`(`--mark`)
- **서버:** 없음
- **테스트:** `client.test.js`의 `wfMeetingChips` 테스트(163-175)·`wfNextReview`(177-189) 유지 확인 + 검색 필터 조합(종류·완료 제외·미해결만) 테스트 1건 추가
- **수동 확인:** ⌘K 즉시 입력 · ↑↓/Enter/Esc · 일치 부분 하이라이트 · `회의` 필터에서 `검토 필요`가 위 · 팔레트에서 연 상세를 닫으면 **검색어·스크롤 그대로 다시 열리는가**(A12)
- **parity:** A11, A12, C(검색 → 팔레트·회의 전체 보기 → 필터)
- **규모:** app.js +330, workflows.js −120, ui.css +150

### B6 — 회의 정리 패널 (방금 들어온 검토 기능 보존)
- **목표:** `meeting` kind를 패널로. **`20ac376`/`c8e5cb6`에서 막 들어온 동작을 한 개도 잃지 않는다.**
- **파일/영역:** `workflows.js` `wfMeeting`(403-465)·`wfDrafts`(523-592)·`wfResult`(482-522)·`wfPromote`(474-480)·`wfResultTasks`(471-472)·`wfNextReview`(468)·`wfItemRow`/`wfItemList`(304-330) → `panelMeeting` 아래로 이동 · `app.js:1098-1232` 인라인 회의 패널 **삭제**, `openMeetingPanel`(1106-1113)은 라우팅만 · `wfSegment`(54-83)·`wfTypeSegment`(84)는 D 세그먼트 모양으로 CSS만 교체 · `wfDateField`(86-108) → `uiDateField`로 치환
- **반드시 살릴 것:** 초안 카드의 문구 우선·여러 줄 textarea, 종류 3칸(할 일→확인 대기→결정 순서), 할 일의 `나중에/오늘` 기본 나중, `마감일`/`회신 기한`, ✕ 빼기, 창 아래 고정 담기 바 + 종류별 개수, 결과 카드(`오늘로`/`모두 오늘로`/`실행 취소`/`다음: ○○ (초안 N) →`), `wfDraftEdits` 유지, `wfCleanDraftText`, 직접 담기의 접힘/펼침 규칙, 성공 알림을 띄우지 않는 quiet 경로(`app.js:105`)
- **삭제:** `workflows.css`의 `wf-dialog`를 제외한 회의 관련 규칙(→ ui.css로)
- **서버:** 없음
- **테스트:** `client.test.js:191-241`(wfAcceptItem·wfResultTasks·wfCleanDraftText·quiet 알림) **그대로 통과해야 한다** — 이 배치의 핵심 안전망
- **수동 확인:** 초안 3건 검토 → 담기 → 결과 카드 → `오늘로` → `실행 취소`로 초안이 되돌아오고 고친 문구가 남는가 · `미팅 노트` 링크 · 기존 항목 연결
- **parity:** A13, C(회의 상세 → 패널)
- **규모:** app.js +430, workflows.js −330, ui.css +190

### B7 — 프로젝트 탭 + 여러 개 선택 (서버 변경 1건)
- **목표:** 마지막 kind를 옮기고 `<dialog>`를 없앤다. 일괄 정리를 새 모양으로.
- **파일/영역:** `workflows.js` `wfProjects`(133-140)·`wfProject`(390-402) → 프로젝트 탭 · `wfOpen`/`wfRender`/`wfRow`/`workflowDialog` **삭제**, 호출처 6곳을 `panelOpen`/`palOpen`으로 치환 · `taskSelectionRefresh`(219-268)·`taskSelectionCheckbox`(272-282)·`taskBatchApply`(283-302) 재작성 → 목록 아래 고정 막대 · `app.js:2100-2140` `TABS`에 `projects` 추가 · `index.html`에 `gridProjects` 패널과 탭 버튼 추가
- **서버 변경(유일):** `task-batch.js:20-33`의 `change` 분기에 `status` 추가 —
  `else if (Object.hasOwn(change, 'status')) { if (change.status !== 'done') throw …; keys = ['status','completed']; values = { status:'done', completed: today }; }`
  (`undoToken` 경로는 기존 `previous` 로직이 그대로 처리한다). 라우트는 기존 `/api/workflow/task-batch`(`server.js:1136`) 그대로 — **새 엔드포인트 없음.**
  **일괄 삭제는 서버를 건드리지 않는다**: 선택한 id를 기존 `/api/track/remove`로 하나씩 보내고(휴지통·원문 보존 그대로), 알림 하나에 `되돌리기`를 달아 `/api/track/restore`를 역순으로 부른다.
- **테스트:** `server.test.js`에 일괄 완료 2건(완료 처리 + 이후 변경된 업무가 있으면 취소 거절) 추가
- **수동 확인:** 프로젝트 탭 좌우 · 0건 프로젝트 흐림 · `여러 개 선택` → 완료 체크와 선택 칸이 **따로** 동작하는가 · 일괄 완료 후 `실행 취소` · 일괄 삭제 후 `되돌리기`
- **parity:** A2, A9, C(프로젝트 모아보기 → 탭)
- **규모:** app.js +380, workflows.js −200, server/task-batch +12, ui.css +170

### B8 — 아이디어·결정 탭 + 환경설정 대화상자
- **파일/영역:** `renderIdeas`/`renderIdeaCard`(1480-1574)·`renderDecisions`/`renderDecisionCard`(586-674)·`renderDecisionArchive`(564-577)·`renderIdeaGroupControl`(1999-2039) · `renderAutomationStatus`(2234-2296)·`renderSettingsGuide`(2297-2339)·`index.html:1193-1220, 1233-1244`
- **parity:** A4(기록), A6(경고 → 설정 줄로 이동), A10, A18
- **수동 확인:** 2열 → 1열(≤900px) · `반영 완료` 펼치면 검색 입력 · 실패 중인 자동화만 urgent + 점 · Esc로 닫으면 설정 버튼으로 포커스 복귀
- **규모:** app.js +330/−320, ui.css +150

### B9 — 주간요약 문서 + 마감 (반응형·다크·문서)
- **파일/영역:** `renderWeeklyReports`(517-554)·`renderWeeklyReportDetail`(555-563) · `report-ui.js` 전면(36-118 `renderReportDraft`: 세그먼트 2모드, 문장 행 hover 동작, `직접 수정`만 표시, 근거 들여쓰기, 문서 끝 `다음 주 계획`, 상시 슬랙 미리보기) · `report-ui.css` 재작성 · `workflows.css` 삭제(+ `server.js:1183, 1463`, `index.html` `<link>`) · `index.html`의 `<style>` 잔여 전부 삭제 · `ui.css`의 alias 블록 삭제 · 반응형 5단계(1280/1120/900/640/520) 전수 점검
- **문서:** `README.md`(24-70 화면 사용 흐름·업무·회의 연결·빠른 정리와 검색 전부 다시 씀 — 현재 동작만) · `DECISIONS.md` 화면 구역에 **덧붙이기만**(계획·정리 모드 제거 / 프로젝트를 탭으로 / 업무 상세 한 벌 / 검색은 ⌘K 팔레트 / 회의 정리는 오른쪽 패널 / 일괄 완료는 기존 일괄 API, 일괄 삭제는 한 건씩) · 스킬 설명: `.claude/skills/calendar-sync.md:3,38`("왼쪽 상단 오늘 일정 카드" → "왼쪽 레일의 오늘 미팅"), `.claude/skills/jira-sync.md:3`·`slack-inbox.md:57-58`(드롭다운 → "프로젝트 선택"), `.claude/skills/tiro-sync.md:3,85`("회의 정리 화면" → "회의 정리 패널")
- **parity:** A14, A15, C(주간요약 2모드·상시 미리보기·다음 주 계획 위치)
- **수동 확인:** 평일 읽기 모드에서 문장이 가장 큰 글자인가 · `슬랙용으로 복사`한 글자와 미리보기가 **정확히 같은가** · 390px에서 가로 스크롤 없음 · 다크 모드 전 화면
- **규모:** report-ui.js +260/−100, app.js +120/−90, ui.css +200, 문서 4개

---

## 3. 위험 8가지와 완화

1. **데이터 안전 경로 회귀** (`request` 97-138, `showNotice` 19-71, 저장 배너 75-94, undo 145-209). — 이 네 구역은 **마크업/CSS만** 바꾸고 로직 줄은 배치별 diff에서 0줄이어야 한다. B1에서 한 번만 손대고, 이후 배치는 `git diff app.js | grep -n "^[-+].*\(request\|showNotice\|pushUndo\|recordUndoFor\|RECOVERY_NEEDED\)"`가 비어 있는지 확인한다. 문구 3종은 테스트가 고정한다.
2. **상세 통합에서 필드 저장이 조용히 빠짐** (`workflowFields`의 `blockedBy`/`outcome`/`followUp`/`contacted`). — B3에서 저장 버튼을 없애며 `initial` 비교를 그대로 옮기고, "변경분만 보낸다"는 payload 테스트를 같은 배치에서 추가한다. `outcome`은 완료 행의 `결과 한 줄 적기`(B2)와 **같은 API**를 쓰므로 B2에서 먼저 한 번 검증된다.
3. **막 들어온 회의 검토 기능 손상** (B6). — `client.test.js:191-241`을 **고치지 않고** 통과시키는 것을 B6의 합격 조건으로 박는다. `wfDraftEdits`·`wfAcceptItem`·`wfCleanDraftText`·`wfResultTasks`·`wfNextReview`·quiet 경로는 이름째 보존(이동만). 수동으로 담기→실행 취소 왕복을 반드시 한 번 한다.
4. **키보드·포커스 회귀** (Esc 순서, 메뉴 포커스 복귀, 서랍/시트 포커스 가둠, 한글 조합 Enter). — Esc는 B1에서 **스택 하나**로 만든다: `escStack = []`, 열리는 것마다 push, `Escape`는 top만 닫는다(설정 → 메뉴 → 검색 → 회의 → 상세 → 서랍). `e.isComposing` 가드는 `setupQuickAdd`(2059)·초안 textarea(workflows.js:560)·그룹 추가(1453)에 이미 있으니 새 입력칸마다 **복사**한다.
5. **모바일 ≤520px** (두 줄 행 46px, 동작 상시 표시, 입력 16px, 당겨서 새로고침). — B2에서 행 반응형을 처음부터 같이 쓰고(나중에 덧대지 않는다), 각 배치 수동 확인에 390px 폭을 넣는다. `touchmove` 핸들러(2374-2389)는 서랍/시트가 스크롤을 먹지 않게 `window.scrollY > 0` 가드를 유지한다.
6. **다크 모드 누락.** — 컴포넌트 CSS에 색 리터럴을 절대 쓰지 않는다(토큰만). B9 전에 각 배치에서 `grep -nE "#[0-9a-fA-F]{3,6}|rgba?\(" ui.css | grep -v "^ *[0-9]*: *--"`가 스크롤바 thumb 2줄 외에 비어 있어야 한다.
7. **배치가 너무 커져 리뷰 불가.** — 배치당 `app.js` 순변화 400줄 안팎, 최대 500줄을 넘기면 쪼갠다(B2·B6이 가장 크다 — 필요하면 B2를 "새로 들어온 것 + 제안"과 "목록 면 + 행"으로, B6를 "초안 카드"와 "결과 카드 + 항목 목록"으로 나눈다). 배치 끝에 `git diff --stat`을 보고한다.
8. **옛/새 화면 혼재로 리뷰가 흐려짐.** — 한 **화면** 단위로 배치를 끊었다(오늘 본문 B2, 오늘 레일·서랍 B4는 같은 탭이라 B2 직후에 붙였다). 아직 안 바뀐 탭(프로젝트·기록·주간요약)은 **동작만 유지**하면 되며, 옛 `<dialog>`가 남아 있는 동안에도 열리고 저장된다. 배치 리뷰 요청문에 "이 배치에서 새 모양인 화면"과 "아직 옛 모양인 화면"을 한 줄씩 적는다.

---

## 4. 사용자(PM)에게 물어야 할 것 — 3가지

1. **일괄 삭제를 되돌리는 방법**
   여러 개를 한 번에 지울 때, 지금처럼 한 건씩 휴지통으로 보내고 알림의 `되돌리기` 한 번으로 전부 복원하는 방식이면 될까요? (추천: **그렇게 한다** — 서버를 새로 만들지 않고 기존 삭제·복원·원문 보존을 그대로 씁니다. 일괄 `완료로 표시`만 기존 일괄 저장 기능을 조금 넓힙니다.)
2. **`나중에 할 일` 서랍을 기억할지**
   서랍을 열어 둔 채 앱을 껐다 켜면 다시 열려 있어야 할까요, 아니면 항상 닫힌 채로 시작할까요? (추천: **항상 닫힌 채로 시작** — 첫 화면에 오늘 할 일이 가장 많이 보입니다.)
3. **회의 정리에서 `담을 프로젝트` 칸을 없애도 될지**
   지금 오늘 미팅에서 바로 연 회의 정리에는 `담을 프로젝트`를 고르는 칸이 있는데, 회의 모아보기에서 연 화면에는 없습니다(같은 걸 두 곳에서 저장하면 어긋난다고 예전에 정한 것 때문입니다). 새 화면은 한 벌이라 둘 중 하나를 골라야 합니다. (추천: **없앤다** — 프로젝트 연결은 지금처럼 오늘 미팅 행의 더보기에서만 합니다.)

---

## 5. 배치 지시 템플릿 (그대로 복사해 쓰세요)

```
[배치 N: <제목>] — 워크트리에서만 작업합니다. 커밋하지 마세요.

0) 먼저 읽을 것 (순서대로)
   - /Users/luvon/personal/AGENTS.md, /Users/luvon/personal/DECISIONS.md
   - /Users/luvon/personal/DESIGN.md  (토큰은 맨 위 frontmatter가 기준.
     파란 글자는 --accent-text, 채움·밑줄·체크박스는 --accent)
   - /Users/luvon/personal/design/mockup/feature-parity.md  (A1–A18·B·C)
   - /Users/luvon/personal/design/mockup/workspace-d.html   (마크업·CSS·상호작용의 참고.
     그 안의 JS는 가짜 상태이므로 붙여넣지 마세요)
   - 이 계획서의 [배치 N] 항목과 §1 아키텍처 결정
   - 고칠 파일: <파일:줄 범위 목록>
   - git -C <WT> log -2 --stat  (회의 검토 기능이 방금 들어왔습니다. 동작을 지키세요)

1) 작업 범위 (이 배치에서만)
   - 목표: <goal>
   - 고칠 것: <files/functions>
   - 지울 것: <deleted>
   - 새로 만들 것: <new functions>
   - 서버: <없음 | 엔드포인트와 테스트>
   - 이 배치에서 완성되는 parity 항목: <A…, B, C 중>

2) 지켜야 할 규칙
   - 프레임워크·빌드 단계·외부 패키지·웹폰트·이미지 금지. Node 기본 모듈, 시스템 글꼴만.
   - 모든 저장은 기존 검증된 API를 거칩니다. GET은 아무 파일도 쓰지 않습니다.
   - 다음 동작은 한 줄도 깨지면 안 됩니다: 복구 필요 배너(스스로 사라지지 않음) ·
     저장 실패 안내와 `다시 시도`·입력 보존 · 되돌리기/다시 실행 30개 ·
     삭제 알림은 닫기 전까지 유지 · 한글 조합 중 Enter 무시 · 입력 중이면 자동 갱신 건너뜀 ·
     화면 버전 바뀌면 자동 새로고침 · 당겨서 새로고침.
   - 색·간격·반경·그림자는 ui.css의 토큰만 씁니다(컴포넌트에 색 값 직접 금지).
   - 정보는 알약으로 그리지 않습니다. 보통/낮음/없음/0개는 목록에 찍지 않습니다.
   - 아이콘은 14px 인라인 SVG만. 이모지·글리프 금지.
   - client.test.js는 구조가 바뀌면 같은 검증 의도로 다시 씁니다. 문구
     `저장을 확인하지 못했습니다` `복구 필요 상태` `저장을 멈췄습니다`는 유지합니다.
   - 프로세스를 끝내는 코드는 직접 띄운 프로세스와 그 그룹에만 신호를 보냅니다.
     프로세스 목록을 훑어 종료 대상을 고르지 않습니다. (AGENTS.md)
   - 커밋·푸시 금지. 본 폴더(/Users/luvon/personal/tracker/inbox-app/)는 절대 건드리지 않습니다.
     4321 포트 금지. /Users/luvon/personal/tracker/ 아래 데이터 파일 열람 금지.

3) 검증 (전부 통과해야 끝)
   cd <WT>/tracker/inbox-app && node --test server.test.js client.test.js report-drafts.test.js
   node --check app.js && node --check workflows.js && node --check report-ui.js && node --check server.js
   git -C <WT> diff --check
   git -C <WT> diff --stat        # app.js 순변화 500줄 이하인지 보고
   # 서버는 지시가 있을 때만 띄웁니다. 띄우라고 하면 리뷰용 가짜 데이터 서버:
   #   cp /private/tmp/.../scratchpad/design-fixture.js /private/tmp/.../scratchpad/ui-d-fixture.js
   #   ui-d-fixture.js의 require('/Users/luvon/personal/tracker/inbox-app/server.js') 를
   #   require('<WT>/tracker/inbox-app/server.js') 로 바꿉니다(원본 257줄).
   #   DESIGN_FIXTURE_PORT=4323 node /private/tmp/.../scratchpad/ui-d-fixture.js
   #   (빠른 점검만: node ui-d-fixture.js --check — 스스로 끝납니다. 4322는 browser-fixture 자리)

4) 보고 (한국어, 결론 먼저)
   - 이 배치에서 새 모양이 된 화면 / 아직 옛 모양인 화면 각각 한 줄
   - 바꾼 파일과 줄 수, 지운 함수, 새로 만든 함수
   - 사용자가 브라우저에서 직접 눌러 볼 것 3~6개 (구체적으로)
   - 통과한 테스트 수, 확인하지 못한 것
```

---

## 6. 리뷰용 가짜 데이터에 대한 권고

`browser-fixture.js`(3건, `:8`에서 4322 포트)는 **저장소에 그대로 둔다** — API 빠른 확인과 테스트 보조용이고 가벼운 게 장점이다. 배치 리뷰는 scratchpad의 `design-fixture.js` 복사본(`ui-d-fixture.js`, `:257`의 require를 워크트리 `server.js`로 바꾸고 `DESIGN_FIXTURE_PORT=4323`)으로 한다. 이유: 풍부한 가짜 데이터 28KB를 저장소에 넣으면 "업무 데이터는 저장소에 넣지 않는다"는 결정과 결이 어긋나고, D 구현 중에만 쓰는 물건이다. 구현이 끝나 본 폴더로 옮길 때, 사용자가 "앞으로도 화면 리뷰에 쓰겠다"고 하면 그때 별도 커밋으로 들인다.

---

## 7. 구현에 가장 중요한 파일

- `/private/tmp/claude-501/-Users-luvon-personal/6f353f74-919b-4ae5-bc78-682eb9b15160/scratchpad/ui-d/tracker/inbox-app/app.js`
- `/private/tmp/claude-501/-Users-luvon-personal/6f353f74-919b-4ae5-bc78-682eb9b15160/scratchpad/ui-d/tracker/inbox-app/workflows.js`
- `/private/tmp/claude-501/-Users-luvon-personal/6f353f74-919b-4ae5-bc78-682eb9b15160/scratchpad/ui-d/tracker/inbox-app/index.html`
- `/Users/luvon/personal/DESIGN.md`
- `/Users/luvon/personal/design/mockup/workspace-d.html`

---

## 8. 조율자 결정 (2026-09-21, §4의 질문에 대한 답 — 이대로 구현)
1. **일괄 삭제:** 추천대로. 선택한 항목을 기존 `/api/track/remove`로 한 건씩 보내고, 알림의 `되돌리기` 한 번으로 `/api/track/restore`를 역순 호출. 일괄 `완료로 표시`만 `task-batch.js`를 넓힌다.
2. **나중에 할 일 서랍 상태:** 사용자가 이미 고른 안("열림 상태는 새로고침해도 기억")대로 **기억한다** — `localStorage`(기존 `safe-storage.js` 방식, try/catch). 추천안(항상 닫힘)은 채택하지 않는다.
3. **회의 정리의 `담을 프로젝트` 칸:** 없앤다(DECISIONS 화면 항목). 프로젝트 연결은 오늘 미팅 줄의 더보기에서만.
4. 확인 대기의 기한은 화면에서 `회신 기한`이라고 부른다(DECISIONS 2026-09-21). 업무는 `기한`.
5. 사용자 필수 유지 항목: 왼쪽 레일 한 줄 요약의 `오늘 신규 N`(누르면 오늘 들어온 항목만 모아 보기 — 팔레트 필터로 구현), 프로젝트 탭의 접힌 `완료한 업무 N`과 열 이름 줄(`언제 할지 | 업무 | 우선순위 | 기한`), 결정의 `PRD 반영함` 체크박스, 아이디어는 체크박스 없이 더보기만, 다음 주 계획은 기존 구조(문장 단위 `add`)를 유지한 채 문서 끝 상시 입력줄.
