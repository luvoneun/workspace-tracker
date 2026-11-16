'use strict';
// 회의 녹음 — 앱 쪽 전부. 회의 패널의 `● 녹음 (Beta)`을 한 번 누르면 이 탭이 바로 떠 있는 알약(Document Picture-in-Picture)을
// 띄우고 마이크로 녹음한다 — 따로 뜨는 녹음 창은 없다. 알약은 다른 앱 위에도 떠 있으니 워크스페이스 창은 내려(⌘M) 두면 된다.
// 브라우저는 사람이 연 창을 스스로 닫지 못하고, 알약은 그 알약을 띄운 탭이 닫히면 함께 닫힌다. 그래서 녹음 조각을 1초마다
// 이 브라우저 안(IndexedDB)에 적어 둔다 — 녹음 중에 창을 닫거나 맥이 꺼져도, 다음에 앱을 열면 거기까지를 그 회의에 저장한다.
// 이 파일은 ① 입구(meetingRecordNodes)와 녹음 ② 다른 탭과 상태 나누기(BroadcastChannel) ③ 끊긴 녹음 되살리기
// ④ 패널의 `녹음본` 목록(재생·옮기기·삭제·전사·요약)을 맡는다. meetings-ui.js의 panelMeeting이 ①·④를 부른다.

const meetingRecChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('workspace-meeting-record') : null;
let meetingRecLive = null;   // 다른 탭이 알린 지금 상태 { meetingId, state, at } — 녹음 중이 아니면 null
let meetingRecSession = null; // 이 탭이 하고 있는 녹음
const meetingRecUnsaved = new Map(); // 녹음 열쇠 → 저장하지 못한 녹음(이 브라우저에 남아 있음) { key, meetingId, seconds, type, error }

const MEETING_REC_BUSY = ['starting', 'recording', 'paused', 'saving'];
const MEETING_REC_STALE_MS = 25000; // 다른 탭은 바쁜 동안 10초마다 알린다 — 이만큼 소식이 없으면 그 탭이 닫힌 것으로 본다
const MEETING_REC_ORPHAN_MS = 30000; // 녹음 중인 탭은 5초마다 기록을 새로 적는다 — 이만큼 끊긴 녹음은 탭이 닫힌 것이다
const MEETING_REC_ICONS = {
  pause: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect fill="currentColor" x="5" y="5" width="14" height="14" rx="2"/></svg>',
};

// 지금 녹음 중인 회의 — 이 탭의 녹음이 먼저, 없으면 다른 탭이 알린 것(소식이 끊긴 지 오래면 없음).
function meetingRecNow() {
  if (meetingRecSession) return { meetingId: meetingRecSession.meetingId, state: meetingRecSession.state, local: true };
  if (meetingRecLive && Date.now() - meetingRecLive.at > MEETING_REC_STALE_MS) meetingRecLive = null;
  return meetingRecLive;
}
// 이 탭이 녹음 중(또는 저장 중)인가 — 앱 화면 갱신 때의 자동 새로고침을 미룬다(app.js load).
function meetingRecBusy() { return !!meetingRecSession; }
// 재생기는 녹음 id마다 하나를 다시 쓴다 — 자동 새로고침으로 카드를 다시 그려도 듣던 자리·재생이 끊기지 않게.
const meetingRecPlayers = new Map();

// 카드에 보이는 글이 같으면(녹음 중 ↔ 잠시 멈춤 등) 다시 그리지 않는다.
const meetingRecLook = live => (!live ? '' : `${live.meetingId}:${live.state === 'saving' ? 'saving' : 'busy'}`);
// 다시 그리기는 load() 하나 — 회의 탭은 그 안에서 입력 중이면 미루는 길(uiRenderOrHold)로 그린다(DECISIONS 2026-10-01).
// 여기서 host.redraw()를 따로 부르면 그 보류를 건너뛰어 한글 입력이 끊긴다.
function meetingRecRefresh() {
  if (typeof load === 'function') load();
}
function meetingRecSay(text) {
  if (typeof announce === 'function') announce(text);
}
function meetingRecPost(message) {
  try { if (meetingRecChannel) meetingRecChannel.postMessage(message); } catch {}
}
function meetingRecSayState() {
  const session = meetingRecSession;
  if (session) meetingRecPost({ type: 'status', meetingId: session.meetingId, state: session.state });
}
if (meetingRecChannel) {
  meetingRecChannel.onmessage = (message) => {
    const data = message.data || {};
    if (data.type === 'ping') { meetingRecSayState(); return; }
    if (data.type === 'status') {
      const before = meetingRecLook(meetingRecNow());
      meetingRecLive = MEETING_REC_BUSY.includes(data.state) ? { meetingId: data.meetingId, state: data.state, at: Date.now() } : null;
      if (before !== meetingRecLook(meetingRecNow())) meetingRecRefresh();
    } else if (data.type === 'saved') {
      meetingRecLive = null;
      meetingRecRefresh();
    }
  };
  // 앱을 새로 열었을 때 다른 탭에서 이미 돌고 있는 녹음이 있으면 상태를 알려 달라고 한다.
  meetingRecPost({ type: 'ping' });
}

