// 캘린더 `맥 캘린더` 갈래 — 맥 기본 캘린더 앱에 추가해 둔 계정(회사 구글 계정 등)의 오늘 일정을 읽는다(Claude·비밀 주소 없이).
//
// 두 얼굴이 한 파일에 있다.
//  1. 실행 스크립트(`node calendar-mac.js run|now`) — launchd가 설치 위치 복사본 `mac-calendar.sh`로 부른다.
//     `automation/mac-calendar.js`(JXA)를 `osascript`로 한 번(목록)·한 번(읽기) 부르고, 오늘 일정을 뽑아
//     `tracker/calendar_today.md`(Claude 갈래 calendar-sync가 쓰던 스냅샷과 같은 모양)에 덮어쓴다 — 이 파일은 스킬·스크립트가
//     덮어쓰는 스냅샷이라 직접 써도 되는 예외다(AGENTS.md). 결과·캘린더 목록은 설치 위치의 `mac-calendar.json`에 남긴다.
//     osascript는 **이 스크립트가 직접 띄운 자식 하나**이고, 60초가 넘으면 그 자식에게만 신호를 보낸다.
//  2. 앱 서버 경로(`route`) — 서버는 프로세스를 띄우지 않는다. `허용하고 확인`은 요청 표시 파일
//     (`requests/mac-calendar.request`, `{"mode":"check"}`)만 쓰고, launchd `mac-calendar-now`가 위 스크립트를 한 번 돌린다.
//     화면은 `mac-calendar.json`을 읽어 결과를 기다린다.
//
// 오늘 일정 뽑기는 비밀 주소 갈래의 `ical.js`를 그대로 쓴다 — JXA가 준 일정을 iCal 글자로 옮겨 같은 함수에 넣는다
// (반복 일정 펼치기·취소 빼기·종일 일정 빼기·일정 id 모양이 비밀 주소 갈래와 같아진다).
// 장소·참석자·메모는 읽지 않는다(참석 상태는 "내가 거절했나"에만 쓰고 남기지 않는다).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCalendar, todayEvents, wallOf } = require('./ical');

const TIMEOUT_MS = 60 * 1000;        // 목록·읽기를 합친 제한 시간
const KILL_GRACE_MS = 2000;          // TERM 뒤 KILL까지
const MAX_OUTPUT = 20 * 1024 * 1024; // osascript 답의 최대 크기
const MAX_CALENDARS = 200;           // 상태 파일에 남기는 캘린더 수
const STATE_FILE = 'mac-calendar.json';
const REQUEST_FILE = 'mac-calendar.request';
const LOG_FILE = 'mac-calendar.log';
const TASK = 'mac-calendar';
const NOW_AGENT = 'mac-calendar-now';

