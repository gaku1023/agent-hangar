import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto, SettingsDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/write.ts';
import { firstSentence, NotifyFallback, START_SLACK_MS } from './notifyFallback.ts';
import { noteNotifyKind } from './notifyKind.ts';
import { onUnread, onUnreadReady } from './unread.ts';
import { noteViewing, resetViewing } from './viewing.ts';

let db: Db;
let live: LiveSessionDto[];
let s1: string;
let s2: string;
let clock: number;
let settings: Partial<SettingsDto>;
let replies: Map<string, { text: string; ts: number | null }>;
let timers: { fn: () => void; ms: number }[];
let offs: (() => void)[];
let fired: string[];

const entry = (sessionId: string, status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });
const unread = (id: string) => db.prepare('select count, latest_text as text from session_unread where session_id = ?').get(id) as { count: number; text: string } | undefined;
const fallback = () => {
  const f = new NotifyFallback({
    db, live: () => live, settings: () => settings, lastReply: (id) => replies.get(id) ?? null,
    now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); }, pollMs: 1000, maxWaitMs: 10_000,
  });
  offs.push(f.start());
  return f;
};
/** 作業中のターンを見せてから、clock を進めて end の状態にし、check する。 */
const turn = (f: NotifyFallback, end: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}) => {
  live = [entry('u1', 'busy')];
  f.check();
  clock += 30_000;
  live = [entry('u1', end, over)];
  f.check();
};
const runTimers = () => {
  const now = timers;
  timers = [];
  for (const t of now) { clock += t.ms; t.fn(); }
};

beforeEach(() => {
  db = openDb(':memory:');
  s1 = ensureSession(db, 'u1', '/w', 'd');
  s2 = ensureSession(db, 'u2', '/w', 'd');
  live = [];
  clock = 1_000_000;
  settings = {};
  replies = new Map();
  timers = [];
  fired = [];
  resetViewing();
  offs = [onUnread((id) => fired.push(`unread:${id}`)), onUnreadReady((id, text, count, sent, meta) => fired.push(`ready:${id}:${text}:${count}:${sent.join(',')}:${meta.kind}`))];
});
afterEach(() => { for (const o of offs) o(); db.close(); });