// 녹음 길이 — `17분 25초`(시각 `17:25`과 헷갈리지 않게 말로).
function meetingRecLen(seconds) {
  const t = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h) return `${h}시간 ${m}분`;
  if (m) return s ? `${m}분 ${s}초` : `${m}분`;
  return `${s}초`;
}

function meetingRecFmt(seconds) {
  const t = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = n => String(n).padStart(2, '0');
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
}

// ---------- 이 브라우저 안의 녹음 조각(IndexedDB) ----------
// sessions: { key, meetingId, type, seconds, lastAt, unsaved?, error? } · chunks: { key, seq, data(Blob) }
// 못 열면(사생활 보호 창 등) null — 녹음은 그대로 되고, 창을 닫았을 때 되살리기만 못 한다.
let meetingRecDbOpen = null;
function meetingRecDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!meetingRecDbOpen) meetingRecDbOpen = new Promise((resolve) => {
    let open;
    try { open = indexedDB.open('workspace-meeting-rec', 1); } catch { resolve(null); return; }
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('sessions', { keyPath: 'key' });
      db.createObjectStore('chunks', { keyPath: ['key', 'seq'] });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
  });
  return meetingRecDbOpen;
}
async function meetingRecTx(stores, mode, fn) {
  const db = await meetingRecDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx, req;
    try { tx = db.transaction(stores, mode); req = fn(tx); } catch { resolve(null); return; }
    tx.oncomplete = () => resolve(req ? req.result : true);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}
const meetingRecRange = key => IDBKeyRange.bound([key, 0], [key, Infinity]);
const meetingRecStore = {
  put: (store, value) => meetingRecTx([store], 'readwrite', (tx) => { tx.objectStore(store).put(value); }),
  sessions: () => meetingRecTx(['sessions'], 'readonly', tx => tx.objectStore('sessions').getAll()),
  chunks: key => meetingRecTx(['chunks'], 'readonly', tx => tx.objectStore('chunks').getAll(meetingRecRange(key))),
  drop: key => meetingRecTx(['sessions', 'chunks'], 'readwrite', (tx) => { tx.objectStore('sessions').delete(key); tx.objectStore('chunks').delete(meetingRecRange(key)); }),
};
async function meetingRecBlob(meta) {
  const chunks = await meetingRecStore.chunks(meta.key);
  if (!chunks || !chunks.length) return null;
  return new Blob(chunks.sort((a, b) => a.seq - b.seq).map(chunk => chunk.data), { type: meta.type || 'audio/webm' });
}

// 서버에 올려 회의에 붙인다. 열쇠(Idempotency-Key)가 같으면 서버가 두 번 붙이지 않는다 — 응답만 잃고 다시 올려도 하나.
async function meetingRecUpload({ key, meetingId, seconds, blob }) {
  const type = String(blob.type || 'audio/webm').split(';')[0];
  try {
    const response = await fetch(`/api/meeting/recording?meetingId=${encodeURIComponent(meetingId)}&seconds=${Math.max(0, Math.round(seconds || 0))}`, {
      method: 'POST', headers: { 'Content-Type': type, 'Idempotency-Key': key }, body: blob,
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok || !data || data.ok === false) throw new Error((data && data.error) || `저장하지 못했어요 (${response.status})`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error && error.message) || '저장하지 못했어요.' };
  }
}
async function meetingRecKeepUnsaved(meta, error) {
  const kept = { ...meta, unsaved: true, error: String(error || '저장하지 못했어요.').slice(0, 200) };
  meetingRecUnsaved.set(kept.key, kept);
  await meetingRecStore.put('sessions', kept);
}

// ---------- 녹음 ----------
function meetingRecElapsed(session) {
  if (!session || !session.startTs) return 0;
  return Date.now() - session.startTs - session.pausedAcc - (session.state === 'paused' ? Date.now() - session.pauseStart : 0);
}
function meetingRecIconButton(doc, icon, label, onClick, className) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `rec-b ${className || ''}`.trim();
  button.innerHTML = MEETING_REC_ICONS[icon];
  button.dataset.icon = icon;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', onClick);
  return button;
}
// 알약 — PiP 창 전체가 알약이다. 시간 · 일시정지(다시 시작) · 정지.
function meetingRecPillNode(doc) {
  const pill = doc.createElement('div');
  pill.className = 'rec-pill';
  const dot = doc.createElement('span'); dot.className = 'rec-dot'; dot.setAttribute('aria-hidden', 'true');
  const time = doc.createElement('span'); time.className = 'rec-time'; time.textContent = '00:00';
  pill.append(dot, time, meetingRecIconButton(doc, 'pause', '일시정지', meetingRecTogglePause), meetingRecIconButton(doc, 'stop', '녹음 정지', meetingRecStop, 'rec-stop'));
  return pill;
}
function meetingRecPillSync() {
  const session = meetingRecSession;
  const pill = session && session.pill;
  if (!pill) return;
  const paused = session.state === 'paused';
  pill.classList.toggle('rec-paused', paused);
  const time = pill.querySelector('.rec-time');
  if (time) time.textContent = meetingRecFmt(meetingRecElapsed(session) / 1000);
  const pause = pill.querySelector('.rec-b:not(.rec-stop)');
  if (pause && pause.dataset.icon !== (paused ? 'play' : 'pause')) {
    pause.dataset.icon = paused ? 'play' : 'pause';
    pause.innerHTML = MEETING_REC_ICONS[paused ? 'play' : 'pause'];
    pause.setAttribute('aria-label', paused ? '다시 시작' : '일시정지');
    pause.title = paused ? '다시 시작' : '일시정지';
  }
}
async function meetingRecOpenPip(title) {
  if (typeof documentPictureInPicture === 'undefined') return null;
  try {
    const pip = await documentPictureInPicture.requestWindow({ width: 240, height: 60 });
    // 앱 스타일(색 토큰·다크 모드)을 그대로 옮긴다 — PiP는 별도 창이라 따로 심어야 한다.
    [...(document.styleSheets || [])].forEach((sheet) => {
      try {
        const style = pip.document.createElement('style');
        style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
        pip.document.head.appendChild(style);
      } catch {}
    });
    pip.document.body.className = 'rec-pip';
    pip.document.title = `녹음 · ${title || '회의'}`;
    return pip;
  } catch {
    return null;
  }
}

