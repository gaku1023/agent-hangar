import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { MAX_SCREEN_LINES, MAX_SEND_CHARS } from './screenTools.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';

let dir: string;
let db: Db;
let alphaId: string;
let live: LiveSessionDto[];
let screen: string | null;
const sends: { name: string; text: string; submit: boolean }[] = [];
let deps: ToolDeps;

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  db = openDb(':memory:');
  sends.length = 0;
  screen = 'line1\nline2\nline3\n\n\n';
  live = [];
  await new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  deps = {
    db, deviceId: 'd', port: 4177, live: () => live,
    runs: {
      start: () => { throw new Error('unused'); },
      readScreen: () => screen,
      sendInput: async (name, text, submit) => { sends.push({ name, text, submit }); },
    },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const addRun = (deviceId: string, tmuxName: string, id = 'rA') => {
  db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values (?, ?, ?, 'start', ?, '{}', null, 1, null, null, ?, 1, ?)").run(id, alphaId, deviceId, tmuxName, Date.now(), deviceId);
};
const goLive = (extra: Partial<LiveSessionDto> = {}) => { live = [{ sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: '/x', pid: 1, ...extra }]; };
const send = (args: Record<string, unknown>, ctx = { sessionId: null as string | null }) => callTool(deps, ctx, 'send_to_session', args) as Promise<Record<string, unknown>>;
const read = (args: Record<string, unknown>, ctx = { sessionId: null as string | null }) => callTool(deps, ctx, 'read_session_screen', args) as Record<string, unknown>;
const refusal = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { expect(e).toBeInstanceOf(ToolError); return (e as Error).message; }
  throw new Error('断られなかった');
};

describe('send_to_session', () => {
  it('道具の名前に入っている', () => {
    expect(TOOL_NAMES).toContain('send_to_session');
    expect(TOOL_NAMES).toContain('read_session_screen');
  });
  it('この PC の hangar の画面へ、複数行のまま送って確定する', async () => {
    addRun('d', 'hangar-rA');
    const r = await send({ session_id: alphaId, text: '一行目\n二行目' });
    expect(sends).toEqual([{ name: 'hangar-rA', text: '一行目\n二行目', submit: true }]);
    expect(r).toMatchObject({ session_id: alphaId, submitted: true });
  });
  it('submit を false にすると確定しない', async () => {
    addRun('d', 'hangar-rA');
    await send({ session_id: alphaId, text: 'x', submit: false });
    expect(sends[0]!.submit).toBe(false);
  });
  it('別のセッションの URL から呼んでも送れる（聞かずに許す）', async () => {
    addRun('d', 'hangar-rA');
    await send({ session_id: alphaId, text: 'x' }, { sessionId: 'other-session' });
    expect(sends).toHaveLength(1);
  });
  it('制御文字は落とし、改行は LF にそろえる（貼り付けの括弧を壊されない）', async () => {
    addRun('d', 'hangar-rA');
    await send({ session_id: alphaId, text: 'a\r\nb\u001b[201~c\u0000d\te' });
    expect(sends[0]!.text).toBe('a\nb[201~cd\te');
  });
  it('呼んだセッション自身へは断る', async () => {
    addRun('d', 'hangar-rA');
    const m = await refusal(send({ session_id: alphaId, text: 'x' }, { sessionId: alphaId }));
    expect(m).toContain('自分');
    expect(sends).toEqual([]);
  });
  it('動いていない会話は、resume_session で再開してからと促して断る', async () => {
    const m = await refusal(send({ session_id: alphaId, text: 'x' }));
    expect(m).toContain('resume_session');
    expect(sends).toEqual([]);
  });
  it('終わった run しか無い会話も、動いていないとして断る', async () => {
    db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values ('rE', ?, 'd', 'start', 'hangar-rE', '{}', null, 1, 2, 'exited', 2, 1, 'd')").run(alphaId);
    expect(await refusal(send({ session_id: alphaId, text: 'x' }))).toContain('resume_session');
  });
  it('ほかの PC で動く会話は、その PC の名前を添えて断る', async () => {
    db.prepare("insert into devices (id, name, platform, last_seen_at, updated_at, origin_device) values ('other', 'mini', 'darwin', ?, 1, 'other')").run(Date.now());
    addRun('other', 'hangar-rX');
    const m = await refusal(send({ session_id: alphaId, text: 'x' }));
    expect(m).toContain('mini');
    expect(sends).toEqual([]);
  });
  it('hangar の外の端末で動く会話（run が無く live だけ）は断る', async () => {
    goLive();
    const m = await refusal(send({ session_id: alphaId, text: 'x' }));
    expect(m).toContain('外部ターミナル');
    expect(sends).toEqual([]);
  });
  it('空の text と長すぎる text は断る', async () => {
    addRun('d', 'hangar-rA');
    expect(await refusal(send({ session_id: alphaId, text: '  ' }))).toContain('text');
    expect(await refusal(send({ session_id: alphaId, text: 'a'.repeat(MAX_SEND_CHARS + 1) }))).toContain(String(MAX_SEND_CHARS));
    await send({ session_id: alphaId, text: 'a'.repeat(MAX_SEND_CHARS) });
    expect(sends).toHaveLength(1);
  });
  it('session_id が無い、または無いセッションは断る', async () => {
    expect(await refusal(send({ text: 'x' }))).toContain('session_id');
    expect(await refusal(send({ session_id: 'nope', text: 'x' }))).toContain('nope');
  });
  it('画面の口が無ければ断る', async () => {
    addRun('d', 'hangar-rA');
    deps = { ...deps, runs: { start: deps.runs.start } };
    expect(await refusal(send({ session_id: alphaId, text: 'x' }))).toContain('tmux');
  });
  it('貼れなかった失敗は、断りの文にして返す', async () => {
    addRun('d', 'hangar-rA');
    deps = { ...deps, runs: { ...deps.runs, sendInput: async () => { throw new Error('tmux paste-buffer failed: boom'); } } };
    expect(await refusal(send({ session_id: alphaId, text: 'x' }))).toContain('boom');
  });
});

