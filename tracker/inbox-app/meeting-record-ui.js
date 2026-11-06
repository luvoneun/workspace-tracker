'use strict';
// 회의 녹음(1차) — 앱 쪽. 회의 패널의 `● 녹음`이 작은 녹음 창(`/record`, record-page.js)을 연다. 녹음은 그 창과
// 그 창이 띄운 알약(Picture-in-Picture)에서 돌아서, 앱 창을 닫거나 새로고침해도 이어진다. 이 파일은
// ① 입구(meetingRecordNodes) ② 녹음 창이 알리는 상태 듣기(BroadcastChannel) ③ 패널의 `녹음본` 목록(재생·삭제)만 맡는다.
// 전사·화자구분·AI 요약은 다음 차수에 녹음본에 붙는다. meetings-ui.js의 panelMeeting이 ①·③을 부른다.

const MEETING_REC_WINDOW = 'workspace-recorder';
const meetingRecChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('workspace-meeting-record') : null;
let meetingRecLive = null;   // 녹음 창이 알린 지금 상태 { meetingId, state } — 녹음 중이 아니면 null
let meetingRecWin = null;    // 이 탭이 연 녹음 창(앞으로 불러오기용)

const MEETING_REC_BUSY = ['starting', 'recording', 'paused', 'saving', 'failed'];
const MEETING_REC_STALE_MS = 25000; // 녹음 창은 바쁜 동안 10초마다 알린다 — 이만큼 소식이 없으면 창이 죽은 것으로 본다
// 지금 녹음 중인 회의(소식이 끊긴 지 오래면 없음으로 본다).
function meetingRecNow() {
  if (meetingRecLive && Date.now() - meetingRecLive.at > MEETING_REC_STALE_MS) meetingRecLive = null;
  return meetingRecLive;
}
// 재생기는 녹음 id마다 하나를 다시 쓴다 — 자동 새로고침으로 카드를 다시 그려도 듣던 자리·재생이 끊기지 않게.
const meetingRecPlayers = new Map();

// 카드에 보이는 글이 같으면(녹음 중 ↔ 잠시 멈춤 등) 다시 그리지 않는다.
const meetingRecLook = live => (!live ? '' : `${live.meetingId}:${live.state === 'saving' || live.state === 'failed' ? live.state : 'busy'}`);
// 다시 그리기는 load() 하나 — 회의 탭은 그 안에서 입력 중이면 미루는 길(uiRenderOrHold)로 그린다(DECISIONS 2026-10-01).
// 여기서 host.redraw()를 따로 부르면 그 보류를 건너뛰어 한글 입력이 끊긴다.
function meetingRecRefresh() {
  if (typeof load === 'function') load();
}
if (meetingRecChannel) {
  meetingRecChannel.onmessage = (message) => {
    const data = message.data || {};
    if (data.type === 'status') {
      const before = meetingRecLook(meetingRecNow());
      meetingRecLive = MEETING_REC_BUSY.includes(data.state) ? { meetingId: data.meetingId, state: data.state, at: Date.now() } : null;
      if (before !== meetingRecLook(meetingRecLive)) meetingRecRefresh();
    } else if (data.type === 'saved') {
      meetingRecLive = null;
      if (typeof announce === 'function') announce('녹음본을 회의에 붙였어요');
      meetingRecRefresh();
    }
  };
  // 앱을 새로 열었을 때 이미 돌고 있는 녹음 창이 있으면 상태를 알려 달라고 한다.
  meetingRecChannel.postMessage({ type: 'ping' });
}

function meetingRecFmt(seconds) {
  const t = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = n => String(n).padStart(2, '0');
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
}

// 머리 아래 조용한 줄에 붙일 입구(요소 목록). 기록된 회의(id가 있는)에서만 — 녹음본은 회의에 붙어야 한다.
function meetingRecordNodes(event, host) {
  if (!event || !event.id) return [];
  const nodes = [];
  const live = meetingRecNow();
  if (live && live.meetingId === event.id) {
    const state = document.createElement('span');
    state.className = 'd-mtlast d-reclive';
    state.textContent = live.state === 'failed' ? '녹음본 저장 실패 — 녹음 창에서 다시 저장해 주세요'
      : live.state === 'saving' ? '녹음본 저장 중…' : '● 녹음 중 — 알약에서 멈춰요';
    nodes.push(state);
    if (meetingRecWin && !meetingRecWin.closed) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'd-link';
      show.textContent = '녹음 창 보기';
      show.addEventListener('click', () => { try { meetingRecWin.focus(); } catch {} });
      nodes.push(show);
    }
    return nodes;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'd-btn sm';
  btn.textContent = '● 녹음';
  btn.addEventListener('click', () => meetingRecOpen(event));
  nodes.push(btn);
  return nodes;
}

function meetingRecOpen(event) {
  const live = meetingRecNow();
  if (live && live.meetingId !== event.id) {
    if (typeof announce === 'function') announce('다른 회의를 녹음하고 있어요. 그 녹음을 먼저 멈춰 주세요.');
    if (meetingRecWin && !meetingRecWin.closed) { try { meetingRecWin.focus(); } catch {} }
    return;
  }
  const win = window.open(`/record?meetingId=${encodeURIComponent(event.id)}`, MEETING_REC_WINDOW, 'popup,width=400,height=320');
  if (!win) {
    if (typeof announce === 'function') announce('녹음 창이 막혔어요. 주소창 오른쪽에서 팝업을 허용해 주세요.');
    return;
  }
  meetingRecWin = win;
  try { win.focus(); } catch {}
}

function meetingRecWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? `오늘 ${time}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
}

// 패널의 `녹음본` 구역 — 최신이 위. 줄마다: 시각·길이 | 재생기 | 삭제(한 번 더 눌러야 지운다).
// 끝에 다음 차수(전사·요약) 자리 한 줄.
function meetingRecordingsNode(event, host) {
  const list = event && Array.isArray(event.recordings) ? event.recordings : [];
  if (!list.length) return null;
  const { section } = meetingSection('녹음본', list.length);
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
    length.textContent = meetingRecFmt(recording.seconds);
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
    row.append(meta, audio, meetingRecDeleteButton(event, recording, host));
    box.appendChild(row);
  });
  section.appendChild(box);
  const soon = document.createElement('p');
  soon.className = 'd-hint rc-soon';
  soon.textContent = '전사·AI 요약은 다음 버전에서 이 녹음본에 붙어요.';
  section.appendChild(soon);
  return section;
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