async function meetingRecStart(event) {
  const live = meetingRecNow();
  if (live) {
    meetingRecSay(live.meetingId === event.id ? '이미 이 회의를 녹음하고 있어요.' : '다른 회의를 녹음하고 있어요. 그 녹음을 먼저 멈춰 주세요.');
    return;
  }
  const key = (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`).slice(0, 100);
  const session = { key, meetingId: event.id, state: 'starting', chunks: [], seq: 0, startTs: 0, pausedAcc: 0, pauseStart: 0, seconds: 0, pip: null, pill: null, timer: null, beat: null, recorder: null, stream: null, type: '' };
  meetingRecSession = session;
  // 이 녹음을 이 탭이 쥐고 있다는 표시(Web Locks) — 탭이 살아 있는 동안 다른 탭이 `끊긴 녹음`으로 보고 올리지 않게.
  // 숨은 탭은 타이머가 1분에 한 번까지 느려져 5초 기록만으로는 살아 있는지 알 수 없다. 탭이 닫히면 브라우저가 풀어 준다.
  try {
    if (navigator.locks && navigator.locks.request) navigator.locks.request(`workspace-meeting-rec:${key}`, () => new Promise((resolve) => { session.releaseLock = resolve; })).catch(() => {});
  } catch {}
  meetingRecSayState(); // 마이크 허용을 기다리는 동안에도 다른 탭이 새 녹음을 시작하지 않게 바로 알린다
  // 알약 창은 사람이 누른 직후에만 열 수 있다 — 마이크 허용 창보다 먼저 연다(반대면 처음 쓸 때 알약이 안 뜬다).
  const pip = await meetingRecOpenPip(event.title);
  const giveUp = (text) => {
    if (pip) { try { pip.close(); } catch {} }
    if (meetingRecSession === session) meetingRecSession = null;
    if (session.releaseLock) session.releaseLock();
    meetingRecPost({ type: 'status', meetingId: session.meetingId, state: 'closed' });
    meetingRecSay(text);
    meetingRecRefresh();
  };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder !== 'function') { giveUp('이 브라우저는 녹음을 지원하지 않아요.'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (error) {
    giveUp(error && error.name === 'NotAllowedError' ? '마이크를 쓸 수 없어요. 주소창 왼쪽의 사이트 설정에서 마이크를 허용해 주세요.' : '마이크를 쓸 수 없어요.');
    return;
  }
  let recorder;
  try { recorder = new MediaRecorder(stream); }
  catch { stream.getTracks().forEach(track => track.stop()); giveUp('이 브라우저는 녹음을 지원하지 않아요.'); return; }
  Object.assign(session, { stream, recorder, type: recorder.mimeType || 'audio/webm' });
  recorder.ondataavailable = (data) => {
    if (!data.data || !data.data.size) return;
    session.chunks.push(data.data);
    meetingRecStore.put('chunks', { key, seq: session.seq++, data: data.data });
  };
  recorder.onstop = () => meetingRecFinish(session);
  recorder.onerror = () => { meetingRecSay('녹음 중에 문제가 생겨 멈췄어요. 녹음된 데까지 저장할게요.'); meetingRecStop(); };
  recorder.start(1000); // 1초마다 조각을 받아 이 브라우저에 적어 둔다
  session.startTs = Date.now();
  session.state = 'recording';
  const note = () => meetingRecStore.put('sessions', { key, meetingId: session.meetingId, type: session.type, seconds: Math.round(meetingRecElapsed(session) / 1000), lastAt: Date.now() });
  note();
  // 5초마다 기록을 새로 적는다(창이 닫힌 녹음을 가려내는 표시) · 10초마다 다른 탭에 살아 있다고 알린다.
  let tick = 0;
  session.beat = setInterval(() => { note(); if ((tick += 1) % 2 === 0) meetingRecSayState(); }, 5000);
  if (pip) {
    session.pip = pip;
    session.pill = meetingRecPillNode(pip.document);
    pip.document.body.appendChild(session.pill);
    // 사람이 알약 창을 닫으면 정지로 본다(녹음은 저장까지 간다).
    pip.addEventListener('pagehide', () => { session.pip = null; session.pill = null; if (session.state === 'recording' || session.state === 'paused') meetingRecStop(); });
    session.timer = setInterval(meetingRecPillSync, 250);
    meetingRecPillSync();
    meetingRecSay('녹음을 시작했어요. 알약은 아무 데나 끌어 두고, 워크스페이스 창은 내려 두면 돼요(닫으면 녹음이 멈춰요).');
  } else {
    meetingRecSay('녹음을 시작했어요. 이 브라우저는 떠 있는 알약을 지원하지 않아요(크롬·엣지에서 돼요) — 회의 카드에서 멈춰 주세요.');
  }
  meetingRecSayState();
  meetingRecRefresh();
}

function meetingRecTogglePause() {
  const session = meetingRecSession;
  if (!session || !session.recorder) return;
  if (session.state === 'paused') {
    try { session.recorder.resume(); } catch {}
    session.pausedAcc += Date.now() - session.pauseStart;
    session.state = 'recording';
  } else if (session.state === 'recording') {
    try { session.recorder.pause(); } catch {}
    session.pauseStart = Date.now();
    session.state = 'paused';
  } else return;
  meetingRecPillSync();
  meetingRecSayState();
  meetingRecRefresh();
}

function meetingRecStop() {
  const session = meetingRecSession;
  if (!session || (session.state !== 'recording' && session.state !== 'paused')) return;
  session.seconds = Math.round(meetingRecElapsed(session) / 1000);
  session.state = 'saving';
  clearInterval(session.timer);
  meetingRecSayState();
  meetingRecRefresh();
  try {
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    else meetingRecFinish(session);
  } catch { meetingRecFinish(session); }
}

async function meetingRecFinish(session) {
  if (session.finished) return;
  session.finished = true;
  try { session.stream && session.stream.getTracks().forEach(track => track.stop()); } catch {}
  if (session.pip) { const pip = session.pip; session.pip = null; session.pill = null; try { pip.close(); } catch {} }
  const meta = { key: session.key, meetingId: session.meetingId, type: session.type, seconds: session.seconds, lastAt: Date.now() };
  let result = { ok: true };
  if (!session.chunks.length) {
    clearInterval(session.beat);
    meetingRecSay('녹음된 소리가 없어요.');
    await meetingRecStore.drop(session.key);
  } else {
    await meetingRecStore.put('sessions', meta);
    result = await meetingRecUpload({ ...meta, blob: new Blob(session.chunks, { type: session.type || 'audio/webm' }) });
    clearInterval(session.beat); // 올리는 동안은 기록을 새로 적어 다른 탭이 되살리지 않게 — 끝나면 멈춘 뒤 지우거나 `저장 못 함`으로 남긴다
    if (result.ok) {
      await meetingRecStore.drop(session.key);
      meetingRecSay('녹음본을 회의에 붙였어요');
    } else {
      await meetingRecKeepUnsaved(meta, result.error);
      meetingRecSay(`${result.error} 녹음은 이 브라우저에 남아 있어요 — 회의 카드에서 다시 저장해 주세요.`);
    }
  }
  if (meetingRecSession === session) meetingRecSession = null;
  if (session.releaseLock) session.releaseLock();
  meetingRecPost(result.ok ? { type: 'saved', meetingId: session.meetingId } : { type: 'status', meetingId: session.meetingId, state: 'closed' });
  meetingRecRefresh();
}

// 녹음 중·저장 중에는 창을 닫기 전에 한 번 묻는다(브라우저 기본 확인). 닫아도 거기까지는 다음에 열 때 저장된다.
window.addEventListener('beforeunload', (event) => {
  if (meetingRecSession) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  if (meetingRecSession) meetingRecPost({ type: 'status', meetingId: meetingRecSession.meetingId, state: 'closed' });
});

// ---------- 끊긴 녹음 되살리기 ----------
// 앱을 열 때 한 번: 이 브라우저에 남은 녹음 가운데 ① 녹음하던 탭이 닫힌 것(기록이 30초 넘게 멈춤)은 바로 그 회의에 올리고
// ② 전에 올리지 못한 것은 회의 카드에 `다시 저장`·`파일로 받기`·`버리기`로 남긴다. 다른 탭이 지금 녹음 중인 것은 건드리지 않는다.
let meetingRecRecoverTimer = null;
// 다른 탭이 이 녹음을 쥐고 있나 — true · false, 알 수 없으면 null.
async function meetingRecHeldElsewhere(key) {
  try {
    if (typeof navigator === 'undefined' || !navigator.locks || !navigator.locks.query) return null;
    const state = await navigator.locks.query();
    return (state.held || []).some(lock => lock.name === `workspace-meeting-rec:${key}`);
  } catch { return null; }
}
async function meetingRecRecover() {
  meetingRecRecoverTimer = null;
  const sessions = await meetingRecStore.sessions();
  if (!sessions || !sessions.length) return;
  let changed = false;
  let wait = 0;
  for (const meta of sessions) {
    if (!meta || !meta.key || (meetingRecSession && meetingRecSession.key === meta.key)) continue;
    if (meta.unsaved) { if (!meetingRecUnsaved.has(meta.key)) { meetingRecUnsaved.set(meta.key, meta); changed = true; } continue; }
    // 녹음한 탭이 아직 살아 있으면(그 탭이 쥔 표시가 있으면) 건드리지 않는다. 표시를 볼 수 없는 브라우저는 기록 시각으로 가린다:
    // 아직 새것이면 다른 탭이 녹음 중이거나 방금 새로고침해서 끊긴 녹음이다 — 30초가 지나면 다시 본다.
    const held = await meetingRecHeldElsewhere(meta.key);
    if (held) { wait = Math.max(wait, MEETING_REC_ORPHAN_MS); continue; }
    const age = Date.now() - (Number(meta.lastAt) || 0);
    if (held === null && age < MEETING_REC_ORPHAN_MS) { wait = Math.max(wait, MEETING_REC_ORPHAN_MS - age + 1000); continue; }
    const blob = await meetingRecBlob(meta);
    if (!blob) { await meetingRecStore.drop(meta.key); continue; }
    const result = await meetingRecUpload({ ...meta, blob });
    if (result.ok) { await meetingRecStore.drop(meta.key); meetingRecSay('지난번에 창이 닫혀 끊긴 녹음을 그 회의에 저장했어요'); }
    else await meetingRecKeepUnsaved(meta, result.error);
    changed = true;
  }
  if (wait && !meetingRecRecoverTimer) meetingRecRecoverTimer = setTimeout(() => { meetingRecRecover().catch(() => {}); }, wait);
  if (changed) meetingRecRefresh();
}
setTimeout(() => { meetingRecRecover().catch(() => {}); }, 1500);

function meetingRecLink(label, onClick, className = 'd-link') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
// 저장하지 못한 녹음 한 줄: 이유 · `다시 저장` · `파일로 받기` · `버리기`(한 번 더 눌러야 버린다).
function meetingRecUnsavedNodes(meta) {
  const line = document.createElement('span');
  line.className = 'd-mtlast d-reclive';
  line.textContent = `저장하지 못한 녹음(${meetingRecFmt(meta.seconds)})이 이 브라우저에 있어요`;
  const save = meetingRecLink('다시 저장', async () => {
    save.disabled = true;
    const blob = await meetingRecBlob(meta);
    const result = blob ? await meetingRecUpload({ ...meta, blob }) : { ok: false, error: '녹음 조각을 찾지 못했어요.' };
    if (result.ok) {
      meetingRecUnsaved.delete(meta.key);
      await meetingRecStore.drop(meta.key);
      meetingRecSay('녹음본을 회의에 붙였어요');
      meetingRecRefresh();
    } else {
      save.disabled = false;
      meetingRecSay(result.error);
    }
  });
  const download = meetingRecLink('파일로 받기', async () => {
    const blob = await meetingRecBlob(meta);
    if (!blob) { meetingRecSay('녹음 조각을 찾지 못했어요.'); return; }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const at = new Date(Number(meta.lastAt) || Date.now());
    const pad = n => String(n).padStart(2, '0');
    const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm';
    link.download = `회의녹음-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.${ext}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  });
  let armed = null;
  const discard = meetingRecLink('버리기', async () => {
    if (!armed) {
      discard.textContent = '한 번 더 누르면 버려요';
      armed = setTimeout(() => { armed = null; discard.textContent = '버리기'; }, 4000);
      return;
    }
    clearTimeout(armed);
    meetingRecUnsaved.delete(meta.key);
    await meetingRecStore.drop(meta.key);
    meetingRecRefresh();
  }, 'd-link rc-del');
  return [line, save, download, discard];
}

