import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, noteTurnStart, STARTUP_GRACE_MS, TURN_START_GRACE_MS, waitForSessionTool, type WaitClock, type WaitResult } from './waitTool.ts';

let dir: string;
let db: Db;
let alphaId: string;
let live: LiveSessionDto[];
let deps: ToolDeps;
let t: number;
/** 眠るたびに時計を進め、その時刻の出来事を起こす。 */
let script: { at: number; run: () => void }[];
let clock: WaitClock;

const T0 = 1_800_000_000_000;

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  db = openDb(':memory:');
  live = [];
  script = [];
  t = T0;
  clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      for (const s of script.filter((x) => x.at <= t)) s.run();
      script = script.filter((x) => x.at > t);
    },
  };
  await new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  deps = {
    db, deviceId: 'd', port: 4177, live: () => live,
    runs: { start: () => { throw new Error('unused'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const row = (extra: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: '/x', pid: 1, ...extra });
const goLive = (extra: Partial<LiveSessionDto> = {}) => { live = [row(extra)]; };
const at = (ms: number, run: () => void) => { script.push({ at: T0 + ms, run }); };
const wait = (args: Record<string, unknown> = {}, ctx = { sessionId: null as string | null }) => waitForSessionTool(deps, ctx, { session_id: alphaId, ...args }, clock) as Promise<WaitResult>;
const addRun = (deviceId: string) => {
  db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values ('rA', ?, ?, 'start', 'hangar-rA', '{}', null, 1, null, null, ?, 1, ?)").run(alphaId, deviceId, Date.now(), deviceId);
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ToolError); return (e as Error).message; }
  throw new Error('断られなかった');
};

describe('wait_for_session', () => {
  it('道具の名前に入り、callTool から呼べる', async () => {
    expect(TOOL_NAMES).toContain('wait_for_session');
    goLive();
    const r = await callTool(deps, { sessionId: null }, 'wait_for_session', { session_id: alphaId, timeout_seconds: 0 }) as WaitResult;
    expect(r.state).toBe('finished');
  });

  it('動いている間は待ち、ターンが終わったら finished と最後の返答を返す', async () => {
    goLive({ status: 'busy' });
    at(3000, () => goLive({ status: 'idle' }));
    const r = await wait({ timeout_seconds: 60 });
    expect(r.state).toBe('finished');
    expect(r.session_id).toBe(alphaId);
    expect(r.waited_seconds).toBeGreaterThanOrEqual(3);
    expect(typeof r.last_message).toBe('string');
    expect(r.url).toContain(`session/${alphaId}`);
  });

  it('入力待ちになったら waiting と、何を待っているかを返す', async () => {
    goLive({ status: 'busy' });
    at(2000, () => goLive({ status: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm x', description: null } }));
    const r = await wait({ timeout_seconds: 60 });
    expect(r.state).toBe('waiting');
    expect(r.waiting).toEqual({ kind: 'permission', text: 'Bash: rm x' });
  });

  it('上限まで動いていれば timeout を返す。呼び手はもう一度呼べる', async () => {
    goLive({ status: 'busy' });
    const r = await wait({ timeout_seconds: 5 });
    expect(r.state).toBe('timeout');
    expect(r.status).toBe('busy');
    expect(t - T0).toBeLessThanOrEqual(6000);
  });

  it('timeout_seconds の 0 は、いまの様子を 1 回だけ見て返す', async () => {
    goLive({ status: 'busy' });
    expect((await wait({ timeout_seconds: 0 })).state).toBe('timeout');
    expect(t).toBe(T0);
  });

  it('省くと既定の上限まで待ち、上限を越えた指定は丸める', async () => {
    goLive({ status: 'busy' });
    await wait();
    expect(t - T0).toBeGreaterThanOrEqual(DEFAULT_WAIT_SECONDS * 1000);
    expect(t - T0).toBeLessThan((DEFAULT_WAIT_SECONDS + 2) * 1000);
    t = T0;
    await wait({ timeout_seconds: MAX_WAIT_SECONDS + 1000 });
    expect(t - T0).toBeLessThan((MAX_WAIT_SECONDS + 2) * 1000);
  });

  it('動いていない会話は failed（not_running）で返す', async () => {
    const r = await wait({ timeout_seconds: 60 });
    expect(r).toMatchObject({ state: 'failed', reason: 'not_running' });
    expect(t).toBe(T0);
  });

  it('待っている間にプロセスが消えたら failed（not_running）で返す', async () => {
    goLive({ status: 'busy' });
    at(2000, () => { live = []; });
    const r = await wait({ timeout_seconds: 60 });
    expect(r).toMatchObject({ state: 'failed', reason: 'not_running' });
  });

  it('run があるのに live に載らないまま（フォルダの信頼の問いなど）は、画面の末尾を添えて waiting で返す', async () => {
    addRun('d');
    deps.runs.readScreen = () => 'Accessing workspace\n\n  Yes, I trust this folder\n\n';
    const r = await wait({ timeout_seconds: 600 });
    expect(r.state).toBe('waiting');
    expect(r.waiting).toEqual({ kind: 'other', text: 'Accessing workspace\nYes, I trust this folder' });
    expect(t - T0).toBeGreaterThanOrEqual(STARTUP_GRACE_MS);
    expect(t - T0).toBeLessThan(STARTUP_GRACE_MS + 2000);
  });

  it('動いたあとで live から消えたら、run が残っていても failed で返す', async () => {
    addRun('d');
    goLive({ status: 'busy' });
    at(2000, () => { live = []; });
    expect(await wait({ timeout_seconds: 600 })).toMatchObject({ state: 'failed', reason: 'not_running' });
    expect(t - T0).toBeLessThan(5000);
  });

  it('使用制限で止まっていれば failed（limit）で返す', async () => {
    goLive({ status: 'idle' });
    db.prepare("insert into session_limits (session_id, kind, resets_at, auto, hit_at) values (?, 'five_hour', ?, 0, 1)").run(alphaId, T0 + 3_600_000);
    const r = await wait({ timeout_seconds: 60 });
    expect(r).toMatchObject({ state: 'failed', reason: 'limit' });
  });

  it('自分自身は待てない。知らない会話とほかの PC の会話は断る', async () => {
    goLive();
    expect(await refusal(wait({}, { sessionId: alphaId }))).toMatch(/自分自身/);
    expect(await refusal(wait({ session_id: 'nope' }))).toMatch(/nope/);
    addRun('other');
    expect(await refusal(wait())).toMatch(/other/);
  });

  describe('送った直後（前のターンの idle を終わりと読まない）', () => {
    it('送った時刻より古い idle は、ターンの始まりを待つ', async () => {
      goLive({ status: 'idle', statusAt: T0 - 1000 });
      noteTurnStart(db, alphaId, { at: T0 });
      at(2000, () => goLive({ status: 'busy', statusAt: T0 + 2000 }));
      at(5000, () => goLive({ status: 'idle', statusAt: T0 + 5000 }));
      const r = await wait({ timeout_seconds: 60 });
      expect(t - T0).toBeGreaterThanOrEqual(5000);
      expect(r.state).toBe('finished');
      expect(r.turn_started).toBe(true);
    });

    it('送った後の返答がまだ無ければ、前のターンの返答を last_message に出さない', async () => {
      goLive({ status: 'busy', statusAt: T0 });
      noteTurnStart(db, alphaId, { at: T0 });
      const r = await wait({ timeout_seconds: 1 });
      expect(r.state).toBe('timeout');
      expect(r.last_message).toBeNull();
    });

    it('送った時刻より古い入力待ちは、答えたものとして待つ', async () => {
      goLive({ status: 'waiting', statusAt: T0 - 1000, waitingFor: 'question' });
      noteTurnStart(db, alphaId, { at: T0 });
      at(2000, () => goLive({ status: 'busy', statusAt: T0 + 2000 }));
      at(4000, () => goLive({ status: 'waiting', statusAt: T0 + 4000, waitingFor: 'question' }));
      const r = await wait({ timeout_seconds: 60 });
      expect(t - T0).toBeGreaterThanOrEqual(4000);
      expect(r.state).toBe('waiting');
    });

    it('猶予を過ぎても始まらなければ turn_started: false で返す（待ち続けない）', async () => {
      goLive({ status: 'idle', statusAt: T0 - 1000 });
      noteTurnStart(db, alphaId, { at: T0 });
      const r = await wait({ timeout_seconds: 600 });
      expect(r.state).toBe('finished');
      expect(r.turn_started).toBe(false);
      expect(t - T0).toBeGreaterThanOrEqual(TURN_START_GRACE_MS);
      expect(t - T0).toBeLessThan(TURN_START_GRACE_MS + 2000);
    });

    it('起動直後の idle（statusAt は新しいが返答がまだ無い）は終わりと読まない', async () => {
      goLive({ status: 'idle', statusAt: T0 + 500 });
      noteTurnStart(db, alphaId, { at: T0 });
      at(1000, () => goLive({ status: 'busy', statusAt: T0 + 1000 }));
      at(4000, () => goLive({ status: 'idle', statusAt: T0 + 4000 }));
      await wait({ timeout_seconds: 60 });
      expect(t - T0).toBeGreaterThanOrEqual(4000);
    });

    it('起動の途中（live に載る前）は、猶予の間は待つ', async () => {
      noteTurnStart(db, alphaId, { at: T0 });
      at(3000, () => goLive({ status: 'busy', statusAt: T0 + 3000 }));
      at(6000, () => goLive({ status: 'idle', statusAt: T0 + 6000 }));
      const r = await wait({ timeout_seconds: 60 });
      expect(r.state).toBe('finished');
      expect(t - T0).toBeGreaterThanOrEqual(6000);
    });

    it('起動前の準備が走っている間は、猶予を過ぎても待つ', async () => {
      let preparing = true;
      deps.runs.prepRunning = (key) => key === 'k1' && preparing;
      noteTurnStart(db, alphaId, { at: T0, prepKey: 'k1' });
      const later = TURN_START_GRACE_MS + 60_000;
      at(later, () => { preparing = false; goLive({ status: 'busy', statusAt: T0 + later }); });
      at(later + 3000, () => goLive({ status: 'idle', statusAt: T0 + later + 3000 }));
      const r = await wait({ timeout_seconds: 600 });
      expect(r.state).toBe('finished');
      expect(t - T0).toBeGreaterThanOrEqual(later + 3000);
    });

    it('印の無い会話の idle は、そのまま終わりと読む', async () => {
      goLive({ status: 'idle', statusAt: T0 - 1000 });
      const r = await wait({ timeout_seconds: 60 });
      expect(r.state).toBe('finished');
      expect(t).toBe(T0);
      expect(r.turn_started).toBeUndefined();
    });
  });

  describe('send_to_session と create_session が印を残す', () => {
    it('send_to_session の直後の idle を、すぐ終わりと読まない', async () => {
      addRun('d');
      deps.runs.sendInput = async () => undefined;
      goLive({ status: 'idle', statusAt: T0 - 1000 });
      // 印の時刻は実際の時計なので、statusAt より新しい。
      await callTool(deps, { sessionId: null }, 'send_to_session', { session_id: alphaId, text: 'hi' });
      const realNow = Date.now();
      t = realNow;
      script.push({ at: realNow + 2000, run: () => goLive({ status: 'busy', statusAt: realNow + 2000 }) });
      script.push({ at: realNow + 4000, run: () => goLive({ status: 'idle', statusAt: realNow + 4000 }) });
      await wait({ timeout_seconds: 60 });
      expect(t - realNow).toBeGreaterThanOrEqual(4000);
    });

    it('submit: false は入力欄に置くだけなので印を残さない', async () => {
      addRun('d');
      deps.runs.sendInput = async () => undefined;
      goLive({ status: 'idle', statusAt: T0 - 1000 });
      await callTool(deps, { sessionId: null }, 'send_to_session', { session_id: alphaId, text: 'hi', submit: false });
      await wait({ timeout_seconds: 60 });
      expect(t).toBe(T0);
    });

    it('create_session の prompt 付きの起動は印を残す。prompt なしは返答を求めない', async () => {
      upsertProject();
      deps.runs.start = () => ({ sessionId: alphaId, run: { id: 'r', tmuxName: 'hangar-r' } }) as never;
      await callTool(deps, { sessionId: null }, 'create_session', { project_id: 'p1', prompt: 'hi' });
      t = Date.now();
      goLive({ status: 'idle', statusAt: t + 60_000 });
      // 起動直後の idle で、返答がまだ無いので、猶予の間は終わりと読まない。
      expect((await wait({ timeout_seconds: 0 })).state).toBe('timeout');
      await callTool(deps, { sessionId: null }, 'create_session', { project_id: 'p1' });
      t = Date.now();
      goLive({ status: 'idle', statusAt: t + 60_000 });
      expect((await wait({ timeout_seconds: 0 })).state).toBe('finished');
    });
  });
});

function upsertProject() {
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
}
