// 회의 녹음 음성 인식 도구 — 어디 있나(찾기) · 준비됐나(상태) · 없으면 받아 깔기(설치).
// - 찾기·상태는 파일이 있는지만 본다(프로세스를 띄우지 않는다) — 앱 서버(routes-record.js)도 이걸로 화면에 상태를 준다.
// - 설치는 launchd `meeting-transcribe` 실행기(meeting-transcribe.js)와 손으로 돌리는 automation/install-meeting-tools.sh만 부른다.
//   서버는 부르지 않는다. 받는 것은 전부 아래 목록(MANIFEST)에 적힌 주소·크기·sha256과 맞을 때만 쓴다 — `.part`로 받고,
//   크기·sha256을 확인한 뒤에만 제자리로 옮긴다(반쪽 파일이 완성본처럼 남지 않게). 압축은 /usr/bin/tar로 임시 폴더에 푼 뒤 옮긴다.
//   tar는 설치를 부른 실행기가 띄운 자식이고, 끝내는 신호도 그 자식에게만 간다(run을 실행기에서 받는다).
// - Homebrew·관리자 암호가 필요 없다. 애플 실리콘 맥만(인텔 맥은 `unsupported`).
// 진행은 `<도구 폴더>/install.json`({ stage, step, percent, bytes, total, error, updatedAt })에 적는다 — 서버는 읽기만 한다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SHERPA_NAME = 'sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts';
const SEG_DIR = 'sherpa-onnx-pyannote-segmentation-3-0';
const EMB_FILE = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';
const MODEL_FULL = 'ggml-large-v3-turbo.bin'; // 예전 설치(약 1.6GB) — 이미 있으면 그대로 쓴다
const MODEL_Q5 = 'ggml-large-v3-turbo-q5_0.bin'; // 새로 받는 모델(약 574MB) — 시끄러운 한국어 녹음에서 위와 같은 글, 더 빠름
const SHERPA_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
// 도구 꾸러미는 이 저장소의 릴리스에 둔다(tools/build-meeting-tools.sh가 만든다). 판을 올리면 태그·이름·크기·sha256을 함께 바꾼다.
const PACKAGE_TAG = 'meeting-tools-v1';
const PACKAGE_FILE = 'meeting-tools-arm64-1.tar.gz';
const PACKAGE_URL = `https://github.com/luvoneun/workspace-tracker/releases/download/${PACKAGE_TAG}/${PACKAGE_FILE}`;
const INSTALLING = ['downloading', 'extracting'];
const STALE_MS = 5 * 60 * 1000; // 이만큼 진행 소식이 없는 설치는 멈춘 것으로 본다(실행기가 죽었다)
const REQUEST_FRESH_MS = 10 * 60 * 1000; // 준비 요청을 쓴 뒤 이만큼은 `곧 시작해요`로 본다

