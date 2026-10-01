// 항목 추가·수정·삭제·되돌리기 경로 — 할 일·확인 대기·결정·아이디어 만들기, 칸 바꾸기(예정일·마감·담당·우선순위·내용 등),
// 완료 표시, 삭제·되살리기, 삭제한 항목 목록. `workflowActions`(워크플로·프로젝트·휴지통 완전 삭제)·보고서·가져오기는 server.js에 있다.
// server.js의 handleRequest가 공통 가드(인증·호스트·출처는 safeHandle, 복구 필요 중 쓰기 차단은 handleRequest 맨 위)를
// 거친 뒤 이 함수에 묻는다. 처리했으면 true, 내 경로가 아니면 false. 필요한 값·함수는 모두 `ctx`로 받는다 —
// 여기서 server.js를 require하지 않는다(서로 부르는 고리가 생기지 않게).
// 저장 잠금: 받는 함수(setTrackField·createManualTask·removeTrackItem 등)는 server.js가 `transactional(...)`로 감싼 뒤의
// 것이다 — ctx를 감싸기 뒤에 만든다. 감싸기 전 것을 받으면 저장 잠금(mutations.run) 없이 파일을 쓰게 된다.

module.exports = function trackRoutes(req, res, url, ctx) {
  const { createDecision, createIdea, createLaterTask, createManualTask, createWaitingItem, idempotent, listTrash, mutations,
    promoteIdeaToToday, readBody, removeTrackItem, restoreTrackItem, setIdeaProject, setTrackDescription, setTrackDoing, setTrackDue,
    setTrackField, setTrackGroup, setTrackJira, setTrackPriority, setTrackWho, toggleTrackStatus, validateDate } = ctx;

  // 설정 > `삭제한 항목`이 창을 열 때마다 읽는 목록. 조회라 어떤 파일도 쓰지 않고,
  // 인증 예외(publicAsset)에도 넣지 않는다. 되살리기는 기존 `/api/track/restore`가 맡는다.
  if (url.pathname === '/api/track/trash' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, items: listTrash() }));
    return true;
  }

  if (req.method === 'POST' && ['/api/track/set-scheduled', '/api/track/seen', '/api/track/restore'].includes(url.pathname)) {
    readBody(req).then(({ id, scheduled, inbox }) => {
      // `inbox: true`는 `새로 들어온 것`에서 정한 일정을 되돌릴 때만 온다 — 예정일을 전 값으로 돌리면서 받지 않은 표시를 되살린다.
      // 칸이 없으면 예전 그대로(값이 바뀌면 표시를 지운다). true가 아닌 값은 받지 않는다.
      const restoreInbox = url.pathname.endsWith('set-scheduled') && inbox !== undefined;
      if (restoreInbox && inbox !== true) throw new Error('입력을 확인해 주세요.');
      if (url.pathname.endsWith('set-scheduled')) validateDate(scheduled);
      let ok;
      if (url.pathname.endsWith('/restore')) ok = restoreTrackItem(id);
      else if (url.pathname.endsWith('/seen')) ok = setTrackField(id, 'seen', 'true', null);
      else {
        ok = mutations.run(() => {
          const changed = setTrackField(id, 'scheduled', scheduled || 'none', 'task');
          if(changed)setTrackField(id, 'inbox', restoreInbox ? 'true' : null, 'task');
          return changed;
        });
      }
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok }));
    }).catch(error => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message || String(error), code: error.code }));
    });
    return true;
  }

  if (url.pathname === '/api/today-task/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createManualTask(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/later-task/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createLaterTask(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/waiting/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createWaitingItem(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/decision/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createDecision(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/idea/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createIdea(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/idea/promote' && req.method === 'POST') {
    readBody(req)
      .then(({ id, due }) => {
        const result = promoteIdeaToToday(id, due);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-jira' && req.method === 'POST') {
    readBody(req)
      .then(({ id, jiraKey }) => {
        const ok = setTrackJira(id, jiraKey || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-group' && req.method === 'POST') {
    readBody(req)
      .then(({ id, group }) => {
        const ok = setTrackGroup(id, group || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/idea/set-project' && req.method === 'POST') {
    readBody(req)
      .then(({ id, project }) => {
        const ok = setIdeaProject(id, project || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-due' && req.method === 'POST') {
    readBody(req)
      .then(({ id, due }) => {
        const ok = setTrackDue(id, due || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-doing' && req.method === 'POST') {
    readBody(req)
      .then(({ id, doing }) => {
        const ok = setTrackDoing(id, !!doing);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-who' && req.method === 'POST') {
    readBody(req)
      .then(({ id, who }) => {
        const ok = setTrackWho(id, who || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-priority' && req.method === 'POST') {
    readBody(req)
      .then(({ id, priority }) => {
        const ok = setTrackPriority(id, priority || 'medium');
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/set-description' && req.method === 'POST') {
    readBody(req)
      .then(({ id, description }) => {
        const ok = setTrackDescription(id, description);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/remove' && req.method === 'POST') {
    readBody(req)
      .then(({ id }) => {
        const removed = removeTrackItem(id);
        res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: !!removed }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }

  if (url.pathname === '/api/track/toggle' && req.method === 'POST') {
    readBody(req)
      .then(({ id, status }) => {
        const ok = toggleTrackStatus(id, status);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return true;
  }
  return false;
};
