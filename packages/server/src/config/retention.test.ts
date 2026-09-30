import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RetentionDto } from '@agent-hangar/shared';
import { measureUsage, previewRetention, readRetention, RetentionConflictError, RetentionService, writeRetention } from './retention.ts';

const NOW = Date.parse('2026-10-01T00:00:00Z');
let root: string;
let claudeDir: string;
let managedDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ret-'));
  claudeDir = path.join(root, '.claude');
  managedDir = path.join(root, 'managed');
  fs.mkdirSync(claudeDir);
});
afterEach(() => {
  try { fs.chmodSync(path.join(claudeDir, 'projects', 'locked'), 0o700); } catch { /* 無ければよい */ }
  fs.rmSync(root, { recursive: true, force: true });
});
const settings = (s: string) => fs.writeFileSync(path.join(claudeDir, 'settings.json'), s);

describe('readRetention', () => {
  it('ファイルもキーも無ければ既定の 30 日で、書ける', () => {
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null });
    settings('{ "a": 1 }');
    expect(readRetention({ claudeDir, managedDir }).source).toBe('default');
  });
  it('1 以上の整数ならユーザーの値として読む', () => {
    settings('{ "cleanupPeriodDays" : 3650 }');
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 3650, source: 'user', userValue: 3650, writable: true, unwritableReason: null });
  });
  it('Claude Code が受け付けない値は、既定として扱う', () => {
    for (const v of ['0', '-1', '7.5', '"30"', 'null']) {
      settings(`{ "cleanupPeriodDays": ${v} }`);
      expect(readRetention({ claudeDir, managedDir })).toMatchObject({ days: 30, source: 'default', userValue: null, writable: true });
    }
  });
  it('JSON として読めなければ、書けない', () => {
    settings('{ "a": ');
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 30, source: 'default', userValue: null, writable: false, unwritableReason: '設定ファイルを読み取れないので書き換えません' });
  });
  it('組織の設定があればそれが効き、書けない。drop-in は名前の順で後が勝つ', () => {
    settings('{ "cleanupPeriodDays": 365 }');
    fs.mkdirSync(path.join(managedDir, 'managed-settings.d'), { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), '{ "cleanupPeriodDays": 14 }');
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 14, source: 'managed', userValue: 365, writable: false, unwritableReason: '組織の設定で決まっています' });
    fs.writeFileSync(path.join(managedDir, 'managed-settings.d', '20-b.json'), '{ "cleanupPeriodDays": 60 }');
    fs.writeFileSync(path.join(managedDir, 'managed-settings.d', '10-a.json'), '{ "cleanupPeriodDays": 7 }');
    expect(readRetention({ claudeDir, managedDir }).days).toBe(60);
  });
});

describe('measureUsage', () => {
  const DAY = 86_400_000;
  const put = (rel: string, bytes: number, ageDays: number) => {
    const p = path.join(claudeDir, 'projects', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(p, t, t);
  };
  it('合計と、直近 30 日のぶんを 30 で割った増え方を返す', async () => {
    put('p/a.jsonl', 3000, 1);
    put('p/a/tool-results/x.txt', 3000, 10);
    put('p/old.jsonl', 9000, 40);
    const u = await measureUsage({ claudeDir, now: NOW });
    expect(u.bytes).toBe(15_000);
    expect(u.dailyBytes).toBe(200);
    expect(u.freeBytes).toBeGreaterThan(0);
    expect(u.measuredAt).toBe(NOW);
  });
  it('シンボリックリンクはたどらず、読めないディレクトリは飛ばす', async () => {
    put('p/a.jsonl', 1000, 1);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'big'), Buffer.alloc(50_000));
    fs.symlinkSync(outside, path.join(claudeDir, 'projects', 'link'));
    fs.mkdirSync(path.join(claudeDir, 'projects', 'locked'));
    fs.writeFileSync(path.join(claudeDir, 'projects', 'locked', 'x'), Buffer.alloc(10));
    fs.chmodSync(path.join(claudeDir, 'projects', 'locked'), 0o000);
    expect((await measureUsage({ claudeDir, now: NOW })).bytes).toBe(1000);
  });
  it('projects が無ければ 0', async () => {
    expect((await measureUsage({ claudeDir, now: NOW })).bytes).toBe(0);
  });
});

