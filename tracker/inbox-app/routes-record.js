// 회의 녹음 경로 — 녹음본 올리기·듣기·삭제·다른 회의로 옮기기, 전사·요약(대기열·진행·다시 시도·전사본).
// 녹음 자체는 앱 화면(meeting-record-ui.js)과 그 화면이 띄운 알약(Picture-in-Picture)에서 돈다.
// 전사·요약은 서버가 직접 돌리지 않는다 — 요청 표시 파일(`requests/meeting-transcribe.request`)만 쓰고 launchd
// `meeting-transcribe`가 meeting-transcribe.js를 돌린다(미팅 노트 가져오기와 같은 원칙). 그 실행기가 대기열을 읽고
// 진행·결과를 이 경로로 알린다. 전사본은 `recordings/<회의 id>/<녹음 id>.transcript.json`, 요약은 녹음본 줄(.workflow.json).
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
const BUSY = ['queued', 'transcribing', 'summarizing'];
const STALE_MS = 3 * 60 * 60 * 1000; // 이만큼 진행 소식이 없는 전사(실행기가 죽음)는 다시 대기열에 올린다
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const oneLine = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// 실행기가 보낸 전사본(발언 목록)을 확인한다 — 화자는 `화자N`, 시각은 초.
function cleanUtterances(list) {
  if (!Array.isArray(list) || list.length > 20000) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const start = Number(item.start), end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > 24 * 3600) return null;
    if (!/^화자\d{1,2}$/.test(String(item.speaker || ''))) return null;
    const text = oneLine(item.text, 4000);
    if (text) out.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, speaker: item.speaker, text });
  }
  return out;
}
// 실행기가 보낸 요약을 확인한다 — 원문에 없는 칸은 빈 배열. 기한은 `YYYY-MM-DD`만(말로 된 날짜는 버린다 — DECISIONS 마감일 잠금).
function cleanSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const lines = (value, count, max) => (Array.isArray(value) ? value : []).map(item => oneLine(item, max)).filter(Boolean).slice(0, count);
  const actions = (Array.isArray(summary.actions) ? summary.actions : []).slice(0, 20).map(item => ({
    task: oneLine(item && item.task, 300),
    owner: /^화자\d{1,2}$/.test(String(item && item.owner || '')) ? item.owner : '',
    due: DATE_RE.test(String(item && item.due || '')) ? item.due : '',
  })).filter(item => item.task);
  return { headline: oneLine(summary.headline, 300), topics: lines(summary.topics, 8, 300), decisions: lines(summary.decisions, 10, 300), actions, checks: lines(summary.checks, 10, 300) };
}

// safeHandle이 POST 본문 형식 검사에서 이 경로의 오디오만 예외로 연다(그 밖은 JSON만).
function isRecordingUpload(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  return req.method === 'POST' && /^\/api\/meeting\/recording(?:\?|$)/.test(req.url || '') && !!AUDIO_TYPES[type];
}

