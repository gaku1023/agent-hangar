import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/open.ts';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { ConfigSyncService } from './service.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-ph-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
function make(o: { codex: boolean; opencode: boolean; switches?: Record<string, boolean> }) {
  const root = path.join(tmp, `pc${n++}`);
  const claudeDir = path.join(root, 'claude'); const home = path.join(root, 'home');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const shared = new FakeCloudClient({ deviceId: 'shared', now: () => 1_000_000, minWorkerCompat: 1 });
  const cloud = shared.asDevice('d');
  void cloud.health();
  const targetPaths = { codexHome: path.join(root, 'codex'), opencodeDir: path.join(root, 'opencode'), agentsSkillsDir: path.join(root, 'agents-skills'), claudeJsonPath: path.join(root, 'claude.json') };
  const svc = new ConfigSyncService({
    db: openDb(':memory:'), deviceId: 'd', deviceName: 'n', claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, approval: () => 'each', now: () => 1_000_000,
    targetSwitches: () => o.switches ?? {}, agentsEnabled: () => ({ codex: o.codex, opencode: o.opencode }), targetPaths,
  });
  return { svc, claudeDir, targetPaths };
}

describe('空の対象の配線', () => {
  it('有効な Codex・opencode の入れ物に .git があれば vcs に載り、無効なら載らない', () => {
    const on = make({ codex: true, opencode: true });
    for (const d of [on.targetPaths.codexHome, on.targetPaths.opencodeDir, on.targetPaths.agentsSkillsDir]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    expect(on.svc.dto().vcs).toEqual([
      { target: 'codex', tools: ['git'] }, { target: 'opencode', tools: ['git'] }, { target: 'agents-skills', tools: ['git'] },
    ]);
    const off = make({ codex: false, opencode: false });
    for (const d of [off.targetPaths.codexHome, off.targetPaths.opencodeDir, off.targetPaths.agentsSkillsDir]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    expect(off.svc.dto().vcs).toBeUndefined();
  });

  it('空の対象を全部入にしても、送る項目も束の targets も変わらない', async () => {
    const all = { codex: true, opencode: true, 'agents-skills': true, 'claude-hooks': true, 'claude-plugins': true, hangar: true };
    const a = make({ codex: true, opencode: true });
    fs.writeFileSync(path.join(a.claudeDir, 'CLAUDE.md'), '# r');
    const before = a.svc.outgoing().items.map((i) => i.id);
    const b = make({ codex: true, opencode: true, switches: all });
    fs.writeFileSync(path.join(b.claudeDir, 'CLAUDE.md'), '# r');
    expect(b.svc.outgoing().items.map((i) => i.id)).toEqual(before);
    expect(await b.svc.send()).toEqual({ sent: true, items: before.length });
  });
});