// 받는 것 — 주소·크기·sha256은 받아 둔 파일에서 잰 값이다. 바꾸면 반드시 새로 잰다.
const MANIFEST = [
  { id: 'tools', label: '음성 인식 프로그램', url: PACKAGE_URL, size: 3427572, sha256: '9a429177be53c779dbc0678020269bd778ca3f4ab0f480fa0d23b9375ce303d0',
    kind: 'tar', moves: [['bin/whisper-cli', 'bin/whisper-cli'], ['bin/ffmpeg', 'bin/ffmpeg'], ['LICENSES', 'licenses/meeting-tools'], ['BUILD.txt', 'licenses/meeting-tools/BUILD.txt']] },
  { id: 'sherpa', label: '화자 구분 프로그램', url: `${SHERPA_BASE}/v2.0.1/${SHERPA_NAME}.tar.bz2`, size: 18663994, sha256: '4fcc6c77c8d8d2e2f04cfdc17c6fd224c01469b78529370eb9d8e0e5ec97ac79',
    kind: 'tar', moves: [[SHERPA_NAME, `sherpa/${SHERPA_NAME}`]] },
  { id: 'seg', label: '화자 구분 모델', url: `${SHERPA_BASE}/speaker-segmentation-models/${SEG_DIR}.tar.bz2`, size: 6958444, sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    kind: 'tar', moves: [[SEG_DIR, `models/${SEG_DIR}`]] },
  { id: 'emb', label: '목소리 구분 모델', url: `${SHERPA_BASE}/speaker-recongition-models/${EMB_FILE}`, size: 39593761, sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    kind: 'file', dest: `models/${EMB_FILE}` },
  { id: 'model', label: '음성 인식 모델', url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_Q5}`, size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    kind: 'file', dest: `models/${MODEL_Q5}` },
];
// 참고: 예전에 받던 ggml-large-v3-turbo.bin(1,624,555,275바이트)의 sha256은 1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69.

const WORDS = {
  network: '내려받지 못했어요 — 인터넷 연결을 확인해 주세요',
  notFound: '내려받을 파일을 찾지 못했어요',
  checksum: '받은 파일이 올바르지 않아요(확인 값이 달라요)',
  disk: '디스크 공간이 부족해요(약 0.7GB가 필요해요)',
  extract: '받은 파일을 풀지 못했어요',
  unsupported: '음성 인식은 애플 실리콘 맥에서만 쓸 수 있어요',
};

function toolsDir(env = process.env) {
  return env.WORKSPACE_MEETING_TOOLS || path.join(os.homedir(), '.local/share/workspace-meeting');
}
// 예전 Homebrew 설치도 계속 쓴다 — 시험은 WORKSPACE_MEETING_SYSTEM_BIN으로 이 자리를 바꾼다.
function systemBins(env = process.env) {
  const raw = env.WORKSPACE_MEETING_SYSTEM_BIN;
  return (raw == null ? '/opt/homebrew/bin:/usr/local/bin' : raw).split(':').filter(Boolean);
}
// 애플 실리콘인가 — 로제타로 도는 node(x64)도 칩 이름으로 가린다. 시험은 WORKSPACE_MEETING_ARCH로 끼운다.
function supported(env = process.env) {
  if (env.WORKSPACE_MEETING_ARCH) return env.WORKSPACE_MEETING_ARCH === 'arm64';
  if (process.platform !== 'darwin') return false;
  if (process.arch === 'arm64') return true;
  try { return /Apple/.test((os.cpus()[0] || {}).model || ''); } catch { return false; }
}

const firstExisting = list => list.find(file => file && fs.existsSync(file)) || '';
// 도구 자리: 환경 변수(시험) → 이 앱이 받은 것(`<도구 폴더>/bin`) → Homebrew. 모델은 이미 있는 큰 모델 → 새 모델(q5).
function locate(env = process.env) {
  const dir = toolsDir(env);
  const models = path.join(dir, 'models');
  const bins = [path.join(dir, 'bin'), ...systemBins(env)];
  let sherpa = env.WORKSPACE_SHERPA_DIARIZE || '';
  if (!sherpa) {
    const base = path.join(dir, 'sherpa');
    let dirs = [];
    try { dirs = fs.readdirSync(base).sort().reverse(); } catch { dirs = []; }
    sherpa = firstExisting(dirs.map(name => path.join(base, name, 'bin', 'sherpa-onnx-offline-speaker-diarization')));
  }
  return {
    ffmpeg: env.WORKSPACE_FFMPEG || firstExisting(bins.map(bin => path.join(bin, 'ffmpeg'))),
    whisper: env.WORKSPACE_WHISPER || firstExisting(bins.map(bin => path.join(bin, 'whisper-cli'))),
    whisperModel: env.WORKSPACE_WHISPER_MODEL || firstExisting([path.join(models, MODEL_FULL), path.join(models, MODEL_Q5)]) || path.join(models, MODEL_Q5),
    sherpa,
    segModel: path.join(models, SEG_DIR, 'model.onnx'),
    embModel: path.join(models, EMB_FILE),
  };
}
// 빠진 것 — 목록(빈 목록이면 준비됨). 화자 구분을 가짜로 끼운 시험은 그 모델을 보지 않는다.
function missing(t, env = process.env) {
  const out = [];
  if (!t.ffmpeg || !fs.existsSync(t.ffmpeg) || !t.whisper || !fs.existsSync(t.whisper)) out.push('tools');
  if (!t.sherpa || !fs.existsSync(t.sherpa)) out.push('sherpa');
  if (!env.WORKSPACE_SHERPA_DIARIZE) {
    if (!fs.existsSync(t.segModel)) out.push('seg');
    if (!fs.existsSync(t.embModel)) out.push('emb');
  }
  if (!t.whisperModel || !fs.existsSync(t.whisperModel)) out.push('model');
  return out;
}

const statusFile = (env = process.env) => path.join(toolsDir(env), 'install.json');
function readStatus(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(statusFile(env), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}
function writeStatus(status, env = process.env) {
  const file = statusFile(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() })}\n`);
    fs.renameSync(temp, file);
  } catch {}
}

