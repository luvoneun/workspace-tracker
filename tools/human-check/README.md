# human-check — 사람 속도로 눌러 보고 쳐 보기

시험(`*.test.js`)은 click을 한 번에 쏘거나 값을 바로 넣어서 **누름과 뗌 사이의 시간**과 **한글 조합 상태**를 건너뛴다. 그래서 시험이 다 통과해도 실제 브라우저에서만 드러나는 버그가 있었다.

- 문장 A를 고치다 문장 B를 누르면, 누름(mousedown) 때 A가 저장되며 문서가 다시 그려져 뗌(mouseup) 때 누른 요소가 바뀌고 click이 사라졌다(첫 클릭 사라짐).
- 한글 조합 중(compositionstart~end)에 다른 저장의 다시 그리기가 칸을 새 요소로 바꿔 글자가 씹혔다.

human-check는 헤드리스 크롬의 실제 입력 장치(CDP `Input.dispatchMouseEvent` · `Input.dispatchKeyEvent` · `Input.imeSetComposition` · `Input.insertText`)로 누름과 뗌을 간격(hold)을 두고 보내고, 실제 조합 상태를 만들어 이런 버그를 잡는다. 손맛·이해하기 쉬움은 판단하지 않는다 — 단계별 통과/실패와 그림·프레임을 남길 뿐이다.

## 쓰는 법

```
node tools/human-check.mjs <시나리오.json> --serve [--out <폴더>] [--holds 0,50,100,150,300]
node tools/human-check.mjs <시나리오.json> --url http://127.0.0.1:4322/ [--out <폴더>]
```

| 옵션 | 뜻 |
|---|---|
| `--serve` | 가짜 데이터 서버(`tracker/inbox-app/browser-fixture.js`)를 4350~4399 빈 포트에 **hold마다 새로** 띄우고 끝나면 그 pid만 끈다. 돌 때마다 데이터가 처음 상태다 |
| `--app <폴더>` | `--serve`로 띄울 inbox-app 폴더. 옛 커밋을 임시 worktree로 꺼내 시험할 때 |
| `--url <주소>` | 그 주소만 쓴다. 데이터는 돌 때마다 이어진다. 운영·금지 포트(4321·4340·4318·4319·9333)는 거절 |
| `--out <폴더>` | 결과 JSON·그림·`index.html`을 둘 곳(기본: 임시 폴더, 마지막 줄 앞에 경로를 찍는다) |
| `--holds <ms,…>` | `click`의 누름~뗌 간격. 간격마다 시나리오 전체를 새 탭에서 다시 돈다(기본 `0,50,100,150,300`) |

마지막 줄은 `human-check: 통과 N · 실패 N · 못 돎 N (hold 0/50/100/150/300)`. 모두 통과면 종료 코드 0, 아니면 1, 인자·시나리오 오류는 2.
**통과** = 모든 단계 통과, **실패** = 단계 하나가 실패(그 자리에서 멈추고 그림을 찍는다), **못 돎** = 서버·크롬·첫 화면 열기(`goto`)가 안 됨.

결과 폴더의 `index.html` 한 장에 hold별 단계 목록·실패 표시·그림이 같은 폴더 상대 경로로 들어 있다 — 폴더째 받은함 `pages`로 올리면 폰에서 열린다.

## 시나리오

JSON 배열, 또는 `{ "name", "description", "steps": [...] }`. 동작마다 `"do"`와 칸들, 설명용 `"note"`. 모르는 동작·모르는 칸은 거절한다.

