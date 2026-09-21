## 룩 4 「확정안」 완성 — 토스/flex 결로 다시 짰습니다

전환기에 다섯 번째 버튼 `확정안`이 생겼고, **기억해 둔 값이 없으면 룩 4로 열립니다**(localStorage 키를 `lookVariant` → `lookVariant2`로 올려서 주인이 바로 확정안을 보게 됩니다). `?look=4`로도 열립니다. 룩 0~3은 렌더링이 그대로입니다(룩 2 규칙을 룩 4와 나눠 쓰려고 선택자를 `html[data-look="2"]` → `html:is([data-look="2"],[data-look="4"])`로 바꿨는데, 명시도가 같은 값이라 0~3의 그림은 달라지지 않습니다 — 스크린샷으로 확인).

**첫 화면 오늘 업무 줄 수: 6줄** (1440×900, 새로 들어온 것 2줄이 위에 있는 상태). 줄 수 목표는 내려놓고 편안함을 택했습니다. 콘솔 오류 0건.

### 동작 점검 (룩 4)
더보기 메뉴 ✓ / 빠른 추가 ✓ / 체크 → 체크 그려짐 + 제목에 줄 그어지며 사라짐 ✓ / 진행 줄 갱신(`21개 중 6개 끝냈어요`) ✓ / ⌘Z ✓ / 고른 줄 강조 + 상세 패널 정렬 ✓ / 서랍이 본문 밀기 ✓ / 390px ✓ / 다크 ✓ / 키보드 초점 테 ✓.

### 두 가지 판단 (알려 드립니다)
1. **목록을 실선으로 자르지 않았습니다.** 흰 카드 한 장 안에서 줄 사이 여백(6px)과 둥근 회색 hover로 나눕니다. 실선보다 그쪽이 참고하신 제품 결에 가깝습니다.
2. **탭은 굵은 글자 + 파란 밑줄**로 했습니다(세그먼트 칩 대신). 목록 머리줄에 이미 세그먼트 컨트롤이 있어서, 둘을 겹치면 시끄러워집니다.

---

# 실제 반영용 명세

## 1. 토큰 (라이트 / 다크)

| 토큰 | 라이트 | 다크 | 쓰는 곳 |
|---|---|---|---|
| `--bg` | `#f2f4f6` | `#15181e` | 페이지·레일 바탕 |
| `--surface` | `#ffffff` | `#1e222a` | 모든 카드 |
| `--surface-line` | `transparent` | `#2b313b` | 카드 테두리(라이트는 없음) |
| `--field` | `#f2f4f6` | `#262b34` | 입력칸 채움 |
| `--hover` / `--rail-hover` | `#f4f6f8` | `#272c35` | 줄 hover |
| `--border` | `#e3e7eb` | `#333a45` | 컨트롤 테두리·진행 줄 트랙 |
| `--hair` | `#eef1f4` | `#2b313b` | 헤더 밑선 |
| `--text` | `#191f28` | `#eaedf1` | 본문 |
| `--muted` | `#4e5968` | `#a8b1bd` | 보조 글자·배지 글자 |
| `--dim` | `#636c78` | `#8b95a1` | 가장 조용한 글자 |
| `--accent` | `#3182f6` | `#4b91f1` | 채움·초점·진행 줄·체크 (글자 안 올림) |
| `--accent-strong` | `#1b64da` | `#4b91f1` | 흰 글자 올리는 채움 버튼 |
| `--accent-text` | `#1b64da` | `#7aa9ff` | 파란 글자 |
| `--accent-soft` | `#e8f3ff` | `#1b2a44` | 2차 버튼·칩·`지금` 배지 |
| `--on-fill` | `#ffffff` | `#0b1020` | 채움 위 글자 |
| `--sel` / `--sel-hover` | `#eef5ff` / `#e6f1ff` | `#1c2533` / `#212c3d` | 고른 줄 |
| `--urgent` / `--urgent-bg` | `#c9252d` / `#ffeceb` | `#ff8f8f` / `#3a2022` | 지남·긴급·삭제 |
| `--warn` / `--warn-bg` | `#b0560a` / `#fff4e5` | `#ffbe6b` / `#3a2e1b` | 오늘까지·높음 |
| `--success` / `--success-bg` | `#0d7a4a` / `#e6f6ee` | `#6ddba0` / `#1c3729` | 답변 해결·진행 줄 |
| `--neutral-bg` | `#eef1f4` | `#2a2f38` | 중립 배지·개수 칩·3차 버튼·세그먼트 트랙 |
| `--warm` / `--warm-line` / `--warm-hover` | `#fff8ed` / `transparent` / `#fff2de` | `#26221b` / `#332c22` / `#2e2820` | 새로 들어온 것·미루기 제안 |
| `--dot-blue` / `--dot-amber` / `--dot-neutral` | `accent` / `#e08c1a` / `#b0b8c1` | `accent` / `#e5a94f` / `#6b7684` | 구역 제목 점 |
| `--pj-0…5` | `#4f83e8 #2f9b87 #c0842b #8a6ed2 #cd6579 #5d9b47` | `#7aa2ff #57c6ad #dfa85c #b198ff #ef92a0 #8ccb72` | 프로젝트 색 점 |
| `--soft` | `0 1px 3px rgba(25,31,40,.04), 0 8px 24px rgba(25,31,40,.06)` | `0 1px 3px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3)` | 카드 |
| `--shadow` / `--pop` / `--drawer-sh` | `.06` / `0 12px 36px rgba(25,31,40,.14)…` / `-10px 0 30px rgba(25,31,40,.07)` | 대응값 | 손잡이 / 메뉴·알림 / 서랍 |