describe('previewRetention と writeRetention', () => {
  const home = () => path.join(root, 'hangar');
  const file = () => path.join(claudeDir, 'settings.json');
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const SRC = '{\n  "a" : 1,\n  "cleanupPeriodDays" : 3650\n}\n';

  it('下見は何も書かず、変わる行と指紋と見込みを返す', () => {
    settings(SRC);
    const p = previewRetention({ claudeDir, home: home(), days: 365, dailyBytes: 1000 });
    expect(p.lines).toEqual([{ kind: 'ctx', text: '  "a" : 1,' }, { kind: 'del', text: '  "cleanupPeriodDays" : 3650' }, { kind: 'add', text: '  "cleanupPeriodDays" : 365' }, { kind: 'ctx', text: '}' }]);
    expect(p.baseSha256).toBe(sha(SRC));
    expect(p.projectedBytes).toBe(365_000);
    expect(p.path).toBe(fs.realpathSync(file()));
    expect(p.backupDir).toBe(path.join(home(), 'backups', 'claude-config'));
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC);
  });
  it('ファイルが無ければ、指紋は空で、全行が add になる', () => {
    const p = previewRetention({ claudeDir, home: home(), days: 365, dailyBytes: null });
    expect(p.baseSha256).toBe('');
    expect(p.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(p.projectedBytes).toBeNull();
  });
  it('書くと 1 行だけ変わり、控えを取り、権限を保つ', () => {
    settings(SRC);
    fs.chmodSync(file(), 0o644);
    const r = writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), now: new Date(2026, 9, 1, 12, 0, 0) });
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC.replace('3650', '365'));
    expect(fs.statSync(file()).mode & 0o777).toBe(0o644);
    expect(r.backup).toBe(path.join(home(), 'backups', 'claude-config', '20261001-120000', 'settings.json'));
    expect(fs.readFileSync(r.backup!, 'utf8')).toBe(SRC);
    expect(fs.statSync(r.backup!).mode & 0o777).toBe(0o600);
  });
  it('同じ秒に 2 度書いても、先の控えを潰さない', () => {
    settings(SRC);
    const now = new Date(2026, 9, 1, 12, 0, 0);
    writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), now });
    const next = fs.readFileSync(file(), 'utf8');
    const r = writeRetention({ claudeDir, home: home(), days: 90, baseSha256: sha(next), now });
    expect(r.backup!.endsWith('settings.json-2')).toBe(true);
  });
  it('ファイルが無ければ 0600 で作り、控えは取らない', () => {
    const r = writeRetention({ claudeDir, home: home(), days: 365, baseSha256: '' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ cleanupPeriodDays: 365 });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(r.backup).toBeNull();
  });
  it('下見の後に変わっていたら、書かずに RetentionConflictError', () => {
    settings(SRC);
    expect(() => writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha('{}') })).toThrow(RetentionConflictError);
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC);
  });
  it('控えを取った後、書く直前に割り込まれても書かない', () => {
    settings(SRC);
    expect(() => writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), onBeforeWrite: () => settings('{ "b": 2 }') })).toThrow(RetentionConflictError);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ "b": 2 }');
  });
  it('控えが取れなければ書かない', () => {
    settings(SRC);
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(path.join(home(), 'backups'), 'ディレクトリの代わりのファイル');
    expect(() => writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC) })).toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC);
  });
  it('リンクなら実体に書き、リンクを保つ', () => {
    const real = path.join(root, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, SRC);
    fs.symlinkSync(real, file());
    writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC) });
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(SRC.replace('3650', '365'));
  });
});

describe('RetentionService', () => {
  it('変わったときだけ配り、書いた後は新しい値を返す', async () => {
    const sent: RetentionDto[] = [];
    const svc = new RetentionService({ claudeDir, home: path.join(root, 'hangar'), managedDir, broadcast: (r) => sent.push(r), now: () => NOW });
    svc.refresh();
    expect(sent).toHaveLength(0);
    expect(svc.current()).toMatchObject({ days: 30, source: 'default', usage: null });
    const p = svc.preview(365);
    expect(svc.write(365, p.baseSha256)).toMatchObject({ days: 365, source: 'user' });
    expect(sent.at(-1)).toMatchObject({ days: 365 });
    svc.refresh();
    expect(sent).toHaveLength(1);
    await svc.measure();
    expect(sent.at(-1)!.usage).not.toBeNull();
  });
});