// 화면에 줄 상태 하나 — ready · unsupported · installing(percent) · requested · failed(error) · missing.
// requestedAt: 준비 요청 파일을 쓴 시각(ms, 없으면 0). now는 시험용.
function summarize({ env = process.env, requestedAt = 0, now = Date.now() } = {}) {
  if (!missing(locate(env), env).length) return { state: 'ready' };
  if (!supported(env)) return { state: 'unsupported', error: WORDS.unsupported };
  const status = readStatus(env);
  const at = status ? Date.parse(status.updatedAt || '') || 0 : 0;
  const percent = status ? Math.max(0, Math.min(100, Math.floor(Number(status.percent) || 0))) : 0;
  if (status && INSTALLING.includes(status.stage)) {
    if (now - at < STALE_MS) return { state: 'installing', percent, step: String(status.step || '') };
    if (requestedAt <= at) return { state: 'failed', error: '준비가 중간에 멈췄어요' };
  }
  if (requestedAt > at && now - requestedAt < REQUEST_FRESH_MS) return { state: 'requested', percent: 0 };
  if (status && status.stage === 'failed') return { state: 'failed', error: String(status.error || WORDS.network).slice(0, 200) };
  return { state: 'missing' };
}

// ---------- 설치(실행기·손 스크립트만) ----------
class InstallError extends Error {}
const fail = (word) => new InstallError(word);

// 잠금 — 실행기와 손으로 돌린 스크립트가 겹쳐 받지 않게. 주인이 이 맥에 살아 있는 프로세스일 때만 잠금으로 본다
// (pid에 신호 0 = 있는지만 묻기, 끝내지 않는다). 주인이 없으면 넘겨받는다.
function takeLock(dir) {
  const file = path.join(dir, '.install.lock');
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true }); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      let owner = 0, age = 0;
      try { owner = parseInt(fs.readFileSync(file, 'utf8'), 10); age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
      let alive = false;
      if (owner > 0 && owner !== process.pid) { try { process.kill(owner, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      // 같은 번호를 다른 프로그램이 물려받았을 수 있다 — 3시간 넘은 잠금은 주인이 있어도 넘겨받는다(설치는 그보다 짧다).
      if (alive && age < 3 * 60 * 60 * 1000) return null;
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  return null;
}

// 하나 받기: `.part`에 흘려 쓰며 sha256을 재고, 크기·값이 맞을 때만 돌려준다. 틀리면 `.part`를 지운다.
async function download(item, part, onBytes, fetchImpl) {
  try { fs.rmSync(part, { force: true }); } catch {} // 지난 회차가 남긴 반쪽 파일 — 받기 전에 먼저 치운다(아래에서 일찍 실패해도 남지 않게)
  let response;
  try { response = await fetchImpl(item.url, { signal: AbortSignal.timeout(60 * 60 * 1000) }); }
  catch { throw fail(WORDS.network); }
  if (response.status === 404) throw fail(WORDS.notFound);
  if (!response.ok || !response.body) throw fail(WORDS.network);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(part, { flags: 'w' });
  const wrote = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  wrote.catch(() => {}); // 중간에 그만두면 아래에서 직접 치운다
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > item.size) { try { await reader.cancel(); } catch {} throw fail(WORDS.checksum); }
      hash.update(value);
      // 디스크가 차면 drain 없이 error만 온다 — 둘 중 먼저 오는 것을 기다린다(영영 멈춰 잠금을 쥐지 않게)
      if (!out.write(value)) {
        await new Promise((resolve, reject) => {
          const drained = () => { out.off('error', broke); resolve(); };
          const broke = (err) => { out.off('drain', drained); reject(err); };
          out.once('drain', drained);
          out.once('error', broke);
        });
      }
      onBytes(value.length);
    }
    out.end();
    await wrote;
  } catch (error) {
    // 파일 손잡이가 닫힌 뒤에 지운다(닫히기 전에 지우면 늦게 열린 손잡이가 빈 파일을 다시 만든다).
    await new Promise(resolve => { if (out.closed) resolve(); else { out.once('close', resolve); out.destroy(); } });
    try { fs.rmSync(part, { force: true }); } catch {}
    if (error instanceof InstallError) throw error;
    throw fail(error && error.code === 'ENOSPC' ? WORDS.disk : WORDS.network);
  }
  if (size !== item.size || hash.digest('hex') !== item.sha256) {
    try { fs.rmSync(part, { force: true }); } catch {}
    throw fail(WORDS.checksum);
  }
}

