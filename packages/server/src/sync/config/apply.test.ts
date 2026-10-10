import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigExecMark, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../../test/platform.ts';
import { openDb, type Db } from '../../db/open.ts';
import { ApplyError, planApply, planRestore, runApply, runRestore } from './apply.ts';
import { applyOrderPath } from './paths.ts';
import { deleteApplyOrder, readApplyOrder, writeApplyOrder } from './applyOrder.ts';
import { listBackups } from './backups.ts';
import { ConfigBase } from './base.ts';
import { writeInbox } from './inbox.ts';
import { slugOfPath } from './ids.ts';
import { configBackupsDir } from './paths.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();

let tmp: string;
let home: string;
let claudeDir: string;
let db: Db;
let clock: number;

const abs = (rel: string): string => path.join(claudeDir, ...rel.split('/'));
const write = (rel: string, text: string | Buffer, mode?: number): void => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, mode === undefined ? undefined : { mode });
};
const read = (rel: string): string | null => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } };
const exists = (rel: string): boolean => fs.existsSync(abs(rel));

type InboxItem = { id: string; kind: ConfigItemKind; content: string; marks?: ConfigExecMark[] };
/** 他の PC の束を開いた写しを置く。 */
function inbox(deviceId: string, items: InboxItem[], at = NOW): void {
  const blobs = new Map<string, Buffer>();
  const manifestItems = items.map((i) => {
    const b = Buffer.from(i.content);
    blobs.set(sha(b), b);
    return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: i.marks ?? [] };
  });
  writeInbox(home, deviceId, { manifest: { version: 1, deviceId, createdAt: at, items: manifestItems }, blobs, skipped: 0 }, { bundleSha256: sha(deviceId + at), forRowSha256: 'row', at, itemCount: items.length, skipped: 0 });
}

type OrderIn = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; content?: string | null; target: string; take?: 'remote' | 'mine'; from?: string };
const orderItem = (o: OrderIn): ConfigApplyOrderItemDto => ({ id: o.id, kind: o.kind, op: o.op, take: o.take ?? 'remote', fromDeviceId: o.from ?? 'dev-b', sha256: o.content == null ? '' : sha(o.content), target: o.target });
const order = (...items: OrderIn[]): void => { writeApplyOrder(home, 'dev-a', items.map(orderItem), NOW); };
const ctx = () => ({ home, claudeDir, db, now: () => clock });
const base = () => new ConfigBase(db).all();
const gens = () => listBackups(home);
const fileOrder = (rel: string, op: ConfigInboxOp, content: string | null, kind: ConfigItemKind = 'commands', take: 'remote' | 'mine' = 'remote'): OrderIn => ({ id: `file:${rel}`, kind, op, content, target: rel, take });
const fail = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-apply-'));
  home = path.join(tmp, 'home');
  claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(home);
  fs.mkdirSync(claudeDir);
  db = openDb(':memory:');
  clock = NOW;
});
afterEach(() => { try { db.close(); } catch { /* 試験が閉じた */ } fs.rmSync(tmp, { recursive: true, force: true }); });

