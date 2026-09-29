// 쉬는 틈에 자동 업데이트(WP-U) — 판단만 한다. 업데이트를 직접 돌리지 않고 프로세스도 띄우지 않는다:
// 조건이 모두 맞으면 설정 › 앱의 `업데이트 받기`와 **같은 길**(server.js의 requestUpdate — 요청 표시 파일 하나)을 부를 뿐이다.
// 그 뒤는 기존 launchd `com.workspace.app.update` → update-runner.sh → update.sh --yes → setup.sh 그대로다
// (백업·실패 기록·되돌리지 않기 모두 기존 규칙).
//
// 절대 규칙: **갈래가 main이면 어떤 경우에도 요청하지 않는다** — 만든 사람의 개발 저장소를 지킨다(테스트로 고정).
// 판단은 1분마다 한 번, 싼 것부터 본다(메모리 값 → 작은 파일 → git). 파일은 요청을 쓴 그때만 `local/auto-update.json`
// 한 파일에 `{ version, triedOn, requestedAt }`을 적고, 그 시도가 실패로 끝난 것을 처음 본 때 `failed: true`를 더한다.
// 새 버전을 처음 본 때도 `seen: { version, at }`을 한 번 적는다(하루가 넘도록 안 깔리면 쉬는 조건을 낮추고 알린다).
const fs = require('node:fs');
const path = require('node:path');

const AUTO_UPDATE_IDLE_MS = 10 * 60 * 1000;      // 마지막 쓰기 요청(사람의 동작)으로부터 이만큼 조용하면 쉬는 중
const AUTO_UPDATE_TICK_MS = 60 * 1000;           // 판단 주기
const AUTO_RECORD_FILE = 'auto-update.json';
// 새 버전을 처음 본 뒤 이만큼 지나도 아직 안 깔렸으면(쉬는 틈이 없음·밤엔 꺼짐·실행기가 안 돎) 쉬는 조건을 낮추고 한 줄로 알린다.
const AUTO_STALE_MS = 24 * 60 * 60 * 1000;
const AUTO_STALE_IDLE_MS = 3 * 60 * 1000;
// 요청 파일이 이만큼 넘게 그대로 남아 있으면 launchd update가 안 도는 것이다.
const REQUEST_STUCK_MS = 10 * 60 * 1000;
// 다른 자동화가 도는 중인가 — 잠금 폴더(slack-capture·apply·update 실행기)와 run-task.sh 로그의 시작/종료 줄로만 본다
// (프로세스 목록은 보지 않는다). 주인이 죽어 남은 잠금·끝 줄이 없는 로그가 자동 업데이트를 영원히 막지 않게 나이를 둔다.
const AUTOMATION_LOCKS = ['.slack-capture.lock', '.apply.lock', '.update.lock'];
const LOCK_STALE_MS = 60 * 60 * 1000;
const RUN_TASK_MAX_MS = 35 * 60 * 1000;          // run-task.sh의 제한 30분 + 정리 여유
const LOG_MARK_RE = /^───── (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) .*? (시작|종료)(?: \(.*\))?\s*$/;
const LOG_TAIL_BYTES = 16 * 1024;

// 오늘 탭 한 줄로 사람에게 넘기는 이유(자동이 안 되는 까닭). 그 밖의 이유(쉬는 중 아님·다른 자동화·오늘 이미 시도 등)는
// 잠깐 기다리면 풀리는 것이라 알리지 않는다.
// `stuck`(요청이 처리되지 않음)·`stale`(하루 넘게 안 깔림)은 자동이 켜져 있어도 알린다.
const NOTICE_REASONS = ['failed', 'stuck', 'off', 'relocate', 'modified', 'not-installed', 'stale'];

function readTail(file, bytes = LOG_TAIL_BYTES) {
  let handle = null;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return ''; } finally { if (handle !== null) try { fs.closeSync(handle); } catch { /* 닫기 실패는 무시 */ } }
}

