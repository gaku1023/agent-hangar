import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../../../test/platform.ts';
import { openDb, type Db } from '../../../db/open.ts';
import { ApplyError } from '../apply.ts';
import { writeApplyOrder } from '../applyOrder.ts';
import { ConfigBase } from '../base.ts';
import type { LocalItem } from '../collect.ts';
import { listBackups } from '../backups.ts';
import { writeInbox } from '../inbox.ts';
import { parseItemId } from '../ids.ts';
import { judge, type RemoteSnapshot } from '../threeWay.ts';
import { claudeTarget } from './claude.ts';
import { claudeHooksTarget, createClaudeHooksTarget, HOOKS_ID, STATUSLINE_ID, holdOfHooks } from './claudeHooks.ts';
import { claudePluginsTarget, createClaudePluginsTarget, holdOfPlugins } from './claudePlugins.ts';
import { allTargets, collectAll, enabledTargetNames, targetNameOfId, type TargetContext } from './index.ts';
import type { HostOs } from './hookCommands.ts';
import { defaultTargetPaths } from './paths.ts';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

let tmp: string;
let db: Db;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-s8-')); db = openDb(':memory:'); });
afterEach(() => { try { db.close(); } catch { /* 閉じ済み */ } fs.rmSync(tmp, { recursive: true, force: true }); });

/** 1 台分の入れ物。home は利用者のホーム、claudeDir は home/.claude、hangar はその PC の hangar の置き場。 */
function pc(name: string) {
  const userHome = path.join(tmp, name, 'home');
  const claudeDir = path.join(userHome, '.claude');
  const hangar = path.join(tmp, name, 'hangar');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(hangar, { recursive: true });
  const abs = (rel: string): string => path.join(claudeDir, ...rel.split('/'));
  return {
    userHome, claudeDir, hangar,
    put: (rel: string, text: string, mode = 0o644): void => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, { mode }); },
    putSettings: (o: unknown): void => fs.writeFileSync(abs('settings.json'), JSON.stringify(o, null, 2) + '\n'),
    read: (rel: string): string | null => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } },
    settings: (): Record<string, unknown> => JSON.parse(fs.readFileSync(abs('settings.json'), 'utf8')) as Record<string, unknown>,
    abs,
  };
}
type Pc = ReturnType<typeof pc>;

const ctxOf = (p: Pc, switches: Record<string, boolean> = { 'claude-hooks': true, 'claude-plugins': true }): TargetContext => ({
  db, deviceId: 'd', home: p.hangar, claudeDir: p.claudeDir, allowedUnsent: new Map(), switches,
  ...defaultTargetPaths({}, p.userHome), codexEnabled: false, opencodeEnabled: false, hangarSettingsPath: path.join(p.hangar, 'settings.json'),
});
const collectHooks = (p: Pc, os: HostOs = 'darwin', sw?: Record<string, boolean>) => createClaudeHooksTarget({ userHome: () => p.userHome, os }).collect(ctxOf(p, sw));
const collectPlugins = (p: Pc) => createClaudePluginsTarget().collect(ctxOf(p));
const byId = (items: LocalItem[]): Record<string, LocalItem> => Object.fromEntries(items.map((i) => [i.id, i]));
const payloadOf = (i: LocalItem): { v: number; value: Record<string, unknown>; files: { rel: string; b64: string; x?: boolean }[] } => JSON.parse(i.content.toString('utf8'));

const HOOKS = { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '~/.claude/hooks/fmt.sh' }] }] };
const STATUS = { type: 'command', command: '~/.claude/statusline-command.sh' };

