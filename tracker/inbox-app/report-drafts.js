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
// 보고 줄의 끝말 다듬기 — AI가 아니라 규칙이다. 업무 제목 끝의 `요청 답하기`·`하기`·`했음`만 떼어 짧은 명사구로 둔다
// (`환불 정책 문서 1차 작성했음` → `환불 정책 문서 1차 작성`). 떼고 남은 글이 2자 미만이면(`하기`·`확인했음` 같은 짧은 제목)
// 그대로, 80자에서 잘린 글(`…`)도 그대로다. 업무 제목은 바뀌지 않고 근거(`evidence`)에 전문이 남는다.
const trimEnd = (text) => {
  const value = String(text || '').trim();
  if (value.endsWith('…')) return value;
  const cut = value.replace(/\s*요청 답하기$/, '').replace(/(하기|했음)$/, '').trim();
  return cut.length >= 2 ? cut : value;
};
const taskText = item => (['task', 'bug'].includes(item.type) ? trimEnd(firstSentence(item.description)) : item.description);
// 끝낸 일의 결과 한 줄(outcome)은 사람이 쓴 글이라 다듬지 않는다.
const textOf = items => [...new Set(items.map(item => item.status === 'done' && item.outcome ? item.outcome : taskText(item)))].join('\n');
// 업무가 설 프로젝트 이름(보고 소제목·할 일 칸 미리 채운 줄이 같은 규칙을 쓴다).
const labelOf = item => item.label || item.group || item.project || '그룹 없음';
// 새 프로젝트 이름으로 받지 않는 말 — 보고가 "프로젝트 없음"으로 읽는 이름들(화면 report-ui.js REPORT_RESERVED_NAMES와 같은 목록).
const RESERVED_NAMES = new Set(['기타', '그룹 없음', '직접 작성', '프로젝트 없음']);
const RESERVED_NAME_ERROR = '`기타`·`그룹 없음`·`직접 작성`·`프로젝트 없음`은 새 프로젝트 이름으로 쓸 수 없어요. 다른 이름을 적어 주세요.';
// 프로젝트가 없는 줄의 이름(한 일 칸은 `그룹 없음`, 할 일 칸은 `직접 작성`).
const noProject = name => !name || name === '그룹 없음' || name === '직접 작성';
// 업무의 프로젝트 열쇠(`jira:KEY`·`group:이름`), 없으면 null — 옮기기와 그 되돌리기가 견준다.
const projectKeyOf = item => (project(item) === 'ungrouped' ? null : project(item));