// 사람에게 보이는 말(해요체). 실패 말은 로그의 ⚠️ 줄에 그대로 들어가고, 연동 카드의 멈춤 이유로 쓰인다.
const WORDS = {
  denied: '맥이 캘린더 접근을 막았어요 — 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 허용해 주세요',
  noAccount: '맥 캘린더에 구글 계정이 없어요 — 1단계를 먼저 해 주세요',
  missing: '고른 캘린더를 찾지 못했어요 — 다시 골라 주세요',
  none: '읽을 캘린더를 아직 고르지 않았어요 — 설정 › 연동 › 캘린더에서 골라 주세요',
  timeout: '맥 캘린더가 60초 안에 답하지 않았어요 — 캘린더가 많으면 잠시 뒤 다시 시도해 주세요',
  failed: '맥 캘린더를 읽지 못했어요 — 잠시 뒤 다시 시도해 주세요',
};
// 종료 코드 — 0이 아니면 서버·화면이 실패로 읽는다(이유는 ⚠️ 줄).
const EXIT = { denied: 77, noAccount: 78, missing: 79, none: 79, timeout: 124, failed: 1 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const looksLikeEmail = value => EMAIL_RE.test(String(value || '').trim());
const clean = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- 고르기 ----------
// 기본으로 켤 캘린더 하나 — 내 이메일 이름의 캘린더(구글 계정의 기본 캘린더 이름이 메일 주소다), 없으면 메일 주소 이름의
// 첫 캘린더(쓰기 가능한 것 먼저). 휴일·구독·다른 사람 캘린더는 기본으로 켜지 않는다.
function suggestCalendars(calendars, email) {
  const list = Array.isArray(calendars) ? calendars : [];
  const mine = String(email || '').trim().toLowerCase();
  const exact = mine ? list.find(one => String(one.name || '').trim().toLowerCase() === mine) : null;
  const pick = exact
    || list.find(one => looksLikeEmail(one.name) && one.writable !== false)
    || list.find(one => looksLikeEmail(one.name));
  return pick ? [String(pick.id)] : [];
}

// 구글(메일 주소 이름) 캘린더가 하나라도 있으면 계정이 있는 것으로 본다.
const hasAccount = calendars => (Array.isArray(calendars) ? calendars : []).some(one => looksLikeEmail(one.name));

// 고른 캘린더를 지금 목록에서 찾는다 — ID로 따라가고(이름이 바뀌어도), ID가 없어졌으면 같은 이름이 하나뿐일 때만 이름으로.
function resolveChosen(calendars, chosen) {
  const list = Array.isArray(calendars) ? calendars : [];
  const ids = [];
  const missing = [];
  (Array.isArray(chosen) ? chosen : []).forEach((want) => {
    const id = String((want && want.id) || '');
    const name = clean(want && want.name);
    let hit = id ? list.find(one => String(one.id) === id) : null;
    if (!hit && name) {
      const same = list.filter(one => clean(one.name) === name);
      if (same.length === 1) hit = same[0];
    }
    if (hit && !ids.includes(String(hit.id))) ids.push(String(hit.id));
    else if (!hit) missing.push(name || id);
  });
  return { ids, missing };
}

// ---------- 일정 → iCal 글자 ----------
const two = n => String(n).padStart(2, '0');
const icsText = value => String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsWall = (ms, zone) => { const w = wallOf(ms, zone); return `${w.y}${two(w.m)}${two(w.d)}T${two(w.h)}${two(w.mi)}${two(w.s)}`; };
const icsDay = (ms, zone) => { const w = wallOf(ms, zone); return `${w.y}${two(w.m)}${two(w.d)}`; };
// 반복 규칙은 `FREQ=…` 한 줄만 받는다(앞의 `RRULE:`는 떼고, 줄바꿈·이상한 글자가 있으면 버린다).
const icsRule = (value) => {
  const rule = String(value || '').trim().replace(/^RRULE:/i, '');
  return /^FREQ=[A-Z0-9=;,:+\-]+$/i.test(rule) ? rule : '';
};

function buildIcs(rows, zone) {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    if (!row || !Number.isFinite(row.start)) return;
    const uid = clean(row.uid, 300).replace(/\s+/g, '') || `mac-${index}`;
    out.push('BEGIN:VEVENT', `UID:${uid.replace(/[\r\n]/g, '')}`, `SUMMARY:${icsText(clean(row.title).replace(/\s*\|\s*/g, ' / '))}`);
    if (row.allDay) {
      out.push(`DTSTART;VALUE=DATE:${icsDay(row.start, zone)}`);
      if (Number.isFinite(row.end) && row.end > row.start) out.push(`DTEND;VALUE=DATE:${icsDay(row.end, zone)}`);
    } else {
      out.push(`DTSTART;TZID=${zone}:${icsWall(row.start, zone)}`);
      if (Number.isFinite(row.end) && row.end >= row.start) out.push(`DTEND;TZID=${zone}:${icsWall(row.end, zone)}`);
    }
    const rule = icsRule(row.recurrence);
    if (rule) {
      out.push(`RRULE:${rule}`);
      (Array.isArray(row.excluded) ? row.excluded : []).filter(Number.isFinite).forEach((ms) => {
        out.push(row.allDay ? `EXDATE;VALUE=DATE:${icsDay(ms, zone)}` : `EXDATE;TZID=${zone}:${icsWall(ms, zone)}`);
      });
    }
    if (/cancel/i.test(String(row.status || ''))) out.push('STATUS:CANCELLED');
    out.push('END:VEVENT');
  });
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}

