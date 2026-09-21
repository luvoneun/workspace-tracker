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
let reportExcludedOpen = false;

const REPORT_PLAN_HEADING = '다음 주 계획';
// 서버는 프로젝트가 없는 기록을 `그룹 없음`으로 준다 — 화면에서는 다른 목록과 같은 말로 적는다.
// (상태 소제목(`완료한 일` 등)과 슬랙 복사의 `기타`는 서버가 준 말 그대로 두고 건드리지 않는다.)
const REPORT_NO_PROJECT_LABEL = '그룹 없음';
const REPORT_NO_PROJECT = '프로젝트 없음';
// 화면에 적는 프로젝트 이름. 저장 값·서버가 준 값은 그대로 두고 보이는 말만 앱 용어로 옮긴다.
const reportProjectText = (name) => {
  const value = String(name ?? '').trim();
  return !value || value === REPORT_NO_PROJECT_LABEL ? REPORT_NO_PROJECT : value;
};
// 서버가 프로젝트 없이 담은 계획 문장의 그룹 이름(`report-drafts.js`의 add 기본값).
const REPORT_PLAN_NO_PROJECT = '직접 작성';
// 옛 합치기 행(서로 다른 프로젝트의 문장을 한 문장으로 합친 것)에만 남는 그룹 이름.
const REPORT_MULTI_PROJECT = '여러 프로젝트';

// 슬랙에 붙일 구역 — 화면·서버의 상태 이름을 슬랙 글의 구역 이름으로 옮긴다.
// `확인 완료`는 따로 세우지 않고 `완료` 안으로 들어간다.
const REPORT_SLACK_SECTIONS = [
  { name: '완료', headings: ['완료한 일', '확인 완료'] },
  { name: '진행 중', headings: ['진행중'] },
  { name: '결정', headings: ['새로 정해진 것'] },
  { name: '확인 대기', headings: ['확인 대기'] },
  { name: '예정', headings: [REPORT_PLAN_HEADING] },
];
const REPORT_SLACK_ALL = REPORT_SLACK_SECTIONS.map(section => section.name);
const REPORT_SLACK_DEFAULT = ['완료', '진행 중', '예정'];
const REPORT_SLACK_OTHER = '기타';   // 프로젝트가 없는 문장을 모으는 구역 끝 묶음
const REPORT_SLACK_KEY = 'workspace-report-slack-sections';

// 고른 구역은 주차와 상관없이 하나로 기억한다(localStorage가 막혀 있으면 기본값으로 시작).
// `seen`은 한 번이라도 칩으로 보여 준 구역 이름이다 — 처음 보는 구역은 켠 채로 시작하고,
// 사람이 끈 구역은 다음에도 꺼진 채로 둔다(모르는 소제목도 조용히 빠지지 않게).
function reportSlackSectionsLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem(REPORT_SLACK_KEY));
    if (Array.isArray(saved)) return { on: new Set(saved), seen: new Set(REPORT_SLACK_ALL) };
    if (saved && Array.isArray(saved.on)) return { on: new Set(saved.on), seen: new Set(saved.seen || REPORT_SLACK_ALL) };
  } catch {}
  return { on: new Set(REPORT_SLACK_DEFAULT), seen: new Set(REPORT_SLACK_ALL) };
}
function reportSlackSectionsSave() {
  try {
    localStorage.setItem(REPORT_SLACK_KEY, JSON.stringify({ on: [...reportSlackSections], seen: [...reportSlackSeen] }));
  } catch {}
}
const reportSlackSaved = reportSlackSectionsLoad();
let reportSlackSections = reportSlackSaved.on;
let reportSlackSeen = reportSlackSaved.seen;

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

// ---------- 순수 함수: 문서 뼈대와 복사 글자 ----------

// 슬랙 글의 첫 줄. 슬랙에 올라간 글은 나중에 읽히므로 `이번 주` 같은 상대 표현은 쓰지 않는다.
function reportSlackTitle(weekKey) {
  if (!weekKey || typeof formatWeekLabel !== 'function') return '';
  const label = formatWeekLabel(weekKey);
  return `${label.week} (${label.range.replace(/^\d{4}년\s*/, '').replace(/\s*~\s*/, '~')})`;
}

// 모르는 소제목은 버리지 않는다 — 그 이름 그대로의 구역이 된다(조용히 빠지는 문장이 없게).
function reportSlackSectionOf(heading) {
  const known = REPORT_SLACK_SECTIONS.find(section => section.headings.includes(heading));
  return known ? known.name : String(heading || '').trim() || null;
}

// 구역 차례: 아는 구역들 → 모르는 소제목(문서에 나온 차례대로) → `예정`.
function reportSlackSectionNames(report) {
  const extra = [];
  for (const row of (report && report.rows ? report.rows : [])) {
    const name = reportSlackSectionOf(row.heading);
    if (!name || REPORT_SLACK_ALL.includes(name) || extra.includes(name)) continue;
    extra.push(name);
  }
  const last = REPORT_SLACK_ALL[REPORT_SLACK_ALL.length - 1]; // 예정
  return [...REPORT_SLACK_ALL.slice(0, -1), ...extra, last];
}

