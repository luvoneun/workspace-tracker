// 프로젝트 열쇠 빠뜨림 시험 — 직접 만든 프로젝트의 이름(열쇠)이 글자로 박힌 모든 자리에 `결제 리뉴얼`을 심고,
// 이름 바꾸기·지라 에픽으로 옮기기·합치기·지우기와 각 되돌리기를 한 번씩 한 뒤 데이터 폴더 **전체**를 글자로 훑는다.
// 옛 열쇠가 한 번이라도 남으면(의도된 예외만 빼고) 빨개진다 — 어느 동작이 새 자리를 빠뜨렸다는 뜻이다.
// 되돌리면 모든 파일의 글자 수가 심은 때와 같아야 한다. 명세: docs/정리/2026-10-08-프로젝트-고정-번호.md
// 실제 지라에는 닿지 않는다 — 옮기기만 지라에 에픽인지 묻고, 그 fetch는 자식 프로세스 안의 가짜 응답이 가로챈다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { freePort, serverReady } = require('./test-support');
const { SITES, KEPT, MODES } = require('./project-keys');

const A = '결제 리뉴얼';
const B = '가입 개편';
const EPIC = 'IO-48501';
const SITE = 'https://rekey-jira.test';
const token = name => name.replace(/\s+/g, '_');

// 자리마다 A를 심는다(명세 1-2절 ①~⑥, ⑧). ⑦ 되돌리기 기록은 동작이 만든다. ⑨ localStorage는 브라우저라 폴더에 없다.
// 비교용으로 B(합칠 대상)도 같은 자리에 하나씩 둔다.
function seed(home) {
  // ① 업무 파일 넷 — 끝낸 일 포함. rk03은 지라가 걸린 줄이라 group 칸이 프로젝트가 아니다(예외).
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
    + `- 정산 배치 만들기 #task[id:rk01 status:to-do priority:high created:2026-09-20 group:${token(A)}]\n`
    + `- 정산 설계 #task[id:rk02 status:done priority:medium created:2026-09-01 completed:2026-09-08 group:${token(A)}]\n`
    + `- 지라에 걸린 일 #task[id:rk03 status:to-do priority:medium created:2026-09-20 jira:PAY-12 group:${token(A)}]\n`
    + `- 가입 화면 개편 #task[id:rk04 status:to-do priority:medium created:2026-09-20 group:${token(B)}]\n`);
  fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n'
    + `- 법무 회신 #check[id:rk05 status:to-do priority:medium created:2026-09-20 who:하늘 group:${token(A)}]\n`);
  fs.writeFileSync(path.join(home, 'decisions.md'), '# Decisions\n'
    + `- 주 단위로 정산 #decision[id:rk06 status:to-do priority:medium created:2026-09-20 group:${token(A)}]\n`);
  fs.writeFileSync(path.join(home, 'ideas.md'), '# Ideas\n'
    + `- 정산 리포트 자동화 #idea[id:rk07 status:to-do priority:low created:2026-09-20 project:${token(A)}]\n`);
  // ② 회의 프로젝트 · ③ projectLinks · ④ projectArchive
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
    items: {}, meetings: {
      m1: { id: 'm1', date: '2026-09-20', start: '10:00', end: '11:00', title: '정산 주간 싱크', series: '정산 주간 싱크', link: null,
        project: { type: 'group', value: A, label: A } },
      m2: { id: 'm2', date: '2026-09-19', start: '14:00', end: '15:00', title: '가입 회의', series: '가입 회의', link: null,
        project: { type: 'group', value: B, label: B } },
    },
    projectLinks: { [A]: 'PAY-1' },
    projectArchive: { [`group:${A}`]: '2026-09-19' },
  }, null, 2));
  // ⑤ 회의 제목 → 프로젝트
  fs.writeFileSync(path.join(home, '.meeting_links.json'), JSON.stringify({ '정산 주간 싱크': `group:${A}`, '가입 회의': `group:${B}` }, null, 2));
  // ⑥ 주간요약 — 소제목(group)·bucket·근거 이름표·묶기 전 문장(parts)·사람이 고친 소제목 이름(group:·name: 열쇠 둘 다)
  const evidence = (id, label) => [{ id, description: '근거', status: 'done', type: 'task', outcome: '', label, permalink: null }];
  fs.writeFileSync(path.join(home, '.report-drafts.json'), JSON.stringify({
    schema: 1,
    weeks: {
      '2026-09-07': { rows: [
        { id: 'w1', heading: '완료한 일', group: A, bucket: `group:${A}:완료한 일:정산 설계`, text: '정산 설계 마침', sourceIds: ['rk02'],
          evidence: evidence('rk02', A), locked: true, excluded: false },
      ], updatedAt: '2026-09-12T00:00:00.000Z' },
      '2026-09-14': { rows: [
        { id: 'r1', heading: '진행중', group: A, bucket: `group:${A}:진행중:정산 배치`, text: '정산 배치와 회신', sourceIds: ['rk01', 'rk05'],
          evidence: [...evidence('rk01', A), ...evidence('rk05', A)], locked: true, excluded: false,
          parts: [
            { id: 'p1', heading: '진행중', group: A, bucket: `group:${A}:진행중:정산 배치`, text: '정산 배치', sourceIds: ['rk01'], evidence: evidence('rk01', A), locked: true, excluded: false },
            { id: 'p2', heading: '진행중', group: A, bucket: `group:${A}:진행중:법무`, text: '법무 회신', sourceIds: ['rk05'], evidence: evidence('rk05', A), locked: true, excluded: false },
          ] },
        { id: 'r2', heading: '진행중', group: B, bucket: `group:${B}:진행중:가입 화면`, text: '가입 화면 개편', sourceIds: ['rk04'],
          evidence: evidence('rk04', B), locked: true, excluded: false },
      ], updatedAt: '2026-09-20T00:00:00.000Z' },
    },
    weekPolish: {
      '2026-09-07': { lockedAt: '2026-09-12T00:00:00.000Z', names: { [`완료한 일|group:${A}`]: '정산 마무리' } },
      '2026-09-14': { names: { [`진행중|name:${A}`]: '정산 진행' } },
    },
  }, null, 2));
  // ⑧ 휴지통 원문 줄 — 이름 바꾸기 때 고쳐 쓰지 않는 알려진 한계(10-06 명세 예외 13).
  fs.writeFileSync(path.join(home, '.trash.json'), JSON.stringify([
    { id: 'rk99', file: 'tasks.md', deletedAt: '2026-09-21T00:00:00.000Z', line: `- 지운 일 #task[id:rk99 status:to-do priority:low created:2026-09-20 group:${token(A)}]` },
  ], null, 2));
}

