// 슬랙 수집 한 회차 — slack-capture.sh가 잠금을 잡은 뒤 부른다(Node 기본 모듈만).
//
//   node slack-collect.js <설정 파일> <상태 파일> <로그 파일> <run-task.sh>
//
// 가져오기·저장은 이 스크립트가 하고, Claude는 도구 없이 분류만 한다(DECISIONS 2026-09-28).
// 예전에는 Claude가 Bash로 조회 스크립트·import-record.js를 직접 불렀는데, Claude Code 버전과 명령 모양에 따라
// 허용 목록 검사가 그 명령을 막아(“자동 분류기가 막음”) 수집이 통째로 멈췄다.
//  1) 켜진 채널마다 커서·since 이후 메시지를 끝 페이지까지 읽는다. 실패한 채널은 커서를 올리지 않는다.
//  2) 공유(포워드)된 메시지는 원본 스레드 전체를 사용자 토큰으로 읽어 붙인다(못 읽으면 `threadError`).
//  3) 채널별 입력 JSON + 지침 파일을 프롬프트에 넣어 run-task.sh로 Claude를 부른다(허용 도구 없음).
//  4) Claude가 낸 JSON을 검증하고, 맞으면 import-record.js로 하나씩 저장한다. 모두 성공한 채널만 커서를 올린다.
// 설정 `slack.tidy`가 'raw'(원문 그대로)면 2)·3)을 건너뛰고 규칙으로 답을 만든다(rawAnswer) — Claude가 없어도 돈다.
// 칸이 없으면 'claude'다. Claude 모드에서 분류가 실패하면 원문으로 대신 넣지 않는다(실패 기록·커서 그대로).
// 토큰은 슬랙 요청 머리글에만 쓴다 — 프롬프트·로그에 싣지 않는다. 로그에는 채널별 수치와 항목 문구만 남긴다.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { history } = require('./slack-history');

const APP_DIR = __dirname;
const WORKSPACE_DIR = path.resolve(APP_DIR, '..', '..');
// 설정 칸 → 커서 이름·항목 종류·지침 파일. 처리 순서도 이 순서다(예전 Claude가 지침을 읽던 순서).
const CHANNELS = {
  todo: { cursor: 'my-todo', type: 'task', skill: 'slack-todos.md' },
  align: { cursor: 'my-align', type: 'decision', skill: 'slack-alignments.md' },
  someday: { cursor: 'my-someday', type: 'idea', skill: 'slack-someday.md' },
  waiting: { cursor: 'my-waiting', type: 'check', skill: 'slack-waiting.md' },
};
// 항목 종류마다 서버(`/api/import`)가 받아 쓰는 칸. 여기 없는 칸은 버린다.
const FIELDS = {
  task: ['priority', 'due', 'jira', 'group'],
  check: ['priority', 'who', 'due', 'jira', 'group'],
  decision: ['priority', 'jira', 'group'],
  idea: ['priority', 'project'],
};
// 중복 판단에 보여 줄 기존 항목 종류(예전 지침이 훑던 파일과 같다).
const EXISTING_TYPES = {
  task: ['task', 'check'],
  decision: ['decision'],
  idea: ['idea', 'task'],
  check: ['check', 'task', 'decision'],
};
const SYSTEM_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_name', 'channel_purpose', 'channel_topic',
  'pinned_item', 'unpinned_item', 'message_changed', 'message_deleted', 'bot_message', 'channel_archive', 'channel_unarchive']);
// 크기 상한 — 한 번에 넣는 메시지 수와 입력 글자 수. 넘치면 앞(오래된 것)부터 잘라 넣고 나머지는 다음 회차로.
const MAX_MESSAGES = Number(process.env.SLACK_COLLECT_MAX_MESSAGES) || 50;
const MAX_INPUT_CHARS = Number(process.env.SLACK_COLLECT_MAX_CHARS) || 100000;
const MAX_EXISTING = 300;
const MAX_USERS = 50;
const TEXT_LIMIT = 3000;
const REPLY_LIMIT = 1500;
const THREAD_HEAD = 20;
const THREAD_TAIL = 40;
// Claude가 도구를 쓰지 못하게 확실히 막는다(허용 목록은 비운다 — 허용이 아니라 "자동 승인" 목록이라 막는 쪽도 적는다).
const DENY_TOOLS = 'Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,mcp__slack';

