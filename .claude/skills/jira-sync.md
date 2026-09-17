# 지라 이슈 캐시 동기화

내(루본) 담당 지라 이슈 중 진행중/백로그인 것들을 `tracker/jira_issues.md`에 최신 스냅샷으로 저장합니다. 인박스 앱의 "지라 이슈 연결" 드롭다운이 이 파일을 읽어요.

## 입력

조회 범위(선택, 기본은 "내 담당 + 진행중/백로그"): $ARGUMENTS

## 작업 지시

1. **Atlassian MCP 도구 로드 확인**
   - `ToolSearch`로 `mcp__atlassian__*` 도구 스키마 로드 (`getAccessibleAtlassianResources`, `searchJiraIssuesUsingJql` 최소 필요)
   - 도구가 안 보이거나 인증이 안 되어 있으면(`claude mcp list`에서 atlassian이 "Needs authentication") — 세션에서 `/mcp`로 재인증 안내 후 중단

2. **cloudId 확보**
   - `getAccessibleAtlassianResources` 호출해서 cloudId 확보 (세션 내 이미 확보한 값이 있으면 재사용)

3. **이슈 조회**
   - `searchJiraIssuesUsingJql`로 조회. 기본 JQL: `assignee = currentUser() AND statusCategory != Done order by updated DESC`
   - `$ARGUMENTS`에 다른 범위(예: 특정 프로젝트, 특정 담당자)가 주어지면 그에 맞게 JQL 조정
   - `view: compact`로 충분 (key, summary, status, issuetype만 필요)

4. **`tracker/jira_issues.md` 덮어쓰기**
   - 이 파일은 **스냅샷**이라 기존 내용과 병합하지 않고 통째로 새로 씀 (slack_inbox.md와 다른 점 — 거기는 미답변 상태를 유지해야 해서 병합하지만, 여긴 그냥 "지금 시점 내 담당 이슈 목록"이라 매번 새로 써도 무방)
   - 이미 앱에서 작업에 연결해둔 `jira:KEY` 태그는 `tracker/tasks.md` 등 다른 파일에 있으므로 이 파일을 덮어써도 영향 없음

## 파일 형식 (`tracker/jira_issues.md`)

```markdown
# 지라 이슈 (내 담당, 진행중/백로그)

마지막 갱신: YYYY-MM-DD

- IO-45438 | 에픽 | 진행 중 | 보드 AI
- IO-36600 | 에픽 | Backlog | 게시판 모아보기 기능 추가
```

한 줄에 `- 키 | 이슈타입 | 상태 | 요약` 형식을 정확히 지킬 것 (앱의 파서가 이 형식에 고정돼 있음).

## 결과 출력

- 조회된 이슈 수
- 지난 갱신 대비 새로 추가되거나 사라진 이슈가 있으면 언급 (있으면 좋고, 없어도 괜찮음)
- 모두 한국어로

## 주의사항

- JQL은 항상 범위를 좁혀서 조회 (전체 프로젝트 무제한 조회 금지 — Jira가 애초에 막음)
- 이슈 설명/댓글 등 본문 내용은 가져오지 않는다 (요약과 상태만)

## Related Commands

- `/slack-inbox` — 슬랙 미답변 인박스 갱신
- `/track task` — 마감 있는 작업 기록
