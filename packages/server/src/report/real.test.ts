import { describe, expect, it, vi } from 'vitest';
import { ghClient, osLabel } from './real.ts';

const ok = (stdout = '', code = 0, stderr = '') => async () => ({ code, stdout, stderr });

describe('osLabel', () => {
  it('Windows は名前と版、ほかは種類と版', () => {
    expect(osLabel('win32', '10.0.26200', 'Windows 11 Home')).toBe('Windows 11 Home 10.0.26200');
    expect(osLabel('darwin', '27.0.0', 'Darwin Kernel Version 27.0.0: long text')).toBe('darwin 27.0.0');
  });
});

describe('ghClient', () => {
  it('gh が無ければ使えない', async () => {
    const capture = vi.fn();
    expect(await ghClient(null, capture).available()).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('auth status の終了コードでログインを見分ける', async () => {
    expect(await ghClient('/bin/gh', ok('', 0)).available()).toBe(true);
    expect(await ghClient('/bin/gh', ok('', 1)).available()).toBe(false);
    expect(await ghClient('/bin/gh', async () => { throw new Error('spawn'); }).available()).toBe(false);
  });

  it('本文を標準入力で渡し、出力の URL を返す', async () => {
    const capture = vi.fn(ok('Creating issue in o/r\n\nhttps://github.com/o/r/issues/12\n'));
    const url = await ghClient('/bin/gh', capture).create('o/r', '[bug] t', 'body text');
    expect(url).toBe('https://github.com/o/r/issues/12');
    const [file, args, opts] = capture.mock.calls[0] as unknown as [string, string[], { stdin: string }];
    expect(file).toBe('/bin/gh');
    expect(args).toEqual(['issue', 'create', '--repo', 'o/r', '--title', '[bug] t', '--body-file', '-']);
    expect(opts.stdin).toBe('body text');
    expect(args.join(' ')).not.toContain('body text');
  });

  it('失敗したら標準エラーの文で投げる', async () => {
    await expect(ghClient('/bin/gh', ok('', 1, 'HTTP 410: Issues are disabled')).create('o/r', 't', 'b')).rejects.toThrow('HTTP 410');
  });
});
