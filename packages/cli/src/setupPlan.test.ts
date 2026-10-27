import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHELL_MARKER, STATUSLINE_MARKER } from '@agent-hangar/server';
import { formatSetupPlan, planSetup, runSetupCommand, runSetupWrite, SECRET_MASK, SETUP_TARGETS, type SetupEnv } from './setupPlan.ts';
import { posixDescribe } from '../../server/test/platform.ts';

let dir: string;
let env: SetupEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-setup-plan-'));
  const tmux = path.join(dir, 'tmux');
  fs.writeFileSync(tmux, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, '.claude'));
  env = {
    home: path.join(dir, '.agent-hangar'),
    claudeDir: path.join(dir, '.claude'),
    claudeJson: path.join(dir, '.claude.json'),
    zshrc: path.join(dir, '.zshrc'),
    port: 4177,
    tmuxPath: tmux,
    loginShell: '/bin/zsh',
    platform: 'darwin',
    homeDir: dir,
    exec: () => ({ status: 0, stdout: '2.1.0', stderr: '' }),
    probe: async () => ({ ok: true } as const),
    now: () => new Date(2026, 9, 12, 10, 31, 5),
  };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const token = () => fs.readFileSync(path.join(env.home, 'token'), 'utf8').trim();

describe('planSetup（書かずに、書く先と差分を返す）', () => {
  it('対象は 6 つ', () => {
    expect(SETUP_TARGETS).toEqual(['mcp-install', 'mcp-uninstall', 'shell-install', 'shell-uninstall', 'statusline-install', 'statusline-uninstall']);
  });

  it('MCP の登録：ほかのサーバは中身を畳み、hangar の行を足し、トークンは伏せる', () => {
    fs.writeFileSync(env.claudeJson, JSON.stringify({ userID: 'u1', projects: { a: 1 }, mcpServers: { github: { type: 'http', headers: { Authorization: 'Bearer secret-gh' } } } }), { mode: 0o600 });
    const before = fs.readFileSync(env.claudeJson, 'utf8');
    const p = planSetup('mcp-install', env);
    expect(p.state).toBe('ready');
    expect(p.files).toHaveLength(1);
    const f = p.files[0]!;
    expect(f).toMatchObject({ path: env.claudeJson, op: 'modify', what: 'mcp.add', where: 'json' });
    const text = f.lines.map((l) => `${l.k}:${l.t}`).join('\n');
    expect(text).toContain('ctx:  "github": { … },');
    expect(text).toContain('add:  "hangar": {');
    expect(text).toContain(`add:      "Authorization": "Bearer ${SECRET_MASK}"`);
    // ほかのサーバの秘密も、hangar のトークンも、差分に出さない。
    expect(JSON.stringify(p)).not.toContain('secret-gh');
    expect(JSON.stringify(p)).not.toContain(token());
    expect(p.secret).toBe(true);
    // バックアップの名前の日時は書いたときに決まるので、見立てでは日時の形だけを見せる。
    expect(p.backup).toBe(path.join(env.home, 'backups', 'claude.json-YYYYMMDDhhmmss'));
    // 何も書かない。
    expect(fs.readFileSync(env.claudeJson, 'utf8')).toBe(before);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('MCP：無いファイルは新規、同じ登録は済み、解除は消す行、載っていなければ済み', () => {
    expect(planSetup('mcp-install', env).files[0]).toMatchObject({ op: 'create', what: 'mcp.add' });
    expect(planSetup('mcp-install', env).backup).toBeNull();
    expect(planSetup('mcp-uninstall', env)).toMatchObject({ state: 'noop', reason: { code: 'absent' } });
    const server = { type: 'http', url: 'http://127.0.0.1:4177/mcp', headers: { Authorization: `Bearer ${planSetup('mcp-install', env) && token()}` } };
    fs.writeFileSync(env.claudeJson, JSON.stringify({ mcpServers: { hangar: server } }));
    expect(planSetup('mcp-install', env)).toMatchObject({ state: 'noop', reason: { code: 'already' } });
    const u = planSetup('mcp-uninstall', env);
    expect(u.state).toBe('ready');
    expect(u.files[0]).toMatchObject({ op: 'remove', what: 'mcp.remove' });
    expect(u.files[0]!.lines.filter((l) => l.k === 'del').map((l) => l.t)).toContain('  "hangar": {');
    expect(JSON.stringify(u)).not.toContain(token());
  });

  it('MCP の解除：見せる差分の後の形（消す行を除いた行）が、書いた mcpServers と同じ形になる', async () => {
    const server = { type: 'http', url: 'http://127.0.0.1:4177/mcp' };
    const after = (lines: { k: string; t: string }[]) => lines.filter((l) => l.k !== 'del').map((l) => l.t);
    // hangar だけのときは、空の mcpServers が残る（Claude Code の claude mcp remove -s user と同じ形）。
    fs.writeFileSync(env.claudeJson, JSON.stringify({ userID: 'u1', mcpServers: { hangar: server } }), { mode: 0o600 });
    const only = planSetup('mcp-uninstall', env);
    expect(after(only.files[0]!.lines)).toEqual(['"mcpServers": {', '}']);
    expect(await runSetupWrite('mcp-uninstall', env, only.fingerprint)).toMatchObject({ ok: true, result: { changed: true } });
    expect(JSON.parse(fs.readFileSync(env.claudeJson, 'utf8'))).toEqual({ userID: 'u1', mcpServers: {} });
    // ほかのサーバが残るときは、最後に残るサーバの行の , も外れる。
    fs.writeFileSync(env.claudeJson, JSON.stringify({ mcpServers: { a: { type: 'stdio' }, b: { type: 'stdio' }, hangar: server } }), { mode: 0o600 });
    const rest = planSetup('mcp-uninstall', env);
    expect(after(rest.files[0]!.lines)).toEqual(['"mcpServers": {', '  "a": { … },', '  "b": { … }', '}']);
    expect(rest.files[0]!.lines.filter((l) => l.k === 'del').map((l) => l.t)).toContain('  "b": { … },');
    expect(await runSetupWrite('mcp-uninstall', env, rest.fingerprint)).toMatchObject({ ok: true, result: { changed: true } });
    expect(Object.keys(JSON.parse(fs.readFileSync(env.claudeJson, 'utf8')).mcpServers)).toEqual(['a', 'b']);
  });

  it('MCP：壊れた JSON と claude の無い PC は blocked', () => {
    fs.writeFileSync(env.claudeJson, '{ x');
    expect(planSetup('mcp-install', env)).toMatchObject({ state: 'blocked', reason: { code: 'broken-json' } });
    fs.rmSync(env.claudeJson);
    expect(planSetup('mcp-install', { ...env, exec: () => ({ status: 1, stdout: '', stderr: '', notFound: true }) })).toMatchObject({ state: 'blocked', reason: { code: 'no-claude' } });
  });

  it('シェル連携：~/.zshrc の末尾に 1 行、hangar の置き場、Windows と zsh 以外と tmux の無い PC は blocked', () => {
    fs.writeFileSync(env.zshrc, 'export A=1\nexport B=2\n');
    const p = planSetup('shell-install', env);
    expect(p.state).toBe('ready');
    expect(p.files.map((f) => [f.op, f.what])).toEqual([['modify', 'shell.add'], ['own', 'shell.script']]);
    expect(p.files[0]!.lines).toEqual([{ k: 'ctx', t: 'export B=2' }, { k: 'add', t: expect.stringContaining(SHELL_MARKER) }]);
    expect(p.files[0]!.where).toBe('tail');
    expect(p.backup).toBe(`${env.zshrc}.bak-YYYYMMDDhhmmss`);
    expect(p.secret).toBe(false);
    expect(fs.readFileSync(env.zshrc, 'utf8')).toBe('export A=1\nexport B=2\n');
    expect(planSetup('shell-install', { ...env, platform: 'win32' }).reason?.code).toBe('windows');
    expect(planSetup('shell-install', { ...env, loginShell: '/bin/bash' }).reason?.code).toBe('not-zsh');
    expect(planSetup('shell-install', { ...env, tmuxPath: null }).reason?.code).toBe('no-tmux');
    expect(planSetup('shell-uninstall', env)).toMatchObject({ state: 'noop', reason: { code: 'absent' } });
  });

  it('ステータスライン：スクリプトの先頭に足す行、置き場、外す行、スクリプトが無ければ blocked', () => {
    expect(planSetup('statusline-install', env)).toMatchObject({ state: 'blocked', reason: { code: 'no-script' } });
    const script = path.join(env.claudeDir, 'sl.sh');
    fs.writeFileSync(script, '#!/bin/bash\ninput=$(cat)\necho x\n', { mode: 0o755 });
    fs.writeFileSync(path.join(env.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: script } }));
    const p = planSetup('statusline-install', env);
    expect(p.state).toBe('ready');
    expect(p.files.map((f) => [f.op, f.what, f.where])).toEqual([['modify', 'statusline.add', 'head'], ['own', 'statusline.header', null]]);
    expect(p.files[0]!.n).toBe(11);
    expect(p.files[0]!.lines[0]).toEqual({ k: 'ctx', t: '#!/bin/bash' });
    expect(p.files[0]!.lines[1]).toEqual({ k: 'add', t: STATUSLINE_MARKER });
    expect(p.backup).toBe(`${script}.bak-YYYYMMDDhhmmss`);
    expect(planSetup('statusline-uninstall', env)).toMatchObject({ state: 'noop' });
  });

  it('UTF-8 でないスクリプトと ~/.zshrc は、入れるのも外すのも not-utf8 で断り、理由を読める', async () => {
    const utf16le = (t: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);
    const script = path.join(env.claudeDir, 'sl.ps1');
    const bytes = utf16le(`${STATUSLINE_MARKER}\r\n$j = 1\r\n`);
    fs.writeFileSync(script, bytes);
    fs.writeFileSync(path.join(env.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `powershell -File "${script}"` } }));
    for (const target of ['statusline-install', 'statusline-uninstall'] as const) {
      const p = planSetup(target, env);
      expect(p, target).toMatchObject({ state: 'blocked', reason: { code: 'not-utf8' } });
      expect(p.reason!.message).toContain('UTF-8');
      expect(formatSetupPlan(p)).toEqual([p.reason!.message]);
      expect(await runSetupWrite(target, env, null)).toMatchObject({ ok: false, code: 'not-utf8' });
    }
    expect(fs.readFileSync(script).equals(bytes)).toBe(true);
    const zbytes = utf16le(`export A=1\n${SHELL_MARKER}\n`);
    fs.writeFileSync(env.zshrc, zbytes);
    for (const target of ['shell-install', 'shell-uninstall'] as const) {
      expect(planSetup(target, env), target).toMatchObject({ state: 'blocked', reason: { code: 'not-utf8' } });
    }
    expect(fs.readFileSync(env.zshrc).equals(zbytes)).toBe(true);
  });

  it('指紋は、見せた中身が変わると変わる。hangar の置き場は数えない', () => {
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    const a = planSetup('shell-install', env).fingerprint;
    expect(planSetup('shell-install', env).fingerprint).toBe(a);
    fs.writeFileSync(env.zshrc, 'export A=2\n');
    expect(planSetup('shell-install', env).fingerprint).not.toBe(a);
    // ~/.claude.json は、Claude Code が他の鍵を頻繁に書き換える。見せた mcpServers が同じなら、指紋は変えない。
    fs.writeFileSync(env.claudeJson, JSON.stringify({ numStartups: 1, mcpServers: { a: { type: 'stdio' } } }));
    const m = planSetup('mcp-install', env).fingerprint;
    fs.writeFileSync(env.claudeJson, JSON.stringify({ numStartups: 2, mcpServers: { a: { type: 'stdio' } } }));
    expect(planSetup('mcp-install', env).fingerprint).toBe(m);
    fs.writeFileSync(env.claudeJson, JSON.stringify({ numStartups: 2, mcpServers: { a: { type: 'stdio' }, b: { type: 'stdio' } } }));
    expect(planSetup('mcp-install', env).fingerprint).not.toBe(m);
  });

  it('端末向けの見立ては、ファイルと +/- の行で、伏せた値は伏せたまま出す', () => {
    const lines = formatSetupPlan(planSetup('mcp-install', env));
    expect(lines.join('\n')).toContain(env.claudeJson);
    expect(lines.join('\n')).toContain('+   "hangar": {');
    expect(lines.join('\n')).toContain('Bearer ••••');
    expect(lines.join('\n')).not.toContain(token());
  });
});

