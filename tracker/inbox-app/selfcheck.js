// 설정 › 앱 `점검하기`(GET /api/selfcheck, WP-K)의 서버 쪽 한 벌 — 설치·연동·자동화를 한 번에 확인하고,
// 문제 있는 줄에만 고치는 법을 붙인다.
//
// 지키는 것(테스트로 고정):
// - **연결한 것만** 본다. 연결 안 한 연동은 결과에서 빼고 이름만 `skipped`로 준다(문제 수에 세지 않는다).
//   "연결했나"는 연동 탭의 `settingsIntgConnected`(settings-ui.js)와 같은 기준이다(아래 connectedFlags).
// - "멈췄나"는 연동 탭 요약·톱니바퀴의 빨간 점과 **같은 함수**(server.js의 integrationAlerts·fetchState*)를 받아 쓴다.
//   "늦었나"(주황)는 화면이 같은 함수(app.js의 syncLag)에 이 응답의 `sync`를 넣어 정한다 — 여기서 따로 만들지 않는다.
// - 바깥(슬랙·지라·캘린더 비밀 주소)에는 **읽기 확인만** 한다(auth.test·conversations.info·myself·주소 한 번 읽기).
//   항목마다 6초, 전체 12초까지만 기다리고, 넘긴 것은 `확인 못 함`이다. 모두 네트워크에서 막혔으면 `offline`으로 묶는다.
// - 프로세스를 띄우지 않는다(git도 부르지 않는다 — 파일만 읽는다). 파일을 쓰지 않는다.
// - 토큰·비밀 주소·이메일은 응답에 싣지 않는다. 경로는 `~`로 줄인다. 채널 이름·지라 표시 이름은 화면용 `detail`에만 싣고,
//   결과 복사용 `copy`에는 개수·고정 문구만 둔다.
// - 같은 결과를 30초 동안 들고 있는다(그 안에 다시 부르면 같은 답 — 화면도 30초에 한 번만 다시 점검한다).

const fs = require('node:fs');
const path = require('node:path');

const ITEM_TIMEOUT_MS = 6000;
const TOTAL_TIMEOUT_MS = 12000;
const CACHE_MS = 30 * 1000;
const NODE_MIN_MAJOR = 18;

// 항상 있어야 하는 launchd 등록(setup.sh가 늘 쓴다)과, 켠 연동에 따라 더 있어야 하는 것.
const BASE_AGENTS = ['server', 'update', 'apply', 'data-backup'];
const INTEGRATION_AGENTS = {
  slack: ['slack-capture', 'slack-capture-now'],
  calendarClaude: ['calendar-sync', 'calendar-sync-now'],
  calendarMac: ['mac-calendar', 'mac-calendar-now'],
  notes: ['tiro-sync'],
};

// 맥 캘린더 읽기의 실패 한 줄(`⚠️ 이유 — 고치는 법`, calendar-mac.js의 WORDS) → 점검 줄의 이유·고치는 법.
function macCalendarWhy(summary) {
  const text = String(summary || '').replace(/^⚠️\s*/, '');
  const at = text.indexOf(' — ');
  if (!/^⚠️/.test(String(summary || '')) || at < 0) return null;
  return { detail: text.slice(0, at), fix: text.slice(at + 3) };
}

const SKIP_NAMES = { slack: '슬랙', jira: '지라', calendar: '캘린더', notes: '회의록' };

