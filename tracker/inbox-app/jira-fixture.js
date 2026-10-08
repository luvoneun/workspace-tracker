// 화면 확인용 가짜 지라 — 브라우저 픽스처(`WORKSPACE_FIXTURE_JIRA=1 node browser-fixture.js`)만 쓴다.
// 이름(`*-fixture.js`)이라 화면으로 나가지 않는다(server.js isClientFile). 사람은 전부 가짜(테스터A~E)이고,
// 정해 둔 가짜 주소(FIXTURE_JIRA_SITE) 말고는 어떤 주소에도 답하지 않고 던진다 — 실제 지라에 닿을 길이 없다.
// 값은 이 프로세스 메모리에만 있다(담당을 바꾸면 메모리만 바뀐다. 파일은 쓰지 않는다).
// 새 프로젝트 만들기도 받는다(에픽·작업 두 종류). 요약에 아래 표시를 넣으면 실패를 흉내 낸다 —
// `[끊김]` 만들어지는데 응답이 끊김(결과 모름) · `[5xx]` 503으로 안 만들어짐(결과 모름) · `[거절]` 400(확실한 실패).
// `[찾기실패]`가 든 요약을 찾으면(결과 모름 뒤 다시 시도) 검색이 503이다.
const FIXTURE_JIRA_SITE = 'https://jira.fixture.invalid';
const ME = 'fx-tester-a';

