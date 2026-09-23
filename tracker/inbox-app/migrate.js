// 데이터 형식 버전 관리.
//
//   node migrate.js [--data DIR] [--dry-run]
//
// 데이터 폴더에는 형식 번호 한 줄짜리 파일 `.data-version`이 있다. 파일이 없으면 **1로 본다**
// (지금 형식이 1이고, 이 기능이 없던 설치도 그대로 읽히게 하려고 — 조회만으로 파일을 새로 만들지 않는다).
// 형식을 바꾸는 변경을 할 때 `DATA_FORMAT_VERSION`을 올리고 `steps`에 그 번호의 변환 함수를 더한다.
// 각 변환은 파일을 `atomicWrite`로만 쓴다(임시 파일 교체 + `.backups/`의 직전 파일).
//
// 데이터가 앱보다 새 형식이면(동료가 옛 앱으로 새 데이터를 여는 경우) 아무것도 하지 않고 종료 코드 3으로
// 멈춘다. 서버도 시작할 때 같은 검사를 한다 — 옛 앱이 새 데이터를 망치지 않게.
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./safe-storage');

const DATA_FORMAT_VERSION = 1;
const VERSION_FILE = '.data-version';
const TOO_NEW_MESSAGE = '이 데이터는 더 새 버전의 앱이 만든 거예요. 앱을 업데이트해 주세요.';

function versionPath(dir) {
  return path.join(dir, VERSION_FILE);
}

function readDataVersion(dir) {
  try {
    const raw = fs.readFileSync(versionPath(dir), 'utf8').trim();
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : 1;
  } catch {
    return 1;   // 파일이 없거나 읽을 수 없으면 지금 형식으로 본다
  }
}

function writeDataVersion(dir, version) {
  atomicWrite(versionPath(dir), `${version}\n`);
}

// 형식을 바꾸는 변경을 할 때 여기에 더한다. 키는 "이 단계를 마치면 도달하는 형식 번호"이고
// 값은 `(dir) => void`다. 지금은 비어 있다(형식 1이 처음이라 변환할 것이 없다).
const steps = {};

// from(지금 데이터) → to(앱이 아는 형식)까지 번호 순서대로 실행한다.
function migrate(dir, options = {}) {
  const from = readDataVersion(dir);
  const to = options.to || DATA_FORMAT_VERSION;
  const dryRun = !!options.dryRun;
  if (from > to) return { ok: false, code: 'DATA_TOO_NEW', from, to, applied: [], dryRun };
  const table = options.steps || steps;
  const applied = [];
  for (let version = from + 1; version <= to; version++) {
    applied.push(version);
    const step = table[version];
    if (!dryRun && step) step(dir);
  }
  if (!dryRun && applied.length) writeDataVersion(dir, to);
  return { ok: true, from, to, applied, dryRun };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let dir = process.env.WORKSPACE_DATA_DIR || path.join(__dirname, '..');
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data' && args[i + 1]) { dir = args[i + 1]; i++; }
    else if (args[i] === '--dry-run') dryRun = true;
    else { console.error(`모르는 옵션이에요: ${args[i]}`); process.exit(2); }
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`데이터 폴더를 찾지 못했어요: ${dir}`);
    process.exit(2);
  }
  const result = migrate(dir, { dryRun });
  if (!result.ok) {
    console.error(TOO_NEW_MESSAGE);
    process.exit(3);
  }
  const head = dryRun ? '(확인만) ' : '';
  if (!result.applied.length) console.log(`${head}데이터 형식 ${result.from} — 바꿀 것이 없어요.`);
  else console.log(`${head}데이터 형식을 ${result.from} → ${result.to}으로 바꿨어요.`);
}

module.exports = { DATA_FORMAT_VERSION, VERSION_FILE, TOO_NEW_MESSAGE, readDataVersion, writeDataVersion, migrate, steps };
