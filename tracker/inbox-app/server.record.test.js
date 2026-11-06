// 서버: 회의 녹음(1차) — 녹음 창 페이지, 녹음본 올리기·듣기·삭제, 본문 형식 예외. 공용 준비는 test-support.js.
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
  assert.deepEqual(fs.existsSync(path.join(RECORDINGS, missing)) ? fs.readdirSync(path.join(RECORDINGS, missing)) : [], []);
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

test('녹음 창: /record는 페이지를 주고, 회의 이름은 meta로 읽는다', async () => {
  seedMeeting();
  const page = await fetch(`${base}/record?meetingId=${MEETING}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /record-page\.js/);
  const meta = await (await fetch(`${base}/api/meeting/recording/meta?meetingId=${MEETING}`)).json();
  assert.equal(meta.ok, true);
  assert.equal(meta.title, '주간 회의');
  assert.equal((await fetch(`${base}/routes-record.js`)).status, 404); // 서버 파일은 화면 파일로 나가지 않는다
  assert.equal((await fetch(`${base}/record.html`)).status, 404);      // 페이지는 /record 한 길로만
});
