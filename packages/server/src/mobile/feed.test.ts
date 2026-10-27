import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MOBILE_TEXT_MAX, PRIMARY_ACCOUNT_ID, type LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { addIntent } from '../live/intents.ts';
import { buildMobileFeed, feedCaps, LAST_USED_SQL, type FeedSources } from './feed.ts';
import { saveRemoteUrl } from './remoteUrl.ts';

const ME = 'pc-me';
const OTHER = 'pc-other';
const TZ = 'Asia/Tokyo';
const HOUR = 3_600_000;
// 2026-10-17 12:00 (Asia/Tokyo)。
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);

function seed(): Db {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p-a', name: 'project-a', status: 'active', is_scratch: 0 }, ME);
  upsertShared(db, 'project_roots', { id: 'r-a', project_id: 'p-a', device_id: ME, path: '/w/project-a', resolved: 1 }, ME);
  return db;
}

function session(db: Db, id: string, o: { projectId?: string | null; name?: string | null } = {}): void {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, project_id: o.projectId === undefined ? 'p-a' : o.projectId, cwd: '/w/project-a', first_prompt: null, ai_title: o.name ?? null, home_device: ME }, ME);
}

function run(db: Db, id: string, sessionId: string, o: { device?: string; startedAt?: number; endedAt?: number | null; account?: string } = {}): void {
  upsertShared(
    db,
    'runs',
    { id, session_id: sessionId, device_id: o.device ?? ME, kind: 'start', tmux_name: `t-${id}`, launch_params: JSON.stringify(o.account ? { account: o.account } : {}), started_at: o.startedAt ?? NOW - HOUR, ended_at: o.endedAt ?? null, heartbeat_at: NOW },
    ME,
  );
}

function state(db: Db, sessionId: string, o: { status: 'paused' | 'done'; returnOn?: string | null; returnTime?: string | null; setAt?: number }): void {
  upsertShared(db, 'session_states', { session_id: sessionId, status: o.status, return_on: o.returnOn ?? null, return_time: o.returnTime ?? null, set_by: 'user', set_at: o.setAt ?? NOW }, ME, 'session_id');
}

const liveOf = (sessionId: string, o: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: `u-${sessionId}`, status: 'busy', name: null, nameSource: null, cwd: '/w/project-a', pid: 1, statusAt: NOW - 1000, ...o });

function src(db: Db, o: Partial<FeedSources> = {}): FeedSources {
  return { db, deviceId: ME, deviceName: 'Mac 1', live: [], accounts: [{ id: PRIMARY_ACCOUNT_ID, name: 'メイン', dir: '/h/.claude', color: '#2a57b8' }], usageOf: () => null, now: NOW, tz: TZ, ...o };
}