// 머리 아래 조용한 줄에 붙일 입구(요소 목록). 기록된 회의(id가 있는)에서만 — 녹음본은 회의에 붙어야 한다.
function meetingRecordNodes(event, host) {
  if (!event || !event.id) return [];
  const nodes = [];
  meetingRecUnsaved.forEach((meta) => { if (meta.meetingId === event.id) nodes.push(...meetingRecUnsavedNodes(meta)); });
  const live = meetingRecNow();
  if (live && live.meetingId === event.id) {
    const state = document.createElement('span');
    state.className = 'd-mtlast d-reclive';
    state.textContent = live.state === 'saving' ? '녹음본 저장 중…'
      : !live.local ? '● 다른 창에서 녹음 중'
      : live.state === 'paused' ? '● 녹음 잠시 멈춤' : '● 녹음 중';
    nodes.push(state);
    if (live.local && (live.state === 'recording' || live.state === 'paused')) {
      nodes.push(meetingRecLink(live.state === 'paused' ? '다시 시작' : '일시정지', meetingRecTogglePause));
      nodes.push(meetingRecLink('정지하고 저장', meetingRecStop));
    }
    return nodes;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'd-btn sm';
  btn.textContent = '● 녹음 (Beta)';
  btn.addEventListener('click', () => meetingRecStart(event));
  nodes.push(btn);
  return nodes;
}

function meetingRecWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? `오늘 ${time}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
}

// 패널의 `녹음본` 구역 — 최신이 위. 줄마다: 시각·길이 | 재생기 | 옮기기 · 삭제(한 번 더 눌러야 지운다). 그 아래 전사·요약.
function meetingRecordingsNode(event, host) {
  const list = event && Array.isArray(event.recordings) ? event.recordings : [];
  if (!list.length) return null;
  // `(Beta)` — 아직 써 보는 기능이라는 말(문구로만, 따로 표시를 그리지 않는다). 정식이 되면 문구에서만 뺀다.
  const { section } = meetingSection('녹음본 (Beta)', list.length);
  section.classList.add('d-recs');
  const box = document.createElement('div');
  box.className = 'd-reclist';
  list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).forEach((recording) => {
    const row = document.createElement('div');
    row.className = 'd-recrow';
    const meta = document.createElement('div');
    meta.className = 'rc-meta';
    const when = document.createElement('span');
    when.textContent = meetingRecWhen(recording.createdAt);
    const length = document.createElement('span');
    length.className = 'rc-len';
    length.textContent = meetingRecLen(recording.seconds);
    meta.append(when, length);
    const src = `/api/meeting/recording?meetingId=${encodeURIComponent(event.id)}&recId=${encodeURIComponent(recording.id)}`;
    let audio = meetingRecPlayers.get(recording.id);
    if (!audio || audio.src.slice(-src.length) !== src) {
      audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.className = 'rc-audio';
      audio.src = src;
      audio.setAttribute('aria-label', `${meetingRecWhen(recording.createdAt)} 녹음본`);
      meetingRecPlayers.set(recording.id, audio);
    }
    const acts = document.createElement('div');
    acts.className = 'rc-acts';
    const move = MEETING_REC_WORKING[recording.status] && recording.status !== 'queued' ? null : meetingRecMoveButton(event, recording, host, row);
    if (move) acts.appendChild(move);
    acts.appendChild(meetingRecDeleteButton(event, recording, host));
    row.append(meta, audio, acts);
    box.append(row, meetingRecBody(event, recording, host));
  });
  section.appendChild(box);
  meetingRecWatch(list);
  return section;
}

// ---------- 전사·요약(녹음본 줄 아래) ----------
// 상태는 서버가 녹음본 줄에 적는다(queued·transcribing·summarizing·done·failed). 실제 일은 launchd 실행기
// (meeting-transcribe.js)가 하고, 화면은 그 상태를 보여 주고 `다시 시도`·`전사·요약 시작`만 보낸다.
const MEETING_REC_WORKING = { queued: '전사 대기 중이에요', redo: '요약 대기 중이에요 — 1~2분이면 끝나요', transcribing: '글로 옮기고 말한 사람을 나누는 중이에요 — 회의 길이에 따라 몇 분 걸려요', summarizing: '요약하는 중이에요' };
const meetingRecTranscripts = new Map(); // 녹음 id → 받아 온 발언 목록(펼칠 때 한 번만 받는다)
let meetingRecWatchTimer = null;

// 진행 중인 녹음본이 보이는 동안 15초마다 다시 읽는다(load — 입력 중이면 미루는 길). 다 끝나면 멈춘다.
function meetingRecWatch(list) {
  const busy = list.some(item => MEETING_REC_WORKING[item.status]);
  if (!busy || meetingRecWatchTimer) return;
  meetingRecWatchTimer = setTimeout(() => { meetingRecWatchTimer = null; if (typeof load === 'function') load(); }, 15000);
}

function meetingRecBody(event, recording, host) {
  const body = document.createElement('div');
  body.className = 'rc-body';
  const status = recording.status;
  if (MEETING_REC_WORKING[status]) {
    const line = document.createElement('p');
    line.className = 'rc-state';
    line.setAttribute('role', 'status');
    line.textContent = status === 'queued' && recording.redo === 'summary' ? MEETING_REC_WORKING.redo : MEETING_REC_WORKING[status];
    body.appendChild(line);
    return body;
  }
  if (status === 'failed' || !status) {
    // 실패했거나, 이 버전 전에 녹음해 전사하지 않은 녹음본.
    const line = document.createElement('p');
    line.className = status === 'failed' ? 'rc-state rc-fail' : 'rc-state';
    const why = document.createElement('span');
    why.textContent = status === 'failed' ? (recording.error || '전사하지 못했어요') : '아직 글로 옮기지 않은 녹음본이에요';
    const again = meetingRecRetryButton(event, recording, host, status === 'failed' ? '다시 시도' : '전사·요약 시작');
    line.append(why, ' ', again);
    body.appendChild(line);
    return body;
  }
  // done — 요약 + 전사본
  const summary = recording.summary || {};
  if (summary.headline) {
    const head = document.createElement('p');
    head.className = 'rc-head';
    head.textContent = summary.headline;
    body.appendChild(head);
  }
  const list = (label, items) => {
    if (!items || !items.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'rc-sum';
    const name = document.createElement('p');
    name.className = 'rc-lbl';
    const count = document.createElement('span');
    count.className = 'rc-n';
    count.textContent = String(items.length);
    const title = document.createElement('span');
    title.textContent = `${label} `;
    name.append(title, count);
    const ul = document.createElement('ul');
    items.forEach((text) => { const li = document.createElement('li'); li.textContent = text; ul.appendChild(li); });
    wrap.append(name, ul);
    body.appendChild(wrap);
  };
  list('주제별 요지', summary.topics);
  // 할 일 — 회의에서 나온 후속 조치(맡은 화자·날짜가 분명하면 함께). 담기는 아래 AI 초안에서.
  const actions = (Array.isArray(summary.actions) ? summary.actions : []).map((item) => {
    const extra = [item.owner, item.due].filter(Boolean).join(' · ');
    return extra ? `${item.task} (${extra})` : item.task;
  });
  list('할 일', actions);
  list('확인할 것', summary.checks);
  list('결정', summary.decisions);
  const hasDrafts = actions.length || (summary.checks && summary.checks.length) || (summary.decisions && summary.decisions.length);
  const note = document.createElement('p');
  note.className = 'd-hint rc-note';
  note.textContent = hasDrafts ? '할 일·확인할 것·결정 후보는 아래 AI 초안에서 골라 담아요.' : '이 녹음에서는 할 일·결정을 찾지 못했어요.';
  // 안내 · 실패 · 전사본 · 다시 하기는 요약 밑 한 묶음(.rc-foot, 8px) — 요약 묶음끼리는 16px.
  const foot = document.createElement('div');
  foot.className = 'rc-foot';
  foot.appendChild(note);
  if (summary.error) {
    const fail = document.createElement('p');
    fail.className = 'rc-state rc-fail';
    fail.textContent = summary.error;
    foot.appendChild(fail);
  }
  if (recording.transcript) foot.appendChild(meetingRecTranscriptNode(event, recording));
  // 다시 하기 — 요약이 아쉬우면 `요약 다시 하기`(전사본 그대로, 1~2분), 글이나 화자가 틀렸으면 `전사부터 다시 하기`(처음부터).
  const again = document.createElement('p');
  again.className = 'rc-state rc-redo';
  const summaryAgain = recording.transcript ? meetingRecRetryButton(event, recording, host, '요약 다시 하기', 'summary') : null;
  if (summaryAgain) {
    summaryAgain.title = '전사본은 그대로 두고 요약과 할 일만 새로 뽑아요 — 1~2분';
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ' · ';
    again.append(summaryAgain, sep);
  }
  const fullAgain = meetingRecRetryButton(event, recording, host, '전사부터 다시 하기');
  fullAgain.title = '녹음을 처음부터 다시 글로 옮기고 말한 사람을 나눠요 — 회의 길이에 따라 몇 분 걸려요';
  again.appendChild(fullAgain);
  foot.appendChild(again);
  body.appendChild(foot);
  return body;
}

// `전사본 보기` — 펼칠 때 서버에서 한 번 받아 화자별로 그린다.
function meetingRecTranscriptNode(event, recording) {
  const box = document.createElement('details');
  box.className = 'rc-tx';
  const label = document.createElement('summary');
  label.textContent = recording.speakers ? `전사본 보기 · 화자 ${recording.speakers}명` : '전사본 보기';
  const lines = document.createElement('div');
  lines.className = 'rc-lines';
  box.append(label, lines);
  const draw = (utterances) => {
    lines.replaceChildren();
    utterances.forEach((item) => {
      const line = document.createElement('p');
      line.className = 'rc-line';
      const who = document.createElement('span');
      who.className = 'rc-who';
      who.textContent = item.speaker;
      const at = document.createElement('span');
      at.className = 'rc-at';
      at.textContent = meetingRecFmt(item.start);
      const text = document.createElement('span');
      text.className = 'rc-text';
      text.textContent = item.text;
      line.append(who, at, text);
      lines.appendChild(line);
    });
  };
  const cached = meetingRecTranscripts.get(recording.id);
  if (cached) draw(cached);
  box.addEventListener('toggle', async () => {
    if (!box.open || meetingRecTranscripts.has(recording.id)) return;
    lines.textContent = '불러오는 중…';
    try {
      const response = await fetch(`/api/meeting/recording/transcript?meetingId=${encodeURIComponent(event.id)}&recId=${encodeURIComponent(recording.id)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error);
      meetingRecTranscripts.set(recording.id, data.utterances);
      draw(data.utterances);
    } catch {
      lines.textContent = '전사본을 불러오지 못했어요.';
    }
  });
  return box;
}