// JXA가 준 줄들 → 오늘 미팅(시작 시각이 있는 것만 — 비밀 주소 갈래와 같은 규칙). 내가 거절한 초대는 뺀다.
// 반복 일정의 한 회차만 옮긴 것(같은 uid의 한 번짜리 일정이 오늘 있음)이 있으면 원래 반복 회차는 뺀다 — 둘 다 보이지 않게.
function todayFromRows(rows, { now = Date.now(), timeZone } = {}) {
  const kept = (Array.isArray(rows) ? rows : []).filter(row => row && row.declined !== true);
  const detached = new Set(kept.filter(row => !icsRule(row.recurrence) && row.uid).map(row => clean(row.uid, 300).replace(/\s+/g, '')));
  const usable = kept.filter(row => !(icsRule(row.recurrence) && detached.has(clean(row.uid, 300).replace(/\s+/g, ''))));
  return todayEvents(parseCalendar(buildIcs(usable, timeZone)), { now, timeZone });
}

// `tracker/calendar_today.md` — calendar-sync 스킬이 쓰는 모양 그대로(서버의 CALENDAR_ITEM_RE가 읽는다).
function snapshotText(events, day) {
  const lines = ['# 오늘 캘린더 일정', '', `마지막 갱신: ${day}`, ''];
  (events || []).forEach((one) => {
    const title = clean(one.title).replace(/\s*\|\s*/g, ' / ') || '(제목 없음)';
    lines.push(`- ${one.start}-${one.end} | ${title}${one.externalId ? ` | id:${String(one.externalId).replace(/\s+/g, '')}` : ''}`);
  });
  return `${lines.join('\n')}\n`;
}

// ---------- osascript ----------
// 직접 띄운 자식 하나만 다룬다 — 제한 시간이 넘으면 그 자식에게만 TERM, 그래도 남으면 KILL.
// child_process는 여기서만 부른다 — 앱 서버가 이 파일을 불러도(route) 프로세스를 띄우는 모듈은 읽지 않는다.
function runOsascript(input, { bin = '/usr/bin/osascript', script = path.join(__dirname, 'automation', 'mac-calendar.js'), timeoutMs = TIMEOUT_MS, spawnImpl = null } = {}) {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) { resolve({ ok: false, error: 'timeout' }); return; }
    let child;
    try {
      child = (spawnImpl || require('child_process').spawn)(bin, ['-l', 'JavaScript', script, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'failed' });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    let killer = null;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* 이미 끝났다 */ }
      killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 이미 끝났다 */ } }, KILL_GRACE_MS);
      if (typeof killer.unref === 'function') killer.unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (out.length < MAX_OUTPUT) out += chunk; });
    child.stderr.on('data', (chunk) => { if (err.length < 64 * 1024) err += chunk; });
    child.on('error', () => finish({ ok: false, error: 'failed' }));
    child.on('close', (code) => {
      if (killer) clearTimeout(killer);
      if (timedOut) { finish({ ok: false, error: 'timeout' }); return; }
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch { parsed = null; }
      if (code === 0 && parsed && typeof parsed === 'object') { finish(parsed); return; }
      if (/-174[34]\b|not authori[sz]ed|not allowed/i.test(err)) { finish({ ok: false, error: 'denied' }); return; }
      finish({ ok: false, error: 'failed' });
    });
  });
}

