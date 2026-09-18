import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryUrl, openInBrowser, openLocationScript } from './url.ts';

describe('entryUrl', () => {
  it('鍵を問い合わせに載せた URL を作る', () => {
    expect(entryUrl(4177, 'a'.repeat(64))).toBe(`http://127.0.0.1:4177/?t=${'a'.repeat(64)}`);
    expect(entryUrl(4198, 'ab/cd')).toBe('http://127.0.0.1:4198/?t=ab%2Fcd');
  });
});

describe('openInBrowser', () => {
  it('鍵付きの URL を argv に載せず、標準入力から osascript に渡す', () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const written: string[] = [];
    const token = 'a'.repeat(64);
    const url = entryUrl(4177, token);
    const fake = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return { stdin: { end: (s: string) => written.push(String(s)) }, unref: () => {} };
    }) as unknown as typeof spawn;
    openInBrowser(url, fake);
    expect(calls).toEqual([{ cmd: 'osascript', args: ['-'] }]);
    expect(JSON.stringify(calls)).not.toContain(token);
    expect(written.join('')).toContain(`open location "${url}"`);
  });

  it('AppleScript の文字列を壊す文字を逃がす', () => {
    expect(openLocationScript('http://127.0.0.1:4177/?t=a"b\\c')).toBe('open location "http://127.0.0.1:4177/?t=a\\"b\\\\c"\n');
  });

  it('実測。起こしたプロセスの argv に鍵は現れない（argv に載せた場合は現れる）', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const url = entryUrl(4177, token);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-open-'));
    const children: ChildProcess[] = [];
    try {
      // 標準入力を読むだけの osascript の代役。ps を取る間だけ生きている。
      const standIn = path.join(dir, 'fake-osascript');
      fs.writeFileSync(standIn, '#!/bin/sh\nsleep 3\ncat >/dev/null\n', { mode: 0o755 });
      openInBrowser(url, ((_cmd: string, args: readonly string[], opts: object) => {
        const c = spawn(standIn, args as string[], opts as Parameters<typeof spawn>[2]);
        children.push(c);
        return c;
      }) as unknown as typeof spawn);
      // 対照。argv に載せる旧来の形なら、同じ ps の取り方で確かに読める。
      const leaky = path.join(dir, 'leaky');
      fs.writeFileSync(leaky, '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
      children.push(spawn(leaky, [url], { stdio: 'ignore' }));
      const ps = execFileSync('ps', ['-axww', '-o', 'command='], { maxBuffer: 64 * 1024 * 1024 }).toString();
      expect(ps).toContain(`${leaky} ${url}`);
      expect(ps.split('\n').filter((l) => l.includes(token) && !l.includes('leaky'))).toEqual([]);
    } finally {
      // 自分が起こした PID だけを止める。ポート番号では止めない。
      for (const c of children) if (c.pid) try { process.kill(c.pid, 'SIGKILL'); } catch { /* 既に終わっている */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
