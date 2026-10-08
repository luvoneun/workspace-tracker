// ---------- 주간요약 문서 ----------
// 평일에는 "이번 주 뭐 했는지" 읽는 문서이고, 금요일에 문장을 고쳐 오른쪽 미리보기 그대로 슬랙에 붙인다.
// 저장하는 길은 `/api/report/change` 하나뿐이고(DECISIONS 주간보고), 이 화면은 추측으로 문장을 만들지 않는다.
// 오른쪽 미리보기와 `슬랙용으로 복사`는 반드시 같은 구조(reportSlackModel)에서 나온다 — 셋이 어긋나면 안 된다.

const reportEdits = new Map();        // `${weekKey}:${행}` / `${weekKey}:new` → 입력 중인 글자(저장 실패해도 남는다)
const reportUndo = new Map();         // weekKey → 되돌리기 토큰
const reportNewRecords = new Map();   // weekKey → { revision, ids } 안 본 새 기록
let reportBusy = false;
let reportMode = 'draft';             // 'draft' 보고 · 'records' 전체 업무 기록
let reportRenderedWeek = null;
let reportRenderedItem = null;
let reportTidy = null;                // 정리 모드(②) — 켜져 있으면 { weekKey, ids: 고른 줄 id(Set), anchor: Shift로 이을 기준 줄 id }
const reportFoldOpen = new Set();     // 접힌 부모를 화면에서만 펼쳐 본 것(저장 안 함)

const REPORT_PLAN_HEADING = '다음 주 계획';
// 서버는 프로젝트가 없는 기록을 `그룹 없음`으로 준다 — 화면에서는 다른 목록과 같은 말로 적는다.
// (상태 소제목(`완료한 일` 등)과 슬랙 복사의 `기타`는 서버가 준 말 그대로 두고 건드리지 않는다.)
const REPORT_NO_PROJECT_LABEL = '그룹 없음';
const REPORT_NO_PROJECT = '프로젝트 없음';
// 화면에 적는 프로젝트 이름. 저장 값·서버가 준 값은 그대로 두고 보이는 말만 앱 용어로 옮긴다.
// 지라 키(`키 · 요약`)는 여기서도 뗀다(BKEY 결정) — 슬랙 복사(reportSlackProjectLabel)와 같은 규칙,
// 정규식은 REPORT_JIRA_LABEL 하나뿐이다.
const reportProjectText = (name) => {
  const value = String(name ?? '').trim();
  if (!value || value === REPORT_NO_PROJECT_LABEL) return REPORT_NO_PROJECT;
  return typeof reportSlackProjectLabel === 'function' ? reportSlackProjectLabel(value) : value;
};
// 다음 주 계획 소제목의 보이는 이름 — 직접 만든 프로젝트 이름이 파일 표기(밑줄, `가입_개선`)로 저장돼 있으면 다른 칸과 같은
// 꼴(`가입 개선`)로 적는다(화면·슬랙 글 모두, 사용자 결정 2026-09-30). 지라 이름(`KEY · 요약`)은 요약 속 밑줄까지 그대로다.
// 저장값·묶는 열쇠(원래 이름)는 그대로이고 보이는 글자만 바뀐다.
function reportPlanShownName(name) {
  const value = String(name ?? '');
  return REPORT_JIRA_LABEL.test(value) ? value : value.replace(/_/g, ' ');
}
// 서버가 프로젝트 없이 담은 계획 문장의 그룹 이름(`report-drafts.js`의 add 기본값).
const REPORT_PLAN_NO_PROJECT = '직접 작성';
// 옛 합치기 행(서로 다른 프로젝트의 문장을 한 문장으로 합친 것)에만 남는 그룹 이름.
const REPORT_MULTI_PROJECT = '여러 프로젝트';
// 문장이 설 소제목 이름. 서버가 보이는 이름이 저장된 이름과 다를 때만 `shownGroup`을 준다 — 사람이 바꾼 소제목 이름이거나,
// 묶음(projectBundles)에 든 티켓이라 대표 이름 아래로 서는 경우다. 저장된 `group`은 그대로다(문서·슬랙이 같은 이름을 쓴다).
const reportRowGroup = row => (row && row.shownGroup) || (row ? row.group : '');
// 문서의 상태 소제목 글자. 서버·저장 값은 `진행중` 그대로 두고 문서에만 띄어 쓴다(슬랙 글의 `[진행중]`은 사용자가 올리는 모양 그대로).
const REPORT_HEADING_TEXT = { '진행중': '진행 중' };
const reportHeadingText = heading => REPORT_HEADING_TEXT[heading] || heading;

// 칸은 둘 — 한 일 칸(완료한 일·진행 중·결정·확인이 프로젝트별로 함께)과 할 일 칸(다음 주 계획). 저장된 소제목(`heading`)은
// 그대로이고 보이는 모양과 슬랙 글만 두 칸으로 합친다(옛 앱이 같은 파일을 읽어도 깨지지 않게).
// 칸 이름은 글자를 눌러 고치고 사람마다 하나라 이 브라우저에 기억한다(주마다가 아니라 — 다른 맥·다른 브라우저에서는 기본 이름).
// 비우고 저장하면 기본 이름으로 돌아간다. localStorage가 막혀 있으면 기본 이름으로 시작한다.
const REPORT_COLUMN_DEFAULT = { done: '[완료]', plan: '[진행 예정]' };
const REPORT_COLUMN_KEY = 'workspace-report-columns';
const REPORT_COLUMN_MAX = 60;
function reportColumnNames() {
  const names = { ...REPORT_COLUMN_DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem(REPORT_COLUMN_KEY));
    for (const key of Object.keys(names)) {
      const value = saved && typeof saved[key] === 'string' ? saved[key].trim() : '';
      if (value && value.length <= REPORT_COLUMN_MAX) names[key] = value;
    }
  } catch {}
  return names;
}
function reportColumnSave(key, value) {
  const names = reportColumnNames();
  const text = String(value ?? '').trim();
  names[key] = text || REPORT_COLUMN_DEFAULT[key];
  const stored = {};
  for (const name of Object.keys(names)) if (names[name] !== REPORT_COLUMN_DEFAULT[name]) stored[name] = names[name];
  try {
    if (Object.keys(stored).length) localStorage.setItem(REPORT_COLUMN_KEY, JSON.stringify(stored));
    else localStorage.removeItem(REPORT_COLUMN_KEY);
  } catch {}
  return names;
}
// 결정·확인 줄 — 처음부터 보고에서 빠져 있고(서버가 `optOut`으로 알린다) 사람이 `다시 넣기`(서버 include)를 누른 줄만 든다.
// 빠져 있어도 한 일 칸 그 프로젝트 아래 흐리게 남는다. 줄 앞의 작은 꼬리표 글자가 값이다.
const REPORT_OPT_IN = { '새로 정해진 것': '결정', '확인 완료': '확인 완료', '확인 대기': '확인 대기' };
const reportOptIn = row => !!row && Object.prototype.hasOwnProperty.call(REPORT_OPT_IN, row.heading);
// 한 일 칸 소제목 이름을 고칠 때 서버에 보내는 자리 — `완료한 일|열쇠`(서버가 `완료한 일` → `진행중` 순서로 읽는다).
const REPORT_DONE_HEADING = '완료한 일';

// ---------- 보내기 전 확인(개편 A) ----------
// 복사 버튼 자리 — 넓은 화면(1120px 초과)은 슬랙 카드 머리, 슬랙 카드가 문서 아래로 내려가는 폭(1120px 이하)은 문서 머리.
// 두 벌을 그려 숨기지 않고 **한 자리에만 하나** 그린다(단축키·보조 기기·테스트가 늘 하나만 잡게). 폭이 경계를 넘으면 다시 그린다.
// matchMedia가 없는 곳(테스트의 가짜 창)은 문서 머리다(예전 자리).
const REPORT_NARROW_QUERY = '(max-width: 1120px)';
function reportCopyInSlack() {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia(REPORT_NARROW_QUERY).matches; }
  catch { return false; }
}
try {
  window.matchMedia(REPORT_NARROW_QUERY).addEventListener('change', () => {
    const item = reportRenderedItem;
    if (!item) return;
    // 고치던 문장 입력칸에 있었으면 다시 그린 뒤 그 칸으로 돌아간다(적던 글은 reportEdits에 그대로 있다).
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const editing = active && active.dataset ? active.dataset.editRow : null;
    renderReportDraft(item);
    if (editing) reportEditFocus(editing);
  });
} catch {}
let reportReviewPick = null;          // `확인 필요 ›`로 옮겨 간 문장 id(그 줄 아래에 근거 한 줄, 선택 톤) — 주를 바꾸면 비운다
let reportMaterialOpen = false;       // 슬랙 카드 맨 위 접힘 줄(확정한 주의 보고에 없는 끝낸 일)을 펼쳐 뒀는지

// 줄 끝 `확인 필요`의 풍선 글 — 이유는 서버(report-drafts.js reviewOf)가 정한다. `legacy`는 이유를 모르는 옛 서버.
const REPORT_REVIEW_TEXT = {
  undone: '근거 업무가 아직 끝나지 않았어요 — 문장은 완료한 일 칸에 있어요',
  missing: '근거 업무가 지워졌어요',
  mixed: '근거 업무의 상태가 서로 달라요',
  changed: '근거 업무가 바뀌었어요',
  marked: '업무 제목에 (확인 필요)·(미확정) 표시가 있어요',
  legacy: '원본을 확인해 주세요',
};
// 이 줄의 확인 필요 이유(없으면 null). 새 서버는 `row.review`, 응답에 `review`가 없는 옛 서버는 `needsReview`로 떨어진다.
// 접힌 부모(화면에서 펼쳐 보지 않은)는 아래 문장의 이유를 빌린다 — 가려진 문장 대신 보이는 줄에 선다. 뺀 문장·계획은 없다.
function reportRowReview(report, row) {
  const own = entry => (report && report.review
    ? (entry.review && entry.review.reason) || null
    : (entry.needsReview ? 'legacy' : null));
  if (!row || row.excluded || row.heading === REPORT_PLAN_HEADING) return null;
  const mine = own(row);
  if (mine) return mine;
  if (row.folded && !reportFoldOpen.has(row.id)) {
    const kid = ((report && report.rows) || []).find(entry => entry.parent === row.id && !entry.excluded && own(entry));
    return kid ? own(kid) : null;
  }
  return null;
}
// `확인 필요 ›`이 차례로 들를 줄(문서에 보이는 순서, 접힌 부모 아래는 부모 한 번).
function reportReviewTargets(report) {
  const rows = (report && report.rows) || [];
  const out = [];
  const done = reportDoneGroups(rows);
  for (const row of [...done.groups.flatMap(group => group.rows), ...done.loose]) {
    if (reportRowHiddenByFold(rows, row)) continue;
    if (reportRowReview(report, row) && !out.includes(row.id)) out.push(row.id);
  }
  return out;
}
// 머리 한 줄의 개수 — 서버가 센 값(`review.count`). 옛 서버는 화면에 보이는 줄 수.
function reportReviewCount(report) {
  if (report && report.review && Number.isFinite(report.review.count)) return report.review.count;
  return reportReviewTargets(report).length;
}

// 탭 닫기·새로고침은 저장하지 않고 묻기만 한다(자동 저장은 앱 안에서 탭을 바꿀 때뿐 — 아래 reportAutosaveLeave).
window.addEventListener('beforeunload', event => {
  if (reportEdits.size || reportBusy) { event.preventDefault(); event.returnValue = ''; }
});

// ---------- 탭을 떠나면 적던 글 저장 ----------
// 적던 글이 있는 채 최상위 탭을 바꾸면(setActiveTab이 주간요약을 떠날 때 부른다) 칸마다 Enter와 같은 길로 하나씩 저장한다.
// 입력칸은 그려질 때 자기 저장 길을 여기 적어 둔다(열쇠 → { weekKey, current, undo, save(item, value) }). 적지 않는 칸 —
// `+ 한 줄 추가`(업무도 함께 만든다)·`나중에 할 일에도 담기` — 은 저장하지 않고 글만 남는다. 보고 있던 주의 글만 저장한다
// (다른 주를 저장하면 그 주가 문서 자리에 그려진다 — 다른 주의 글은 지금처럼 남는다). 비었거나 원래 글과 같으면 저장하지 않고
// 칸만 닫는다. 실패(서버 꺼짐·409·거절)하면 거기서 멈추고 남은 글은 reportEdits에 그대로다. 탭 전환은 기다리지 않는다.
const reportLeaveSavers = new Map();
const reportLeaveSaving = new Set();   // 지금 저장 중인 열쇠 — 그 사이 다시 그려진 입력칸은 잠근다(탭을 떠난 뒤라 칠 사람이 없다)
// Enter로 저장 중인 열쇠 — 칸은 잠그지 않는다(잠근 칸에 친 글자는 브라우저가 버린다 — DESIGN 동작 관습 5). 그 사이 두 번째 Enter·
// 바깥 누르기 저장은 넘긴다(같은 글을 두 번 보내지 않게).
const reportEnterSaving = new Set();
// Enter 저장이 끝난 뒤 문서를 그린다 — 그 사이 칸에서 한글을 조합하는 중이면 조합이 끝난 뒤에(칸을 갈아 끼우면 조합이 끊긴다 —
// 바깥 누르기 저장과 같은 기다리기). 그래서 Enter 저장은 reportChange에 `draw: false`를 주고 이것으로 그린다.
// `settle`은 그리기 직전에 적던 글을 다시 맞추는 일 — 조합이 끝나며 칸이 적던 글을 덮어쓰기 때문이다(한 줄 추가의 남길 글).
async function reportEnterDraw(item, settle = null) {
  await reportLeaveWait(() => !uiComposingLive(), REPORT_COMPOSE_MAX);
  if (settle) settle();
  renderReportDraft(item);
}
// 저장 중의 Esc는 넘긴다 — 저장은 이미 가고 있어 글만 지우면 실패 때 "그대로 있어요"가 거짓이 되고, 성공 때 취소한 글이 저장된다.
function reportEnterEsc(event, key) {
  if (!reportEnterSaving.has(key)) return false;
  event.preventDefault(); event.stopPropagation();
  return true;
}
let reportLeaveRun = Promise.resolve();
// 한글 조합 중인지는 앱 공통 추적(app.js uiComposingLive — 떨어져 나간 칸의 조합은 끝난 것으로 본다)을 본다.
// 바깥 누르기 저장은 한글 조합이 끝날 때까지 기다린다 — 문장 A를 고치다 문장 B를 눌러 치는 중에 A 저장 뒤 문서를 다시 그리면
// B의 조합이 끊긴다. 상한은 멈춤 방지용이다(조합이 이만큼 이어지는 일은 거의 없다).
const REPORT_COMPOSE_MAX = 5000;
const REPORT_LEAVE_FAIL = '저장하지 못했어요 — 주간요약에 적던 글이 남아 있어요';

function reportLeaveSaver(key, saver) { reportLeaveSavers.set(key, saver); }
// 조건이 맞을 때까지 잠깐씩 기다린다(상한을 넘으면 그때의 조건을 돌려준다).
function reportLeaveWait(test, limit) {
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => (test() || Date.now() - started >= limit ? resolve(!!test()) : setTimeout(tick, 50));
    tick();
  });
}
// 탭을 떠날 때마다 한 번 — 앞의 저장이 끝난 뒤 이어서 돈다(연타해도 같은 글을 두 번 보내지 않는다).
function reportAutosaveLeave() {
  reportLeaveRun = reportLeaveRun.then(reportLeaveSave, reportLeaveSave);
  return reportLeaveRun;
}
async function reportLeaveSave() {
  // 한글 조합 중이면 조합이 끝나 마지막 글자가 reportEdits에 들어온 뒤에 본다.
  await reportLeaveWait(() => !uiComposingLive(), 1000);
  await new Promise(resolve => setTimeout(resolve, 0));
  const shown = reportRenderedItem;
  if (!shown || !shown.weekKey) return;
  const week = shown.weekKey;
  const fresh = reportLeaveFresh(week, shown);
  // 같은 칸의 Enter 저장이 줄 서 있으면 그 칸은 건너뛴다(Enter가 이미 꺼내 보낸 글이다 — 실패하면 그쪽이 칸에 되돌린다).
  const queued = key => typeof uiSendQueues !== 'undefined' && uiSendQueues.has(`report:${key}`);
  const keys = [...reportEdits.keys()].filter(key => {
    const saver = reportLeaveSavers.get(key);
    return saver && saver.weekKey === week && !queued(key);
  });
  let saved = 0;
  let closed = false;
  let last = null;
  let failed = false;
  for (const key of keys) {
    // 그 사이 주간요약으로 돌아왔으면 남은 글은 사람 손에 둔다(입력칸이 그대로 열려 있다).
    if (typeof activeTabKey !== 'undefined' && activeTabKey === 'weekly') break;
    // 다른 저장이 도는 중이면 끝난 뒤에(reportChange는 도는 중이면 아무것도 하지 않고 돌아온다). 그 저장이 이 칸의 Enter였으면
    // 성공하면 글이 이미 비워졌고, 실패했으면 같은 글을 한 번 더 보낸다(문장·이름 고치기는 같은 글을 다시 써도 그대로다).
    if (!await reportLeaveWait(() => !reportBusy, 20000)) { failed = true; break; }
    if (typeof activeTabKey !== 'undefined' && activeTabKey === 'weekly') break;
    const step = await reportLeaveSaveKey(key, fresh);
    if (step.state === 'closed') closed = true;
    if (step.state === 'saved') { saved += 1; last = step.saver; }
    if (step.state === 'failed') { failed = true; break; }
  }
  if (closed && reportRenderedItem) renderReportDraft(reportRenderedItem);
  if (failed) { showNotice(REPORT_LEAVE_FAIL, true); return; }
  if (!saved) return;
  // 저장하지 않는 칸(`+ 한 줄 추가`·다른 주)에 글이 남았으면 함께 알린다.
  const left = [...reportEdits.values()].filter(text => String(text ?? '').trim()).length;
  const tail = left ? ` · 저장 안 한 글 ${left}개는 주간요약에 남아 있어요` : '';
  if (saved > 1) { showNotice(`적던 글 ${saved}개를 저장했어요${tail}`); return; }
  const item = fresh();
  showNotice(`적던 글을 저장했어요${tail}`, false, null,
    last.undo && reportUndo.has(week) ? { label: '되돌리기', onClick: () => reportUndoNow(item) } : null);
}
// 저장할 때 쓸 그 주의 최신 보고(다른 창·새 기록으로 바뀌었으면 캐시의 것).
function reportLeaveFresh(week, shown) {
  return () => {
    const cached = typeof weeklyReportsCache !== 'undefined' && Array.isArray(weeklyReportsCache)
      ? weeklyReportsCache.find(entry => entry.weekKey === week) : null;
    return cached && cached.draft ? cached : (reportRenderedItem && reportRenderedItem.weekKey === week ? reportRenderedItem : shown);
  };
}
// 칸 하나를 그 칸의 저장 길로 보낸다(탭을 떠날 때·입력칸을 떠날 때가 함께 쓴다). 돌려주는 것:
// 'skip'(글·저장 길이 이미 없음) · 'closed'(비었거나 같거나 사라진 줄 — 글만 정리했다, 다시 그리기는 부르는 쪽) ·
// 'saved'(저장됨, 저장 길이 그린다) · 'failed'(글은 reportEdits에 남는다, { error }).
// `quiet`(입력칸 떠나면 저장)이면 문서를 다시 그리지 않는다 — 그 칸만 제자리에서 잠그고 저장 길도 그리지 않게 하며(draw: false),
// 다시 그리기는 부르는 쪽이 사람이 다른 칸에서 치는 한글 조합이 끝난 뒤에 한 번 한다.
async function reportLeaveSaveKey(key, fresh, { quiet = false } = {}) {
  const saver = reportLeaveSavers.get(key);
  if (!reportEdits.has(key) || !saver) return { state: 'skip' };
  const value = String(reportEdits.get(key) ?? '');
  // 그 사이 사라진 줄(다른 창의 묶기·되돌리기)의 글은 갈 곳이 없다 — 보내면 거절돼 뒤 칸까지 막으므로 정리한다.
  const gone = saver.rowId && !((fresh().draft && fresh().draft.rows) || []).some(row => row.id === saver.rowId);
  if (gone || !value.trim() || value.trim() === String(saver.current ?? '').trim()) {
    reportEdits.delete(key);
    reportLeaveSavers.delete(key);
    return { state: 'closed' };
  }
  reportLeaveSaving.add(key);
  // 저장이 서버에 가 있는 동안 옛 입력칸에 글을 더 치거나 Enter를 누르지 못하게, 보내자마자 한 번 다시 그린다 — 문장·이름 칸은
  // 잠기고(reportLeaveSaving), 적기줄은 글을 꺼낸 빈 칸이 된다(그 사이 Enter는 같은 대기열 뒤에 선다).
  if (saver.take) reportEdits.delete(key);
  try {
    const pending = saver.save(fresh(), value, quiet ? { draw: false } : undefined);
    if (quiet) reportLeaveLock(key);
    else { renderReportDraft(fresh()); reportFocusBack(); }
    if (await pending === false) throw new Error(REPORT_LEAVE_FAIL);
    reportLeaveSavers.delete(key);
    return { state: 'saved', saver };
  } catch (error) {
    return { state: 'failed', error };
  } finally {
    reportLeaveSaving.delete(key);
  }
}
// 저장 중인 칸을 제자리에서 잠근다(문서를 갈아 끼우지 않는다 — 사람이 막 누른 다른 문장·버튼이 떨어져 나가지 않게).
function reportLeaveLock(key) {
  const host = document.getElementById('weeklyReportDetail');
  if (!host || typeof host.querySelectorAll !== 'function') return;
  const week = String(key).slice(0, String(key).indexOf(':'));
  for (const el of host.querySelectorAll('[data-edit-row], [data-rename-input]')) {
    if (el.dataset.renameInput === key || (el.dataset.editRow !== undefined && `${week}:${el.dataset.editRow}` === key)) el.disabled = true;
  }
}