describe('NotifyFallback', () => {
  it('notify_user の無いまま作業中から入力待ち（idle）に抜けたら、最後の返答の頭の 1 文で未読を 1 つ積み、知らせ方の done の決まりどおり OS とスマホへ流す', () => {
    const f = fallback();
    replies.set(s1, { text: '調べ終えました。原因は設定の読み違いです。', ts: clock + 20_000 });
    turn(f, 'idle');
    expect(unread(s1)).toEqual({ count: 1, text: '調べ終えました。' });
    expect(unread(s2)).toBeUndefined();
    // 預かり（onUnread）は通さず、出してよい知らせ（onUnreadReady）として直に流す。
    expect(fired).toEqual([`ready:${s1}:調べ終えました。:1:os,phone:done`]);
    // 同じ終わりを何度見ても、積むのは 1 回だけ。
    f.check();
    runTimers();
    expect(unread(s1)!.count).toBe(1);
  });

  it('そのターンに notify_user が done か ask で呼ばれていれば積まない（数えるのはその呼び出し）。次のターンでは、また呼ばれなければ積む', () => {
    const f = fallback();
    replies.set(s1, { text: '一つ目。', ts: clock + 1 });
    live = [entry('u1', 'busy')];
    f.check();
    noteNotifyKind(s1, 'ask');
    live = [entry('u1', 'idle')];
    f.check();
    runTimers();
    expect(unread(s1)).toBeUndefined();
    replies.set(s1, { text: '二つ目。', ts: clock + 20_000 });
    turn(f, 'idle');
    expect(unread(s1)).toEqual({ count: 1, text: '二つ目。' });
  });

  it('作業中と見る前に呼ばれた notify_user も、そのターンの分として数える', () => {
    const f = fallback();
    replies.set(s1, { text: '済みました。', ts: clock + 20_000 });
    noteNotifyKind(s1, 'done');
    turn(f, 'idle');
    runTimers();
    expect(unread(s1)).toBeUndefined();
  });

  it('progress の呼び出しと、hangar が代わりに出した知らせ（immediate）は、終わりの 1 つを打ち消さない', () => {
    const f = fallback();
    replies.set(s1, { text: '終わりました。', ts: clock + 20_000 });
    live = [entry('u1', 'busy')];
    f.check();
    noteNotifyKind(s1, 'progress');
    noteNotifyKind(s1, 'ask', true);
    clock += 30_000;
    live = [entry('u1', 'idle')];
    f.check();
    expect(unread(s1)).toEqual({ count: 1, text: '終わりました。' });
  });

  it('画面で前に出して見ている会話には積まず、スマホへも流さない。OS は殻が窓の前後で決めるので流す', () => {
    const f = fallback();
    replies.set(s1, { text: '見ている間に終わりました。', ts: clock + 20_000 });
    noteViewing('win', s1, clock);
    turn(f, 'idle');
    expect(unread(s1)).toBeUndefined();
    expect(fired).toEqual([`ready:${s1}:見ている間に終わりました。:0:os:done`]);
  });

  it('問いの入力待ちで終わったターンは未読だけ積む（OS とスマホは入力待ちの知らせが別に出す）。run が居なくなったターンには積まない', () => {
    const f = fallback();
    replies.set(s1, { text: 'どちらにしますか。', ts: clock + 20_000 });
    turn(f, 'waiting', { waitingFor: 'question' });
    expect(unread(s1)).toEqual({ count: 1, text: 'どちらにしますか。' });
    expect(fired).toEqual([]);
    live = [entry('u1', 'busy')];
    f.check();
    live = [];
    f.check();
    runTimers();
    expect(unread(s1)!.count).toBe(1);
  });

  it('許可待ちはターンの途中なので終わりとみなさない。裏だけが動く（aside）のは終わりとみなす', () => {
    const f = fallback();
    replies.set(s1, { text: '裏で走らせました。', ts: clock + 20_000 });
    live = [entry('u1', 'busy')];
    f.check();
    live = [entry('u1', 'waiting', { waitingFor: 'permission' })];
    f.check();
    expect(unread(s1)).toBeUndefined();
    clock += 30_000;
    live = [entry('u1', 'busy', { aside: { shell: true, agents: 0 } })];
    f.check();
    expect(unread(s1)).toEqual({ count: 1, text: '裏で走らせました。' });
  });

  it('返答が本文にまだ載っていなければ、載るまで間を置いて読み直す。上限まで載らなければ諦める', () => {
    const f = fallback();
    turn(f, 'idle');
    expect(unread(s1)).toBeUndefined();
    expect(timers).toHaveLength(1);
    replies.set(s1, { text: 'できました', ts: clock - 1000 });
    runTimers();
    expect(unread(s1)).toEqual({ count: 1, text: 'できました' });
    expect(timers).toEqual([]);

    clock += 60_000;
    turn(f, 'idle');
    for (let i = 0; i < 20 && timers.length > 0; i++) runTimers();
    expect(timers).toEqual([]);
    expect(unread(s1)!.count).toBe(1);
  });

  it('ターンの始まりより前の返答（前のターンのもの）と、時刻の無い返答は使わない', () => {
    const f = fallback();
    replies.set(s1, { text: '前のターン。', ts: clock - START_SLACK_MS - 1 });
    turn(f, 'idle');
    for (let i = 0; i < 20 && timers.length > 0; i++) runTimers();
    replies.set(s1, { text: '時刻なし。', ts: null });
    turn(f, 'idle');
    for (let i = 0; i < 20 && timers.length > 0; i++) runTimers();
    expect(unread(s1)).toBeUndefined();
  });

  it('知らせ方の決まりで done を含まない出し先、休みの会話、統括の会話には出さない。notify_user の段を切っていても数える', () => {
    const f = fallback();
    const check = () => {
      replies.set(s1, { text: '済み。', ts: clock + 20_000 });
      turn(f, 'idle');
      runTimers();
      return unread(s1);
    };
    settings = { notifyPreference: { text: '未読は判断が要るときだけ', unread: ['ask'], os: ['done'], phone: [], whileFocused: false, merge: true } };
    expect(check()).toBeUndefined();
    expect(fired).toEqual([`ready:${s1}:済み。:0:os:done`]);
    fired = [];
    settings = { notifyUser: false };
    expect(check()).toEqual({ count: 1, text: '済み。' });
    db.prepare('delete from session_unread').run();
    fired = [];
    settings = { orchestrator: { enabled: true, sessionId: s1 } as SettingsDto['orchestrator'] };
    expect(check()).toBeUndefined();
    settings = {};
    upsertShared(db, 'session_states', { session_id: s1, status: 'done', set_by: 'user', set_at: 5 }, 'd', 'session_id');
    expect(check()).toBeUndefined();
    db.prepare('delete from session_states').run();
    expect(check()).toEqual({ count: 1, text: '済み。' });
    expect(fired).toEqual([`ready:${s1}:済み。:1:os,phone:done`]);
  });

  it('Codex と opencode の会話も、登録の agent と会話の provider で引き当てる', () => {
    const f = fallback();
    const cx = ensureSession(db, 'c1', '/w', 'd', 'codex');
    replies.set(cx, { text: 'Codex で直しました。', ts: clock + 20_000 });
    live = [entry('c1', 'busy', { agent: 'codex' })];
    f.check();
    clock += 30_000;
    live = [entry('c1', 'idle', { agent: 'codex' })];
    f.check();
    expect(unread(cx)).toEqual({ count: 1, text: 'Codex で直しました。' });
  });
});

describe('firstSentence', () => {
  it('Markdown の飾りを外し、最初の文で切る', () => {
    expect(firstSentence('## 結果\n\n**直しました**。続きは下に。')).toBe('結果');
    expect(firstSentence('- `npm test` が通りました! 次は build です')).toBe('npm test が通りました!');
    expect(firstSentence('Fixed the bug. Next, the docs.')).toBe('Fixed the bug.');
    expect(firstSentence('```ts\nconst a = 1;\n```\n書き換えました。')).toBe('書き換えました。');
    expect(firstSentence('v0.22.0 を出しました')).toBe('v0.22.0 を出しました');
  });
  it('200 字を越える文は切って … を付ける。中身が無ければ null', () => {
    const s = firstSentence('あ'.repeat(300))!;
    expect([...s]).toHaveLength(200);
    expect(s.endsWith('…')).toBe(true);
    expect(firstSentence('  \n```\n```\n')).toBeNull();
  });
});
