import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import type { CloudSettingsProps, SettingsProps } from '../presenters/settings.ts';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Header } from './Header.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { ToastStack } from './ToastStack.tsx';

describe('SessionsScreen', () => {
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    fireEvent.change(screen.getByLabelText('実行中'), { target: { value: 'running' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { running: true } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y' });
  });
  it('日本語入力の確定の Enter では検索しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: '動画' } });
    fireEvent.keyDown(kw, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(kw, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画' });
    const file = screen.getByLabelText('ファイル');
    fireEvent.change(file, { target: { value: 'a.md' } });
    onIntent.mockClear();
    fireEvent.keyDown(file, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('期間は since を now から N 日前にする', () => {
    const onIntent = vi.fn();
    const before = Date.now();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('期間'), { target: { value: '7' } });
    const call = onIntent.mock.calls.find((c) => c[0].type === 'search.filter')?.[0];
    expect(call).toBeDefined();
    const since = call.patch.since as number;
    expect(since).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    expect(call.patch.until).toBeUndefined();
  });
  it('検索中と件数の表示', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" /></IntentRoot>);
    expect(screen.getByText('検索しています')).toBeInTheDocument();
  });
  it('検索で何も当たらなければ「一致するセッションはありません」', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="search" /></IntentRoot>);
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
    expect(screen.queryByText('セッションはまだありません')).toBeNull();
  });
  it('全件表示で空なら「セッションはまだありません」のまま', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
  it('検索中は空の文言を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" /></IntentRoot>);
    expect(screen.queryByText('一致するセッションはありません')).toBeNull();
  });
});

const settingsProps = (over: Partial<SettingsProps> = {}): SettingsProps => ({
  workspaceRoot: '/w', claudeDir: '/c', device: { id: 'd', name: 'mac' }, version: '0.3.0', index: { phase: 'idle', done: 0, total: 0 }, sessionCount: 3, projectCount: 2,
  tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null, mcpInstallCommand: 'npm run hangar -- mcp install',
  lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false,
  summarizerModels: ['gemma', 'qwen'], summarizerTest: null,
  statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: false },
  statuslineCommand: 'npm run hangar -- statusline install',
  usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 1200, outputTokens: 340, sessions: 2 }], projects: [{ projectId: 'p1', name: 'alpha', inputTokens: 1200, outputTokens: 340, costUsd: 1.5, sessions: 2 }] },
  cloud: { configured: false, url: null, state: 'off', paused: false, lastPullAt: '不明', pending: 0, devices: [], joinToken: null, syncClaudeConfig: false, configConfirmed: false },
  ...over,
});

const cloudProps = (over: Partial<CloudSettingsProps> = {}): CloudSettingsProps => ({
  configured: true, url: 'https://h.workers.dev', state: 'idle', paused: false, lastPullAt: '1 分前', pending: 2,
  devices: [{ name: 'mac', platform: 'darwin', lastSeen: '今', self: true }, { name: 'mini', platform: 'darwin', lastSeen: '3 分前', self: false }],
  joinToken: null, syncClaudeConfig: false, configConfirmed: false,
  ...over,
});

describe('SettingsScreen', () => {
  it('保存と作り直し', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ version: '0.1.0', index: { phase: 'idle', done: 3, total: 3 }, projectCount: 1 })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('ワークスペースのルート'), { target: { value: '/w2' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { workspaceRoot: '/w2' } });
    fireEvent.click(screen.getByText('索引を作り直す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'index.rebuild' });
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByText(/再起動後に反映されます/)).toBeInTheDocument();
  });
  it('ツールのパスとターミナルアプリを保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ version: '0.2.0', index: { phase: 'idle', done: 3, total: 3 }, projectCount: 1 })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('ターミナルアプリ'), { target: { value: 'iterm' } });
    fireEvent.change(screen.getByLabelText('code のパス'), { target: { value: '/usr/local/bin/code' } });
    fireEvent.click(screen.getByText('ツールの設定を保存'));
    // 変えた項目だけを送る。terminalApp を毎回入れると iTerm2 の案内が保存のたびに出る。
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { terminalApp: 'iterm', codePath: '/usr/local/bin/code' } });
    expect(screen.getByText('npm run hangar -- mcp install')).toBeInTheDocument();
  });
  it('サーバが正規化した値に入力欄が追従する', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ tmuxPath: 'tmux', device: null, version: '0.2.0', sessionCount: 0, projectCount: 0 })} /></IntentRoot>);
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('tmux');
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ workspaceRoot: '/w2', terminalApp: 'iterm', codePath: '/usr/local/bin/code', device: null, version: '0.2.0', sessionCount: 0, projectCount: 0 })} /></IntentRoot>);
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('/opt/homebrew/bin/tmux');
    expect(screen.getByLabelText('ワークスペースのルート')).toHaveValue('/w2');
    expect(screen.getByLabelText('ターミナルアプリ')).toHaveValue('iterm');
    expect(screen.getByLabelText('code のパス')).toHaveValue('/usr/local/bin/code');
  });
  it('何も変えていなければツールの保存は押せない', () => {
    // 空の patch はサーバが 400 にするので、押せないようにする。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ terminalApp: 'iterm', device: null, version: '0.2.0' })} /></IntentRoot>);
    const save = screen.getByText('ツールの設定を保存');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('code のパス'), { target: { value: '/usr/local/bin/code' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { codePath: '/usr/local/bin/code' } });
  });
});

