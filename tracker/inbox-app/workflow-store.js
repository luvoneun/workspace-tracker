const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./safe-storage');

// Additional relationships live beside the Markdown files; source IDs remain authoritative.
module.exports = function workflowStore({ directory, refs, calendar, today, validateDate, create, remove, move }) {
  const filename = path.join(directory, '.workflow.json');
  function read() {
    if (!fs.existsSync(filename)) return { items: {}, meetings: {} };
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!state.items || !state.meetings) throw new Error('업무 연결 기록을 읽지 못했어요.');
    // projectLinks·projectArchive 칸이 없는 옛 파일은 "하나도 없다"로 읽힌다(고쳐 쓰지 않는다).
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
    return {
      items,
      meetings: Object.values(meetings).sort((a, b) => `${b.date} ${b.start}`.localeCompare(`${a.date} ${a.start}`)),
      // 손으로 걸어 둔 `그룹 이름 → 지라 키`. 화면은 지금 보고 있는 프로젝트의 것만 읽으므로,
      // 그룹이 없어져 고아가 된 연결이 남아 있어도 아무 자리에도 나타나지 않는다.
      projectLinks: { ...(state.projectLinks || {}) },
      // 지라 프로젝트의 앱 안 별칭(`{ "IO-48501": "결제 리뉴얼" }`, BJALIAS). 칸이 없는 옛 파일은
      // 하나도 없다로 읽힌다(projectLinks 주석과 같은 규칙).
      projectAliases: { ...(state.projectAliases || {}) },
      // 새 프로젝트 화면의 직군 세트(`[{ label, prefix }]`). 파일에 칸이 없으면 `null`이고
      // 그때는 **화면이** 기본 세트를 쓴다 — 여기서 기본값을 파일에 써 넣지 않는다.
      // 사람이 전부 지우면 빈 배열이 저장되고, 그때는 빈 목록이 그대로 보인다.
      jiraRoles: Array.isArray(state.jiraRoles) ? state.jiraRoles.map(role => ({ label: role.label, prefix: role.prefix })) : null,
      // 프로젝트 묶어 보기(BBUNDLE) — 화면에서만 묶는 표시 정보. 칸이 없거나 깨진 값은 걸러서 보낸다
      // (파일은 고쳐 쓰지 않는다 — 다음 묶기·풀기 저장 때 정리된 모양으로 쓴다).
      projectBundles: cleanBundles(state.projectBundles),
    };
  }
  function patchItem({ id, ...patch }) {
    const all = refs();
    const source = all[id];
    if (!source) throw new Error('항목을 찾을 수 없어요.');
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !['followUp', 'contacted', 'blockedBy', 'outcome', 'note'].includes(key))) throw new Error('지원하지 않는 변경이에요.');
    if ('followUp' in patch) { if (source.type !== 'check') throw new Error('확인 대기에서만 지정할 수 있어요.'); validateDate(patch.followUp); }
    if ('contacted' in patch) { if (source.type !== 'check' || patch.contacted !== today()) throw new Error('확인 요청 날짜가 올바르지 않아요.'); }
    if ('blockedBy' in patch && (!['task', 'bug'].includes(source.type) || (patch.blockedBy !== null && (!all[patch.blockedBy] || all[patch.blockedBy].type !== 'check')))) throw new Error('연결할 확인 대기를 찾을 수 없어요.');
    // outcome: 업무·버그의 `결과 한 줄`이자 확인 대기의 `답변 한 줄`이다(둘 다 주간요약 문장이 된다).
    // 결정·아이디어에는 결과가 없다.
    if ('outcome' in patch && (!['task', 'bug', 'check'].includes(source.type) || typeof patch.outcome !== 'string' || patch.outcome.length > 1000 || /[\r\n]/.test(patch.outcome))) throw new Error('결과는 1,000자 이내 한 줄로 적어 주세요.');
    // note: 결정의 `내용`처럼 여러 줄로 적는 본문이다. 종류를 가리지 않고 이 앱 파일(.workflow.json)에만
    // 저장한다 — tracker/*.md의 한 줄 형식은 건드리지 않는다.
    if ('note' in patch && (typeof patch.note !== 'string' || patch.note.length > 4000)) throw new Error('내용은 4,000자 이내로 적어 주세요.');
    const state = read();
    state.items[id] = { ...state.items[id], ...patch };
    write(state);
    return { ok: true };
  }
  function resolveMeeting(id, state) {
    const event = state.meetings[id] || currentMeetings().find(event => event.id === id) || draftsByMeeting(state)[id]?.event;
    if (!event) throw new Error('회의를 찾을 수 없어요.');
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
  // 제목별 연결을 바꾸면 오늘 그 제목의 회의 + (있으면) 사람이 연결을 고른 그 회의의 프로젝트를 함께 맞춘다.
  // 지난 회의 상세에서 연결했을 때 그 회의 머리·새로 담는 항목이 옛 프로젝트에 남지 않게(오늘만 보던 빈틈).
  // 같은 제목의 다른 지난 회의는 건드리지 않는다 — 그 회차는 그때의 프로젝트가 기록이다.
  function syncProject(title, project, meetingId) {
    const state=read();let changed=false;
    for(const event of [...Object.values(state.meetings),...currentMeetings()]) {
      if(event.title!==title || event.date!==today())continue;
      state.meetings[event.id]={...event,project};changed=true;
    }
    if(typeof meetingId==='string' && meetingId) {
      let event=null;
      try { event=resolveMeeting(meetingId,state); } catch { event=null; }
      if(event && String(event.title||'').trim()===title) { state.meetings[meetingId]={...event,project};changed=true; }
    }
    if(changed)write(state);
  }
  // 이 회의(번호)에 담긴 항목 번호들 — 회의에 프로젝트를 연결한 뒤 `이미 담은 것도 옮기기`가 쓴다.
  function meetingItemIds(meetingId) {
    const state=read();
    return new Set(Object.entries(state.items).filter(([, entry]) => entry && entry.meetingId===meetingId).map(([id]) => id));
  }
  // due: 할 일의 마감일, 확인 대기의 회신 기한. 결정에는 마감일이 없다.
  function capture({ meetingId: id, type, description, project, due }) {
    if (due && type === 'decision') throw new Error('결정에는 마감일을 넣을 수 없어요.');
    validateDate(due);
    return addToMeeting(id, { type, description, project, extra: due ? { due } : {} });
  }
  function addToMeeting(id, { type, description, project, extra = {}, draftId }) {
    if (!validItem({ type, description })) throw new Error('종류와 내용을 확인해 주세요.');
    const state = read();
    const event = resolveMeeting(id, state);
    // 고르지 않았으면 회의의 프로젝트 — 그 티켓이 묶음에 들어 있으면 대표 티켓으로 담는다(BBUNDLE 덩어리 2).
    const selected = project === undefined ? bundleLeadProject(event.project, state) : project;
    if (selected && (!['jira', 'group'].includes(selected.type) || typeof selected.value !== 'string' || !selected.value.trim() || /[\r\n\[\]]/.test(selected.value))) throw new Error('프로젝트를 확인해 주세요.');
    const result = create[type]({ description, ...extra, ...(selected ? { [selected.type]: selected.value } : {}) });
    if (!result.ok) throw new Error('항목을 저장하지 못했어요.');
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
    if (new Set(ids).size !== ids.length || ids.some(draftId => !pending.has(draftId))) throw new Error('이미 처리했거나 찾을 수 없는 항목이에요.');
    if (accept.some(item => !validItem(item))) throw new Error('종류와 내용을 확인해 주세요.');
    // when: 할 일을 담을 때만 "오늘"을 고를 수 있다. 정하지 않으면 나중에 할 일.
    if (accept.some(item => item.when !== undefined && !['today', 'later'].includes(item.when))) throw new Error('오늘 또는 나중을 골라 주세요.');
    if (accept.some(item => item.when === 'today' && item.type !== 'task')) throw new Error('오늘은 할 일만 고를 수 있어요.');
    // due: 사람이 고른 날짜. null이면 지운 것이고, 보내지 않으면 초안에 있던 마감(할 일만)을 그대로 쓴다.
    if (accept.some(item => item.due && item.type === 'decision')) throw new Error('결정에는 마감일을 넣을 수 없어요.');
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
  // 뺀 초안 되살리기(알림의 `되돌리기`·⌘Z) — review의 dismiss를 거꾸로 한다. "뺀 직후 모양"일 때만 받는다:
  // 검토 기록이 정확히 'dismissed'이고, 기록을 지우면 그 초안이 이 회의의 초안으로 다시 올라올 때.
  // 이미 담았거나(항목 번호) 살아 있거나(기록 없음) 모양이 다른 옛 기록이면 하나도 쓰지 않고 거절한다.
  // meeting_drafts.json은 여기서도 고치지 않는다(검토 기록 한 칸만 지운다).
  function restoreDismissed({ meetingId: id, drafts } = {}) {
    if (typeof id !== 'string' || !id || !Array.isArray(drafts) || !drafts.length || drafts.some(draftId => typeof draftId !== 'string' || !draftId) || new Set(drafts).size !== drafts.length) throw new Error('되살릴 초안을 확인해 주세요.');
    const state = read();
    const reviewed = { ...(state.reviewed || {}) };
    if (drafts.some(draftId => !Object.prototype.hasOwnProperty.call(reviewed, draftId) || reviewed[draftId] !== 'dismissed')) throw new Error('이미 담았거나 되살릴 수 없는 초안이에요.');
    drafts.forEach(draftId => { delete reviewed[draftId]; });
    const back = new Set((draftsByMeeting({ ...state, reviewed })[id]?.drafts || []).map(draft => draft.id));
    if (drafts.some(draftId => !back.has(draftId))) throw new Error('이 회의에서 뺀 초안을 찾을 수 없어요.');
    state.reviewed = reviewed;
    write(state);
    return { ok: true, restored: drafts.length };
  }
  // 방금 담은 것을 되돌린다: 항목은 삭제 휴지통(원문 보존)으로 옮기고, 초안은 다시 검토 대기로 올린다.
  // review가 돌려준 created 목록 그대로만 받는다(이 회의에서 초안으로 만든 항목이 아니면 거절).
  function undoReview({ meetingId: id, created }) {
    if (!Array.isArray(created) || !created.length) throw new Error('되돌릴 항목이 없어요.');
    const state = read();
    const draftOf = new Map(Object.entries(state.reviewed || {}).filter(([, itemId]) => itemId !== 'dismissed').map(([draftId, itemId]) => [itemId, draftId]));
    if (new Set(created).size !== created.length || created.some(itemId => !draftOf.has(itemId) || state.items[itemId]?.meetingId !== id)) throw new Error('이미 되돌렸거나 되돌릴 수 없는 항목이에요.');
    created.forEach(itemId => remove(itemId));
    const reviewed = { ...state.reviewed }, linked = { ...state.items };
    created.forEach(itemId => { delete reviewed[draftOf.get(itemId)]; delete linked[itemId]; });
    state.reviewed = reviewed; state.items = linked;
    write(state);
    return { ok: true, restored: created.length };
  }
  // ---------- 직접 만든(그룹) 프로젝트 ↔ 지라 티켓 하나 (사람이 손으로 건다) ----------
  // 항목을 `jira:KEY`로 옮겨 쓰지 않는다 — 프로젝트 이름이 바뀌고 되돌리기 어렵다.
  // 여기 저장하는 것은 `그룹 이름 → 지라 키` 표 하나뿐이고, 저장 길은 다른 기능과 같다
  // (idempotent → mutations.run → .workflow.json 원자적 쓰기).
  const PROJECT_LINK_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
  const linkGroupName = value => String(value || '').replace(/_/g, ' ');
  // 앱이 실제로 프로젝트로 보여 주는 그룹 이름들 — 화면의 wfKey/wfMeetingKey와 같은 규칙이다
  // (지라 키가 있는 항목은 지라 프로젝트이지 그룹이 아니다).
  function groupNames(state) {
    const names = new Set();
    for (const item of Object.values(refs())) {
      if (item.jira) continue;
      const named = item.group || item.project;
      if (named) names.add(linkGroupName(named));
    }
    for (const event of Object.values(state.meetings)) {
      if (event.project && event.project.type === 'group' && event.project.value) names.add(linkGroupName(event.project.value));
    }
    return names;
  }
  // 저장하기 전에 보낸 값만 본다(지라에는 닿지 않는다) — 부르는 쪽이 여기서 통과한 키만
  // 지라에서 읽어 보고, 읽히면 그때 linkProject로 저장한다.
  function checkProjectLink({ project, jira }) {
    if (typeof project !== 'string' || !project.startsWith('group:')) throw new Error('직접 만든 프로젝트에만 지라 티켓을 연결할 수 있어요.');
    const name = project.slice('group:'.length).trim();
    if (!name || name.length > 200 || /[\r\n]/.test(name)) throw new Error('프로젝트를 확인해 주세요.');
    if (!groupNames(read()).has(name)) throw new Error('프로젝트를 찾을 수 없어요.');
    const key = jira === undefined || jira === null || jira === '' ? null : jira;
    if (key !== null && (typeof key !== 'string' || !PROJECT_LINK_KEY_RE.test(key))) throw new Error('지라 번호를 확인해 주세요.');
    return { name, key };
  }
  function linkProject({ project, jira }) {
    const { name, key } = checkProjectLink({ project, jira });
    const state = read();
    const links = { ...(state.projectLinks || {}) };
    if (key) links[name] = key;
    else delete links[name];
    state.projectLinks = links;
    write(state);
    return { ok: true, project, jira: key };
  }

  // ---------- 지라 프로젝트 앱 안 별칭 (BJALIAS) ----------
  // 지라 요약은 그대로 두고 앱 안에서만 쓰는 이름을 덧씌운다. 여기서 보는 것은 형식(지라 키·글자
  // 길이·대괄호)뿐이다 — 그룹 이름·다른 별칭·지라 요약과의 겹침 검사는 부르는 쪽(server.js)이
  // 이 함수를 부르기 전에 마친다(지라 요약 목록은 여기서 보이지 않는다 — checkProjectLink와 같은
  // 역할 나눔). 저장 길은 projectLinks와 같다(idempotent → mutations.run → 원자적 쓰기).
  const PROJECT_ALIAS_MAX = 60;
  function checkProjectAlias({ jira, alias }) {
    if (typeof jira !== 'string' || !PROJECT_LINK_KEY_RE.test(jira)) throw new Error('지라 번호를 확인해 주세요.');
    if (alias === undefined || alias === null || alias === '') return { jira, alias: null };
    if (typeof alias !== 'string') throw new Error(`별칭은 ${PROJECT_ALIAS_MAX}자 이내 한 줄로, 대괄호 없이 적어 주세요.`);
    // 밑줄→공백 정리는 renameProject의 `to`와 같은 규칙이다(연속 공백은 여기서 지우지 않는다 —
    // 겹침 비교에서만 groupNameKey가 고르게 맞춘다. renameProject의 "결제  리뉴얼"이 자기 이름과
    // 겹치지 않는 것과 같은 이유다).
    const cleaned = alias.replace(/_/g, ' ').trim();
    if (!cleaned || cleaned.length > PROJECT_ALIAS_MAX || /[\r\n\[\]]/.test(cleaned)) throw new Error(`별칭은 ${PROJECT_ALIAS_MAX}자 이내 한 줄로, 대괄호 없이 적어 주세요.`);
    return { jira, alias: cleaned };
  }
  function setProjectAlias({ jira, alias }) {
    const { jira: key, alias: cleaned } = checkProjectAlias({ jira, alias });
    const state = read();
    const aliases = { ...(state.projectAliases || {}) };
    const previous = aliases[key] || null;
    if (cleaned) aliases[key] = cleaned;
    else delete aliases[key];
    state.projectAliases = aliases;
    write(state);
    return { ok: true, jira: key, alias: cleaned, previous };
  }
  // 겹침 검사(server.js)·이름표 짓기(projectLabelOf 등)가 읽는 자리 — read()는 file I/O라 매번
  // 새로 읽는다(스냅샷 캐시가 아니다).
  function projectAliases() {
    return { ...(read().projectAliases || {}) };
  }

  // ---------- 프로젝트 묶어 보기 (BBUNDLE) ----------
  // 한 가지 일이 지라 티켓 둘 이상으로 나뉜 것을 프로젝트 탭에서 한 줄로 본다. **화면에서만** 묶는다 —
  // 항목의 `jira:KEY`·지라 쪽은 하나도 바꾸지 않고, `.workflow.json`의 `projectBundles` 칸에 표시 정보만
  // 둔다: `[{ id, lead: 'jira:A', keys: ['jira:A', 'jira:B'], at }]`. 한 키는 한 묶음에만, 묶음은 키 2개
  // 이상, lead는 keys 안에 있다. 지금은 지라 키끼리만 묶는다(그룹 프로젝트는 이름 바꾸기·에픽으로
  // 옮기기가 키를 바꾸는데, 그 길까지 묶음을 따라가게 하는 것은 다음 덩어리로 미룬다).
  // 저장 길은 다른 기능과 같다(idempotent → mutations.run → 원자적 쓰기). 옛 앱은 이 칸을 모르지만
  // 모든 저장이 "읽고 → 고치고 → 통째로 쓰기"라 칸을 지우지 않는다(데이터 형식 번호를 올리지 않는다).
  const BUNDLE_KEY_RE = /^jira:[A-Z][A-Z0-9]*-\d+$/;
  const BUNDLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const BUNDLE_MAX_KEYS = 10;
  // 묶음 수 상한 — 묶인 키는 전부 지라 목록의 추가 조회(`key in (…)`, jira-client.js listMyIssues)에 실리는데
  // 그 조회는 한 번에 100개까지라, 묶음이 끝없이 늘면 이름을 못 읽는 티켓이 생긴다(한 묶음 2개 × 100 = 200은 넉넉한 위 한계).
  const BUNDLE_MAX_BUNDLES = 100;
  const bundleIdOf = keys => `bd_${createHash('sha256').update(keys.join('|')).digest('hex').slice(0, 12)}`;
  // 깨진 값은 조용히 정리한다: 형식이 틀린 키·중복 키·이미 앞 묶음에 있는 키는 빼고, 남은 키가 2개
  // 미만이면 그 묶음을 버리고, lead가 keys 밖이면 첫 키로, id가 없으면 키로 지은 id로 채운다.
  function cleanBundles(raw) {
    if (!Array.isArray(raw)) return [];
    const claimed = new Set();
    const ids = new Set();
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.keys)) continue;
      const keys = [];
      for (const key of entry.keys) {
        if (typeof key !== 'string' || !BUNDLE_KEY_RE.test(key) || claimed.has(key) || keys.includes(key)) continue;
        keys.push(key);
      }
      if (keys.length < 2) continue;
      const trimmed = keys.slice(0, BUNDLE_MAX_KEYS);
      let id = typeof entry.id === 'string' && BUNDLE_ID_RE.test(entry.id) ? entry.id : bundleIdOf(trimmed);
      if (ids.has(id)) id = bundleIdOf(trimmed);
      if (ids.has(id)) continue;
      trimmed.forEach(key => claimed.add(key));
      ids.add(id);
      const lead = trimmed.includes(entry.lead) ? entry.lead : trimmed[0];
      out.push({ id, lead, keys: trimmed, at: typeof entry.at === 'string' ? entry.at : null });
    }
    return out;
  }
  // 회의 담기 기본값 — `{ type: 'jira', value: 'B' }`가 묶음에 들어 있으면 대표 키로 바꿔 준다. 나머지는 그대로.
  function bundleLeadProject(project, state) {
    if (!project || project.type !== 'jira' || typeof project.value !== 'string') return project;
    const home = cleanBundles(state.projectBundles).find(bundle => bundle.keys.includes(`jira:${project.value}`));
    return home && home.lead !== `jira:${project.value}` ? { ...project, value: home.lead.slice('jira:'.length) } : project;
  }
  const bundleCopy = bundle => (bundle ? { id: bundle.id, lead: bundle.lead, keys: [...bundle.keys], at: bundle.at || null } : null);
  const bundleSame = (a, b) => (!a && !b) || (!!a && !!b && a.id === b.id && a.lead === b.lead && a.keys.join('|') === b.keys.join('|'));
  function bundleKey(value) {
    if (typeof value !== 'string' || !BUNDLE_KEY_RE.test(value)) throw new Error('지라 프로젝트끼리만 묶을 수 있어요.');
    return value;
  }
  function writeBundles(state, bundles) {
    state.projectBundles = bundles;
    write(state);
  }
  // 묶기 — project가 이미 묶음에 있으면 그 묶음에 더하고, 없으면 project를 대표로 새 묶음을 만든다.
  // 더하는 키가 이미 (다른 또는 같은) 묶음에 있으면 거절한다(한 키는 한 묶음에만) — 같은 묶음이면 그렇다고 말한다.
  // 돌려주는 before/after는 되돌리기(restoreBundle)가 그대로 쓰는 값이다.
  function bundleProjects(body) {
    const project = bundleKey(body && body.project);
    const add = Array.isArray(body && body.add) ? body.add : null;
    if (!add || !add.length) throw new Error('함께 묶을 프로젝트를 골라 주세요.');
    add.forEach(bundleKey);
    if (new Set(add).size !== add.length || add.includes(project)) throw new Error('같은 프로젝트를 두 번 묶을 수 없어요.');
    const state = read();
    const bundles = cleanBundles(state.projectBundles);
    const home = bundles.find(bundle => bundle.keys.includes(project)) || null;
    for (const key of add) {
      const taken = bundles.find(bundle => bundle.keys.includes(key));
      if (taken && taken === home) throw new Error(`이미 이 묶음에 들어 있어요 — ${key.slice('jira:'.length)}`);
      if (taken) throw new Error(`${key.slice('jira:'.length)}는 이미 다른 묶음에 있어요. 그 묶음을 먼저 풀어 주세요.`);
    }
    if (!home && bundles.length >= BUNDLE_MAX_BUNDLES) throw new Error(`묶음은 ${BUNDLE_MAX_BUNDLES}개까지 만들 수 있어요. 안 쓰는 묶음을 먼저 풀어 주세요.`);
    const before = bundleCopy(home);
    const keys = [...(home ? home.keys : [project]), ...add];
    if (keys.length > BUNDLE_MAX_KEYS) throw new Error(`한 묶음에는 ${BUNDLE_MAX_KEYS}개까지 넣을 수 있어요.`);
    const after = home
      ? { ...home, keys }
      : { id: `bd_${createHash('sha256').update(`${keys.join('|')}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12)}`, lead: project, keys, at: new Date().toISOString() };
    writeBundles(state, home ? bundles.map(bundle => (bundle === home ? after : bundle)) : [...bundles, after]);
    return { ok: true, before, after: bundleCopy(after) };
  }
  function bundleById(bundles, id) {
    if (typeof id !== 'string' || !BUNDLE_ID_RE.test(id)) throw new Error('묶음을 확인해 주세요.');
    const found = bundles.find(bundle => bundle.id === id);
    if (!found) throw new Error('묶음을 찾을 수 없어요.');
    return found;
  }
  // 풀기 — 표시 정보만 지운다. 업무는 원래 티켓(`jira:KEY`)에 그대로 있다.
  function unbundleProjects(body) {
    const state = read();
    const bundles = cleanBundles(state.projectBundles);
    const found = bundleById(bundles, body && body.id);
    writeBundles(state, bundles.filter(bundle => bundle !== found));
    return { ok: true, before: bundleCopy(found), after: null };
  }
  // 대표 바꾸기 — 이름·색은 대표 티켓의 것이라(저장하지 않는다) lead만 바꾼다.
  function setBundleLead(body) {
    const lead = bundleKey(body && body.lead);
    const state = read();
    const bundles = cleanBundles(state.projectBundles);
    const found = bundleById(bundles, body && body.id);
    if (!found.keys.includes(lead)) throw new Error('이 묶음에 있는 프로젝트만 대표로 고를 수 있어요.');
    if (found.lead === lead) throw new Error('이미 대표예요.');
    const after = { ...found, lead };
    writeBundles(state, bundles.map(bundle => (bundle === found ? after : bundle)));
    return { ok: true, before: bundleCopy(found), after: bundleCopy(after) };
  }
  // 되돌리기·다시 실행(⌘Z와 알림의 `되돌리기`) — "지금이 after와 같을 때만" before로 되돌린다. 그 사이
  // 다른 곳에서 묶음이 바뀌었으면 덮지 않고 거절한다. before를 넣을 때도 한 키 한 묶음 규칙을 다시 본다.
  function restoreBundle(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || !BUNDLE_ID_RE.test(id)) throw new Error('묶음을 확인해 주세요.');
    const shape = (value) => {
      if (value === null || value === undefined) return null;
      const [clean] = cleanBundles([value]);
      if (!clean || clean.id !== id || clean.keys.length !== (Array.isArray(value.keys) ? value.keys.length : -1) || clean.lead !== value.lead) throw new Error('되돌릴 묶음을 확인해 주세요.');
      return clean;
    };
    const before = shape(body.before);
    const after = shape(body.after);
    const state = read();
    const bundles = cleanBundles(state.projectBundles);
    const current = bundles.find(bundle => bundle.id === id) || null;
    if (!bundleSame(current, after)) throw new Error('그 사이 묶음이 바뀌어서 되돌리지 못했어요.');
    const rest = bundles.filter(bundle => bundle !== current);
    if (before) {
      const clash = before.keys.find(key => rest.some(bundle => bundle.keys.includes(key)));
      if (clash) throw new Error(`${clash.slice('jira:'.length)}가 다른 묶음에 들어가 있어서 되돌리지 못했어요.`);
    }
    const index = current ? bundles.indexOf(current) : bundles.length;
    const next = [...rest];
    if (before) next.splice(Math.min(index, next.length), 0, before);
    writeBundles(state, next);
    return { ok: true, before: bundleCopy(current), after: bundleCopy(before) };
  }

  // ---------- 새 프로젝트 화면의 직군 세트 ----------
  // `workspace.config.json`은 사람이 손으로 고치는 파일이라 앱이 쓰지 않는다 — 직군 세트는 앱
  // 데이터다. 저장 길은 projectLinks·projectArchive와 같다(idempotent → mutations.run → 원자적 쓰기).
  // 지라에는 아무것도 묻지 않는다(접두어는 우리가 붙이는 글자일 뿐이다).
  const ROLE_MAX = 20;
  function checkJiraRoles({ roles }) {
    if (!Array.isArray(roles)) throw new Error('직군 목록을 확인해 주세요.');
    if (roles.length > ROLE_MAX) throw new Error(`직군은 ${ROLE_MAX}개까지 저장할 수 있어요.`);
    const seen = new Set();
    return roles.map((role) => {
      const label = typeof (role && role.label) === 'string' ? role.label.trim() : '';
      const prefix = typeof (role && role.prefix) === 'string' ? role.prefix.trim() : '';
      if (!label || label.length > 30 || /[\r\n]/.test(label)) throw new Error('직군 이름은 30자 이내 한 줄로 적어 주세요.');
      if (!prefix || prefix.length > 20 || /[\r\n]/.test(prefix)) throw new Error('접두어는 20자 이내 한 줄로 적어 주세요.');
      const key = label.toLocaleLowerCase();
      if (seen.has(key)) throw new Error('같은 직군 이름이 두 번 있어요.');
      seen.add(key);
      return { label, prefix };
    });
  }
  function saveJiraRoles(body) {
    const roles = checkJiraRoles(body || {});
    const state = read();
    state.jiraRoles = roles;
    write(state);
    return { ok: true, roles };
  }

  // ---------- 직접 만든(그룹) 프로젝트 이름 바꾸기 ----------
  // 이 저장소가 가진 세 자리(회의 프로젝트·projectLinks 키·projectArchive 키)만 바꾼다. 업무 파일과
  // 회의 연결 파일·주간요약은 부르는 쪽(server.js renameProject)이 같은 트랜잭션 안에서 이어서 바꾼다.
  // 칸이 없던 옛 파일에 `projectLinks`·`projectArchive`를 새로 만들어 넣지는 않는다(snapshot 주석과 같은 규칙).
  const groupList = () => [...groupNames(read())];
  function renameGroup(from, to) {
    const state = read();
    let meetings = 0, links = 0, archive = 0;
    for (const [id, event] of Object.entries(state.meetings)) {
      if (!event.project || event.project.type !== 'group' || linkGroupName(event.project.value) !== from) continue;
      state.meetings[id] = { ...event, project: { ...event.project, value: to, label: to } };
      meetings += 1;
    }
    if (state.projectLinks) {
      const next = {};
      for (const [name, key] of Object.entries(state.projectLinks)) {
        if (linkGroupName(name) === from) { next[to] = key; links += 1; } else next[name] = key;
      }
      state.projectLinks = next;
    }
    if (state.projectArchive) {
      const next = {};
      for (const [key, day] of Object.entries(state.projectArchive)) {
        const named = key.startsWith('group:') && linkGroupName(key.slice('group:'.length)) === from;
        if (named) { next[`group:${to}`] = day; archive += 1; } else next[key] = day;
      }
      state.projectArchive = next;
    }
    if (meetings || links || archive) write(state);
    return { meetings, links, archive };
  }

  // ---------- 직접 만든(그룹) 프로젝트 → 지라 에픽으로 옮기기 (BMOVE) ----------
  // 이 저장소가 가진 두 자리(회의 프로젝트·projectLinks 키)만 바꾼다. 업무 파일과 회의 연결 파일·
  // 주간요약은 부르는 쪽(server.js moveProject)이 같은 트랜잭션 안에서 이어서 바꾼다.
  // renameGroup과 다른 점: 종류(type)까지 `group`→`jira`로 바뀐다 — 되돌릴 때 정확히 반대로 가려고
  // 바뀐 회의 id 목록을 돌려준다(renameGroup은 개수만 돌려줬다).
  function moveGroup(from, to) {
    const state = read();
    const ids = [];
    for (const [id, event] of Object.entries(state.meetings)) {
      if (!event.project || event.project.type !== 'group' || linkGroupName(event.project.value) !== from) continue;
      state.meetings[id] = { ...event, project: { type: 'jira', value: to, label: to } };
      ids.push(id);
    }
    let link = null;
    if (state.projectLinks && Object.prototype.hasOwnProperty.call(state.projectLinks, from)) {
      link = state.projectLinks[from];
      const next = { ...state.projectLinks };
      delete next[from];
      state.projectLinks = next;
    }
    if (ids.length || link !== null) write(state);
    return { ids, link };
  }
  // 되돌리기는 **기록에 있는 그 회의 id들만** 반대로 돌린다. 그 사이 다른 프로젝트로 다시 바뀌었거나
  // 지워졌으면 건드리지 않고 건너뛴다(skipped로 센다).
  function undoMoveGroup({ from, to, meetingIds, link }) {
    const state = read();
    let restored = 0, skipped = 0;
    for (const id of meetingIds) {
      const event = state.meetings[id];
      if (!event || !event.project || event.project.type !== 'jira' || event.project.value !== to) { skipped += 1; continue; }
      state.meetings[id] = { ...event, project: { type: 'group', value: from, label: from } };
      restored += 1;
    }
    if (link !== null && link !== undefined) state.projectLinks = { ...(state.projectLinks || {}), [from]: link };
    write(state);
    return { restored, skipped };
  }
  // 이동 기록(`projectMoves`) — 되돌리기를 정확하게 하기 위한 서버 저장값일 뿐이고 화면에는
  // 내려보내지 않는다(snapshot()에 넣지 않는다). 최근 20개만 유지한다.
  const PROJECT_MOVE_MAX = 20;
  function recordProjectMove(entry) {
    const state = read();
    const moves = Array.isArray(state.projectMoves) ? state.projectMoves : [];
    state.projectMoves = [...moves, entry].slice(-PROJECT_MOVE_MAX);
    write(state);
  }
  // 한 번 되돌리면 기록에서 지운다(한 번만 되돌릴 수 있다).
  function takeProjectMove(id) {
    const state = read();
    const moves = Array.isArray(state.projectMoves) ? state.projectMoves : [];
    const index = moves.findIndex(entry => entry.id === id);
    if (index === -1) return null;
    const entry = moves[index];
    state.projectMoves = [...moves.slice(0, index), ...moves.slice(index + 1)];
    write(state);
    return entry;
  }

  // ---------- 반응 필요에서 치운 줄 (BATTENTION) ----------
  // 저장하는 것은 `줄 id → 치운 시각` 표 하나뿐이다 — 댓글 글자도, 사람 이름도 저장하지 않는다.
  // id는 `출처:키:마지막 다른 사람 댓글 id`라 댓글이 더 달리면 값이 달라져 그 줄이 다시 나타난다.
  // 저장 길은 다른 기능과 같다(idempotent → mutations.run → .workflow.json 원자적 쓰기).
  const ATTENTION_ID_RE = /^[a-z]+:[A-Z][A-Z0-9]*-\d+:\d+$/;
  const ATTENTION_MAX = 200;
  const ATTENTION_DAYS = 30;
  const dismissedTable = state => ({ ...((state.attention || {}).dismissed || {}) });
  // 서버가 목록을 거를 때 읽는다. 파일을 못 읽어도 화면이 멈추지 않게 빈 표로 흐른다.
  function attentionDismissed() {
    try { return dismissedTable(read()); } catch { return {}; }
  }
  function checkAttentionId(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || !ATTENTION_ID_RE.test(id)) throw new Error('보낸 값을 확인해 주세요.');
    return id;
  }
  // 치울 때마다 표를 정리한다: 30일이 지난 것과, 200개를 넘으면 오래된 것부터 버린다.
  // 다만 **지금 목록에 있는 id**는 버리지 않는다 — 버리는 순간 그 줄이 다시 올라온다.
  function pruneDismissed(table, keep) {
    const at = value => Date.parse(value) || 0;
    const oldest = Date.now() - ATTENTION_DAYS * 24 * 60 * 60 * 1000;
    const droppable = Object.keys(table).filter(id => !keep.has(id));
    droppable.filter(id => at(table[id]) < oldest).forEach((id) => { delete table[id]; });
    const left = droppable.filter(id => table[id] !== undefined).sort((a, b) => at(table[a]) - at(table[b]));
    while (Object.keys(table).length > ATTENTION_MAX && left.length) delete table[left.shift()];
    return table;
  }
  function dismissAttention(body, keep = new Set()) {
    const id = checkAttentionId(body || {});
    const state = read();
    const table = dismissedTable(state);
    table[id] = new Date().toISOString();
    state.attention = { ...(state.attention || {}), dismissed: pruneDismissed(table, new Set([...keep, id])) };
    write(state);
    return { ok: true, id };
  }
  function undismissAttention(body) {
    const id = checkAttentionId(body || {});
    const state = read();
    const table = dismissedTable(state);
    delete table[id];
    state.attention = { ...(state.attention || {}), dismissed: table };
    write(state);
    return { ok: true, id };
  }

  // ---------- `답변 왔어요` 확인함 (리마인드 카드에서 빼기) ----------
  // 기다리던 답변이 온 업무를 한 번 열어 보면 리마인드 카드에서 뺀다. 기기마다 다르면 안 되므로 여기(.workflow.json)에
  // 둔다 — 그 업무의 흐름 기록 칸 하나(`answerSeen`)라 업무가 사라지면 함께 뜻을 잃고, 표가 따로 불어나지 않는다.
  // 값은 `{ at: 확인 시각, answer: '확인 대기 번호:완료일' }`이다. 화면은 지금의 `답변`(blockedBy + 그 확인 대기의 완료일)이
  // 적어 둔 answer와 다를 때만 다시 올린다 — 다른 확인 대기에 다시 걸렸다가 답이 오면(또는 같은 확인 대기를 풀었다가
  // 다른 날 다시 끝내면) 다시 뜬다. 같은 날 풀었다 다시 끝낸 것은 같은 답으로 본다(완료일이 날짜뿐이다).
  // 리마인드에서 빠지는 순간 알림의 `되돌리기`·⌘Z로 지울 수 있다(unmarkAnswerSeen). 업무 줄의 `답변 왔어요` 상태 글자는 그대로 남는다.
  const answerMark = (blockerId, blocker) => `${blockerId}:${(blocker && blocker.completed) || ''}`;
  function markAnswerSeen(body) {
    const id = body && body.id;
    const all = refs();
    const source = typeof id === 'string' ? all[id] : null;
    if (!source) throw new Error('항목을 찾을 수 없어요.');
    if (!['task', 'bug'].includes(source.type)) throw new Error('업무에서만 표시할 수 있어요.');
    const state = read();
    const entry = state.items[id] || {};
    const blocker = entry.blockedBy ? all[entry.blockedBy] : null;
    if (!blocker || blocker.status !== 'done') throw new Error('아직 답변이 오지 않은 업무예요.');
    const answer = answerMark(entry.blockedBy, blocker);
    if (entry.answerSeen && entry.answerSeen.answer === answer) return { ok: true, id, answerSeen: entry.answerSeen };
    const answerSeen = { at: new Date().toISOString(), answer };
    state.items[id] = { ...entry, answerSeen };
    write(state);
    return { ok: true, id, answerSeen };
  }
  // 되돌리기(알림의 `되돌리기`·⌘Z): 그 업무의 확인 표시만 지운다 — 줄이 리마인드에 다시 선다.
  function unmarkAnswerSeen(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || !refs()[id]) throw new Error('항목을 찾을 수 없어요.');
    const state = read();
    const entry = state.items[id];
    if (!entry || !entry.answerSeen) return { ok: true, id, changed: false };
    const next = { ...entry };
    delete next.answerSeen;
    state.items[id] = next;
    write(state);
    return { ok: true, id, changed: true };
  }

  // ---------- 담은 항목의 종류 바꾸기 ----------
  // 새 항목을 만들지 않는다 — 같은 id로 업무 파일의 줄만 옮긴다(move). 회의 연결(state.items[id].meetingId)과
  // 검토 기록(state.reviewed)은 항목 번호로 이어져 있어서 그대로 남는다.
  // 여기서 손보는 것은 새 종류에 없는 흐름 기록 칸을 지우는 것 하나뿐이다.
  const RETYPE_DROP = {
    task: ['followUp', 'contacted'],            // 다시 확인할 날짜·확인 요청 기록은 확인 대기의 것이다
    check: ['blockedBy', 'answerSeen'],          // 기다리는 답변 연결(과 그 답을 확인한 표시)은 할 일의 것이다
    decision: ['blockedBy', 'answerSeen', 'followUp', 'contacted', 'outcome'], // 결정에는 결과 한 줄이 없다
  };
  function retype({ id, type }) {
    if (!['task', 'check', 'decision'].includes(type)) throw new Error('바꿀 종류를 확인해 주세요.');
    const source = refs()[id];
    if (!source) throw new Error('항목을 찾을 수 없어요.');
    if (!['task', 'bug', 'check', 'decision'].includes(source.type)) throw new Error('이 종류는 바꿀 수 없어요.');
    if (source.type === type) throw new Error('이미 같은 종류예요.');
    if (source.status === 'done') throw new Error('완료한 항목은 종류를 바꿀 수 없어요.');
    const moved = move(id, type);
    const state = read();
    const entry = state.items[id];
    if (entry) {
      const next = { ...entry };
      RETYPE_DROP[type].forEach(key => { delete next[key]; });
      if (JSON.stringify(next) !== JSON.stringify(entry)) { state.items[id] = next; write(state); }
    }
    return { ok: true, id, type, from: moved.from };
  }

  function link({ id, meetingId }) {
    if (!refs()[id]) throw new Error('항목을 찾을 수 없어요.');
    const state = read();
    const event = resolveMeeting(meetingId, state);
    if (state.items[id]?.meetingId && state.items[id].meetingId !== meetingId) throw new Error('이미 다른 회의에 연결된 항목이에요.');
    state.meetings[meetingId] = event;
    state.items[id] = { ...state.items[id], meetingId };
    write(state);
    return { ok: true };
  }
  return { archive, snapshot, patchItem, saveMeeting, syncProject, meetingItemIds, markAnswerSeen, unmarkAnswerSeen, capture, review, restoreDismissed, undoReview, retype, link, checkProjectLink, linkProject, checkProjectAlias, setProjectAlias, projectAliases, checkJiraRoles, saveJiraRoles, bundleProjects, unbundleProjects, setBundleLead, restoreBundle, groupList, renameGroup, moveGroup, undoMoveGroup, recordProjectMove, takeProjectMove, attentionDismissed, dismissAttention, undismissAttention, outcome: id => read().items[id]?.outcome || '' };
};
