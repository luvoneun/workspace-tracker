// 목록 읽기 경로 — `GET /api/items`(화면이 처음·새로고침 때 받는 목록 한 벌)와, 그것만 쓰는 목록 읽기 도우미.
// server.js의 handleRequest가 공통 가드(인증·호스트·출처는 safeHandle, 복구 필요 중 쓰기 차단은 handleRequest 맨 위)를
// 거친 뒤 이 함수에 묻는다. 처리했으면 true, 내 경로가 아니면 false. 필요한 값·함수는 모두 `ctx`로 받는다 —
// 여기서 server.js를 require하지 않는다(서로 부르는 고리가 생기지 않게).
// 파일 읽기: 아래 도우미가 쓰는 `fs`는 ctx로 받은 server.js의 fs다 — 요청마다 새로 만드는 읽기 묶음(readScope)을
// 부를 때마다 확인하므로, 요청 하나 안에서 같은 파일을 두 번 읽지 않는 것이 예전과 같다. 여기서 `require('fs')`로
// 바꾸면 오류 없이 그 묶음만 빠진다(느려진다). `storage`는 handleRequest가 이 요청에서 읽은 저장 상태다.
const path = require('path');

module.exports = function itemsRoutes(req, res, url, ctx) {
  const { APP_TITLE, CALENDAR_ICAL, PUBLIC_DIR, TITLE_HIDDEN, USES, calendarLive, clientFiles, fs, getCalendarWithLinks, getCustomGroups,
    getJiraIssueCache, getJiraSync, getLaterTasks, getReportRefs, getSlackSync, getTodayTasks, jiraLive, meetingNotesStatus,
    storage, todayLocal, workflows } = ctx;

  if (url.pathname === '/api/items' && req.method === 'GET') {
    const { getInboxTasks, getDecisions, getWaitingItems, getIdeas, getTodaySuggestions, getWeeklyReports, getTodayActivityCounts } = listReaders(ctx);
    // 지라 목록이 묵었으면 갱신만 걸어 둔다 — 이 응답은 기다리지 않는다(지라 때문에 목록이 늦지 않게).
    if (USES.jira) jiraLive.nudge();
    // 캘린더 비밀 주소도 같다 — 묵었으면 뒤에서 다시 읽게만 걸어 둔다.
    if (CALENDAR_ICAL) calendarLive.nudge();
    // Automatic drafts are a read-only projection. Edited reports are saved explicitly.
    const allDecisions = getDecisions();
    const payload = {
      inboxTasks: getInboxTasks(),
      laterTasks: getLaterTasks(),
      waiting: getWaitingItems(),
      todayTasks: getTodayTasks(),
      ideas: getIdeas(),
      decisions: allDecisions.filter((d) => d.status !== 'done'),
      decisionArchive: allDecisions
        .filter((d) => d.status === 'done')
        .sort((a, b) => (b.completed || '').localeCompare(a.completed || '')),
      weeklyReports: getWeeklyReports(),
      jiraIssues: getJiraIssueCache(),
      jiraSync: getJiraSync(),
      slackSync: getSlackSync(),
      title: APP_TITLE,
      titleHidden: TITLE_HIDDEN,
      // 앱 화면 파일이 바뀌면 이 값이 달라진다. 브라우저가 이걸 보고 스스로 새로고침한다.
      appVersion: (() => {
        try {
          return ['index.html', ...clientFiles()].map(file => fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs).join(':');
        } catch {
          return '0';
        }
      })(),
      customGroups: getCustomGroups(),
      calendar: getCalendarWithLinks(),
      suggestions: getTodaySuggestions(),
      reportRefs: getReportRefs(),
      workflows: workflows.snapshot(),
      // 미팅 노트 가져오기의 지금 상태 — 페이지를 새로 열어도 진행 중인 가져오기가 이어지게 첫 조회에 함께 싣는다.
      meetingNotes: meetingNotesStatus(),
      storage,
      // 업데이트가 도는 중인가(WP-U) — 서버가 잠깐 꺼지는 동안 화면이 `연결 실패` 대신 `바꾸는 중이에요`를 말하려고 기억해 둔다.
      updating: (() => { try { return !!ctx.updateStatusView().running; } catch { return false; } })(),
      today: todayLocal(),
      ...getTodayActivityCounts(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
  }
  return false;
};

// 목록 읽기 도우미 — 이 경로만 쓴다(server.js에서 글자 그대로 옮겼다). 다른 곳도 쓰는 도우미는 server.js에 두고 ctx로 받는다.
function listReaders(ctx) {
  const { TRACK_RE, fs, getCalendarToday, getLaterTasks, getTodayTasks, isNewSlack, listTrackerFiles, localDateOf, parseFields,
    parseWeeklyReports, projectKeyOf, readMeetingLinks, reportDrafts, todayLocal, weeklyReportStatePath, workflows } = ctx;

  // "새로 들어온 것" — 슬랙에서 캡처됐지만 오늘 할지 나중에 할지 아직 안 정한 것.
  // 오늘/나중에 목록에 섞여 묻히는 걸 막으려고 따로 모아둔다. 사람이 분류하면 inbox가 지워진다.
  function getInboxTasks() {
    const items = [];
    listTrackerFiles().forEach((filePath) => {
      fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
        const m = line.match(TRACK_RE);
        if (!m || m[2] !== 'task') return;
        const fields = parseFields(m[3]);
        if (fields.status === 'done' || fields.inbox !== 'true') return;
        items.push({
          description: m[1],
          id: fields.id,
          status: fields.status || 'to-do',
          priority: fields.priority || 'medium',
          created: fields.created,
          due: fields.due || null,
          permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
          jira: fields.jira || null,
          group: fields.group ? fields.group.replace(/_/g, ' ') : null,
        });
      });
    });
    return items;
  }

  // "정책/얼라인" — 결정/합의된 내용 (#decision 타입). 슬랙 캡처분과 직접 쓴 것 모두 포함.
  // PRD 반영 여부는 status(to-do/done)로 관리
  function getDecisions() {
    const items = [];
    listTrackerFiles().forEach((filePath) => {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line) => {
        const m = line.match(TRACK_RE);
        if (!m || m[2] !== 'decision') return;
        const fields = parseFields(m[3]);
        items.push({
          file: path.basename(filePath),
          description: m[1],
          id: fields.id,
          status: fields.status || 'to-do',
          priority: fields.priority || 'medium',
          created: fields.created,
          completed: fields.status === 'done' ? fields.completed || (fields.updated ? localDateOf(fields.updated) : null) : null,
          permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
          isNew: isNewSlack(fields),
          jira: fields.jira || null,
          group: fields.group ? fields.group.replace(/_/g, ' ') : null,
        });
      });
    });
    return items;
  }

  // "확인 대기중" — waiting on someone else to check/confirm something (#check 타입, source:slack:)
  function getWaitingItems() {
    const items = [];
    listTrackerFiles().forEach((filePath) => {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line) => {
        const m = line.match(TRACK_RE);
        if (!m || m[2] !== 'check') return;
        const fields = parseFields(m[3]);
        if (fields.status === 'done') return;
        items.push({
          file: path.basename(filePath),
          description: m[1],
          id: fields.id,
          status: fields.status || 'to-do',
          priority: fields.priority || 'medium',
          created: fields.created,
          due: fields.due || null,
          who: fields.who ? fields.who.replace(/_/g, ' ') : null,
          permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
          isNew: isNewSlack(fields),
          jira: fields.jira || null,
          group: fields.group ? fields.group.replace(/_/g, ' ') : null,
        });
      });
    });
    return items;
  }

  function getIdeas() {
    const items = [];
    listTrackerFiles().forEach((filePath) => {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line) => {
        const m = line.match(TRACK_RE);
        if (!m || m[2] !== 'idea') return;
        const fields = parseFields(m[3]);
        if (fields.status === 'done') return;
        items.push({
          file: path.basename(filePath),
          description: m[1],
          id: fields.id,
          status: fields.status || 'to-do',
          priority: fields.priority || 'medium',
          created: fields.created,
          project: fields.project ? fields.project.replace(/_/g, ' ') : null,
          isNew: isNewSlack(fields),
        });
      });
    });
    return items;
  }

  // 오늘 미팅에 연결된 프로젝트들 — 제안이 "오늘 미팅 있는 일"을 건드리지 않도록 쓰인다
  function meetingProjectKeys() {
    const links = readMeetingLinks();
    const keys = new Set();
    getCalendarToday().events.forEach((event) => {
      const key = links[String(event.title).trim()];
      if (key) keys.add(key);
    });
    return keys;
  }

  function daysBetween(fromDate, toDate) {
    return Math.round((new Date(`${toDate}T00:00:00`) - new Date(`${fromDate}T00:00:00`)) / 86400000);
  }

  // 오늘 목록 상태에 따라 방향이 갈린다.
  // 여유 있으면 "이거 가져올까요?", 과부하면 "이건 미룰까요?", 적당하면 아무 말도 안 한다.
  function getTodaySuggestions() {
    const openToday = getTodayTasks().filter((t) => t.status !== 'done');
    if (openToday.length >= 8) return { mode: 'defer', total: openToday.length, items: suggestDeferrals(openToday) };
    if (openToday.length < 5) return { mode: 'pull', total: openToday.length, items: suggestPulls() };
    return { mode: 'none', total: openToday.length, items: [] };
  }

  // 오늘 하기 좋은 후보 — 나중에 할 일 중에서
  function suggestPulls() {
    const today = todayLocal();
    const meetingKeys = meetingProjectKeys();
    return getLaterTasks()
      .map((task) => {
        const reasons = [];
        let score = 0;
        const key = projectKeyOf(task);
        if (key && meetingKeys.has(key)) {
          score += 10;
          reasons.push('오늘 미팅 관련');
        }
        if (task.due) {
          const left = daysBetween(today, task.due);
          if (left <= 1) {
            score += 9;
            reasons.push(left < 0 ? '마감 지남' : '마감 임박');
          } else if (left <= 3) {
            score += 6;
            reasons.push(`마감 ${left}일 전`);
          } else if (left <= 7) {
            score += 3;
            reasons.push('이번 주 마감');
          }
        }
        if (task.priority === 'critical') {
          score += 6;
          reasons.push('긴급');
        } else if (task.priority === 'high') {
          score += 4;
          reasons.push('중요');
        }
        const waited = task.created ? daysBetween(task.created, today) : 0;
        if (waited >= 7) {
          score += 3;
          reasons.push(`${waited}일째 대기`);
        } else if (waited >= 3) {
          score += 1;
          reasons.push(`${waited}일째 대기`);
        }
        return { ...task, score, reasons };
      })
      .filter((task) => task.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  // 오늘 미뤄도 괜찮아 보이는 후보 — 오늘 미팅과 무관하고, 마감도 급하지 않고, 우선순위도 높지 않은 것
  function suggestDeferrals(openToday) {
    const today = todayLocal();
    const meetingKeys = meetingProjectKeys();
    return openToday
      .map((task) => {
        const key = projectKeyOf(task);
        if (key && meetingKeys.has(key)) return null;
        if (task.priority === 'high' || task.priority === 'critical') return null;

        const reasons = [];
        let score = 0;
        if (task.due) {
          const left = daysBetween(today, task.due);
          if (left <= 3) return null;
          score += 2;
          reasons.push(`마감 ${left}일 남음`);
        } else {
          score += 3;
          reasons.push('마감 없음');
        }
        if (task.priority === 'low') {
          score += 4;
          reasons.push('우선순위 낮음');
        }
        if (!key) {
          score += 1;
          reasons.push('프로젝트 미지정');
        }
        return { ...task, score, reasons };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  function weekLabel(weekKey) {
    const monday = new Date(weekKey + 'T00:00:00');
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const rangeStr = `${monday.getMonth() + 1}/${monday.getDate()}~${sunday.getMonth() + 1}/${sunday.getDate()}`;
    return `${monday.getFullYear()}년 ${rangeStr}`;
  }

  function readWeeklyReportState() {
    const p = weeklyReportStatePath();
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return {};
    }
  }

  function getWeeklyReports() {
    const state = readWeeklyReportState();
    const old = parseWeeklyReports();
    const snapshot = workflows.snapshot();
    const sources = snapshot.items;
    // 보고 기록 파일은 한 번만 읽어서 주마다 돌려 쓴다 — view()가 주 수만큼 다시 읽지 않게(묶음 목록도 같다).
    const drafts = reportDrafts.read();
    const bundles = snapshot.projectBundles || [];
    return reportDrafts.weeks(sources, drafts).map(weekKey => ({ weekKey, label: weekLabel(weekKey), body: old.find(r=>r.weekKey===weekKey)?.body || '', generatedAt: state[weekKey]?.generatedAt || null, draft: reportDrafts.view(weekKey, drafts, sources, { bundles }) }));
  }

  // 오늘 새로 생긴 항목 수 / 오늘 완료한 항목 수 — 상단 통계용
  function getTodayActivityCounts() {
    const today = todayLocal();
    let createdToday = 0;
    listTrackerFiles().forEach((filePath) => {
      fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
        const m = line.match(TRACK_RE);
        if (!m) return;
        const fields = parseFields(m[3]);
        if (fields.created === today) createdToday += 1;
      });
    });
    return { createdToday };
  }

  return { getInboxTasks, getDecisions, getWaitingItems, getIdeas, getTodaySuggestions, getWeeklyReports, getTodayActivityCounts };
}
