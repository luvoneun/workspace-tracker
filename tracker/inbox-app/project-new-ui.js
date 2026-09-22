// 새 프로젝트 화면 한 벌 — 프로젝트 탭 왼쪽 목록 머리의 `+`가 여는 오른쪽 면이다.
// 이름과 직군을 고르면 지라에 **에픽 하나 + 직군별 하위 티켓**을 만든다(이미 있는 에픽에 붙일 수도).
// 담당자·설명·배포 버전·기한은 넣지 않는다 — 사람이 지라에서 정한다(1차 범위).
//
// 지키는 것:
// - 만들 목록 전체를 미리 보여 주고 확인 줄을 한 번 더 거친 뒤에만 보낸다. **앱의 ⌘Z 대상이 아니다**
//   (`pushUndo`를 쓰지 않는다) — 지라에 여러 이슈를 만드는 일은 되돌릴 수 없다.
// - 지라에 쓰는 길은 `/api/jira/create` 하나뿐이고, 앱 항목은 기존 업무 만들기 API로만 만든다.
// - 지라·사람이 준 글자는 전부 textContent로만 넣는다(innerHTML을 쓰지 않는다).
// - 화면에 보이는 이름은 요약만이다(BKEY) — 지라 키는 미리 보기의 `IO-48394에 붙임`·확인 줄·툴팁에만.
// index.html에서 projects-ui.js 뒤, app.js보다 먼저 읽힌다.

// 설정에 저장된 직군 세트가 없을 때 쓰는 기본값. 저장하면 `.workflow.json`의 `jiraRoles`가 된다
// (빈 배열을 저장하면 빈 목록 그대로다 — 그때 이 기본값이 되살아나지 않는다).
const PROJECT_NEW_ROLES = [
  { label: 'Web', prefix: '[Web]' },
  { label: 'iOS', prefix: '[iOS]' },
  { label: 'Android', prefix: '[Android]' },
  { label: 'Backend', prefix: '[Backend]' },
  { label: 'Design', prefix: '[Design]' },
  { label: 'QA', prefix: '[QA]' },
];
// 연결 입력칸(jira-ui.js)을 빌려 쓸 때 쓰는 자리 이름이다 — 실제 프로젝트 키가 아니다.
const PROJECT_NEW_LINK = 'new:project';
const PROJECT_NEW_PROJECT_STORE = 'projectNewProject';
const PROJECT_NEW_TYPE_STORE = 'projectNewType';
const PROJECT_NEW_MAX = 12;

// 화면이 열려 있을 때만 값이 있다. 탭을 옮기거나 닫으면 통째로 버린다(적던 것도 함께 사라진다).
let projectNew = null;
// 미리 보기와 주 버튼만 따로 다시 그리는 자리 — 이름을 적는 동안 초점이 튀지 않게 한다.
let projectNewPreviewNode = null;
let projectNewGoNode = null;

const projectNewStore = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const projectNewRead = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

// 설정에 저장된 직군 세트(없으면 기본값). `.workflow.json`에 칸이 없으면 서버가 null을 준다.
function projectNewRoles() {
  const saved = (typeof workflowData === 'object' && workflowData && workflowData.jiraRoles) || null;
  return Array.isArray(saved) ? saved : PROJECT_NEW_ROLES;
}

