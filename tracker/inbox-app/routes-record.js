// 회의 녹음(1차) 경로 — 녹음 창 페이지, 회의 이름 읽기, 녹음본 올리기·듣기·삭제.
// server.js의 safeHandle 공통 가드(인증·호스트·출처)를 거친 뒤 들어온다. 처리했으면 true, 내 경로가 아니면 false.
// 녹음본 파일은 업무 데이터 폴더의 `recordings/<회의 id>/<녹음 id>.webm`에 두고, 어느 회의에 붙었는지는
// `.workflow.json`의 회의 오버레이(`recordings`)에 적는다(workflow-store.js). 녹음본은 공개 저장소·백업에 들어가지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

const MEETING_ID_RE = /^[0-9a-f]{1,32}$/;
const REC_ID_RE = /^[0-9a-f]{16}$/;
const MAX_BYTES = 500 * 1024 * 1024; // 한 번에 올리는 녹음본 상한(대략 8시간 이상)
const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };
const MIME_OF = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4' };

// safeHandle이 POST 본문 형식 검사에서 이 경로의 오디오만 예외로 연다(그 밖은 JSON만).
function isRecordingUpload(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  return req.method === 'POST' && /^\/api\/meeting\/recording(?:\?|$)/.test(req.url || '') && !!AUDIO_TYPES[type];
}

