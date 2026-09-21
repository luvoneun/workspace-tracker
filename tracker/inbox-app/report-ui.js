// ---------- 주간요약 문서 ----------
// 평일에는 "이번 주 뭐 했는지" 읽는 문서이고, 금요일에 문장을 고쳐 오른쪽 미리보기 그대로 슬랙에 붙인다.
// 저장하는 길은 `/api/report/change` 하나뿐이고(DECISIONS 주간보고), 이 화면은 추측으로 문장을 만들지 않는다.
// 오른쪽 미리보기와 `슬랙용으로 복사`는 반드시 같은 구조(reportSlackModel)에서 나온다 — 셋이 어긋나면 안 된다.

const reportEdits = new Map();        // `${weekKey}:${행}` / `${weekKey}:new` → 입력 중인 글자(저장 실패해도 남는다)
const reportUndo = new Map();         // weekKey → 되돌리기 토큰
const reportSelection = new Set();    // 묶기 모드에서 고른 문장
const reportEvidenceOpen = new Set(); // 근거 업무를 펼쳐 둔 문장
const reportNewRecords = new Map();   // weekKey → { revision, ids } 안 본 새 기록
let reportBusy = false;
let reportMode = 'draft';             // 'draft' 보고 · 'records' 전체 업무 기록
let reportRenderedWeek = null;
let reportRenderedItem = null;
let reportMergeHeading = null;        // 묶기 모드에서 고를 수 있는 상태(서버도 같은 상태만 허용한다)
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

