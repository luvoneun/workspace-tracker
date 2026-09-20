# 슬랙발 언젠가(참고용) 캡처

`#my-someday` (나만 보는 비공개 슬랙 채널)에 공유해둔 메시지/스레드를 읽어서 `tracker/ideas.md`에 등록합니다. 확정된 일이 아니라, 나중에 참고만 하면 되는 수준의 메모입니다. (참고: 확정됐지만 오늘 할 일은 아닌 것은 `#my-todo`로 가야 함 — `/slack-todos` 참고)

이 채널에 공유하는 행위 자체가 "이건 언젠가 참고할 거리다"라는 사람의 명시적 표시입니다. AI는 포함 여부를 판단하지 않습니다. AI가 하는 일은 (a) 원본 스레드까지 읽어서 맥락 파악, (b) 메모 문구로 다듬기, (c) 확정 가능성 1차 판단(낮음/보통/높음), (d) 중복 제거입니다.

## 채널 정보

- 채널 ID와 슬랙 주소는 **`workspace.config.json`의 `slack.channels.someday.id`와 `slack.workspaceUrl`에서 읽는다** (하드코딩하지 말 것)
- 이 채널은 비공개, 사용자 1인 멤버 — 작성자 필터링 불필요

## 작업 지시

1. **상태 파일 확인**

   `tracker/inbox-app/.slack_capture_state.json`을 읽는다 (없으면 `{}`로 취급). `my-someday` 키에 마지막으로 처리한 메시지 ts가 있으면 그 값을 `oldest`로 사용한다.

2. **채널 원본 데이터 조회**

   ```bash
   bash tracker/inbox-app/fetch_slack_channel.sh <설정에서 읽은 채널ID> 100 [oldest_ts, 있으면]
   ```

   자동 분류기가 이 실행을 막으면 사용자에게 직접 실행해달라고 안내하고 결과를 받아서 진행한다.

3. **메시지별로 처리**

   받은 JSON의 `messages` 배열을 순회하며:
   - `subtype`이 `channel_join`, `channel_name` 등 시스템 메시지면 건너뜀
   - `attachments` 배열이 있으면, 그 안의 각 항목을 순회하며 `is_share: true`인 것을 찾는다:
     - `from_url`에서 쿼리스트링(`?` 이후) 제거한 걸 permalink로 사용
     - `channel_id`, `ts`를 원본 채널/시각으로 사용
     - `mcp__slack__conversations_replies`(channel_id, thread_ts=ts)로 원본 스레드 전체를 읽어서 맥락 파악 시도
       - **성공하면**: 스레드 내용을 바탕으로 메모 문구를 다듬고, 대화 톤을 보고 확정 가능성을 판단한다 (예: "꼭 해야 함/거의 확정"처럼 읽히면 high, "그냥 아이디어 차원/누가 지나가듯 언급"이면 low, 애매하면 medium)
       - **실패하면** (권한 없음, 채널 못 찾음 등): attachment의 `fallback` 또는 `text` 필드를 문구로 그대로 사용하고 가능성은 `medium`으로 기본 설정, 이 항목을 "⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함"으로 표시해서 최종 결과 출력에 반드시 포함
     - 이미 사람이 "이건 언젠가다"라고 골라서 넣은 것이므로 애매해도 제외하지 않음 — 문구와 가능성 판단만 한다. 가능성 판단은 어차피 앱 화면에서 사람이 배지를 눌러 바로 고칠 수 있으니 너무 고민하지 말고 1차 추정으로 충분하다.
   - `attachments`가 없는 경우 (그냥 이 채널에 직접 타이핑한 메모):
     - 메시지 `text`를 그대로 문구로 사용, 가능성은 `medium`
     - permalink는 `<slack.workspaceUrl>/archives/<채널ID>/p<ts에서 점(.) 제거>` 로 직접 생성