describe('read_session_screen', () => {
  it('画面の末尾を返し、live の状態を添える', () => {
    addRun('d', 'hangar-rA');
    goLive({ status: 'waiting', waitingFor: 'permission' });
    expect(read({ session_id: alphaId })).toEqual({ session_id: alphaId, status: 'waiting', waiting_for: 'permission', screen: 'line1\nline2\nline3' });
  });
  it('lines で末尾の行数を絞る。上限を越える指定は上限にする', () => {
    addRun('d', 'hangar-rA');
    goLive();
    expect(read({ session_id: alphaId, lines: 2 }).screen).toBe('line2\nline3');
    screen = Array.from({ length: MAX_SCREEN_LINES + 50 }, (_, i) => `l${i}`).join('\n');
    expect((read({ session_id: alphaId, lines: 100000 }).screen as string).split('\n')).toHaveLength(MAX_SCREEN_LINES);
  });
  it('自分自身も読める', () => {
    addRun('d', 'hangar-rA');
    goLive();
    expect(read({ session_id: alphaId }, { sessionId: alphaId }).screen).toBe('line1\nline2\nline3');
    expect(read({}, { sessionId: alphaId }).session_id).toBe(alphaId);
  });
  it('動いていなければ断る', async () => {
    expect(await refusal(() => read({ session_id: alphaId }))).toContain('resume_session');
  });
  it('ほかの PC と hangar の外の端末は断る', async () => {
    goLive();
    expect(await refusal(() => read({ session_id: alphaId }))).toContain('外部ターミナル');
  });
  it('画面が見つからなければ、動いていないとして断る', async () => {
    addRun('d', 'hangar-rA');
    screen = null;
    expect(await refusal(() => read({ session_id: alphaId }))).toContain('resume_session');
  });
  it('状態が無いとき（live に載っていない）は null を返す', () => {
    addRun('d', 'hangar-rA');
    expect(read({ session_id: alphaId })).toMatchObject({ status: null, waiting_for: null });
  });
});
