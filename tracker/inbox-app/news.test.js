// 쉬운 말 소식(WP-J) — 순수 파서 news.js. 네트워크는 전부 가짜 request로 주입한다(진짜 fetch 없음).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseNews, newsFor, fetchRemoteNewsText, NEWS_MAX_LINES, NEWS_MAX_LINE_LEN } = require('./news');

test('형식대로 버전·날짜·줄 목록을 뽑는다(최신이 위, 파일 순서 그대로)', () => {
  const text = [
    '## v1.1.4 · 2026-09-28',
    '- Dock 아이콘을 눌러도 창이 하나만 떠요',
    '- **굵게**는 요소로만 표시해요',
    '',
    '## v1.1.0 · 2026-09-24',
    '- 설정이 연동 · 앱 · 꾸미기로 정리됐어요',
  ].join('\n');
  const entries = parseNews(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { version: '1.1.4', date: '2026-09-28', lines: ['Dock 아이콘을 눌러도 창이 하나만 떠요', '**굵게**는 요소로만 표시해요'] });
  assert.equal(entries[1].version, '1.1.0');
});

test('굵게(**…**)는 글자 그대로 남기고, 그 밖의 마크다운·HTML도 해석하지 않는다', () => {
  const entries = parseNews('## v1.0.0 · 2026-09-24\n- <b>주의</b> _기울임_처럼 보이는 글자와 **정말 굵은 글자**\n');
  assert.equal(entries[0].lines[0], '<b>주의</b> _기울임_처럼 보이는 글자와 **정말 굵은 글자**');
});

test('줄은 최대 8개까지만 담는다', () => {
  const bullets = Array.from({ length: 12 }, (_, i) => `- 줄 ${i + 1}`).join('\n');
  const entries = parseNews(`## v1.0.0 · 2026-09-24\n${bullets}\n`);
  assert.equal(entries[0].lines.length, NEWS_MAX_LINES);
  assert.equal(entries[0].lines[NEWS_MAX_LINES - 1], `줄 ${NEWS_MAX_LINES}`);
});

test('줄 하나는 200자에서 자른다', () => {
  const long = '가'.repeat(500);
  const entries = parseNews(`## v1.0.0 · 2026-09-24\n- ${long}\n`);
  assert.equal(entries[0].lines[0].length, NEWS_MAX_LINE_LEN);
});

test('깨진 줄(머리줄 모양이 다르거나 -로 시작하지 않는 줄)은 조용히 건너뛴다', () => {
  const text = [
    '# 소식',                          // 첫 머리줄 전 — 무시
    '## v1.1 · 2026-09-24',            // 세 자리가 아니라 머리줄로 안 잡힘
    '- 이 줄은 아직 버전이 없어 버려진다',
    '## v1.0.0 · 2026-09-24',
    '이 줄은 - 로 시작하지 않아 버려진다',
    '',
    '- 살아남는 줄',
    '-빈칸이 없어도 형식은 지킨다',        // "- " 뒤 공백 없음 — 스펙 형식과 다르니 버려짐
  ].join('\n');
  const entries = parseNews(text);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].lines, ['살아남는 줄']);
});

test('문자열이 아니거나 비어 있으면 빈 목록', () => {
  assert.deepEqual(parseNews(''), []);
  assert.deepEqual(parseNews(null), []);
  assert.deepEqual(parseNews(undefined), []);
});

test('newsFor는 v 접두가 있든 없든 그 버전만 찾는다', () => {
  const entries = parseNews('## v1.1.4 · 2026-09-28\n- a\n## v1.1.0 · 2026-09-24\n- b\n');
  assert.equal(newsFor(entries, '1.1.0').lines[0], 'b');
  assert.equal(newsFor(entries, 'v1.1.4').lines[0], 'a');
  assert.equal(newsFor(entries, '9.9.9'), null);
});

// ---------- 원격 읽기(가짜 fetch만, 진짜 네트워크 없음) ----------

test('원격 성공 — raw.githubusercontent.com 주소로 태그의 소식.md를 읽는다', async () => {
  let calledUrl = null;
  let calledOpts = null;
  const request = async (url, opts) => {
    calledUrl = url;
    calledOpts = opts;
    return { ok: true, headers: { get: () => '120' }, arrayBuffer: async () => Buffer.from('## v1.1.4 · 2026-09-28\n- 새 줄\n', 'utf8') };
  };
  const text = await fetchRemoteNewsText({ owner: 'luvon', repo: 'workspace', ref: 'v1.1.4', request });
  assert.equal(calledUrl, 'https://raw.githubusercontent.com/luvon/workspace/v1.1.4/%EC%86%8C%EC%8B%9D.md');
  assert.ok(calledOpts && calledOpts.signal, '시간 제한 신호를 함께 보낸다');
  assert.match(text, /새 줄/);
});

test('원격 실패(네트워크 오류)는 조용히 null', async () => {
  const request = async () => { throw new TypeError('network down'); };
  const text = await fetchRemoteNewsText({ owner: 'a', repo: 'b', ref: 'main', request });
  assert.equal(text, null);
});

test('원격이 404 등 실패 상태면 null', async () => {
  const request = async () => ({ ok: false, status: 404, headers: { get: () => null } });
  const text = await fetchRemoteNewsText({ owner: 'a', repo: 'b', ref: 'v9.9.9', request });
  assert.equal(text, null);
});

test('github이 아니면(owner·repo·ref 중 하나라도 없으면) 묻지 않는다', async () => {
  let called = false;
  const request = async () => { called = true; return { ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('') }; };
  assert.equal(await fetchRemoteNewsText({ owner: '', repo: 'b', ref: 'main', request }), null);
  assert.equal(await fetchRemoteNewsText({ owner: 'a', repo: '', ref: 'main', request }), null);
  assert.equal(await fetchRemoteNewsText({ owner: 'a', repo: 'b', ref: '', request }), null);
  assert.equal(called, false);
});

test('200KB를 넘으면(헤더로 미리 알든 실제 크기로 나중에 알든) null', async () => {
  const bigHeader = async () => ({ ok: true, headers: { get: (name) => (name === 'content-length' ? String(300 * 1024) : null) }, arrayBuffer: async () => { throw new Error('여기까지 오면 안 된다'); } });
  assert.equal(await fetchRemoteNewsText({ owner: 'a', repo: 'b', ref: 'main', request: bigHeader }), null);

  const bigBody = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(300 * 1024) });
  assert.equal(await fetchRemoteNewsText({ owner: 'a', repo: 'b', ref: 'main', request: bigBody }), null);
});