// 고치는 법 문구(해요체). 업데이트 파일은 이름만 쓰지 않는다 — 무엇인지 + 실제 경로의 한 줄 명령 + Finder 길(추가 A).
const WORDS = {
  updateFile: '업데이트 파일(앱을 새로 받고 다시 켜 주는 파일)을 한 번 실행해 주세요',
  reconnectSlack: '설정 › 연동 › 슬랙 ⋯ › 다시 연결 — OAuth & Permissions 화면의 User OAuth Token(xoxp-)을 붙여 주세요',
  // 새 방식(슬랙 연결 버튼·자동 갱신)은 토큰을 찾지 않는다 — 버튼 한 번이다.
  reconnectSlackOAuth: '설정 › 연동 › 슬랙 카드의 다시 연결을 누르고 슬랙에서 허용해 주세요 — 토큰을 다시 찾을 필요는 없어요',
  refreshLater: '기다리면 앱이 다시 해 봐요 — 계속되면 회사 네트워크(VPN)를 확인해 주세요',
  // 갱신이 만료 뒤에도 이어지지 않을 때 — 다시 연결이 먼저고, 그래도 안 되면 옛 길(토큰 붙여 넣기)이 남아 있다.
  // 슬랙에 닿지 못해 이어 가지 못할 때 — 다시 연결을 권하지 않는다(연결이 돌아오면 앱이 알아서 잇는다).
  stalledOffline: '인터넷 연결을 확인해 주세요 — 연결이 돌아오면 앱이 알아서 이어 가요. 회사 네트워크(VPN)를 쓰면 연결을 확인해 주세요',
  reconnectSlackStalled: '설정 › 연동 › 슬랙 카드의 다시 연결을 눌러 주세요 — 안 되면 카드의 고급: 토큰 직접 붙여 넣기로 연결할 수 있어요',
  moreScopes: '설정 › 연동 › 슬랙 카드 ⋯ › 다시 연결에서 슬랙의 허용을 한 번 더 눌러 주세요 — 권한이 빠지면 일부 채널을 못 읽거나 새 채널을 못 만들어요',
  reconnectJira: '설정 › 연동 › 지라 ⋯ › 다시 연결에서 토큰을 새로 붙여 주세요',
  reconnectCalendar: '비밀 주소가 바뀌었을 수 있어요 — 설정 › 연동 › 캘린더 ⋯ › 다시 연결에서 새 주소를 붙여 주세요',
  pickChannels: '설정 › 연동 › 슬랙 ⋯ › 채널 고르기에서 다시 체크하면 새로 만들어 줘요',
  unreachable: '잠시 뒤 다시 점검해 주세요 — 회사 네트워크(VPN)를 쓰면 연결을 확인해 주세요',
  recentLog: kind => `설정 › 연동 › ${kind} ⋯ › 최근 기록에서 이유를 보고, 카드의 다시 시도를 눌러 주세요`,
  claudeLogin: '① 아래 명령을 복사해 터미널에서 실행 → 브라우저에서 허용하면 긴 토큰(sk-ant-…)이 나와요 ② 그 토큰을 복사해 설정 › 연동의 멈춘 카드(`Claude Code 로그인이 풀렸어요`) 칸에 붙여 저장 → 카드의 다시 시도, 그다음 여기서 다시 점검',
  claudeInstall: 'Claude Code를 설치하고 터미널에서 claude → /login으로 로그인해 주세요(docs/연동.md)',
  node: `Node ${NODE_MIN_MAJOR} 이상으로 올린 뒤 업데이트 파일을 다시 실행해 주세요`,
};
// 갱신 실패를 사람 말 한 조각으로 — 슬랙이 준 오류 이름(소문자·숫자·밑줄만 통과한 낱말, 값 없음)이 있으면 그것을 그대로 보인다.
const FAILURE_REASONS = { network: '슬랙에 닿지 못함', http: '슬랙 서버 오류', bad_response: '슬랙의 답을 읽지 못함', write: '저장하지 못함' };
function failureWords(failure) {
  if (!failure) return '';
  const code = /^[a-z0-9_]{1,60}$/.test(String(failure.code || '')) ? failure.code : '';
  return code ? `슬랙 오류: ${code}` : (FAILURE_REASONS[failure.reason] || '');
}
// 터미널에서는 이 명령 하나만 — 나온 토큰은 앱의 칸에 붙인다(서버가 0600 파일로 저장, docs/연동.md "OAuth session expired" 절).
const CLAUDE_TOKEN_COMMAND = 'claude setup-token';