// ---------- 입력칸을 떠나면 저장 ----------
// 문장·제목·소제목·칸 이름 입력칸은 초점이 그 칸(과 칸 아래 도구 줄) 밖으로 나가면 탭을 떠날 때와 같은 길(reportLeaveSaveKey)로
// 그 칸 하나만 저장하고 닫는다 — 다른 문장을 누르면 앞 문장이 저장돼 닫히고 새 문장이 열린다. 비었거나 원래 글과 같으면 닫기만,
// 실패(서버 꺼짐·409·거절)하면 입력칸을 열어 둔 채 글을 남기고 알린다. 저장하지 않는 때: 칸 안 도구(`보고에서 빼기` 등 —
// 누를 때 초점을 가져가지 않는다)·같은 줄 안 링크로 옮길 때, 앱 창 자체가 초점을 잃을 때(다른 앱·다른 창), Enter·Esc로
// 닫히며 사라질 때, 그 칸이 이미 저장 중일 때. 한글 조합 중이면 조합이 끝난 뒤에 본다. 할 일 칸 적기줄은 늘 떠 있는 줄이라 대상이 아니다.
const reportBlurWatched = new Map();   // 열쇠 → { scope, input } 지금 그려진 입력칸(다시 그리면 새 것으로 바뀐다)
function reportBlurWatch(scope, input, key) {
  reportBlurWatched.set(key, { scope, input });
  scope.addEventListener('focusout', (event) => {
    if (input.disabled || !reportEdits.has(key) || reportLeaveSaving.has(key) || reportEnterSaving.has(key)) return;
    const next = event.relatedTarget;
    if (next && typeof scope.contains === 'function' && scope.contains(next)) return;
    // 줄 안의 글자(근거·안내 줄)를 눌렀다 — 닫지 않는다. 손을 뗐을 때 글자를 고르지 않았으면 입력칸으로 초점을 돌려놓고,
    // 골랐으면(근거의 업무 제목을 긁어 복사) 그대로 둔다.
    if (!next && reportPointerDown && reportPointerTarget && typeof scope.contains === 'function' && scope.contains(reportPointerTarget)) {
      reportAfterPointer(() => {
        const picked = typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (!scope.isConnected || !reportEdits.has(key) || input.disabled || (picked && !picked.isCollapsed)) return;
        const active = document.activeElement;
        if (!active || active === document.body) input.focus();
      });
      return;
    }
    // 초점이 줄 밖의 다른 것(다른 문장 글자·버튼·입력칸)으로 옮겨 갔다 — 바로 줄을 세운다(그것을 누른 뒤 문서를 곧바로 다시
    // 그려도 놓치지 않는다).
    if (next) { reportBlurSave(key); return; }
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    // 옮겨 간 곳을 모르면(빈 곳을 누름·다시 그려 칸이 사라짐) 초점이 다 옮겨 간 뒤에 본다 — 다시 그려 사라진 칸(Enter·Esc·새 기록)은
    // 판단하지 않는다(브라우저는 칸을 뗄 때도 초점이 나갔다고 알린다).
    setTimeout(() => {
      if (!scope.isConnected) return;
      const active = document.activeElement;
      if (active && typeof scope.contains === 'function' && scope.contains(active)) return;
      if (active === input) return;
      reportBlurSave(key);
    }, 0);
  });
}
// 누르고 있는 동안에는 저장·다시 그리기를 미룬다 — 문서를 갈아 끼우면 누른 문장·버튼이 떨어져 나가 손을 뗄 때 click이 사라진다.
// 손을 뗀 뒤 한 틱(그 사이 click이 먼저 돈다). 창 밖에서 뗐으면 뗐다는 소식이 오지 않으므로 상한까지만 기다린다.
let reportPointerDown = false;
let reportPointerTarget = null;
const reportPointerWaiters = [];
document.addEventListener('pointerdown', (event) => {
  reportPointerDown = true;
  reportPointerTarget = event.target;
  reportBlurSweep(event.target);
}, true);
// 뗐다는 소식(pointerup)이 오지 않는 끝도 눌림을 푼다 — 오른쪽 메뉴·포인터 붙잡기를 잃음·탭이 가려짐.
function reportPointerRelease() {
  reportPointerDown = false;
  const waiters = reportPointerWaiters.splice(0);
  setTimeout(() => waiters.forEach(run => run()), 0);
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'contextmenu']) document.addEventListener(name, reportPointerRelease, true);
document.addEventListener('visibilitychange', () => { if (document.hidden) reportPointerRelease(); });
// 초점 없이 열려 있는 칸(근거 글자를 끌어 고른 뒤·저장 실패로 남은 칸·다시 그려 돌아온 칸)은 focusout이 다시 오지 않는다 —
// 그 칸 줄 밖을 누르면 바깥 누르기와 같이 저장하고 닫는다(초점이 있는 칸은 focusout이 맡는다).
function reportBlurSweep(target) {
  const active = document.activeElement;
  for (const [key, { scope, input }] of [...reportBlurWatched]) {
    if (!scope.isConnected) { reportBlurWatched.delete(key); continue; }
    if (!reportEdits.has(key) || input.disabled || reportLeaveSaving.has(key) || reportEnterSaving.has(key) || reportBlurPending.has(key)) continue;
    if (typeof scope.contains !== 'function' || (active && scope.contains(active)) || (target && scope.contains(target))) continue;
    reportBlurSave(key);
  }
}
function reportAfterPointer(run) {
  if (!reportPointerDown) { setTimeout(run, 0); return; }
  reportPointerWaiters.push(run);
}
// 탭을 떠날 때 저장과 같은 줄에 선다 — 한 칸을 두 번 보내지 않는다.
const reportBlurPending = new Set();   // 바깥을 눌러 저장하려고 줄 선 칸
function reportBlurSave(key) {
  reportBlurPending.add(key);
  const step = () => reportBlurSaveNow(key).finally(() => reportBlurPending.delete(key));
  reportLeaveRun = reportLeaveRun.then(step, step);
  return reportLeaveRun;
}
// 고치던 칸에서 곧장 `정리`·`슬랙용으로 복사`·`확정`을 누르면 그 click이 바깥 누르기 저장보다 먼저 돈다 — 줄 선 저장이 있으면
// 끝난 뒤에 판단한다(그래도 남은 글이 있으면 — 저장 실패 — 예전처럼 저장·취소하라고 알린다). 돌려주는 것은 그 주의 최신 보고.
async function reportBlurSettle(item) {
  if (reportBlurPending.size) await reportLeaveRun.catch(() => {});
  return reportRenderedItem && reportRenderedItem.weekKey === item.weekKey ? reportRenderedItem : item;
}
// 그 칸에 초점이 돌아와 있는지(다시 눌러 이어서 고치는 중이면 저장하지 않는다).
function reportBlurBack(key) {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el || !el.dataset) return false;
  const week = String(key).slice(0, String(key).indexOf(':'));
  return el.dataset.renameInput === key || (el.dataset.editRow !== undefined && `${week}:${el.dataset.editRow}` === key);
}
async function reportBlurSaveNow(key) {
  await reportLeaveWait(() => !reportPointerDown, 3000);
  await reportLeaveWait(() => !uiComposingLive(), REPORT_COMPOSE_MAX);
  await new Promise(resolve => setTimeout(resolve, 0));
  const shown = reportRenderedItem;
  const saver = reportLeaveSavers.get(key);
  if (!shown || !saver || saver.weekKey !== shown.weekKey || !reportEdits.has(key) || reportBlurBack(key)) return;
  if (!await reportLeaveWait(() => !reportBusy, 20000)) { showNotice(REPORT_BLUR_FAIL, true); return; }
  if (!reportEdits.has(key) || reportBlurBack(key) || !reportRenderedItem || reportRenderedItem.weekKey !== saver.weekKey) return;
  // 기다리는 사이 이 칸으로 돌아와 한글을 치기 시작했으면 마지막 글자가 들어온 뒤에 읽는다.
  await reportLeaveWait(() => !uiComposingLive(), REPORT_COMPOSE_MAX);
  if (!reportEdits.has(key) || reportBlurBack(key)) return;
  const fresh = reportLeaveFresh(saver.weekKey, shown);
  const step = await reportLeaveSaveKey(key, fresh, { quiet: true });
  if (step.state === 'skip') return;
  // 닫거나(저장·빈 글) 잠갔던 칸을 풀어(실패·409) 한 번 그린다 — 다른 칸에서 한글을 조합하는 중이면 끝난 뒤에(끊지 않게).
  // 알림은 저장 길(reportSavedNotice — Enter와 같은 문구)이 이미 띄웠다.
  await reportLeaveWait(() => !uiComposingLive(), REPORT_COMPOSE_MAX);
  if (reportRenderedItem && reportRenderedItem.weekKey === saver.weekKey) { renderReportDraft(fresh()); reportFocusBack(); }
  if (step.state === 'failed') {
    const message = step.error && step.error.message && step.error.message !== REPORT_LEAVE_FAIL ? step.error.message : REPORT_BLUR_FAIL;
    showNotice(message, true);
  }
}
const REPORT_BLUR_FAIL = '저장하지 못했어요. 적은 내용은 그대로 있어요';
const REPORT_BUSY_TEXT = '다른 저장이 끝나지 않아 하지 못했어요. 적은 내용은 그대로 있어요';
// 문서를 다시 그리면 초점이 있던 칸이 새 요소로 바뀐다 — 저장하는 사이 사람이 옮겨 간 칸(새로 연 문장·Tab으로 간 글자)에 초점과
// 커서를 돌려놓는다. 초점이 이미 다른 곳에 있거나(사라진 칸이 아님) 주간요약을 보고 있지 않으면 아무것도 하지 않는다.
let reportLastFocus = null;
document.addEventListener('focusin', (event) => {
  const host = document.getElementById('weeklyReportDetail');
  if (host && typeof host.contains === 'function' && event.target && host.contains(event.target)) reportLastFocus = event.target;
}, true);
const REPORT_FOCUS_KEYS = ['editRow', 'editText', 'renameInput', 'rename', 'addlineInput', 'addline', 'tidyRow'];
function reportFocusBack() {
  const old = reportLastFocus;
  if (!old || old.isConnected || (typeof activeTabKey !== 'undefined' && activeTabKey !== 'weekly')) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const host = document.getElementById('weeklyReportDetail');
  if (!host || typeof host.querySelectorAll !== 'function' || !old.dataset) return;
  const name = REPORT_FOCUS_KEYS.find(attr => old.dataset[attr] !== undefined);
  const attr = name && `data-${name.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase())}`;
  const twin = attr ? [...host.querySelectorAll(`[${attr}]`)].find(el => el.dataset[name] === old.dataset[name])
    : (old.id ? document.getElementById(old.id) : null);
  if (!twin || twin.disabled) return;
  twin.focus();
  if (typeof twin.setSelectionRange === 'function' && Number.isFinite(old.selectionStart)) {
    try { twin.setSelectionRange(old.selectionStart, old.selectionEnd); } catch {}
  }
}

function reportNode(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

// 저장을 부르는 버튼 한 벌. 저장이 도는 동안 눌리지 않고, 실패하면 알림만 띄운다(입력은 그대로 남는다).
function reportButton(text, action, className = 'd-btn') {
  const el = reportNode('button', text, className);
  el.type = 'button';
  el.disabled = reportBusy;
  el.addEventListener('click', async () => {
    el.disabled = true;
    // 다른 저장이 도는 중이면 저장 길은 아무것도 하지 않고 false를 돌려준다 — 조용히 무시하지 않고 알린다(바깥 누르기 저장은
    // 문서를 다시 그리지 않아 그 사이 버튼이 살아 있다).
    try { if (await action() === false) showNotice(REPORT_BUSY_TEXT, true); }
    catch (error) { showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true); }
    finally { el.disabled = false; }
  });
  return el;
}

// ---------- 제목·소제목 이름을 그 자리에서 고치기 ----------
// 적던 글은 문장 수정과 같은 `reportEdits`에 둔다 — 문서를 다시 그려도(새 기록·다른 창) 입력칸과 글이 그대로 남고,
// 수정 중에는 복사가 막히고 창을 닫을 때 묻는다. 서버는 `/api/report/change`의 `retitle`·`rename` 하나다.
const reportTitleEditKey = weekKey => `${weekKey}:title`;
const reportNameEditKey = (weekKey, heading, key) => `${weekKey}:name:${heading}|${key}`;
// 문장·제목·소제목을 고치는 중인지(다음 주 계획 입력칸에 적던 글은 뺀다) — 머리의 `슬랙용으로 복사`를 3차로 내린다.
function reportEditing(weekKey) {
  const head = `${weekKey}:`;
  return [...reportEdits.keys()].some(key => key.startsWith(head)
    && key !== `${head}${REPORT_PLAN_BOTTOM_KEY}` && !key.startsWith(`${head}plan-add:`)
    && !(key.startsWith(`${head}addline:`) && !String(reportEdits.get(key) || '').trim()));
}

// 편집 중 입력칸 아래의 단서 한 줄 — 버튼이 없으므로 이것이 저장·취소를 알려 주는 유일한 글자다(v3).
const REPORT_EDIT_HINT = 'Enter·바깥 누르면 저장 · Esc 취소';

// 제목·소제목 자리의 입력칸 — 글자를 누르면 그 자리가 입력칸(`.d-din`)이 되고 아래에 `Enter·바깥 누르면 저장 · Esc 취소` 한 줄이 선다.
// 저장·취소 버튼은 없다(v3 — 고치는 법은 하나). 한글 조합 중 Enter는 넘긴다. 원래 이름과 같으면 저장하지 않고 닫고,
// 비우고 저장하면 원래 이름으로 돌아간다(placeholder가 원래 이름이다).
function reportRenameBox(item, { editKey, label, original, current, save, hint, local = false }) {
  const box = reportNode('div', undefined, 'rp-ren');
  const input = reportNode('input', undefined, 'd-din');
  input.type = 'text';
  input.maxLength = 60;
  input.value = reportEdits.get(editKey) ?? current;
  input.placeholder = original;
  input.dataset.renameInput = editKey;
  input.setAttribute('aria-label', `${label} — ${hint ? `${hint} · ` : ''}${REPORT_EDIT_HINT}`);
  input.addEventListener('input', () => reportEdits.set(editKey, input.value));
  // 탭을 떠나면 Enter와 같은 길로 저장한다(reportAutosaveLeave) — 비우면 원래 이름으로 돌리는 Enter와 달리 빈 칸은 닫기만 한다.
  // `local`(칸 이름)은 이 브라우저에만 적어 되돌릴 것이 없다.
  reportLeaveSaver(editKey, { weekKey: item.weekKey, current, undo: !local, save: (fresh, value, options) => save(value.trim(), fresh, options) });
  if (reportLeaveSaving.has(editKey)) input.disabled = true;
  // 바깥을 누르거나 Tab으로 나가면 같은 길로 이 칸만 저장하고 닫는다(reportBlurWatch).
  reportBlurWatch(box, input, editKey);
  const close = () => { reportEdits.delete(editKey); renderReportDraft(item); reportRenameFocus(editKey); };
  const commit = async () => {
    const typed = input.value;
    const value = typed.trim();
    if (value === current) { close(); return; }
    await save(value, item, { typed, draw: false });
    await reportEnterDraw(item);
    reportRenameFocus(editKey);
  };
  // Enter 저장 중에도 칸은 잠그지 않는다 — 이어 친 글자는 칸에 남고, 저장 뒤에도 칸이 그 글로 열려 있다(reportEditsDone).
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { if (reportEnterEsc(event, editKey)) return; event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Enter' || input.disabled) return;
    event.preventDefault();
    if (reportEnterSaving.has(editKey)) return;
    reportEnterSaving.add(editKey);
    commit().catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true))
      .finally(() => { reportEnterSaving.delete(editKey); });
  });
  box.append(input, reportNode('div', hint ? `${hint} · ${REPORT_EDIT_HINT}` : REPORT_EDIT_HINT, 'rp-help'));
  return box;
}
// 다시 그린 뒤 제목·소제목 자리(버튼)로 초점을 돌려놓는다 — 입력칸이 아직 열려 있으면(저장 실패) 입력칸으로.
function reportRenameFocus(editKey) {
  const host = document.getElementById('weeklyReportDetail');
  if (!host || typeof host.querySelectorAll !== 'function') return;
  const find = attr => [...host.querySelectorAll(`[${attr}]`)].find(el => (attr === 'data-rename' ? el.dataset.rename : el.dataset.renameInput) === editKey);
  (find('data-rename-input') || find('data-rename'))?.focus();
}
// 제목·소제목 글자 자체가 누르는 자리다 — 진짜 button이라 Tab으로 닿고 Enter·Space로 편집을 시작한다.
// 손이 닿거나 초점이 오면 옅은 `--hover` 판 + 밑줄로 "누를 수 있음"을 보여 준다(CSS `.rp-rename`).
function reportRenameButton(item, { editKey, text, label, current, tip }) {
  const button = reportNode('button', text, 'rp-rename');
  button.type = 'button';
  button.dataset.rename = editKey;
  button.title = tip || '누르면 이름을 고쳐요';
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => {
    reportEdits.set(editKey, current);
    renderReportDraft(item);
    const input = [...(document.getElementById('weeklyReportDetail')?.querySelectorAll('[data-rename-input]') || [])]
      .find(el => el.dataset.renameInput === editKey);
    if (input) { input.focus(); input.select?.(); }
  });
  return button;
}

// ---------- 순수 함수: 문서 뼈대와 복사 글자 ----------

// 슬랙 글의 첫 줄. 슬랙에 올라간 글은 나중에 읽히므로 `이번 주` 같은 상대 표현은 쓰지 않는다.
// 사람이 제목을 바꿨으면 그 제목 뒤에 같은 기간 괄호를 붙인다(나중에 읽어도 어느 주인지 알 수 있게).
function reportSlackTitle(weekKey, title) {
  if (!weekKey || typeof formatWeekLabel !== 'function') return '';
  const label = formatWeekLabel(weekKey);
  return `${title || label.week} (${label.range.replace(/^\d{4}년\s*/, '').replace(/\s*~\s*/, '~')})`;
}

// ---------- 다른 문장 아래로 들어간 문장(`parent`) ----------
// 서버가 고아 규칙(부모가 없거나 제외됐거나 상태가 다르거나 부모가 또 누군가의 자식)을 이미 적용해
// `parent`를 지운 채로 준다 — 화면은 그 판단을 다시 하지 않고, 목록에 없는 부모만 최상위로 되돌린다.
function reportChildRows(rows) {
  const kept = (rows || []).filter(row => !row.excluded);
  const tops = new Set(kept.filter(row => !row.parent).map(row => row.id));
  const children = new Map();
  for (const row of kept) {
    if (!row.parent || !tops.has(row.parent)) continue;
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent).push(row);
  }
  return children;
}
function reportParentRow(rows, row) {
  if (!row || !row.parent) return null;
  return (rows || []).find(entry => entry.id === row.parent && !entry.excluded && !entry.parent) || null;
}
// 접힌 부모(`folded`)의 아래 문장은 화면에서만 뺀다(문서 그리기 전용 — 저장·슬랙은 건드리지 않는다).
// 화면 상태로 펼쳐 본(`reportFoldOpen`) 부모의 아래는 그대로 그린다.
function reportRowHiddenByFold(rows, row) {
  const parentRow = reportParentRow(rows, row);
  return !!(parentRow && parentRow.folded && !reportFoldOpen.has(parentRow.id));
}

// 옛 합치기 행이 모이는 `여러 프로젝트`는 그 구역의 맨 끝 — 프로젝트 없는 묶음(`기타`·`프로젝트 없음`)이
// 있으면 그 바로 앞에 선다(문서·슬랙 같은 규칙).
function reportMultiProjectLast(list, nameOf, noneOf) {
  const at = list.findIndex(entry => nameOf(entry) === REPORT_MULTI_PROJECT);
  if (at < 0) return list;
  const [multi] = list.splice(at, 1);
  const last = list.length - 1;
  list.splice(last >= 0 && noneOf(list[last]) ? last : list.length, 0, multi);
  return list;
}

// 한 줄씩 풀어 놓은 모양. 일반 글자와 미리보기가 같은 글자를 쓰게 하는 가운데 단계다
// (미리보기를 직접 선택해 복사해도 아래 `reportSlackText`와 같은 글자가 나온다).
// 슬랙에 나가는 구역 제목은 `[완료]` `[진행중]` `[예정]` 꼴이다(사용자가 올리는 글의 모양). 구역을 고르는
// 칩과 저장된 선택은 이름 그대로(`진행 중`)를 쓴다 — 바뀌는 것은 나가는 글자뿐이다.
// 슬랙으로 나가는 글에는 지라 키를 싣지 않는다(`PAY-77 · 요약` → `요약`). 요약을 모르는 이슈는 키밖에 이름이 없어 그대로 나간다.
// 묶기는 원래 이름으로 하고(키가 다르면 다른 프로젝트다) 나가는 글자만 바꾼다. 화면의 소제목도 이제 요약만이다
// (BKEY 결정, reportProjectText가 같은 규칙을 쓴다) — 저장되는 이름은 그대로 `키 · 요약`이다.
const REPORT_JIRA_LABEL = /^([A-Z][A-Z0-9]*-\d+) · (.+)$/;
function reportSlackProjectLabel(name) {
  const match = REPORT_JIRA_LABEL.exec(String(name || ''));
  return match ? match[2] : name;
}
// 색 점의 색은 표기가 아니라 원래 키로 정한다 — 같은 프로젝트가 자리마다 다른 색이면 안 된다.
function reportProjectColorKey(name) {
  const match = REPORT_JIRA_LABEL.exec(String(name || ''));
  return match ? match[1] : name;
}
// 그룹 제목 자리(문서 소제목·전체 업무 기록·다음 주 계획)에서만 쓰는 도구 둘.
// 같은 요약을 가진 지라 이름이 한 목록에 둘 이상이면 그때만 원래 이름(`키 · 요약`)을 남겨 구분한다.
// 저장되는 이름은 그대로 두고 화면 표기만 정한다 — REPORT_JIRA_LABEL 하나로 판단한다(BKEY 결정).
function reportGroupTitles(names) {
  const labels = names.map(name => reportProjectText(name));
  const counts = new Map();
  labels.forEach(label => counts.set(label, (counts.get(label) || 0) + 1));
  return new Map(names.map((name, i) => {
    const label = labels[i];
    const dupe = REPORT_JIRA_LABEL.test(String(name || '')) && counts.get(label) > 1;
    return [name, dupe ? name : label];
  }));
}
// ---------- 한 일 칸 소제목의 자동 괄호 ----------
// 주간요약에 저장된 프로젝트 이름에서 지라 키를 얻는 길: 지라 프로젝트는 `KEY · 요약`으로 저장돼 있고(REPORT_JIRA_LABEL),
// 직접 만든(그룹) 프로젝트는 손으로 걸어 둔 연결(projectLinks)이다.
function reportJiraKeyOf(name) {
  const match = REPORT_JIRA_LABEL.exec(String(name || ''));
  if (match) return match[1];
  const links = typeof jiraProjectLinks === 'function' ? jiraProjectLinks() : {};
  return links[String(name || '').trim()] || '';
}

