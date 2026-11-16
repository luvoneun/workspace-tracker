// 서버: 회의 녹음 — 녹음본 올리기·듣기·옮기기·삭제, 본문 형식 예외. 공용 준비는 test-support.js.
// 실제 마이크·브라우저는 쓰지 않는다: 가짜 바이트를 올려 저장 위치·회의 연결·되돌려 받기만 확인한다.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./test-support');
const { directory } = support;
let base;
before(async () => { base = await support.ready(); });

const RECORDINGS = path.join(directory, 'recordings');
const MEETING = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const workflowFile = path.join(directory, '.workflow.json');
const seedMeeting = () => {
  fs.rmSync(RECORDINGS, { recursive: true, force: true });
  fs.writeFileSync(workflowFile, JSON.stringify({ items: {}, meetings: { [MEETING]: { id: MEETING, title: '주간 회의', date: support.today, start: '10:00' } } }));
};
const upload = (body, { meetingId = MEETING, type = 'audio/webm', seconds = 42 } = {}) =>
  fetch(`${base}/api/meeting/recording?meetingId=${meetingId}&seconds=${seconds}`, { method: 'POST', headers: { 'Content-Type': type }, body });

test('녹음본: 올리면 데이터 폴더 recordings/<회의>/에 쓰고 회의에 붙인다 → 들을 수 있다 → 지우면 둘 다 사라진다', async () => {
  seedMeeting();
  const bytes = Buffer.from('fake-webm-bytes-0123456789');
  const up = await upload(bytes);
  const body = await up.json();
  assert.equal(up.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.recording.seconds, 42);
  assert.match(body.recording.id, /^[0-9a-f]{16}$/);
  const file = path.join(RECORDINGS, MEETING, body.recording.file);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(path.join(RECORDINGS, MEETING)), [body.recording.file]); // 임시 파일이 남지 않는다

  // 회의 스냅샷에 실린다(앱이 패널에서 그대로 읽는다).
  const state = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  assert.equal(state.meetings[MEETING].title, '주간 회의');
  assert.equal(state.meetings[MEETING].recordings.length, 1);

  const got = await fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&recId=${body.recording.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'audio/webm');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);

  // 뒤로 감기용 바이트 구간
  const part = await fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&recId=${body.recording.id}`, { headers: { Range: 'bytes=5-8' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 5-8/${bytes.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), bytes.subarray(5, 9).toString());

  const removed = await support.post('/api/meeting/recording/delete', { meetingId: MEETING, recId: body.recording.id });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(file), false);
  const after = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  assert.equal(after.meetings[MEETING].recordings, undefined);
  assert.equal(after.meetings[MEETING].title, '주간 회의'); // 회의 기록 자체는 그대로
});

test('녹음본: 오디오 형식만 JSON 예외로 열리고, 다른 형식·다른 경로는 그대로 막힌다', async () => {
  seedMeeting();
  assert.equal((await upload(Buffer.from('x'), { type: 'text/plain' })).status, 403);
  const other = await fetch(`${base}/api/workflow/meeting`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('x') });
  assert.equal(other.status, 403);
  const cross = await fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&seconds=1`, { method: 'POST', headers: { 'Content-Type': 'audio/webm', Origin: 'http://evil.test' }, body: Buffer.from('x') });
  assert.equal(cross.status, 403);
  assert.equal(fs.existsSync(path.join(RECORDINGS, MEETING)), false);
});

test('녹음본: 잘못된 회의 식별자·없는 회의·빈 본문은 거절하고 파일을 남기지 않는다', async () => {
  seedMeeting();
  assert.equal((await upload(Buffer.from('x'), { meetingId: '..%2Fetc' })).status, 400);
  const missing = 'f'.repeat(24);
  const gone = await upload(Buffer.from('x'), { meetingId: missing });
  assert.equal(gone.status, 404);
  assert.equal(fs.existsSync(path.join(RECORDINGS, missing)), false, '없는 회의면 받기 전에 거절해 폴더도 만들지 않는다');
  const empty = await upload(Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.deepEqual(fs.readdirSync(path.join(RECORDINGS, MEETING)), []);
});

test('녹음본: 목록에 없는 녹음 id는 들을 수 없다(파일 이름을 만들지 않는다)', async () => {
  seedMeeting();
  const miss = await fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&recId=${'b'.repeat(16)}`);
  assert.equal(miss.status, 404);
  const odd = await fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&recId=..%2F..%2Fx`);
  assert.equal(odd.status, 404);
});

test('녹음 창은 없다: 녹음은 앱 화면에서 돈다 — /record·meta는 없고, 서버 파일은 화면 파일로 나가지 않는다', async () => {
  seedMeeting();
  assert.equal((await fetch(`${base}/record?meetingId=${MEETING}`)).status, 404);
  assert.equal((await fetch(`${base}/api/meeting/recording/meta?meetingId=${MEETING}`)).status, 404);
  assert.equal((await fetch(`${base}/routes-record.js`)).status, 404);
});

