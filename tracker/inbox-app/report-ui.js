// ---------- 주간요약 문서 ----------
// 평일에는 "이번 주 뭐 했는지" 읽는 문서이고, 금요일에 문장을 고쳐 오른쪽 미리보기 그대로 슬랙에 붙인다.
// 저장하는 길은 `/api/report/change` 하나뿐이고(DECISIONS 주간보고), 이 화면은 추측으로 문장을 만들지 않는다.
// 오른쪽 미리보기와 `슬랙용으로 복사`는 반드시 같은 함수(reportCopyBlocks)에서 나온다 — 둘이 어긋나면 안 된다.

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

// 복사 글자의 재료. 형식은 예전 그대로다 — `상태 · 프로젝트` 한 줄 + `- 문장` 줄들, 묶음 사이 빈 줄.
// 형식을 바꾸면 사용자의 슬랙 글 모양이 바뀐다.
function reportCopyBlocks(report) {
  return (report && report.rows ? report.rows : [])
    .filter(row => !row.excluded)
    .map(row => ({
      title: `${row.heading} · ${row.group}`,
      lines: String(row.text).split('\n').map(line => `- ${line}`),
    }));
}

function reportCopyText(report) {
  return reportCopyBlocks(report).map(block => [block.title, ...block.lines].join('\n')).join('\n\n');
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
  announce('보고 내용을 저장했어요');
}

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
      await navigator.clipboard.writeText(reportCopyText(report));
      announce('보고 내용을 복사했어요');
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

// 근거 업무: 문장 아래 들여 쓴 목록. 줄을 누르면 오른쪽 상세 패널이 열린다.
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
    box.setAttribute('aria-label', `${row.group} · ${row.text} 묶기 선택`);
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
    const actions = reportNode('div', undefined, 'ed');
    actions.append(
      reportButton('저장', () => reportChange(item, { action: 'edit', id: row.id, text: input.value }), 'd-btn pri'),
      reportButton('취소', () => { reportEdits.delete(key); renderReportDraft(item); }),
    );
    text.appendChild(actions);
    host.appendChild(line);
    return;
  }

  text.appendChild(reportNode('span', row.text, 'ln'));
  // 손으로 고친 문장에만 조용한 이름표를 붙인다. `자동 초안`은 찍지 않는다.
  if (row.locked && !context.plan) text.appendChild(reportNode('span', '직접 수정', 'edt'));
  if (row.needsReview && !row.suggestion) text.appendChild(reportNode('span', '원본 확인 필요', 'rv'));
  const rowNew = row.sourceIds.filter(id => newIds.has(id)).length;
  if (rowNew) text.appendChild(reportNode('span', `새 기록 ${rowNew}`, 'nw'));

  const actions = reportNode('span', undefined, 'ac');
  actions.appendChild(reportButton('수정', () => {
    reportEdits.set(key, row.text);
    renderReportDraft(item);
    document.getElementById('weeklyReportDetail')?.querySelector(`[data-edit-row="${row.id}"]`)?.focus();
  }, 'd-btn sm'));
  actions.appendChild(reportButton('제외', () => reportChange(item, { action: 'exclude', id: row.id }), 'd-btn sm'));
  actions.appendChild(uiMoreButton(`${row.group} 문장 더보기`, () => [[
    row.sourceIds.length ? {
      label: reportEvidenceOpen.has(row.id) ? '근거 업무 숨기기' : '근거 업무 보기',
      onClick: () => {
        if (reportEvidenceOpen.has(row.id)) reportEvidenceOpen.delete(row.id); else reportEvidenceOpen.add(row.id);
        renderReportDraft(item);
      },
    } : null,
    { label: '다른 문장과 묶기', onClick: () => reportMergeStart(item, row) },
  ].filter(Boolean)]));
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

// 다음 주 계획 — 문서의 마지막 구역. 한 문장이 한 줄(서버의 `add`)이고, 사람이 직접 쓴 것만 들어간다.
function reportPlanSection(item, host, newIds) {
  const rows = reportPlanRows(item.draft.rows);
  host.appendChild(reportNode('div', REPORT_PLAN_HEADING, 'rp-h'));
  for (const row of rows) reportSentenceRow(item, row, { host, newIds, plan: true });
  if (!rows.length) host.appendChild(reportNode('div', '직접 쓴 문장만 들어가요', 'rp-hint'));

  const key = `${item.weekKey}:new`;
  const add = reportNode('div', undefined, 'rp-add');
  add.innerHTML = uiIcon('plus');
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
    try { await reportChange(item, { action: 'add', text: input.value }); }
    catch (error) { showNotice(error.message || '저장됐는지 확인하지 못했어요. 적은 내용은 그대로 있어요', true); }
    finally { input.disabled = false; }
    // 다시 그려졌으면 새로 생긴 입력칸으로, 실패해서 그대로면 같은 칸으로 돌아온다.
    document.getElementById('reportPlanInput')?.focus();
  });
  add.appendChild(input);
  host.appendChild(add);
}

// `전체 업무 기록` — 이번 주에 연결된 업무를 조용한 목록으로. 줄을 누르면 상세가 열린다.
function reportRecordsView(item, host) {
  const records = new Map();
  item.draft.rows.forEach(row => [...(row.evidence || []), ...(row.suggestion?.evidence || [])]
    .forEach(source => records.set(source.id, { source, row })));
  if (!records.size) {
    host.appendChild(reportNode('div', '이번 주에 연결된 업무 기록이 없어요.', 'rp-hint'));
    return;
  }
  const list = reportNode('div', undefined, 'rp-recs');
  for (const { source, row } of records.values()) {
    const line = reportNode('div', undefined, 'rp-rec');
    const open = reportNode('button', source.description, 'ti');
    open.type = 'button';
    open.addEventListener('click', () => panelOpen({ id: source.id }));
    line.append(open, reportNode('span', `${source.label} · ${source.status === 'done' ? '완료' : '미완료'} · ${row.excluded ? '보고 제외' : '보고에 포함'}`, 'mt'));
    if (row.excluded) line.appendChild(reportButton('보고에 복원', () => reportChange(item, { action: 'exclude', id: row.id }), 'd-btn sm'));
    list.appendChild(line);
  }
  host.appendChild(list);
}

// ---------- 슬랙 미리보기(상시) ----------

// 복사될 글자를 그대로 그린다 — 여기 보이는 것과 클립보드에 담기는 것이 같아야 한다.
function reportPreview(report) {
  const host = document.getElementById('weeklyReportPreview');
  if (!host) return;
  host.replaceChildren();
  host.appendChild(reportNode('div', '슬랙에 붙이면', 'rp-slackhd'));
  const box = reportNode('div', undefined, 'rp-slackbox');
  box.id = 'reportPreviewBox';
  const blocks = reportCopyBlocks(report);
  if (!blocks.length) box.appendChild(reportNode('div', '보고에 담긴 문장이 없어요.', 'rp-hint'));
  for (const block of blocks) {
    const group = reportNode('div', undefined, 'blk');
    group.appendChild(reportNode('div', block.title, 'hd'));
    for (const text of block.lines) group.appendChild(reportNode('div', text, 'bl'));
    box.appendChild(group);
  }
  host.appendChild(box);
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
        body.appendChild(reportNode('div', group.group, 'rp-pj'));
        for (const row of group.rows) reportSentenceRow(item, row, { host: body, newIds });
      }
    }
    reportExcludedBlock(item, body);
    reportPlanSection(item, body, newIds);
  }

  reportMergeBar(item);
  reportPreview(report);
}