describe('適用の指示書を読む', () => {
  it('指示書が無いとき', () => {
    expect(fail(() => planApply({ home })).code).toBe('no-order');
    expect(fail(() => runApply(ctx())).code).toBe('no-order');
  });

  it('壊れた指示書は読まず、消さずに残す', () => {
    fs.mkdirSync(path.dirname(applyOrderPath(home)), { recursive: true });
    fs.writeFileSync(applyOrderPath(home), '{"version":1,"items":');
    expect(fail(() => planApply({ home })).code).toBe('broken-order');
    expect(fail(() => runApply(ctx())).code).toBe('broken-order');
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
  });

  it('形の合わない指示書（id と種類の食い違い）は壊れたものとして扱う', () => {
    writeApplyOrder(home, 'dev-a', [{ ...orderItem(fileOrder('commands/x.md', 'create', 'x')), kind: 'skills' }], NOW);
    expect(fail(() => planApply({ home })).code).toBe('broken-order');
  });

  it('指示書の項目が、中身の置き場とずれていたら断る（書き込み先が id と合わない）', () => {
    inbox('dev-b', [{ id: 'file:commands/x.md', kind: 'commands', content: 'x' }]);
    order({ ...fileOrder('commands/x.md', 'create', 'x'), target: '../outside.md' });
    expect(fail(() => planApply({ home })).code).toBe('unsafe');
    order({ ...fileOrder('commands/x.md', 'create', 'x'), target: 'commands/y.md' });
    expect(fail(() => planApply({ home })).code).toBe('unsafe');
  });

  it('inbox の指紋と合わない（束が更新された）指示書は、古いものとして断る', () => {
    inbox('dev-b', [{ id: 'file:commands/x.md', kind: 'commands', content: 'new' }]);
    order(fileOrder('commands/x.md', 'create', 'old'));
    expect(fail(() => planApply({ home })).code).toBe('stale');
    expect(fail(() => runApply(ctx())).code).toBe('stale');
    expect(exists('commands/x.md')).toBe(false);
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
    expect(gens()).toEqual([]);
  });

  it('削除の指示で、相手がまだその項目を持っているときは古いものとして断る', () => {
    write('commands/x.md', 'mine');
    inbox('dev-b', [{ id: 'file:commands/x.md', kind: 'commands', content: 'mine' }]);
    order(fileOrder('commands/x.md', 'delete', null));
    expect(fail(() => runApply(ctx())).code).toBe('stale');
    expect(read('commands/x.md')).toBe('mine');
  });
});

describe('適用の見立て（殻の確認に出す件数と種類）', () => {
  it('操作と種類ごとの件数、実行される指示、フックとコマンド実行の印を数える', () => {
    inbox('dev-b', [
      { id: 'file:skills/a/SKILL.md', kind: 'skills', content: 'a', marks: ['hooks'] },
      { id: 'file:skills/b/SKILL.md', kind: 'skills', content: 'b' },
      { id: 'file:commands/c.md', kind: 'commands', content: 'c', marks: ['shell'] },
      { id: 'file:CLAUDE.md', kind: 'claude-md', content: 'rules' },
      { id: 'settings:model', kind: 'settings', content: '"opus"' },
    ]);
    write('commands/c.md', 'old c');
    write('commands/gone.md', 'gone');
    write('keybindings.json', '{}');
    order(
      fileOrder('skills/a/SKILL.md', 'create', 'a', 'skills'),
      fileOrder('skills/b/SKILL.md', 'create', 'b', 'skills'),
      fileOrder('commands/c.md', 'overwrite', 'c'),
      fileOrder('commands/gone.md', 'delete', null),
      fileOrder('CLAUDE.md', 'conflict', 'rules', 'claude-md', 'remote'),
      { id: 'settings:model', kind: 'settings', op: 'conflict', content: '"opus"', target: 'settings.json#model', take: 'mine' },
    );
    const plan = planApply({ home });
    expect(plan.counts).toEqual({ create: 2, overwrite: 1, delete: 1, conflictRemote: 1, conflictMine: 1 });
    expect(plan.byKind).toEqual({ skills: 2, commands: 2, 'claude-md': 1, settings: 1 });
    // 書き込む skills と commands は、Claude が実行する指示である。削除と手元を残すものは数えない。
    expect(plan.instructions).toBe(3);
    expect(plan.exec.map((i) => [i.id, i.marks])).toEqual([['file:skills/a/SKILL.md', ['hooks']], ['file:commands/c.md', ['shell']]]);
    expect(plan.items).toHaveLength(6);
    expect(plan.createdAt).toBe(NOW);
  });
});

