// 지라 경로 — 이슈 읽기·내 담당 목록·반응 필요·완료 목록·고르개·담당자 찾기·바꾸기·만들기·그룹 프로젝트에 걸기/옮기기.
// server.js의 handleRequest가 공통 가드(인증·호스트·출처는 safeHandle, 복구 필요 중 쓰기 차단은 handleRequest 맨 위)를
// 거친 뒤 이 함수에 묻는다. 처리했으면 true, 내 경로가 아니면 false. 필요한 값·함수는 모두 `ctx`로 받는다 —
// 여기서 server.js를 require하지 않는다(서로 부르는 고리가 생기지 않게). 파일 읽기 캐시(readScope)를 쓰는 함수도
// server.js에 그대로 두고 ctx로 받아 부르므로, 요청 하나 안에서 같은 파일을 두 번 읽지 않는 것도 예전과 같다.

module.exports = function jiraRoutes(req, res, url, ctx) {
  const { JIRA_DONE_DAYS, JIRA_DONE_MAX_DAYS, PROJECT_MOVE_KEY_RE, USES, attentionLive, idempotent, jira, jiraLive,
    findProject, moveProject, projectDisplayName, readBody, workflows } = ctx;

  // 지라 직접 읽기 — 프로젝트 탭의 띠 카드가 열릴 때만 부른다. 파일은 쓰지 않고(조회),
  // 키별 60초 메모리 캐시를 둔다(`fresh=1`이면 건너뛴다). 인증 예외에는 넣지 않는다.
  if (url.pathname === '/api/jira/issue' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    jira.read(url.searchParams.get('key'), { fresh: url.searchParams.get('fresh') === '1' })
      .then((payload) => {
        // 지라 쪽 실패는 200 + `ok:false`로 답한다 — 우리 서버가 제대로 답한 것이고,
        // 화면은 그 문구를 카드 자리에 조용히 적는다(브라우저 콘솔에 붉은 줄을 남기지 않는다).
        // 형식이 틀린 키만 400이다(보낸 쪽 잘못).
        res.writeHead(payload.kind === 'key' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        // 여기 오는 것은 우리 쪽 잘못이다 — 지라가 준 글자는 이미 위에서 우리 문구로 바뀌어 있다.
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return true;
  }

  // 내 담당 목록을 **지금** 다시 읽어 메모리만 바꾼다(파일은 쓰지 않는다). 헤더의 새로고침이
  // 목록을 다시 받기 전에 조용히 부른다 — 돌려주는 것은 결과 한 줄뿐이고 티켓은 싣지 않는다.
  if (url.pathname === '/api/jira/list' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    const done = () => {
      const live = jiraLive.current();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        connected: !!jira.connected,
        count: live ? live.issues.length : 0,
        liveAt: live ? new Date(live.at).toISOString() : null,
      }));
    };
    const asked = url.searchParams.get('fresh') === '1' || !jiraLive.current();
    (asked && jira.connected ? jiraLive.refresh() : Promise.resolve()).then(done, done);
    return true;
  }

  // 반응 필요(1차: 지라 댓글) — 내 마지막 댓글 뒤에 다른 사람 댓글이 있는 이슈 목록이다.
  // 조회라 어떤 파일도 쓰지 않고, 값은 서버 메모리(attention-live)에만 있다. 인증 예외도 아니다.
  // 지라를 쓰지 않거나 설정이 없으면 `connected:false`로만 답한다(화면은 구역 자체를 그리지 않는다).
  if (url.pathname === '/api/attention' && req.method === 'GET') {
    if (!USES.jira || !jira.connected) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, connected: false, items: [] }));
      return true;
    }
    const done = () => {
      const view = attentionLive.view();
      const hidden = workflows.attentionDismissed();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        connected: true,
        items: view.items.filter(item => !hidden[item.id]),
        updatedAt: view.updatedAt,
        stale: view.stale,
        ...(view.error ? { error: view.error } : {}),
      }));
    };
    // 아직 값이 없거나 `fresh=1`이면 지금 읽는다(그 밖에는 10분마다 도는 값을 그대로 쓴다).
    // 지라가 죽어 있는 동안 화면을 열 때마다 다시 묻지 않게, 스스로 읽는 쪽은 1분을 바닥으로 둔다.
    const asked = url.searchParams.get('fresh') === '1' || attentionLive.needsRead();
    (asked ? attentionLive.refresh() : Promise.resolve()).then(done, done);
    return true;
  }

  // 연결 입력칸에서 `완료한 티켓도 보기`를 눌렀을 때만 부른다 — 최근 며칠 안에 완료된 내 담당 티켓이다.
  // 조회라 파일은 하나도 쓰지 않고, 서버 메모리에 60초만 들고 있는다. 인증 예외에는 넣지 않는다.
  if (url.pathname === '/api/jira/done' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    const asked = url.searchParams.get('days');
    const days = asked === null || asked === '' ? JIRA_DONE_DAYS : Number(asked);
    if (!Number.isInteger(days) || days < 1 || days > JIRA_DONE_MAX_DAYS) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' }));
      return true;
    }
    jira.listDone(days)
      .then((payload) => {
        // 지라 쪽 실패는 200 + `ok:false`다(화면이 그 문구를 그 자리에 조용히 적는다).
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return true;
  }

  // 고르개가 열릴 때 지라가 허용하는 전환·버전 목록을 읽는다. 파일도 캐시도 없다(조회).
  if (url.pathname === '/api/jira/options' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    jira.options(url.searchParams.get('key'))
      .then((payload) => {
        res.writeHead(payload.kind === 'key' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return true;
  }

  // 담당자 고르개가 두 글자 이상 쳤을 때만 부른다 — 이 티켓을 맡을 수 있는 사람(최대 10명).
  // 조회라 파일도 캐시도 없다. 응답에는 고르개가 쓸 id·표시 이름만 실린다(이메일·아바타는 서버가 버린다).
  if (url.pathname === '/api/jira/assignable' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    jira.assignable(url.searchParams.get('key'), url.searchParams.get('q'))
      .then((payload) => {
        // 형식이 틀린 키·두 글자 미만은 400이다(보낸 쪽 잘못). 지라 쪽 실패는 200 + `ok:false`다.
        res.writeHead(payload.kind === 'key' || payload.kind === 'value' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return true;
  }

  // 지라에 쓰는 단 하나의 주소. 화면이 확인 절차를 거친 뒤에만 부르고, 서버는 보낸 값을 다시
  // 검증한 뒤 id를 쓰기 직전에 지라에서 다시 조회해 대조한다. 앱 파일은 하나도 건드리지 않으므로
  // `idempotent()`·mutation-store를 타지 않는다(그것들은 앱 데이터용이다) — 다만 복구 필요 상태의
  // POST 차단은 맨 위 전역 분기를 그대로 탄다(앱 저장소가 아픈 동안 바깥에 쓰지 않는 쪽이 안전하다).
  // 요청 본문은 어디에도 기록하지 않는다.
  if (url.pathname === '/api/jira/change' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    readBody(req)
      .then(body => jira.change(body))
      .then((payload) => {
        // 보낸 쪽 잘못(키·값 형식)만 400이다. 지라 쪽 실패는 200 + `ok:false`로 문구를 실어 보낸다.
        res.writeHead(['key', 'value', 'assignValue'].includes(payload.kind) ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' }));
      });
    return true;
  }

  // 새 프로젝트 화면이 하위 티켓 종류를 고를 때 부른다 — 그 지라 프로젝트에서 만들 수 있는 이슈
  // 종류다. 조회라 파일은 하나도 쓰지 않고, 서버 메모리에 프로젝트마다 60초만 담아 둔다.
  if (url.pathname === '/api/jira/create-meta' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    jira.createMeta(url.searchParams.get('project'))
      .then((payload) => {
        // 형식이 틀린 프로젝트 키만 400이다(보낸 쪽 잘못). 지라 쪽 실패는 200 + `ok:false`다.
        res.writeHead(payload.kind === 'key' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return true;
  }

  // 지라에 **여러 이슈를 만드는** 단 하나의 주소(에픽 하나 + 직군별 하위). 화면이 만들 목록 전체를
  // 보여 주고 확인을 받은 뒤에만 부른다. 서버는 보낸 값을 다시 검증하고, 만들 수 있는 이슈 종류를
  // 쓰기 직전에 지라에서 다시 읽어 대조하며, 같은 계획을 60초 안에 두 번 받으면 거절한다.
  // 앱 파일은 하나도 건드리지 않으므로 `idempotent()`·mutation-store를 타지 않는다(그것들은 앱
  // 데이터용이다) — 다만 복구 필요 상태의 POST 차단은 맨 위 전역 분기를 그대로 탄다.
  // 요청 본문은 어디에도 기록하지 않는다.
  // 새 에픽의 요약은 프로젝트 이름이라 앱의 이름 규칙(밑줄→공백·연속 공백 하나)으로 한 번 더 고르고, 그 이름이
  // 이미 있는 지라 프로젝트(에픽 요약·별칭 — findProject가 `jira:`를 돌려줌)와 같으면 지라에 아무것도 묻지 않고
  // 409로 거절한다. 지라에 만드는 일은 되돌릴 수 없어서 화면 막기 하나로 끝내지 않는다. 직접 만든 프로젝트와 같은
  // 이름은 통과한다(만든 뒤 옮기기 흐름). 비교는 화면과 같은 캐시라 내 목록에 없는 남의 에픽은 알아보지 못한다.
  if (url.pathname === '/api/jira/create' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return true; }
    readBody(req)
      .then((body) => {
        const epic = body && body.plan && typeof body.plan === 'object' && body.plan.epic && typeof body.plan.epic === 'object' ? body.plan.epic : null;
        const fresh = epic && (epic.key == null || epic.key === '') && typeof epic.summary === 'string';
        if (!fresh) return jira.create(body);
        const summary = epic.summary.replace(/_/g, ' ').trim().replace(/\s+/g, ' ');
        const same = summary ? findProject(summary) : null;
        if (same && same.startsWith('jira:')) return { ok: false, error: '같은 이름의 지라 프로젝트가 이미 있어요.', kind: 'exists', project: same };
        return jira.create({ ...body, plan: { ...body.plan, epic: { ...epic, summary } } });
      })
      .then((payload) => {
        // 보낸 쪽 잘못(키·값 형식·개수)만 400이다. 같은 이름의 지라 프로젝트는 409. 지라 쪽 실패는 200 + `ok:false`로 문구를 실어 보낸다.
        res.writeHead(payload.kind === 'exists' ? 409 : ['key', 'value', 'tooMany'].includes(payload.kind) ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' }));
      });
    return true;
  }

  // 직접 만든(그룹) 프로젝트에 지라 티켓 **하나**를 손으로 건다(`jira:KEY` 프로젝트에는 걸지 않는다 —
  // 이미 지라다). 순서가 안전장치다: ① 보낸 값과 그 그룹이 앱에 실제로 있는지 먼저 보고
  // ② 지라에서 그 티켓을 **읽을 수 있을 때만** ③ 앱의 기존 저장 길(idempotent → mutations.run)로 저장한다.
  // `jira: null`이면 해제다 — 지라에는 아무것도 묻지 않는다. 업무·기록은 하나도 바뀌지 않는다.
  if (url.pathname === '/api/project/jira-link' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.' })); return true; }
    readBody(req).then(async (body) => {
      const { key } = workflows.checkProjectLink(body || {});
      if (key) {
        const seen = await jira.read(key);
        if (seen.ok === false) { const error = new Error(seen.error); error.status = 400; throw error; }
        if (seen.connected === false) { const error = new Error('지라 연결이 필요해요.'); error.status = 400; throw error; }
      }
      return idempotent(req, body, () => workflows.linkProject(body));
    }).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((error) => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return true;
  }

  // 직접 만든(그룹) 프로젝트를 지라 에픽으로 통째로 옮긴다(BMOVE) — jira-link와 같은 순서다:
  // ① 형식 확인 ② 지라에서 **다시 읽어** 실제로 에픽(계층 1)인지 확인 ③ 그때만 앱의 저장 길로 옮긴다.
  // 되돌리기는 `/api/project/move-undo`(workflowActions)가 지라를 다시 묻지 않고 기록만으로 한다.
  if (url.pathname === '/api/project/move' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.' })); return true; }
    readBody(req).then(async (body) => {
      const { project, to } = body || {};
      if (typeof project !== 'string' || !project.startsWith('group:')) { const error = new Error('직접 만든 프로젝트만 옮길 수 있어요.'); error.status = 400; throw error; }
      if (typeof to !== 'string' || !PROJECT_MOVE_KEY_RE.test(to)) { const error = new Error('지라 번호를 확인해 주세요.'); error.status = 400; throw error; }
      const check = await jira.checkEpic(to);
      if (check.ok === false) { const error = new Error('지라에서 이 티켓을 읽지 못했어요.'); error.status = 400; throw error; }
      if (check.connected === false) { const error = new Error('지라 연결이 필요해요.'); error.status = 400; throw error; }
      if (!check.epic) { const error = new Error('에픽에만 옮길 수 있어요.'); error.status = 400; throw error; }
      // 별칭이 있으면 그 이름, 없으면 방금 지라에서 읽은 요약(BJALIAS와 같은 규칙) — 아직 앱의
      // 지라 캐시(jira_issues.md)에 없는 새 에픽이어도 이 요약으로 표시 이름을 지을 수 있다.
      const name = projectDisplayName(to, check.summary || '');
      const label = name ? `${to} · ${name}` : to;
      return idempotent(req, body, () => moveProject({ project, to, label }));
    }).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((error) => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return true;
  }

  return false;
};
