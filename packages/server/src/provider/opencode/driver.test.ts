import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import type { LaunchSpec } from '../../agent/types.ts';
import { createOpencodeDriver, type OpencodeDriverDeps } from './driver.ts';
import { isAlive, ServeRegistry } from './serve/registry.ts';
import { ServeManager } from './serve/manager.ts';

const ev = <K extends FakeOpencodeEvent['ev']>(log: FakeOpencodeEvent[], k: K) => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: K }> => e.ev === k);

describe('opencode の driver（serve を起こさない面）', () => {
  const driver = createOpencodeDriver({ serves: () => null, droppedEnv: [] });
  it('Claude にしか無い操作は caps で持たない', () => {
    expect(driver.kind).toBe('opencode');
    expect(driver.caps).toEqual({ accounts: false, effort: false, permissionMode: false, remoteControl: false, fork: false, attachExternal: false });
  });
  it('ID を先に決めない。hook は読まない。追記は途中でも差し替えられる', () => {
    expect(driver.launch.newSessionId).toBeUndefined();
    expect(driver.launch.materialize).toBeTypeOf('function');
    expect(driver.asks.parseHook).toBeUndefined();
    expect(driver.instructions.when).toBe('live');
  });
  it('状態とトランスクリプトの面は B4・B5 まで空のまま', () => {
    expect(driver.live.current()).toEqual([]);
    expect(driver.live.isRunning('ses_x', 1)).toBe(false);
    const off = driver.live.onChange(() => {});
    off();
    expect(driver.transcript.readPage(null as never, 'h1', {})).toEqual({ sessionId: 'h1', events: [], total: 0, nextSeq: null });
  });
  it('serve の管理がまだ無ければ、起こさずに断る', async () => {
    await expect(driver.launch.materialize!({ kind: 'start' }, spec('/w'))).rejects.toThrow();
  });
});

function spec(cwd: string, over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    cwd, hangarSessionId: 'h1', name: '名前', model: 'lmstudio/qwen3.8', mode: 'plan',
    mcp: { url: 'http://127.0.0.1:4177/mcp/s/h1', secret: 'run-secret' },
    instructions: [{ key: 'body', text: 'あなたは agent-hangar から起動されたセッションです。\n' }, { key: 'live', text: '各ターンの最初の一手で。\n' }],
    env: {},
    ...over,
  };
}