describe('対象の登録', () => {
  it('claude-hooks と claude-plugins は claude より前に登録され、枠ではない。claude は plugins の鍵を持たない', () => {
    const names = allTargets().map((t) => t.name);
    expect(names.indexOf('claude-hooks')).toBeLessThan(names.indexOf('claude'));
    expect(names.indexOf('claude-plugins')).toBeLessThan(names.indexOf('claude'));
    expect(claudeHooksTarget.placeholder).toBeUndefined();
    expect(claudePluginsTarget.placeholder).toBeUndefined();
    expect(targetNameOfId(HOOKS_ID)).toBe('claude-hooks');
    expect(targetNameOfId(STATUSLINE_ID)).toBe('claude-hooks');
    expect(targetNameOfId('settings:enabledPlugins')).toBe('claude-plugins');
    expect(targetNameOfId('settings:extraKnownMarketplaces')).toBe('claude-plugins');
    expect(claudeTarget.owns('settings:enabledPlugins')).toBe(false);
    expect(claudeTarget.owns('settings:model')).toBe(true);
    expect(parseItemId(HOOKS_ID)).toEqual({ kind: 'claude-hooks', ref: { type: 'settings', key: 'hooks' } });
    expect(parseItemId(STATUSLINE_ID)).toEqual({ kind: 'claude-statusline', ref: { type: 'settings', key: 'statusLine' } });
    expect(parseItemId('settings:enabledPlugins')).toEqual({ kind: 'plugins', ref: { type: 'settings', key: 'enabledPlugins' } });
    expect(parseItemId('claude-hooks:other')).toBeNull();
  });

  it('既定は切。入れると束の targets に載る', () => {
    const a = pc('a');
    expect(enabledTargetNames(ctxOf(a, {}))).toEqual(['claude']);
    expect(enabledTargetNames(ctxOf(a))).toEqual(['claude-hooks', 'claude-plugins', 'claude']);
  });
});