// 소제목 뒤의 자동 괄호(이번 주 보고만 — 지난 주에 지금 배포일을 붙이면 틀린 말이 된다): 배포 버전에 날짜가 있으면
// `(10/15 배포 목표)` > 날짜 없는 배포 버전만 있으면 `(v2.70)` > 보고에 든 업무 줄이 전부 진행 중이면 `(진행 중)` > 없음.
// 배포 버전은 **이미 받아 둔 지라 목록**에서만 읽는다(주간요약을 열었다고 지라를 새로 부르지 않는다) — 지라를 못 읽는 동안에는
// `(진행 중)`만 붙는다. 사람이 고친 소제목(`origin`이 있는 것)에는 붙이지 않는다(괄호까지 한 글자처럼 고친다 — 사람 이름이 이긴다).
function reportProjectParen(report, group) {
  if (!group || group.origin || group.etc || !report || !reportPlanIsCurrentWeek(report.weekKey)) return '';
  const jira = group.key && group.key.startsWith('jira:') ? group.key.slice(5) : reportJiraKeyOf(group.source || group.group);
  const issues = typeof jiraIssuesByKey === 'object' && jiraIssuesByKey && typeof jiraIssuesByKey.get === 'function' ? jiraIssuesByKey : null;
  const issue = jira && issues ? issues.get(jira) : null;
  if (issue) {
    const dated = typeof deploySoonVersion === 'function' ? deploySoonVersion(issue) : null;
    if (dated && typeof uiDateSlash === 'function') return `(${uiDateSlash(dated.releaseDate)} 배포 목표)`;
    const plain = typeof deployUndatedVersion === 'function' ? deployUndatedVersion(issue) : null;
    if (plain) return `(${plain.name})`;
  }
  const tasks = group.rows.filter(row => !row.excluded && (row.heading === '완료한 일' || row.heading === '진행중'));
  return tasks.length && tasks.every(row => row.heading === '진행중') ? '(진행 중)' : '';
}
// 한 일 칸 소제목의 보이는 글자 — `이름 (괄호)`. `name`은 화면에 적는 이름(reportGroupTitles가 정한 것)이다.
function reportProjectTitle(report, group, name) {
  const paren = reportProjectParen(report, group);
  return { name, paren, text: paren ? `${name} ${paren}` : name };
}

