import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { openDb, type Db } from '../../db/open.ts';
import { collectLocal } from './collect.ts';
import { parseItemId } from './ids.ts';
import { CLAUDE_KEYS2_NAME, CLAUDE_KEYS2_KEYS, claudeKeys2Target } from './targets/claudeKeys2.ts';
import { allTargets, collectAll, enabledTargetNames, targetNameOfId, targetOfId, type TargetContext } from './targets/index.ts';
import { sortSettings } from './settingsSort.ts';
import { judge, type RemoteSnapshot } from './threeWay.ts';
import { ConfigSyncService } from './service.ts';

/**
 * SPEC 5 章の鍵（S3）。見本は実物の settings.json の鍵の名前だけを写した形で、値は型に合う作り物にしてある。
 * Mac の実物の並びを写した。Windows の実物は手元に無いので、同じ鍵の部分集合で足りることだけを確かめる。
 */
const MAC_SHAPE: Record<string, unknown> = {
  cleanupPeriodDays: 30, permissions: { ask: ['Bash(x)'], defaultMode: 'default' }, model: 'm', deniedMcpServers: [{ serverName: 's' }],
  hooks: {}, statusLine: {}, enabledPlugins: {}, language: 'ja', effortLevel: 'high', modelSettings: { m: { effortLevel: 'high' } },
  promptSuggestionEnabled: false, tui: 'fullscreen', voice: { enabled: true, mode: 'tap' }, skipWorkflowUsageWarning: true, theme: 'dark',
  inputNeededNotifEnabled: true, agentPushNotifEnabled: true, skipAutoPermissionPrompt: true, autoMode: { allow: ['x'] }, voiceEnabled: true,
};
const KEYS2 = ['autoMode', 'modelSettings', 'promptSuggestionEnabled', 'tui', 'voice', 'voiceEnabled', 'agentPushNotifEnabled', 'inputNeededNotifEnabled', 'skipAutoPermissionPrompt', 'skipWorkflowUsageWarning', 'autoUpdatesChannel', 'deniedMcpServers'];

