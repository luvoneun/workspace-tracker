// 프로젝트 열쇠 짓기 고정 시험 — 업무 한 줄(item)에서 프로젝트 열쇠(`jira:KEY`·`group:이름`)를 짓는 곳이
// 화면(workflows.js wfKey)·주간요약(report-drafts.js bucket 앞머리)·서버(오늘 회의의 관련 할 일 수)에 있다.
// 세 곳이 지금 내는 값을 표 하나로 못 박는다 — 열쇠 짓기를 공용 함수로 모은 뒤에도 같은 표가 초록이어야 한다.
// 명세: docs/정리/2026-10-08-프로젝트-고정-번호.md (C3)
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const support = require('./test-support');
const reportDrafts = require('./report-drafts');

let base;
before(async () => { base = await support.ready(); });

// 업무 한 줄 → 열쇠. 지라가 있으면 지라가 이기고, 그다음 group, 그다음 project(아이디어), 없으면 null.
// 이름은 손대지 않는다(밑줄·빈칸·대소문자 그대로 — 같은 이름 비교는 groupNameKey의 일이다).
const CASES = [
  [{ jira: 'PAY-12', group: '결제 리뉴얼' }, 'jira:PAY-12'],
  [{ jira: 'PAY-12', project: '결제 리뉴얼' }, 'jira:PAY-12'],
  [{ group: '결제 리뉴얼' }, 'group:결제 리뉴얼'],
  [{ project: '정산_리포트' }, 'group:정산_리포트'],
  [{ group: '가입 개편', project: '다른 이름' }, 'group:가입 개편'],
  [{ group: 'Mixed  Case_이름' }, 'group:Mixed  Case_이름'],
  [{ jira: '', group: '가입 개편' }, 'group:가입 개편'],
  [{ jira: null, group: null, project: null }, null],
  [{ group: '', project: '' }, null],
  [{}, null],
];

test('화면 wfKey: 표의 모든 줄에서 같은 열쇠를 짓는다', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'workflows.js'), 'utf8'), context);
  for (const [item, key] of CASES) {
    context.__item = item;
    assert.equal(vm.runInContext('wfKey(__item)', context), key, JSON.stringify(item));
  }
});

test('주간요약: 문장 행의 bucket 앞머리가 같은 열쇠다(없으면 ungrouped)', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const items = CASES.map(([item], index) => ({
    id: `k${index}`, type: 'task', description: `열쇠 시험 ${index}번`, status: 'done', created: '2026-09-14', completed: '2026-09-15', ...item,
  }));
  const store = reportDrafts({ directory, sources: () => items, legacy: () => [], currentWeek: () => '2026-09-14' });
  const rows = store.view('2026-09-14').rows;
  CASES.forEach(([item, key], index) => {
    const row = rows.find(entry => entry.sourceIds.includes(`k${index}`));
    assert.ok(row, `k${index} 행이 있다`);
    assert.ok(row.bucket.startsWith(`${key === null ? 'ungrouped' : key}:`), `${JSON.stringify(item)} → ${row.bucket}`);
  });
});

test('서버: 오늘 회의의 관련 할 일 수가 같은 열쇠로 센다', async () => {
  const { directory, today, items } = support;
  fs.writeFileSync(support.tasksPath, '# Tasks\n'
    + '- 정산 배치 #task[id:pk1 status:to-do priority:medium created:2026-09-20 group:결제_리뉴얼]\n'
    + '- 지라에 걸린 일 #task[id:pk2 status:to-do priority:medium created:2026-09-20 jira:PAY-12 group:결제_리뉴얼]\n'
    + '- 지라 일 #task[id:pk3 status:to-do priority:medium created:2026-09-20 jira:PAY-12]\n'
    + '- 끝낸 일 #task[id:pk4 status:done priority:medium created:2026-09-20 completed:2026-09-21 group:결제_리뉴얼]\n'
    + '- 그룹 없는 일 #task[id:pk5 status:to-do priority:medium created:2026-09-20]\n');
  fs.writeFileSync(path.join(directory, 'ideas.md'), '# Ideas\n'
    + '- 정산 아이디어 #idea[id:pk6 status:to-do priority:low created:2026-09-20 project:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | 결제 회의\n- 14:00-15:00 | 지라 회의\n- 16:00-17:00 | 없는 회의\n`);
  fs.writeFileSync(path.join(directory, '.meeting_links.json'), JSON.stringify({
    '결제 회의': 'group:결제 리뉴얼', '지라 회의': 'jira:PAY-12', '없는 회의': 'group:가입 개편',
  }));
  try {
    const events = (await items()).calendar.events;
    const count = title => events.find(event => event.title === title).relatedCount;
    assert.equal(count('결제 회의'), 1, '지라가 걸린 줄은 그룹 프로젝트가 아니다 · 끝낸 일·아이디어는 세지 않는다');
    assert.equal(count('지라 회의'), 2);
    assert.equal(count('없는 회의'), 0);
  } finally {
    for (const name of ['ideas.md', 'calendar_today.md', '.meeting_links.json']) fs.rmSync(path.join(directory, name), { force: true });
  }
});