// 압축 꾸러미를 임시 폴더에 풀고, 적힌 자리만 제자리로 옮긴다(이미 있던 반쪽 폴더는 지우고).
async function unpack(item, part, dir, run) {
  const staging = path.join(dir, 'downloads', `${item.id}.staging`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const result = await run('/usr/bin/tar', ['-xf', part, '-C', staging], { timeoutMs: 10 * 60 * 1000 });
    if (result.code !== 0 || result.timedOut) throw fail(WORDS.extract);
    for (const [from, to] of item.moves) {
      const source = path.join(staging, from);
      if (!fs.existsSync(source)) throw fail(WORDS.extract);
      // 꾸러미 밖으로 나가는 링크·경로는 받지 않는다.
      if (!path.resolve(source).startsWith(path.resolve(staging) + path.sep) || fs.lstatSync(source).isSymbolicLink()) throw fail(WORDS.extract);
      const target = path.join(dir, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(source, target);
      if (/^bin\//.test(to)) fs.chmodSync(target, 0o755);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// 빠진 것만 받아 깐다. 돌려줌: { ok: true } · { ok: false, error } · { ok: false, busy: true }(다른 설치가 도는 중) · { ok: false, unsupported: true }.
// 진행은 install.json에 적는다(받는 동안 0.5초에 한 번까지).
async function install({ run, env = process.env, fetchImpl = fetch, manifest = loadManifest(env), log = () => {} } = {}) {
  if (!supported(env)) { writeStatus({ stage: 'unsupported', error: WORDS.unsupported }, env); return { ok: false, unsupported: true, error: WORDS.unsupported }; }
  const dir = toolsDir(env);
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  const release = takeLock(dir);
  if (!release) return { ok: false, busy: true };
  let heartbeat = null;
  try {
    const need = new Set(missing(locate(env), env));
    const items = manifest.filter(item => need.has(item.id));
    const total = items.reduce((sum, item) => sum + item.size, 0);
    let bytes = 0;
    let shownAt = 0;
    const show = (stage, step, force) => {
      const now = Date.now();
      if (!force && now - shownAt < 500) return;
      shownAt = now;
      writeStatus({ stage, step, bytes, total, percent: total ? Math.floor((bytes / total) * 100) : 100, pid: process.pid }, env);
    };
    let current = { stage: 'downloading', step: items[0] ? items[0].id : '' };
    const beat = (stage, step, force) => { current = { stage, step }; show(stage, step, force); };
    // 느린 망에서 한동안 바이트가 안 들어와도 실행기가 살아 있는 동안은 '받는 중'으로 보이게 — 30초마다 같은 진행을 다시 적는다.
    heartbeat = setInterval(() => show(current.stage, current.step, true), 30 * 1000);
    if (heartbeat.unref) heartbeat.unref();
    beat('downloading', current.step, true);
    for (const item of items) {
      const part = path.join(dir, 'downloads', `${item.id}.part`);
      log(`${item.label} 받는 중 (${Math.round(item.size / 1024 / 1024)}MB)`);
      beat('downloading', item.id, true);
      await download(item, part, (n) => { bytes += n; show('downloading', item.id, false); }, fetchImpl);
      beat('extracting', item.id, true);
      try {
        if (item.kind === 'tar') await unpack(item, part, dir, run);
        else {
          const target = path.join(dir, item.dest);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(part, target);
        }
      } finally { fs.rmSync(part, { force: true }); }
    }
    const left = missing(locate(env), env);
    if (left.length) throw fail(WORDS.extract);
    writeStatus({ stage: 'done', bytes, total, percent: 100 }, env);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof InstallError ? error.message : (error && error.code === 'ENOSPC' ? WORDS.disk : WORDS.extract);
    if (!(error instanceof InstallError)) log(`설치 중 예상 못 한 문제: ${String((error && error.message) || error)}`);
    writeStatus({ stage: 'failed', error: reason }, env);
    return { ok: false, error: reason };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    release();
  }
}
// 시험만: WORKSPACE_MEETING_TOOLS_MANIFEST(JSON 파일)로 받을 목록 전체를 바꾼다 — 주소·크기·sha256까지 함께.
// 그 밖에는 위에 박아 둔 목록만 쓴다(주소만 바꿔 다른 파일을 받게 할 수 없다).
function loadManifest(env = process.env) {
  if (!env.WORKSPACE_MEETING_TOOLS_MANIFEST) return MANIFEST;
  try {
    const list = JSON.parse(fs.readFileSync(env.WORKSPACE_MEETING_TOOLS_MANIFEST, 'utf8'));
    return Array.isArray(list) ? list : MANIFEST;
  } catch { return MANIFEST; }
}
const totalBytes = (manifest = MANIFEST) => manifest.reduce((sum, item) => sum + item.size, 0);

module.exports = { locate, missing, supported, toolsDir, readStatus, writeStatus, summarize, install, totalBytes, MANIFEST, WORDS, MODEL_Q5, MODEL_FULL, PACKAGE_TAG, PACKAGE_FILE };