describe('claude-hooks：集める', () => {
  it('hooks と statusLine は 2 つの項目。台本と鍵が 1 項目で、台本を変えると指紋が変わる', () => {
    const a = pc('a');
    a.putSettings({ model: 'opus', hooks: HOOKS, statusLine: STATUS });
    a.put('hooks/fmt.sh', '#!/bin/sh\necho fmt\n', 0o755);
    a.put('statusline-command.sh', '#!/bin/sh\necho hi\n');
    const c1 = collectHooks(a);
    expect(c1.items.map((i) => [i.id, i.kind])).toEqual([[HOOKS_ID, 'claude-hooks'], [STATUSLINE_ID, 'claude-statusline']]);
    const h = payloadOf(byId(c1.items)[HOOKS_ID]!);
    expect(h.value).toEqual(HOOKS);
    expect(h.files).toEqual([{ rel: 'hooks/fmt.sh', b64: Buffer.from('#!/bin/sh\necho fmt\n').toString('base64'), ...(process.platform === 'win32' ? {} : { x: true }) }]);
    expect(payloadOf(byId(c1.items)[STATUSLINE_ID]!).files.map((f) => f.rel)).toEqual(['statusline-command.sh']);
    a.put('hooks/fmt.sh', '#!/bin/sh\necho changed\n', 0o755);
    const c2 = collectHooks(a);
    expect(byId(c2.items)[HOOKS_ID]!.sha256).not.toBe(byId(c1.items)[HOOKS_ID]!.sha256);
    expect(byId(c2.items)[STATUSLINE_ID]!.sha256).toBe(byId(c1.items)[STATUSLINE_ID]!.sha256);
    a.putSettings({ model: 'opus', hooks: { ...HOOKS, Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/fmt.sh' }] }] }, statusLine: STATUS });
    expect(byId(collectHooks(a).items)[HOOKS_ID]!.sha256).not.toBe(byId(c2.items)[HOOKS_ID]!.sha256);
  });

  it('settings.json が無い、hooks が無いなら項目は無い。読めない settings.json は塞ぐ', () => {
    const a = pc('a');
    expect(collectHooks(a).items).toEqual([]);
    a.putSettings({ model: 'x' });
    expect(collectHooks(a).items).toEqual([]);
    fs.writeFileSync(a.abs('settings.json'), '{こわれた');
    const c = collectHooks(a);
    expect(c.items).toEqual([]);
    expect([...c.blocked.ids].sort()).toEqual([HOOKS_ID, STATUSLINE_ID]);
  });

  it('ホームの絶対パスは目印で運ぶ。~、$HOME、%USERPROFILE% の形は触らない', () => {
    const a = pc('a');
    a.putSettings({ statusLine: { type: 'command', command: `bash ${a.userHome}/.claude/s.sh` }, hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/n.sh"' }] }] } });
    a.put('s.sh', 'x'); a.put('n.sh', 'y');
    const c = byId(collectHooks(a).items);
    expect(payloadOf(c[STATUSLINE_ID]!).value).toEqual({ type: 'command', command: 'bash __HANGAR_HOME__/.claude/s.sh' });
    expect(JSON.stringify(payloadOf(c[HOOKS_ID]!).value)).toContain('$HOME/.claude/n.sh');
  });

  it('Windows の実物の形（.ps1、.cmd の絶対パス）を Windows として集めると、目印に読み替わる', () => {
    const a = pc('a');
    const winHome = 'C:\\Users\\a';
    a.putSettings({
      statusLine: { type: 'command', command: 'powershell -NoProfile -File "C:\\Users\\a\\.claude\\statusline.ps1"' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'C:\\Users\\a\\.claude\\hooks\\notify.cmd' }] }] },
    });
    a.put('statusline.ps1', 'Write-Host hi'); a.put('hooks/notify.cmd', '@echo off');
    const t = createClaudeHooksTarget({ userHome: () => winHome, os: 'win32' });
    const c = byId(t.collect(ctxOf(a)).items);
    expect(payloadOf(c[STATUSLINE_ID]!).value).toEqual({ type: 'command', command: 'powershell -NoProfile -File "__HANGAR_HOME__\\.claude\\statusline.ps1"' });
    expect(payloadOf(c[HOOKS_ID]!).files.map((f) => f.rel)).toEqual(['hooks/notify.cmd']);
  });

  it('~/.claude の外を指す hook と、hangar の包みを指すものは運ばない', () => {
    const a = pc('a');
    a.putSettings({
      statusLine: { type: 'command', command: 'node ~/.agent-hangar/bin/hangar-run.mjs statusline -- ~/.claude/s.sh' },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify' }, { type: 'command', command: '~/.claude/ok.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/outside.sh' }, { type: 'command', command: 'bash ~/.agent-hangar/bin/hangar-run.sh x' }] }],
      },
    });
    a.put('ok.sh', 'ok'); a.put('s.sh', 's');
    const c = byId(collectHooks(a).items);
    expect(c[STATUSLINE_ID]).toBeUndefined();
    expect(payloadOf(c[HOOKS_ID]!).value).toEqual({ Stop: [{ hooks: [{ type: 'command', command: '~/.claude/ok.sh' }] }] });
    expect(payloadOf(c[HOOKS_ID]!).files.map((f) => f.rel)).toEqual(['ok.sh']);
    // 運べるものが何も無ければ項目ごと無い
    a.putSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify' }] }] } });
    expect(collectHooks(a).items).toEqual([]);
  });

  it('秘密らしい文字列が台本にあれば withheld にして、送らなかった項目に出す', () => {
    const a = pc('a');
    a.putSettings({ hooks: HOOKS });
    a.put('hooks/fmt.sh', 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"');
    const c = collectHooks(a);
    expect(byId(c.items)[HOOKS_ID]!.withheld).toBe('secret');
    expect(c.unsent.map((u) => [u.kind, u.itemId])).toEqual([['secret', HOOKS_ID]]);
  });
});

describe('claude-hooks：古い版の束', () => {
  it('古い版の束（targets 無し、または claude だけ）を受けても、hooks と plugins は消去に見えない', () => {
    const ids = [HOOKS_ID, STATUSLINE_ID, 'settings:enabledPlugins', 'settings:extraKnownMarketplaces'];
    const local = new Map([...ids.map((i): [string, string] => [i, 'x']), ['settings:model', 'm']]);
    const localTargets = new Set(['claude', 'claude-hooks', 'claude-plugins']);
    const old = (targets?: string[]): RemoteSnapshot => ({ deviceId: 'B', at: 10, items: new Map([['settings:model', { sha256: 'm' }]]), ...(targets ? { targets: new Set(targets) } : {}) });
    for (const b of [old(), old(['claude'])]) {
      const j = judge({ local, base: new Map(local), remotes: [b], localTargets });
      expect(j.actions).toEqual([]);
      expect(j.forget).toEqual([]);
    }
    // 新しい版が持っていないなら、これまでどおり消去
    const neu: RemoteSnapshot = { deviceId: 'C', at: 10, items: new Map([['settings:model', { sha256: 'm' }]]), targets: new Set(['claude', 'claude-hooks', 'claude-plugins']) };
    expect(judge({ local, base: new Map(local), remotes: [neu], localTargets }).actions.map((a) => `${a.op}:${a.id}`).sort()).toEqual(ids.map((i) => `delete:${i}`).sort());
  });
});

/** 送り手 a の項目を、受け手 b の inbox に置き、指示書を書く。 */
function deliver(to: Pc, items: LocalItem[], o: { senderOs?: HostOs; ops?: Record<string, ConfigApplyOrderItemDto['op']>; from?: string } = {}): void {
  const from = o.from ?? 'dev-a';
  const blobs = new Map<string, Buffer>();
  const manifestItems = items.map((i) => { blobs.set(i.sha256, i.content); return { id: i.id, kind: i.kind, sha256: i.sha256, size: i.size, marks: i.marks }; });
  writeInbox(to.hangar, from, { manifest: { version: 1, deviceId: from, createdAt: NOW, items: manifestItems }, blobs, skipped: 0 }, { bundleSha256: sha(from), forRowSha256: 'r', at: NOW, itemCount: items.length, skipped: 0, os: o.senderOs ?? 'darwin' });
  writeApplyOrder(to.hangar, 'dev-b', items.map((i) => ({ id: i.id, kind: i.kind, op: o.ops?.[i.id] ?? 'create', take: 'remote', fromDeviceId: from, sha256: i.sha256, target: i.target })), NOW);
}
const writeOpts = (p: Pc) => ({ home: p.hangar, claudeDir: p.claudeDir, db, now: () => NOW });
const tryErr = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };

