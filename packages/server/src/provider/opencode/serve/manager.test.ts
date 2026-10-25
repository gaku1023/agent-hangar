import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent, type FakeOpencodeOptions } from '../../../../test/fake-opencode.ts';
import { isWindows, posixIt } from '../../../../test/platform.ts';
import { OpencodeDisabledError, ServeManager, type OpencodeVersionNoticeSeed, type ServeManagerDeps } from './manager.ts';
import { isAlive, ServeRegistry } from './registry.ts';
import { killGroup } from './spawn.ts';

// hangar を Claude Code のセッションから起こしたときにサーバの環境に入っている印。
const dirtyEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_ENTRYPOINT: 'cli',
  HANGAR_RUN_ID: 'r1', HANGAR_TOKEN: 'secret', HANGAR_HOME: '/x',
};

const starts = (log: FakeOpencodeEvent[]): Extract<FakeOpencodeEvent, { ev: 'start' }>[] => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: 'start' }> => e.ev === 'start');

// 偽の opencode を本当に起こして止める。
// Windows には SIGTERM が無く、interrupt の後は taskkill で木ごと強制で止めるので、偽の opencode に term の記録が残らない。
describe('ServeManager', () => {
  let dir: string;
  let managers: ServeManager[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-mgr-'));
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) await m.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (fake: FakeOpencodeOptions = {}, deps: Partial<ServeManagerDeps> = {}): { m: ServeManager; logFile: string; registry: ServeRegistry } => {
    const { bin, logFile } = writeFakeOpencode(path.join(dir, 'oc'), fake);
    const registry = new ServeRegistry(path.join(dir, 'serves.json'));
    const m = new ServeManager({
      enabled: () => true,
      bin: () => bin,
      version: async () => '2.1.4',
      registry,
      env: dirtyEnv,
      killGraceMs: 300,
      lockDelaysMs: [20, 40, 80],
      ...deps,
    });
    managers.push(m);
    return { m, logFile, registry };
  };

  it('5 本を同時に頼んでも、起動は 1 本ずつ。前の 1 本が応答してから次を起こす', async () => {
    const { m, logFile } = make({ startDelayMs: 80 });
    const infos = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => m.ensure(id)));
    expect(new Set(infos.map((i) => i.pid)).size).toBe(5);
    const log = readFakeOpencodeLog(logFile);
    expect(starts(log)).toHaveLength(5);
    expect(log.filter((e) => e.ev === 'exit')).toEqual([]);
    // 各起動は、ひとつ前の起動の待ち受けの後に始まる。
    const evs = log.filter((e) => e.ev === 'start' || e.ev === 'ready').map((e) => e.ev);
    expect(evs).toEqual(['start', 'ready', 'start', 'ready', 'start', 'ready', 'start', 'ready', 'start', 'ready']);
  });

  it('database is locked で落ちたら、間をあけて起こし直す', async () => {
    const { m, logFile } = make({ failLockTimes: 2 });
    const info = await m.ensure('a');
    expect(isAlive(info.pid)).toBe(true);
    const log = readFakeOpencodeLog(logFile);
    expect(starts(log)).toHaveLength(3);
    expect(log.filter((e) => e.ev === 'exit').map((e) => e.ev === 'exit' && e.reason)).toEqual(['locked', 'locked']);
  });

  it('ロックが 3 回の起こし直しでも解けなければ諦める', async () => {
    const { m, logFile } = make({ failLockTimes: 10 });
    await expect(m.ensure('a')).rejects.toMatchObject({ reason: 'locked' });
    expect(starts(readFakeOpencodeLog(logFile))).toHaveLength(4);
  });

  it('env に CLAUDE で始まる鍵と HANGAR_* が 1 つも無く、パスワードは argv にも記録のファイルにも無い', async () => {
    const { m, logFile } = make();
    const info = await m.ensure('a');
    const [start] = starts(readFakeOpencodeLog(logFile));
    const keys = Object.keys(start?.env ?? {});
    expect(keys.filter((k) => k.startsWith('CLAUDE'))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('HANGAR_'))).toEqual([]);
    expect(start?.env.OPENCODE_SERVER_PASSWORD).toBe(info.password);
    expect(start?.argv.some((a) => a.includes(info.password))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'serves.json'), 'utf8')).not.toContain(info.password);
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('any は起きている serve のどれか 1 本を返す。1 本も無ければ null', async () => {
    const { m } = make();
    expect(m.any()).toBeNull();
    const a = await m.ensure('a');
    expect(m.any()).toEqual(a);
    await m.stop('a');
    expect(m.any()).toBeNull();
  });

  it('同じ会話を 2 度頼んでも 1 本だけ起こす', async () => {
    const { m, logFile } = make();
    const [a, b] = await Promise.all([m.ensure('a'), m.ensure('a')]);
    expect(a).toEqual(b);
    expect(await m.ensure('a')).toEqual(a);
    expect(starts(readFakeOpencodeLog(logFile))).toHaveLength(1);
  });

  it('止めるときは interrupt、SIGTERM の順。記録からも消す', async () => {
    const { m, logFile, registry } = make({ activeIds: ['ses_x', 'ses_y'] });
    const info = await m.ensure('a');
    expect(registry.list().map((r) => r.pid)).toEqual([info.pid]);
    await m.stop('a');
    expect(isAlive(info.pid)).toBe(false);
    const evs = readFakeOpencodeLog(logFile).filter((e) => e.ev === 'interrupt' || e.ev === 'term').map((e) => (e.ev === 'interrupt' ? `interrupt:${e.id}` : e.ev));
    expect(evs).toEqual(isWindows ? ['interrupt:ses_x', 'interrupt:ses_y'] : ['interrupt:ses_x', 'interrupt:ses_y', 'term']);
    expect(registry.list()).toEqual([]);
    expect(m.get('a')).toBeNull();
  });

  it('止めている途中に重ねて頼まれたら、どちらも止め終わるまで待つ', async () => {
    const { m } = make({ ignoreTerm: true });
    const info = await m.ensure('a');
    const first = m.stop('a');
    await m.stop('a');
    expect(isAlive(info.pid)).toBe(false);
    await first;
  });

  posixIt('SIGTERM で降りなければ、間をおいて SIGKILL で止める', async () => {
    const { m, logFile } = make({ ignoreTerm: true });
    const info = await m.ensure('a');
    const t0 = Date.now();
    await m.stop('a');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(isAlive(info.pid)).toBe(false);
    expect(readFakeOpencodeLog(logFile).filter((e) => e.ev === 'term')).toHaveLength(1);
  });

  it('設定が切なら何も起こさない', async () => {
    const { m, logFile } = make({}, { enabled: () => false });
    await expect(m.ensure('a')).rejects.toBeInstanceOf(OpencodeDisabledError);
    expect(readFakeOpencodeLog(logFile)).toEqual([]);
  });

  it('起動のたびに版を見て、範囲の外なら知らせの種を出す。起動は止めない', async () => {
    const seeds: OpencodeVersionNoticeSeed[] = [];
    const { m } = make({}, { version: async () => '2.2.0', onVersionNotice: (s) => seeds.push(s) });
    await m.ensure('a');
    await m.ensure('b');
    expect(seeds).toEqual([
      { kind: 'opencode-version', version: '2.2.0', verdict: 'unverified' },
      { kind: 'opencode-version', version: '2.2.0', verdict: 'unverified' },
    ]);
  });

  it('確かめた範囲の版なら知らせない', async () => {
    const seeds: OpencodeVersionNoticeSeed[] = [];
    const { m } = make({}, { onVersionNotice: (s) => seeds.push(s) });
    await m.ensure('a');
    expect(seeds).toEqual([]);
  });

  it('serve が自分で終わったら、次の ensure で起こし直す', async () => {
    const { m, logFile, registry } = make();
    const first = await m.ensure('a');
    killGroup(first.pid, 'SIGTERM');
    for (let i = 0; i < 50 && m.get('a'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(m.get('a')).toBeNull();
    expect(registry.list()).toEqual([]);
    const second = await m.ensure('a');
    expect(second.pid).not.toBe(first.pid);
    expect(starts(readFakeOpencodeLog(logFile))).toHaveLength(2);
  });

  it('stopAll は全部を止める', async () => {
    const { m, registry } = make();
    const infos = await Promise.all(['a', 'b'].map((id) => m.ensure(id)));
    await m.stopAll();
    for (const i of infos) expect(isAlive(i.pid)).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('起動の前の掃除が済むまで、起こさない', async () => {
    let release!: () => void;
    const swept = new Promise<void>((r) => { release = r; });
    const { m, logFile } = make({}, { ready: swept });
    const p = m.ensure('a');
    await new Promise((r) => setTimeout(r, 100));
    expect(readFakeOpencodeLog(logFile)).toEqual([]);
    release();
    await p;
    expect(starts(readFakeOpencodeLog(logFile))).toHaveLength(1);
  });
});