// 데이터 폴더 전체를 파일마다 글자로 읽는다. 의도된 예외는 자리 표의 KEPT(project-keys.js)에 적힌 것만 지운다 —
// 예외를 늘리려면 KEPT에 이유와 함께 한 줄을 더한다(여기에 따로 적지 않는다).
//   ⑦ `.workflow.json`의 projectMoves·projectMerges · ⑧ `.trash.json`·`.backups/`
//   모드별: 옮기기·지우기의 ④ `projectArchive`, 지우기의 ⑥ `.report-drafts.json`
//   그 밖에 지라가 걸린 줄(rk03)의 group 칸 — 지라 프로젝트라 그룹 이름이 아니다(① 규칙 "지라가 걸린 줄은 건너뜀")
const kept = (id, mode) => KEPT.some(entry => entry.id === id && (!entry.modes || entry.modes.includes(mode)));
function readData(home, mode) {
  const keepReport = mode && kept('⑥', mode);
  const keepArchive = mode && kept('④', mode);
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) { walk(file); continue; }
      const rel = path.relative(home, file);
      if (kept('⑧') && (rel === '.trash.json' || rel.startsWith(`.backups${path.sep}`))) continue;
      if (keepReport && rel === '.report-drafts.json') continue;
      let text = fs.readFileSync(file, 'utf8');
      if (rel === '.workflow.json' && kept('⑦')) {
        const state = JSON.parse(text);
        delete state.projectMoves;
        delete state.projectMerges;
        if (keepArchive) delete state.projectArchive;
        text = JSON.stringify(state);
      }
      if (rel.endsWith('.md')) text = text.split('\n').filter(line => !line.includes('id:rk03 ')).join('\n');
      out[rel] = text;
    }
  };
  walk(home);
  return out;
}
const count = (text, word) => text.split(word).length - 1;
// 파일마다 [A, B, 에픽 키]가 몇 번 나오나 — 공백 꼴(JSON)과 밑줄 꼴(업무 줄)을 함께 센다.
function counts(home) {
  return Object.fromEntries(Object.entries(readData(home)).map(([file, text]) => [file, {
    a: count(text, A) + count(text, token(A)),
    b: count(text, B) + count(text, token(B)),
    epic: count(text, EPIC),
  }]).filter(([, value]) => value.a || value.b || value.epic));
}
function assertNoOld(home, word, mode) {
  const left = Object.entries(readData(home, mode))
    .map(([file, text]) => [file, count(text, word) + count(text, token(word))])
    .filter(([, n]) => n > 0);
  assert.deepEqual(left, [], `옛 열쇠 「${word}」가 남은 파일: ${JSON.stringify(left)}`);
}

