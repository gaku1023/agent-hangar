import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { insertProject } from '../projects/registry.ts';
import { Publisher } from '../events/publisher.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { createLiveChangeHandler } from './liveChange.ts';
import { setSessionState } from './states.ts';

/**
 * 実行中の一覧が変わったときの受け手。
 * 見本の本文を索引した DB の上で、一覧の出入りと動きの変化を手で渡し、行と配られたイベントを見る。
 * 行の変化を画面へ配るのは配る層（events/publisher.ts）なので、本番と同じ組で動かす。
 */
describe('実行中の一覧の変化', () => {
  let claudeDir: string;
  let db: Db;
  let alpha: string;
  let live: LiveSessionDto[];
  let sent: ServerEvent[];
  let publisher: Publisher;
  let calls: string[];
  const entry = (status: LiveSessionDto['status'], extra: Partial<LiveSessionDto> = {}): LiveSessionDto =>
    ({ sessionId: SESSION_ALPHA, status, name: null, nameSource: null, cwd: '/w', pid: 12345, ...extra });

  beforeEach(async () => {
    claudeDir = copyFixtureClaudeDir();
    db = openDb(':memory:');
    live = [entry('busy')];
    await new IndexerService({ db, deviceId: 'd', claudeDir, isRunning: (id) => live.some((l) => l.sessionId === id) }).fullScan();
    alpha = (db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(SESSION_ALPHA) as { id: string }).id;
    sent = [];
    calls = [];
    publisher = new Publisher({ db, deviceId: 'd', live: () => live, hub: { broadcast: (ev) => { sent.push(ev); } } });
    publisher.flush();
    sent.length = 0;
  });
  afterEach(() => {
    publisher.stop();
    db.close();
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  const handler = () => {
    const h = createLiveChangeHandler({ db, deviceId: 'd', hub: publisher, resetPark: (id) => { calls.push(`reset ${id}`); }, linkRegistry: (l) => { calls.push(`link ${l.length}`); } });
    h.prime(live);
    return h;
  };
  /** 一覧を入れ替えてから受け手へ渡す。配る層も同じ一覧を読む。 */
  const change = (h: ReturnType<typeof handler>, next: LiveSessionDto[]): void => {
    live = next;
    h.onChange(next);
    publisher.flush();
  };
  const summaryState = () => (db.prepare('select state from session_summaries where session_id = ?').get(alpha) as { state: string } | undefined)?.state;
  const upserts = () => sent.filter((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.id === alpha);

  it('実行中の登録が消えたら要約の状態を done に書き替える', () => {
    // Claude の最後の書き込みは登録ファイルの削除より前に起きるので、索引の側では終了に気付けない。
    expect(summaryState()).toBe('in_progress');
    change(handler(), []);
    expect(summaryState()).toBe('done');
    // 実行中かどうかは行に無い。行は変わらなくても中身が変わるので、配り直す。
    expect(upserts().length).toBeGreaterThan(0);
    expect(sent[0]).toEqual({ type: 'live.update', live: [] });
  });

  it('実行中の登録が消えたら、答えを待っていた問いを消す。再開した直後に前の問いが出ない', () => {
    db.prepare('insert or replace into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)').run(alpha, 'AskUserQuestion', 'AskUserQuestion', 'toolu_1', 'どちらにしますか？', 1);
    const questionOf = () => (db.prepare('select question from session_activity where session_id = ?').get(alpha) as { question: string | null } | undefined)?.question;
    const h = handler();
    // 動きが変わっただけでは消さない。答えを待っている最中である。
    change(h, [entry('waiting')]);
    expect(questionOf()).toBe('どちらにしますか？');
    change(h, []);
    expect(questionOf()).toBeNull();
    // 最後の呼び出しは残す。消すのは問いだけである。
    expect(db.prepare('select tool from session_activity where session_id = ?').get(alpha)).toEqual({ tool: 'AskUserQuestion' });
  });

  it('印を付けたセッションは、動きが変わるたびに行ごと配り直す。休みになれば parked が立ち、作業中に戻れば外れる', () => {
    // UI は live.update から動きしか直せない。行を配り直さないと、休みになっても実行中の札に残る。
    setSessionState(db, 'd', alpha, { status: 'paused', note: '明日見る', returnOn: '2099-01-01', setBy: 'user' });
    publisher.flush();
    const h = handler();
    // 印より前に起動したプロセスが、休みになった。
    const procStart = 'Tue Sep  1 10:00:00 2026';
    sent.length = 0;
    change(h, [entry('idle', { procStart } as Partial<LiveSessionDto>)]);
    const idle = upserts().at(-1)!;
    expect(idle.session.live).toBe('idle');
    expect(idle.session.parked).toBe(true);
    sent.length = 0;
    change(h, [entry('busy', { procStart } as Partial<LiveSessionDto>)]);
    const busy = upserts().at(-1)!;
    expect(busy.session.live).toBe('busy');
    expect(busy.session.parked).toBe(false);
    // 動きが変わったら、休みの数え直しにする。
    expect(calls.filter((c) => c === `reset ${alpha}`).length).toBe(2);
  });

  it('印の無いセッションは、動きが変わっても行を配り直さない。動きは live.update が運ぶ', () => {
    const h = handler();
    change(h, [entry('idle')]);
    expect(upserts()).toEqual([]);
    expect(sent.filter((e) => e.type === 'live.update').length).toBe(1);
  });

  it('実行中の数はどのプロジェクトでも変わりうるので、プロジェクトを全部配り直し、run へ登録を結ぶ', () => {
    const p1 = insertProject(db, 'd', 'one', '/w/one');
    const p2 = insertProject(db, 'd', 'two', '/w/two');
    publisher.flush();
    sent.length = 0;
    change(handler(), [entry('busy'), entry('idle', { sessionId: 'zzzzzzzz-0000-4000-8000-000000000009', pid: 2 })]);
    const ids = sent.filter((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert').map((e) => e.project.id).sort();
    expect(ids).toEqual([p1, p2].sort());
    expect(calls).toContain('link 2');
  });

  it('起動のときに動いていた会話は prime で覚える。同じ一覧が来ても出入りとは見ない', () => {
    const h = handler();
    change(h, [entry('busy')]);
    expect(upserts()).toEqual([]);
    expect(summaryState()).toBe('in_progress');
  });
});