// 로그의 마지막 `───── 시각 이름 시작|종료` 줄이 `시작`이고 제한 시간 안이면 도는 중이다(시각은 이 맥의 현지 시각).
function logRunning(file, now) {
  const lines = readTail(file).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = LOG_MARK_RE.exec(lines[i]);
    if (!match) continue;
    if (match[7] !== '시작') return false;
    const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
    const at = new Date(y, mo - 1, d, h, mi, s).getTime();
    return Number.isFinite(at) && now - at >= -60 * 1000 && now - at < RUN_TASK_MAX_MS;
  }
  return false;
}

// 다른 자동화(슬랙 수집·캘린더·티로·등록 다시 하기·업데이트 실행기)가 지금 도는가. 읽기만 한다.
function automationBusy({ automationDir, logDir, now = Date.now() }) {
  for (const name of AUTOMATION_LOCKS) {
    try {
      const stat = fs.statSync(path.join(logDir, name));
      if (stat.isDirectory() && now - stat.mtimeMs < LOCK_STALE_MS) return true;
    } catch { /* 잠금 없음 */ }
  }
  // 등록 다시 하기(setup.sh)를 부탁해 둔 채 아직 집어 가지 않았으면 그것이 먼저다.
  if (fs.existsSync(path.join(automationDir, 'requests', 'apply.request'))) return true;
  let names = [];
  try { names = fs.readdirSync(logDir).filter(name => name.endsWith('.log')); } catch { names = []; }
  return names.some(name => logRunning(path.join(logDir, name), now));
}

