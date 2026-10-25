import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode } from '../../test/fake-opencode.ts';
import { serveEnv } from '../provider/opencode/serve/env.ts';
import { OpencodeDisabledError } from '../provider/opencode/serve/manager.ts';
import { isAlive, ServeRegistry, serveRegistryPath } from '../provider/opencode/serve/registry.ts';
import { killGroup, startServe } from '../provider/opencode/serve/spawn.ts';
import { bootOpencode } from './opencode.ts';

// 偽の opencode を本当に起こして止める。
describe('bootOpencode', () => {
  let home: string;
  const pids: number[] = [];
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-boot-oc-')); });
  afterEach(() => {
    for (const pid of pids.splice(0)) killGroup(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('設定が切でも、前の hangar が残した serve は起動のときに掃除する。ほかは何も起こさない', async () => {
    const { bin, logFile } = writeFakeOpencode(path.join(home, 'oc'));
    const left = await startServe({ bin, env: serveEnv(bin) });
    pids.push(left.pid);
    new ServeRegistry(serveRegistryPath(home)).add({ sessionId: 'old', pid: left.pid, port: left.port, startedAt: left.startedAt });
    const oc = bootOpencode({ home, settings: { current: { opencodeEnabled: false } } }, { bin: () => bin });
    await oc.swept;
    await left.exited;
    expect(isAlive(left.pid)).toBe(false);
    await expect(oc.serves.ensure('s1')).rejects.toBeInstanceOf(OpencodeDisabledError);
    expect(readFakeOpencodeLog(logFile).filter((e) => e.ev === 'start')).toHaveLength(1);
    await oc.stop(1000);
  });

  it('有効なら起こせて、終わりの後片付けで止める。範囲の外の版は種として持つ', async () => {
    const { bin } = writeFakeOpencode(path.join(home, 'oc'));
    const settings = { current: { opencodeEnabled: true } };
    const oc = bootOpencode({ home, settings }, { bin: () => bin, version: async () => '2.3.0' });
    const info = await oc.serves.ensure('s1');
    expect(oc.versionNotice()).toEqual({ kind: 'opencode-version', version: '2.3.0', verdict: 'unverified' });
    await oc.stop(3000);
    expect(isAlive(info.pid)).toBe(false);
    expect(new ServeRegistry(serveRegistryPath(home)).list()).toEqual([]);
  });
});
