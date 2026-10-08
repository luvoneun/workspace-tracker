// 지라 REST API를 앱 서버가 직접 읽는 얇은 모듈(AI를 거치지 않는다).
// Node 기본 `fetch`만 쓰고, 부르는 쪽이 `request`(fetch)와 `readToken`을 끼워 넣을 수 있다 —
// 테스트와 화면 확인은 가짜 fetch만 쓰고 실제 지라에는 절대 닿지 않는다.
//
// 지키는 것(테스트로 고정):
// - 토큰은 부를 때마다 파일에서 읽고 오래 들고 있지 않는다. 토큰·이메일은 오류 문구·돌려주는 값 어디에도 싣지 않는다.
// - siteUrl은 `https://`만, 키는 `^[A-Z][A-Z0-9]*-\d+$`만 받는다. 요청은 8초에서 끊는다.
// - 이 모듈은 아무것도 기록하지 않는다(로그도, 파일 쓰기도 없다).
const nodeFs = require('node:fs');
const nodeCrypto = require('node:crypto');
const os = require('node:os');

const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const JIRA_PROJECT_RE = /^[A-Z][A-Z0-9]*$/;
// 지라가 주는 id는 숫자 문자열이다. 주소에 그대로 끼우므로 숫자만 받는다.
const JIRA_ID_RE = /^[0-9]{1,20}$/;
const JIRA_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const JIRA_TIMEOUT_MS = 8000;
const JIRA_CACHE_MS = 60 * 1000;
const JIRA_CHILD_LIMIT = 100;
// 띠 카드가 쓰는 값만 받아 온다 — 본문·댓글까지 끌고 오지 않는다.
const ISSUE_FIELDS = 'summary,status,issuetype,assignee,duedate,fixVersions,subtasks';
// 하위 티켓 줄이 쓰는 값만 받아 온다. 담당자는 **표시 이름만** 꺼내 쓴다 —
// 지라가 주는 사용자 덩어리에서 이메일·계정 id는 어디에도 옮기지 않는다(테스트로 고정).
const CHILD_FIELDS = 'summary,status,assignee,fixVersions,issuetype';
// 내 담당 목록(프로젝트 고르기·요약의 원천)이 받아 오는 칸. **담당자는 아예 요청하지 않는다** —
// 내 것만 읽는 목록이라 필요가 없고, 요청하지 않으면 이메일·계정 id가 응답에 실릴 일도 없다.
const LIST_FIELDS = 'summary,status,issuetype,fixVersions,duedate';
const JIRA_LIST_LIMIT = 100;
// 기본 조회: 내가 담당이고 아직 끝나지 않은 것. 최근에 손댄 순서다.
const MY_ISSUES_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
// 완료한 내 티켓(연결 입력칸의 `완료한 티켓도 보기`)이 받아 오는 칸 — 고르는 줄 한 개(`요약 · 키`)에
// 필요한 것뿐이다. 여기도 담당자는 아예 요청하지 않는다(내 것만 읽는 목록이라 필요가 없다).
const DONE_FIELDS = 'summary,status,issuetype';
// 최근에 끝난 내 티켓. 기간은 부르는 쪽이 정한다(화면은 90일).
const JIRA_DONE_DAYS = 90;
const JIRA_DONE_MAX_DAYS = 365;
const doneIssuesJql = days => `assignee = currentUser() AND statusCategory = Done AND resolved >= -${days}d ORDER BY resolved DESC`;
const doneDaysOf = days => (Number.isInteger(days) && days >= 1 && days <= JIRA_DONE_MAX_DAYS ? days : JIRA_DONE_DAYS);
const CHANGE_KINDS = ['status', 'version', 'due', 'versionEdit', 'assignee', 'assigneeUndo'];
// 담당자 바꾸기(BJASSIGN2) — 사람 찾기·맡기기·되돌리기. accountId는 지라 내부 식별자라
// 찾기 응답·맡기기 요청 본문·지라로 보내는 본문(body)에만 지나가고, 주소(querystring)·오류 문구·기록에는 싣지 않는다.
// 첫 글자는 영문·숫자 — 자동 배정 값(`-1`)은 받지 않는다.
const JIRA_ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ASSIGNABLE_ASK = 20;       // 지라에 묻는 인원
const ASSIGNABLE_SHOWN = 10;     // 고르개에 내놓는 인원
const ASSIGNABLE_CHECK = 50;     // 쓰기 직전 "맡을 수 있나" 대조에 묻는 인원
const ASSIGNABLE_QUERY_MAX = 50; // 찾는 글자 상한
const ASSIGN_NAME_MAX = 255;
const SAME_NAME_LOOKUPS = 3;     // 같은 이름 구분에 지라를 더 부르는 최대 인원
const ASSIGN_UNDO_MS = 10 * 60 * 1000;
const ASSIGN_REPEAT_MS = 3000;
// 반응 필요(BATTENTION 1차)가 읽는 것 — 내가 담당·보고·지켜보는 이슈 중 최근 14일 안에 갱신된 것.
// 받아 오는 칸은 셋뿐이고(요약·상태·댓글) 담당자는 아예 묻지 않는다.
const ATTENTION_JQL = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -14d ORDER BY updated DESC';
const ATTENTION_FIELDS = 'summary,status,comment';
const ATTENTION_LIMIT = 50;        // 한 번에 보는 이슈 수
const ATTENTION_COMMENT_LIMIT = 20; // 댓글 칸이 잘려 왔을 때 그 이슈만 다시 읽는 개수
const ATTENTION_PREVIEW_MAX = 140;  // 미리보기 글자 수
// 새로 만들기(BJCREATE)가 쓰는 상한 — 한 번에 만드는 이슈는 에픽 하나 + 하위 12개까지다.
const JIRA_CREATE_MAX = 12;
const JIRA_SUMMARY_MAX = 255;
// 만들 수 있는 이슈 종류 목록(createmeta)에서 읽어 오는 개수. 한 프로젝트의 종류는 이보다 훨씬 적다.
const JIRA_TYPE_LIMIT = 100;
// 만들기가 "결과 모름"(시간 초과·끊김·5xx·응답 해석 실패)으로 끝난 이슈를 기억하는 시간(메모리만, 재시작하면 사라진다).
// 그 안에 같은 이슈를 다시 만들라고 하면 지라에서 먼저 찾는다 — 응답만 끊긴 경우 두 벌이 생기지 않게.
const UNSURE_KEEP_MS = 24 * 60 * 60 * 1000;
// 지라 검색은 방금 만든 이슈를 몇 초 늦게 잡는다 — 모름이 난 뒤 이 시간 전에는 찾지도 만들지도 않는다.
const UNSURE_SETTLE_MS = 30 * 1000;
// 찾을 때 "모름이 난 시각"보다 이만큼 앞까지 본다(맥과 지라의 시계가 다를 수 있다).
const UNSURE_LOOKBACK_MIN = 10;
// 한 번에 읽어 요약을 대조하는 개수. 이보다 많이 오면 가를 수 없다고 보고 모름을 유지한다.
const UNSURE_LOOKUP_LIMIT = 50;
// 찾기가 0개면 같은 요청 안에서 이만큼 쉬고 한 번 더 찾는다 — 그래도 0개일 때만 새로 만든다(검색 지연 대비).
const UNSURE_RECHECK_MS = 3000;

// 지라가 주는 범주 열쇠는 셋뿐이다. 모르는 값은 `진행`으로 본다(상태 이름은 그대로 보여 준다).
const CATEGORY = { new: 'todo', indeterminate: 'doing', done: 'done' };

// 화면에 그대로 나가는 문구다(해요체). 지라가 준 원문·주소·토큰은 절대 섞지 않는다.
const MESSAGE = {
  key: '지라 번호를 확인해 주세요.',
  auth: '지라 토큰을 확인해 주세요.',
  notfound: '지라에서 이 티켓을 찾지 못했어요.',
  network: '지라에 연결하지 못했어요.',
  other: '지라에 연결하지 못했어요.',
  // 아래는 "바꾸기"(쓰기)에서만 쓰는 문구다 — 읽기 실패와 말이 섞이지 않게 따로 둔다.
  off: '지라 연결이 필요해요.',
  value: '보낸 값을 확인해 주세요.',
  forbidden: '지라에서 이 티켓을 바꿀 권한이 없어요.',
  reject: '지라가 이 변경을 받아들이지 않았어요. 지라에서 직접 확인해 주세요.',
  write: '지라에 반영하지 못했어요.',
  stale: '지라에서 고를 수 있는 값이 바뀌었어요. 카드를 새로 읽고 다시 골라 주세요.',
  screen: '이 전환은 지라에서 직접 해 주세요.',
  multi: '버전이 여러 개라 지라에서 직접 바꿔 주세요.',
  // 아래는 "새로 만들기"(BJCREATE)에서만 쓰는 문구다 — 바꾸기와 말이 섞이지 않게 따로 둔다.
  make: '지라에 만들지 못했어요.',
  makeReject: '지라가 이 값을 받아들이지 않았어요 — 필수 항목이 더 있을 수 있어요. 지라에서 직접 확인해 주세요.',
  makeForbidden: '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.',
  epicType: '이 지라 프로젝트에서는 에픽을 만들 수 없어요.',
  notEpic: '고른 티켓이 에픽이 아니에요.',
  typeStale: '지라에서 만들 수 있는 종류가 바뀌었어요. 화면을 새로 읽고 다시 골라 주세요.',
  tooMany: '한 번에 12개까지 만들 수 있어요.',
  duplicate: '같은 내용을 방금 보냈어요. 잠시 뒤에 다시 시도해 주세요.',
  makeUnsure: '지라에 만들어졌는지 확인하지 못했어요. 지라에서 확인한 뒤 다시 시도해 주세요.',
  makeSettling: '지라가 확인하는 중이에요. 잠시 뒤에 다시 시도해 주세요.',
  // 아래는 "담당자 바꾸기"에서만 쓰는 문구다. 이름이 들어가는 문구는 assignMessage가 짓는다.
  assignForbidden: '지라에서 이 티켓의 담당을 바꿀 권한이 없어요.',
  assignUnsure: '지라에 반영됐는지 확인하지 못했어요 — 카드를 새로 읽었어요.',
  undoGone: '되돌릴 수 있는 시간이 지났어요.',
  undoStale: '그 사이 지라에서 다시 바뀌어 되돌리지 않았어요.',
  assignValue: '보낸 값을 확인해 주세요.',
  assignBusy: '이 티켓의 담당을 바꾸는 중이에요. 잠시 뒤에 다시 시도해 주세요.',
};