// 偽の opencode の serve を本当に起こす。止め方が POSIX のものなので、Windows では飛ばす。
posixDescribe('opencode の driver の materialize', () => {
  let dir: string;
  let cwd: string;
  let managers: ServeManager[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-driver-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-cwd-'));
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) await m.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const make = (fake: FakeOpencodeOptions = {}, over: Partial<OpencodeDriverDeps> = {}) => {
    const { bin, logFile } = writeFakeOpencode(path.join(dir, 'oc'), fake);
    const serves = new ServeManager({
      enabled: () => true, bin: () => bin, version: async () => '2.1.4', registry: new ServeRegistry(path.join(dir, 'serves.json')),
      env: { ...process.env, CLAUDECODE: '1', HANGAR_TOKEN: 'secret' }, killGraceMs: 300,
    });
    managers.push(serves);
    const reports: string[] = [];
    const driver = createOpencodeDriver({ serves: () => serves, droppedEnv: ['CLAUDECODE'], mcpPollMs: 10, mcpWaitMs: 2000, report: (what) => reports.push(what), ...over });
    return { driver, serves, bin, logFile, reports, log: () => readFakeOpencodeLog(logFile) };
  };

  posixIt('serve を起こし、ID を付けずに会話を作り、追記を PUT し、MCP がつながるのを待ってから返す', async () => {
    const { driver, serves, log } = make({ mcpPendingPolls: 2 });
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    const l = log();
    const create = ev(l, 'create');
    expect(create).toHaveLength(1);
    expect(r).toEqual({ providerSessionId: create[0]!.id });
    // ID は opencode に振らせる（hangar が決めた ID は Zen の無料枠が 403 で断る）。
    expect(create[0]!.body).not.toHaveProperty('id');
    expect(create[0]!.body).toEqual({ location: { directory: cwd }, title: '名前', agent: 'plan', model: { providerID: 'lmstudio', id: 'qwen3.8' } });
    // 段はつないで 1 つの鍵で送る（検証した条件と同じく <context key="hangar"> の 1 つになる）。
    expect(ev(l, 'instructions')).toEqual([expect.objectContaining({ id: create[0]!.id, key: 'hangar', body: { value: 'あなたは agent-hangar から起動されたセッションです。\n各ターンの最初の一手で。\n' } })]);
    const mcp = ev(l, 'mcp');
    expect(mcp.map((m) => m.status)).toEqual(['pending', 'pending', 'connected']);
    expect(mcp.every((m) => m.directory === cwd)).toBe(true);
    // 順番：serve の起動 → 作成 → PUT → MCP の確かめ。
    expect(l.filter((e) => e.ev !== 'ready').map((e) => e.ev)).toEqual(['start', 'create', 'instructions', 'mcp', 'mcp', 'mcp']);
    // hangar の MCP は serve の設定で渡し、run の秘密は header に入る。CLAUDE と HANGAR_ の鍵は渡さない。
    const env = ev(l, 'start')[0]!.env;
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ mcp: { servers: { hangar: { type: 'remote', url: 'http://127.0.0.1:4177/mcp/s/h1', headers: { Authorization: 'Bearer run-secret' } } } } });
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE') || k.startsWith('HANGAR_'))).toEqual([]);
    expect(ev(l, 'start')[0]!.argv.join(' ')).not.toContain('run-secret');
    // plan は起こした serve につなぐ。
    const info = serves.get('h1')!;
    const plan = driver.launch.plan('/bin/oc', { kind: 'start', id: r!.providerSessionId }, spec(cwd));
    expect(plan.argv).toEqual(['/bin/oc', cwd, '--server', info.url, '-s', r!.providerSessionId]);
    expect(plan.env).toEqual({});
    expect(plan.secretEnv).toEqual({ OPENCODE_PASSWORD: info.password });
  });

  posixIt('追記の段が無ければ PUT しない', async () => {
    const { driver, log } = make();
    await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { instructions: [] }));
    expect(ev(log(), 'instructions')).toEqual([]);
    expect(ev(log(), 'create')).toHaveLength(1);
  });

  posixIt('指示の API が無い版でも起動は続け、知らせだけ出す', async () => {
    const { driver, log, reports } = make({ instructionsStatus: 404 });
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(r?.providerSessionId).toBe(ev(log(), 'create')[0]!.id);
    expect(reports).toContain('instructions');
  });

  posixIt('MCP がつながらなくても、上限で待つのをやめて起動は続ける。failed なら待たない', async () => {
    const never = make({ mcp: 'never' }, { mcpWaitMs: 150 });
    expect(await never.driver.launch.materialize!({ kind: 'start' }, spec(cwd))).toHaveProperty('providerSessionId');
    expect(never.reports).toContain('mcp');
    await never.serves.stopAll();
    fs.rmSync(path.join(dir, 'oc'), { recursive: true, force: true });
    const failed = make({ mcp: 'failed' });
    await failed.driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(ev(failed.log(), 'mcp')).toHaveLength(1);
    expect(failed.reports).toContain('mcp');
  });

  posixIt('会話を作れなければ投げて、起こした serve を止める', async () => {
    const { driver, serves, log } = make({ failCreate: true });
    await expect(driver.launch.materialize!({ kind: 'start' }, spec(cwd))).rejects.toThrow();
    expect(serves.get('h1')).toBeNull();
    const pid = ev(log(), 'start')[0]!.pid;
    expect(isAlive(pid)).toBe(false);
    expect(ev(log(), 'instructions')).toEqual([]);
  });

  posixIt('再開とフォークはまだ受けない（B6）', async () => {
    const { driver, log } = make();
    await expect(driver.launch.materialize!({ kind: 'resume', id: 'ses_x' }, spec(cwd))).rejects.toThrow();
    expect(ev(log(), 'start')).toEqual([]);
  });

  posixIt('release は serve を止める', async () => {
    const { driver, serves, log } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed')).toBe(true);
    expect(serves.get('h1')).toBeNull();
    expect(isAlive(ev(log(), 'start')[0]!.pid)).toBe(false);
    expect(await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed')).toBe(false);
  });

  posixIt('instructions.update は、その会話の serve に PUT し直す', async () => {
    const { driver, log } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { instructions: [] }));
    await driver.instructions.update!(r!.providerSessionId, [{ key: 'body', text: '新しい指示\n' }]);
    expect(ev(log(), 'instructions')).toEqual([expect.objectContaining({ id: r!.providerSessionId, key: 'hangar', body: { value: '新しい指示\n' } })]);
  });
});