describe('settingsSort の範囲', () => {
  it('claude の範囲では、新しい鍵を黙って外し（運ぶ鍵にも落とした鍵にも出さず）、他は今までどおり', () => {
    const s = sortSettings(MAC_SHAPE);
    expect(s.items.map((i) => i.key).sort()).toEqual(['cleanupPeriodDays', 'effortLevel', 'language', 'model', 'permissions.ask', 'permissions.defaultMode', 'theme']);
    expect(s.dropped.map((d) => d.key).sort()).toEqual(['enabledPlugins', 'hooks', 'statusLine']);
  });

  it('keys2 の範囲では、新しい鍵だけを運ぶ', () => {
    const s = sortSettings({ ...MAC_SHAPE, autoUpdatesChannel: 'stable' }, { scope: 'keys2' });
    expect(s.items.map((i) => i.key).sort()).toEqual([...KEYS2].sort());
    expect(s.dropped).toEqual([]);
  });

  it('型が合わない値は運ばず、知らない鍵として扱う', () => {
    const s = sortSettings({ tui: 3, voice: 'x', deniedMcpServers: ['a'], autoUpdatesChannel: 1, promptSuggestionEnabled: 'no' }, { scope: 'keys2' });
    expect(s.items).toEqual([]);
    expect(s.dropped.map((d) => d.reason)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  });
});

describe('対象 claude-keys2', () => {
  it('登録は claude より前で、新しい鍵の id はこの対象のもの。claude のものではない', () => {
    const names = allTargets().map((t) => t.name);
    expect(names.indexOf(CLAUDE_KEYS2_NAME)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(CLAUDE_KEYS2_NAME)).toBeLessThan(names.indexOf('claude'));
    for (const k of KEYS2) expect(targetNameOfId(`settings:${k}`)).toBe(CLAUDE_KEYS2_NAME);
    expect([...CLAUDE_KEYS2_KEYS].sort()).toEqual([...KEYS2].sort());
    expect(targetNameOfId('settings:model')).toBe('claude');
    expect(targetNameOfId('file:CLAUDE.md')).toBe('claude');
    expect(targetOfId('settings:tui')!.parseId('settings:tui')).toMatchObject({ kind: 'settings' });
    expect(parseItemId('settings:tui')).toMatchObject({ kind: 'settings' });
    expect(parseItemId('settings:notAKey')).toBeNull();
  });

  it('古い版の束（targets 無し、または claude だけ）を受けても、新しい鍵は消去に見えない', () => {
    const local = new Map([['settings:tui', 'x'], ['settings:model', 'm']]);
    const base = new Map(local);
    const localTargets = new Set(['claude', CLAUDE_KEYS2_NAME]);
    const oldBundle = (targets?: string[]): RemoteSnapshot => ({ deviceId: 'B', at: 10, items: new Map([['settings:model', { sha256: 'm' }]]), ...(targets ? { targets: new Set(targets) } : {}) });
    for (const b of [oldBundle(), oldBundle(['claude'])]) {
      const j = judge({ local, base, remotes: [b], localTargets });
      expect(j.actions).toEqual([]);
      expect(j.forget).toEqual([]);
    }
    // 新しい版が持っていないなら、これまでどおり消去
    const neu: RemoteSnapshot = { deviceId: 'C', at: 10, items: new Map([['settings:model', { sha256: 'm' }]]), targets: new Set(['claude', CLAUDE_KEYS2_NAME]) };
    expect(judge({ local, base, remotes: [neu], localTargets }).actions.map((a) => `${a.op}:${a.id}`)).toEqual(['delete:settings:tui']);
    // 手元で切なら、相手が持っていても create しない
    const has: RemoteSnapshot = { deviceId: 'C', at: 10, items: new Map([['settings:tui', { sha256: 'y' }]]), targets: new Set(['claude', CLAUDE_KEYS2_NAME]) };
    expect(judge({ local: new Map(), base: new Map(), remotes: [has], localTargets: new Set(['claude']) }).actions).toEqual([]);
  });

  it('承諾が要るのは skipAutoPermissionPrompt・deniedMcpServers・autoMode だけ（設定が each のとき）', () => {
    const need = (id: string, op: 'create' | 'overwrite' | 'delete', a: 'each' | 'auto' = 'each') => claudeKeys2Target.needsApproval({ id, kind: 'settings', op }, a);
    expect(need('settings:deniedMcpServers', 'create')).toBe(true);
    expect(need('settings:skipAutoPermissionPrompt', 'overwrite')).toBe(true);
    expect(need('settings:autoMode', 'create')).toBe(true);
    expect(need('settings:deniedMcpServers', 'create', 'auto')).toBe(false);
    expect(need('settings:tui', 'create')).toBe(false);
    expect(need('settings:voice', 'overwrite')).toBe(false);
  });
});

describe('集める', () => {
  let tmp: string; let claudeDir: string; let db: Db;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-keys2-')); claudeDir = path.join(tmp, 'c'); fs.mkdirSync(claudeDir); db = openDb(':memory:'); });
  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const ctx = (switches: Record<string, boolean>): TargetContext => ({ db, deviceId: 'd', home: tmp, claudeDir, allowedUnsent: new Map(), switches });
  const put = (o: unknown) => fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(o));

  it('既定は切。切のあいだ、新しい鍵は項目にも知らない鍵にも出ない', () => {
    put(MAC_SHAPE);
    expect(enabledTargetNames(ctx({}))).toEqual(['claude']);
    const c = collectAll(ctx({}));
    expect(c.items.map((i) => i.id).filter((id) => id.slice(9) in { tui: 1, voice: 1, autoMode: 1 })).toEqual([]);
    expect(c.unsent).toEqual([]);
  });

  it('入にすると新しい鍵が settings:<鍵> の項目で集まり、claude の項目と重ならない', () => {
    put(MAC_SHAPE);
    const on = collectAll(ctx({ [CLAUDE_KEYS2_NAME]: true }));
    expect(enabledTargetNames(ctx({ [CLAUDE_KEYS2_NAME]: true }))).toEqual([CLAUDE_KEYS2_NAME, 'claude']);
    const got = on.items.map((i) => i.id);
    for (const k of KEYS2.filter((k) => k in MAC_SHAPE)) expect(got).toContain(`settings:${k}`);
    expect(new Set(got).size).toBe(got.length);
    expect(got).toContain('settings:model');
    expect(on.unsent).toEqual([]);
  });

  it('知らない鍵は config_unsent の候補（知らない鍵）として出る。値は載せない', () => {
    put({ model: 'm', futureKey: { secret: 'v' }, permissions: { allow: ['Bash(x)'], newThing: 1 } });
    const c = collectLocal({ db, deviceId: 'd', claudeDir, allowedUnsent: new Map() });
    expect(c.unsent.map((u) => ({ kind: u.kind, label: u.label, reason: u.reason, allowed: u.allowed }))).toEqual([
      { kind: 'unknown-key', label: 'futureKey', reason: 'unknown-key', allowed: false },
      { kind: 'unknown-key', label: 'permissions.newThing', reason: 'unknown-key', allowed: false },
    ]);
    expect(JSON.stringify(c.unsent)).not.toContain('"v"');
  });
});

describe('画面の DTO に知らない鍵が出る', () => {
  it('unsent() に kind=unknown-key で出て、「それでも送る」は断る', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-keys2-svc-'));
    const claudeDir = path.join(tmp, 'c'); const home = path.join(tmp, 'h');
    fs.mkdirSync(claudeDir); fs.mkdirSync(home);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'm', futureKey: 1 }));
    const db = openDb(':memory:');
    const cloud = new FakeCloudClient().asDevice('a');
    const svc = new ConfigSyncService({ db, deviceId: 'a', deviceName: 'A', claudeDir, home, cloud, keyring: cloud.keyring, enabled: () => true, switchedOn: () => true, approval: () => 'each' });
    svc.outgoing();
    const u = svc.unsent();
    expect(u.items).toEqual([{ id: 'unknown-key:futureKey', kind: 'unknown-key', itemId: 'settings:futureKey', label: 'futureKey', reason: 'unknown-key', allowed: false }]);
    expect(svc.dto().unsent).toBe(1);
    await expect(svc.sendUnsent('unknown-key:futureKey')).rejects.toThrow();
    db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  });
});