// ---------- 한 번 읽기 ----------
// kind: 'check'(허용하고 확인 — 목록 + 고른(또는 기본) 캘린더의 오늘 일정 수, 스냅샷은 쓰지 않는다) | 'run'(주기·지금 가져오기).
async function readMac({ kind, chosen, source, email, now = Date.now(), timeZone, osa }) {
  // 제한 시간은 실제 시계로 잰다(`now`는 "오늘"을 정하는 값이다).
  const deadline = Date.now() + TIMEOUT_MS;
  const left = () => deadline - Date.now();
  const list = await osa({ mode: 'list' }, left());
  if (!list || list.ok !== true) return { ok: false, reason: (list && list.error) === 'denied' ? 'denied' : (list && list.error) === 'timeout' ? 'timeout' : 'failed', calendars: [] };
  const calendars = (Array.isArray(list.calendars) ? list.calendars : []).slice(0, MAX_CALENDARS)
    .map(one => ({ id: clean(one && one.id, 300), name: clean(one && one.name), writable: !(one && one.writable === false) }))
    .filter(one => one.id);
  const suggested = suggestCalendars(calendars, email);
  const base = { calendars, suggested };
  if (!calendars.length) return { ...base, ok: false, reason: 'noAccount' };
  const configured = Array.isArray(chosen) && chosen.length ? chosen : null;
  let ids;
  let missing = [];
  if (kind === 'run' || (configured && source === 'mac')) {
    if (!configured) return { ...base, ok: false, reason: 'none' };
    ({ ids, missing } = resolveChosen(calendars, configured));
    if (!ids.length) return { ...base, ok: false, reason: 'missing', missing };
  } else {
    if (!hasAccount(calendars) || !suggested.length) return { ...base, ok: false, reason: 'noAccount' };
    ids = suggested;
  }
  const day = new Date(now);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const me = {};
  ids.forEach((id) => {
    const one = calendars.find(cal => cal.id === id);
    const mail = one && looksLikeEmail(one.name) ? one.name : (looksLikeEmail(email) ? String(email).trim() : '');
    if (mail) me[id] = mail.toLowerCase();
  });
  const read = await osa({ mode: 'read', ids, start, end, me }, left());
  if (!read || read.ok !== true) return { ...base, ok: false, reason: (read && read.error) === 'denied' ? 'denied' : (read && read.error) === 'timeout' ? 'timeout' : 'failed', read: ids, missing };
  const failed = Array.isArray(read.failed) ? read.failed.map(String) : [];
  const good = ids.filter(id => !failed.includes(id));
  if (!good.length) return { ...base, ok: false, reason: 'failed', read: ids, missing };
  const rows = (Array.isArray(read.events) ? read.events : []).filter(row => row && good.includes(String(row.calendarId)));
  const events = todayFromRows(rows, { now, timeZone });
  return { ...base, ok: true, read: good, failed, missing, events, declinedChecked: read.declinedChecked !== false };
}

// ---------- 파일 ----------
function paths(env = process.env) {
  const automation = env.WORKSPACE_AUTOMATION_DIR || path.join(os.homedir(), '.local', 'share', 'workspace-automation');
  return {
    config: env.WORKSPACE_CONFIG || path.join(__dirname, '..', '..', 'workspace.config.json'),
    data: env.WORKSPACE_DATA_DIR || path.join(__dirname, '..'),
    version: path.join(__dirname, '..', '..', 'VERSION'),
    automation,
    logs: env.AUTOMATION_LOG_DIR || path.join(automation, 'logs'),
  };
}
const statePath = dir => path.join(dir, STATE_FILE);
const requestPath = dir => path.join(dir, 'requests', REQUEST_FILE);

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

const stamp = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const localDay = (ms = Date.now()) => stamp(ms).slice(0, 10);

function versionTag(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').slice(0, 40).replace(/\s+/g, '');
    return /^[0-9A-Za-z.+-]{1,20}$/.test(value) ? ` (v${value})` : '';
  } catch { return ''; }
}

