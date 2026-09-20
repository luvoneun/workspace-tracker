# 슬랙발 정책/얼라인 캡처

`#my-align` (나만 보는 비공개 슬랙 채널)에 공유해둔 메시지/스레드를 읽어서 `tracker/decisions.md`에 등록합니다. 나중에 PRD에 반영할지 검토하기 위한 후보 목록입니다.

이 채널에 뭔가를 "공유(포워드)"하는 행위 자체가 곧 "이건 정책/얼라인된 내용이다"라는 사람의 명시적 표시입니다. AI는 어떤 걸 포함시킬지 판단하지 않습니다 — 이미 채널에 들어와 있는 것만 처리합니다. AI가 하는 일은 (a) 원본 스레드까지 읽어서 맥락 파악, (b) 결정 내용을 한 줄로 정리, (c) 중복 제거뿐입니다.

## 채널 정보

- 채널 ID와 슬랙 주소는 **`workspace.config.json`의 `slack.channels.align.id`와 `slack.workspaceUrl`에서 읽는다** (하드코딩하지 말 것)
- 이 채널은 비공개, 사용자 1인 멤버 — 작성자 필터링 불필요

## 작업 지시

1. **상태 파일 확인**

   `tracker/inbox-app/.slack_capture_state.json`을 읽는다 (없으면 `{}`로 취급). `my-align` 키에 마지막으로 처리한 메시지 ts가 있으면 그 값을 `oldest`로 사용한다.

2. **채널 원본 데이터 조회**

   `tracker/inbox-app/fetch_slack_channel.sh` 스크립트를 실행해서 채널 히스토리를 JSON으로 받는다.

   ```bash
   bash tracker/inbox-app/fetch_slack_channel.sh <설정에서 읽은 채널ID> 100 [oldest_ts, 있으면]
   ```

   자동 분류기가 이 실행을 막으면 사용자에게 직접 실행해달라고 안내하고 결과를 받아서 진행한다.

3. **메시지별로 처리**

   받은 JSON의 `messages` 배열을 순회하며:
   - `subtype`이 `channel_join`, `channel_name` 등 시스템 메시지면 건너뜀
   - `attachments` 배열이 있으면, 그 안의 각 항목을 순회하며 `is_share: true`인 것을 찾는다 (보통 1개지만 여러 개일 수 있음):
     - `from_url`에서 쿼리스트링(`?` 이후) 제거한 걸 permalink로 사용
     - `channel_id`, `ts`를 원본 채널/시각으로 사용
     - `mcp__slack__conversations_replies`(channel_id, thread_ts=ts)로 원본 스레드 전체를 읽어서 맥락 파악 시도
       - **성공하면**: 스레드 내용을 바탕으로 "무엇이 정해졌는지"를 한 줄로 정리 (예: "~하기로 결정", "~는 제외하기로 함"). 그리고 `tracker/jira_issues.md`를 참고해서 이 결정이 특정 지라 티켓/기능과 명확히 관련되어 보이면 그 지라 키를 그룹 후보로 삼는다 (예: 스레드에 "보드 AI" 얘기가 계속 나오고 jira_issues.md에 "IO-45438 · 보드 AI"가 있으면 그걸로). 애매하거나 안 맞으면 억지로 끼워맞추지 않고 그냥 비워둔다.
       - **실패하면** (권한 없음, 채널 못 찾음 등): 대신 attachment의 `fallback` 또는 `text` 필드를 문구로 그대로 사용하고, 이 항목을 "⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함"으로 표시해서 최종 결과 출력에 반드시 포함시킨다 (조용히 넘어가지 않는다)
     - 이미 사람이 "이건 정책/얼라인이다"라고 골라서 넣은 것이므로 애매해도 제외하지 않음 — 문구만 정리한다.
   - `attachments`가 없는 경우 (그냥 이 채널에 직접 타이핑한 메모):
     - 메시지 `text`를 그대로 문구로 사용
     - permalink는 `<slack.workspaceUrl>/archives/<채널ID>/p<ts에서 점(.) 제거>` 로 직접 생성

