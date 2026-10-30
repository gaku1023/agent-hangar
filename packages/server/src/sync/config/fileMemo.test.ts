import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../db/open.ts';
import { collectLocal } from './collect.ts';
import { clearFileMemo, endRound, fileMemoSize, readRegular, startRound, StaleContentError } from './fileMemo.ts';

let tmp: string;
let claudeDir: string;
let db: Db;
const abs = (rel: string): string => path.join(claudeDir, ...rel.split('/'));
const write = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); };
/** mtime を十分に過去へ置き、ctime の刻みも過ぎるまで待つ（書いた直後は記憶を信用しない決まりのため）。 */
const settle = async (rel: string): Promise<void> => {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(abs(rel), old, old);
  await new Promise((r) => setTimeout(r, 70));
};
const collect = () => collectLocal({ db, deviceId: 'dev-a', claudeDir, allowedUnsent: new Map() });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-memo-'));
  claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir);
  db = openDb(':memory:');
  clearFileMemo();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('ファイルの読みの記憶', () => {
  it('変わっていないファイルは、2 回目に読まず、同じ結果を返す', async () => {
    write('CLAUDE.md', '# hello');
    write('skills/a/SKILL.md', 'body');
    await settle('CLAUDE.md');
    await settle('skills/a/SKILL.md');
    const first = collect();
    const spy = vi.spyOn(fs, 'readFileSync');
    const second = collect();
    expect(spy.mock.calls.filter((c) => String(c[0]).startsWith(claudeDir))).toEqual([]);
    expect(second.items.map((i) => [i.id, i.sha256, i.size, i.marks, i.withheld])).toEqual(first.items.map((i) => [i.id, i.sha256, i.size, i.marks, i.withheld]));
  });

  it('中身は読んだときに読み直す', async () => {
    write('CLAUDE.md', '# hello');
    await settle('CLAUDE.md');
    collect();
    const item = collect().items.find((i) => i.id === 'file:CLAUDE.md')!;
    expect(item.content.toString()).toBe('# hello');
  });

  it('stat が同じでも中身が変わっていたら、読んだときに気付いて記憶を捨てる', async () => {
    write('CLAUDE.md', '# hello');
    await settle('CLAUDE.md');
    collect();
    const item = collect().items.find((i) => i.id === 'file:CLAUDE.md')!;
    const st = fs.statSync(abs('CLAUDE.md'));
    fs.writeFileSync(abs('CLAUDE.md'), '# HELLO');
    fs.utimesSync(abs('CLAUDE.md'), st.atime, st.mtime);
    expect(() => item.content).toThrow(StaleContentError);
    const again = collect().items.find((i) => i.id === 'file:CLAUDE.md')!;
    expect(again.content.toString()).toBe('# HELLO');
  });

  it('書き換えたファイルは、読み直して新しい指紋にする', async () => {
    write('CLAUDE.md', 'one');
    await settle('CLAUDE.md');
    const a = collect().items[0]!.sha256;
    write('CLAUDE.md', 'two!');
    const b = collect().items[0]!;
    expect(b.sha256).not.toBe(a);
    expect(b.size).toBe(4);
  });

  it('秘密の検出の結果も記憶し、「それでも送る」の判定は毎回当て直す', async () => {
    write('memory/leak.md', 'key sk-ant-abcdefghijklmnopqrstuvwxyz');
    await settle('memory/leak.md');
    const c1 = collect();
    const leak = c1.items.find((i) => i.label === 'memory/leak.md')!;
    expect(leak.withheld).toBe('secret');
    const spy = vi.spyOn(fs, 'readFileSync');
    const c2 = collectLocal({ db, deviceId: 'dev-a', claudeDir, allowedUnsent: new Map([[`secret:${leak.id}`, leak.sha256]]) });
    expect(spy.mock.calls.filter((c) => String(c[0]).startsWith(claudeDir))).toEqual([]);
    expect(c2.items.find((i) => i.id === leak.id)!.withheld).toBeNull();
    expect(c2.unsent.find((u) => u.itemId === leak.id)!.allowed).toBe(true);
  });

  it('1 周で見なかったパスの記憶は落とす', async () => {
    write('CLAUDE.md', 'x');
    write('keybindings.json', '{}');
    await settle('CLAUDE.md');
    await settle('keybindings.json');
    startRound(); collect(); endRound();
    expect(fileMemoSize()).toBe(2);
    fs.rmSync(abs('keybindings.json'));
    startRound(); collect(); endRound();
    expect(fileMemoSize()).toBe(1);
  });

  it('リンクと無いファイルの扱いは変えない', () => {
    expect(readRegular(abs('none'))).toBe('absent');
    write('real', 'x');
    fs.symlinkSync(abs('real'), abs('link'));
    expect(readRegular(abs('link'))).toBe('blocked');
  });
});