const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function createJiraFixture() {
  // 같은 이름(테스터B) 둘·비활성 하나·앱 계정 하나 — 고르개의 예외 상황을 눌러 보려는 것.
  const users = [
    { accountId: ME, displayName: '테스터A', active: true, accountType: 'atlassian' },
    { accountId: 'fx-tester-b1', displayName: '테스터B', active: true, accountType: 'atlassian' },
    { accountId: 'fx-tester-b2', displayName: '테스터B', active: true, accountType: 'atlassian' },
    { accountId: 'fx-tester-c', displayName: '테스터C', active: true, accountType: 'atlassian' },
    { accountId: 'fx-tester-d', displayName: '테스터D', active: true, accountType: 'atlassian' },
    { accountId: 'fx-tester-e', displayName: '테스터E', active: false, accountType: 'atlassian' },
    { accountId: 'fx-bot', displayName: '테스트 자동화 봇', active: true, accountType: 'app' },
  ];
  const userOf = id => users.find(user => user.accountId === id) || null;
  const status = (name, key) => ({ name, statusCategory: { key } });
  let updated = 0;
  const issue = (key, summary, type, who, state, extra = {}) => ({ key, summary, type, who, state, updated: (updated += 1), ...extra });
  const issues = [
    issue('IO-140', '결제 리뉴얼', '에픽', ME, status('진행 중', 'indeterminate'), { due: '2026-10-17', versions: [{ id: '10101', name: 'v2.71.0', releaseDate: '2026-10-08', released: false }] }),
    issue('IO-141', '[Web] 결제 리뉴얼 웹', '작업', 'fx-tester-c', status('진행 중', 'indeterminate'), { parent: 'IO-140' }),
    issue('IO-142', '[iOS] 결제 리뉴얼 iOS', '작업', null, status('할 일', 'new'), { parent: 'IO-140' }),
    issue('IO-143', '[Android] 결제 리뉴얼 안드로이드', '작업', null, status('할 일', 'new'), { parent: 'IO-140' }),
    issue('IO-144', '[Backend] 결제 리뉴얼 서버', '작업', null, status('할 일', 'new'), { parent: 'IO-140' }),
    issue('IO-145', '[Design] 결제 리뉴얼 디자인', '작업', null, status('할 일', 'new'), { parent: 'IO-140' }),
    issue('IO-146', '[QA] 결제 리뉴얼 QA 계획', '작업', 'fx-tester-d', status('완료', 'done'), { parent: 'IO-140' }),
    // 같은 이름 둘을 가르는 "최근 맡은 티켓"
    issue('IO-160', '결제 리뉴얼 iOS 검수', '작업', 'fx-tester-b1', status('진행 중', 'indeterminate')),
    issue('IO-161', '알림센터 서버', '작업', 'fx-tester-b2', status('진행 중', 'indeterminate')),
  ];
  const byKey = key => issues.find(entry => entry.key === key) || null;
  let nextKey = 200;
  const createTypes = { issueTypes: [
    { id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 },
    { id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 },
  ] };
  // 지라가 실제로 주는 것처럼 사람 덩어리에 이메일·아바타까지 싣는다 — 서버가 버리는지 화면에서 보려는 것.
  const person = (id) => {
    const user = userOf(id);
    return user ? { ...user, emailAddress: `${user.accountId}@fixture.invalid`, avatarUrls: { '48x48': 'https://avatar.fixture.invalid/x.png' }, timeZone: 'Asia/Seoul' } : null;
  };
  const fieldsOf = entry => ({
    summary: entry.summary,
    status: entry.state,
    issuetype: { name: entry.type, id: entry.type === '에픽' ? '10000' : '10001' },
    assignee: person(entry.who),
    duedate: entry.due || null,
    fixVersions: entry.versions || [],
    subtasks: [],
  });
  const shaped = entry => ({ key: entry.key, fields: { ...fieldsOf(entry), parent: entry.parent ? { key: entry.parent } : null } });
  const notDone = entry => entry.state.statusCategory.key !== 'done';

  function search(jql) {
    // 결과 모름 뒤 찾기(jira-client findMade) — 프로젝트·종류·보고자=나·(부모). 시각 조건은 이 픽스처에서 보지 않는다.
    const made = jql.match(/^project = ([A-Z][A-Z0-9]*) AND issuetype = (\d+) AND reporter = currentUser\(\) AND created >= -\d+m(?: AND parent = ([A-Z][A-Z0-9]*-\d+))? ORDER BY created DESC$/);
    if (made) {
      return issues.filter(entry => entry.reporter === ME && entry.key.startsWith(`${made[1]}-`)
        && (entry.type === '에픽' ? '10000' : '10001') === made[2] && (!made[3] || entry.parent === made[3]));
    }
    const parent = jql.match(/^parent=([A-Z][A-Z0-9]*-\d+)$/);
    if (parent) return issues.filter(entry => entry.parent === parent[1]);
    const keys = jql.match(/^key in \(([^)]*)\)$/);
    if (keys) return keys[1].split(',').map(key => byKey(key.trim())).filter(Boolean);
    if (jql.startsWith('assignee = currentUser() AND statusCategory != Done')) {
      return issues.filter(entry => entry.who === ME && notDone(entry)).sort((a, b) => b.updated - a.updated);
    }
    const someone = jql.match(/^assignee = "([^"]+)" ORDER BY updated DESC$/);
    if (someone) return issues.filter(entry => entry.who === someone[1]).sort((a, b) => b.updated - a.updated);
    return [];   // 반응 필요·완료 목록 등은 비어 있다
  }

  async function request(input, options = {}) {
    const url = new URL(String(input));
    if (url.origin !== FIXTURE_JIRA_SITE) throw new Error('가짜 지라 밖의 주소예요');
    const method = options.method || 'GET';
    const path = url.pathname;
    const sent = options.body ? JSON.parse(options.body) : null;
    if (path === '/rest/api/3/myself') return reply({ ...person(ME) });
    if (path === '/rest/api/3/search/jql' || path === '/rest/api/3/search') {
      const jql = method === 'POST' ? String(sent && sent.jql || '') : String(url.searchParams.get('jql') || '');
      if (jql.startsWith('project = ') && search(jql).some(entry => entry.summary.includes('[찾기실패]'))) return reply({ errorMessages: ['busy'] }, 503);
      const max = Number((method === 'POST' ? sent && sent.maxResults : url.searchParams.get('maxResults')) || 50);
      return reply({ issues: search(jql).slice(0, max).map(shaped) });
    }
    if (path === '/rest/api/3/user/assignable/search') {
      if (!byKey(url.searchParams.get('issueKey') || '')) return reply({ errorMessages: ['no issue'] }, 404);
      const query = String(url.searchParams.get('query') || '').toLocaleLowerCase();
      return reply(users.filter(user => user.displayName.toLocaleLowerCase().includes(query)).map(user => person(user.accountId)));
    }
    const assign = path.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)\/assignee$/);
    if (assign && method === 'PUT') {
      const entry = byKey(assign[1]);
      if (!entry) return reply({ errorMessages: ['no issue'] }, 404);
      const id = sent ? sent.accountId : undefined;
      if (id !== null && !(userOf(id) && userOf(id).active)) return reply({ errorMessages: ['cannot assign'] }, 400);
      entry.who = id;
      entry.updated = (updated += 1);
      return reply(null, 204);
    }
    if (path === '/rest/api/3/issue/createmeta/IO/issuetypes') return reply(createTypes);
    if (path === '/rest/api/3/issue' && method === 'POST') {
      const fields = (sent && sent.fields) || {};
      const summary = String(fields.summary || '');
      if (summary.includes('[거절]')) return reply({ errorMessages: ['refused'] }, 400);
      if (summary.includes('[5xx]')) return reply({ errorMessages: ['unavailable'] }, 503);
      nextKey += 1;
      const key = `${fields.project.key}-${nextKey}`;
      const epic = fields.issuetype && fields.issuetype.id === '10000';
      issues.push(issue(key, summary, epic ? '에픽' : '작업', null, status('할 일', 'new'), { parent: fields.parent ? fields.parent.key : undefined, reporter: ME }));
      // 지라에는 만들어졌는데 응답만 끊긴 경우 — 서버는 이것을 결과 모름으로 받아야 한다.
      if (summary.includes('[끊김]')) throw new Error('fixture: socket hang up');
      return reply({ id: String(nextKey), key }, 201);
    }
    const transitions = path.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)\/transitions$/);
    if (transitions) return reply({ transitions: [] });
    const one = path.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)$/);
    if (one && method === 'GET') {
      const entry = byKey(one[1]);
      return entry ? reply(shaped(entry)) : reply({ errorMessages: ['no issue'] }, 404);
    }
    if (/^\/rest\/api\/3\/project\/[A-Z][A-Z0-9]*\/versions$/.test(path)) return reply([]);
    return reply({ errorMessages: ['가짜 지라에 없는 길'] }, 404);
  }

  return { request, issues, users };
}

module.exports = { createJiraFixture, FIXTURE_JIRA_SITE };
