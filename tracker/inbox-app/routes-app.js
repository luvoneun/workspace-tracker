// 앱 정보 경로 — 앱 정보(about)·업데이트 요청·업데이트 진행 상태·문제 보고용 오류 줄·점검하기(selfcheck).
// server.js의 handleRequest가 공통 가드(인증·호스트·출처는 safeHandle, 복구 필요 중 쓰기 차단은 handleRequest 맨 위)를
// 거친 뒤 이 함수에 묻는다. 처리했으면 true, 내 경로가 아니면 false. 필요한 값·함수는 모두 `ctx`로 받는다 —
// 여기서 server.js를 require하지 않는다(서로 부르는 고리가 생기지 않게). 파일 읽기 캐시(readScope)를 쓰는 함수도
// server.js에 그대로 두고 ctx로 받아 부르므로, 요청 하나 안에서 같은 파일을 두 번 읽지 않는 것도 예전과 같다.

module.exports = function appRoutes(req, res, url, ctx) {
  const { UPDATE_MESSAGE, aboutApp, aboutDiagnostics, readBody, requestUpdate, selfcheck, updateStatusView } = ctx;

  // 앱 정보 — 조회라 파일을 쓰지 않는다.
  if (url.pathname === '/api/about' && req.method === 'GET') {
    aboutApp({ cached: url.searchParams.get('cached') === '1', check: url.searchParams.get('check') === '1' }).then((about) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(about));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '앱 정보를 읽지 못했어요.' }));
    });
    return true;
  }

  // 앱 안에서 업데이트 받기 — 서버는 요청 표시 파일 하나만 쓰고(launchd가 실행기를 돌린다), 진행은 상태 파일을 읽어 준다.
  if (url.pathname === '/api/update' && req.method === 'POST') {
    readBody(req)
      .then(body => requestUpdate(body && typeof body === 'object' ? body.action : ''))
      .then(({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, reason: 'action', message: UPDATE_MESSAGE.action }));
      });
    return true;
  }
  if (url.pathname === '/api/update/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(updateStatusView()));
    return true;
  }

  // 문제 보고에 붙일 최근 오류 줄 — 조회라 파일을 쓰지 않는다.
  if (url.pathname === '/api/about/diagnostics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(aboutDiagnostics()));
    return true;
  }

  // 설정 › 앱 › 점검하기(WP-K) — 조회라 파일을 쓰지 않는다. 바깥에는 읽기 확인만, 같은 결과를 30초 들고 있는다.
  if (url.pathname === '/api/selfcheck' && req.method === 'GET') {
    selfcheck.run().then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '점검하지 못했어요.' }));
    });
    return true;
  }

  return false;
};
