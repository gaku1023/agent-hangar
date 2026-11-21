import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareTags, latestTagFrom, runUpdate, stableServicePaths, tarLayout, type UpdateOptions } from './update.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-update-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** tar で入れたときの形（prefix/versions/<版>/app/cli.mjs）を作り、cli.mjs の置き場（app）を返す。 */
function installed(version: string): { prefix: string; here: string } {
  const prefix = path.join(tmp, 'prefix');
  const root = path.join(prefix, 'versions', version);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  fs.symlinkSync(`versions/${version}`, path.join(prefix, 'current'));
  return { prefix, here: path.join(root, 'app') };
}

describe('tarLayout', () => {
  it('tar で入れた形なら、prefix と今の版と current を返す', () => {
    const { prefix, here } = installed('v1.0.0');
    expect(tarLayout(here)).toEqual({ prefix, version: 'v1.0.0', current: path.join(prefix, 'current') });
  });

  it('リポジトリや .app の束（VERSION が無い）は null', () => {
    const dir = path.join(tmp, 'repo/packages/cli/src');
    fs.mkdirSync(dir, { recursive: true });
    expect(tarLayout(dir)).toBeNull();
  });

  it('versions/ の下でなければ null（VERSION だけあっても、更新の置き場と見なさない）', () => {
    const root = path.join(tmp, 'odd/hangar');
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'VERSION'), 'v1.0.0\n');
    expect(tarLayout(path.join(root, 'app'))).toBeNull();
  });
});

describe('stableServicePaths', () => {
  it('ユニットには、版ごとの実体ではなく current の下の node と server.mjs を書く（更新で書き換えずに済む）', () => {
    const { prefix, here } = installed('v1.0.0');
    const layout = tarLayout(here)!;
    expect(stableServicePaths(layout)).toEqual({
      nodePath: path.join(prefix, 'current/node/bin/node'),
      serverArgs: [path.join(prefix, 'current/app/server.mjs')],
      workingDir: path.join(prefix, 'current/app'),
    });
  });
});

describe('compareTags', () => {
  it('数の順に並べる（v1.10.0 は v1.9.0 より新しい）', () => {
    expect(compareTags('v1.10.0', 'v1.9.0')).toBeGreaterThan(0);
    expect(compareTags('v1.0.0', 'v1.0.0')).toBe(0);
    expect(compareTags('v0.9.9', 'v1.0.0')).toBeLessThan(0);
  });
  it('rc は同じ版の正式より前で、rc どうしは番号の順', () => {
    expect(compareTags('v1.0.0-rc.2', 'v1.0.0')).toBeLessThan(0);
    expect(compareTags('v1.0.0-rc.10', 'v1.0.0-rc.9')).toBeGreaterThan(0);
  });
  it('読めない形は投げる', () => {
    expect(() => compareTags('latest', 'v1.0.0')).toThrow();
  });
});

describe('latestTagFrom', () => {
  it('GitHub の最新の Release の JSON から tag_name を取る', () => {
    expect(latestTagFrom({ tag_name: 'v2.0.0' })).toBe('v2.0.0');
  });
  it('形が違えば投げる', () => {
    expect(() => latestTagFrom({})).toThrow();
    expect(() => latestTagFrom({ tag_name: 'nightly' })).toThrow();
  });
});

describe('runUpdate', () => {
  function opts(over: Partial<UpdateOptions> & { here: string }): { o: UpdateOptions; calls: string[]; msgs: string[] } {
    const calls: string[] = [];
    const msgs: string[] = [];
    const o: UpdateOptions = {
      platform: 'linux',
      fetchLatest: async () => { calls.push('fetchLatest'); return 'v1.1.0'; },
      install: async (tag) => { calls.push(`install ${tag}`); return true; },
      restart: async () => { calls.push('restart'); return 'restarted'; },
      log: (s) => msgs.push(s),
      ...over,
    };
    return { o, calls, msgs };
  }

  it('tar で入れたものでなければ断る', async () => {
    const dir = path.join(tmp, 'repo');
    fs.mkdirSync(dir);
    const { o, calls } = opts({ here: dir });
    const r = await runUpdate(o);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('Linux 以外では断る', async () => {
    const { here } = installed('v1.0.0');
    const { o, calls } = opts({ here, platform: 'darwin' });
    expect((await runUpdate(o)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('新しい版があれば入れ、常駐を再起動する', async () => {
    const { here } = installed('v1.0.0');
    const { o, calls, msgs } = opts({ here });
    const r = await runUpdate(o);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['fetchLatest', 'install v1.1.0', 'restart']);
    expect(msgs.join('\n')).toContain('v1.0.0');
    expect(msgs.join('\n')).toContain('v1.1.0');
  });

  it('最新と同じなら、何も入れず再起動もしない', async () => {
    const { here } = installed('v1.1.0');
    const { o, calls, msgs } = opts({ here });
    expect((await runUpdate(o)).ok).toBe(true);
    expect(calls).toEqual(['fetchLatest']);
    expect(msgs.join('\n')).toContain('最新');
  });

  it('--check は、新しい版を告げるだけで入れない', async () => {
    const { here } = installed('v1.0.0');
    const { o, calls, msgs } = opts({ here, check: true });
    expect((await runUpdate(o)).ok).toBe(true);
    expect(calls).toEqual(['fetchLatest']);
    expect(msgs.join('\n')).toContain('v1.1.0');
  });

  it('--version で版を決めたら、最新を引かずにその版を入れる（古い版にも戻せる）', async () => {
    const { here } = installed('v1.1.0');
    const { o, calls } = opts({ here, version: 'v1.0.0' });
    expect((await runUpdate(o)).ok).toBe(true);
    expect(calls).toEqual(['install v1.0.0', 'restart']);
  });

  it('最新が今より古いときは、黙って戻さない', async () => {
    const { here } = installed('v2.0.0');
    const { o, calls } = opts({ here });
    expect((await runUpdate(o)).ok).toBe(true);
    expect(calls).toEqual(['fetchLatest']);
  });

  it('入れるのに失敗したら、再起動せずに ok:false', async () => {
    const { here } = installed('v1.0.0');
    const { o, calls } = opts({ here, install: async () => false });
    expect((await runUpdate(o)).ok).toBe(false);
    expect(calls).toEqual(['fetchLatest']);
  });

  it('常駐が入っていなければ、再起動の代わりにそう告げる', async () => {
    const { here } = installed('v1.0.0');
    const { o, msgs } = opts({ here, restart: async () => 'none' });
    expect((await runUpdate(o)).ok).toBe(true);
    expect(msgs.join('\n')).toContain('service install');
  });

  it('再起動に失敗したら、入った版は残したまま手で再起動するよう案内する', async () => {
    const { here } = installed('v1.0.0');
    const { o, msgs } = opts({ here, restart: async () => 'failed' });
    const r = await runUpdate(o);
    expect(r.ok).toBe(false);
    expect(msgs.join('\n')).toContain('systemctl');
  });
});