test('녹음본: 응답을 잃어 같은 열쇠로 다시 저장해도 한 번만 붙고 새 파일은 남지 않는다', async () => {
  seedMeeting();
  const send = () => fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&seconds=5`, {
    method: 'POST', headers: { 'Content-Type': 'audio/webm', 'Idempotency-Key': 'rec-key-0123456789abcdef' }, body: Buffer.from('same-audio'),
  }).then(response => response.json());
  const first = await send();
  const second = await send();
  assert.equal(first.ok, true);
  assert.equal(second.recording.id, first.recording.id);
  const state = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  assert.equal(state.meetings[MEETING].recordings.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(RECORDINGS, MEETING)), [first.recording.file]);
});

test('녹음본: 오늘 회의에 프로젝트를 연결해(제목별 연결) 캘린더 원본으로 덮어도 녹음본 목록이 남는다', () => {
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-record-store-'));
  try {
    const day = support.today;
    const store = require('./workflow-store')({
      directory: home, refs: () => ({}), calendar: () => ({ events: [{ start: '10:00', end: '11:00', title: '주간 회의' }] }), today: () => day, validateDate: () => {},
      create: {}, remove: () => {}, move: () => {},
    });
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
    const id = store.snapshot().meetings[0].id; // 캘린더에서 온 오늘 회의 — 아직 기록이 없다
    store.addRecording({ meetingId: id, id: '0123456789abcdef', file: '0123456789abcdef.webm', seconds: 3, size: 1 });
    store.syncProject('주간 회의', { type: 'group', value: '기획', label: '기획' }, id);
    const after = JSON.parse(fs.readFileSync(path.join(home, '.workflow.json'), 'utf8')).meetings[id];
    assert.equal(after.project.value, '기획');
    assert.equal(after.recordings.length, 1);
    assert.equal(store.recordingFile({ meetingId: id, recId: '0123456789abcdef' }).file, '0123456789abcdef.webm');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------- 전사·화자 구분·요약 ----------
const { automationHome } = support;
const transcriber = require('./meeting-transcribe');
const requestFile = path.join(automationHome, 'requests', 'meeting-transcribe.request');
const draftsPath = path.join(directory, 'meeting_drafts.json');
const progress = body => support.post('/api/meeting/recording/progress', { meetingId: MEETING, ...body });
const snapshotMeeting = async () => (await support.items()).workflows.meetings.find(item => item.id === MEETING);

test('실행기 계산: 화자 구간 읽기·글 조각에 화자 붙이기(무음의 지어낸 말은 버림)·요약 JSON 꺼내기', () => {
  const turns = transcriber.parseDiarization('Started\n0.031 -- 6.713 speaker_01\n7.473 -- 13.970 speaker_00\n14.712 -- 21.901 speaker_01\nDuration : 17 s');
  assert.deepEqual(turns.map(turn => turn.speaker), ['speaker_01', 'speaker_00', 'speaker_01']);
  const segments = transcriber.parseWhisper({ transcription: [
    { offsets: { from: 0, to: 3000 }, text: ' 안녕하세요.' },
    { offsets: { from: 3000, to: 6500 }, text: ' 일정 정해요.' },
    { offsets: { from: 7520, to: 13820 }, text: ' 목요일까지 할게요.' },
    { offsets: { from: 14760, to: 21540 }, text: ' 화요일로 확정하죠.' },
    { offsets: { from: 30000, to: 59980 }, text: ' 자막 제공 및 광고를 포함하고 있습니다.' },
  ] });
  const merged = transcriber.mergeTranscript(segments, turns);
  assert.deepEqual(merged.map(item => [item.speaker, item.text]), [
    ['화자1', '안녕하세요. 일정 정해요.'],
    ['화자2', '목요일까지 할게요.'],
    ['화자1', '화요일로 확정하죠.'],
  ]);
  assert.deepEqual(transcriber.parseSummary('여기요\n```json\n{"headline":"한 줄","topics":[]}\n```'), { headline: '한 줄', topics: [] });
  assert.equal(transcriber.parseSummary('JSON 없음'), null);
  // 혼자 길게 말해도 한 발언은 1,500자를 넘지 않게 나눈다(서버 상한 4,000자에서 잘리지 않게)
  const long = Array.from({ length: 40 }, (_, i) => ({ start: i, end: i + 1, text: '가'.repeat(100) }));
  const split = transcriber.mergeTranscript(long, [{ start: 0, end: 40, speaker: 'speaker_00' }]);
  assert.ok(split.length > 1 && split.every(item => item.text.length <= 1500));
  assert.equal(split.map(item => item.text.replace(/ /g, '')).join('').length, 4000);
  assert.match(transcriber.summaryPrompt({ date: '2026-11-06', title: '주간' }, merged), /<transcript>\n\[00:00\] 화자1: 안녕하세요/);
  assert.match(transcriber.summaryPrompt({ date: '2026-11-06', title: '주간' }, merged), /"checks"/, '확인할 것도 찾는다');
  // 화자 구분이 한 사람을 잘게 쪼개도(긴 회의에서 수십 명) 말한 시간이 2%도 안 되는 화자는 세지 않는다 — 겹치는 큰 화자, 없으면 앞 발언의 화자로.
  const shards = [{ start: 0, end: 300, speaker: 'speaker_00' }, { start: 300, end: 305, speaker: 'speaker_07' }, { start: 305, end: 600, speaker: 'speaker_01' }, { start: 600, end: 603, speaker: 'speaker_09' }];
  const pieces = [{ start: 0, end: 290, text: '가' }, { start: 300, end: 305, text: '나' }, { start: 310, end: 590, text: '다' }, { start: 600, end: 603, text: '라' }];
  assert.deepEqual(transcriber.mergeTranscript(pieces, shards).map(item => [item.speaker, item.text]), [['화자1', '가'], ['화자1', '나'], ['화자2', '다'], ['화자2', '라']]);
});

test('전사: 새 녹음본은 `전사 대기`로 붙고 실행기를 깨운다 → 대기열 → 진행 → 완료면 요약·전사본·AI 초안(티로 노트로 세지 않음)', async () => {
  seedMeeting();
  fs.rmSync(requestFile, { force: true });
  fs.rmSync(draftsPath, { force: true });
  const up = await (await upload(Buffer.from('audio'))).json();
  assert.equal(up.recording.status, 'queued');
  assert.ok(fs.existsSync(requestFile), '요청 표시 파일만 쓴다(프로세스를 띄우지 않는다)');
  const recId = up.recording.id;
  const queue = await (await fetch(`${base}/api/meeting/recording/queue`)).json();
  assert.deepEqual(queue.jobs.map(job => job.recId), [recId]);

  assert.equal((await progress({ recId, stage: 'transcribing' })).recording.status, 'transcribing');
  assert.deepEqual((await (await fetch(`${base}/api/meeting/recording/queue`)).json()).jobs, [], '진행 중은 대기열에서 빠진다');
  const utterances = [{ start: 0, end: 3, speaker: '화자1', text: '출시는 화요일로 하죠.' }, { start: 3, end: 6, speaker: '화자2', text: '버그 목록은 제가 공유할게요.' }];
  const mid = await progress({ recId, stage: 'summarizing', utterances });
  assert.equal(mid.recording.transcript, true);
  assert.equal(mid.recording.speakers, 2);
  const done = await progress({ recId, stage: 'done', summary: {
    headline: '출시 일정 확정', topics: ['일정'], decisions: ['출시는 화요일'],
    actions: [{ task: '버그 목록 공유', owner: '화자2', due: '다음 주' }, { task: '결제 확인', owner: '', due: '2026-11-14' }],
    checks: ['법무팀에 약관 문구 확인'],
  } });
  assert.equal(done.drafts, 4);
  assert.equal(done.recording.status, 'done');
  assert.equal(done.recording.summary.actions[0].due, '', '말로 된 날짜는 기한으로 넣지 않는다');

  const transcript = await (await fetch(`${base}/api/meeting/recording/transcript?meetingId=${MEETING}&recId=${recId}`)).json();
  assert.deepEqual(transcript.utterances.map(item => item.speaker), ['화자1', '화자2']);
  const meeting = await snapshotMeeting();
  assert.deepEqual(meeting.drafts.map(draft => [draft.type, draft.description, draft.due || '']), [
    ['task', '버그 목록 공유 (화자2)', ''], ['task', '결제 확인', '2026-11-14'], ['check', '법무팀에 약관 문구 확인', ''], ['decision', '출시는 화요일', ''],
  ]);
  assert.equal(meeting.tiroNotes, undefined, '녹음 요약의 초안은 티로 노트로 세지 않는다');
  // 같은 결과가 또 와도(실행기 재시도) 초안을 두 번 넣지 않는다
  const same = { headline: '출시 일정 확정', topics: ['일정'], decisions: ['출시는 화요일'], actions: [{ task: '버그 목록 공유', owner: '화자2', due: '다음 주' }, { task: '결제 확인', owner: '', due: '2026-11-14' }], checks: ['법무팀에 약관 문구 확인'] };
  assert.equal((await progress({ recId, stage: 'done', summary: same })).drafts, 0);
  assert.equal(JSON.parse(fs.readFileSync(draftsPath, 'utf8')).notes.length, 1);
  // 요약을 다시 돌려 후보가 달라지면: 이미 담은 것은 그대로, 아직 고르지 않은 옛 후보는 새 후보로 바뀐다(초안 파일은 끝에 추가만).
  const first = (await snapshotMeeting()).drafts;
  const keep = first.find(draft => draft.description === '출시는 화요일');
  assert.equal((await support.post('/api/workflow/review', { meetingId: MEETING, accept: [{ id: keep.id, type: keep.type, description: keep.description }] })).status, 200);
  const redone = await progress({ recId, stage: 'done', summary: { headline: 'x', decisions: ['출시는 화요일'], actions: [{ task: '릴리스 노트 쓰기' }] } });
  assert.equal(redone.drafts, 2);
  const notes = JSON.parse(fs.readFileSync(draftsPath, 'utf8')).notes;
  assert.equal(notes.length, 2, '고쳐 쓰지 않고 끝에 덧붙인다');
  assert.deepEqual((await snapshotMeeting()).drafts.map(draft => draft.description), ['릴리스 노트 쓰기'], '담은 후보는 다시 뜨지 않고, 옛 후보(버그 목록 공유 등)는 빠진다');
  // 다시 돌린 요약에 후보가 하나도 없으면 빈 노트로 남은 옛 후보를 비운다
  assert.equal((await progress({ recId, stage: 'done', summary: { headline: 'y' } })).drafts, 0);
  assert.deepEqual((await snapshotMeeting()).drafts, []);
  // 지우면 전사본 파일도 지운다
  await support.post('/api/meeting/recording/delete', { meetingId: MEETING, recId });
  assert.equal(fs.existsSync(path.join(RECORDINGS, MEETING, `${recId}.transcript.json`)), false);
});

test('전사: 실패하면 이유를 남기고 `다시 시도`로 대기열에 올린다 — 진행 중에는 막고, 끝난 것은 `다시 전사·요약`', async () => {
  seedMeeting();
  const { recording } = await (await upload(Buffer.from('audio'))).json();
  const recId = recording.id;
  assert.equal((await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId })).status, 409, '이미 대기 중');
  const failed = await progress({ recId, stage: 'failed', error: transcriber.WORDS.silent });
  assert.equal(failed.recording.error, transcriber.WORDS.silent);
  fs.rmSync(requestFile, { force: true });
  const again = await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId });
  assert.equal(again.recording.status, 'queued');
  assert.equal(again.recording.error, undefined);
  assert.ok(fs.existsSync(requestFile));
  assert.equal((await progress({ recId, stage: 'done', summary: null, summaryError: 'x' })).recording.summary.error, 'x');
  const rerun = await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId });
  assert.equal(rerun.recording.status, 'queued', '끝난 녹음본도 `다시 전사·요약`으로 처음부터 다시 돈다');
  assert.equal(rerun.recording.summary, undefined);
  assert.equal((await progress({ recId, stage: 'summarizing', utterances: [{ start: 0, end: 1, speaker: '../x', text: 'a' }] })).status, 400, '화자 이름은 화자N만');
  // `요약 다시 하기`(only: summary)는 전사본이 있어야 한다 — 범위 값이 이상하면 400
  await progress({ recId, stage: 'done', summary: null, summaryError: 'x' });
  assert.equal((await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId, only: 'summary' })).status, 409, '전사본 없음');
  assert.equal((await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId, only: 'all' })).status, 400);
});

test('실행기: 가짜 도구(ffmpeg·whisper·sherpa·claude)로 녹음 하나를 받아 전사·요약까지 앱에 알린다', async () => {
  seedMeeting();
  fs.rmSync(draftsPath, { force: true });
  const { recording } = await (await upload(Buffer.from('audio'))).json();
  const bin = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'workspace-fake-tools-'));
  const script = (name, body) => { const file = path.join(bin, name); fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 }); return file; };
  const env = {
    ...process.env,
    WORKSPACE_PORT: new URL(base).port,
    WORKSPACE_FFMPEG: script('ffmpeg', "const a=process.argv; require('fs').writeFileSync(a[a.length-1],'wav');"),
    WORKSPACE_WHISPER: script('whisper', "const a=process.argv; const of=a[a.indexOf('-of')+1]; require('fs').writeFileSync(of+'.json', JSON.stringify({transcription:[{offsets:{from:0,to:3000},text:' 출시는 화요일로 확정하죠.'},{offsets:{from:3500,to:6000},text:' 버그 목록은 제가 공유할게요.'}]}));"),
    WORKSPACE_WHISPER_MODEL: __filename,
    WORKSPACE_SHERPA_DIARIZE: script('sherpa', "console.log('0.0 -- 3.2 speaker_00'); console.log('3.4 -- 6.1 speaker_01');"),
    CLAUDE_BIN: script('claude', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{ if(!s.includes('<transcript>'))process.exit(2); console.log(JSON.stringify({headline:'출시 확정',topics:[],decisions:['출시는 화요일'],actions:[{task:'버그 목록 공유',owner:'화자2',due:''}]})); });"),
    AUTOMATION_LOG_DIR: path.join(bin, 'logs'),
  };
  try {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'meeting-transcribe.js')], { env, stdio: 'ignore' });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, fs.readFileSync(path.join(bin, 'logs', 'meeting-transcribe.log'), 'utf8'));
    const saved = (await snapshotMeeting()).recordings.find(item => item.id === recording.id);
    assert.equal(saved.status, 'done');
    assert.equal(saved.speakers, 2);
    assert.equal(saved.summary.headline, '출시 확정');
    const meeting = await snapshotMeeting();
    assert.deepEqual(meeting.drafts.map(draft => draft.description), ['버그 목록 공유 (화자2)', '출시는 화요일']);
    assert.match(fs.readFileSync(path.join(bin, 'logs', 'meeting-transcribe.log'), 'utf8'), /meeting-transcribe 시작[\s\S]*완료 — 발언 2개, 초안 2개[\s\S]*종료 \(exit 0\)/);

    // `요약 다시 하기` — 대기열에 `only: summary`로 오고, 실행기는 녹음·whisper·화자 구분 없이 저장된 전사본으로 요약만 다시 한다.
    const redo = await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId: recording.id, only: 'summary' });
    assert.equal(redo.recording.status, 'queued');
    assert.equal(redo.recording.redo, 'summary');
    assert.equal(redo.recording.transcript, true, '전사본은 그대로');
    const queued = (await (await fetch(`${base}/api/meeting/recording/queue`)).json()).jobs.find(job => job.recId === recording.id);
    assert.equal(queued.only, 'summary');
    // 요약 중에도 범위를 잊지 않는다(실행기가 죽어 오래 뒤 다시 돌 때도 요약만)
    assert.equal((await progress({ recId: recording.id, stage: 'summarizing' })).recording.redo, 'summary');
    assert.equal((await progress({ recId: recording.id, stage: 'transcribing' })).recording.redo, undefined, '전사 단계로 가면 처음부터');
    await progress({ recId: recording.id, stage: 'done', summary: null, summaryError: 'x' });
    assert.equal((await support.post('/api/meeting/recording/retry', { meetingId: MEETING, recId: recording.id, only: 'summary' })).recording.redo, 'summary');
    const again = { ...env,
      WORKSPACE_FFMPEG: '/nonexistent/ffmpeg', WORKSPACE_WHISPER: '/nonexistent/whisper', WORKSPACE_SHERPA_DIARIZE: '/nonexistent/sherpa',
      CLAUDE_BIN: script('claude2', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{ if(!s.includes('버그 목록은 제가 공유할게요'))process.exit(2); console.log(JSON.stringify({headline:'다시 한 요약',topics:[],decisions:['출시는 화요일'],actions:[{task:'릴리스 노트 쓰기',owner:'',due:''}]})); });"),
    };
    const child2 = spawn(process.execPath, [path.join(__dirname, 'meeting-transcribe.js')], { env: again, stdio: 'ignore' });
    assert.equal(await new Promise(resolve => child2.on('close', resolve)), 0);
    const resaved = (await snapshotMeeting()).recordings.find(item => item.id === recording.id);
    assert.equal(resaved.status, 'done');
    assert.equal(resaved.redo, undefined);
    assert.equal(resaved.speakers, 2, '화자 구분은 그대로');
    assert.equal(resaved.summary.headline, '다시 한 요약');
    assert.deepEqual((await snapshotMeeting()).drafts.map(draft => draft.description), ['릴리스 노트 쓰기', '출시는 화요일']);
    assert.match(fs.readFileSync(path.join(bin, 'logs', 'meeting-transcribe.log'), 'utf8'), /요약만 다시 — 발언 2개, 초안 2개/);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

// ---------- 음성 인식 도구: 찾기·상태·준비 요청·저절로 받아 깔기 ----------
const meetingTools = require('./meeting-tools');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const toolsHome = process.env.WORKSPACE_MEETING_TOOLS;
const toolsRequest = () => JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const toolsNow = async () => (await fetch(`${base}/api/meeting/tools`)).json();
const withArch = async (arch, fn) => {
  const before = process.env.WORKSPACE_MEETING_ARCH;
  process.env.WORKSPACE_MEETING_ARCH = arch;
  try { return await fn(); } finally { if (before === undefined) delete process.env.WORKSPACE_MEETING_ARCH; else process.env.WORKSPACE_MEETING_ARCH = before; }
};
const touch = (file, body = 'x', mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode }); return file; };

test('도구 자리: 이 앱이 받은 bin → Homebrew 순서, 모델은 이미 있는 큰 모델 → 새 q5 모델', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tools-locate-'));
  try {
    const dir = path.join(root, 'meeting');
    const brew = path.join(root, 'brew');
    const env = { WORKSPACE_MEETING_TOOLS: dir, WORKSPACE_MEETING_SYSTEM_BIN: brew };
    touch(path.join(brew, 'ffmpeg')); touch(path.join(brew, 'whisper-cli'));
    let t = meetingTools.locate(env);
    assert.equal(t.ffmpeg, path.join(brew, 'ffmpeg'), '예전 Homebrew 설치도 그대로 쓴다');
    assert.equal(t.whisperModel, path.join(dir, 'models', meetingTools.MODEL_Q5), '모델이 없으면 받을 자리(q5)');
    assert.deepEqual(meetingTools.missing(t, env), ['sherpa', 'seg', 'emb', 'model']);
    touch(path.join(dir, 'bin', 'ffmpeg')); touch(path.join(dir, 'bin', 'whisper-cli'));
    touch(path.join(dir, 'models', meetingTools.MODEL_Q5));
    t = meetingTools.locate(env);
    assert.equal(t.ffmpeg, path.join(dir, 'bin', 'ffmpeg'), '이 앱이 받은 것이 먼저');
    assert.equal(t.whisper, path.join(dir, 'bin', 'whisper-cli'));
    assert.equal(t.whisperModel, path.join(dir, 'models', meetingTools.MODEL_Q5));
    touch(path.join(dir, 'models', meetingTools.MODEL_FULL));
    assert.equal(meetingTools.locate(env).whisperModel, path.join(dir, 'models', meetingTools.MODEL_FULL), '이미 받아 둔 큰 모델이 있으면 그것');
    assert.equal(meetingTools.locate({ ...env, WORKSPACE_FFMPEG: '/x/ffmpeg' }).ffmpeg, '/x/ffmpeg', '시험용 환경 변수가 가장 먼저');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('도구 상태·준비 요청: 서버는 상태를 읽고 요청 파일(prepare)만 쓴다 — 받는 중 %·실패·인텔 맥', async () => {
  fs.rmSync(toolsHome, { recursive: true, force: true });
  fs.rmSync(requestFile, { force: true });
  await withArch('arm64', async () => {
    const first = await toolsNow();
    assert.equal(first.state, 'missing');
    assert.ok(first.size > 600e6 && first.size < 700e6, '받을 크기(약 0.7GB)');
    const asked = await support.post('/api/meeting/tools/prepare', {});
    assert.equal(asked.ok, true);
    assert.equal(asked.state, 'requested');
    assert.equal(toolsRequest().prepare, true, '요청 표시 파일에 준비 표시만 쓴다(프로세스를 띄우지 않는다)');
    assert.equal(fs.existsSync(toolsHome), false, '서버는 도구 폴더에 아무것도 쓰지 않는다');
    // 실행기가 적는 진행(install.json)을 그대로 보여 준다
    meetingTools.writeStatus({ stage: 'downloading', step: 'model', percent: 42, bytes: 1, total: 2 });
    const busy = await toolsNow();
    assert.deepEqual([busy.state, busy.percent], ['installing', 42]);
    fs.rmSync(requestFile, { force: true });
    assert.equal((await support.post('/api/meeting/tools/prepare', {})).state, 'installing');
    assert.equal(fs.existsSync(requestFile), false, '받는 중이면 요청을 또 쓰지 않는다');
    meetingTools.writeStatus({ stage: 'failed', error: meetingTools.WORDS.checksum });
    const failed = await toolsNow();
    assert.deepEqual([failed.state, failed.error], ['failed', meetingTools.WORDS.checksum]);
    // 실패한 뒤 `다시 받기` → 다시 요청
    assert.equal((await support.post('/api/meeting/tools/prepare', {})).state, 'requested');
  });
  await withArch('x64', async () => {
    assert.equal((await toolsNow()).state, 'unsupported');
    const no = await support.post('/api/meeting/tools/prepare', {});
    assert.equal(no.status, 409);
    assert.equal(no.error, meetingTools.WORDS.unsupported);
  });
  fs.rmSync(toolsHome, { recursive: true, force: true });
});

test('설치: 확인 값(sha256)이 다르면 실패로 적고 받은 파일을 남기지 않는다(.part도 지움)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tools-bad-'));
  try {
    const env = { WORKSPACE_MEETING_TOOLS: dir, WORKSPACE_MEETING_SYSTEM_BIN: path.join(dir, 'none'), WORKSPACE_MEETING_ARCH: 'arm64' };
    const body = Buffer.from('not the real model');
    const manifest = [{ id: 'model', label: '음성 인식 모델', url: 'https://example.test/model.bin', size: body.length, sha256: '0'.repeat(64), kind: 'file', dest: `models/${meetingTools.MODEL_Q5}` }];
    const result = await meetingTools.install({ env, manifest, fetchImpl: async () => new Response(body), run: async () => ({ code: 0 }) });
    assert.equal(result.ok, false);
    assert.equal(result.error, meetingTools.WORDS.checksum);
    assert.equal(fs.existsSync(path.join(dir, 'models', meetingTools.MODEL_Q5)), false, '완성본 자리에 아무것도 없다');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'downloads')), [], '반쪽 파일도 남지 않는다');
    assert.equal(meetingTools.readStatus(env).stage, 'failed');
    assert.equal(fs.existsSync(path.join(dir, '.install.lock')), false, '잠금은 풀린다');
    // 크기가 적힌 것보다 크면 받다가 멈춘다
    const big = await meetingTools.install({ env, manifest: [{ ...manifest[0], size: 3 }], fetchImpl: async () => new Response(body), run: async () => ({ code: 0 }) });
    assert.equal(big.error, meetingTools.WORDS.checksum);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'downloads')), []);
    // 인텔 맥이면 받지 않는다
    const intel = await meetingTools.install({ env: { ...env, WORKSPACE_MEETING_ARCH: 'x64' }, manifest, fetchImpl: async () => { throw new Error('받으면 안 됨'); } });
    assert.equal(intel.unsupported, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 가짜 도구 꾸러미를 이 시험이 띄운 작은 서버에서 내준다(바깥 네트워크에 닿지 않는다). 받는 목록(주소·크기·sha256)은 시험용 목록 파일로.
function fakeToolPackages(root) {
  const src = path.join(root, 'src');
  const node = body => `#!${process.execPath}\n${body}\n`;
  touch(path.join(src, 'tools', 'bin', 'ffmpeg'), node("const a=process.argv; require('fs').writeFileSync(a[a.length-1],'wav');"), 0o755);
  touch(path.join(src, 'tools', 'bin', 'whisper-cli'), node("const a=process.argv; const of=a[a.indexOf('-of')+1]; require('fs').writeFileSync(of+'.json', JSON.stringify({transcription:[{offsets:{from:0,to:3000},text:' 출시는 화요일로 확정하죠.'},{offsets:{from:3500,to:6000},text:' 버그 목록은 제가 공유할게요.'}]}));"), 0o755);
  touch(path.join(src, 'tools', 'LICENSES', 'x.txt'));
  touch(path.join(src, 'tools', 'BUILD.txt'));
  touch(path.join(src, 'sherpa', 'sherpa-x', 'bin', 'sherpa-onnx-offline-speaker-diarization'), node("console.log('0.0 -- 3.2 speaker_00'); console.log('3.4 -- 6.1 speaker_01');"), 0o755);
  touch(path.join(src, 'seg', 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'));
  const files = {};
  const tar = (name, dir, flag) => {
    const out = path.join(root, name);
    const made = spawnSync('/usr/bin/tar', [flag, out, '-C', dir, '.'], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    files[name] = fs.readFileSync(out);
  };
  tar('tools.tar.gz', path.join(src, 'tools'), '-czf');
  tar('sherpa.tar.bz2', path.join(src, 'sherpa'), '-cjf');
  tar('seg.tar.bz2', path.join(src, 'seg'), '-cjf');
  files['emb.onnx'] = Buffer.from('emb');
  files['model.bin'] = Buffer.alloc(64 * 1024, 7);
  return files;
}
function serveFiles(files, { holdModel = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    if (!files[name]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': files[name].length });
    // 모델은 앞 절반만 먼저 보내고 붙잡아 둔다 — 받는 중(%)을 볼 수 있게.
    if (name === 'model.bin' && holdModel) {
      const half = files[name].length / 2;
      res.write(files[name].subarray(0, half));
      await holdModel;
      res.end(files[name].subarray(half));
      return;
    }
    res.end(files[name]);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function fakeManifest(files, at) {
  const sha = name => crypto.createHash('sha256').update(files[name]).digest('hex');
  const item = (id, name, rest) => ({ id, label: id, url: `${at}/${name}`, size: files[name].length, sha256: sha(name), ...rest });
  return [
    item('tools', 'tools.tar.gz', { kind: 'tar', moves: [['bin/whisper-cli', 'bin/whisper-cli'], ['bin/ffmpeg', 'bin/ffmpeg'], ['LICENSES', 'licenses/meeting-tools']] }),
    item('sherpa', 'sherpa.tar.bz2', { kind: 'tar', moves: [['sherpa-x', 'sherpa/sherpa-x']] }),
    item('seg', 'seg.tar.bz2', { kind: 'tar', moves: [['sherpa-onnx-pyannote-segmentation-3-0', 'models/sherpa-onnx-pyannote-segmentation-3-0']] }),
    item('emb', 'emb.onnx', { kind: 'file', dest: 'models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx' }),
    item('model', 'model.bin', { kind: 'file', dest: `models/${meetingTools.MODEL_Q5}` }),
  ];
}
const waitFor = async (check, ms = 15000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('기다리던 상태가 오지 않았어요');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('실행기: 도구가 없으면 먼저 받아 깔고(그동안 녹음본은 `전사 대기`, 화면은 받는 중 %) 다 깔리면 저절로 전사·요약까지 간다', async () => {
  seedMeeting();
  fs.rmSync(draftsPath, { force: true });
  fs.rmSync(toolsHome, { recursive: true, force: true });
  const { recording } = await (await upload(Buffer.from('audio'))).json();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tools-auto-'));
  let release;
  const holdModel = new Promise((resolve) => { release = resolve; });
  const files = fakeToolPackages(root);
  const fileServer = await serveFiles(files, { holdModel });
  try {
    const manifestFile = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(fakeManifest(files, `http://127.0.0.1:${fileServer.address().port}`)));
    const claude = touch(path.join(root, 'claude'), `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{ console.log(JSON.stringify({headline:'출시 확정',topics:[],decisions:['출시는 화요일'],actions:[]})); });\n`, 0o755);
    const env = { ...process.env, WORKSPACE_PORT: new URL(base).port, WORKSPACE_MEETING_ARCH: 'arm64', WORKSPACE_MEETING_TOOLS_MANIFEST: manifestFile, CLAUDE_BIN: claude, AUTOMATION_LOG_DIR: path.join(root, 'logs') };
    await withArch('arm64', async () => {
      const child = spawn(process.execPath, [path.join(__dirname, 'meeting-transcribe.js')], { env, stdio: 'ignore' });
      const closed = new Promise(resolve => child.on('close', resolve));
      // 모델을 받는 동안(서버가 붙잡아 둠): 화면은 받는 중, 녹음본은 아직 `전사 대기`
      const busy = await waitFor(async () => { const now = await toolsNow(); return now.state === 'installing' && now.percent > 0 ? now : null; });
      assert.ok(busy.percent < 100);
      assert.equal((await snapshotMeeting()).recordings.find(item => item.id === recording.id).status, 'queued', '받는 동안 녹음본은 기다린다');
      release();
      assert.equal(await closed, 0, fs.readFileSync(path.join(root, 'logs', 'meeting-transcribe.log'), 'utf8'));
      assert.equal((await toolsNow()).state, 'ready');
    });
    const saved = (await snapshotMeeting()).recordings.find(item => item.id === recording.id);
    assert.equal(saved.status, 'done', '사람이 누르지 않아도 이어서 전사했다');
    assert.equal(saved.summary.headline, '출시 확정');
    assert.equal(fs.statSync(path.join(toolsHome, 'bin', 'whisper-cli')).mode & 0o111, 0o111, '실행할 수 있게 깔린다');
    assert.ok(fs.existsSync(path.join(toolsHome, 'licenses', 'meeting-tools', 'x.txt')), '라이선스도 함께');
    assert.deepEqual(fs.readdirSync(path.join(toolsHome, 'downloads')), [], '받은 꾸러미·임시 폴더는 치운다');
    assert.equal(meetingTools.readStatus().stage, 'done');
    assert.match(fs.readFileSync(path.join(root, 'logs', 'meeting-transcribe.log'), 'utf8'), /도구 준비 시작[\s\S]*도구 준비 끝[\s\S]*완료 — 발언 2개/);
  } finally {
    release();
    fileServer.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(toolsHome, { recursive: true, force: true });
  }
});

test('실행기: 도구를 못 받으면 녹음본은 `전사 대기`로 두고 이유를 적는다 — 인텔 맥이면 받지 않고 이유만 남긴다', async () => {
  seedMeeting();
  fs.rmSync(toolsHome, { recursive: true, force: true });
  const { recording } = await (await upload(Buffer.from('audio'))).json();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tools-fail-'));
  const fileServer = await serveFiles({}); // 무엇을 달라 해도 404
  try {
    const manifestFile = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify([{ id: 'model', label: 'm', url: `http://127.0.0.1:${fileServer.address().port}/model.bin`, size: 1, sha256: '0'.repeat(64), kind: 'file', dest: `models/${meetingTools.MODEL_Q5}` }]));
    const env = { ...process.env, WORKSPACE_PORT: new URL(base).port, WORKSPACE_MEETING_TOOLS_MANIFEST: manifestFile, AUTOMATION_LOG_DIR: path.join(root, 'logs') };
    const runOnce = extra => new Promise(resolve => spawn(process.execPath, [path.join(__dirname, 'meeting-transcribe.js')], { env: { ...env, ...extra }, stdio: 'ignore' }).on('close', resolve));
    await runOnce({ WORKSPACE_MEETING_ARCH: 'arm64' });
    assert.equal((await snapshotMeeting()).recordings.find(item => item.id === recording.id).status, 'queued', '실패해도 녹음본은 기다린다(`다시 받기`가 깔면 이어서 돈다)');
    await withArch('arm64', async () => {
      fs.rmSync(requestFile, { force: true });
      const now = await toolsNow();
      assert.deepEqual([now.state, now.error], ['failed', meetingTools.WORDS.notFound]);
    });
    assert.deepEqual(fs.readdirSync(path.join(toolsHome, 'downloads')), []);

    await runOnce({ WORKSPACE_MEETING_ARCH: 'x64' });
    const saved = (await snapshotMeeting()).recordings.find(item => item.id === recording.id);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.error, transcriber.WORDS.unsupported);
  } finally {
    fileServer.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(toolsHome, { recursive: true, force: true });
  }
});

test('옮기기: 녹음본·전사본·요약·AI 초안이 다른 회의로 함께 간다 — 전사 중·같은 회의·없는 회의는 거절', async () => {
  const OTHER = 'ffffeeeeddddccccbbbbaaaa';
  fs.rmSync(RECORDINGS, { recursive: true, force: true });
  fs.rmSync(draftsPath, { force: true });
  fs.writeFileSync(workflowFile, JSON.stringify({ items: {}, meetings: {
    [MEETING]: { id: MEETING, title: '주간 회의', date: support.today, start: '10:00' },
    [OTHER]: { id: OTHER, title: '디자인 리뷰', date: support.today, start: '14:00' },
  } }));
  const { recording } = await (await upload(Buffer.from('audio-bytes'))).json();
  const recId = recording.id;
  const move = body => support.post('/api/meeting/recording/move', { meetingId: MEETING, recId, toMeetingId: OTHER, ...body });

  await progress({ recId, stage: 'transcribing' });
  assert.equal((await move({})).status, 409, '전사 중에는 옮기지 않는다');
  await progress({ recId, stage: 'summarizing', utterances: [{ start: 0, end: 2, speaker: '화자1', text: '시안은 금요일까지요.' }] });
  await progress({ recId, stage: 'done', summary: { headline: '시안 일정', decisions: ['시안은 금요일'] } });
  assert.equal((await move({ toMeetingId: MEETING })).status, 400, '같은 회의');
  assert.equal((await move({ toMeetingId: 'abababababababababababab' })).status, 404, '없는 회의');

  const moved = await move({});
  assert.equal(moved.ok, true);
  assert.equal(moved.recording.status, 'done', '상태·요약은 그대로');
  assert.equal(fs.existsSync(path.join(RECORDINGS, MEETING, recording.file)), false);
  assert.deepEqual(fs.readFileSync(path.join(RECORDINGS, OTHER, recording.file)), Buffer.from('audio-bytes'));
  assert.equal((await fetch(`${base}/api/meeting/recording?meetingId=${OTHER}&recId=${recId}`)).status, 200);
  assert.equal((await fetch(`${base}/api/meeting/recording?meetingId=${MEETING}&recId=${recId}`)).status, 404);
  const transcript = await (await fetch(`${base}/api/meeting/recording/transcript?meetingId=${OTHER}&recId=${recId}`)).json();
  assert.equal(transcript.utterances[0].text, '시안은 금요일까지요.');

  const meetings = (await support.items()).workflows.meetings;
  const from = meetings.find(item => item.id === MEETING);
  const to = meetings.find(item => item.id === OTHER);
  assert.equal((from.recordings || []).length, 0);
  assert.deepEqual(to.recordings.map(item => item.id), [recId]);
  assert.deepEqual((from.drafts || []).map(draft => draft.description), [], '옛 회의에서 AI 초안이 빠진다');
  assert.deepEqual(to.drafts.map(draft => draft.description), ['시안은 금요일'], '새 회의로 AI 초안이 따라간다');
  assert.equal(JSON.parse(fs.readFileSync(draftsPath, 'utf8')).notes.length, 1, '초안 파일은 고쳐 쓰지 않는다(끝에 추가만)');
  assert.equal((await move({})).status, 404, '이미 옮긴 녹음본');
});
