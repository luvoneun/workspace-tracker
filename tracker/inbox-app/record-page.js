'use strict';
// 회의 녹음 창(record.html)의 동작. 순서: 알약 창(PiP)을 먼저 연다 → 마이크를 묻는다 → 녹음한다 → 정지하면 올린다.
// PiP 창은 사람이 누른 직후에만 열 수 있어서, 마이크 허용 창보다 먼저 연다(반대면 처음 쓸 때 알약이 안 뜬다).
// 올리기에 실패해도 녹음은 버리지 않는다 — `다시 저장`·`파일로 받기`를 남긴다. 앱 창과는 BroadcastChannel로만 말한다.

const recMeetingId = new URLSearchParams(location.search).get('meetingId') || '';
const recChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('workspace-meeting-record') : null;
const rec = {
  state: 'loading', // loading · ready · starting · recording · paused · saving · saved · failed · missing
  title: '', recorder: null, stream: null, chunks: [], blob: null, pip: null, pill: null,
  startTs: 0, pausedAcc: 0, pauseStart: 0, seconds: 0, timer: null, note: '',
};
const $rec = id => document.getElementById(id);

const REC_ICONS = {
  pause: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect fill="currentColor" x="5" y="5" width="14" height="14" rx="2"/></svg>',
};

function recFmt(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = n => String(n).padStart(2, '0');
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
}
function recElapsed() {
  if (!rec.startTs) return 0;
  return Date.now() - rec.startTs - rec.pausedAcc - (rec.state === 'paused' ? Date.now() - rec.pauseStart : 0);
}
function recSay() {
  if (recChannel) recChannel.postMessage({ type: 'status', meetingId: recMeetingId, state: rec.state });
}
function recSet(state) {
  rec.state = state;
  recSay();
  recRender();
}

function recButton(label, onClick, className = 'd-btn') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
function recIconButton(icon, label, onClick, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `rec-b ${className || ''}`.trim();
  button.innerHTML = REC_ICONS[icon];
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', onClick);
  return button;
}

// 알약 — PiP 창 안(없으면 이 창 안)에 그린다. 시간·일시정지(다시 시작)·정지.
function recPillNode(doc) {
  const pill = doc.createElement('div');
  pill.className = 'rec-pill';
  const dot = doc.createElement('span'); dot.className = 'rec-dot'; dot.setAttribute('aria-hidden', 'true');
  const time = doc.createElement('span'); time.className = 'rec-time'; time.textContent = recFmt(recElapsed());
  const pause = recIconButton('pause', '일시정지', recTogglePause);
  const stop = recIconButton('stop', '녹음 정지', recStop, 'rec-stop');
  pill.append(dot, time, pause, stop);
  return pill;
}
function recPillSync() {
  if (!rec.pill) return;
  const paused = rec.state === 'paused';
  rec.pill.classList.toggle('rec-paused', paused);
  const time = rec.pill.querySelector('.rec-time');
  if (time) time.textContent = recFmt(recElapsed());
  const pause = rec.pill.querySelector('.rec-b:not(.rec-stop)');
  if (pause && pause.dataset.icon !== (paused ? 'play' : 'pause')) {
    pause.dataset.icon = paused ? 'play' : 'pause';
    pause.innerHTML = REC_ICONS[paused ? 'play' : 'pause'];
    pause.setAttribute('aria-label', paused ? '다시 시작' : '일시정지');
    pause.title = paused ? '다시 시작' : '일시정지';
  }
}

function recRender() {
  const live = rec.state === 'recording' || rec.state === 'paused';
  $rec('recLive').hidden = !live;
  $rec('recLive').classList.toggle('rec-paused', rec.state === 'paused');
  $rec('recTime').textContent = recFmt(recElapsed());
  const acts = $rec('recActs');
  acts.replaceChildren();
  const state = {
    loading: '',
    ready: '',
    starting: '녹음을 준비하고 있어요…',
    recording: '녹음 중',
    paused: '잠시 멈춤',
    saving: '녹음본을 저장하고 있어요…',
    saved: '저장했어요. 회의 탭의 녹음본에서 들을 수 있어요.',
    failed: '',
    missing: '',
  }[rec.state];
  $rec('recState').textContent = state || '';
  if (rec.state === 'ready') {
    acts.appendChild(recButton('● 녹음 시작', recStart, 'd-btn pri'));
  } else if (live) {
    acts.append(
      recButton(rec.state === 'paused' ? '다시 시작' : '일시정지', recTogglePause),
      recButton('정지하고 저장', recStop, 'd-btn pri'),
    );
  } else if (rec.state === 'failed') {
    acts.append(recButton('다시 저장', recUpload, 'd-btn pri'), recDownloadLink());
  } else if (rec.state === 'saved') {
    acts.appendChild(recButton('창 닫기', () => window.close()));
  }
  $rec('recNote').textContent = rec.note;
  recPillSync();
}