4. **중복 제거**
   - 이미 같은 원본 ts를 처리했는지는 상태 파일의 커서로 관리한다 (커서 이후 메시지만 조회되므로 원본 중복은 걱정 적음)
   - 그리고 `tracker/ideas.md`, `tracker/tasks.md`를 훑어서, 새로 캡처하려는 항목이 **표현은 달라도 사실상 같은 내용**을 가리키는 기존 항목이 있으면 등록하지 않는다
   - 이렇게 건너뛴 항목은 반드시 결과 출력에 "🔁 이미 있는 '[기존 항목 문구]'랑 중복돼서 안 가져왔어요"로 알린다

5. **검증된 API로 등록**
   - Markdown 파일을 직접 생성·수정하지 않는다. UI와 같은 저장·복구 규칙을 사용해야 한다.
   - 새 항목마다 아래 한 줄을 실행한다. JSON은 작은따옴표로 감싼 **명령줄 인자**로 넘긴다 — 파이프(`echo … | node …`)나 히어독은 캡처 실행의 명령 검사에 막힌다. 문구에 작은따옴표(`'`)가 있으면 명령이 깨지므로 `’`로 바꿔 넣는다.

     ```bash
     node tracker/inbox-app/import-record.js item '{"type":"idea","description":"정리한 한 줄","permalink":"원본 https 링크"}'
     ```
   - 문구는 1,000자 이내 한 줄. 필요한 경우 `priority`, `jira`, `group`, `who`, `project`, 명시적 `due`를 추가한다. 추측한 날짜는 넣지 않는다.
   - task는 서버가 자동으로 인박스에 넣는다. ID·created·status는 서버가 만든다.
   - 반환값 `ok:true`를 확인한다. `duplicate:true`면 기존 원본 링크와 중복되어 추가하지 않은 것이다.
   - 서버가 꺼졌거나 저장에 실패하면 파일 직접 수정으로 우회하지 말고 실패를 알린다.

6. **전부 성공한 뒤 커서 갱신**
   - 모든 페이지 조회와 필요한 항목 저장이 성공한 경우에만 `node tracker/inbox-app/import-record.js cursor '{"channel":"my-someday","ts":"이번 조회의 최신 ts"}'`를 같은 방식(명령줄 인자)으로 실행한다.
   - 하나라도 실패하면 커서를 전진시키지 않는다. 같은 항목 재시도는 서버에서 원본 링크로 중복 제거한다.
   - 조회 스크립트가 실패하면 부분 JSON으로 처리하지 않는다. 새 메시지가 없으면 커서를 유지한다.
   - 전체 과정이 성공하면 `node tracker/inbox-app/import-record.js health '{"channel":"my-someday","success":true}'`를, 실패하면 `node tracker/inbox-app/import-record.js health '{"channel":"my-someday","success":false,"error":"실패 이유"}'`를 실행한다.
   - 상태 JSON도 직접 덮어쓰지 않는다.

## 결과 출력

- 새로 추가된 메모 수
- 각 항목 [문구 / 판단한 가능성 / 간단 맥락 한 줄] 나열, 사람이 검수하기 좋게
- 원본 스레드를 못 읽은 항목이 있으면 반드시 별도로 눈에 띄게 알림
- 중복이라 건너뛴 항목이 있으면 반드시 별도로 알림
- 없으면 "새로 생긴 언젠가 메모 없음"
- 한국어로

## 주의사항

- 원본 슬랙 스레드 내용(다른 사람과의 대화 원문)은 최종 출력에 그대로 노출하지 말고, 압축된 요약 문구로만 다룬다
- 조회량은 스크립트의 `limit` 인자로 적당히 좁힌다 (기본 100)
- `#my-someday` 채널 안의 메시지는 읽기만 한다 — 삭제/수정 등 아무 것도 건드리지 않는다

## Related Commands

- `/slack-todos` — 슬랙에서 할 일 캡처 (확정 + 오늘/나중에)
- `/slack-alignments` — 슬랙에서 결정/합의된 정책·얼라인 캡처