4. **중복 제거**
   - `tracker/decisions.md`를 읽고 (없으면 새로 생성, 헤더는 `# Decisions`), 이미 같은 permalink(`source:slack:`)로 등록된 항목은 건너뜀 (원본이 같은 메시지)
   - 그리고 `tracker/decisions.md`를 훑어서, 새로 캡처하려는 항목이 **표현은 달라도 사실상 같은 결정**을 가리키는 기존 항목이 있으면 등록하지 않는다
   - 이렇게 건너뛴 항목은 반드시 결과 출력에 "🔁 이미 있는 '[기존 항목 문구]'랑 중복돼서 안 가져왔어요"로 알린다

5. **검증된 API로 등록**
   - Markdown 파일을 직접 생성·수정하지 않는다. UI와 같은 저장·복구 규칙을 사용해야 한다.
   - 새 항목마다 아래 한 줄을 실행한다. JSON은 작은따옴표로 감싼 **명령줄 인자**로 넘긴다 — 파이프(`echo … | node …`)나 히어독은 캡처 실행의 명령 검사에 막힌다. 문구에 작은따옴표(`'`)가 있으면 명령이 깨지므로 `’`로 바꿔 넣는다.

     ```bash
     node tracker/inbox-app/import-record.js item '{"type":"decision","description":"정리한 한 줄","permalink":"원본 https 링크"}'
     ```
   - 문구는 1,000자 이내 한 줄. 필요한 경우 `priority`, `jira`, `group`, `who`, `project`, 명시적 `due`를 추가한다. 추측한 날짜는 넣지 않는다.
   - task는 서버가 자동으로 인박스에 넣는다. ID·created·status는 서버가 만든다.
   - 반환값 `ok:true`를 확인한다. `duplicate:true`면 기존 원본 링크와 중복되어 추가하지 않은 것이다.
   - 서버가 꺼졌거나 저장에 실패하면 파일 직접 수정으로 우회하지 말고 실패를 알린다.

6. **전부 성공한 뒤 커서 갱신**
   - 모든 페이지 조회와 필요한 항목 저장이 성공한 경우에만 `node tracker/inbox-app/import-record.js cursor '{"channel":"my-align","ts":"이번 조회의 최신 ts"}'`를 같은 방식(명령줄 인자)으로 실행한다.
   - 하나라도 실패하면 커서를 전진시키지 않는다. 같은 항목 재시도는 서버에서 원본 링크로 중복 제거한다.
   - 조회 스크립트가 실패하면 부분 JSON으로 처리하지 않는다. 새 메시지가 없으면 커서를 유지한다.
   - 전체 과정이 성공하면 `node tracker/inbox-app/import-record.js health '{"channel":"my-align","success":true}'`를, 실패하면 `node tracker/inbox-app/import-record.js health '{"channel":"my-align","success":false,"error":"실패 이유"}'`를 실행한다.
   - 상태 JSON도 직접 덮어쓰지 않는다.

## 결과 출력

- 새로 추가된 항목 수
- 각 항목 [정리된 문구 / 간단 맥락 한 줄] 나열, 사람이 검수하기 좋게
- 원본 스레드를 못 읽은 항목이 있으면 반드시 별도로 눈에 띄게 알림 (예: "⚠️ 아래 N개는 원문을 못 읽어서 공유 당시 텍스트만 반영했어요")
- 중복이라 건너뛴 항목이 있으면 반드시 별도로 알림
- 없으면 "새로 생긴 정책/얼라인 없음"
- 한국어로

## 주의사항

- 원본 슬랙 스레드 내용(다른 사람과의 대화 원문)은 최종 출력에 그대로 노출하지 말고, 압축된 요약 문구로만 다룬다
- 조회량은 스크립트의 `limit` 인자로 적당히 좁힌다 (기본 100)
- `#my-align` 채널 안의 메시지는 읽기만 한다 — 삭제/수정 등 아무 것도 건드리지 않는다

## Related Commands

- `/slack-todos` — 슬랙에서 할 일 캡처
- `/jira-sync`, `/calendar-sync` — 다른 데이터 소스 갱신
