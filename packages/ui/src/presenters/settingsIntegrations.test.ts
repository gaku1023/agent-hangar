import { describe, expect, it } from 'vitest';
import type { ReadinessDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSettings } from './settings.ts';

// 連携の 3 枚の札の書き込み（試作の連携 A）。殻の中はボタン、ブラウザはコマンドを出す（D9）。
const SETTINGS: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
const READY: ReadinessDto = {
  tools: { tmux: { path: '/t', ok: true, problem: null, version: '3.4' }, claude: { path: '/c', ok: true, problem: null, version: '2.1.0' }, git: { path: '/usr/bin/git', ok: true, problem: null, version: '2.51.0' }, node: { path: '/n', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/w', exists: true, projectCount: 1 }, mcp: { registered: false, file: '/h/.claude.json' }, statusline: { command: 'bash /h/s.sh', scriptPath: '/h/s.sh', installed: false },
  commands: { mcp: '/A/hangar mcp install', statusline: '/A/hangar statusline install', shell: '/A/hangar shell install', join: '/A/hangar cloud join <URL>' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};
const store = (over: Partial<Store> = {}): Store => ({
  ...initialStore(), settings: SETTINGS, readiness: READY, desktop: true,
  statusline: { command: 'bash /h/s.sh', scriptPath: '/h/s.sh', installed: false },
  shellHook: { state: 'off', zshrc: '/h/.zshrc', line: 'x', command: '/A/hangar shell install', osSupported: true } as Store['shellHook'],
  ...over,
});
const present = (s: Store, running: ReturnType<typeof initialState>['setupRunning'] = null) => presentSettings({ ...initialState(), screen: { name: 'settings' }, setupRunning: running }, s).integrations;

describe('連携の札の書き込み', () => {
  it('入っていなければ入れるボタン（主）、書き込む先、入れるコマンドを出す', () => {
    const p = present(store());
    expect(p.desktop).toBe(true);
    expect(p.mcp).toEqual({ file: '/h/.claude.json', action: { target: 'mcp-install', label: '登録…', primary: true, disabled: false, running: false }, command: '/A/hangar mcp install' });
    expect(p.statusline.action).toMatchObject({ target: 'statusline-install', label: '設定…' });
    expect(p.shell).toMatchObject({ file: '/h/.zshrc', action: { target: 'shell-install', label: 'インストール…' }, command: '/A/hangar shell install' });
  });
  it('入っていれば解除のボタンと、解除のコマンドを出す', () => {
    const p = present(store({
      readiness: { ...READY, mcp: { registered: true, file: '/h/.claude.json' } },
      statusline: { command: 'x', scriptPath: '/h/s.sh', installed: true },
      shellHook: { state: 'on', zshrc: '/h/.zshrc', line: 'x', command: '/A/hangar shell install', osSupported: true } as Store['shellHook'],
    }));
    expect(p.mcp.action).toMatchObject({ target: 'mcp-uninstall', label: '登録を解除…', primary: false });
    expect(p.mcp.command).toBe('/A/hangar mcp uninstall');
    expect(p.statusline.action).toMatchObject({ target: 'statusline-uninstall', label: '設定を解除…' });
    expect(p.statusline.command).toBe('/A/hangar statusline uninstall');
    expect(p.shell.action).toMatchObject({ target: 'shell-uninstall', label: 'アンインストール…' });
  });
  it('スクリプトが無ければ押せず、tmux が無い PC と読み込み前はボタンを出さない', () => {
    const p = present(store({ statusline: { command: null, scriptPath: null, installed: false }, shellHook: { state: 'unsupported', zshrc: '/h/.zshrc', line: 'x', command: 'c', osSupported: true } as Store['shellHook'] }));
    expect(p.statusline.action).toMatchObject({ disabled: true });
    expect(p.shell.action).toBeNull();
    const before = present(store({ readiness: null, statusline: null, shellHook: null }));
    expect([before.mcp.action, before.statusline.action, before.shell.action]).toEqual([null, null, null]);
  });
  it('殻の返事を待つあいだは、押した札を「確認中…」にし、ほかの札も押せなくする', () => {
    const p = present(store(), 'mcp-install');
    expect(p.mcp.action).toMatchObject({ label: '確認中…', disabled: true, running: true });
    expect(p.statusline.action).toMatchObject({ label: '設定…', disabled: true, running: false });
  });
  it('ブラウザでは desktop が偽（画面はボタンの代わりにコマンドを出す）', () => {
    expect(present(store({ desktop: false })).desktop).toBe(false);
  });
});

describe('連携の末尾の「Claude Code に環境を見てもらう」の札', () => {
  const guide = { path: '~/.agent-hangar/setup-guide.md', version: '0.7.0', sha: '3f9a1c2e', prompt: 'サーバの一言' };
  const of = (s: Store) => presentSettings({ ...initialState(), screen: { name: 'settings' } }, s).setupGuide;

  it('一言は画面の言語で作り直し、版を添える。サーバの一言はそのまま使わない（言語を変えても取り直さずに替わる）', () => {
    expect(of(store({ setupGuide: guide }))).toEqual({ prompt: '~/.agent-hangar/setup-guide.md（v0.7.0 sha256:3f9a1c2e）を読んで、私の環境を診断して。書き換えは私が承認してから', version: '0.7.0' });
    const en = of(store({ setupGuide: guide, settings: { ...SETTINGS, language: 'en' } }));
    expect(en?.prompt).toMatch(/^Read ~\/\.agent-hangar\/setup-guide\.md \(v0\.7\.0 sha256:3f9a1c2e\)/);
  });

  it('写しが取れていなければ null', () => {
    expect(of(store())).toBeNull();
  });
});