// 새 에픽을 만들 지라 프로젝트의 첫 제안 — 내 담당 목록에 가장 많이 나오는 프로젝트다.
// 하나도 없으면 빈 값이고, 그때는 사람이 직접 적는다.
function projectNewGuessProject() {
  const remembered = projectNewRead(PROJECT_NEW_PROJECT_STORE);
  if (/^[A-Z][A-Z0-9]*$/.test(remembered)) return remembered;
  const seen = new Map();
  (typeof jiraIssuesCache !== 'undefined' && Array.isArray(jiraIssuesCache) ? jiraIssuesCache : [])
    .forEach((issue) => {
      const key = String((issue && issue.key) || '').split('-')[0];
      if (/^[A-Z][A-Z0-9]*$/.test(key)) seen.set(key, (seen.get(key) || 0) + 1);
    });
  return [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function projectNewBlank() {
  return {
    name: '', mode: 'epic', project: projectNewGuessProject(), epic: null,
    roles: [], extra: [], titles: {}, first: '',
    types: null, typeId: null, typeEpic: null, typeProject: '', typeBusy: false, typeError: '',
    roleEdit: null, roleError: '', roleBusy: false,
    confirm: false, busy: false, error: '', result: null, onEsc: null,
  };
}

// ---------- 열고 닫기 ----------
function projectNewStart() {
  projectNewDrop();
  projectNew = projectNewBlank();
  jiraLinkBorrow({ openLabel: '에픽 고르기', label: '이 에픽에 붙이기', onPick: issue => projectNewPickEpic(issue) });
  // Esc는 이 화면만 닫는다(탭·상세는 건드리지 않는다).
  projectNew.onEsc = escPush(() => projectNewClose());
  renderProjects();
  document.getElementById('projectBody')?.querySelector?.('.d-pnewname')?.focus?.();
  // 첫 제안 프로젝트의 만들 수 있는 종류를 미리 읽어 둔다(조회라 아무것도 저장하지 않는다).
  projectNewMetaLoad(projectNewProjectKey(projectNew));
}
function projectNewDrop() {
  if (projectNew && projectNew.onEsc) escDrop(projectNew.onEsc);
  projectNew = null;
  projectNewPreviewNode = null;
  projectNewGoNode = null;
  jiraLinkBorrow(null);
  jiraLinkReset(false);
}
function projectNewClose() {
  projectNewDrop();
  renderProjects();
  document.getElementById('projectList')?.querySelector?.('.d-pnewgo')?.focus?.();
}

// ---------- 만들 목록 ----------
// 고른 직군(설정 세트 + 그 자리에서 적은 것)마다 한 줄이다. 제목 규칙은 `접두어 + 공백 + 이름`이고,
// 미리 보기 줄에서 그 자리에서 고치면 그 글자가 그대로 나간다.
function projectNewPicked(state) {
  const set = projectNewRoles().filter(role => state.roles.includes(role.label));
  return [...set, ...state.extra];
}
function projectNewTitle(state, role) {
  if (Object.prototype.hasOwnProperty.call(state.titles, role.label)) return state.titles[role.label];
  const name = state.name.trim();
  return name ? `${role.prefix} ${name}` : '';
}
// 이미 있는 에픽에 붙일 때, 그 에픽의 하위에 같은 접두어가 이미 있으면 그 키를 알려 준다.
function projectNewExisting(state, role) {
  const items = (state.epic && state.epic.children && state.epic.children.items) || [];
  const found = items.find(item => String((item && item.summary) || '').trim().startsWith(role.prefix));
  return found ? found.key : '';
}
function projectNewRows(state) {
  return projectNewPicked(state).map(role => ({
    label: role.label, prefix: role.prefix,
    summary: projectNewTitle(state, role),
    existing: projectNewExisting(state, role),
  }));
}
// 지라 프로젝트 키: 붙이기는 고른 에픽에서, 새로 만들기는 사람이 적은 값에서 온다.
function projectNewProjectKey(state) {
  if (state.mode === 'attach') return state.epic ? String(state.epic.key).split('-')[0] : '';
  return String(state.project || '').trim().toUpperCase();
}
// 만들 이슈 수 — 새 에픽이면 에픽 하나를 함께 센다.
function projectNewCount(state) {
  return projectNewRows(state).length + (state.mode === 'epic' ? 1 : 0);
}
// 지금 보낼 수 있는지. 못 보내면 그 이유를 주 버튼 아래 조용한 한 줄로 적는다.
function projectNewBlocker(state) {
  if (state.mode === 'none') {
    if (!state.name.trim()) return '프로젝트 이름을 적어 주세요.';
    if (!state.first.trim()) return '첫 할 일이 있어야 프로젝트가 생겨요.';
    return '';
  }
  if (state.mode === 'attach' && !state.epic) return '붙일 에픽을 골라 주세요.';
  if (state.mode === 'epic' && !state.name.trim()) return '프로젝트 이름을 적어 주세요.';
  if (state.mode === 'epic' && !/^[A-Z][A-Z0-9]*$/.test(projectNewProjectKey(state))) return '지라 프로젝트 키를 적어 주세요 — 예: IO';
  const rows = projectNewRows(state);
  if (state.mode === 'attach' && !rows.length) return '만들 하위 티켓을 골라 주세요.';
  if (rows.length > PROJECT_NEW_MAX) return `한 번에 ${PROJECT_NEW_MAX}개까지 만들 수 있어요.`;
  if (rows.some(row => !row.summary.trim())) return '제목이 빈 줄이 있어요.';
  if (rows.some(row => row.summary.length > 255)) return '제목은 255자까지예요.';
  if (rows.length && !state.typeId) return '하위 티켓 종류를 고를 수 없어요.';
  return '';
}

// ---------- 만들 수 있는 이슈 종류 ----------
async function projectNewMetaLoad(project) {
  if (!projectNew || !/^[A-Z][A-Z0-9]*$/.test(project)) return;
  if (projectNew.typeProject === project && (projectNew.types || projectNew.typeBusy)) return;
  projectNew.typeProject = project;
  projectNew.types = null;
  projectNew.typeEpic = null;
  projectNew.typeBusy = true;
  projectNew.typeError = '';
  projectNewPaint();
  let data = null;
  try {
    const response = await fetch(`/api/jira/create-meta?project=${encodeURIComponent(project)}`);
    data = await response.json();
  } catch { data = null; }
  // 그 사이 다른 프로젝트를 적었거나 화면을 닫았으면 이 응답은 버린다.
  if (!projectNew || projectNew.typeProject !== project) return;
  projectNew.typeBusy = false;
  if (!data || data.ok === false) projectNew.typeError = (data && data.error) || '지라에 연결하지 못했어요.';
  else if (data.connected === false) projectNew.typeError = '지라 연결이 필요해요.';
  else {
    projectNew.types = Array.isArray(data.types) ? data.types : [];
    projectNew.typeEpic = data.epic || null;
    const remembered = projectNewRead(`${PROJECT_NEW_TYPE_STORE}:${project}`);
    const found = projectNew.types.find(type => type.id === remembered)
      || projectNew.types.find(type => type.id === data.defaultTypeId)
      || projectNew.types[0] || null;
    projectNew.typeId = found ? found.id : null;
  }
  projectNewPaint();
}

// ---------- 에픽 고르기(연결 입력칸을 빌려 쓴다) ----------
function projectNewPickEpic(issue) {
  if (!projectNew) return;
  projectNew.epic = issue;
  // 이미 그 접두어의 하위가 있는 직군은 체크를 꺼 둔다 — 켜면 한 번 더 만든다.
  projectNew.roles = projectNew.roles.filter(label => {
    const role = projectNewRoles().find(entry => entry.label === label);
    return !role || !projectNewExisting(projectNew, role);
  });
  jiraLinkReset(false);
  projectNewPaint();
  projectNewMetaLoad(projectNewProjectKey(projectNew));
}

// ---------- 그리기 ----------
function projectNewPaint() {
  const body = document.getElementById('projectBody');
  if (body && projectNew) projectNewRender(body);
}

function projectNewField(label, control, hint) {
  const row = document.createElement('div');
  row.className = 'row';
  const name = document.createElement('span');
  name.className = 'lb';
  name.textContent = label;
  const slot = document.createElement('div');
  slot.className = 'ct';
  slot.appendChild(control);
  if (hint) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = hint;
    slot.appendChild(note);
  }
  row.append(name, slot);
  return row;
}

function projectNewInput(value, placeholder, label, onInput, maxLength = 200) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-din in';
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => onInput(input.value, input));
  return input;
}