describe('適用する', () => {
  it('新規と上書きと削除を書き、書く前の控えを世代に置き、基準を更新し、指示書を消す', () => {
    write('commands/over.md', 'old');
    write('commands/del.md', 'bye');
    write('CLAUDE.md', 'untouched');
    inbox('dev-b', [
      { id: 'file:commands/new.md', kind: 'commands', content: 'N' },
      { id: 'file:commands/over.md', kind: 'commands', content: 'O' },
    ]);
    new ConfigBase(db).set('file:commands/del.md', sha('bye'), NOW);
    order(fileOrder('commands/new.md', 'create', 'N'), fileOrder('commands/over.md', 'overwrite', 'O'), fileOrder('commands/del.md', 'delete', null));
    const r = runApply(ctx());
    expect(read('commands/new.md')).toBe('N');
    expect(read('commands/over.md')).toBe('O');
    expect(exists('commands/del.md')).toBe(false);
    expect(read('CLAUDE.md')).toBe('untouched');
    // 控え。元の中身が世代に残る。新規は控えるものが無い。
    expect(r.generation).toBe('20261010-120000');
    const gen = path.join(configBackupsDir(home), r.generation!);
    expect(fs.readFileSync(path.join(gen, 'commands/over.md'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(gen, 'commands/del.md'), 'utf8')).toBe('bye');
    expect(fs.existsSync(path.join(gen, 'commands/new.md'))).toBe(false);
    // 世代の一覧に出る。数えるのは控えたファイルだけで、世代の記録（戻し方の情報）は数えない。
    expect(gens()).toEqual([{ name: '20261010-120000', at: NOW, files: 2 }]);
    expect(r).toMatchObject({ written: 2, removed: 1, keptMine: 0 });
    // 基準
    expect(base().get('file:commands/new.md')).toBe(sha('N'));
    expect(base().get('file:commands/over.md')).toBe(sha('O'));
    expect(base().has('file:commands/del.md')).toBe(false);
    // 指示書は消える。
    expect(fs.existsSync(applyOrderPath(home))).toBe(false);
    expect(readApplyOrder(home)).toBeNull();
  });

  it('中のディレクトリが無くても作り、実行の許可は付けない', () => {
    inbox('dev-b', [{ id: 'file:skills/run/tool.sh', kind: 'skills', content: '#!/bin/sh\necho hi\n', marks: ['script'] }]);
    order(fileOrder('skills/run/tool.sh', 'create', '#!/bin/sh\necho hi\n', 'skills'));
    runApply(ctx());
    expect(read('skills/run/tool.sh')).toBe('#!/bin/sh\necho hi\n');
    if (process.platform !== 'win32') expect(fs.statSync(abs('skills/run/tool.sh')).mode & 0o111).toBe(0);
  });

  posixIt('上書きでは、手元のファイルの権限を保つ（Unix だけ）', () => {
    write('commands/x.md', 'old', 0o600);
    inbox('dev-b', [{ id: 'file:commands/x.md', kind: 'commands', content: 'new' }]);
    order(fileOrder('commands/x.md', 'overwrite', 'new'));
    runApply(ctx());
    expect(fs.statSync(abs('commands/x.md')).mode & 0o777).toBe(0o600);
  });

  it('競合で手元を採る項目は書かず、基準を相手の指紋に合わせる（次の同期で手元が送られる）', () => {
    write('CLAUDE.md', 'local');
    inbox('dev-b', [{ id: 'file:CLAUDE.md', kind: 'claude-md', content: 'remote' }]);
    order(fileOrder('CLAUDE.md', 'conflict', 'remote', 'claude-md', 'mine'));
    const r = runApply(ctx());
    expect(read('CLAUDE.md')).toBe('local');
    expect(base().get('file:CLAUDE.md')).toBe(sha('remote'));
    // 書くものが無いので世代は作らない。
    expect(r.generation).toBeNull();
    expect(r).toMatchObject({ written: 0, removed: 0, keptMine: 1 });
    expect(fs.existsSync(applyOrderPath(home))).toBe(false);
  });

  it('相手が消した項目の競合で手元を採るときは、基準の行を消す（手元だけの項目になる）', () => {
    write('commands/x.md', 'local edit');
    new ConfigBase(db).set('file:commands/x.md', sha('before'), NOW);
    inbox('dev-b', []);
    order(fileOrder('commands/x.md', 'conflict', null, 'commands', 'mine'));
    runApply(ctx());
    expect(read('commands/x.md')).toBe('local edit');
    expect(base().has('file:commands/x.md')).toBe(false);
  });

  it('競合で相手を採る項目は、手元の中身を控えてから上書きする', () => {
    write('CLAUDE.md', 'local');
    inbox('dev-b', [{ id: 'file:CLAUDE.md', kind: 'claude-md', content: 'remote' }]);
    order(fileOrder('CLAUDE.md', 'conflict', 'remote', 'claude-md', 'remote'));
    const r = runApply(ctx());
    expect(read('CLAUDE.md')).toBe('remote');
    expect(fs.readFileSync(path.join(configBackupsDir(home), r.generation!, 'CLAUDE.md'), 'utf8')).toBe('local');
  });

  it('プロジェクトのメモリは、指示書の書き込み先（この PC の slug）へ書く', () => {
    const slug = slugOfPath('/work/proj');
    inbox('dev-b', [{ id: 'memory:proj-1/notes/a.md', kind: 'memory', content: 'mem' }]);
    order({ id: 'memory:proj-1/notes/a.md', kind: 'memory', op: 'create', content: 'mem', target: `projects/${slug}/memory/notes/a.md` });
    runApply(ctx());
    expect(read(`projects/${slug}/memory/notes/a.md`)).toBe('mem');
    expect(base().get('memory:proj-1/notes/a.md')).toBe(sha('mem'));
  });

  it('同じ秒にもう一度適用しても、前の世代を潰さず次の秒の名前にする', () => {
    inbox('dev-b', [{ id: 'file:commands/a.md', kind: 'commands', content: 'A' }]);
    write('commands/a.md', 'a0');
    order(fileOrder('commands/a.md', 'overwrite', 'A'));
    const first = runApply(ctx());
    inbox('dev-b', [{ id: 'file:commands/a.md', kind: 'commands', content: 'A2' }]);
    order(fileOrder('commands/a.md', 'overwrite', 'A2'));
    const second = runApply(ctx());
    expect(first.generation).toBe('20261010-120000');
    expect(second.generation).toBe('20261010-120001');
    expect(gens().map((g) => g.name)).toEqual(['20261010-120001', '20261010-120000']);
  });

  it('世代は新しい 20 個までに保つ。時刻の名前でないもの（removed など）は触らない', () => {
    fs.mkdirSync(path.join(configBackupsDir(home), 'removed'), { recursive: true });
    for (let i = 1; i <= 22; i++) fs.mkdirSync(path.join(configBackupsDir(home), `202601${String(i).padStart(2, '0')}-000000`), { recursive: true });
    inbox('dev-b', [{ id: 'file:commands/a.md', kind: 'commands', content: 'A' }]);
    write('commands/a.md', 'a0');
    order(fileOrder('commands/a.md', 'overwrite', 'A'));
    runApply(ctx());
    expect(gens()).toHaveLength(20);
    expect(gens()[0]!.name).toBe('20261010-120000');
    expect(fs.existsSync(path.join(configBackupsDir(home), 'removed'))).toBe(true);
  });
});

describe('settings.json の鍵', () => {
  const settingsOrder = (key: string, op: ConfigInboxOp, value: unknown | null, take: 'remote' | 'mine' = 'remote'): OrderIn => ({ id: `settings:${key}`, kind: 'settings', op, content: value === null ? null : JSON.stringify(value), target: `settings.json#${key}`, take });
  const inboxSettings = (entries: [string, unknown][]): void => inbox('dev-b', entries.map(([k, v]) => ({ id: `settings:${k}`, kind: 'settings' as const, content: JSON.stringify(v) })));

  it('届いた鍵だけを書き、ほかの鍵と並びと字下げは保つ', () => {
    write('settings.json', '{\n    "env": {"A":"1"},\n    "model": "sonnet",\n    "hooks": {"x": 1}\n}\n');
    inboxSettings([['model', 'opus'], ['theme', 'dark']]);
    order(settingsOrder('model', 'overwrite', 'opus'), settingsOrder('theme', 'create', 'dark'));
    const r = runApply(ctx());
    expect(read('settings.json')).toBe('{\n    "env": {\n        "A": "1"\n    },\n    "model": "opus",\n    "hooks": {\n        "x": 1\n    },\n    "theme": "dark"\n}\n');
    expect(fs.readFileSync(path.join(configBackupsDir(home), r.generation!, 'settings.json'), 'utf8')).toContain('"sonnet"');
    expect(base().get('settings:model')).toBe(sha(JSON.stringify('opus')));
  });

  it('settings.json が無ければ作る', () => {
    inboxSettings([['model', 'opus']]);
    order(settingsOrder('model', 'create', 'opus'));
    runApply(ctx());
    expect(JSON.parse(read('settings.json')!)).toEqual({ model: 'opus' });
  });

  it('権限の規則は、届いた規則を入れ、手元の絶対パスの規則は残す', () => {
    write('settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Read(//Users/me/data/**)', 'Read(//C:/data/**)'], deny: ['Bash(rm *)'] } }, null, 2));
    inboxSettings([['permissions.allow', ['Bash(git status)', 'Read(/src/**)']]]);
    order(settingsOrder('permissions.allow', 'overwrite', ['Bash(git status)', 'Read(/src/**)']));
    runApply(ctx());
    expect(JSON.parse(read('settings.json')!).permissions).toEqual({
      allow: ['Bash(git status)', 'Read(/src/**)', 'Read(//Users/me/data/**)', 'Read(//C:/data/**)'],
      deny: ['Bash(rm *)'],
    });
  });

  it('相手が権限の鍵を消したとき、手元の絶対パスの規則だけを残す（無ければ鍵ごと消す）', () => {
    write('settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Read(//Users/me/data/**)'], ask: ['Bash(curl *)'] } }));
    inboxSettings([]);
    order(settingsOrder('permissions.allow', 'delete', null), settingsOrder('permissions.ask', 'delete', null));
    runApply(ctx());
    expect(JSON.parse(read('settings.json')!).permissions).toEqual({ allow: ['Read(//Users/me/data/**)'] });
  });

  it('権限の規則の重複は足さない', () => {
    write('settings.json', JSON.stringify({ permissions: { allow: ['Read(//a/b)'] } }));
    inboxSettings([['permissions.allow', ['Read(//a/b)', 'Bash(ls)']]]);
    order(settingsOrder('permissions.allow', 'overwrite', ['Read(//a/b)', 'Bash(ls)']));
    runApply(ctx());
    expect(JSON.parse(read('settings.json')!).permissions.allow).toEqual(['Read(//a/b)', 'Bash(ls)']);
  });

  it('鍵を消す指示で、トップの鍵を消す', () => {
    write('settings.json', JSON.stringify({ model: 'x', theme: 'dark' }));
    inboxSettings([['theme', 'dark']]);
    order(settingsOrder('model', 'delete', null));
    runApply(ctx());
    expect(JSON.parse(read('settings.json')!)).toEqual({ theme: 'dark' });
  });

  it('settings.json が JSON でない、オブジェクトでないときは何も書かず、指示書も残す', () => {
    write('settings.json', '{ broken');
    order(settingsOrder('model', 'create', 'opus'), fileOrder('commands/a.md', 'create', 'A'));
    inbox('dev-b', [{ id: 'settings:model', kind: 'settings', content: '"opus"' }, { id: 'file:commands/a.md', kind: 'commands', content: 'A' }]);
    const e = fail(() => runApply(ctx()));
    expect(e.code).toBe('settings-unreadable');
    expect(read('settings.json')).toBe('{ broken');
    expect(exists('commands/a.md')).toBe(false);
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
    write('settings.json', '[1]');
    expect(fail(() => runApply(ctx())).code).toBe('settings-unreadable');
  });

  it('値の型が鍵に合わないものは書かない（権限の規則が文字列の配列でない）', () => {
    inbox('dev-b', [{ id: 'settings:permissions.allow', kind: 'settings', content: '{"a":1}' }]);
    order({ id: 'settings:permissions.allow', kind: 'settings', op: 'create', content: '{"a":1}', target: 'settings.json#permissions.allow' });
    expect(fail(() => runApply(ctx())).code).toBe('bad-content');
  });
});

