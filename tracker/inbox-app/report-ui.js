const reportEdits = new Map();
const reportUndo = new Map();
const reportSelection = new Set();
let reportBusy = false;
let reportMode = 'draft';
let reportRenderedWeek = null;
let reportSelecting = false;
const reportNewRecords = new Map();
window.addEventListener('beforeunload', event => { if(reportEdits.size || reportBusy) { event.preventDefault(); event.returnValue=''; } });
function reportNode(tag,text,className) { const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el; }
function reportButton(text,action) {
  const el=reportNode('button',text,'convert-btn');el.type='button';el.disabled=reportBusy;
  el.addEventListener('click',async()=>{el.disabled=true;try{await action();}catch(error){showNotice(error.message || '저장하지 못했습니다. 입력은 보존됩니다.',true);}finally{el.disabled=false;}});return el;
}
function reportCopyText(report) {
  return report.rows.filter(row=>!row.excluded).map(row=>`${row.heading} · ${row.group}\n${row.text.split('\n').map(line=>`- ${line}`).join('\n')}`).join('\n\n');
}
async function reportChange(item, action) {
  if(reportBusy)return;
  reportBusy=true;
  try {
    const response=await fetch('/api/report/change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({weekKey:item.weekKey,revision:item.draft.revision,...action}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok) {
      if(response.status===409) { const fresh=await (await fetch('/api/items')).json();weeklyReportsCache=fresh.weeklyReports;const latest=weeklyReportsCache.find(entry=>entry.weekKey===item.weekKey);if(latest){reportBusy=false;renderReportDraft(latest);} }
      throw new Error(result.error || '저장을 확인하지 못했습니다. 입력은 보존됩니다.');
    }
    if(action.action==='edit')reportEdits.delete(`${item.weekKey}:${action.id}`);
    if(action.action==='add')reportEdits.delete(`${item.weekKey}:new`);
    reportUndo.set(item.weekKey,result.undoToken);reportSelection.clear();
    item.draft=result.report;
    const cached=weeklyReportsCache.find(entry=>entry.weekKey===item.weekKey);if(cached)cached.draft=result.report;
  } finally { reportBusy=false; }
  renderReportDraft(item);announce('보고 내용을 저장했습니다.');
}
function renderReportDraft(item) {
  if(reportRenderedWeek!==item.weekKey){reportSelection.clear();reportSelecting=false;reportRenderedWeek=item.weekKey;}
  const host=document.getElementById('weeklyReportDetail');host.dataset.weekKey=item.weekKey;host.replaceChildren();host.classList.add('report-draft');
  const report=item.draft,label=formatWeekLabel(item.weekKey);
  const currentIds=[...new Set(report.rows.flatMap(row=>[...row.sourceIds,...(row.suggestion?.sourceIds||[])]))];
  const seenKey=`workspace-report-seen:${item.weekKey}`;
  if(reportNewRecords.get(item.weekKey)?.revision!==report.revision) {
    let previous=null;try{previous=JSON.parse(localStorage.getItem(seenKey));localStorage.setItem(seenKey,JSON.stringify(currentIds));}catch{}
    reportNewRecords.set(item.weekKey,{revision:report.revision,ids:new Set(previous?currentIds.filter(id=>!previous.includes(id)):[])});
  }
  const newIds=reportNewRecords.get(item.weekKey).ids;
  const heading=reportNode('div',undefined,'wr-detail-heading');heading.append(reportNode('span',label.week,'wr-detail-week'),reportNode('span',label.range,'wr-detail-range'));host.appendChild(heading);
  const toolbar=reportNode('div',undefined,'report-toolbar');
  for(const [mode,title] of [['draft','보고 초안'],['records','전체 업무 기록'],['copy','복사 미리보기']]) {
    const button=reportButton(title,()=>{reportMode=mode;renderReportDraft(item);});button.setAttribute('aria-pressed',String(reportMode===mode));toolbar.appendChild(button);
  }
  toolbar.appendChild(reportButton('복사',async()=>{if([...reportEdits.keys()].some(key=>key.startsWith(item.weekKey+':')))throw new Error('수정 중인 문장을 저장하거나 취소한 뒤 복사해 주세요.');try{await navigator.clipboard.writeText(reportCopyText(report));announce('보고 내용을 복사했습니다.');}catch(error){reportMode='copy';renderReportDraft(item);throw new Error('복사 미리보기의 내용을 직접 선택해 복사해 주세요.');}}));
  if(reportUndo.has(item.weekKey))toolbar.appendChild(reportButton('되돌리기',()=>reportChange(item,{action:'undo',token:reportUndo.get(item.weekKey)})));
  host.appendChild(toolbar);
  if(reportMode==='draft')toolbar.appendChild(reportButton(reportSelecting?'선택 종료':'선택',()=>{reportSelecting=!reportSelecting;reportSelection.clear();renderReportDraft(item);}));
  const pending=report.rows.filter(row=>row.needsReview),added=report.rows.reduce((n,row)=>n+(row.suggestion?.added||0),0);
  const summary=reportNode('div',undefined,'report-summary');
  summary.appendChild(reportNode('span',`보고 ${report.rows.filter(row=>!row.excluded).length}개 · 근거 업무 ${currentIds.length}개${newIds.size?` · 새 기록 ${newIds.size}개`:''}`));
  if(pending.length)summary.appendChild(reportButton(`확인 필요 ${pending.length}개${added?` · 새 관련 업무 ${added}개`:''}`,()=>{reportMode='draft';renderReportDraft(item);host.querySelector('[data-review="true"]')?.scrollIntoView({block:'center',behavior:'smooth'});}));
  host.appendChild(summary);
  if(reportMode==='copy') {const text=reportNode('textarea');text.readOnly=true;text.value=reportCopyText(report);text.setAttribute('aria-label','복사용 보고 내용');text.rows=18;host.appendChild(text);return;}
  if(reportMode==='records') {
    const records=new Map();report.rows.forEach(row=>[...row.evidence,...(row.suggestion?.evidence||[])].forEach(source=>records.set(source.id,{source,row})));
    if(!records.size)host.appendChild(reportNode('p','이번 주에 연결된 업무 기록이 없습니다.','wf-section-note'));
    for(const {source,row} of records.values()) {
      const line=reportNode('div',undefined,'report-record');line.append(reportNode('span',source.description),reportNode('span',`${source.label} · ${source.status==='done'?'완료':'미완료'} · ${row.excluded?'보고 제외':'보고에 포함'}`,'wf-meta'));
      line.appendChild(reportButton('원본 보기',()=>panelOpen({ id: source.id })));if(row.excluded)line.appendChild(reportButton('보고에 복원',()=>reportChange(item,{action:'exclude',id:row.id})));host.appendChild(line);
    }
    return;
  }
  if(!report.rows.length)host.appendChild(reportNode('p','이번 주 기록이 생기면 초안에 표시됩니다.','empty'));
  const manual=reportNode('details');manual.appendChild(reportNode('summary','다음 주 계획 직접 작성'));
  const manualLabel=reportNode('label','계획'),manualInput=reportNode('textarea');manualInput.rows=2;manualInput.value=reportEdits.get(`${item.weekKey}:new`) || '';manualInput.addEventListener('input',()=>{if(manualInput.value)reportEdits.set(`${item.weekKey}:new`,manualInput.value);else reportEdits.delete(`${item.weekKey}:new`);});manualLabel.appendChild(manualInput);manual.append(manualLabel,reportButton('추가',()=>reportChange(item,{action:'add',text:manualInput.value})));host.appendChild(manual);
  const merge=reportButton('선택 항목 묶기',()=>reportChange(item,{action:'merge',ids:[...reportSelection]}));merge.hidden=reportSelection.size<2;host.appendChild(merge);
  const excluded=reportNode('details',undefined,'report-excluded');excluded.appendChild(reportNode('summary',`이번 보고에서 제외 ${report.rows.filter(row=>row.excluded).length}개`));
  const reportGroups=new Map();
  for(const row of report.rows) {
    const card=reportNode('section',undefined,'report-entry');card.dataset.review=String(!!row.needsReview);
    const top=reportNode('div',undefined,'report-entry-head');
    if(!row.excluded && reportSelecting) {const box=reportNode('input');box.type='checkbox';box.checked=reportSelection.has(row.id);box.setAttribute('aria-label',`${row.group} ${row.heading} 묶기 선택`);box.addEventListener('change',()=>{box.checked?reportSelection.add(row.id):reportSelection.delete(row.id);merge.hidden=reportSelection.size<2;});top.appendChild(box);}
    top.append(reportNode('h3',row.group),reportNode('span',row.heading,'badge'),reportNode('span',row.locked?'직접 편집':'자동 초안','wf-meta'));card.appendChild(top);
    if(row.needsReview && !row.suggestion)top.appendChild(reportNode('span','원본 확인 필요','badge'));
    const rowNew=row.sourceIds.filter(id=>newIds.has(id)).length;if(rowNew)top.appendChild(reportNode('span',`새 기록 ${rowNew}개`,'badge'));
    const key=`${item.weekKey}:${row.id}`;
    if(reportEdits.has(key)) {
      const label=reportNode('label','보고 문장'),input=reportNode('textarea');input.value=reportEdits.get(key);input.rows=Math.max(3,Math.min(10,input.value.split('\n').length+1));input.maxLength=10000;
      input.addEventListener('input',()=>reportEdits.set(key,input.value));label.appendChild(input);card.appendChild(label);
      card.append(reportButton('저장',()=>reportChange(item,{action:'edit',id:row.id,text:input.value})),reportButton('취소',()=>{reportEdits.delete(key);renderReportDraft(item);}));
    } else {
      card.appendChild(reportNode('p',row.text,'report-text'));
      if(!row.excluded)card.appendChild(reportButton('문장 수정',()=>{reportEdits.set(key,row.text);renderReportDraft(item);host.querySelector('textarea')?.focus();}));
    }
    card.appendChild(reportButton(row.excluded?'보고에 복원':'이번 보고에서 제외',()=>reportChange(item,{action:'exclude',id:row.id})));
    const proof=reportNode('details',undefined,'report-proof');proof.appendChild(reportNode('summary',`근거 업무 ${row.sourceIds.length}개`));
    for(const source of row.currentEvidence || row.evidence) {const line=reportNode('div',undefined,'report-record');line.append(reportNode('span',source.description),reportNode('span',source.status==='done'?'완료':'미완료','wf-meta'),reportButton('원본 보기',()=>panelOpen({ id: source.id })));proof.appendChild(line);}
    if(!row.sourceIds.length)proof.appendChild(reportNode('p','기존 보고 문장 · 연결된 원본 없음','wf-section-note'));card.appendChild(proof);
    if(row.suggestion) {
      const proposal=reportNode('details',undefined,'report-proposal');proposal.appendChild(reportNode('summary',row.suggestion.added?`새 관련 업무 ${row.suggestion.added}개 · 수정 제안 보기`:'원본 변경 · 확인 필요'));
      proposal.appendChild(reportNode('p','현재 문장은 그대로 보존됩니다.','wf-section-note'));
      proposal.appendChild(reportNode('p',row.suggestion.text || '연결된 원본을 찾을 수 없습니다.','report-text'));
      if(!row.suggestion.missing&&!row.suggestion.mixed)proposal.appendChild(reportButton('제안 문장 적용',()=>reportChange(item,{action:'accept',id:row.id})));
      proposal.appendChild(reportButton('현재 문장 유지',()=>reportChange(item,{action:'acknowledge',id:row.id})));
      if(row.suggestion.mixed||row.suggestion.missing)proposal.appendChild(reportNode('p','원본 상태가 다르거나 삭제된 업무가 있습니다. 문장을 직접 확인해 주세요.','wf-section-note'));
      card.appendChild(proposal);
    }
    if(row.excluded)excluded.appendChild(card);
    else {
      const groupKey=JSON.stringify([row.heading,row.group]);
      if(!reportGroups.has(groupKey)) {
        const group=reportNode('section',undefined,'report-group');
        const title=reportNode('div',undefined,'report-group-title');title.append(reportNode('h3',row.group),reportNode('span',row.heading,'badge'));group.appendChild(title);
        reportGroups.set(groupKey,group);host.appendChild(group);
      }
      reportGroups.get(groupKey).appendChild(card);
    }
  }
  if(report.rows.some(row=>row.excluded))host.appendChild(excluded);
}