// 이름 뒤 조사 — 받침이 있으면 앞의 것. 한글이 아니면 받침 없음으로 본다. `로`는 ㄹ 받침도 받침 없음과 같다.
function josa(name, withFinal, without) {
  const word = String(name || '');
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const final = code >= 0 && code <= 11171 ? code % 28 : 0;
  const has = withFinal === '으로' ? final !== 0 && final !== 8 : final !== 0;
  return word + (has ? withFinal : without);
}
// 이름이 들어가는 담당자 문구. 이름은 지라의 표시 이름(화면에 이미 보이는 값)뿐이다.
function assignMessage(kind, name) {
  const who = name || '없음';
  if (kind === 'assigneeStale') return `그 사이 지라에서 담당이 ${josa(who, '으로', '로')} 바뀌었어요. 확인하고 다시 골라 주세요.`;
  if (kind === 'notAssignable') return `${josa(name || '이 사람', '은', '는')} 이 티켓을 맡을 수 없어요(지라 권한). 다른 사람을 골라 주세요.`;
  if (kind === 'undoFail') return `되돌리지 못했어요 — 담당은 ${who} 그대로예요.`;
  return MESSAGE[kind] || MESSAGE.write;
}

function jiraError(kind, status) {
  const error = new Error(MESSAGE[kind] || MESSAGE.other);
  error.kind = MESSAGE[kind] ? kind : 'other';
  if (status) error.status = status;
  return error;
}

const expandHome = value => String(value || '').replace(/^~(?=\/|$)/, os.homedir());

// 설정 셋(`siteUrl`·`email`·`tokenFile`)이 다 있고 주소가 https일 때만 "연결된" 것으로 본다.
// 토큰은 여기서 읽지 않는다 — 부를 때마다 읽는다.
function jiraSettings(config) {
  const jira = (config && config.jira) || {};
  const siteUrl = typeof jira.siteUrl === 'string' ? jira.siteUrl.trim().replace(/\/+$/, '') : '';
  const email = typeof jira.email === 'string' ? jira.email.trim() : '';
  const tokenFile = typeof jira.tokenFile === 'string' ? jira.tokenFile.trim() : '';
  if (!/^https:\/\/[^\s/?#]+$/.test(siteUrl) || !email || !tokenFile) return null;
  return { siteUrl, email, tokenFile: expandHome(tokenFile) };
}

const issueUrl = (siteUrl, key) => `${siteUrl}/browse/${key}`;
// 지라 키 `ABC-1234`의 프로젝트는 `ABC`다 — 버전 목록을 읽을 때 쓴다(따로 더 묻지 않는다).
const projectOf = key => String(key || '').split('-')[0];

const text = value => (typeof value === 'string' ? value : '');
const day = value => (typeof value === 'string' && JIRA_DAY_RE.test(value) ? value : null);
const idOf = value => (value != null && value !== '' ? String(value) : '');

// 티켓에 걸린 버전 목록(id만). 바꾸기 직전에 "지금 몇 개가 걸려 있나"를 다시 확인하는 데 쓴다.
const versionIdsOf = body => (Array.isArray(body && body.fields && body.fields.fixVersions) ? body.fields.fixVersions : [])
  .map(version => idOf(version && version.id)).filter(Boolean);

// 지라가 허용하는 전환만 선택지로 만든다. 보이는 이름은 `to.name`이고,
// 같은 이름이 둘이면 그때만 전환 이름을 괄호로 붙여 구분한다.
// `requiresInput`은 "지라에서 입력 화면을 거쳐야 하는 전환"이다(기본값 없는 필수 필드가 있는 것).
function shapeTransitions(body) {
  const list = Array.isArray(body && body.transitions) ? body.transitions : [];
  const shaped = list.map((entry) => {
    const fields = entry && entry.fields && typeof entry.fields === 'object' ? Object.values(entry.fields) : [];
    return {
      id: idOf(entry && entry.id),
      toName: text(entry && entry.to && entry.to.name),
      ownName: text(entry && entry.name),
      category: CATEGORY[entry && entry.to && entry.to.statusCategory && entry.to.statusCategory.key] || 'doing',
      requiresInput: fields.some(field => field && field.required === true && field.hasDefaultValue !== true),
    };
  }).filter(entry => entry.id && JIRA_ID_RE.test(entry.id));
  const seen = new Map();
  shaped.forEach(entry => seen.set(entry.toName, (seen.get(entry.toName) || 0) + 1));
  return shaped.map(entry => ({
    id: entry.id,
    name: entry.toName
      ? (seen.get(entry.toName) > 1 && entry.ownName ? `${entry.toName} (${entry.ownName})` : entry.toName)
      : entry.ownName,
    category: entry.category,
    requiresInput: entry.requiresInput,
  }));
}

// 프로젝트의 버전 목록. 고르개는 미배포·미보관만 내놓지만(거르는 것은 부르는 쪽),
// "그 프로젝트의 버전이 맞나" 대조는 거르지 않은 전체로 한다.
function shapeVersions(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body && body.values) ? body.values : [];
  return list.map(version => ({
    id: idOf(version && version.id),
    name: text(version && version.name),
    releaseDate: day(version && version.releaseDate),
    released: !!(version && version.released),
    archived: !!(version && version.archived),
  })).filter(version => version.id && JIRA_ID_RE.test(version.id));
}

// 그 프로젝트에서 만들 수 있는 이슈 종류(createmeta). 새 주소는 `issueTypes`, 옛 주소는
// `projects[0].issuetypes`로 온다 — 둘 다 같은 모양으로 펴서 돌려준다.
// `hierarchyLevel`이 기준이다(이름에 기대지 않는다): 1 = 에픽, 0 = 표준, -1 = 하위 작업.
// 그 칸이 없는 옛 지라는 `subtask`로만 갈라 표준/하위 작업을 나눈다.
function shapeCreateTypes(body) {
  const list = Array.isArray(body && body.issueTypes) ? body.issueTypes
    : Array.isArray(body && body.values) ? body.values
      : (Array.isArray(body && body.projects) && body.projects[0] && Array.isArray(body.projects[0].issuetypes))
        ? body.projects[0].issuetypes : [];
  return list.map((entry) => {
    const subtask = !!(entry && entry.subtask);
    return {
      id: idOf(entry && entry.id),
      name: text(entry && entry.name),
      subtask,
      level: Number.isInteger(entry && entry.hierarchyLevel) ? entry.hierarchyLevel : (subtask ? -1 : 0),
    };
  }).filter(type => type.id && JIRA_ID_RE.test(type.id));
}
// 에픽은 계층 1 하나다(이름이 `Epic`이든 `에픽`이든 상관없다).
const epicTypeOf = types => (Array.isArray(types) ? types : []).find(type => type.level === 1) || null;
// 하위로 달 수 있는 것은 표준 타입(계층 0)뿐이다 — 하위 작업(subtask)은 쓰지 않는다.
const childTypesOf = types => (Array.isArray(types) ? types : []).filter(type => type.level === 0 && !type.subtask);
// 기본값은 이름에 `작업`/`Task`가 있는 것, 없으면 첫 번째다(IO 프로젝트의 실제 하위는 전부 `작업`이었다).
function defaultChildType(types) {
  const list = childTypesOf(types);
  return list.find(type => /task|작업/i.test(type.name)) || list[0] || null;
}

// 지라 응답에서 띠 카드가 쓰는 값만 뽑는다. 모르는 모양이 와도 빈 값으로 흐르게 한다.
function shapeIssue(siteUrl, key, body, children) {
  const fields = (body && body.fields) || {};
  const status = fields.status || {};
  const versions = Array.isArray(fields.fixVersions) ? fields.fixVersions : [];
  return {
    key,
    url: issueUrl(siteUrl, key),
    summary: text(fields.summary),
    type: text(fields.issuetype && fields.issuetype.name),
    status: { name: text(status.name), category: CATEGORY[status.statusCategory && status.statusCategory.key] || 'doing' },
    assignee: text(fields.assignee && fields.assignee.displayName) || null,
    // 지금 담당이 지라에서 비활성일 때만 붙는다(고르개 맨 위 한 줄). 계정 id는 싣지 않는다.
    ...(fields.assignee && fields.assignee.active === false ? { assigneeInactive: true } : {}),
    due: day(fields.duedate),
    versions: versions.map(version => ({
      id: idOf(version && version.id),
      name: text(version && version.name),
      releaseDate: day(version && version.releaseDate),
      released: !!(version && version.released),
    })),
    children,
  };
}

// 하위 티켓의 개수. 하나도 없으면 null — 화면이 진행률 줄을 아예 그리지 않는다.
function countChildren(issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) return null;
  const done = list.filter(item => CATEGORY[item && item.fields && item.fields.status && item.fields.status.statusCategory && item.fields.status.statusCategory.key] === 'done').length;
  return { total: list.length, done };
}

// 하위 티켓 한 줄. 담당자는 `displayName` 하나만 옮긴다 — 지라가 같은 덩어리에 담아 주는
// `emailAddress`·`accountId`는 읽지도 싣지도 않는다. 배포 버전도 이름만(줄 끝의 조용한 글자다).
// 키 형식이 아닌 것은 버린다 — 그 키로 주소를 조립하기 때문이다.
function shapeChild(siteUrl, entry) {
  const key = text(entry && entry.key);
  if (!JIRA_KEY_RE.test(key)) return null;
  const fields = (entry && entry.fields) || {};
  const status = fields.status || {};
  const versions = Array.isArray(fields.fixVersions) ? fields.fixVersions : [];
  return {
    key,
    url: issueUrl(siteUrl, key),
    summary: text(fields.summary),
    type: text(fields.issuetype && fields.issuetype.name),
    status: { name: text(status.name), category: CATEGORY[status.statusCategory && status.statusCategory.key] || 'doing' },
    assignee: text(fields.assignee && fields.assignee.displayName) || null,
    ...(fields.assignee && fields.assignee.active === false ? { assigneeInactive: true } : {}),
    version: text(versions[0] && versions[0].name) || null,
  };
}