describe('SettingsScreen のフェーズ 3', () => {
  it('statusline の状態と追記のコマンドを出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('まだ追記されていません')).toBeTruthy();
    expect(screen.getByText('npm run hangar -- statusline install')).toBeTruthy();
    expect(screen.getByText('/h/.claude/statusline.sh')).toBeTruthy();
  });
  it('statusline の案内にポートの指定を添える', () => {
    // 4177 以外で動いているサーバに、4177 宛てのスニペットを追記させない。
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('サーバが 4177 以外で動いているときは --port <番号> を付けてください。')).toBeTruthy();
  });
  it('追記済みならそう出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ statusline: { command: 'bash x', scriptPath: '/h/x', installed: true } })} /></IntentRoot>);
    expect(screen.getByText('追記済みです')).toBeTruthy();
  });
  it('statusline の設定が無いときは案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ statusline: { command: null, scriptPath: null, installed: false } })} /></IntentRoot>);
    expect(screen.getByText('statusLine の設定が見つかりません')).toBeTruthy();
  });
  it('statusline がまだ届いていなければ読み込み中を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ statusline: null, summarizerModels: [] })} /></IntentRoot>);
    expect(screen.getByText('読み込んでいます')).toBeTruthy();
  });
  it('要約器の URL とモデルとフォールバックを保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'http://127.0.0.1:2345' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false } });
    fireEvent.change(screen.getByLabelText('モデル'), { target: { value: 'qwen' } });
    fireEvent.click(screen.getByLabelText('Claude へ切り替える'));
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: 'qwen', summaryFallback: false, summaryHourlyCap: 5, allowExternalSummarizer: false } });
  });
  it('外部の要約器を許すときは、本文が送られることを書く', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    // 既定では許していないので、警告は出さない。
    expect(screen.queryByText(/会話の本文/)).toBeNull();
    fireEvent.click(screen.getByLabelText('外部の要約器を許す'));
    expect(screen.getByText(/会話の本文/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'https://summarizer.example.com' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'https://summarizer.example.com', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: true } });
    // サーバから届いた値が入りのときは、最初から警告を出す。
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ allowExternalSummarizer: true, lmStudioUrl: 'https://summarizer.example.com' })} /></IntentRoot>);
    expect((screen.getByLabelText('外部の要約器を許す') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/会話の本文/)).toBeTruthy();
  });
  it('1 時間の上限は 1 以上 200 以下の整数の入力欄である', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const cap = screen.getByLabelText('1 時間の上限') as HTMLInputElement;
    expect(cap.type).toBe('number');
    expect(cap.min).toBe('1');
    expect(cap.max).toBe('200');
    expect(cap.step).toBe('1');
  });
  it('1 時間の上限が整数でなければ保存せず案内を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const cap = screen.getByLabelText('1 時間の上限');
    // 空は 0 に、文字は NaN になってしまうので、送る前に弾く。
    for (const bad of ['', '0', '-3', '1.5', '201']) {
      fireEvent.change(cap, { target: { value: bad } });
      fireEvent.click(screen.getByText('要約器の設定を保存'));
      expect(onIntent).not.toHaveBeenCalled();
      expect(screen.getByText('1 から 200 までの整数を入れてください')).toBeTruthy();
    }
    fireEvent.change(cap, { target: { value: '12' } });
    expect(screen.queryByText('1 から 200 までの整数を入れてください')).toBeNull();
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 12, allowExternalSummarizer: false } });
  });
  it('モデルの一覧の状態を出し分ける', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ summarizerModels: null })} /></IntentRoot>);
    expect(screen.getByText('読み込んでいます')).toBeTruthy();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ summarizerModels: [] })} /></IntentRoot>);
    expect(screen.getByText('LM Studio に繋がりません')).toBeTruthy();
  });
  it('要約器を試すと summarizer.test を出し、結果を出す', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByText('要約器を試す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summarizer.test' });
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerTest: { ok: true, id: 'lmstudio', ms: 820, summary: { title: '題', oneLiner: '1 文', body: '本文', state: 'done', nextSteps: [], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: 'gemma', basedOnTurns: 3 } } })} /></IntentRoot>);
    expect(screen.getByText('lmstudio で成功しました（820 ミリ秒）')).toBeTruthy();
    expect(screen.getByText('1 文')).toBeTruthy();
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerTest: { ok: false, tried: [{ id: 'lmstudio', message: 'ECONNREFUSED' }, { id: 'claude-headless', message: '上限に達しています' }] } })} /></IntentRoot>);
    expect(screen.getByText('lmstudio: ECONNREFUSED')).toBeTruthy();
    expect(screen.getByText('claude-headless: 上限に達しています')).toBeTruthy();
  });
  it('使用量の 2 つの表を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('2026-09-18')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
  });
  it('トークンは期間のとおりでコストは走り全体の累計だと添える', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('トークン数は期間のとおりですが、推定コストはそのセッションの走り全体の累計です。')).toBeTruthy();
  });
  it('集計がまだ無ければ読み込み中を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ usageAggregate: null })} /></IntentRoot>);
    expect(screen.getByText('使用量を読み込んでいます')).toBeTruthy();
  });
});