function appendLog(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
  // 로그가 끝없이 커지지 않게 최근 2000줄만 남긴다(run-task.sh와 같다).
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    if (all.length > 2100) writeAtomic(file, all.slice(-2000).join('\n'));
  } catch { /* 줄이기는 곁들이는 일이다 */ }
}

// ---------- 실행 스크립트 ----------
async function main({ mode = 'run', env = process.env, now = Date.now, osa = null, timeZone } = {}) {
  const p = paths(env);
  const log = path.join(p.logs, LOG_FILE);
  const config = readJson(p.config) || {};
  const calendar = config.calendar && typeof config.calendar === 'object' ? config.calendar : {};
  const uses = config.integrations && typeof config.integrations === 'object' ? config.integrations : {};
  // 요청 파일에서는 mode 한 값(check)만 본다 — 그 밖의 글자는 쓰지 않는다.
  const request = mode === 'now' ? readJson(requestPath(p.automation)) : null;
  const kind = request && request.mode === 'check' ? 'check' : 'run';
  const requestedAt = request && typeof request.requestedAt === 'string' ? request.requestedAt.slice(0, 40) : null;
  if (kind === 'run' && (uses.calendar === false || calendar.source !== 'mac')) {
    appendLog(log, [`${stamp(now())} ${TASK} ${uses.calendar === false ? '캘린더 연동이 꺼져 있어 건너뛰어요' : '맥 캘린더 갈래가 아니라 건너뛰어요'}`]);
    return 0;
  }
  const started = stamp(now());
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const bin = env.WORKSPACE_OSASCRIPT || '/usr/bin/osascript';
  const call = osa || ((input, ms) => runOsascript(input, { bin, timeoutMs: ms }));
  const jiraEmail = config.jira && typeof config.jira === 'object' ? config.jira.email : '';
  let result;
  try {
    result = await readMac({ kind, chosen: calendar.macCalendars, source: calendar.source, email: jiraEmail, now: now(), timeZone: zone, osa: call });
  } catch {
    result = { ok: false, reason: 'failed', calendars: [] };
  }
  const events = result.events || [];
  let line;
  if (result.ok) {
    line = `캘린더 ${result.read.length}개 · 오늘 일정 ${events.length}개를 읽었어요`;
    if (result.missing && result.missing.length) line += ` · 고른 캘린더 ${result.missing.length}개를 찾지 못했어요 — 다시 골라 주세요`;
    if (result.failed && result.failed.length) line += ` · 캘린더 ${result.failed.length}개는 읽지 못했어요`;
  } else {
    line = `⚠️ ${WORDS[result.reason] || WORDS.failed}`;
  }
  // 스냅샷은 주기 실행·지금 가져오기(run)에서만, 내용이 바뀌었을 때만 쓴다(같은 내용으로 회의 기록 맞추기를 다시 깨우지 않게).
  if (kind === 'run' && result.ok) {
    const file = path.join(p.data, 'calendar_today.md');
    const text = snapshotText(events, localDay(now()));
    let before = null;
    try { before = fs.readFileSync(file, 'utf8'); } catch { before = null; }
    if (before !== text) writeAtomic(file, text);
  }
  const code = result.ok ? 0 : (EXIT[result.reason] || 1);
  const state = {
    at: new Date(now()).toISOString(),
    kind,
    requestedAt,
    ok: !!result.ok,
    reason: result.ok ? null : (result.reason || 'failed'),
    message: result.ok ? line : (WORDS[result.reason] || WORDS.failed),
    calendars: result.calendars || [],
    suggested: result.suggested || [],
    read: result.read || [],
    missing: result.missing || [],
    eventCount: result.ok ? events.length : null,
    declinedChecked: result.ok ? result.declinedChecked !== false : null,
  };
  try { writeAtomic(statePath(p.automation), `${JSON.stringify(state, null, 2)}\n`); } catch { /* 상태 파일은 화면용이다 — 기록은 로그에 남는다 */ }
  appendLog(log, [`───── ${started} ${TASK} 시작${versionTag(p.version)}`, line, '', `───── ${stamp(now())} ${TASK} 종료 (exit ${code})`]);
  return code;
}