// 서버를 자기 임시 폴더로 띄운다. 설정·토큰·가짜 지라 파일은 데이터 폴더 **밖**에 둔다(훑기에 섞이지 않게).
async function start(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-rekey-'));
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-rekey-side-'));
  seed(home);
  const tokenFile = path.join(side, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(side, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: SITE, email: 'fixture@example.test', tokenFile } }));
  const wrapper = path.join(side, 'fake-jira-rekey-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(SITE)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/issue/createmeta/')) return json({ issueTypes: [{ id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 }] });
  if (url.includes('/rest/api/3/issue/${EPIC}')) return json({ fields: { summary: '정산 에픽', issuetype: { id: '10000' } } });
  return json({ issues: [] });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(side, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  await serverReady(child, origin, () => log);
  const post = (route, body) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async response => ({ status: response.status, ...await response.json() }));
  return { home, post };
}

// 심은 그대로인지 먼저 본다 — 자리 표의 모든 파일에 A가 실제로 있어야 시험이 뜻이 있고, A가 든 파일은 모두 자리 표에 있어야 한다
// (표에 없는 자리에 이름을 심으면 — 곧 새 자리를 만들고 표에 안 올리면 — 여기서 빨개진다).
function assertSeeded(home) {
  const seeded = counts(home);
  const files = SITES.flatMap(site => site.files);
  for (const file of files) assert.ok(seeded[file] && seeded[file].a > 0, `${file}에 ${A}를 심어야 한다`);
  assert.deepEqual(Object.keys(seeded).filter(file => seeded[file].a > 0).sort(), [...files].sort(), '이름이 든 파일 = 자리 표의 파일');
  return seeded;
}
test('자리 표: 모든 자리가 네 동작마다 무엇을 하는지(또는 KEPT에 왜 안 하는지) 적혀 있다', () => {
  for (const site of SITES) {
    for (const mode of MODES) {
      assert.ok(site.modes[mode] || kept(site.id, mode), `${site.id} ${mode}: 표에 할 일도, KEPT의 이유도 없다`);
    }
    assert.ok(site.undo && site.files.length, site.id);
  }
  for (const entry of KEPT) assert.ok(entry.why, entry.id);
});
// 업무 줄을 고친 동작은 그 줄의 수정 시각(updated)을 새로 적고 응답 revisions에 싣는다(저장 충돌 검사).
const MOVED_ITEMS = ['rk01', 'rk02', 'rk05', 'rk06', 'rk07'];
function assertStamped(home, answer) {
  assert.deepEqual(Object.keys(answer.revisions || {}).sort(), MOVED_ITEMS, '고친 업무 줄마다 revisions가 실린다');
  const lines = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md'].flatMap(name => fs.readFileSync(path.join(home, name), 'utf8').split('\n'));
  for (const id of MOVED_ITEMS) {
    const line = lines.find(entry => entry.includes(`id:${id} `));
    assert.ok(line.includes(` updated:${answer.revisions[id]}`), `${id} 줄에 응답과 같은 updated가 적힌다`);
  }
  assert.ok(!lines.find(entry => entry.includes('id:rk03 ')).includes('updated:'), '지라가 걸린 줄은 손대지 않는다');
}