// 지우면 되돌릴 수 없으니 두 번 누른다: `삭제` → `한 번 더 누르면 삭제`(4초 뒤 원래대로).
function meetingRecDeleteButton(event, recording, host) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-link rc-del';
  button.textContent = '삭제';
  let armed = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = '한 번 더 누르면 삭제';
      button.classList.add('armed');
      armed = setTimeout(() => { armed = null; button.textContent = '삭제'; button.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    button.disabled = true;
    try {
      await request('/api/meeting/recording/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: event.id, recId: recording.id }),
      });
      if (typeof meetingLoadRedraw === 'function') await meetingLoadRedraw(host);
    } catch (error) {
      button.disabled = false;
      button.textContent = '삭제';
      button.classList.remove('armed');
      // request()가 이미 알렸으면(error.reported) 또 알리지 않는다.
      if (!(error && error.reported) && typeof announce === 'function') announce((error && error.message) || '삭제하지 못했어요.');
    }
  });
  return button;
}

// ---------- 다른 회의로 옮기기 ----------
// 잘못된 회의에서 녹음했을 때. `옮기기`를 누르면 녹음본 줄 아래(같은 줄의 다음 행)에 회의 고르기(오늘 회의 먼저, 그다음 지난 2주)가 열린다.
// 전사·요약 중에는 옮기지 않는다(서버도 막는다). 옮기면 녹음본·전사본·요약·AI 초안이 함께 간다.
function meetingRecMoveChoices(event) {
  const today = typeof todayStr === 'function' ? todayStr() : new Date().toISOString().slice(0, 10);
  const from = new Date(`${today}T00:00:00`);
  from.setDate(from.getDate() - 14);
  const pad = n => String(n).padStart(2, '0');
  const since = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
  const meetings = (typeof workflowData !== 'undefined' && workflowData && Array.isArray(workflowData.meetings)) ? workflowData.meetings : [];
  return meetings
    .filter(item => item && item.id && item.id !== event.id && item.date && item.date >= since && item.date <= today)
    .sort((a, b) => `${b.date} ${b.start || ''}`.localeCompare(`${a.date} ${a.start || ''}`))
    .slice(0, 40);
}
function meetingRecMoveLabel(item, today) {
  const [, m, d] = String(item.date).split('-').map(Number);
  const day = item.date === today ? '오늘' : `${m}월 ${d}일`;
  return `${day} ${item.start || ''} ${item.title || '회의'}`.replace(/\s+/g, ' ').trim();
}
function meetingRecMoveButton(event, recording, host, row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-link';
  button.textContent = '옮기기';
  let form = null;
  const close = () => { if (form) { row.removeChild(form); form = null; } button.focus(); };
  button.addEventListener('click', () => {
    if (form) { close(); return; }
    form = meetingRecMoveForm(event, recording, host, close);
    row.appendChild(form); // 줄은 감싸기(flex-wrap)라 고르기는 줄 아래 한 줄을 다 쓴다
  });
  return button;
}
function meetingRecMoveForm(event, recording, host, close) {
  const form = document.createElement('div');
  form.className = 'rc-move';
  const today = typeof todayStr === 'function' ? todayStr() : '';
  const choices = meetingRecMoveChoices(event);
  if (!choices.length) {
    const none = document.createElement('p');
    none.className = 'd-hint';
    none.textContent = '옮길 수 있는 회의가 없어요(오늘과 지난 2주의 회의만 보여요).';
    form.appendChild(none);
    return form;
  }
  const select = document.createElement('select');
  select.className = 'rc-movesel';
  select.setAttribute('aria-label', '옮길 회의');
  choices.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = meetingRecMoveLabel(item, today);
    select.appendChild(option);
  });
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn sm';
  go.textContent = '이 회의로 옮기기';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-link';
  cancel.textContent = '취소';
  cancel.addEventListener('click', close);
  go.addEventListener('click', async () => {
    const target = choices.find(item => item.id === select.value);
    if (!target) return;
    go.disabled = true;
    try {
      await request('/api/meeting/recording/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: event.id, recId: recording.id, toMeetingId: target.id }),
      });
      meetingRecSay(`녹음본을 「${target.title || '회의'}」로 옮겼어요`);
      if (typeof meetingLoadRedraw === 'function') await meetingLoadRedraw(host);
    } catch (error) {
      go.disabled = false;
      if (!(error && error.reported)) meetingRecSay((error && error.message) || '옮기지 못했어요.');
    }
  });
  form.append(select, go, cancel);
  setTimeout(() => { try { select.focus(); } catch {} }, 0);
  return form;
}

// only: 'summary'면 전사본은 두고 요약만 다시(서버가 전사본이 있는지 다시 본다).
function meetingRecRetryButton(event, recording, host, label, only) {
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'd-link';
  again.textContent = label;
  again.addEventListener('click', async () => {
    again.disabled = true;
    try {
      await request('/api/meeting/recording/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId: event.id, recId: recording.id, ...(only ? { only } : {}) }) });
      if (typeof meetingLoadRedraw === 'function') await meetingLoadRedraw(host);
    } catch (error) {
      again.disabled = false;
      if (!(error && error.reported) && typeof announce === 'function') announce((error && error.message) || '다시 시도하지 못했어요.');
    }
  });
  return again;
}
