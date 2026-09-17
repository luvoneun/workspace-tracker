# 슬랙발 확인 대기 캡처

`#my-waiting` (나만 보는 비공개 슬랙 채널)에 공유해둔 메시지/스레드를 읽어서 `tracker/checks.md`에 등록합니다. 내가 할 일이 아니라, **누군가 확인/응답해줘야 나에게 알려주는 것**을 기다리는 항목입니다.

이 채널에 공유하는 행위 자체가 "이건 대기 중인 것이다"라는 사람의 명시적 표시입니다. AI는 포함 여부를 판단하지 않습니다. AI가 하는 일은 (a) 원본 스레드까지 읽어서 맥락 파악, (b) 문구 다듬기, (c) 누구를 기다리는지(who) 파악 시도, (d) 중복 제거입니다.

## 채널 정보

- 채널 ID와 슬랙 주소는 **`workspace.config.json`의 `slack.channels.waiting.id`와 `slack.workspaceUrl`에서 읽는다** (하드코딩하지 말 것)
- 이 채널은 비공개, 사용자 1인 멤버 — 작성자 필터링 불필요

## 작업 지시

1. **상태 파일 확인**

   `tracker/inbox-app/.slack_capture_state.json`을 읽는다 (없으면 `{}`로 취급). `my-waiting` 키에 마지막으로 처리한 메시지 ts가 있으면 그 값을 `oldest`로 사용한다.

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
     - `channel_id`, (`from_url`의 `thread_ts` 쿼리파라미터가 있으면 그걸, 없으면 `ts`를) 원본 채널/스레드 시각으로 사용
     - `mcp__slack__conversations_replies`(channel_id, thread_ts)로 원본 스레드 전체를 읽어서 맥락 파악 시도
       - **성공하면**: 스레드 내용을 바탕으로 "무엇을 기다리는지" 문구로 정리하고, 스레드에서 확인/응답을 요청받은 특정 인물이 명확히 드러나면 `who`에 기록 (예: 담당자 이름). 애매하면 `who`는 비워둔다 — 억지로 추측하지 않는다.
       - **실패하면**: attachment의 `fallback`/`text`를 문구로 그대로 사용, `who`는 비움, "⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함"으로 표시해서 결과 출력에 반드시 포함
     - 이미 사람이 "이건 대기 중인 것이다"라고 골라서 넣은 것이므로 애매해도 제외하지 않음 — 문구와 who만 정리한다.
   - `attachments`가 없는 경우 (직접 타이핑한 메모): 메시지 `text`를 그대로 문구로 사용, permalink는 `<slack.workspaceUrl>/archives/<채널ID>/p<ts에서 점(.) 제거>`로 생성

4. **내용 중복 확인** (permalink 중복과 별개로, 실제 의미가 같은 항목인지)
   - `tracker/checks.md`와 `tracker/tasks.md`, `tracker/decisions.md`를 읽고, 새로 캡처하려는 항목이 **이미 있는 항목과 사실상 같은 내용**이면 (표현이 달라도 같은 일을 가리키면) 등록하지 않는다
   - 건너뛴 항목은 반드시 결과 출력에 "🔁 이미 있는 '[기존 항목 문구]'랑 중복돼서 안 가져왔어요"로 알린다

5. **확인 대기 항목으로 등록**
   - 새 항목마다 ULID(`chk_` 접두사) 생성, `tracker/checks.md`에 아래 형식으로 추가 (파일 없으면 헤더 `# Checks`로 새로 생성)

```markdown
- [무엇을 기다리는지] #check[id:chk_[ULID] status:to-do priority:medium created:YYYY-MM-DD source:slack:permalink who:담당자]
```

   (`who`는 파악 안 되면 생략)

6. **상태 파일 갱신**
   - 이번에 조회된 메시지 중 가장 큰(최신) ts를 `tracker/inbox-app/.slack_capture_state.json`의 `my-waiting` 키에 저장
   - **새 메시지 유무와 상관없이** 같은 파일의 `checkedAt` 키에 현재 시각을 ISO 8601로 기록한다 (예: `"checkedAt": "2026-09-17T09:07:00+09:00"`). 앱이 "슬랙 캡처가 언제 마지막으로 돌았는지"를 이 값으로 판단하므로, 가져올 게 없어서 아무것도 안 하는 경우에도 반드시 갱신한다.

## 결과 출력

- 새로 추가된 항목 수
- 각 항목 [문구 / 누구 확인 대기인지 / 간단 맥락 한 줄] 나열
- 중복이라 건너뛴 항목이 있으면 반드시 별도로 알림
- 원본 스레드를 못 읽은 항목이 있으면 반드시 별도로 알림
- 없으면 "새로 생긴 확인 대기 항목 없음"
- 한국어로

## 주의사항

- 원본 슬랙 스레드 내용(다른 사람과의 대화 원문)은 최종 출력에 그대로 노출하지 말고, 압축된 요약 문구로만 다룬다
- 조회량은 스크립트의 `limit` 인자로 적당히 좁힌다 (기본 100)
- `#my-waiting` 채널 안의 메시지는 읽기만 한다 — 삭제/수정 등 아무 것도 건드리지 않는다

## Related Commands

- `/slack-todos` — 슬랙에서 할 일 캡처
- `/slack-alignments` — 슬랙에서 결정/합의된 정책·얼라인 캡처
- `/slack-someday` — 슬랙에서 언젠가(참고용) 캡처