// 경로를 `~`로. 홈 밖이면 그대로.
function tilde(value, home) {
  const text = String(value || '');
  const base = String(home || '');
  if (base && (text === base || text.startsWith(`${base}/`))) return `~${text.slice(base.length)}`;
  return text;
}
// `bash <경로>` 한 줄 — 띄어쓰기 같은 글자가 있으면 `~/` 뒤를 작은따옴표로 감싼다.
function shellPath(shown) {
  const text = String(shown || '');
  if (/^[~\w./가-힣-]+$/.test(text)) return text;
  const rest = text.startsWith('~/') ? text.slice(2) : text;
  const quoted = `'${rest.replace(/'/g, `'\\''`)}'`;
  return text.startsWith('~/') ? `~/${quoted}` : quoted;
}
function updateFix(updateFile, lead = '') {
  return {
    text: lead ? `${lead} — ${WORDS.updateFile}` : WORDS.updateFile,
    command: `bash ${shellPath(updateFile)}`,
    finder: updateFile,
  };
}

// 로그 시각(`YYYY-MM-DD HH:MM:SS`, 이 맥의 시각)이나 ISO → `오늘 10:05` · `어제 10:05` · `9월 20일 10:05`.
function whenText(value, now) {
  let at = null;
  const log = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(value || ''));
  if (log) at = new Date(Number(log[1]), Number(log[2]) - 1, Number(log[3]), Number(log[4]), Number(log[5]));
  else if (value) { const parsed = new Date(value); if (!Number.isNaN(parsed.getTime())) at = parsed; }
  if (!at) return '';
  const today = new Date(now);
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(at)) / 86400000);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (diff === 0) return `오늘 ${time}`;
  if (diff === 1) return `어제 ${time}`;
  return `${at.getMonth() + 1}월 ${at.getDate()}일 ${time}`;
}

// 다음 갱신까지 — `2시간 뒤` · `40분 뒤` · `곧`(이미 갱신할 때가 됐다).
function untilText(at, now) {
  const left = Number(at) - now;
  if (!Number.isFinite(left) || left < 60 * 1000) return '곧';
  // 시간은 반올림한다 — 방금 갱신해 7시간 59분 남았을 때 `7시간 뒤`가 아니라 `8시간 뒤`로 읽히게.
  const hours = left >= 60 * 60 * 1000 ? Math.round(left / (60 * 60 * 1000)) : 0;
  return hours >= 1 ? `${hours}시간 뒤` : `${Math.floor(left / (60 * 1000))}분 뒤`;
}

// 연동 탭 카드의 "연결됐나"(settings-ui.js의 settingsIntgConnected)와 같은 기준 — 같은 입력에 같은 답(테스트로 고정).
function connectedFlags(state) {
  const slack = (state && state.slack) || {};
  const jira = (state && state.jira) || {};
  const channels = slack.channels || {};
  const slackOn = Object.keys(channels).filter(key => channels[key] && channels[key].id);
  return {
    slack: !!(slack.enabled && slack.hasToken && slackOn.length),
    jira: !!(jira.enabled && jira.hasToken && jira.siteUrl),
    calendar: !!(state && state.calendar && state.calendar.enabled),
    notes: !!(state && state.meetingNotes && state.meetingNotes.mode === 'tiro'),
  };
}

// 제한 시간 안에 끝나면 { value } / 던지면 { error } / 넘기면 { timeout: true }.
function within(promiseFn, ms) {
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, ms)); });
  let run;
  try { run = Promise.resolve(promiseFn()); } catch (error) { run = Promise.reject(error); }
  return Promise.race([run.then(value => ({ value }), error => ({ error })), late]).finally(() => clearTimeout(timer));
}

// 바깥에 닿지 못한 것(네트워크·끊김)인가 — 각 확인 함수가 남기는 표지로만 가른다(원문은 보지 않는다).
const netError = {
  slackToken: (error, messages) => !!error && !error.code && error.message === messages.slackReach,
  slackChannel: error => !!error && error.code === 'slack_unreachable',
  jira: result => !!result && result.kind === 'network',
  ical: error => !!error && !error.auth && error.net === true,
};

function createSelfcheck(deps) {
  let held = null;   // { at, result }
  let running = null;

  const now = () => (deps.now ? deps.now() : Date.now());

  async function build() {
    const startedAt = now();
    // 시간 제한은 테스트만 짧게 끼운다(deps.itemTimeoutMs·totalTimeoutMs).
    const deadline = startedAt + (deps.totalTimeoutMs || TOTAL_TIMEOUT_MS);
    const left = () => Math.min(deps.itemTimeoutMs || ITEM_TIMEOUT_MS, deadline - now());
    const home = deps.home;
    const items = [];
    const external = [];   // 바깥 확인을 시도한 항목 — { item, net }
    const add = (item) => { items.push(item); return item; };
    const updateFile = deps.updateFile();

    // ---------- 앱 버전 — 이미 가진 값만(원격에 새로 묻지 않는다) ----------
    const version = deps.version();
    const offer = deps.updateOffer() || {};
    if (!version) add({ key: 'version', label: '앱 버전', state: 'unknown', detail: '버전을 읽지 못했어요' });
    else if (offer.available) {
      const next = offer.label && offer.label !== 'main' ? `새 버전 ${offer.label}이 있어요` : '새 버전이 있어요(main)';
      add({ key: 'version', label: '앱 버전', state: 'warn', detail: `v${version} · ${next}`, fix: { text: '설정 › 앱 › 버전 줄의 업데이트 받기를 눌러 주세요' } });
    } else if (!offer.checkedAt) add({ key: 'version', label: '앱 버전', state: 'unknown', detail: `v${version} · 최신인지는 아직 알 수 없어요` });
    else add({ key: 'version', label: '앱 버전', state: 'ok', detail: `v${version} · 최신이에요` });

    // ---------- 설치 위치 ----------
    const where = deps.installPlace();
    const shown = tilde(where.real, home);
    if (where.playio) {
      add({ key: 'install', label: '설치 위치', state: 'bad', detail: `${shown} · 회사(playio) 폴더 안이에요`, fix: updateFix(updateFile, '업데이트 파일이 ~/workspace로 옮겨 줘요') });
    } else if (where.synced) {
      add({
        key: 'install', label: '설치 위치', state: 'warn', detail: `${shown} · 바탕화면·문서·iCloud 폴더는 느리거나 파일이 꼬일 수 있어요`,
        fix: { text: '앱을 닫고 이 폴더를 ~/workspace로 옮긴 뒤, 옮긴 폴더의 업데이트 파일(앱을 새로 받고 다시 켜 주는 파일)을 한 번 실행해 주세요', command: 'bash ~/workspace/업데이트.command', finder: '~/workspace/업데이트.command' },
      });
    } else if (where.other) {
      add({ key: 'install', label: '설치 위치', state: 'warn', detail: `${shown} · 자동 실행은 한 벌 더 있는 ${tilde(where.other, home)}를 써요`, fix: updateFix(updateFile, '지금 여는 이 폴더를 쓰게 하려면') });
    } else {
      add({ key: 'install', label: '설치 위치', state: 'ok', detail: shown || '알 수 없어요' });
    }

    // ---------- Node ----------
    const node = String(deps.nodeVersion || '');
    const major = Number((/^v?(\d+)/.exec(node) || [])[1]);
    add(Number.isFinite(major) && major >= NODE_MIN_MAJOR
      ? { key: 'node', label: 'Node', state: 'ok', detail: `${node} (${NODE_MIN_MAJOR} 이상이면 돼요)` }
      : { key: 'node', label: 'Node', state: node ? 'bad' : 'unknown', detail: node ? `${node} — ${NODE_MIN_MAJOR}보다 낮아요` : '버전을 읽지 못했어요', ...(node ? { fix: { text: WORDS.node } } : {}) });

    // ---------- 연결한 것 ----------
    const config = deps.config();
    const state = deps.readIntegrations(config);
    const on = connectedFlags(state);
    const calendarIcal = on.calendar && state.calendar && state.calendar.source === 'ical';
    const calendarMac = on.calendar && state.calendar && state.calendar.source === 'mac';
    const skipped = Object.keys(SKIP_NAMES).filter(key => !on[key]).map(key => SKIP_NAMES[key]);

    // ---------- 자동 실행 등록(plist가 있는지만) ----------
    const wanted = [...BASE_AGENTS,
      ...(on.slack ? INTEGRATION_AGENTS.slack : []),
      ...(on.calendar && !calendarIcal ? (calendarMac ? INTEGRATION_AGENTS.calendarMac : INTEGRATION_AGENTS.calendarClaude) : []),
      ...(on.notes ? INTEGRATION_AGENTS.notes : [])];
    const missing = wanted.filter(name => !deps.agentInstalled(name));
    const integrationOnly = missing.every(name => !BASE_AGENTS.includes(name));
    if (!missing.length) add({ key: 'agents', label: '자동 실행 등록', state: 'ok', detail: `${wanted.length}개 모두 등록돼 있어요` });
    else if (!deps.managed && missing.length === wanted.length) add({ key: 'agents', label: '자동 실행 등록', state: 'unknown', detail: '개발용 서버라 아직 알 수 없어요' });
    else if (integrationOnly && deps.agentInstalled('apply') && !deps.applyFailing()) add({ key: 'agents', label: '자동 실행 등록', state: 'unknown', detail: '방금 켠 연동을 등록하는 중이에요 — 잠시 뒤 다시 점검해 주세요' });
    else add({ key: 'agents', label: '자동 실행 등록', state: 'bad', detail: `${wanted.length}개 중 ${missing.length}개가 등록돼 있지 않아요 (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' 외' : ''})`, fix: updateFix(updateFile) });

    // 멈췄나 — 연동 탭·톱니바퀴와 같은 함수.
    const automations = deps.automations();
    const alerts = deps.alerts(config, automations);
    const automation = key => automations.find(one => one.key === key) || null;
    const fetchState = {
      slack: deps.fetchStateSlack ? deps.fetchStateSlack(automation('slack')) : deps.fetchStateAutomation(automation('slack'), deps.slackAuthRe),
      calendar: calendarIcal ? deps.fetchStateLive(deps.calendarFailure(), deps.calendarHistory ? deps.calendarHistory() : []) : deps.fetchStateAutomation(automation('calendar')),
      notes: deps.fetchStateAutomation(automation('tiro')),
      jira: deps.fetchStateLive(deps.jiraFailure(), deps.jiraHistory ? deps.jiraHistory() : []),
    };

    // ---------- Claude Code(Claude가 필요한 연동을 켰을 때만) — 설치는 파일이 있는지, 로그인은 최근 기록 기준 ----------
    const claudeUsers = [
      // 원문 그대로(slack.tidy='raw')는 Claude 없이 수집하므로 Claude가 필요한 연동으로 세지 않는다.
      on.slack && ((config && config.slack) || {}).tidy !== 'raw' ? { key: 'slack', name: '슬랙 수집' } : null,
      on.calendar && !calendarIcal && !calendarMac ? { key: 'calendar', name: '캘린더 동기화' } : null,
      on.notes ? { key: 'tiro', name: '미팅 노트 가져오기', stateKey: 'notes' } : null,
    ].filter(Boolean);
    let claudeBad = false;
    if (claudeUsers.length) {
      if (!deps.claudeInstalled()) {
        claudeBad = true;
        add({ key: 'claude', label: 'Claude Code', state: 'bad', detail: '이 맥에서 claude를 찾지 못했어요', fix: { text: WORDS.claudeInstall } });
      } else {
        const loginFail = claudeUsers.map(user => ({ user, st: fetchState[user.stateKey || user.key] })).find(one => one.st && one.st.claudeAuth);
        const runs = claudeUsers.map((user) => {
          const auto = automation(user.key);
          const run = auto && Array.isArray(auto.events) ? auto.events.find(event => event.kind === 'run') : null;
          return run ? { user, time: run.time } : null;
        }).filter(Boolean).sort((a, b) => String(b.time).localeCompare(String(a.time)));
        if (loginFail) {
          claudeBad = true;
          const at = whenText(loginFail.st.failedAt, now());
          add({ key: 'claude', label: 'Claude Code 로그인', state: 'bad', detail: `최근 ${loginFail.user.name}이 "로그인이 풀렸어요"로 실패했어요${at ? ` · ${at} 기준` : ''}`, fix: { text: WORDS.claudeLogin, command: CLAUDE_TOKEN_COMMAND } });
        } else if (runs.length) {
          add({ key: 'claude', label: 'Claude Code 로그인', state: 'ok', detail: `최근 기록 기준 · ${whenText(runs[0].time, now())} ${runs[0].user.name} 성공` });
        } else {
          add({ key: 'claude', label: 'Claude Code 로그인', state: 'unknown', detail: '아직 알 수 없어요 — Claude가 한 번 돌면 최근 기록으로 알려 줘요' });
        }
      }
    }

    // 슬랙이 새 방식(슬랙 연결 버튼·자동 갱신)인가 — 옛 방식이면 아래 슬랙 줄은 예전 그대로다.
    const slackOAuthOn = on.slack && !!deps.slackOAuth && (deps.slackOAuth(config) || {}).auth === 'oauth';

    // 연동 카드의 "멈춤"(alerts) 한 줄 — 원인이 이미 다른 줄(토큰·Claude)에 있으면 그 줄을 가리키고 문제 수에 한 번만 센다.
    const stopped = (kind, name, authItem = null) => {
      const st = fetchState[kind] || {};
      if (st.claudeAuth && !st.auth && claudeBad) return { state: 'bad', sameAs: 'claude', detail: `Claude Code 로그인이 풀려서 멈췄어요 — 위 Claude Code 줄대로 고치면 돼요` };
      if (st.auth && authItem && authItem.state === 'bad') return { state: 'bad', sameAs: authItem.key, detail: kind === 'slack' && slackOAuthOn ? '연결이 풀려서 멈췄어요 — 위 슬랙 연결 줄대로 고치면 돼요' : '토큰 문제로 멈췄어요 — 위 토큰 줄대로 고치면 돼요' };
      if (st.auth) return { state: 'bad', detail: kind === 'calendar' ? '비밀 주소를 읽을 수 없어요' : '토큰이 만료됐거나 권한이 없어요', fix: { text: kind === 'calendar' ? WORDS.reconnectCalendar : kind === 'jira' ? WORDS.reconnectJira : slackOAuthOn ? WORDS.reconnectSlackOAuth : WORDS.reconnectSlack } };
      const at = whenText(st.failedAt, now());
      return { state: 'bad', detail: `최근 읽기가 실패했어요${at ? ` · ${at}` : ''}`, fix: { text: WORDS.recentLog(name) } };
    };

    // ---------- 슬랙 ----------
    let slackTokenItem = null;
    if (on.slack) {
      // 지금 쓸 토큰 — 새 방식이면 만료가 가까울 때 갱신한 뒤의 것이다(한 줄 사본만 읽지 않는다). 못 받으면 빈 글자.
      const got = await within(() => deps.slackToken(config), left());
      const token = typeof got.value === 'string' ? got.value : '';
      // 갱신 상태는 토큰을 받은 **뒤에** 읽는다(방금 갱신했거나 실패했으면 그 결과가 보이게). 값 없이 시각·권한·실패 종류뿐이다.
      const oauth = slackOAuthOn ? (deps.slackOAuth(config) || {}) : null;
      const lost = !!oauth && (oauth.connected === false || !!(oauth.lastFailure && oauth.lastFailure.kind === 'reconnect'));
      const lostItem = { state: 'bad', detail: '연결이 풀렸어요', fix: { text: WORDS.reconnectSlackOAuth } };
      // 갱신이 만료 뒤에도 이어지지 않는다(연동 탭 `멈췄어요`·빨간 점과 같은 값). 원인을 알아야 고친다 — 슬랙이 준 오류 이름
      // (값 없는 낱말)이나 실패 종류를 같이 말한다.
      const stalled = !lost && !!oauth && oauth.stalled === true;
      // 슬랙이 거절한 것이 아니라 닿지 못해서면(네트워크·슬랙 장애) 말과 고치는 법이 다르다 — 예전 `슬랙에 닿지 못했어요` 갈래와 같은 쪽.
      const offline = stalled && oauth.stalledBy === 'unreachable';
      const why = failureWords(oauth && oauth.lastFailure);
      slackTokenItem = add({ key: 'slack_token', label: oauth ? '슬랙 연결' : '슬랙 토큰', state: 'unknown', detail: '확인 못 함' });
      // 다시 연결해야 하는 것을 이미 알면 슬랙에 묻지 않는다(죽은 토큰으로 두드리지 않는다).
      const checked = lost || stalled ? null : await within(() => deps.slackTokenCheck(token), left());
      if (lost) Object.assign(slackTokenItem, lostItem);
      else if (offline) { Object.assign(slackTokenItem, { state: 'bad', detail: '슬랙에 닿지 못하고 있어요', fix: { text: WORDS.stalledOffline } }); external.push({ item: slackTokenItem, net: true }); }
      else if (stalled) Object.assign(slackTokenItem, { state: 'bad', detail: `슬랙 연결을 이어 가지 못하고 있어요${why ? ` (${why})` : ''}`, fix: { text: WORDS.reconnectSlackStalled } });
      else if (checked.timeout) slackTokenItem.detail = '확인 못 함 — 슬랙이 제시간에 답하지 않았어요';
      else if (checked.value && oauth) {
        const retrying = !!(oauth.lastFailure && oauth.lastFailure.kind === 'retry');
        const code = retrying && oauth.lastFailure.code ? ` (${why})` : '';
        Object.assign(slackTokenItem, retrying
          ? { state: 'warn', detail: `갱신이 잠시 안 돼요 — 곧 다시 해 봐요${code}`, fix: { text: WORDS.refreshLater } }
          : { state: 'ok', detail: `자동 갱신 · 다음 갱신 ${untilText(oauth.nextRefreshAt, now())}` });
        external.push({ item: slackTokenItem, net: false });
      } else if (checked.value) {
        Object.assign(slackTokenItem, { state: 'ok', detail: 'User OAuth Token(xoxp-) · 연결돼요' });
        external.push({ item: slackTokenItem, net: false });
      } else if (oauth && !netError.slackToken(checked.error || {}, deps.messages)) {
        // 갱신 기록은 멀쩡한데 슬랙이 토큰을 거절했다(슬랙에서 앱을 지웠거나 권한을 거둠) — 고치는 법은 같다.
        Object.assign(slackTokenItem, lostItem);
        external.push({ item: slackTokenItem, net: false });
      } else {
        const error = checked.error || {};
        const net = netError.slackToken(error, deps.messages);
        const shape = ['bot_token', 'app_token', 'not_user_token'].includes(error.code);
        Object.assign(slackTokenItem, net
          ? { state: 'bad', detail: '슬랙에 닿지 못했어요', fix: { text: WORDS.unreachable } }
          : { state: 'bad', detail: shape ? String(error.message || '토큰 모양이 맞지 않아요') : '토큰이 만료됐거나 권한이 없어요', fix: { text: WORDS.reconnectSlack } });
        external.push({ item: slackTokenItem, net });
      }

      // 받은 권한 — 새 방식에서 갱신 정보가 있을 때만(옛 방식은 토큰이 가진 권한을 여기서 알 수 없다). 빠진 것이 있으면 이름을 말한다.
      if (oauth && oauth.expiresAt) {
        const missing = Array.isArray(oauth.missingScopes) ? oauth.missingScopes.map(String) : [];
        const count = Array.isArray(oauth.scopes) ? oauth.scopes.length : 0;
        add(missing.length
          ? { key: 'slack_scopes', label: '받은 권한', state: 'warn', detail: `빠진 권한: ${missing.join(', ')}`, fix: { text: WORDS.moreScopes } }
          : { key: 'slack_scopes', label: '받은 권한', state: 'ok', detail: `${count}개 · 필요한 권한을 모두 받았어요` });
      }

      const channels = (state.slack && state.slack.channels) || {};
      const onKeys = Object.keys(channels).filter(key => channels[key] && channels[key].id);
      const channelItem = add({ key: 'slack_channels', label: '슬랙 채널', state: 'unknown', detail: '확인 못 함' });
      // 갱신이 잠시 안 되는 중(warn)이어도 지금 토큰은 쓸 수 있다 — 채널은 그대로 확인한다.
      if (!['ok', 'warn'].includes(slackTokenItem.state)) {
        channelItem.detail = slackTokenItem.state === 'unknown' ? '확인 못 함' : offline ? '슬랙에 닿은 뒤 확인할 수 있어요' : oauth ? '다시 연결한 뒤 확인할 수 있어요' : '토큰을 고친 뒤 확인할 수 있어요';
      } else {
        const answers = await Promise.all(onKeys.map(key => within(() => deps.slackCheckChannel(token, channels[key].id), left())));
        const count = onKeys.length;
        const names = onKeys.map(key => String(channels[key].name || '').trim()).filter(Boolean);
        const first = names[0] || '';
        const gone = answers.map((answer, index) => (answer.error && answer.error.code === 'channel_not_found' ? onKeys[index] : null)).filter(Boolean);
        const nets = answers.filter(answer => netError.slackChannel(answer.error)).length;
        const late = answers.filter(answer => answer.timeout).length;
        const other = answers.filter(answer => answer.error && answer.error.code !== 'channel_not_found' && !netError.slackChannel(answer.error)).length;
        if (count && nets === count) {
          Object.assign(channelItem, { state: 'bad', detail: '슬랙에 닿지 못했어요', fix: { text: WORDS.unreachable } });
          external.push({ item: channelItem, net: true });
        } else if (gone.length && gone.length === count) {
          Object.assign(channelItem, { state: 'bad', detail: '켜진 채널을 모두 찾을 수 없어요', copy: '켜진 채널을 모두 찾을 수 없어요', fix: { text: WORDS.pickChannels } });
          external.push({ item: channelItem, net: false });
        } else if (gone.length || other) {
          const goneName = gone.map(key => String(channels[key].name || '').trim()).filter(Boolean)[0];
          const what = gone.length ? `${goneName ? `${goneName} ` : ''}${gone.length > 1 ? `외 ${gone.length - 1}개 ` : ''}채널을 찾을 수 없어요` : `${other}개 채널을 읽지 못했어요`;
          Object.assign(channelItem, { state: 'warn', detail: `${count}개 중 ${what}`, copy: `켜진 채널 ${count}개 중 ${gone.length + other}개를 읽지 못했어요`, fix: { text: WORDS.pickChannels } });
          external.push({ item: channelItem, net: false });
        } else if (late) {
          channelItem.detail = '확인 못 함 — 슬랙이 제시간에 답하지 않았어요';
        } else {
          const rest = count > 1 ? ` 외 ${count - 1}개` : '';
          Object.assign(channelItem, { state: 'ok', detail: `${first || '채널'}${rest} · 모두 읽혀요`, copy: `켜진 채널 ${count}개 · 모두 읽혀요` });
          external.push({ item: channelItem, net: false });
        }
      }

      // 슬랙 수집 — 연동 탭 카드의 `멈췄어요`와 같은 판단(계속 실패·토큰 문제·켜진 채널이 모두 사라짐). 늦음(주황)은 화면이 syncLag로 더한다(`lag`).
      const collect = { key: 'slack', label: '슬랙 수집', lag: 'slack' };
      if (alerts.includes('slack') && (lost || stalled)) {
        // 새 방식의 연결이 풀려서(또는 이어 가지 못해서) 멈췄다 — 원인은 위 슬랙 연결 줄 하나다(문제 수에 한 번만 센다).
        add({ ...collect, state: 'bad', sameAs: 'slack_token', detail: `${lost ? '연결이 풀려서' : offline ? '슬랙에 닿지 못해' : '연결을 이어 가지 못해'} 멈췄어요 — 위 슬랙 연결 줄대로 고치면 돼요` });
      } else if (alerts.includes('slack')) {
        const allGone = !(fetchState.slack && fetchState.slack.failing);
        add({ ...collect, ...(allGone ? { state: 'bad', sameAs: channelItem.state === 'bad' ? 'slack_channels' : undefined, detail: '켜진 채널이 모두 사라져서 멈췄어요', fix: { text: WORDS.pickChannels } } : stopped('slack', '슬랙', slackTokenItem)) });
      } else {
        const at = whenText(deps.slackSuccessAt(), now());
        add({ ...collect, state: 'ok', detail: at ? `마지막 수집 ${at}` : '잘 돌고 있어요' });
      }
    }

    // ---------- 캘린더 ----------
    if (on.calendar) {
      const item = add({ key: 'calendar', label: '캘린더', state: 'ok', detail: '', lag: 'calendar' });
      if (calendarIcal) {
        const checked = await within(() => deps.icalCheck(config), left());
        if (checked.timeout) Object.assign(item, { state: 'unknown', detail: '확인 못 함 — 캘린더가 제시간에 답하지 않았어요' });
        else if (checked.value) { Object.assign(item, { detail: `비밀 주소로 읽혀요 · 오늘 ${Number(checked.value.count) || 0}개` }); external.push({ item, net: false }); }
        else {
          const error = checked.error || {};
          const net = netError.ical(error);
          Object.assign(item, error.auth
            ? { state: 'bad', detail: '비밀 주소를 읽을 수 없어요', fix: { text: WORDS.reconnectCalendar } }
            : net ? { state: 'bad', detail: '캘린더에 닿지 못했어요', fix: { text: WORDS.unreachable } }
              : { state: 'bad', detail: '이 주소를 캘린더로 읽지 못했어요', fix: { text: WORDS.reconnectCalendar } });
          external.push({ item, net });
        }
      }
      if (item.state !== 'bad' && alerts.includes('calendar')) {
        const found = stopped('calendar', '캘린더');
        Object.assign(item, found, calendarIcal && found.detail && !found.sameAs ? { detail: `${found.detail} — 지금 확인해 보니 주소는 읽혀요, 카드의 ⋯ › 새로 받기로 다시 읽어 주세요` } : {});
      }
      // 맥 캘린더 갈래는 멈춘 이유(⚠️ 줄 — 허용 막힘·계정 없음·고른 캘린더 없음·시간 초과)를 그대로 한 줄로 보인다.
      const macWhy = calendarMac && item.state === 'bad' && !item.sameAs ? macCalendarWhy((fetchState.calendar || {}).summary) : null;
      if (macWhy) Object.assign(item, { detail: macWhy.detail, fix: { text: macWhy.fix } });
      if (!item.detail) {
        const at = whenText((fetchState.calendar || {}).lastRunAt, now());
        const how = calendarMac ? '맥 캘린더에서 읽어요' : 'Claude로 읽어요';
        item.detail = at ? `${how} · 마지막 ${at}` : how;
      }
    }

    // ---------- 지라 ----------
    if (on.jira) {
      const item = add({ key: 'jira', label: '지라', state: 'unknown', detail: '확인 못 함', lag: 'jira' });
      const checked = await within(() => deps.jiraCheck(config), left());
      if (checked.timeout) item.detail = '확인 못 함 — 지라가 제시간에 답하지 않았어요';
      else {
        const result = checked.value || { ok: false, kind: 'other' };
        const net = netError.jira(result);
        if (result.ok) Object.assign(item, { state: 'ok', detail: `${result.displayName ? `${result.displayName}님 · ` : ''}방금 확인`, copy: '연결돼요 · 방금 확인' });
        else if (net) Object.assign(item, { state: 'bad', detail: '지라에 닿지 못했어요', fix: { text: WORDS.unreachable } });
        else if (result.kind === 'auth') Object.assign(item, { state: 'bad', detail: '토큰이 만료됐거나 권한이 없어요', fix: { text: WORDS.reconnectJira } });
        else Object.assign(item, { state: 'bad', detail: '지라가 응답하지 않았어요', fix: { text: WORDS.unreachable } });
        external.push({ item, net });
      }
      if (item.state !== 'bad' && alerts.includes('jira')) {
        const found = stopped('jira', '지라');
        Object.assign(item, found, item.state === 'ok' && !found.sameAs ? { detail: `${found.detail} — 지금 확인해 보니 토큰은 맞아요, 카드의 ⋯ › 새로 받기로 다시 읽어 주세요`, copy: undefined } : {});
      }
    }

    // ---------- 회의록(티로) ----------
    if (on.notes) {
      const item = add({ key: 'notes', label: '회의록', state: 'ok', detail: '' });
      if (alerts.includes('notes')) Object.assign(item, stopped('notes', '회의록'));
      else {
        const auto = automation('tiro');
        const at = auto && auto.lastRunAt ? whenText(auto.lastRunAt, now()) : '';
        Object.assign(item, at ? { detail: `티로 · 마지막 ${at}` } : { state: 'unknown', detail: '아직 알 수 없어요 — 미팅 노트를 한 번 가져오면 알 수 있어요' });
      }
    }

    // ---------- 데이터 백업(`/api/backup`과 같은 값) ----------
    const backup = deps.backup() || {};
    const local = backup.local || {};
    if (local.state === 'fail') {
      add({ key: 'backup', label: '데이터 백업', state: 'bad', detail: `이 맥 백업이 멈췄어요${local.at ? ` · ${whenText(local.at, now())}` : ''}`, fix: { text: '설정 › 앱 › 데이터 백업 줄에서 이유를 확인해 주세요 — 등록이 빠졌으면 업데이트 파일을 한 번 실행하면 다시 등록해요' } });
    } else if (local.state === 'never') {
      const d = new Date(now());
      const lateToday = d.getHours() * 60 + d.getMinutes() >= 19 * 60 + 30;
      add({ key: 'backup', label: '데이터 백업', state: 'unknown', detail: `${lateToday ? '내일' : '오늘'} 19:30에 처음 해요` });
    } else if (backup.github && backup.github.on && backup.github.state === 'fail') {
      add({ key: 'backup', label: '데이터 백업', state: 'warn', detail: `이 맥에는 ${Number(local.days) || 0}일치 · GitHub에 올리지 못했어요`, fix: { text: '설정 › 앱 › 데이터 백업 줄에서 이유를 확인해 주세요' } });
    } else {
      const at = local.at ? whenText(local.at, now()) : '';
      add({ key: 'backup', label: '데이터 백업', state: 'ok', detail: [at, `${Number(local.days) || 0}일치`].filter(Boolean).join(' · ') });
    }

    // ---------- 바깥에 모두 닿지 못했으면 한 줄로 묶는다(예외 4) ----------
    const offline = external.length > 0 && external.every(one => one.net);
    if (offline) external.forEach(({ item }) => { Object.assign(item, { state: 'offline', detail: '닿지 못했어요' }); delete item.fix; });

    // 응답에 실을 칸만 옮긴다(정한 모양 밖의 값이 새지 않게).
    const clean = items.map(item => ({
      key: item.key, label: item.label, state: item.state, detail: String(item.detail || ''),
      ...(item.copy ? { copy: item.copy } : {}),
      ...(item.fix ? { fix: { text: item.fix.text, ...(item.fix.command ? { command: item.fix.command } : {}), ...(item.fix.finder ? { finder: item.fix.finder } : {}) } } : {}),
      ...(item.sameAs ? { sameAs: item.sameAs } : {}),
      ...(item.lag ? { lag: item.lag } : {}),
    }));
    return {
      ok: true, at: new Date(startedAt).toISOString(), version: version || null, items: clean, skipped, offline,
      // 늦음(주황)의 재료 — /api/integrations의 `sync`와 같은 값(화면이 syncLag에 그대로 넣는다).
      sync: deps.sync(),
    };
  }

  // 30초 안에 다시 부르면 같은 답. 도는 중이면 같은 약속을 나눠 쓴다.
  function run() {
    if (held && now() - held.at < CACHE_MS) return Promise.resolve({ ...held.result, cached: true });
    if (running) return running;
    running = build().then((result) => { held = { at: now(), result }; return result; }).finally(() => { running = null; });
    return running;
  }

  return { run, clear: () => { held = null; } };
}

// 설치 위치 판단 — install-location.sh와 같은 규칙을 **파일만 읽어** 본다(git을 부르지 않는다).
// playio: 실제 경로 칸에 playio, 또는 바깥 저장소(.git/config)의 remote 주소에 playio.
// synced: 바탕화면·문서·iCloud 아래. other: workspace.env가 다른 폴더를 가리킴(한 벌 더).
function installPlace({ repoDir, home, envFile }) {
  let real = repoDir;
  try { real = fs.realpathSync(repoDir); } catch { /* 그대로 */ }
  let playio = /playio/i.test(real);
  if (!playio) {
    let at = path.dirname(real);
    for (let i = 0; i < 12 && at && at !== path.dirname(at); i += 1) {
      try {
        const text = fs.readFileSync(path.join(at, '.git', 'config'), 'utf8');
        playio = /url\s*=.*playio/i.test(text);
        break;
      } catch { at = path.dirname(at); }
    }
  }
  const under = dir => real === dir || real.startsWith(`${dir}/`);
  const synced = !!home && ['Desktop', 'Documents', path.join('Library', 'Mobile Documents')].some(dir => under(path.join(home, dir)));
  let other = null;
  try {
    const text = fs.readFileSync(envFile, 'utf8');
    const hit = /^WORKSPACE_DIR="([^"\n]+)"/m.exec(text);
    if (hit) {
      let target = hit[1];
      try { target = fs.realpathSync(target); } catch { /* 없는 폴더면 글자 그대로 */ }
      if (target !== real) other = target;
    }
  } catch { other = null; }
  return { real, playio, synced, other };
}

module.exports = {
  createSelfcheck, installPlace, connectedFlags, whenText, shellPath,
  SELFCHECK_ITEM_TIMEOUT_MS: ITEM_TIMEOUT_MS, SELFCHECK_TOTAL_TIMEOUT_MS: TOTAL_TIMEOUT_MS, SELFCHECK_CACHE_MS: CACHE_MS,
  SELFCHECK_WORDS: WORDS, CLAUDE_TOKEN_COMMAND,
};
