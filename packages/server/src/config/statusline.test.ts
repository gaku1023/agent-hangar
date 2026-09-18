import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendStatuslineSnippet, ensureStatuslineHeaderFile, resolveStatuslineScript, STATUSLINE_MARKER, statuslineHeaderPath, statuslineSnippet, statuslineStatus, writeStatuslineHeaderFile } from './statusline.ts';

let dir: string;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-sl-home-'));
  dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
/** そのファイルができるまで待つ。 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`waitForFile: timeout ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** スクリプトを bash で走らせ、標準出力を返す。curl は PATH の先頭を差し替えられる。 */
function runScript(script: string, hangarHome: string, input: string, binDir?: string): Promise<string> {
  const PATH = binDir ? `${binDir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '');
  const child = spawn('bash', [script], { env: { ...process.env, PATH, HANGAR_HOME: hangarHome }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (out += c));
  child.stdin.end(input);
  return new Promise((r) => child.on('close', () => r(out)));
}

const settings = (command: unknown) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));

describe('statuslineSnippet', () => {
  it('目印の行で始まり、ポートを埋める', () => {
    const s = statuslineSnippet(4177);
    expect(s.split('\n')[0]).toBe(STATUSLINE_MARKER);
    expect(s).toContain('http://127.0.0.1:4177/api/ingest/statusline');
    expect(s).toContain('exec <<<"$__hangar_input"');
    expect(s.endsWith('\n')).toBe(true);
  });

  it('ヘッダのファイルは HANGAR_HOME があればそこから読む', () => {
    const s = statuslineSnippet(4177);
    expect(s).toContain('${HANGAR_HOME:-$HOME/.agent-hangar}');
    expect(s).toContain('"$__hangar_home/statusline-header"');
    expect(s).not.toContain('$HOME/.agent-hangar/statusline-header');
  });

  it('トークンを curl の引数に載せず、ヘッダのファイルから読ませる', () => {
    // -H "Authorization: Bearer $(cat ...)" はシェルが展開してから curl を起こすので、
    // curl の argv に 64 桁がそのまま載り、statusline が走るたびに ps から読める。
    // --variable と --expand-header でも隠せるが、それは curl 8.3 以降にしか無く、
    // 古い curl では無警告で壊れる。-H @<ファイル> は 7.55 以降にあり、同じだけ隠せる。
    const s = statuslineSnippet(4177);
    expect(s).not.toContain('Bearer $(cat');
    expect(s).not.toMatch(/-H ["']Authorization: Bearer \$/);
    expect(s).not.toContain('--variable');
    expect(s).not.toContain('--expand-header');
    expect(s).toContain('-H @"$__hangar_header"');
  });

  it('ヘッダのファイルが読めなければ、何もせずに素通しする', () => {
    const s = statuslineSnippet(4177);
    expect(s).toContain('if [ -r "$__hangar_header" ]; then');
    // 送らない場合でも、元のスクリプトへ標準入力を戻す行は if の外にある。
    expect(s.split('\n').at(-2)).toBe('exec <<<"$__hangar_input"');
  });
});

describe('writeStatuslineHeaderFile', () => {
  const TOKEN = 'f'.repeat(64);

  it('ヘッダ 1 行だけを 0600 で置き、token とは別の名前にする', () => {
    const hangarHome = path.join(home, '.agent-hangar');
    fs.mkdirSync(hangarHome, { recursive: true });
    const file = writeStatuslineHeaderFile(hangarHome, TOKEN);
    expect(file).toBe(statuslineHeaderPath(hangarHome));
    expect(file).toBe(path.join(hangarHome, 'statusline-header'));
    expect(fs.readFileSync(file, 'utf8')).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('既にあるファイルは中身を入れ替え、他人に読める権限なら狭める', () => {
    const hangarHome = path.join(home, '.agent-hangar2');
    fs.mkdirSync(hangarHome, { recursive: true });
    const file = statuslineHeaderPath(hangarHome);
    fs.writeFileSync(file, 'Authorization: Bearer 古い\n', { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    writeStatuslineHeaderFile(hangarHome, TOKEN);
    expect(fs.readFileSync(file, 'utf8')).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('ensureStatuslineHeaderFile', () => {
  const TOKEN = 'e'.repeat(64);

  it('ファイルが無ければ 0600 で作る', () => {
    const hangarHome = path.join(home, '.agent-hangar-ensure1');
    fs.mkdirSync(hangarHome, { recursive: true });
    const file = ensureStatuslineHeaderFile(hangarHome, TOKEN);
    expect(file).toBe(statuslineHeaderPath(hangarHome));
    expect(fs.readFileSync(file, 'utf8')).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('中身と権限が合っていれば書き直さない', () => {
    const hangarHome = path.join(home, '.agent-hangar-ensure2');
    fs.mkdirSync(hangarHome, { recursive: true });
    const file = ensureStatuslineHeaderFile(hangarHome, TOKEN);
    const before = fs.statSync(file).mtimeMs;
    // mtime の分解能で同じ値にならないよう、書き込みの有無が分かる時刻に戻しておく。
    const past = new Date(before - 60_000);
    fs.utimesSync(file, past, past);
    ensureStatuslineHeaderFile(hangarHome, TOKEN);
    // mtime はナノ秒から丸められるので、1 ミリ秒の幅で見る。書き直していれば今の時刻に飛ぶ。
    expect(Math.abs(fs.statSync(file).mtimeMs - past.getTime())).toBeLessThan(1);
  });

  it('トークンが作り直されていれば書き直す', () => {
    const hangarHome = path.join(home, '.agent-hangar-ensure3');
    fs.mkdirSync(hangarHome, { recursive: true });
    ensureStatuslineHeaderFile(hangarHome, TOKEN);
    const next = 'd'.repeat(64);
    const file = ensureStatuslineHeaderFile(hangarHome, next);
    expect(fs.readFileSync(file, 'utf8')).toBe(`Authorization: Bearer ${next}\n`);
  });

  it('中身が合っていても他人に読める権限なら狭める', () => {
    const hangarHome = path.join(home, '.agent-hangar-ensure4');
    fs.mkdirSync(hangarHome, { recursive: true });
    const file = ensureStatuslineHeaderFile(hangarHome, TOKEN);
    fs.chmodSync(file, 0o644);
    ensureStatuslineHeaderFile(hangarHome, TOKEN);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('statusline のスニペットを実際に走らせる', () => {
  const TOKEN = 'a1b2c3d4'.repeat(8);

  /** HANGAR_HOME になる置き場を用意し、ヘッダのファイルを置く。 */
  function hangarHomeWithHeader(): string {
    const hangarHome = path.join(home, '.agent-hangar');
    fs.mkdirSync(hangarHome, { recursive: true });
    writeStatuslineHeaderFile(hangarHome, TOKEN);
    return hangarHome;
  }

  it('curl の argv にトークンが出ず、ps からも読めない', async () => {
    const hangarHome = hangarHomeWithHeader();
    // PATH の先頭に偽の curl を置く。受け取った argv を記録し、少し待ってから終わる。
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const argsFile = path.join(home, 'curl-args.bin');
    const doneFile = path.join(home, 'curl-done.txt');
    fs.writeFileSync(
      path.join(bin, 'curl'),
      ['#!/bin/sh', `for a in "$@"; do printf '%s\\000' "$a" >> "${argsFile}"; done`, 'cat > /dev/null', `printf ok > "${doneFile}"`, 'sleep 2', ''].join('\n'),
      { mode: 0o755 },
    );
    const script = path.join(home, 'sl.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash\n${statuslineSnippet(4177)}`, { mode: 0o755 });

    const child = spawn('bash', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HANGAR_HOME: hangarHome }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end('{"session_id":"x"}');
    await waitForFile(doneFile);

    // 偽の curl が動いている間に ps を読む。
    const ps = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
    expect(ps).toContain('/api/ingest/statusline');
    expect(ps).not.toContain(TOKEN);
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).not.toContain(TOKEN);
    // トークンではなく、ヘッダのファイルの名前だけが argv に載る。
    expect(args).toContain(`@${statuslineHeaderPath(hangarHome)}`);
  });

  it('本物の curl で、本文と Authorization がそのまま届く', async () => {
    const hangarHome = hangarHomeWithHeader();
    const got: { auth?: string; type?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ auth: req.headers.authorization, type: req.headers['content-type'], body: b });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const script = path.join(home, 'real.sh');
      fs.writeFileSync(script, `#!/usr/bin/env bash\n${statuslineSnippet(port)}cat\n`, { mode: 0o755 });
      const out = await runScript(script, hangarHome, '{"session_id":"x"}');
      // 元のスクリプトには、読んだ標準入力が戻る（here-string なので末尾に改行が付く）。
      expect(out).toBe('{"session_id":"x"}\n');
      const until = Date.now() + 5000;
      while (got.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(got).toHaveLength(1);
      expect(got[0]!.auth).toBe(`Bearer ${TOKEN}`);
      expect(got[0]!.type).toBe('application/json');
      expect(got[0]!.body).toBe('{"session_id":"x"}');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ヘッダのファイルが無ければ、何も送らずに素通しする', async () => {
    const hangarHome = path.join(home, '.agent-hangar-empty');
    fs.mkdirSync(hangarHome, { recursive: true });
    const bin = path.join(home, 'bin2');
    fs.mkdirSync(bin, { recursive: true });
    const calledFile = path.join(home, 'curl-called.txt');
    fs.writeFileSync(path.join(bin, 'curl'), ['#!/bin/sh', `printf called > "${calledFile}"`, ''].join('\n'), { mode: 0o755 });
    const script = path.join(home, 'quiet.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash\n${statuslineSnippet(4177)}cat\n`, { mode: 0o755 });
    const out = await runScript(script, hangarHome, '{"session_id":"y"}', bin);
    // statusline の表示は壊さない。
    expect(out).toBe('{"session_id":"y"}\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(calledFile)).toBe(false);
  });
});