// 세그먼트 세 칸 — 값을 고르는 것이라 `aria-checked`다(부품·모양은 앱의 것 그대로).
function projectNewModes(state) {
  const seg = document.createElement('div');
  seg.className = 'd-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', '지라');
  [['epic', '새 에픽 만들기'], ['attach', '있는 에픽에 붙이기'], ['none', '지라 없이']].forEach(([value, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(state.mode === value));
    button.textContent = label;
    button.addEventListener('click', () => {
      if (state.mode === value) return;
      state.mode = value;
      state.confirm = false;
      jiraLinkReset(false);
      projectNewPaint();
      if (value !== 'none') projectNewMetaLoad(projectNewProjectKey(state));
      if (value === 'attach' && !state.epic) jiraLinkOpen(PROJECT_NEW_LINK);
    });
    seg.appendChild(button);
  });
  return seg;
}

// 고른 에픽 한 줄(요약이 먼저, 상태는 뒤, 키는 조용한 글자로 — 연결 미리 보기와 같은 규칙).
function projectNewEpicRow(state) {
  const box = document.createElement('div');
  box.className = 'd-pnewepic';
  const name = document.createElement('span');
  name.className = 'sm';
  name.textContent = state.epic.summary || state.epic.key;
  const rest = document.createElement('span');
  rest.textContent = (state.epic.status && state.epic.status.name) || '';
  const key = document.createElement('span');
  key.className = 'ky';
  key.textContent = state.epic.key;
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'd-link';
  again.textContent = '다시 고르기';
  again.addEventListener('click', () => {
    state.epic = null;
    projectNewPaint();
    jiraLinkOpen(PROJECT_NEW_LINK);
  });
  box.append(name, rest, key, again);
  return box;
}

// 직군 체크 목록 + 그 자리에서 적는 한 줄.
function projectNewRoleBox(state) {
  const box = document.createElement('div');
  box.className = 'd-pnewroles';
  projectNewRoles().forEach((role) => {
    const existing = projectNewExisting(state, role);
    const line = document.createElement('label');
    line.className = 'rl' + (existing ? ' is-had' : '');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'd-wcb';
    check.checked = state.roles.includes(role.label);
    check.setAttribute('aria-label', `${role.label} 하위 티켓 만들기`);
    check.addEventListener('change', () => {
      state.roles = check.checked ? [...state.roles, role.label] : state.roles.filter(label => label !== role.label);
      projectNewPreviewPaint();
    });
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = role.label;
    line.append(check, name);
    if (existing) {
      const had = document.createElement('span');
      had.className = 'hd';
      // 이 자리의 지라 키는 "이미 있는 그 티켓"을 가리키는 값이라 그대로 적는다(BKEY의 허용 자리).
      had.textContent = `이미 있어요 ${existing}`;
      line.appendChild(had);
    }
    box.appendChild(line);
  });
  state.extra.forEach((role) => {
    const line = document.createElement('span');
    line.className = 'rl is-own';
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = role.prefix;
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'x';
    drop.textContent = '✕';
    drop.setAttribute('aria-label', `${role.prefix} 빼기`);
    drop.addEventListener('click', () => {
      state.extra = state.extra.filter(entry => entry.label !== role.label);
      delete state.titles[role.label];
      projectNewPaint();
    });
    line.append(name, drop);
    box.appendChild(line);
  });
  return box;
}

