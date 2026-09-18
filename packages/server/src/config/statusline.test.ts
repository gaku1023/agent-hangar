import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendStatuslineSnippet, resolveStatuslineScript, STATUSLINE_MARKER, statuslineSnippet, statuslineStatus } from './statusline.ts';

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

const settings = (command: unknown) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));

describe('statuslineSnippet', () => {
  it('目印の行で始まり、ポートを埋める', () => {
    const s = statuslineSnippet(4177);
    expect(s.split('\n')[0]).toBe(STATUSLINE_MARKER);
    expect(s).toContain('http://127.0.0.1:4177/api/ingest/statusline');
    expect(s).toContain('exec <<<"$__hangar_input"');
    expect(s.endsWith('\n')).toBe(true);
  });

  it('トークンは HANGAR_HOME があればそこから読む', () => {
    const s = statuslineSnippet(4177);
    expect(s).toContain('${HANGAR_HOME:-$HOME/.agent-hangar}');
    expect(s).toContain('"$__hangar_home/token"');
    expect(s).not.toContain('$HOME/.agent-hangar/token');
  });

  it('トークンを curl の引数に載せず、環境変数から渡す', () => {
    // -H "Authorization: Bearer $(cat ...)" はシェルが展開してから curl を起こすので、
    // curl の argv に 64 桁がそのまま載り、statusline が走るたびに ps から読める。
    const s = statuslineSnippet(4177);
    expect(s).not.toContain('Bearer $(cat');
    expect(s).not.toMatch(/-H ["']Authorization: Bearer \$/);
    expect(s).toContain('HANGAR_TOKEN="$__hangar_token"');
    expect(s).toContain("--variable '%HANGAR_TOKEN'");
    expect(s).toContain("--expand-header 'Authorization: Bearer {{HANGAR_TOKEN}}'");
  });
});

describe('statusline のスニペットを実際に走らせる', () => {
  const TOKEN = 'a1b2c3d4'.repeat(8);

  it('curl の argv にトークンが出ず、ps からも読めない。値は環境変数で届く', async () => {
    const hangarHome = path.join(home, '.agent-hangar');
    fs.mkdirSync(hangarHome, { recursive: true });
    fs.writeFileSync(path.join(hangarHome, 'token'), TOKEN, { mode: 0o600 });
    // PATH の先頭に偽の curl を置く。受け取った argv と環境変数を記録し、少し待ってから終わる。
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const argsFile = path.join(home, 'curl-args.bin');
    const envFile = path.join(home, 'curl-env.txt');
    fs.writeFileSync(
      path.join(bin, 'curl'),
      ['#!/bin/sh', `for a in "$@"; do printf '%s\\000' "$a" >> "${argsFile}"; done`, `printf '%s' "$HANGAR_TOKEN" > "${envFile}"`, 'cat > /dev/null', 'sleep 2', ''].join('\n'),
      { mode: 0o755 },
    );
    const script = path.join(home, 'sl.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash\n${statuslineSnippet(4177)}`, { mode: 0o755 });

    const child = spawn('bash', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HANGAR_HOME: hangarHome }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end('{"session_id":"x"}');
    await waitForFile(envFile);

    // 偽の curl が動いている間に ps を読む。
    const ps = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
    expect(ps).toContain('/api/ingest/statusline');
    expect(ps).not.toContain(TOKEN);
    expect(fs.readFileSync(argsFile, 'utf8')).not.toContain(TOKEN);
    // 環境変数では届いている。届かなければ認証が通らず、使用量が入らなくなる。
    expect(fs.readFileSync(envFile, 'utf8')).toBe(TOKEN);
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

  it('古い形のスニペットは、バックアップを取って今の形に差し替える', () => {
    // 目印だけ見て何もしないと、トークンを argv に載せる古いスニペットが入ったまま残る。
    const old = [
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
    const file = path.join(dir, 'old.sh');
    fs.writeFileSync(file, `#!/bin/bash\n${old}echo hi\n`, { mode: 0o755 });
    const r = appendStatuslineSnippet(file, 4177);
    expect(r.changed).toBe(true);
    expect(r.backup).not.toBeNull();
    const after = fs.readFileSync(file, 'utf8');
    expect(after).not.toContain('Bearer $(cat');
    expect(after).toContain('--expand-header');
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