module.exports = function recordRoutes(req, res, url, ctx) {
  const { RECORDINGS_DIR, readBody, idempotent, workflows, automationDir } = ctx;
  // 저장소 쓰기는 다른 쓰기와 같은 잠금(idempotent → mutations.run) 안에서만 — 큰 파일을 받는 동안에는 잠금을 쥐지 않는다.
  const locked = action => Promise.resolve().then(() => idempotent(req, null, action));
  const sendJson = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const meetingDir = id => path.join(RECORDINGS_DIR, id);
  const transcriptFile = (meetingId, recId) => path.join(meetingDir(meetingId), `${recId}.transcript.json`);
  // 실행기를 깨운다 — 요청 표시 파일 하나만 쓴다(프로세스를 띄우지 않는다). 못 써도 녹음본은 대기열에 남아 다음 깨움에 돈다.
  const wakeTranscriber = () => {
    try {
      const file = path.join(automationDir(), 'requests', 'meeting-transcribe.request');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);
      return true;
    } catch { return false; }
  };
  const readJson = () => readBody(req, 8 * 1024 * 1024).then(body => body, () => { const error = new Error('요청을 읽지 못했어요.'); error.status = 400; throw error; });
  const fail = error => { if (!res.headersSent) sendJson(error.status || (/찾을 수 없/.test(error.message || '') ? 404 : 500), { ok: false, error: error.message || '처리하지 못했어요.', code: error.code }); };
  const recordingOf = (meetingId, recId) => {
    const event = workflows.snapshot().meetings.find(item => item.id === meetingId);
    const recording = event && Array.isArray(event.recordings) ? event.recordings.find(item => item.id === recId) : null;
    return { event, recording };
  };

  // 올리기: 본문은 오디오 바이트 그대로. 임시 파일로 바로 흘려 쓰고(메모리에 쌓지 않는다), 다 받은 뒤에만
  // 이름을 바꾸고 회의에 붙인다. 중간에 끊기거나 상한을 넘으면 임시 파일을 지운다.
  if (url.pathname === '/api/meeting/recording' && req.method === 'POST') {
    const meetingId = url.searchParams.get('meetingId') || '';
    const seconds = Math.max(0, Math.min(24 * 3600, parseInt(url.searchParams.get('seconds') || '0', 10) || 0));
    const ext = AUDIO_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!MEETING_ID_RE.test(meetingId) || !ext) { req.resume(); sendJson(400, { ok: false, error: '회의를 찾지 못했어요.' }); return true; }
    // 없는 회의면 본문을 받기 전에 거절한다 — 큰 파일을 다 받고 버리지 않게.
    if (!workflows.snapshot().meetings.some(item => item.id === meetingId)) { req.resume(); sendJson(404, { ok: false, error: '회의를 찾을 수 없어요. 녹음은 이 브라우저에 남아 있어요 — 파일로 받아 두세요.' }); return true; }
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
          else wakeTranscriber(); // 새 녹음본은 `전사 대기`로 붙었다 — 실행기를 깨운다
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
          try { fs.rmSync(transcriptFile(meetingId, recId), { force: true }); } catch {}
        }
        sendJson(200, { ok: true, removed: !!removed });
      }, () => sendJson(400, { ok: false, error: '요청을 읽지 못했어요.' }))
      .catch(error => { if (!res.headersSent) sendJson(500, { ok: false, error: error.message || '녹음본을 지우지 못했어요.', code: error.code }); });
    return true;
  }

  // 옮기기: 다른 회의에 잘못 녹음했을 때. 파일(녹음·전사본)을 먼저 옮기고(같은 디스크 안 이름 바꾸기) 기록을 바꾼다 —
  // 기록을 못 바꾸면 파일을 되돌린다. 전사·요약 중에는 실행기가 옛 회의로 알려 오므로 끝난 뒤에만 옮긴다.
  if (url.pathname === '/api/meeting/recording/move' && req.method === 'POST') {
    readJson().then(async (body) => {
      const meetingId = String((body && body.meetingId) || '');
      const recId = String((body && body.recId) || '');
      const toMeetingId = String((body && body.toMeetingId) || '');
      if (!MEETING_ID_RE.test(meetingId) || !REC_ID_RE.test(recId) || !MEETING_ID_RE.test(toMeetingId)) { sendJson(400, { ok: false, error: '녹음본을 찾지 못했어요.' }); return; }
      if (meetingId === toMeetingId) { sendJson(400, { ok: false, error: '같은 회의예요.' }); return; }
      const { recording } = recordingOf(meetingId, recId);
      if (!recording) { sendJson(404, { ok: false, error: '녹음본을 찾을 수 없어요.' }); return; }
      if (['transcribing', 'summarizing'].includes(recording.status)) { sendJson(409, { ok: false, error: '전사가 끝난 뒤에 옮길 수 있어요.' }); return; }
      if (!workflows.snapshot().meetings.some(item => item.id === toMeetingId)) { sendJson(404, { ok: false, error: '옮길 회의를 찾을 수 없어요.' }); return; }
      const files = [];
      if (/^[0-9a-f]{16}\.(webm|ogg|m4a)$/.test(recording.file || '')) files.push([path.join(meetingDir(meetingId), recording.file), path.join(meetingDir(toMeetingId), recording.file)]);
      files.push([transcriptFile(meetingId, recId), transcriptFile(toMeetingId, recId)]);
      const moved = [];
      try {
        fs.mkdirSync(meetingDir(toMeetingId), { recursive: true });
        for (const [from, to] of files) if (fs.existsSync(from)) { fs.renameSync(from, to); moved.push([from, to]); }
      } catch {
        for (const [from, to] of moved.reverse()) { try { fs.renameSync(to, from); } catch {} }
        sendJson(500, { ok: false, error: '녹음본 파일을 옮기지 못했어요.' }); return;
      }
      let saved;
      try { saved = await locked(() => workflows.moveRecording({ meetingId, recId, toMeetingId })); }
      catch (error) { for (const [from, to] of moved.reverse()) { try { fs.renameSync(to, from); } catch {} } throw error; }
      if (saved.status === 'queued') wakeTranscriber(); // 기다리던 전사는 새 회의에서 다시 집는다
      sendJson(200, { ok: true, recording: saved });
    }).catch(fail);
    return true;
  }

  // 대기열 — 실행기가 읽는다. 전사 대기, 그리고 오래 소식이 없는 진행 중(실행기가 죽었다)을 돌려준다.
  if (url.pathname === '/api/meeting/recording/queue' && req.method === 'GET') {
    const now = Date.now();
    const jobs = [];
    for (const event of workflows.snapshot().meetings) {
      for (const recording of Array.isArray(event.recordings) ? event.recordings : []) {
        const stale = BUSY.includes(recording.status) && recording.status !== 'queued' && now - Date.parse(recording.updatedAt || recording.createdAt || 0) > STALE_MS;
        if (recording.status === 'queued' || stale) jobs.push({ meetingId: event.id, recId: recording.id, seconds: recording.seconds || 0, date: event.date || '', title: event.title || '' });
      }
    }
    jobs.sort((a, b) => a.recId.localeCompare(b.recId));
    sendJson(200, { ok: true, jobs });
    return true;
  }

  // 진행·결과 — 실행기가 알린다. stage: transcribing · summarizing(+ 전사본) · done(+ 요약) · failed(+ 이유)
  if (url.pathname === '/api/meeting/recording/progress' && req.method === 'POST') {
    readJson().then(async (body) => {
      const meetingId = String((body && body.meetingId) || '');
      const recId = String((body && body.recId) || '');
      const stage = String((body && body.stage) || '');
      if (!MEETING_ID_RE.test(meetingId) || !REC_ID_RE.test(recId) || !['transcribing', 'summarizing', 'done', 'failed'].includes(stage)) { sendJson(400, { ok: false, error: '진행 알림을 확인해 주세요.' }); return; }
      const { event, recording } = recordingOf(meetingId, recId);
      if (!recording) { sendJson(404, { ok: false, error: '녹음본을 찾을 수 없어요.' }); return; }
      const patch = { meetingId, recId, status: stage };
      if (body.utterances !== undefined) {
        const utterances = cleanUtterances(body.utterances);
        if (!utterances) { sendJson(400, { ok: false, error: '전사본을 확인해 주세요.' }); return; }
        fs.mkdirSync(meetingDir(meetingId), { recursive: true });
        fs.writeFileSync(transcriptFile(meetingId, recId), JSON.stringify({ utterances }));
        patch.transcript = true;
        patch.speakers = new Set(utterances.map(item => item.speaker)).size;
      }
      if (stage === 'failed') patch.error = oneLine(body.error, 300);
      let drafts = 0;
      if (stage === 'done') {
        const summary = body.summary == null ? null : cleanSummary(body.summary);
        patch.summary = summary ? { ...summary, ...(body.summaryError ? { error: oneLine(body.summaryError, 200) } : {}) } : { error: oneLine(body.summaryError || '요약을 만들지 못했어요.', 200) };
        // 할 일·결정 후보 → 이 회의의 `AI 초안`(티로 노트와 같은 검토 흐름).
        if (summary && event.date && event.start && event.title) {
          const items = [
            ...summary.actions.map(item => ({ type: 'task', description: item.owner ? `${item.task} (${item.owner})` : item.task, ...(item.due ? { due: item.due } : {}) })),
            ...summary.checks.map(text => ({ type: 'check', description: text })),
            ...summary.decisions.map(text => ({ type: 'decision', description: text })),
          ];
          const added = await locked(() => workflows.appendRecordingDraft({ recId, date: event.date, start: event.start, end: event.end || '', title: event.title, items }));
          drafts = added.added ? added.count : 0;
        }
      }
      const saved = await locked(() => workflows.setRecordingStatus(patch));
      sendJson(200, { ok: true, recording: saved, drafts });
    }).catch(fail);
    return true;
  }

  // 다시 시도(실패했거나 이 버전 전에 녹음해 전사하지 않은 녹음본, 또는 끝났지만 `다시 전사·요약`을 누른 녹음본) — 대기열에 올리고 실행기를 깨운다.
  // 다시 돌려도 AI 초안은 그 녹음에서 아직 하나도 안 나왔을 때만 들어간다(초안 파일은 끝에 추가만 — 같은 후보를 두 번 넣지 않게).
  if (url.pathname === '/api/meeting/recording/retry' && req.method === 'POST') {
    readJson().then(async (body) => {
      const meetingId = String((body && body.meetingId) || '');
      const recId = String((body && body.recId) || '');
      if (!MEETING_ID_RE.test(meetingId) || !REC_ID_RE.test(recId)) { sendJson(400, { ok: false, error: '녹음본을 찾지 못했어요.' }); return; }
      const { recording } = recordingOf(meetingId, recId);
      if (!recording) { sendJson(404, { ok: false, error: '녹음본을 찾을 수 없어요.' }); return; }
      if (BUSY.includes(recording.status)) { sendJson(409, { ok: false, error: '이미 전사하고 있어요.' }); return; }
      const saved = await locked(() => workflows.setRecordingStatus({ meetingId, recId, status: 'queued' }));
      wakeTranscriber();
      sendJson(200, { ok: true, recording: saved });
    }).catch(fail);
    return true;
  }

  // 전사본 읽기 — 화면이 `전사본 보기`를 펼칠 때.
  if (url.pathname === '/api/meeting/recording/transcript' && req.method === 'GET') {
    const meetingId = url.searchParams.get('meetingId') || '';
    const recId = url.searchParams.get('recId') || '';
    const rec = MEETING_ID_RE.test(meetingId) && REC_ID_RE.test(recId) ? workflows.recordingFile({ meetingId, recId }) : null;
    let data = null;
    try { data = rec ? JSON.parse(fs.readFileSync(transcriptFile(meetingId, recId), 'utf8')) : null; } catch { data = null; }
    if (!data || !Array.isArray(data.utterances)) { sendJson(404, { ok: false, error: '전사본이 없어요.' }); return true; }
    sendJson(200, { ok: true, utterances: data.utterances });
    return true;
  }

  return false;
};
module.exports.isRecordingUpload = isRecordingUpload;
module.exports.cleanSummary = cleanSummary;
module.exports.cleanUtterances = cleanUtterances;
