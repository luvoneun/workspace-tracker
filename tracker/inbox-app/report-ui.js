// ---------- 주간요약 문서 ----------
// 평일에는 "이번 주 뭐 했는지" 읽는 문서이고, 금요일에 문장을 고쳐 오른쪽 미리보기 그대로 슬랙에 붙인다.
// 저장하는 길은 `/api/report/change` 하나뿐이고(DECISIONS 주간보고), 이 화면은 추측으로 문장을 만들지 않는다.
// 오른쪽 미리보기와 `슬랙용으로 복사`는 반드시 같은 구조(reportSlackModel)에서 나온다 — 셋이 어긋나면 안 된다.

const reportEdits = new Map();        // `${weekKey}:${행}` / `${weekKey}:new` → 입력 중인 글자(저장 실패해도 남는다)
const reportUndo = new Map();         // weekKey → 되돌리기 토큰
const reportEvidenceOpen = new Set(); // 근거 업무를 펼쳐 둔 문장
const reportNewRecords = new Map();   // weekKey → { revision, ids } 안 본 새 기록
let reportBusy = false;
let reportMode = 'draft';             // 'draft' 보고 · 'records' 전체 업무 기록
let reportRenderedWeek = null;
let reportRenderedItem = null;
let reportNestParentId = null;        // 모으기 모드의 기준 문장(이 문장 아래로 넣는다)
let reportFoldIds = null;             // 한 줄로 모으기 고르기 모드에서 지금 고른 id들(Set) — 꺼져 있으면 null
let reportFoldHeading = null;         // 고르기 모드에서 고를 수 있는 소제목(첫 문장의 heading)
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
let reportMaterialOpen = false;       // 슬랙 카드 맨 위 접힘 줄(보고에 없는 끝낸 일 · 뺀 문장)을 펼쳐 뒀는지

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

window.addEventListener('beforeunload', event => {
  if (reportEdits.size || reportBusy) { event.preventDefault(); event.returnValue = ''; }
});

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
    try { await action(); }
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
const REPORT_EDIT_HINT = 'Enter 저장 · Esc 취소';

// 제목·소제목 자리의 입력칸 — 글자를 누르면 그 자리가 입력칸(`.d-din`)이 되고 아래에 `Enter 저장 · Esc 취소` 한 줄이 선다.
// 저장·취소 버튼은 없다(v3 — 고치는 법은 하나). 한글 조합 중 Enter는 넘긴다. 원래 이름과 같으면 저장하지 않고 닫고,
// 비우고 저장하면 원래 이름으로 돌아간다(placeholder가 원래 이름이다).
function reportRenameBox(item, { editKey, label, original, current, save, hint }) {
  const box = reportNode('div', undefined, 'rp-ren');
  const input = reportNode('input', undefined, 'd-din');
  input.type = 'text';
  input.maxLength = 60;
  input.value = reportEdits.get(editKey) ?? current;
  input.placeholder = original;
  input.dataset.renameInput = editKey;
  input.setAttribute('aria-label', `${label} — ${hint ? `${hint} · ` : ''}${REPORT_EDIT_HINT}`);
  input.addEventListener('input', () => reportEdits.set(editKey, input.value));
  const close = () => { reportEdits.delete(editKey); renderReportDraft(item); reportRenameFocus(editKey); };
  const commit = async () => {
    const value = input.value.trim();
    if (value === current) { close(); return; }
    await save(value);
    reportRenameFocus(editKey);
  };
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Enter' || input.disabled) return;
    event.preventDefault();
    input.disabled = true;
    commit().catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true))
      .finally(() => { input.disabled = false; });
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

// 모으기 모드에서 이 문장을 기준 문장 아래로 넣을 수 있는지 — 서버 `nest`와 같은 조건이다.
function reportCanNest(rows, row, parent) {
  if (!row || !parent || row.id === parent.id) return false;
  if (row.excluded || parent.excluded) return false;
  if (row.heading !== parent.heading) return false;
  if (row.parent || parent.parent) return false;
  return !(rows || []).some(entry => entry.parent === row.id);
}

// ---------- 한 줄로 모으기(fold) — 여러 문장을 골라 사람이 지은 요약 한 줄 아래로 넣는다 ----------
// 고를 수 있는 문장의 조건은 nest 후보와 같다(최상위·제외 안 됨·아래에 문장 없음), 거기에 고르기를
// 시작한 문장과 같은 소제목이어야 한다는 조건이 더해진다. 글자는 합치지 않는다(fold는 서버가 처리).
function reportCanFold(rows, row) {
  if (!row || row.excluded || row.parent) return false;
  return !(rows || []).some(entry => entry.parent === row.id);
}

// 초기 요약 문장 — 프로젝트가 하나면 이름을 앞에 붙이고, 여럿이면 개수만(BKEY: 지라는 요약만).
function reportFoldSeedText(selected) {
  const names = new Set((selected || []).map(row => reportProjectText(reportRowGroup(row))));
  const count = (selected || []).length;
  return names.size === 1 ? `${[...names][0]} 소소한 작업 ${count}건` : `소소한 작업 ${count}건`;
}