// 고르는 목록에서만 앞뒤를 바꾼다(`요약 · 키`) — 저장되는 값(옵션의 value)은 그대로 원래 이름이다.
function reportPickerLabel(name) {
  const match = REPORT_JIRA_LABEL.exec(String(name || ''));
  return match ? `${match[2]} · ${match[1]}` : name;
}
// 슬랙에 붙일 글의 구조(순수 함수). 일반 글자·서식 있는 복사·미리보기가 모두 여기서 나온다(셋이 어긋나면 안 된다).
// 칸 둘(한 일 · 할 일) → `•` 프로젝트(한 일 칸은 소제목 이름 + 자동 괄호) → `◦` 줄. 프로젝트 없는 줄은 `•` 한 줄로 칸 맨 아래.
// 규칙: 뺀 줄(처음부터 빠진 결정·확인 포함)은 빠짐 · 팔로업으로 묶인 줄은 그 프로젝트 맨 아래 `팔로업` 한 줄 · `기타`로 옮긴 줄은
// 프로젝트들 맨 끝 `• 기타` 아래 · 여러 줄 문장·아래로 넣은 문장은 각 줄이 `◦`(두 단계까지) · 접힌 부모는
// 첫 줄 하나만 · 내용이 없는 칸은 생략. 슬랙에는 지라 키를 싣지 않는다(reportSlackProjectLabel).
// `options.names`는 칸 이름(`{ done, plan }`)이고, 빠뜨리면 이 브라우저에 기억한 이름이다.
const REPORT_FOLLOW_LINE = '팔로업';
function reportSlackModel(report, options = {}) {
  const names = { ...REPORT_COLUMN_DEFAULT, ...(options.names || reportColumnNames()) };
  const rows = report && report.rows ? report.rows : [];
  const children = reportChildRows(rows);
  const linesOf = row => String(row.text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const flat = row => (row.folded ? linesOf(row).slice(0, 1) : [...linesOf(row), ...(children.get(row.id) || []).flatMap(linesOf)]);
  const tops = list => list.filter(row => !row.excluded && !reportParentRow(rows, row));
  const loose = (list, items) => {
    for (const row of tops(list)) {
      const [first, ...rest] = flat(row);
      if (first) items.push({ text: first, notes: rest });
    }
  };
  const done = reportDoneGroups(rows);
  const titles = reportGroupTitles(done.groups.map(group => group.group));
  const doneItems = [];
  for (const group of done.groups) {
    // 팔로업으로 묶인 줄은 나열하지 않고 그 프로젝트 맨 아래 `팔로업` 한 단어 한 줄이 된다(프로젝트마다 따로).
    const kept = tops(group.rows);
    const lines = kept.filter(row => !reportFollowShown(row)).flatMap(flat);
    if (kept.some(reportFollowShown)) lines.push(REPORT_FOLLOW_LINE);
    if (lines.length) doneItems.push({ text: reportSlackProjectLabel(reportProjectTitle(report, group, titles.get(group.group)).text), notes: lines });
  }
  loose(done.loose, doneItems);
  const planItems = [];
  for (const group of reportPlanGroups(reportPlanRows(rows))) {
    if (!group.name) { loose(group.rows, planItems); continue; }
    const lines = tops(group.rows).flatMap(flat);
    if (lines.length) planItems.push({ text: reportSlackProjectLabel(reportPlanShownName(group.name)), notes: lines });
  }
  return {
    title: reportSlackTitle(report && report.weekKey, report && report.title),
    sections: [{ key: 'done', name: names.done, items: doneItems }, { key: 'plan', name: names.plan, items: planItems }].filter(section => section.items.length),
  };
}

// 한 줄씩 풀어 놓은 모양 — 일반 글자와 미리보기가 같은 글자를 쓰게 하는 가운데 단계다(미리보기를 직접 골라 복사해도 같은 글자).
// 빈 줄은 제목 뒤와 칸 사이에만 하나씩 — 프로젝트 사이에는 넣지 않는다(팀이 올리는 글의 모양).
function reportSlackLines(model) {
  const lines = [];
  if (!model || !model.sections.length) return lines;
  const gap = () => lines.push({ kind: 'gap', text: '' });
  if (model.title) { lines.push({ kind: 'title', text: model.title }); gap(); }
  model.sections.forEach((section, index) => {
    if (index) gap();
    lines.push({ kind: 'section', text: section.name });
    for (const item of section.items) {
      lines.push({ kind: 'item', text: `• ${item.text}` });
      for (const note of item.notes) lines.push({ kind: 'note', text: `    ◦ ${note}` });
    }
  });
  return lines;
}

// 서식 없는 곳에 붙을 글자. 형식을 바꾸면 사용자의 슬랙 글 모양이 바뀐다(테스트가 고정한다).
function reportSlackText(model) {
  return reportSlackLines(model).map(line => line.text).join('\n');
}

// 서식 있는 복사. 슬랙 입력창에 붙이면 칸 이름은 굵게, 프로젝트는 `<ul><li>`, 그 아래 줄은 한 단계 안쪽 `<ul>`이 된다.
// 사용자 문구는 전부 escape한다. 빈 줄은 일반 글자와 같은 자리(제목 뒤·칸 사이)에 빈 단락으로 넣는다 — 붙였을 때 간격이 같아야 한다.
// 빈 단락은 `<p><br></p>`다(속이 완전히 빈 `<p></p>`는 붙는 곳에서 지워지는 일이 있다).
const REPORT_SLACK_HTML_GAP = '<p><br></p>';
function reportSlackHtml(model) {
  if (!model || !model.sections.length) return '';
  const bold = text => `<p><b>${escapeHtml(text)}</b></p>`;
  const notes = list => list.length ? `<ul>${list.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : '';
  const html = [];
  if (model.title) html.push(bold(model.title), REPORT_SLACK_HTML_GAP);
  model.sections.forEach((section, index) => {
    if (index) html.push(REPORT_SLACK_HTML_GAP);
    html.push(bold(section.name));
    html.push(`<ul>${section.items.map(item => `<li>${escapeHtml(item.text)}${notes(item.notes)}</li>`).join('')}</ul>`);
  });
  return html.join('');
}

// 한 일 칸의 뼈대 — 문서·슬랙 글·`확인 필요 ›` 차례·정리 알림이 모두 이 묶음을 쓴다.
// 프로젝트(소제목)는 열쇠(groupKey)로 묶고 소제목(완료한 일·진행 중·결정·확인)은 가리지 않는다 — 서버가 준 차례(완료 → 진행 중 →
// 결정·확인)대로 한 프로젝트 아래 선다. 뺀 줄(처음부터 빠진 결정·확인 포함)도 제자리에 남는다(흐리게 — 슬랙 글은 tops가 거른다).
// 팔로업으로 묶인 줄은 그 프로젝트 맨 아래로. 다른 문장 아래로 들어간 문장은 자기 프로젝트가 달라도 부모의 프로젝트 아래 부모 바로 뒤.
// 프로젝트 없는 줄(`그룹 없음`)은 소제목 없이 칸 맨 아래(`loose`), 정리 막대로 `기타`에 옮긴 줄(서버 `etc`)은 프로젝트들 맨 끝
// `기타` 소제목 아래, 옛 합치기의 `여러 프로젝트`는 그 앞. 열쇠가 없는 옛 응답만 이름으로 묶는다.
function reportKidsOf(rows) {
  const kids = new Map();
  for (const row of rows || []) {
    const parent = reportParentRow(rows, row);
    if (!parent) continue;
    if (!kids.has(parent.id)) kids.set(parent.id, []);
    kids.get(parent.id).push(row);
  }
  return kids;
}
function reportDoneGroups(rows) {
  const groups = [];
  const loose = [];
  const etc = [];
  const kidsOf = reportKidsOf(rows);
  for (const row of rows || []) {
    if (row.heading === REPORT_PLAN_HEADING) continue;
    if (reportParentRow(rows, row)) continue;
    const kids = kidsOf.get(row.id) || [];
    const name = reportRowGroup(row);
    if (reportProjectText(name) === REPORT_NO_PROJECT) { (row.etc ? etc : loose).push(row, ...kids); continue; }
    const groupId = row.groupKey ? `key:${row.groupKey}` : `name:${name}`;
    let group = groups.find(entry => entry.id === groupId);
    // `key`·`origin`은 소제목 이름 바꾸기가 쓴다(서버가 준 프로젝트 열쇠와, 사람이 고친 이름일 때의 원래 이름). `source`는 저장된 이름.
    if (!group) {
      group = { group: name, key: row.groupKey || null, origin: row.groupOrigin || null, source: row.group, rows: [] };
      Object.defineProperty(group, 'id', { value: groupId, enumerable: false });
      Object.defineProperty(group, 'blocks', { value: [], enumerable: false });
      groups.push(group);
    }
    group.blocks.push([row, ...kids]);
  }
  // 팔로업으로 묶인 줄(과 그 아래 문장)은 그 프로젝트 맨 아래로 — 나머지 차례는 그대로다.
  for (const group of groups) {
    group.rows = [...group.blocks.filter(block => !reportFollowShown(block[0])), ...group.blocks.filter(block => reportFollowShown(block[0]))].flat();
  }
  reportMultiProjectLast(groups, group => group.group, () => false);
  if (etc.length) {
    const group = { group: REPORT_ETC, key: null, origin: null, source: null, etc: true, rows: etc };
    Object.defineProperty(group, 'id', { value: 'etc', enumerable: false });
    groups.push(group);
  }
  return { groups, loose };
}
// `기타` 소제목 — 정리 막대로 옮긴 줄만 선다(업무 프로젝트는 비어 있다). 점·괄호·`+ 한 줄 추가`가 없다.
const REPORT_ETC = '기타';

// 할 일 칸(다음 주 계획)의 줄 — 사람이 적은 줄과, 서버가 미리 채운 줄(`origin:'carry'` — 진행 중 업무·지난주 계획 중 안 끝난 것,
// 그리고 지난주에 직접 적은 줄은 흐리게 빠진 채). 뺀 줄도 제자리에 남는다(흐리게 — 슬랙 글은 tops가 거른다).
function reportPlanRows(rows) {
  return (rows || []).filter(row => row.heading === REPORT_PLAN_HEADING);
}

// 계획 문장도 문서에서는 프로젝트 소제목 아래로 묶인다. `기타`로 옮긴 줄은 프로젝트들 맨 끝 `기타`(`etc: true`),
// 프로젝트를 고르지 않은 문장은 구역 끝에 소제목 없이 선다(`name: null`).
function reportPlanGroups(rows) {
  const groups = [];
  const byName = new Map();
  const loose = [];
  const etc = [];
  const kidsOf = reportKidsOf(rows);
  for (const row of rows || []) {
    if (reportParentRow(rows, row)) continue;
    const kids = kidsOf.get(row.id) || [];
    const name = String(row.group || '').trim();
    if (!name || name === REPORT_PLAN_NO_PROJECT || name === REPORT_NO_PROJECT_LABEL || name === REPORT_NO_PROJECT) {
      (row.etc ? etc : loose).push(row, ...kids);
      continue;
    }
    if (!byName.has(name)) { const group = { name, rows: [] }; byName.set(name, group); groups.push(group); }
    byName.get(name).rows.push(row, ...kids);
  }
  if (etc.length) groups.push({ name: REPORT_ETC, etc: true, rows: etc });
  if (loose.length) groups.push({ name: null, rows: loose });
  return groups;
}

function reportSourceIds(report) {
  return [...new Set((report.rows || []).flatMap(row => [...row.sourceIds, ...(row.suggestion?.sourceIds || [])]))];
}

const reportSeenKey = weekKey => `workspace-report-seen:${weekKey}`;

// 이 주를 열 때 "안 본 새 기록"을 한 번 세고, 그 순간 본 것으로 표시한다(기존 규칙 그대로).
function reportMarkSeen(item) {
  const cached = reportNewRecords.get(item.weekKey);
  if (cached && cached.revision === item.draft.revision) return cached.ids;
  const currentIds = reportSourceIds(item.draft);
  let previous = null;
  try {
    previous = JSON.parse(localStorage.getItem(reportSeenKey(item.weekKey)));
    localStorage.setItem(reportSeenKey(item.weekKey), JSON.stringify(currentIds));
  } catch {}
  const ids = new Set(previous ? currentIds.filter(id => !previous.includes(id)) : []);
  reportNewRecords.set(item.weekKey, { revision: item.draft.revision, ids });
  return ids;
}

// 주차 목록의 `새 기록 N`. 아직 열어 보지 않은 주는 세어만 보고 "봤다"고 적지 않는다.
function reportNewCount(item) {
  const cached = reportNewRecords.get(item.weekKey);
  if (cached && cached.revision === item.draft.revision) return cached.ids.size;
  let previous = null;
  try { previous = JSON.parse(localStorage.getItem(reportSeenKey(item.weekKey))); } catch {}
  if (!previous) return 0;
  return reportSourceIds(item.draft).filter(id => !previous.includes(id)).length;
}

// ---------- 저장 ----------

// 저장이 끝난 칸의 적던 글을 지운다 — 다만 Enter 때의 글(`options.typed`)과 지금 글이 다르면(저장하는 동안 이어 쳤으면) 지우지 않는다.
// 칸이 그 글로 열린 채 남아 이어 친 글자가 버려지지 않는다(DESIGN 동작 관습 5). 한 줄 더하기(`rest`)는 보낸 글 뒤에 친 것만 남긴다.
function reportEditsDone(key, options, rest = false) {
  const now = reportEdits.get(key);
  if (options.typed === undefined || now === undefined || now === options.typed) { reportEdits.delete(key); return; }
  if (!rest) return;
  const left = now.startsWith(options.typed) ? now.slice(options.typed.length).trimStart() : now;
  if (left.trim()) reportEdits.set(key, left); else reportEdits.delete(key);
}
// `options.key`는 같은 요청을 다시 보내도 한 번만 되게 하는 요청 id(`+ 한 줄 추가`가 업무를 만들 때 — 서버의 Idempotency-Key).
// 다른 저장이 도는 중이면 보내지 않고 false를 돌려준다(성공은 undefined — 이 값을 보는 쪽만 구분한다).
// `options.typed`는 Enter 때 칸의 글 — 저장 뒤 적던 글을 지울지 가린다(reportEditsDone).
async function reportChange(item, action, notice, options = {}) {
  if (reportBusy) return false;
  reportBusy = true;
  let tasksChanged = false;
  try {
    const response = await fetch('/api/report/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
      body: JSON.stringify({ weekKey: item.weekKey, revision: item.draft.revision, ...action }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) {
      // 다른 창이나 새 기록 때문에 판이 달라졌으면 최신 내용을 받아 다시 그린다(입력은 보존).
      if (response.status === 409) {
        const fresh = await (await fetch('/api/items')).json();
        weeklyReportsCache = fresh.weeklyReports;
        const latest = weeklyReportsCache.find(entry => entry.weekKey === item.weekKey);
        if (latest) { reportBusy = false; renderReportDraft(latest); }
      }
      if (result.code === 'RECOVERY_NEEDED' && typeof renderStorageBanner === 'function') renderStorageBanner({ recoveryNeeded: true });
      throw new Error(result.error || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요');
    }
    if (action.action === 'edit') reportEditsDone(`${item.weekKey}:${action.id}`, options);
    if (action.action === 'retitle') reportEditsDone(reportTitleEditKey(item.weekKey), options);
    if (action.action === 'rename') reportEditsDone(reportNameEditKey(item.weekKey, action.heading, action.groupKey), options);
    if (action.action === 'addLine') reportEditsDone(reportAddLineKey(item.weekKey, action.heading, action.groupKey), options, true);
    // `add`로 적던 글을 비우는 것은 입력칸을 들고 있는 쪽(reportPlanAddLines)이 한다 —
    // 다른 입력줄(프로젝트 소제목의 `+ 추가`)에서 담았는데 맨 아래 줄의 글이 날아가면 안 된다.
    // `+ 한 줄 추가`를 되돌린 결과처럼 서버가 되돌리기 표를 주지 않으면 되돌릴 것이 없다.
    if (result.undoToken) reportUndo.set(item.weekKey, result.undoToken); else reportUndo.delete(item.weekKey);
    tasksChanged = !!result.tasksChanged;
    reportLastSkipped = Number.isFinite(result.skipped) ? result.skipped : 0;
    item.draft = result.report;
    const cached = weeklyReportsCache.find(entry => entry.weekKey === item.weekKey);
    if (cached) cached.draft = result.report;
  } finally { reportBusy = false; }
  // draw: false — 부르는 쪽이 곧바로 한 번 더 그린다(같은 틱에 두 번 그리면 첫 그리기의 줄 움직임이 지워진다).
  if (options.draw !== false) renderReportDraft(item);
  reportSavedNotice(item, action, notice);
  // 업무를 만들거나 지웠으면(`+ 한 줄 추가`·그 되돌리기) 오늘·프로젝트 목록도 바로 보이게 목록을 다시 받는다.
  if (tasksChanged && typeof load === 'function') Promise.resolve(load()).catch(() => {});
}

// 저장 뒤 알림 하나. 자리를 옮기는 변경(아래로 넣기·따로 빼기·옛 묶기·묶음 풀기)은 무엇이 바뀌었는지
// 적고 그 자리에서 `되돌리기`까지 준다(머리줄의 `되돌리기`와 같은 길이다). 나머지는 예전 문구 그대로다.
const REPORT_MOVE_NOTICE = {
  edit: '저장했어요',
  nest: '문장을 아래로 넣었어요',
  unnest: '따로 뺐어요',
  split: '묶음을 풀었어요',
  unfold: '풀었어요',
  regroup: '프로젝트를 바꿨어요',
  retitle: '제목을 바꿨어요',
  rename: '소제목 이름을 바꿨어요',
  ackNew: '새로 들어온 것을 모두 확인했어요',
  addLine: '보고에 한 줄 더했어요 · 업무에도 남겼어요',
  confirm: '이 보고를 확정했어요',
  unconfirm: '확정을 풀었어요',
  pullNew: '새로 들어온 줄을 보고에 넣었어요',
  pullOne: '보고에 한 줄 넣었어요',
};
// `notice`를 주면 그 문구만 조용히 알린다(다음 주 계획 담기처럼 무엇을 했는지 문구가 이미 다 말하는 자리).
// 옮기기 되돌리기에서 서버가 건너뛴 업무 수(그 사이 다른 곳에서 프로젝트를 바꾼 업무 — 덮지 않았다).
let reportLastSkipped = 0;
function reportSavedNotice(item, action, notice) {
  if (action.action === 'undo') { announce(reportLastSkipped ? `되돌렸어요 · 그 사이 프로젝트가 바뀐 업무 ${reportLastSkipped}개는 그대로 뒀어요` : '되돌렸어요'); return; }
  if (notice) { announce(notice); return; }
  const message = action.action === 'merge'
    ? `문장 ${action.ids.length}개를 묶었어요`
    : action.action === 'fold'
    ? `한 줄로 모았어요 · ${action.ids.length}건`
    // 제외는 문장이 문서에서 사라지는 변경이라 무엇을 했는지 적고 되돌리기를 준다(⌘Z도 같은 길).
    : action.action === 'exclude'
    ? (((item.draft && item.draft.rows) || []).find(row => row.id === action.id)?.excluded ? '보고에서 뺐어요' : '보고에 되살렸어요')
    : action.action === 'include'
    ? (action.on ? '보고에 다시 넣었어요' : '보고에서 뺐어요')
    // 정리 막대(②) — 몇 줄에 했는지 적고 되돌리기를 준다(⌘Z도 같은 길). 옮기기는 업무에도 반영됐다고 말한다.
    : action.action === 'setOut'
    ? `${action.out ? '보고에서 뺐어요' : '다시 넣었어요'} · ${action.ids.length}줄`
    : action.action === 'follow'
    ? `${action.on ? '팔로업으로 묶었어요' : '팔로업에서 뺐어요'} · ${action.ids.length}줄`
    : action.action === 'move'
    ? `프로젝트를 옮겼어요 · ${action.ids.length}줄 · 업무에도 반영했어요`
    // 완료로 옮기기 — 어느 문장인지 적는다(조사는 문장 끝 글자로 고를 수 없어 붙이지 않는다).
    : action.action === 'complete'
    ? `「${reportNestLabel(String(((item.draft && item.draft.rows) || []).find(row => row.id === action.id)?.text || '').split('\n')[0])}」 완료한 일로 옮겼어요`
    : REPORT_MOVE_NOTICE[action.action];
  if (!message) { announce('보고 내용을 저장했어요'); return; }
  const token = reportUndo.get(item.weekKey);
  showNotice(message, false, null, token ? { label: '되돌리기', onClick: () => reportUndoNow(item) } : null);
}

// 그 주차의 되돌리기(머리줄 버튼·알림 버튼·⌘Z가 모두 이 길을 쓴다).
function reportUndoNow(item) {
  const token = reportUndo.get(item.weekKey);
  if (!token) return Promise.resolve();
  return reportChange(item, { action: 'undo', token })
    .catch(error => showNotice(error.message || '되돌리지 못했어요. 적은 내용은 그대로 있어요', true));
}

// ⌘Z / Ctrl+Z — 주간요약 탭에서 보고 되돌리기. 조건이 아니면 아무것도 하지 않고 앱의 기존 ⌘Z로 흘려보낸다.
// (탭이 주간요약이 아니거나, 입력칸 안이거나, 그 주차의 되돌리기 토큰이 없으면 손대지 않는다.)
function reportUndoHotkeyItem(event) {
  if (!event || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (String(event.key || '').toLowerCase() !== 'z') return null;
  if (typeof activeTabKey === 'undefined' || activeTabKey !== 'weekly') return null;
  if (event.target && event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return null;
  const item = reportRenderedItem;
  return item && reportUndo.has(item.weekKey) ? item : null;
}

function reportUndoHotkey(event) {
  const item = reportUndoHotkeyItem(event);
  if (!item) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  reportUndoNow(item);
  return true;
}

// 앱이 켜질 때 한 번만 단다(탭을 오갈 때마다 쌓이지 않게). capture 단계라 app.js의 ⌘Z보다 먼저 본다.
document.addEventListener('keydown', reportUndoHotkey, true);

// 알림·막대에 적는 문장 — 첫 줄만, 길면 줄인다.
function reportNestLabel(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

// ---------- 정리 모드(②) ----------
// 줄에서 하는 일은 둘 — 글자를 누르면 고치기 / 머리의 `정리`를 눌러 줄을 골라 아래 막대 버튼. 정리 모드 동안 글머리 자리에
// 선택 칸(오늘 탭 여러 개 선택의 `.d-selcb`)이 서고 줄 아무 데나 눌러 고른다(Shift로 여러 줄, Tab은 선택 칸에만). 맨 위에 알림 한 줄,
// 아래에 선택 막대(`#reportNestBarEl`, `.d-selbar`). 막대 버튼을 눌러도 고른 줄은 그대로라 바로 반대 버튼으로 되돌린다.
// Esc 한 번은 떠 있는 목록만 닫고, 목록이 없으면 모드를 끝낸다. 끝나면 초점은 머리의 `정리` 버튼으로 간다.
// 서버는 `setOut`·`follow`·`move`(한 요청 = 한 저장 = 되돌리기 하나), 옛 묶음 풀기는 `unfold`·`split`·`unnest`.

// 팔로업 후보 — 한 일 칸의 프로젝트 있는 업무 줄 중 업무 제목에 이 말이 든 것. 알리기만 하고 앱이 스스로 묶지 않는다.
const REPORT_FOLLOW_HINT = /팔로업|QA|대응/;
const REPORT_TASK_HEADINGS = ['완료한 일', '진행중'];
const reportHasProject = row => /^(jira|group):./.test(String((row && row.groupKey) || ''));
// 팔로업으로 묶인 줄이 그렇게 보이는지 — 프로젝트가 사라지면(프로젝트 없음) 표시는 보이지 않는다(저장값은 그대로).
const reportFollowShown = row => !!row && !!row.follow && !row.excluded && REPORT_TASK_HEADINGS.includes(row.heading) && reportHasProject(row);
// 막대 버튼마다 맞는 줄 — 서버 follow·move와 같은 조건이다.
// 다른 문장 아래로 넣은 줄(parent)은 슬랙 글에서 부모에 딸려 나가 `팔로업` 줄이 생기지 않으므로 묶지 않는다.
const reportCanFollow = row => !!row && REPORT_TASK_HEADINGS.includes(row.heading) && !row.manual && !row.excluded && !row.follow
  && !row.parent && (row.sourceIds || []).length > 0 && reportHasProject(row);
function reportCanMove(row) {
  if (!row || reportOptIn(row)) return false;
  if (row.heading === REPORT_PLAN_HEADING) return true;
  const sources = row.currentEvidence || row.evidence || [];
  return !row.manual && (row.sourceIds || []).length > 0 && sources.length === row.sourceIds.length
    && sources.every(source => ['task', 'bug'].includes(source.type));
}
// 옛 묶음을 푸는 길 — 접힌·모은 부모는 unfold, 합친 줄은 split, 다른 문장 아래 줄은 unnest. 없으면 null.
function reportUnfoldAction(rows, row) {
  if (!row) return null;
  if ((rows || []).some(entry => entry.parent === row.id)) return 'unfold';
  if (row.canSplit) return 'split';
  if (row.parent) return 'unnest';
  return null;
}
// 고른 줄에 맞는 버튼과 그 줄 수(순수 함수 — 시험이 표를 본다). 고른 줄 전부에 맞으면 버튼에 숫자를 붙이지 않는다.
function reportTidyCounts(report, ids) {
  const rows = (report && report.rows) || [];
  const picked = rows.filter(row => ids && ids.has(row.id));
  const of = test => picked.filter(test).map(row => row.id);
  return {
    n: picked.length,
    out: of(row => !row.excluded),
    in: of(row => !!row.excluded),
    follow: of(reportCanFollow),
    unfollow: of(row => !!row.follow),
    move: of(reportCanMove),
    // `풀기`는 고른 줄이 하나일 때만 선다 — 줄마다 한 요청이라 여러 줄이면 되돌리기가 마지막 하나뿐이고 중간에 실패하면 반만 풀린다.
    unfold: picked.length === 1 ? of(row => !!reportUnfoldAction(rows, row)) : [],
  };
}
const REPORT_TIDY_BUTTONS = [
  ['out', '보고에서 빼기'], ['in', '다시 넣기'], ['follow', '팔로업으로 묶기'], ['unfollow', '팔로업에서 빼기'], ['move', '프로젝트 옮기기'], ['unfold', '풀기'],
];
// 막대에 서는 버튼 이름(맞는 줄이 있는 것만) — `[열쇠, 글자]`. 일부에만 맞으면 끝에 줄 수(`프로젝트 옮기기 1`).
function reportTidyButtons(counts) {
  return REPORT_TIDY_BUTTONS.filter(([key]) => counts[key].length)
    .map(([key, text]) => [key, counts[key].length === counts.n ? text : `${text} ${counts[key].length}`]);
}

// 알림 한 줄 — 할 것이 있는 항목만. 팔로업 후보는 프로젝트마다 따로(`f:<열쇠>`), 그다음 `결정`(처음부터 빠진 결정 줄) ·
// `프로젝트 없음`(한 일 칸의 프로젝트 없는 업무 줄). 접힌 부모 아래에 가려진 줄은 고를 수 없어 세지 않는다.
function reportTidyAlerts(report) {
  const rows = (report && report.rows) || [];
  const shown = row => !reportRowHiddenByFold(rows, row);
  const done = reportDoneGroups(rows);
  const titles = reportGroupTitles(done.groups.map(group => group.group));
  const items = [];
  for (const group of done.groups) {
    const ids = group.rows.filter(row => shown(row) && reportCanFollow(row)
      && (row.currentEvidence || row.evidence || []).some(source => REPORT_FOLLOW_HINT.test(String(source.description || '')))).map(row => row.id);
    if (ids.length) items.push({ k: `f:${group.key || group.group}`, fol: true, label: titles.get(group.group), ids });
  }
  const decisions = rows.filter(row => shown(row) && row.heading === '새로 정해진 것' && row.excluded).map(row => row.id);
  if (decisions.length) items.push({ k: 'dec', label: '결정', ids: decisions });
  const loose = done.loose.filter(row => shown(row) && !row.excluded && REPORT_TASK_HEADINGS.includes(row.heading) && (row.sourceIds || []).length).map(row => row.id);
  if (loose.length) items.push({ k: 'nopj', label: REPORT_NO_PROJECT, ids: loose });
  return items;
}
// 알림에서 눌러 본 항목은 그 주 이 브라우저에 기억한다(흐려지고 머리 숫자에서 빠진다). 저장이 막혀 있으면 이번 화면에서만.
const reportTidySeenKey = weekKey => `workspace-report-tidy-seen:${weekKey}`;
const reportTidySeenMemo = new Map();
function reportTidySeen(weekKey) {
  if (reportTidySeenMemo.has(weekKey)) return reportTidySeenMemo.get(weekKey);
  let seen = [];
  try { const saved = JSON.parse(localStorage.getItem(reportTidySeenKey(weekKey))); if (Array.isArray(saved)) seen = saved.filter(key => typeof key === 'string'); } catch {}
  const set = new Set(seen);
  reportTidySeenMemo.set(weekKey, set);
  return set;
}
function reportTidySeenAdd(weekKey, key) {
  const set = reportTidySeen(weekKey);
  set.add(key);
  try { localStorage.setItem(reportTidySeenKey(weekKey), JSON.stringify([...set])); } catch {}
}
// 머리 `정리 N`의 N — 눌러 보지 않은 알림 항목의 줄 수.
function reportTidyTodo(item) {
  const seen = reportTidySeen(item.weekKey);
  return reportTidyAlerts(item.draft).filter(entry => !seen.has(entry.k)).reduce((sum, entry) => sum + entry.ids.length, 0);
}

function reportTidyStart(item) {
  if (reportEditing(item.weekKey) && reportBlurPending.size) { reportBlurSettle(item).then(latest => reportTidyStart(latest)); return; }
  if (reportEditing(item.weekKey)) {
    showNotice('고치는 중인 글이 있어요. Enter로 저장하거나 Esc로 취소한 뒤 정리해 주세요.', true);
    return;
  }
  reportMode = 'draft';
  reportTidy = { weekKey: item.weekKey, ids: new Set(), anchor: null };
  escDrop(reportTidyEnd);
  escPush(reportTidyEnd);
  if (typeof usageTick === 'function') usageTick('weekly_tidy');
  renderReportDraft(item);
  reportTidyFocus('[data-tidy-head]');
}
function reportTidyEnd() {
  // 저장이 도는 중의 Esc는 아무것도 닫지 못한다 — 스택에서 빠진 자기를 되돌려 놓아야 다음 Esc가 듣는다.
  if (reportBusy && reportTidy) { if (!escStack.includes(reportTidyEnd)) escPush(reportTidyEnd); return; }
  if (!reportTidy) return;
  reportTidy = null;
  escDrop(reportTidyEnd);
  if (typeof uiMenuOpen === 'object' && uiMenuOpen && uiMenuOpen.anchor && uiMenuOpen.anchor.closest && uiMenuOpen.anchor.closest('#reportNestBarEl')) uiMenuClose();
  if (reportRenderedItem) renderReportDraft(reportRenderedItem);
  reportTidyFocus('[data-tidy-head]');
}
// 다시 그린 뒤 초점을 돌려놓는다 — 문서·막대 어디든(선택자가 가리키는 첫 요소).
function reportTidyFocus(selector, value) {
  const roots = [document.getElementById('weeklyReportDetail'), document.getElementById('reportNestBarEl')].filter(Boolean);
  for (const root of roots) {
    if (typeof root.querySelectorAll !== 'function') continue;
    const found = [...root.querySelectorAll(selector)].find(el => value === undefined || Object.values(el.dataset || {}).includes(value));
    if (found) { found.focus(); return true; }
  }
  return false;
}
// 줄 하나를 고르거나 뺀다. Shift면 기준 줄부터 이 줄까지(화면 차례) 전부 고른다.
function reportTidyToggle(item, rowId, shift) {
  if (!reportTidy) return;
  const host = document.getElementById('weeklyReportDetail');
  const order = host && typeof host.querySelectorAll === 'function' ? [...host.querySelectorAll('[data-tidy-row]')].map(el => el.dataset.tidyRow) : [];
  if (shift && reportTidy.anchor && order.includes(reportTidy.anchor) && order.includes(rowId)) {
    const a = order.indexOf(reportTidy.anchor), b = order.indexOf(rowId);
    order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(id => reportTidy.ids.add(id));
  } else {
    if (reportTidy.ids.has(rowId)) reportTidy.ids.delete(rowId); else reportTidy.ids.add(rowId);
    reportTidy.anchor = rowId;
  }
  renderReportDraft(item);
  reportTidyFocus('[data-tidy-row]', rowId);
}
// 알림 항목을 누르면 그 줄들로 고른 것을 바꾸고, 그 항목을 본 것으로 적는다.
function reportTidyPickAlert(item, entry) {
  if (!reportTidy) return;
  reportTidy.ids = new Set(entry.ids);
  reportTidy.anchor = entry.ids[entry.ids.length - 1] || null;
  reportTidySeenAdd(item.weekKey, entry.k);
  renderReportDraft(item);
  reportTidyFocus('[data-tidy-alert]', entry.k);
}

// 알림 한 줄(`.rp-tidy`) — 문서 머리 바로 아래. 할 것이 없으면 조용한 안내 한 마디.
function reportTidyAlertLine(item) {
  const items = reportTidyAlerts(item.draft);
  const line = reportNode('div', undefined, 'rp-tidy');
  if (!items.length) {
    line.setAttribute('role', 'status');
    line.appendChild(reportNode('span', '손볼 줄이 없어요 — 줄을 골라 아래 막대로 정리해요', 'calm'));
    return line;
  }
  line.setAttribute('role', 'group');
  line.setAttribute('aria-label', '정리할 것');
  const seen = reportTidySeen(item.weekKey);
  const dot = () => { const el = reportNode('span', '·', 'dot'); el.setAttribute('aria-hidden', 'true'); return el; };
  const button = (entry) => {
    const el = reportNode('button', undefined, 'rp-tidyit' + (seen.has(entry.k) ? ' is-seen' : ''));
    el.type = 'button';
    el.dataset.tidyAlert = entry.k;
    el.append(reportNode('span', entry.label), reportNode('span', String(entry.ids.length), 'n'));
    el.title = entry.fol ? '제목에 팔로업 · QA · 대응이 있는 줄이에요 — 누르면 이 프로젝트의 그 줄들을 골라요' : '누르면 이 줄들을 골라요';
    el.setAttribute('aria-label', entry.fol ? `팔로업으로 묶을 후보: ${entry.label} ${entry.ids.length}줄 고르기` : `${entry.label} ${entry.ids.length}줄 고르기`);
    el.addEventListener('click', () => reportTidyPickAlert(item, entry));
    return el;
  };
  const fol = items.filter(entry => entry.fol), rest = items.filter(entry => !entry.fol);
  if (fol.length) {
    line.appendChild(reportNode('span', '팔로업으로 묶을까요?', 'k'));
    fol.forEach((entry, index) => { if (index) line.appendChild(dot()); line.appendChild(button(entry)); });
  }
  rest.forEach((entry, index) => { if (index || fol.length) line.appendChild(dot()); line.appendChild(button(entry)); });
  return line;
}

// 선택 막대 — 모드 내내 선다. 개수 칸은 바뀔 때마다 읽히는 자리(aria-live)라 같은 요소를 그대로 두고 나머지만 다시 그린다
// (오늘 탭 taskSelectionRefresh와 같다). 맨 오른쪽은 늘 `완료`.
function reportTidyBar(item) {
  const bar = document.getElementById('reportNestBarEl');
  if (!bar) return;
  const open = !!reportTidy && reportMode === 'draft';
  document.body.classList.toggle('nest-open', open);
  // 비우고 닫으므로 닫힘은 복사본이 재생한다(선택 막대와 같은 부품 .d-stay)
  if (!open && !bar.hidden && typeof uiFloatGhost === 'function') uiFloatGhost(bar);
  bar.hidden = !open;
  if (!open) { bar.replaceChildren(); return; }
  bar.setAttribute('aria-label', '고른 줄');
  let inner = bar.querySelector('.bar');
  let count = inner && inner.children[0];
  if (!inner || !count || count.getAttribute('aria-live') !== 'polite') {
    bar.replaceChildren();
    inner = reportNode('div', undefined, 'bar');
    count = reportNode('span');
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
    inner.appendChild(count);
    bar.appendChild(inner);
  }
  [...inner.children].forEach((kid) => { if (kid !== count) inner.removeChild(kid); });
  const counts = reportTidyCounts(item.draft, reportTidy.ids);
  count.className = counts.n ? 'ct' : 'hint';
  count.textContent = counts.n ? `${counts.n}줄 고름` : '줄을 눌러 골라요 · Shift로 여러 줄';
  for (const [key, text] of reportTidyButtons(counts)) {
    const button = reportButton(text, () => reportTidyApply(item, key, counts[key], button), 'd-btn sm');
    button.dataset.tidyAct = key;
    if (key === 'move') { button.setAttribute('aria-haspopup', 'true'); button.setAttribute('aria-expanded', 'false'); }
    inner.appendChild(button);
  }
  inner.appendChild(reportNode('span', undefined, 'sp'));
  const done = reportButton('완료', () => reportTidyEnd(), 'd-btn acc sm');
  done.dataset.tidyAct = 'done';
  inner.appendChild(done);
}

// 막대 버튼 하나. 저장 뒤 막대가 다시 그려지면 같은 버튼(없으면 반대 버튼 → 첫 버튼)으로 초점을 돌려놓는다.
const REPORT_TIDY_SWAP = { out: 'in', in: 'out', follow: 'unfollow', unfollow: 'follow' };
async function reportTidyApply(item, key, ids, button) {
  if (!ids.length) return;
  if (key === 'move') { reportMoveOpen(item, ids, button); return; }
  if (key === 'unfold') {
    // 옛 묶음 풀기 — 고른 줄 하나만(서버 unfold·split·unnest, 되돌리기 하나).
    const rows = item.draft.rows || [];
    const action = ids.length === 1 ? reportUnfoldAction(rows, rows.find(row => row.id === ids[0])) : null;
    if (action) await reportChange(item, { action, id: ids[0] });
  } else if (key === 'out' || key === 'in') await reportChange(item, { action: 'setOut', ids, out: key === 'out' });
  else await reportChange(item, { action: 'follow', ids, on: key === 'follow' });
  reportTidyFocus('[data-tidy-act]', key) || reportTidyFocus('[data-tidy-act]', REPORT_TIDY_SWAP[key]) || reportTidyFocus('[data-tidy-act]');
}

// ---------- 프로젝트 옮기기 목록 ----------
// 막대의 `프로젝트 옮기기` 위로 뜨는 작은 목록 — 더보기 메뉴(uiMenu, 뜨는 것 부품) 안에 앱의 프로젝트 고르기 목록(uiPickList)을
// 펼친다. 선택지 출처는 앱 전체의 프로젝트 고르기와 같은 projectPickEntries(값이 프로젝트 열쇠 — 서버 move의 `to`와 같다)이고,
// 끝의 `직접 입력…`·`프로젝트 빼기` 대신 `기타`(프로젝트 없이 맨 아래 기타 소제목)·`새 프로젝트…`(그 자리 입력칸)를 둔다.
// Esc는 목록만 닫고(초점은 버튼으로), 입력칸의 Esc는 목록으로 돌아간다.
const REPORT_MOVE_ETC = 'etc';
// 새 프로젝트 이름으로 받지 않는 말 — 서버(report-drafts.js RESERVED_NAMES)와 같은 목록·같은 말.
const REPORT_RESERVED_NAMES = ['기타', '그룹 없음', '직접 작성', '프로젝트 없음'];
const REPORT_RESERVED_NAME_ERROR = '`기타`·`그룹 없음`·`직접 작성`·`프로젝트 없음`은 새 프로젝트 이름으로 쓸 수 없어요. 다른 이름을 적어 주세요.';
// 옮기기 요청 → 요청 id. 응답을 못 받고(15초) 다시 누르면 같은 id라 서버가 앞 결과를 돌려준다(업무를 두 번 옮기지 않고 되돌리기도 받는다).
const reportMoveIds = new Map();
const reportPickCustom = () => (typeof PICK_CUSTOM !== 'undefined' ? PICK_CUSTOM : '__custom__');
function reportMoveEntries(current) {
  const base = typeof projectPickEntries === 'function' ? projectPickEntries(current || null, false) : [];
  const clear = typeof PICK_CLEAR !== 'undefined' ? PICK_CLEAR : null;
  return [
    ...base.filter(entry => entry.type !== 'action' || (entry.value !== reportPickCustom() && entry.value !== clear)),
    { type: 'action', value: REPORT_MOVE_ETC, text: '기타' },
    { type: 'action', value: reportPickCustom(), text: '새 프로젝트…' },
  ];
}
function reportMoveOpen(item, ids, button) {
  const rows = (item.draft.rows || []).filter(row => ids.includes(row.id));
  const keys = [...new Set(rows.map(row => (row.heading === REPORT_PLAN_HEADING ? null : row.groupKey)))];
  const common = keys.length === 1 && reportHasProject({ groupKey: keys[0] }) ? keys[0] : null;
  const current = common ? { type: common.slice(0, common.indexOf(':')), value: common.slice(common.indexOf(':') + 1) } : null;
  const wrap = reportNode('div', undefined, 'rp-regroup is-picking');
  const back = () => { if (typeof uiMenuClose === 'function') uiMenuClose(); reportTidyFocus('[data-tidy-act]', 'move'); };
  const send = async (to) => {
    if (typeof uiMenuClose === 'function') uiMenuClose();
    const memo = `${item.weekKey}|${ids.join(',')}|${JSON.stringify(to)}`;
    if (!reportMoveIds.has(memo)) reportMoveIds.set(memo, reportRequestId());
    try {
      await reportChange(item, { action: 'move', ids, to }, undefined, { key: reportMoveIds.get(memo) });
      reportMoveIds.delete(memo);
    } catch (error) {
      // 같은 id의 앞 요청은 이미 옮겨졌는데 그 뒤 보고가 바뀐 경우 — 다시 보내지 않고 최신 보고를 받는다(addLine과 같은 규칙).
      if (/다른 내용으로 같은 요청/.test(String(error && error.message))) {
        reportMoveIds.delete(memo);
        if (typeof load === 'function') await Promise.resolve(load()).catch(() => {});
        showNotice('이미 옮겨 둔 줄이에요. 최신 보고를 불러왔어요.', true);
      } else showNotice(error.message || '옮기지 못했어요. 고른 줄은 그대로예요', true);
    }
    reportTidyFocus('[data-tidy-act]', 'move') || reportTidyFocus('[data-tidy-act]');
  };
  // 목록을 먼저 채운 뒤 메뉴를 띄운다 — 메뉴가 자리를 잴 때 목록 높이까지 알아야 막대 위로 뒤집힌다(아래가 모자라므로).
  const showList = (initial = false) => {
    const entries = reportMoveEntries(current);
    const list = uiPickList({
      entries,
      label: '옮길 프로젝트',
      search: uiPickSearchable(entries),
      onClose: () => back(),
      onPick: (value, query) => {
        if (value === reportPickCustom()) { showInput(String(query || '').trim()); return; }
        send(value === REPORT_MOVE_ETC ? 'etc' : value);
      },
    });
    wrap.replaceChildren(list);
    if (initial) return list;
    if (typeof uiPickFit === 'function') uiPickFit(list);
    list.focusStart();
    return list;
  };
  const showInput = (seed) => {
    const box = reportNode('div', undefined, 'rp-newpj');
    const input = reportNode('input', undefined, 'd-din');
    input.type = 'text';
    input.maxLength = 60;
    input.value = seed;
    input.placeholder = '새 프로젝트 이름';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '새 프로젝트 이름 — Enter 옮기기 · Esc 목록으로');
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); showList(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) return;
      if (REPORT_RESERVED_NAMES.includes(name)) { showNotice(REPORT_RESERVED_NAME_ERROR, true); return; }
      send({ name });
    });
    box.append(input, reportNode('div', '이름을 적고 Enter — 이 보고와 업무에 함께 쓰여요 · Esc 목록으로', 'rp-help'));
    wrap.replaceChildren(box);
    input.focus();
  };
  const list = showList(true);
  const menu = uiMenu(button, [
    [{ field: '옮길 프로젝트', control: wrap }],
    [{ label: '업무의 프로젝트도 같이 바뀌어요', disabled: true, onClick() {} }],
  ]);
  if (!menu) return;
  list.focusStart();
}

