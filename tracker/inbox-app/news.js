// 쉬운 말 소식(패치노트, WP-J) — 저장소 뿌리 `소식.md` 한 파일을 파싱하고, 새 버전이 있을 때는
// 원격(github.com)의 그 태그(또는 main) `소식.md`도 읽는다.
//
// 지키는 것:
// - 파서는 순수 함수다(파일도 네트워크도 건드리지 않는다) — 버전·날짜·줄 목록만 뽑는다.
// - 줄은 글자만 옮긴다. 굵게(`**…**`)만 나중에(화면에서) 요소로 바꾸고, 그 밖의 마크다운·HTML은
//   그대로 글자로 둔다(여기서도 화면에서도 해석하지 않는다).
// - 원격 읽기는 10초·200KB 상한이고 실패하면 조용히 `null`이다 — 프로세스를 새로 띄우지 않고 fetch만 쓴다.
const NEWS_FILE_NAME = '소식.md';
const NEWS_MAX_VERSIONS = 10;   // GET /api/about의 news가 담는 최근 버전 수
const NEWS_MAX_LINES = 8;       // 버전 하나당 줄 최대 개수
const NEWS_MAX_LINE_LEN = 200;  // 줄 하나당 최대 글자 수
const NEWS_TIMEOUT_MS = 10000;
const NEWS_MAX_BYTES = 200 * 1024;

const NEWS_HEAD_RE = /^##\s+v(\d+\.\d+\.\d+)\s*·\s*(\d{4}-\d{2}-\d{2})\s*$/;
const NEWS_BULLET_RE = /^-\s+(.+?)\s*$/;

// `소식.md`(또는 원격에서 받은 같은 형식의 글) → [{ version, date, lines }], 최신이 위(파일 순서 그대로).
// 형식이 깨진 줄(머리줄 모양이 다르거나 `- `로 시작하지 않는 줄)은 조용히 건너뛴다.
function parseNews(text) {
  if (typeof text !== 'string') return [];
  const versions = [];
  let current = null;
  text.split(/\r?\n/).forEach((raw) => {
    const head = NEWS_HEAD_RE.exec(raw);
    if (head) {
      current = { version: head[1], date: head[2], lines: [] };
      versions.push(current);
      return;
    }
    if (!current) return; // 첫 머리줄 전에 나온 글(제목 등)은 무시
    const bullet = NEWS_BULLET_RE.exec(raw);
    if (!bullet) return;
    if (current.lines.length >= NEWS_MAX_LINES) return;
    const line = bullet[1].slice(0, NEWS_MAX_LINE_LEN);
    if (line) current.lines.push(line);
  });
  return versions;
}

// 파싱한 목록에서 한 버전(`v` 접두 있어도 없어도 됨)의 줄만 — release.sh의 검사·원격 한 벌이 같이 쓴다.
function newsFor(entries, version) {
  const bare = String(version || '').replace(/^v/, '');
  return (entries || []).find((entry) => entry.version === bare) || null;
}

// 원격 저장소(github.com raw)의 태그(또는 main) `소식.md`를 읽는다. 실패는 무엇이든 조용히 `null`이다
// (파일이 없음·시간 초과·너무 큼·네트워크 오류 전부). `request`는 테스트가 진짜 네트워크 없이 주입한다.
async function fetchRemoteNewsText({ owner, repo, ref, request = (...args) => fetch(...args) } = {}) {
  if (!owner || !repo || !ref) return null;
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodeURIComponent(NEWS_FILE_NAME)}`;
  let response;
  try {
    response = await request(url, { signal: AbortSignal.timeout(NEWS_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!response || !response.ok) return null;
  const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > NEWS_MAX_BYTES) return null;
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > NEWS_MAX_BYTES) return null;
    return Buffer.from(buffer).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = {
  NEWS_FILE_NAME, NEWS_MAX_VERSIONS, NEWS_MAX_LINES, NEWS_MAX_LINE_LEN, NEWS_MAX_BYTES,
  parseNews, newsFor, fetchRemoteNewsText,
};