const TS_RE = /^[0-9]+[.][0-9]+$/;
const tsValue = ts => { const [s, f] = String(ts).split('.'); return BigInt(s) * 1000000n + BigInt((f + '000000').slice(0, 6)); };
const tsCompare = (a, b) => { const x = tsValue(a), y = tsValue(b); return x < y ? -1 : x > y ? 1 : 0; };
const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayOf = ts => stamp(new Date(Number(String(ts).split('.')[0]) * 1000)).slice(0, 10);
const clip = (text, limit) => { const s = String(text == null ? '' : text); return s.length > limit ? `${s.slice(0, limit)}…(생략)` : s; };
const oneLine = (text, limit = 80) => clip(String(text || '').replace(/\s+/g, ' ').trim(), limit);
// 로그 시작 줄 끝의 `(v1.1.2)` — 이 회차를 돌린 앱 버전(설치 폴더의 VERSION). 못 읽거나 모양이 이상하면 붙이지 않는다.
const versionTag = () => {
  let version = '';
  try { version = fs.readFileSync(path.join(WORKSPACE_DIR, 'VERSION'), 'utf8').trim(); } catch { version = ''; }
  return /^[0-9A-Za-z.+-]{1,20}$/.test(version) ? ` (v${version})` : '';
};
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 분류가 필요 없는 메시지(갈래 ①): 시스템 메시지와 봇 메시지 — 지침의 규칙 그대로.
function isSystem(message) {
  if (!message || typeof message !== 'object') return true;
  if (message.subtype && SYSTEM_SUBTYPES.has(message.subtype)) return true;
  return !!(message.bot_id && !message.user);
}

async function slackGet(token, method, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  // 요청 한도·서버 오류는 "원본을 못 읽음"이 아니라 이번 회차 실패다(다음 회차에 다시 읽는다).
  if (!response.ok) { const error = new Error(`Slack HTTP ${response.status}`); error.retry = true; throw error; }
  const body = await response.json();
  if (!body || body.ok !== true) {
    const error = new Error(`Slack: ${(body && body.error) || 'unknown'}`);
    error.retry = !body || body.error === 'ratelimited' || body.error === 'internal_error' || body.error === 'fatal_error';
    throw error;
  }
  return body;
}

// 원본 스레드 전체(댓글을 공유했으면 그 댓글이 속한 스레드). 슬랙이 거절하면(권한·채널 없음 등) null.
async function readThread(token, channel, threadTs) {
  const messages = [], seen = new Set();
  let cursor = '';
  for (let page = 0; page < 5; page += 1) {
    const params = { channel, ts: threadTs, limit: 200 };
    if (cursor) params.cursor = cursor;
    let body;
    try { body = await slackGet(token, 'conversations.replies', params); }
    catch (error) { if (error.retry || !/^Slack: /.test(error.message)) throw error; return { error: error.message.slice(7) }; }
    if (Array.isArray(body.messages)) messages.push(...body.messages);
    cursor = (body.response_metadata && body.response_metadata.next_cursor) || '';
    if (!cursor || seen.has(cursor)) { cursor = ''; break; }
    seen.add(cursor);
  }
  // 5쪽(1,000개)을 넘는 스레드는 앞부분만 읽었다 — 전부 읽은 것처럼 넘기지 않고 표시한다(Codex 검토).
  return { messages, truncated: !!cursor };
}

