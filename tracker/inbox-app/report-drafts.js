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
const textOf = items => [...new Set(items.map(item => item.status === 'done' && item.outcome ? item.outcome : item.status === 'done' ? item.description.replace(/하기$/, '함') : item.description))].join('\n');

module.exports = ({ directory, sources, legacy, currentWeek }) => {
  const filename = path.join(directory, '.report-drafts.json');
  const undo = new Map();
  function read() {
    if (!fs.existsSync(filename)) return { schema: 1, weeks: {} };
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value.schema !== 1 || !value.weeks) throw new Error('보고 기록 형식을 확인해 주세요. 원본은 보존되어 있습니다.');
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
    const order=['완료한 일','진행중','새로 정해진 것','확인 완료','확인 대기','다음 주 계획'];
    rows.forEach(row=>{if(row.evidence.some(item=>/\(.*확인 필요.*\)|\(미확정\)/.test(item.description)))row.needsReview=true;});
    rows.sort((a,b)=>(order.indexOf(a.heading)<0?99:order.indexOf(a.heading))-(order.indexOf(b.heading)<0?99:order.indexOf(b.heading)) || a.group.localeCompare(b.group));
    return { weekKey, rows, revision: hash({ stored, rows }), updatedAt: stored?.updatedAt || null };
  }
  function clean(row) { const { suggestion, needsReview, currentEvidence, ...rest } = row; return rest; }
  function change({ weekKey, revision, action, id, text, ids, token }) {
    const state=read(), current=view(weekKey,state);
    if (revision !== current.revision) { const error=new Error('새 기록이나 다른 창의 변경이 있습니다. 입력은 보존했습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.');error.status=409;throw error; }
    let rows=current.rows.map(clean); const row=rows.find(row=>row.id===id), shown=current.rows.find(row=>row.id===id);
    if(action==='undo') {
      const prior=undo.get(token); if(!prior || prior.weekKey!==weekKey)throw new Error('되돌리기 기록이 만료되었습니다.');
      if(hash(state.weeks[weekKey]?.rows)!==prior.after)throw new Error('이후 다른 변경이 있어 되돌릴 수 없습니다. 최신 보고를 확인해 주세요.');
      rows=prior.rows;
    } else if(action==='add') {
      if(typeof text!=='string'||!text.trim()||text.length>10000)throw new Error('보고 문장을 입력해 주세요.');
      rows.push({id:randomUUID(),heading:'다음 주 계획',group:'직접 작성',text:text.trim(),sourceIds:[],evidence:[],locked:true,excluded:false});
    } else if(action==='merge') {
      if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw new Error('묶을 보고 항목을 선택해 주세요.');
      const selected=rows.filter(row=>ids.includes(row.id));
      if(selected.length!==ids.length||selected.some(row=>row.excluded)||new Set(selected.map(row=>row.heading)).size!==1)throw new Error('같은 상태의 보고 항목만 묶을 수 있습니다.');
      const sourceIds=[...new Set(selected.flatMap(row=>row.sourceIds))];
      rows=rows.filter(row=>!ids.includes(row.id));
      rows.push({id:randomUUID(),heading:selected[0].heading,group:new Set(selected.map(row=>row.group)).size===1?selected[0].group:'여러 프로젝트',bucket:new Set(selected.map(row=>row.bucket)).size===1?selected[0].bucket:null,text:selected.map(row=>row.text).join('\n'),sourceIds,evidence:[...new Map(selected.flatMap(row=>row.evidence).map(item=>[item.id,item])).values()],locked:true,excluded:false});
    } else {
      if(!row)throw new Error('보고 항목을 찾을 수 없습니다.');
      if(action==='edit') { if(typeof text!=='string'||!text.trim()||text.length>10000)throw new Error('보고 문장을 10,000자 이내로 입력해 주세요.');row.text=text.trim();row.locked=true;row.legacy=false;row.evidence=shown.currentEvidence; }
      else if(action==='exclude') row.excluded=!row.excluded;
      else if(action==='accept') { if(!shown.suggestion || shown.suggestion.missing || shown.suggestion.mixed)throw new Error('원본 상태를 확인하고 문장을 직접 수정해 주세요.');Object.assign(row,shown.suggestion,{locked:true,legacy:false});delete row.added;delete row.missing;delete row.mixed; }
      else if(action==='acknowledge') { row.evidence=shown.suggestion?.evidence || shown.currentEvidence;row.sourceIds=shown.suggestion?.sourceIds || row.sourceIds;row.legacy=false;row.locked=true; }
      else throw new Error('지원하지 않는 보고 변경입니다.');
    }
    const undoToken=randomUUID();
    state.weeks[weekKey]={rows,updatedAt:new Date().toISOString()};atomicWrite(filename,JSON.stringify(state,null,2));
    undo.set(undoToken,{weekKey,rows:current.rows.map(clean),after:hash(rows)});if(undo.size>50)undo.delete(undo.keys().next().value);
    return {ok:true,report:view(weekKey,state),undoToken};
  }
  function weeks(snapshot=sources()) {
    const dates=snapshot.flatMap(item=>[item.completed,...(['decision','check'].includes(item.type)?[item.created]:[])]).filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date || ''));
    const keys=dates.map(date=>{const d=new Date(`${date}T12:00:00`);d.setDate(d.getDate()-((d.getDay()+6)%7));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
    return [...new Set([currentWeek(),...keys,...legacy().map(entry=>entry.weekKey),...Object.keys(read().weeks)])].sort().reverse();
  }
  return {view,change,weeks};
};
