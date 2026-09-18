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

  it('実行権限を保つ', () => {
    const file = path.join(dir, 'u.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho hi\n', { mode: 0o755 });
    appendStatuslineSnippet(file, 4177);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  });
});
