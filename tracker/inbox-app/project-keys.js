// 직접 만든(그룹) 프로젝트의 열쇠 바꾸기 — 한 곳. 프로젝트 이름은 기록 여러 자리에 글자로 박혀 있어서(번호가 없다)
// 이름 바꾸기·지라 에픽으로 옮기기·합치기·지우기가 모두 "그 자리들을 차례로 고쳐 쓰기"다. 그 자리 목록이 아래
// SITES(자리 표)이고, 네 동작과 되돌리기 둘은 rekeyProject·unrekeyProject 하나만 부른다. 새 자리를 만들면 표에
// 한 줄을 더한다 — 안 더하면 project-rekey.test.js(데이터 폴더 전체에서 옛 이름 0번)가 빨개진다.
// 명세: docs/정리/2026-10-08-프로젝트-고정-번호.md (추천 C). 지라 프로젝트(`jira:KEY`)는 키가 이미 고정 번호라 여기 없다.
//
// 트랜잭션은 부르는 쪽(server.js — idempotent → mutations.run)이 연다. 여기서 던지면 저널이 그때까지 쓴 것을 전부
// 되돌린다(반쯤 바뀐 이름이 없다). 자리를 걷는 차례(① → ②③④ → ⑤ → ⑥)도 예전 그대로다.

// 동작 넷. `to`의 꼴: rename·merge는 그룹 이름, move는 지라 키, delete는 null.
const MODES = ['rename', 'move', 'merge', 'delete'];

// 자리 표 — 모드마다 무엇을 하는지(빈칸이면 그 모드는 그 자리를 건드리지 않는다)와 되돌리기가 무엇을 보는지.
// `files`는 데이터 폴더 기준 파일이다(빠뜨림 시험이 이 표로 심은 자리를 맞춰 본다).
const SITES = [
  { id: '①', files: ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md'], what: '업무 줄의 `group:`·`project:`(아이디어) 칸 — 파일 표기는 공백→밑줄, 지라가 걸린 줄은 건너뜀',
    modes: { rename: '두 칸 다 값만 새 이름으로(id 없는 줄도)', move: '종류의 칸(아이디어는 project, 나머지는 group)을 빼고 `jira:KEY`를 붙임',
      merge: '두 칸 다 값을 B로 — id 없는 줄이 있으면 쓰기 전에 거절', delete: '두 칸 다 뺌 — id 없는 줄이 있으면 쓰기 전에 거절' },
    undo: '기록한 id만, 지금도 바뀐 뒤 모양일 때만' },
  { id: '②③④', files: ['.workflow.json'], what: '회의 프로젝트(②) · projectLinks 키(③, 수동 지라 연결) · projectArchive 키(④, 읽는 코드 없는 옛 기록)',
    modes: { rename: 'workflows.renameGroup', move: 'workflows.moveGroup — ②는 지라로, ③은 지움, ④는 그대로',
      merge: 'workflows.mergeGroup — B에 이미 있으면 B 것을 남김', delete: 'workflows.mergeGroup(null) — ②는 비우고 ③은 지움, ④는 그대로' },
    undo: 'workflows.undoMoveGroup · undoMergeGroup' },
  { id: '⑤', files: ['.meeting_links.json'], what: '회의 제목 → 프로젝트(`group:이름`, 정기 회의 자동 연결)',
    modes: { rename: '`group:새 이름`', move: '`jira:KEY`', merge: '`group:B`', delete: '그 줄을 뺌(남기면 다음 정기 회의가 되살린다)' },
    undo: '기록한 제목만, 지금도 바뀐 뒤 값일 때만' },
  { id: '⑥', files: ['.report-drafts.json'], what: '주간요약 저장본 — 소제목(group)·bucket 앞머리·근거 이름표·묶기 전 문장·소제목 이름 열쇠(weekPolish names), 모든 주',
    modes: { rename: 'reportDrafts.renameGroup', move: 'reportDrafts.moveGroup(표시 이름 `KEY · 이름`)', merge: 'reportDrafts.mergeGroup' },
    undo: 'reportDrafts.moveGroupUndo · mergeGroupUndo' },
];
// 일부러 안 바꾸는 자리 — 이유와 함께. 빠뜨림 시험이 이 목록만 예외로 본다.
const KEPT = [
  { id: '⑦', files: ['.workflow.json projectMoves·projectMerges'], why: '되돌리기 기록이라 옛 이름을 남겨야 되돌릴 수 있다' },
  { id: '⑧', files: ['.trash.json', '.backups/'], why: '휴지통 원문 줄(되살리면 옛 이름으로 돌아온다 — 10-06 명세 예외 13) · 저장마다 남기는 바로 전 사본' },
  { id: '⑨', files: [], why: '브라우저 localStorage.projectKey — 못 찾으면 화면이 첫 프로젝트로 간다' },
  { id: '④', modes: ['move', 'delete'], why: 'projectArchive는 읽는 코드가 없는 옛 기록 — 이름 바꾸기·합치기만 따라간다' },
  { id: '⑥', modes: ['delete'], why: '지우기는 지난 보고를 바꾸지 않는다(DECISIONS 169 · 10-06 명세 예외 9·10)' },
];

