const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWrite } = require('./safe-storage');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const heading = item => item.type === 'decision' ? '새로 정해진 것' : item.type === 'check' ? (item.status==='done'?'확인 완료':'확인 대기') : item.status === 'done' ? '완료한 일' : '진행중';
const project = item => item.jira ? `jira:${item.jira}` : item.group || item.project ? `group:${item.group || item.project}` : 'ungrouped';
// Shared project alone is not evidence that two tasks describe the same work.
const topic = item => item.meetingId || item.permalink || item.description.normalize('NFKC').trim().split(/\s+/).slice(0,2).join(' ');
const bucket = item => `${project(item)}:${heading(item)}:${topic(item)}`;
const evidence = item => ({ id: item.id, description: item.description, status: item.status, type: item.type, outcome: item.outcome || '', label: item.label || item.group || item.project || '그룹 없음', permalink: /^https?:\/\//.test(item.permalink || '') ? item.permalink : null });
// 사람이 직접 쓰는 유일한 구역 — 자동 초안은 이 소제목을 만들지 않는다.
const PLAN_HEADING = '다음 주 계획';
// 할 일 문구가 80자를 넘을 때만 줄인다(슬랙 원문처럼 긴 문구가 보고 한 줄을 통째로 차지하지 않게) — 20자 넘게 간 뒤의
// 첫 문장 끝(마침표·물음표·느낌표 뒤 빈칸이나 끝)까지, 그런 끝이 없으면 80자 + …. 80자 이하 문구는 그대로다(기존 보고 불변,
// `1. 정리 2. 공유`·`Mr. Kim` 같은 짧은 문구가 조각나지 않게). 근거 `evidence`에는 전문이 남는다.
const firstSentence = text => {
  const value = String(text || '').trim();
  if (value.length <= 80) return value;
  const end = /[.?!。？！](?=\s|$)/g;
  let match;
  while ((match = end.exec(value)) && match.index < 20);
  const cut = match && match.index + 1 <= 80 ? value.slice(0, match.index + 1) : value;
  return cut.length > 80 ? `${cut.slice(0, 80).trimEnd()}…` : cut;
};
const taskText = item => (['task', 'bug'].includes(item.type) ? firstSentence(item.description) : item.description);
const textOf = items => [...new Set(items.map(item => item.status === 'done' && item.outcome ? item.outcome : item.status === 'done' ? taskText(item).replace(/하기$/, '함') : taskText(item)))].join('\n');

// ---------- 다듬기(제목·소제목 이름·새로 표시) ----------
// 사람이 고친 보고 제목과 소제목 이름, 그리고 "마지막으로 다듬은 때 무엇을 봤는지"는 파일 맨 위의 `weekPolish` 칸에
// 주마다 둔다: `{ [weekKey]: { title?, names?: { '소제목|프로젝트 열쇠': 이름 }, seen?: { at, ids: { 업무 id: 지문 } } } }`.
// 주(`weeks[weekKey]`) 안이 아니라 맨 위에 두는 이유: 옛 앱(1.2.1)의 change()는 주 칸을 `{rows, updatedAt}`로 통째로
// 새로 쓰므로 그 안의 모르는 칸은 버리지만, 파일 맨 위는 읽은 그대로 다시 쓴다(renameGroup 등도 같다). 문장 행에는
// 새 칸을 더하지 않는다 — 소제목·새로 표시는 view()가 그때그때 계산해 내보내고 clean()이 저장 전에 걷는다.
const HEADINGS = ['완료한 일', '진행중', '새로 정해진 것', '확인 완료', '확인 대기'];
const POLISH_NAME_MAX = 60;
// 문장 행이 속한 프로젝트 열쇠(`jira:KEY`·`group:이름`·`ungrouped`). 자동 갱신이 짝을 찾는 bucket 앞머리에서 읽는다
// (group 이름에 `:`가 있을 수 있어 소제목 자리로 끊는다). bucket이 없는 행은 null — 부르는 쪽이 이름으로 짝을 찾는다.
function ownKey(row) {
  const value = typeof row.bucket === 'string' ? row.bucket : '';
  if (value.startsWith('jira:')) { const end = value.indexOf(':', 5); return end > 5 ? value.slice(0, end) : null; }
  if (value.startsWith('group:')) {
    for (const name of [row.heading, ...HEADINGS]) { const at = value.indexOf(`:${name}:`, 6); if (at > 6) return value.slice(0, at); }
    return null;
  }
  return value.startsWith('ungrouped:') ? 'ungrouped' : null;
}
// "다듬은 뒤 바뀌었나"를 가르는 업무의 지문 — 이름표(label)는 빼고 본다(프로젝트 이름을 바꿨다고 전부 `바뀜`이 되지 않게).
// 지금 없는 업무(삭제)는 `-`다 — 다듬을 때 이미 없던 업무는 그 뒤에도 `바뀜`이 아니다.
const sourceMark = item => (item ? hash([item.description, item.status, item.type, item.outcome || '']).slice(0, 12) : '-');
const mondayKey = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
};
// 제목·소제목 이름: 60자 이내 한 줄. 빈 값은 "원래대로"다(null).
function polishName(value, what) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${what}을 확인해 주세요.`);
  const name = value.trim();
  if (!name) return null;
  if (name.length > POLISH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${what}을 ${POLISH_NAME_MAX}자 이내 한 줄로 적어 주세요.`);
  return name;
}