// `total`/`done`은 1단계와 똑같이 둔다(진행률 줄과 기존 테스트가 그대로 돈다).
// `items`만 새로 얹는다 — 정렬·접기·거르기는 화면 몫이다.
function shapeChildren(siteUrl, issues) {
  const counted = countChildren(issues);
  if (!counted) return null;
  return { ...counted, items: (Array.isArray(issues) ? issues : []).map(entry => shapeChild(siteUrl, entry)).filter(Boolean) };
}

// 목록 한 줄. 모양은 지금까지 파일(`jira_issues.md`)에서 읽던 것과 **같은 칸 이름**으로 맞춘다
// (`status`는 상태 **이름** 글자다) — 그래야 이 값을 쓰는 기존 자리들이 그대로 돈다.
// 새 칸은 셋뿐이다: `category`(할 일·진행·완료), `due`, `versions`(배포 임박 알림·주간요약이 쓸 값).
// 담당자 칸은 애초에 요청하지 않으므로 여기에도 없다.
function shapeListIssue(entry, extra) {
  const key = text(entry && entry.key);
  if (!JIRA_KEY_RE.test(key)) return null;
  const fields = (entry && entry.fields) || {};
  const status = fields.status || {};
  const versions = Array.isArray(fields.fixVersions) ? fields.fixVersions : [];
  return {
    key,
    type: text(fields.issuetype && fields.issuetype.name),
    status: text(status.name),
    summary: text(fields.summary),
    extra,
    category: CATEGORY[status.statusCategory && status.statusCategory.key] || 'doing',
    due: day(fields.duedate),
    versions: versions.map(version => ({
      name: text(version && version.name),
      releaseDate: day(version && version.releaseDate),
      released: !!(version && version.released),
    })),
  };
}

// ---------- 반응 필요 (BATTENTION 1차 — 지라 댓글) ----------
// "내 마지막 댓글 뒤에 다른 사람이 남긴 댓글이 있는 이슈"만 한 줄로 만든다.
// 내 계정 id는 **판별에만** 쓰고 돌려주는 값에는 넣지 않는다. 사람은 표시 이름만 옮긴다
// (지라가 같이 주는 이메일·계정 id는 어디에도 싣지 않는다 — 하위 티켓 줄과 같은 규칙).

// ADF(지라 댓글 본문)를 한 줄 글자로 편다: 글자 노드는 그대로, `mention`은 `@표시이름`,
// 줄바꿈·문단 사이는 공백 하나, 그 밖(그림·첨부 같은 것)은 빈 글자다.
function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return text(node.text);
  if (node.type === 'mention') {
    const name = text(node.attrs && node.attrs.text).replace(/^@/, '').trim();
    return name ? `@${name}` : '';
  }
  if (node.type === 'hardBreak') return ' ';
  if (!Array.isArray(node.content)) return '';
  // 문단 **안**은 이어 붙이고(글자가 갈라지지 않게), 문단끼리는 공백 하나로 잇는다.
  return node.content.map(adfText).join(node.type === 'paragraph' ? '' : ' ');
}

function attentionPreview(body) {
  const flat = adfText(body).replace(/\s+/g, ' ').trim();
  return flat.length > ATTENTION_PREVIEW_MAX ? `${flat.slice(0, ATTENTION_PREVIEW_MAX - 1).trimEnd()}…` : flat;
}

// 이 댓글이 나를 불렀나 — 본문 어딘가에 `mention` 노드가 있고 그 id가 내 계정 id인지만 본다.
function adfMentions(node, accountId) {
  if (!node || typeof node !== 'object' || !accountId) return false;
  if (node.type === 'mention') return idOf(node.attrs && node.attrs.id) === accountId;
  return Array.isArray(node.content) && node.content.some(kid => adfMentions(kid, accountId));
}

const commentAuthorId = entry => idOf(entry && entry.author && entry.author.accountId);
const commentAuthorName = entry => text(entry && entry.author && entry.author.displayName);
const isoTime = (value) => {
  const at = Date.parse(typeof value === 'string' ? value : '');
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};
// 댓글을 `created` 오름차순으로 놓는다 — 잘려 온 이슈를 다시 읽을 때는 최신순으로 오기 때문에
// 판정 전에 늘 한 번 맞춰 둔다(시각을 못 읽는 줄은 받은 차례를 지킨다).
function sortedComments(list) {
  return (Array.isArray(list) ? list : [])
    .filter(entry => entry && typeof entry === 'object')
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.created) || 0 }))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index))
    .map(item => item.entry);
}

// 이슈 하나 → 줄 하나(또는 null). `mineId`가 없으면 아무것도 만들지 않는다(누가 나인지 모르면 판정하지 않는다).
function shapeAttention(siteUrl, entry, mineId, comments) {
  const key = text(entry && entry.key);
  if (!JIRA_KEY_RE.test(key) || !mineId) return null;
  const list = sortedComments(comments);
  // 내 마지막 댓글 뒤에 남은 다른 사람 댓글. 내 댓글이 없으면(-1) 다른 사람 댓글 전부가 대상이다.
  const mineAt = list.map(commentAuthorId).lastIndexOf(mineId);
  const after = list.slice(mineAt + 1).filter(item => commentAuthorId(item) !== mineId);
  if (!after.length) return null;
  const last = after[after.length - 1];
  const lastId = idOf(last.id);
  // id는 `출처:키:마지막 다른 사람 댓글 id`다 — 숫자가 아니면 그 줄을 만들지 않는다(치우기가 그 id로 걸린다).
  if (!JIRA_ID_RE.test(lastId)) return null;
  const who = commentAuthorName(last);
  const names = new Set(after.map(commentAuthorName).filter(Boolean));
  names.delete(who);
  const fields = (entry && entry.fields) || {};
  const status = fields.status || {};
  return {
    id: `jira:${key}:${lastId}`,
    source: 'jira',
    key,
    url: issueUrl(siteUrl, key),
    summary: text(fields.summary),
    status: text(status.name),
    statusTone: CATEGORY[status.statusCategory && status.statusCategory.key] || 'doing',
    who,
    others: names.size,
    count: after.length,
    preview: attentionPreview(last.body),
    at: isoTime(last.created),
    mention: after.some(item => adfMentions(item.body, mineId)),
  };
}

// 나를 부른 줄이 먼저, 그 안에서는 마지막 댓글이 최신인 것부터.
const attentionOrder = (a, b) => (Number(b.mention) - Number(a.mention)) || String(b.at || '').localeCompare(String(a.at || ''));