치수: `--r:20px --r-sm:12px --r-xs:10px --row:54px --grp:36px --hdr:60px --pad:20px --wp:104px --wm:184px --rail-w:296px --rail-bleed:20px --ease:cubic-bezier(.22,.8,.3,1)`
글꼴: `--font: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "Segoe UI", sans-serif` (웹폰트를 받지 않습니다 — 설치돼 있을 때만 씁니다)

## 2. 대비 (계산값, 4.5:1 기준)

**라이트** — text/흰바탕 **16.6** · text/바탕 **15.0** · muted/흰 **7.11** · muted/바탕 **6.45** · dim/흰 **5.32** · dim/바탕 **4.83** · accent-text/흰 **5.41** · accent-text/바탕 **4.91** · accent-text/`#e8f3ff` **4.82** · 흰글자/`#1b64da` **5.41**
배지: urgent `#c9252d`/`#ffeceb` **4.87** (흰 5.55, 바탕 5.03) · warn `#b0560a`/`#fff4e5` **4.62** (흰 5.02, 바탕 4.55) · success `#0d7a4a`/`#e6f6ee` **4.82** (흰 5.38) · 중립 `#4e5968`/`#eef1f4` **6.27**

**다크** — text/면 **13.6** · muted/면 **7.35** · muted/바탕 **8.20** · dim/면 **5.25** · accent-text/면 **6.79** · accent-text/`#1b2a44` **6.12** · on-fill/accent **5.97**
배지: urgent **6.79** · warn **8.09** · success **7.55** · 중립 **6.20**

> **참고 색에서 일부러 벗어난 두 곳**
> - 토스 계열의 `#8b95a1`(연한 회색 글자)은 흰 바탕에서 **3.04:1**이라 글자로 쓸 수 없습니다 → 라이트의 `--dim`을 `#636c78`로 한 단계 어둡게 했습니다(다크에서는 `#8b95a1` 그대로, 5.25 ✓).
> - `#3182f6`에 흰 글자는 **3.71:1**이라 미달 → **채움은 `#3182f6`**(진행 줄·체크·초점·탭 밑줄처럼 글자를 안 올리는 자리)**, 흰 글자를 올리는 버튼은 `#1b64da`**로 나눴습니다.

## 3. 컴포넌트 규칙 (`ui.css`, 전부 `html[data-look="4"]` 아래)

