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
const JIRA_TIMEOUT_MS = 8000;
const JIRA_CACHE_MS = 60 * 1000;
const JIRA_CHILD_LIMIT = 100;
// 띠 카드가 쓰는 값만 받아 온다 — 본문·댓글까지 끌고 오지 않는다.
const ISSUE_FIELDS = 'summary,status,issuetype,assignee,duedate,fixVersions,subtasks';

// 지라가 주는 범주 열쇠는 셋뿐이다. 모르는 값은 `진행`으로 본다(상태 이름은 그대로 보여 준다).
const CATEGORY = { new: 'todo', indeterminate: 'doing', done: 'done' };

// 화면에 그대로 나가는 문구다(해요체). 지라가 준 원문·주소·토큰은 절대 섞지 않는다.
const MESSAGE = {
  key: '지라 번호를 확인해 주세요.',
  auth: '지라 토큰을 확인해 주세요.',
  notfound: '지라에서 이 티켓을 찾지 못했어요.',
  network: '지라에 연결하지 못했어요.',
  other: '지라에 연결하지 못했어요.',
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

// 지라 응답에서 띠 카드가 쓰는 값만 뽑는다. 모르는 모양이 와도 빈 값으로 흐르게 한다.
function shapeIssue(siteUrl, key, body, children) {
  const fields = (body && body.fields) || {};
  const status = fields.status || {};
  const versions = Array.isArray(fields.fixVersions) ? fields.fixVersions : [];
  const text = value => (typeof value === 'string' ? value : '');
  const day = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  return {
    key,
    url: issueUrl(siteUrl, key),
    summary: text(fields.summary),
    type: text(fields.issuetype && fields.issuetype.name),
    status: { name: text(status.name), category: CATEGORY[status.statusCategory && status.statusCategory.key] || 'doing' },
    assignee: text(fields.assignee && fields.assignee.displayName) || null,
    due: day(fields.duedate),
    versions: versions.map(version => ({
      id: version && version.id != null ? String(version.id) : '',
      name: text(version && version.name),
      releaseDate: day(version && version.releaseDate),
      released: !!(version && version.released),
    })),
    children,
  };
}

// 하위 티켓은 개수만 센다(목록은 3단계 몫이다). 하나도 없으면 null — 화면이 진행률 줄을 아예 그리지 않는다.
function countChildren(issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) return null;
  const done = list.filter(item => CATEGORY[item && item.fields && item.fields.status && item.fields.status.statusCategory && item.fields.status.statusCategory.key] === 'done').length;
  return { total: list.length, done };
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

  async function call(pathAndQuery, secret) {
    let response;
    try {
      response = await request(`${settings.siteUrl}${pathAndQuery}`, {
        headers: {
          // 지라가 요구하는 Basic 인증. 이 값은 만들어 바로 보내고 어디에도 남기지 않는다.
          Authorization: `Basic ${Buffer.from(`${settings.email}:${secret}`).toString('base64')}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
      });
    } catch {
      // 끊긴 연결·시간 초과. 원인 문구에 주소·토큰이 섞이지 않게 우리 문구로만 알린다.
      throw jiraError('network');
    }
    if (response.status === 401 || response.status === 403) throw jiraError('auth');
    if (response.status === 404) throw jiraError('notfound', 404);
    if (!response.ok) throw jiraError('other');
    try {
      return await response.json();
    } catch {
      throw jiraError('other');
    }
  }

  // 에픽의 하위는 `subtasks`에 안 담길 수 있어서 JQL로 따로 센다.
  // 새 주소(`/search/jql`)가 없는 지라에서는 옛 주소(`/search`)로 한 번만 물러선다.
  async function children(key, secret, subtasks) {
    const query = `jql=${encodeURIComponent(`parent=${key}`)}&fields=status&maxResults=${JIRA_CHILD_LIMIT}`;
    try {
      let body;
      try {
        body = await call(`/rest/api/3/search/jql?${query}`, secret);
      } catch (error) {
        if (error.status !== 404) throw error;
        body = await call(`/rest/api/3/search?${query}`, secret);
      }
      const counted = countChildren(body && body.issues);
      if (counted) return counted;
    } catch {
      // 하위 집계는 곁들이는 값이다 — 실패해도 카드 전체를 오류로 만들지 않는다.
    }
    return countChildren(subtasks);
  }

  // 화면이 쓰는 한 덩어리. 실패는 `kind`가 붙은 Error로 던진다.
  async function getIssueOverview(key) {
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) throw jiraError('key');
    const secret = token();
    const body = await call(`/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`, secret);
    return shapeIssue(settings.siteUrl, key, body, await children(key, secret, body && body.fields && body.fields.subtasks));
  }

  return { getIssueOverview };
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

  return { read, connected: !!settings };
}

module.exports = { createJiraClient, createJiraApi, jiraSettings, issueUrl, countChildren, JIRA_KEY_RE, JIRA_TIMEOUT_MS, JIRA_CACHE_MS, JIRA_MESSAGE: MESSAGE };