// ---------- 앱 서버 경로 ----------
// GET  /api/integrations/calendar/mac        — 마지막 확인·읽기 결과와 캘린더 목록(이 맥 안의 상태 파일에서만), 기다리는 요청 시각
// POST /api/integrations/calendar/mac-check  — `허용하고 확인`: 요청 표시 파일만 쓴다(프로세스를 띄우지 않는다)
const NOT_INSTALLED = '업데이트.command를 한 번 실행하면 쓸 수 있어요';
function stateView(dir) {
  const raw = readJson(statePath(dir));
  if (!raw) return null;
  const list = Array.isArray(raw.calendars) ? raw.calendars.slice(0, MAX_CALENDARS) : [];
  const ids = value => (Array.isArray(value) ? value.map(v => clean(v, 300)).filter(Boolean).slice(0, MAX_CALENDARS) : []);
  return {
    at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : null,
    kind: raw.kind === 'check' ? 'check' : 'run',
    requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt.slice(0, 40) : null,
    ok: raw.ok === true,
    reason: typeof raw.reason === 'string' && Object.prototype.hasOwnProperty.call(WORDS, raw.reason) ? raw.reason : (raw.ok === true ? null : 'failed'),
    calendars: list.map(one => ({ id: clean(one && one.id, 300), name: clean(one && one.name), writable: !(one && one.writable === false) })).filter(one => one.id),
    suggested: ids(raw.suggested),
    read: ids(raw.read),
    missing: Array.isArray(raw.missing) ? raw.missing.map(v => clean(v)).slice(0, 20) : [],
    eventCount: Number.isFinite(raw.eventCount) ? raw.eventCount : null,
  };
}

function route(req, res, url, ctx) {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/integrations/calendar/mac' && req.method === 'GET') {
    const dir = ctx.automationDir();
    const pending = readJson(requestPath(dir));
    const config = ctx.currentConfigFile() || {};
    const chosen = config.calendar && Array.isArray(config.calendar.macCalendars) ? config.calendar.macCalendars : [];
    send(200, {
      ok: true,
      installed: ctx.launchAgentInstalled(NOW_AGENT),
      requestedAt: pending && typeof pending.requestedAt === 'string' ? pending.requestedAt.slice(0, 40) : null,
      chosen: chosen.map(one => clean(one && one.id, 300)).filter(Boolean),
      state: stateView(dir),
    });
    return true;
  }
  if (url.pathname === '/api/integrations/calendar/mac-check' && req.method === 'POST') {
    if (!ctx.launchAgentInstalled(NOW_AGENT)) { send(200, { ok: false, reason: 'not-installed', error: NOT_INSTALLED }); return true; }
    const requestedAt = new Date().toISOString();
    try {
      writeAtomic(requestPath(ctx.automationDir()), `${JSON.stringify({ mode: 'check', requestedAt })}\n`);
    } catch {
      send(500, { ok: false, reason: 'failed', error: '확인을 요청하지 못했어요 — 잠시 뒤 다시 눌러 주세요' });
      return true;
    }
    send(200, { ok: true, requestedAt });
    return true;
  }
  return false;
}

module.exports = {
  suggestCalendars, hasAccount, resolveChosen, buildIcs, todayFromRows, snapshotText, runOsascript, readMac, main,
  route, stateView, looksLikeEmail, WORDS, EXIT, STATE_FILE, REQUEST_FILE, LOG_FILE, NOW_AGENT, TIMEOUT_MS,
};

if (require.main === module) {
  main({ mode: process.argv[2] === 'now' ? 'now' : 'run' })
    .then((code) => { process.exitCode = code; })
    .catch(() => { process.exitCode = 1; });
}
