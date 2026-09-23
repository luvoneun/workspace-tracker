// 설정 › 꾸미기(개인별 — 이 맥에만)의 서버 쪽 한 벌: Dock 아이콘 그림 확인·저장·되돌리기, 이름 확인,
// Dock 앱을 다시 만들어 달라는 요청 표시 파일 쓰기.
//
// 지키는 것:
// - 그림은 **저장소의 `local/icon.png` 한 파일에만** 쓴다(업데이트해도 남는 자리). 되돌리기도 그 파일만 지운다.
// - 받은 바이트는 시그니처(PNG/JPEG)·크기(5MB 이하)·가로세로(128px 이상)를 확인한 뒤에만 쓴다.
// - 서버는 프로세스를 띄우지 않는다 — Dock 앱은 요청 표시 파일을 본 launchd 에이전트(app-refresh)가 다시 만든다.
//   Dock 프로세스도 다시 시작하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ICON_MAX_BYTES = 5 * 1024 * 1024;
const ICON_MIN_SIDE = 128;
const DOCK_NAME_DEFAULT = 'Workspace';

const MESSAGE = {
  iconSize: '그림은 5MB까지 쓸 수 있어요',
  iconType: 'PNG나 JPG 그림만 쓸 수 있어요',
  iconSide: '가로세로 128px 이상인 그림을 골라 주세요',
  dockName: 'Dock 이름은 1~30자로 적어 주세요 — / : 와 줄바꿈은 쓸 수 없어요',
  title: '워크스페이스 제목은 1~40자로 적어 주세요',
  nothing: '바꿀 것이 없어요',
};

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const length = value => [...value].length;

// Dock 이름(`~/Applications/<이름>.app`이 된다). 경로를 만들 수 없는 글자(`/`·`:`·줄바꿈)와
// 점으로 시작하는 이름(숨은 파일)은 받지 않는다.
function checkDockName(value) {
  const name = trimmed(value);
  if (!name || length(name) > 30 || /[/:\r\n\t\0]/.test(name) || name.startsWith('.')) throw bad(MESSAGE.dockName);
  return name;
}

// 화면 헤더·탭 제목(config `title`).
function checkTitle(value) {
  const title = trimmed(value);
  if (!title || length(title) > 40 || /[\r\n\0]/.test(title)) throw bad(MESSAGE.title);
  return title;
}

// 그림 바이트 → { type, width, height } (모르는 형식이면 null). PNG는 IHDR, JPEG는 SOF 표지에서 읽는다.
function imageInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.subarray(0, 8).equals(png) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at += 1; continue; }
      const marker = buffer[at + 1];
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const size = buffer.readUInt16BE(at + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return { type: 'jpeg', width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) };
      at += 2 + size;
    }
    return null;
  }
  return null;
}

function checkIcon(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad(MESSAGE.iconType);
  if (buffer.length > ICON_MAX_BYTES) throw bad(MESSAGE.iconSize);
  const info = imageInfo(buffer);
  if (!info) throw bad(MESSAGE.iconType);
  if (info.width < ICON_MIN_SIDE || info.height < ICON_MIN_SIDE) throw bad(MESSAGE.iconSide);
  return info;
}

const iconPath = localDir => path.join(localDir, 'icon.png');

// `local/icon.png`에 원자적으로 쓴다(같은 폴더의 임시 파일 → 이름 바꾸기). 다른 파일은 건드리지 않는다.
function saveIcon(localDir, buffer) {
  const info = checkIcon(buffer);
  fs.mkdirSync(localDir, { recursive: true });
  const target = iconPath(localDir);
  const temp = path.join(localDir, `.icon.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, buffer, { mode: 0o644 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return info;
}

// 기본 토끼로 되돌리기 — `local/icon.png` **한 파일만** 지운다. 없으면 아무 일도 없다.
function resetIcon(localDir) {
  const target = iconPath(localDir);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

const hasCustomIcon = localDir => fs.existsSync(iconPath(localDir));

// `/app-icon.png`가 줄 파일 — 내 그림이 있으면 그것, 없으면 기본 토끼.
function currentIcon(localDir, appDir) {
  const custom = iconPath(localDir);
  const file = fs.existsSync(custom) ? custom : path.join(appDir, 'icons', 'icon-512.png');
  const data = fs.readFileSync(file);
  const info = imageInfo(data);
  return { data, type: info && info.type === 'jpeg' ? 'image/jpeg' : 'image/png', custom: file === custom };
}

// Dock 앱을 다시 만들어 달라는 표시 파일. launchd 에이전트 `com.workspace.app.app-refresh`가 이 파일이
// 바뀌는 것을 보고 `app-refresh.sh`를 한 번 돌린다(미팅 노트 가져오기와 같은 방식). 내용은 기록용일 뿐이다.
function writeRefreshRequest(automationDir, reason) {
  const file = path.join(automationDir, 'requests', 'app-refresh.request');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ requestedAt: new Date().toISOString(), reason: String(reason || '') })}\n`);
  return file;
}

// 홈 폴더를 `~`로 줄인 경로(화면에 보여 줄 때). 사람 이름이 든 홈 경로를 그대로 내보내지 않는다.
function tildePath(value, home) {
  const text = String(value || '');
  const base = String(home || '');
  if (base && (text === base || text.startsWith(`${base}/`))) return `~${text.slice(base.length)}`;
  return text;
}

module.exports = {
  ICON_MAX_BYTES, ICON_MIN_SIDE, DOCK_NAME_DEFAULT, PERSONALIZE_MESSAGE: MESSAGE,
  checkDockName, checkTitle, imageInfo, checkIcon, saveIcon, resetIcon, hasCustomIcon, currentIcon,
  writeRefreshRequest, tildePath,
};
