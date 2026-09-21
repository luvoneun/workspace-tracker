const nativeFs = require('node:fs');
const { atomicWrite } = require('./safe-storage');
const fs = { ...nativeFs, writeFileSync: atomicWrite };
const { randomUUID } = require('node:crypto');

module.exports = ({ files, pattern, parse, validateDate, today }) => {
  const history = new Map();
  const pick = (fields, keys) => Object.fromEntries(keys.map(key => [key, fields[key] ?? null]));
  function editFields(raw, values) {
    const tokens = raw.split(/\s+/).filter(token => !Object.hasOwn(values, token.slice(0, token.indexOf(':'))));
    for (const [key, value] of Object.entries(values)) if (value !== null) tokens.push(`${key}:${value}`);
    return tokens.join(' ');
  }
  return function batch({ ids, change, undoToken }) {
    const previous = undoToken ? history.get(undoToken) : null;
    if (undoToken && !previous) throw new Error('실행 취소 기록이 만료되었습니다.');
    if (previous) ids = previous.map(item => item.id);
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('선택한 업무를 확인해 주세요.');
    let keys, values;
    if (previous) keys = Object.keys(previous[0].before);
    else {
      if (!change || Object.keys(change).length !== 1) throw new Error('한 번에 하나의 변경을 선택해 주세요.');
      if (Object.hasOwn(change, 'scheduled')) {
        validateDate(change.scheduled);
        keys = ['scheduled', 'inbox']; values = { scheduled: change.scheduled || 'none', inbox: null };
      } else if (Object.hasOwn(change, 'project')) {
        const project = change.project;
        if (project !== null && (typeof project !== 'string' || !/^(jira|group):\S/.test(project) || /[\r\n\[\]]/.test(project) || project.length > 250)) throw new Error('그룹을 확인해 주세요.');
        keys = ['jira', 'group']; values = { jira: null, group: null };
        if (project) { const split = project.indexOf(':'); values[project.slice(0, split)] = project.slice(split + 1).trim().replace(/\s+/g, '_'); }
      } else if (Object.hasOwn(change, 'status')) {
        // 일괄로 여는 상태 변경은 "완료로 표시" 하나뿐이다. 완료 취소는 줄마다 체크로 되돌린다.
        // 완료일은 서버가 오늘로 적는다(추측한 날짜를 기록으로 남기지 않는다).
        if (change.status !== 'done') throw new Error('지원하지 않는 일괄 변경입니다.');
        keys = ['status', 'completed']; values = { status: 'done', completed: today() };
      } else throw new Error('지원하지 않는 일괄 변경입니다.');
    }
    const selected = new Set(ids), found = new Set(), changes = [], updates = [];
    for (const file of files()) {
      const before = fs.readFileSync(file, 'utf8');
      const after = before.split('\n').map(line => {
        const match = line.match(pattern);
        if (!match) return line;
        const fields = parse(match[3]);
        if (!selected.has(fields.id)) return line;
        if (found.has(fields.id)) throw new Error('중복된 업무 ID가 있습니다.');
        if (match[2] !== 'task' || (!previous && fields.status === 'done')) throw new Error('미완료 업무만 선택할 수 있습니다.');
        const current = pick(fields, keys);
        const record = previous?.find(item => item.id === fields.id);
        if (record && keys.some(key => current[key] !== record.after[key])) throw new Error('이후 변경된 업무가 있어 실행 취소할 수 없습니다.');
        const next = record ? record.before : values;
        changes.push({ id: fields.id, before: current, after: { ...next } });
        found.add(fields.id);
        return `- ${match[1]} #${match[2]}[${editFields(match[3], next)}]`;
      }).join('\n');
      if (before !== after) updates.push({ file, before, after });
    }
    if (found.size !== ids.length) throw new Error('일부 업무가 삭제되었거나 찾을 수 없습니다. 새로고침해 주세요.');
    const written = [];
    try {
      for (const update of updates) {
        // Include the current file in rollback even if a write fails partway through.
        written.push(update);
        fs.writeFileSync(update.file, update.after);
      }
    } catch (error) {
      for (const update of written.reverse()) fs.writeFileSync(update.file, update.before);
      throw error;
    }
    if (undoToken) history.delete(undoToken);
    const token = randomUUID(); history.set(token, changes);
    if (history.size > 50) history.delete(history.keys().next().value);
    return { ok: true, count: ids.length, undoToken: token };
  };
};
