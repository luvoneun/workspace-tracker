# /track Command

`/track [type] [description]`는 실행 중인 앱의 수동 등록 API로 항목을 만듭니다. `tracker/*.md`를 직접 편집하지 않습니다 — 앱의 검증·ID 생성·인박스 분류를 우회하게 됩니다.

## 종류 매핑

- `task` → 오늘 할 일이면 `/api/today-task/create`, 아니면(기본) `/api/later-task/create`
- `check`(확인 대기) → `/api/waiting/create`
- `decision` → `/api/decision/create`
- `idea` → `/api/idea/create`
- `bug`는 등록 API가 없습니다. `task`로 등록하고 그렇게 했다고 알립니다.

## 요청

포트는 `workspace.config.json`의 `server.port`(기본 4321)를 씁니다. POST는 `Content-Type: application/json` 헤더가 필수이고, Host는 `localhost`/`127.0.0.1`만 허용됩니다.

```sh
curl -X POST http://localhost:4321/api/today-task/create \
  -H "Content-Type: application/json" \
  -d '{"description":"...", "priority":"medium", "due":"2026-09-25"}'
```

- 필수: `description`(줄바꿈 없이 1,000자 이내)
- 공통 선택: `priority`(low/medium/high/critical, 기본 medium), `jira`(예: `ABC-123`) 또는 `group`
- `check`에는 `who`, `idea`에는 `project` 선택 필드가 더 있습니다
- 마감일(`due`, YYYY-MM-DD)은 사용자가 날짜를 명시했을 때만 넣고, 절대 추측하지 않습니다. `task`(`today-task`·`later-task`)만 요청에 `due`를 함께 보낼 수 있습니다(나중 업무는 마감일이 있어도 나중에 할 일에 그대로 남습니다)
- `id`·`created`·`status`는 서버가 생성합니다

응답 `{"ok":true,"id":"..."}`로 성공을 확인합니다. 실패하면(`ok:false`, 연결 실패 등) 사용자에게 실패를 그대로 알리고, 파일을 직접 고쳐서 우회하지 않습니다.

`/api/import`(Slack 수집 전용, https 원본 링크 필요)는 여기서 쓰지 않습니다.