function createJiraClient({ settings, request = (...args) => fetch(...args), readToken } = {}) {
  if (!settings) throw new Error('지라 설정이 필요해요.');
  const token = typeof readToken === 'function'
    ? readToken
    : () => {
      const value = String(nodeFs.readFileSync(settings.tokenFile, 'utf8') || '').trim();
      if (!value) throw jiraError('auth');
      return value;
    };

  // 지라로 나가는 단 하나의 길. `send`가 있으면 그 값을 본문으로 실어 보낸다(쓰기).
  // 실패는 늘 우리 문구로 바꿔 던지되 `status`를 달아 둔다 — 쓰기 쪽이 400·403을 갈라 읽는다.
  // `read`는 쓰기인데 답을 읽어야 할 때만 켠다(이슈 만들기가 새 키를 받아 온다).
  async function call(pathAndQuery, secret, { method = 'GET', send = null, read = false } = {}) {
    let response;
    try {
      response = await request(`${settings.siteUrl}${pathAndQuery}`, {
        method,
        headers: {
          // 지라가 요구하는 Basic 인증. 이 값은 만들어 바로 보내고 어디에도 남기지 않는다.
          Authorization: `Basic ${Buffer.from(`${settings.email}:${secret}`).toString('base64')}`,
          Accept: 'application/json',
          ...(send ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(send ? { body: JSON.stringify(send) } : {}),
        signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
      });
    } catch {
      // 끊긴 연결·시간 초과. 원인 문구에 주소·토큰이 섞이지 않게 우리 문구로만 알린다.
      throw jiraError('network');
    }
    if (response.status === 401 || response.status === 403) throw jiraError('auth', response.status);
    if (response.status === 404) throw jiraError('notfound', 404);
    if (!response.ok) throw jiraError('other', response.status);
    // 쓰기는 보통 204(본문 없음)로 온다 — 돌려줄 값이 없으니 해석하지 않는다.
    if (method !== 'GET' && !read) return null;
    try {
      return await response.json();
    } catch {
      throw jiraError('other', response.status);
    }
  }

  // 에픽의 하위는 `subtasks`에 안 담길 수 있어서 JQL로 따로 읽는다.
  // 새 주소(`/search/jql`)가 없는 지라에서는 옛 주소(`/search`)로 한 번만 물러선다.
  // `subtasks`로 물러서면 담당자·배포 버전은 오지 않는다 — 그 줄은 `담당 없음`으로 선다.
  async function children(key, secret, subtasks) {
    const query = `jql=${encodeURIComponent(`parent=${key}`)}&fields=${CHILD_FIELDS}&maxResults=${JIRA_CHILD_LIMIT}`;
    try {
      let body;
      try {
        body = await call(`/rest/api/3/search/jql?${query}`, secret);
      } catch (error) {
        if (error.status !== 404) throw error;
        body = await call(`/rest/api/3/search?${query}`, secret);
      }
      const shaped = shapeChildren(settings.siteUrl, body && body.issues);
      if (shaped) return shaped;
    } catch {
      // 하위 조회는 곁들이는 값이다 — 실패해도 카드 전체를 오류로 만들지 않는다.
    }
    return shapeChildren(settings.siteUrl, subtasks);
  }

  // 목록 조회 한 번. 하위 티켓과 같은 길이다 — 새 주소(`/search/jql`)가 없는 지라에서는
  // 옛 주소(`/search`)로 한 번만 물러선다. 받아 오는 칸은 부르는 쪽이 고른다.
  async function search(jql, secret, fields = LIST_FIELDS, limit = JIRA_LIST_LIMIT) {
    const query = `jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${limit}`;
    try {
      return await call(`/rest/api/3/search/jql?${query}`, secret);
    } catch (error) {
      if (error.status !== 404) throw error;
      return await call(`/rest/api/3/search?${query}`, secret);
    }
  }

  // 프로젝트 고르기 목록·요약의 원천. ① 내 담당·미완료를 읽고,
  // ② 업무에 걸려 있는 키 중 ①에 없는 것만 `key in (…)`로 한 번 더 읽어 `extra:true`로 붙인다
  // (완료됐거나 담당이 바뀐 티켓의 요약이 사라지지 않게 — 파일 스냅샷의 `그 밖의 이슈`와 같은 규칙).
  // 16번이면 추가 조회 키 100개(JIRA_LIST_LIMIT) 가운데 지워진 키가 하나일 때 반씩 나눠 끝까지 찾아갈 수 있다(1 + 2×7 = 15).
  const EXTRA_SEARCH_LIMIT = 16;
  async function listMyIssues(linkedKeys = []) {
    const secret = token();
    const mine = (((await search(MY_ISSUES_JQL, secret)) || {}).issues || [])
      .map(entry => shapeListIssue(entry, false)).filter(Boolean).slice(0, JIRA_LIST_LIMIT);
    const have = new Set(mine.map(issue => issue.key));
    const wanted = [...new Set((Array.isArray(linkedKeys) ? linkedKeys : [])
      .filter(key => typeof key === 'string' && JIRA_KEY_RE.test(key) && !have.has(key)))].slice(0, JIRA_LIST_LIMIT);
    if (!wanted.length) return mine;
    // 지라에서 지워졌거나 없는 키가 섞이면 그 조회가 4xx로 실패한다 — 키 목록을 반으로 나눠 다시 묻고,
    // 한 개짜리가 4xx면 그 키만 뺀다(살아 있는 추가분은 살린다). 지라를 두드리는 수를 묶으려고
    // 한 번 목록 갱신의 추가 조회는 EXTRA_SEARCH_LIMIT번까지만 — 넘으면 아직 못 물은 키는 빼고 끝낸다.
    // (인증 실패 401·403, 너무 잦은 요청 429, 상태 없는 네트워크 오류·5xx는 중간에 나와도 예전처럼 그대로 던진다.)
    const found = { issues: [] };
    let budget = EXTRA_SEARCH_LIMIT;
    const queue = [wanted];
    while (queue.length && budget > 0) {
      const keys = queue.shift();
      budget -= 1;
      try {
        const body = (await search(`key in (${keys.join(',')})`, secret)) || {};
        found.issues.push(...(body.issues || []));
      } catch (error) {
        const status = error && error.status;
        if (!(status >= 400 && status < 500) || status === 401 || status === 403 || status === 429) throw error;
        if (keys.length > 1) {
          const half = Math.ceil(keys.length / 2);
          queue.push(keys.slice(0, half), keys.slice(half));
        }
      }
    }
    const rest = (found.issues || [])
      .map(entry => shapeListIssue(entry, true)).filter(Boolean)
      .filter(issue => !have.has(issue.key)).slice(0, JIRA_LIST_LIMIT);
    return [...mine, ...rest];
  }

  // 최근에 끝난 내 티켓. 연결 입력칸에서 `완료한 티켓도 보기`를 눌렀을 때만 부른다 —
  // 목록과 같은 길·같은 모양이되 배포 버전·기한은 묻지 않는다(고르는 줄에 쓰지 않는다).
  async function listDoneIssues(days = JIRA_DONE_DAYS) {
    const body = await search(doneIssuesJql(doneDaysOf(days)), token(), DONE_FIELDS);
    return ((body || {}).issues || []).map(entry => shapeListIssue(entry, false)).filter(Boolean).slice(0, JIRA_LIST_LIMIT);
  }

  // ---------- 반응 필요 (BATTENTION) ----------
  // 누가 나인지는 지라에 한 번 물어 계정 id로 안다. 이 값은 **부르는 쪽 메모리에만** 두고
  // 돌려주는 값·오류 문구 어디에도 싣지 않는다(테스트로 고정).
  async function getMyAccountId() {
    return (await getMyself()).accountId;
  }

  // 연동 설정에서 "이 토큰으로 지라에 들어가지나" 확인할 때 쓴다 — 계정 id와 **표시 이름**만 읽는다.
  // 이메일·토큰은 돌려주지 않는다.
  async function getMyself() {
    const body = await call('/rest/api/3/myself', token());
    const id = idOf(body && body.accountId);
    if (!id) throw jiraError('auth');
    return { accountId: id, displayName: text(body && body.displayName) };
  }

  // 내가 담당·보고·지켜보는 이슈(최근 14일) → 내 마지막 댓글 뒤에 다른 사람 댓글이 있는 줄만.
  // 댓글 칸이 잘려 온 이슈만 한 번씩 더 읽는다(그 이슈의 최근 20개).
  async function listAttention(mineId) {
    if (!mineId) throw jiraError('auth');
    const secret = token();
    const body = await search(ATTENTION_JQL, secret, ATTENTION_FIELDS, ATTENTION_LIMIT);
    const issues = (Array.isArray(body && body.issues) ? body.issues : []).slice(0, ATTENTION_LIMIT);
    const rows = [];
    for (const entry of issues) {
      const key = text(entry && entry.key);
      if (!JIRA_KEY_RE.test(key)) continue;
      const comment = (entry.fields && entry.fields.comment) || {};
      let comments = Array.isArray(comment.comments) ? comment.comments : [];
      if (Number.isInteger(comment.total) && comment.total > comments.length) {
        try {
          const more = await call(`/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${ATTENTION_COMMENT_LIMIT}`, secret);
          if (Array.isArray(more && more.comments)) comments = more.comments;
        } catch {
          // 곁들이는 조회다 — 실패하면 목록에 실려 온 댓글로만 판단한다(목록 전체를 오류로 만들지 않는다).
        }
      }
      const row = shapeAttention(settings.siteUrl, entry, mineId, comments);
      if (row) rows.push(row);
    }
    return rows.sort(attentionOrder);
  }

  const wantKey = (key) => { if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) throw jiraError('key'); return key; };
  const wantId = (id) => { const value = idOf(id); if (!JIRA_ID_RE.test(value)) throw jiraError('value'); return value; };
  const wantProject = (key) => { if (typeof key !== 'string' || !JIRA_PROJECT_RE.test(key)) throw jiraError('key'); return key; };
  const wantSummary = (value) => {
    const summary = typeof value === 'string' ? value.trim() : '';
    if (!summary || summary.length > JIRA_SUMMARY_MAX || /[\r\n]/.test(summary)) throw jiraError('value');
    return summary;
  };

  // 화면이 쓰는 한 덩어리. 실패는 `kind`가 붙은 Error로 던진다.
  async function getIssueOverview(key) {
    wantKey(key);
    const secret = token();
    const body = await call(`/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`, secret);
    return shapeIssue(settings.siteUrl, key, body, await children(key, secret, body && body.fields && body.fields.subtasks));
  }

  // ---------- 바꾸기(2단계) ----------
  // 전부 "고르개가 내놓을 선택지"와 "쓰기" 둘로만 나뉜다. 쓰기는 부르는 쪽이 확인 절차를 거친 뒤에만 부른다.

  async function getTransitions(key) {
    wantKey(key);
    return shapeTransitions(await call(`/rest/api/3/issue/${key}/transitions?expand=transitions.fields`, token()));
  }

  async function getVersions(projectKey) {
    if (typeof projectKey !== 'string' || !JIRA_PROJECT_RE.test(projectKey)) throw jiraError('key');
    return shapeVersions(await call(`/rest/api/3/project/${projectKey}/versions`, token()));
  }

  // 티켓에 지금 걸린 버전 id만 가볍게 읽는다(하위 집계까지 끌고 오지 않는다).
  async function getIssueVersionIds(key) {
    wantKey(key);
    return versionIdsOf(await call(`/rest/api/3/issue/${key}?fields=fixVersions`, token()));
  }

  async function transition(key, transitionId) {
    wantKey(key);
    await call(`/rest/api/3/issue/${key}/transitions`, token(), { method: 'POST', send: { transition: { id: wantId(transitionId) } } });
  }

  // `fields`에 담아 보낸 칸만 바뀐다(우리가 만든 값만 넣는다 — 받은 객체를 그대로 싣지 않는다).
  async function updateIssueFields(key, fields) {
    wantKey(key);
    if (!fields || !Object.keys(fields).length) throw jiraError('value');
    await call(`/rest/api/3/issue/${key}`, token(), { method: 'PUT', send: { fields } });
  }

  // 버전 자체(이름·배포일)를 고친다 — 그 버전을 쓰는 모든 티켓에 적용된다.
  async function updateVersion(versionId, patch) {
    const id = wantId(versionId);
    const send = {};
    if (patch && typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (!name || name.length > 255 || /[\r\n]/.test(name)) throw jiraError('value');
      send.name = name;
    }
    if (patch && 'releaseDate' in patch) {
      if (patch.releaseDate === null) send.releaseDate = null;
      else if (typeof patch.releaseDate === 'string' && JIRA_DAY_RE.test(patch.releaseDate)) send.releaseDate = patch.releaseDate;
      else throw jiraError('value');
    }
    if (!Object.keys(send).length) throw jiraError('value');
    await call(`/rest/api/3/version/${id}`, token(), { method: 'PUT', send });
  }

  // ---------- 새로 만들기(BJCREATE) ----------
  // 만드는 것은 에픽 하나와 그 아래 하위 티켓들뿐이다. 새로 만든 에픽만 나에게 자동 배정하고
  // (BJASSIGN), 하위 티켓은 직군별로 사람이 나중에 따로 지정한다(담당 없음 그대로). 설명·배포 버전·기한은 넣지 않는다.

  // 그 프로젝트에서 만들 수 있는 이슈 종류. 새 주소가 없는 지라에서는 옛 주소로 한 번만 물러선다
  // (하위 티켓 조회와 같은 규칙이다).
  async function getCreateMeta(projectKey) {
    wantProject(projectKey);
    const secret = token();
    try {
      return shapeCreateTypes(await call(`/rest/api/3/issue/createmeta/${projectKey}/issuetypes?maxResults=${JIRA_TYPE_LIMIT}`, secret));
    } catch (error) {
      if (error.status !== 404) throw error;
      return shapeCreateTypes(await call(`/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`, secret));
    }
  }

  // 대조용으로 가볍게 읽는다(요약과 종류 id만) — 띠 카드가 쓰는 한 덩어리를 끌고 오지 않는다.
  async function getIssueBrief(key) {
    wantKey(key);
    const body = await call(`/rest/api/3/issue/${key}?fields=summary,issuetype`, token());
    const fields = (body && body.fields) || {};
    return { key, summary: text(fields.summary), typeId: idOf(fields.issuetype && fields.issuetype.id) };
  }

  // 이슈 하나 만들기. 보내는 칸은 우리가 지은 네 개뿐이다(받은 객체를 그대로 싣지 않는다).
  // 에픽 하위는 `parent`로 단다 — 구형 지라의 `에픽 링크` 커스텀 필드는 1차에서 지원하지 않고,
  // 그 지라는 400을 돌려주므로 화면이 `지라에서 직접 확인해 주세요`로 안내한다.
  async function createIssue({ projectKey, issueTypeId, summary, parentKey = null } = {}) {
    wantProject(projectKey);
    const fields = { project: { key: projectKey }, issuetype: { id: wantId(issueTypeId) }, summary: wantSummary(summary) };
    if (parentKey) fields.parent = { key: wantKey(parentKey) };
    const body = await call('/rest/api/3/issue', token(), { method: 'POST', send: { fields }, read: true });
    const key = text(body && body.key);
    if (!JIRA_KEY_RE.test(key)) throw jiraError('make');
    return { key, url: issueUrl(settings.siteUrl, key) };
  }

  // 결과 모름으로 끝난 만들기가 실제로 지라에 있는지 찾는다. 요약은 JQL 글자 검색(`~`)에 맡기지 않고
  // (괄호·따옴표가 섞이면 검색 문법이 흔들린다) 같은 프로젝트·종류·부모·보고자=나·최근 생성으로 좁혀 읽은 뒤
  // 요약을 글자 그대로 대조한다. 읽은 것이 상한만큼 차면 가를 수 없다고 보고 던진다(부르는 쪽이 모름을 유지한다).
  async function findMade({ projectKey, issueTypeId, summary, parentKey = null, minutes } = {}) {
    wantProject(projectKey);
    const type = wantId(issueTypeId);
    const within = Math.max(1, Math.ceil(Number(minutes) || 0));
    const jql = `project = ${projectKey} AND issuetype = ${type} AND reporter = currentUser() AND created >= -${within}m`
      + (parentKey ? ` AND parent = ${wantKey(parentKey)}` : '') + ' ORDER BY created DESC';
    const body = await search(jql, token(), 'summary,issuetype,parent', UNSURE_LOOKUP_LIMIT);
    const issues = Array.isArray(body && body.issues) ? body.issues : null;
    // 덜 읽은 쪽이 있으면(새 주소는 nextPageToken·isLast:false, 옛 주소는 total) 남은 쪽에 같은 이슈가 있을 수 있다.
    const partial = !!(body && (body.nextPageToken || body.isLast === false || (typeof body.total === 'number' && body.total > (issues || []).length)));
    if (!issues || partial || issues.length >= UNSURE_LOOKUP_LIMIT) throw jiraError('other');
    const want = wantSummary(summary);
    return issues
      .filter(entry => entry && JIRA_KEY_RE.test(text(entry.key)) && text(entry.fields && entry.fields.summary).trim() === want)
      .filter(entry => idOf(entry.fields.issuetype && entry.fields.issuetype.id) === type)
      .filter(entry => !parentKey || text(entry.fields.parent && entry.fields.parent.key) === parentKey)
      .map(entry => ({ key: entry.key, url: issueUrl(settings.siteUrl, entry.key) }));
  }

  // 담당자를 accountId로 지정한다(BJASSIGN 새 에픽 · BJASSIGN2 담당자 바꾸기). accountId는 사람이 보는
  // 값이 아니라 지라 내부 식별자라 본문(body)에만 싣고 주소(querystring)에는 절대 넣지 않는다.
  // `null`을 주면 담당을 뺀다(`{ accountId: null }`). 자동 배정(`-1`)은 쓰지 않는다.
  async function assignIssue(key, accountId) {
    wantKey(key);
    let id = null;
    if (accountId !== null) {
      id = idOf(accountId);
      if (!id) throw jiraError('auth');
    }
    await call(`/rest/api/3/issue/${key}/assignee`, token(), { method: 'PUT', send: { accountId: id } });
  }

  // ---------- 담당자 바꾸기(BJASSIGN2) ----------
  const wantAccount = (id) => { const value = idOf(id); if (!JIRA_ACCOUNT_RE.test(value)) throw jiraError('value'); return value; };

  // 이 티켓을 맡을 수 있는 사람(지라가 프로젝트 권한대로 거른다). 지라는 이메일·아바타·시간대까지 주지만
  // id·표시 이름만 옮기고, 사람 계정(`atlassian`)·활성인 사람만 남긴다. 주소에는 키와 사람이 친 글자만 실린다.
  async function searchAssignable(key, query, limit = ASSIGNABLE_ASK) {
    wantKey(key);
    const body = await call(`/rest/api/3/user/assignable/search?issueKey=${key}&query=${encodeURIComponent(String(query || ''))}&maxResults=${limit}`, token());
    return (Array.isArray(body) ? body : [])
      .filter(user => user && user.accountType === 'atlassian' && user.active !== false)
      .map(user => ({ accountId: idOf(user.accountId), name: text(user.displayName) }))
      .filter(user => JIRA_ACCOUNT_RE.test(user.accountId) && user.name);
  }

  // 지금 담당. id는 부르는 쪽이 메모리에서 대조에만 쓴다(돌려주는 응답에는 이름만 나간다).
  async function getAssignee(key) {
    wantKey(key);
    const body = await call(`/rest/api/3/issue/${key}?fields=assignee`, token());
    const who = body && body.fields && body.fields.assignee;
    const id = idOf(who && who.accountId);
    return id ? { accountId: id, name: text(who.displayName) || null } : { accountId: null, name: null };
  }

  // 그 사람이 최근 맡은 티켓 요약 한 줄(같은 이름이 둘 이상일 때 구분용). accountId는 본문(JQL)에만 싣는다.
  async function latestSummaryOf(accountId) {
    const id = wantAccount(accountId);
    const body = await call('/rest/api/3/search/jql', token(), {
      method: 'POST', read: true,
      send: { jql: `assignee = "${id}" ORDER BY updated DESC`, fields: ['summary'], maxResults: 1 },
    });
    const first = body && Array.isArray(body.issues) ? body.issues[0] : null;
    return text(first && first.fields && first.fields.summary) || null;
  }

  return {
    getIssueOverview, listMyIssues, listDoneIssues, getTransitions, getVersions, getIssueVersionIds,
    transition, updateIssueFields, updateVersion, getCreateMeta, getIssueBrief, createIssue, findMade, assignIssue,
    searchAssignable, getAssignee, latestSummaryOf,
    getMyAccountId, getMyself, listAttention,
  };
}

// 설정 > 연동의 `연결` 하나가 쓰는 길 — 아직 저장되지 않은 값으로 지라에 한 번 물어본다.
// 성공하면 표시 이름만 돌려주고, 실패는 갈래만 알린다(주소·이메일·토큰은 어디에도 싣지 않는다).
async function checkJiraAccount({ siteUrl, email, token, request } = {}) {
  const site = String(siteUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/?#]+$/.test(site) || !String(email || '').trim() || !String(token || '').trim()) {
    return { ok: false, kind: 'auth' };
  }
  try {
    const client = createJiraClient({
      settings: { siteUrl: site, email: String(email).trim(), tokenFile: '' },
      request,
      readToken: () => String(token).trim(),
    });
    const me = await client.getMyself();
    return { ok: true, displayName: me.displayName };
  } catch (error) {
    return { ok: false, kind: MESSAGE[error && error.kind] ? error.kind : 'other' };
  }
}

// 쓰기 실패를 화면 문구로 옮기는 단 하나의 표. 우리가 먼저 막은 것(대조 실패·필수 입력·여러 버전)은
// 그 갈래를 그대로 쓰고, 지라가 준 것은 상태 번호로만 가른다(지라 원문은 절대 싣지 않는다).
const WRITE_GUARDS = ['key', 'value', 'stale', 'screen', 'multi'];
function writeKind(error) {
  if (error && WRITE_GUARDS.includes(error.kind)) return error.kind;
  const status = error && error.status;
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 400) return 'reject';
  if (status === 404) return 'notfound';
  return 'write';
}