function createAutoUpdate(deps) {
  const now = deps.now || (() => Date.now());
  let lastActivityAt = now();
  let timer = null;
  let ticking = null;
  let tickEvery = AUTO_UPDATE_TICK_MS;
  let lastTickAt = null;

  const recordFile = () => {
    const dir = deps.localDir();
    return dir ? path.join(dir, AUTO_RECORD_FILE) : null;
  };
  function readRaw() {
    const file = recordFile();
    if (!file) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }
  // 자동으로 요청한 기록 `{ version, triedOn, requestedAt, failed }` — 요청한 적이 없으면 null.
  function readRecord() {
    const raw = readRaw();
    if (typeof raw.version !== 'string') return null;
    return {
      version: raw.version.slice(0, 40),
      triedOn: typeof raw.triedOn === 'string' ? raw.triedOn.slice(0, 10) : null,
      requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt.slice(0, 40) : null,
      failed: raw.failed === true,
    };
  }
  // 새 버전을 처음 본 때 `seen: { version, at }` — 지금 제안 중인 버전과 같을 때만 쓴다.
  function seenAt(label) {
    const seen = readRaw().seen;
    if (!seen || typeof seen !== 'object' || seen.version !== label) return null;
    const at = Date.parse(seen.at || '');
    return Number.isFinite(at) ? at : null;
  }
  // 있던 칸은 두고 준 칸만 바꿔 쓴다(임시 파일 → 이름 바꾸기).
  function writeRecord(patch) {
    const file = recordFile();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...readRaw(), ...patch })}\n`);
    fs.renameSync(temp, file);
  }
  // 이 버전을 처음 봤으면 적어 두고, 하루가 넘었는가를 돌려준다.
  function markSeen(label) {
    const at = seenAt(label);
    if (at === null) {
      try { writeRecord({ seen: { version: label, at: new Date(now()).toISOString() } }); } catch { /* 다음 판단에서 다시 적는다 */ }
      return false;
    }
    return now() - at >= AUTO_STALE_MS;
  }
  const staleFor = label => { const at = seenAt(label); return at !== null && now() - at >= AUTO_STALE_MS; };
  // 요청 파일이 10분 넘게 그대로인가(`updateStatusView().pending` — 실행기는 집어 가자마자 지운다).
  const requestStuck = (view) => {
    const at = Date.parse((view && view.pending && view.pending.requestedAt) || '');
    return Number.isFinite(at) && now() - at > REQUEST_STUCK_MS;
  };

  // 사람의 동작(쓰기 요청)이 있었다 — 쉬는 시간을 처음부터 다시 센다.
  function touch() { lastActivityAt = now(); }
  const idleFor = () => now() - lastActivityAt;

  // 만든 사람의 개발 저장소(worktree를 여럿 쓴다)도 절대 막는다 — main 갈래 설정이 지워져도 지키는 두 번째 겹.
  // 동료 설치(팀 zip·clone)는 worktree가 하나뿐이다. 알 수 없으면(git 실패) 막는다. deps에 없으면(옛 부르는 쪽) 막지 않는다.
  async function devRepo() {
    if (typeof deps.devRepo !== 'function') return false;
    try { return (await deps.devRepo()) !== false; } catch { return true; }
  }

  // 절대 막는 자리(알리지도 않는다): 개발용·테스트·픽스처, **main 갈래**, 새 버전 없음.
  function gate() {
    if (deps.channel() === 'main') return 'main';
    if (!deps.environment()) return 'environment';
    const offer = deps.offer() || {};
    if (!offer.available || !offer.label || offer.label === 'main') return 'none';
    return null;
  }

  // 자동으로 요청한 그 버전이 실패로 끝났는가(멈춤 또는 그 뒤 되돌리기). 처음 본 때 기록에 `failed`를 남긴다.
  function attemptFailed(record, view, label) {
    if (!record || record.version !== label) return false;
    if (record.failed) return true;
    const status = view && view.status;
    if (!status) return false;
    const started = Date.parse(status.startedAt || '');
    const asked = Date.parse(record.requestedAt || '');
    if (Number.isFinite(asked) && Number.isFinite(started) && started < asked - 5000) return false;
    const failed = status.state === 'failed' || (status.action === 'rollback' && status.state === 'done');
    if (failed) { try { writeRecord({ ...record, failed: true }); } catch { /* 다음 판단에서 다시 본다 */ } }
    return failed;
  }
  const stoppedByFailure = view => !!(view && view.status && view.status.state === 'failed' && !view.settled);
  // 마지막 상태가 되돌리기 완료이고 그 되돌림이 떠난 버전(`from`)이 지금 제안 중인 버전이면 — 사람이 되돌린 버전이라 자동으로 다시 깔지 않는다.
  const bare = value => String(value || '').trim().replace(/^v/, '');
  const rolledBack = (view, label) => {
    const status = view && view.status;
    return !!(status && status.action === 'rollback' && status.state === 'done' && status.from && bare(status.from) === bare(label));
  };

  // 오늘 탭 한 줄 알림의 이유(없으면 null). GET /api/about이 부른다 — 파일은 쓰지 않는다(실패 표시 한 번은 예외).
  async function noticeReason({ modified } = {}) {
    if (gate()) return null;
    if (await devRepo()) return null;
    const label = deps.offer().label;
    const view = deps.status();
    if (stoppedByFailure(view) || rolledBack(view, label) || attemptFailed(readRecord(), view, label)) return 'failed';
    if (requestStuck(view)) return 'stuck';
    if (!deps.enabled()) return 'off';
    if (await deps.needsMove()) return 'relocate';
    const changed = modified !== undefined ? modified : await deps.modified();
    if (Array.isArray(changed) && changed.length) return 'modified';
    if (!deps.agentInstalled()) return 'not-installed';
    if (staleFor(label)) return 'stale';
    return null;
  }

  // 한 번 판단한다. 조건이 모두 맞으면 요청 파일을 쓰고 { requested: true }, 아니면 { requested: false, reason }.
  async function decide() {
    const blocked = gate();
    if (blocked) return { requested: false, reason: blocked };
    const label = deps.offer().label;
    const view = deps.status();
    // 싼 것 먼저(메모리·작은 파일) — 꺼짐·실패·되돌린 버전·오늘 이미 시도는 git을 부르기 전에 본다.
    if (stoppedByFailure(view)) return { requested: false, reason: 'failed' };
    if (rolledBack(view, label)) return { requested: false, reason: 'rolledback' };
    if (!deps.enabled()) return { requested: false, reason: 'off' };
    if (view && view.running) return { requested: false, reason: 'running' };
    if (deps.recoveryNeeded()) return { requested: false, reason: 'recovery' };
    const record = readRecord();
    if (attemptFailed(record, view, label)) return { requested: false, reason: 'failed' };
    if (record && record.version === label && record.triedOn === deps.today()) return { requested: false, reason: 'tried-today' };
    // 만든 사람의 개발 저장소면 여기서 멈춘다(처음 본 때 기록도 그 저장소의 local/에 쓰지 않는다).
    if (await devRepo()) return { requested: false, reason: 'dev-repo' };
    // 하루 넘게 안 깔렸으면 쉬는 조건을 3분으로 낮춰 한 번 더 기회를 준다(다른 조건은 그대로).
    const idleMs = markSeen(label) ? Math.min(deps.idleMs(), AUTO_STALE_IDLE_MS) : deps.idleMs();
    if (idleFor() < idleMs) return { requested: false, reason: 'active' };
    if (!deps.agentInstalled()) return { requested: false, reason: 'not-installed' };
    if (deps.automationBusy()) return { requested: false, reason: 'busy' };
    if (await deps.needsMove()) return { requested: false, reason: 'relocate' };
    const changed = await deps.modified();
    if (changed === null) return { requested: false, reason: 'unknown' };
    if (changed.length) return { requested: false, reason: 'modified' };
    // 기다리는 사이 사람이 돌아왔거나 갈래가 바뀌었으면 쓰지 않는다(마지막으로 한 번 더).
    const late = gate();
    if (late) return { requested: false, reason: late };
    if (await devRepo()) return { requested: false, reason: 'dev-repo' };
    if (idleFor() < idleMs) return { requested: false, reason: 'active' };
    const answer = await deps.request();
    const body = answer && answer.body;
    if (!body || body.ok !== true) return { requested: false, reason: (body && body.reason) || 'request' };
    writeRecord({ version: label, triedOn: deps.today(), requestedAt: body.requestedAt || new Date(now()).toISOString() });
    return { requested: true, version: label };
  }

  // 같은 때 두 번 돌지 않는다. 지난 판단과의 벽시계 간격이 판단 주기의 3배를 넘으면 맥이 잠들었다 깬 것으로 보고
  // 쉬는 시간을 처음부터 센다(뚜껑을 연 직후 업데이트가 시작되지 않게). 테스트는 `wakeGapMs`로 이 간격을 바꾼다.
  function tick() {
    // 판단이 길어져 이번 차례를 건너뛰어도 시각은 적는다(느린 git 때문에 깨어남으로 오해하지 않게).
    const gap = typeof deps.wakeGapMs === 'function' ? deps.wakeGapMs() : tickEvery * 3;
    const at = now();
    if (lastTickAt !== null && at - lastTickAt > gap) touch();
    lastTickAt = at;
    if (ticking) return ticking;
    ticking = decide().catch(() => ({ requested: false, reason: 'error' })).finally(() => { ticking = null; });
    return ticking;
  }

  function start(tickMs = AUTO_UPDATE_TICK_MS) {
    if (timer) return;
    tickEvery = tickMs;
    timer = setInterval(tick, tickMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { touch, idleFor, tick, decide, noticeReason, start, stop, readRecord, devRepo };
}

module.exports = {
  createAutoUpdate, automationBusy, logRunning, NOTICE_REASONS,
  AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_TICK_MS, AUTO_RECORD_FILE, RUN_TASK_MAX_MS, LOCK_STALE_MS,
  AUTO_STALE_MS, AUTO_STALE_IDLE_MS, REQUEST_STUCK_MS,
};
