#!/usr/bin/env node
// 합치기 글 자동 생성 도구 — 가지 이름만 주면 바뀐 파일·커밋을 git에서 뽑고,
// 파일 종류에 맞는 점검 블록을 붙여 합치기 시작 글(.md)과 열기 파일(.json)을 만든다.
// 쓰기는 --out 폴더의 <이름표>.md · <이름표>.json 두 개뿐이고 세션은 열지 않는다. Node 기본 모듈만 쓴다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OPEN_QUEUED = '/Users/luvon/session-board/app/bin/open-queued.mjs';
const DESIGN_TOOLS_README = '/Users/luvon/session-board/docs/design/tools/README.md';
const LEDGER = '/Users/luvon/session-board/app/lib/ledger.js';
const INSTALLED_AUTOMATION = '~/.local/share/workspace-automation/';
const SAFETY_FUNCS = 'request·showNotice·pushUndo·recordUndoFor·toggleTask·fadeOutAndRun·isClientFile·RECOVERY_NEEDED';
const TEST_CMD = '`cd tracker/inbox-app`에서 `node --test --test-concurrency=1 --test-timeout=300000 *.test.js`';
const HUMAN_SPEED_FILES = new Set(['report-ui.js', 'app.js', 'projects-ui.js', 'meetings-ui.js', 'project-new-ui.js', 'settings-ui.js', 'waiting-ui.js']);
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const RISK_FILES = new Set(['server.js', 'slack-capture.sh', 'ui.css', 'app.js']);

class UsageError extends Error {}

const VALUE_FLAGS = new Set(['task', 'name', 'summary', 'base', 'model', 'repo', 'out']);
const BOOL_FLAGS = new Set(['dry-run', 'force', 'codex-done', 'opus-review-done']);

