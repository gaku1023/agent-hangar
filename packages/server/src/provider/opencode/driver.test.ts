import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeLog, readFakeOpencodeRequests, writeFakeOpencode, type FakeOpencodeEvent, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import { until } from '../../../test/fake-opencode-events.ts';
import type { LaunchSpec } from '../../agent/types.ts';
import { openDb } from '../../db/open.ts';
import { readStoredPage } from '../../transcript/stored.ts';
import type { LaunchPrepDto } from '@agent-hangar/shared';
import { LaunchPreps } from '../../runs/launchPrep.ts';
import { createOpencodeDriver, type OpencodeDriverDeps } from './driver.ts';
import { ProviderPrepFailed, ProviderPreps } from './providerPrep.ts';
import { LocalModelListing } from './localModels/available.ts';
import { isAlive, ServeRegistry } from './serve/registry.ts';
import { ServeManager } from './serve/manager.ts';

const ev = <K extends FakeOpencodeEvent['ev']>(log: FakeOpencodeEvent[], k: K) => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: K }> => e.ev === k);

describe('opencode の driver（serve を起こさない面）', () => {
  const driver = createOpencodeDriver({ serves: () => null, droppedEnv: [] });
  it('Claude にしか無い操作は caps で持たない', () => {
    expect(driver.kind).toBe('opencode');
    expect(driver.caps).toEqual({ accounts: false, effort: false, permissionMode: false, remoteControl: false, fork: false, attachExternal: false, promptJump: false });
  });
  it('ID を先に決めない。hook は読まない。追記は途中でも差し替えられる', () => {
    expect(driver.launch.newSessionId).toBeUndefined();
    expect(driver.launch.materialize).toBeTypeOf('function');
    expect(driver.asks.parseHook).toBeUndefined();
    expect(driver.asks.subscribe).toBeTypeOf('function');
    expect(driver.instructions.when).toBe('live');
  });
  it('状態の面は会話を載せるまで空。トランスクリプトの面は本文を hangar の DB（agent_events）から読む', () => {
    expect(driver.live.current()).toEqual([]);
    expect(driver.live.isRunning('ses_x', 1)).toBe(false);
    const off = driver.live.onChange(() => {});
    off();
    expect(driver.transcript.readPage).toBe(readStoredPage);
    const db = openDb(':memory:');
    expect(driver.transcript.readPage(db, 'h1', {})).toEqual({ sessionId: 'h1', events: [], total: 0, nextSeq: null });
    db.close();
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

// 偽の opencode の serve を本当に起こす。
// serve の pid を偽の opencode の記録の pid と突き合わせる試験と、SIGTERM の記録（term）で止めた順を見る試験がある。
// Windows では偽の opencode が .cmd の包みの下の子になり（serve の pid は cmd.exe）、taskkill で止めるので term も残らない。Windows では飛ばす。
// serve の起こし方と止め方そのものの Windows の試験は serve/ の試験が受け持つ。
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
    const { bin, logFile, requestsFile } = writeFakeOpencode(path.join(dir, 'oc'), fake);
    const serves = new ServeManager({
      enabled: () => true, bin: () => bin, version: async () => '2.1.4', registry: new ServeRegistry(path.join(dir, 'serves.json')),
      env: { ...process.env, CLAUDECODE: '1', HANGAR_TOKEN: 'secret' }, killGraceMs: 300,
    });
    managers.push(serves);
    const reports: string[] = [];
    const driver = createOpencodeDriver({ serves: () => serves, droppedEnv: ['CLAUDECODE'], mcpPollMs: 10, mcpWaitMs: 2000, report: (what) => reports.push(what), ...over });
    return { driver, serves, bin, logFile, reports, log: () => readFakeOpencodeLog(logFile), requests: () => readFakeOpencodeRequests(requestsFile) };
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

  posixIt('許可のひな形を渡されたら、hangar の MCP と一緒に serve の設定（permissions）で重ねる。null なら重ねない', async () => {
    const rules = [{ action: 'shell', resource: '*', effect: 'ask' as const }];
    const seen: string[] = [];
    const on = make({}, { permissions: (c) => { seen.push(c); return rules; } });
    await on.driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(seen).toEqual([cwd]);
    expect(JSON.parse(ev(on.log(), 'start')[0]!.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({ mcp: { servers: { hangar: { type: 'remote' } } }, permissions: rules });
    await on.serves.stopAll();
    const off = make({}, { permissions: () => null });
    await off.driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(JSON.parse(ev(off.log(), 'start').at(-1)!.env.OPENCODE_CONFIG_CONTENT!)).not.toHaveProperty('permissions');
  });

  posixIt('serve は会話のフォルダで起こし、hangar から serve への要求はどれも会話のフォルダを指す', async () => {
    const { driver, serves, log, requests } = make({ activeIds: ['ses_busy'] });
    await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(fs.realpathSync(ev(log(), 'start')[0]!.cwd)).toBe(fs.realpathSync(cwd));
    expect(serves.get('h1')!.directory).toBe(cwd);
    // release は走っている作業を interrupt してから serve を止める。
    await driver.launch.release!({ sessionId: 'h1', providerSessionId: ev(log(), 'create')[0]!.id, cwd }, 'tui-gone');
    const reqs = requests();
    expect(reqs.some((r) => r.path === '/api/session/ses_busy/interrupt')).toBe(true);
    expect(reqs.filter((r) => r.directory !== cwd).map((r) => `${r.method} ${r.path}`)).toEqual([]);
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

  posixIt('準備コマンドの後、モデル確認の前にサーバーを起動し、再開時にも確かめる', async () => {
    const order: string[] = [];
    const preps = new LaunchPreps({ broadcast: () => {} });
    const providerPreps = new ProviderPreps({ preps: () => ({ lmstudio: { start: 'server-up', stop: '', stopAfter: 5 } }), run: async () => { order.push('command'); return { code: 0, tail: '' }; }, exitReason: String, timeoutReason: String });
    const { driver, log } = make({ providers: [{ id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' }] }, {
      providerPreps,
      localServers: { ensure: async (p) => { expect(p.id).toBe('lmstudio'); order.push('server'); } },
      localListing: new LocalModelListing({ fetch: (async () => { order.push('list'); return Response.json({ models: [{ type: 'llm', key: 'qwen3.8' }] }); }) as typeof fetch }),
    });
    const launched = await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { prep: { run: preps.begin(undefined), choice: {} } }));
    expect(order).toEqual(['command', 'server', 'list']);
    expect(ev(log(), 'create')).toHaveLength(1);
    order.length = 0;
    await driver.launch.materialize!({ kind: 'resume', id: launched!.providerSessionId }, spec(cwd, { prep: { run: preps.begin(undefined), choice: {} } }));
    expect(order).toContain('server');
    expect(ev(log(), 'create')).toHaveLength(1);
  });

  posixIt('サーバーの起動に失敗したら会話を作らず serve を解放する', async () => {
    const { driver, serves, log } = make({ providers: [{ id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' }] }, { localServers: { ensure: async () => { throw new Error('server failed'); } } });
    const run = new LaunchPreps({ broadcast: () => {} }).begin(undefined);
    await expect(driver.launch.materialize!({ kind: 'start' }, spec(cwd, { prep: { run, choice: {} } }))).rejects.toThrow('server failed');
    expect(ev(log(), 'create')).toHaveLength(0);
    expect(serves.get('h1')).toBeNull();
  });

  posixIt('会話を作れなければ投げて、起こした serve を止める', async () => {
    const { driver, serves, log } = make({ failCreate: true });
    await expect(driver.launch.materialize!({ kind: 'start' }, spec(cwd))).rejects.toThrow();
    expect(serves.get('h1')).toBeNull();
    const pid = ev(log(), 'start')[0]!.pid;
    expect(isAlive(pid)).toBe(false);
    expect(ev(log(), 'instructions')).toEqual([]);
  });

  posixIt('接続先の準備のコマンドは、会話を作る前に走らせる。失敗したら会話を作らずに serve を止めて断る', async () => {
    const runs: string[] = [];
    let code = 0;
    const providerPreps = new ProviderPreps({
      preps: () => ({ lmstudio: { start: 'gpu up', stop: 'gpu down', stopAfter: 5 } }),
      run: async (command) => { runs.push(command); return { code, tail: code ? 'no route to host' : '' }; },
      exitReason: (c) => `exit ${c}`, timeoutReason: (m) => `timeout ${m}`,
    });
    const sent: LaunchPrepDto[] = [];
    const preps = new LaunchPreps({ broadcast: (e) => { sent.push(structuredClone(e.prep)); } });
    const { driver, serves, log } = make({}, { providerPreps });
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { prep: { run: preps.begin('key-ok01'), choice: {} } }));
    expect(runs).toEqual(['gpu up']);
    expect(sent.at(-1)!.steps).toEqual([expect.objectContaining({ kind: 'command', action: 'run', target: 'LM Studio (local)', state: 'done' })]);
    expect(ev(log(), 'create')).toHaveLength(1);
    await driver.launch.release!({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed');
    providerPreps.dispose();
    code = 10;
    await expect(driver.launch.materialize!({ kind: 'start' }, spec(cwd, { prep: { run: preps.begin('key-ng01'), choice: {} } }))).rejects.toThrow(new ProviderPrepFailed('no route to host'));
    expect(ev(log(), 'create')).toHaveLength(1);
    expect(serves.get('h1')).toBeNull();
    // 準備の無い接続先だけを使う会話では走らせない。「そのまま開始」の答えでも走らせない。
    runs.length = 0;
    await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { model: 'opencode/big', prep: { run: preps.begin('key-ot01'), choice: {} } }));
    await serves.stopAll();
    await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { prep: { run: preps.begin('key-sk01'), choice: { skip: true } } }));
    expect(runs).toEqual([]);
  });

  posixIt('フォークは受けない（materialize も plan も）', async () => {
    const { driver, log } = make();
    await expect(driver.launch.materialize!({ kind: 'fork', id: 'ses_x', newId: 'ses_y' }, spec(cwd))).rejects.toThrow();
    expect(() => driver.launch.plan('/bin/oc', { kind: 'fork', id: 'ses_x', newId: 'ses_y' }, spec(cwd))).toThrow();
    expect(ev(log(), 'start')).toEqual([]);
  });

  posixIt('再開は serve を止めて新しい MCP の秘密で起こし直し、会話は作らず、追記を PUT し直し、MCP を待ち、写しに載せ直す', async () => {
    const { driver, serves, log } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    const id = r!.providerSessionId;
    const first = serves.get('h1')!;
    const again = await driver.launch.materialize!({ kind: 'resume', id }, spec(cwd, { mcp: { url: 'http://127.0.0.1:4177/mcp/s/h1', secret: 'run-secret-2' } }));
    expect(again).toEqual({ providerSessionId: id });
    const l = log();
    // 前の serve は止め、新しい秘密で起こし直す（起きている serve には新しい設定を当て直せない）。
    const starts = ev(l, 'start');
    expect(starts).toHaveLength(2);
    expect(isAlive(first.pid)).toBe(false);
    expect(JSON.parse(starts[1]!.env.OPENCODE_CONFIG_CONTENT!).mcp.servers.hangar.headers).toEqual({ Authorization: 'Bearer run-secret-2' });
    const second = serves.get('h1')!;
    expect(second.pid).toBe(starts[1]!.pid);
    // 会話は作らない。追記は同じ会話に PUT し直し、MCP の接続を待つ。
    expect(ev(l, 'create')).toHaveLength(1);
    expect(ev(l, 'instructions').map((e) => [e.pid, e.id])).toEqual([[first.pid, id], [second.pid, id]]);
    expect(ev(l, 'mcp').filter((m) => m.pid === second.pid).at(-1)?.status).toBe('connected');
    // 状態の面は新しい serve で載せ直す。
    expect(driver.live.current()).toEqual([expect.objectContaining({ sessionId: id, pid: second.pid, agent: 'opencode' })]);
    // plan は -s で既存の会話につなぐ。パスワードは argv に無く、秘密の環境で渡す。
    const plan = driver.launch.plan('/bin/oc', { kind: 'resume', id }, spec(cwd));
    expect(plan.argv).toEqual(['/bin/oc', cwd, '--server', second.url, '-s', id]);
    expect(plan.argv.join(' ')).not.toContain(second.password);
    expect(plan.secretEnv).toEqual({ OPENCODE_PASSWORD: second.password });
  });

  posixIt('再開で serve を起こせなければ投げる。追記の差し込みも写しへの載せ直しもしない', async () => {
    const { driver, serves, log } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'tui-gone');
    const off = createOpencodeDriver({ serves: () => ({ ensure: () => Promise.reject(new Error('disabled')), get: (x) => serves.get(x), stop: (x) => serves.stop(x) }), droppedEnv: [] });
    await expect(off.launch.materialize!({ kind: 'resume', id: r!.providerSessionId }, spec(cwd))).rejects.toThrow('disabled');
    expect(off.live.current()).toEqual([]);
    expect(ev(log(), 'instructions')).toHaveLength(1);
  });

  for (const cause of ['tui-gone', 'parked', 'killed'] as const) {
    posixIt(`release（${cause}）は走っている作業を interrupt してから serve を止め、写しから外す`, async () => {
      const { driver, serves, log } = make({ activeIds: ['ses_busy'] });
      const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
      const pid = serves.get('h1')!.pid;
      expect(await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, cause)).toBe(true);
      const l = log();
      const interrupt = ev(l, 'interrupt');
      expect(interrupt.map((e) => e.id)).toEqual(['ses_busy']);
      expect(interrupt[0]!.t).toBeLessThanOrEqual(ev(l, 'term')[0]!.t);
      expect(serves.get('h1')).toBeNull();
      expect(isAlive(pid)).toBe(false);
      expect(driver.live.current()).toEqual([]);
    });
  }

  posixIt('hangar の会話の ID を渡さなくても、作った会話なら serve を引いて止める（再起動の後は呼び手が ID を渡す）', async () => {
    const { driver, serves } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(await driver.launch.release({ providerSessionId: r!.providerSessionId, cwd }, 'tui-gone')).toBe(true);
    expect(serves.get('h1')).toBeNull();
  });

  posixIt('serve の無い会話の release は何も起こさない（開いていない会話の serve を起こさない）', async () => {
    const { driver, log } = make();
    expect(await driver.launch.release({ sessionId: 'h-old', providerSessionId: 'ses_old', cwd }, 'tui-gone')).toBe(false);
    expect(log()).toEqual([]);
  });

  posixIt('release は serve を止める', async () => {
    const { driver, serves, log } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    expect(await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed')).toBe(true);
    expect(serves.get('h1')).toBeNull();
    expect(isAlive(ev(log(), 'start')[0]!.pid)).toBe(false);
    expect(await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed')).toBe(false);
  });

  posixIt('作った会話を状態の面に載せ（serve の pid、opencode の印）、release で外す', async () => {
    const { driver, serves } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    const pid = serves.get('h1')!.pid;
    expect(driver.live.current()).toEqual([expect.objectContaining({ sessionId: r!.providerSessionId, status: 'idle', cwd, pid, agent: 'opencode' })]);
    expect(driver.live.isRunning(r!.providerSessionId, pid)).toBe(true);
    await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed');
    expect(driver.live.current()).toEqual([]);
    expect(driver.live.isRunning(r!.providerSessionId, pid)).toBe(false);
  });

  posixIt('作った会話の本文を写しに載せて読み（/message）、release では serve を止める前にもう一度読む', async () => {
    const { driver, log } = make();
    const batches: unknown[] = [];
    driver.transcript.start({ batch: (b) => batches.push(b), named: () => {}, rescan: () => {}, historyChanged: () => {}, error: () => {} });
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd));
    await until(() => ev(log(), 'messages').length >= 1);
    expect(ev(log(), 'messages')[0]).toMatchObject({ id: r!.providerSessionId });
    const before = ev(log(), 'messages').length;
    await driver.launch.release({ sessionId: 'h1', providerSessionId: r!.providerSessionId, cwd }, 'killed');
    const reads = ev(log(), 'messages');
    expect(reads.length).toBe(before + 1);
    expect(reads.at(-1)!.t).toBeLessThanOrEqual(ev(log(), 'interrupt')[0]?.t ?? ev(log(), 'term')[0]!.t);
    driver.transcript.stop();
    expect(batches).toEqual([]);
  });

  posixIt('instructions.update は、その会話の serve に PUT し直す', async () => {
    const { driver, log } = make();
    const r = await driver.launch.materialize!({ kind: 'start' }, spec(cwd, { instructions: [] }));
    await driver.instructions.update!(r!.providerSessionId, [{ key: 'body', text: '新しい指示\n' }]);
    expect(ev(log(), 'instructions')).toEqual([expect.objectContaining({ id: r!.providerSessionId, key: 'hangar', body: { value: '新しい指示\n' } })]);
  });
});