module.exports = function recordRoutes(req, res, url, ctx) {
  const { RECORDINGS_DIR, PUBLIC_DIR, readBody, idempotent, workflows } = ctx;
  // 저장소 쓰기는 다른 쓰기와 같은 잠금(idempotent → mutations.run) 안에서만 — 큰 파일을 받는 동안에는 잠금을 쥐지 않는다.
  const locked = action => Promise.resolve().then(() => idempotent(req, null, action));
  const sendJson = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const meetingDir = id => path.join(RECORDINGS_DIR, id);

  // 녹음 창 — 앱이 작은 창으로 연다. 녹음은 이 창에서 돌아서 앱 창을 닫거나 새로고침해도 이어진다.
  if (url.pathname === '/record' && req.method === 'GET') {
    fs.readFile(path.join(PUBLIC_DIR, 'record.html'), (error, data) => {
      if (error) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return true;
  }

  // 녹음 창 머리에 쓸 회의 이름·날짜.
  if (url.pathname === '/api/meeting/recording/meta' && req.method === 'GET') {
    const meetingId = url.searchParams.get('meetingId') || '';
    const event = MEETING_ID_RE.test(meetingId) ? workflows.snapshot().meetings.find(item => item.id === meetingId) : null;
    if (!event) { sendJson(404, { ok: false, error: '회의를 찾지 못했어요.' }); return true; }
    sendJson(200, { ok: true, title: event.title || '', date: event.date || '', start: event.start || '' });
    return true;
  }

  // 올리기: 본문은 오디오 바이트 그대로. 임시 파일로 바로 흘려 쓰고(메모리에 쌓지 않는다), 다 받은 뒤에만
  // 이름을 바꾸고 회의에 붙인다. 중간에 끊기거나 상한을 넘으면 임시 파일을 지운다.
  if (url.pathname === '/api/meeting/recording' && req.method === 'POST') {
    const meetingId = url.searchParams.get('meetingId') || '';
    const seconds = Math.max(0, Math.min(24 * 3600, parseInt(url.searchParams.get('seconds') || '0', 10) || 0));
    const ext = AUDIO_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!MEETING_ID_RE.test(meetingId) || !ext) { req.resume(); sendJson(400, { ok: false, error: '회의를 찾지 못했어요.' }); return true; }
    // 없는 회의(오래 열어 둔 녹음 창 등)면 본문을 받기 전에 거절한다 — 큰 파일을 다 받고 버리지 않게.
    if (!workflows.snapshot().meetings.some(item => item.id === meetingId)) { req.resume(); sendJson(404, { ok: false, error: '회의를 찾을 수 없어요. 녹음은 이 창에 남아 있어요 — 파일로 받아 두세요.' }); return true; }
    const dir = meetingDir(meetingId);
    const recId = crypto.randomBytes(8).toString('hex');
    const temp = path.join(dir, `.${recId}.part`);
    let size = 0;
    let failed = false;
    const fail = (status, error) => {
      if (failed) return;
      failed = true;
      try { fs.rmSync(temp, { force: true }); } catch {}
      if (!res.headersSent) sendJson(status, { ok: false, error });
    };
    try { fs.mkdirSync(dir, { recursive: true }); } catch { req.resume(); fail(500, '녹음본을 저장하지 못했어요.'); return true; }
    const out = fs.createWriteStream(temp, { flags: 'wx' });
    out.on('error', () => { req.unpipe(out); req.resume(); fail(500, '녹음본을 저장하지 못했어요.'); });
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) { req.unpipe(out); out.destroy(); req.resume(); fail(413, '녹음이 너무 길어 저장하지 못했어요.'); }
    });
    req.on('aborted', () => { out.destroy(); fail(400, '녹음본을 받는 중에 연결이 끊겼어요.'); });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (!size) { fail(400, '녹음된 소리가 없어요.'); return; }
      const file = `${recId}.${ext}`;
      try {
        fs.renameSync(temp, path.join(dir, file));
      } catch { fail(500, '녹음본을 저장하지 못했어요.'); return; }
      Promise.resolve()
        .then(() => locked(() => workflows.addRecording({ meetingId, id: recId, file, seconds, size, createdAt: new Date().toISOString() })))
        .then((recording) => {
          if (recording.id !== recId) { try { fs.rmSync(path.join(dir, file), { force: true }); } catch {} } // 이미 저장된 같은 녹음
          sendJson(200, { ok: true, recording });
        })
        .catch((error) => {
          try { fs.rmSync(path.join(dir, file), { force: true }); } catch {}
          sendJson(/찾을 수 없/.test(error.message || '') ? 404 : /요청 식별자|같은 요청/.test(error.message || '') ? 400 : 500, { ok: false, error: error.message || '녹음본을 저장하지 못했어요.' });
        });
    });
    return true;
  }

  // 듣기: 그 회의 목록에 있는 녹음 id만 연다(파일 이름은 저장소에 적힌 것만 쓴다 — 경로를 만들지 않는다).
  // 재생기가 뒤로 감기 할 수 있게 Range(바이트 구간)를 받는다.
  if (url.pathname === '/api/meeting/recording' && req.method === 'GET') {
    const meetingId = url.searchParams.get('meetingId') || '';
    const recId = url.searchParams.get('recId') || '';
    const rec = MEETING_ID_RE.test(meetingId) && REC_ID_RE.test(recId) ? workflows.recordingFile({ meetingId, recId }) : null;
    const file = rec && /^[0-9a-f]{16}\.(webm|ogg|m4a)$/.test(rec.file) ? path.join(meetingDir(meetingId), rec.file) : null;
    let stat = null;
    try { stat = file ? fs.statSync(file) : null; } catch { stat = null; }
    if (!stat) { sendJson(404, { ok: false, error: '녹음본을 찾지 못했어요.' }); return true; }
    const type = MIME_OF[rec.file.split('.').pop()] || 'audio/webm';
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : Math.max(0, stat.size - parseInt(range[2], 10));
      let end = range[1] && range[2] ? parseInt(range[2], 10) : stat.size - 1;
      end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true;
      }
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' });
      pipeline(fs.createReadStream(file, { start, end }), res, () => {});
      return true;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    // pipeline: 듣는 사이에 지워졌거나(ENOENT) 재생기가 중간에 끊어도(뒤로 감기) 파일 손잡이를 닫고 응답만 끝낸다 —
    // 처리 안 한 스트림 오류는 서버 전체를 끈다.
    pipeline(fs.createReadStream(file), res, () => {});
    return true;
  }

  // 삭제: 기록을 먼저 지우고 파일을 지운다(파일만 남는 쪽이 기록만 남는 쪽보다 낫다).
  if (url.pathname === '/api/meeting/recording/delete' && req.method === 'POST') {
    readBody(req)
      .then(async body => {
        const meetingId = String((body && body.meetingId) || '');
        const recId = String((body && body.recId) || '');
        if (!MEETING_ID_RE.test(meetingId) || !REC_ID_RE.test(recId)) { sendJson(400, { ok: false, error: '녹음본을 찾지 못했어요.' }); return; }
        const removed = await locked(() => workflows.removeRecording({ meetingId, recId }));
        if (removed && /^[0-9a-f]{16}\.(webm|ogg|m4a)$/.test(removed.file)) {
          try { fs.rmSync(path.join(meetingDir(meetingId), removed.file), { force: true }); } catch {}
        }
        sendJson(200, { ok: true, removed: !!removed });
      }, () => sendJson(400, { ok: false, error: '요청을 읽지 못했어요.' }))
      .catch(error => { if (!res.headersSent) sendJson(500, { ok: false, error: error.message || '녹음본을 지우지 못했어요.', code: error.code }); });
    return true;
  }

  return false;
};
module.exports.isRecordingUpload = isRecordingUpload;
