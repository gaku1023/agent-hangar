import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../../db/open.ts';
import { loadSettings } from '../../../config/paths.ts';
import { expectMode } from '../../../../test/platform.ts';
import { ConfigBase } from '../base.ts';
import { writeApplyOrder } from '../applyOrder.ts';
import { writeInbox } from '../inbox.ts';
import { judge, type RemoteSnapshot } from '../threeWay.ts';
import { allTargets, collectAll, enabledTargetNames, targetNameOfId, type TargetContext } from './index.ts';
import { HANGAR_PREF_KEYS, hangarTarget, setHangarPrefsApplier } from './hangar.ts';

let tmp: string;
let db: Db;
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const settingsFile = (): string => path.join(tmp, 'settings.json');
const ctx = (o: Partial<TargetContext> = {}): TargetContext => ({
  db, deviceId: 'd', home: tmp, claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
  codexHome: path.join(tmp, 'codex'), codexEnabled: true, opencodeDir: path.join(tmp, 'opencode'), opencodeEnabled: true,
  agentsSkillsDir: path.join(tmp, 'agents'), claudeJsonPath: path.join(tmp, 'claude.json'), hangarSettingsPath: settingsFile(), switches: { hangar: true }, ...o,
});
const put = (o: Record<string, unknown>): void => { fs.writeFileSync(settingsFile(), JSON.stringify(o)); };

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')); db = openDb(':memory:'); });
afterEach(() => { setHangarPrefsApplier(null); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('hangar の好み：集める', () => {
  it('運ぶ鍵だけを hangar:<鍵> で集める。PC ごとの鍵は集めない', () => {
    put({
      language: 'en', askStatusAtEnd: false, liveHints: false, notifyUser: false, unreadBadge: false, unreadOs: false, unreadPhone: false, defaultModel: 'opus', autoDone: false, autoDoneIdleDays: 14, autoPark: false, remoteControl: false,
      summaryEngine: 'claude', summaryClaudeModel: 'sonnet', configApproval: 'auto', opencodeInjection: 'none', opencodePermissionPreset: false, opencodeLocalContext: 65536, codexInjection: 'none',
      // PC ごと
      codexEnabled: true, codexIntercept: true, opencodeEnabled: true, opencodeIntercept: true, claudeDir: '/x', tmuxPath: '/t', nodePath: '/n', claudePath: '/c', workspaceRoot: '/w',
      editor: { id: 'vscode', path: null }, terminalApp: 'terminal', summaryApiKey: 'sk-secret', lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'm',
      opencodeProviderPrep: { a: { command: 'x' } }, opencodeIdleUnload: 5, configTargets: { hangar: true }, configBundleSync: true, toolsResolved: true,
    });
    const ids = collectAll(ctx()).items.map((i) => i.id).sort();
    expect(ids).toEqual([...HANGAR_PREF_KEYS].map((k) => `hangar:${k}`).sort());
    expect(HANGAR_PREF_KEYS).toHaveLength(19);
    for (const i of collectAll(ctx()).items) expect(i.kind).toBe('hangar-pref');
    const body = collectAll(ctx()).items.map((i) => i.content.toString()).join('\n');
    expect(body).not.toContain('sk-secret');
  });

  it('値は JSON で運ぶ。設定にある鍵だけで、無い鍵は項目にしない。形の合わない値は塞ぐ', () => {
    put({ language: 'ja', autoDoneIdleDays: 5, liveHints: 'yes' });
    const c = collectAll(ctx());
    const by = Object.fromEntries(c.items.map((i) => [i.id, i.content.toString()]));
    expect(by['hangar:language']).toBe('"ja"');
    expect(c.items.map((i) => i.id)).toEqual(['hangar:language']);
    expect(c.blocked.ids.has('hangar:liveHints')).toBe(true);
    expect(c.blocked.ids.has('hangar:autoDoneIdleDays')).toBe(true);
  });

  it('settings.json が無ければ空。読めなければ hangar: を全部塞ぐ。対象の入が無ければ集めない', () => {
    expect(collectAll(ctx()).items).toEqual([]);
    fs.writeFileSync(settingsFile(), '{ broken');
    expect(collectAll(ctx()).blocked.prefixes).toContain('hangar:');
    put({ language: 'en' });
    expect(collectAll(ctx({ switches: {} })).items).toEqual([]);
  });

  it('本物の対象になり、束の targets に載る。項目の持ち主は hangar', () => {
    expect(hangarTarget.placeholder).toBeUndefined();
    expect(allTargets().map((t) => t.name)).toContain('hangar');
    expect(enabledTargetNames(ctx())).toContain('hangar');
    expect(enabledTargetNames(ctx({ switches: {} }))).not.toContain('hangar');
    expect(targetNameOfId('hangar:language')).toBe('hangar');
  });

  it('id を解く。運ばない鍵と形の悪い id は null', () => {
    expect(hangarTarget.parseId('hangar:language')).toEqual({ kind: 'hangar-pref', ref: { type: 'hangar', key: 'language' } });
    for (const bad of ['hangar:codexEnabled', 'hangar:opencodeEnabled', 'hangar:codexIntercept', 'hangar:editor', 'hangar:configTargets', 'hangar:summaryApiKey', 'hangar:', 'hangar:../x', 'settings:language']) expect(hangarTarget.parseId(bad)).toBeNull();
  });
});

describe('hangar の好み：承認', () => {
  it('configApproval の変更だけ承認になる。ほかの鍵は設定が each でも要らない', () => {
    const n = (id: string, approval: 'each' | 'auto', op: 'create' | 'overwrite' | 'delete' | 'conflict' = 'overwrite') => hangarTarget.needsApproval({ id, kind: 'hangar-pref', op }, approval);
    expect(n('hangar:configApproval', 'each')).toBe(true);
    // 今の設定が auto でも、承認の仕方そのものを変える項目は黙って通さない。
    expect(n('hangar:configApproval', 'auto')).toBe(true);
    expect(n('hangar:configApproval', 'each', 'delete')).toBe(false);
    for (const k of HANGAR_PREF_KEYS.filter((x) => x !== 'configApproval')) {
      expect(n(`hangar:${k}`, 'each')).toBe(false);
      expect(n(`hangar:${k}`, 'auto')).toBe(false);
    }
  });
  it('PC に依る項目は無い', () => {
    expect(hangarTarget.isMachineBound({ id: 'hangar:language', kind: 'hangar-pref', content: Buffer.from('"ja"') })).toBe(false);
  });
});

describe('hangar の好み：古い版の束', () => {
  const snap = (targets?: string[]): RemoteSnapshot => ({ deviceId: 'B', at: 10, items: new Map(), ...(targets ? { targets: new Set(targets) } : {}) });
  it('古い版の束（targets 無し、claude だけ）では、hangar の項目は消去にも forget にもならない', () => {
    const local = new Map([['hangar:language', 'x']]);
    for (const s of [snap(), snap(['claude'])]) {
      const j = judge({ local, base: new Map(local), remotes: [s] });
      expect(j.actions).toEqual([]);
      expect(j.forget).toEqual([]);
    }
    const j = judge({ local, base: new Map(local), remotes: [snap(['claude', 'hangar'])] });
    expect(j.actions.map((a) => [a.id, a.op])).toEqual([['hangar:language', 'delete']]);
  });
});

describe('hangar の好み：書く', () => {
  const NOW = 1_700_000_000_000;
  function receive(items: { id: string; content: string }[], target = (id: string) => `hangar-settings.json#${id.slice(7)}`) {
    const blobs = new Map<string, Buffer>();
    const mi = items.map((i) => { const b = Buffer.from(i.content); blobs.set(sha(i.content), b); return { id: i.id, kind: 'hangar-pref' as const, sha256: sha(i.content), size: b.length, marks: [] }; });
    writeInbox(tmp, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: mi }, blobs, skipped: 0 }, { bundleSha256: sha('b'), forRowSha256: 'r', at: NOW, itemCount: items.length, skipped: 0 });
    writeApplyOrder(tmp, 'dev-a', items.map((i) => ({ id: i.id, kind: 'hangar-pref' as const, op: 'overwrite' as const, take: 'remote' as const, fromDeviceId: 'dev-b', sha256: sha(i.content), target: target(i.id) })), NOW);
  }
  const opts = () => ({ home: tmp, claudeDir: path.join(tmp, 'claude'), db, now: () => NOW });

  it('settings を書く関数で書き、読み込みが新しい値を見る。ほかの鍵と PC ごとの鍵は変えない', () => {
    put({ language: 'ja', codexEnabled: true, summaryApiKey: 'keep-me' });
    receive([{ id: 'hangar:language', content: '"en"' }, { id: 'hangar:autoDoneIdleDays', content: '14' }]);
    const r = hangarTarget.write(opts());
    expect(r.written).toBe(2);
    const s = loadSettings(tmp);
    expect(s.language).toBe('en');
    expect(s.autoDoneIdleDays).toBe(14);
    expect(s.codexEnabled).toBe(true);
    expect(s.summaryApiKey).toBe('keep-me');
    expect(new ConfigBase(db).all().get('hangar:language')).toBe(sha('"en"'));
    expectMode(settingsFile(), 0o600);
  });

  it('走っているサーバの設定の入れ物を通す口があれば、そちらへ渡す', () => {
    put({ language: 'ja' });
    const seen: Record<string, unknown>[] = [];
    setHangarPrefsApplier((_home, patch) => { seen.push(patch); });
    receive([{ id: 'hangar:autoPark', content: 'false' }]);
    hangarTarget.write(opts());
    expect(seen).toEqual([{ autoPark: false }]);
  });

  it('形の合わない値と、運ばない鍵と、書き込み先の食い違いは、何も書かずに断る', () => {
    put({ language: 'ja' });
    receive([{ id: 'hangar:language', content: '"xx"' }]);
    expect(() => hangarTarget.write(opts())).toThrow();
    receive([{ id: 'hangar:language', content: '"en"' }], () => 'hangar-settings.json#other');
    expect(() => hangarTarget.write(opts())).toThrow();
    expect(loadSettings(tmp).language).toBe('ja');
  });

  it('相手が消した鍵は、手元を消さず基準だけ外す', () => {
    put({ language: 'en' });
    new ConfigBase(db).set('hangar:language', 'old', NOW);
    writeApplyOrder(tmp, 'dev-a', [{ id: 'hangar:language', kind: 'hangar-pref', op: 'delete', take: 'remote', fromDeviceId: 'dev-b', sha256: '', target: 'hangar-settings.json#language' }], NOW);
    hangarTarget.write(opts());
    expect(loadSettings(tmp).language).toBe('en');
    expect(new ConfigBase(db).all().has('hangar:language')).toBe(false);
  });

  it('planWrite は何も書かずに見立てを返す', () => {
    put({ language: 'ja' });
    receive([{ id: 'hangar:language', content: '"en"' }]);
    const p = hangarTarget.planWrite({ home: tmp });
    expect(p.items.map((i) => [i.id, i.act])).toEqual([['hangar:language', 'write']]);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).language).toBe('ja');
  });
});