// fold 성공 뒤 방금 만든 새 부모를 찾는다 — 서버가 새 id를 만들어 응답에 담아 오므로, 고른 id들과
// 자식이 정확히 같은 manual 부모를 찾는다(다른 fold 묶음과 헷갈리지 않게).
function reportFoldParentOf(rows, ids) {
  const set = new Set(ids);
  return (rows || []).find(row => row.manual && !row.parent
    && (rows || []).filter(entry => entry.parent === row.id).length === set.size
    && (rows || []).filter(entry => entry.parent === row.id).every(entry => set.has(entry.id)));
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
  if (!group || group.origin || !report || !reportPlanIsCurrentWeek(report.weekKey)) return '';
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
// 규칙: 뺀 줄(처음부터 빠진 결정·확인 포함)은 빠짐 · 여러 줄 문장·아래로 넣은 문장은 각 줄이 `◦`(두 단계까지) · 접힌 부모는
// 첫 줄 하나만 · 내용이 없는 칸은 생략. 슬랙에는 지라 키를 싣지 않는다(reportSlackProjectLabel).
// `options.names`는 칸 이름(`{ done, plan }`)이고, 빠뜨리면 이 브라우저에 기억한 이름이다.
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
    const lines = tops(group.rows).flatMap(flat);
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

// 한 일 칸의 뼈대 — 문서·슬랙 글·`확인 필요 ›` 차례가 모두 이 묶음을 쓴다.
// 프로젝트(소제목)는 열쇠(groupKey)로 묶고 소제목(완료한 일·진행 중·결정·확인)은 가리지 않는다 — 서버가 준 차례(완료 → 진행 중 →
// 결정·확인)대로 한 프로젝트 아래 선다. 결정·확인 줄은 빠져 있어도 그 프로젝트 아래 남고(흐리게), 그 밖의 뺀 문장·할 일 칸은 빠진다.
// 다른 문장 아래로 들어간 문장은 자기 프로젝트가 달라도 부모의 프로젝트 아래 부모 바로 뒤. 프로젝트 없는 줄(`그룹 없음`)은
// 소제목 없이 칸 맨 아래(`loose`), 옛 합치기의 `여러 프로젝트`는 프로젝트들 맨 끝. 열쇠가 없는 옛 응답만 이름으로 묶는다.
function reportDoneGroups(rows) {
  const groups = [];
  const loose = [];
  const children = reportChildRows(rows);
  for (const row of rows || []) {
    if (row.heading === REPORT_PLAN_HEADING || (row.excluded && !reportOptIn(row))) continue;
    if (reportParentRow(rows, row)) continue;
    const kids = children.get(row.id) || [];
    const name = reportRowGroup(row);
    if (reportProjectText(name) === REPORT_NO_PROJECT) { loose.push(row, ...kids); continue; }
    const groupId = row.groupKey ? `key:${row.groupKey}` : `name:${name}`;
    let group = groups.find(entry => entry.id === groupId);
    // `key`·`origin`은 소제목 이름 바꾸기가 쓴다(서버가 준 프로젝트 열쇠와, 사람이 고친 이름일 때의 원래 이름). `source`는 저장된 이름.
    if (!group) {
      group = { group: name, key: row.groupKey || null, origin: row.groupOrigin || null, source: row.group, rows: [] };
      Object.defineProperty(group, 'id', { value: groupId, enumerable: false });
      groups.push(group);
    }
    group.rows.push(row, ...kids);
  }
  reportMultiProjectLast(groups, group => group.group, () => false);
  return { groups, loose };
}

// 할 일 칸(다음 주 계획)의 줄 — 사람이 적은 줄과, 서버가 미리 채운 줄(`origin:'carry'` — 진행 중 업무·지난주 계획 중 안 끝난 것).
function reportPlanRows(rows) {
  return (rows || []).filter(row => row.heading === REPORT_PLAN_HEADING && !row.excluded);
}

// 계획 문장도 문서에서는 프로젝트 소제목 아래로 묶인다. 프로젝트를 고르지 않은 문장은 구역 끝에
// 소제목 없이 선다(`name: null`).
function reportPlanGroups(rows) {
  const groups = [];
  const byName = new Map();
  const loose = [];
  const children = reportChildRows(rows);
  for (const row of rows || []) {
    if (reportParentRow(rows, row)) continue;
    const kids = children.get(row.id) || [];
    const name = String(row.group || '').trim();
    if (!name || name === REPORT_PLAN_NO_PROJECT || name === REPORT_NO_PROJECT_LABEL || name === REPORT_NO_PROJECT) {
      loose.push(row, ...kids);
      continue;
    }
    if (!byName.has(name)) { const group = { name, rows: [] }; byName.set(name, group); groups.push(group); }
    byName.get(name).rows.push(row, ...kids);
  }
  if (loose.length) groups.push({ name: null, rows: loose });
  return groups;
}

// 뺀 문장(슬랙 카드 접힘 줄의 `뺀 문장 N`). 결정·확인 줄은 한 일 칸 제자리에 흐리게 남으므로 여기 들지 않는다.
function reportExcludedRows(rows) {
  return (rows || []).filter(row => row.excluded && !reportOptIn(row));
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

// `options.key`는 같은 요청을 다시 보내도 한 번만 되게 하는 요청 id(`+ 한 줄 추가`가 업무를 만들 때 — 서버의 Idempotency-Key).
async function reportChange(item, action, notice, options = {}) {
  if (reportBusy) return;
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
    if (action.action === 'edit') reportEdits.delete(`${item.weekKey}:${action.id}`);
    if (action.action === 'retitle') reportEdits.delete(reportTitleEditKey(item.weekKey));
    if (action.action === 'rename') reportEdits.delete(reportNameEditKey(item.weekKey, action.heading, action.groupKey));
    if (action.action === 'addLine') reportEdits.delete(reportAddLineKey(item.weekKey, action.heading, action.groupKey));
    // `add`로 적던 글을 비우는 것은 입력칸을 들고 있는 쪽(reportPlanAddLines)이 한다 —
    // 다른 입력줄(프로젝트 소제목의 `+ 추가`)에서 담았는데 맨 아래 줄의 글이 날아가면 안 된다.
    // `+ 한 줄 추가`를 되돌린 결과처럼 서버가 되돌리기 표를 주지 않으면 되돌릴 것이 없다.
    if (result.undoToken) reportUndo.set(item.weekKey, result.undoToken); else reportUndo.delete(item.weekKey);
    tasksChanged = !!result.tasksChanged;
    item.draft = result.report;
    const cached = weeklyReportsCache.find(entry => entry.weekKey === item.weekKey);
    if (cached) cached.draft = result.report;
  } finally { reportBusy = false; }
  renderReportDraft(item);
  reportSavedNotice(item, action, notice);
  // 업무를 만들거나 지웠으면(`+ 한 줄 추가`·그 되돌리기) 오늘·프로젝트 목록도 바로 보이게 목록을 다시 받는다.
  if (tasksChanged && typeof load === 'function') Promise.resolve(load()).catch(() => {});
}

// 저장 뒤 알림 하나. 자리를 옮기는 변경(아래로 넣기·따로 빼기·옛 묶기·묶음 풀기)은 무엇이 바뀌었는지
// 적고 그 자리에서 `되돌리기`까지 준다(머리줄의 `되돌리기`와 같은 길이다). 나머지는 예전 문구 그대로다.
const REPORT_MOVE_NOTICE = {
  nest: '문장을 아래로 넣었어요',
  unnest: '따로 뺐어요',
  split: '묶음을 풀었어요',
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
function reportSavedNotice(item, action, notice) {
  if (action.action === 'undo') { announce('되돌렸어요'); return; }
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

// ---------- 모으기 모드(기준 문장 아래로 문장을 넣는다) ----------
// 글자를 합치지 않는다 — 누른 문장이 그 자리에서 기준 문장 아래로 한 단계 들어가고 모드는 그대로 남는다.

// 지금 모으고 있는 기준 문장. 그 문장이 사라졌으면(다른 창의 변경 등) 모드가 끝난 것으로 본다.
function reportNestParent(report) {
  if (reportNestParentId === null) return null;
  return (report && report.rows ? report.rows : []).find(row => row.id === reportNestParentId && !row.excluded && !row.parent) || null;
}

function reportNestStart(item, row) {
  reportFoldEnd(); // 고르기 모드는 함께 열리지 않는다.
  reportPlaceEnd();
  reportNestParentId = row.id;
  escDrop(reportNestEnd);
  escPush(reportNestEnd);
  renderReportDraft(item);
}

function reportNestEnd() {
  // 저장이 도는 중의 Esc는 아무것도 닫지 못한다 — 스택에서 빠진 자기를 되돌려 놓아야 다음 Esc가 듣는다.
  if (reportBusy && reportNestParentId !== null) { if (!escStack.includes(reportNestEnd)) escPush(reportNestEnd); return; }
  if (reportNestParentId === null) return;
  reportNestParentId = null;
  escDrop(reportNestEnd);
  if (reportRenderedItem) renderReportDraft(reportRenderedItem);
}

// 막대에 적는 기준 문장 — 첫 줄만, 길면 줄인다.
function reportNestLabel(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

// ---------- 넣을 곳 고르기(`다른 문장 아래로 넣기`) ----------
// 모으기(nest)의 반대 방향 — 옮길 문장에서 시작해 그 문장을 받을 문장을 한 번 누르면 끝난다(서버는 같은 `nest`).
let reportPlaceId = null;
function reportPlaceRow(report) {
  if (reportPlaceId === null) return null;
  return (report && report.rows ? report.rows : []).find(row => row.id === reportPlaceId && !row.excluded && !row.parent) || null;
}
function reportPlaceStart(item, row) {
  reportNestEnd();
  reportFoldEnd();
  reportPlaceId = row.id;
  escDrop(reportPlaceEnd);
  escPush(reportPlaceEnd);
  renderReportDraft(item);
}
function reportPlaceEnd() {
  if (reportPlaceId === null) return;
  reportPlaceId = null;
  escDrop(reportPlaceEnd);
  if (reportRenderedItem) renderReportDraft(reportRenderedItem);
}

// ---------- 한 줄로 모으기 고르기 모드 ----------
// nest처럼 기준 문장에서 시작하지만, 여러 문장을 골라 두었다가 확인을 눌러야(fold) 저장된다.
// 시작한 문장은 이미 골라진 상태이고, 같은 소제목의 문장만 고르고 뺄 수 있다.

function reportFoldStart(item, row) {
  reportNestEnd(); // 고르기 모드는 함께 열리지 않는다.
  reportPlaceEnd();
  reportFoldIds = new Set([row.id]);
  reportFoldHeading = row.heading;
  escDrop(reportFoldEnd);
  escPush(reportFoldEnd);
  renderReportDraft(item);
}

function reportFoldEnd() {
  if (reportBusy && reportFoldIds !== null) { if (!escStack.includes(reportFoldEnd)) escPush(reportFoldEnd); return; }
  if (reportFoldIds === null) return;
  reportFoldIds = null;
  reportFoldHeading = null;
  escDrop(reportFoldEnd);
  if (reportRenderedItem) renderReportDraft(reportRenderedItem);
}

// 확인을 누르면 서버에 `fold`를 보내고, 성공하면 새 부모 문장을 그 자리에서 바로 수정 모드로 연다
// (글 전체가 선택된 채로 — 기존 `edit` 인라인 UI를 그대로 재사용한다).
async function reportFoldConfirm(item) {
  if (!reportFoldIds || reportFoldIds.size < 2 || reportBusy) return;
  const ids = [...reportFoldIds];
  const text = reportFoldSeedText((item.draft.rows || []).filter(row => ids.includes(row.id)));
  reportFoldIds = null;
  reportFoldHeading = null;
  escDrop(reportFoldEnd);
  try {
    await reportChange(item, { action: 'fold', ids, text });
  } catch (error) {
    showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true);
    return;
  }
  const parent = reportFoldParentOf(item.draft.rows, ids);
  if (!parent) return;
  reportEdits.set(`${item.weekKey}:${parent.id}`, parent.text);
  renderReportDraft(item);
  const input = document.getElementById('weeklyReportDetail')?.querySelector(`[data-edit-row="${parent.id}"]`);
  if (input) { input.focus(); input.select(); }
}

// 모으기 막대(nest) · 한 줄로 모으기 고르기 막대(fold) — 같은 부품(`.d-selbar`, `#reportNestBarEl`)을
// 함께 쓴다(둘은 동시에 열리지 않는다). 어느 쪽도 아니면 감춘다.
function reportPickBar(item) {
  const bar = document.getElementById('reportNestBarEl');
  if (!bar) return;
  const nestParent = reportNestParent(item.draft);
  const nesting = !!nestParent && reportMode === 'draft';
  const folding = reportFoldIds !== null && reportMode === 'draft';
  const placeRow = reportPlaceRow(item.draft);
  const placing = !!placeRow && reportMode === 'draft';
  const open = nesting || folding || placing;
  document.body.classList.toggle('nest-open', open);
  bar.hidden = !open;
  bar.replaceChildren();
  if (!open) return;
  // 같은 막대를 세 모드가 나눠 쓴다 — 지금 모드에 맞게 이름표를 바꿔 단다.
  bar.setAttribute('aria-label', folding ? '한 줄로 모으기 고르기' : placing ? '넣을 곳 고르기' : '문장 아래로 모으기');
  const inner = reportNode('div', undefined, 'bar');
  if (placing) {
    inner.appendChild(reportNode('span', `「${reportNestLabel(placeRow.text)}」`, 'ct'));
    inner.appendChild(reportNode('span', '을 넣을 문장을 눌러 주세요', 'rp-hint'));
    inner.appendChild(reportNode('span', undefined, 'sp'));
    inner.appendChild(reportButton('취소', () => reportPlaceEnd()));
  } else if (nesting) {
    inner.appendChild(reportNode('span', `「${reportNestLabel(nestParent.text)}」 아래로`, 'ct'));
    inner.appendChild(reportNode('span', '넣을 문장을 눌러 주세요', 'rp-hint'));
    inner.appendChild(reportNode('span', undefined, 'sp'));
    inner.appendChild(reportButton('완료', () => reportNestEnd(), 'd-btn pri'));
  } else {
    const count = reportFoldIds.size;
    inner.appendChild(reportNode('span', `한 줄로 모을 문장을 골라요 · ${count}개`, 'ct'));
    inner.appendChild(reportNode('span', undefined, 'sp'));
    inner.appendChild(reportButton('취소', () => reportFoldEnd()));
    const confirm = reportButton('한 줄로 모으기', () => reportFoldConfirm(item), 'd-btn pri');
    if (count < 2) confirm.disabled = true;
    inner.appendChild(confirm);
  }
  bar.appendChild(inner);
}

// ---------- 문서의 부품 ----------

// 머리 한 줄(v3): 제목 · 기간 ··· `다음 주 계획`(조용한 글자 버튼) · `슬랙용으로 복사`(1차) · ⋯.
// ⋯ 안: `전체 업무 기록 보기`(↔ `보고로 돌아가기`) · `제외한 문장 보기` · 직전 변경 되돌리기 · 개수 한 줄.
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
      save: text => reportChange(item, { action: 'retitle', text }),
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
  // 금요일에 가장 먼저 하는 일이 계획 쓰기다 — 긴 문서를 훑지 않고 바로 그 자리로 데려간다(이번 주만).
  if (reportPlanIsCurrentWeek(item.weekKey)) {
    acts.appendChild(reportButton('다음 주 계획', () => {
      reportMode = 'draft';
      renderReportDraft(item);
      const input = document.getElementById('reportPlanInput');
      if (!input) return;
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

// `슬랙용으로 복사` — 한 화면에 채운 버튼은 이것 하나다. 고치는 중이거나 모으기 모드일 때는 3차로 내려선다.
// 자리는 부르는 쪽이 정한다(넓으면 슬랙 카드 머리, 좁으면 문서 머리 — reportCopyInSlack). 어느 자리든 하나만 그린다.
function reportCopyButton(item) {
  const report = item.draft;
  const busyMode = reportEditing(item.weekKey) || (reportMode === 'draft' && (reportNestParentId !== null || reportFoldIds !== null || reportPlaceId !== null));
  return reportButton('슬랙용으로 복사', async () => {
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
    else showNotice('슬랙에 붙여 넣을 수 있게 복사했어요', false, null, { label: '이대로 확정', onClick: () => reportConfirm(item, true) });
    // 사용 횟수(WP-R) — 복사 한 번, 그리고 복사한 글에 할 일 칸 줄이 있으면 한 번 더(다음 주 칸이 빈칸에서 시작하지 않는지 보려고).
    if (typeof usageTick === 'function') {
      usageTick('weekly_copy');
      if (model.sections.some(section => section.key === 'plan')) usageTick('weekly_copy_plan');
    }
    reportKeep(item);
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
}

// 머리 ⋯ 메뉴(순수에 가까움 — 테스트가 이름표를 본다). 개수 줄은 누를 수 없는 조용한 항목이다.
function reportHeadMenuSections(item) {
  const report = item.draft;
  const rows = report.rows || [];
  const excluded = reportExcludedRows(rows).length;
  return [
    [report.confirmed
      ? { label: '확정 풀기', onClick: () => reportConfirm(item, false) }
      : { label: '이 보고 확정하기', onClick: () => reportConfirm(item, true) }],
    [
      reportMode === 'records'
        ? { label: '보고로 돌아가기', onClick: () => { reportMode = 'draft'; renderReportDraft(item); } }
        : { label: '전체 업무 기록 보기', onClick: () => { reportMode = 'records'; renderReportDraft(item); } },
      excluded ? {
        label: `제외한 문장 보기 · ${excluded}개`,
        // 뺀 문장은 슬랙 카드 맨 위 접힘 줄에 있다 — 펼치고 그 줄로 간다.
        onClick: () => {
          reportMaterialOpen = true;
          renderReportDraft(item);
          const fold = document.getElementById('weeklyReportPreview')?.querySelector('.rp-fl');
          if (fold) { fold.scrollIntoView?.({ block: 'nearest' }); fold.focus(); }
        },
      } : null,
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
function reportConfirm(item, on) {
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
// 끝낸 업무 문장인데 결과 한 줄이 비었으면 끝에 주황 `결과 한 줄 비었어요` — 확인 필요로는 세지 않는다(앱이 채우지도 않는다).
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
  if (row.heading === '완료한 일') {
    const done = sources.filter(source => ['task', 'bug'].includes(source.type) && source.status === 'done');
    const empty = done.filter(source => !String(source.outcome || '').trim()).length;
    if (empty && empty === sources.length) bits.push(reportNode('span', '결과 한 줄 비었어요', 'w'));
    else if (empty) bits.push(reportNode('span', `결과 한 줄 빈 업무 ${empty}개`, 'w'));
  }
  bits.forEach((bit, index) => {
    if (index) { const dot = reportNode('span', '·', 'dot'); dot.setAttribute('aria-hidden', 'true'); line.appendChild(dot); }
    line.appendChild(bit);
  });
  return line;
}

// 근거 업무: 문장 아래 들여 쓴 목록. 줄을 누르면 그 줄 옆에 상세 카드가 열린다.
// `manual`(한 줄로 모으기로 만든 요약)은 자기 근거가 없다 — 아래 문장들의 근거를 이어 보여 준다
// (새 부품 없이 이 목록을 그대로 쓴다).
function reportEvidenceBlock(row, rows) {
  const list = reportNode('div', undefined, 'rp-ev');
  const kids = row.manual ? (rows || []).filter(entry => entry.parent === row.id) : [];
  const sources = kids.length ? kids.flatMap(entry => entry.currentEvidence || entry.evidence || []) : (row.currentEvidence || row.evidence || []);
  if (kids.length) list.appendChild(reportNode('div', `아래 문장 ${kids.length}개의 근거`, 'none'));
  if (!sources.length) {
    if (!kids.length) list.appendChild(reportNode('div', '기존 보고 문장 · 연결된 원본 없음', 'none'));
    return list;
  }
  for (const source of sources) {
    const line = reportNode('button', undefined, 'ev');
    line.type = 'button';
    line.append(reportNode('span', source.description, 't'));
    line.appendChild(reportNode('span', source.outcome || (source.status === 'done' ? '완료' : '미완료'), 'o'));
    line.addEventListener('click', () => panelOpen({ id: source.id }));
    list.appendChild(line);
  }
  return list;
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

// 문장 줄의 ⋯ 메뉴(v3). 첫 묶음이 자주 쓰는 셋 — `보고에서 빼기` · `다른 문장 아래로 넣기`(넣을 곳이 있을 때) ·
// `원래 문장으로`(손으로 고친 줄만). 그다음 묶음은 자리 옮기기(모으기·한 줄로 모으기·따로 빼기·묶음 풀기·접기·풀기),
// 마지막이 근거 한 줄(누르면 근거 업무 목록을 펼친다). 계획 문장은 끝에 `프로젝트 바꾸기`.
function reportSentenceMenuSections(item, row) {
  const rows = item.draft.rows || [];
  const hasChildren = rows.some(entry => entry.parent === row.id);
  const canPlace = !row.parent && !row.excluded && !hasChildren && rows.some(entry => reportCanNest(rows, row, entry));
  const sources = row.currentEvidence || row.evidence || [];
  const evidenceLabel = sources.length
    ? `근거: ${sources[0].description}${sources.length > 1 ? ` 외 ${sources.length - 1}개` : ''}`
    : row.manual && hasChildren ? '근거: 아래 문장들의 업무' : (row.sourceIds || []).length ? '근거 업무 보기' : '';
  // 결정·확인 줄은 처음부터 빠져 있다 — `다시 넣기`/`보고에서 빼기`가 서버 include다(뺀 줄은 다른 자리로 옮기지 않는다).
  const optIn = reportOptIn(row);
  return [
    [
      optIn
        ? { label: row.excluded ? '다시 넣기' : '보고에서 빼기', onClick: () => reportChange(item, { action: 'include', id: row.id, on: !!row.excluded }) }
        : { label: row.excluded ? '보고에 되살리기' : '보고에서 빼기', onClick: () => reportChange(item, { action: 'exclude', id: row.id }) },
      canPlace ? { label: '다른 문장 아래로 넣기', onClick: () => reportPlaceStart(item, row) } : null,
      // 사람이 `+ 한 줄 추가`로 더한 줄(`origin: weekly`)은 그 문장이 곧 원래 문장이라 붙이지 않는다.
      row.locked && !row.manual && row.origin !== 'weekly' && row.heading !== REPORT_PLAN_HEADING && (row.sourceIds || []).length
        ? { label: '원래 문장으로', onClick: () => reportChange(item, { action: 'revert', id: row.id }) } : null,
    ].filter(Boolean),
    row.excluded ? [] : [
      // `이 아래로 문장 모으기`는 이미 아래에 문장이 있는 부모에도 붙는다(더 넣는 길). `한 줄로 모으기…`는
      // 붙지 않는다 — 아래 문장을 가진 문장은 새 요약 아래로 들어갈 수 없어(서버가 거절) 늘 실패하는 항목이 된다.
      !row.parent && !row.excluded ? { label: '이 아래로 문장 모으기', onClick: () => reportNestStart(item, row) } : null,
      !row.parent && !row.excluded && !hasChildren ? { label: '한 줄로 모으기…', onClick: () => reportFoldStart(item, row) } : null,
      row.parent ? { label: '따로 빼기', onClick: () => reportChange(item, { action: 'unnest', id: row.id }) } : null,
      row.canSplit ? { label: '묶음 풀기', onClick: () => reportChange(item, { action: 'split', id: row.id }) } : null,
      hasChildren ? {
        label: row.folded ? '펼쳐서 보이기' : '접어서 한 줄로 보이기',
        onClick: () => reportChange(item, { action: 'setFolded', id: row.id, folded: !row.folded }),
      } : null,
      hasChildren ? { label: '풀기', onClick: () => reportChange(item, { action: 'unfold', id: row.id }) } : null,
    ].filter(Boolean),
    evidenceLabel ? [{
      label: reportEvidenceOpen.has(row.id) ? `${evidenceLabel} · 숨기기` : evidenceLabel,
      onClick: () => {
        if (reportEvidenceOpen.has(row.id)) reportEvidenceOpen.delete(row.id); else reportEvidenceOpen.add(row.id);
        renderReportDraft(item);
      },
    }] : null,
    // 계획 문장만 프로젝트를 나중에 바꾼다(다른 구역의 프로젝트는 원본 업무가 정한다).
    row.heading === REPORT_PLAN_HEADING
      ? [{ field: '프로젝트 바꾸기', control: reportPlanRegroupPicker(item, row) }]
      : null,
  ].filter(section => section && section.length);
}

// 줄 글자에 손을 올렸을 때의 풍선 — 끝말을 다듬은 줄은 원래 업무 제목(`업무: …`), 미리 채운 할 일 칸 줄은 왜 들어왔는지.
// 왜 들어왔는지는 풍선으로만 알린다(줄에 표시를 늘어놓지 않는다). 업무 제목은 바뀌지 않는다.
const REPORT_CARRY_WHY = { doing: '진행 중이라 들어왔어요', plan: '지난주 계획에 있었는데 아직 안 끝나서 들어왔어요' };
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

// 문장 한 줄(v3). 평소에는 글만 보인다 — 글자가 곧 고치는 자리(초점이 가는 버튼 역할, Enter·Space로도 시작)이고,
// 줄에 손이 닿거나 초점이 오면 끝에 ⋯ 하나만 나온다. 다듬은 뒤 새로 들어온 줄은 앞 점이 파랗다(`새로 들어옴`).
// 원본이 바뀐 고친 줄은 끝에 작은 알약 하나. 다른 문장 아래로 들어간 문장은 한 단계 들여 쓴 `◦` 줄이고,
// 모으기·고르기·넣을 곳 고르기 모드에서는 줄 전체가 눌리는 과녁이 된다.
function reportSentenceRow(item, row, context) {
  const host = context.host;
  const newIds = context.newIds || new Set();
  const key = `${item.weekKey}:${row.id}`;
  const rows = item.draft.rows || [];
  const parentRow = reportParentRow(rows, row);
  // 처음부터 빠져 있거나 뺀 결정·확인 줄 — 지우지 않고 제자리에 흐리게(취소선 없음, 읽어 주는 이름 `보고에서 뺌`).
  const out = !!row.excluded && reportOptIn(row);
  const line = reportNode('div', undefined, 'rp-s' + (parentRow ? ' is-sub' : '') + (out ? ' is-dim' : ''));
  if (reportRowReview(item.draft, row)) line.dataset.review = 'true';
  // `확인 필요 ›`로 옮겨 온 줄 — 기존 선택 톤(--sel) 하나.
  const picked = reportReviewPick === row.id && reportMode === 'draft';
  if (picked) line.classList.add('is-hit');

  const nestParent = reportNestParent(item.draft);
  const nesting = !!nestParent && reportMode === 'draft';
  const isNestParent = nesting && row.id === nestParent.id;
  const canNest = nesting && !reportEdits.has(key) && reportCanNest(rows, row, nestParent);
  if (isNestParent) line.classList.add('is-nest');
  else if (nesting && !canNest) line.classList.add('is-off');
  const pick = (labelText, run) => {
    line.classList.add('is-pick');
    line.tabIndex = 0;
    line.setAttribute('role', 'button');
    line.setAttribute('aria-label', labelText);
    line.addEventListener('click', run);
    line.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); }
    });
  };
  if (canNest) {
    pick(`${row.text} — 「${reportNestLabel(nestParent.text)}」 아래로 넣기`, () => reportChange(item, { action: 'nest', id: row.id, parentId: nestParent.id })
      .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true)));
  }

  // 넣을 곳 고르기(`다른 문장 아래로 넣기`) — 옮길 문장은 선택 톤, 그 문장을 받을 수 있는 문장만 눌린다(한 번 넣으면 끝).
  const placeRow = reportPlaceRow(item.draft);
  const placing = !!placeRow && reportMode === 'draft';
  const isPlaceRow = placing && row.id === placeRow.id;
  const canPlace = placing && !isPlaceRow && reportCanNest(rows, placeRow, row);
  if (placing) {
    if (isPlaceRow) line.classList.add('is-nest');
    else if (!canPlace) line.classList.add('is-off');
  }
  if (canPlace) {
    pick(`「${reportNestLabel(placeRow.text)}」을 ${row.text} 아래로 넣기`, () => {
      const child = placeRow.id;
      reportPlaceEnd();
      reportChange(item, { action: 'nest', id: child, parentId: row.id })
        .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true));
    });
  }

  // 한 줄로 모으기 고르기 모드 — 같은 소제목의 최상위·아래 문장 없는 문장만 고르고 뺄 수 있다.
  // 고른 문장은 기존 선택 톤(`.is-nest`, `--sel`)을 그대로 빌려 쓴다(새 색 없음).
  const folding = reportFoldIds !== null && reportMode === 'draft';
  const foldSelected = folding && reportFoldIds.has(row.id);
  const foldCandidate = folding && !foldSelected && row.heading === reportFoldHeading && reportCanFold(rows, row);
  if (folding) {
    if (foldSelected) line.classList.add('is-nest');
    else if (!foldCandidate) line.classList.add('is-off');
  }
  if (foldSelected || foldCandidate) {
    pick(`${row.text} — ${foldSelected ? '고르기 해제' : '한 줄로 모으기에 담기'}`, () => {
      if (reportFoldIds.has(row.id)) reportFoldIds.delete(row.id); else reportFoldIds.add(row.id);
      renderReportDraft(item);
    });
  }
  const modal = nesting || folding || placing;

  // 글머리 점 — 다듬은 뒤 새로 들어온 줄(기록이 없는 주는 브라우저별 새 기록)은 파란 점이고, 색만으로 말하지 않게
  // `새로 들어옴` 이름표를 붙인다.
  const fresh = item.draft.since ? !!row.fresh : (row.sourceIds || []).some(id => newIds.has(id));
  const bullet = reportNode('span', parentRow ? '◦' : '•', 'bu' + (fresh ? ' is-fresh' : ''));
  if (fresh) {
    bullet.setAttribute('role', 'img');
    bullet.setAttribute('aria-label', '새로 들어옴');
    bullet.title = '새로 들어옴';
    line.dataset.since = 'true';
  }
  line.appendChild(bullet);

  const text = reportNode('div', undefined, 'tx');
  line.appendChild(text);

  if (reportEdits.has(key)) {
    // 그 자리에서 고친다(v3 — 버튼 없음). Enter 저장 · Esc 취소 · Shift+Enter 줄바꿈. 한글 조합 중 Enter는 넘긴다.
    // 저장이 실패해도 적은 글자는 reportEdits에 남는다.
    const input = reportNode('textarea', undefined, 'rp-ta');
    input.value = reportEdits.get(key);
    input.rows = Math.max(1, Math.min(10, input.value.split('\n').length));
    input.maxLength = 10000;
    input.dataset.editRow = row.id;
    input.setAttribute('aria-label', `보고 문장 고치기 — ${REPORT_EDIT_HINT}`);
    input.addEventListener('input', () => reportEdits.set(key, input.value));
    const cancel = () => { reportEdits.delete(key); renderReportDraft(item); reportEditFocus(row.id); };
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (event.key !== 'Enter' || event.shiftKey || input.disabled) return;
      event.preventDefault();
      if (input.value.trim() === String(row.text ?? '').trim()) { cancel(); return; }
      input.disabled = true;
      reportChange(item, { action: 'edit', id: row.id, text: input.value })
        .then(() => reportEditFocus(row.id))
        .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true))
        .finally(() => { input.disabled = false; });
    });
    text.appendChild(input);
    text.appendChild(reportNode('div', `${REPORT_EDIT_HINT} · Shift+Enter 줄바꿈(둘째 줄부터 슬랙에서 부연)`, 'rp-help'));
    const evidence = reportEvidenceLine(row, rows);
    if (evidence) line.appendChild(evidence);
    host.appendChild(line);
    return;
  }

  // 첫 줄이 문장이고, 둘째 줄부터는 부연이다 — 슬랙에서 들여 쓴 작은 글머리로 들어간다.
  const lines = String(row.text ?? '').split('\n');
  if (reportOptIn(row)) text.appendChild(reportNode('span', REPORT_OPT_IN[row.heading], 'tg'));
  const first = reportNode('span', lines[0], modal ? 'ln' : 'ln rp-edit');
  const tip = reportRowTip(row);
  if (tip) first.title = tip;
  if (!modal) {
    first.tabIndex = 0;
    first.setAttribute('role', 'button');
    first.setAttribute('aria-label', `문장 고치기: ${lines[0]}`);
    first.dataset.editText = row.id;
    first.addEventListener('click', () => reportEditStart(item, row));
    first.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reportEditStart(item, row); }
    });
  }
  text.appendChild(first);
  if (out) text.appendChild(reportNode('span', ' (보고에서 뺌)', 'sr-only'));
  const ask = context.plan ? reportPlanAskNode(item, row) : null;
  if (ask) text.appendChild(ask);
  // 아래로 들어간 문장의 프로젝트가 부모와 다르면 그 이름을 조용히 적는다(문서에서만 — 슬랙에는 안 나간다).
  if (parentRow && reportRowGroup(row) !== reportRowGroup(parentRow)) {
    text.appendChild(reportNode('span', `· ${reportProjectText(reportRowGroup(row))}`, 'pj'));
  }
  if (isNestParent) text.appendChild(reportNode('span', '여기 아래로', 'here'));
  if (isPlaceRow) text.appendChild(reportNode('span', '옮길 문장', 'here'));
  // 접힌 부모는 문장 뒤에 꺾쇠 + `· N건` 버튼이 붙는다 — 누르면 아래 문장이 화면에서만(저장 안 함) 흐린 글자로 펼쳐 보인다.
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
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (peek) reportFoldOpen.delete(row.id); else reportFoldOpen.add(row.id);
      renderReportDraft(item);
    });
    text.appendChild(toggle);
  }
  if (lines.length > 1) {
    const sub = reportNode('div', lines.slice(1).join('\n'), 'sub');
    if (!modal) sub.addEventListener('click', () => reportEditStart(item, row));
    text.appendChild(sub);
  }

  if (!modal) {
    // 줄 끝: (있으면) 알약 하나 + ⋯ 하나. ⋯는 줄에 손이 닿거나 초점이 올 때만 보인다(`.ac`).
    const pill = reportRowPill(item, row);
    if (pill) line.appendChild(pill);
    const actions = reportNode('span', undefined, 'ac');
    actions.appendChild(uiMoreButton(`${lines[0]} — 문장 더 보기`, () => reportSentenceMenuSections(item, row)));
    line.appendChild(actions);
  } else if (canNest || canPlace || foldSelected || foldCandidate) {
    // 모드의 과녁 표시 — 누를 수 있는 줄에 손이 닿거나 초점이 올 때만(줄 전체가 버튼이고 읽기 전용 한 마디다).
    const target = reportNode('span', undefined, 'rp-aim');
    const word = reportNode('span', canNest || canPlace ? '아래로 넣기' : foldSelected ? '고름' : '고르기', foldSelected ? 'd-btn sm acc' : 'd-btn sm');
    word.setAttribute('aria-hidden', 'true');
    target.appendChild(word);
    line.appendChild(target);
  }
  if (picked && !modal) {
    const evidence = reportEvidenceLine(row, rows);
    if (evidence) line.appendChild(evidence);
  }
  host.appendChild(line);

  if (reportEvidenceOpen.has(row.id)) host.appendChild(reportEvidenceBlock(row, rows));
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
  if (reportEdits.has(editKey)) {
    head.appendChild(reportRenameBox(item, {
      editKey, label: '칸 이름', original: REPORT_COLUMN_DEFAULT[key], current: names[key], hint: '다음 주에도 이 이름으로 나와요',
      save: async (value) => { reportColumnSave(key, value); reportEdits.delete(editKey); renderReportDraft(item); },
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
      save: value => reportChange(item, { action: 'rename', heading: REPORT_DONE_HEADING, groupKey: group.key, text: value === auto ? '' : value }),
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
  return !(reportMode !== 'draft' || reportNestParentId !== null || reportFoldIds !== null || reportPlaceId !== null);
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
async function reportAddLineSubmit(item, heading, group, editKey, text) {
  const memo = `${editKey}|${text}`;
  if (!reportAddLineIds.has(memo)) reportAddLineIds.set(memo, reportRequestId());
  try {
    await reportChange(item, { action: 'addLine', heading, groupKey: group.key, text }, undefined, { key: reportAddLineIds.get(memo) });
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
      event.preventDefault(); event.stopPropagation();
      reportEdits.delete(editKey); renderReportDraft(item); reportAddLineFocus(editKey);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.disabled = true;
    reportAddLineSubmit(item, heading, group, editKey, text)
      .then(() => reportAddLineFocus(editKey))
      .catch(error => showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true))
      .finally(() => { input.disabled = false; });
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

// 고르는 목록이라 보이는 글자만 `요약 · 키`(요약 + 오른쪽 조용한 키)로 바꾸고(BKEY 결정, 정렬도 그 글자 기준),
// 저장되는 값은 그대로 원래 이름이다 — 이전에 저장된 문장의 프로젝트와 같은 꼴로 묶이게 한다.
// 앱의 프로젝트 고르기 목록(app.js uiPickList) 모양의 선택지다(순수 함수). 여기는 찾기만 하고 묶음은 없다
// (다음 주 계획은 저장된 이름 문자열 단위라 묶음을 모른다 — 주간요약 묶기는 다른 작업).
function reportPlanPickEntries(current) {
  const names = reportPlanProjectNames();
  if (current && !names.includes(current)) names.unshift(current);
  const sorted = [...names].sort((a, b) => reportPickerLabel(a).localeCompare(reportPickerLabel(b)));
  return [
    { type: 'action', value: '', text: REPORT_NO_PROJECT, selected: !current },
    ...sorted.map((name) => {
      const match = REPORT_JIRA_LABEL.exec(String(name));
      return {
        type: 'option', value: name, text: match ? match[2] : name, key: match ? match[1] : '', level: 0,
        selected: name === current, find: [name, reportPickerLabel(name)],
      };
    }),
  ];
}

// 조용한 고르개 버튼의 얼굴 — 글자(.v) + 꺾쇠(.cv, 누를 수 있어 보이게). 상세 카드 .d-dpick과 같은 모양.
function reportPickFace(pick, text) {
  const value = reportNode('span', text, 'v');
  const caret = reportNode('span', undefined, 'cv');
  caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = uiIcon('chevron');
  pick.replaceChildren(value, caret);
  pick.title = text;
}

// 이미 담긴 계획 문장의 프로젝트를 바꾸는 고르개(문장 ⋯ 메뉴의 필드 줄). 서버는 `regroup`이고
// 프로젝트 이름 검증(`planGroup`)은 담을 때와 같은 길을 쓴다. 버튼을 누르면 그 자리에서 목록(uiPickList —
// 입력줄 앞 고르개와 같은 선택지 reportPlanPickEntries, 찾기만 있고 묶음은 없다)이 펼쳐지고, 고르면 저장하고 메뉴를 닫는다.
function reportPlanRegroupPicker(item, row) {
  const wrap = reportNode('div', undefined, 'rp-regroup');
  const current = String(row.group || '').trim();
  const none = !current || current === REPORT_PLAN_NO_PROJECT
    || current === REPORT_NO_PROJECT_LABEL || current === REPORT_NO_PROJECT;
  const value = none ? '' : current;
  const pick = reportNode('button', undefined, 'd-msel rp-pick');
  pick.type = 'button';
  pick.setAttribute('aria-haspopup', 'listbox');
  const faceText = value ? reportPickerLabel(value) : REPORT_NO_PROJECT;
  reportPickFace(pick, faceText);
  pick.setAttribute('aria-label', `계획 문장 프로젝트: ${faceText} — 바꾸기`);
  let open = false;
  const restore = (focus) => {
    if (open) { open = false; wrap.classList.remove('is-picking'); wrap.replaceChildren(pick); }
    if (focus) pick.focus();
  };
  pick.addEventListener('click', (event) => {
    event.stopPropagation();
    const entries = reportPlanPickEntries(value);
    const list = uiPickList({
      entries,
      label: '계획 문장 프로젝트',
      search: uiPickSearchable(entries),
      onPick: (next) => {
        restore(false);
        if (typeof uiMenuClose === 'function') uiMenuClose();
        reportChange(item, { action: 'regroup', id: row.id, group: next || undefined })
          .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true));
      },
      onClose: byKeyboard => restore(byKeyboard),
    });
    open = true;
    wrap.classList.add('is-picking');
    wrap.replaceChildren(list);
    if (typeof uiPickFit === 'function') uiPickFit(list);
    list.focusStart();
  });
  wrap.appendChild(pick);
  return wrap;
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
async function reportPlanAddOne(item, { text, group }) {
  const before = new Set(((item.draft && item.draft.rows) || []).map(row => row.id));
  await reportChange(item, { action: 'add', text, group: group || undefined }, '할 일 칸에 적었어요');
  if (!group) return;
  const made = ((item.draft && item.draft.rows) || []).find(row => !before.has(row.id) && row.heading === REPORT_PLAN_HEADING);
  if (made) { reportPlanAsk.set(made.id, { taskId: null, idle: false }); reportPlanAskIdle(made.id); }
}

// 여러 줄을 차례로 적는다. 중간에 실패하면 거기서 멈추고 남은 줄을 입력칸에 되돌려 놓는다.
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
      await reportPlanAddOne(item, { text: line.text, group: line.group });
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
      return;
    }
  }
  // 성공한 뒤 늦게 비우지 않는다 — 적는 동안 새로 친 글(reportEdits)은 그대로 다시 그려진다.
  renderReportDraft(item);
  document.getElementById(focusId)?.focus();
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
async function reportPlanTake(item, row) {
  const entry = reportPlanAsk.get(row.id);
  if (!entry) return;
  const taskId = entry.taskId || await reportPlanCreateTask(String(row.text || '').split('\n')[0], row.group);
  if (!taskId) throw new Error('나중에 할 일을 만들지 못했어요. 보고 줄은 그대로 있어요');
  // 업무는 만들었는데 잇기가 실패하면 다시 누를 때 업무를 또 만들지 않는다.
  entry.taskId = taskId;
  await reportChange(item, { action: 'link', id: row.id, planOf: taskId }, '나중에 할 일에도 담았어요');
  entry.idle = false;
  reportPlanAskIdle(row.id);
  reportPlanAskFocus(row.id);
  if (typeof load === 'function') Promise.resolve(load()).catch(() => {});
}
async function reportPlanUntake(item, row) {
  const entry = reportPlanAsk.get(row.id);
  if (!entry) return;
  if (entry.taskId) await request('/api/track/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.taskId }) });
  entry.taskId = null;
  await reportChange(item, { action: 'link', id: row.id, planOf: null }, '나중에 할 일에서 뺐어요');
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
    const title = REPORT_JIRA_LABEL.test(group.name) ? titles.get(group.name) : reportPlanShownName(titles.get(group.name));
    host.appendChild(reportPlanProjectHead(title, group.name));
    for (const row of group.rows) {
      if (reportRowHiddenByFold(item.draft.rows, row)) continue;
      reportSentenceRow(item, row, { host, newIds, plan: true });
    }
    if (current) host.appendChild(reportPlanAddRow(item, group.name, title));
  }
  if (loose || current) host.appendChild(reportNode('div', undefined, 'rp-sep'));
  for (const row of loose ? loose.rows : []) {
    if (reportRowHiddenByFold(item.draft.rows, row)) continue;
    reportSentenceRow(item, row, { host, newIds, plan: true });
  }
  if (current) host.appendChild(reportPlanAddRow(item, null));
  else if (!rows.length) host.appendChild(reportNode('div', '적은 할 일이 없어요.', 'rp-hint'));
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

// 슬랙 카드 맨 위 접힘 한 줄(개편 A) — `보고에 없는 끝낸 일 N · 뺀 문장 N ›`. 누르면 그 자리에서 펼쳐지고(aria-expanded),
// 줄마다 `넣기`(확정한 주에 붙들어 둔 끝낸 일 하나를 새 줄로 — 서버 pullOne) · `되살리기`(뺀 문장 — exclude). 둘 다 0이면 줄이 없다.
// 넣는 것은 사람이 누를 때만이다(확정한 주는 자동 모으기가 문장을 넣지 않는다 — DECISIONS). 옛 서버(material 없음)는 뺀 문장만.
function reportMaterialBlock(item) {
  const report = item.draft;
  const pending = report.material && Array.isArray(report.material.pending) && report.confirmed ? report.material.pending : [];
  // 확정 뒤 새로 들어온 줄 전부(끝낸 일·진행 중·결정 등, 서버의 confirmed.pending — `모두 넣기`(pullNew)가 실제로 넣는 줄 수)와
  // 그중 끝낸 일이 아닌 줄 수. 끝낸 일은 한 줄씩 `넣기`로도 넣고, 나머지는 `모두 넣기`로만 들어간다.
  const fresh = report.confirmed && Number.isFinite(report.confirmed.pending) ? report.confirmed.pending : 0;
  const others = Math.max(0, fresh - (Number.isFinite(report.confirmed && report.confirmed.pendingDone) ? report.confirmed.pendingDone : fresh));
  const excluded = reportExcludedRows(report.rows);
  if (!pending.length && !fresh && !excluded.length) return null;
  const wrap = reportNode('div', undefined, 'rp-flw');
  const newText = pending.length ? `보고에 없는 끝낸 일 ${pending.length}${others ? ` · 새 줄 ${others}` : ''}` : fresh ? `보고에 없는 새 줄 ${fresh}` : '';
  const label = [newText, excluded.length ? `뺀 문장 ${excluded.length}` : ''].filter(Boolean).join(' · ');
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
    body.hidden = !reportMaterialOpen;
  });
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
  if (excluded.length) {
    body.appendChild(reportNode('div', `뺀 문장 ${excluded.length}`, 'g'));
    for (const row of excluded) {
      const line = reportNode('div', undefined, 'mr');
      const first = String(row.text || '').split('\n')[0];
      line.appendChild(reportNode('span', first, 't'));
      line.title = row.text || '';
      const meta = reportNode('span', undefined, 'm');
      const back = reportButton('되살리기', () => reportChange(item, { action: 'exclude', id: row.id }).then(reportMaterialFocus), 'd-link');
      back.setAttribute('aria-label', `${first} — 보고에 되살리기`);
      meta.appendChild(back);
      line.appendChild(meta);
      body.appendChild(line);
    }
  }
  wrap.append(toggle, body);
  return wrap;
}

// 넣기·되살리기 뒤 카드가 다시 그려지면 초점을 접힘 줄로 돌려놓는다(줄이 사라졌으면 그대로 둔다).
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

function renderReportDraft(item) {
  const host = document.getElementById('weeklyReportDetail');
  if (!host) return;
  if (reportRenderedWeek !== item.weekKey) {
    reportNestParentId = null;
    escDrop(reportNestEnd);
    reportPlaceId = null;
    escDrop(reportPlaceEnd);
    reportFoldIds = null;
    reportFoldHeading = null;
    escDrop(reportFoldEnd);
    reportFoldOpen.clear();
    reportEvidenceOpen.clear();
    reportReviewPick = null;
    reportRenderedWeek = item.weekKey;
  }
  reportRenderedItem = item;
  const report = item.draft;
  // 다시 그릴 때마다 모으기 모드가 아직 말이 되는지 확인한다 — 기준 문장이 사라졌거나
  // `전체 업무 기록`으로 옮겼으면 모드는 끝난다(남은 Esc 리스너도 함께 내린다).
  if (reportNestParentId !== null && (reportMode !== 'draft' || !reportNestParent(report))) {
    reportNestParentId = null;
    escDrop(reportNestEnd);
  }
  if (reportPlaceId !== null && (reportMode !== 'draft' || !reportPlaceRow(report))) {
    reportPlaceId = null;
    escDrop(reportPlaceEnd);
  }
  // 한 줄로 모으기 고르기 모드도 같은 이유로 다시 확인한다 — 고른 문장 중 사라졌거나 더 이상
  // 고를 수 없게 된 것은 조용히 뺀다. `전체 업무 기록`으로 옮기면 모드는 끝난다.
  if (reportFoldIds !== null) {
    if (reportMode !== 'draft') { reportFoldIds = null; reportFoldHeading = null; escDrop(reportFoldEnd); }
    else {
      for (const id of [...reportFoldIds]) {
        const found = (report.rows || []).find(candidate => candidate.id === id);
        if (!found || found.excluded || found.parent) reportFoldIds.delete(id);
      }
      if (!reportFoldIds.size) { reportFoldIds = null; reportFoldHeading = null; escDrop(reportFoldEnd); }
    }
  }
  host.dataset.weekKey = item.weekKey;
  host.replaceChildren();

  const newIds = reportMarkSeen(item);
  reportDocHead(item, host);
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

  reportPickBar(item);
  reportPreview(report, item);
}

// ---------- 주차 목록에 끼울 자리('내 일 기록', 그리기는 usage-ui.js) ----------
// app.js의 renderWeeklyReports가 부른다 — usage-ui.js가 없거나 기록이 없으면 null. ① 주차 한 줄의 오른쪽 끝 칸
// (끝낸 일 막대·숫자 자리) ② 주차 목록 칸 맨 아래 한 덩어리. 요소를 돌려주면 그 자리에 붙는다.
function reportWeekRowEnd(item) { return typeof usageWeekRowEnd === 'function' ? usageWeekRowEnd(item) : null; }
function reportWeeksFoot(items) { return typeof usageWeeksFoot === 'function' ? usageWeeksFoot(items) : null; }