// 담당자 바꾸기의 같은 표. 기존 쓰기 표(writeKind)는 401·403을 합쳐 `권한이 없어요`로 말하지만,
// 담당자 바꾸기만은 401을 토큰 문제(`auth`)로 가른다. 지라에 쓰는 중(PUT)에 끊기거나 시간이 지나면
// 반영됐는지 모르므로(5xx도 같다) `assignUnsure`다(화면이 카드를 새로 읽는다). 보낸 모양이 틀리면 `assignValue`다 —
// 이 종류를 모르는 옛 서버의 `value` 거절과 화면이 가를 수 있게 갈래 이름을 따로 둔다.
const ASSIGN_GUARDS = ['key', 'value', 'assignValue'];
function assignKind(error, writing = false) {
  if (error && ASSIGN_GUARDS.includes(error.kind)) return error.kind;
  const status = error && error.status;
  if (status === 401) return 'auth';
  if (status === 403) return 'assignForbidden';
  if (status === 400) return 'reject';
  if (status === 404) return 'notfound';
  // 쓰는 중 5xx(502·504 등)는 지라가 반영했는지 모른다 — 끊김과 같이 다룬다(화면이 카드를 새로 읽는다).
  if (!status || status >= 500) return writing ? 'assignUnsure' : 'network';
  return 'write';
}

// 담당자 바꾸기 요청 모양 확인 — 요청 하나는 티켓 하나의 담당자 한 명 변경이다(여러 키·여러 사람을 받지 않는다).
// 맞으면 고른 값, 틀리면 null.
function assignPayload(payload) {
  const name = value => (value === null || value === undefined || value === ''
    ? null
    : (typeof value === 'string' && value.trim() && value.length <= ASSIGN_NAME_MAX && !/[\r\n]/.test(value) ? value : undefined));
  if (payload.kind === 'assigneeUndo') {
    return typeof payload.undoId === 'string' && /^[0-9a-f-]{36}$/.test(payload.undoId) ? { undoId: payload.undoId } : null;
  }
  if (!('to' in payload)) return null;
  const to = payload.to === null ? null : payload.to;
  if (to !== null && !(typeof to === 'string' && JIRA_ACCOUNT_RE.test(to))) return null;
  const expect = name(payload.expect);
  const toName = name(payload.toName);
  if (expect === undefined || toName === undefined) return null;
  // 맡길 사람이 있으면 그 표시 이름도 있어야 한다 — 쓰기 직전 "맡을 수 있나"를 이름으로 찾아 id로 대조한다.
  if (to !== null && !toName) return null;
  return { to, expect, toName };
}

