import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendStatuslineSnippet, ensureStatuslineHeaderFile, planStatuslineRemoval, planStatuslineSnippet, removeStatuslineSnippet, resolveStatuslineScript, STATUSLINE_MARKER, statuslineHeaderPath, statuslineSnippet, statuslineSnippetFor, statuslineStatus, writeStatuslineHeaderFile } from './statusline.ts';
import { expectMode, posixDescribe } from '../../../../test/platform.ts';

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
    expectMode(file, 0o600);
  });

  it('既にあるファイルは中身を入れ替え、他人に読める権限なら狭める', () => {
    const hangarHome = path.join(home, '.agent-hangar2');
    fs.mkdirSync(hangarHome, { recursive: true });
    const file = statuslineHeaderPath(hangarHome);
    fs.writeFileSync(file, 'Authorization: Bearer 古い\n', { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    writeStatuslineHeaderFile(hangarHome, TOKEN);
    expect(fs.readFileSync(file, 'utf8')).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expectMode(file, 0o600);
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
    expectMode(file, 0o600);
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
    expectMode(file, 0o600);
  });
});

// statusline の断片は bash。Windows 向けの差し込みは次の区切りで作る。
posixDescribe('statusline のスニペットを実際に走らせる', () => {
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

describe('command の読み方（引用符、空白、環境変数）', () => {
  it('引用符で包んだ空白入りのパスを読む。実行するものが引用符つきの絶対パスでも読む', () => {
    const sub = path.join(dir, 'a b');
    fs.mkdirSync(sub);
    const ps = path.join(sub, 'x.ps1');
    fs.writeFileSync(ps, '$j = [Console]::In.ReadToEnd()\n');
    settings(`powershell -NoProfile -File "${ps}"`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
    settings(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "${ps}"`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
    settings(`'/usr/local/bin/pwsh' -File '${ps}'`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
    settings(`"${ps}"`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
    const sh = path.join(sub, 's.sh');
    fs.writeFileSync(sh, '#!/bin/bash\necho x\n');
    settings(`bash "${sh}" --compact`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(sh);
    settings(`"C:\\Program Files\\Git\\bin\\bash.exe" "${sh}"`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(sh);
  });

  it('絶対パスで書いた bash の後ろの語を読む（bash そのものを指さない）', () => {
    const sh = path.join(dir, 'statusline-command.sh');
    fs.writeFileSync(sh, '#!/bin/bash\necho x\n');
    settings(`/bin/bash ${sh}`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(sh);
  });

  it('%NAME%、$NAME、${NAME}、~、$HOME を展開する。展開できない変数があれば読めない扱いにする', () => {
    const ps = path.join(dir, 'x.ps1');
    fs.writeFileSync(ps, '$j = 1\n');
    const env = { USERPROFILE: home, CLAUDE_DIR_T: dir };
    settings('powershell -File "%USERPROFILE%/.claude/x.ps1"');
    expect(resolveStatuslineScript(dir, home, env).scriptPath).toBe(ps);
    settings('pwsh -File $USERPROFILE/.claude/x.ps1');
    expect(resolveStatuslineScript(dir, home, env).scriptPath).toBe(ps);
    settings('pwsh -File "${CLAUDE_DIR_T}/x.ps1"');
    expect(resolveStatuslineScript(dir, home, env).scriptPath).toBe(ps);
    settings('$HOME/.claude/x.ps1');
    expect(resolveStatuslineScript(dir, home, {}).scriptPath).toBe(ps);
    settings('${HOME}/.claude/x.ps1');
    expect(resolveStatuslineScript(dir, home, {}).scriptPath).toBe(ps);
    settings('~/.claude/x.ps1');
    expect(resolveStatuslineScript(dir, home, {}).scriptPath).toBe(ps);
    settings('powershell -File "%NO_SUCH_VAR_T%/x.ps1"');
    expect(resolveStatuslineScript(dir, home, env)).toEqual({ command: 'powershell -File "%NO_SUCH_VAR_T%/x.ps1"', scriptPath: null });
    settings('pwsh -File $NO_SUCH_VAR_T/x.ps1');
    expect(resolveStatuslineScript(dir, home, env).scriptPath).toBeNull();
  });
});

describe('UTF-8 でないスクリプト', () => {
  const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

  it('UTF-16 のスクリプトには入れず、外すときも触らない', () => {
    const ps = path.join(dir, 'u.ps1');
    const bytes = utf16le('$j = [Console]::In.ReadToEnd()\r\n');
    fs.writeFileSync(ps, bytes);
    expect(appendStatuslineSnippet(ps, 4177)).toEqual({ changed: false, backup: null });
    expect(removeStatuslineSnippet(ps)).toEqual({ changed: false, backup: null });
    expect(fs.readFileSync(ps).equals(bytes)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('UTF-8 の BOM 付きは、BOM を先頭に保ったまま入れ、入れたものを読み、外すと元に戻る', () => {
    const bom = '\uFEFF';
    const ps = path.join(dir, 'b.ps1');
    const psSrc = `${bom}$j = [Console]::In.ReadToEnd()\r\nWrite-Output x\r\n`;
    fs.writeFileSync(ps, psSrc);
    expect(appendStatuslineSnippet(ps, 4177).changed).toBe(true);
    const psNext = fs.readFileSync(ps, 'utf8');
    expect(psNext.startsWith(`${bom}${STATUSLINE_MARKER}\r\n`)).toBe(true);
    expect(psNext.slice(1)).not.toContain(bom);
    expect(planStatuslineSnippet(psNext, ps, 4177)).toEqual({ kind: 'same' });
    expect(removeStatuslineSnippet(ps).changed).toBe(true);
    expect(fs.readFileSync(ps, 'utf8')).toBe(psSrc);

    const sh = path.join(dir, 'b.sh');
    const shSrc = `${bom}#!/bin/bash\necho x\n`;
    fs.writeFileSync(sh, shSrc);
    expect(appendStatuslineSnippet(sh, 4177).changed).toBe(true);
    const shNext = fs.readFileSync(sh, 'utf8');
    expect(shNext.startsWith(`${bom}#!/bin/bash\n${STATUSLINE_MARKER}\n`)).toBe(true);
    expect(planStatuslineSnippet(shNext, sh, 4177)).toEqual({ kind: 'same' });
    expect(removeStatuslineSnippet(sh).changed).toBe(true);
    expect(fs.readFileSync(sh, 'utf8')).toBe(shSrc);
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
    expectMode(file, 0o755);
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
    expectMode(file, 0o755);
  });
});

describe('planStatuslineSnippet と planStatuslineRemoval（書く中身だけを決め、書かない）', () => {
  it('追記、差し替え、同じ、読み取れない、を見分ける', () => {
    const sh = path.join(dir, 'p.sh');
    expect(planStatuslineSnippet('#!/bin/bash\necho hi\n', sh, 4177)).toEqual({ kind: 'add', next: `#!/bin/bash\n${statuslineSnippet(4177)}echo hi\n` });
    const cur = `#!/bin/bash\n${statuslineSnippet(4177)}echo hi\n`;
    expect(planStatuslineSnippet(cur, sh, 4177)).toEqual({ kind: 'same' });
    expect(planStatuslineSnippet(cur, sh, 4200)).toEqual({ kind: 'replace', next: `#!/bin/bash\n${statuslineSnippet(4200)}echo hi\n` });
    expect(planStatuslineSnippet(`#!/bin/bash\n${STATUSLINE_MARKER}\necho x\n`, sh, 4177)).toEqual({ kind: 'unreadable' });
  });

  it('外すのは目印から終わりの行までで、ほかの行は残す', () => {
    const cur = `#!/bin/bash\n${statuslineSnippet(4177)}echo hi\n`;
    expect(planStatuslineRemoval(cur)).toEqual({ kind: 'remove', next: '#!/bin/bash\necho hi\n' });
    expect(planStatuslineRemoval('#!/bin/bash\necho hi\n')).toEqual({ kind: 'absent' });
    expect(planStatuslineRemoval(`#!/bin/bash\n${STATUSLINE_MARKER}\necho x\n`)).toEqual({ kind: 'unreadable' });
  });
});

describe('removeStatuslineSnippet', () => {
  it('バックアップを取ってから外し、実行権限を保つ。入っていなければ触らない', () => {
    const file = path.join(dir, 'r.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho hi\n', { mode: 0o755 });
    appendStatuslineSnippet(file, 4177);
    const r = removeStatuslineSnippet(file, new Date(2026, 9, 12, 10, 36, 12));
    expect(r.changed).toBe(true);
    expect(r.backup).toBe(path.join(dir, 'r.sh.bak-20261012103612'));
    expect(fs.readFileSync(r.backup!, 'utf8')).toContain(STATUSLINE_MARKER);
    expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/bash\necho hi\n');
    expectMode(file, 0o755);
    expect(removeStatuslineSnippet(file)).toEqual({ changed: false, backup: null });
  });
});

describe('PowerShell のステータスライン（.ps1）', () => {
  it('pwsh や powershell の -File と、.ps1 を直に書いた command を解決する', () => {
    const ps = path.join(dir, 'statusline.ps1');
    fs.writeFileSync(ps, '$j = [Console]::In.ReadToEnd()\n');
    settings(`pwsh -NoProfile -File ${ps}`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
    settings(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps}"`);
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
    settings('~/.claude/statusline.ps1');
    expect(resolveStatuslineScript(dir, home).scriptPath).toBe(ps);
  });

  it('.ps1 には PowerShell の行を先頭に入れ、改行の形（CRLF）を保ち、外すと元に戻る', () => {
    const ps = path.join(dir, 's.ps1');
    const src = '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json\r\nWrite-Output $j.model.display_name\r\n';
    const snippet = statuslineSnippetFor(ps, 4177);
    expect(snippet.split('\n')[0]).toBe(STATUSLINE_MARKER);
    expect(snippet).toContain('[Console]::SetIn(');
    expect(snippet).not.toContain('curl');
    const plan = planStatuslineSnippet(src, ps, 4177);
    expect(plan.kind).toBe('add');
    const next = (plan as { next: string }).next;
    expect(next.startsWith(`${STATUSLINE_MARKER}\r\n`)).toBe(true);
    expect(next.endsWith(src)).toBe(true);
    expect(next.replace(/\r\n/g, '')).not.toContain('\n');
    expect(planStatuslineSnippet(next, ps, 4177)).toEqual({ kind: 'same' });
    expect(planStatuslineRemoval(next)).toEqual({ kind: 'remove', next: src });
  });

  it('param の塊で始まるものと、$input で読むものには自動では入れない', () => {
    const ps = path.join(dir, 'p.ps1');
    expect(planStatuslineSnippet('# 説明\n[CmdletBinding()]\nparam([string]$x)\n$j = [Console]::In.ReadToEnd()\n', ps, 4177)).toEqual({ kind: 'ps-param' });
    expect(planStatuslineSnippet('param($x)\n', ps, 4177)).toEqual({ kind: 'ps-param' });
    expect(planStatuslineSnippet('$j = $input | Out-String\n', ps, 4177)).toEqual({ kind: 'ps-input' });
  });
});

// 本物の PowerShell で走らせる。Windows の CI で確かめる（macOS と Linux の手元には PowerShell が無いことが多い）。
describe.skipIf(process.platform !== 'win32')('PowerShell のスニペットを実際に走らせる', () => {
  const TOKEN = 'f0e1d2c3'.repeat(8);
  function runPs(script: string, hangarHome: string, input: string): Promise<string> {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { env: { ...process.env, HANGAR_HOME: hangarHome }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stdin.end(input);
    return new Promise((r) => child.on('close', () => r(out)));
  }

  it('本文と Authorization が届き、元のスクリプトは同じ標準入力を [Console]::In で読める', async () => {
    const hangarHome = path.join(home, '.agent-hangar');
    fs.mkdirSync(hangarHome, { recursive: true });
    writeStatuslineHeaderFile(hangarHome, TOKEN);
    const got: { auth?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { got.push({ auth: req.headers.authorization, body: b }); res.writeHead(200).end('{}'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const script = path.join(home, 'real.ps1');
      fs.writeFileSync(script, '$j = [Console]::In.ReadToEnd()\r\n[Console]::Out.Write("got:" + $j)\r\n');
      const plan = planStatuslineSnippet(fs.readFileSync(script, 'utf8'), script, port);
      fs.writeFileSync(script, (plan as { next: string }).next);
      const out = await runPs(script, hangarHome, '{"session_id":"x"}');
      expect(out).toBe('got:{"session_id":"x"}');
      expect(got).toHaveLength(1);
      expect(got[0]!.auth).toBe(`Bearer ${TOKEN}`);
      expect(got[0]!.body).toBe('{"session_id":"x"}');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 30_000);

  it('ヘッダのファイルが無くても、表示は壊さない', async () => {
    const hangarHome = path.join(home, '.agent-hangar-empty');
    fs.mkdirSync(hangarHome, { recursive: true });
    const script = path.join(home, 'quiet.ps1');
    fs.writeFileSync(script, `${statuslineSnippetFor(script, 9)}$j = [Console]::In.ReadToEnd()\r\n[Console]::Out.Write("got:" + $j)\r\n`.replace(/\r?\n/g, '\r\n'));
    expect(await runPs(script, hangarHome, '{"session_id":"y"}')).toBe('got:{"session_id":"y"}');
  }, 30_000);
});