describe('claude-hooks：書き戻し', () => {
  const sender = (): Pc => {
    const a = pc('a');
    a.putSettings({ model: 'opus', hooks: HOOKS, statusLine: STATUS });
    a.put('hooks/fmt.sh', '#!/bin/sh\necho fmt\n', 0o755);
    a.put('statusline-command.sh', '#!/bin/sh\necho hi\n');
    return a;
  };
  const targetFor = (p: Pc, os: HostOs = 'darwin') => createClaudeHooksTarget({ userHome: () => p.userHome, os });

  posixIt('台本と鍵を 1 項目で書き、書いた後の集め直しが送り手と同じ指紋になる。控えの世代を取る', () => {
    const a = sender();
    const b = pc('b');
    b.putSettings({ model: 'sonnet' });
    const sent = collectHooks(a).items;
    deliver(b, sent);
    const t = targetFor(b);
    const plan = t.planWrite({ home: b.hangar });
    expect(plan.counts.create).toBe(2);
    expect(plan.exec.map((e) => e.id).sort()).toEqual([HOOKS_ID, STATUSLINE_ID]);
    const r = t.write(writeOpts(b));
    expect(r.files.sort()).toEqual(['hooks/fmt.sh', 'settings.json', 'statusline-command.sh']);
    expect(b.settings()).toMatchObject({ model: 'sonnet', hooks: HOOKS, statusLine: STATUS });
    expect(b.read('hooks/fmt.sh')).toBe('#!/bin/sh\necho fmt\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(b.abs('hooks/fmt.sh')).mode & 0o111).not.toBe(0);
      expect(fs.statSync(b.abs('statusline-command.sh')).mode & 0o111).toBe(0);
    }
    expect(listBackups(b.hangar).length).toBe(1);
    expect(r.generation).not.toBeNull();
    expect(byId(collectHooks(b).items)[HOOKS_ID]!.sha256).toBe(byId(sent)[HOOKS_ID]!.sha256);
    expect(byId(collectHooks(b).items)[STATUSLINE_ID]!.sha256).toBe(byId(sent)[STATUSLINE_ID]!.sha256);
    expect(new ConfigBase(db).all().get(HOOKS_ID)).toBe(byId(sent)[HOOKS_ID]!.sha256);
  });

  posixIt('ホームの絶対パスの command は、受け手のホームで書く', () => {
    const a = pc('a');
    a.putSettings({ statusLine: { type: 'command', command: `bash ${a.userHome}/.claude/s.sh` } });
    a.put('s.sh', 'echo');
    const b = pc('b');
    deliver(b, collectHooks(a).items);
    targetFor(b).write(writeOpts(b));
    expect(b.settings().statusLine).toEqual({ type: 'command', command: `bash ${b.userHome}/.claude/s.sh` });
    expect(byId(collectHooks(b).items)[STATUSLINE_ID]!.sha256).toBe(byId(collectHooks(a).items)[STATUSLINE_ID]!.sha256);
  });

  posixIt('手元だけの hook（~/.claude の外を指すもの）は残す。届いた分は置き換わる', () => {
    const a = sender();
    const b = pc('b');
    b.putSettings({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '~/.claude/old.sh' }, { type: 'command', command: '/opt/local/audit' }] }],
        Notification: [{ hooks: [{ type: 'command', command: '/usr/local/bin/ping' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '~/.claude/gone.sh' }] }],
      },
      statusLine: { type: 'command', command: '/usr/local/bin/mystatus' },
    });
    deliver(b, collectHooks(a).items, { ops: {} });
    targetFor(b).write(writeOpts(b));
    const s = b.settings();
    expect(s.hooks).toEqual({
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '~/.claude/hooks/fmt.sh' }, { type: 'command', command: '/opt/local/audit' }] }],
      Notification: [{ hooks: [{ type: 'command', command: '/usr/local/bin/ping' }] }],
    });
    expect(s.statusLine).toEqual(STATUS);
  });

  posixIt('相手が消した（delete）ときも、手元だけの hook は残す', () => {
    const b = pc('b');
    b.putSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/.claude/gone.sh' }, { type: 'command', command: '/usr/local/bin/ping' }] }] }, statusLine: STATUS });
    writeApplyOrder(b.hangar, 'dev-b', [
      { id: HOOKS_ID, kind: 'claude-hooks', op: 'delete', take: 'remote', fromDeviceId: 'dev-a', sha256: '', target: 'settings.json#hooks' },
      { id: STATUSLINE_ID, kind: 'claude-statusline', op: 'delete', take: 'remote', fromDeviceId: 'dev-a', sha256: '', target: 'settings.json#statusLine' },
    ], NOW);
    targetFor(b).write(writeOpts(b));
    expect(b.settings()).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/ping' }] }] } });
  });

  it('送り手と OS が違うときは保留。Windows の形（.ps1、.cmd の絶対パス）を Mac が受けると書かない', () => {
    const a = pc('a');
    a.putSettings({
      statusLine: { type: 'command', command: 'powershell -NoProfile -File "C:\\Users\\a\\.claude\\statusline.ps1"' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'C:\\Users\\a\\.claude\\hooks\\notify.cmd' }] }] },
    });
    a.put('statusline.ps1', 'Write-Host hi'); a.put('hooks/notify.cmd', '@echo off');
    const sent = createClaudeHooksTarget({ userHome: () => 'C:\\Users\\a', os: 'win32' }).collect(ctxOf(a)).items;
    expect(sent.length).toBe(2);
    for (const i of sent) expect(holdOfHooks(i.content, { senderOs: 'win32', os: 'darwin', userHome: '/Users/b' })).toBe('other-os');
    // 同じ OS なら保留ではない
    for (const i of sent) expect(holdOfHooks(i.content, { senderOs: 'win32', os: 'win32', userHome: 'C:\\Users\\b' })).toBeNull();

    const b = pc('b');
    b.putSettings({ model: 'm' });
    const before = fs.readFileSync(b.abs('settings.json'), 'utf8');
    deliver(b, sent, { senderOs: 'win32' });
    const t = targetFor(b, 'darwin');
    expect(tryErr(() => t.planWrite({ home: b.hangar })).message).toMatch(/OS/);
    expect(tryErr(() => t.write(writeOpts(b))).code).toBe('unsafe');
    expect(fs.readFileSync(b.abs('settings.json'), 'utf8')).toBe(before);
    expect(b.read('statusline.ps1')).toBeNull();
    expect(listBackups(b.hangar)).toEqual([]);
  });

  it('送り手の OS が分からないものも保留', () => {
    const a = sender();
    const [h] = collectHooks(a).items;
    expect(holdOfHooks(h!.content, { senderOs: undefined, os: 'darwin', userHome: '/Users/b' })).toBe('other-os');
  });

  it('~/.claude の外を指すもの、hangar の包みを指すものが（別の版から）届いても書かない', () => {
    const b = pc('b');
    const fake = (value: unknown, id = HOOKS_ID): LocalItem => {
      const content = Buffer.from(JSON.stringify({ v: 1, value, files: [] }));
      return { id, kind: id === HOOKS_ID ? 'claude-hooks' : 'claude-statusline', label: 'x', sha256: sha(content), size: content.length, marks: [], content, mtime: null, target: id === HOOKS_ID ? 'settings.json#hooks' : 'settings.json#statusLine', withheld: null };
    };
    const outside = fake({ Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/x' }] }] });
    const wrapper = fake({ type: 'command', command: 'node ~/.agent-hangar/bin/hangar-run.mjs statusline -- ~/.claude/s.sh' }, STATUSLINE_ID);
    expect(holdOfHooks(outside.content, { senderOs: 'darwin', os: 'darwin', userHome: b.userHome })).toBe('outside-claude');
    expect(holdOfHooks(wrapper.content, { senderOs: 'darwin', os: 'darwin', userHome: b.userHome })).toBe('hangar-wrapper');
    for (const i of [outside, wrapper]) {
      deliver(b, [i]);
      expect(tryErr(() => targetFor(b).write(writeOpts(b))).code).toBe('unsafe');
    }
    expect(b.read('settings.json')).toBeNull();
  });

  it('悪意のある束（運ばない場所へのファイル、command が指さないファイル）は断る', () => {
    const b = pc('b');
    b.putSettings({ model: 'keep' });
    const bad = (files: { rel: string; b64: string }[], value: unknown = HOOKS): LocalItem => {
      const content = Buffer.from(JSON.stringify({ v: 1, value, files }));
      return { id: HOOKS_ID, kind: 'claude-hooks', label: 'hooks', sha256: sha(content), size: content.length, marks: [], content, mtime: null, target: 'settings.json#hooks', withheld: null };
    };
    const x = Buffer.from('evil').toString('base64');
    for (const files of [[{ rel: 'settings.json', b64: x }], [{ rel: '../escape.sh', b64: x }], [{ rel: 'skills/a/SKILL.md', b64: x }], [{ rel: 'hooks/other.sh', b64: x }]]) {
      deliver(b, [bad(files)]);
      expect(tryErr(() => targetFor(b).write(writeOpts(b))).code).toBe('bad-content');
    }
    deliver(b, [bad([], 'not an object')]);
    expect(tryErr(() => targetFor(b).write(writeOpts(b))).code).toBe('bad-content');
    expect(b.settings()).toEqual({ model: 'keep' });
    expect(listBackups(b.hangar)).toEqual([]);
  });

  posixIt('途中で書けなくなったら、元へ戻す', () => {
    const a = sender();
    const b = pc('b');
    b.putSettings({ model: 'sonnet' });
    deliver(b, collectHooks(a).items);
    let n = 0;
    const e = tryErr(() => targetFor(b).write({ ...writeOpts(b), onWrite: () => { if (++n === 2) throw new Error('boom'); } }));
    expect(e.code).toBe('write-failed');
    expect(b.settings()).toEqual({ model: 'sonnet' });
    expect(b.read('hooks/fmt.sh')).toBeNull();
    expect(new ConfigBase(db).all().size).toBe(0);
  });

  posixIt('控えの世代を作れなければ書かない', () => {
    const a = sender();
    const b = pc('b');
    b.putSettings({ model: 'sonnet' });
    deliver(b, collectHooks(a).items);
    fs.writeFileSync(path.join(b.hangar, 'backups'), 'ファイルがディレクトリの場所にある');
    expect(tryErr(() => targetFor(b).write(writeOpts(b))).code).toBe('write-failed');
    expect(b.settings()).toEqual({ model: 'sonnet' });
    expect(b.read('hooks/fmt.sh')).toBeNull();
  });

  it('承諾：設定が each のあいだは、消去も含めて全部。auto なら要らない', () => {
    for (const op of ['create', 'overwrite', 'delete'] as const) {
      expect(claudeHooksTarget.needsApproval({ id: HOOKS_ID, kind: 'claude-hooks', op }, 'each')).toBe(true);
      expect(claudeHooksTarget.needsApproval({ id: STATUSLINE_ID, kind: 'claude-statusline', op }, 'each')).toBe(true);
      expect(claudePluginsTarget.needsApproval({ id: 'settings:enabledPlugins', kind: 'plugins', op }, 'each')).toBe(true);
      expect(claudePluginsTarget.needsApproval({ id: 'settings:extraKnownMarketplaces', kind: 'plugins', op }, 'each')).toBe(true);
    }
    expect(claudeHooksTarget.needsApproval({ id: HOOKS_ID, kind: 'claude-hooks', op: 'create' }, 'auto')).toBe(false);
    expect(claudePluginsTarget.needsApproval({ id: 'settings:enabledPlugins', kind: 'plugins', op: 'create' }, 'auto')).toBe(false);
  });
});