// 직접 입력 줄 — 접두어를 적고 Enter면 체크된 항목으로 더한다. 설정에는 저장하지 않는다.
function projectNewOwnRow(state) {
  const row = document.createElement('div');
  row.className = 'd-pnewown';
  const input = projectNewInput('', '직접 입력 — 예: [Data]', '직군 접두어 직접 입력', () => {}, 20);
  const add = () => {
    const prefix = input.value.trim();
    if (!prefix) return;
    if (state.extra.some(entry => entry.prefix === prefix) || projectNewRoles().some(role => role.prefix === prefix)) {
      input.value = '';
      return;
    }
    state.extra = [...state.extra, { label: `직접:${prefix}`, prefix }];
    input.value = '';
    projectNewPaint();
  };
  input.addEventListener('keydown', (event) => {
    // 한글을 조합하는 중의 Enter는 글자를 확정하는 Enter다 — 더하지 않는다.
    if (event.key !== 'Enter' || event.isComposing) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    add();
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-btn sm';
  button.textContent = '추가';
  button.addEventListener('click', add);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'd-link';
  edit.textContent = '직군 목록 고치기';
  edit.addEventListener('click', () => {
    state.roleEdit = projectNewRoles().map(role => ({ ...role }));
    state.roleError = '';
    projectNewPaint();
  });
  row.append(input, button, edit);
  return row;
}

// 직군 세트를 고치는 줄 편집 — 저장은 앱의 기존 저장 길(`/api/workflow/jira-roles`)로만 나간다.
function projectNewRoleEdit(state) {
  const box = document.createElement('div');
  box.className = 'd-pnewedit';
  state.roleEdit.forEach((role, at) => {
    const line = document.createElement('div');
    line.className = 'ln';
    const label = projectNewInput(role.label, '이름', `${at + 1}번째 직군 이름`, (value) => { state.roleEdit[at].label = value; }, 30);
    const prefix = projectNewInput(role.prefix, '접두어', `${at + 1}번째 직군 접두어`, (value) => { state.roleEdit[at].prefix = value; }, 20);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'd-btn sm';
    drop.textContent = '삭제';
    drop.addEventListener('click', () => {
      state.roleEdit = state.roleEdit.filter((entry, index) => index !== at);
      projectNewPaint();
    });
    line.append(label, prefix, drop);
    box.appendChild(line);
  });
  const acts = document.createElement('div');
  acts.className = 'acts';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'd-btn sm';
  add.textContent = '직군 추가';
  add.disabled = state.roleEdit.length >= 20;
  add.addEventListener('click', () => {
    state.roleEdit = [...state.roleEdit, { label: '', prefix: '' }];
    projectNewPaint();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-btn sm';
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => { state.roleEdit = null; state.roleError = ''; projectNewPaint(); });
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'd-btn sm acc';
  save.textContent = state.roleBusy ? '저장하는 중…' : '저장';
  save.disabled = state.roleBusy;
  save.addEventListener('click', () => projectNewRoleSave(state));
  acts.append(add, cancel, save);
  box.appendChild(acts);
  if (state.roleError) {
    const error = document.createElement('div');
    error.className = 'er';
    error.setAttribute('role', 'status');
    error.textContent = state.roleError;
    box.appendChild(error);
  }
  return box;
}

async function projectNewRoleSave(state) {
  if (state.roleBusy) return;
  const roles = state.roleEdit.map(role => ({ label: String(role.label || '').trim(), prefix: String(role.prefix || '').trim() }));
  if (roles.some(role => !role.label || !role.prefix)) { state.roleError = '이름과 접두어를 모두 적어 주세요.'; projectNewPaint(); return; }
  state.roleBusy = true;
  state.roleError = '';
  projectNewPaint();
  try {
    await request('/api/workflow/jira-roles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles }),
    });
  } catch {
    if (!projectNew) return;
    state.roleBusy = false;
    projectNewPaint();
    return;
  }
  await load();
  if (!projectNew) return;
  state.roleBusy = false;
  state.roleEdit = null;
  // 없어진 직군의 체크는 함께 지운다(목록에 없는 것이 미리 보기에 남지 않게).
  const known = projectNewRoles().map(role => role.label);
  state.roles = state.roles.filter(label => known.includes(label));
  projectNewPaint();
  showNotice('직군 목록을 저장했어요');
}

// 하위 티켓 종류 — 허용 타입이 하나면 자동이라 조용한 글자로만 적고, 둘 이상일 때만 고르개가 선다.
function projectNewTypeRow(state) {
  const row = document.createElement('div');
  row.className = 'd-pnewtype';
  if (state.typeBusy) {
    const busy = document.createElement('span');
    busy.className = 'note';
    busy.textContent = '지라에서 만들 수 있는 종류를 읽는 중…';
    row.appendChild(busy);
    return row;
  }
  if (state.typeError) {
    const error = document.createElement('span');
    error.className = 'er';
    error.setAttribute('role', 'status');
    error.textContent = state.typeError;
    row.appendChild(error);
    return row;
  }
  const types = state.types || [];
  if (!types.length) return row;
  const current = types.find(type => type.id === state.typeId) || types[0];
  if (types.length === 1) {
    const only = document.createElement('span');
    only.className = 'note';
    only.textContent = `하위 티켓 종류 · ${current.name}`;
    row.appendChild(only);
    return row;
  }
  const label = document.createElement('span');
  label.className = 'note';
  label.textContent = '하위 티켓 종류';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-dpick';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', '하위 티켓 종류 — 눌러서 바꾸기');
  const value = document.createElement('span');
  value.className = 'v';
  value.textContent = current.name;
  const caret = document.createElement('span');
  caret.className = 'cv';
  // 고정 마크업(꺾쇠 아이콘)만 붙는 자리다 — 지라가 준 글자는 위 textContent로만 들어간다.
  caret.insertAdjacentHTML('beforeend', uiIcon('chevron'));
  button.append(value, caret);
  button.addEventListener('click', (event) => {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    uiMenu(button, [types.map(type => ({
      label: type.name,
      onClick: () => {
        state.typeId = type.id;
        projectNewStore(`${PROJECT_NEW_TYPE_STORE}:${state.typeProject}`, type.id);
        projectNewPaint();
      },
    }))]);
  });
  row.append(label, button);
  return row;
}

// ---------- 미리 보기 ----------
function projectNewPreview(state) {
  const box = document.createElement('div');
  box.className = 'd-pnewpv';
  const name = state.name.trim();
  const rows = projectNewRows(state);
  if (state.mode === 'none') {
    const line = document.createElement('div');
    line.className = 'note';
    line.textContent = name ? `직접 만든 프로젝트 · ${name}` : '이름을 적으면 여기에 미리 보여 드려요.';
    box.appendChild(line);
    return box;
  }
  const head = document.createElement('div');
  head.className = 'ep';
  const kind = document.createElement('span');
  kind.className = 'kd';
  kind.textContent = '에픽';
  const title = document.createElement('span');
  title.className = 'sm';
  title.textContent = state.mode === 'attach' ? ((state.epic && state.epic.summary) || '') : name;
  const where = document.createElement('span');
  where.className = 'wh';
  // 명세가 정한 자리다 — 새로 만드는지, 어느 에픽에 붙이는지를 한마디로 알린다.
  where.textContent = state.mode === 'attach'
    ? (state.epic ? `${state.epic.key}에 붙임` : '에픽을 고르지 않았어요')
    : '새로 만듦';
  head.append(kind, title, where);
  box.appendChild(head);
  if (!rows.length) {
    const only = document.createElement('div');
    only.className = 'note';
    only.textContent = state.mode === 'attach' ? '직군을 고르면 만들 하위 티켓이 여기에 서요.' : '직군을 고르지 않으면 에픽만 만들어요.';
    box.appendChild(only);
    return box;
  }
  rows.forEach((row, at) => {
    const line = document.createElement('div');
    line.className = 'kid';
    const branch = document.createElement('span');
    branch.className = 'br';
    branch.textContent = at === rows.length - 1 ? '└' : '├';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'd-din ti';
    input.value = row.summary;
    input.maxLength = 255;
    input.setAttribute('aria-label', `${row.prefix} 하위 티켓 제목`);
    input.addEventListener('input', () => {
      state.titles[row.label] = input.value;
      projectNewGoPaint();
    });
    const type = document.createElement('span');
    type.className = 'ty';
    const picked = (state.types || []).find(entry => entry.id === state.typeId);
    type.textContent = picked ? picked.name : '';
    const who = document.createElement('span');
    who.className = 'wh';
    who.textContent = '담당 없음';
    line.append(branch, input, type, who);
    if (row.existing) {
      const had = document.createElement('span');
      had.className = 'hd';
      had.textContent = `이미 있어요 ${row.existing}`;
      line.appendChild(had);
    }
    box.appendChild(line);
  });
  return box;
}

function projectNewPreviewPaint() {
  if (!projectNew || !projectNewPreviewNode || !projectNewPreviewNode.isConnected) { projectNewPaint(); return; }
  projectNewPreviewNode.replaceChildren(projectNewPreview(projectNew));
  projectNewGoPaint();
}
// 주 버튼의 글자(개수)와 눌릴 수 있는지만 고쳐 준다 — 이름을 적는 동안 초점이 튀지 않게.
function projectNewGoPaint() {
  if (!projectNew || !projectNewGoNode || !projectNewGoNode.isConnected) return;
  projectNewGoNode.replaceChildren(projectNewActions(projectNew));
}

// ---------- 확인 · 보내기 ----------
function projectNewActions(state) {
  const box = document.createElement('div');
  box.className = 'd-pnewacts';
  const blocker = projectNewBlocker(state);
  if (state.confirm) {
    const confirm = document.createElement('div');
    confirm.className = 'd-jconfirm';
    confirm.setAttribute('tabindex', '-1');
    confirm.setAttribute('role', 'group');
    const ask = document.createElement('div');
    ask.className = 'ask';
    ask.textContent = `지라에 이슈 ${projectNewCount(state)}개를 만들까요? 되돌릴 수 없어요.`;
    const what = document.createElement('div');
    what.className = 'what';
    const sm = document.createElement('span');
    sm.className = 'sm';
    sm.textContent = state.mode === 'attach' ? ((state.epic && state.epic.summary) || '') : state.name.trim();
    what.appendChild(sm);
    if (state.mode === 'attach' && state.epic) {
      const key = document.createElement('span');
      key.className = 'ky';
      key.textContent = state.epic.key;
      what.appendChild(key);
    }
    const acts = document.createElement('div');
    acts.className = 'acts';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'd-btn sm';
    cancel.textContent = '취소';
    cancel.disabled = state.busy;
    cancel.addEventListener('click', () => { state.confirm = false; projectNewPaint(); });
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'd-btn sm acc';
    go.textContent = state.busy ? '만드는 중…' : '만들기';
    go.disabled = state.busy;
    go.addEventListener('click', () => projectNewSend(state));
    acts.append(cancel, go);
    confirm.append(ask, what, acts);
    box.appendChild(confirm);
    return box;
  }
  const line = document.createElement('div');
  line.className = 'go';
  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'd-btn pri';
  make.textContent = state.mode === 'none' ? '프로젝트 만들기' : `지라에 ${projectNewCount(state)}개 만들기`;
  make.disabled = !!blocker || state.busy;
  make.addEventListener('click', () => {
    // 지라 없이는 앱 항목 하나를 만드는 일이라 확인 줄을 세우지 않는다(⌘Z·삭제로 되돌린다).
    if (state.mode === 'none') return projectNewPlain(state);
    state.confirm = true;
    projectNewPaint();
    document.getElementById('projectBody')?.querySelector?.('.d-jconfirm')?.focus?.();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-btn';
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => projectNewClose());
  line.append(make, cancel);
  box.appendChild(line);
  if (blocker) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = blocker;
    box.appendChild(note);
  }
  if (state.error) {
    const error = document.createElement('div');
    error.className = 'er';
    error.setAttribute('role', 'status');
    error.textContent = state.error;
    box.appendChild(error);
  }
  return box;
}

// 지라 없이 — 새 API를 쓰지 않는다. 기존 업무 만들기로 그 그룹의 첫 할 일 하나를 만들면
// 그 순간 프로젝트가 생긴다(항목이 하나도 없으면 프로젝트가 만들어지지 않는 지금 구조 그대로다).
async function projectNewPlain(state) {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  projectNewPaint();
  const name = state.name.trim();
  try {
    await request('/api/later-task/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: state.first.trim(), group: name }),
    });
  } catch {
    if (!projectNew) return;
    state.busy = false;
    projectNewPaint();
    return;
  }
  projectNewDrop();
  openProjectTab(`group:${name}`);
  await load();
  showNotice(`프로젝트를 만들었어요 · ${name}`);
}