describe('buildMobileFeed', () => {
  it('この PC のできること（問い合わせ、画像、effort）を caps に全部 true で載せる', () => {
    const db = seed();
    expect(buildMobileFeed(src(db)).caps).toEqual({ asks: true, images: true, effort: true });
  });

  it('入力待ちの run は waiting に問いの文が入り、300 字で切られる', () => {
    const db = seed();
    session(db, 's1', { name: '会話 1' });
    run(db, 'run1', 's1');
    const long = 'あ'.repeat(MOBILE_TEXT_MAX + 50);
    db.prepare("insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values ('s1', 'AskUserQuestion', '', 't', ?, ?)").run(long, NOW);
    const feed = buildMobileFeed(src(db, { live: [liveOf('s1', { status: 'waiting', waitingFor: 'question', statusAt: NOW - 5000 })] }));
    expect(feed.live).toHaveLength(1);
    const item = feed.live[0]!;
    expect(item).toMatchObject({ sessionId: 's1', projectId: 'p-a', projectName: 'project-a', title: '会話 1', accountId: PRIMARY_ACCOUNT_ID, status: 'waiting', statusAt: NOW - 5000, startedAt: NOW - HOUR, rcUrl: null });
    expect(item.waiting?.kind).toBe('question');
    expect(item.waiting?.text).toBe('あ'.repeat(MOBILE_TEXT_MAX) + '…');
  });

  it('許可待ちはツール名と命令を waiting に入れ、busy の run の waiting は null', () => {
    const db = seed();
    session(db, 's1');
    session(db, 's2');
    run(db, 'run1', 's1');
    run(db, 'run2', 's2');
    const feed = buildMobileFeed(
      src(db, {
        live: [
          liveOf('s1', { status: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'npm test', description: null }, statusAt: NOW - 1 }),
          liveOf('s2', { status: 'busy', statusAt: NOW - 2 }),
        ],
      }),
    );
    expect(feed.live.map((l) => l.sessionId)).toEqual(['s1', 's2']);
    expect(feed.live[0]!.waiting).toEqual({ kind: 'permission', text: 'Bash: npm test' });
    expect(feed.live[1]!.waiting).toBeNull();
  });

  it('許可待ちの長い命令は 300 字で切られ、説明だけ、ツール名だけの許可も入る', () => {
    const db = seed();
    for (const id of ['s1', 's2', 's3']) {
      session(db, id);
      run(db, `run-${id}`, id);
    }
    const wait = (permission: LiveSessionDto['permission']) => ({ status: 'waiting' as const, waitingFor: 'permission' as const, permission });
    const feed = buildMobileFeed(
      src(db, {
        live: [
          liveOf('s1', { ...wait({ tool: 'Bash', input: 'x'.repeat(400), description: null }), statusAt: NOW - 1 }),
          liveOf('s2', { ...wait({ tool: 'WebFetch', input: '  ', description: 'example.com を読む' }), statusAt: NOW - 2 }),
          liveOf('s3', { ...wait({ tool: 'Edit', input: '', description: null }), statusAt: NOW - 3 }),
        ],
      }),
    );
    expect(feed.live.map((l) => l.waiting)).toEqual([
      { kind: 'permission', text: `Bash: ${'x'.repeat(MOBILE_TEXT_MAX - 'Bash: '.length)}…` },
      { kind: 'permission', text: 'WebFetch: example.com を読む' },
      { kind: 'permission', text: 'Edit' },
    ]);
  });

  it('許可待ちの間は、前の AskUserQuestion の問いを出さず許可の中身を出す。問いの待ちでは前の許可を出さない', () => {
    const db = seed();
    for (const id of ['s1', 's2', 's3']) {
      session(db, id);
      run(db, `run-${id}`, id);
      db.prepare("insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?, 'AskUserQuestion', '', 't', '前の問い', ?)").run(id, NOW - 9000);
    }
    const feed = buildMobileFeed(
      src(db, {
        live: [
          liveOf('s1', { status: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'npm test', description: null }, statusAt: NOW - 1 }),
          liveOf('s2', { status: 'waiting', waitingFor: 'question', permission: { tool: 'Bash', input: 'rm -rf build', description: null }, statusAt: NOW - 2 }),
          // Claude Code の版によっては、AskUserQuestion の待ちに permission を書く。そのときは問いとして出す。
          liveOf('s3', { status: 'waiting', waitingFor: 'permission', permission: { tool: 'AskUserQuestion', input: '{"questions":[]}', description: null }, statusAt: NOW - 3 }),
        ],
      }),
    );
    expect(feed.live.map((l) => l.waiting)).toEqual([
      { kind: 'permission', text: 'Bash: npm test' },
      { kind: 'question', text: '前の問い' },
      { kind: 'question', text: '前の問い' },
    ]);
  });

  it('問いの待ちで問いの文がまだ無ければ、許可の命令を問いとして出さず空にする', () => {
    const db = seed();
    session(db, 's1');
    run(db, 'run1', 's1');
    const feed = buildMobileFeed(src(db, { live: [liveOf('s1', { status: 'waiting', waitingFor: 'question', permission: { tool: 'Bash', input: 'npm test', description: null } })] }));
    expect(feed.live[0]!.waiting).toEqual({ kind: 'question', text: '' });
  });

  describe('許可でない待ち（waitingFor が other）で、最後の呼び出しにもう答えが出ているか（presenters/live.ts の staleWait）', () => {
    const UUID = 'bbbbbbbb-0000-4000-8000-0000000000f1';
    const T = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString();
    const base = (s: number) => ({ uuid: `x${s}`, timestamp: T(s), cwd: '/w/project-a', sessionId: UUID });
    const ask = (s: number) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'どちらにしますか', header: 'h', options: [], multiSelect: false }] } }] }, ...base(s) });
    const answer = (s: number) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'A' }] }, ...base(s) });
    const prompt = (s: number) => ({ type: 'user', message: { role: 'user', content: '指示' }, ...base(s) });
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

    /** 本文を索引に入れ、run を置き、hook が遅れて届いたつもりで問いを残す。 */
    async function seedTranscript(rows: unknown[]): Promise<{ db: Db; sid: string }> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-feed-'));
      dirs.push(dir);
      const file = path.join(dir, 'projects', '-w-project-a', `${UUID}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const db = seed();
      await new IndexerService({ db, deviceId: ME, transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false }).fullScan();
      const sid = (db.prepare('select id from sessions where provider_session_id = ?').get(UUID) as { id: string }).id;
      run(db, 'run1', sid);
      db.prepare("insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?, 'AskUserQuestion', '', 'toolu_q', 'どちらにしますか', ?) on conflict(session_id) do update set question = excluded.question").run(sid, NOW);
      return { db, sid };
    }
    const waitOther = (db: Db) => buildMobileFeed(src(db, { live: [{ ...liveOf('x'), sessionId: UUID, status: 'waiting', waitingFor: 'other' }] })).live[0]!.waiting;

    it('答えの出た問いは出さない', async () => {
      const { db } = await seedTranscript([prompt(0), ask(1), answer(2)]);
      expect(waitOther(db)).toEqual({ kind: 'other', text: '' });
    });

    it('答えの出ていない問いは出す', async () => {
      const { db } = await seedTranscript([prompt(0), ask(1)]);
      expect(waitOther(db)).toEqual({ kind: 'question', text: 'どちらにしますか' });
    });
  });

  it('同じ会話を再開したら、前の run で拾った URL は出さない', () => {
    const db = seed();
    session(db, 's1');
    run(db, 'run-a', 's1', { startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    saveRemoteUrl(db, 's1', 'https://claude.ai/code/session_01Prev', NOW - 3 * HOUR + 4000);
    run(db, 'run-b', 's1', { startedAt: NOW - HOUR });
    expect(buildMobileFeed(src(db, { live: [liveOf('s1')] })).live[0]!.rcUrl).toBeNull();
    saveRemoteUrl(db, 's1', 'https://claude.ai/code/session_02Now', NOW - HOUR + 4000);
    expect(buildMobileFeed(src(db, { live: [liveOf('s1')] })).live[0]!.rcUrl).toBe('https://claude.ai/code/session_02Now');
  });

  it('run_remote_urls にある会話は rcUrl が入る（今の run の起動より後に拾ったものだけ、claude.ai のものだけ）', () => {
    const db = seed();
    for (const id of ['s1', 's2', 's3', 's4']) {
      session(db, id);
      run(db, `run-${id}`, id, { startedAt: NOW - HOUR });
    }
    saveRemoteUrl(db, 's1', 'https://claude.ai/code/session_01AbCd', NOW - HOUR + 4000);
    // 前の run で拾ったものは、その run が終わった今はつながらない。
    saveRemoteUrl(db, 's2', 'https://claude.ai/code/session_02Old', NOW - 2 * HOUR);
    db.prepare("insert into run_remote_urls (session_id, url, at) values ('s3', 'https://claude.ai.evil.example/code/x', ?)").run(NOW - 1);
    const feed = buildMobileFeed(src(db, { live: ['s1', 's2', 's3', 's4'].map((id, i) => liveOf(id, { statusAt: NOW - i })) }));
    expect(feed.live.map((l) => [l.sessionId, l.rcUrl])).toEqual([
      ['s1', 'https://claude.ai/code/session_01AbCd'],
      ['s2', null],
      ['s3', null],
      ['s4', null],
    ]);
  });

  it('ほかの PC の run と、終わった run は live に入らない', () => {
    const db = seed();
    session(db, 's1');
    session(db, 's2');
    session(db, 's3');
    run(db, 'run1', 's1', { device: OTHER });
    run(db, 'run2', 's2', { endedAt: NOW - 10 });
    run(db, 'run3', 's3');
    const feed = buildMobileFeed(src(db, { live: [liveOf('s1'), liveOf('s2'), liveOf('s3'), liveOf('nothing')] }));
    expect(feed.live.map((l) => l.sessionId)).toEqual(['s3']);
  });

  it('意図は最新の 1 つだけで、300 字で切られる', () => {
    const db = seed();
    session(db, 's1');
    run(db, 'run1', 's1');
    addIntent(db, 's1', '古い意図', NOW - 2000);
    addIntent(db, 's1', 'い'.repeat(400), NOW - 1000);
    const a = buildMobileFeed(src(db, { live: [liveOf('s1')] })).live[0]!;
    expect(a.intent).toBe('い'.repeat(MOBILE_TEXT_MAX) + '…');
    addIntent(db, 's1', '新しい意図', NOW - 500);
    expect(buildMobileFeed(src(db, { live: [liveOf('s1')] })).live[0]!.intent).toBe('新しい意図');
  });

  it('live は statusAt の降順に並ぶ', () => {
    const db = seed();
    for (const id of ['s1', 's2', 's3']) {
      session(db, id);
      run(db, `run-${id}`, id);
    }
    const feed = buildMobileFeed(src(db, { live: [liveOf('s1', { statusAt: 100 }), liveOf('s3', { statusAt: 300 }), liveOf('s2', { statusAt: 200 })] }));
    expect(feed.live.map((l) => l.sessionId)).toEqual(['s3', 's2', 's1']);
  });

  it('2 つ目のアカウントで起こした run はそのアカウントの id が付く', () => {
    const db = seed();
    session(db, 's1');
    run(db, 'run1', 's1', { account: 'acc-2' });
    expect(buildMobileFeed(src(db, { live: [liveOf('s1')] })).live[0]!.accountId).toBe('acc-2');
  });

  it('今日戻る Paused は returns に、明日までは入り、明後日のものは入らない', () => {
    const db = seed();
    for (const id of ['s-today', 's-tomorrow', 's-later', 's-overdue', 's-nodate']) {
      session(db, id, { name: id });
      run(db, `run-${id}`, id, { endedAt: NOW - 100 });
    }
    state(db, 's-today', { status: 'paused', returnOn: '2026-10-17', returnTime: '15:00' });
    state(db, 's-tomorrow', { status: 'paused', returnOn: '2026-10-18' });
    state(db, 's-later', { status: 'paused', returnOn: '2026-10-19' });
    state(db, 's-overdue', { status: 'paused', returnOn: '2026-10-10' });
    state(db, 's-nodate', { status: 'paused', returnOn: null });
    const feed = buildMobileFeed(src(db));
    expect(feed.returns.map((r) => r.sessionId)).toEqual(['s-tomorrow', 's-today', 's-overdue']);
    expect(feed.returns.find((r) => r.sessionId === 's-today')).toEqual({ sessionId: 's-today', projectName: 'project-a', title: 's-today', accountId: PRIMARY_ACCOUNT_ID, returnOn: '2026-10-17', returnTime: '15:00' });
  });

  it('「明日」は tz のその PC の日付で決まる', () => {
    const db = seed();
    session(db, 's1');
    run(db, 'run1', 's1', { endedAt: NOW - 100 });
    state(db, 's1', { status: 'paused', returnOn: '2026-10-19' });
    // UTC では 10-17 でも、Pacific/Kiritimati（+14）では 10-18 の朝。明日は 10-19。
    const at = Date.UTC(2026, 9, 17, 20, 0, 0);
    expect(buildMobileFeed(src(db, { now: at, tz: 'Pacific/Kiritimati' })).returns).toHaveLength(1);
    expect(buildMobileFeed(src(db, { now: at, tz: 'UTC' })).returns).toHaveLength(0);
  });

  it('Done は 36 時間以内だけで、一言は session_summaries から取る', () => {
    const db = seed();
    for (const id of ['s-new', 's-old']) {
      session(db, id, { name: id });
      run(db, `run-${id}`, id, { endedAt: NOW - 100 });
    }
    state(db, 's-new', { status: 'done', setAt: NOW - 35 * HOUR });
    state(db, 's-old', { status: 'done', setAt: NOW - 37 * HOUR });
    upsertShared(db, 'session_summaries', { session_id: 's-new', title: 't', one_liner: '一言のまとめ', body: 'b', state: 'done', next_steps: '[]', source: 'baseline', based_on_turns: 1 }, ME, 'session_id');
    const feed = buildMobileFeed(src(db));
    expect(feed.done).toEqual([{ sessionId: 's-new', projectName: 'project-a', title: 's-new', oneLiner: '一言のまとめ', doneAt: NOW - 35 * HOUR }]);
  });

  it('最後の run がほかの PC の会話は returns と done に入らない', () => {
    const db = seed();
    session(db, 's1');
    session(db, 's2');
    run(db, 'run1a', 's1', { startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR });
    run(db, 'run1b', 's1', { device: OTHER, startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    run(db, 'run2', 's2', { device: OTHER });
    state(db, 's1', { status: 'paused', returnOn: '2026-10-17' });
    state(db, 's2', { status: 'done', setAt: NOW - HOUR });
    const feed = buildMobileFeed(src(db));
    expect(feed.returns).toEqual([]);
    expect(feed.done).toEqual([]);
  });

  it('run の無い会話は returns と done に入らない', () => {
    const db = seed();
    session(db, 's1');
    state(db, 's1', { status: 'done', setAt: NOW - HOUR });
    expect(buildMobileFeed(src(db)).done).toEqual([]);
  });

  it('動いている会話は returns と done に重ねて入れない', () => {
    const db = seed();
    session(db, 's1');
    run(db, 'run1', 's1');
    state(db, 's1', { status: 'done', setAt: NOW - HOUR });
    const feed = buildMobileFeed(src(db, { live: [liveOf('s1')] }));
    expect(feed.live).toHaveLength(1);
    expect(feed.done).toEqual([]);
  });

  it('この PC に場所の無いプロジェクトは projects に入らず、lastUsedAt は最後の run の開始時刻', () => {
    const db = seed();
    upsertShared(db, 'projects', { id: 'p-b', name: 'project-b', status: 'active', is_scratch: 0 }, ME);
    upsertShared(db, 'project_roots', { id: 'r-b', project_id: 'p-b', device_id: OTHER, path: '/x/project-b', resolved: 1 }, ME);
    upsertShared(db, 'projects', { id: 'p-c', name: 'project-c', status: 'active', is_scratch: 0 }, ME);
    upsertShared(db, 'project_roots', { id: 'r-c', project_id: 'p-c', device_id: ME, path: '/w/project-c', resolved: 1 }, ME);
    upsertShared(db, 'projects', { id: 'p-d', name: 'project-d', status: 'active', is_scratch: 0 }, ME);
    upsertShared(db, 'project_roots', { id: 'r-d', project_id: 'p-d', device_id: ME, path: '/w/project-d', resolved: 1, deleted_at: NOW }, ME);
    upsertShared(db, 'projects', { id: 'p-s', name: 'scratch', status: 'active', is_scratch: 1 }, ME);
    upsertShared(db, 'project_roots', { id: 'r-s', project_id: 'p-s', device_id: ME, path: '/w/scratch', resolved: 1 }, ME);
    session(db, 's1');
    session(db, 's2');
    run(db, 'run1', 's1', { startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    run(db, 'run2', 's2', { startedAt: NOW - 1 * HOUR, endedAt: NOW - 1 });
    const feed = buildMobileFeed(src(db));
    expect(feed.projects).toEqual([
      { id: 'p-a', name: 'project-a', lastUsedAt: NOW - HOUR },
      { id: 'p-c', name: 'project-c', lastUsedAt: null },
    ]);
  });

  it('lastUsedAt は 1 回の集計で、sessions と runs を索引で引き、消した run は数えない', () => {
    const db = seed();
    upsertShared(db, 'projects', { id: 'p-c', name: 'project-c', status: 'active', is_scratch: 0 }, ME);
    upsertShared(db, 'project_roots', { id: 'r-c', project_id: 'p-c', device_id: ME, path: '/w/project-c', resolved: 1 }, ME);
    session(db, 's1');
    session(db, 's2', { projectId: 'p-c' });
    run(db, 'run1', 's1', { startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    run(db, 'run2', 's2', { startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR });
    upsertShared(db, 'runs', { id: 'run3', session_id: 's2', device_id: ME, kind: 'start', tmux_name: 't-run3', launch_params: '{}', started_at: NOW - HOUR, ended_at: NOW - 1, heartbeat_at: NOW, deleted_at: NOW }, ME);
    expect(buildMobileFeed(src(db)).projects).toEqual([
      { id: 'p-a', name: 'project-a', lastUsedAt: NOW - 3 * HOUR },
      { id: 'p-c', name: 'project-c', lastUsedAt: NOW - 5 * HOUR },
    ]);
    const plan = (db.prepare(`explain query plan ${LAST_USED_SQL}`).all(ME) as { detail: string }[]).map((p) => p.detail);
    expect(plan.join(' | ')).toContain('runs_session_started');
    expect(plan.join(' | ')).toContain('sessions_project');
    expect(plan.some((d) => /^SCAN (r|s)\b/.test(d))).toBe(false);
  });

  it('accounts は AccountStore の一覧と使用率', () => {
    const db = seed();
    const feed = buildMobileFeed(
      src(db, {
        accounts: [
          { id: PRIMARY_ACCOUNT_ID, name: 'メイン', dir: '/h/.claude', color: '#2a57b8' },
          { id: 'acc-2', name: 'サブ', dir: '/h/.claude-2', color: '#7a4a9e' },
        ],
        usageOf: (id) => (id === PRIMARY_ACCOUNT_ID ? { fiveHour: { usedPercent: 32, resetsAt: NOW + HOUR }, sevenDay: { usedPercent: 10, resetsAt: null }, updatedAt: NOW } : null),
      }),
    );
    expect(feed.accounts).toEqual([
      { id: PRIMARY_ACCOUNT_ID, name: 'メイン', color: '#2a57b8', fiveHour: 32, sevenDay: 10 },
      { id: 'acc-2', name: 'サブ', color: '#7a4a9e', fiveHour: null, sevenDay: null },
    ]);
    expect(feed).toMatchObject({ v: 1, deviceId: ME, deviceName: 'Mac 1' });
  });

  it('同じ入力からは同じ JSON になる', () => {
    const db = seed();
    for (const id of ['s1', 's2', 's3', 's4']) {
      session(db, id, { name: id });
      run(db, `run-${id}`, id, { endedAt: NOW - 100 });
    }
    state(db, 's1', { status: 'done', setAt: NOW - HOUR });
    state(db, 's2', { status: 'done', setAt: NOW - HOUR });
    state(db, 's3', { status: 'paused', returnOn: '2026-10-17' });
    state(db, 's4', { status: 'paused', returnOn: '2026-10-17' });
    const a = JSON.stringify(buildMobileFeed(src(db)));
    const b = JSON.stringify(buildMobileFeed(src(db)));
    expect(a).toBe(b);
    const f = buildMobileFeed(src(db));
    expect(f.done.map((d) => d.sessionId)).toEqual(['s1', 's2']);
    expect(f.returns.map((d) => d.sessionId)).toEqual(['s3', 's4']);
  });

  describe('opencode の会話（F1）', () => {
    function ocSession(db: Db, id: string, o: { name?: string } = {}): void {
      upsertShared(db, 'sessions', { id, provider: 'opencode', provider_session_id: `ses_${id}`, project_id: 'p-a', cwd: '/w/project-a', first_prompt: null, ai_title: o.name ?? null, home_device: ME }, ME);
    }
    const ocLive = (id: string, o: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: `ses_${id}`, status: 'busy', name: null, nameSource: null, cwd: '/w/project-a', pid: 2, statusAt: NOW - 1000, agent: 'opencode', ...o });
    function stats(db: Db, providerSessionId: string, o: { model?: string | null; used?: number | null; size?: number | null; cost?: number | null }): void {
      db.prepare('insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)')
        .run(providerSessionId, o.model ?? null, null, o.used ?? null, o.size ?? null, o.cost ?? null, NOW);
    }

    it('opencode の実行中の会話も live に出て、agent に opencode が付く。Claude の行には agent も usage も付かない', () => {
      const db = seed();
      session(db, 's1', { name: 'Claude の会話' });
      ocSession(db, 'o1', { name: 'opencode の会話' });
      run(db, 'run1', 's1');
      run(db, 'run2', 'o1');
      stats(db, 'u-s1', { model: 'claude-opus', used: 50_000, size: 200_000, cost: 1.5 });
      const feed = buildMobileFeed(src(db, { live: [liveOf('s1', { statusAt: NOW - 1 }), ocLive('o1', { statusAt: NOW - 2 })] }));
      expect(feed.live.map((l) => l.sessionId)).toEqual(['s1', 'o1']);
      const [claude, oc] = feed.live;
      expect(claude).not.toHaveProperty('agent');
      expect(claude).not.toHaveProperty('usage');
      expect(oc).toMatchObject({ sessionId: 'o1', title: 'opencode の会話', agent: 'opencode', rcUrl: null });
      // アカウントは Claude だけのもの。opencode の行は空にして、スマホにアカウントの札を出させない。
      expect(claude!.accountId).toBe(PRIMARY_ACCOUNT_ID);
      expect(oc!.accountId).toBe('');
    });

    it('同じ provider_session_id の Claude の会話と取り違えない（provider で引く）', () => {
      const db = seed();
      upsertShared(db, 'sessions', { id: 'c-dup', provider: 'claude-code', provider_session_id: 'ses_o1', project_id: 'p-a', cwd: '/w/project-a', first_prompt: null, ai_title: 'Claude 側', home_device: ME }, ME);
      ocSession(db, 'o1', { name: 'opencode 側' });
      run(db, 'run-c', 'c-dup');
      run(db, 'run-o', 'o1');
      const feed = buildMobileFeed(src(db, { live: [ocLive('o1')] }));
      expect(feed.live.map((l) => [l.sessionId, l.title, l.agent])).toEqual([['o1', 'opencode 側', 'opencode']]);
    });

    it('opencode の行の使用量は session_live_stats から（ctx は 0〜100 の整数、tokens は使ったコンテキスト）', () => {
      const db = seed();
      for (const id of ['o1', 'o2', 'o3', 'o4']) { ocSession(db, id); run(db, `run-${id}`, id); }
      stats(db, 'ses_o1', { model: 'opencode/big-pickle', used: 13_600, size: 200_000, cost: 0 });
      stats(db, 'ses_o2', { model: 'lmstudio/qwen', used: 9_000, size: null, cost: null });
      stats(db, 'ses_o3', { model: 'x/y', used: 300_000, size: 200_000, cost: 0.4249 });
      // 使った量がまだ無い行（o4）と、行そのものが無い会話には usage を付けない。
      stats(db, 'ses_o4', { model: 'x/y', used: null, size: 200_000, cost: null });
      const feed = buildMobileFeed(src(db, { live: ['o1', 'o2', 'o3', 'o4'].map((id, i) => ocLive(id, { statusAt: NOW - i })) }));
      const by = Object.fromEntries(feed.live.map((l) => [l.sessionId, l.usage]));
      expect(by.o1).toEqual({ ctx: 7, tokens: 13_600, cost: 0, model: 'opencode/big-pickle' });
      expect(by.o2).toEqual({ ctx: null, tokens: 9_000, cost: null, model: 'lmstudio/qwen' });
      expect(by.o3).toEqual({ ctx: 100, tokens: 300_000, cost: 0.4249, model: 'x/y' });
      expect(by.o4).toBeUndefined();
      expect(feed.live.find((l) => l.sessionId === 'o4')).not.toHaveProperty('usage');
    });

    it('opencode の許可待ちは「shell: 命令」、form の問いは session_activity の問いの文が waiting に入る', () => {
      const db = seed();
      ocSession(db, 'o1');
      ocSession(db, 'o2');
      run(db, 'run1', 'o1');
      run(db, 'run2', 'o2');
      db.prepare("insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values ('o2', 'AskUserQuestion', '', 'call_1', 'どの枝に出しますか', ?)").run(NOW);
      const feed = buildMobileFeed(src(db, {
        live: [
          ocLive('o1', { status: 'waiting', waitingFor: 'permission', permission: { tool: 'shell', input: 'git push origin main', description: null }, statusAt: NOW - 1 }),
          ocLive('o2', { status: 'waiting', waitingFor: 'question', statusAt: NOW - 2 }),
        ],
      }));
      const by = Object.fromEntries(feed.live.map((l) => [l.sessionId, l.waiting]));
      expect(by.o1).toEqual({ kind: 'permission', text: 'shell: git push origin main' });
      expect(by.o2).toEqual({ kind: 'question', text: 'どの枝に出しますか' });
    });

    it('opencode の Paused と Done にも agent が付き、Claude の行には付かない', () => {
      const db = seed();
      session(db, 's1');
      ocSession(db, 'o1');
      ocSession(db, 'o2');
      for (const id of ['s1', 'o1', 'o2']) run(db, `run-${id}`, id, { endedAt: NOW - 100 });
      state(db, 's1', { status: 'done', setAt: NOW - HOUR });
      state(db, 'o1', { status: 'done', setAt: NOW - 2 * HOUR });
      state(db, 'o2', { status: 'paused', returnOn: '2026-10-17' });
      const feed = buildMobileFeed(src(db));
      expect(feed.done.map((d) => [d.sessionId, d.agent])).toEqual([['s1', undefined], ['o1', 'opencode']]);
      expect(feed.done[0]).not.toHaveProperty('agent');
      expect(feed.returns.map((r) => [r.sessionId, r.agent, r.accountId])).toEqual([['o2', 'opencode', '']]);
    });

    it('caps.agents は、設定で opencode が有効のときだけ載せる（切なら caps は今までと同じ形）', () => {
      const db = seed();
      expect(buildMobileFeed(src(db)).caps).toEqual({ asks: true, images: true, effort: true });
      expect(buildMobileFeed(src(db, { opencodeEnabled: false })).caps).toEqual({ asks: true, images: true, effort: true });
      expect(buildMobileFeed(src(db, { opencodeEnabled: true })).caps).toEqual({ asks: true, images: true, effort: true, agents: ['claude-code', 'opencode'] });
    });

    it('caps.agents は Codex も、設定で有効のときだけ載せる。並びは AGENT_KINDS のまま。opencode と別々に入り切りする', () => {
      const db = seed();
      const base = { asks: true, images: true, effort: true };
      expect(buildMobileFeed(src(db, { codexEnabled: true })).caps).toEqual({ ...base, agents: ['claude-code', 'codex'] });
      expect(buildMobileFeed(src(db, { codexEnabled: true, opencodeEnabled: true })).caps).toEqual({ ...base, agents: ['claude-code', 'codex', 'opencode'] });
      expect(buildMobileFeed(src(db, { codexEnabled: false, opencodeEnabled: true })).caps).toEqual({ ...base, agents: ['claude-code', 'opencode'] });
      expect(feedCaps(false, false)).toEqual(base);
      expect(feedCaps(false)).toEqual(base);
    });
  });

  describe('Codex の会話（F1）', () => {
    function cxSession(db: Db, id: string): void {
      upsertShared(db, 'sessions', { id, provider: 'codex', provider_session_id: `thr_${id}`, project_id: 'p-a', cwd: '/w/project-a', first_prompt: null, ai_title: 'Codex の会話', home_device: ME }, ME);
    }
    const cxLive = (id: string, o: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: `thr_${id}`, status: 'busy', name: null, nameSource: null, cwd: '/w/project-a', pid: 2, statusAt: NOW - 1000, agent: 'codex', ...o });

    it('実行中の Codex の会話は live に出て、agent に codex、アカウントは空、rcUrl は無い。使用量は session_live_stats から付く', () => {
      const db = seed();
      cxSession(db, 'c1');
      run(db, 'run-c1', 'c1');
      db.prepare('insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)').run('thr_c1', 'gpt-5.5', 'high', 20_000, 200_000, null, NOW);
      const feed = buildMobileFeed(src(db, { live: [cxLive('c1')] }));
      expect(feed.live).toHaveLength(1);
      expect(feed.live[0]).toMatchObject({ sessionId: 'c1', agent: 'codex', accountId: '', rcUrl: null, usage: { ctx: 10, tokens: 20_000, cost: null, model: 'gpt-5.5' } });
    });

    it('入力待ちの Codex の行は waiting を持つ（スマホは「PC で答えてください」を出す）。使用量がまだ無い行には usage を付けない', () => {
      const db = seed();
      cxSession(db, 'c1');
      run(db, 'run-c1', 'c1');
      const feed = buildMobileFeed(src(db, { live: [cxLive('c1', { status: 'waiting', waitingFor: 'permission', permission: { tool: 'shell', input: 'git push', description: null } as never })] }));
      expect(feed.live[0]!.waiting).toEqual({ kind: 'permission', text: 'shell: git push' });
      expect(feed.live[0]).not.toHaveProperty('usage');
    });

    it('休みと Done の Codex の行にも agent が付く', () => {
      const db = seed();
      cxSession(db, 'c1');
      run(db, 'run-c1', 'c1', { endedAt: NOW - HOUR });
      state(db, 'c1', { status: 'done', setAt: NOW - 2 * HOUR });
      expect(buildMobileFeed(src(db)).done.map((d) => [d.sessionId, d.agent])).toEqual([['c1', 'codex']]);
    });
  });
});