describe('claude-plugins', () => {
  const MK = {
    shared: { source: { source: 'github', repo: 'o/shared' } },
    team: { source: { source: 'git', url: 'https://example.com/team.git' } },
    mine: { source: { source: 'directory', path: '/Users/a/dev/mk' } },
    mine2: { source: { source: 'file', path: '~/mk/marketplace.json' } },
  };
  const PLUGINS = { 'p1@shared': true, 'p2@team': false, 'p3@mine': true, 'p4@mine2': true, solo: true };

  it('承諾つきの 2 項目として集める。ローカルの marketplace と、それ由来の plugin は運ばない', () => {
    const a = pc('a');
    a.putSettings({ model: 'x', enabledPlugins: PLUGINS, extraKnownMarketplaces: MK });
    const c = byId(collectPlugins(a).items);
    expect(Object.keys(c).sort()).toEqual(['settings:enabledPlugins', 'settings:extraKnownMarketplaces']);
    expect(c['settings:enabledPlugins']!.kind).toBe('plugins');
    expect(JSON.parse(c['settings:enabledPlugins']!.content.toString())).toEqual({ 'p1@shared': true, 'p2@team': false, solo: true });
    expect(JSON.parse(c['settings:extraKnownMarketplaces']!.content.toString())).toEqual({ shared: MK.shared, team: MK.team });
  });

  it('全部ローカルなら、その鍵は運ばない。からの鍵や無い鍵も項目にしない', () => {
    const a = pc('a');
    a.putSettings({ extraKnownMarketplaces: { mine: MK.mine }, enabledPlugins: { 'p@mine': true } });
    expect(collectPlugins(a).items).toEqual([]);
    a.putSettings({ enabledPlugins: {} });
    expect(collectPlugins(a).items).toEqual([]);
  });

  it('届いたものを書く。手元だけの（ローカルの marketplace とその plugin）は残し、書いた後の指紋は送り手と同じ', () => {
    const a = pc('a');
    a.putSettings({ enabledPlugins: { 'p1@shared': true }, extraKnownMarketplaces: { shared: MK.shared } });
    const b = pc('b');
    b.putSettings({ model: 'm', enabledPlugins: { 'old@team': true, 'l@loc': true }, extraKnownMarketplaces: { loc: { source: { source: 'directory', path: '/x/y' } }, team: MK.team } });
    const sent = collectPlugins(a).items;
    deliver(b, sent, { ops: { 'settings:enabledPlugins': 'overwrite', 'settings:extraKnownMarketplaces': 'overwrite' } });
    createClaudePluginsTarget().write(writeOpts(b));
    const s = b.settings();
    expect(s.model).toBe('m');
    expect(s.enabledPlugins).toEqual({ 'p1@shared': true, 'l@loc': true });
    expect(s.extraKnownMarketplaces).toEqual({ shared: MK.shared, loc: { source: { source: 'directory', path: '/x/y' } } });
    expect(byId(collectPlugins(b).items)['settings:enabledPlugins']!.sha256).toBe(byId(sent)['settings:enabledPlugins']!.sha256);
  });

  it('ローカルの marketplace が届いたら保留（書かない）', () => {
    const b = pc('b');
    const content = Buffer.from(JSON.stringify(MK));
    expect(holdOfPlugins('settings:extraKnownMarketplaces', content)).toBe('local-marketplace');
    expect(holdOfPlugins('settings:extraKnownMarketplaces', Buffer.from(JSON.stringify({ shared: MK.shared })))).toBeNull();
    expect(holdOfPlugins('settings:enabledPlugins', Buffer.from(JSON.stringify(PLUGINS)))).toBeNull();
    const item: LocalItem = { id: 'settings:extraKnownMarketplaces', kind: 'plugins', label: 'x', sha256: sha(content), size: content.length, marks: [], content, mtime: null, target: 'settings.json#extraKnownMarketplaces', withheld: null };
    deliver(b, [item]);
    expect(tryErr(() => createClaudePluginsTarget().write(writeOpts(b))).code).toBe('unsafe');
    expect(b.read('settings.json')).toBeNull();
  });

  it('型の合わない値は書かない', () => {
    const b = pc('b');
    const content = Buffer.from('["a"]');
    const item: LocalItem = { id: 'settings:enabledPlugins', kind: 'plugins', label: 'x', sha256: sha(content), size: content.length, marks: [], content, mtime: null, target: 'settings.json#enabledPlugins', withheld: null };
    deliver(b, [item]);
    expect(tryErr(() => createClaudePluginsTarget().write(writeOpts(b))).code).toBe('bad-content');
  });
});