module.exports = ({ fs, listTrackerFiles, TRACK_RE, parseFields, stampUpdated, readMeetingLinks, MEETING_LINKS_PATH, workflows, reportDrafts }) => {
  const plain = value => String(value).replace(/_/g, ' ');
  const token = name => name.replace(/\s+/g, '_');
  const isKeyPart = key => key === 'group' || key === 'project';
  const partKey = (part) => { const at = part.indexOf(':'); return at === -1 ? null : part.slice(0, at); };
  const partValue = part => part.slice(part.indexOf(':') + 1);

  // ① 업무 파일 걷기 — 모든 파일의 새 내용을 먼저 다 짓고(edit가 던지면 아무것도 쓰기 전에 멈춘다) 그다음 쓴다.
  // edit(match, fields, parts)가 새 칸 문자열을 돌려주면 그 줄을 바꾸고 수정 시각(updated)을 새로 적는다(stampUpdated —
  // 저장 충돌 검사와 응답 revisions가 이것을 본다). null이면 그 줄은 그대로다.
  function walkItems(edit) {
    let lines = 0;
    const plans = listTrackerFiles().map((filePath) => {
      let touched = false;
      const next = fs.readFileSync(filePath, 'utf-8').split('\n').map((line) => {
        const match = line.match(TRACK_RE);
        if (!match) return line;
        const fieldStr = edit(match, parseFields(match[3]), match[3].split(/\s+/));
        if (fieldStr === null) return line;
        touched = true;
        lines += 1;
        return `- ${match[1]} #${match[2]}[${stampUpdated(fieldStr)}]`;
      });
      return { filePath, next, touched };
    });
    plans.forEach(({ filePath, next, touched }) => { if (touched) fs.writeFileSync(filePath, next.join('\n')); });
    return lines;
  }

  // ① 모드별 규칙. marks는 되돌리기 기록에 들어가는 꼴 그대로다(move: id 목록, merge·delete: `{ id, key }` 목록).
  function rekeyItems(from, mode, to) {
    const marks = [];
    const lines = walkItems((match, fields, parts) => {
      if (fields.jira) return null;
      if (mode === 'move') {
        const key = match[2] === 'idea' ? 'project' : 'group';
        if (!fields[key] || plain(fields[key]) !== from) return null;
        if (fields.id) marks.push(fields.id);
        return parts.filter(part => partKey(part) !== key).concat(`jira:${to}`).join(' ');
      }
      const next = mode === 'delete' ? null : token(to);
      const keys = [];
      const out = parts.flatMap((part) => {
        const key = partKey(part);
        if (!isKeyPart(key) || plain(partValue(part)) !== from) return [part];
        keys.push(key);
        return next === null ? [] : [`${key}:${next}`];
      });
      if (!keys.length) return null;
      // 이름 바꾸기는 칸 글자가 그대로면(띄어쓰기만 고쳐 파일 표기가 같을 때) 그 줄을 고친 것으로 치지 않는다.
      if (mode === 'rename') return out.join(' ') === match[3] ? null : out.join(' ');
      // 되돌리기는 id로 짝을 찾는다 — id가 없는 줄은 되돌릴 수 없으니 합치기·지우기 자체를 하지 않는다.
      if (!fields.id) throw new Error('id가 없는 항목이 있어 되돌릴 수 없어요.');
      keys.forEach(key => marks.push({ id: fields.id, key }));
      return out.join(' ');
    });
    return { lines, marks };
  }

  // ① 되돌리기 — 기록한 id의 줄 하나(첫 줄)만 본다. still이 거짓이면 그 사이 바뀐 것이라 건너뛴다(skipped).
  function unrekeyItems({ from, mode, to, marks }) {
    const fromToken = token(from);
    const wanted = new Map();
    const list = Array.isArray(marks) ? marks : [];
    if (mode === 'move') list.forEach(id => wanted.set(id, null));
    else list.forEach(({ id, key }) => {
      if (typeof id !== 'string' || !isKeyPart(key)) return;
      if (!wanted.has(id)) wanted.set(id, new Set());
      wanted.get(id).add(key);
    });
    const seen = new Set();
    let skipped = 0;
    const restored = walkItems((match, fields, parts) => {
      if (!fields.id || !wanted.has(fields.id) || seen.has(fields.id)) return null;
      seen.add(fields.id);
      if (mode === 'move') {
        if (fields.jira !== to) { skipped += 1; return null; }
        const key = match[2] === 'idea' ? 'project' : 'group';
        return parts.filter(part => partKey(part) !== 'jira').concat(`${key}:${fromToken}`).join(' ');
      }
      const keys = wanted.get(fields.id);
      const has = key => parts.some(part => part.startsWith(`${key}:`));
      const still = !fields.jira && [...keys].every(key => (to === null
        ? !has('group') && !has('project')
        : parts.some(part => part.startsWith(`${key}:`) && plain(part.slice(key.length + 1)) === to)));
      if (!still) { skipped += 1; return null; }
      return to === null
        ? [...parts, ...[...keys].map(key => `${key}:${fromToken}`)].join(' ')
        : parts.map(part => (keys.has(partKey(part) || '') && plain(partValue(part)) === to ? `${partKey(part)}:${fromToken}` : part)).join(' ');
    });
    skipped += [...wanted.keys()].filter(id => !seen.has(id)).length; // 기록에는 있었지만 그 사이 지워진 항목
    return { restored, skipped };
  }

  // ⑤ 회의 제목 → 프로젝트 — `group:from`인 줄을 next로(null이면 줄을 뺀다). 바꾼 줄을 `{ title, before }`로 돌려준다.
  function rekeyLinks(from, next) {
    const links = readMeetingLinks();
    const changed = [];
    for (const [title, value] of Object.entries(links)) {
      if (typeof value !== 'string' || !value.startsWith('group:')) continue;
      if (plain(value.slice('group:'.length)).trim() !== from) continue;
      changed.push({ title, before: value });
      if (next === null) delete links[title]; else links[title] = next;
    }
    if (changed.length) fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(links, null, 2));
    return changed;
  }
  // ⑤ 되돌리기 — `[{ title, now, before }]`: 지금 값이 now(null이면 "줄이 없음")일 때만 before로.
  function restoreLinks(list) {
    const links = readMeetingLinks();
    let restored = 0, skipped = 0;
    list.forEach(({ title, now, before }) => {
      const still = now === null ? !Object.prototype.hasOwnProperty.call(links, title) : links[title] === now;
      if (!still) { skipped += 1; return; }
      links[title] = before;
      restored += 1;
    });
    if (restored) fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(links, null, 2));
    return { restored, skipped };
  }

  // 열쇠 바꾸기 — `group:from`을 `to`로. 자리 표 차례대로 걷고, 자리마다 그 저장소가 돌려준 값을 그대로 모아 준다
  // (응답 숫자·되돌리기 기록은 부르는 쪽이 지금 꼴 그대로 짓는다). label은 move만 — 주간요약 표시 이름(`KEY · 이름`).
  function rekeyProject({ from, mode, to, label }) {
    if (!MODES.includes(mode)) throw new Error(`모르는 열쇠 바꾸기: ${mode}`);
    const items = rekeyItems(from, mode, to);
    const workflow = mode === 'rename' ? workflows.renameGroup(from, to)
      : mode === 'move' ? workflows.moveGroup(from, to)
        : workflows.mergeGroup(from, mode === 'delete' ? null : to);
    const links = rekeyLinks(from, mode === 'delete' ? null : mode === 'move' ? `jira:${to}` : `group:${to}`);
    const report = mode === 'rename' ? reportDrafts.renameGroup(from, to)
      : mode === 'move' ? reportDrafts.moveGroup(from, to, label)
        : mode === 'merge' ? reportDrafts.mergeGroup(from, to)
          : null; // delete — KEPT ⑥
    return { items, workflow, links, report };
  }

  // 되돌리기 — 기록(projectMoves·projectMerges 한 줄)만 보고 반대로. 기록 꼴은 예전 그대로라 옛 기록도 되돌려진다.
  function unrekeyProject(mode, entry) {
    const { from, to } = entry;
    if (mode === 'move') {
      const items = unrekeyItems({ from, mode, to, marks: entry.items });
      const workflow = workflows.undoMoveGroup({ from, to, meetingIds: entry.meetings, link: entry.links ? entry.links[from] : null });
      const links = restoreLinks((Array.isArray(entry.meetingLinks) ? entry.meetingLinks : []).map(title => ({ title, now: `jira:${to}`, before: `group:${from}` })));
      const report = reportDrafts.moveGroupUndo(entry.reportRows, from, to, entry.reportLabel, entry.reportNames);
      return { items, workflow, links, report };
    }
    if (mode !== 'merge') throw new Error(`모르는 되돌리기: ${mode}`);
    const items = unrekeyItems({ from, mode: to === null ? 'delete' : 'merge', to, marks: entry.items });
    const workflow = workflows.undoMergeGroup({ from, to, meetings: entry.meetings, link: entry.link, archive: entry.archive });
    const links = restoreLinks((Array.isArray(entry.meetingLinks) ? entry.meetingLinks : [])
      .map(({ title, before }) => ({ title, now: to === null ? null : `group:${to}`, before })));
    const report = to === null ? { restored: 0, skipped: 0 } : reportDrafts.mergeGroupUndo(entry.reportRows, from, to, entry.reportNames);
    return { items, workflow, links, report };
  }

  return { rekeyProject, unrekeyProject };
};
module.exports.SITES = SITES;
module.exports.KEPT = KEPT;
module.exports.MODES = MODES;