function recDownloadLink() {
  const link = document.createElement('a');
  link.className = 'd-btn';
  link.textContent = '파일로 받기';
  if (rec.blob) {
    link.href = URL.createObjectURL(rec.blob);
    const at = new Date(rec.startTs || Date.now());
    const pad = n => String(n).padStart(2, '0');
    const ext = /ogg/.test(rec.blob.type) ? 'ogg' : /mp4/.test(rec.blob.type) ? 'm4a' : 'webm';
    link.download = `회의녹음-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.${ext}`;
  }
  return link;
}

async function recOpenPip() {
  if (!window.documentPictureInPicture) return { ok: false, why: '이 브라우저는 떠 있는 알약 창을 지원하지 않아요(크롬·엣지에서 돼요).' };
  try {
    const pip = await documentPictureInPicture.requestWindow({ width: 240, height: 60 });
    // 앱 스타일(색 토큰·다크 모드)을 그대로 옮긴다 — PiP는 별도 창이라 따로 심어야 한다.
    [...document.styleSheets].forEach((sheet) => {
      try {
        const style = pip.document.createElement('style');
        style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
        pip.document.head.appendChild(style);
      } catch {}
    });
    pip.document.body.className = 'rec-pip';
    pip.document.title = '회의 녹음';
    return { ok: true, pip };
  } catch {
    return { ok: false, why: '떠 있는 알약 창을 열지 못했어요.' };
  }
}

async function recStart() {
  if (rec.state !== 'ready') return; // 두 번 눌러도 하나만
  recSet('starting');
  $rec('recErr').textContent = '';
  const opened = await recOpenPip(); // 사람이 누른 직후라야 열린다 — 마이크보다 먼저
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder !== 'function') {
    if (opened.ok) opened.pip.close();
    $rec('recErr').textContent = '이 브라우저는 녹음을 지원하지 않아요.';
    recSet('ready'); return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (error) {
    if (opened.ok) opened.pip.close();
    $rec('recErr').textContent = error && error.name === 'NotAllowedError'
      ? '마이크를 쓸 수 없어요. 주소창 왼쪽의 사이트 설정에서 마이크를 허용해 주세요.'
      : '마이크를 쓸 수 없어요.';
    recSet('ready'); return;
  }
  let recorder;
  try { recorder = new MediaRecorder(stream); }
  catch {
    stream.getTracks().forEach(track => track.stop());
    if (opened.ok) opened.pip.close();
    $rec('recErr').textContent = '이 브라우저는 녹음을 지원하지 않아요.';
    recSet('ready'); return;
  }
  rec.stream = stream; rec.recorder = recorder; rec.chunks = []; rec.blob = null;
  recorder.ondataavailable = event => { if (event.data && event.data.size) rec.chunks.push(event.data); };
  recorder.onstop = recFinish;
  recorder.onerror = () => { $rec('recErr').textContent = '녹음 중에 문제가 생겨 멈췄어요. 녹음된 데까지 저장할게요.'; recStop(); };
  recorder.start(1000); // 1초마다 조각을 받아 둔다 — 정지 때 한 번에 몰지 않게
  rec.startTs = Date.now(); rec.pausedAcc = 0; rec.pauseStart = 0;
  if (opened.ok) {
    rec.pip = opened.pip;
    rec.pill = recPillNode(opened.pip.document);
    opened.pip.document.body.appendChild(rec.pill);
    // 사람이 알약 창을 닫으면 정지로 본다(녹음은 저장까지 간다).
    opened.pip.addEventListener('pagehide', () => { rec.pip = null; rec.pill = null; if (rec.state === 'recording' || rec.state === 'paused') recStop(); });
    rec.note = '알약은 아무 데나 끌어 두세요. 이 창은 내려 두면 되고, 앱 창은 닫아도 녹음이 이어져요. 이 창을 닫으면 녹음이 멈춰요.';
  } else {
    rec.note = `${opened.why} 이 창이 알약 대신이에요 — 닫지 말고 내려 두세요. 앱 창은 닫아도 녹음이 이어져요.`;
  }
  rec.timer = setInterval(() => { $rec('recTime').textContent = recFmt(recElapsed()); recPillSync(); }, 250);
  recSet('recording');
}