function shareSource(attachment) {
  const fromUrl = typeof attachment.from_url === 'string' ? attachment.from_url : '';
  let threadTs = '';
  try { threadTs = new URL(fromUrl).searchParams.get('thread_ts') || ''; } catch { threadTs = ''; }
  const permalink = fromUrl.split('?')[0];
  return {
    permalink: /^https:\/\/[^\s"<>]+$/.test(permalink) ? permalink : '',
    channel: attachment.channel_id || '',
    threadTs: TS_RE.test(threadTs) ? threadTs : (TS_RE.test(String(attachment.ts || '')) ? String(attachment.ts) : ''),
  };
}

const mentionIds = text => [...String(text || '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(match => match[1]);
const withNames = (text, names) => String(text || '').replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (whole, id) => (names[id] ? `@${names[id]}` : whole));

// 이름 찾기는 있으면 좋은 정도다 — 권한(users:read)이 없거나 실패하면 id를 그대로 둔다.
async function lookupNames(token, ids) {
  const names = {};
  for (const id of [...new Set(ids)].slice(0, MAX_USERS)) {
    try {
      const body = await slackGet(token, 'users.info', { user: id });
      const user = body.user || {}, profile = user.profile || {};
      const name = profile.display_name || user.real_name || profile.real_name || user.name;
      if (name) names[id] = String(name).slice(0, 80);
    } catch { /* 이름 없이 진행 */ }
  }
  return names;
}

// 한 메시지의 분류 재료. 공유면 원본 스레드까지 읽는다(재시도해야 하는 실패는 위로 던져 채널을 실패시킨다).
async function gather(token, channel, message) {
  const ownLink = `${channel.workspaceUrl}/archives/${channel.id}/p${String(message.ts).replace('.', '')}`;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const shared = attachments.filter(one => one && one.is_share === true);
  const entry = {
    ts: message.ts,
    date: dayOf(message.ts),
    kind: shared.length ? 'share' : 'memo',
    permalink: ownLink,
    text: clip(message.text, TEXT_LIMIT),
  };
  if (message.edited) entry.edited = true;
  if (message.subtype) entry.subtype = message.subtype;
  const files = (Array.isArray(message.files) ? message.files : []).map(file => file && (file.title || file.name)).filter(Boolean);
  if (files.length) entry.files = files.slice(0, 10).map(name => clip(name, 200));
  const previews = attachments.filter(one => one && one.is_share !== true)
    .map(one => ({ title: clip(one.title || '', 300), text: clip(one.text || '', 800), fallback: clip(one.fallback || '', 300) }))
    .filter(one => one.title || one.text || one.fallback);
  if (previews.length) entry.attachments = previews.slice(0, 5);
  const users = mentionIds(message.text);
  if (shared.length) {
    entry.shares = [];
    for (const attachment of shared) {
      const source = shareSource(attachment);
      const share = {
        permalink: source.permalink,
        author: clip(attachment.author_name || attachment.author_subname || '', 80),
        channelName: clip(attachment.channel_name || '', 80),
        text: clip(attachment.text || attachment.fallback || '', TEXT_LIMIT),
      };
      if (!source.channel || !source.threadTs) {
        share.threadError = '원본 스레드를 못 읽음(원본 위치 없음)';
      } else {
        const thread = await readThread(token, source.channel, source.threadTs);
        if (thread.error) {
          share.threadError = `원본 스레드를 못 읽음(${thread.error})`;
        } else {
          const all = thread.messages.map(reply => ({ user: reply.user || reply.username || '', ts: reply.ts, text: clip(reply.text, REPLY_LIMIT) }));
          let kept = all;
          if (all.length > THREAD_HEAD + THREAD_TAIL) {
            kept = [...all.slice(0, THREAD_HEAD), ...all.slice(-THREAD_TAIL)];
            share.threadOmitted = all.length - kept.length;
          }
          if (thread.truncated) share.threadIncomplete = '스레드가 너무 길어 앞 1,000개까지만 읽었어요 — 뒷부분은 없어요';
          share.thread = kept;
          kept.forEach(reply => { if (/^[UW][A-Z0-9]+$/.test(reply.user)) users.push(reply.user); users.push(...mentionIds(reply.text)); });
        }
      }
      users.push(...mentionIds(share.text));
      entry.shares.push(share);
    }
  }
  return { entry, users };
}

function applyNames(entry, names) {
  entry.text = withNames(entry.text, names);
  (entry.shares || []).forEach(share => {
    share.text = withNames(share.text, names);
    (share.thread || []).forEach(reply => { if (names[reply.user]) reply.user = names[reply.user]; reply.text = withNames(reply.text, names); });
  });
}

function allowedLinks(entry) {
  return new Set([entry.permalink, ...(entry.shares || []).map(share => share.permalink).filter(Boolean)]);
}

// Claude의 답 검증 — 모양·필수 칸·길이. 하나라도 어긋나면 이번 채널은 실패(커서 그대로·저장 없음).
function validate(text, entries, type) {
  let raw = String(text || '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(raw);
  if (fenced) raw = fenced[1].trim();
  let answer;
  try { answer = JSON.parse(raw); } catch { throw new Error('답이 JSON이 아니에요'); }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('답의 모양이 달라요');
  if (!Array.isArray(answer.items) || !Array.isArray(answer.skipped)) throw new Error('items·skipped 목록이 없어요');
  const byTs = new Map(entries.map(entry => [entry.ts, entry]));
  if (answer.items.length > entries.length * 5 || answer.skipped.length > entries.length * 5) throw new Error('항목이 너무 많아요');
  const covered = new Set();
  const items = answer.items.map((item, index) => {
    const where = `items[${index}]`;
    if (!item || typeof item !== 'object') throw new Error(`${where} 모양이 달라요`);
    const entry = byTs.get(item.ts);
    if (!entry) throw new Error(`${where}.ts가 입력에 없어요`);
    if (item.type !== undefined && item.type !== type) throw new Error(`${where}.type이 채널과 달라요`);
    const { description, permalink } = item;
    if (typeof description !== 'string' || !description.trim() || description.length > 1000 || /[\r\n]/.test(description)) throw new Error(`${where}.description은 1,000자 이내 한 줄이어야 해요`);
    if (typeof permalink !== 'string' || !allowedLinks(entry).has(permalink)) throw new Error(`${where}.permalink가 입력의 링크가 아니에요`);
    const saved = { type, description: description.trim(), permalink };
    for (const key of FIELDS[type]) {
      const value = item[key];
      if (value == null || value === '') continue;
      if (typeof value !== 'string' || value.length > 250 || /[\r\n[\]]/.test(value)) throw new Error(`${where}.${key} 값을 확인해 주세요`);
      if (key === 'due' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${where}.due는 YYYY-MM-DD여야 해요`);
      if (key === 'priority' && !['low', 'medium', 'high', 'critical'].includes(value)) throw new Error(`${where}.priority 값을 확인해 주세요`);
      if (key === 'jira' && !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value)) throw new Error(`${where}.jira 값을 확인해 주세요`);
      saved[key] = value;
    }
    const notes = item.notes == null ? [] : item.notes;
    if (!Array.isArray(notes) || notes.length > 5 || notes.some(note => typeof note !== 'string' || note.length > 200)) throw new Error(`${where}.notes 모양이 달라요`);
    covered.add(item.ts);
    return { ts: item.ts, payload: saved, notes };
  });
  const skipped = answer.skipped.map((skip, index) => {
    const where = `skipped[${index}]`;
    if (!skip || typeof skip !== 'object' || !byTs.has(skip.ts)) throw new Error(`${where}.ts가 입력에 없어요`);
    if (typeof skip.reason !== 'string' || !skip.reason.trim() || skip.reason.length > 100) throw new Error(`${where}.reason을 확인해 주세요`);
    if (skip.existing != null && (typeof skip.existing !== 'string' || skip.existing.length > 1000)) throw new Error(`${where}.existing을 확인해 주세요`);
    covered.add(skip.ts);
    return { ts: skip.ts, reason: skip.reason.trim(), existing: skip.existing || '' };
  });
  const missing = entries.filter(entry => !covered.has(entry.ts));
  if (missing.length) throw new Error(`처리 대장이 모자라요(${missing.length}개 메시지가 빠짐)`);
  return { items, skipped };
}

// ---------- 원문 그대로 모드(`slack.tidy: 'raw'`) ----------
// Claude 없이 규칙으로 답(`validate`가 내는 모양과 같은 `{ items, skipped }`)을 만든다. 갈래는 채널이 정하고,
// 요약·중요도 판단·기한·지라 연결은 하지 않는다(DECISIONS: 마감일 추측 금지·슬랙 포함 판단 안 함).
const RAW_LIMIT = 200;
const RAW_SHORT = 12;
// 슬랙 표기를 읽는 글로 — 사람·채널·링크·굵게/기울임/취소/코드 기호·그림 글자(:emoji:)는 지운다, &amp; 등은 되돌린다.
function slackPlain(text, names = {}) {
  return String(text || '')
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (whole, id, label) => `@${names[id] || label || id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (whole, name) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, (whole, id) => `#${id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (whole, label) => label || '@그룹')
    .replace(/<!([a-z]+)(?:\|([^>]*))?>/g, (whole, word, label) => label || `@${word}`)
    .replace(/<([^<>|\s]+)\|([^<>]+)>/g, (whole, url, label) => label)
    .replace(/<((?:https?|mailto):[^<>\s]+)>/g, (whole, url) => url.replace(/^mailto:/, ''))
    .replace(/```/g, '')
    .replace(/`/g, '')
    // 그림 글자·굵게·취소선은 슬랙처럼 앞뒤가 단어 경계일 때만 — `3~5명`, `2*3*4`, `api:v2:x` 같은 글자를 망가뜨리지 않게.
    .replace(/(^|\s)(?::[a-z0-9_+'-]+:)+(?=$|\s)/gm, '$1')
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?])/gm, '$1$2')
    .replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s).,!?])/gm, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, '$1$2')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// 비어 있지 않은 줄들(앞 인용 기호·목록 기호를 떼고 공백을 한 칸으로). `list`는 목록 기호가 붙어 있던 줄인지.
const LIST_MARK = /^\s*(?:[-•*·◦▪]|\d+[.)])\s+/;
const plainLines = text => String(text || '').split(/\r?\n/)
  .map(line => line.replace(/^\s*>\s?/, ''))
  .map(line => ({ list: LIST_MARK.test(line), text: line.replace(LIST_MARK, '').replace(/\s+/g, ' ').trim() }))
  .filter(line => line.text);
// 첫 줄 — 12자 이하면(인사말 등) 다음 줄을 한 번 이어 붙인다. 한 메시지는 항목 하나다(목록이어도 나누지 않고,
// 목록의 첫 항목은 짧아도 다음 항목을 붙이지 않는다 — 두 일이 한 문구로 섞이지 않게).
function firstLine(text) {
  const lines = plainLines(text);
  if (!lines.length) return '';
  const [first, next] = lines;
  return first.text.length <= RAW_SHORT && next && !first.list ? `${first.text} ${next.text}` : first.text;
}
// 글이 없고 파일만 있으면: 설명(alt·파일 이름과 다른 제목)이 있으면 그것, 없으면 `(파일) 이름`.
function fileLine(files) {
  const file = (Array.isArray(files) ? files : []).find(one => one && (one.alt_txt || one.title || one.name));
  if (!file) return '';
  const alt = String(file.alt_txt || (file.title && file.title !== file.name ? file.title : '')).replace(/\s+/g, ' ').trim();
  return alt || `(파일) ${String(file.name || file.title).replace(/\s+/g, ' ').trim()}`;
}
const rawClip = text => (text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT).trimEnd()}…` : text);

// 메시지 하나 → 저장할 항목 하나. 링크는 원래 메시지(공유면 원본) 우선.
function rawItem(channel, message, names) {
  const ownLink = `${channel.workspaceUrl}/archives/${channel.id}/p${String(message.ts).replace('.', '')}`;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const share = attachments.find(one => one && one.is_share === true) || null;
  // 공유하며 적은 메모는 딱 첫 줄만 뒤에 붙인다(짧아도 이어 붙이지 않는다). 공유가 아니면 메시지 글이 곧 문구다.
  const memo = share ? ((plainLines(slackPlain(message.text, names))[0] || {}).text || '') : '';
  let body = firstLine(slackPlain(share ? (share.text || share.fallback) : message.text, names));
  const notes = [];
  if (!body) {
    body = fileLine(share && Array.isArray(share.files) && share.files.length ? share.files : message.files);
    if (body) notes.push('파일만');
  }
  if (!body && !share) {
    const preview = attachments.find(one => one && (one.title || one.fallback));
    body = preview ? firstLine(slackPlain(preview.title || preview.fallback, names)) : '';
  }
  // 원래 메시지 글도 파일도 없는 공유면 내 메모가 곧 문구다.
  const memoOnly = !body && !!memo;
  if (memoOnly) body = memo;
  // 공유도 파일도 없이 이모지·기호만 남은 메시지(예: `:+1:`)는 할 일로 넣지 않는다 — 건너뜀으로 기록한다.
  if (!body && !share) return { ts: message.ts, empty: true };
  if (!body) body = '(글 없는 메시지)';
  const description = rawClip(memo && !memoOnly ? `${body} — ${memo}` : body);
  const source = share ? shareSource(share) : null;
  // 링크: 공유할 때 메모를 적었으면 내가 보낸 메시지 링크 — 같은 원본을 다른 메모로 다시 공유해도 따로 남게(링크 중복으로
  // 버려지지 않게). 메모 없는 공유는 원본 링크 — 같은 원본을 또 보내면 링크 중복으로 한 번만 들어간다.
  const payload = { type: channel.type, description, permalink: (memo ? ownLink : (source && source.permalink)) || ownLink };
  // 확인 대기의 담당자(who)는 넣지 않는다 — 원래 글쓴이가 답할 사람인지 답을 기다리는 사람인지 규칙으로는 알 수 없다(추측 금지).
  return { ts: message.ts, payload, notes };
}

function rawAnswer(channel, messages, names) {
  const all = messages.map(message => rawItem(channel, message, names));
  return { items: all.filter(one => !one.empty), skipped: all.filter(one => one.empty).map(() => ({ reason: '글 없음' })) };
}

function buildPrompt(skillText, input) {
  return [
    '너는 슬랙 수집의 분류 단계다. 도구는 쓰지 않는다 — 필요한 재료(메시지·원본 스레드·기존 항목)는 모두 아래 입력 JSON에 들어 있다.',
    '아래 지침의 분류 규칙을 따르고, 지침의 "출력" 절에 적힌 JSON 하나만 답한다. 코드 블록·설명 문장 없이 `{`로 시작해 `}`로 끝나는 JSON만 출력한다.',
    '',
    '## 지침',
    skillText.trim(),
    '',
    '## 입력 JSON',
    JSON.stringify(input),
  ].join('\n');
}

// claude가 자기 로그인에 대해 남기는 말(server.js의 CLAUDE_AUTH_RE와 같은 목록). 찾으면 그 말, 없으면 ''.
const CLAUDE_AUTH_PHRASES = [/Failed to authenticate\. API Error: 401/i, /OAuth session expired and could not be refreshed/i, /Invalid API key · Please run \/login/i];
function claudeAuthPhrase(text) {
  for (const re of CLAUDE_AUTH_PHRASES) { const hit = String(text || '').match(re); if (hit) return hit[0]; }
  return '';
}
// run-task.sh가 slack-classify 실행의 오류 출력을 쌓는 로그의 끝부분(없으면 '').
function classifyLogTail() {
  const dir = process.env.AUTOMATION_LOG_DIR || path.join(os.homedir(), '.local', 'share', 'workspace-automation', 'logs');
  try { const text = fs.readFileSync(path.join(dir, 'slack-classify.log'), 'utf8'); return text.slice(-4000); } catch { return ''; }
}

function runClassifier(runTask, prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-classify-'));
  const outFile = path.join(dir, 'answer.txt');
  const cleanup = () => { try { fs.rmSync(outFile, { force: true }); } catch {} try { fs.rmdirSync(dir); } catch {} };
  return new Promise(resolve => {
    const child = spawn('/bin/bash', [runTask, 'slack-classify', prompt, '', 'dontAsk', DENY_TOOLS], {
      cwd: WORKSPACE_DIR, env: { ...process.env, TASK_OUTPUT_FILE: outFile }, stdio: 'ignore',
    });
    child.on('error', error => { cleanup(); resolve({ status: -1, text: '', error: error.message }); });
    child.on('close', status => {
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
      cleanup();
      resolve({ status, text });
    });
  });
}

function importRecord(config, kind, payload) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(APP_DIR, 'import-record.js'), kind, JSON.stringify(payload)], {
      env: { ...process.env, WORKSPACE_CONFIG: config }, timeout: 30000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) { resolve({ ok: false }); return; }
      let result = null;
      try { result = JSON.parse(stdout); } catch { result = null; }
      resolve(result && result.ok === true ? result : { ok: false });
    });
  });
}

async function readAppItems(config) {
  const settings = readJson(config) || {};
  const port = Number(process.env.WORKSPACE_PORT || (settings.server && settings.server.port) || 4321);
  const response = await fetch(`http://127.0.0.1:${port}/api/items`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`앱 HTTP ${response.status}`);
  const body = await response.json();
  const refs = body && body.reportRefs && typeof body.reportRefs === 'object' ? Object.values(body.reportRefs) : [];
  const jira = Array.isArray(body && body.jiraIssues) ? body.jiraIssues : [];
  return {
    items: refs.filter(ref => ref && typeof ref.description === 'string').map(ref => ({
      type: ref.type, description: oneLine(ref.description, 200), status: ref.status || '', created: ref.created || '',
      ...(ref.permalink ? { permalink: ref.permalink } : {}),
    })),
    jira: jira.filter(issue => issue && issue.key).slice(0, MAX_EXISTING).map(issue => ({ key: String(issue.key), summary: oneLine(issue.summary, 150) })),
  };
}

// 한 채널의 새 메시지 처리. 결과: { line, detail[], ok }
async function processChannel(ctx, channel, messages) {
  const sorted = messages.filter(message => message && TS_RE.test(String(message.ts || ''))).sort((a, b) => tsCompare(a.ts, b.ts));
  const counts = { seen: 0, saved: 0, skipped: 0 };
  const reasons = {};
  const addReason = (reason, n = 1) => { reasons[reason] = (reasons[reason] || 0) + n; counts.skipped += n; };
  const detail = [];
  const ledger = { seen: 0, saved: 0, duplicate: 0, similar: 0, system: 0 };
  let batch = sorted.slice(0, MAX_MESSAGES);
  let human = batch.filter(message => !isSystem(message));
  let entries = [];
  let answer = { items: [], skipped: [] };
  let failure = '';
  let notes = 0;

  try {
    if (human.length && ctx.tidy === 'raw') {
      // 원문 그대로: Claude를 부르지 않는다(원본 스레드·기존 항목도 읽지 않는다 — 요약·중복 판단을 안 하므로).
      // 이름표만 찾아 `<@U…>`를 이름으로 바꾸고, 저장·링크 중복·커서는 아래 공통 길을 그대로 탄다.
      const users = [];
      human.forEach(message => {
        users.push(...mentionIds(message.text));
        (Array.isArray(message.attachments) ? message.attachments : []).forEach(one => { if (one && one.is_share === true) users.push(...mentionIds(one.text)); });
      });
      const names = await lookupNames(ctx.token, users);
      answer = rawAnswer(channel, human, names);
    } else if (human.length) {
      const gathered = [];
      const users = [];
      for (const message of human) {
        const one = await gather(ctx.token, channel, message);
        gathered.push(one.entry);
        users.push(...one.users);
      }
      const names = await lookupNames(ctx.token, users);
      gathered.forEach(entry => applyNames(entry, names));
      if (!ctx.app) ctx.app = await readAppItems(ctx.config);
      const types = EXISTING_TYPES[channel.type];
      const existing = ctx.app.items.filter(item => types.includes(item.type))
        .sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, MAX_EXISTING);
      const now = new Date();
      const makeInput = list => ({
        channel: channel.cursor,
        type: channel.type,
        today: `${stamp(now).slice(0, 10)} (${'일월화수목금토'[now.getDay()]})`,
        messages: list,
        existing,
        ...(channel.type === 'decision' ? { jiraIssues: ctx.app.jira } : {}),
      });
      // 입력이 너무 크면 앞(오래된 것)부터 절반씩 줄여 넣는다. 남은 메시지는 커서가 그 앞에서 멈춰 다음 회차에 읽힌다.
      let count = gathered.length;
      while (count > 1 && JSON.stringify(makeInput(gathered.slice(0, count))).length > MAX_INPUT_CHARS) count = Math.ceil(count / 2);
      entries = gathered.slice(0, count);
      if (count < gathered.length) {
        const lastTs = entries[entries.length - 1].ts;
        batch = batch.filter(message => tsCompare(message.ts, lastTs) <= 0);
        human = human.slice(0, count);
      }
      const skillText = fs.readFileSync(path.join(WORKSPACE_DIR, '.claude', 'skills', channel.skill), 'utf8');
      const run = await runClassifier(ctx.runTask, buildPrompt(skillText, makeInput(entries)));
      if (run.status !== 0) {
        // Claude 로그인이 풀려 실패했으면 claude가 남긴 그 말을 이 기록에 그대로 옮긴다 — 앱의 "로그인이 풀렸어요"
        // 안내(server.js CLAUDE_AUTH_RE)가 슬랙 수집 기록에서 이 말을 찾기 때문이다(Claude 출력은 slack-classify.log에 따로 쌓인다).
        const auth = claudeAuthPhrase(`${run.text || ''}\n${classifyLogTail()}`);
        throw new Error(`분류 실패(exit ${run.status})${auth ? ` — ${auth}` : ''}`);
      }
      try { answer = validate(run.text, entries, channel.type); }
      catch (error) { throw new Error(`분류 답을 쓸 수 없음 — ${error.message}`); }
    }
  } catch (error) {
    failure = error.message;
  }
  counts.seen = batch.length;
  const systemCount = batch.length - human.length;

  if (!failure) {
    if (systemCount) addReason('시스템', systemCount);
    answer.skipped.forEach(skip => {
      addReason(skip.reason);
      if (/링크/.test(skip.reason)) ledger.duplicate += 1; else if (skip.reason === '글 없음') ledger.system += 1; else ledger.similar += 1;
      // 설정 › 연동 › 슬랙 ⋯ › 최근 기록이 뽑아 보이는 모양(`🔁 이미 있는 '…'랑 …`) 그대로 남긴다.
      detail.push(skip.existing
        ? `🔁 이미 있는 '${oneLine(skip.existing)}'랑 중복돼서 안 가져왔어요`
        : `  - 건너뜀(${oneLine(skip.reason, 30)})`);
    });
    let saveFailed = 0;
    for (const item of answer.items) {
      const result = await importRecord(ctx.config, 'item', item.payload);
      if (!result.ok) { saveFailed += 1; detail.push(`  ! 저장 실패: ${oneLine(item.payload.description)}`); continue; }
      if (result.duplicate) { addReason('링크 중복'); ledger.duplicate += 1; detail.push(`  - 건너뜀(링크 중복): ${oneLine(item.payload.description)}`); continue; }
      counts.saved += 1;
      if (item.notes.length) notes += 1;
      detail.push(`  + ${oneLine(item.payload.description)}${item.notes.length ? ` (${item.notes.map(note => oneLine(note, 40)).join(' · ')})` : ''}`);
      if (item.notes.some(note => /원본/.test(note))) detail.push(`⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함: ${oneLine(item.payload.description, 60)}`);
      if (item.notes.some(note => /파일만/.test(note))) detail.push(`⚠️ 글 없이 파일만 있는 메시지: ${oneLine(item.payload.description, 60)}`);
      if (ctx.app) ctx.app.items.unshift({ type: item.payload.type, description: oneLine(item.payload.description, 200), status: 'to-do', created: stamp().slice(0, 10), permalink: item.payload.permalink });
    }
    if (saveFailed) failure = `저장 ${saveFailed}건 실패`;
  }

  if (!failure && batch.length) {
    const latest = batch[batch.length - 1].ts;
    const moved = await importRecord(ctx.config, 'cursor', { channel: channel.cursor, ts: latest });
    if (!moved.ok) failure = '커서를 저장하지 못함';
  }
  await importRecord(ctx.config, 'health', failure
    ? { channel: channel.cursor, success: false, error: failure }
    : { channel: channel.cursor, success: true });

  const reasonText = Object.entries(reasons).map(([reason, n]) => `${oneLine(reason, 30)} ${n}`).join(' · ');
  let line = `${channel.cursor} · 새 ${counts.seen}개 · 저장 ${counts.saved} · 건너뜀 ${counts.skipped}`;
  if (reasonText) line += ` (${reasonText})`;
  if (notes) line += ` · 표시 ${notes}`;
  if (ctx.tidy === 'raw') line += ' · 원문 그대로';
  if (sorted.length > batch.length) line += ` · 남은 ${sorted.length - batch.length}개는 다음 회차`;
  if (failure) line += ` · 실패: ${oneLine(failure, 120)} — 커서 그대로`;
  Object.assign(ledger, { seen: counts.seen, saved: counts.saved, system: failure ? ledger.system : systemCount });
  return { line, detail, ledger, ok: !failure };
}

async function main() {
  const [configFile, stateFile, logFile, runTask] = process.argv.slice(2);
  const log = text => fs.appendFileSync(logFile, `${stamp()} ${text}\n`);
  const config = readJson(configFile);
  if (!config) { log('채널 확인 실패 — 설정된 채널을 읽을 수 없음'); return 1; }
  const slack = config.slack || {};
  const workspaceUrl = String(slack.workspaceUrl || 'https://slack.com').replace(/\/+$/, '');
  const channels = Object.entries(slack.channels || {})
    .filter(([key, value]) => CHANNELS[key] && value && typeof value.id === 'string' && /^[^\s:]+$/.test(value.id) && value.off !== true)
    .map(([key, value]) => ({ key, id: value.id, since: TS_RE.test(String(value.since || '')) ? String(value.since) : '', workspaceUrl, ...CHANNELS[key] }));
  // 받을 채널은 넷 중 켜진 것 아무거나다(할 일 채널이 꼭 있어야 하는 것은 아니다). 하나도 없으면 수집하지 않는다.
  if (!channels.length) { log('켜진 채널이 없어 건너뛰어요'); return 0; }

  let token = '';
  try { token = fs.readFileSync(String(slack.tokenFile || '').replace(/^~(?=\/|$)/, os.homedir()), 'utf8').trim(); } catch { token = ''; }
  const state = readJson(stateFile) || {};
  const fetched = [];
  let failures = 0;
  for (const channel of channels) {
    // 어디서부터 볼지 = 수집 커서와 since 중 큰 값(슬랙 ts는 소수라 글자가 아니라 수로 견준다).
    const cursor = TS_RE.test(String(state[channel.cursor] || '')) ? String(state[channel.cursor]) : '';
    const oldest = !channel.since ? cursor : (!cursor || tsCompare(channel.since, cursor) > 0 ? channel.since : cursor);
    if (!token) { failures += 1; log(`${channel.cursor} 채널 확인 실패 — 슬랙 토큰을 읽을 수 없음`); continue; }
    try {
      const result = await history({ token, channel: channel.id, oldest: oldest || undefined, limit: 100 });
      fetched.push({ channel, messages: result.messages });
    } catch (error) {
      failures += 1;
      log(`${channel.cursor} 채널 확인 실패 — ${oneLine(error.message, 160)}`);
    }
  }
  const found = fetched.reduce((sum, one) => sum + one.messages.length, 0);
  // 상태도 앱의 저장 경로를 쓴다. 수집 전에는 성공으로 기록하지 않는다.
  if (!found) {
    if (failures) { await importRecord(configFile, 'health', { success: false, error: '일부 채널을 확인하지 못했습니다.' }); return 1; }
    if (!(await importRecord(configFile, 'health', { success: true })).ok) return 1;
    log('새 메시지 없음 — Claude 호출 생략');
    return 0;
  }

  const started = stamp();
  // 정리 방식 — `raw`만 원문 그대로이고, 칸이 없거나 다른 값이면 예전처럼 Claude로 다듬는다.
  const ctx = { token, config: configFile, runTask, app: null, tidy: slack.tidy === 'raw' ? 'raw' : 'claude' };
  const lines = [], details = [];
  const total = { seen: 0, saved: 0, duplicate: 0, similar: 0, system: 0 };
  let failed = false;
  const order = Object.keys(CHANNELS);
  fetched.sort((a, b) => order.indexOf(a.channel.key) - order.indexOf(b.channel.key));
  for (const { channel, messages } of fetched) {
    if (!messages.length) { await importRecord(configFile, 'health', { channel: channel.cursor, success: true }); continue; }
    const result = await processChannel(ctx, channel, messages);
    lines.push(result.line);
    details.push(...result.detail);
    Object.keys(total).forEach(key => { total[key] += result.ledger[key]; });
    if (!result.ok) failed = true;
  }
  if (failures) await importRecord(configFile, 'health', { success: false, error: '일부 채널을 확인하지 못했습니다.' });
  const status = failed || failures ? 1 : 0;
  // 한 회차 = 로그 블록 하나(run-task.sh와 같은 시작/종료 줄) — 앱의 연동 카드가 그대로 읽는다.
  // 맨 앞 처리 대장 한 줄은 예전 지침이 남기던 문장과 같은 모양이다(연동 카드 ⋯ › 최근 기록 위의 요약 줄이 읽는다).
  const ledger = `이번에 본 메시지 ${total.seen}개 = 등록 ${total.saved} · 링크 중복 ${total.duplicate} · 비슷한 일이라 건너뜀 ${total.similar} · 시스템 ${total.system}`;
  fs.appendFileSync(logFile, [`───── ${started} slack-capture 시작${versionTag()}`, ledger, ...lines, ...details, '', `───── ${stamp()} slack-capture 종료 (exit ${status})`, ''].join('\n'));
  return status;
}

if (require.main === module) {
  const started = stamp();
  main().then(code => { process.exitCode = code; }, error => {
    // 예상하지 못한 오류도 실패 블록 하나로 남긴다(연동 카드가 실패로 읽게). 커서는 이 경우 올라가지 않는다.
    try { fs.appendFileSync(process.argv[4], [`───── ${started} slack-capture 시작${versionTag()}`, `수집 중 오류로 멈춤 — ${oneLine(error && error.message, 160)}`, '', `───── ${stamp()} slack-capture 종료 (exit 1)`, ''].join('\n')); } catch {}
    process.exitCode = 1;
  });
}
module.exports = { claudeAuthPhrase, validate, isSystem, buildPrompt, shareSource, slackPlain, firstLine, rawItem };