// 문장이 설 프로젝트 이름. `예정`에서 프로젝트가 없는 문장은 묶지 않고 구역 끝 메모로 보낸다(null).
function reportSlackProjectOf(row, sectionName) {
  const group = String(row.group || '').trim();
  const none = !group || group === REPORT_NO_PROJECT_LABEL || group === REPORT_NO_PROJECT;
  if (sectionName === '예정') return none || group === REPORT_PLAN_NO_PROJECT ? null : group;
  return none ? REPORT_SLACK_OTHER : group;
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

// 슬랙에 붙일 글의 구조(순수 함수). 일반 글자·서식 있는 복사·미리보기가 모두 여기서 나온다.
// `options.sections`는 넣을 구역 이름의 목록이고, 빠뜨리면 기본값(완료·진행 중·예정)이다.
// 규칙: 제외한 문장은 빠짐 · 구역 안에서 같은 프로젝트는 머리 하나 아래로 · 프로젝트 없는 것은 `기타`로
// 구역 끝 · 여러 줄 문장은 둘째 줄부터 부연 · 아래로 들어간 문장의 각 줄도 그 부모의 부연(`◦`)으로 ·
// 내용이 없는 구역은 생략.
function reportSlackModel(report, options = {}) {
  const chosen = new Set(options.sections || REPORT_SLACK_DEFAULT);
  const order = reportSlackSectionNames(report);
  const sections = new Map();
  const rows = report && report.rows ? report.rows : [];
  const children = reportChildRows(rows);
  const linesOf = row => String(row.text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  for (const row of rows) {
    if (row.excluded || reportParentRow(rows, row)) continue;
    const name = reportSlackSectionOf(row.heading);
    if (!name || !chosen.has(name)) continue;
    const lines = linesOf(row);
    if (!lines.length) continue;
    if (!sections.has(name)) sections.set(name, { name, projects: [], memos: [] });
    const section = sections.get(name);
    // 아래로 들어간 문장은 자기 프로젝트가 달라도 부모의 항목 밑 부연으로 붙는다(보이는 대로 나간다).
    const item = { text: lines[0], notes: [...lines.slice(1), ...(children.get(row.id) || []).flatMap(linesOf)] };
    const projectName = reportSlackProjectOf(row, name);
    if (projectName === null) { section.memos.push(item); continue; }
    let project = section.projects.find(entry => entry.name === projectName);
    if (!project) { project = { name: projectName, items: [] }; section.projects.push(project); }
    project.items.push(item);
  }
  for (const section of sections.values()) {
    const index = section.projects.findIndex(project => project.name === REPORT_SLACK_OTHER);
    if (index >= 0) section.projects.push(section.projects.splice(index, 1)[0]);
    reportMultiProjectLast(section.projects, project => project.name, project => project.name === REPORT_SLACK_OTHER);
  }
  return {
    title: reportSlackTitle(report && report.weekKey),
    sections: order.map(name => sections.get(name)).filter(section => section && (section.projects.length || section.memos.length)),
  };
}

// 한 줄씩 풀어 놓은 모양. 일반 글자와 미리보기가 같은 글자를 쓰게 하는 가운데 단계다
// (미리보기를 직접 선택해 복사해도 아래 `reportSlackText`와 같은 글자가 나온다).
// 슬랙에 나가는 구역 제목은 `[완료]` `[진행중]` `[예정]` 꼴이다(사용자가 올리는 글의 모양). 구역을 고르는
// 칩과 저장된 선택은 이름 그대로(`진행 중`)를 쓴다 — 바뀌는 것은 나가는 글자뿐이다.
function reportSlackSectionLabel(name) {
  return `[${name === '진행 중' ? '진행중' : name}]`;
}
function reportSlackLines(model) {
  const lines = [];
  if (!model || !model.sections.length) return lines;
  if (model.title) lines.push({ kind: 'title', text: model.title }, { kind: 'gap', text: '' });
  model.sections.forEach((section, index) => {
    if (index) lines.push({ kind: 'gap', text: '' });
    lines.push({ kind: 'section', text: reportSlackSectionLabel(section.name) });
    for (const project of section.projects) {
      lines.push({ kind: 'project', text: project.name });
      for (const item of project.items) {
        lines.push({ kind: 'item', text: `• ${item.text}` });
        for (const note of item.notes) lines.push({ kind: 'note', text: `    ◦ ${note}` });
      }
    }
    for (const memo of section.memos) {
      lines.push({ kind: 'memo', text: `* ${memo.text}` });
      for (const note of memo.notes) lines.push({ kind: 'note', text: `    ◦ ${note}` });
    }
  });
  return lines;
}

// 서식 없는 곳에 붙을 글자. 형식을 바꾸면 사용자의 슬랙 글 모양이 바뀐다(테스트가 고정한다).
function reportSlackText(model) {
  return reportSlackLines(model).map(line => line.text).join('\n');
}

// 서식 있는 복사. 슬랙 입력창에 붙이면 굵은 제목과 글머리 목록이 된다. 사용자 문구는 전부 escape한다.
function reportSlackHtml(model) {
  if (!model || !model.sections.length) return '';
  const bold = text => `<p><b>${escapeHtml(text)}</b></p>`;
  const notes = list => list.length ? `<ul>${list.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : '';
  const html = [];
  if (model.title) html.push(bold(model.title));
  for (const section of model.sections) {
    html.push(bold(reportSlackSectionLabel(section.name)));
    for (const project of section.projects) {
      html.push(bold(project.name));
      html.push(`<ul>${project.items.map(item => `<li>${escapeHtml(item.text)}${notes(item.notes)}</li>`).join('')}</ul>`);
    }
    for (const memo of section.memos) html.push(`<p>* ${escapeHtml(memo.text)}</p>${notes(memo.notes)}`);
  }
  return html.join('');
}

// 문서의 뼈대: 상태(서버가 준 순서) → 프로젝트 → 문장.
// 제외한 문장과 다음 주 계획은 문서 끝에 따로 모이므로 여기서는 빠진다.
// 다른 문장 아래로 들어간 문장은 자기 프로젝트가 달라도 **부모의 프로젝트** 아래, 부모 바로 뒤에 선다.
function reportDocSections(rows) {
  const sections = [];
  const byHeading = new Map();
  const children = reportChildRows(rows);
  for (const row of rows || []) {
    if (row.excluded || row.heading === REPORT_PLAN_HEADING) continue;
    if (reportParentRow(rows, row)) continue;
    if (!byHeading.has(row.heading)) {
      const section = { heading: row.heading, groups: [] };
      byHeading.set(row.heading, section);
      sections.push(section);
    }
    const section = byHeading.get(row.heading);
    let group = section.groups.find(entry => entry.group === row.group);
    if (!group) { group = { group: row.group, rows: [] }; section.groups.push(group); }
    group.rows.push(row, ...(children.get(row.id) || []));
  }
  for (const section of sections) {
    reportMultiProjectLast(section.groups, group => group.group, group => reportProjectText(group.group) === REPORT_NO_PROJECT);
  }
  return sections;
}

// 다음 주 계획은 사람이 직접 쓴 문장만 들어간다(DECISIONS) — 자동으로 채우지 않는다.
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

function reportExcludedRows(rows) {
  return (rows || []).filter(row => row.excluded);
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

async function reportChange(item, action, notice) {
  if (reportBusy) return;
  reportBusy = true;
  try {
    const response = await fetch('/api/report/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    // `add`로 적던 글을 비우는 것은 입력칸을 들고 있는 쪽(reportPlanAddLines)이 한다 —
    // 다른 입력줄(프로젝트 소제목의 `+ 추가`)에서 담았는데 맨 아래 줄의 글이 날아가면 안 된다.
    reportUndo.set(item.weekKey, result.undoToken);
    item.draft = result.report;
    const cached = weeklyReportsCache.find(entry => entry.weekKey === item.weekKey);
    if (cached) cached.draft = result.report;
  } finally { reportBusy = false; }
  renderReportDraft(item);
  reportSavedNotice(item, action, notice);
}

// 저장 뒤 알림 하나. 자리를 옮기는 변경(아래로 넣기·따로 빼기·옛 묶기·묶음 풀기)은 무엇이 바뀌었는지
// 적고 그 자리에서 `되돌리기`까지 준다(머리줄의 `되돌리기`와 같은 길이다). 나머지는 예전 문구 그대로다.
const REPORT_MOVE_NOTICE = {
  nest: '문장을 아래로 넣었어요',
  unnest: '따로 뺐어요',
  split: '묶음을 풀었어요',
  regroup: '프로젝트를 바꿨어요',
};
// `notice`를 주면 그 문구만 조용히 알린다(다음 주 계획 담기처럼 무엇을 했는지 문구가 이미 다 말하는 자리).
function reportSavedNotice(item, action, notice) {
  if (action.action === 'undo') { announce('되돌렸어요'); return; }
  if (notice) { announce(notice); return; }
  const message = action.action === 'merge'
    ? `문장 ${action.ids.length}개를 묶었어요`
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

function reportNestBar(item) {
  const bar = document.getElementById('reportNestBarEl');
  if (!bar) return;
  const parent = reportNestParent(item.draft);
  const open = !!parent && reportMode === 'draft';
  document.body.classList.toggle('nest-open', open);
  bar.hidden = !open;
  bar.replaceChildren();
  if (!open) return;
  const inner = reportNode('div', undefined, 'bar');
  inner.appendChild(reportNode('span', `「${reportNestLabel(parent.text)}」 아래로`, 'ct'));
  inner.appendChild(reportNode('span', '넣을 문장을 눌러 주세요', 'rp-hint'));
  inner.appendChild(reportNode('span', undefined, 'sp'));
  inner.appendChild(reportButton('완료', () => reportNestEnd(), 'd-btn pri'));
  bar.appendChild(inner);
}

// ---------- 문서의 부품 ----------

function reportDocHead(item, host) {
  const report = item.draft;
  const label = formatWeekLabel(item.weekKey);
  const head = reportNode('div', undefined, 'd-lhd rp-hd');
  head.appendChild(reportNode('h2', reportWeekName(item.weekKey), 'rp-title'));
  head.appendChild(reportNode('span', label.range, 'sub'));

  const seg = reportNode('span', undefined, 'd-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '주간요약 보기');
  for (const [mode, text] of [['draft', '보고'], ['records', '전체 업무 기록']]) {
    const button = reportButton(text, () => { reportMode = mode; renderReportDraft(item); }, '');
    button.setAttribute('aria-pressed', String(reportMode === mode));
    seg.appendChild(button);
  }
  head.append(seg, reportNode('span', undefined, 'sp'));
  // 머리줄의 동작 버튼은 한 묶음이다 — 자리가 모자라면 묶음째 다음 줄 오른쪽으로 내려간다(하나만 떨어져 나가지 않게).
  const acts = reportNode('span', undefined, 'rp-acts');

  if (reportUndo.has(item.weekKey)) {
    acts.appendChild(reportButton('되돌리기', () => reportChange(item, { action: 'undo', token: reportUndo.get(item.weekKey) })));
  }
  // 금요일에 가장 먼저 하는 일이 계획 쓰기다 — 긴 문서를 훑지 않고 바로 그 자리로 데려간다(이번 주만).
  if (reportPlanIsCurrentWeek(item.weekKey)) {
    acts.appendChild(reportButton('다음 주 계획 쓰기', () => {
      const input = document.getElementById('reportPlanInput');
      if (!input) return;
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus();
    }));
  }
  // 한 화면에 채운 버튼은 이것 하나다.
  acts.appendChild(reportButton('슬랙용으로 복사', async () => {
    if ([...reportEdits.keys()].some(key => key.startsWith(item.weekKey + ':'))) {
      throw new Error('수정 중인 문장을 저장하거나 취소한 뒤 복사해 주세요.');
    }
    try {
      await reportSlackCopy(reportSlackModel(report, { sections: [...reportSlackSections] }));
      announce('슬랙에 붙여 넣을 수 있게 복사했어요');
    } catch {
      reportSelectPreview();
      throw new Error('복사 미리보기의 내용을 직접 선택해 복사해 주세요.');
    }
  }, 'd-btn pri'));
  head.appendChild(acts);
  host.appendChild(head);
}

// 머리줄 아래 조용한 한 줄. 확인이 필요한 문장이 있으면 그 자리로 데려간다.
function reportDocSummary(item, host, newIds) {
  const report = item.draft;
  const line = reportNode('div', undefined, 'rp-sum');
  const kept = report.rows.filter(row => !row.excluded).length;
  const pending = report.rows.filter(row => row.needsReview).length;
  line.appendChild(reportNode('span', `보고 ${kept}문장 · 근거 업무 ${reportSourceIds(report).length}개${newIds.size ? ` · 새 기록 ${newIds.size}개` : ''}`));
  if (pending) {
    const jump = reportButton(`확인 필요 ${pending}개`, () => {
      reportMode = 'draft';
      renderReportDraft(item);
      document.getElementById('weeklyReportDetail')?.querySelector('[data-review="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 'd-link');
    line.appendChild(jump);
  }
  host.appendChild(line);
}

// 근거 업무: 문장 아래 들여 쓴 목록. 줄을 누르면 그 줄 옆에 상세 카드가 열린다.
function reportEvidenceBlock(row) {
  const list = reportNode('div', undefined, 'rp-ev');
  const sources = row.currentEvidence || row.evidence || [];
  if (!sources.length) {
    list.appendChild(reportNode('div', '기존 보고 문장 · 연결된 원본 없음', 'none'));
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

// 원본이 바뀌었을 때의 수정 제안. 지금 문장은 덮어쓰지 않고 사람이 고른다(DECISIONS).
function reportSuggestionBlock(item, row) {
  const suggestion = row.suggestion;
  const box = reportNode('div', undefined, 'rp-sg');
  box.appendChild(reportNode('div', suggestion.added ? `원본이 바뀌었어요 · 새 관련 업무 ${suggestion.added}개` : '원본이 바뀌었어요', 'hd'));
  box.appendChild(reportNode('div', suggestion.text || '연결된 원본을 찾지 못했어요.', 'tx'));
  const actions = reportNode('div', undefined, 'ac');
  if (!suggestion.missing && !suggestion.mixed) {
    actions.appendChild(reportButton('적용', () => reportChange(item, { action: 'accept', id: row.id }), 'd-btn sm'));
  }
  actions.appendChild(reportButton('그대로 두기', () => reportChange(item, { action: 'acknowledge', id: row.id }), 'd-btn sm'));
  box.appendChild(actions);
  box.appendChild(reportNode('div', suggestion.mixed || suggestion.missing
    ? '원본 상태가 다르거나 삭제된 업무가 있어요. 문장을 직접 확인해 주세요.'
    : '지금 문장은 그대로 둬요.', 'hint'));
  return box;
}

// 문장 줄의 ⋯ 메뉴. `이 아래로 문장 모으기`는 최상위·제외되지 않은 문장에만 붙는다(아래로 들어간
// 문장은 `따로 빼기`로 먼저 나와야 한다 — 한 단계까지만 들어간다).
// `묶음 풀기`는 서버가 묶기 전 문장을 들고 있는 옛 합치기 행에만 붙는다(`canSplit`).
function reportSentenceMenuSections(item, row) {
  return [
    [
      row.sourceIds.length ? {
        label: reportEvidenceOpen.has(row.id) ? '근거 업무 숨기기' : '근거 업무 보기',
        onClick: () => {
          if (reportEvidenceOpen.has(row.id)) reportEvidenceOpen.delete(row.id); else reportEvidenceOpen.add(row.id);
          renderReportDraft(item);
        },
      } : null,
      !row.parent && !row.excluded ? { label: '이 아래로 문장 모으기', onClick: () => reportNestStart(item, row) } : null,
      row.parent ? { label: '따로 빼기', onClick: () => reportChange(item, { action: 'unnest', id: row.id }) } : null,
      row.canSplit ? { label: '묶음 풀기', onClick: () => reportChange(item, { action: 'split', id: row.id }) } : null,
    ].filter(Boolean),
    // 계획 문장만 프로젝트를 나중에 바꾼다(다른 구역의 프로젝트는 원본 업무가 정한다).
    row.heading === REPORT_PLAN_HEADING
      ? [{ field: '프로젝트 바꾸기', control: reportPlanRegroupPicker(item, row) }]
      : null,
  ].filter(section => section && section.length);
}

// 문장 한 줄. 동작(수정·제외·따로 빼기·더보기)은 hover·focus에서만 보인다.
// 다른 문장 아래로 들어간 문장은 한 단계 들여 쓴 `◦` 줄이고, 모으기 모드에서는 넣을 수 있는 문장만
// 밝게 서서 눌리는 과녁이 된다(누르는 즉시 들어간다).
function reportSentenceRow(item, row, context) {
  const host = context.host;
  const newIds = context.newIds || new Set();
  const key = `${item.weekKey}:${row.id}`;
  const rows = item.draft.rows || [];
  const parentRow = reportParentRow(rows, row);
  const line = reportNode('div', undefined, 'rp-s' + (parentRow ? ' is-sub' : ''));
  if (row.needsReview) line.dataset.review = 'true';

  const nestParent = reportNestParent(item.draft);
  const nesting = !!nestParent && reportMode === 'draft';
  const isNestParent = nesting && row.id === nestParent.id;
  const canNest = nesting && !reportEdits.has(key) && reportCanNest(rows, row, nestParent);
  if (isNestParent) line.classList.add('is-nest');
  else if (nesting && !canNest) line.classList.add('is-off');
  if (canNest) {
    line.classList.add('is-pick');
    line.tabIndex = 0;
    line.setAttribute('role', 'button');
    line.setAttribute('aria-label', `${row.text} — 「${reportNestLabel(nestParent.text)}」 아래로 넣기`);
    const nest = () => reportChange(item, { action: 'nest', id: row.id, parentId: nestParent.id })
      .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true));
    line.addEventListener('click', nest);
    line.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nest(); }
    });
  }
  line.appendChild(reportNode('span', parentRow ? '◦' : '•', 'bu'));

  const text = reportNode('div', undefined, 'tx');
  line.appendChild(text);

  if (reportEdits.has(key)) {
    // 그 자리에서 고친다. 저장이 실패해도 적은 글자는 reportEdits에 남는다.
    const input = reportNode('textarea', undefined, 'rp-ta');
    input.value = reportEdits.get(key);
    input.rows = Math.max(2, Math.min(10, input.value.split('\n').length + 1));
    input.maxLength = 10000;
    input.dataset.editRow = row.id;
    input.setAttribute('aria-label', '보고 문장 수정');
    input.addEventListener('input', () => reportEdits.set(key, input.value));
    text.appendChild(input);
    // Enter는 줄바꿈이다(저장은 아래 버튼) — 둘째 줄이 슬랙에서 어떻게 보이는지 조용히 알려 준다.
    text.appendChild(reportNode('div', '둘째 줄부터는 슬랙에서 들여 쓴 부연으로 들어가요', 'rp-help'));
    const actions = reportNode('div', undefined, 'ed');
    actions.append(
      reportButton('저장', () => reportChange(item, { action: 'edit', id: row.id, text: input.value }), 'd-btn pri'),
      reportButton('취소', () => { reportEdits.delete(key); renderReportDraft(item); }),
    );
    text.appendChild(actions);
    host.appendChild(line);
    return;
  }

  // 첫 줄이 문장이고, 둘째 줄부터는 부연이다 — 슬랙에서 들여 쓴 작은 글머리로 들어간다.
  const lines = String(row.text ?? '').split('\n');
  text.appendChild(reportNode('span', lines[0], 'ln'));
  // 아래로 들어간 문장의 프로젝트가 부모와 다르면 그 이름을 조용히 적는다(문서에서만 — 슬랙에는 안 나간다).
  if (parentRow && row.group !== parentRow.group) {
    text.appendChild(reportNode('span', `· ${reportProjectText(row.group)}`, 'pj'));
  }
  if (isNestParent) text.appendChild(reportNode('span', '여기 아래로', 'here'));
  // 손으로 고친 문장에만 조용한 이름표를 붙인다. `자동 초안`은 찍지 않는다.
  if (row.locked && !context.plan) text.appendChild(reportNode('span', '직접 수정', 'edt'));
  if (row.needsReview && !row.suggestion) text.appendChild(reportNode('span', '원본 확인 필요', 'rv'));
  const rowNew = row.sourceIds.filter(id => newIds.has(id)).length;
  if (rowNew) text.appendChild(reportNode('span', `새 기록 ${rowNew}`, 'nw'));
  if (lines.length > 1) text.appendChild(reportNode('div', lines.slice(1).join('\n'), 'sub'));

  // 모으기 모드에서는 줄을 누르는 것이 "넣기"다 — 수정·제외·⋯과 헷갈리지 않게 그동안은 감춘다.
  if (!nesting) {
    const actions = reportNode('span', undefined, 'ac');
    actions.appendChild(reportButton('수정', () => {
      reportEdits.set(key, row.text);
      renderReportDraft(item);
      document.getElementById('weeklyReportDetail')?.querySelector(`[data-edit-row="${row.id}"]`)?.focus();
    }, 'd-btn sm'));
    actions.appendChild(reportButton('제외', () => reportChange(item, { action: 'exclude', id: row.id }), 'd-btn sm'));
    if (parentRow) {
      actions.appendChild(reportButton('따로 빼기', () => reportChange(item, { action: 'unnest', id: row.id }), 'd-btn sm'));
    }
    actions.appendChild(uiMoreButton(`${reportProjectText(row.group)} 문장 더보기`, () => reportSentenceMenuSections(item, row)));
    line.appendChild(actions);
  }
  host.appendChild(line);

  if (reportEvidenceOpen.has(row.id)) host.appendChild(reportEvidenceBlock(row));
  if (row.suggestion) host.appendChild(reportSuggestionBlock(item, row));
}

// 제외한 문장은 문서 끝(다음 주 계획 위)에 접어 둔다 — 복사에서는 빠진다.
function reportExcludedBlock(item, host) {
  const rows = reportExcludedRows(item.draft.rows);
  if (!rows.length) return;
  const box = reportNode('details', undefined, 'rp-ex');
  box.open = reportExcludedOpen;
  box.addEventListener('toggle', () => { reportExcludedOpen = box.open; });
  box.appendChild(reportNode('summary', `제외한 문장 ${rows.length}개`));
  for (const row of rows) {
    const line = reportNode('div', undefined, 'row');
    line.append(
      reportNode('span', row.text, 'tx'),
      reportButton('복원', () => reportChange(item, { action: 'exclude', id: row.id }), 'd-btn sm'),
    );
    box.appendChild(line);
  }
  host.appendChild(box);
}

// 계획 문장에 붙일 프로젝트 — 앱의 다른 프로젝트 선택과 같은 목록(그룹 + 지라)을 쓴다.
// 저장되는 값은 화면에 보이는 이름 그대로다(슬랙 글에 그 이름이 그대로 올라간다).
let reportPlanGroup = '';

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

function reportPlanProjectPicker() {
  const pick = reportNode('select', undefined, 'd-msel rp-pick');
  pick.setAttribute('aria-label', '다음 주 계획 프로젝트');
  const names = reportPlanProjectNames();
  if (reportPlanGroup && !names.includes(reportPlanGroup)) names.unshift(reportPlanGroup);
  for (const [value, text] of [['', REPORT_NO_PROJECT], ...names.map(name => [name, name])]) {
    const option = reportNode('option', text);
    option.value = value;
    if (value === reportPlanGroup) option.selected = true;
    pick.appendChild(option);
  }
  pick.addEventListener('change', () => { reportPlanGroup = pick.value; });
  return pick;
}

// 이미 담긴 계획 문장의 프로젝트를 바꾸는 고르개(문장 ⋯ 메뉴의 필드 줄). 서버는 `regroup`이고
// 프로젝트 이름 검증(`planGroup`)은 담을 때와 같은 길을 쓴다.
function reportPlanRegroupPicker(item, row) {
  const pick = reportNode('select', undefined, 'd-msel');
  pick.setAttribute('aria-label', '계획 문장 프로젝트 바꾸기');
  const current = String(row.group || '').trim();
  const none = !current || current === REPORT_PLAN_NO_PROJECT
    || current === REPORT_NO_PROJECT_LABEL || current === REPORT_NO_PROJECT;
  const names = reportPlanProjectNames();
  // 지금 붙어 있는 이름이 목록에 없으면(프로젝트가 비었거나 이름이 바뀐 뒤) 그 이름을 맨 앞에 남긴다.
  if (!none && !names.includes(current)) names.unshift(current);
  for (const [value, text] of [['', REPORT_NO_PROJECT], ...names.map(name => [name, name])]) {
    const option = reportNode('option', text);
    option.value = value;
    if (none ? value === '' : value === current) option.selected = true;
    pick.appendChild(option);
  }
  pick.addEventListener('change', () => {
    if (typeof uiMenuClose === 'function') uiMenuClose();
    reportChange(item, { action: 'regroup', id: row.id, group: pick.value || undefined })
      .catch(error => showNotice(error.message || '저장하지 못했어요. 적은 내용은 그대로 있어요', true));
  });
  return pick;
}

// ---------- 다음 주 계획: 후보에서 담기 · 직접 쓰기 ----------
// DECISIONS("다음 주 계획은 사람이 직접 쓴다")는 그대로다 — 앱은 후보를 보여 줄 뿐이고,
// 담기는 사람이 누른 것만이다. 후보 목록은 화면이 이미 들고 있는 업무 목록(`taskListsCache`)을 쓴다:
// 새 API를 만들지 않는다.

const REPORT_PLAN_TASK_KEY = 'workspace-report-plan-also-task';
const REPORT_PLAN_MAX_LINES = 20;        // 여러 줄 붙여넣기의 상한
const REPORT_PLAN_BOTTOM_KEY = 'new';    // 맨 아래 입력줄의 `reportEdits` 열쇠(기존 값 그대로)

// `나중에 할 일에도 추가` 토글은 기본 켜짐이고 브라우저에 기억한다(막혀 있으면 기본값으로 시작).
function reportPlanAlsoTaskLoad() {
  try {
    const saved = localStorage.getItem(REPORT_PLAN_TASK_KEY);
    if (saved === '0') return false;
  } catch {}
  return true;
}
let reportPlanAlsoTask = reportPlanAlsoTaskLoad();
let reportPlanLaterOpen = false;  // `나중에 할 일에서 고르기`를 펼쳐 뒀는지
let reportPlanLaterQuery = '';    // 그 목록의 거르기 글자
// 업무는 만들어졌는데 문장 추가가 실패했을 때, 다시 시도가 업무를 또 만들지 않도록 붙들어 두는 자리.
// 열쇠는 주차 + 프로젝트 + 글이다(성공하면 바로 비운다 — 같은 글을 일부러 두 번 담는 길은 막지 않는다).
const reportPlanMade = new Map();

// 이번 주 보고에서만 후보·직접 쓰기의 업무 만들기를 연다(지난 주차는 기존 입력줄만).
function reportPlanIsCurrentWeek(weekKey) {
  if (typeof todayStr !== 'function') return false;
  const monday = new Date(`${todayStr()}T12:00:00`);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  return key === weekKey;
}

// 화면이 이미 들고 있는 업무 목록. 없으면(다른 화면·테스트) 빈 목록으로 조용히 넘어간다.
function reportPlanTaskLists() {
  const lists = typeof taskListsCache === 'object' && taskListsCache ? taskListsCache : null;
  return { today: (lists && lists.todayTasks) || [], later: (lists && lists.laterTasks) || [] };
}
// 후보는 미완료 업무 전부다(진행 중 포함). 완료한 것은 빠지고, `새로 들어온 것`은 애초에 이 목록에 없다.
function reportPlanOpenTasks(items) {
  return (items || []).filter(item => item && item.status !== 'done');
}

// 후보를 담을 때 문장에 붙일 프로젝트 이름 — 계획 문장이 쓰는 이름과 같은 꼴이어야
// 문서에서 같은 소제목 아래로 모인다(지라는 `KEY · 요약`, 길면 키만).
function reportPlanTaskGroup(task) {
  if (!task) return '';
  if (task.jira) {
    const issue = typeof jiraIssuesByKey !== 'undefined' && jiraIssuesByKey && jiraIssuesByKey.get
      ? jiraIssuesByKey.get(task.jira) : null;
    return reportPlanJiraName(task.jira, issue ? issue.summary : '');
  }
  const name = String(task.group || task.project || '').trim();
  return name && name.length <= REPORT_PLAN_NAME_MAX ? name : '';
}

// 프로젝트 이름 → 업무를 만들 때 보낼 값. 지라 이름(`KEY · 요약`)은 지라 키로 되돌린다.
function reportPlanJiraKeyOf(name) {
  const value = String(name || '').trim();
  if (!value || typeof jiraIssuesCache === 'undefined' || !Array.isArray(jiraIssuesCache)) return null;
  const issue = jiraIssuesCache.find(entry => reportPlanJiraName(entry.key, entry.summary) === value || entry.key === value);
  return issue ? issue.key : null;
}

// 이미 담은 후보는 다시 담지 않는다 — 판정은 계획 행에 저장된 연결(`planOf`)로 하고 글자를 비교하지 않는다.
// 제외해 둔 계획 문장도 문서에 남아 있으므로(복원할 수 있다) 담은 것으로 본다.
function reportPlanClaimed(rows) {
  return new Set((rows || [])
    .filter(row => row.heading === REPORT_PLAN_HEADING && typeof row.planOf === 'string' && row.planOf)
    .map(row => row.planOf));
}

// 후보 한 줄: 제목(말줄임) + 조용한 기한 + 오른쪽 `+ 담기`. 담은 뒤에는 흐리게 + `담음`.
function reportPlanCandidateRow(item, task, groupName, claimed) {
  const line = reportNode('div', undefined, 'rp-cand' + (claimed ? ' is-in' : ''));
  const title = reportNode('span', task.description, 'ti');
  title.title = task.description;
  line.appendChild(title);
  const due = typeof uiDueText === 'function' ? uiDueText(task.due, 'full') : null;
  line.appendChild(reportNode('span', due ? due.text : '', 'mt'));
  if (claimed) {
    // 담기 버튼과 같은 자리·같은 크기로 선다 — 담을 때마다 줄 높이와 오른쪽 끝이 흔들리지 않게.
    const done = reportNode('span', undefined, 'rp-in');
    done.innerHTML = uiIcon('check');
    done.appendChild(reportNode('span', '담음', 'in'));
    line.appendChild(done);
    return line;
  }
  // 담아도 업무 자체는 바뀌지 않는다(언제 할지·상태 그대로) — 계획 문장만 하나 는다.
  line.appendChild(reportButton('+ 담기', () => reportChange(item, {
    action: 'add', text: task.description, group: groupName || undefined, planOf: task.id,
  }, '다음 주 계획에 넣었어요'), 'd-btn sm rp-take'));
  return line;
}

// 후보 목록을 프로젝트별로 그린다(목록의 프로젝트 묶기·제목 부품을 그대로 쓴다).
function reportPlanCandidateList(item, host, tasks, claimed) {
  host.replaceChildren();
  const groups = typeof uiGroupTasks === 'function' ? uiGroupTasks(tasks) : [['__misc__', tasks]];
  for (const [key, groupTasks] of groups) {
    const label = typeof uiGroupLabel === 'function' ? uiGroupLabel(key) : REPORT_NO_PROJECT;
    // 오늘 목록의 그룹 제목과 같은 말투(색 점 + 이름 + 개수) — 프로젝트가 한 덩어리로 뭉쳐 보이지 않게.
    const head = reportNode('div', undefined, 'rp-candpj');
    if (key !== '__misc__' && typeof uiProjectDot === 'function') head.appendChild(uiProjectDot(label));
    head.appendChild(reportNode('span', label, 'pjn'));
    head.appendChild(reportNode('span', String(groupTasks.length), 'n num'));
    host.appendChild(head);
    const name = reportPlanTaskGroup(groupTasks[0]);
    for (const task of groupTasks) {
      host.appendChild(reportPlanCandidateRow(item, task, name, claimed.has(task.id)));
    }
  }
  if (!tasks.length) host.appendChild(reportNode('div', '고를 업무가 없어요.', 'rp-hint'));
}

// `다음 주 후보` 구역 — 담은 문장들 아래에 선다. 고를 것이 아무것도 없으면 그리지 않는다.
function reportPlanCandidateSection(item, host) {
  const lists = reportPlanTaskLists();
  const today = reportPlanOpenTasks(lists.today);
  const later = reportPlanOpenTasks(lists.later);
  if (!today.length && !later.length) return;
  const claimed = reportPlanClaimed(item.draft.rows);

  const head = reportNode('div', undefined, 'rp-candhd');
  head.appendChild(reportNode('span', '다음 주 후보', 'hd'));
  head.appendChild(reportNode('span', undefined, 'sp'));
  const pick = reportNode('button', '나중에 할 일에서 고르기', 'd-btn sm');
  pick.type = 'button';
  pick.setAttribute('aria-pressed', String(reportPlanLaterOpen));
  pick.addEventListener('click', () => {
    reportPlanLaterOpen = !reportPlanLaterOpen;
    reportPlanLaterQuery = '';
    renderReportDraft(item);
  });
  head.appendChild(pick);
  host.appendChild(head);

  const list = reportNode('div', undefined, 'rp-cands' + (reportPlanLaterOpen ? ' is-scroll' : ''));
  if (!reportPlanLaterOpen) {
    if (!today.length) {
      host.appendChild(reportNode('div', '오늘 할 일에 남은 업무가 없어요. 나중에 할 일에서 고를 수 있어요.', 'rp-hint'));
      return;
    }
    reportPlanCandidateList(item, list, today, claimed);
    host.appendChild(list);
    return;
  }
  // 나중에 할 일은 많을 수 있다 — 위에 작은 거르기 칸을 두고 목록은 구역 안에서 스크롤한다.
  const filter = reportNode('input', undefined, 'rp-candfilter');
  filter.type = 'text';
  filter.id = 'reportPlanFilter';
  filter.placeholder = '나중에 할 일 거르기';
  filter.setAttribute('aria-label', '나중에 할 일 거르기');
  filter.value = reportPlanLaterQuery;
  const draw = () => {
    const needle = reportPlanLaterQuery.trim().toLowerCase();
    reportPlanCandidateList(item, list, needle
      ? later.filter(task => String(task.description || '').toLowerCase().includes(needle)
        || reportPlanTaskGroup(task).toLowerCase().includes(needle))
      : later, claimed);
  };
  // 글자를 칠 때는 목록만 다시 만든다 — 문서 전체를 다시 그리면 치던 글과 초점이 날아간다.
  filter.addEventListener('input', () => { reportPlanLaterQuery = filter.value; draw(); });
  host.append(filter, list);
  draw();
}

// ---------- 직접 쓰기(+ 나중에 할 일에도) ----------

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

// 문장 하나를 담는다. 순서는 업무 만들기 → 그 id를 `planOf`로 계획 문장 추가다.
// 업무는 만들어졌는데 문장 추가가 실패하면 만든 id를 붙들어 둔다 — 다시 시도는 문장 추가만 한다.
async function reportPlanAddOne(item, { text, group, alsoTask }) {
  const memo = `${item.weekKey}|${group || ''}|${text}`;
  let link = reportPlanMade.get(memo) || null;
  let made = false;
  if (alsoTask && !link) { link = await reportPlanCreateTask(text, group); made = true; }
  if (link) reportPlanMade.set(memo, link);
  await reportChange(item, { action: 'add', text, group: group || undefined, planOf: link || undefined },
    link ? '다음 주 계획에 넣었어요 · 나중에 할 일에도 추가했어요' : '다음 주 계획에 넣었어요');
  reportPlanMade.delete(memo);
  return made;
}

// 여러 줄을 차례로 담는다. 중간에 실패하면 거기서 멈추고 남은 줄을 입력칸에 되돌려 놓는다.
async function reportPlanAddLines(item, lines, { key, group, alsoTask, focusId }) {
  const names = reportPlanProjectNames();
  let madeTask = false;
  // 담는 동안 입력칸은 비워 둔다 — 실패하면 남은 줄을 그 자리에 되돌려 놓는다.
  reportEdits.delete(`${item.weekKey}:${key}`);
  for (let index = 0; index < lines.length; index += 1) {
    const line = reportPlanSplitPrefix(lines[index], names, group);
    try {
      madeTask = (await reportPlanAddOne(item, { text: line.text, group: line.group, alsoTask })) || madeTask;
    } catch (error) {
      reportEdits.set(`${item.weekKey}:${key}`, lines.slice(index).join('\n'));
      if (madeTask) await load();
      renderReportDraft(item);
      document.getElementById(focusId)?.focus();
      showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true);
      return;
    }
  }
  reportEdits.delete(`${item.weekKey}:${key}`);
  // 만든 업무가 `나중에 할 일` 서랍과 후보 목록에 바로 보이게 목록을 다시 받는다.
  if (madeTask) await load();
  renderReportDraft(item);
  // 다시 그려져도 같은 줄로 돌아온다 — 적던 글이 비어 접힌 `+ 추가` 줄은 다시 열어 준다
  // (오늘 목록의 `+ 이 그룹에 추가`와 같은 포커스 복원).
  const next = document.getElementById(focusId);
  const row = next && next.closest ? next.closest('.rp-add') : null;
  if (row) row.hidden = false;
  next?.focus();
}

// 계획 문장 입력칸 한 벌 — 맨 아래 입력줄과 프로젝트 소제목의 `+ 추가`가 같은 길을 쓴다.
// 평소에는 한 줄 입력이고, 여러 줄 붙여넣기가 중간에 실패해 남은 줄을 돌려놓을 때만 여러 줄 칸이 된다.
function reportPlanInput(item, { key, id, placeholder, label, groupOf, alsoTaskOf }) {
  const full = `${item.weekKey}:${key}`;
  const draft = reportEdits.get(full) || '';
  const multi = draft.includes('\n');
  const el = reportNode(multi ? 'textarea' : 'input', undefined, multi ? 'rp-addmulti' : '');
  if (!multi) el.type = 'text';
  else el.rows = Math.min(6, draft.split('\n').length);
  el.id = id;
  el.placeholder = placeholder;
  el.setAttribute('aria-label', label);
  el.value = draft;
  el.maxLength = 10000;
  el.addEventListener('input', () => {
    if (el.value) reportEdits.set(full, el.value); else reportEdits.delete(full);
  });
  const submit = async () => {
    const lines = reportPlanLines(el.value);
    if (!lines.length) return;
    el.disabled = true;
    try { await reportPlanAddLines(item, lines, { key, group: groupOf(), alsoTask: alsoTaskOf(), focusId: id }); }
    catch (error) { showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true); }
    finally { el.disabled = false; }
  };
  el.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape' && !event.isComposing && key !== REPORT_PLAN_BOTTOM_KEY) {
      reportEdits.delete(full);
      renderReportDraft(item);
      return;
    }
    // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이지 추가가 아니다.
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || el.disabled) return;
    event.preventDefault();
    await submit();
  });
  // 한 줄 붙여넣기는 평소대로 — 줄바꿈이 있을 때만 가로채서 한 줄 = 한 문장으로 차례로 담는다.
  el.addEventListener('paste', (event) => {
    const pasted = event.clipboardData && typeof event.clipboardData.getData === 'function'
      ? event.clipboardData.getData('text') : '';
    if (!/[\r\n]/.test(String(pasted))) return;
    event.preventDefault();
    const lines = reportPlanLines(pasted);
    if (!lines.length) return;
    el.disabled = true;
    Promise.resolve()
      .then(() => reportPlanAddLines(item, lines, { key, group: groupOf(), alsoTask: alsoTaskOf(), focusId: id }))
      .catch(error => showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true))
      .finally(() => { el.disabled = false; });
  });
  return el;
}

// 프로젝트 소제목의 `+ 추가`가 여는 그 자리 입력줄(오늘 목록의 `+ 이 그룹에 추가`와 같은 모양).
function reportPlanGroupAddRow(item, name) {
  const key = `plan-add:${name}`;
  const id = `reportPlanAdd-${encodeURIComponent(name)}`;
  const row = reportNode('div', undefined, 'rp-add is-group');
  row.innerHTML = uiIcon('plus');
  // 저장 뒤 문서를 다시 그려도 적던 줄이 열려 있으면 그 자리로 돌아온다.
  row.hidden = !reportEdits.has(`${item.weekKey}:${key}`);
  const input = reportPlanInput(item, {
    key, id, placeholder: '이 프로젝트에 한 문장 추가 — Enter', label: `${name} 프로젝트에 다음 주 계획 문장 추가`,
    groupOf: () => name, alsoTaskOf: () => reportPlanAlsoTask,
  });
  if (String(input.className).includes('rp-addmulti')) row.className += ' is-multi';
  row.appendChild(input);
  return row;
}

// 프로젝트 소제목 + 그 자리에서 쓰는 `+ 추가`.
function reportPlanProjectHead(name, onAdd) {
  const head = reportNode('div', undefined, 'rp-pj');
  head.appendChild(reportNode('span', name, 'nm'));
  if (onAdd) {
    const add = reportNode('button', '+ 추가', 'rp-pjadd');
    add.type = 'button';
    add.setAttribute('aria-label', `${name} 프로젝트에 다음 주 계획 문장 추가`);
    add.addEventListener('click', onAdd);
    head.appendChild(add);
  }
  return head;
}

// `나중에 할 일에도 추가` 토글(기본 켜짐). 켜져 있으면 직접 쓴 문장이 업무로도 만들어진다.
function reportPlanAlsoTaskToggle() {
  const toggle = reportNode('button', '나중에 할 일에도 추가', 'd-chip rp-also' + (reportPlanAlsoTask ? ' is-on' : ''));
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', String(reportPlanAlsoTask));
  toggle.title = '직접 쓴 계획 문장을 같은 프로젝트의 나중에 할 일 업무로도 만들어요';
  toggle.addEventListener('click', () => {
    reportPlanAlsoTask = !reportPlanAlsoTask;
    try { localStorage.setItem(REPORT_PLAN_TASK_KEY, reportPlanAlsoTask ? '1' : '0'); } catch {}
    toggle.setAttribute('aria-pressed', String(reportPlanAlsoTask));
    toggle.classList.toggle('is-on', reportPlanAlsoTask);
  });
  return toggle;
}

// 다음 주 계획 — 문서의 마지막 구역. 한 문장이 한 줄(서버의 `add`)이고, 사람이 직접 쓴 것만 들어간다.
// 프로젝트를 고른 문장은 소제목 아래로 묶이고, 고르지 않은 문장은 구역 끝에 선다.
function reportPlanSection(item, host, newIds) {
  const rows = reportPlanRows(item.draft.rows);
  const current = reportPlanIsCurrentWeek(item.weekKey);
  host.appendChild(reportNode('div', REPORT_PLAN_HEADING, 'rp-h'));
  reportPlanGroups(rows).forEach((group, index) => {
    // 프로젝트를 고르지 않은 문장에는 소제목이 없다 — 앞 묶음에 딸려 보이지 않게 자리만 띄운다.
    if (group.name) {
      // 소제목의 `+ 추가`는 그 프로젝트의 입력줄을 그 자리에서 연다(이번 주만).
      const addRow = current ? reportPlanGroupAddRow(item, group.name) : null;
      host.appendChild(reportPlanProjectHead(group.name, addRow ? () => {
        addRow.hidden = false;
        addRow.querySelector('input, textarea')?.focus();
      } : null));
      for (const row of group.rows) reportSentenceRow(item, row, { host, newIds, plan: true });
      if (addRow) host.appendChild(addRow);
      return;
    }
    if (index) host.appendChild(reportNode('div', undefined, 'rp-sep'));
    for (const row of group.rows) reportSentenceRow(item, row, { host, newIds, plan: true });
  });
  if (!rows.length) host.appendChild(reportNode('div', '직접 쓴 문장만 들어가요', 'rp-hint'));

  // 담은 문장들 바로 아래가 후보 자리다(이번 주만). 눌러 담는 것은 사람이고, 앱은 보여 주기만 한다.
  if (current) reportPlanCandidateSection(item, host);

  // 맨 아래 입력줄 하나는 늘 남는다 — 새 프로젝트·프로젝트 없음용이다.
  const add = reportNode('div', undefined, 'rp-add');
  add.innerHTML = uiIcon('plus');
  add.appendChild(reportPlanProjectPicker());
  const input = reportPlanInput(item, {
    key: REPORT_PLAN_BOTTOM_KEY, id: 'reportPlanInput',
    placeholder: '다음 주에 할 일을 한 문장씩 추가 — Enter', label: '다음 주 계획 문장 추가',
    groupOf: () => reportPlanGroup, alsoTaskOf: () => current && reportPlanAlsoTask,
  });
  if (String(input.className).includes('rp-addmulti')) add.className += ' is-multi';
  add.appendChild(input);
  host.appendChild(add);
  // 지난 주차에서는 업무를 만들지 않는다 — 토글을 보여 주지 않는다(기존 입력줄만).
  if (!current) return;
  const foot = reportNode('div', undefined, 'rp-addfoot');
  foot.appendChild(reportPlanAlsoTaskToggle());
  host.appendChild(foot);
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
  for (const group of groups) {
    list.appendChild(uiGroupHeading(group.name, group.entries.length,
      group.name === REPORT_NO_PROJECT ? {} : { projectName: group.name }));
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

// 슬랙에 넣을 구역 고르기 — 내용이 없는 구역은 누를 수 없고, 바꾸면 미리보기와 복사가 같이 바뀐다.
function reportSlackChips(report) {
  const names = reportSlackSectionNames(report);
  const filled = new Set(reportSlackModel(report, { sections: names }).sections.map(section => section.name));
  // 처음 보는 구역(모르는 소제목)은 켠 채로 시작한다.
  let fresh = false;
  for (const name of names) {
    if (reportSlackSeen.has(name)) continue;
    reportSlackSeen.add(name);
    reportSlackSections.add(name);
    fresh = true;
  }
  if (fresh) reportSlackSectionsSave();
  const wrap = reportNode('div', undefined, 'rp-secs');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '슬랙에 넣을 구역');
  for (const name of names) {
    const on = reportSlackSections.has(name);
    const chip = reportNode('button', name, 'd-chip' + (on ? ' is-on' : ''));
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(on));
    if (!filled.has(name)) {
      chip.disabled = true;
      chip.title = '이 구역에 담긴 문장이 없어요';
    }
    chip.addEventListener('click', () => {
      if (reportSlackSections.has(name)) reportSlackSections.delete(name); else reportSlackSections.add(name);
      reportSlackSectionsSave();
      reportPreview(report);
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

// 슬랙에 붙었을 때의 모습을 그대로 그린다 — 여기 보이는 글자와 클립보드에 담기는 글자가 같아야 한다.
function reportPreview(report) {
  const host = document.getElementById('weeklyReportPreview');
  if (!host) return;
  host.replaceChildren();
  host.appendChild(reportNode('div', '슬랙에 붙이면', 'rp-slackhd'));
  host.appendChild(reportSlackChips(report));
  const box = reportNode('div', undefined, 'rp-slackbox');
  box.id = 'reportPreviewBox';
  const lines = reportSlackLines(reportSlackModel(report, { sections: [...reportSlackSections] }));
  if (!lines.length) box.appendChild(reportNode('div', '슬랙에 넣을 문장이 없어요.', 'rp-hint'));
  // 구역 사이의 빈 줄은 진짜 줄바꿈 글자로 둔다 — 빈 칸은 직접 선택해 복사할 때 빈 줄로 따라오지 않는다.
  for (const line of lines) {
    if (line.kind === 'gap') box.appendChild(document.createTextNode('\n'));
    else box.appendChild(reportNode('div', line.text, line.kind));
  }
  host.appendChild(box);
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
    reportEvidenceOpen.clear();
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
  host.dataset.weekKey = item.weekKey;
  host.replaceChildren();

  const newIds = reportMarkSeen(item);
  reportDocHead(item, host);
  const body = reportNode('div', undefined, 'rp-body');
  host.appendChild(body);
  reportDocSummary(item, body, newIds);

  if (reportMode === 'records') {
    reportRecordsView(item, body);
  } else {
    const sections = reportDocSections(report.rows);
    if (!sections.length) body.appendChild(reportNode('div', '이번 주 기록이 생기면 여기에 나타나요.', 'rp-hint'));
    for (const section of sections) {
      body.appendChild(reportNode('div', section.heading, 'rp-h'));
      for (const group of section.groups) {
        body.appendChild(reportNode('div', reportProjectText(group.group), 'rp-pj'));
        for (const row of group.rows) reportSentenceRow(item, row, { host: body, newIds });
      }
    }
    reportExcludedBlock(item, body);
    reportPlanSection(item, body, newIds);
  }

  reportNestBar(item);
  reportPreview(report);
}