// ---------- 다듬기(제목·소제목 이름·새로 표시) ----------
// 사람이 고친 보고 제목과 소제목 이름, 그리고 "마지막으로 다듬은 때 무엇을 봤는지"는 파일 맨 위의 `weekPolish` 칸에
// 주마다 둔다: `{ [weekKey]: { title?, names?: { '소제목|프로젝트 열쇠': 이름 }, seen?: { at, ids: { 업무 id: 지문 } } } }`.
// 주(`weeks[weekKey]`) 안이 아니라 맨 위에 두는 이유: 옛 앱(1.2.1)의 change()는 주 칸을 `{rows, updatedAt}`로 통째로
// 새로 쓰므로 그 안의 모르는 칸은 버리지만, 파일 맨 위는 읽은 그대로 다시 쓴다(renameGroup 등도 같다). 문장 행에는
// 새 칸을 더하지 않는다 — 소제목·새로 표시는 view()가 그때그때 계산해 내보내고 clean()이 저장 전에 걷는다.
const HEADINGS = ['완료한 일', '진행중', '새로 정해진 것', '확인 완료', '확인 대기'];
// 결정·확인 줄은 처음부터 보고에서 빠져 있다 — 사람이 `다시 넣기`(change의 include)를 누른 줄(`included`)만 보고에 든다.
// 저장된 `excluded`는 건드리지 않고 view()가 보이는 결과에서만 빼며(`optOut`), clean()이 저장 전에 되돌린다.
const OPT_IN = new Set(['새로 정해진 것', '확인 완료', '확인 대기']);
// 한 일 칸의 소제목 이름을 찾는 차례 — 칸이 둘(한 일·할 일)이 된 뒤로 한 프로젝트의 완료·진행 중·결정·확인 줄이 한
// 소제목 아래 서므로, 이름은 `완료한 일|열쇠` → `진행중|열쇠` → 그 줄 자기 소제목 자리 순서로 찾는다(옛 이름도 그대로 읽힌다).
const NAME_ORDER = ['완료한 일', '진행중'];
// 한 줄의 소제목 이름을 찾는 자리 목록 — view()가 읽고 rename이 비울 때 같은 목록으로 지운다(어긋나면 원래대로가 안 된다).
const nameHeads = own => own === PLAN_HEADING ? [own] : [...new Set([...NAME_ORDER, own])];
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
// 그 주 월요일에서 며칠 뒤의 날짜(`YYYY-MM-DD`, 지역 시간).
const dayAfter = (weekKey, days) => {
  const date = new Date(`${weekKey}T12:00:00`);
  date.setDate(date.getDate() + days);
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
// `tasks`는 보고 칸의 `+ 한 줄 추가`(addLine)가 업무를 만들고 되돌리기가 지우는 길이다 — `{ create({ description, done,
// completed, jira, group }) → id, remove(id, keep) }`. 없으면 addLine을 거절한다. 서버(server.js)에서는 이 두 함수와 보고 저장이
// 한 요청의 저장 트랜잭션(mutations.run) 안에서 돌아, 어느 한쪽이 실패하면 업무 파일과 보고 저장본이 함께 되돌아간다.
// 정리 막대의 `프로젝트 옮기기`(move)도 같은 틀이다 — `tasks.setProject(id, 열쇠|null)`(업무의 jira·group 칸만 바꾼다)와
// `tasks.findProject(이름) → 열쇠|null`(같은 이름의 프로젝트 — 직접 만든 이름·지라 요약·별칭). 없으면 move를 거절한다.
module.exports = ({ directory, sources, legacy, currentWeek, bundles = () => [], projectLabel = () => null, tasks = null }) => {
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
    const names = polish.names && typeof polish.names === 'object' && !Array.isArray(polish.names) ? polish.names : {};
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
      // 바꾼 이름은 대표 열쇠에서 먼저 찾고, 없으면 묶음의 다른 열쇠를 차례로 본다 — 이름을 바꾼 뒤 대표를 바꿔도
      // (저장된 이름은 옛 대표 열쇠에 있다) 이름이 사라지지 않게. 찾은 열쇠는 `nameKey`로 알려 rename이 그 자리를 치운다.
      // 묶음을 풀면 각 티켓은 자기 열쇠만 보므로 이름은 그 이름이 저장된(바꿀 때의 대표) 티켓 소제목에만 남는다.
      const tries = bundle ? [bundle.lead, ...bundle.keys.filter(entry => entry !== bundle.lead)] : [key];
      const heads = nameHeads(row.heading);
      const has = slot => typeof names[slot] === 'string' && names[slot] && Object.prototype.hasOwnProperty.call(names, slot);
      let found = null, slot = null;
      for (const entry of tries) { const head = heads.find(name => has(`${name}|${entry}`)); if (head) { found = entry; slot = `${head}|${entry}`; break; } }
      const custom = slot ? names[slot] : null;
      if (custom) { row.shownGroup = custom; row.groupOrigin = projectLabel(key) || natural; row.nameKey = found; }
      else if (natural !== row.group) row.shownGroup = natural;
    });
  }
  // 새로·바뀜 표시 — 마지막으로 다듬은(또는 `모두 확인`한) 때 본 업무(`seen.ids`)와 견준다. 그런 기록이 없으면(옛 데이터·
  // 아직 한 번도 다듬지 않은 주) 아무 표시도 없다. 행의 업무가 전부 처음 보는 것이면 `fresh`, 일부가 처음이거나
  // 본 뒤 문구·상태가 바뀌었으면 `changed`. 제외한 문장·다음 주 계획은 세지 않는다.
  function marks(rows, seen, byId) {
    if (!seen || !seen.ids || typeof seen.ids !== 'object' || Array.isArray(seen.ids)) return null;
    const known = id => Object.prototype.hasOwnProperty.call(seen.ids, id);
    let fresh = 0, changed = 0;
    rows.forEach((row) => {
      if (row.excluded || row.heading === PLAN_HEADING) return;
      // 줄 끝 알약(원본 바뀜·새 업무·끝났어요 등 — 제안이 있는 줄)이 이미 알리는 변화는 상태 줄에서 다시 세지 않는다.
      if (row.suggestion) return;
      const own = row.sourceIds || [];
      const all = [...new Set([...own, ...(row.suggestion?.sourceIds || [])])];
      if (!all.length) return;
      if (own.length && own.every(id => !known(id))) { row.fresh = true; fresh += 1; return; }
      if (all.some(id => !known(id) || seen.ids[id] !== sourceMark(byId.get(id)))) { row.changed = true; changed += 1; }
    });
    return { at: typeof seen.at === 'string' ? seen.at : null, fresh, changed };
  }
  // 다듬기 칸이 손상돼 배열로 들어 있으면(주 칸이든 맨 위 칸이든) 없는 것으로 본다 — 배열에 이름 붙은 칸을 달면
  // JSON으로 쓸 때 조용히 사라지므로, 저장할 때도 새 객체로 바꿔 쓴다.
  const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const polishWeeks = state => (isPlain(state.weekPolish) ? state.weekPolish : {});
  const polishOf = (state, weekKey) => {
    const value = polishWeeks(state)[weekKey];
    return isPlain(value) ? value : {};
  };
  function view(weekKey, state = read(), sourceSnapshot, opts = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) throw new Error('주간 날짜를 확인해 주세요.');
    const all = sourceSnapshot || sources(), byId = new Map(all.map(item => [item.id,item]));
    const old = legacy().find(entry => entry.weekKey === weekKey);
    const stored = state.weeks[weekKey];
    const rows = structuredClone(stored?.rows || importLegacy(old?.body || '', all));
    const claimed = new Set(rows.flatMap(row => row.sourceIds));
    const candidates = all.filter(item => eligible(item,weekKey) && !claimed.has(item.id));
    const polish = polishOf(state, weekKey);
    // 확정(`weekPolish[주].lockedAt`, 선택) — 확정한 주는 자동 모으기가 문장을 더 넣거나 고치지 않는다. 있던 문장은 전부
    // 고친 문장처럼 다뤄 원본이 바뀌면 제안만 하고, 새 업무는 문장이 되지 않고 `confirmed.pending`(줄 수)로만 센다.
    // `opts.release`(보고에 넣기 — change의 pullNew만)는 그 새 줄만 풀어 준다(있던 문장에 더하지 않고 새 줄로).
    const lockedAt = typeof polish.lockedAt === 'string' && polish.lockedAt ? polish.lockedAt : null;
    const hold = !!lockedAt && !opts.release;
    const weekEnd = dayAfter(weekKey, 6);
    // 확인 필요 판단에 쓰는 행마다의 사실(지워진 근거·섞인 상태) — 아래 reviewOf가 읽는다. 저장하지 않는다.
    const facts = new Map();
    for (const row of rows) {
      // 미리 채운 할 일 칸 줄은 근거(sourceIds)가 없는 계획 줄이다 — 자동 모으기·제안 대상이 아니다(아래 미리 채우기가 따로 다룬다).
      if (row.origin === 'carry' && row.heading === PLAN_HEADING) { row.needsReview = false; row.currentEvidence = []; continue; }
      const linked = row.sourceIds.map(id => byId.get(id)).filter(Boolean);
      const currentEvidence = linked.map(evidence);
      const missing = linked.length !== row.sourceIds.length;
      const added = row.bucket && !row.excluded && !lockedAt ? candidates.filter(item => bucket(item) === row.bucket && !claimed.has(item.id)) : [];
      added.forEach(item => claimed.add(item.id));
      const combined = [...linked, ...added];
      const mixed = new Set(combined.map(heading)).size > 1;
      if (row.locked || row.excluded || weekKey < currentWeek() || lockedAt) {
        const changed = !row.legacy && hash(currentEvidence) !== hash(row.evidence);
        if (added.length || changed || missing) row.suggestion = { text: textOf(combined), sourceIds: combined.map(item=>item.id), evidence: combined.map(evidence), added: added.length, missing, mixed };
      } else if (combined.length && !missing && !mixed) {
        row.text = textOf(combined); row.sourceIds = combined.map(item=>item.id); row.evidence = combined.map(evidence);
        row.heading = heading(combined[0]); row.bucket = bucket(combined[0]);
        row.group=combined[0].label || combined[0].group || combined[0].project || '그룹 없음';
      } else row.suggestion = { text: textOf(combined), sourceIds: combined.map(item=>item.id), evidence: currentEvidence, added: added.length, missing, mixed };
      row.needsReview = !!row.suggestion || mixed || missing;
      row.currentEvidence = currentEvidence;
      facts.set(row, { linked, missing, mixed });
      // 완료 제안(`끝났어요 · 완료로`) — 사람이 고쳤거나(또는 확정으로 굳은) 진행 중 문장의 업무가 **이 주 안에** 전부 끝났고,
      // 업무 문구는 그대로일 때만. 문구까지 바뀌었으면 원래 제안(원본 바뀜)만 선다 — 옮기면서 바뀐 문구를 묻어 버리지 않게.
      if (row.heading === '진행중' && !row.excluded && row.suggestion && !row.suggestion.added && !missing && linked.length
        && linked.every(item => ['task','bug'].includes(item.type) && item.status === 'done' && item.completed && item.completed >= weekKey && item.completed <= weekEnd)) {
        const said = new Map((row.evidence || []).map(entry => [entry.id, entry.description]));
        if (linked.every(item => said.get(item.id) === item.description)) row.completable = true;
      }
    }
    const groups = new Map();
    candidates.filter(item=>!claimed.has(item.id)).forEach(item=>{ const key=bucket(item); if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item); });
    let pending = 0, pendingDone = 0;
    // 확정한 주에 붙들어 둔 새 업무 중 끝낸 일(완료한 일 칸에 설 것)만 한 건씩 — 화면의 `보고에 없는 끝낸 일 N`과
    // 한 줄씩 넣기(change의 pullOne)가 읽는다. 확정 전 주·진행 중·결정·확인은 없다(넣기는 완료 칸만, addLine 규칙과 같다).
    const materialPending = [];
    // 결정·확인 묶음은 넣어도 처음부터 빠진 줄(optOut)이라 `보고에 없는 새 줄 N`에 세지 않는다 — 세면 `모두 넣기`를 눌러도 글이 그대로다.
    for (const [key,items] of groups) if (hold) { if (!OPT_IN.has(heading(items[0]))) pending += 1; if (heading(items[0]) === '완료한 일') { pendingDone += 1;
      items.forEach(item => materialPending.push({ id: item.id, description: item.description, label: item.label || item.group || item.project || '그룹 없음', completed: item.completed || null })); } } else rows.push({ id:`auto-${hash([key,items.map(item=>item.id).sort()]).slice(0,16)}`,bucket:key,heading:heading(items[0]),group:items[0].label || items[0].group || items[0].project || '그룹 없음', text:textOf(items),sourceIds:items.map(item=>item.id),evidence:items.map(evidence),currentEvidence:items.map(evidence),locked:false,excluded:false,needsReview:false });
    // 결정·확인 줄은 `다시 넣기`(included) 전까지 보고에서 빠진 줄로 보인다 — 확인 필요·새로 표시·슬랙 글 모두 제외로 센다.
    rows.forEach((row) => { if (OPT_IN.has(row.heading) && !row.included && !row.excluded) { row.excluded = true; row.optOut = true; } });
    // 할 일 칸 미리 채우기 — 이번 주·확정 전 보고에만, ⓐ 진행 중 업무 ⓑ 지난주 보고의 계획 줄 중 업무와 이어진(`planOf`) 것이
    // 아직 안 끝난 것 둘만 넣는다(실행일·기한만 보고 넣지는 않는다). 줄은 `origin:'carry'`·`planOf`=업무 id·`locked:false`이고,
    // 같은 업무를 가리키는 계획 줄이 이미 있으면(뺀 줄 포함) 넣지 않는다 — 덜어 낸 줄이 다시 들어오지 않게. 안 고친 미리 채운
    // 줄은 업무가 끝나거나 지워지면 빠지고, 남아 있으면 업무 제목을 따라간다. 왜 들어왔는지(`carryWhy`)는 계산 값이다(저장 안 함).
    // GET은 파일을 쓰지 않으므로 화면이 복사 성공 때 `keep`으로 한 번 적는다.
    if (weekKey === currentWeek() && !lockedAt) {
      const open = item => !!item && ['task', 'bug'].includes(item.type) && item.status !== 'done';
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.origin !== 'carry' || row.locked || row.excluded || row.heading !== PLAN_HEADING || typeof row.carryOf === 'string') continue;
        const item = byId.get(row.planOf);
        if (!open(item)) { rows.splice(index, 1); continue; }
        row.text = textOf([item]); row.group = labelOf(item);
      }
      const taken = new Set(rows.filter(row => row.heading === PLAN_HEADING && typeof row.planOf === 'string').map(row => row.planOf));
      const lastRows = state.weeks[dayAfter(weekKey, -7)]?.rows || [];
      const planned = lastRows
        .filter(row => row && row.heading === PLAN_HEADING && !row.excluded && typeof row.planOf === 'string').map(row => row.planOf);
      const carried = [...all.filter(item => open(item) && item.doing), ...planned.map(id => byId.get(id)).filter(open)];
      for (const item of carried) {
        if (taken.has(item.id)) continue;
        taken.add(item.id);
        rows.push({ id: `carry-${hash([weekKey, item.id]).slice(0, 16)}`, heading: PLAN_HEADING, group: labelOf(item), text: textOf([item]),
          sourceIds: [], evidence: [], currentEvidence: [], locked: false, excluded: false, needsReview: false, origin: 'carry', planOf: item.id });
      }
      // 지난주 계획 이어 보기(②) — 업무와 이어지지 않은(직접 적은) 지난주 계획 줄은 끝났는지 앱이 모르므로 **흐리게 빠진 채**
      // 들어온다(아직 할 일이면 사람이 `다시 넣기`). 같은 지난주 줄을 가리키는 줄(`carryOf`)이 이미 있으면(뺀 줄 포함) 넣지 않는다 —
      // 한 번 저장되면 다시 오지 않는다. 지난주에 뺀 줄·업무와 이어진 줄(위 ⓑ)은 보지 않는다.
      const echoed = new Set(rows.filter(row => typeof row.carryOf === 'string').map(row => row.carryOf));
      for (const prev of lastRows) {
        if (!prev || prev.heading !== PLAN_HEADING || prev.excluded || typeof prev.planOf === 'string' || typeof prev.id !== 'string'
          || typeof prev.text !== 'string' || !prev.text.trim() || echoed.has(prev.id)) continue;
        echoed.add(prev.id);
        rows.push({ id: `carry-${hash([weekKey, 'row', prev.id]).slice(0, 16)}`, heading: PLAN_HEADING, group: typeof prev.group === 'string' && prev.group ? prev.group : '직접 작성',
          text: prev.text, sourceIds: [], evidence: [], currentEvidence: [], locked: false, excluded: true, needsReview: false, origin: 'carry', carryOf: prev.id });
      }
      rows.forEach((row) => {
        if (row.origin !== 'carry') return;
        if (typeof row.carryOf === 'string') row.carryWhy = 'note';
        else if (open(byId.get(row.planOf))) row.carryWhy = byId.get(row.planOf).doing ? 'doing' : 'plan';
      });
    }
    dress(rows, weekKey, polish, opts.bundles !== undefined ? opts.bundles : bundles());
    // `기타`(②) — 정리 막대에서 `기타`로 옮긴 줄은 업무 프로젝트가 비고, 보고에서만 `weekPolish[주].etc`(업무 id·할 일 칸 줄 id)로
    // 프로젝트들 맨 끝 `기타` 소제목 아래 선다(`etc` 계산 값 — 저장 안 함). 업무에 다시 프로젝트가 생기면 그 프로젝트로 간다.
    const etc = new Set(Array.isArray(polish.etc) ? polish.etc.filter(value => typeof value === 'string') : []);
    if (etc.size) rows.forEach((row) => {
      if (!noProject(row.group)) return;
      if (row.heading === PLAN_HEADING ? etc.has(row.id) : (row.sourceIds || []).some(id => etc.has(id))) row.etc = true;
    });
    const since = marks(rows, polish.seen, byId);
    const order=['완료한 일','진행중','새로 정해진 것','확인 완료','확인 대기',PLAN_HEADING];
    rows.forEach(row=>{if(row.evidence.some(item=>/\(.*확인 필요.*\)|\(미확정\)/.test(item.description)))row.needsReview=true;});
    // 확인 필요(개편 A) — 보내기 전에 사람이 볼 이유 하나(가장 급한 것)를 행에 붙인다. 화면은 표시만 하고 슬랙 글에는 넣지 않는다.
    // undone: 근거 업무가 아직 안 끝났는데 문장이 `완료한 일`에 있다(확정·고친 줄에서 생긴다) · missing: 근거 업무가 지워졌다 ·
    // mixed: 근거 업무의 상태가 섞였다 · changed: 원본이 바뀌어 제안이 섰다(`끝났어요 · 완료로`가 선 줄은 뺀다 — 그 제안이 말한다) ·
    // marked: 근거 업무 제목에 `(확인 필요)`·`(미확정)`. 결과 한 줄이 빈 것은 이유가 아니다(화면의 근거 줄에만 보인다).
    // 제외한 문장·다음 주 계획은 보지 않는다. 옛 화면이 읽는 needsReview는 그대로 둔다. clean()이 저장 전에 걷는다.
    const reviewOf = (row) => {
      if (row.excluded || row.heading === PLAN_HEADING) return null;
      const fact = facts.get(row) || { linked: row.sourceIds.map(id => byId.get(id)).filter(Boolean), missing: false, mixed: false };
      if (row.heading === '완료한 일' && fact.linked.some(item => ['task','bug'].includes(item.type) && item.status !== 'done')) return 'undone';
      if (fact.missing) return 'missing';
      if (fact.mixed) return 'mixed';
      if (row.suggestion && !row.completable) return 'changed';
      if (row.evidence.some(item => /\(.*확인 필요.*\)|\(미확정\)/.test(item.description))) return 'marked';
      return null;
    };
    rows.forEach(row => { const reason = reviewOf(row); if (reason) row.review = { reason }; else delete row.review; });
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
    // 머리의 `확인 필요 N ›`이 읽는 값 — 개수와 문서 순서의 첫 문장. 접힌 부모 아래의 문장이 걸리면 그 부모로 간다(화면에 보이는 줄).
    const reviewed = visible.filter(row => row.review);
    const anchorOf = (row) => { const parent = row.parent ? byRowId.get(row.parent) : null; return parent && parent.folded ? parent.id : row.id; };
    // 제목·소제목 이름·새로 기록도 revision에 든다 — 다른 창에서 바꾼 것을 모르고 덮어쓰지 않게.
    const revision = hash({ stored, rows: ordered, polish });
    return { weekKey, rows: visible, revision, updatedAt: stored?.updatedAt || null, title: typeof polish.title === 'string' && polish.title ? polish.title : null, since,
      confirmed: lockedAt ? { at: lockedAt, pending, pendingDone } : null,
      review: { count: reviewed.length, first: reviewed.length ? anchorOf(reviewed[0]) : null },
      material: { pending: materialPending },
      ...(opts.raw ? { byId } : {}) };
  }
  function clean(row) {
    const { suggestion, needsReview, currentEvidence, canSplit, partCount, groupKey, shownGroup, groupOrigin, nameKey, fresh, changed, completable, review, optOut, carryWhy, etc, ...rest } = row;
    if (optOut) rest.excluded = false;
    return rest;
  }
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
  function change({ weekKey, revision, action, id, parentId, text, ids, token, group, planOf: planSource, folded, heading: groupHeading, groupKey, on, out, to }) {
    const state=read(), base=view(weekKey,state,undefined,{raw:true});
    if (revision !== base.revision) { const error=new Error('새 기록이나 다른 창의 변경이 있어요. 적은 내용은 그대로 있어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.');error.status=409;throw error; }
    // 묶기 전 문장은 화면으로 나가지 않으므로(view가 `canSplit`만 알린다) 저장 파일에서 다시 붙인다.
    // `parts`는 서버가 merge에서만 만든다 — 요청 본문의 값은 받지 않는다.
    const storedParts=new Map((state.weeks[weekKey]?.rows||[]).filter(row=>row.parts).map(row=>[row.id,row.parts]));
    // 고아 규칙에 걸린 `parent`는 view가 결과에서만 뺀다 — 저장 파일의 값은 조용히 지우지 않는다.
    const storedParents=new Map((state.weeks[weekKey]?.rows||[]).filter(row=>row.parent).map(row=>[row.id,row.parent]));
    const carry=row=>{const next=clean(row);if(storedParts.has(row.id))next.parts=storedParts.get(row.id);
      if(next.parent===undefined&&storedParents.has(row.id))next.parent=storedParents.get(row.id);return next;};
    // `보고에 넣기`(pullNew)만 확정으로 붙들어 둔 새 줄을 풀어 본 결과에서 시작한다 — 되돌리기는 그 전(base)으로 돌아간다.
    const current=action==='pullNew'&&base.confirmed&&base.confirmed.pending?view(weekKey,state,undefined,{raw:true,release:true}):base;
    let rows=current.rows.map(carry); const row=rows.find(row=>row.id===id), shown=current.rows.find(row=>row.id===id);
    // `+ 한 줄 추가`가 만든 업무 — 되돌리기 기록에 남겨 되돌릴 때 함께 지운다. 업무 파일을 건드렸으면 화면이 목록을 다시 받게 알린다.
    let createdTask=null, tasksChanged=false, keepUndo=true, pulledOne=null, movedTasks=null, skippedTasks=0;
    // 정리 막대가 고른 줄들(setOut·follow·move) — 전부 지금 보고에 있어야 한다. 한 요청 = 한 저장 = 되돌리기 하나다.
    const picked=()=>{
      if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(value=>typeof value!=='string')||new Set(ids).size!==ids.length)throw new Error('고른 줄을 확인해 주세요.');
      const list=ids.map(rowId=>({row:rows.find(entry=>entry.id===rowId),shown:current.rows.find(entry=>entry.id===rowId)}));
      if(list.some(entry=>!entry.row||!entry.shown))throw new Error('고른 줄을 찾을 수 없어요. 최신 보고를 확인해 주세요.');
      return list;
    };
    // 이 주의 다듬기 칸(제목·소제목 이름·새로 기록). 되돌리기는 문장과 함께 이 칸도 그 전으로 돌린다.
    const polishBefore=structuredClone(polishOf(state,weekKey));
    let polish=structuredClone(polishBefore);
    if(action==='undo') {
      const prior=undo.get(token); if(!prior || prior.weekKey!==weekKey)throw new Error('되돌리기 기록이 만료됐어요.');
      if(hash({rows:state.weeks[weekKey]?.rows,polish:polishOf(state,weekKey)})!==prior.after)throw new Error('그 뒤에 다른 변경이 있어 되돌릴 수 없어요. 최신 보고를 확인해 주세요.');
      rows=prior.rows; polish=structuredClone(prior.polish||{});
      // `+ 한 줄 추가`를 되돌리면 그때 만든 업무도 지운다 — 늘 지운 항목(설정 › 삭제한 항목, `.trash.json`)에 남긴다.
      // 그 사이 오늘 탭에서 마감·우선순위·일정·진행 중 같은 칸을 더했을 수 있고, 지문(sourceMark)은 그 칸들을 보지 않아서다.
      // 이 되돌리기는 다시 되돌리지 않는다(업무가 없는 줄만 돌아오므로).
      if(prior.createdTask&&tasks){
        const made=current.byId.get(prior.createdTask.id);
        if(made)tasks.remove(prior.createdTask.id,true);
        tasksChanged=true; keepUndo=false;
      }
      // `프로젝트 옮기기`를 되돌리면 그때 옮긴 업무도 원래 프로젝트로 돌린다 — 지금도 옮긴 그 프로젝트에 있는 업무만
      // (그 사이 다른 곳에서 바꾼 업무는 덮지 않고 건너뛴다). 이 되돌리기도 다시 되돌리지 않는다(업무가 반만 돌아오므로).
      if(prior.movedTasks&&tasks){
        for(const entry of prior.movedTasks){
          const now=current.byId.get(entry.id);
          if(now&&projectKeyOf(now)===entry.to)tasks.setProject(entry.id,entry.from); else skippedTasks+=1;
        }
        tasksChanged=true; keepUndo=false;
      }
    } else if(action==='retitle') {
      // 보고 제목. 빈 값이면 원래 제목(`이번 주`·`9월 4주차`)으로 돌아간다.
      const title=polishName(text,'보고 제목');
      if(title)polish.title=title; else delete polish.title;
    } else if(action==='rename') {
      // 소제목 이름 — 프로젝트 열쇠에 묶인다(화면이 보고 있던 소제목의 열쇠만 받는다). 빈 값이나 원래 이름과 같으면
      // 원래 이름으로 돌아간다. 문장·연결·프로젝트는 하나도 바뀌지 않는다.
      // 한 일 칸(칸이 둘인 화면)은 `완료한 일`로 보낸다 — 그 프로젝트에 완료 줄이 없어도(진행 중·결정만) 같은 열쇠의 줄이면 된다.
      const inSlot=entry=>entry.groupKey===groupKey&&(entry.heading===groupHeading||(groupHeading==='완료한 일'&&entry.heading!==PLAN_HEADING));
      if(typeof groupHeading!=='string'||typeof groupKey!=='string'||groupHeading===PLAN_HEADING
        ||!current.rows.some(inSlot))throw new Error('이름을 바꿀 소제목을 찾을 수 없어요. 최신 보고를 확인해 주세요.');
      const name=polishName(text,'소제목 이름');
      const sample=current.rows.find(inSlot);
      const natural=sample.groupOrigin||sample.shownGroup||sample.group;
      const plain=String(natural).replace(/^[A-Z][A-Z0-9]*-\d+ · /,'');
      const names={...(isPlain(polish.names)?polish.names:{})};
      // 이름이 옛 대표 열쇠에서 찾아진 것이면(대표를 바꾼 뒤) 그 자리도 함께 치우고 지금 대표 열쇠에 쓴다.
      if(sample.nameKey&&sample.nameKey!==groupKey)delete names[`${groupHeading}|${sample.nameKey}`];
      // `완료한 일|열쇠`에 쓸 때는 한 일 칸 줄이 읽을 수 있는 다른 이름 자리(옛 `진행중|열쇠`·결정·확인 줄 자기 소제목 자리)도
      // 치운다 — view()는 그 자리들을 차례로 읽으므로, 남겨 두면 원래대로가 안 된다(지금 없는 상태의 줄이 나중에 생겨도 같다).
      if(groupHeading==='완료한 일'){
        const keys=new Set([groupKey,...current.rows.filter(inSlot).map(entry=>entry.nameKey)].filter(Boolean));
        for(const head of new Set(HEADINGS.flatMap(nameHeads)))
          if(head!=='완료한 일')for(const key of keys)delete names[`${head}|${key}`];
      }
      if(!name||name===natural||name===plain)delete names[`${groupHeading}|${groupKey}`]; else names[`${groupHeading}|${groupKey}`]=name;
      if(Object.keys(names).length)polish.names=names; else delete polish.names;
    } else if(action==='ackNew') {
      // `모두 확인` — 지금 보이는 업무를 전부 본 것으로 적는다(새로·바뀜 표시가 걷힌다). 문장은 그대로다.
    } else if(action==='confirm') {
      // 확정(선택) — 이 주의 문장을 자동 모으기가 더 흔들지 않게 한다(view의 `lockedAt`). 이미 확정했으면 처음 때를 그대로 둔다.
      // 확정은 "다 봤다"는 뜻이라 지금 보이는 업무를 전부 본 것으로 적는다(모두 확인과 같다).
      if(!(typeof polish.lockedAt==='string'&&polish.lockedAt))polish.lockedAt=new Date().toISOString();
    } else if(action==='unconfirm') {
      if(!(typeof polish.lockedAt==='string'&&polish.lockedAt))throw new Error('확정하지 않은 보고예요.');
      delete polish.lockedAt;
    } else if(action==='pullNew') {
      // `보고에 넣기` — 확정 뒤 새로 들어온 업무를 새 줄로 넣는다(있던 문장에 더하지 않는다). 확정은 그대로다.
      if(!base.confirmed)throw new Error('확정한 보고에서만 넣을 수 있어요.');
      if(!base.confirmed.pending)throw new Error('새로 넣을 줄이 없어요. 최신 보고를 확인해 주세요.');
    } else if(action==='pullOne') {
      // 한 줄씩 넣기(개편 A) — 확정한 주에 붙들어 둔 끝낸 일 하나만 새 줄로 넣는다(있던 문장에 더하지 않는다). 확정은 그대로다.
      // 넣을 수 있는 것은 지금 `material.pending`에 있는 업무뿐이다 — 그 사이 지워졌거나 이미 들어갔으면 거절한다.
      if(!base.confirmed)throw new Error('확정한 보고에서만 넣을 수 있어요.');
      const wanted=Array.isArray(ids)&&ids.length===1&&typeof ids[0]==='string'?ids[0]:null;
      const item=wanted&&base.material.pending.some(entry=>entry.id===wanted)?base.byId.get(wanted):null;
      if(!item||heading(item)!=='완료한 일')throw new Error('넣을 업무를 찾을 수 없어요. 최신 보고를 확인해 주세요.');
      rows.push({id:randomUUID(),bucket:bucket(item),heading:heading(item),group:item.label||item.group||item.project||'그룹 없음',text:textOf([item]),
        sourceIds:[item.id],evidence:[evidence(item)],locked:false,excluded:false});
      pulledOne=item;
    } else if(action==='addLine') {
      // `+ 한 줄 추가` — 완료한 일·진행 중 칸의 소제목(프로젝트) 아래에 사람이 쓴 문장 그대로 한 줄. 같은 프로젝트의 업무도
      // 만든다(완료한 일이면 이 주에 끝낸 업무, 진행 중이면 진행 중 업무 — 흔적은 업무의 `source:weekly`). 업무를 먼저 만들고
      // 그 업무를 읽어 낸 뒤에 줄을 쓴다 — 서버에서는 둘이 한 트랜잭션이라 한쪽만 남지 않는다. 같은 요청을 다시 보내면
      // (Idempotency-Key) 서버가 앞 결과를 돌려준다.
      if(!tasks)throw new Error('이 앱에서는 보고에 줄을 더할 수 없어요.');
      if(groupHeading!=='완료한 일'&&groupHeading!=='진행중')throw new Error('완료한 일·진행 중 칸에만 한 줄을 더할 수 있어요.');
      if(typeof text!=='string'||!text.trim()||text.length>1000||/[\r\n]/.test(text))throw new Error('더할 문장을 1,000자 이내 한 줄로 적어 주세요.');
      if(weekKey>currentWeek())throw new Error('아직 오지 않은 주에는 줄을 더할 수 없어요.');
      if(groupHeading==='진행중'&&weekKey<currentWeek())throw new Error('지난 주 보고에는 진행 중 줄을 더할 수 없어요. 완료한 일 칸에 더해 주세요.');
      // 한 일 칸은 완료·진행 중·결정·확인 줄이 한 소제목 아래 서므로, 그 프로젝트의 줄이 칸 어디에든 있으면 된다.
      if(typeof groupKey!=='string'||!/^(jira:.+|group:.+|ungrouped)$/.test(groupKey)
        ||!current.rows.some(entry=>entry.groupKey===groupKey&&entry.heading!==PLAN_HEADING&&(entry.heading===groupHeading||groupHeading==='완료한 일')&&(!entry.excluded||entry.optOut)))throw new Error('줄을 더할 소제목을 찾을 수 없어요. 최신 보고를 확인해 주세요.');
      const project=groupKey.startsWith('jira:')?{jira:groupKey.slice(5)}:groupKey.startsWith('group:')?{group:groupKey.slice(6)}:{};
      // 완료일: 이번 주면 오늘(업무를 끝낼 때와 같다), 지난 주면 그 주 금요일(주말 날짜가 업무 목록에 서지 않게).
      const madeId=tasks.create({description:text.trim(),done:groupHeading==='완료한 일',completed:weekKey<currentWeek()?dayAfter(weekKey,4):null,...project});
      const made=sources().find(item=>item.id===madeId);
      if(!made||heading(made)!==groupHeading)throw new Error('업무를 만들지 못했어요. 적은 내용은 그대로 있어요.');
      rows.push({id:randomUUID(),heading:groupHeading,group:made.label||made.group||made.project||'그룹 없음',bucket:bucket(made),text:text.trim(),
        sourceIds:[made.id],evidence:[evidence(made)],locked:true,excluded:false,origin:'weekly'});
      createdTask={id:made.id,mark:sourceMark(made)}; tasksChanged=true;
    } else if(action==='keep') {
      // 복사한 뒤 지금 보이는 줄(미리 채운 할 일 칸 줄 포함)을 그대로 파일에 적는다 — 문장·새로 기록·되돌리기는 그대로다.
      // GET은 파일을 쓰지 않아서, 한 번도 저장하지 않은 주의 미리 채운 줄은 다음 주의 `지난주 계획`이 되지 못한다.
      // 줄 차례만 다른 것은 바뀐 것이 아니다(add는 맨 뒤에 붙이고 view는 소제목·이름순으로 세운다) — 쓰지 않아야 그 전 ⌘Z가 살아 있다.
      keepUndo=false;
      const byId=list=>[...(list||[])].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
      if(hash(byId(rows))===hash(byId(state.weeks[weekKey]?.rows)))return {ok:true,report:view(weekKey,state),undoToken:null};
    } else if(action==='add') {
      if(typeof text!=='string'||!text.trim()||text.length>10000)throw new Error('보고 문장을 입력해 주세요.');
      const link=planOf(planSource);
      rows.push({id:randomUUID(),heading:PLAN_HEADING,group:planGroup(group),text:text.trim(),sourceIds:[],evidence:[],locked:true,excluded:false,...(link?{planOf:link}:{})});
    } else if(action==='setOut') {
      // 정리 막대 `보고에서 빼기`(out) / `다시 넣기` — 여러 줄을 한 번에. 결정·확인 줄은 처음부터 빠져 있어 `included`로 넣고 뺀다
      // (include와 같은 규칙), 나머지는 `excluded`. 뺀 줄은 지우지 않고 제자리에 흐리게 남는다.
      if(typeof out!=='boolean')throw new Error('뺄지 넣을지 알려 주세요.');
      for(const {row:target,shown:seen} of picked()){
        if(OPT_IN.has(seen.heading)){ if(out)delete target.included; else target.included=true; target.excluded=false; }
        else {
          target.excluded=out;
          // 지난주 직접 적은 줄(carryOf)을 다시 넣으면 사람이 고른 줄이다 — 굳혀 둔다(옛 ① 앱이 미리 채운 줄로 보고 지우지 않게).
          if(!out&&typeof target.carryOf==='string')target.locked=true;
        }
      }
    } else if(action==='follow') {
      // `팔로업으로 묶기`(on) / `팔로업에서 빼기` — 행 안 `follow` 표시만 바꾼다(문장·자리는 그대로). 묶는 줄은 한 일 칸의
      // 프로젝트 있는 업무 줄만이고 보고에 든 줄이어야 한다. 묶음은 늘 프로젝트마다 따로다(슬랙 글에 프로젝트마다 `팔로업` 한 줄 —
      // 화면이 그린다). 앱이 스스로 묶지는 않는다(사람이 골랐을 때만).
      if(typeof on!=='boolean')throw new Error('묶을지 뺄지 알려 주세요.');
      for(const {row:target,shown:seen} of picked()){
        if(!on){ delete target.follow; continue; }
        // 다른 문장 아래로 넣은 줄(parent)은 슬랙 글에서 부모에 딸려 나가 `팔로업` 줄이 생기지 않으므로 묶지 않는다.
        const task=(seen.heading==='완료한 일'||seen.heading==='진행중')&&!seen.manual&&!seen.parent&&(seen.sourceIds||[]).length
          &&/^(jira|group):./.test(seen.groupKey||'');
        if(!task||seen.excluded)throw new Error('한 일 칸의 프로젝트 있는 업무 줄만 팔로업으로 묶을 수 있어요.');
        target.follow=true;
      }
    } else if(action==='move') {
      // `프로젝트 옮기기` — 고른 줄의 **업무 전부**의 프로젝트를 바꾸고(한 일 칸 줄은 근거 업무, 할 일 칸 줄은 `group` + 이어진
      // 업무가 있으면 그 업무도) 같은 저장 트랜잭션에서 보고 줄도 고친다. 되돌리기 기록에 옮기기 전 프로젝트를 남겨 함께 돌린다.
      // `to`: 프로젝트 열쇠(`jira:KEY`·`group:이름`) · `'etc'`(업무 프로젝트를 비우고 보고에서만 `기타` 아래) · `{name}`(새 프로젝트 —
      // 같은 이름의 프로젝트가 있으면 그리로). 결정·확인 줄은 옮기지 않는다.
      if(!tasks||typeof tasks.setProject!=='function')throw new Error('이 앱에서는 프로젝트를 옮길 수 없어요.');
      let target;
      if(to==='etc')target=null;
      else if(typeof to==='string'&&to.length<=250&&!/[\r\n\[\]]/.test(to)&&(/^jira:[A-Za-z][A-Za-z0-9_]*-\d+$/.test(to)||/^group:\s*\S/.test(to)))
        target=to.startsWith('group:')?`group:${to.slice(6).replace(/_/g,' ').replace(/\s+/g,' ').trim()}`:to;
      else if(isPlain(to)&&typeof to.name==='string'){
        const name=to.name.replace(/_/g,' ').replace(/\s+/g,' ').trim();
        if(!name||name.length>60||/[\u0000-\u001f\u007f\[\]]/.test(name))throw new Error('새 프로젝트 이름을 60자 이내 한 줄로, 대괄호 없이 적어 주세요.');
        // `기타`·`그룹 없음`·`직접 작성`·`프로젝트 없음`은 보고가 "프로젝트 없음"으로 읽는 이름이다 — 업무엔 프로젝트가 생기는데 보고는
        // 프로젝트 없음으로 보이거나 `기타`가 두 번 선다. 새 이름으로 받지 않는다(`기타`는 목록의 `기타`로).
        if(RESERVED_NAMES.has(name))throw new Error(RESERVED_NAME_ERROR);
        const found=typeof tasks.findProject==='function'?tasks.findProject(name):null;
        target=typeof found==='string'&&/^(jira|group):./.test(found)?found:`group:${name}`;
      } else throw new Error('옮길 프로젝트를 확인해 주세요.');
      // 할 일 칸 줄에 적는 이름 — 지라는 `KEY · 이름`(60자를 넘으면 키만), 직접 만든 프로젝트는 그 이름.
      const label=target?(projectLabel(target)||target.slice(target.indexOf(':')+1)):null;
      const planName=!target?'직접 작성':target.startsWith('jira:')&&label.length>60?target.slice(5):label;
      const list=picked(), taskIds=new Set();
      if(planName.length>60&&list.some(entry=>entry.shown.heading===PLAN_HEADING))throw new Error('프로젝트 이름이 길어 할 일 칸 줄은 옮길 수 없어요.');
      for(const {row:entry,shown:seen} of list){
        if(OPT_IN.has(seen.heading))throw new Error('결정·확인 줄은 옮기지 않아요.');
        if(seen.heading===PLAN_HEADING){
          const linked=typeof seen.planOf==='string'?current.byId.get(seen.planOf):null;
          if(linked&&['task','bug'].includes(linked.type))taskIds.add(linked.id);
          continue;
        }
        const linked=(seen.sourceIds||[]).map(sourceId=>current.byId.get(sourceId));
        if(seen.manual||!linked.length||linked.some(item=>!item||!['task','bug'].includes(item.type)))
          throw new Error('업무와 이어진 줄만 옮길 수 있어요. 최신 보고를 확인해 주세요.');
        linked.forEach(item=>taskIds.add(item.id));
      }
      movedTasks=[];
      for(const taskId of taskIds){
        const from=projectKeyOf(current.byId.get(taskId));
        if(from===target)continue;
        tasks.setProject(taskId,target);
        movedTasks.push({id:taskId,from,to:target});
      }
      const fresh=new Map(sources().map(item=>[item.id,item]));
      if(movedTasks.some(entry=>!fresh.get(entry.id)||projectKeyOf(fresh.get(entry.id))!==target))throw new Error('업무의 프로젝트를 바꾸지 못했어요. 최신 보고를 확인해 주세요.');
      const etcIds=new Set(Array.isArray(polish.etc)?polish.etc.filter(value=>typeof value==='string'):[]);
      const mark=value=>{ if(target)etcIds.delete(value); else etcIds.add(value); };
      for(const {row:entry,shown:seen} of list){
        if(seen.heading===PLAN_HEADING){ entry.group=planName; mark(entry.id); continue; }
        // 자동 줄은 다음 view가 업무를 따라 다시 짓지만, 고친(굳은) 줄은 프로젝트 자리(group·bucket)와 근거의 이름표를 여기서 옮긴다 —
        // 이름표만 바꾸므로 원본이 바뀌었다는 제안(근거 지문)은 생기지 않는다.
        const items=entry.sourceIds.map(sourceId=>fresh.get(sourceId)).filter(Boolean);
        if(!items.length)continue;
        entry.group=labelOf(items[0]);
        if(typeof entry.bucket==='string')entry.bucket=bucket(items[0]);
        (entry.evidence||[]).forEach(item=>{const now=item&&fresh.get(item.id);if(now)item.label=evidence(now).label;});
        entry.sourceIds.forEach(mark);
      }
      if(etcIds.size)polish.etc=[...etcIds]; else delete polish.etc;
      tasksChanged=movedTasks.length>0;
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
      // 결정·확인 줄 `다시 넣기`(on) / `보고에서 빼기`(off) — 이 줄들은 처음부터 빠져 있고 `included`인 줄만 보고에 든다.
      else if(action==='include') {
        if(!OPT_IN.has(shown.heading))throw new Error('결정·확인 줄만 보고에 다시 넣거나 뺄 수 있어요.');
        if(on===true)row.included=true; else if(on===false)delete row.included; else throw new Error('넣을지 뺄지 알려 주세요.');
        row.excluded=false;
      }
      // 할 일 칸 줄을 업무와 잇거나(`나중에 할 일에도 담기`가 만든 업무 id) 끊는다. 화면 표시용 연결이다(planOf 주석 참고).
      // 알림의 `되돌리기`가 업무와 함께 직접 되돌리므로 ⌘Z 되돌리기 기록은 남기지 않는다.
      else if(action==='link') {
        if(shown.heading!==PLAN_HEADING)throw new Error('할 일 칸 줄만 업무와 이을 수 있어요.');
        // 미리 채운 줄은 이미 업무를 가리킨다 — 다른 업무로 이으면 그 업무가 다시 미리 채워져 같은 업무의 줄이 둘이 될 수 있다.
        if(shown.origin==='carry')throw new Error('미리 채운 줄은 이미 업무와 이어져 있어요.');
        const link=planOf(planSource);
        if(link)row.planOf=link; else delete row.planOf;
        keepUndo=false;
      }
      // `원래 문장으로` — 손으로 고친 문장을 연결된 업무에서 다시 지은 문장으로 돌린다(이번 주면 다시 자동 갱신된다).
      // 원본이 하나도 남아 있지 않으면 되돌릴 문장이 없어 거절한다. 연결(`sourceIds`)·자리(`parent`)는 그대로다.
      else if(action==='revert') {
        const linked=(row.sourceIds||[]).map(sourceId=>current.byId.get(sourceId)).filter(Boolean);
        if(!row.locked||row.manual||!linked.length)throw new Error('원래 문장으로 돌릴 수 없어요. 원본 업무를 확인해 주세요.');
        row.text=textOf(linked);row.evidence=linked.map(evidence);row.sourceIds=linked.map(item=>item.id);row.locked=false;row.legacy=false;
      }
      // 완료 제안의 `완료로` — 진행 중 문장을 문장 그대로 완료한 일 칸(같은 프로젝트 소제목)으로 옮긴다. 다른 문장 아래에
      // 있었거나 아래에 문장이 있었으면 그 자리 연결은 푼다(칸이 달라 함께 설 수 없다) — 되돌리기가 그대로 되살린다.
      else if(action==='complete') {
        if(!shown.completable)throw new Error('완료로 옮길 수 없어요. 최신 보고를 확인해 주세요.');
        const linked=row.sourceIds.map(sourceId=>current.byId.get(sourceId));
        row.heading='완료한 일';
        if(row.bucket)row.bucket=bucket(linked[0]);
        row.evidence=linked.map(evidence);row.locked=true;row.legacy=false;
        delete row.parent;
        rows.forEach(entry=>{if(entry.parent===row.id)delete entry.parent;});
      }
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
    if(action!=='undo'&&action!=='keep'&&action!=='link') {
      const now=new Date().toISOString();
      const idsOf=list=>[...new Set(list.flatMap(entry=>[...(entry.sourceIds||[]),...(entry.suggestion?.sourceIds||[])]))];
      const seenIds=list=>Object.fromEntries(idsOf(list).map(sourceId=>[sourceId,sourceMark(current.byId.get(sourceId))]));
      const seen=isPlain(polish.seen)&&isPlain(polish.seen.ids)?polish.seen:null;
      if(action==='ackNew'||action==='confirm'||!seen) polish.seen={at:now,ids:seenIds(current.rows)};
      else {
        const touched=new Set([id,parentId,...(Array.isArray(ids)?ids:[])].filter(value=>typeof value==='string'));
        const known=new Set(base.rows.map(entry=>entry.id));
        const hit=current.rows.filter(entry=>touched.has(entry.id)||(action==='rename'&&entry.heading===groupHeading&&entry.groupKey===groupKey)
          ||(action==='pullNew'&&!known.has(entry.id)));
        polish.seen={at:now,ids:{...seen.ids,...seenIds(hit)}};
      }
      // 사람이 방금 더한 줄의 업무는 "새로 들어온 것"이 아니다(한 줄씩 넣은 업무도 같다).
      if(createdTask)polish.seen.ids={...polish.seen.ids,[createdTask.id]:createdTask.mark};
      if(pulledOne)polish.seen.ids={...polish.seen.ids,[pulledOne.id]:sourceMark(pulledOne)};
    }
    const undoToken=randomUUID();
    state.weeks[weekKey]={rows,updatedAt:new Date().toISOString()};
    if(!isPlain(polish))polish={};
    if(Object.keys(polish).length){if(!isPlain(state.weekPolish))state.weekPolish={};state.weekPolish[weekKey]=polish;}
    else if(isPlain(state.weekPolish)){delete state.weekPolish[weekKey];if(!Object.keys(state.weekPolish).length)delete state.weekPolish;}
    atomicWrite(filename,JSON.stringify(state,null,2));
    if(keepUndo){undo.set(undoToken,{weekKey,rows:base.rows.map(carry),polish:polishBefore,after:hash({rows,polish:polishOf(state,weekKey)}),...(createdTask?{createdTask}:{}),...(movedTasks&&movedTasks.length?{movedTasks}:{})});if(undo.size>50)undo.delete(undo.keys().next().value);}
    return {ok:true,report:view(weekKey,state),undoToken:keepUndo?undoToken:null,...(tasksChanged?{tasksChanged:true}:{}),...(skippedTasks?{skipped:skippedTasks}:{})};
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
  // 옮긴 것을 `[주, 옛 이름 열쇠, 새 이름 열쇠]` 목록으로 돌려준다 — 에픽 옮기기 되돌리기가 **자기가 옮긴 것만** 되돌리게.
  function moveNames(state, from, to) {
    const moved = [];
    for (const [weekKey, week] of Object.entries(polishWeeks(state))) {
      const names = week && week.names && typeof week.names === 'object' && !Array.isArray(week.names) ? week.names : null;
      if (!names) continue;
      for (const name of Object.keys(names)) {
        const at = name.indexOf('|');
        if (at < 0 || name.slice(at + 1) !== from) continue;
        const next = `${name.slice(0, at)}|${to}`;
        if (Object.prototype.hasOwnProperty.call(names, next)) continue;
        names[next] = names[name];
        delete names[name];
        moved.push([weekKey, name, next]);
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
    const names = moveNames(state, `group:${from}`, `group:${to}`).length + moveNames(state, `name:${from}`, `name:${to}`).length;
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
    const names = moveNames(state, `name:${from}`, `name:${to}`).length;
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
    const names = [...moveNames(state, `group:${from}`, `jira:${to}`), ...moveNames(state, `name:${from}`, `name:${label}`)];
    if (ids.length || names.length) atomicWrite(filename, JSON.stringify(state, null, 2));
    // 옮긴 소제목 이름 열쇠는 배열에 숨은 칸(`names`)으로 함께 준다 — 돌려주는 값(행 id 배열)의 모양은 그대로다.
    Object.defineProperty(ids, 'names', { value: names, enumerable: false });
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
  function moveGroupUndo(ids, from, to, label, movedNames) {
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
    // 소제목 이름은 행 id가 아니라 열쇠에 붙어 있다 — 옮길 때 기록한 것(`movedNames`)만 원래 열쇠로 돌린다. 에픽이 원래
    // 갖고 있던 소제목 이름은 건드리지 않는다. 기록이 없으면(옛 이동 기록) 이름은 그대로 둔다.
    const names = restoreNames(state, movedNames);
    if (restored || names) atomicWrite(filename, JSON.stringify(state, null, 2));
    return { restored, skipped: set.size - restored };
  }
  // moveNames가 옮긴 `[주, 옛 이름 열쇠, 새 이름 열쇠]` 목록을 거꾸로 돌린다 — 새 열쇠에 아직 그 이름이 있고 옛 열쇠가
  // 비어 있을 때만(그 사이 사람이 고쳤으면 덮지 않는다). 되돌린 개수를 돌려준다.
  function restoreNames(state, movedNames) {
    let names = 0;
    for (const entry of Array.isArray(movedNames) ? movedNames : []) {
      if (!Array.isArray(entry) || entry.length !== 3 || !entry.every(value => typeof value === 'string')) continue;
      const [weekKey, back, now] = entry;
      const week = polishWeeks(state)[weekKey];
      const list = isPlain(week) && isPlain(week.names) ? week.names : null;
      if (!list || !Object.prototype.hasOwnProperty.call(list, now) || Object.prototype.hasOwnProperty.call(list, back)) continue;
      list[back] = list[now];
      delete list[now];
      names += 1;
    }
    return names;
  }
  // 직접 만든 프로젝트 A를 B로 합칠 때 — renameGroup과 같은 세 자리(group·bucket 앞머리·evidence[].label)를 모든 주에서
  // B로 바꾼다(확정한 주·지난 주 포함). 같은 주에 B 소제목이 이미 있으면 한 소제목 아래 두 무리가 된다. 사람이 고친
  // 소제목 이름은 moveNames 규칙 그대로 B에 이미 있으면 B 것을 남긴다. 되돌리기(mergeGroupUndo)가 자기가 바꾼 것만
  // 되돌리게 **바뀐 행 id**와 옮긴 이름 열쇠를 돌려준다. 부르는 쪽(server.js mergeProject)의 트랜잭션 안에서 돈다.
  function mergeGroup(from, to) {
    const state = read();
    const head = `group:${from}:`;
    const ids = [];
    const fix = (row) => {
      if (!row || typeof row !== 'object') return false;
      let touched = false;
      if (row.group === from) { row.group = to; touched = true; }
      if (typeof row.bucket === 'string' && row.bucket.startsWith(head)) { row.bucket = `group:${to}:${row.bucket.slice(head.length)}`; touched = true; }
      (Array.isArray(row.evidence) ? row.evidence : []).forEach((item) => {
        if (item && item.label === from) { item.label = to; touched = true; }
      });
      const childTouched = (Array.isArray(row.parts) ? row.parts : []).map(fix).some(Boolean);
      return touched || childTouched;
    };
    for (const week of Object.values(state.weeks || {})) {
      (week?.rows || []).forEach((row) => { if (fix(row)) ids.push(row.id); });
    }
    const names = [...moveNames(state, `group:${from}`, `group:${to}`), ...moveNames(state, `name:${from}`, `name:${to}`)];
    if (ids.length || names.length) atomicWrite(filename, JSON.stringify(state, null, 2));
    return { ids, names };
  }
  // mergeGroup의 반대 방향 — **기록에 있는 행 id들만**, B를 가리키는 자리만 A로 돌린다(id가 없어졌거나 그 사이
  // 다른 프로젝트로 옮겨 B 자리가 하나도 없으면 건너뛴다). 소제목 이름은 기록한 열쇠만 돌린다.
  function mergeGroupUndo(ids, from, to, movedNames) {
    const state = read();
    const set = new Set(Array.isArray(ids) ? ids : []);
    const head = `group:${to}:`;
    let restored = 0;
    const fix = (row) => {
      if (!row || typeof row !== 'object') return false;
      let touched = false;
      if (row.group === to) { row.group = from; touched = true; }
      if (typeof row.bucket === 'string' && row.bucket.startsWith(head)) { row.bucket = `group:${from}:${row.bucket.slice(head.length)}`; touched = true; }
      (Array.isArray(row.evidence) ? row.evidence : []).forEach((item) => {
        if (item && item.label === to) { item.label = from; touched = true; }
      });
      const childTouched = (Array.isArray(row.parts) ? row.parts : []).map(fix).some(Boolean);
      return touched || childTouched;
    };
    for (const week of Object.values(state.weeks || {})) {
      for (const row of (week?.rows || [])) {
        if (!set.has(row.id)) continue;
        if (fix(row)) restored += 1;
      }
    }
    const names = restoreNames(state, movedNames);
    if (restored || names) atomicWrite(filename, JSON.stringify(state, null, 2));
    return { restored, skipped: set.size - restored };
  }
  // read는 한 번 읽은 보고 기록을 weeks·view에 함께 넘겨 주 수만큼 다시 읽지 않게 하려고 내보낸다.
  return {view,change,weeks,read,renameGroup,relabelProject,moveGroup,moveGroupUndo,mergeGroup,mergeGroupUndo};
};