describe('SettingsScreen のクラウド同期', () => {
  it('Settings のクラウド同期の節', () => {
    const onIntent = vi.fn();
    const cloud = cloudProps();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud })} /></IntentRoot>);
    expect(screen.getByText('https://h.workers.dev')).toBeInTheDocument();
    expect(screen.getByText('未送信 2 件')).toBeInTheDocument();
    expect(screen.getByText('mini')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークンを表示' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.joinToken.show' });
    fireEvent.click(screen.getByLabelText('Claude Code の設定を同期する'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { syncClaudeConfig: true } });
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud: cloudProps({ joinToken: 'tok-abc', syncClaudeConfig: true }) })} /></IntentRoot>);
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.getByText('このトークンを持つ人は、あなたのセッションを読み書きできます。渡す相手に気をつけてください。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取り込み内容を確認' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.config.preview' });
  });
  it('同期が未設定なら参加の案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ configured: false, url: null, state: 'off', lastPullAt: '不明', pending: 0, devices: [] }) })} /></IntentRoot>);
    expect(screen.getByText('hangar setup cloud か hangar join <token> で始められます')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
  });
  it('今すぐ同期と一時停止の Intent', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.now' });
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.pause', paused: true });
    // 一時停止中は、同じボタンが再開になる。
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud: cloudProps({ state: 'paused', paused: true }) })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '同期を再開' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'sync.pause', paused: false });
  });
  it('参加トークンは押すまで出さず、消えたら表示のボタンに戻る', () => {
    // 全セッションの読み書き権を持つ秘密なので、画面に出したままにしない。
    // ランタイムが 120 秒で store から消すので、props が null に戻ったらボタンの姿に戻る。
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    expect(screen.queryByText('tok-abc')).toBeNull();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ joinToken: 'tok-abc' }) })} /></IntentRoot>);
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '参加トークンを表示' })).toBeNull();
    expect(screen.getByText('120 秒で自動的に消えます。1Password などに写してください。')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    expect(screen.queryByText('tok-abc')).toBeNull();
    expect(screen.getByRole('button', { name: '参加トークンを表示' })).toBeInTheDocument();
  });
  it('設定の同期を切っているあいだは取り込みの確認を押せない', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '取り込み内容を確認' })).toBeDisabled();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ syncClaudeConfig: true }) })} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '取り込み内容を確認' })).toBeEnabled();
  });
  it('取り込みの対象と控えの置き場と、確認がまだであることを書く', () => {
    // 利用者の決定 2 と 12。何を書き換えるかと、控えがどこに残るかを押す前に見せる。
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ syncClaudeConfig: true }) })} /></IntentRoot>);
    expect(screen.getByText(/CLAUDE\.md、settings\.json、statusline のスクリプト、skills、memory、projects の memory/)).toBeInTheDocument();
    expect(screen.getByText(/~\/\.agent-hangar\/backups\/claude-config\//)).toBeInTheDocument();
    expect(screen.getByText('まだ取り込みを確認していません。確認するまで ~/.claude には書き込みません。')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ syncClaudeConfig: true, configConfirmed: true }) })} /></IntentRoot>);
    expect(screen.queryByText(/まだ取り込みを確認していません/)).toBeNull();
    expect(screen.getByText('取り込みを確認済みです。')).toBeInTheDocument();
  });
  it('次のフェーズで追加される設定の節は残っていない', () => {
    // クラウド同期はこのフェーズで実装し、引き継ぎは作らないと決まった（利用者の決定 1）ので、節ごと消した。
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.queryByText('次のフェーズで追加される設定')).toBeNull();
    expect(screen.getByRole('heading', { name: 'クラウド同期' })).toBeInTheDocument();
  });
});