function parseArgs(argv) {
  const opts = { branches: [], base: 'main' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts.branches.push(arg); continue; }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (BOOL_FLAGS.has(key)) { opts[key] = true; continue; }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`모르는 옵션: --${key}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`--${key} 값이 없음`);
    }
    opts[key] = value;
  }
  for (const need of ['task', 'name', 'summary']) {
    if (!opts[need]) throw new UsageError(`--${need} 필요`);
  }
  if (!opts.branches.length) throw new UsageError('가지 이름이 하나는 필요함');
  if (!/^[A-Za-z0-9._-]+$/.test(opts.task)) throw new UsageError('--task 는 영문·숫자·._- 만 쓸 수 있음');
  // 셸이 백틱을 명령으로 실행해 문구가 빠지는 사고가 있었다. 이 검사는 셸이 처리하고 남은 백틱만 잡을 수 있다(이미 빠진 문구는 알 수 없음).
  if (opts.summary.includes('`')) throw new UsageError('--summary 에 백틱(`)이 있음 — 백틱 대신 「」를 써 주세요');
  if (opts.model && !['sonnet', 'opus'].includes(opts.model)) throw new UsageError('--model 은 sonnet 또는 opus');
  return opts;
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const msg = String(e.stderr || e.message).trim();
    throw new UsageError(`git ${args.join(' ')} 실패: ${msg}`);
  }
}

function gitOk(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}

// 메인 저장소 뿌리 — 복사본(worktree)에서 돌려도 합칠 곳은 원래 저장소다.
function mainRepoRoot(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return path.basename(common) === '.git' ? path.dirname(common) : repo;
}

function classify(file) {
  const base = path.basename(file);
  if (/\.test\.js$/.test(base) || base === 'test-support.js') return '시험';
  if (/\.md$/.test(base)) return '문서';
  if (/(^|\/)automation\//.test(file)) return '스크립트';
  if (/\.(css)$/.test(base) || base === 'index.html' || base === 'app.js' || /-ui\.js$/.test(base)) return '화면';
  if (/^tracker\/inbox-app\/.+\.(js|mjs|cjs)$/.test(file)) return '서버';
  if (/^[^/]+\.sh$/.test(file)) return '스크립트';
  return '기타';
}

function gatherBranch(repo, base, branch, index) {
  if (!gitOk(repo, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])) {
    throw new UsageError(`가지를 찾을 수 없음: ${branch}`);
  }
  const mergeBase = git(repo, ['merge-base', base, branch]).trim();
  const ancestor = gitOk(repo, ['merge-base', '--is-ancestor', base, branch]);
  const commits = git(repo, ['log', '--oneline', `${base}..${branch}`]).split('\n').filter(Boolean);
  const nameStatus = git(repo, ['diff', '--no-renames', '-z', '--name-status', `${base}...${branch}`]).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < nameStatus.length; i += 2) {
    files.push({ status: nameStatus[i], file: nameStatus[i + 1], kind: classify(nameStatus[i + 1]) });
  }
  if (!files.length) throw new UsageError(`바뀐 파일이 0개: ${base}...${branch} (이미 합쳐졌거나 가지가 비었음)`);
  const stat = new Map();
  for (const rec of git(repo, ['diff', '--no-renames', '-z', '--numstat', `${base}...${branch}`]).split('\0').filter(Boolean)) {
    const [add, del, ...rest] = rec.split('\t');
    stat.set(rest.join('\t'), { add, del });
  }
  for (const f of files) Object.assign(f, stat.get(f.file) || { add: '-', del: '-' });
  files.sort((a, b) => (a.file < b.file ? -1 : 1));
  const tip = git(repo, ['rev-parse', '--short', branch]).trim();
  const kinds = new Set(files.map((f) => f.kind));
  return {
    branch, index, tip, mergeBase, commits, files, kinds,
    // 첫 가지만 main 위인지 본다. 뒤 가지는 앞 가지가 합쳐지면 main이 앞서므로 항상 --no-ff.
    ff: index === 0 && ancestor,
    ancestor,
  };
}

function riskFiles(info) {
  return info.files.filter((f) => RISK_FILES.has(path.basename(f.file)) || f.kind === '서버' || f.kind === '스크립트');
}

function fileList(info) {
  return info.files.map((f) => f.file).join(', ');
}

function kindSummary(info) {
  const order = ['화면', '서버', '스크립트', '문서', '시험', '기타'];
  return order.filter((k) => info.kinds.has(k)).map((k) => `${k} ${info.files.filter((f) => f.kind === k).length}`).join(' · ');
}

function pickModel(opts, infos) {
  if (opts.model) return { model: opts.model, why: '--model 로 지정' };
  const heavy = infos.some((i) => i.kinds.has('서버') || i.kinds.has('스크립트'));
  return heavy
    ? { model: 'opus', why: '서버·스크립트 변경 있음' }
    : { model: 'sonnet', why: '서버·스크립트 변경 없음(화면·문서·시험만)' };
}

function branchSection(opts, info, total, baseTip) {
  const L = [];
  const label = total > 1 ? `${CIRCLED[info.index] || info.index + 1} ` : '';
  const how = info.ff
    ? `main ${baseTip} 바로 위 — ff-only로 됨`
    : (info.index > 0 ? '앞 가지가 합쳐지면 main이 앞서므로 ff가 안 됨 — --no-ff로 합침' : `main ${baseTip}이(가) 앞서 있음 — --no-ff로 합침`);
  L.push(`### ${label}${info.branch} (${info.tip}까지, 커밋 ${info.commits.length}개, ${how})`);
  L.push('커밋: ' + (info.commits.length ? info.commits.map((c) => `\`${c.replace(/`/g, "'")}\``).join(' · ') : '없음'));
  L.push(`- 바뀐 파일은 \`git diff --name-status ${opts.base}...${info.branch}\`로 **정확히 ${info.files.length}개**여야 함: ${fileList(info)}. 이 밖이면 멈추고 알려. (종류: ${kindSummary(info)})`);
  const risk = riskFiles(info);
  if (risk.length) {
    L.push('- 위험 파일 변경 줄 수(+/-): ' + risk.map((f) => `${f.file} +${f.add}/-${f.del}`).join(' · ') + ' — diff를 직접 읽어 이 수와 맞는지 확인.');
  }
  if (info.kinds.has('서버') || info.kinds.has('스크립트')) {
    L.push('- **안전 검사 강화(서버·스크립트에 닿음 — 꼼꼼히)**: diff를 직접 읽어 ①새 fs 쓰기·spawn·fetch가 새로 생기지 않았는지 ②슬랙 토큰·갱신 정보 파일을 읽거나 쓰는 코드, 인증(OAuth/PKCE/인증 코드) 로직 변경이 없는지 ③저장 형식 번호(스키마 버전)가 그대로인지 ④새 파일 쓰기가 없는지.');
    L.push(`- 되돌림 기준: 진짜 실패면 \`git reset --keep ${baseTip}\`(이 가지를 합치기 전 main 끝 커밋)로 되돌리고 보고.`);
    L.push('- 검수 상태: ' + reviewStatus(opts));
  }
  L.push(info.ff
    ? `- 합치기: \`git merge --ff-only ${info.branch}\``
    : `- 합치기: \`git merge --no-ff ${info.branch} -m "합치기 — ${opts.name}"\` (충돌이 나면 건드리지 말고 \`git merge --abort\` 후 멈추고 알려)`);
  return L;
}