// ---------- 문서의 부품 ----------

// 머리 한 줄(v3): 제목 · 기간 ··· `다음 주 계획`(조용한 글자 버튼) · `슬랙용으로 복사`(1차) · ⋯.
// ⋯ 안: `전체 업무 기록 보기`(↔ `보고로 돌아가기`) · 직전 변경 되돌리기 · 개수 한 줄. 뺀 줄은 문서 제자리에 흐리게 남는다(②).
// ⋯ 맨 위 묶음은 확정(`이 보고 확정하기` ↔ `확정 풀기`)이다(다듬기 B).
function reportDocHead(item, host) {
  const report = item.draft;
  const label = formatWeekLabel(item.weekKey);
  const head = reportNode('div', undefined, 'd-lhd rp-hd');
  // 제목은 사람이 바꿀 수 있다(`retitle`, 비우면 원래 이름). 제목 글자가 곧 누르는 자리다.
  const original = reportWeekName(item.weekKey);
  const current = report.title || original;
  const titleKey = reportTitleEditKey(item.weekKey);
  const title = reportNode('h2', undefined, 'rp-title');
  if (reportEdits.has(titleKey)) {
    title.appendChild(reportRenameBox(item, {
      editKey: titleKey, label: '보고 제목', original, current,
      save: (text, target = item, options) => reportChange(target, { action: 'retitle', text }, undefined, options),
    }));
  } else {
    title.appendChild(reportRenameButton(item, { editKey: titleKey, text: current, label: `보고 제목: ${current} — 고치기`, current, tip: '누르면 제목을 고쳐요' }));
  }
  head.appendChild(title);
  // 기간은 올해면 연도를 뺀다(다른 해의 주만 연도가 붙는다).
  const thisYear = typeof todayStr === 'function' ? todayStr().slice(0, 4) : '';
  head.appendChild(reportNode('span', thisYear && item.weekKey.startsWith(thisYear) ? label.range.replace(/^\d{4}년\s*/, '') : label.range, 'sub'));

  // 오른쪽 동작은 한 묶음이다 — 자리가 모자라면 묶음째 다음 줄 오른쪽으로 내려간다.
  const acts = reportNode('span', undefined, 'rp-acts');
  // `정리`(②) — 늘 서는 조용한 글자 버튼 하나. 손볼 줄이 있으면 숫자 하나(`정리 N`), 모드 중에는 `완료`가 되어 모드를 끝낸다.
  if (reportMode === 'draft') acts.appendChild(reportTidyHeadButton(item));
  // 금요일에 가장 먼저 하는 일이 계획 쓰기다 — 긴 문서를 훑지 않고 바로 그 자리로 데려간다(이번 주만).
  if (reportPlanIsCurrentWeek(item.weekKey)) {
    acts.appendChild(reportButton('다음 주 계획', () => {
      reportMode = 'draft';
      renderReportDraft(item);
      const input = document.getElementById('reportPlanInput');
      if (!input) return;
      const still = typeof detailReduce === 'function' && detailReduce(); // 움직임 줄이기면 바로 간다
      input.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      input.focus();
    }, 'd-headnum'));
  }
  // 복사 버튼은 슬랙 카드가 옆에 설 때(1120px 초과) 슬랙 카드 머리에 있다 — 그때 문서 머리에는 없다. 좁은 폭에서만 여기에
  // 서고, 그 왼쪽에 `확인 필요 N ›`이 붙는다(걸린 문장이 있을 때만).
  if (!reportCopyInSlack()) {
    if (reportReviewCount(report) > 0 && reportMode === 'draft') acts.appendChild(reportReviewButton(item));
    acts.appendChild(reportCopyButton(item));
  }
  acts.appendChild(uiMoreButton('주간요약 더 보기', () => reportHeadMenuSections(item)));
  head.appendChild(acts);
  host.appendChild(head);
}

function reportTidyHeadButton(item) {
  const on = !!reportTidy;
  const todo = on ? 0 : reportTidyTodo(item);
  const button = reportNode('button', undefined, 'd-headnum' + (on ? ' is-on' : ''));
  button.type = 'button';
  button.dataset.tidyHead = 'true';
  button.setAttribute('aria-pressed', String(on));
  if (on) { button.textContent = '완료'; button.setAttribute('aria-label', '정리 완료'); }
  else {
    button.textContent = '정리';
    if (todo) {
      button.appendChild(reportNode('span', String(todo), 'n'));
      button.setAttribute('aria-label', `정리 — 손볼 줄 ${todo}개`);
    }
    button.title = '줄을 골라 빼기 · 다시 넣기 · 팔로업으로 묶기 · 프로젝트 옮기기';
  }
  button.addEventListener('click', () => (reportTidy ? reportTidyEnd() : reportTidyStart(item)));
  return button;
}

// `슬랙용으로 복사` — 한 화면에 채운 버튼은 이것 하나다. 고치는 중이거나 정리 모드일 때는 3차로 내려선다.
// 자리는 부르는 쪽이 정한다(넓으면 슬랙 카드 머리, 좁으면 문서 머리 — reportCopyInSlack). 어느 자리든 하나만 그린다.
function reportCopyButton(item) {
  const busyMode = reportEditing(item.weekKey) || (reportMode === 'draft' && reportTidy !== null);
  return reportButton('슬랙용으로 복사', async () => {
    // 바깥 누르기로 저장 중인 글이 있으면 끝난 뒤의 보고를 복사한다.
    const latest = await reportBlurSettle(item);
    const report = latest.draft;
    // 열어만 둔 빈 `+ 한 줄 추가` 칸은 적던 글이 아니다.
    if ([...reportEdits.keys()].some(key => key.startsWith(item.weekKey + ':')
      && !(key.startsWith(`${item.weekKey}:addline:`) && !String(reportEdits.get(key) || '').trim()))) {
      throw new Error('고치는 중인 글이 있어요. Enter로 저장하거나 Esc로 취소한 뒤 복사해 주세요.');
    }
    const model = reportSlackModel(report);
    try {
      await reportSlackCopy(model);
    } catch {
      reportSelectPreview();
      throw new Error('이 브라우저가 복사를 막았어요. 슬랙 미리보기 글을 골라 두었으니 ⌘C로 복사해 주세요.');
    }
    // 보고를 보내는 순간이 확정하기 가장 자연스러운 때다 — 복사 알림에 `이대로 확정`을 붙인다(이미 확정했으면 알림만).
    if (report.confirmed) announce('슬랙에 붙여 넣을 수 있게 복사했어요');
    else showNotice('슬랙에 붙여 넣을 수 있게 복사했어요', false, null, { label: '이대로 확정', onClick: () => reportConfirm(latest, true) });
    // 사용 횟수(WP-R) — 복사 한 번, 그리고 복사한 글에 할 일 칸 줄이 있으면 한 번 더(다음 주 칸이 빈칸에서 시작하지 않는지 보려고).
    if (typeof usageTick === 'function') {
      usageTick('weekly_copy');
      if (model.sections.some(section => section.key === 'plan')) usageTick('weekly_copy_plan');
    }
    reportKeep(latest);
  }, busyMode ? 'd-btn' : 'd-btn pri');
}

// 복사가 끝나면 지금 보이는 줄(미리 채운 할 일 칸 줄 포함)을 한 번 적는다(서버 keep — 문장·새로 기록은 그대로, 되돌리기 기록 없음).
// 화면을 여는 것(GET)은 파일을 쓰지 않아서, 그 주를 한 번도 저장하지 않으면 미리 채운 줄이 다음 주의 `지난주 계획`이 되지 못한다.
// 이번 주·확정 전만. 조용히 한다 — 실패해도 복사는 이미 됐고 다음 저장이 다시 적는다. 줄 id는 그대로라 다시 그리지 않고 판만 바꾼다.
async function reportKeep(item) {
  if (!item || !item.draft || item.draft.confirmed || !reportPlanIsCurrentWeek(item.weekKey) || reportBusy) return;
  try {
    const response = await fetch('/api/report/change', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekKey: item.weekKey, revision: item.draft.revision, action: 'keep' }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result || !result.report) return;
    item.draft = result.report;
    const cached = (typeof weeklyReportsCache !== 'undefined' && Array.isArray(weeklyReportsCache) ? weeklyReportsCache : []).find(entry => entry.weekKey === item.weekKey);
    if (cached) cached.draft = result.report;
  } catch {}
}

// `확인 필요 N ›` — 바탕 없는 주황 글자 버튼(`--warn`). 누르면 걸린 문장으로 가서 그 문장 글자에 초점을 둔다(다시 누르면 다음 문장).
// 옮겨 간 줄은 선택 톤 + 바로 아래 근거 한 줄. 고치던 글은 reportEdits에 남고 입력칸도 닫지 않는다(이동만).
function reportReviewButton(item) {
  // 숫자는 화면이 실제로 들르는 줄 수 — 서버는 접힌 부모 아래 문장을 하나씩 세지만 `›`는 그 부모를 한 번만 들른다.
  const visits = reportReviewTargets(item.draft).length;
  const count = visits || reportReviewCount(item.draft);
  const go = reportNode('button', undefined, 'rp-go');
  go.type = 'button';
  go.appendChild(reportNode('span', `확인 필요 ${count}`));
  const chev = reportNode('span', undefined, 'cv');
  chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = uiIcon('chevron');
  go.appendChild(chev);
  go.title = '확인이 필요한 문장으로 가요';
  // 읽어 주는 이름은 `확인 필요 N개 중 k번째로 이동` — 누를 때마다 다음 문장으로 돈다(k는 이번에 갈 자리).
  const targets = reportReviewTargets(item.draft);
  const next = reportReviewNext(item.draft, targets);
  go.setAttribute('aria-label', next ? `확인 필요 ${targets.length}개 중 ${targets.indexOf(next) + 1}번째로 이동` : `확인 필요 ${count}개`);
  go.addEventListener('click', () => reportReviewGo(item));
  return go;
}
// 다음에 갈 문장 — 아직 고른 줄이 없으면 서버의 첫 문장(없으면 문서 순서 첫 줄), 있으면 그다음(끝이면 처음으로).
function reportReviewNext(report, targets = reportReviewTargets(report)) {
  if (!targets.length) return null;
  const at = targets.indexOf(reportReviewPick);
  if (at >= 0) return targets[(at + 1) % targets.length];
  return report && report.review && targets.includes(report.review.first) ? report.review.first : targets[0];
}
function reportReviewGo(item) {
  const id = reportReviewNext(item.draft);
  if (!id) return;
  reportReviewPick = id;
  reportMode = 'draft';
  renderReportDraft(item);
  const host = document.getElementById('weeklyReportDetail');
  if (!host || typeof host.querySelector !== 'function') return;
  const target = host.querySelector(`[data-edit-row="${id}"]`) || host.querySelector(`[data-edit-text="${id}"]`);
  if (!target) return;
  const still = typeof detailReduce === 'function' && detailReduce();
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  target.focus({ preventScroll: true });
  // 여기예요 밝히기 — 옮겨 온 문장 줄을 한 번 밝힌다(고른 톤 is-hit은 그대로 남는다)
  const line = typeof target.closest === 'function' ? target.closest('.rp-s') : null;
  if (line && typeof uiHere === 'function') { uiHere(line); reportHereUntil = Date.now() + (typeof UI_RARE !== 'undefined' ? UI_RARE.here : 0); }
}
// 밝히는 동안 문서를 다시 그리면(바깥 누르기 저장 등) 새 줄에서 다시 밝힌다.
let reportHereUntil = 0;

// 머리 ⋯ 메뉴(순수에 가까움 — 테스트가 이름표를 본다). 개수 줄은 누를 수 없는 조용한 항목이다.
function reportHeadMenuSections(item) {
  const report = item.draft;
  const rows = report.rows || [];
  return [
    [report.confirmed
      ? { label: '확정 풀기', onClick: () => reportConfirm(item, false) }
      : { label: '이 보고 확정하기', onClick: () => reportConfirm(item, true) }],
    [
      reportMode === 'records'
        ? { label: '보고로 돌아가기', onClick: () => { reportMode = 'draft'; renderReportDraft(item); } }
        : { label: '전체 업무 기록 보기', onClick: () => { reportMode = 'records'; renderReportDraft(item); } },
      reportUndo.has(item.weekKey) ? { label: '직전 변경 되돌리기', onClick: () => reportUndoNow(item) } : null,
    ].filter(Boolean),
    [{ label: `보고 ${rows.filter(row => !row.excluded).length}문장 · 근거 업무 ${reportSourceIds(report).length}개`, disabled: true, onClick() {} }],
  ];
}

// 머리 아래 상태 줄(v3) — 다듬은 뒤 새로 들어온(또는 바뀐) 줄이 있을 때만 옅은 파란 한 줄이 서고, 없으면 줄 자체가 없다.
// 확정한 주는 대신 회색 한 줄 `M/D에 확정했어요`(+ 그 뒤 새로 들어온 줄이 있으면 ` · 그 뒤 N줄이 새로 끝났어요` — 글만).
// `전체 업무 기록`을 보는 중에는 돌아가는 길을 같은 자리에 둔다.
function reportTopBlock(item, host) {
  const top = reportNode('div', undefined, 'rp-top');
  if (reportMode === 'records') {
    const line = reportNode('div', undefined, 'rp-status is-quiet');
    line.appendChild(reportNode('span', '전체 업무 기록을 보고 있어요'));
    line.appendChild(reportButton('보고로 돌아가기', () => { reportMode = 'draft'; renderReportDraft(item); }, 'd-link'));
    top.appendChild(line);
  } else if (item.draft.confirmed) {
    const confirmed = item.draft.confirmed;
    const line = reportNode('div', undefined, 'rp-status is-quiet');
    line.setAttribute('role', 'status');
    // 글만 남긴다 — 넣기는 슬랙 카드 맨 위 접힘 줄(한 줄씩 `넣기`, 2줄 이상이면 그룹 머리의 `모두 넣기`)에서 한다(개편 A).
    line.appendChild(reportNode('span', reportConfirmedText(confirmed)));
    top.appendChild(line);
  } else {
    const text = reportStatusText(item.draft.since);
    if (text) {
      const line = reportNode('div', undefined, 'rp-status');
      line.setAttribute('role', 'status');
      line.appendChild(reportNode('span', text));
      line.appendChild(reportButton('확인했어요', () => reportChange(item, { action: 'ackNew' }), 'd-link'));
      top.appendChild(line);
    }
  }
  // 상태 줄도 줄 부품의 열쇠를 단다 — `확인했어요`로 사라지면 그림자가 흐려지고, 새로 생기면 나타난다(펼침 부품).
  [...top.children].forEach((line) => { line.dataset.moveId = 'st:report'; });
  if (top.children.length) host.appendChild(top);
}

// `9/30에 확정했어요`(+ ` · 그 뒤 N줄이 새로 끝났어요` — 새 줄이 전부 완료한 일이 아니면 `들어왔어요`).
function reportConfirmedText(confirmed) {
  const at = new Date(confirmed.at);
  const day = Number.isNaN(at.getTime()) ? '' : `${at.getMonth() + 1}/${at.getDate()}에 `;
  const head = `${day}확정했어요`;
  if (!confirmed.pending) return head;
  return `${head} · 그 뒤 ${confirmed.pending}줄이 새로 ${confirmed.pendingDone === confirmed.pending ? '끝났어요' : '들어왔어요'}`;
}

// 확정하기·풀기(머리 ⋯, 복사 알림의 `이대로 확정`). 고치는 중인 글이 있으면 먼저 저장·취소하게 한다.
async function reportConfirm(item, on) {
  if (on && reportEditing(item.weekKey) && reportBlurPending.size) item = await reportBlurSettle(item);
  if (on && reportEditing(item.weekKey)) {
    showNotice('고치는 중인 글이 있어요. Enter로 저장하거나 Esc로 취소한 뒤 확정해 주세요.', true);
    return Promise.resolve();
  }
  return reportChange(item, { action: on ? 'confirm' : 'unconfirm' })
    .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true));
}

// `지난번 다듬은 뒤 N줄이 새로 들어왔어요`(+ ` · M줄이 바뀌었어요`) — 둘 다 0이거나 기록이 없으면 빈 글자.
function reportStatusText(since) {
  if (!since) return '';
  const parts = [];
  if (since.fresh) parts.push(`${since.fresh}줄이 새로 들어왔어요`);
  if (since.changed) parts.push(`${since.changed}줄이 바뀌었어요`);
  return parts.length ? `지난번 다듬은 뒤 ${parts.join(' · ')}` : '';
}

// 고르거나 고치는 문장 바로 아래 조용한 근거 한 줄(개편 A): `근거 · <업무 제목> · <상태·날짜>`. 여러 업무면 첫 업무 + `외 N개`.
// 근거가 없는 줄(계획·옛 보고 문장)은 줄 자체가 없다. 출처 링크(`슬랙 ↗`)는 출처 종류 판별(2단계) 뒤에 붙인다.
function reportEvidenceLine(row, rows) {
  if (!row || row.heading === REPORT_PLAN_HEADING) return null;
  const kids = row.manual ? (rows || []).filter(entry => entry.parent === row.id) : [];
  const sources = kids.length ? kids.flatMap(entry => entry.currentEvidence || entry.evidence || []) : (row.currentEvidence || row.evidence || []);
  const gone = kids.length ? 0 : Math.max(0, (row.sourceIds || []).length - sources.length);
  if (!sources.length && !gone) return null;
  const line = reportNode('div', undefined, 'rp-ev1');
  const bits = [reportNode('span', '근거', 'k')];
  if (sources.length) {
    const first = sources[0];
    bits.push(reportNode('span', `${first.description}${sources.length > 1 ? ` 외 ${sources.length - 1}개` : ''}`, 't'));
    const task = ['task', 'bug'].includes(first.type);
    const found = (typeof itemsById !== 'undefined' && itemsById.get(first.id)) || (typeof wfItem === 'function' ? wfItem(first.id) : null);
    const day = found && found.completed && typeof uiDateSlash === 'function' ? ` ${uiDateSlash(found.completed)}` : '';
    const state = first.type === 'decision' ? '결정'
      : first.type === 'check' ? (first.status === 'done' ? '확인 완료' : '확인 대기')
      : first.status === 'done' ? `완료${day}` : '미완료';
    const off = task && first.status !== 'done' && row.heading === '완료한 일';
    bits.push(reportNode('span', state, off ? 'w' : ''));
  }
  if (gone) bits.push(reportNode('span', `지워진 업무 ${gone}개`, 'w'));
  bits.forEach((bit, index) => {
    if (index) { const dot = reportNode('span', '·', 'dot'); dot.setAttribute('aria-hidden', 'true'); line.appendChild(dot); }
    line.appendChild(bit);
  });
  return line;
}

