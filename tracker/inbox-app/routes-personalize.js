// 설정 › 꾸미기 경로(이 맥에만) — Dock 아이콘·이름/제목·아이콘 그림·local.css.
// server.js의 handleRequest가 공통 가드(인증·호스트·출처는 safeHandle, 복구 필요 중 쓰기 차단은 handleRequest 맨 위)를
// 거친 뒤 이 함수에 묻는다. 처리했으면 true, 내 경로가 아니면 false. 필요한 값·함수는 모두 `ctx`로 받는다 —
// 여기서 server.js를 require하지 않는다(서로 부르는 고리가 생기지 않게). 파일 읽기 캐시(readScope)를 쓰는 함수도
// server.js에 그대로 두고 ctx로 받아 부르므로, 요청 하나 안에서 같은 파일을 두 번 읽지 않는 것도 예전과 같다.
const path = require('path');
const nativeFs = require('fs');

module.exports = function personalizeRoutes(req, res, url, ctx) {
  const { CONFIG_PATH, LOCAL_DIR, PUBLIC_DIR, applicationsDir, automationDir, currentConfigFile, currentDockName,
    integrations, personalize, readBody } = ctx;

  // ---------- 설정 › 꾸미기 (이 맥에만) ----------
  // Dock 아이콘 — 내 그림(`local/icon.png`)이 있으면 그것, 없으면 기본 토끼. 탭 아이콘(favicon)도 이 주소다.
  if (url.pathname === '/app-icon.png' && req.method === 'GET') {
    try {
      const icon = personalize.currentIcon(LOCAL_DIR, PUBLIC_DIR);
      res.writeHead(200, { 'Content-Type': icon.type });
      res.end(icon.data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return true;
  }

  // 지금 값 — 조회라 파일을 쓰지 않는다.
  if (url.pathname === '/api/personalize' && req.method === 'GET') {
    const config = currentConfigFile();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, title: ctx.APP_TITLE, dockName: currentDockName(), customIcon: personalize.hasCustomIcon(LOCAL_DIR),
      titleSaved: typeof config.title === 'string' ? config.title : '',
    }));
    return true;
  }

  // 이름 저장(`title`·`server.dockName`만). 제목은 곧바로 화면에 쓰이고, Dock 이름이 바뀌면 Dock 앱을
  // 다시 만들어 달라는 표시 파일 하나를 쓴다(프로세스는 띄우지 않는다).
  if (url.pathname === '/api/personalize' && req.method === 'POST') {
    readBody(req)
      .then(body => integrations.savePersonalize({ configPath: CONFIG_PATH, current: currentConfigFile(), body, appsDir: applicationsDir() }))
      .then(({ config, changed }) => {
        if (typeof config.title === 'string' && config.title) ctx.APP_TITLE = config.title;
        if (changed.dockName) personalize.writeRefreshRequest(automationDir(), 'dockName');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, title: ctx.APP_TITLE, dockName: currentDockName(), refresh: changed.dockName }));
      })
      .catch((error) => {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.status ? error.message : '저장하지 못했어요.' }));
      });
    return true;
  }

  // Dock 아이콘 그림 저장·되돌리기. 그림은 `{ image: base64 }`(화면이 정사각형으로 잘라 PNG로 보낸다),
  // 되돌리기는 `{ reset: true }` — `local/icon.png` 한 파일만 쓰거나 지운다. 5MB 그림의 base64가 들어오도록
  // 이 길만 본문 한도를 8MB로 둔다.
  if (url.pathname === '/api/personalize/icon' && req.method === 'POST') {
    readBody(req, 8 * 1024 * 1024)
      .then((body) => {
        const data = body && typeof body === 'object' ? body : {};
        if (data.reset === true) {
          personalize.resetIcon(LOCAL_DIR);
        } else {
          const text = typeof data.image === 'string' ? data.image.replace(/^data:image\/(?:png|jpeg);base64,/, '') : '';
          if (!text || !/^[A-Za-z0-9+/=\s]+$/.test(text)) throw Object.assign(new Error(personalize.PERSONALIZE_MESSAGE.iconType), { status: 400 });
          personalize.saveIcon(LOCAL_DIR, Buffer.from(text, 'base64'));
        }
        personalize.writeRefreshRequest(automationDir(), data.reset === true ? 'icon-reset' : 'icon');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, customIcon: personalize.hasCustomIcon(LOCAL_DIR), refresh: true }));
      })
      .catch((error) => {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.status ? error.message : '그림을 저장하지 못했어요.' }));
      });
    return true;
  }

  // 이 컴퓨터에만 두는 꾸밈(`local/local.css`). 저장소에 없는 파일이라 **없어도 빈 200**으로 준다 —
  // 화면은 늘 같은 한 줄을 읽고, 브라우저 콘솔에 404가 남지 않는다. 허용하는 경로는 이것 하나뿐이다.
  if (url.pathname === '/local/local.css' && req.method === 'GET') {
    let css = '';
    try { css = nativeFs.readFileSync(path.join(LOCAL_DIR, 'local.css'), 'utf8'); } catch { css = ''; }
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(css);
    return true;
  }

  return false;
};
