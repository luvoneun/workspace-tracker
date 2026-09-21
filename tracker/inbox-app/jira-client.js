// 지라 REST API를 앱 서버가 직접 읽는 얇은 모듈(AI를 거치지 않는다).
// Node 기본 `fetch`만 쓰고, 부르는 쪽이 `request`(fetch)와 `readToken`을 끼워 넣을 수 있다 —
// 테스트와 화면 확인은 가짜 fetch만 쓰고 실제 지라에는 절대 닿지 않는다.
//
// 지키는 것(테스트로 고정):
// - 토큰은 부를 때마다 파일에서 읽고 오래 들고 있지 않는다. 토큰·이메일은 오류 문구·돌려주는 값 어디에도 싣지 않는다.
// - siteUrl은 `https://`만, 키는 `^[A-Z][A-Z0-9]*-\d+$`만 받는다. 요청은 8초에서 끊는다.
// - 이 모듈은 아무것도 기록하지 않는다(로그도, 파일 쓰기도 없다).
const nodeFs = require('node:fs');
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
const CHANGE_KINDS = ['status', 'version', 'due', 'versionEdit'];

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
};

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
// 지라 키 `IO-48394`의 프로젝트는 `IO`다 — 버전 목록을 읽을 때 쓴다(따로 더 묻지 않는다).
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
  async function call(pathAndQuery, secret, { method = 'GET', send = null } = {}) {
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
    if (method !== 'GET') return null;
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
  // 옛 주소(`/search`)로 한 번만 물러선다.
  async function search(jql, secret) {
    const query = `jql=${encodeURIComponent(jql)}&fields=${LIST_FIELDS}&maxResults=${JIRA_LIST_LIMIT}`;
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
  async function listMyIssues(linkedKeys = []) {
    const secret = token();
    const mine = (((await search(MY_ISSUES_JQL, secret)) || {}).issues || [])
      .map(entry => shapeListIssue(entry, false)).filter(Boolean).slice(0, JIRA_LIST_LIMIT);
    const have = new Set(mine.map(issue => issue.key));
    const wanted = [...new Set((Array.isArray(linkedKeys) ? linkedKeys : [])
      .filter(key => typeof key === 'string' && JIRA_KEY_RE.test(key) && !have.has(key)))].slice(0, JIRA_LIST_LIMIT);
    if (!wanted.length) return mine;
    const rest = (((await search(`key in (${wanted.join(',')})`, secret)) || {}).issues || [])
      .map(entry => shapeListIssue(entry, true)).filter(Boolean)
      .filter(issue => !have.has(issue.key)).slice(0, JIRA_LIST_LIMIT);
    return [...mine, ...rest];
  }

  const wantKey = (key) => { if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) throw jiraError('key'); return key; };
  const wantId = (id) => { const value = idOf(id); if (!JIRA_ID_RE.test(value)) throw jiraError('value'); return value; };

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

  return { getIssueOverview, listMyIssues, getTransitions, getVersions, getIssueVersionIds, transition, updateIssueFields, updateVersion };
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

// 서버가 쓰는 겉면: 설정 확인 + 키별 60초 메모리 캐시 + 화면에 그대로 보여 줄 오류 문구.
// 파일은 아무것도 쓰지 않는다(조회는 기록을 남기지 않는다).
function createJiraApi({ config, request, readFile = nodeFs.readFileSync, now = Date.now, ttlMs = JIRA_CACHE_MS } = {}) {
  const settings = jiraSettings(config);
  const cache = new Map();

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

  // 지라에 쓰는 단 하나의 길. 화면은 확인 절차를 거친 뒤에만 부르고,
  // 여기서는 보낸 값을 다시 검증하고 id를 **쓰기 직전에 다시 조회해 대조**한다.
  // 앱 데이터 저장소(mutation-store·idempotent)는 건드리지 않는다 — 지라는 앱 파일이 아니다.
  async function change(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const key = payload.key;
    const what = payload.kind;
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) return { ok: false, error: MESSAGE.key, kind: 'key' };
    if (!CHANGE_KINDS.includes(what)) return { ok: false, error: MESSAGE.value, kind: 'value' };
    if (!settings) return { ok: false, error: MESSAGE.off, kind: 'off' };
    const secret = token();
    if (!secret) return { ok: false, error: MESSAGE.off, kind: 'off' };
    const client = createJiraClient({ settings, request, readToken: () => secret });
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

  return { read, list, options, change, connected: !!settings };
}

module.exports = {
  createJiraClient, createJiraApi, jiraSettings, issueUrl, projectOf, countChildren, shapeChildren,
  shapeTransitions, shapeVersions, shapeListIssue, writeKind,
  JIRA_KEY_RE, JIRA_TIMEOUT_MS, JIRA_CACHE_MS, JIRA_LIST_LIMIT, MY_ISSUES_JQL, JIRA_MESSAGE: MESSAGE,
};