function reviewStatus(opts) {
  const done = [];
  if (opts['codex-done']) done.push('Codex 읽기 전용 검토 받음');
  if (opts['opus-review-done']) done.push('Opus 검수 받음');
  return done.length ? done.join(' · ') : 'Codex 미검토 — 합치기 전에 조율에게 확인';
}

function buildPrompt(opts, infos, baseTip, modelPick) {
  const allKinds = new Set(infos.flatMap((i) => [...i.kinds]));
  const heavy = allKinds.has('서버') || allKinds.has('스크립트');
  const screen = allKinds.has('화면');
  const docTestOnly = [...allKinds].every((k) => k === '문서' || k === '시험');
  const tests = heavy ? 2 : 1;
  const modelName = modelPick.model === 'opus' ? 'Opus' : 'Sonnet';
  const repoRoot = opts._repoRoot;
  const L = [];

  L.push(`<!-- 모델: ${modelPick.model} — ${modelPick.why} (merge-prompt.js 가 만든 글) -->`);
  L.push(`너는 "합치기·반영" 세션이야. 워크스페이스 앱 저장소(${repoRoot})에서 검수 끝난 가지 ${infos.length > 1 ? `${infos.length}개를 순서대로` : '하나를'} ${opts.base}에 합치고 시험 뒤 이 맥에 반영해. 계정 루렌(.claude-account3), 모델 ${modelName}.`);
  L.push('조율("워크플레이스 조율")이 연 창 없는 세션이라 사용자는 이 창을 안 봐. 질문과 보고는 SendMessage로 "워크플레이스 조율"에게(추천 하나 붙여서, 짧은 끝맺음 ~함). 루본에게 직접 묻지 마. 시작하면 "시작" 한 줄만 보내고 바로 일해.');
  L.push('');
  L.push(`## 지금 합칠 것${infos.length > 1 ? `: 가지 ${infos.length}개를 이 순서로 (${infos.map((i) => i.branch).join(' → ')})` : `: ${infos[0].branch}`}`);
  L.push(opts.summary);
  L.push('');
  for (const info of infos) {
    L.push(...branchSection(opts, info, infos.length, baseTip));
    L.push('');
  }

  L.push('## 절차');
  const steps = [];
  steps.push('각 가지의 안전 검사' + `: 안전장치 함수(${SAFETY_FUNCS}) 정의 변경 없음 확인(diff 직접 확인)`);
  steps.push('위 합치기 명령을 가지 순서대로 하나씩' + (infos.length > 1 ? ' (뒤 가지는 앞 가지가 합쳐진 main 위라 `--no-ff`)' : ''));
  steps.push(`전체 시험 **${tests}번** — ${TEST_CMD}. 흔들리는 시험(automation·server.calendar·server.update·slack-oauth 시간 초과)은 단독 재실행(\`node --test --test-timeout=90000 <파일>\`)으로 구분하고, 진짜 실패면 되돌림. 이 맥엔 \`timeout\` 명령이 없으니 쓰지 마.`);
  steps.push(automationBlock(infos));
  if (docTestOnly) {
    steps.push('문서·시험만 바뀐 변경이라 서버 재시작은 생략해도 됨. 그래도 4321·4340이 200인지는 확인.');
  } else {
    steps.push('`launchctl kickstart -k gui/$(id -u)/com.workspace.app.server` → `curl`로 4321 200 → 저장소 뿌리에서 `./tryout.sh restart` → 4340 200.');
  }
  steps.push('운영 확인: 재시작 전 `curl -s http://localhost:4321/api/items`의 **항목 개수만**(내용 출력 금지)과 `curl http://localhost:4321/api/integrations`에서 **값 없는 상태만**(auth·oauth.connected·oauth.stalled·fetch.failing·alerts 개수) 적어 두고, 재시작 뒤 같은지 확인(응답 통째 출력 금지).');
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');

  if (screen) {
    const screenFiles = [...new Set(infos.flatMap((i) => i.files.filter((f) => f.kind === '화면').map((f) => f.file)))];
    L.push('## 화면 확인');
    L.push(`- 써 보기 4340(가짜 데이터)에서 바뀐 화면(${screenFiles.join(', ')})을 눌러 보기: 깨짐·잘림 없는지, 라이트·다크 각 한 장, 콘솔 오류. 운영 4321에서는 화면을 열어 보기만(데이터를 바꾸는 동작은 누르지 마).`);
    L.push(`- **간격 측정(필수, 새로 생긴 것만)**: \`${DESIGN_TOOLS_README}\`의 \`measure.mjs\`로 — 두 번 다 \`--tokens DESIGN.md\`를 붙여(DESIGN.md의 spacing 블록 눈금으로 판단 — 눈금 밖 값만 경고) — main에서 같은 화면을 먼저 재 두고(\`--json main.json\`), 가지에서 \`--base main.json\`으로 다시 재서 **이번에 새로 생긴 것만** 보고에 적어(새로 생긴 간격 N곳·잘림 N곳, 1440 폭). 기준을 못 재면 "기준 비교 못 함"과 이유를 적어. "변경 없음"은 CSS·화면 구조 둘 다 안 바뀐 경우에만 쓸 것. 보고에 간격 줄이 없으면 안 끝난 것.`);
    L.push('');
  }

  const humanFiles = [...new Set(infos.flatMap((i) => i.files.filter((f) => HUMAN_SPEED_FILES.has(path.basename(f.file))).map((f) => f.file)))];
  if (humanFiles.length) {
    L.push('## 사람 속도 확인');
    L.push(`- 입력·클릭 파일이 바뀜(${humanFiles.join(', ')}). 입력칸·클릭·저장 동작이 바뀐 일이면 \`node tools/human-check.mjs <시나리오.json> --serve\`로 돌린다(누름 0·50·100·150·300ms·실제 한글 조합, 자기 크롬·자기 pid만 — 쓰는 법은 tools/human-check/README.md). 바뀐 흐름에 맞는 시나리오가 tools/human-check/scenarios/에 없으면 하나 써서 같이 커밋하고, 결과 요약 줄(통과 N · 실패 N · 못 돎 N)과 index.html 경로를 보고에 적을 것.`);
    L.push('');
  }

  L.push('## 지키는 선');
  [
    '`git push`·`release.sh`·배포·태그·VERSION 올리기·소식.md 고치기 금지(배포는 사용자가 직접, 소식은 배포 전에).',
    '자동 권한 검사가 막으면 다른 길로 돌리지 말고 멈추고 조율에게. `launchctl`·`./tryout.sh restart`가 막히면 사용자가 `!`로 돌릴 명령 한 줄만 조율에게 알려.',
    '운영 설정·토큰·갱신 정보 파일은 읽지도 쓰지도 마. 운영(4321)에서 데이터를 바꾸는 동작(담기·체크·종류 바꾸기·슬랙 연결·지금 가져오기)은 누르지 마. 운영 보고 파일(`tracker/.report-drafts.json` 등)·업무 데이터도 읽지 마.',
    'kill 계열(pkill·killall·xargs kill) 금지, 직접 띄운 프로세스만 PID로 끝내. 프로세스 목록을 훑어 종료 대상을 고르지 마. 포트 9333 Chrome·작업실 4318·다른 세션 프로세스는 건드리지 마.',
    '허락 창에서 멈출 모양(`&&`로 길게 잇기, {a,b}, 변수가 빈 rm)은 피해. 대화 기록·메모리 파일은 읽지 마. main 작업 트리의 미추적 파일(PRODUCT.md·design/·docs/정리 등)은 건드리지 마(합치기가 그 파일을 덮어쓰지 않음을 확인).',
    '브라우저 도구가 2분 넘게 응답 없으면 기다리지 말고 "못 봄"으로 적고 넘어가. /compact 금지.',
    `장부 한마디: node ${LEDGER} add '{"task":"${opts.task}","stage":"합치기","say":"합치기: <무엇 하는 중>"}'`,
  ].forEach((s) => L.push(`- ${s}`));
  L.push('');

  L.push('## 끝나면');
  L.push(`조율에게 "끝"과 함께: 시험 수${tests > 1 ? '(각 회차 결과·걸린 시간)' : '·걸린 시간'}, ${opts.base} 커밋(합친 뒤 끝 해시), 서버 재시작 여부, 운영 상태(슬랙 상태 값 없는 항목·운영 데이터 개수 전후), 화면 확인(본 것/못 본 것${screen ? ' — 간격 측정 줄 포함' : ''}), 써 보기 서버 상태, 미푸시 커밋 수, "발견했지만 안 건드린 것". 그리고 기다려.`);
  return L.join('\n') + '\n';
}

