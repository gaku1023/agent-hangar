import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/open.ts';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { readApplyOrder } from './applyOrder.ts';
import { writeInbox } from './inbox.ts';
import { ConfigSyncError, ConfigSyncService } from './service.ts';
import { setHangarPrefsApplier } from './targets/hangar.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const NOW = 1_000_000;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-apply-')); });
afterEach(() => { setHangarPrefsApplier(null); fs.rmSync(tmp, { recursive: true, force: true }); });

function make(o: { switches?: Record<string, boolean>; opencode?: boolean } = {}) {
  const claudeDir = path.join(tmp, 'claude'); const home = path.join(tmp, 'home');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const shared = new FakeCloudClient({ deviceId: 'shared', now: () => NOW, minWorkerCompat: 1 });
  const cloud = shared.asDevice('d');
  const targetPaths = { codexHome: path.join(tmp, 'codex'), opencodeDir: path.join(tmp, 'opencode'), agentsSkillsDir: path.join(tmp, 'agents-skills'), claudeJsonPath: path.join(tmp, 'claude.json') };
  const svc = new ConfigSyncService({
    db: openDb(':memory:'), deviceId: 'd', deviceName: 'n', claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, approval: () => 'each', now: () => NOW,
    targetSwitches: () => o.switches ?? {}, agentsEnabled: () => ({ codex: false, opencode: o.opencode ?? false }), targetPaths,
    userHome: tmp, hostOs: 'darwin',
  });
  return { svc, home, targetPaths };
}

type In = { id: string; kind: ConfigItemKind; content: string };
function arrive(home: string, items: In[], meta: { os?: 'darwin' | 'win32' | 'linux'; targets: string[] }): void {
  const blobs = new Map(items.map((i) => [sha(i.content), Buffer.from(i.content)]));
  writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: items.map((i) => ({ id: i.id, kind: i.kind, sha256: sha(i.content), size: Buffer.byteLength(i.content), marks: [] })), targets: meta.targets, ...(meta.os ? { os: meta.os } : {}) }, blobs, skipped: 0 }, { bundleSha256: 'b', forRowSha256: 'r', at: NOW, itemCount: items.length, skipped: 0, targets: meta.targets, ...(meta.os ? { os: meta.os } : {}) });
}

describe('保留の理由（フックとプラグイン）', () => {
  it('送り手と OS が違うフック、ローカルの配布元を持つプラグインは held に出て、指示書に入れられない', () => {
    const { svc, home } = make({ switches: { 'claude-hooks': true, 'claude-plugins': true } });
    arrive(home, [
      { id: 'claude-hooks:statusline', kind: 'claude-statusline', content: JSON.stringify({ v: 1, value: { type: 'command', command: 'echo hi' }, files: [] }) },
      { id: 'settings:extraKnownMarketplaces', kind: 'plugins', content: JSON.stringify({ mine: { source: { source: 'directory', path: '/x' } } }) },
    ], { os: 'win32', targets: ['claude', 'claude-hooks', 'claude-plugins'] });
    const held = Object.fromEntries(svc.inbox().items.map((i) => [i.id, i.held]));
    expect(held).toEqual({ 'claude-hooks:statusline': 'other-os', 'settings:extraKnownMarketplaces': 'local-marketplace' });
    expect(svc.dto().held).toBe(2);
    expect(() => svc.putApplyOrder([{ id: 'claude-hooks:statusline' }])).toThrow(ConfigSyncError);
  });

  it('同じ OS で ~/.claude の中を指すフックは保留しない', () => {
    const { svc, home } = make({ switches: { 'claude-hooks': true } });
    arrive(home, [{ id: 'claude-hooks:statusline', kind: 'claude-statusline', content: JSON.stringify({ v: 1, value: { type: 'command', command: 'echo hi' }, files: [] }) }], { os: 'darwin', targets: ['claude', 'claude-hooks'] });
    expect(svc.inbox().items.map((i) => i.held)).toEqual([null]);
  });
});

describe('hangar の好みはサーバの中で書く', () => {
  it('指示書に入れると、登録した口（applySettingsPatch）でその場で反映し、指示書から外す', () => {
    const { svc, home } = make({ switches: { hangar: true } });
    const patches: Record<string, unknown>[] = [];
    setHangarPrefsApplier((_h, patch) => { patches.push(patch); });
    fs.mkdirSync(path.join(tmp, 'claude', 'commands'), { recursive: true });
    arrive(home, [
      { id: 'hangar:liveHints', kind: 'hangar-pref', content: 'false' },
      { id: 'file:commands/c.md', kind: 'commands', content: 'C' },
    ], { os: 'darwin', targets: ['claude', 'hangar'] });
    const order = svc.putApplyOrder([{ id: 'hangar:liveHints' }, { id: 'file:commands/c.md' }]);
    expect(patches).toEqual([{ liveHints: false }]);
    expect(order.items.map((i) => i.id)).toEqual(['file:commands/c.md']);
    expect(readApplyOrder(home)!.items.map((i) => i.id)).toEqual(['file:commands/c.md']);
  });

  it('好みだけなら、指示書は残さない。書けなければ指示書ごと消して断る', () => {
    const { svc, home } = make({ switches: { hangar: true } });
    arrive(home, [{ id: 'hangar:liveHints', kind: 'hangar-pref', content: 'false' }], { os: 'darwin', targets: ['claude', 'hangar'] });
    setHangarPrefsApplier(() => {});
    expect(svc.putApplyOrder([{ id: 'hangar:liveHints' }]).items).toEqual([]);
    expect(readApplyOrder(home)).toBeNull();
    setHangarPrefsApplier(() => { throw new Error('disk full'); });
    expect(() => svc.putApplyOrder([{ id: 'hangar:liveHints' }])).toThrow(ConfigSyncError);
    expect(readApplyOrder(home)).toBeNull();
  });
});

describe('知らせと控え', () => {
  it('opencode の json と jsonc が両方あれば notices に出す。無ければ欄ごと省く', () => {
    const { svc, targetPaths } = make({ opencode: true });
    expect(svc.dto().notices).toBeUndefined();
    fs.mkdirSync(targetPaths.opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(targetPaths.opencodeDir, 'opencode.json'), '{}');
    fs.writeFileSync(path.join(targetPaths.opencodeDir, 'opencode.jsonc'), '{}');
    expect(svc.dto().notices).toEqual([{ target: 'opencode', code: 'both-json-jsonc' }]);
  });

  it('控えの一覧は、全部の対象の世代を数え、Claude 以外には target を添える', () => {
    const { svc, home } = make();
    for (const b of ['claude-config', 'codex-config']) fs.mkdirSync(path.join(home, 'backups', b, '20261027-120000'), { recursive: true });
    expect(svc.backups().generations.map((g) => g.target ?? 'claude').sort()).toEqual(['claude', 'codex']);
    expect(svc.dto().backups).toBe(2);
  });
});