describe('runSetupWrite（見せた中身から変わっていなければ書く）', () => {
  it('指紋が合えば書き、控えの場所を返す', async () => {
    fs.writeFileSync(env.claudeJson, JSON.stringify({ mcpServers: { a: { type: 'stdio' } } }), { mode: 0o600 });
    const p = planSetup('mcp-install', env);
    const r = await runSetupWrite('mcp-install', env, p.fingerprint);
    expect(r).toMatchObject({ ok: true, result: { changed: true } });
    if (!r.ok) throw new Error('unreachable');
    expect(r.result.backups).toEqual([path.join(env.home, 'backups', 'claude.json-20261012103105')]);
    expect(JSON.parse(fs.readFileSync(env.claudeJson, 'utf8')).mcpServers.hangar.url).toBe('http://127.0.0.1:4177/mcp');
  });

  it('見立てで見せたバックアップの名前の形と、書いたときの実際の名前が食い違わない', async () => {
    // 承認の窓を開いた時刻と、書き込みを押した時刻はずれる（0.4.0-rc.1 の Windows の実機で 12 秒と 25 秒）。
    const shownAt = (p: string | null) => new RegExp(`^${p!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('YYYYMMDDhhmmss', '\\d{14}')}$`);
    fs.writeFileSync(env.claudeJson, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    const script = path.join(env.claudeDir, 'sl.sh');
    fs.writeFileSync(script, '#!/bin/bash\necho x\n', { mode: 0o755 });
    fs.writeFileSync(path.join(env.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: script } }));
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    const later = { ...env, now: () => new Date(2026, 9, 12, 10, 31, 30) };
    // シェル連携とステータスラインの書き込みは、ほかの試験と同じく POSIX でだけ通す。
    const targets = process.platform === 'win32' ? (['mcp-install'] as const) : (['mcp-install', 'statusline-install', 'shell-install'] as const);
    for (const target of targets) {
      const p = planSetup(target, env);
      const r = await runSetupWrite(target, later, p.fingerprint);
      if (!r.ok) throw new Error(`${target}: ${r.message}`);
      expect(r.result.backups, target).toHaveLength(1);
      expect(r.result.backups[0], target).toMatch(shownAt(p.backup));
      expect(r.result.backups[0], target).toContain('20261012103130');
    }
  });

  it('見せた後に変わっていたら、何も書かずに changed で断る', async () => {
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    const p = planSetup('shell-install', env);
    fs.writeFileSync(env.zshrc, 'export A=1\nexport C=3\n');
    const r = await runSetupWrite('shell-install', env, p.fingerprint);
    expect(r).toMatchObject({ ok: false, code: 'changed' });
    expect(fs.readFileSync(env.zshrc, 'utf8')).toBe('export A=1\nexport C=3\n');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('ロックの中で読んだ mcpServers が見せたときと違えば、書かない', async () => {
    fs.writeFileSync(env.claudeJson, JSON.stringify({ mcpServers: { a: { type: 'stdio' } } }), { mode: 0o600 });
    const p = planSetup('mcp-uninstall', env);
    expect(p.state).toBe('noop');
    const q = planSetup('mcp-install', env);
    // 確かめの後、ロックを取る前に割り込みで書かれた、という形を、check の比べる値で作る。
    const r = await runSetupWrite('mcp-install', { ...env, beforeLock: () => fs.writeFileSync(env.claudeJson, JSON.stringify({ mcpServers: { a: { type: 'stdio' }, z: { type: 'stdio' } } })) }, q.fingerprint);
    expect(r).toMatchObject({ ok: false, code: 'changed' });
    expect(JSON.parse(fs.readFileSync(env.claudeJson, 'utf8')).mcpServers.hangar).toBeUndefined();
  });

  it('blocked と済みは書かずに返す', async () => {
    expect(await runSetupWrite('statusline-install', env, null)).toMatchObject({ ok: false, code: 'no-script' });
    expect(await runSetupWrite('mcp-uninstall', env, null)).toMatchObject({ ok: true, result: { changed: false } });
  });
});

posixDescribe('runSetupWrite（シェル連携とステータスライン）', () => {
  it('シェル連携を入れて外し、ステータスラインを入れて外す', async () => {
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    expect(await runSetupWrite('shell-install', env, planSetup('shell-install', env).fingerprint)).toMatchObject({ ok: true, result: { changed: true } });
    expect(fs.readFileSync(env.zshrc, 'utf8')).toContain(SHELL_MARKER);
    expect(fs.existsSync(path.join(env.home, 'shell', 'claude.zsh'))).toBe(true);
    expect(await runSetupWrite('shell-uninstall', env, planSetup('shell-uninstall', env).fingerprint)).toMatchObject({ ok: true, result: { changed: true } });
    expect(fs.readFileSync(env.zshrc, 'utf8')).toBe('export A=1\n');

    const script = path.join(env.claudeDir, 'sl.sh');
    fs.writeFileSync(script, '#!/bin/bash\necho x\n', { mode: 0o755 });
    fs.writeFileSync(path.join(env.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: script } }));
    expect(await runSetupWrite('statusline-install', env, planSetup('statusline-install', env).fingerprint)).toMatchObject({ ok: true, result: { changed: true, backups: [`${script}.bak-20261012103105`] } });
    expect(fs.readFileSync(script, 'utf8')).toContain(STATUSLINE_MARKER);
    expect(fs.existsSync(path.join(env.home, 'statusline-header'))).toBe(true);
    expect(await runSetupWrite('statusline-uninstall', { ...env, now: () => new Date(2026, 9, 12, 10, 36, 12) }, planSetup('statusline-uninstall', env).fingerprint)).toMatchObject({ ok: true, result: { changed: true } });
    expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/bash\necho x\n');
  });
});

