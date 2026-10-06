import { describe, expect, it } from 'vitest';
import type { ReadinessDto } from '@agent-hangar/shared';
import { clientPlatform, muxInstallCommand, presentChecks, toolLine, workspaceLine } from './readiness.ts';

const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
};

describe('欄の下の検証（設定の B1）', () => {
  it('動かせるときは、見つかったパスと版', () => {
    expect(toolLine('tmux', READY.tools.tmux)).toEqual({ ok: true, soft: false, text: '/opt/homebrew/bin/tmux', note: '3.4', fix: null, fixCommand: null });
  });
  it('動かせないときは、理由と直し方。tmux は入れるコマンドを添える', () => {
    expect(toolLine('tmux', { path: null, ok: false, problem: 'unset', version: null })).toEqual({ ok: false, soft: false, text: '見つかりません', note: null, fix: null, fixCommand: 'brew install tmux' });
    expect(toolLine('claude', { path: '/x/claude', ok: false, problem: 'notExecutable', version: null })).toMatchObject({ ok: false, text: '/x/claude には実行権がありません', fix: 'claude コマンドの絶対パスを入れてください' });
    expect(toolLine('claude', { path: '/x', ok: false, problem: 'notFile', version: null })).toMatchObject({ text: '/x はファイルではありません' });
    expect(toolLine('claude', { path: '/x/claude', ok: false, problem: 'missing', version: null })).toMatchObject({ text: '/x/claude が見つかりません' });
  });
  it('code は無くても動くので、弱い印にして一言添える', () => {
    expect(toolLine('code', READY.tools.code)).toEqual({ ok: false, soft: true, text: '見つかりません', note: '無くても動きます', fix: 'VS Code から code コマンドを入れてください', fixCommand: null });
  });
  it('Node の設定が空なら、自動で見つけた Node だと添える', () => {
    expect(toolLine('node', READY.tools.node)).toEqual({ ok: true, soft: false, text: '/opt/homebrew/bin/node', note: 'v22.9.0、自動で見つけました', fix: null, fixCommand: null });
  });
  it('ワークスペースは、登録したプロジェクトの数を出し、0 件なら理由を言う', () => {
    expect(workspaceLine({ ...READY.workspace, projectCount: 12 })).toEqual({ ok: true, soft: false, text: '/Users/me/workspace', note: 'プロジェクト 12 件', fix: null, fixCommand: null });
    expect(workspaceLine(READY.workspace)).toMatchObject({ ok: false, text: '直下に、Claude のセッションがあるディレクトリがありません' });
    expect(workspaceLine({ ...READY.workspace, exists: false })).toMatchObject({ ok: false, text: '/Users/me/workspace が見つかりません' });
  });
});

describe('始める前の確認（初回の A1）', () => {
  it('5 つを並べ、揃った数を数える', () => {
    const c = presentChecks(READY);
    expect(c.items.map((i) => [i.key, i.ok])).toEqual([['tmux', true], ['claude', true], ['workspace', false], ['mcp', false], ['statusline', false]]);
    expect(c.progress).toBe('5 つ中 2 つ');
    expect(c.items[0]).toMatchObject({ label: 'tmux', detail: 'ターミナルを動かすのに使います', path: '/opt/homebrew/bin/tmux（3.4）' });
  });
  it('✗ の行は直し方を持つ。ワークスペースは設定へ、MCP と statusline はコマンドを出す', () => {
    const c = presentChecks(READY);
    const by = Object.fromEntries(c.items.map((i) => [i.key, i]));
    expect(by.workspace).toMatchObject({ soft: false, detail: '/Users/me/workspace の直下に、Claude のセッションがあるディレクトリがありません', action: 'settings' });
    expect(by.mcp).toMatchObject({ soft: true, command: 'hangar mcp install' });
    expect(by.statusline).toMatchObject({ soft: true, command: 'hangar statusline install' });
  });
  it('statusline のスクリプトが無ければ、先に作るよう言う', () => {
    const c = presentChecks({ ...READY, statusline: { command: null, scriptPath: null, installed: false } });
    expect(c.items.find((i) => i.key === 'statusline')!.detail).toBe('Claude Code の /statusline でスクリプトを作ってから、次を実行してください');
  });
  it('tmux が無ければ、入れるコマンドと設定への道を出す', () => {
    const c = presentChecks({ ...READY, tools: { ...READY.tools, tmux: { path: null, ok: false, problem: 'unset', version: null } } });
    expect(c.items[0]).toMatchObject({ ok: false, soft: false, command: 'brew install tmux', action: 'settings' });
    expect(c.progress).toBe('5 つ中 1 つ');
  });
});

describe('tmux の役を担う道具の入れ方', () => {
  it('その PC の OS に合わせて案内する', () => {
    expect(muxInstallCommand('darwin')).toBe('brew install tmux');
    expect(muxInstallCommand('linux')).toBe('brew install tmux');
    expect(muxInstallCommand('win32')).toBe('winget install marlocarlo.psmux');
  });
  // hangar の画面は、サーバと同じ PC のブラウザか WebView で開く。ブラウザの名乗りから OS を読む。
  it('ブラウザの名乗りから Windows を見分ける', () => {
    expect(clientPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('win32');
    expect(clientPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('darwin');
    expect(clientPlatform(undefined)).toBe('darwin');
  });
  it('Windows では、tmux が無いときに psmux の入れ方を出す', () => {
    const missing = { path: null, ok: false, problem: 'unset' as const, version: null };
    expect(toolLine('tmux', missing, 'win32').fixCommand).toBe('winget install marlocarlo.psmux');
    expect(toolLine('tmux', missing, 'darwin').fixCommand).toBe('brew install tmux');
  });
});
