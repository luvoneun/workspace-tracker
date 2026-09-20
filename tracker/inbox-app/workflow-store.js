const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./safe-storage');

// Additional relationships live beside the Markdown files; source IDs remain authoritative.
module.exports = function workflowStore({ directory, refs, calendar, today, validateDate, create, remove }) {
  const filename = path.join(directory, '.workflow.json');
  function read() {
    if (!fs.existsSync(filename)) return { items: {}, meetings: {} };
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!state.items || !state.meetings) throw new Error('업무 연결 기록을 읽을 수 없습니다.');
    return state;
  }
  function write(state) {
    atomicWrite(filename, JSON.stringify(state, null, 2));
  }
  const draftsFile = path.join(directory, 'meeting_drafts.json');
  const meetingId = (date, event) => createHash('sha256').update(JSON.stringify([date, event.start, event.title])).digest('hex').slice(0, 24);
  const draftId = (note, item) => `${note.noteGuid}:stable:${createHash('sha256').update(JSON.stringify([item.id || null,item.type,item.description?.trim()])).digest('hex').slice(0,24)}`;
  function currentMeetings() {
    const saved=Object.values(read().meetings);
    return calendar().events.map(event => {
      const prior=saved.find(old=>old.date===today() && ((event.externalId && old.externalId===event.externalId) || old.id===meetingId(today(),event)));
      const id=prior?.id || (event.externalId ? createHash('sha256').update(`${today()}:${event.externalId}`).digest('hex').slice(0,24) : meetingId(today(),event));
      return {...event,id,date:today(),series:event.title.trim()};
    });
  }
  // meeting_drafts.json is written by the tiro-sync skill and only read here; review results live in .workflow.json.
  function draftNotes() {
    if (!fs.existsSync(draftsFile)) return [];
    try {
      const { notes } = JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
      return Array.isArray(notes) ? notes.filter(note => note && typeof note.noteGuid === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(note.date) && /^\d{2}:\d{2}$/.test(note.start) && typeof note.title === 'string' && note.title.trim()) : [];
    } catch (error) {
      console.error('회의 초안을 읽지 못했습니다:', error.message);
      return [];
    }
  }
  function draftsByMeeting(state) {
    const reviewed = state.reviewed || {};
    const meetings = {};
    for (const note of draftNotes()) {
      const event = { start: note.start, end: /^\d{2}:\d{2}$/.test(note.end) ? note.end : '', title: note.title, link: null, project: null };
      const matched=Object.values(state.meetings).find(saved=>saved.date===note.date && ((note.eventId && saved.externalId===note.eventId) || (saved.start===note.start && saved.title===note.title)));
      const id = matched?.id || meetingId(note.date, event);
      const entry = meetings[id] ||= { event: { ...event, id, date: note.date, series: note.title.trim() }, notes: [], drafts: [] };
      if (/^https:\/\/\S+$/.test(note.webUrl || '')) entry.notes.push(note.webUrl);
      (Array.isArray(note.items) ? note.items : []).forEach((item, index) => {
        const id = draftId(note,item);
        if (reviewed[id] || !validItem(item)) return;
        let due;
        try { if (item.type === 'task' && item.due) { validateDate(item.due); due = item.due; } } catch { due = undefined; }
        entry.drafts.push({ id, type: item.type, description: item.description.trim(), ...(due ? { due } : {}) });
      });
    }
    return meetings;
  }
  const validItem = item => ['task', 'check', 'decision'].includes(item?.type) && typeof item.description === 'string' && !!item.description.trim() && !/[\r\n]/.test(item.description) && item.description.length <= 1000;
  // Called by startup/file watcher, never as a side effect of GET /api/items.
  function archive() {
    const state = read();
    let changed = false;
    for(const note of draftNotes())for(const [index,item] of (note.items || []).entries()) {
      const old=`${note.noteGuid}:${index}`;
      if(state.reviewed?.[old]) {state.reviewed[draftId(note,item)]=state.reviewed[old];delete state.reviewed[old];changed=true;}
    }
    for (const event of currentMeetings()) {
      const prior = state.meetings[event.id];
      const next = { ...event, ...prior, externalId: event.externalId || prior?.externalId, title:event.title, start:event.start, end: event.end, link: event.link };
      if (JSON.stringify(prior) !== JSON.stringify(next)) { state.meetings[event.id] = next; changed = true; }
    }
    if (changed) write(state);
  }
  function snapshot() {
    const state = read();
    const all = refs();
    const items = Object.entries(all).map(([id, item]) => ({ id, ...item, ...state.items[id] }));
    const meetings = { ...state.meetings };
    for (const event of currentMeetings()) meetings[event.id] = { ...event, ...meetings[event.id] };
    for (const [id, entry] of Object.entries(draftsByMeeting(state))) meetings[id] = { ...entry.event, ...meetings[id], tiroNotes: entry.notes, drafts: entry.drafts };
    return { items, meetings: Object.values(meetings).sort((a, b) => `${b.date} ${b.start}`.localeCompare(`${a.date} ${a.start}`)) };
  }
  function patchItem({ id, ...patch }) {
    const all = refs();
    const source = all[id];
    if (!source) throw new Error('항목을 찾을 수 없습니다.');
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !['followUp', 'contacted', 'blockedBy', 'outcome'].includes(key))) throw new Error('지원하지 않는 변경입니다.');
    if ('followUp' in patch) { if (source.type !== 'check') throw new Error('확인 대기에서만 지정할 수 있습니다.'); validateDate(patch.followUp); }
    if ('contacted' in patch) { if (source.type !== 'check' || patch.contacted !== today()) throw new Error('확인 요청 날짜가 올바르지 않습니다.'); }
    if ('blockedBy' in patch && (!['task', 'bug'].includes(source.type) || (patch.blockedBy !== null && (!all[patch.blockedBy] || all[patch.blockedBy].type !== 'check')))) throw new Error('연결할 확인 대기를 찾을 수 없습니다.');
    if ('outcome' in patch && (!['task', 'bug'].includes(source.type) || typeof patch.outcome !== 'string' || patch.outcome.length > 1000 || /[\r\n]/.test(patch.outcome))) throw new Error('결과는 1,000자 이내 한 줄로 적어 주세요.');
    const state = read();
    state.items[id] = { ...state.items[id], ...patch };
    write(state);
    return { ok: true };
  }
  function resolveMeeting(id, state) {
    const event = state.meetings[id] || currentMeetings().find(event => event.id === id) || draftsByMeeting(state)[id]?.event;
    if (!event) throw new Error('회의를 찾을 수 없습니다.');
    return event;
  }
  function saveMeeting({ id, project, series }) {
    const state = read();
    const event = resolveMeeting(id, state);
    if (project !== undefined && project !== null && (typeof project !== 'string' || !/^(jira|group):\S/.test(project) || project.length > 250 || /[\r\n]/.test(project))) throw new Error('프로젝트를 확인해 주세요.');
    if (series !== undefined && (typeof series !== 'string' || !series.trim() || series.length > 200)) throw new Error('시리즈 이름을 확인해 주세요.');
    let selected = event.project;
    if (project !== undefined) selected = project ? { type: project.slice(0, project.indexOf(':')), value: project.slice(project.indexOf(':') + 1), label: project.slice(project.indexOf(':') + 1) } : null;
    state.meetings[id] = { ...event, project: selected, series: series === undefined ? event.series : series.trim() };
    write(state);
    return { ok: true };
  }
  function syncProject(title, project) {
    const state=read();let changed=false;
    for(const event of [...Object.values(state.meetings),...currentMeetings()]) {
      if(event.title!==title || event.date!==today())continue;
      state.meetings[event.id]={...event,project};changed=true;
    }
    if(changed)write(state);
  }
  // due: 할 일의 마감일, 확인 대기의 회신 기한. 결정에는 마감일이 없다.
  function capture({ meetingId: id, type, description, project, due }) {
    if (due && type === 'decision') throw new Error('결정에는 마감일을 넣을 수 없습니다.');
    validateDate(due);
    return addToMeeting(id, { type, description, project, extra: due ? { due } : {} });
  }
  function addToMeeting(id, { type, description, project, extra = {}, draftId }) {
    if (!validItem({ type, description })) throw new Error('종류와 내용을 확인해 주세요.');
    const state = read();
    const event = resolveMeeting(id, state);
    const selected = project === undefined ? event.project : project;
    if (selected && (!['jira', 'group'].includes(selected.type) || typeof selected.value !== 'string' || !selected.value.trim() || /[\r\n\[\]]/.test(selected.value))) throw new Error('프로젝트를 확인해 주세요.');
    const result = create[type]({ description, ...extra, ...(selected ? { [selected.type]: selected.value } : {}) });
    if (!result.ok) throw new Error('항목을 저장하지 못했습니다.');
    try {
      state.meetings[id] = event;
      state.items[result.id] = { meetingId: id };
      if (draftId) state.reviewed = { ...state.reviewed, [draftId]: result.id };
      write(state);
    } catch (error) { remove(result.id, false); throw error; }
    return result;
  }
  // AI가 분류한 초안을 사람이 검토한 결과. 담은 것은 각 목록으로 만들고, 뺀 것은 다시 올라오지 않게 기록만 한다.
  function review({ meetingId: id, accept = [], dismiss = [] }) {
    if (!Array.isArray(accept) || !Array.isArray(dismiss) || (!accept.length && !dismiss.length)) throw new Error('검토할 항목을 골라 주세요.');
    const state = read();
    const pending = new Map((draftsByMeeting(state)[id]?.drafts || []).map(draft => [draft.id, draft]));
    const ids = [...accept.map(item => item?.id), ...dismiss];
    if (new Set(ids).size !== ids.length || ids.some(draftId => !pending.has(draftId))) throw new Error('이미 처리했거나 찾을 수 없는 항목입니다.');
    if (accept.some(item => !validItem(item))) throw new Error('종류와 내용을 확인해 주세요.');
    // when: 할 일을 담을 때만 "오늘"을 고를 수 있다. 정하지 않으면 나중에 할 일.
    if (accept.some(item => item.when !== undefined && !['today', 'later'].includes(item.when))) throw new Error('오늘 또는 나중을 골라 주세요.');
    if (accept.some(item => item.when === 'today' && item.type !== 'task')) throw new Error('오늘은 할 일만 고를 수 있습니다.');
    // due: 사람이 고른 날짜. null이면 지운 것이고, 보내지 않으면 초안에 있던 마감(할 일만)을 그대로 쓴다.
    if (accept.some(item => item.due && item.type === 'decision')) throw new Error('결정에는 마감일을 넣을 수 없습니다.');
    accept.forEach(item => validateDate(item.due));
    if (dismiss.length) {
      state.meetings[id] = resolveMeeting(id, state);
      state.reviewed = { ...state.reviewed, ...Object.fromEntries(dismiss.map(draftId => [draftId, 'dismissed'])) };
      write(state);
    }
    // 회의에서 나온 할 일이 오늘 목록을 한꺼번에 채우지 않게 기본은 나중에 할 일로 담는다. 사람이 "오늘"을 고른 것만 오늘로. 마감일은 초안에 명시된 경우만.
    const created = accept.map(item => addToMeeting(id, {
      type: item.type, description: item.description.trim(), draftId: item.id,
      extra: item.type === 'task' ? { scheduled: item.when === 'today' ? today() : null, due: (item.due !== undefined ? item.due : pending.get(item.id).due) || null }
        : item.type === 'check' ? { due: item.due || null } : {},
    }).id);
    return { ok: true, created };
  }
  // 방금 담은 것을 되돌린다: 항목은 삭제 휴지통(원문 보존)으로 옮기고, 초안은 다시 검토 대기로 올린다.
  // review가 돌려준 created 목록 그대로만 받는다(이 회의에서 초안으로 만든 항목이 아니면 거절).
  function undoReview({ meetingId: id, created }) {
    if (!Array.isArray(created) || !created.length) throw new Error('되돌릴 항목이 없습니다.');
    const state = read();
    const draftOf = new Map(Object.entries(state.reviewed || {}).filter(([, itemId]) => itemId !== 'dismissed').map(([draftId, itemId]) => [itemId, draftId]));
    if (new Set(created).size !== created.length || created.some(itemId => !draftOf.has(itemId) || state.items[itemId]?.meetingId !== id)) throw new Error('이미 되돌렸거나 되돌릴 수 없는 항목입니다.');
    created.forEach(itemId => remove(itemId));
    const reviewed = { ...state.reviewed }, linked = { ...state.items };
    created.forEach(itemId => { delete reviewed[draftOf.get(itemId)]; delete linked[itemId]; });
    state.reviewed = reviewed; state.items = linked;
    write(state);
    return { ok: true, restored: created.length };
  }
  function link({ id, meetingId }) {
    if (!refs()[id]) throw new Error('항목을 찾을 수 없습니다.');
    const state = read();
    const event = resolveMeeting(meetingId, state);
    if (state.items[id]?.meetingId && state.items[id].meetingId !== meetingId) throw new Error('이미 다른 회의에 연결된 항목입니다.');
    state.meetings[meetingId] = event;
    state.items[id] = { ...state.items[id], meetingId };
    write(state);
    return { ok: true };
  }
  return { archive, snapshot, patchItem, saveMeeting, syncProject, capture, review, undoReview, link, outcome: id => read().items[id]?.outcome || '' };
};
