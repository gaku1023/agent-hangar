import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAndExitScript } from '../../test/fake-bin.ts';
import { captureOutput, captureOutputSync } from './capture.ts';

let tmp: string;
/** 一時ファイルを作らせる場所。試験ごとに空で始め、終わったら空に戻っているかを見る。 */
let outDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-capture-'));
  outDir = path.join(tmp, 'out');
  fs.mkdirSync(outDir);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 台本を置き、いまの Node で起こす引数を返す。.cmd を通さないので、どの OS でも同じに動く。 */
function script(name: string, body: string): string {
  const p = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(p, body);
  return p;
}

/** パイプの容量（8KB〜64KB）を越える出力。行ごとに番号を振り、どこで切れても全体とは一致しない。 */
const BIG = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'.'.repeat(60)}`).join('\n') + '\nEND\n';

describe('captureOutput', () => {
  // claude はパイプへ非同期に書き、書き切る前に終わる。パイプで読むと macOS では 8KB か 16KB で切れた。
  it('標準出力へ大きく書いてすぐ終わる子の出力を、最後まで読む', async () => {
    const js = script('big', writeAndExitScript(BIG));
    const r = await captureOutput(process.execPath, [js], { timeoutMs: 10_000, tmpDir: outDir });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(BIG.length);
    expect(r.stdout).toBe(BIG);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('標準入力を渡し、頼めば標準エラーも集める。0 以外の終了コードもそのまま返す', async () => {
    const js = script('echo', [
      'let s = "";',
      'for await (const c of process.stdin) s += c;',
      'process.stderr.write("warn\\n");',
      'process.stdout.write(`got:${s}`);',
      'process.exit(3);',
    ].join('\n'));
    const r = await captureOutput(process.execPath, [js], { timeoutMs: 10_000, stdin: 'hello', stderr: true, tmpDir: outDir });
    expect(r).toEqual({ code: 3, stdout: 'got:hello', stderr: 'warn\n' });
    // 頼まなければ標準エラーは捨てる。
    expect((await captureOutput(process.execPath, [js], { timeoutMs: 10_000, stdin: 'x', tmpDir: outDir })).stderr).toBe('');
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('時間を過ぎたら止めて投げ、待ち続けない', async () => {
    const js = script('hang', 'process.stdout.write("partial");\nsetInterval(() => {}, 1000);\n');
    const t0 = Date.now();
    await expect(captureOutput(process.execPath, [js], { timeoutMs: 300, tmpDir: outDir })).rejects.toThrow('300 ミリ秒で応答がありませんでした');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('上限を越えた出力は投げる', async () => {
    const js = script('big', writeAndExitScript(BIG));
    await expect(captureOutput(process.execPath, [js], { timeoutMs: 10_000, maxBytes: 1024, tmpDir: outDir })).rejects.toThrow('上限');
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('起こせないもの（無い、空、NUL 入り）は投げる。その場で投げる場所も拒否にする', async () => {
    await expect(captureOutput(path.join(tmp, 'missing'), [], { timeoutMs: 1000, tmpDir: outDir })).rejects.toThrow();
    await expect(captureOutput('', [], { timeoutMs: 1000, tmpDir: outDir })).rejects.toThrow();
    await expect(captureOutput('claude\0x', [], { timeoutMs: 1000, tmpDir: outDir })).rejects.toThrow();
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
});

describe('captureOutputSync', () => {
  it('標準出力へ大きく書いてすぐ終わる子の出力を、最後まで読む', () => {
    const js = script('big', writeAndExitScript(BIG));
    const r = captureOutputSync(process.execPath, [js], { timeoutMs: 10_000, tmpDir: outDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(BIG);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('0 以外の終了コードをそのまま返す', () => {
    const js = script('bad', writeAndExitScript('x', 3));
    expect(captureOutputSync(process.execPath, [js], { timeoutMs: 10_000, tmpDir: outDir })).toEqual({ code: 3, stdout: 'x', stderr: '' });
  });
  it('時間を過ぎたら止めて投げる', () => {
    const js = script('hang', 'setInterval(() => {}, 1000);\n');
    const t0 = Date.now();
    expect(() => captureOutputSync(process.execPath, [js], { timeoutMs: 300, tmpDir: outDir })).toThrow('300 ミリ秒で応答がありませんでした');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('起こせないもの（無い、空、NUL 入り）は投げ、一時ファイルを残さない', () => {
    expect(() => captureOutputSync(path.join(tmp, 'missing'), [], { timeoutMs: 1000, tmpDir: outDir })).toThrow();
    expect(() => captureOutputSync('', [], { timeoutMs: 1000, tmpDir: outDir })).toThrow();
    expect(() => captureOutputSync('claude\0x', [], { timeoutMs: 1000, tmpDir: outDir })).toThrow();
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
});
