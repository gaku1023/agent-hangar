import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { noteUnread, onUnreadReady, type NotifyTarget, type UnreadMeta } from './unread.ts';
import { UnreadHold } from './unreadHold.ts';

let db: Db;
let live: LiveSessionDto[];
let s1: string;
let s2: string;
let ready: { id: string; text: string; count: number; sent: NotifyTarget[]; meta: UnreadMeta }[];
let offs: (() => void)[];
const entry = (sessionId: string, status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });
const hold = () => {
  const h = new UnreadHold({ db, live: () => live });
  offs.push(h.start());
  return h;
};

beforeEach(() => {
  db = openDb(':memory:');
  s1 = ensureSession(db, 'u1', '/w', 'd');
  s2 = ensureSession(db, 'u2', '/w', 'd');
  live = [entry('u1', 'busy'), entry('u2', 'busy')];
  ready = [];
  offs = [onUnreadReady((id, text, count, sent, meta) => ready.push({ id, text, count, sent, meta }))];
});
afterEach(() => { for (const o of offs) o(); db.close(); });

describe('UnreadHold', () => {
  it('作業中に呼ばれた done は、ターンを抜ける（idle）まで預かり、抜けたら出す', () => {
    const h = hold();
    noteUnread(s1, '調べ終えました', 1, ['unread', 'os', 'phone'], { kind: 'done' });
    expect(ready).toEqual([]);
    expect(h.pending()).toBe(true);
    h.check();
    expect(ready).toEqual([]);
    live = [entry('u1', 'idle'), entry('u2', 'busy')];
    h.check();
    expect(ready).toEqual([{ id: s1, text: '調べ終えました', count: 1, sent: ['os', 'phone'], meta: { kind: 'done' } }]);
    expect(h.pending()).toBe(false);
    h.check();
    expect(ready).toHaveLength(1);
  });

  it('許可待ちの間は出さず、問いの入力待ちになったら出す', () => {
    const h = hold();
    noteUnread(s1, '決めてほしいことがあります', 1, ['os'], { kind: 'ask' });
    live = [entry('u1', 'waiting', { waitingFor: 'permission' })];
    h.check();
    expect(ready).toEqual([]);
    live = [entry('u1', 'waiting', { waitingFor: 'question' })];
    h.check();
    expect(ready.map((r) => r.text)).toEqual(['決めてほしいことがあります']);
  });

  it('progress は預からずにすぐ出す', () => {
    hold();
    noteUnread(s1, '半分まで来ました', 1, ['os'], { kind: 'progress' });
    expect(ready.map((r) => r.meta.kind)).toEqual(['progress']);
  });

  it('immediate の印があれば、作業中でもすぐ出す', () => {
    hold();
    noteUnread(s1, '起動に失敗しました', 1, ['os'], { kind: 'ask', immediate: true });
    expect(ready).toHaveLength(1);
  });

  it('作業中でない（入力待ち、登録に居ない、知らない会話）ならすぐ出す', () => {
    hold();
    live = [entry('u1', 'idle')];
    noteUnread(s1, 'a', 1, ['os']);
    noteUnread(s2, 'b', 1, ['os']);
    noteUnread('nope', 'c', 1, ['os']);
    expect(ready.map((r) => r.text)).toEqual(['a', 'b', 'c']);
  });

  it('同じ会話の預かりは 1 つにまとめ、本文は最後のもの、出し先は合わせ、ask を残す', () => {
    const h = hold();
    noteUnread(s1, '1 回目', 1, ['os'], { kind: 'ask' });
    noteUnread(s1, '2 回目', 2, ['unread', 'phone'], { kind: 'done' });
    noteUnread(s2, '別の会話', 1, ['os'], { kind: 'done' });
    live = [entry('u1', 'idle'), entry('u2', 'busy')];
    h.check();
    expect(ready).toEqual([{ id: s1, text: '2 回目', count: 2, sent: ['os', 'phone'], meta: { kind: 'ask' } }]);
  });

  it('run が居なくなったら出す', () => {
    const h = hold();
    noteUnread(s1, '終わりました', 1, ['os']);
    live = [entry('u2', 'busy')];
    h.check();
    expect(ready).toHaveLength(1);
  });

  it('出し先が未読の数だけなら、何も流さない', () => {
    hold();
    live = [];
    noteUnread(s1, '数だけ', 1, ['unread']);
    expect(ready).toEqual([]);
  });

  it('外した後は聞かない', () => {
    const h = new UnreadHold({ db, live: () => [] });
    const off = h.start();
    off();
    noteUnread(s1, 'x', 1, ['os']);
    expect(ready).toEqual([]);
  });
});
