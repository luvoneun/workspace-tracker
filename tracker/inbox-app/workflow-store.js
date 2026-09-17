const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

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
    const temp = `${filename}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, filename);
  }
  const meetingId = (date, event) => createHash('sha256').update(JSON.stringify([date, event.start, event.title])).digest('hex').slice(0, 24);
  function currentMeetings() {
    return calendar().events.map(event => ({ ...event, id: meetingId(today(), event), date: today(), series: event.title.trim() }));
  }
  // Called by startup/file watcher, never as a side effect of GET /api/items.
  function archive() {
    const state = read();
    let changed = false;
    for (const event of currentMeetings()) {
      const prior = state.meetings[event.id];
      const next = { ...event, ...prior, end: event.end, link: event.link };
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
    const event = state.meetings[id] || currentMeetings().find(event => event.id === id);
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
  function capture({ meetingId: id, type, description, project }) {
    if (!['task', 'check', 'decision'].includes(type) || typeof description !== 'string' || !description.trim() || /[\r\n]/.test(description) || description.length > 1000) throw new Error('종류와 내용을 확인해 주세요.');
    const state = read();
    const event = resolveMeeting(id, state);
    const selected = project === undefined ? event.project : project;
    if (selected && (!['jira', 'group'].includes(selected.type) || typeof selected.value !== 'string' || !selected.value.trim() || /[\r\n\[\]]/.test(selected.value))) throw new Error('프로젝트를 확인해 주세요.');
    const result = create[type]({ description, ...(selected ? { [selected.type]: selected.value } : {}) });
    if (!result.ok) throw new Error('항목을 저장하지 못했습니다.');
    try {
      state.meetings[id] = event;
      state.items[result.id] = { meetingId: id };
      write(state);
    } catch (error) { remove(result.id, false); throw error; }
    return result;
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
  return { archive, snapshot, patchItem, saveMeeting, capture, link, outcome: id => read().items[id]?.outcome || '' };
};
