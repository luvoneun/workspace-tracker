# 오늘 캘린더 일정 동기화

구글 캘린더에서 오늘 일정을 가져와 `tracker/calendar_today.md`에 저장합니다. 인박스 앱 오늘 탭 왼쪽 레일의 "오늘 미팅" 카드가 이 파일을 읽어요.

설정 › 연동 › 캘린더에서 **비밀 주소 붙이기** 갈래(`workspace.config.json`의 `calendar.source: "ical"`)를 고른 사람은 앱 서버가 캘린더를 직접 읽어요 — 그때는 이 파일을 보지 않고, 자동 실행(`run-task.sh`)도 이 스킬을 건너뛰어요.

## 입력

없음 (항상 "오늘" 기준). $ARGUMENTS로 특정 날짜를 지정하면 그 날짜로 대신 조회.

## 작업 지시

1. **Google Calendar MCP 도구 로드 확인**
   - `ToolSearch`로 `mcp__*Google_Calendar__list_events` (서버 프리픽스는 세션마다 다를 수 있음, `calendar` 키워드로 검색) 로드
   - 도구가 안 보이면 인증이 안 되어 있는 것 — 세션에서 인증 안내 후 중단 (구글 캘린더는 `/mcp`만으로 완전히 인증되지 않을 수 있어, 대화 중 `authenticate`/`complete_authentication` 도구 쌍이 뜨면 그 플로우를 따른다)

2. **오늘 하루 범위로 조회**
   - `list_events`에 `startTime`: 오늘 00:00:00+09:00, `endTime`: 내일 00:00:00+09:00, `timeZone: Asia/Seoul`, `orderBy: startTime`
   - primary 캘린더만 조회 (calendarId 생략)

3. **`tracker/calendar_today.md` 덮어쓰기**
   - 이 파일도 지라 캐시처럼 **스냅샷**이라 병합하지 않고 통째로 새로 씀
   - 종일 일정(all-day)은 시간이 없으므로 제외하거나 "하루 종일"로 표기 (파서는 `HH:MM-HH:MM` 형식만 인식하니, 종일 일정을 넣고 싶으면 스킬 자체 판단으로 형식을 맞추거나 생략)

## 파일 형식 (`tracker/calendar_today.md`)

```markdown
# 오늘 캘린더 일정

마지막 갱신: YYYY-MM-DD

- 14:40-15:00 | 과금 유저 우대 논의
- 15:00-16:00 | PMO 정기 회의
```

일정이 없으면 헤더만 남기고 항목 줄은 비운다. 이벤트의 provider ID가 있으면 반드시 `- HH:MM-HH:MM | 제목 | id:이벤트ID` 형태로 마지막에 추가한다. 같은 이벤트의 제목이나 시간이 바뀌어도 ID는 그대로 유지한다. ID가 없으면 기존 형식을 유지하고 추측해서 만들지 않는다.

## 결과 출력

- 오늘 일정 수와 각 일정 제목/시간 요약
- 없으면 "오늘 일정 없음"이라고만
- 한국어로

## 주의사항

- 시간대는 항상 `Asia/Seoul` 기준
- 참석자 목록, 회의 설명(description) 등 세부 내용은 가져오지 않는다 (시간과 제목만)

## Related Commands

- `/slack-inbox` — 슬랙 미답변 인박스 갱신