describe('runSetupCommand（CLI の旗）', () => {
  it('--dry-run --json は見立てを 1 行の JSON で出し、何も書かない', async () => {
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    const out: string[] = [];
    expect(await runSetupCommand('shell-install', env, { dryRun: true, json: true }, { log: (s) => out.push(s) })).toBe(0);
    expect(out).toHaveLength(1);
    const j = JSON.parse(out[0]!) as { ok: boolean; plan: { state: string; fingerprint: string } };
    expect(j.ok).toBe(true);
    expect(j.plan.state).toBe('ready');
    expect(fs.readFileSync(env.zshrc, 'utf8')).toBe('export A=1\n');
  });

  it('--json の書き込みは --yes が無ければ断り、--expect が合えば書く', async () => {
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    const out: string[] = [];
    expect(await runSetupCommand('shell-install', env, { json: true }, { log: (s) => out.push(s) })).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, code: 'confirm-required' });
    const fp = planSetup('shell-install', env).fingerprint;
    out.length = 0;
    expect(await runSetupCommand('shell-install', env, { json: true, yes: true, expect: 'f'.repeat(64) }, { log: (s) => out.push(s) })).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, code: 'changed' });
    out.length = 0;
    expect(await runSetupCommand('shell-install', env, { json: true, yes: true, expect: fp }, { log: (s) => out.push(s) })).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, result: { changed: true } });
  });

  it('旗が無ければ見立てを見せて聞き、断れば書かない', async () => {
    fs.writeFileSync(env.zshrc, 'export A=1\n');
    const out: string[] = [];
    expect(await runSetupCommand('shell-install', env, {}, { log: (s) => out.push(s), interactive: true, ask: async () => false })).toBe(1);
    expect(out.join('\n')).toContain(env.zshrc);
    expect(fs.readFileSync(env.zshrc, 'utf8')).toBe('export A=1\n');
  });
});