describe('途中で失敗したら、書きかけを残さない', () => {
  it('2 つ目の書き込みで失敗すると、1 つ目と作ったディレクトリも元に戻り、世代は消え、指示書は残る', () => {
    write('commands/a.md', 'a0');
    inbox('dev-b', [
      { id: 'file:commands/a.md', kind: 'commands', content: 'A' },
      { id: 'file:skills/new/SKILL.md', kind: 'skills', content: 'S' },
    ]);
    order(fileOrder('commands/a.md', 'overwrite', 'A'), fileOrder('skills/new/SKILL.md', 'create', 'S', 'skills'));
    new ConfigBase(db).set('file:commands/a.md', sha('a0'), NOW);
    const e = fail(() => runApply({ ...ctx(), onWrite: (_rel, i) => { if (i === 1) throw new Error('ディスクが一杯'); } }));
    expect(e.code).toBe('write-failed');
    expect(e.message).toContain('ディスクが一杯');
    expect(read('commands/a.md')).toBe('a0');
    expect(exists('skills/new/SKILL.md')).toBe(false);
    expect(exists('skills')).toBe(false);
    expect(base().get('file:commands/a.md')).toBe(sha('a0'));
    expect(gens()).toEqual([]);
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
    // 一時ファイルも残さない。
    expect(fs.readdirSync(abs('commands'))).toEqual(['a.md']);
  });

  it('基準の更新で失敗しても、書いたファイルを戻す', () => {
    write('commands/a.md', 'a0');
    inbox('dev-b', [{ id: 'file:commands/a.md', kind: 'commands', content: 'A' }]);
    order(fileOrder('commands/a.md', 'overwrite', 'A'));
    db.exec("create trigger refuse before insert on config_base begin select raise(abort, '基準の表に書けない'); end");
    const e = fail(() => runApply(ctx()));
    expect(e.code).toBe('write-failed');
    expect(e.message).toContain('基準の表に書けない');
    expect(read('commands/a.md')).toBe('a0');
    expect(gens()).toEqual([]);
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
  });

  it('データベースを開けないときは、何も書かない', () => {
    write('commands/a.md', 'a0');
    inbox('dev-b', [{ id: 'file:commands/a.md', kind: 'commands', content: 'A' }]);
    order(fileOrder('commands/a.md', 'overwrite', 'A'));
    db.close();
    expect(fail(() => runApply(ctx())).code).toBe('write-failed');
    expect(read('commands/a.md')).toBe('a0');
    expect(gens()).toEqual([]);
  });

  posixIt('途中が通常のファイルやシンボリックリンクのときは、何も書かずに断る（Unix だけ）', () => {
    inbox('dev-b', [{ id: 'file:commands/a.md', kind: 'commands', content: 'A' }, { id: 'file:skills/s/SKILL.md', kind: 'skills', content: 'S' }]);
    order(fileOrder('commands/a.md', 'create', 'A'), fileOrder('skills/s/SKILL.md', 'create', 'S', 'skills'));
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, abs('skills'));
    const e = fail(() => runApply(ctx()));
    expect(e.code).toBe('unsafe');
    expect(exists('commands/a.md')).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    // ファイル自体がリンクのとき
    fs.rmSync(abs('skills'));
    fs.mkdirSync(abs('commands'));
    fs.symlinkSync(path.join(tmp, 'elsewhere.md'), abs('commands/a.md'), 'file');
    fs.writeFileSync(path.join(tmp, 'elsewhere.md'), 'target');
    expect(fail(() => runApply(ctx())).code).toBe('unsafe');
    expect(fs.readFileSync(path.join(tmp, 'elsewhere.md'), 'utf8')).toBe('target');
    // ディレクトリの場所にファイルを書く指示
    fs.rmSync(abs('commands/a.md'));
    fs.mkdirSync(abs('commands/a.md'));
    expect(fail(() => runApply(ctx())).code).toBe('unsafe');
  });
});