describe('resolveStatuslineScript', () => {
  it('command の先頭の語をファイルとして解決する', () => {
    fs.writeFileSync(path.join(dir, 'statusline-command.sh'), '#!/usr/bin/env bash\necho hi\n');
    settings('~/.claude/statusline-command.sh');
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: '~/.claude/statusline-command.sh', scriptPath: path.join(dir, 'statusline-command.sh') });
    settings(`bash ${dir}/statusline-command.sh --compact`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(path.join(dir, 'statusline-command.sh'));
    settings('npx ccstatusline@latest');
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: 'npx ccstatusline@latest', scriptPath: null });
    settings(undefined);
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: null, scriptPath: null });
    fs.rmSync(path.join(dir, 'settings.json'));
    expect(resolveStatuslineScript(dir, home)).toEqual({ command: null, scriptPath: null });
  });
});

describe('appendStatuslineSnippet', () => {
  it('shebang の直後に入れ、バックアップを取り、二重に入れない', () => {
    const file = path.join(dir, 's.sh');
    fs.writeFileSync(file, '#!/usr/bin/env bash\necho hi\n');
    const r = appendStatuslineSnippet(file, 4177, new Date(2026, 8, 17, 12, 34, 56));
    expect(r.changed).toBe(true);
    expect(r.backup).toBe(path.join(dir, 's.sh.bak-20260917123456'));
    expect(fs.readFileSync(r.backup!, 'utf8')).toBe('#!/usr/bin/env bash\necho hi\n');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines[1]).toBe(STATUSLINE_MARKER);
    expect(lines.at(-2)).toBe('echo hi');
    expect(appendStatuslineSnippet(file, 4177)).toEqual({ changed: false, backup: null });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(1);
    settings(file);
    expect(statuslineStatus(dir, home)).toEqual({ command: file, scriptPath: file, installed: true });
  });

  it('shebang が無ければ先頭に入れる', () => {
    const file = path.join(dir, 't.sh');
    fs.writeFileSync(file, 'echo hi\n');
    appendStatuslineSnippet(file, 4199);
    expect(fs.readFileSync(file, 'utf8').startsWith(STATUSLINE_MARKER)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain(':4199/');
  });

  /** トークンを argv に載せていた最初の形。 */
  const OLD_ARGV_FORM = [
    STATUSLINE_MARKER,
    '__hangar_input=$(cat)',
    '__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"',
    `printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \\`,
    `  -H 'Content-Type: application/json' \\`,
    '  -H "Authorization: Bearer $(cat "$__hangar_home/token" 2>/dev/null)" \\',
    '  --data-binary @- http://127.0.0.1:4177/api/ingest/statusline >/dev/null 2>&1 &',
    'exec <<<"$__hangar_input"',
    '',
  ].join('\n');

  /** curl 8.3 以降を要る形。それより古い curl では無警告で壊れる。 */
  const OLD_VARIABLE_FORM = [
    STATUSLINE_MARKER,
    '__hangar_input=$(cat)',
    '__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"',
    '__hangar_token=$(cat "$__hangar_home/token" 2>/dev/null)',
    `printf '%s' "$__hangar_input" | HANGAR_TOKEN="$__hangar_token" curl -s -m 0.3 -X POST \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --variable '%HANGAR_TOKEN' --expand-header 'Authorization: Bearer {{HANGAR_TOKEN}}' \\`,
    '  --data-binary @- http://127.0.0.1:4177/api/ingest/statusline >/dev/null 2>&1 &',
    'exec <<<"$__hangar_input"',
    '',
  ].join('\n');

  it.each([
    ['トークンを argv に載せる形', OLD_ARGV_FORM, 'Bearer $(cat'],
    ['curl 8.3 以降を要る形', OLD_VARIABLE_FORM, '--expand-header'],
  ])('古い形のスニペット（%s）は、バックアップを取って今の形に差し替える', (_name, old, gone) => {
    // 目印だけ見て何もしないと、古いスニペットが入ったまま残る。
    const file = path.join(dir, `old-${_name}.sh`);
    fs.writeFileSync(file, `#!/bin/bash\n${old}echo hi\n`, { mode: 0o755 });
    const r = appendStatuslineSnippet(file, 4177);
    expect(r.changed).toBe(true);
    expect(r.backup).not.toBeNull();
    const after = fs.readFileSync(file, 'utf8');
    expect(after).not.toContain(gone);
    expect(after).toContain('-H @"$__hangar_header"');
    expect(after).toBe(`#!/bin/bash\n${statuslineSnippet(4177)}echo hi\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    // 二度目は変えない。
    expect(appendStatuslineSnippet(file, 4177)).toEqual({ changed: false, backup: null });
  });

  it('目印はあるが範囲を読み取れないときは触らない', () => {
    const file = path.join(dir, 'broken.sh');
    const body = `#!/bin/bash\n${STATUSLINE_MARKER}\necho 手で書き換えた\n`;
    fs.writeFileSync(file, body);
    expect(appendStatuslineSnippet(file, 4177)).toEqual({ changed: false, backup: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it('実行権限を保つ', () => {
    const file = path.join(dir, 'u.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho hi\n', { mode: 0o755 });
    appendStatuslineSnippet(file, 4177);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  });
});