describe('collectAll に載る', () => {
  it('入にすると、hooks・statusline・plugins が claude の項目と重ならずに集まる', () => {
    const a = pc('a');
    a.putSettings({ model: 'x', hooks: HOOKS, statusLine: STATUS, enabledPlugins: { 'p@m': true }, extraKnownMarketplaces: { m: MK_GH } });
    a.put('hooks/fmt.sh', 'x'); a.put('statusline-command.sh', 'y');
    const off = collectAll(ctxOf(a, {})).items.map((i) => i.id);
    expect(off).toEqual(['settings:model']);
    const on = collectAll(ctxOf(a)).items.map((i) => i.id);
    expect(on.sort()).toEqual([HOOKS_ID, STATUSLINE_ID, 'settings:enabledPlugins', 'settings:extraKnownMarketplaces', 'settings:model'].sort());
  });
});
const MK_GH = { source: { source: 'github', repo: 'o/m' } };

describe('permissions.* の承諾（SPEC 4 章）', () => {
  const need = (id: string, op: 'create' | 'overwrite' | 'delete', a: 'each' | 'auto' = 'each') => claudeTarget.needsApproval({ id, kind: 'settings', op }, a);
  it('設定が each のあいだ、権限の鍵は消去も含めて承諾が要る。auto なら要らない', () => {
    for (const k of ['allow', 'ask', 'deny', 'defaultMode']) {
      for (const op of ['create', 'overwrite', 'delete'] as const) expect([k, op, need(`settings:permissions.${k}`, op)]).toEqual([k, op, true]);
      expect(need(`settings:permissions.${k}`, 'create', 'auto')).toBe(false);
    }
  });
  it('ほかの好みの鍵と、今までの承諾（skills など）は変わらない', () => {
    expect(need('settings:model', 'overwrite')).toBe(false);
    expect(need('file:CLAUDE.md', 'create')).toBe(false);
    expect(claudeTarget.needsApproval({ id: 'file:skills/a/SKILL.md', kind: 'skills', op: 'create' }, 'each')).toBe(true);
    expect(claudeTarget.needsApproval({ id: 'file:skills/a/SKILL.md', kind: 'skills', op: 'delete' }, 'each')).toBe(false);
  });
});