function recTogglePause() {
  const recorder = rec.recorder;
  if (!recorder) return;
  if (rec.state === 'paused') {
    try { recorder.resume(); } catch {}
    rec.pausedAcc += Date.now() - rec.pauseStart;
    recSet('recording');
  } else if (rec.state === 'recording') {
    try { recorder.pause(); } catch {}
    rec.pauseStart = Date.now();
    recSet('paused');
  }
}

function recStop() {
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  rec.seconds = Math.round(recElapsed() / 1000);
  clearInterval(rec.timer);
  recSet('saving');
  try {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
    else recFinish();
  } catch { recFinish(); }
}

function recFinish() {
  if (rec.blob) return;
  try { rec.stream && rec.stream.getTracks().forEach(track => track.stop()); } catch {}
  if (rec.pip) { const pip = rec.pip; rec.pip = null; rec.pill = null; try { pip.close(); } catch {} }
  if (!rec.chunks.length) {
    $rec('recErr').textContent = '녹음된 소리가 없어요.';
    rec.note = '';
    recSet('ready'); return;
  }
  rec.blob = new Blob(rec.chunks, { type: rec.chunks[0].type || 'audio/webm' });
  rec.chunks = [];
  recUpload();
}

async function recUpload() {
  if (!rec.blob) return;
  recSet('saving');
  $rec('recErr').textContent = '';
  const type = String(rec.blob.type || 'audio/webm').split(';')[0];
  try {
    const response = await fetch(`/api/meeting/recording?meetingId=${encodeURIComponent(recMeetingId)}&seconds=${rec.seconds}`, {
      method: 'POST', headers: { 'Content-Type': type }, body: rec.blob,
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok || !data || data.ok === false) throw new Error((data && data.error) || `저장하지 못했어요 (${response.status})`);
    rec.note = '';
    recSet('saved');
    if (recChannel) recChannel.postMessage({ type: 'saved', meetingId: recMeetingId });
    setTimeout(() => { if (rec.state === 'saved') window.close(); }, 2500);
  } catch (error) {
    $rec('recErr').textContent = `${(error && error.message) || '저장하지 못했어요.'} 녹음은 이 창에 그대로 있어요 — 다시 저장하거나 파일로 받아 두세요.`;
    rec.note = '';
    recSet('failed');
  }
}

// 녹음 중·저장 전에는 창을 닫기 전에 한 번 묻는다(브라우저 기본 확인).
window.addEventListener('beforeunload', (event) => {
  if (['starting', 'recording', 'paused', 'saving', 'failed'].includes(rec.state)) { event.preventDefault(); event.returnValue = ''; }
});
// 앱 창이 새로 열리면 지금 상태를 묻는다.
if (recChannel) recChannel.onmessage = (event) => { if (event.data && event.data.type === 'ping') recSay(); };

async function recLoad() {
  if (!/^[0-9a-f]{1,32}$/.test(recMeetingId)) { $rec('recErr').textContent = '회의를 찾지 못했어요. 회의 탭에서 다시 열어 주세요.'; recSet('missing'); return; }
  try {
    const response = await fetch(`/api/meeting/recording/meta?meetingId=${encodeURIComponent(recMeetingId)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error);
    rec.title = data.title || '회의';
    $rec('recTitle').textContent = rec.title;
    document.title = `녹음 · ${rec.title}`;
    $rec('recWhen').textContent = [data.date, data.start].filter(Boolean).join(' ');
    rec.note = '녹음을 시작하기 전에 참석자에게 녹음한다고 알려 주세요.';
    recSet('ready');
  } catch {
    $rec('recErr').textContent = '회의를 찾지 못했어요. 회의 탭에서 다시 열어 주세요.';
    recSet('missing');
  }
}
recLoad();