| 동작 | 칸 | 하는 일 |
|---|---|---|
| `goto` | `url`, `waitFor?`, `wait?`, `timeout?` | 주소(기준 주소에 상대) 열고 load를 기다림. 안 열리면 "못 돎" |
| `click` | `selector`, `nth?`, `hold?` | 요소 가운데로 마우스를 옮겨 누름 → hold ms → 뗌. `hold`가 없으면 `--holds`의 그 회차 값. 가운데를 다른 요소가 가리면 결과에 `covered`로 적는다(그래도 그 자리를 누른다 — 사람처럼) |
| `type` | `text`, `selector?`, `nth?`, `ime?`, `during?`, `duringAt?`, `delay?` | 글자마다 친다. `ime: true`면 한 글자를 `ㅎ → 하 → 한` 조합 단계로 거친 뒤 `insertText`로 확정. `during`(동작 배열)은 `duringAt`번째 글자(0부터)의 첫 자모만 친 조합 도중에 끼운다 — 예: `eval`로 다시 그리기 유발. `selector`가 있으면 먼저 그 칸에 초점 |
| `key` | `key` | `Enter` · `Escape` · `Tab` · `Backspace` |
| `wait` | `ms?`, `selector?`, `gone?`, `timeout?` | 시간, 또는 요소가 나올(`gone`이면 사라질) 때까지 |
| `eval` | `expr` | 페이지 안 식(Promise면 기다림). 값은 결과에 남는다 — 다시 그리기 유발(`load()`)·값 기억용 |
| `failRequests` | `pattern`, `status?` / `clear` | 주소가 정규식에 맞는 요청을 CDP Fetch로 실패시킨다(`status` 기본 500, `0`이면 네트워크 오류). `clear: true`로 끔 |
| `assert` | `expr`, `message?` | 식이 참이어야 통과 |
| `shot` | `name` | 지금 화면 그림(`h<hold>-<name>.png`) |
| `frames` | `name`, `ms` | 지금 도는 애니메이션·전환을 멈추고 시작점에서 `ms`만큼씩 옮겨 찍는다 — 실제 시계를 기다리지 않아 가려진 창 문제가 없다 |

저장소에 있는 시나리오(`scenarios/`):

- `주간요약-다른문장-누르기.json` — 위 버그 ①. 0446fd7 바로 앞(572b6d0)에서는 실패, 지금은 통과.
- `한글조합-다시그리기.json` — 위 버그 ②(결정 줄 문구 고치기). 052ef5f 바로 앞에서는 실패(저장된 문구가 `…확ㅇ`), 지금은 통과.

옛 커밋 시험: `git worktree add --detach <임시폴더> <커밋>` → `node tools/human-check.mjs <시나리오> --serve --app <임시폴더>/tracker/inbox-app` → 끝나면 `git worktree remove <임시폴더>`.

## 지키는 선

- 헤드리스 크롬은 매번 새 임시 프로필(`--user-data-dir` 임시 폴더, `--remote-debugging-port=0`)로 띄우고, 끝나면 그 프로세스 그룹에만 신호를 보내고 프로필을 지운다. 이미 떠 있는 크롬·디버그 포트에 붙는 옵션은 없다. 프로세스 목록을 훑지 않는다.
- 입력은 CDP 입력 이벤트만. OS 마우스·키보드를 움직이지 않는다.
- 운영·금지 포트는 `--url`로 받지 않는다. 실제 업무 데이터로 돌리지 않는다 — `--serve`(가짜 데이터)가 기본 길이다.
- `tracker/inbox-app/human-check.test.js`가 위 선을 고정한다.

## 한계

- **적어 둔 시나리오만** 본다. 새 흐름은 시나리오를 써야 잡힌다.
- **고른 간격만** 본다. hold 0은 누름·뗌이 거의 붙어 있어 경쟁(race)에 따라 결과가 갈릴 수 있다 — 버그를 볼 때는 50 이상을 기준으로 본다.
- **입력기 흉내**다. 실제 macOS 한글 입력기의 자모 순서·키 이벤트(keyCode 229 등)를 똑같이 내지는 않는다. 조합 시작·갱신·끝과 조합 중 input은 실제처럼 온다.
- **크롬만**. 사파리·파이어폭스는 안 본다.
- **손맛 판단 안 함.** 눈으로 볼 것은 `index.html`의 그림·프레임으로 사람이 본다.