- **헤더** 60px 흰 띠, 테두리 대신 `box-shadow: 0 1px 0 var(--hair)`. 이름표 20px/700 `-0.02em`. 날짜는 **회색** 칩(28px, 999px, `--neutral-bg`). 검색은 알약형 회색 칸. 탭 15px/500, 켜진 탭 700 + 2.5px 파란 밑줄.
- **카드** `.d-list` `.d-inbox` `.d-detail` `.d-rsec` `.d-dbody .d-list` → `border:1px solid var(--surface-line)` + `border-radius:20px` + `box-shadow: var(--soft)`. 안쪽 여백 10px(목록)·22px(상세)·10/8/12px(레일 카드).
- **목록 줄** 54px, `border-radius:14px`, **실선 없음**(`.d-row + .d-row::after { content: none }`), hover = `--hover` 둥근 채움, 고른 줄 = `--sel` + 제목 `--accent-text`/600. 격자 `30px | 1fr | 104px | 184px`, 칸 사이 12px.
- **그룹 제목** 14.5px/600 + 프로젝트 색 점 + 둥근 회색 개수 칩, 위 14px 여백.
- **버튼 세 등급** — 3차 `.d-btn` 34px/회색채움/10px, 1차 `.d-btn.pri` 42px/`--accent-strong`/12px, 2차 `.d-acts .d-btn`·`.d-ibacts .d-btn` 33px/`--accent-soft`+`--accent-text`/10px(hover는 파란 채움). 삭제 `.dng`는 빨간 글자 → hover에서 `--urgent-bg`. 전부 `:active { transform: scale(.98) }`, 전환 170ms.
- **입력칸** `.d-qa .d-qaf .d-addrow .d-din .d-mtext .d-msel .d-dateinput .d-resin` → 테두리 0, `--field` 채움, 12px(퀵애드는 999px), 초점에서 `background:--surface` + `box-shadow: 0 0 0 2px var(--accent)`.
- **상태 배지** `.d-meta .m-pri/.m-due/.m-wait/.m-doing`, `.d-mrow .ct`, `.d-wrow .mt .k-*` → 23px, **6px 라운드**(알약 아님), 12.5px/600, 틴트 바탕 + 같은 색 진한 글자, `pointer-events:none`. `.k-neg`=빨강, `.k-warn`=주황, `.k-pos`=초록, 그 외 중립. `.m-pri` 안의 `.d-dot`은 숨김. **`.m-carry`(어제부터)·`.out`·`.d-proj`는 배지 아님 — `--dim` 평문.**
- **개수 칩** `.d-sechd .n`, `.d-rhd .n`, `.d-dhd .n`, `.d-grp .n` → 22px 둥근 회색. 새로 들어온 것·확인 대기는 `--warn-bg`. 오늘 할 일만 `.d-lhd .sub .cnt`가 파란 칩이고 `완료 5`는 조용한 글자(`.sep` 숨김).
- **세그먼트** 회색 트랙(12px) + 흰 손잡이(9px, `--shadow`). **체크박스** 22px 동그라미, 켜지면 `--accent` 채움 + 체크가 그려짐.
- **레일** 296px(격자 열은 `296-20`), 바탕 투명·오른쪽 선 없음. 카드 셋(미팅 / 리마인드+후속 / 확인 대기) — 리마인드와 후속은 `:has()`로 한 장처럼 붙임. 카드 안에서 `--rail-hover: var(--hover)`로 덮어써야 줄 위 동작 묶음이 안 비칩니다. 회의 시각 14px/700 진한 글자, **지금 하는 회의만 파랑 + `지금` 배지**.
- **서랍** 바탕색 판(`--bg`) + 그 안에 흰 카드 목록(카드 안의 카드 방지), `box-shadow: var(--drawer-sh)`, 테두리 없음. 떠 있는 상세 판도 같은 결.
- **좁은 화면** ≤900 레일 아래로, ≤640 헤더 여백·날짜 칩 축소, ≤520 줄을 두 줄 자동 높이 격자(`"ck ti ac" / "ck mt ac"`, min 60px)로 되돌림 — **룩 규칙이 원래 좁은 화면 규칙보다 명시도가 높아서 반드시 다시 덮어써야 합니다.**

## 4. 마크업 (`index.html`, 3곳)