// 원본이 바뀌었을 때의 수정 제안 — v3에서는 줄 끝 작은 알약 하나(기존 칩 부품 `.d-chip`)이고, 누르면 제안 글과
// `적용`·`그대로 두기`가 메뉴로 뜬다. 지금 문장은 덮어쓰지 않고 사람이 고른다(DECISIONS). B의 `끝났어요 · 완료로`도 이 자리다.
function reportSuggestionLabel(suggestion) {
  if (suggestion.missing || suggestion.mixed) return '원본 확인';
  return suggestion.added ? `새 업무 ${suggestion.added}개` : '원본 바뀜';
}
function reportSuggestionMenuSections(item, row) {
  const suggestion = row.suggestion;
  const text = String(suggestion.text || '연결된 원본을 찾지 못했어요.').split('\n')[0];
  return [
    [{ label: `제안: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`, disabled: true, onClick() {} }],
    [
      !suggestion.missing && !suggestion.mixed ? { label: '제안대로 바꾸기', onClick: () => reportChange(item, { action: 'accept', id: row.id }) } : null,
      { label: '지금 문장 그대로 두기', onClick: () => reportChange(item, { action: 'acknowledge', id: row.id }) },
    ].filter(Boolean),
    suggestion.missing || suggestion.mixed ? [{ label: '원본 상태가 다르거나 지워진 업무가 있어요', disabled: true, onClick() {} }] : null,
  ].filter(Boolean);
}
// 줄 끝 한 마디(개편 A) — 한 줄에 하나만: `끝났어요 · 완료로` > 제안 알약(원본 바뀜·새 업무 N개) > `확인 필요`.
// 끝났어요는 초록 글자 버튼 하나(누르는 자리 한 곳, --success), 확인 필요는 바탕 없는 주황 글자(--warn, 이유는 풍선).
function reportRowPill(item, row) {
  // 완료 제안(다듬기 B) — 진행 중 줄의 업무가 이 주에 끝났으면. 누르면 문장 그대로 완료한 일 칸 같은 프로젝트로 옮긴다
  // (알림·⌘Z로 되돌린다). 원본 문구까지 바뀌었으면 서버가 이 표시를 주지 않는다(원래 제안만).
  if (row.completable) {
    const move = reportNode('button', '끝났어요 · 완료로', 'rp-end is-ok');
    move.type = 'button';
    move.title = '업무가 이 주에 끝났어요 — 문장 그대로 완료한 일로 옮겨요';
    move.setAttribute('aria-label', `${reportNestLabel(String(row.text || '').split('\n')[0])} — 업무가 끝났어요. 완료한 일로 옮기기`);
    move.addEventListener('click', (event) => {
      event.stopPropagation();
      move.disabled = true;
      reportChange(item, { action: 'complete', id: row.id })
        .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true))
        .finally(() => { move.disabled = false; });
    });
    return move;
  }
  const reason = reportRowReview(item.draft, row);
  if (row.suggestion) {
    const pill = reportNode('button', reportSuggestionLabel(row.suggestion), 'd-chip rp-pill');
    pill.type = 'button';
    pill.setAttribute('aria-haspopup', 'true');
    pill.setAttribute('aria-label', `${reportSuggestionLabel(row.suggestion)} — 제안 보기`);
    // 같은 줄이 확인 필요로도 세어졌으면 그 이유를 풍선에 둔다(한 줄에 한 마디 — 알약이 대신 선다).
    if (reason && REPORT_REVIEW_TEXT[reason]) pill.title = REPORT_REVIEW_TEXT[reason];
    pill.addEventListener('click', (event) => { event.stopPropagation(); uiMenu(pill, reportSuggestionMenuSections(item, row)); });
    return pill;
  }
  if (reason) {
    const note = reportNode('span', '확인 필요', 'rp-end is-warn');
    note.title = REPORT_REVIEW_TEXT[reason] || REPORT_REVIEW_TEXT.legacy;
    return note;
  }
  return null;
}

// 줄 글자에 손을 올렸을 때의 풍선 — 끝말을 다듬은 줄은 원래 업무 제목(`업무: …`), 미리 채운 할 일 칸 줄은 왜 들어왔는지.
// 왜 들어왔는지는 풍선으로만 알린다(줄에 표시를 늘어놓지 않는다). 업무 제목은 바뀌지 않는다.
// `note`(②)는 지난주에 직접 적은 줄 — 끝났는지 앱이 몰라 빼 둔 채로 들어온다(아직 할 일이면 정리 모드 `다시 넣기`).
const REPORT_CARRY_WHY = { doing: '진행 중이라 들어왔어요', plan: '지난주 계획에 있었는데 아직 안 끝나서 들어왔어요', note: '지난주에 적은 계획이에요 — 끝났는지 몰라 빼 두었어요. 아직 할 일이면 정리에서 다시 넣어요' };
function reportRowTip(row) {
  const first = String(row.text ?? '').split('\n')[0];
  const sources = row.currentEvidence || row.evidence || [];
  const known = row.origin === 'carry' && typeof itemsById !== 'undefined' && itemsById && typeof itemsById.get === 'function' ? itemsById.get(row.planOf) : null;
  const source = sources.length === 1 && ['task', 'bug'].includes(sources[0].type) ? sources[0] : known;
  return [
    source && source.description && source.description !== first ? `업무: ${source.description}` : '',
    REPORT_CARRY_WHY[row.carryWhy] || '',
  ].filter(Boolean).join('\n');
}

// 문장 편집을 시작한다 — 글자를 누르거나(마우스) 초점에서 Enter·Space(키보드).
function reportEditStart(item, row) {
  const key = `${item.weekKey}:${row.id}`;
  reportEdits.set(key, row.text);
  renderReportDraft(item);
  const input = document.getElementById('weeklyReportDetail')?.querySelector(`[data-edit-row="${row.id}"]`);
  if (input) { input.focus(); if (typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length); }
}

// 문장 한 줄. 평소에는 글만 보인다 — 글자가 곧 고치는 자리(초점이 가는 버튼 역할, Enter·Space로도 시작)이고 줄 끝에는
// (있으면) 알약 하나뿐이다(문장 ⋯ 메뉴는 없앴다 — ②). 다듬은 뒤 새로 들어온 줄은 앞 점이 파랗다(`새로 들어옴`).
// 뺀 줄은 지우지 않고 제자리에 흐리게(취소선 없음, 읽어 주는 이름 `보고에서 뺌`), 팔로업으로 묶인 줄은 그 프로젝트 맨 아래 흐리게
// (`팔로업` 꼬리표). 다른 문장 아래로 들어간 문장은 한 단계 들여 쓴 `◦` 줄이다.
// 정리 모드에서는 글머리 자리에 선택 칸이 서고 줄 아무 데나 눌러 고른다 — 글자 고치기는 쉬고, Tab은 선택 칸에만 선다.
function reportSentenceRow(item, row, context) {
  const host = context.host;
  const newIds = context.newIds || new Set();
  const key = `${item.weekKey}:${row.id}`;
  const rows = item.draft.rows || [];
  const parentRow = reportParentRow(rows, row);
  const out = !!row.excluded;
  const followed = reportFollowShown(row);
  const tidy = !!reportTidy && reportMode === 'draft';
  const chosen = tidy && reportTidy.ids.has(row.id);
  const line = reportNode('div', undefined, 'rp-s' + (parentRow ? ' is-sub' : '') + (out ? ' is-dim' : '') + (followed ? ' is-fol' : '')
    + (tidy ? ' is-tidy' : '') + (chosen ? ' is-selected' : ''));
  line.dataset.moveId = `rp:${row.id}`; // 줄 이동 도우미의 열쇠(uiRowsMove)
  if (reportRowReview(item.draft, row)) line.dataset.review = 'true';
  // `확인 필요 ›`로 옮겨 온 줄 — 기존 선택 톤(--sel) 하나.
  const picked = reportReviewPick === row.id && reportMode === 'draft' && !tidy;
  if (picked) line.classList.add('is-hit');
  if (picked && Date.now() < reportHereUntil && typeof uiHere === 'function') uiHere(line);
  const lines = String(row.text ?? '').split('\n');

  // 글머리 — 정리 모드면 선택 칸, 아니면 점. 다듬은 뒤 새로 들어온 줄(기록이 없는 주는 브라우저별 새 기록)은 파란 점이고,
  // 색만으로 말하지 않게 `새로 들어옴` 이름표를 붙인다.
  const fresh = item.draft.since ? !!row.fresh : (row.sourceIds || []).some(id => newIds.has(id));
  if (tidy) {
    const lead = reportNode('span', undefined, 'bu');
    const box = reportNode('input', undefined, 'd-selcb');
    box.type = 'checkbox';
    box.checked = chosen;
    box.dataset.tidyRow = row.id;
    box.setAttribute('aria-label', `줄 고르기: ${lines[0]}${out ? ' (보고에서 뺌)' : followed ? ' (팔로업으로 묶임)' : ''}`);
    box.addEventListener('click', (event) => { event.stopPropagation(); event.preventDefault(); reportTidyToggle(item, row.id, event.shiftKey); });
    lead.appendChild(box);
    line.appendChild(lead);
    line.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('button, input, textarea, a')) return;
      reportTidyToggle(item, row.id, event.shiftKey);
    });
  } else {
    const bullet = reportNode('span', parentRow ? '◦' : '•', 'bu' + (fresh ? ' is-fresh' : ''));
    if (fresh) {
      bullet.setAttribute('role', 'img');
      bullet.setAttribute('aria-label', '새로 들어옴');
      bullet.title = '새로 들어옴';
      line.dataset.since = 'true';
    }
    line.appendChild(bullet);
  }

  const text = reportNode('div', undefined, 'tx');
  line.appendChild(text);

  if (!tidy && reportEdits.has(key)) {
    // 그 자리에서 고친다(v3 — 저장·취소 버튼 없음). Enter·바깥 누르면 저장 · Esc 취소 · Shift+Enter 줄바꿈. 한글 조합 중 Enter는 넘긴다.
    // 저장이 실패해도 적은 글자는 reportEdits에 남는다. 입력칸 아래 안내 줄에 글자 버튼 `보고에서 빼기`(뺀 줄이면 `다시 넣기`)와
    // (손으로 고친 줄이면) `원래 문장으로`가 선다(②, 문장 ⋯ 메뉴 대신). 근거 한 줄은 그 아래 그대로다.
    const input = reportNode('textarea', undefined, 'rp-ta');
    input.value = reportEdits.get(key);
    input.rows = Math.max(1, Math.min(10, input.value.split('\n').length));
    input.maxLength = 10000;
    input.dataset.editRow = row.id;
    input.setAttribute('aria-label', `보고 문장 고치기 — ${REPORT_EDIT_HINT}`);
    input.addEventListener('input', () => reportEdits.set(key, input.value));
    // 탭을 떠나면 Enter와 같은 길로 저장한다(reportAutosaveLeave). 그 저장이 도는 동안 다시 그려진 칸은 잠근다.
    reportLeaveSaver(key, { weekKey: item.weekKey, rowId: row.id, current: row.text, undo: true, save: (fresh, value, options) => reportChange(fresh, { action: 'edit', id: row.id, text: value }, undefined, options) });
    if (reportLeaveSaving.has(key)) input.disabled = true;
    // 바깥을 누르거나 Tab으로 줄 밖으로 나가면 같은 길로 이 칸만 저장하고 닫는다(reportBlurWatch — 아래 도구 줄·근거 줄은 줄 안이다).
    reportBlurWatch(line, input, key);
    const cancel = () => { reportEdits.delete(key); renderReportDraft(item); reportEditFocus(row.id); };
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { if (reportEnterEsc(event, key)) return; event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (event.key !== 'Enter' || event.shiftKey || input.disabled) return;
      event.preventDefault();
      if (reportEnterSaving.has(key)) return;
      if (input.value.trim() === String(row.text ?? '').trim()) { cancel(); return; }
      // 칸은 잠그지 않는다 — 저장하는 동안 이어 친 글자는 칸에 남고, 저장 뒤에도 칸이 그 글로 열려 있다(reportEditsDone).
      reportEnterSaving.add(key);
      reportChange(item, { action: 'edit', id: row.id, text: input.value }, undefined, { typed: input.value, draw: false })
        .then(() => reportEnterDraw(item))
        .then(() => reportEditFocus(row.id))
        .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true))
        .finally(() => { reportEnterSaving.delete(key); });
    });
    text.appendChild(input);
    const help = reportNode('div', undefined, 'rp-help');
    // 글자 버튼을 누르면 적던 글은 저장하지 않고 그 일만 한다(저장하지 않은 글이 몰래 저장되지 않게). 고치기는 그 일이 **성공한 뒤에**
    // 닫는다 — 실패하면(서버 꺼짐·409) 적던 글이 입력칸에 그대로 남는다.
    const helpButton = (label, aria, run) => {
      const button = reportButton(label, async () => {
        if (await run() === false) throw new Error(REPORT_BUSY_TEXT);
        reportEdits.delete(key); renderReportDraft(item); reportEditFocus(row.id);
      }, 'd-link');
      button.setAttribute('aria-label', aria);
      button.addEventListener('mousedown', event => event.preventDefault());
      help.appendChild(button);
    };
    helpButton(out ? '다시 넣기' : '보고에서 빼기', `${lines[0]} — ${out ? '보고에 다시 넣기' : '보고에서 빼기'}`,
      () => reportChange(item, { action: 'setOut', ids: [row.id], out: !out }));
    // 사람이 `+ 한 줄 추가`로 더한 줄(`origin: weekly`)은 그 문장이 곧 원래 문장이라 붙이지 않는다.
    if (row.locked && !row.manual && row.origin !== 'weekly' && row.heading !== REPORT_PLAN_HEADING && (row.sourceIds || []).length) {
      helpButton('원래 문장으로', `${lines[0]} — 원래 문장으로 돌리기`, () => reportChange(item, { action: 'revert', id: row.id }));
    }
    help.appendChild(reportNode('span', `${REPORT_EDIT_HINT} · Shift+Enter 줄바꿈(둘째 줄부터 슬랙에서 부연)`));
    text.appendChild(help);
    const evidence = reportEvidenceLine(row, rows);
    if (evidence) line.appendChild(evidence);
    host.appendChild(line);
    return;
  }

  // 첫 줄이 문장이고, 둘째 줄부터는 부연이다 — 슬랙에서 들여 쓴 작은 글머리로 들어간다.
  const tag = reportOptIn(row) ? REPORT_OPT_IN[row.heading] : followed ? '팔로업' : '';
  if (tag) text.appendChild(reportNode('span', tag, 'tg'));
  const first = reportNode('span', lines[0], tidy ? 'ln' : 'ln rp-edit');
  const tip = reportRowTip(row);
  if (tip) first.title = tip;
  if (!tidy) {
    first.tabIndex = 0;
    first.setAttribute('role', 'button');
    first.setAttribute('aria-label', `문장 고치기: ${lines[0]}${out ? ' (보고에서 뺌)' : ''}`);
    first.dataset.editText = row.id;
    first.addEventListener('click', () => reportEditStart(item, row));
    first.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reportEditStart(item, row); }
    });
  }
  text.appendChild(first);
  if (out) text.appendChild(reportNode('span', ' (보고에서 뺌)', 'sr-only'));
  else if (followed) text.appendChild(reportNode('span', ' (팔로업으로 묶임 — 슬랙 글에는 팔로업 한 줄)', 'sr-only'));
  const ask = context.plan && !tidy ? reportPlanAskNode(item, row) : null;
  if (ask) text.appendChild(ask);
  // 아래로 들어간 문장의 프로젝트가 부모와 다르면 그 이름을 조용히 적는다(문서에서만 — 슬랙에는 안 나간다).
  if (parentRow && reportRowGroup(row) !== reportRowGroup(parentRow)) {
    text.appendChild(reportNode('span', `· ${reportProjectText(reportRowGroup(row))}`, 'pj'));
  }
  // 접힌 부모는 문장 뒤에 꺾쇠 + `· N건` 버튼이 붙는다 — 누르면 아래 문장이 화면에서만(저장 안 함) 흐린 글자로 펼쳐 보인다.
  // 정리 모드에서도 눌러 펼칠 수 있지만 Tab은 선택 칸에만 서도록 초점 차례에서는 뺀다.
  const childCount = rows.filter(entry => entry.parent === row.id).length;
  if (row.folded && childCount) {
    const peek = reportFoldOpen.has(row.id);
    // 펼침 표시는 앱의 꺾쇠(uiIcon) — 접힘은 오른쪽, 펼쳐 보면 90° 돌아 아래를 본다(CSS가 aria-expanded로 돌린다).
    const toggle = reportNode('button', undefined, 'rp-foldtoggle');
    toggle.type = 'button';
    toggle.innerHTML = uiIcon('chevron');
    toggle.appendChild(reportNode('span', `· ${childCount}건`));
    toggle.setAttribute('aria-label', `아래 문장 ${childCount}개 보기`);
    toggle.setAttribute('aria-expanded', String(peek));
    uiFoldKey(toggle, `rp-fold:${row.id}`); // 누르면 문서를 다시 그려 새 꺾쇠가 된다 — 옛 각도에서 돈다(펼침 부품)
    if (tidy) toggle.tabIndex = -1;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (peek) reportFoldOpen.delete(row.id); else reportFoldOpen.add(row.id);
      renderReportDraft(item);
    });
    text.appendChild(toggle);
  }
  if (lines.length > 1) {
    const sub = reportNode('div', lines.slice(1).join('\n'), 'sub');
    if (!tidy) sub.addEventListener('click', () => reportEditStart(item, row));
    text.appendChild(sub);
  }

  // 줄 끝: (있으면) 알약 하나 — 정리 모드에서는 쉰다(Tab이 선택 칸에만 서게).
  if (!tidy) {
    const pill = reportRowPill(item, row);
    if (pill) line.appendChild(pill);
  }
  if (picked) {
    const evidence = reportEvidenceLine(row, rows);
    if (evidence) line.appendChild(evidence);
  }
  host.appendChild(line);
}

// 저장·취소 뒤 그 문장의 글자로 초점을 돌려놓는다(키보드로 이어서 고치기).
function reportEditFocus(rowId) {
  const host = document.getElementById('weeklyReportDetail');
  if (!host || typeof host.querySelector !== 'function') return;
  (host.querySelector(`[data-edit-row="${rowId}"]`) || host.querySelector(`[data-edit-text="${rowId}"]`))?.focus();
}

// 칸 이름(`[완료]`·`[진행 예정]`) — 글자가 곧 고치는 자리이고, 고치면 이 브라우저에 기억해 다음 주에도 같은 이름으로 나온다
// (reportColumnSave). 서버에는 아무것도 보내지 않는다. 비우고 저장하면 기본 이름으로 돌아간다.
const reportColumnEditKey = (weekKey, key) => `${weekKey}:col:${key}`;
function reportColumnHead(item, key) {
  const names = reportColumnNames();
  const editKey = reportColumnEditKey(item.weekKey, key);
  const head = reportNode('h3', undefined, 'rp-h rp-col');
  head.dataset.moveId = `grp:col:${key}`; // 줄 이동 도우미의 열쇠 — 칸 제목도 문장과 함께 미끄러진다
  if (reportEdits.has(editKey)) {
    head.appendChild(reportRenameBox(item, {
      editKey, label: '칸 이름', original: REPORT_COLUMN_DEFAULT[key], current: names[key], hint: '다음 주에도 이 이름으로 나와요', local: true,
      save: async (value, target = item, options) => {
        reportColumnSave(key, value);
        reportEdits.delete(editKey);
        if (!options || options.draw !== false) renderReportDraft(target);
      },
    }));
  } else {
    head.appendChild(reportRenameButton(item, { editKey, text: names[key], label: `칸 이름 ${names[key]} — 고치기`, current: names[key], tip: '누르면 칸 이름을 고쳐요' }));
  }
  return head;
}

// 한 일 칸의 프로젝트 소제목. 색 점 + 이름 글자 + 자동 괄호(`.pa`, 조용한 글자)이고, 글자가 곧 이름 바꾸기 자리다(`rename`,
// `완료한 일|프로젝트 열쇠`에 묶인다 — 서버가 옛 `진행중|열쇠` 이름도 읽는다). 괄호까지 한 글자처럼 고치고, 사람이 고친 이름이 이긴다
// (그 뒤 괄호는 붙지 않는다). 자동 글자(`이름 (괄호)`)나 원래 이름 그대로 저장하면 원래대로(빈 값)다. 원래 프로젝트 이름은
// 손을 올렸을 때의 풍선만. 서버가 열쇠를 주지 않은 옛 응답이면 예전처럼 이름 글자만 선다.
function reportGroupHead(item, group, name) {
  const head = reportNode('div', undefined, 'rp-pj');
  head.dataset.moveId = `grp:done:${group.key || group.group || ''}`; // 줄 이동 도우미의 열쇠 — 소제목도 문장과 함께 미끄러진다
  const title = reportProjectTitle(item.draft, group, name);
  if (!group.key) { head.appendChild(reportNode('span', title.text, 'nm')); return head; }
  const editKey = reportNameEditKey(item.weekKey, REPORT_DONE_HEADING, group.key);
  const original = reportProjectText(group.origin || group.group);
  // 사람이 고친 이름을 지웠을 때 서게 될 자동 글자 — 이것과 같게 적으면 원래대로 돌린다.
  const plainParen = reportProjectParen(item.draft, { ...group, origin: null });
  const auto = plainParen ? `${original} ${plainParen}` : original;
  if (typeof uiProjectDot === 'function' && /^(jira|group):/.test(group.key)) head.appendChild(uiProjectDot(group.key));
  if (reportEdits.has(editKey)) {
    head.appendChild(reportRenameBox(item, {
      editKey, label: '소제목 이름', original: auto, current: title.text, hint: '보고에서만 바뀌어요 — 업무의 프로젝트 이름은 그대로예요',
      save: (value, target = item, options) => reportChange(target, { action: 'rename', heading: REPORT_DONE_HEADING, groupKey: group.key, text: value === auto ? '' : value }, undefined, options),
    }));
    return head;
  }
  const tip = group.origin ? `원래 프로젝트: ${original} · 누르면 이름을 고쳐요` : '누르면 소제목을 고쳐요';
  const button = reportRenameButton(item, { editKey, text: title.name, label: group.origin ? `소제목 ${title.text}(원래 프로젝트 ${original}) — 이름 고치기` : `소제목 ${title.text} — 이름 고치기`, current: title.text, tip });
  if (title.paren) button.appendChild(reportNode('span', title.paren, 'pa'));
  head.appendChild(button);
  return head;
}

