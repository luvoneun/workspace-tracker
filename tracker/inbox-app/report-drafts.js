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
const textOf = items => [...new Set(items.map(item => item.status === 'done' && item.outcome ? item.outcome : item.status === 'done' ? item.description.replace(/하기$/, '함') : item.description))].join('\n');

module.exports = ({ directory, sources, legacy, currentWeek }) => {
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
  function view(weekKey, state = read(), sourceSnapshot) {
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
    tops.sort((a,b)=>(order.indexOf(a.heading)<0?99:order.indexOf(a.heading))-(order.indexOf(b.heading)<0?99:order.indexOf(b.heading)) || a.group.localeCompare(b.group));
    const nested=new Map();
    rows.forEach(row=>{if(!row.parent)return;if(!nested.has(row.parent))nested.set(row.parent,[]);nested.get(row.parent).push(row);});
    const ordered=tops.flatMap(row=>[row,...(nested.get(row.id)||[])]);
    return { weekKey, rows: ordered, revision: hash({ stored, rows: ordered }), updatedAt: stored?.updatedAt || null };
  }
  function clean(row) { const { suggestion, needsReview, currentEvidence, canSplit, partCount, ...rest } = row; return rest; }
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
  function change({ weekKey, revision, action, id, parentId, text, ids, token, group, planOf: planSource }) {
    const state=read(), current=view(weekKey,state);
    if (revision !== current.revision) { const error=new Error('새 기록이나 다른 창의 변경이 있어요. 적은 내용은 그대로 있어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.');error.status=409;throw error; }
    // 묶기 전 문장은 화면으로 나가지 않으므로(view가 `canSplit`만 알린다) 저장 파일에서 다시 붙인다.
    // `parts`는 서버가 merge에서만 만든다 — 요청 본문의 값은 받지 않는다.
    const storedParts=new Map((state.weeks[weekKey]?.rows||[]).filter(row=>row.parts).map(row=>[row.id,row.parts]));
    // 고아 규칙에 걸린 `parent`는 view가 결과에서만 뺀다 — 저장 파일의 값은 조용히 지우지 않는다.
    const storedParents=new Map((state.weeks[weekKey]?.rows||[]).filter(row=>row.parent).map(row=>[row.id,row.parent]));
    const carry=row=>{const next=clean(row);if(storedParts.has(row.id))next.parts=storedParts.get(row.id);
      if(next.parent===undefined&&storedParents.has(row.id))next.parent=storedParents.get(row.id);return next;};
    let rows=current.rows.map(carry); const row=rows.find(row=>row.id===id), shown=current.rows.find(row=>row.id===id);
    if(action==='undo') {
      const prior=undo.get(token); if(!prior || prior.weekKey!==weekKey)throw new Error('되돌리기 기록이 만료됐어요.');
      if(hash(state.weeks[weekKey]?.rows)!==prior.after)throw new Error('그 뒤에 다른 변경이 있어 되돌릴 수 없어요. 최신 보고를 확인해 주세요.');
      rows=prior.rows;
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
      else if(action==='unnest') delete row.parent;
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
    const undoToken=randomUUID();
    state.weeks[weekKey]={rows,updatedAt:new Date().toISOString()};atomicWrite(filename,JSON.stringify(state,null,2));
    undo.set(undoToken,{weekKey,rows:current.rows.map(carry),after:hash(rows)});if(undo.size>50)undo.delete(undo.keys().next().value);
    return {ok:true,report:view(weekKey,state),undoToken};
  }
  function weeks(snapshot=sources(), state=read()) {
    const dates=snapshot.flatMap(item=>[item.completed,...(['decision','check'].includes(item.type)?[item.created]:[])]).filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date || ''));
    const keys=dates.map(date=>{const d=new Date(`${date}T12:00:00`);d.setDate(d.getDate()-((d.getDay()+6)%7));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
    return [...new Set([currentWeek(),...keys,...legacy().map(entry=>entry.weekKey),...Object.keys(state.weeks)])].sort().reverse();
  }
  // read는 한 번 읽은 보고 기록을 weeks·view에 함께 넘겨 주 수만큼 다시 읽지 않게 하려고 내보낸다.
  return {view,change,weeks,read};
};
