// 연동 경로 — 연동 상태·슬랙 토큰 확인/채널 만들기·연동 저장·지금 가져오기·자동화 상태·백업 상태·미팅 노트.
// server.js의 handleRequest가 공통 가드(인증·호스트·출처는 safeHandle, 복구 필요 중 쓰기 차단은 handleRequest 맨 위)를
// 거친 뒤 이 함수에 묻는다. 처리했으면 true, 내 경로가 아니면 false. 필요한 값·함수는 모두 `ctx`로 받는다 —
// 여기서 server.js를 require하지 않는다(서로 부르는 고리가 생기지 않게). 파일 읽기 캐시(readScope)를 쓰는 함수도
// server.js에 그대로 두고 ctx로 받아 부르므로, 요청 하나 안에서 같은 파일을 두 번 읽지 않는 것도 예전과 같다.

module.exports = function integrationsRoutes(req, res, url, ctx) {
  const { CALENDAR_ICAL, CONFIG_PATH, FETCH_MESSAGE, SLACK_AUTH_RE, USES, attentionLive, backupStatus, calendarLive,
    claudeReady, currentConfigFile, fetchNow, fetchStateAutomation, fetchStateLive, getAutomationStatus,
    getCalendarToday, getJiraSync, getReportRefs, getSlackSync, integrationAlerts, integrations, jiraLive, liveLog,
    meetingNotesStatus, readBody, requestApply, slackFollowOn, slackFollower, slackSyncSuccessAt, todayLocal,
    withApplyFailure, workflows, writeMeetingNotesRequest } = ctx;

  // 지금 연동 상태 — 토큰 값은 싣지 않고 있음/없음만 알려 준다.
  // 열 때마다 슬랙 채널 이름을 따라간다(5분 캐시, 이름만 고침 — slackFollower 참고). 카드의 상태 줄에
  // 쓰는 "언제 읽었나"(지라 직접 읽기·슬랙 수집)와 지라 개수도 함께 싣는다(값은 메모리·상태 파일에서).
  if (url.pathname === '/api/integrations' && req.method === 'GET') {
    // 캘린더 비밀 주소가 묵었으면 뒤에서 한 번 더 읽게만 걸어 둔다(이 응답은 기다리지 않는다).
    if (CALENDAR_ICAL) calendarLive.nudge();
    const followed = slackFollowOn()
      ? slackFollower.follow({ read: currentConfigFile, configPath: CONFIG_PATH }).catch(() => ({ missing: {} }))
      : Promise.resolve({ missing: {} });
    followed.then(({ missing }) => {
      const config = currentConfigFile();
      const state = integrations.readIntegrations(config, { claude: claudeReady() });
      // 사라진 채널 — 뺀 채널이면 그 표시에(다시 체크하면 새로 만든다), 아니면 연결된 채널에 붙인다.
      Object.keys(missing || {}).forEach((key) => {
        if (state.slack.off[key]) state.slack.off[key].missing = true;
        else if (state.slack.channels[key] && state.slack.channels[key].id) state.slack.channels[key].missing = true;
      });
      const live = jiraLive.current();
      const attention = attentionLive.current();
      const hidden = attention ? workflows.attentionDismissed() : {};
      state.jira.readAt = live ? new Date(live.at).toISOString() : null;
      state.jira.issueCount = live ? live.issues.length : null;
      state.jira.attentionCount = attention && Array.isArray(attention.items)
        ? attention.items.filter(item => !hidden[item.id]).length : null;
      // 반응 필요(지라 댓글)를 마지막으로 확인한 때와, 다시 읽지 못하고 있는지 — 지라 카드 둘째 줄이 쓴다.
      const attentionView = attentionLive.view();
      state.jira.attentionAt = attentionView.updatedAt || null;
      state.jira.attentionStale = !!attentionView.stale;
      state.jira.attentionError = !!attentionView.error;
      const slackSync = getSlackSync();
      state.slack.readAt = slackSync && slackSync.used !== false ? slackSyncSuccessAt() : null;
      // 캘린더 비밀 주소 갈래의 상태 줄(`비밀 주소로 읽는 중 · 오늘 3개 · 10분 전`)에 쓰는 값 — 메모리에서만.
      const calendar = CALENDAR_ICAL ? calendarLive.current() : null;
      state.calendar.live = CALENDAR_ICAL;
      state.calendar.readAt = calendar ? new Date(calendar.at).toISOString() : null;
      state.calendar.eventCount = calendar ? calendar.events.length : null;
      state.calendar.failed = CALENDAR_ICAL ? calendarLive.failed() : false;
      // `지금 가져오기` 버튼과 빨간 상태 줄이 쓰는 "지금 실패 중인가"(토큰 문제면 auth).
      const automations = getAutomationStatus();
      const automation = key => automations.find(one => one.key === key) || null;
      state.jira.fetch = fetchStateLive(jiraLive.failure());
      state.slack.fetch = fetchStateAutomation(automation('slack'), SLACK_AUTH_RE);
      state.calendar.fetch = CALENDAR_ICAL ? fetchStateLive(calendarLive.failure()) : fetchStateAutomation(automation('calendar'));
      state.meetingNotes.fetch = fetchStateAutomation(automation('tiro'));
      // 오늘 슬랙에서 들어온 항목 수(원본 링크가 슬랙이고 오늘 만든 것) — 슬랙 카드 둘째 줄.
      const today = todayLocal();
      state.slack.todayCount = slackSync && slackSync.used !== false
        ? Object.values(getReportRefs()).filter(item => item.permalink && item.created === today).length : null;
      // 카드 ⋯ › 최근 기록 — 자동화는 로그의 최근 10번, 앱이 직접 읽는 것은 메모리에 있는 만큼.
      const events = key => (automation(key) || {}).events || [];
      // 켠 연동 자동 등록이 마지막에 실패했으면 launchd에 기대는 카드(슬랙·캘린더 Claude·회의록)의 기록에 한 줄.
      state.slack.log = withApplyFailure(events('slack'));
      state.jira.log = liveLog('jira', jiraLive.history());
      state.calendar.log = CALENDAR_ICAL ? liveLog('calendar', calendarLive.history()) : withApplyFailure(events('calendar'));
      state.meetingNotes.log = withApplyFailure(events('tiro'));
      state.alerts = integrationAlerts(config, automations);
      // 늦음·첫 읽기 전 판단의 재료 — /api/items(톱니바퀴의 주황 점)와 같은 값이라 둘이 같은 말을 한다.
      const calendarSync = { ...getCalendarToday() };
      delete calendarSync.events;
      state.sync = { slackSync, jiraSync: getJiraSync(), calendar: calendarSync };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...state, install: process.env.WORKSPACE_MANAGED ? 'managed' : 'manual' }));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '연동 상태를 읽지 못했어요.' }));
    });
    return true;
  }

  // 슬랙 위저드 `① 토큰`의 `다음` — `auth.test`로 토큰만 확인한다. 아무 파일도 쓰지 않고 `{ok}`만 돌려준다.
  if (url.pathname === '/api/integrations/slack-token-check' && req.method === 'POST') {
    readBody(req)
      .then((body) => {
        // 토큰 칸 없이 부르면(채널 고르기 — 새 채널 이름의 앞머리만 알고 싶을 때) 저장된 토큰을 서버 안에서만 쓴다.
        const given = typeof (body || {}).token === 'string' ? body.token.trim() : '';
        return integrations.slackTokenCheck(given || integrations.savedSlackToken(currentConfigFile()));
      })
      .then((checked) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, prefix: checked.prefix }));
      })
      .catch((error) => {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message, code: error.code || '' }));
      });
    return true;
  }

  // 연동 저장 — 켜는 쪽은 먼저 지라·슬랙에 읽어 보고 성공했을 때만 쓴다.
  // `USES`·지라 설정은 서버가 뜰 때 읽으므로, launchd가 띄운 자리면 응답 뒤 스스로 끝낸다(다시 떠 준다).
  if (url.pathname === '/api/integrations/save' && req.method === 'POST') {
    let before = {};
    readBody(req)
      .then(body => integrations.saveIntegrations({
        configPath: CONFIG_PATH,
        current: (before = currentConfigFile()),
        body,
        // 슬랙 정리 방식: 처음 연결할 때 Claude Code가 없으면 원문 그대로, `Claude로 다듬기`는 있을 때만 받는다.
        claude: claudeReady(),
        jiraCheck: settings => require('./jira-client').checkJiraAccount(settings),
        slackCheck: (token, id) => integrations.slackCheckChannel(token, id),
        // 비밀 주소는 한 번 읽어 오늘 일정 수만 센다(10초 제한). 주소는 응답·로그에 남지 않는다.
        calendarCheck: address => integrations.icalCheck(address),
      }))
      .then(({ result, config, quiet }) => {
        // 정리 방식만 바꾼 저장(`quiet`)은 다시 켜지 않는다 — 수집이 회차마다 설정을 읽는다.
        const managed = !!process.env.WORKSPACE_MANAGED && !quiet;
        // 등록에 영향을 주는 값이 바뀌었을 때만 켠 연동 자동 등록을 요청한다(요청 파일만 — 실패해도 저장은 끝났다).
        let apply = null;
        if (integrations.registrationKey(before) !== integrations.registrationKey(config)) {
          try { apply = requestApply(); } catch { apply = 'failed'; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...result, restart: managed, ...(quiet ? { quiet: true } : {}), ...(apply ? { apply } : {}) }));
        integrations.scheduleRestart({ managed, exit: ctx.exitApp });
      })
      .catch((error) => {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        // `code`·`key`는 화면이 갈래를 나눌 때만 쓴다(다시 체크한 채널이 사라졌으면 `channel_gone` + 그 칸).
        res.end(JSON.stringify({ ok: false, error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.key ? { key: error.key } : {}) }));
      });
    return true;
  }

  // 슬랙 비공개 채널 대신 만들기 — `설정 > 연동 > 슬랙 수집` 위저드의 ② 채널이 고른 채널마다 한 번씩 부른다.
  // 여기서는 **아무 파일도 쓰지 않는다**: 토큰은 슬랙 헤더로만 나가고, 만든 채널의 id·이름만 돌려준다
  // (그 id를 화면이 ③ 확인의 `연결`에 실어 보내고, 저장은 예전대로 `/api/integrations/save`만 한다).
  // 토큰 칸이 비어 있으면(`채널 고르기` — 이미 연결된 뒤 채널을 더하는 길) 저장된 토큰을 서버 안에서만 쓴다.
  if (url.pathname === '/api/integrations/slack-channel' && req.method === 'POST') {
    readBody(req)
      .then((body) => {
        const given = typeof (body || {}).token === 'string' ? body.token.trim() : '';
        const token = given || integrations.savedSlackToken(currentConfigFile());
        return integrations.slackCreateChannel(token, (body || {}).name);
      })
      .then((channel) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: channel.id, name: channel.name }));
      })
      .catch((error) => {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message, code: error.code || '' }));
      });
    return true;
  }

  // 지금 가져오기 — 지라·캘린더(비밀 주소)는 곧바로 다시 읽어 결과를, 나머지는 요청 표시 파일만 쓴다.
  // 토큰·비밀 주소는 응답에 싣지 않는다(결과는 개수·시각·갈래뿐).
  if (url.pathname === '/api/integrations/fetch' && req.method === 'POST') {
    readBody(req)
      .then(body => fetchNow(body && typeof body === 'object' ? body.key : ''))
      .then(({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, reason: 'failed', message: FETCH_MESSAGE.key }));
      });
    return true;
  }

  if (url.pathname === '/api/automation/status' && req.method === 'GET') {
    const automations = getAutomationStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // `alerts`는 지금 멈춘 연동(톱니바퀴의 빨간 점) — 연동 탭 요약과 같은 판단이다.
    res.end(JSON.stringify({ automations, alerts: integrationAlerts(currentConfigFile(), automations) }));
    return true;
  }

  // 설정 › 앱의 `데이터 백업` 줄 — 백업 로그와 날짜 폴더 목록을 **읽기만** 한다(프로세스·파일 쓰기 없음).
  if (url.pathname === '/api/backup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(backupStatus()));
    return true;
  }

  // 미팅 노트 가져오기 — 조회는 파일을 쓰지 않고(로그·요청 표시 파일을 읽기만),
  // 요청은 표시 파일 하나만 쓴다. 프로세스는 띄우지 않는다.
  if (url.pathname === '/api/meeting-notes/status' && req.method === 'GET') {
    if (!USES.tiro) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '미팅 노트 가져오기를 쓰지 않도록 설정돼 있어요.' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(meetingNotesStatus()));
    return true;
  }

  if (url.pathname === '/api/meeting-notes/request' && req.method === 'POST') {
    readBody(req).then(body => {
      const result = writeMeetingNotesRequest(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch(error => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return true;
  }

  return false;
};