// 지라에 보내는 단 하나의 길. 확인 줄의 `만들기`와 결과 화면의 `실패한 것 다시 시도`만 이리로 온다.
async function projectNewPost(plan) {
  const response = await fetch('/api/jira/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!data || data.ok !== true) throw new Error((data && data.error) || '지라에 만들지 못했어요.');
  return data;
}

async function projectNewSend(state) {
  if (state.busy) return;
  const rows = projectNewRows(state);
  const plan = {
    projectKey: projectNewProjectKey(state),
    epic: state.mode === 'attach' ? { key: state.epic.key } : { summary: state.name.trim() },
    children: rows.map(row => ({ summary: row.summary.trim(), issueTypeId: state.typeId })),
  };
  state.busy = true;
  state.error = '';
  projectNewPaint();
  let data = null;
  try {
    data = await projectNewPost(plan);
  } catch (error) {
    if (!projectNew) return;
    state.busy = false;
    state.confirm = false;
    state.error = error.message;
    projectNewPaint();
    return;
  }
  if (!projectNew) return;
  if (state.mode === 'epic') projectNewStore(PROJECT_NEW_PROJECT_STORE, plan.projectKey);
  state.busy = false;
  state.confirm = false;
  state.result = data;
  projectNewPaint();
  showNotice(`지라에 ${data.made}개를 만들었어요`, false, null, { label: '지라에서 열기', onClick: () => jiraOpen(data.epic.url) });
}

// ---------- 만든 뒤 ----------
// 성공도 부분 실패도 같은 자리에 선다. 앱 프로젝트(`jira:KEY`)는 그 에픽에 걸린 항목이 하나
// 있어야 목록에 뜨므로, 첫 할 일을 적는 줄을 여기에 둔다(적으면 그 프로젝트가 열린다).
function projectNewResult(state) {
  const box = document.createElement('div');
  box.className = 'd-pnewres';
  const result = state.result;
  const head = document.createElement('div');
  head.className = 'hd';
  head.textContent = result.failed
    ? `만들어진 것 ${result.made} · 실패 ${result.failed}`
    : `지라에 ${result.made}개를 만들었어요`;
  box.appendChild(head);

  const epic = document.createElement('div');
  epic.className = 'kid';
  const kind = document.createElement('span');
  kind.className = 'kd';
  kind.textContent = '에픽';
  const title = document.createElement('span');
  title.className = 'sm';
  title.textContent = result.epic.summary || result.epic.key;
  const key = document.createElement('span');
  key.className = 'ky';
  key.textContent = result.epic.key;
  epic.append(kind, title, key);
  box.appendChild(epic);

  result.children.forEach((child) => {
    const line = document.createElement('div');
    line.className = 'kid' + (child.error ? ' is-bad' : '');
    const mark = document.createElement('span');
    mark.className = 'kd';
    mark.textContent = child.error ? '실패' : '만듦';
    const name = document.createElement('span');
    name.className = 'sm';
    name.textContent = child.summary;
    const note = document.createElement('span');
    note.className = child.error ? 'er' : 'ky';
    note.textContent = child.error || child.key;
    line.append(mark, name, note);
    box.appendChild(line);
  });

  const acts = document.createElement('div');
  acts.className = 'acts';
  if (result.failed) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'd-btn sm acc';
    again.textContent = state.busy ? '다시 만드는 중…' : '실패한 것 다시 시도';
    again.disabled = state.busy;
    again.addEventListener('click', () => projectNewRetry(state));
    acts.appendChild(again);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'd-btn sm';
  open.textContent = '지라에서 열기';
  open.addEventListener('click', () => jiraOpen(result.epic.url));
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'd-btn sm';
  done.textContent = '닫기';
  done.addEventListener('click', () => projectNewClose());
  acts.append(open, done);
  box.appendChild(acts);

  // 첫 할 일 한 줄 — 이것이 그 에픽으로 걸리는 순간 앱에도 프로젝트가 생긴다.
  const first = document.createElement('div');
  first.className = 'first';
  const label = document.createElement('div');
  label.className = 'note';
  label.textContent = '첫 할 일을 적으면 앱에도 이 프로젝트가 생겨요.';
  const row = document.createElement('div');
  row.className = 'ln';
  const input = projectNewInput(state.first, '첫 할 일 — 예: 기획 초안 정리하기', '첫 할 일', (value) => { state.first = value; }, 200);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'd-btn sm acc';
  add.textContent = '만들고 프로젝트 열기';
  add.addEventListener('click', () => projectNewFirstTask(state, input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    projectNewFirstTask(state, input.value);
  });
  row.append(input, add);
  first.append(label, row);
  box.appendChild(first);
  if (state.error) {
    const error = document.createElement('div');
    error.className = 'er';
    error.setAttribute('role', 'status');
    error.textContent = state.error;
    box.appendChild(error);
  }
  return box;
}

// 실패한 줄만 다시 보낸다 — 에픽은 이미 있으므로 `key`로 붙인다(두 번 만들지 않는다).
async function projectNewRetry(state) {
  if (state.busy) return;
  const failed = state.result.children.filter(child => child.error);
  if (!failed.length) return;
  state.busy = true;
  state.error = '';
  projectNewPaint();
  let data = null;
  try {
    data = await projectNewPost({
      projectKey: String(state.result.epic.key).split('-')[0],
      epic: { key: state.result.epic.key },
      children: failed.map(child => ({ summary: child.summary, issueTypeId: state.typeId })),
    });
  } catch (error) {
    if (!projectNew) return;
    state.busy = false;
    state.error = error.message;
    projectNewPaint();
    return;
  }
  if (!projectNew) return;
  state.busy = false;
  // 성공한 줄은 그대로 두고 실패했던 줄만 이번 결과로 갈아 끼운다.
  const next = new Map(data.children.map(child => [child.summary, child]));
  state.result = {
    ...state.result,
    children: state.result.children.map(child => (child.error && next.has(child.summary) ? next.get(child.summary) : child)),
  };
  state.result.made = state.result.children.filter(child => child.key).length + (state.result.epic.created ? 1 : 0);
  state.result.failed = state.result.children.filter(child => child.error).length;
  projectNewPaint();
  showNotice(state.result.failed ? `아직 ${state.result.failed}개가 남았어요` : '남은 것도 다 만들었어요');
}

async function projectNewFirstTask(state, text) {
  const description = String(text || '').trim();
  if (!description || state.busy) return;
  state.busy = true;
  state.error = '';
  projectNewPaint();
  try {
    await request('/api/later-task/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, jira: state.result.epic.key }),
    });
  } catch {
    if (!projectNew) return;
    state.busy = false;
    projectNewPaint();
    return;
  }
  const key = `jira:${state.result.epic.key}`;
  projectNewDrop();
  openProjectTab(key);
  await load();
  showNotice('첫 할 일을 만들었어요');
}