function automationBlock(infos) {
  const auto = [...new Set(infos.flatMap((i) => i.files.filter((f) => f.kind === '스크립트').map((f) => f.file)))];
  if (!auto.length) return 'automation/ 변경 없음 확인(설치본 복사 불필요).';
  const pairs = auto.map((f) => `\`${f}\` → \`${INSTALLED_AUTOMATION}${path.basename(f)}\``).join(', ');
  return `**설치본 복사 필수** — 바뀐 스크립트: ${pairs}. AGENTS.md는 \`setup.sh\`·\`update.sh\`가 설치본을 복사한다고 함. 먼저 \`setup.sh\`를 **읽어서** launchd 등록·plist·권한·설정을 건드리는지 확인하고, 한 파일만 \`cp -p\` 하려면 **조율에게 먼저 물어**(추천 하나). 승인되면 복사 뒤 \`diff 저장소파일 설치본\`이 같은지 확인. 진짜 실패로 되돌릴 때는 설치본도 되돌림.`;
}

function buildJson(opts, infos, modelPick, tests, docTestOnly) {
  return {
    task: opts.task,
    name: opts.name,
    project: '워크',
    account: '루렌',
    model: modelPick.model,
    cwd: opts._repoRoot,
    promptFile: `${opts.task}.md`,
    note: `${infos.map((i) => i.branch).join(' + ')} ${infos[0].ff ? 'ff-only' : 'no-ff'} 합치고 시험 ${tests}번${docTestOnly ? '(재시작 생략 가능)' : '·재시작'}. 푸시·배포 없음.`,
  };
}