test('열쇠 빠뜨림: 이름 바꾸기 뒤 옛 이름이 0번, 반대로 한 번 더 바꾸면 모든 파일이 심은 때와 같다', async (t) => {
  const { home, post } = await start(t);
  const seeded = assertSeeded(home);
  const answer = await post('/api/project/rename', { project: `group:${A}`, name: '결제 정산' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assertNoOld(home, A, 'rename');
  assertStamped(home, answer);
  const back = await post('/api/project/rename', { project: 'group:결제 정산', name: A });
  assert.equal(back.ok, true, JSON.stringify(back));
  assertNoOld(home, '결제 정산', 'rename');
  assert.deepEqual(counts(home), seeded);
});

test('열쇠 빠뜨림: 지라 에픽으로 옮기기 뒤 옛 이름이 0번, 되돌리면 모든 파일이 심은 때와 같고 에픽 키도 남지 않는다', async (t) => {
  const { home, post } = await start(t);
  const seeded = assertSeeded(home);
  const answer = await post('/api/project/move', { project: `group:${A}`, to: EPIC });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assertNoOld(home, A, 'move');
  assertStamped(home, answer);
  // 되돌리기 기록 꼴은 그대로다(옛 앱·옛 기록과 같은 칸) — 칸을 바꾸면 옛 기록 되돌리기를 따로 따져야 한다.
  const [move] = JSON.parse(fs.readFileSync(path.join(home, '.workflow.json'), 'utf8')).projectMoves;
  assert.deepEqual(Object.keys(move), ['id', 'from', 'to', 'at', 'items', 'meetings', 'links', 'meetingLinks', 'reportRows', 'reportNames', 'reportLabel', 'counts']);
  assert.deepEqual([move.items, move.meetings, move.links, move.meetingLinks, move.reportRows, move.reportLabel, move.counts],
    [['rk05', 'rk06', 'rk07', 'rk01', 'rk02'], ['m1'], { [A]: 'PAY-1' }, ['정산 주간 싱크'], ['w1', 'r1'], `${EPIC} · 정산 에픽`, { items: 5, meetings: 2, report: 2 }]);
  const back = await post('/api/project/move-undo', { moveId: answer.moveId });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.skipped, 0);
  assert.deepEqual(counts(home), seeded);
});

test('열쇠 빠뜨림: 합치기 뒤 옛 이름이 0번, 되돌리면 모든 파일이 심은 때와 같다', async (t) => {
  const { home, post } = await start(t);
  const seeded = assertSeeded(home);
  const answer = await post('/api/project/merge', { project: `group:${A}`, to: `group:${B}` });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assertNoOld(home, A, 'merge');
  assertStamped(home, answer);
  const [merge] = JSON.parse(fs.readFileSync(path.join(home, '.workflow.json'), 'utf8')).projectMerges;
  assert.deepEqual(Object.keys(merge), ['id', 'from', 'to', 'at', 'items', 'meetings', 'link', 'archive', 'meetingLinks', 'reportRows', 'reportNames', 'counts']);
  assert.deepEqual([merge.items, merge.meetingLinks, merge.counts], [
    [['rk05', 'group'], ['rk06', 'group'], ['rk07', 'project'], ['rk01', 'group'], ['rk02', 'group']].map(([id, key]) => ({ id, key })),
    [{ title: '정산 주간 싱크', before: `group:${A}` }], { items: 5, meetings: 2, report: 2 }]);
  const back = await post('/api/project/merge-undo', { mergeId: answer.mergeId });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.skipped, 0);
  assert.deepEqual(counts(home), seeded);
});

test('열쇠 빠뜨림: 지우기 뒤 옛 이름이 0번(주간요약만 예외), 되돌리면 모든 파일이 심은 때와 같다', async (t) => {
  const { home, post } = await start(t);
  const seeded = assertSeeded(home);
  const report = fs.readFileSync(path.join(home, '.report-drafts.json'), 'utf8');
  const answer = await post('/api/project/merge', { project: `group:${A}`, to: null });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assertNoOld(home, A, 'delete');
  assert.equal(fs.readFileSync(path.join(home, '.report-drafts.json'), 'utf8'), report, '지우기는 주간요약을 바이트 그대로 둔다');
  assertStamped(home, answer);
  const back = await post('/api/project/merge-undo', { mergeId: answer.mergeId });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.skipped, 0);
  assert.deepEqual(counts(home), seeded);
});