1. `<head>` 맨 앞 인라인 스크립트 — 그리기 전에 `document.documentElement.dataset.look` 결정(`?look=` → `localStorage.lookVariant2` → 기본 `'4'`). try/catch.
2. `.d-lhd` 안의 개수: `<span class="sub num"><span class="cnt" id="todayTaskCount">0</span><span class="sep"> · </span><span id="todayDoneSummary">완료 0</span></span>` — `.cnt`/`.sep` 두 span이 칩 분리의 전부입니다.
3. `.d-lhd` 바로 아래 진행 줄: `<div class="d-prog" id="todayProgress" hidden><span class="bar" aria-hidden="true"><i id="todayProgressFill"></i></span><span class="lbl" id="todayProgressLabel"></span></div>`
   (그리고 비교용 전환기 `#lookSwitch` — 실제 반영 때는 통째로 버립니다.)

## 5. app.js — 도우미와 부르는 자리

| 함수 | 줄 | 하는 일 |
|---|---|---|
| `lookNow()` | 24 | `dataset.look`을 숫자로 |
| `lookProjectKey(name)` | 29 | `group:`/`jira:` 떼고 소문자·공백/`_`/`-` 제거 — 그룹 열쇠와 표시 이름의 색이 갈리지 않게 |
| `lookProjectHue(name)` | 34 | 이름 해시 % 6, **이미 쓴 색이면 다음 칸으로 밀어** 여섯 개까지 안 겹치게 |
| `lookProjectDot(name)` | 49 | `<i class="d-pjdot" data-pj="N" aria-hidden>` |
| `lookRenderProgress(done,total)` | 3335 | `#todayProgress` 보임/숨김, `--p` 퍼센트, 문구 |
| `setUpLookSwitch()` | 3348 | 비교용 전환기(실제 반영 때 삭제) |

부르는 자리: `uiGroupHeading` 309(`opts.projectName`) · `uiTaskRow`의 `.d-proj` 532 · `renderCalendar` 1029(레일 미팅) · `renderCalendar` 1032(`지금` 배지, look≥4) · `taskCompletionCheckbox` 1660(`is-completing` 클래스, look≥2) · `renderTodayTasks` 2468(진행 줄) / 2493(`projectName: key`) / 2504(빈 화면 문구).

**자료를 읽고 쓰는 코드는 한 줄도 건드리지 않았습니다.**

## 6. 새로 넣은 문구 (해요체, 기존 문구는 그대로)
- 진행 줄: `20개 중 5개 끝냈어요`
- 다 끝낸 날: `오늘 할 일을 모두 끝냈어요. 5개 마쳤습니다.`
- 지금 하는 회의: `지금`

## 7. 확인 못 한 것
- **Pretendard 실물로는 못 봤습니다** — 이 맥에 설치돼 있지 않아 시스템 글꼴로 찍혔습니다. 폰트를 넣으면 글자가 더 촘촘해져 줄 높이(54px)와 제목 크기를 한 번 더 보셔야 합니다.
- 오늘 화면만 봤습니다. 아이디어·결정 / 주간요약 / 회의·프로젝트·검색 화면은 공통 토큰(둥글기·글자·색)만 물려받고 옛 `.card` 부품이 남아 있어, 룩 4에서 어떻게 보이는지 확인하지 않았습니다.
- 프로젝트 색은 "먼저 나온 순서"로 겹침을 피하므로, 프로젝트가 하나 늘면 다른 프로젝트 색이 한 칸 밀릴 수 있습니다. 실제 반영 전에 색을 저장해 고정할지 정해야 합니다.
- 실제 터치 기기, `prefers-reduced-motion` 켠 화면, `data-theme` 속성을 직접 지정한 경우(앱에 전환 장치가 없어 OS 다크만 확인), 스크린리더.
- 레일 카드 합치기는 CSS `:has()`를 씁니다(크롬·사파리 최신 OK).

## 화면 (`.../scratchpad/`)
`look-4-{today,hover,detail,drawer,dark,390,menu,complete}.png`, 그리고 비교용으로 `look-0~3-*`.