// `bundles`(프로젝트 묶어 보기 목록)와 `projectLabel`(열쇠 → 지금 표시 이름)은 없어도 된다 — 없으면 묶음·새 이름 없이 예전과 같다.
module.exports = ({ directory, sources, legacy, currentWeek, bundles = () => [], projectLabel = () => null }) => {
  const filename = path.join(directory, '.report-drafts.json');
  const undo = new Map();
  function read() {
    if (!fs.existsSync(filename)) return { schema: 1, weeks: {} };
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value.schema !== 1 || !value.weeks) throw new Error('보고 기록 형식을 확인해 주세요. 원본은 그대로 있어요.');
    return value;
  }
  function eligible(item, weekKey) {
    const end = new Date(`${weekKey}T12:00:00`); end.setDate(end.getDate() + 6);
    const until = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
    if (!item.created || item.created > until) return false;
    if (['task','bug'].includes(item.type)) return item.status === 'done'
      ? !!item.completed && item.completed >= weekKey && item.completed <= until
      : !!item.doing && item.doing <= until && weekKey === currentWeek();
    if (item.type === 'decision') return item.created >= weekKey && item.created <= until;
    return item.type === 'check' && item.created >= weekKey && item.created <= until;
  }
  function importLegacy(body, all) {
    let title = '기존 보고';
    return body.split('\n').flatMap((line, index) => {
      const h = line.match(/^\*\*(.+)\*\*$/); if (h) { title = h[1]; return []; }
      if (!line.trim()) return [];
      const id = line.match(/\s\^([^\s]+)\s*$/)?.[1];
      const item = all.find(item => item.id === id);
      return [{ id: `legacy-${index}`, heading: title, group: item?.label || item?.group || item?.project || '기존 보고', bucket: item ? bucket(item) : null,
        text: line.replace(/^- /,'').replace(/\s\^[^\s]+\s*$/,''), sourceIds: id ? [id] : [], evidence: item ? [evidence(item)] : [], locked: true, legacy: true, excluded: title === '조용히 완료한 일' }];
    });
  }
  // 소제목 자리 — 행마다 프로젝트 열쇠(`groupKey`)와, 보이는 이름이 저장된 이름(`group`)과 다를 때만 `shownGroup`을 붙인다.
  // ① 묶음(projectBundles)에 든 지라 프로젝트는 그 묶음이 생긴 주의 보고부터 대표 열쇠·대표 이름 하나로 선다
  //    (그 전 주는 그대로 — 소급하지 않는다). ② 사람이 바꾼 소제목 이름(`names['소제목|열쇠']`)이 있으면 그 이름이 서고
  //    `groupOrigin`에 원래 프로젝트 이름(지금 이름)을 함께 준다. 이름이 프로젝트 열쇠에 묶여 있으므로 그 프로젝트의
  //    새 업무도 바뀐 소제목 아래로 들어간다. 다음 주 계획은 사람이 고른 이름 그대로라 건드리지 않는다.
  function dress(rows, weekKey, polish, list) {
    const names = polish.names && typeof polish.names === 'object' ? polish.names : {};
    const applied = (Array.isArray(list) ? list : []).filter(bundle => bundle && Array.isArray(bundle.keys) && bundle.keys.includes(bundle.lead)
      && weekKey >= ((bundle.at && mondayKey(bundle.at)) || currentWeek()));
    const keys = new Map();
    const byName = new Map();
    const report = rows.filter(row => row.heading !== PLAN_HEADING);
    report.forEach(row => { const key = ownKey(row); if (!key) return; keys.set(row, key); if (!byName.has(row.group)) byName.set(row.group, key); });
    // bucket이 없는 행(한 줄로 모으기 요약·옛 합치기)은 같은 이름을 쓰는 행의 열쇠를 빌린다 — 없으면 이름이 곧 열쇠다.
    report.forEach(row => { if (!keys.has(row)) keys.set(row, byName.get(row.group) || `name:${row.group}`); });
    const leadName = (lead) => {
      const found = report.find(row => keys.get(row) === lead);
      return found ? found.group : (projectLabel(lead) || lead.slice(lead.indexOf(':') + 1));
    };
    report.forEach((row) => {
      const own = keys.get(row);
      const bundle = applied.find(entry => entry.keys.includes(own));
      const key = bundle ? bundle.lead : own;
      const natural = bundle ? leadName(bundle.lead) : row.group;
      row.groupKey = key;
      const custom = Object.prototype.hasOwnProperty.call(names, `${row.heading}|${key}`) ? names[`${row.heading}|${key}`] : null;
      if (typeof custom === 'string' && custom) { row.shownGroup = custom; row.groupOrigin = projectLabel(key) || natural; }
      else if (natural !== row.group) row.shownGroup = natural;
    });
  }
  // 새로·바뀜 표시 — 마지막으로 다듬은(또는 `모두 확인`한) 때 본 업무(`seen.ids`)와 견준다. 그런 기록이 없으면(옛 데이터·
  // 아직 한 번도 다듬지 않은 주) 아무 표시도 없다. 행의 업무가 전부 처음 보는 것이면 `fresh`, 일부가 처음이거나
  // 본 뒤 문구·상태가 바뀌었으면 `changed`. 제외한 문장·다음 주 계획은 세지 않는다.
  function marks(rows, seen, byId) {
    if (!seen || !seen.ids || typeof seen.ids !== 'object') return null;
    const known = id => Object.prototype.hasOwnProperty.call(seen.ids, id);
    let fresh = 0, changed = 0;
    rows.forEach((row) => {
      if (row.excluded || row.heading === PLAN_HEADING) return;
      const own = row.sourceIds || [];
      const all = [...new Set([...own, ...(row.suggestion?.sourceIds || [])])];
      if (!all.length) return;
      if (own.length && own.every(id => !known(id))) { row.fresh = true; fresh += 1; return; }
      if (all.some(id => !known(id) || seen.ids[id] !== sourceMark(byId.get(id)))) { row.changed = true; changed += 1; }
    });
    return { at: typeof seen.at === 'string' ? seen.at : null, fresh, changed };
  }
  const polishOf = (state, weekKey) => {
    const value = state.weekPolish && typeof state.weekPolish === 'object' ? state.weekPolish[weekKey] : null;
    return value && typeof value === 'object' ? value : {};
  };
  function view(weekKey, state = read(), sourceSnapshot, opts = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) throw new Error('주간 날짜를 확인해 주세요.');
    const all = sourceSnapshot || sources(), byId = new Map(all.map(item => [item.id,item]));
    const old = legacy().find(entry => entry.weekKey === weekKey);
    const stored = state.weeks[weekKey];
    const rows = structuredClone(stored?.rows || importLegacy(old?.body || '', all));
    const claimed = new Set(rows.flatMap(row => row.sourceIds));
    const candidates = all.filter(item => eligible(item,weekKey) && !claimed.has(item.id));
    for (const row of rows) {
      const linked = row.sourceIds.map(id => byId.get(id)).filter(Boolean);
      const currentEvidence = linked.map(evidence);
      const missing = linked.length !== row.sourceIds.length;
      const added = row.bucket && !row.excluded ? candidates.filter(item => bucket(item) === row.bucket && !claimed.has(item.id)) : [];
      added.forEach(item => claimed.add(item.id));
      const combined = [...linked, ...added];
      const mixed = new Set(combined.map(heading)).size > 1;
      if (row.locked || row.excluded || weekKey < currentWeek()) {
        const changed = !row.legacy && hash(currentEvidence) !== hash(row.evidence);
        if (added.length || changed || missing) row.suggestion = { text: textOf(combined), sourceIds: combined.map(item=>item.id), evidence: combined.map(evidence), added: added.length, missing, mixed };
      } else if (combined.length && !missing && !mixed) {
        row.text = textOf(combined); row.sourceIds = combined.map(item=>item.id); row.evidence = combined.map(evidence);
        row.heading = heading(combined[0]); row.bucket = bucket(combined[0]);
        row.group=combined[0].label || combined[0].group || combined[0].project || '그룹 없음';
      } else row.suggestion = { text: textOf(combined), sourceIds: combined.map(item=>item.id), evidence: currentEvidence, added: added.length, missing, mixed };
      row.needsReview = !!row.suggestion || mixed || missing;
      row.currentEvidence = currentEvidence;
    }
    const groups = new Map();
    candidates.filter(item=>!claimed.has(item.id)).forEach(item=>{ const key=bucket(item); if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item); });
    for (const [key,items] of groups) rows.push({ id:`auto-${hash([key,items.map(item=>item.id).sort()]).slice(0,16)}`,bucket:key,heading:heading(items[0]),group:items[0].label || items[0].group || items[0].project || '그룹 없음', text:textOf(items),sourceIds:items.map(item=>item.id),evidence:items.map(evidence),currentEvidence:items.map(evidence),locked:false,excluded:false,needsReview:false });
    const polish = polishOf(state, weekKey);
    dress(rows, weekKey, polish, opts.bundles !== undefined ? opts.bundles : bundles());
    const since = marks(rows, polish.seen, byId);
    const order=['완료한 일','진행중','새로 정해진 것','확인 완료','확인 대기',PLAN_HEADING];
    rows.forEach(row=>{if(row.evidence.some(item=>/\(.*확인 필요.*\)|\(미확정\)/.test(item.description)))row.needsReview=true;});
    // 묶기 전 문장(`parts`)은 저장 파일에만 둔다 — 화면에는 "풀 수 있는지"만 알린다(큰 배열을 매번 내보내지 않으려고).
    // `parts`가 없는 옛 묶음 행은 `canSplit`이 붙지 않아 화면에서 `묶음 풀기`가 보이지 않는다.
    rows.forEach(row=>{if(row.parts){row.canSplit=true;row.partCount=row.parts.length;delete row.parts;}});
    // 다른 문장 아래로 들어간 문장(`parent`)은 그 부모 바로 뒤에 선다. 부모가 사라졌거나 제외됐거나
    // (자동 갱신으로) 상태가 달라졌거나 부모가 다시 누군가의 자식이면 그 문장은 최상위로 보인다 —
    // 저장된 값은 그대로 두고 보이는 결과에서만 뺀다(GET은 파일을 쓰지 않는다).
    const byRowId=new Map(rows.map(row=>[row.id,row]));
    rows.forEach(row=>{const parent=row.parent?byRowId.get(row.parent):null;
      if(row.parent&&(!parent||parent.id===row.id||parent.excluded||parent.heading!==row.heading))delete row.parent;});
    rows.forEach(row=>{if(row.parent&&byRowId.get(row.parent).parent)delete row.parent;});
    const tops=rows.filter(row=>!row.parent);
    tops.sort((a,b)=>(order.indexOf(a.heading)<0?99:order.indexOf(a.heading))-(order.indexOf(b.heading)<0?99:order.indexOf(b.heading)) || (a.shownGroup||a.group).localeCompare(b.shownGroup||b.group));
    const nested=new Map();
    rows.forEach(row=>{if(!row.parent)return;if(!nested.has(row.parent))nested.set(row.parent,[]);nested.get(row.parent).push(row);});
    const ordered=tops.flatMap(row=>[row,...(nested.get(row.id)||[])]);
    // 사람이 지은 요약 문장(`manual`, fold로 만든 부모)은 아래 문장이 (직접 지운 게 아니라) 고아 규칙으로
    // 전부 떨어져 나가면 화면에서 뜻 없는 빈 줄로 남지 않게 뺀다 — 저장값은 그대로 둔다(기존 parent
    // 고아 규칙과 같은 태도). `opts.raw`는 change()가 다음 저장을 준비할 때만 쓰는 내부용으로, 숨긴 행도
    // 그대로 들고 있어야 carry()가 저장값을 잃지 않는다.
    const visible = opts.raw ? ordered : ordered.filter(row => !(row.manual && !(nested.get(row.id) || []).length));
    // 제목·소제목 이름·새로 기록도 revision에 든다 — 다른 창에서 바꾼 것을 모르고 덮어쓰지 않게.
    const revision = hash({ stored, rows: ordered, polish });
    return { weekKey, rows: visible, revision, updatedAt: stored?.updatedAt || null, title: typeof polish.title === 'string' && polish.title ? polish.title : null, since,
      ...(opts.raw ? { byId } : {}) };
  }
  function clean(row) { const { suggestion, needsReview, currentEvidence, canSplit, partCount, groupKey, shownGroup, groupOrigin, fresh, changed, ...rest } = row; return rest; }
  // 계획 문장에 붙이는 프로젝트 이름. 없으면 기존처럼 `직접 작성`으로 담는다.
  function planGroup(group) {
    if (group === undefined || group === null || group === '') return '직접 작성';
    if (typeof group !== 'string') throw new Error('프로젝트 이름을 확인해 주세요.');
    const name = group.trim();
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('프로젝트 이름을 60자 이내 한 줄로 입력해 주세요.');
    return name;
  }
  // 계획 문장이 어느 업무에서 왔는지 가리키는 표시. 화면이 후보 줄의 `담음` 판정에만 쓴다.
  // **`sourceIds`·`evidence`에는 절대 넣지 않는다** — 넣으면 view의 `claimed`가 그 업무를 이번 주
  // `진행중` 자동 문장에서 빼 버린다(다음 주 계획에 담았다고 이번 주 기록이 사라지면 안 된다).
  // 그 업무가 실제로 있는지는 서버가 확인하지 않는다(화면 표시용 연결일 뿐이다).
  function planOf(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new Error('담은 업무 표시를 확인해 주세요.');
    const link = value.trim();
    if (!link || link.length > 100 || /[\u0000-\u001f\u007f]/.test(link)) throw new Error('담은 업무 표시를 100자 이내 한 줄로 보내 주세요.');
    return link;
  }
  function change({ weekKey, revision, action, id, parentId, text, ids, token, group, planOf: planSource, folded, heading: groupHeading, groupKey }) {
    const state=read(), current=view(weekKey,state,undefined,{raw:true});
    if (revision !== current.revision) { const error=new Error('새 기록이나 다른 창의 변경이 있어요. 적은 내용은 그대로 있어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.');error.status=409;throw error; }
    // 묶기 전 문장은 화면으로 나가지 않으므로(view가 `canSplit`만 알린다) 저장 파일에서 다시 붙인다.
    // `parts`는 서버가 merge에서만 만든다 — 요청 본문의 값은 받지 않는다.
    const storedParts=new Map((state.weeks[weekKey]?.rows||[]).filter(row=>row.parts).map(row=>[row.id,row.parts]));
    // 고아 규칙에 걸린 `parent`는 view가 결과에서만 뺀다 — 저장 파일의 값은 조용히 지우지 않는다.
    const storedParents=new Map((state.weeks[weekKey]?.rows||[]).filter(row=>row.parent).map(row=>[row.id,row.parent]));
    const carry=row=>{const next=clean(row);if(storedParts.has(row.id))next.parts=storedParts.get(row.id);
      if(next.parent===undefined&&storedParents.has(row.id))next.parent=storedParents.get(row.id);return next;};
    let rows=current.rows.map(carry); const row=rows.find(row=>row.id===id), shown=current.rows.find(row=>row.id===id);
    // 이 주의 다듬기 칸(제목·소제목 이름·새로 기록). 되돌리기는 문장과 함께 이 칸도 그 전으로 돌린다.
    const polishBefore=structuredClone(polishOf(state,weekKey));
    let polish=structuredClone(polishBefore);
    if(action==='undo') {
      const prior=undo.get(token); if(!prior || prior.weekKey!==weekKey)throw new Error('되돌리기 기록이 만료됐어요.');
      if(hash({rows:state.weeks[weekKey]?.rows,polish:polishOf(state,weekKey)})!==prior.after)throw new Error('그 뒤에 다른 변경이 있어 되돌릴 수 없어요. 최신 보고를 확인해 주세요.');
      rows=prior.rows; polish=structuredClone(prior.polish||{});
    } else if(action==='retitle') {
      // 보고 제목. 빈 값이면 원래 제목(`이번 주`·`9월 4주차`)으로 돌아간다.
      const title=polishName(text,'보고 제목');
      if(title)polish.title=title; else delete polish.title;
    } else if(action==='rename') {
      // 소제목 이름 — 프로젝트 열쇠에 묶인다(화면이 보고 있던 소제목의 열쇠만 받는다). 빈 값이나 원래 이름과 같으면
      // 원래 이름으로 돌아간다. 문장·연결·프로젝트는 하나도 바뀌지 않는다.
      if(typeof groupHeading!=='string'||typeof groupKey!=='string'||groupHeading===PLAN_HEADING
        ||!current.rows.some(entry=>entry.heading===groupHeading&&entry.groupKey===groupKey))throw new Error('이름을 바꿀 소제목을 찾을 수 없어요. 최신 보고를 확인해 주세요.');
      const name=polishName(text,'소제목 이름');
      const sample=current.rows.find(entry=>entry.heading===groupHeading&&entry.groupKey===groupKey);
      const natural=sample.groupOrigin||sample.shownGroup||sample.group;
      const plain=String(natural).replace(/^[A-Z][A-Z0-9]*-\d+ · /,'');
      const names={...(polish.names&&typeof polish.names==='object'?polish.names:{})};
      if(!name||name===natural||name===plain)delete names[`${groupHeading}|${groupKey}`]; else names[`${groupHeading}|${groupKey}`]=name;
      if(Object.keys(names).length)polish.names=names; else delete polish.names;
    } else if(action==='ackNew') {
      // `모두 확인` — 지금 보이는 업무를 전부 본 것으로 적는다(새로·바뀜 표시가 걷힌다). 문장은 그대로다.
    } else if(action==='add') {
      if(typeof text!=='string'||!text.trim()||text.length>10000)throw new Error('보고 문장을 입력해 주세요.');
      const link=planOf(planSource);
      rows.push({id:randomUUID(),heading:PLAN_HEADING,group:planGroup(group),text:text.trim(),sourceIds:[],evidence:[],locked:true,excluded:false,...(link?{planOf:link}:{})});
    } else if(action==='merge') {
      if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw new Error('묶을 보고 항목을 선택해 주세요.');
      const selected=rows.filter(row=>ids.includes(row.id));
      if(selected.length!==ids.length||selected.some(row=>row.excluded)||new Set(selected.map(row=>row.heading)).size!==1)throw new Error('같은 상태의 문장만 묶을 수 있어요.');
      const sourceIds=[...new Set(selected.flatMap(row=>row.sourceIds))];
      rows=rows.filter(row=>!ids.includes(row.id));
      // 묶기 전 문장을 그대로 품는다(나중에 `split`으로 되살린다). 이미 묶음이던 행은 그 행의 `parts`까지
      // 함께 들어가 있어서, 묶음을 다시 묶은 것을 풀면 한 단계만 풀린다.
      rows.push({id:randomUUID(),heading:selected[0].heading,group:new Set(selected.map(row=>row.group)).size===1?selected[0].group:'여러 프로젝트',bucket:new Set(selected.map(row=>row.bucket)).size===1?selected[0].bucket:null,text:selected.map(row=>row.text).join('\n'),sourceIds,evidence:[...new Map(selected.flatMap(row=>row.evidence).map(item=>[item.id,item])).values()],locked:true,excluded:false,parts:structuredClone(selected)});
    } else if(action==='fold') {
      // 여러 문장을 골라 사람이 지은 요약 한 줄(`manual`) 아래로 넣는다(nest와 같은 후보 조건 + 같은 heading).
      // 글자는 합치지 않는다 — 고른 문장은 그대로 독립된 문장으로 남고, 새 부모만 하나 생긴다.
      if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw new Error('한 줄로 모을 문장을 두 개 이상 골라 주세요.');
      const selected=rows.filter(row=>ids.includes(row.id));
      if(selected.length!==ids.length||new Set(selected.map(row=>row.heading)).size!==1)throw new Error('같은 상태의 문장만 한 줄로 모을 수 있어요.');
      if(selected.some(row=>row.excluded))throw new Error('제외한 문장은 모을 수 없어요.');
      if(selected.some(row=>row.parent))throw new Error('이미 다른 문장 아래에 있는 문장은 모을 수 없어요.');
      if(selected.some(candidate=>rows.some(entry=>entry.parent===candidate.id)))throw new Error('아래에 문장이 있는 문장은 먼저 비워 주세요.');
      const trimmed=typeof text==='string'?text.trim():'';
      if(!trimmed||trimmed.length>200||/\n/.test(text))throw new Error('요약 문장을 200자 이내 한 줄로 적어 주세요.');
      const parentId=randomUUID();
      const group=new Set(selected.map(row=>row.group)).size===1?selected[0].group:'여러 프로젝트';
      // 부모는 뒤에 붙이지 않고 선택한 첫 문장(화면 순서 기준) 자리에 넣는다 — 나머지는 자리 그대로 두고
      // `parent`만 붙인다(view의 tops/children 재구성이 부모 바로 뒤로 옮겨 준다).
      const firstIndex=rows.findIndex(row=>ids.includes(row.id));
      selected.forEach(row=>{row.parent=parentId;});
      rows.splice(firstIndex,0,{id:parentId,heading:selected[0].heading,group,bucket:null,text:trimmed,sourceIds:[],evidence:[],locked:true,excluded:false,folded:true,manual:true});
    } else {
      if(!row)throw new Error('보고 항목을 찾을 수 없어요.');
      if(action==='edit') { if(typeof text!=='string'||!text.trim()||text.length>10000)throw new Error('보고 문장을 10,000자 이내로 입력해 주세요.');row.text=text.trim();row.locked=true;row.legacy=false;row.evidence=shown.currentEvidence; }
      else if(action==='exclude') row.excluded=!row.excluded;
      else if(action==='accept') { if(!shown.suggestion || shown.suggestion.missing || shown.suggestion.mixed)throw new Error('원본 상태를 확인하고 문장을 직접 수정해 주세요.');Object.assign(row,shown.suggestion,{locked:true,legacy:false});delete row.added;delete row.missing;delete row.mixed; }
      else if(action==='acknowledge') { row.evidence=shown.suggestion?.evidence || shown.currentEvidence;row.sourceIds=shown.suggestion?.sourceIds || row.sourceIds;row.legacy=false;row.locked=true; }
      // 문장을 다른 문장 아래로 넣는다(글자를 합치지 않는다 — 들어간 문장도 독립된 문장으로 남는다).
      // 판단은 화면이 보고 있는 결과(`current.rows`)를 기준으로 한다 — 고아 규칙으로 최상위로 보이던
      // 문장은 화면에서 본 그대로 최상위로 다룬다.
      else if(action==='nest') {
        const parent=current.rows.find(entry=>entry.id===parentId);
        if(!parent||parent.id===row.id)throw new Error('아래로 넣을 문장을 찾을 수 없어요.');
        if(parent.heading!==shown.heading)throw new Error('같은 상태의 문장 아래로만 넣을 수 있어요.');
        if(parent.parent)throw new Error('이미 다른 문장 아래에 있는 문장 밑으로는 넣을 수 없어요.');
        if(shown.excluded||parent.excluded)throw new Error('제외한 문장은 넣을 수 없어요.');
        if(current.rows.some(entry=>entry.parent===row.id))throw new Error('아래에 문장이 있는 문장은 먼저 비워 주세요.');
        row.parent=parent.id;
      }
      else if(action==='unnest') {
        // 마지막 아래 문장을 빼서 사람이 지은 요약(`manual`) 부모 아래가 비면 그 부모도 함께 지운다 —
        // 뜻 없는 빈 요약 줄을 남기지 않는다. 원래 있던 문장을 부모로 쓴 nest 묶음은 그대로 남는다.
        const parentId=row.parent;
        delete row.parent;
        const parent=parentId?rows.find(entry=>entry.id===parentId):null;
        if(parent&&parent.manual&&!rows.some(entry=>entry.parent===parentId))rows=rows.filter(entry=>entry.id!==parentId);
      }
      else if(action==='setFolded') {
        if(row.parent||!rows.some(entry=>entry.parent===row.id))throw new Error('아래에 문장이 있는 문장만 접을 수 있어요.');
        row.folded=!!folded;
      }
      else if(action==='unfold') {
        rows.forEach(entry=>{if(entry.parent===row.id)delete entry.parent;});
        if(row.manual)rows=rows.filter(entry=>entry.id!==row.id);
        else row.folded=false;
      }
      // 계획 문장의 프로젝트만 나중에 바꾼다(지우고 다시 넣지 않아도 되게). 다른 구역의 문장은
      // 프로젝트가 원본 업무에서 오므로 여기서 손대지 않는다.
      else if(action==='regroup') {
        if(shown.heading!==PLAN_HEADING)throw new Error('다음 주 계획 문장만 프로젝트를 바꿀 수 있어요.');
        row.group=planGroup(group);
      }
      else if(action==='split') {
        // 묶은 뒤 문장을 고쳤더라도 묶기 전 문장들로 돌아간다(그 편집은 `undo`로 되살린다).
        if(!row.parts || !row.parts.length)throw new Error('이 문장은 풀 수 없어요.');
        const used=new Set(rows.filter(entry=>entry.id!==id).map(entry=>entry.id));
        const restored=structuredClone(row.parts).map(part=>{const next={...part,id:used.has(part.id)?randomUUID():part.id};used.add(next.id);return next;});
        rows=rows.flatMap(entry=>entry.id===id?restored:[entry]);
      }
      else throw new Error('지원하지 않는 보고 변경이에요.');
    }
    // 다듬은 기록(`seen`). 되돌리기 말고는 모든 저장이 "다듬기"다 — 처음 다듬을 때(기록이 없던 주)는 지금 보이는 업무를
    // 전부, 그 뒤로는 손댄 문장의 업무만 본 것으로 더한다(한 문장을 고쳤다고 다른 줄의 `새로`가 걷히지 않게).
    // `모두 확인`은 늘 전부다.
    if(action!=='undo') {
      const now=new Date().toISOString();
      const idsOf=list=>[...new Set(list.flatMap(entry=>[...(entry.sourceIds||[]),...(entry.suggestion?.sourceIds||[])]))];
      const seenIds=list=>Object.fromEntries(idsOf(list).map(sourceId=>[sourceId,sourceMark(current.byId.get(sourceId))]));
      const seen=polish.seen&&polish.seen.ids&&typeof polish.seen.ids==='object'?polish.seen:null;
      if(action==='ackNew'||!seen) polish.seen={at:now,ids:seenIds(current.rows)};
      else {
        const touched=new Set([id,parentId,...(Array.isArray(ids)?ids:[])].filter(value=>typeof value==='string'));
        const hit=current.rows.filter(entry=>touched.has(entry.id)||(action==='rename'&&entry.heading===groupHeading&&entry.groupKey===groupKey));
        polish.seen={at:now,ids:{...seen.ids,...seenIds(hit)}};
      }
    }
    const undoToken=randomUUID();
    state.weeks[weekKey]={rows,updatedAt:new Date().toISOString()};
    if(Object.keys(polish).length){if(!state.weekPolish||typeof state.weekPolish!=='object')state.weekPolish={};state.weekPolish[weekKey]=polish;}
    else if(state.weekPolish&&typeof state.weekPolish==='object'){delete state.weekPolish[weekKey];if(!Object.keys(state.weekPolish).length)delete state.weekPolish;}
    atomicWrite(filename,JSON.stringify(state,null,2));
    undo.set(undoToken,{weekKey,rows:current.rows.map(carry),polish:polishBefore,after:hash({rows,polish:polishOf(state,weekKey)})});if(undo.size>50)undo.delete(undo.keys().next().value);
    return {ok:true,report:view(weekKey,state),undoToken};
  }
  function weeks(snapshot=sources(), state=read()) {
    const dates=snapshot.flatMap(item=>[item.completed,...(['decision','check'].includes(item.type)?[item.created]:[])]).filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date || ''));
    const keys=dates.map(date=>{const d=new Date(`${date}T12:00:00`);d.setDate(d.getDate()-((d.getDay()+6)%7));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
    return [...new Set([currentWeek(),...keys,...legacy().map(entry=>entry.weekKey),...Object.keys(state.weeks)])].sort().reverse();
  }
  // 직접 만든 프로젝트의 이름이 바뀔 때, 저장된 보고에 글자로 박혀 있는 그룹 이름만 바꾼다.
  // 저장 형식은 그대로 두고 값만 고친다 — 문장(`text`)·연결(`sourceIds`)은 손대지 않는다.
  // 바꾸는 자리는 셋이다: 프로젝트 소제목이 되는 `group`, 자동 갱신이 짝을 찾는 `bucket`의 앞머리,
  // 근거 줄에 적히는 `evidence[].label`. 묶기 전 문장(`parts`)도 같은 규칙으로 따라간다.
  // 부르는 쪽(server.js renameProject)의 트랜잭션 안에서 돈다 — 여기서 실패하면 전부 되돌아간다.
  // 사람이 바꾼 소제목 이름(`weekPolish[주].names`)은 `소제목|프로젝트 열쇠`로 묶여 있다 — 프로젝트의 열쇠가 바뀌면
  // (이름 바꾸기·에픽으로 옮기기) 그 이름도 새 열쇠로 따라간다. 새 열쇠에 이미 이름이 있으면 덮지 않고 그대로 둔다.
  function moveNames(state, from, to) {
    let moved = 0;
    for (const week of Object.values(state.weekPolish && typeof state.weekPolish === 'object' ? state.weekPolish : {})) {
      const names = week && week.names && typeof week.names === 'object' ? week.names : null;
      if (!names) continue;
      for (const name of Object.keys(names)) {
        const at = name.indexOf('|');
        if (at < 0 || name.slice(at + 1) !== from) continue;
        const next = `${name.slice(0, at)}|${to}`;
        if (Object.prototype.hasOwnProperty.call(names, next)) continue;
        names[next] = names[name];
        delete names[name];
        moved += 1;
      }
    }
    return moved;
  }
  function renameGroup(from, to) {
    const state = read();
    const head = `group:${from}:`;
    let rows = 0;
    const fix = (row) => {
      if (!row || typeof row !== 'object') return;
      let touched = false;
      if (row.group === from) { row.group = to; touched = true; }
      if (typeof row.bucket === 'string' && row.bucket.startsWith(head)) { row.bucket = `group:${to}:${row.bucket.slice(head.length)}`; touched = true; }
      (Array.isArray(row.evidence) ? row.evidence : []).forEach((item) => {
        if (item && item.label === from) { item.label = to; touched = true; }
      });
      (Array.isArray(row.parts) ? row.parts : []).forEach(fix);
      if (touched) rows += 1;
    };
    for (const week of Object.values(state.weeks || {})) (week?.rows || []).forEach(fix);
    const names = moveNames(state, `group:${from}`, `group:${to}`) + moveNames(state, `name:${from}`, `name:${to}`);
    if (rows || names) atomicWrite(filename, JSON.stringify(state, null, 2));
    return rows;
  }
  // 지라 프로젝트의 앱 안 별칭이 바뀔 때, 저장된 보고에 글자로 박혀 있는 표시 이름만 바꾼다(BJALIAS).
  // renameGroup과 정확히 대칭이지만 짝짓는 자리가 다르다 — 지라 키는 바뀌지 않으므로(bucket은 그대로)
  // `group`/`evidence[].label`을 그 프로젝트의 bucket(`jira:KEY:`로 시작)에 속한 행에서만 바꾼다.
  // 다른 프로젝트의 행에 같은 글자가 우연히 있어도(계획 문장 등) 건드리지 않는다.
  function relabelProject(bucketHead, from, to) {
    const state = read();
    let rows = 0;
    const fix = (row) => {
      if (!row || typeof row !== 'object') return;
      let touched = false;
      if (typeof row.bucket === 'string' && row.bucket.startsWith(bucketHead)) {
        if (row.group === from) { row.group = to; touched = true; }
        (Array.isArray(row.evidence) ? row.evidence : []).forEach((item) => {
          if (item && item.label === from) { item.label = to; touched = true; }
        });
      }
      (Array.isArray(row.parts) ? row.parts : []).forEach(fix);
      if (touched) rows += 1;
    };
    for (const week of Object.values(state.weeks || {})) (week?.rows || []).forEach(fix);
    const names = moveNames(state, `name:${from}`, `name:${to}`);
    if (rows || names) atomicWrite(filename, JSON.stringify(state, null, 2));
    return rows;
  }
  // 직접 만든 프로젝트를 지라 에픽으로 옮길 때(BMOVE), 저장된 보고에 박혀 있는 그룹 이름을 지라 꼴로
  // 바꾼다. renameGroup과 같은 세 자리(group·bucket 앞머리·evidence[].label)를 보되, bucket은
  // `group:from:` → `jira:to:`로 종류까지 바뀌고 group·label은 부르는 쪽이 지은 표시 이름(`label`,
  // `KEY · 이름` 꼴)으로 바뀐다. renameGroup과 달리 **바뀐 행의 id 목록**을 돌려준다 —
  // 되돌리기(moveGroupUndo)가 그 id들만 반대로 돌려야 하기 때문이다(옮긴 뒤 이 에픽에 새로 생긴
  // 행은 건드리면 안 된다).
  function moveGroup(from, to, label) {
    const state = read();
    const head = `group:${from}:`;
    const ids = [];
    const fix = (row) => {
      if (!row || typeof row !== 'object') return false;
      let touched = false;
      if (typeof row.bucket === 'string' && row.bucket.startsWith(head)) { row.bucket = `jira:${to}:${row.bucket.slice(head.length)}`; touched = true; }
      if (row.group === from) { row.group = label; touched = true; }
      (Array.isArray(row.evidence) ? row.evidence : []).forEach((item) => {
        if (item && item.label === from) { item.label = label; touched = true; }
      });
      const childTouched = (Array.isArray(row.parts) ? row.parts : []).map(fix).some(Boolean);
      return touched || childTouched;
    };
    for (const week of Object.values(state.weeks || {})) {
      (week?.rows || []).forEach((row) => { if (fix(row)) ids.push(row.id); });
    }
    const names = moveNames(state, `group:${from}`, `jira:${to}`) + moveNames(state, `name:${from}`, `name:${label}`);
    if (ids.length || names) atomicWrite(filename, JSON.stringify(state, null, 2));
    return ids;
  }
  // moveGroup의 반대 방향. **기록에 있는 그 행 id들만** 되돌린다 — id가 더는 없으면(그 사이 지워짐)
  // 건너뛴다.
  //
  // 짝은 **bucket**으로 찾는다(표시 이름이 아니라). 옮긴 뒤에 그 에픽의 별칭을 바꾸거나 지우면
  // 표시 이름이 `KEY · 새 이름`·`KEY`로 다시 지어지는데(relabelProject), 예전처럼 "옮길 때의 이름과
  // 같을 때만" 되돌리면 bucket만 돌아오고 프로젝트 이름은 지라 쪽 이름으로 남아 되돌리기가 반만 됐다.
  // 그래서 bucket이 그 에픽을 가리키는 행은 `group`을 지금 값이 무엇이든 원래 이름으로 돌린다.
  // 근거 줄의 이름은 `KEY · `로 시작하거나 옮길 때의 이름과 같을 때 돌린다(우연히 같은 글자를 쓰는
  // 다른 근거는 건드리지 않는다). bucket이 없는 행(여러 프로젝트를 묶은 문장 등)은 예전처럼 이름으로만 본다.
  function moveGroupUndo(ids, from, to, label) {
    const state = read();
    const set = new Set(Array.isArray(ids) ? ids : []);
    const head = `jira:${to}:`;
    const aliasHead = `${to} · `;
    const fromJira = value => typeof value === 'string' && (value === label || value === to || value.startsWith(aliasHead));
    let restored = 0;
    const fix = (row) => {
      if (!row || typeof row !== 'object') return false;
      let touched = false;
      const moved = typeof row.bucket === 'string' && row.bucket.startsWith(head);
      if (moved) { row.bucket = `group:${from}:${row.bucket.slice(head.length)}`; touched = true; }
      if (moved ? row.group !== from : fromJira(row.group)) { row.group = from; touched = true; }
      (Array.isArray(row.evidence) ? row.evidence : []).forEach((item) => {
        if (item && fromJira(item.label)) { item.label = from; touched = true; }
      });
      (Array.isArray(row.parts) ? row.parts : []).forEach(fix);
      return touched;
    };
    for (const week of Object.values(state.weeks || {})) {
      for (const row of (week?.rows || [])) {
        if (!set.has(row.id)) continue;
        if (fix(row)) restored += 1;
      }
    }
    // 소제목 이름은 행 id가 아니라 열쇠에 붙어 있다 — 에픽 열쇠의 이름을 원래 그룹 열쇠로 돌린다(그룹 쪽에 이미 있으면 그대로).
    const names = moveNames(state, `jira:${to}`, `group:${from}`) + moveNames(state, `name:${label}`, `name:${from}`);
    if (restored || names) atomicWrite(filename, JSON.stringify(state, null, 2));
    return { restored, skipped: set.size - restored };
  }
  // read는 한 번 읽은 보고 기록을 weeks·view에 함께 넘겨 주 수만큼 다시 읽지 않게 하려고 내보낸다.
  return {view,change,weeks,read,renameGroup,relabelProject,moveGroup,moveGroupUndo};
};