function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  try {
    const opts = parseArgs(argv);
    const repo = path.resolve(opts.repo || io.cwd || process.cwd());
    if (!gitOk(repo, ['rev-parse', '--git-dir'])) throw new UsageError(`git 저장소가 아님: ${repo}`);
    if (!gitOk(repo, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`])) throw new UsageError(`base 가지를 찾을 수 없음: ${opts.base}`);
    opts._repoRoot = mainRepoRoot(repo);

    const infos = opts.branches.map((b, i) => gatherBranch(repo, opts.base, b, i));
    const baseTip = git(repo, ['rev-parse', '--short', opts.base]).trim();
    const modelPick = pickModel(opts, infos);
    const allKinds = new Set(infos.flatMap((i) => [...i.kinds]));
    const heavy = allKinds.has('서버') || allKinds.has('스크립트');
    const docTestOnly = [...allKinds].every((k) => k === '문서' || k === '시험');
    const md = buildPrompt(opts, infos, baseTip, modelPick);
    const json = JSON.stringify(buildJson(opts, infos, modelPick, heavy ? 2 : 1, docTestOnly)) + '\n';
    const openCmd = `node ${OPEN_QUEUED} ${opts.task}`;
    const cleanCmd = `합친 뒤 정리: tools/after-merge.sh ${opts.branches[0]} --task <구현 이름표> --merge-task ${opts.task}`;

    if (opts['dry-run']) {
      out(md + '\n--- ' + `${opts.task}.json` + ' ---\n' + json + '\n(dry-run: 파일을 쓰지 않음)\n열려면: ' + openCmd + '\n' + cleanCmd + '\n');
      return 0;
    }
    const outDir = path.resolve((opts.out || path.join(os.homedir(), '.session-board', 'launch-queue')).replace(/^~(?=\/|$)/, os.homedir()));
    const mdPath = path.join(outDir, `${opts.task}.md`);
    const jsonPath = path.join(outDir, `${opts.task}.json`);
    if (!opts.force) {
      for (const p of [mdPath, jsonPath]) {
        if (fs.existsSync(p)) throw new UsageError(`이미 있음: ${p} (덮어쓰려면 --force)`);
      }
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(mdPath, md);
    fs.writeFileSync(jsonPath, json);
    out(`만듦: ${mdPath}\n만듦: ${jsonPath}\n세션을 열려면(이 스크립트는 열지 않음):\n${openCmd}\n${cleanCmd}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { err(`오류: ${e.message}\n`); return 1; }
    throw e;
  }
}

module.exports = { run, parseArgs, classify, gatherBranch, buildPrompt, UsageError };

if (require.main === module) process.exitCode = run(process.argv.slice(2));