describe('世代へ戻す', () => {
  function applied(): { generation: string } {
    write('commands/over.md', 'old');
    write('commands/del.md', 'bye');
    write('settings.json', '{"model":"sonnet"}\n');
    const b = new ConfigBase(db);
    b.set('file:commands/del.md', sha('bye'), NOW);
    b.set('file:commands/over.md', sha('old'), NOW);
    order(
      fileOrder('skills/x/SKILL.md', 'create', 'S', 'skills'),
      fileOrder('commands/new.md', 'create', 'N'),
      fileOrder('commands/over.md', 'overwrite', 'O'),
      fileOrder('commands/del.md', 'delete', null),
      { id: 'settings:model', kind: 'settings', op: 'overwrite', content: '"opus"', target: 'settings.json#model' },
    );
    inbox('dev-b', [
      { id: 'file:skills/x/SKILL.md', kind: 'skills', content: 'S' },
      { id: 'file:commands/new.md', kind: 'commands', content: 'N' },
      { id: 'file:commands/over.md', kind: 'commands', content: 'O' },
      { id: 'settings:model', kind: 'settings', content: '"opus"' },
    ]);
    return { generation: runApply(ctx()).generation! };
  }

  it('上書きしたものは元の中身へ、消したものは戻し、作ったものと空になった作りたてのディレクトリは消し、基準も適用前へ戻す', () => {
    const { generation } = applied();
    expect(read('commands/over.md')).toBe('O');
    expect(exists('skills')).toBe(true);
    clock += 60_000;
    const plan = planRestore({ home, claudeDir, name: generation });
    expect(plan.restore.sort()).toEqual(['commands/del.md', 'commands/over.md', 'settings.json']);
    expect(plan.remove.sort()).toEqual(['commands/new.md', 'skills/x/SKILL.md']);
    const r = runRestore({ ...ctx(), name: generation });
    expect(read('commands/over.md')).toBe('old');
    expect(read('commands/del.md')).toBe('bye');
    expect(read('settings.json')).toBe('{"model":"sonnet"}\n');
    expect(exists('commands/new.md')).toBe(false);
    expect(exists('skills')).toBe(false);
    expect(base().get('file:commands/over.md')).toBe(sha('old'));
    expect(base().get('file:commands/del.md')).toBe(sha('bye'));
    expect(base().has('file:commands/new.md')).toBe(false);
    expect(base().has('settings:model')).toBe(false);
    // 戻す前の状態も世代に取る。戻しを取り消せる。
    expect(r.safety).toBe('20261010-120100');
    expect(gens().map((g) => g.name)).toEqual(['20261010-120100', generation]);
    clock += 60_000;
    runRestore({ ...ctx(), name: r.safety! });
    expect(read('commands/over.md')).toBe('O');
    expect(exists('commands/del.md')).toBe(false);
    expect(read('commands/new.md')).toBe('N');
    expect(read('settings.json')).toBe('{\n  "model": "opus"\n}\n');
  });

  it('時刻の名前でないもの、無い世代、記録の無い古い実装の世代', () => {
    expect(fail(() => planRestore({ home, claudeDir, name: '../x' })).code).toBe('bad-name');
    expect(fail(() => runRestore({ ...ctx(), name: 'removed' })).code).toBe('bad-name');
    expect(fail(() => runRestore({ ...ctx(), name: '20250101-000000' })).code).toBe('no-generation');
    // 旧実装の世代（記録なし、中身は相対パスのファイルだけ）は、ファイルを戻すだけでできる。
    const legacy = path.join(configBackupsDir(home), '20250101-000000');
    fs.mkdirSync(path.join(legacy, 'skills/old'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'skills/old/SKILL.md'), 'legacy');
    write('skills/old/SKILL.md', 'current');
    const r = runRestore({ ...ctx(), name: '20250101-000000' });
    expect(read('skills/old/SKILL.md')).toBe('legacy');
    expect(r.restored).toEqual(['skills/old/SKILL.md']);
  });

  posixIt('戻し先の途中がリンクなら、何も書かずに断る（Unix だけ）', () => {
    const { generation } = applied();
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(abs('commands'), { recursive: true });
    fs.symlinkSync(outside, abs('commands'));
    expect(fail(() => runRestore({ ...ctx(), name: generation })).code).toBe('unsafe');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('データベースを開かなくても、ファイルは戻せる', () => {
    const { generation } = applied();
    const r = runRestore({ home, claudeDir, name: generation, now: () => clock });
    expect(read('commands/over.md')).toBe('old');
    expect(r.baseReverted).toBe(false);
  });
});

describe('指示書の読み書きの補助', () => {
  it('指示書を消す', () => {
    order(fileOrder('commands/a.md', 'create', 'A'));
    expect(deleteApplyOrder(home)).toBe(true);
    expect(deleteApplyOrder(home)).toBe(false);
  });
});
