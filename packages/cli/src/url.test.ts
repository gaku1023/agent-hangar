import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entryUrl, openInBrowser, openLocationScript, redirectPage } from './url.ts';
import { expectMode, posixIt } from '../../server/test/platform.ts';

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
      return { stdin: { end: (s: string) => written.push(String(s)) }, unref: () => {}, on: () => {} };
    }) as unknown as typeof spawn;
    openInBrowser(url, { spawnFn: fake, platform: 'darwin' });
    expect(calls).toEqual([{ cmd: 'osascript', args: ['-'] }]);
    expect(JSON.stringify(calls)).not.toContain(token);
    expect(written.join('')).toContain(`open location "${url}"`);
  });

  it('AppleScript の文字列を壊す文字を逃がす', () => {
    expect(openLocationScript('http://127.0.0.1:4177/?t=a"b\\c')).toBe('open location "http://127.0.0.1:4177/?t=a\\"b\\\\c"\n');
  });

  // ps で argv を読む実測。ブラウザを開く経路の Windows 版は次の区切りで作る。
  posixIt('実測。起こしたプロセスの argv に鍵は現れない（argv に載せた場合は現れる）', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const url = entryUrl(4177, token);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-open-'));
    const children: ChildProcess[] = [];
    try {
      // 標準入力を読むだけの osascript の代役。ps を取る間だけ生きている。
      const standIn = path.join(dir, 'fake-osascript');
      fs.writeFileSync(standIn, '#!/bin/sh\nsleep 3\ncat >/dev/null\n', { mode: 0o755 });
      openInBrowser(url, { platform: 'darwin', spawnFn: ((_cmd: string, args: readonly string[], opts: object) => {
        const c = spawn(standIn, args as string[], opts as Parameters<typeof spawn>[2]);
        children.push(c);
        return c;
      }) as unknown as typeof spawn });
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

describe('openInBrowser（macOS の外）', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-open-home-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const token = 'b'.repeat(64);
  const url = entryUrl(4177, token);
  /** 起こしたコマンドを覚え、起動に失敗したことにもできる偽の spawn。 */
  const fakeSpawn = (o: { fail?: boolean } = {}) => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const fn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      const child = Object.assign(new EventEmitter(), { stdin: null, unref: () => {} });
      if (o.fail) queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    }) as unknown as typeof spawn;
    return { fn, calls };
  };

  it('Windows は、鍵を書いた転送のページを置き場に書き、そのファイルを既定のブラウザで開く', () => {
    const f = fakeSpawn();
    openInBrowser(url, { spawnFn: f.fn, platform: 'win32', home });
    const page = path.join(home, 'open.html');
    expect(f.calls).toEqual([{ cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', page] }]);
    // 鍵は argv に載らず、ファイルの中にだけある。
    expect(JSON.stringify(f.calls)).not.toContain(token);
    expect(fs.readFileSync(page, 'utf8')).toBe(redirectPage(url));
  });

  it('Linux は xdg-open で同じページを開く', () => {
    const f = fakeSpawn();
    openInBrowser(url, { spawnFn: f.fn, platform: 'linux', home });
    expect(f.calls).toEqual([{ cmd: 'xdg-open', args: [path.join(home, 'open.html')] }]);
  });

  posixIt('転送のページは本人だけが読める', () => {
    openInBrowser(url, { spawnFn: fakeSpawn().fn, platform: 'linux', home });
    expectMode(path.join(home, 'open.html'), 0o600);
  });

  it('開く道具が無くても、CLI を落とさない', async () => {
    const f = fakeSpawn({ fail: true });
    expect(() => openInBrowser(url, { spawnFn: f.fn, platform: 'win32', home })).not.toThrow();
    // error を受け手なしで投げると、プロセスごと落ちる。受け手があれば、ここまで進む。
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toHaveLength(1);
  });

  it('転送のページは、URL を HTML の属性と文字列から抜けられない形で埋める', () => {
    const page = redirectPage('http://127.0.0.1:4177/?t="<>&\'');
    expect(page).not.toContain('"<>');
    expect(page).toContain('&quot;&lt;&gt;&amp;');
    expect(page).toContain('location.replace(');
  });
});