// 슬랙에 붙일 글의 구조(순수 함수). 일반 글자·서식 있는 복사·미리보기가 모두 여기서 나온다.
// `options.sections`는 넣을 구역 이름의 목록이고, 빠뜨리면 기본값(완료·진행 중·예정)이다.
// 규칙: 제외한 문장은 빠짐 · 구역 안에서 같은 프로젝트는 머리 하나 아래로 · 프로젝트 없는 것은 `기타`로
// 구역 끝 · 여러 줄 문장은 둘째 줄부터 부연 · 내용이 없는 구역은 생략.
function reportSlackModel(report, options = {}) {
  const chosen = new Set(options.sections || REPORT_SLACK_DEFAULT);
  const order = reportSlackSectionNames(report);
  const sections = new Map();
  for (const row of (report && report.rows ? report.rows : [])) {
    if (row.excluded) continue;
    const name = reportSlackSectionOf(row.heading);
    if (!name || !chosen.has(name)) continue;
    const lines = String(row.text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (!sections.has(name)) sections.set(name, { name, projects: [], memos: [] });
    const section = sections.get(name);
    const item = { text: lines[0], notes: lines.slice(1) };
    const projectName = reportSlackProjectOf(row, name);
    if (projectName === null) { section.memos.push(item); continue; }
    let project = section.projects.find(entry => entry.name === projectName);
    if (!project) { project = { name: projectName, items: [] }; section.projects.push(project); }
    project.items.push(item);
  }
  for (const section of sections.values()) {
    const index = section.projects.findIndex(project => project.name === REPORT_SLACK_OTHER);
    if (index >= 0) section.projects.push(section.projects.splice(index, 1)[0]);
  }
  return {
    title: reportSlackTitle(report && report.weekKey),
    sections: order.map(name => sections.get(name)).filter(section => section && (section.projects.length || section.memos.length)),
  };
}

// 한 줄씩 풀어 놓은 모양. 일반 글자와 미리보기가 같은 글자를 쓰게 하는 가운데 단계다
// (미리보기를 직접 선택해 복사해도 아래 `reportSlackText`와 같은 글자가 나온다).
function reportSlackLines(model) {
  const lines = [];
  if (!model || !model.sections.length) return lines;
  if (model.title) lines.push({ kind: 'title', text: model.title }, { kind: 'gap', text: '' });
  model.sections.forEach((section, index) => {
    if (index) lines.push({ kind: 'gap', text: '' });
    lines.push({ kind: 'section', text: section.name });
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
    html.push(bold(section.name));
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
function reportDocSections(rows) {
  const sections = [];
  const byHeading = new Map();
  for (const row of rows || []) {
    if (row.excluded || row.heading === REPORT_PLAN_HEADING) continue;
    if (!byHeading.has(row.heading)) {
      const section = { heading: row.heading, groups: [] };
      byHeading.set(row.heading, section);
      sections.push(section);
    }
    const section = byHeading.get(row.heading);
    let group = section.groups.find(entry => entry.group === row.group);
    if (!group) { group = { group: row.group, rows: [] }; section.groups.push(group); }
    group.rows.push(row);
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
  for (const row of rows || []) {
    const name = String(row.group || '').trim();
    if (!name || name === REPORT_PLAN_NO_PROJECT || name === REPORT_NO_PROJECT_LABEL || name === REPORT_NO_PROJECT) {
      loose.push(row);
      continue;
    }
    if (!byName.has(name)) { const group = { name, rows: [] }; byName.set(name, group); groups.push(group); }
    byName.get(name).rows.push(row);
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

async function reportChange(item, action) {
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
      throw new Error(result.error || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요');
    }
    if (action.action === 'edit') reportEdits.delete(`${item.weekKey}:${action.id}`);
    if (action.action === 'add') reportEdits.delete(`${item.weekKey}:new`);
    if (action.action === 'merge') { reportMergeHeading = null; escDrop(reportMergeEnd); }
    reportUndo.set(item.weekKey, result.undoToken);
    reportSelection.clear();
    item.draft = result.report;
    const cached = weeklyReportsCache.find(entry => entry.weekKey === item.weekKey);
    if (cached) cached.draft = result.report;
  } finally { reportBusy = false; }
  renderReportDraft(item);
  reportSavedNotice(item, action);
}

// 저장 뒤 알림 하나. 묶기·묶음 풀기는 무엇이 바뀌었는지 적고 그 자리에서 `되돌리기`까지 준다
// (머리줄의 `되돌리기`와 같은 길이다). 나머지 변경은 예전 문구 그대로다.
function reportSavedNotice(item, action) {
  if (action.action === 'undo') { announce('되돌렸어요'); return; }
  if (action.action !== 'merge' && action.action !== 'split') { announce('보고 내용을 저장했어요'); return; }
  const message = action.action === 'merge' ? `문장 ${action.ids.length}개를 묶었어요` : '묶음을 풀었어요';
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

// ---------- 묶기 모드(같은 상태의 문장만) ----------

function reportMergeStart(item, row) {
  reportMergeHeading = row.heading;
  reportSelection.clear();
  reportSelection.add(row.id);
  escDrop(reportMergeEnd);
  escPush(reportMergeEnd);
  renderReportDraft(item);
}

function reportMergeEnd() {
  if (reportBusy || reportMergeHeading === null) return;
  reportMergeHeading = null;
  reportSelection.clear();
  escDrop(reportMergeEnd);
  if (reportRenderedItem) renderReportDraft(reportRenderedItem);
}

function reportMergeBar(item) {
  const bar = document.getElementById('reportMergeBar');
  if (!bar) return;
  const open = reportMergeHeading !== null && reportMode === 'draft';
  document.body.classList.toggle('merge-open', open);
  bar.hidden = !open;
  bar.replaceChildren();
  if (!open) return;
  const inner = reportNode('div', undefined, 'bar');
  inner.appendChild(reportNode('span', `${reportSelection.size}개 선택`, 'ct num'));
  inner.appendChild(reportNode('span', `${reportMergeHeading} 안에서만 고를 수 있어요`, 'rp-hint'));
  inner.appendChild(reportNode('span', undefined, 'sp'));
  const merge = reportButton('선택한 문장 묶기', () => reportChange(item, { action: 'merge', ids: [...reportSelection] }), 'd-btn pri');
  merge.disabled = reportBusy || reportSelection.size < 2;
  inner.append(merge, reportButton('취소', () => reportMergeEnd()));
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

  if (reportUndo.has(item.weekKey)) {
    head.appendChild(reportButton('되돌리기', () => reportChange(item, { action: 'undo', token: reportUndo.get(item.weekKey) })));
  }
  // 한 화면에 채운 버튼은 이것 하나다.
  head.appendChild(reportButton('슬랙용으로 복사', async () => {
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

// 문장 줄의 ⋯ 메뉴. `묶음 풀기`는 서버가 묶기 전 문장을 들고 있는 행에만 붙는다(`canSplit`) —
// 옛 묶음 문장이나 낱 문장에는 나오지 않는다. 풀면 묶은 뒤에 고친 글은 사라지지만 `되돌리기`로 돌아온다.
function reportSentenceMenuSections(item, row) {
  return [[
    row.sourceIds.length ? {
      label: reportEvidenceOpen.has(row.id) ? '근거 업무 숨기기' : '근거 업무 보기',
      onClick: () => {
        if (reportEvidenceOpen.has(row.id)) reportEvidenceOpen.delete(row.id); else reportEvidenceOpen.add(row.id);
        renderReportDraft(item);
      },
    } : null,
    { label: '다른 문장과 묶기', onClick: () => reportMergeStart(item, row) },
    row.canSplit ? { label: '묶음 풀기', onClick: () => reportChange(item, { action: 'split', id: row.id }) } : null,
  ].filter(Boolean)];
}

// 문장 한 줄. 동작(수정·제외·더보기)은 hover·focus에서만 보인다.
function reportSentenceRow(item, row, context) {
  const host = context.host;
  const newIds = context.newIds || new Set();
  const key = `${item.weekKey}:${row.id}`;
  const line = reportNode('div', undefined, 'rp-s');
  if (row.needsReview) line.dataset.review = 'true';

  const merging = reportMergeHeading !== null;
  if (merging && row.heading === reportMergeHeading) {
    const box = reportNode('input');
    box.type = 'checkbox';
    box.className = 'd-cb';
    box.checked = reportSelection.has(row.id);
    box.setAttribute('aria-label', `${reportProjectText(row.group)} · ${row.text} 묶기 선택`);
    box.addEventListener('change', () => {
      if (box.checked) reportSelection.add(row.id); else reportSelection.delete(row.id);
      line.classList.toggle('is-sel', box.checked);
      reportMergeBar(item);
    });
    if (box.checked) line.classList.add('is-sel');
    line.appendChild(box);
  } else {
    if (merging) line.classList.add('is-off');
    line.appendChild(reportNode('span', '•', 'bu'));
  }

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
  // 손으로 고친 문장에만 조용한 이름표를 붙인다. `자동 초안`은 찍지 않는다.
  if (row.locked && !context.plan) text.appendChild(reportNode('span', '직접 수정', 'edt'));
  if (row.needsReview && !row.suggestion) text.appendChild(reportNode('span', '원본 확인 필요', 'rv'));
  const rowNew = row.sourceIds.filter(id => newIds.has(id)).length;
  if (rowNew) text.appendChild(reportNode('span', `새 기록 ${rowNew}`, 'nw'));
  if (lines.length > 1) text.appendChild(reportNode('div', lines.slice(1).join('\n'), 'sub'));

  const actions = reportNode('span', undefined, 'ac');
  actions.appendChild(reportButton('수정', () => {
    reportEdits.set(key, row.text);
    renderReportDraft(item);
    document.getElementById('weeklyReportDetail')?.querySelector(`[data-edit-row="${row.id}"]`)?.focus();
  }, 'd-btn sm'));
  actions.appendChild(reportButton('제외', () => reportChange(item, { action: 'exclude', id: row.id }), 'd-btn sm'));
  actions.appendChild(uiMoreButton(`${reportProjectText(row.group)} 문장 더보기`, () => reportSentenceMenuSections(item, row)));
  line.appendChild(actions);
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

// 다음 주 계획 — 문서의 마지막 구역. 한 문장이 한 줄(서버의 `add`)이고, 사람이 직접 쓴 것만 들어간다.
// 프로젝트를 고른 문장은 소제목 아래로 묶이고, 고르지 않은 문장은 구역 끝에 선다.
function reportPlanSection(item, host, newIds) {
  const rows = reportPlanRows(item.draft.rows);
  host.appendChild(reportNode('div', REPORT_PLAN_HEADING, 'rp-h'));
  reportPlanGroups(rows).forEach((group, index) => {
    // 프로젝트를 고르지 않은 문장에는 소제목이 없다 — 앞 묶음에 딸려 보이지 않게 자리만 띄운다.
    if (group.name) host.appendChild(reportNode('div', group.name, 'rp-pj'));
    else if (index) host.appendChild(reportNode('div', undefined, 'rp-sep'));
    for (const row of group.rows) reportSentenceRow(item, row, { host, newIds, plan: true });
  });
  if (!rows.length) host.appendChild(reportNode('div', '직접 쓴 문장만 들어가요', 'rp-hint'));

  const key = `${item.weekKey}:new`;
  const add = reportNode('div', undefined, 'rp-add');
  add.innerHTML = uiIcon('plus');
  add.appendChild(reportPlanProjectPicker());
  const input = reportNode('input');
  input.type = 'text';
  input.id = 'reportPlanInput';
  input.placeholder = '다음 주에 할 일을 한 문장씩 추가 — Enter';
  input.setAttribute('aria-label', '다음 주 계획 문장 추가');
  input.value = reportEdits.get(key) || '';
  input.maxLength = 10000;
  input.addEventListener('input', () => {
    if (input.value) reportEdits.set(key, input.value); else reportEdits.delete(key);
  });
  input.addEventListener('keydown', async (event) => {
    // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이지 추가가 아니다.
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!input.value.trim()) return;
    input.disabled = true;
    try { await reportChange(item, { action: 'add', text: input.value, group: reportPlanGroup || undefined }); }
    catch (error) { showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true); }
    finally { input.disabled = false; }
    // 다시 그려졌으면 새로 생긴 입력칸으로, 실패해서 그대로면 같은 칸으로 돌아온다.
    document.getElementById('reportPlanInput')?.focus();
  });
  add.appendChild(input);
  host.appendChild(add);
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
    reportSelection.clear();
    reportMergeHeading = null;
    escDrop(reportMergeEnd);
    reportEvidenceOpen.clear();
    reportRenderedWeek = item.weekKey;
  }
  reportRenderedItem = item;
  const report = item.draft;
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

  reportMergeBar(item);
  reportPreview(report);
}