// 새로 만들기의 같은 표. 만들기는 실패 이유가 줄마다 따로 보이므로 문구를 따로 둔다
// (400은 "필수 항목이 더 있을 수 있어요"까지 말해 준다 — 지라 원문은 여기서도 싣지 않는다).
// `writing`은 이슈를 만드는 POST에서만 켠다. 그때 지라가 4xx로 거절한 것만 확실한 실패(안 만들어짐)이고,
// 끊김·시간 초과(상태 번호 없음)·5xx·성공 번호인데 응답을 못 읽음은 **결과 모름**(`makeUnsure` — 만들어졌을 수도)이다.
// 읽기(종류 목록·에픽 대조·나 조회)와 배정은 만든 것이 없으니 이 갈래를 타지 않는다.
const MAKE_GUARDS = ['key', 'value', 'typeStale', 'epicType', 'notEpic'];
function makeKind(error, writing = false) {
  if (error && MAKE_GUARDS.includes(error.kind)) return error.kind;
  const status = error && error.status;
  if (writing && (!status || status >= 500 || (status >= 200 && status < 300))) return 'makeUnsure';
  if (status === 401 || status === 403) return 'makeForbidden';
  if (status === 400) return 'makeReject';
  if (status === 404) return 'notfound';
  return 'make';
}