// ---------- 칸마다 `+ 한 줄 추가`(다듬기 B) ----------
// 완료한 일·진행 중 칸의 소제목(프로젝트) 묶음 맨 아래 조용한 한 줄. 글자를 누르면 문장 고치기와 같은 입력칸(`.rp-ta`)이 되고
// Enter로 더한다 — 보고에는 적은 문장 그대로 한 줄, 같은 프로젝트(묶음이면 대표 티켓)에 업무도 하나(완료한 일 칸이면 이 주에
// 끝낸 업무, 진행 중 칸이면 진행 중 업무). 결정·확인·다음 주 계획 칸에는 없다(만들 업무의 종류가 애매하다). 진행 중 칸은
// 이번 주만(지난 주에 진행 중 업무를 만들면 그 주 기록이 아니다), 프로젝트 열쇠가 없는 소제목(여러 프로젝트 요약 등)에도 없다.
const reportAddLineKey = (weekKey, heading, key) => `${weekKey}:addline:${heading}|${key}`;
// 적던 줄 → 요청 id. 같은 글을 다시 보내면(응답을 못 받아 다시 누름) 같은 id라 서버가 업무를 한 번만 만든다.
const reportAddLineIds = new Map();
function reportCanAddLine(item, group) {
  if (!group || typeof group.key !== 'string' || !/^(jira:.+|group:.+)$/.test(group.key)) return false;
  return reportMode === 'draft' && reportTidy === null;
}
// 입력칸 아래 한 줄 — 무엇이 함께 생기는지 미리 말한다.
function reportAddLineHint(item, heading, title) {
  const what = heading === '진행중' ? '진행 중인 업무로도 남아요'
    : reportPlanIsCurrentWeek(item.weekKey) ? '이번 주에 끝낸 업무로도 남아요' : '그 주 금요일에 끝낸 업무로도 남아요';
  return `Enter 추가 · ${what} (${title})`;
}
function reportAddLineFocus(editKey) {
  const host = document.getElementById('weeklyReportDetail');
  if (!host || typeof host.querySelectorAll !== 'function') return;
  const find = attr => [...host.querySelectorAll(`[${attr}]`)].find(el => (attr === 'data-addline' ? el.dataset.addline : el.dataset.addlineInput) === editKey);
  (find('data-addline-input') || find('data-addline'))?.focus();
}
// 요청 id — `crypto.randomUUID`는 보안 연결(localhost·https)에서만 있어 휴대폰의 http://IP 접속에서는 없다. 그때는 시간 +
// 무작위 글자로 짓는다(서버가 받는 모양 `[a-zA-Z0-9-]{16,100}`).
function reportRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const part = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${Date.now().toString(36)}-${part()}-${part()}`;
}
// `extra`는 reportChange에 넘길 칸 정보(Enter 때의 글 `typed`·`draw`) — 입력칸이 Enter로 부를 때만.
async function reportAddLineSubmit(item, heading, group, editKey, text, extra = {}) {
  const memo = `${editKey}|${text}`;
  if (!reportAddLineIds.has(memo)) reportAddLineIds.set(memo, reportRequestId());
  let done;
  try {
    done = await reportChange(item, { action: 'addLine', heading, groupKey: group.key, text }, undefined, { ...extra, key: reportAddLineIds.get(memo) });
  } catch (error) {
    // 같은 id의 앞 요청은 이미 저장됐는데(응답만 잃음) 그 뒤 보고가 바뀌어 본문이 달라진 경우 — 서버가 같은 id를 다른 내용으로
    // 받지 않는다. 이미 더해진 것이므로 id와 적던 글을 버리고 최신 보고를 받아 온다(다시 보내면 같은 줄이 두 번 생긴다).
    if (/다른 내용으로 같은 요청/.test(String(error && error.message))) {
      reportAddLineIds.delete(memo);
      reportEdits.delete(editKey);
      if (typeof load === 'function') await Promise.resolve(load()).catch(() => {});
      throw new Error('이미 더해 둔 줄이에요. 최신 보고를 불러왔어요.');
    }
    throw error;
  }
  reportAddLineIds.delete(memo);
  return done;
}
function reportAddLineRow(item, heading, group, title, host) {
  const editKey = reportAddLineKey(item.weekKey, heading, group.key);
  const line = reportNode('div', undefined, 'rp-s is-add' + (reportEdits.has(editKey) ? ' is-open' : ''));
  const mark = reportNode('span', '+', 'bu');
  mark.setAttribute('aria-hidden', 'true');
  line.appendChild(mark);
  const box = reportNode('div', undefined, 'tx');
  line.appendChild(box);
  host.appendChild(line);
  if (!reportEdits.has(editKey)) {
    const open = reportNode('button', '한 줄 추가', 'rp-pjadd');
    open.type = 'button';
    open.dataset.addline = editKey;
    open.setAttribute('aria-label', `${reportHeadingText(heading)} · ${title}에 한 줄 추가`);
    open.addEventListener('click', () => {
      reportEdits.set(editKey, '');
      renderReportDraft(item);
      reportAddLineFocus(editKey);
    });
    box.appendChild(open);
    return line;
  }
  // 한 줄 입력(업무 제목이 되므로 줄바꿈은 받지 않는다 — 붙여 넣은 줄바꿈은 빈칸으로). 한글 조합 중 Enter는 넘긴다.
  // 빈 채로 Enter는 아무 일도 하지 않는다. 저장이 실패해도 적은 글은 reportEdits에 남는다.
  const input = reportNode('textarea', undefined, 'rp-ta');
  input.rows = 1;
  input.maxLength = 1000;
  input.value = reportEdits.get(editKey) || '';
  input.dataset.addlineInput = editKey;
  input.setAttribute('aria-label', `${reportHeadingText(heading)} · ${title}에 더할 문장 — Enter 추가 · Esc 취소`);
  input.addEventListener('input', () => {
    if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');
    reportEdits.set(editKey, input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      if (reportEnterEsc(event, editKey)) return;
      event.preventDefault(); event.stopPropagation();
      reportEdits.delete(editKey); renderReportDraft(item); reportAddLineFocus(editKey);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text || reportEnterSaving.has(editKey)) return;
    // 칸은 잠그지 않는다 — 저장하는 동안 이어 친 글자는 칸에 남는다(보낸 글 뒤에 친 것만 — reportEditsDone).
    reportEnterSaving.add(editKey);
    const typed = input.value;
    reportAddLineSubmit(item, heading, group, editKey, text, { typed, draw: false })
      .then(done => reportEnterDraw(item, done === false ? null : () => reportEditsDone(editKey, { typed }, true)))
      .then(() => reportAddLineFocus(editKey))
      .catch(error => showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true))
      .finally(() => { reportEnterSaving.delete(editKey); });
  });
  box.appendChild(input);
  box.appendChild(reportNode('div', reportAddLineHint(item, heading, title), 'rp-help'));
  return line;
}

// 지라는 `KEY · 요약`으로 적되, 서버가 받는 60자를 넘으면 키만 쓴다.
const REPORT_PLAN_NAME_MAX = 60;
function reportPlanJiraName(key, summary) {
  const full = [key, summary].filter(Boolean).join(' · ');
  return full.length > REPORT_PLAN_NAME_MAX ? key : full;
}

function reportPlanProjectNames() {
  const groups = typeof customGroupsCache !== 'undefined' ? [...customGroupsCache] : [];
  const jira = typeof jiraIssuesCache !== 'undefined' ? jiraIssuesCache.map(issue => reportPlanJiraName(issue.key, issue.summary)) : [];
  const names = [];
  for (const name of [...groups, ...jira]) {
    if (name && name.length <= REPORT_PLAN_NAME_MAX && !names.includes(name)) names.push(name);
  }
  return names;
}

// ---------- 할 일 칸(다음 주 계획): 미리 채운 줄 · 적기 ----------
// 서버가 진행 중 업무와 지난주 계획 중 안 끝난 것을 미리 채워 두고(덜어 내는 것은 사람), 그 밖은 사람이 적는다 —
// 프로젝트마다 `할 일 적기` + 맨 아래 `한 줄 적기 (휴가 · 이슈)`. 적은 줄은 **보고에만** 들어가고, 프로젝트 아래 줄에만
// 작은 질문 `나중에 할 일에도 담을까요? 담기`가 붙는다(누르면 기존 `/api/later-task/create`로 업무를 만들고 그 id를 planOf로 잇는다).

const REPORT_PLAN_MAX_LINES = 20;        // 여러 줄 붙여넣기의 상한
const REPORT_PLAN_BOTTOM_KEY = 'new';    // 맨 아래 입력줄의 `reportEdits` 열쇠(기존 값 그대로)
const REPORT_PLAN_ASK_IDLE_MS = 4000;    // 질문이 조용히 숨기까지(손을 올리거나 초점이 오면 다시 보인다)
// 이 창에서 방금 적은 할 일 칸 줄 id → { taskId, idle }. 화면 상태일 뿐 저장하지 않는다(다시 열면 질문은 없다).
const reportPlanAsk = new Map();

// 이번 주 보고인지 — 할 일 칸 미리 채우기·입력줄·질문, 자동 괄호, `다음 주 계획` 머리 버튼은 이번 주에만 선다.
function reportPlanIsCurrentWeek(weekKey) {
  if (typeof todayStr !== 'function') return false;
  const monday = new Date(`${todayStr()}T12:00:00`);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  return key === weekKey;
}

// 프로젝트 이름 → 업무를 만들 때 보낼 값. 지라 이름(`KEY · 요약`)은 지라 키로 되돌린다.
function reportPlanJiraKeyOf(name) {
  const value = String(name || '').trim();
  const match = REPORT_JIRA_LABEL.exec(value);
  if (match) return match[1];
  if (!value || typeof jiraIssuesCache === 'undefined' || !Array.isArray(jiraIssuesCache)) return null;
  const issue = jiraIssuesCache.find(entry => reportPlanJiraName(entry.key, entry.summary) === value || entry.key === value);
  return issue ? issue.key : null;
}

// 줄 앞의 `프로젝트 이름: ` 접두는 기존 프로젝트 이름과 **정확히 같을 때만** 그 프로젝트로 보낸다.
function reportPlanSplitPrefix(line, names, fallback) {
  const at = String(line).indexOf(':');
  if (at > 0) {
    const name = line.slice(0, at).trim();
    const rest = line.slice(at + 1).trim();
    if (rest && names.includes(name)) return { text: rest, group: name };
  }
  return { text: String(line).trim(), group: fallback };
}

// 붙여넣은 여러 줄을 한 줄 = 한 문장으로 나눈다(빈 줄 무시, 최대 20줄).
function reportPlanLines(value) {
  return String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, REPORT_PLAN_MAX_LINES);
}

// 같은 글·같은 프로젝트로 `나중에 할 일` 업무를 만든다 — 기존 길(`/api/later-task/create`)이고
// 기한·우선순위는 넣지 않는다(마감일은 사람이 말한 날짜만 — DECISIONS).
async function reportPlanCreateTask(text, group) {
  const payload = { description: text };
  const jira = reportPlanJiraKeyOf(group);
  if (jira) payload.jira = jira;
  else if (group) payload.group = group;
  const response = await request('/api/later-task/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const created = await response.json();
  return created && typeof created.id === 'string' ? created.id : null;
}

// 한 줄을 할 일 칸에 적는다(서버 add — 보고에만, 업무는 만들지 않는다). 프로젝트 아래 줄이면 새로 생긴 줄에 질문을 단다.
async function reportPlanAddOne(item, { text, group }, draw = true) {
  const before = new Set(((item.draft && item.draft.rows) || []).map(row => row.id));
  if (await reportChange(item, { action: 'add', text, group: group || undefined }, '할 일 칸에 적었어요', { draw }) === false) {
    throw new Error('다른 저장이 끝나지 않아 적지 못했어요. 적은 내용은 그대로 있어요');
  }
  if (!group) return;
  const made = ((item.draft && item.draft.rows) || []).find(row => !before.has(row.id) && row.heading === REPORT_PLAN_HEADING);
  if (made) { reportPlanAsk.set(made.id, { taskId: null, idle: false }); reportPlanAskIdle(made.id); }
}

// 여러 줄을 차례로 적는다. 중간에 실패하면 거기서 멈추고 남은 줄을 입력칸에 되돌려 놓는다(false — 다 적으면 true).
// `taken`: 입력칸을 들고 있는 쪽이 보낼 글을 이미 칸에서 꺼냈다(Enter·붙여넣기) — 적는 동안 새로 친 글은 건드리지 않는다.
// 초점은 입력줄에 남는다(이어서 적게).
async function reportPlanAddLines(item, lines, { key, group, focusId, taken = false }) {
  const names = reportPlanProjectNames();
  const full = `${item.weekKey}:${key}`;
  // 줄을 적을 때마다 문서가 다시 그려진다(reportChange) — 초점이 빠졌으면 곧바로 새 칸으로 돌려
  // 그 사이 치는 글자가 빈 화면으로 새지 않게 한다(다른 칸으로 옮겨 가 있으면 뺏지 않는다).
  const refocus = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected !== false) return;
    document.getElementById(focusId)?.focus();
  };
  if (!taken) reportEdits.delete(full);
  for (let index = 0; index < lines.length; index += 1) {
    const line = reportPlanSplitPrefix(lines[index], names, group);
    try {
      // 한 줄이면 아래 끝의 그리기 한 번으로 — 그 그리기에서 새 줄만 나타난다(빠른 추가 — uiGlideAddMark).
      await reportPlanAddOne(item, { text: line.text, group: line.group }, lines.length > 1);
      refocus();
    } catch (error) {
      const rest = lines.slice(index).join('\n');
      // 그 사이 칸에 새 글을 치고 있으면 덮어쓰지 않고, 어떤 글이 안 됐는지만 알린다.
      const busy = !!String(reportEdits.get(full) || '').trim();
      if (!busy) reportEdits.set(full, rest);
      renderReportDraft(item);
      document.getElementById(focusId)?.focus();
      if (busy) uiUnsavedNotice(rest, `report:${full}`);
      else showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true);
      return false;
    }
  }
  // 성공한 뒤 늦게 비우지 않는다 — 적는 동안 새로 친 글(reportEdits)은 그대로 다시 그려진다.
  renderReportDraft(item);
  document.getElementById(focusId)?.focus();
  return true;
}

// 할 일 칸 입력칸 한 벌 — 프로젝트마다의 `할 일 적기`와 맨 아래 `한 줄 적기`가 같은 길을 쓴다(빠른 추가 부품 `.rp-add`).
// 평소에는 한 줄 입력이고, 여러 줄 붙여넣기가 중간에 실패해 남은 줄을 돌려놓을 때만 여러 줄 칸이 된다.
function reportPlanInput(item, { key, id, placeholder, label, groupOf }) {
  const full = `${item.weekKey}:${key}`;
  const draft = reportEdits.get(full) || '';
  const multi = draft.includes('\n');
  const el = reportNode(multi ? 'textarea' : 'input', undefined, multi ? 'rp-addmulti' : '');
  if (!multi) el.type = 'text';
  else el.rows = Math.min(6, draft.split('\n').length);
  el.id = id;
  el.placeholder = placeholder;
  el.setAttribute('aria-label', label);
  el.autocomplete = 'off';
  el.value = draft;
  el.maxLength = 10000;
  el.addEventListener('input', () => {
    if (el.value) reportEdits.set(full, el.value); else reportEdits.delete(full);
  });
  // 칸은 잠그지 않는다(잠긴 칸에 친 글자는 브라우저가 버린다) — 보낼 글을 꺼내 칸을 바로 비우고,
  // 같은 칸의 저장은 대기열로 하나씩 순서대로 적는다(오늘 목록 입력칸과 같은 uiQueueSend).
  const send = (lines) => {
    const opts = { key, group: groupOf(), focusId: id, taken: true };
    return uiQueueSend(`report:${full}`, () => reportPlanAddLines(item, lines, opts))
      .catch(error => showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true));
  };
  // 탭을 떠나면 Enter와 같은 길로 적는다(reportAutosaveLeave) — 보고에만 들어가고 업무는 만들지 않는다. 글을 칸에서 꺼내 보내고,
  // 실패하면 reportPlanAddLines가 남은 줄을 칸에 되돌린다(false). 글을 칸에서 꺼내는 것(take)은 저장 고리가 다시 그리기 전에 한다.
  reportLeaveSaver(full, { weekKey: item.weekKey, current: '', undo: true, take: true, save: (fresh, value) =>
    uiQueueSend(`report:${full}`, () => reportPlanAddLines(fresh, reportPlanLines(value), { key, group: groupOf(), focusId: id, taken: true })) });
  const submit = () => {
    const lines = reportPlanLines(el.value);
    if (!lines.length) return;
    el.value = '';
    reportEdits.delete(full);
    return send(lines);
  };
  el.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape' && !event.isComposing && el.value) {
      event.stopPropagation();
      el.value = '';
      reportEdits.delete(full);
      return;
    }
    // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이지 추가가 아니다.
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (typeof uiGlideAddMark === 'function') uiGlideAddMark(el, event); // 빠른 추가 — 적은 뒤 다시 그리기에서 새 줄만 나타난다
    await submit();
  });
  // 한 줄 붙여넣기는 평소대로 — 줄바꿈이 있을 때만 가로채서 한 줄 = 한 문장으로 차례로 적는다.
  el.addEventListener('paste', (event) => {
    const pasted = event.clipboardData && typeof event.clipboardData.getData === 'function'
      ? event.clipboardData.getData('text') : '';
    if (!/[\r\n]/.test(String(pasted))) return;
    event.preventDefault();
    const lines = reportPlanLines(pasted);
    if (!lines.length) return;
    // 붙여넣은 줄은 칸에 들어가지 않는다 — 칸에 적던 글은 그대로 두고 붙여넣은 줄만 적는다.
    send(lines);
  });
  return el;
}

// 입력줄 한 줄(`+` 아이콘 + 칸). `name`이 있으면 그 프로젝트의 `할 일 적기`, 없으면 맨 아래 `한 줄 적기`.
function reportPlanAddRow(item, name, title) {
  const row = reportNode('div', undefined, 'rp-add' + (name ? ' is-group' : ''));
  row.dataset.moveId = `add:${name || ''}`; // 줄 이동 도우미의 열쇠 — 입력줄도 문장과 함께 미끄러진다
  row.innerHTML = uiIcon('plus');
  const input = name
    ? reportPlanInput(item, { key: `plan-add:${name}`, id: `reportPlanAdd-${encodeURIComponent(name)}`, placeholder: '할 일 적기', label: `${title}에 할 일 적기`, groupOf: () => name })
    : reportPlanInput(item, { key: REPORT_PLAN_BOTTOM_KEY, id: 'reportPlanInput', placeholder: '한 줄 적기 (휴가 · 이슈)', label: '할 일 칸에 한 줄 적기 (휴가 · 이슈)', groupOf: () => '' });
  if (String(input.className).includes('rp-addmulti')) row.className += ' is-multi';
  row.appendChild(input);
  return row;
}

// 할 일 칸 프로젝트 소제목 — 한 일 칸 소제목과 같은 표기(색 점 + 이름, 파일 표기 밑줄은 빈칸으로).
function reportPlanProjectHead(name, source) {
  const head = reportNode('div', undefined, 'rp-pj');
  head.dataset.moveId = `grp:plan:${source || name || ''}`; // 줄 이동 도우미의 열쇠
  if (source && typeof uiProjectDot === 'function') head.appendChild(uiProjectDot(reportProjectColorKey(source)));
  head.appendChild(reportNode('span', name, 'nm'));
  return head;
}

// ---------- `나중에 할 일에도 담을까요? 담기` ----------
// 프로젝트 아래에 방금 적은 줄에만 작은 질문이 붙는다. `담기` → 기존 `/api/later-task/create`(같은 글·같은 프로젝트, 기한 없음)로
// 업무를 만들고 그 id를 그 줄의 planOf로 잇는다(서버 link — 다음 주 미리 채우기가 이 연결을 본다). 누르면 `담았어요 · 되돌리기`,
// 되돌리기는 만든 업무를 지운 항목(설정 › 삭제한 항목)으로 보내고 연결을 끊는다. 몇 초 뒤 질문은 숨고 손을 올리면 다시 보인다.
function reportPlanAskIdle(rowId) {
  setTimeout(() => {
    const entry = reportPlanAsk.get(rowId);
    if (!entry) return;
    entry.idle = true;
    const host = document.getElementById('weeklyReportDetail');
    const el = host && typeof host.querySelector === 'function' ? host.querySelector(`[data-plan-ask="${rowId}"]`) : null;
    if (el && !el.contains(document.activeElement)) el.classList.add('is-idle');
  }, REPORT_PLAN_ASK_IDLE_MS);
}
function reportPlanAskFocus(rowId) {
  const host = document.getElementById('weeklyReportDetail');
  host?.querySelector?.(`[data-plan-ask="${rowId}"] button`)?.focus();
}
// 업무와 보고 저장은 두 요청이다 — 보고 저장(link)이 실패하거나(409·서버 꺼짐) 다른 저장이 도는 중이라 건너뛰면, 방금 한
// 업무 일을 되돌려 둘이 어긋나지 않게 한다(고아 업무·지워진 업무를 가리키는 줄이 남지 않게). 성공 여부는 저장 뒤 그 줄의 planOf로 본다.
const reportPlanLinked = (item, rowId, taskId) => {
  const now = ((item.draft && item.draft.rows) || []).find(entry => entry.id === rowId);
  return !!now && (taskId ? now.planOf === taskId : !now.planOf);
};
const reportPlanRemoveTask = id => request('/api/track/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
async function reportPlanTake(item, row) {
  const entry = reportPlanAsk.get(row.id);
  if (!entry || reportBusy) return;
  const taskId = await reportPlanCreateTask(String(row.text || '').split('\n')[0], row.group);
  if (!taskId) throw new Error('나중에 할 일을 만들지 못했어요. 보고 줄은 그대로 있어요');
  let failure = null;
  try { await reportChange(item, { action: 'link', id: row.id, planOf: taskId }, '나중에 할 일에도 담았어요'); } catch (error) { failure = error; }
  if (failure || !reportPlanLinked(item, row.id, taskId)) {
    // 잇지 못했으면 방금 만든 업무를 지운다(지운 항목에 남는다).
    await reportPlanRemoveTask(taskId).catch(() => {});
    if (typeof load === 'function') Promise.resolve(load()).catch(() => {});
    throw failure || new Error('저장이 끝나지 않아 담지 못했어요. 다시 눌러 주세요');
  }
  entry.taskId = taskId;
  entry.idle = false;
  reportPlanAskIdle(row.id);
  reportPlanAskFocus(row.id);
  if (typeof load === 'function') Promise.resolve(load()).catch(() => {});
}
// 되돌리기는 차례를 뒤집는다 — 먼저 연결을 끊고(보고 저장), 그게 된 뒤에 업무를 지운다. 업무 지우기가 실패하면 연결을 다시 잇는다.
async function reportPlanUntake(item, row) {
  const entry = reportPlanAsk.get(row.id);
  if (!entry || !entry.taskId || reportBusy) return;
  const taskId = entry.taskId;
  await reportChange(item, { action: 'link', id: row.id, planOf: null }, '나중에 할 일에서 뺐어요');
  if (!reportPlanLinked(item, row.id, null)) throw new Error('저장이 끝나지 않아 되돌리지 못했어요. 다시 눌러 주세요');
  try { await reportPlanRemoveTask(taskId); } catch (error) {
    await reportChange(item, { action: 'link', id: row.id, planOf: taskId }).catch(() => {});
    throw error;
  }
  entry.taskId = null;
  reportPlanAskFocus(row.id);
  if (typeof load === 'function') Promise.resolve(load()).catch(() => {});
}
// 질문 한 줄 — 줄 글 뒤의 작은 글자(`.rp-ask`) + 글자 버튼(`.d-link`). 담았으면 `담았어요 · 되돌리기`.
function reportPlanAskNode(item, row) {
  const entry = reportPlanAsk.get(row.id);
  if (!entry || row.heading !== REPORT_PLAN_HEADING || row.excluded || !reportPlanIsCurrentWeek(item.weekKey)) return null;
  const taken = !!entry.taskId && row.planOf === entry.taskId;
  const ask = reportNode('span', taken ? '담았어요 · ' : '나중에 할 일에도 담을까요? ', 'rp-ask' + (entry.idle ? ' is-idle' : ''));
  ask.dataset.planAsk = row.id;
  const button = reportButton(taken ? '되돌리기' : '담기', () => (taken ? reportPlanUntake(item, row) : reportPlanTake(item, row)), 'd-link');
  button.setAttribute('aria-label', taken ? `${row.text} — 나중에 할 일에서 빼기` : `${row.text} — 나중에 할 일에도 담기`);
  ask.appendChild(button);
  return ask;
}

// 한 일 칸 프로젝트 → 할 일 칸에 설 프로젝트 이름(저장된 이름 그대로 — 미리 채운 줄과 같은 이름 규칙). 프로젝트 열쇠가 있는 것만.
function reportPlanDoneProjects(rows) {
  return reportDoneGroups(rows).groups
    .filter(group => group.key && /^(jira|group):/.test(group.key) && group.source)
    .map(group => String(group.source).trim())
    .filter((name, index, list) => name && list.indexOf(name) === index);
}

// 할 일 칸 — 문서의 마지막 칸. 프로젝트 소제목(이번 주는 한 일 칸 프로젝트도 함께, 적을 자리로) 아래 줄 + `할 일 적기`,
// 프로젝트 없는 줄은 칸 끝(소제목 없이) + 맨 아래 `한 줄 적기`. 지난 주는 저장된 줄만(입력줄·질문 없음).
function reportPlanSection(item, host, newIds) {
  const rows = reportPlanRows(item.draft.rows);
  const current = reportPlanIsCurrentWeek(item.weekKey);
  host.appendChild(reportColumnHead(item, 'plan'));
  const groups = reportPlanGroups(rows);
  const named = groups.filter(group => group.name);
  const loose = groups.find(group => !group.name);
  if (current) {
    // 한 일 칸 차례대로 서고, 그 뒤에 할 일 칸에만 있는 프로젝트.
    const order = reportPlanDoneProjects(item.draft.rows);
    for (const name of order) if (!named.some(group => group.name === name)) named.push({ name, rows: [] });
    named.sort((a, b) => (order.includes(a.name) ? order.indexOf(a.name) : order.length) - (order.includes(b.name) ? order.indexOf(b.name) : order.length));
  }
  const titles = reportGroupTitles(named.map(group => group.name));
  for (const group of named) {
    const title = group.etc ? REPORT_ETC : REPORT_JIRA_LABEL.test(group.name) ? titles.get(group.name) : reportPlanShownName(titles.get(group.name));
    // `기타`는 점·`할 일 적기`가 없다(적은 줄이 그 이름의 프로젝트로 담기지 않게).
    host.appendChild(reportPlanProjectHead(title, group.etc ? null : group.name));
    for (const row of group.rows) {
      if (reportRowHiddenByFold(item.draft.rows, row)) continue;
      reportSentenceRow(item, row, { host, newIds, plan: true });
    }
    if (current && !group.etc && !reportTidy) host.appendChild(reportPlanAddRow(item, group.name, title));
  }
  if (loose || current) host.appendChild(reportNode('div', undefined, 'rp-sep'));
  for (const row of loose ? loose.rows : []) {
    if (reportRowHiddenByFold(item.draft.rows, row)) continue;
    reportSentenceRow(item, row, { host, newIds, plan: true });
  }
  if (current && !reportTidy) host.appendChild(reportPlanAddRow(item, null));
  else if (!current && !rows.length) host.appendChild(reportNode('div', '적은 할 일이 없어요.', 'rp-hint'));
}

// 전체 업무 기록을 프로젝트로 묶는다(순수 함수). 프로젝트 차례는 보고 문서와 같게 — 기록이 문장에
// 처음 나온 순서를 그대로 쓴다 — 두고, `프로젝트 없음`만 맨 아래로 내린다. 같은 기록이 여러 문장에
// 걸려 있으면 한 번만 세고, 그 기록이 마지막으로 붙은 문장(복원할 대상)을 함께 들고 간다.
function reportRecordGroups(rows) {
  const records = new Map();
  for (const row of rows || []) {
    for (const source of [...(row.evidence || []), ...(row.suggestion?.evidence || [])]) {
      records.set(source.id, { source, row });
    }
  }
  const groups = new Map();
  for (const entry of records.values()) {
    const label = String(entry.source.label || '').trim();
    const name = !label || label === REPORT_NO_PROJECT_LABEL ? REPORT_NO_PROJECT : label;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(entry);
  }
  const names = [...groups.keys()].filter(name => name !== REPORT_NO_PROJECT);
  if (groups.has(REPORT_NO_PROJECT)) names.push(REPORT_NO_PROJECT);
  return names.map(name => ({ name, entries: groups.get(name) }));
}

// 전체 업무 기록 줄의 ⋯ — 맨 위 `보고에서 제외`/`보고에 복원` + 그 업무 종류의 기존 메뉴.
// source는 보고가 들고 있는 요약 값(id·문구·상태·종류)뿐이라, 메뉴에 쓸 값은 앱의 전체 목록에서 다시 찾는다
// (panelOpen이 상세를 열 때 쓰는 것과 같은 길 — panelResolve). 찾지 못하면(이미 사라진 항목 등) 제외/복원만 남긴다.
function reportRecordMenuSections(item, source, row, card) {
  const toggle = [{
    label: row.excluded ? '보고에 복원' : '보고에서 제외',
    onClick: () => reportChange(item, { action: 'exclude', id: row.id }),
  }];
  const resolved = typeof panelResolve === 'function' ? panelResolve(source.id) : null;
  if (!resolved) return [toggle];
  const base = source.type === 'check' ? waitingMenuSections(resolved.item, card)
    : source.type === 'decision' ? decisionMenuSections(resolved.item, card)
    : taskMenuSections({ item: resolved.item, mode: panelMode(resolved.item), card });
  return [toggle, ...base];
}

// `전체 업무 기록` — 이번 주에 연결된 업무를 프로젝트로 묶은 조용한 목록. 줄을 누르면 상세가 열린다.
// 오른쪽에는 기본값이 아닌 것만 적는다(`완료`·`보고에서 제외됨`) — `미완료`·`보고에 포함`은 찍지 않는다.
function reportRecordsView(item, host) {
  const groups = reportRecordGroups(item.draft.rows);
  if (!groups.length) {
    host.appendChild(reportNode('div', '이번 주에 연결된 업무 기록이 없어요.', 'rp-hint'));
    return;
  }
  const list = reportNode('div', undefined, 'rp-recs');
  const titles = reportGroupTitles(groups.map(group => group.name));
  for (const group of groups) {
    list.appendChild(uiGroupHeading(titles.get(group.name), group.entries.length,
      group.name === REPORT_NO_PROJECT ? {} : { projectName: reportProjectColorKey(group.name) }));
    for (const { source, row } of group.entries) {
      const line = reportNode('div', undefined, 'rp-rec');
      const wrap = reportNode('span', undefined, 'tiwrap');
      const open = reportNode('button', source.description, 'ti');
      open.type = 'button';
      open.title = source.description;
      open.addEventListener('click', () => panelOpen({ id: source.id }));
      wrap.appendChild(open);
      const link = uiSourceLink(source);
      if (link) wrap.appendChild(link);
      line.appendChild(wrap);
      const notes = [];
      if (source.status === 'done') notes.push('완료');
      if (row.excluded) notes.push('보고에서 제외됨');
      line.appendChild(reportNode('span', notes.join(' · '), 'mt'));
      if (row.excluded) line.appendChild(reportButton('복원', () => reportChange(item, { action: 'exclude', id: row.id }), 'd-btn sm'));
      // 이 줄에서 할 수 있는 일이 ⋯뿐이라 늘 보인다(다른 목록의 확인 대기·결정·아이디어 줄과 같은 규칙).
      const acts = reportNode('span', undefined, 'ac');
      acts.appendChild(uiMoreButton(`${source.description} — 더 보기`, () => reportRecordMenuSections(item, source, row, line)));
      line.appendChild(acts);
      list.appendChild(line);
    }
  }
  host.appendChild(list);
}

// ---------- 슬랙 미리보기(상시) ----------

// 슬랙 카드 맨 위 접힘 한 줄(개편 A) — 확정한 주의 `보고에 없는 끝낸 일 N ›`. 누르면 그 자리에서 펼쳐지고(aria-expanded),
// 줄마다 `넣기`(확정한 주에 붙들어 둔 끝낸 일 하나를 새 줄로 — 서버 pullOne). 없으면 줄이 없다. 넣는 것은 사람이 누를 때만이다
// (확정한 주는 자동 모으기가 문장을 넣지 않는다 — DECISIONS). 뺀 줄은 ②부터 문서 제자리에 흐리게 남아 여기 없다.
function reportMaterialBlock(item) {
  const report = item.draft;
  const pending = report.material && Array.isArray(report.material.pending) && report.confirmed ? report.material.pending : [];
  // 확정 뒤 새로 들어온 줄 전부(끝낸 일·진행 중·결정 등, 서버의 confirmed.pending — `모두 넣기`(pullNew)가 실제로 넣는 줄 수)와
  // 그중 끝낸 일이 아닌 줄 수. 끝낸 일은 한 줄씩 `넣기`로도 넣고, 나머지는 `모두 넣기`로만 들어간다.
  const fresh = report.confirmed && Number.isFinite(report.confirmed.pending) ? report.confirmed.pending : 0;
  const others = Math.max(0, fresh - (Number.isFinite(report.confirmed && report.confirmed.pendingDone) ? report.confirmed.pendingDone : fresh));
  if (!pending.length && !fresh) return null;
  const wrap = reportNode('div', undefined, 'rp-flw');
  const newText = pending.length ? `보고에 없는 끝낸 일 ${pending.length}${others ? ` · 새 줄 ${others}` : ''}` : fresh ? `보고에 없는 새 줄 ${fresh}` : '';
  const label = newText;
  const toggle = reportNode('button', undefined, 'rp-fl');
  toggle.type = 'button';
  toggle.appendChild(reportNode('span', label));
  const chev = reportNode('span', undefined, 'cv');
  chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = uiIcon('chevron');
  toggle.appendChild(chev);
  toggle.setAttribute('aria-expanded', String(reportMaterialOpen));
  toggle.setAttribute('aria-controls', 'reportMaterialBody');
  const body = reportNode('div', undefined, 'rp-flb');
  body.id = 'reportMaterialBody';
  body.hidden = !reportMaterialOpen;
  toggle.addEventListener('click', () => {
    reportMaterialOpen = !reportMaterialOpen;
    toggle.setAttribute('aria-expanded', String(reportMaterialOpen));
    uiFold(() => { body.hidden = !reportMaterialOpen; }, { open: reportMaterialOpen, part: body });
  });
  uiFoldKey(toggle, 'rp-material'); // 미리보기를 다시 그려도 꺾쇠가 옛 각도에서 돈다
  // `새로 들어온 줄 N 모두 넣기` — 확정 뒤 새로 들어온 줄 전부를 한 번에 새 줄로(기존 pullNew, 이름의 N이 곧 넣는 줄 수).
  // 두 줄 이상이거나, 한 줄씩 넣기로 못 넣는 줄(진행 중·결정 등)이 있을 때만 선다.
  if (pending.length || fresh) {
    const headText = pending.length ? `보고에 없는 끝낸 일 ${pending.length}` : `보고에 없는 새 줄 ${fresh}`;
    if (fresh >= 2 || fresh > pending.length) {
      const head = reportNode('div', undefined, 'g');
      head.appendChild(reportNode('span', headText));
      const all = reportButton(fresh > 1 ? `새로 들어온 줄 ${fresh} 모두 넣기` : '보고에 넣기', () => reportChange(item, { action: 'pullNew' }).then(reportMaterialFocus), 'rp-all');
      all.setAttribute('aria-label', `확정 뒤 새로 들어온 줄 ${fresh}개 모두 보고에 넣기`);
      head.appendChild(all);
      body.appendChild(head);
    } else body.appendChild(reportNode('div', headText, 'g'));
    for (const task of pending) {
      const line = reportNode('div', undefined, 'mr');
      line.appendChild(reportNode('span', task.description, 't'));
      const meta = reportNode('span', undefined, 'm');
      const day = task.completed && typeof uiDateSlash === 'function' ? ` · ${uiDateSlash(task.completed)}` : '';
      meta.appendChild(reportNode('span', `${reportProjectText(task.label)}${day}`));
      const take = reportButton('넣기', () => reportChange(item, { action: 'pullOne', ids: [task.id] }).then(reportMaterialFocus), 'd-link');
      take.setAttribute('aria-label', `${task.description} — 보고에 넣기`);
      meta.appendChild(take);
      line.appendChild(meta);
      line.title = task.description;
      body.appendChild(line);
    }
  }
  wrap.append(toggle, body);
  return wrap;
}

// 넣기 뒤 카드가 다시 그려지면 초점을 접힘 줄로 돌려놓는다(줄이 사라졌으면 그대로 둔다).
function reportMaterialFocus() {
  const toggle = document.getElementById('weeklyReportPreview')?.querySelector?.('.rp-fl');
  if (toggle && typeof toggle.focus === 'function') toggle.focus();
}

// 슬랙 카드(개편 A): 머리(`슬랙에 붙이면` + 넓은 화면이면 복사 버튼) → (넓은 화면) `보내기 전 확인 · 확인 필요 N ›` →
// 접힘 한 줄 → 붙였을 때의 글. 여기 보이는 글자와 클립보드에 담기는 글자가 같아야 한다.
// `item`이 없으면(옛 부르는 곳) 머리·확인 줄·접힘 줄 없이 글만 그린다.
function reportPreview(report, item) {
  const host = document.getElementById('weeklyReportPreview');
  if (!host) return;
  host.replaceChildren();
  const wide = !!item && reportCopyInSlack();
  const top = reportNode('div', undefined, 'rp-slacktop');
  top.appendChild(reportNode('div', '슬랙에 붙이면', 'rp-slackhd'));
  if (wide) top.appendChild(reportCopyButton(item));
  host.appendChild(top);
  const empty = !reportSlackLines(reportSlackModel(report)).length;
  // 확인할 것이 0이면 이 줄 자체가 없다(0은 적지 않는다) — 보낼 문장이 없을 때의 한 마디와 걸린 문장이 있을 때만 선다.
  const reviewCount = reportReviewCount(report);
  if (wide && (empty || reviewCount > 0)) {
    const check = reportNode('div', undefined, 'rp-check');
    check.appendChild(reportNode('span', '보내기 전 확인', 'hl'));
    if (empty) check.appendChild(reportNode('span', '보낼 문장이 아직 없어요', 'fine'));
    else if (reportMode === 'draft') check.appendChild(reportReviewButton(item));
    else check.appendChild(reportNode('span', `확인 필요 ${reviewCount}`, 'fine'));
    host.appendChild(check);
  }
  const material = item ? reportMaterialBlock(item) : null;
  if (material) host.appendChild(material);
  const box = reportNode('div', undefined, 'rp-slackbox');
  box.id = 'reportPreviewBox';
  host.appendChild(box);
  reportPreviewText(report, box);
}

// 붙였을 때의 글.
function reportPreviewText(report, target) {
  const box = target || document.getElementById('reportPreviewBox');
  if (!box) return;
  box.replaceChildren();
  const lines = reportSlackLines(reportSlackModel(report));
  if (!lines.length) box.appendChild(reportNode('div', '슬랙에 넣을 문장이 없어요.', 'rp-hint'));
  // 구역 사이의 빈 줄은 진짜 줄바꿈 글자로 둔다 — 빈 칸은 직접 선택해 복사할 때 빈 줄로 따라오지 않는다.
  for (const line of lines) {
    if (line.kind === 'gap') box.appendChild(document.createTextNode('\n'));
    else box.appendChild(reportNode('div', line.text, line.kind));
  }
}

// 서식 있는 복사와 일반 글자를 함께 넣는다. `ClipboardItem`이 없거나 막히면 일반 글자만,
// 그것도 막히면 예외를 그대로 올려 바깥에서 미리보기를 잡아 준다.
async function reportSlackCopy(model) {
  const text = reportSlackText(model);
  if (typeof ClipboardItem === 'function' && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([reportSlackHtml(model)], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return;
    } catch {}
  }
  await navigator.clipboard.writeText(text);
}

// 클립보드가 막힌 곳(사파리 권한·헤드리스)에서는 미리보기 글자를 잡아 준다 — ⌘C로 바로 복사되게.
function reportSelectPreview() {
  const box = document.getElementById('reportPreviewBox');
  if (!box || typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(box);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  box.scrollIntoView({ block: 'nearest' });
}

// ---------- 문서 전체 ----------

// 문서는 통째로 다시 그린다 — 줄 부품(uiRowsMove)으로 감싸 문장이 옛 자리에서 새 자리로 미끄러진다(빼기·모으기·팔로업·되돌리기).
// 문장을 고치는 중(입력칸에 초점)·한글 조합 중·글자 칸의 Enter·Esc 뒤에는 도우미가 스스로 쉰다. 적던 글은 reportEdits가 지킨다(그대로).
// 다른 주·다른 보기(보고 ↔ 전체 업무 기록)로 옮기면 다른 내용이다(화면 전환) — 재지 않고 그린다.
function renderReportDraft(item) {
  const host = document.getElementById('weeklyReportDetail');
  if (!host) return;
  const same = host.dataset.weekKey === item.weekKey && host.dataset.reportMode === reportMode;
  if (same) uiRowsMove(host, () => renderReportDraftNow(item, host));
  else renderReportDraftNow(item, host);
  host.dataset.reportMode = reportMode;
  // 다른 주·다른 보기(전체 업무 기록)로 옮겼으면 문서가 100ms 나타나기만 한다(화면 전환 — 옆으로 밀지 않는다).
  uiSwap(host, 'weekly:doc', `${item.weekKey}|${reportMode}`);
  // 정리 모드를 켜면 글머리 자리의 선택 칸과 알림 한 줄이 100ms 나타난다(끌 때는 바로 사라진다).
  uiSwap([...host.querySelectorAll('.rp-tidy, .rp-s.is-tidy .bu')], 'weekly:tidy', reportTidy ? item.weekKey : '');
}
function renderReportDraftNow(item, host) {
  if (reportRenderedWeek !== item.weekKey) {
    reportFoldOpen.clear();
    reportReviewPick = null;
    reportRenderedWeek = item.weekKey;
  }
  reportRenderedItem = item;
  const report = item.draft;
  // 다시 그릴 때마다 정리 모드가 아직 말이 되는지 확인한다 — `전체 업무 기록`으로 옮겼으면 모드는 끝나고(남은 Esc도 내린다),
  // 고른 줄 중 사라진 것(풀기·다른 창의 변경)은 조용히 뺀다.
  if (reportTidy) {
    // 주를 바꾸면 정리 모드는 끝난다(고른 줄은 그 주의 것이다).
    if (reportMode !== 'draft' || (reportTidy.weekKey && reportTidy.weekKey !== item.weekKey)) { reportTidy = null; escDrop(reportTidyEnd); }
    else {
      const ids = new Set((report.rows || []).map(row => row.id));
      for (const id of [...reportTidy.ids]) if (!ids.has(id)) reportTidy.ids.delete(id);
      if (reportTidy.anchor && !ids.has(reportTidy.anchor)) reportTidy.anchor = null;
    }
  }
  host.dataset.weekKey = item.weekKey;
  host.replaceChildren();

  const newIds = reportMarkSeen(item);
  reportDocHead(item, host);
  if (reportTidy && reportMode === 'draft') host.appendChild(reportTidyAlertLine(item));
  reportTopBlock(item, host);
  const body = reportNode('div', undefined, 'rp-body');
  host.appendChild(body);

  if (reportMode === 'records') {
    reportRecordsView(item, body);
  } else {
    // 한 일 칸 — 프로젝트마다 완료·진행 중·결정·확인 줄이 함께 서고(결정·확인은 처음부터 흐리게 빠짐), 프로젝트 없는 줄은 맨 아래.
    const done = reportDoneGroups(report.rows);
    body.appendChild(reportColumnHead(item, 'done'));
    if (!done.groups.length && !done.loose.length) body.appendChild(reportNode('div', '이번 주 기록이 생기면 여기에 나타나요.', 'rp-hint'));
    const titles = reportGroupTitles(done.groups.map(group => group.group));
    for (const group of done.groups) {
      // 소제목 묶음 하나(`.rp-grp`) — `+ 한 줄 추가`는 이 묶음에 손이 닿거나 초점이 들어올 때만 보인다(CSS).
      const box = reportNode('div', undefined, 'rp-grp');
      body.appendChild(box);
      box.appendChild(reportGroupHead(item, group, titles.get(group.group)));
      let shown = 0;
      for (const row of group.rows) {
        // `reportDoneGroups`는 그대로 두고(순수 함수) 이 그리기 단계에서만 접힌 부모의 아래를 거른다.
        if (reportRowHiddenByFold(report.rows, row)) continue;
        reportSentenceRow(item, row, { host: box, newIds });
        shown += 1;
      }
      if (!shown) box.classList.add('is-empty');
      // 한 일 칸 `+ 한 줄 추가`는 완료한 일로만 더한다(진행 중 업무는 할 일 칸 입력줄로).
      if (reportCanAddLine(item, group)) reportAddLineRow(item, REPORT_DONE_HEADING, group, titles.get(group.group), box);
    }
    if (done.loose.length) {
      body.appendChild(reportNode('div', undefined, 'rp-sep'));
      for (const row of done.loose) {
        if (reportRowHiddenByFold(report.rows, row)) continue;
        reportSentenceRow(item, row, { host: body, newIds });
      }
    }
    reportPlanSection(item, body, newIds);
  }

  reportTidyBar(item);
  reportPreview(report, item);
}

// ---------- 주차 목록에 끼울 자리('내 일 기록', 그리기는 usage-ui.js) ----------
// app.js의 renderWeeklyReports가 부른다 — usage-ui.js가 없거나 기록이 없으면 null. ① 주차 한 줄의 오른쪽 끝 칸
// (끝낸 일 막대·숫자 자리) ② 주차 목록 칸 맨 아래 한 덩어리. 요소를 돌려주면 그 자리에 붙는다.
function reportWeekRowEnd(item) { return typeof usageWeekRowEnd === 'function' ? usageWeekRowEnd(item) : null; }
function reportWeeksFoot(items) { return typeof usageWeeksFoot === 'function' ? usageWeeksFoot(items) : null; }