describe('Header', () => {
  it('日本語入力の確定の Enter では検索しない', () => {
    const onIntent = vi.fn();
    // sync は Task 23 が Header に足した props である。この節が見るのは検索欄だけなので、出さない形で渡す。
    render(<IntentRoot onIntent={onIntent}><Header crumbs={[{ label: 'Home' }]} searchText="" connection="connected" indexLabel={null} usage={{ fiveHour: null, sevenDay: null, updatedLabel: null }} sync={{ visible: false, state: 'off', label: '', pending: 0, paused: false }} /></IntentRoot>);
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: '動画' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画' });
  });
});

describe('ResolveProjectDialog', () => {
  it('三つの解決と閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={['/w/alpha-moved']} onQueryCandidates={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('/w/alpha-moved'));
    fireEvent.click(screen.getByText('この場所にする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'repoint', path: '/w/alpha-moved' } });
    fireEvent.click(screen.getByText('アーカイブにする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } });
    fireEvent.click(screen.getByText('紐づけを削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } });
    fireEvent.click(screen.getByText('あとで'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ToastStack', () => {
  it('クリックで消す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ToastStack toasts={[{ id: '1', level: 'error', message: 'oops' }]} /></IntentRoot>);
    fireEvent.click(screen.getByText('oops'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
});

describe('SessionRows（空のとき）', () => {
  it('emptyText を渡すとその文言、渡さなければ既定の文言', () => {
    const { unmount } = render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} showProject emptyText="何もない" /></IntentRoot>);
    expect(screen.getByText('何もない')).toBeInTheDocument();
    unmount();
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} showProject /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
});

describe('SessionRows（抜粋つき）', () => {
  const row = (id: string, snippets: { seq: number; text: string }[]): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '完了', model: 'fable 5.1', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, cost: '', runId: null, snippets });
  it('抜粋の数が違う行も全部描き、高さは行ごとに決める', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[row('a', [{ seq: 1, text: 'snip a1' }]), row('b', [{ seq: 1, text: 'snip b1' }, { seq: 2, text: 'snip b2' }, { seq: 3, text: 'snip b3' }])]} height={400} showProject showSnippets /></IntentRoot>);
    expect(screen.getByText('na')).toBeInTheDocument();
    expect(screen.getByText('nb')).toBeInTheDocument();
    for (const t of ['snip a1', 'snip b1', 'snip b2', 'snip b3']) expect(screen.getByText(t)).toBeInTheDocument();
    const wrapOf = (name: string) => screen.getByText(name).closest('[role="row"]')!.parentElement as HTMLElement;
    expect(wrapOf('na').style.height).toBe('48px');
    expect(wrapOf('nb').style.height).toBe('88px');
  });
});

describe('ResolveProjectDialog のアイコン', () => {
  it('三つの解決はそれぞれのアイコンを持つ', () => {
    render(<IntentRoot onIntent={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    const iconOf = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon') ?? null;
    expect(iconOf('この場所にする')).toBe('repoint');
    expect(iconOf('アーカイブにする')).toBe('archive');
    expect(iconOf('紐づけを削除')).toBe('unlink');
  });
});