// 서버가 쓰는 겉면: 설정 확인 + 키별 60초 메모리 캐시 + 화면에 그대로 보여 줄 오류 문구.
// 파일은 아무것도 쓰지 않는다(조회는 기록을 남기지 않는다).
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function createJiraApi({ config, request, readFile = nodeFs.readFileSync, now = Date.now, ttlMs = JIRA_CACHE_MS, sleep = pause } = {}) {
  const settings = jiraSettings(config);
  const cache = new Map();
  // 완료한 내 티켓은 키가 없는 목록이라 캐시도 한 벌뿐이다(기간이 바뀌면 버린다).
  let doneCache = null;
  // 만들 수 있는 이슈 종류는 프로젝트마다 60초 메모리 캐시다(파일은 쓰지 않는다).
  const metaCache = new Map();
  // 방금 보낸 만들기 요청의 지문 → 받은 시각. 같은 계획이 60초 안에 두 번 오면 거절한다
  // (새로고침·두 번 누르기로 지라에 같은 이슈가 두 벌 생기지 않게). 메모리에만 있다.
  const madePlans = new Map();
  // 결과 모름으로 끝난 이슈 하나하나의 지문(프로젝트·부모·종류·요약) → 모름이 난 시각. 계획 지문과 달리
  // 하위 티켓 `다시 시도`(이미 있는 에픽에 붙이는 다른 계획)로 와도 같은 이슈면 잡힌다. 메모리에만 있다.
  const unsureMade = new Map();
  // 지금 지라에 보내거나 찾는 중인 이슈 지문 — 다른 계획이 같은 이슈를 동시에 보내면 둘째는 기다리게 한다(assignBusy와 같은 방식).
  const makeBusy = new Set();
  // 내 계정 id(반응 필요의 "나" 판별). 프로세스마다 한 번 묻고 메모리에만 둔다 — 어디에도 나가지 않는다.
  let mineId = null;
  // 담당자 바꾸기(BJASSIGN2) — 되돌리기 표(undoId → 직전·직후 담당, 10분, 한 번 쓰면 지움)와
  // 방금 쓴 `키+사람`(3초, 연타가 두 번 쓰지 않게). 둘 다 메모리에만 있다(파일·로그 없음, 재시작하면 사라진다).
  const assignUndo = new Map();
  const assignRecent = new Map();
  // 지금 지라에 담당을 쓰는 중인 티켓 — 같은 티켓에 동시에 온 두 번째 요청은 지라를 부르지 않고 멈춘다.
  const assignBusy = new Set();
  const assignSweep = () => {
    for (const [id, entry] of assignUndo) if (now() - entry.at >= ASSIGN_UNDO_MS) assignUndo.delete(id);
    for (const [sig, entry] of assignRecent) if (now() - entry.at >= ASSIGN_REPEAT_MS) assignRecent.delete(sig);
  };
  // 그 티켓에 새로 쓰면 그 티켓의 "방금 쓴 사람" 기억은 전부 버린다(되돌린 뒤 곧바로 다시 맡겨도 쓰이게).
  const assignForget = key => { for (const sig of [...assignRecent.keys()]) if (sig.startsWith(`${key}|`)) assignRecent.delete(sig); };

  function token() {
    try {
      return String(readFile(settings.tokenFile, 'utf8') || '').trim() || null;
    } catch {
      return null;
    }
  }

  async function read(key, { fresh = false } = {}) {
    // 들어온 값은 설정보다 먼저 본다 — 연결 여부와 상관없이 형식이 틀린 키는 받지 않는다.
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    if (!settings) return { ok: true, connected: false };
    // 토큰 파일을 못 읽으면 "잘못 넣었다"가 아니라 "아직 연결하지 않았다"로 본다(README의 설정 절로 안내).
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    if (!fresh) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return { ok: true, connected: true, issue: hit.issue };
    }
    try {
      const issue = await createJiraClient({ settings, request, readToken: () => secret }).getIssueOverview(key);
      cache.set(key, { at: now(), issue });
      return { ok: true, connected: true, issue };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 내 담당 목록. 캐시는 여기 두지 않는다 — 들고 있는 것은 서버의 `jira-live`뿐이고,
  // 이 함수는 부를 때마다 지라에서 새로 읽는다. 파일은 아무것도 쓰지 않는다.
  async function list(linkedKeys = []) {
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    try {
      const issues = await createJiraClient({ settings, request, readToken: () => secret }).listMyIssues(linkedKeys);
      return { ok: true, connected: true, issues };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 완료한 내 티켓. 연결 입력칸에서 그 버튼을 눌렀을 때만 부르고, 파일은 아무것도 쓰지 않는다.
  // 서버 메모리에 60초만 들고 있는다 — 같은 입력칸을 여러 번 열어도 지라를 다시 부르지 않게.
  async function listDone(days = JIRA_DONE_DAYS) {
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    const span = doneDaysOf(days);
    if (doneCache && doneCache.days === span && now() - doneCache.at < ttlMs) return { ok: true, connected: true, issues: doneCache.issues };
    try {
      const issues = await createJiraClient({ settings, request, readToken: () => secret }).listDoneIssues(span);
      doneCache = { at: now(), days: span, issues };
      return { ok: true, connected: true, issues };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 반응 필요(지라 댓글). 파일은 하나도 쓰지 않고, 들고 있는 것은 서버의 `attention-live`뿐이다.
  // 내 계정 id만 이 closure의 메모리에 한 번 담아 두고(토큰이 만료되면 버린다) 응답에는 싣지 않는다.
  async function attention() {
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    const client = createJiraClient({ settings, request, readToken: () => secret });
    try {
      if (!mineId) mineId = await client.getMyAccountId();
      return { ok: true, connected: true, items: await client.listAttention(mineId) };
    } catch (error) {
      // 토큰이 바뀌면 나도 달라질 수 있다 — 인증 실패면 다음번에 다시 묻는다.
      if (error && (error.status === 401 || error.status === 403)) mineId = null;
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 고르개가 열릴 때만 부른다(카드를 그릴 때는 부르지 않는다). 파일도 캐시도 없다 —
  // 선택지는 늘 지라의 지금 값이어야 하고, 쓰기 직전에 서버가 한 번 더 대조한다.
  async function options(key) {
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    try {
      const client = createJiraClient({ settings, request, readToken: () => secret });
      const [transitions, versions] = await Promise.all([client.getTransitions(key), client.getVersions(projectOf(key))]);
      return {
        ok: true,
        connected: true,
        transitions,
        // 고를 수 있는 것은 아직 배포되지 않고 보관되지 않은 버전뿐이다(지금 걸린 버전은 화면이 더한다).
        versions: versions.filter(version => !version.released && !version.archived)
          .map(({ id, name, releaseDate }) => ({ id, name, releaseDate })),
      };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 담당자 고르개가 두 글자 이상 쳤을 때만 부른다 — 이 티켓을 맡을 수 있는 사람(최대 10명).
  // 조회라 파일도 캐시도 없다. 응답에 실리는 것은 id·표시 이름·`나`·같은 이름 구분 글자뿐이다.
  async function assignable(key, q) {
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    const query = typeof q === 'string' ? q.trim() : '';
    if ([...query].length < 2 || query.length > ASSIGNABLE_QUERY_MAX || /[\r\n]/.test(query)) return { ok: false, error: MESSAGE.value, kind: 'value' };
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    const client = createJiraClient({ settings, request, readToken: () => secret });
    try {
      const found = (await client.searchAssignable(key, query)).slice(0, ASSIGNABLE_SHOWN);
      // 누가 나인지는 반응 필요·새 에픽과 같은 mineId를 쓴다(못 읽으면 `나` 표시만 빠진다).
      if (!mineId) {
        try { mineId = await client.getMyAccountId(); } catch { mineId = null; }
      }
      const total = new Map();
      found.forEach(user => total.set(user.name, (total.get(user.name) || 0) + 1));
      const nth = new Map();
      let lookups = SAME_NAME_LOOKUPS;
      const users = [];
      for (const user of found) {
        const entry = { accountId: user.accountId, name: user.name };
        if (mineId && user.accountId === mineId) entry.me = true;
        const many = total.get(user.name);
        if (many > 1) {
          // 같은 이름이 둘 이상이면 이메일 대신 그 사람이 최근 맡은 티켓 요약 한 줄로 가른다.
          nth.set(user.name, (nth.get(user.name) || 0) + 1);
          let summary = null;
          if (lookups > 0) {
            lookups -= 1;
            try { summary = await client.latestSummaryOf(user.accountId); } catch { summary = null; }
          }
          entry.hint = summary ? `최근 · ${summary}` : `같은 이름 ${many}명 중 ${nth.get(user.name)}`;
        }
        users.push(entry);
      }
      return { ok: true, connected: true, users };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 담당자 바꾸기·되돌리기. 순서가 안전장치다(하나라도 어긋나면 쓰지 않고 멈춘다):
  // ① 지금 담당을 다시 읽어 화면이 본 이름(`expect`)과 같은지 ② 맡길 사람이 이 티켓을 맡을 수 있는지
  // (이름으로 찾고 id로 대조 — 주소에 id를 싣지 않으려고) ③ 이미 그 사람이면 쓰지 않음 ④ PUT.
  // 되돌리기는 ①을 accountId로 대조한 뒤 직전 담당으로 PUT한다. 응답에는 이름만 나간다.
  async function changeAssignee(key, asked, client) {
    if (assignBusy.has(key)) return { ok: false, error: assignMessage('assignBusy'), kind: 'assignBusy' };
    assignBusy.add(key);
    try {
      return await changeAssigneeOnce(key, asked, client);
    } finally {
      assignBusy.delete(key);
    }
  }
  async function changeAssigneeOnce(key, asked, client) {
    const fail = (kind, name) => ({ ok: false, error: assignMessage(kind, name), kind });
    assignSweep();
    if (asked.undoId) {
      const entry = assignUndo.get(asked.undoId);
      if (!entry || entry.key !== key) return fail('undoGone');
      assignUndo.delete(asked.undoId);
      let current;
      try {
        current = await client.getAssignee(key);
      } catch (error) {
        const kind = assignKind(error);
        return kind === 'auth' ? fail('auth') : fail('undoFail', entry.afterName);
      }
      if (current.accountId !== entry.after) { cache.delete(key); return fail('undoStale'); }
      try {
        await client.assignIssue(key, entry.before);
      } catch (error) {
        const kind = assignKind(error, true);
        cache.delete(key);
        return kind === 'auth' || kind === 'assignUnsure' ? fail(kind) : fail('undoFail', entry.afterName);
      }
      cache.delete(key);
      assignForget(key);
      return { ok: true, assignee: entry.beforeName };
    }

    const { to, expect } = asked;
    let toName = asked.toName;
    const signature = `${key}|${to === null ? '' : to}`;
    let current;
    try {
      current = await client.getAssignee(key);
    } catch (error) { return fail(assignKind(error)); }
    // 3초 안에 같은 `키+사람`이 또 왔다(두 번 누름): 지라의 지금 담당이 방금 쓴 그 사람이거나 아직 화면이 본 그대로일
    // 때만 쓰지 않고 `same`이다. 그 사이 다른 사람이 바꿨으면 아래 대조가 `stale`로 막는다(덮어쓰지 않는다).
    const repeat = assignRecent.get(signature);
    if (repeat && (current.accountId === to || (current.name || null) === expect)) return { ok: true, same: true, assignee: repeat.name };
    if ((current.name || null) !== expect) {
      cache.delete(key);
      return { ...fail('assigneeStale', current.name), assignee: current.name };
    }
    if (to !== null) {
      let allowed;
      try {
        allowed = await client.searchAssignable(key, toName, ASSIGNABLE_CHECK);
      } catch (error) { return fail(assignKind(error)); }
      const match = allowed.find(user => user.accountId === to);
      if (!match) return fail('notAssignable', toName);
      toName = match.name;
    }
    if (current.accountId === to) return { ok: true, same: true, assignee: current.name };
    try {
      await client.assignIssue(key, to);
    } catch (error) {
      const kind = assignKind(error, true);
      cache.delete(key);
      return fail(kind);
    }
    cache.delete(key);
    const after = to === null ? null : toName;
    assignForget(key);
    assignRecent.set(signature, { at: now(), name: after });
    const undoId = nodeCrypto.randomUUID();
    assignUndo.set(undoId, { key, before: current.accountId, beforeName: current.name, after: to, afterName: after, at: now() });
    return { ok: true, assignee: after, undoId };
  }

  // 지라에 쓰는 단 하나의 길. 화면은 확인 절차를 거친 뒤에만 부르고,
  // 여기서는 보낸 값을 다시 검증하고 id를 **쓰기 직전에 다시 조회해 대조**한다.
  // 앱 데이터 저장소(mutation-store·idempotent)는 건드리지 않는다 — 지라는 앱 파일이 아니다.
  async function change(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const key = payload.key;
    const what = payload.kind;
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    if (!CHANGE_KINDS.includes(what)) return { ok: false, error: MESSAGE.value, kind: 'value' };
    const assigning = what === 'assignee' || what === 'assigneeUndo';
    const asked = assigning ? assignPayload(payload) : null;
    if (assigning && !asked) return { ok: false, error: MESSAGE.assignValue, kind: 'assignValue' };
    if (!settings) return { ok: false, error: MESSAGE.off, kind: 'off' };
    const secret = token();
    if (!secret) return { ok: false, error: MESSAGE.off, kind: 'off' };
    const client = createJiraClient({ settings, request, readToken: () => secret });
    if (assigning) return changeAssignee(key, asked, client);
    try {
      if (what === 'status') {
        const id = idOf(payload.transitionId);
        // 고르개가 본 목록이 아니라 **지금** 목록으로 대조한다(그 사이 지라에서 바뀌었을 수 있다).
        const allowed = (await client.getTransitions(key)).find(entry => entry.id === id);
        if (!allowed) throw jiraError('stale');
        if (allowed.requiresInput) throw jiraError('screen');
        await client.transition(key, id);
      } else if (what === 'version') {
        const versionId = payload.versionId == null || payload.versionId === '' ? null : idOf(payload.versionId);
        // 버전이 여러 개 걸린 티켓은 앱에서 바꾸지 않는다 — 다른 버전을 실수로 지우지 않게.
        if ((await client.getIssueVersionIds(key)).length > 1) throw jiraError('multi');
        if (versionId !== null && !(await client.getVersions(projectOf(key))).some(version => version.id === versionId)) throw jiraError('stale');
        await client.updateIssueFields(key, { fixVersions: versionId ? [{ id: versionId }] : [] });
      } else if (what === 'due') {
        const due = payload.due == null || payload.due === '' ? null : payload.due;
        if (due !== null && !(typeof due === 'string' && JIRA_DAY_RE.test(due))) throw jiraError('value');
        await client.updateIssueFields(key, { duedate: due });
      } else {
        const versionId = idOf(payload.versionId);
        if (!(await client.getVersions(projectOf(key))).some(version => version.id === versionId)) throw jiraError('stale');
        const patch = {};
        if (typeof payload.name === 'string') patch.name = payload.name;
        if ('releaseDate' in payload) patch.releaseDate = payload.releaseDate === '' ? null : payload.releaseDate;
        await client.updateVersion(versionId, patch);
      }
    } catch (error) {
      const kind = writeKind(error);
      return { ok: false, error: MESSAGE[kind], kind };
    }
    // 바뀐 티켓의 낡은 캐시는 버린다 — 화면이 곧바로 `fresh=1`로 다시 읽는다.
    cache.delete(key);
    return { ok: true };
  }

  // ---------- 새로 만들기(BJCREATE) ----------

  // 새 프로젝트 화면이 하위 티켓 종류를 고를 때만 부른다. 조회라 파일은 쓰지 않고,
  // 프로젝트마다 60초만 메모리에 담아 둔다(같은 화면을 다시 열어도 지라를 또 부르지 않게).
  async function createMeta(projectKey) {
    if (typeof projectKey !== 'string' || !JIRA_PROJECT_RE.test(projectKey)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    const hit = metaCache.get(projectKey);
    if (hit && now() - hit.at < ttlMs) return { ok: true, connected: true, ...hit.value };
    try {
      const types = await createJiraClient({ settings, request, readToken: () => secret }).getCreateMeta(projectKey);
      const epic = epicTypeOf(types);
      const preferred = defaultChildType(types);
      const value = {
        project: projectKey,
        // 화면에는 id와 이름만 나간다 — 지라가 준 나머지 덩어리는 옮기지 않는다.
        epic: epic ? { id: epic.id, name: epic.name } : null,
        types: childTypesOf(types).map(({ id, name }) => ({ id, name })),
        defaultTypeId: preferred ? preferred.id : null,
      };
      metaCache.set(projectKey, { at: now(), value });
      return { ok: true, connected: true, ...value };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  // 이슈 하나를 만든다 — 같은 이슈가 결과 모름으로 남아 있으면 **보내기 전에 지라에서 먼저 찾는다**.
  // 돌려주는 것: { key, url } · 찾았으면 { key, url, found: true } · 못 만들었거나 모르면 { kind }.
  // 찾기 규칙: 같은 프로젝트·종류·부모·요약(글자 그대로)·보고자=나·모름이 난 시각 10분 전 이후 생성(findMade).
  //  - 모름이 난 뒤 30초 안이면 찾지도 만들지도 않는다(검색이 방금 만든 것을 아직 못 잡을 수 있다) → makeSettling
  //  - 하나 찾음 → 그 키를 쓰고 새로 만들지 않는다 · 없음 → 3초 쉬고 한 번 더 찾아 그래도 없을 때만 새로 만든다
  //  - 같은 이슈를 다른 요청이 지금 보내거나 찾는 중이면 → makeSettling
  //  - 둘 이상이거나 찾기도 실패 → 모름을 유지하고 만들지 않는다(자동으로 다시 하지 않는다) → makeUnsure
  async function makeOnce(client, issue) {
    const sig = JSON.stringify([issue.projectKey, issue.parentKey || null, issue.issueTypeId, issue.summary]);
    if (makeBusy.has(sig)) return { kind: 'makeSettling' };
    makeBusy.add(sig);
    try {
      return await makeOnceFree(client, issue, sig);
    } finally {
      makeBusy.delete(sig);
    }
  }
  async function makeOnceFree(client, issue, sig) {
    const since = unsureMade.get(sig);
    if (since !== undefined) {
      if (now() - since < UNSURE_SETTLE_MS) return { kind: 'makeSettling' };
      const look = () => client.findMade({ ...issue, minutes: (now() - since) / 60000 + UNSURE_LOOKBACK_MIN });
      let found;
      try {
        found = await look();
        // 0개면 검색이 아직 못 잡았을 수 있다 — 짧게 쉬고 한 번 더 본다.
        if (!found.length) { await sleep(UNSURE_RECHECK_MS); found = await look(); }
      } catch { return { kind: 'makeUnsure' }; }
      if (found.length > 1) return { kind: 'makeUnsure' };
      unsureMade.delete(sig);
      if (found.length === 1) return { ...found[0], found: true };
    }
    try {
      return await client.createIssue(issue);
    } catch (error) {
      const kind = makeKind(error, true);
      if (kind === 'makeUnsure') unsureMade.set(sig, now());
      return { kind };
    }
  }

  // 지라에 여러 이슈를 만드는 단 하나의 길. 화면이 미리 보기 + 확인 줄을 거친 뒤에만 부른다.
  // 앱 데이터 저장소(mutation-store·idempotent)는 건드리지 않는다 — 지라는 앱 파일이 아니다.
  // 순서는 늘 같다: ① 보낸 값 검증 → ② 같은 계획인지(60초) → ③ 만들 수 있는 종류를 **쓰기 직전에
  // 다시 읽어 대조** → ④ 에픽 → ⑤ 하위를 하나씩. 하위 하나가 실패해도 다음은 계속한다.
  // ④·⑤는 makeOnce를 거친다 — 전에 결과 모름으로 끝난 같은 이슈면 보내기 전에 지라에서 먼저 찾는다.
  async function create(body) {
    const plan = body && typeof body === 'object' && body.plan && typeof body.plan === 'object' ? body.plan : null;
    const bad = (kind) => ({ ok: false, error: MESSAGE[kind], kind });
    if (!plan) return bad('value');
    const projectKey = typeof plan.projectKey === 'string' ? plan.projectKey : '';
    if (!JIRA_PROJECT_RE.test(projectKey)) return bad('key');
    const asked = plan.epic && typeof plan.epic === 'object' ? plan.epic : null;
    if (!asked) return bad('value');
    // 에픽은 둘 중 하나다: 이미 있는 것(key)에 붙이거나, 요약을 주고 새로 만들거나.
    const epicKey = asked.key == null || asked.key === '' ? null : asked.key;
    if (epicKey !== null && (typeof epicKey !== 'string' || !JIRA_KEY_RE.test(epicKey) || projectOf(epicKey) !== projectKey)) return bad('key');
    const clean = (value) => {
      const summary = typeof value === 'string' ? value.trim() : '';
      return summary && summary.length <= JIRA_SUMMARY_MAX && !/[\r\n]/.test(summary) ? summary : null;
    };
    const epicSummary = epicKey ? null : clean(asked.summary);
    if (!epicKey && !epicSummary) return bad('value');
    const asking = Array.isArray(plan.children) ? plan.children : [];
    if (asking.length > JIRA_CREATE_MAX) return bad('tooMany');
    // 이미 있는 에픽에 붙이는데 만들 하위가 하나도 없으면 만들 것이 없다.
    if (epicKey && !asking.length) return bad('value');
    const children = asking.map(child => ({
      summary: clean(child && child.summary),
      issueTypeId: idOf(child && child.issueTypeId),
    }));
    if (children.some(child => !child.summary || !JIRA_ID_RE.test(child.issueTypeId))) return bad('value');
    if (!settings) return bad('off');
    const secret = token();
    if (!secret) return bad('off');

    const signature = JSON.stringify([projectKey, epicKey, epicSummary, children.map(child => [child.summary, child.issueTypeId])]);
    for (const [key, at] of madePlans) if (now() - at >= ttlMs) madePlans.delete(key);
    for (const [key, at] of unsureMade) if (now() - at >= UNSURE_KEEP_MS) unsureMade.delete(key);
    if (madePlans.has(signature)) return bad('duplicate');
    madePlans.set(signature, now());
    // 아무것도 만들지 못하고 끝난 길은 지문을 지운다 — 곧바로 다시 시도할 수 있어야 한다.
    // 에픽이 결과 모름으로 끝나도 계획 지문은 지운다: 다시 보내면 `duplicate`가 아니라 makeOnce가 지라에서 먼저 찾는다
    // (모름의 기억은 이슈 지문으로 unsureMade에 남아 있다).
    const give = (kind) => { madePlans.delete(signature); return bad(kind); };

    const client = createJiraClient({ settings, request, readToken: () => secret });
    let types;
    try {
      types = await client.getCreateMeta(projectKey);
    } catch (error) { return give(makeKind(error)); }
    // 고르개가 본 목록이 아니라 **지금** 목록으로 대조한다(그 사이 지라에서 바뀌었을 수 있다).
    const allowed = new Set(childTypesOf(types).map(type => type.id));
    if (children.some(child => !allowed.has(child.issueTypeId))) return give('typeStale');

    let epic;
    if (epicKey) {
      let brief;
      try {
        brief = await client.getIssueBrief(epicKey);
      } catch (error) { return give(makeKind(error)); }
      const epicType = epicTypeOf(types);
      if (!epicType) return give('epicType');
      if (brief.typeId !== epicType.id) return give('notEpic');
      // 이미 있는 에픽에 붙이는 것뿐이라 재배정하지 않는다 — 남의 에픽일 수 있다.
      // (그래서 "누가 나인지"도 여기서는 묻지 않는다 — attach는 mineId를 아예 안 쓴다.)
      epic = { key: epicKey, url: issueUrl(settings.siteUrl, epicKey), summary: brief.summary, created: false };
    } else {
      const epicType = epicTypeOf(types);
      if (!epicType) return give('epicType');
      // 새로 만드는 에픽은 무조건 나에게 배정한다(BJASSIGN) — 그래야 프로젝트 목록에도 바로 뜬다.
      // 누가 나인지는 이 모듈 상단의 `mineId`에 프로세스마다 한 번만 묻고 그대로 재사용한다
      // (`attention()`이 쓰는 것과 같은 값). 이 조회가 실패하면 아무것도 만들지 않은 채로 전체를 중단한다
      // — "만들어졌는데 담당자가 없는" 상태가 생기지 않게 하려는 것이다. 에픽을 만들기 **전에** 확인해서
      // 만든 뒤에 배정처만 실패로 남는 어중간한 상태를 피한다.
      if (!mineId) {
        try {
          mineId = await client.getMyAccountId();
        } catch (error) {
          // 토큰이 바뀌면 나도 달라질 수 있다 — 인증 실패면 다음번에 다시 묻는다(attention()과 같은 규칙).
          if (error && (error.status === 401 || error.status === 403)) mineId = null;
          return give(makeKind(error));
        }
      }
      const outcome = await makeOnce(client, { projectKey, issueTypeId: epicType.id, summary: epicSummary });
      // 에픽이 실패하거나 결과를 모르면 하위는 시작하지도 않는다(모름이면 그 에픽 지문은 unsureMade에 남는다).
      if (outcome.kind) return give(outcome.kind);
      epic = { key: outcome.key, url: outcome.url, summary: epicSummary, created: true, ...(outcome.found ? { found: true } : {}) };
      // 새로 만든 에픽만 나에게 배정한다. 실패해도 이미 만들어진 티켓이라 전체를 실패로 돌리지 않고
      // 그 이유만 결과에 얹는다 — 하위 티켓은 직군별로 사람이 나중에 따로 지정하므로 여기서는 배정하지 않는다.
      try {
        await client.assignIssue(epic.key, mineId);
        epic.assigned = true;
      } catch (error) {
        epic.assignError = MESSAGE[makeKind(error)];
      }
    }

    const results = [];
    for (const child of children) {
      const outcome = await makeOnce(client, { projectKey, issueTypeId: child.issueTypeId, summary: child.summary, parentKey: epic.key });
      if (outcome.kind) results.push({ summary: child.summary, error: MESSAGE[outcome.kind], kind: outcome.kind });
      else results.push({ summary: child.summary, key: outcome.key, url: outcome.url, ...(outcome.found ? { found: true } : {}) });
    }
    return {
      ok: true,
      connected: true,
      epic,
      children: results,
      made: results.filter(entry => entry.key).length + (epic.created ? 1 : 0),
      failed: results.filter(entry => entry.error).length,
    };
  }

  // 옮기기(BMOVE)가 대상이 실제로 에픽(계층 1)인지 확인할 때만 부른다. create()가 이미 있는 에픽에
  // 붙일 때 쓰는 대조(요약·종류 id를 다시 읽어 그 프로젝트의 에픽 타입과 견주기)를 그대로 재사용한다.
  // 조회뿐이라 파일도 캐시도 쓰지 않는다.
  async function checkEpic(key) {
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    if (!settings) return { ok: true, connected: false };
    const secret = token();
    if (!secret) return { ok: true, connected: false };
    const client = createJiraClient({ settings, request, readToken: () => secret });
    try {
      const [brief, types] = await Promise.all([client.getIssueBrief(key), client.getCreateMeta(projectOf(key))]);
      const epicType = epicTypeOf(types);
      return { ok: true, connected: true, epic: !!(epicType && brief.typeId === epicType.id), summary: brief.summary };
    } catch (error) {
      const kind = MESSAGE[error && error.kind] ? error.kind : 'other';
      return { ok: false, error: MESSAGE[kind], kind };
    }
  }

  return { read, list, listDone, attention, options, assignable, change, createMeta, create, checkEpic, connected: !!settings };
}

module.exports = {
  createJiraClient, createJiraApi, checkJiraAccount, jiraSettings, issueUrl, projectOf, countChildren, shapeChildren,
  shapeTransitions, shapeVersions, shapeListIssue, writeKind, makeKind, assignKind, assignMessage, josa,
  shapeCreateTypes, epicTypeOf, childTypesOf, defaultChildType,
  JIRA_KEY_RE, JIRA_TIMEOUT_MS, JIRA_CACHE_MS, JIRA_LIST_LIMIT, MY_ISSUES_JQL, JIRA_MESSAGE: MESSAGE,
  JIRA_DONE_DAYS, JIRA_DONE_MAX_DAYS, doneIssuesJql, JIRA_CREATE_MAX, JIRA_SUMMARY_MAX,
  UNSURE_KEEP_MS, UNSURE_SETTLE_MS, UNSURE_LOOKBACK_MIN, UNSURE_RECHECK_MS,
  adfText, attentionPreview, shapeAttention, attentionOrder,
  ATTENTION_JQL, ATTENTION_LIMIT, ATTENTION_PREVIEW_MAX,
};