// ---------- 화면 한 장 ----------
function projectNewRender(body) {
  const state = projectNew;
  body.replaceChildren();
  const title = document.createElement('h2');
  title.className = 'd-ptitle';
  title.textContent = '새 프로젝트';
  body.appendChild(title);

  if (state.result) {
    body.appendChild(projectNewResult(state));
    return;
  }

  const form = document.createElement('div');
  form.className = 'd-pnew';

  const name = projectNewInput(state.name, '프로젝트 이름 — 예: 게시글 작성하기_게임 임베드', '프로젝트 이름', (value) => {
    state.name = value;
    projectNewPreviewPaint();
  }, 200);
  name.classList.add('d-pnewname');
  form.appendChild(projectNewField('이름', name, state.mode === 'epic' ? '이 이름이 에픽 제목이 돼요.' : ''));

  form.appendChild(projectNewField('지라', projectNewModes(state)));

  if (state.mode === 'epic') {
    const project = projectNewInput(state.project, '지라 프로젝트 키 — 예: IO', '지라 프로젝트 키', (value) => { state.project = value; }, 20);
    // 한 글자마다 지라를 부르지 않는다 — 칸을 벗어나거나 Enter를 눌렀을 때만 종류를 읽는다.
    const settle = () => {
      state.project = project.value.trim().toUpperCase();
      project.value = state.project;
      projectNewPaint();
      projectNewMetaLoad(state.project);
    };
    project.addEventListener('blur', settle);
    project.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      settle();
    });
    form.appendChild(projectNewField('지라 프로젝트', project, '에픽을 만들 지라 프로젝트예요.'));
  }

  if (state.mode === 'attach') {
    const slot = document.createElement('div');
    if (state.epic) slot.appendChild(projectNewEpicRow(state));
    else {
      const host = document.createElement('div');
      host.id = 'jiraLinkRow';
      host.dataset.project = PROJECT_NEW_LINK;
      slot.appendChild(host);
      jiraLinkEnsure(PROJECT_NEW_LINK);
      jiraLinkPaint();
    }
    form.appendChild(projectNewField('에픽', slot, state.epic ? '' : '번호·주소를 적거나 아래 목록에서 골라요.'));
  }

  if (state.mode !== 'none') {
    const roles = document.createElement('div');
    roles.appendChild(state.roleEdit ? projectNewRoleEdit(state) : projectNewRoleBox(state));
    if (!state.roleEdit) roles.appendChild(projectNewOwnRow(state));
    form.appendChild(projectNewField('직군', roles, state.roleEdit ? '' : '하나도 고르지 않으면 에픽만 만들어요.'));
    form.appendChild(projectNewField('하위 티켓', projectNewTypeRow(state)));
  }

  if (state.mode === 'none') {
    const first = projectNewInput(state.first, '첫 할 일 — 예: 기획 초안 정리하기', '첫 할 일', (value) => {
      state.first = value;
      projectNewGoPaint();
    }, 200);
    form.appendChild(projectNewField('첫 할 일', first, '항목이 하나 있어야 프로젝트가 생겨요.'));
  }

  body.appendChild(form);

  projectNewPreviewNode = document.createElement('div');
  projectNewPreviewNode.className = 'd-pnewpvbox';
  projectNewPreviewNode.appendChild(projectNewPreview(state));
  body.appendChild(projectNewPreviewNode);

  projectNewGoNode = document.createElement('div');
  projectNewGoNode.className = 'd-pnewgobox';
  projectNewGoNode.appendChild(projectNewActions(state));
  body.appendChild(projectNewGoNode);
}
