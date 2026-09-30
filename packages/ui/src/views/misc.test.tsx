import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pick } from '../test/pick.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { CloudSettingsProps, SettingsProps } from '../presenters/settings.ts';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Header } from './Header.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '', model: '', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null });

describe('SessionsScreen', () => {
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    pick('プロジェクト', 'alpha');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    expect(within(screen.getByRole('radiogroup', { name: '状態' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['すべて', '入力待ち', '実行中', '終了']);
    fireEvent.click(screen.getByRole('radio', { name: '実行中' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { live: 'running' } });
    fireEvent.click(screen.getByRole('radio', { name: '入力待ち' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { live: 'waiting' } });
    fireEvent.click(screen.getByRole('radio', { name: '終了' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { live: 'ended' } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y' });
  });
  it('絞り込みは、何で絞っているかを帯と札で見せる', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ projectId: 'p1', live: 'ended' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('alpha');
    expect(within(screen.getByRole('radiogroup', { name: '状態' })).getByRole('radio', { name: '終了' })).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).getByRole('radio', { name: '全期間' })).toHaveAttribute('aria-checked', 'true');
  });
  it('すべてのプロジェクトに戻すと projectId を外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{ projectId: 'p1' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    pick('プロジェクト', 'すべてのプロジェクト');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: undefined } });
  });
  it('日本語入力の確定の Enter では検索しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
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
  // 期間は相対の日数で持つ。絶対の時刻で持つと、時間が経つにつれて表示の日数がずれ、半日ほどで「全期間」に見えていた。
  it('期間は日数で持ち、時間が経っても選んだ帯のまま見える', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: '7 日' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { days: 7 } });
    rerender(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{ days: 7 }} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: '全期間' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { days: undefined } });
  });
  it('選んだ期間の帯に印が付く', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ days: 1 }} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    const period = () => within(screen.getByRole('radiogroup', { name: '期間' }));
    expect(period().getByRole('radio', { name: '今日' })).toHaveAttribute('aria-checked', 'true');
    rerender(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ days: 30 }} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    expect(period().getByRole('radio', { name: '30 日' })).toHaveAttribute('aria-checked', 'true');
  });
  // 件数は見出しの行に並べるが、見出しの名前には含めない。読み上げでは「セッション」の見出しとして見つかる。
  it('画面の頭に見出しを置き、件数を添える', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} shown={1196} total={1196} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    const h = screen.getByRole('heading', { level: 1, name: 'セッション' });
    expect(within(h.closest('.page-title-row') as HTMLElement).getByText('1196 件')).toBeInTheDocument();
  });
  // サーバは上位の 50 件だけを返す。全件の数だけを出すと、並ぶ行の数と合わない。
  it('切れているときは「上位 N / 全件」と出し、一覧の末尾から続きを読める', () => {
    const onIntent = vi.fn();
    const rows = [row('s1'), row('s2')];
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionsScreen text="q" filter={{}} projects={[]} rows={rows} shown={50} total={132} loading={false} loadingMore={false} mode="search" /></IntentRoot>);
    expect(within(screen.getByRole('heading', { level: 1, name: 'セッション' }).closest('.page-title-row') as HTMLElement).getByText('上位 50 / 132 件')).toBeInTheDocument();
    const more = within(screen.getByTestId('session-rows')).getByRole('button', { name: 'さらに読み込む' });
    fireEvent.click(more);
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.more', offset: 50 });
    rerender(<IntentRoot onIntent={onIntent}><SessionsScreen text="q" filter={{}} projects={[]} rows={rows} shown={50} total={132} loading={false} loadingMore mode="search" /></IntentRoot>);
    expect(screen.getByRole('button', { name: '読み込んでいます' })).toBeDisabled();
    expect(screen.getByText('上位 50 / 132 件')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><SessionsScreen text="q" filter={{}} projects={[]} rows={rows} shown={132} total={132} loading={false} loadingMore={false} mode="search" /></IntentRoot>);
    expect(screen.getByText('132 件')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'さらに読み込む' })).toBeNull();
  });
  it('さらに読み込むを押したら、読み終えたところで読み足した最初の行へフォーカスを返す', () => {
    const onIntent = vi.fn();
    const at = (rows: SessionRowProps[], loadingMore: boolean, shown: number) => <IntentRoot onIntent={onIntent}><SessionsScreen text="q" filter={{}} projects={[]} rows={rows} shown={shown} total={4} loading={false} loadingMore={loadingMore} mode="search" /></IntentRoot>;
    const two = [row('s1'), row('s2')];
    const { rerender } = render(at(two, false, 2));
    const more = screen.getByRole('button', { name: 'さらに読み込む' });
    act(() => more.focus());
    fireEvent.click(more);
    rerender(at(two, true, 2));
    // 押したボタンは読み込みの間 disabled になり、ブラウザはフォーカスを body へ落とす。jsdom は落とさないので、ここで落とす。
    act(() => (document.activeElement as HTMLElement).blur());
    rerender(at([...two, row('s3'), row('s4')], false, 4));
    expect(document.activeElement).toBe(screen.getByText('ns3').closest('[role="row"]'));
    expect(screen.getByText('ns3').closest('[role="row"]')).toHaveAttribute('data-cursor', 'true');
  });
  it('読み足せなかったときは一覧へフォーカスを返し、ほかへ移したフォーカスは奪わない', () => {
    const onIntent = vi.fn();
    const at = (loadingMore: boolean) => <IntentRoot onIntent={onIntent}><SessionsScreen text="q" filter={{}} projects={[]} rows={[row('s1'), row('s2')]} shown={2} total={4} loading={false} loadingMore={loadingMore} mode="search" /></IntentRoot>;
    const { rerender } = render(at(false));
    fireEvent.click(screen.getByRole('button', { name: 'さらに読み込む' }));
    rerender(at(true));
    act(() => (document.activeElement as HTMLElement).blur());
    rerender(at(false));
    expect(document.activeElement).toBe(screen.getByTestId('session-rows'));
    // 読み込みの間に利用者がキーワードの欄へ移ったら、そのままにする。
    fireEvent.click(screen.getByRole('button', { name: 'さらに読み込む' }));
    rerender(at(true));
    const keyword = screen.getByLabelText('キーワード');
    act(() => keyword.focus());
    rerender(at(false));
    expect(document.activeElement).toBe(keyword);
  });
  it('検索中と件数の表示', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} shown={0} total={0} loading loadingMore={false} mode="search" /></IntentRoot>);
    expect(screen.getByText('検索しています')).toBeInTheDocument();
  });
  it('検索で何も当たらなければ「一致するセッションはありません」', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="search" /></IntentRoot>);
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
    expect(screen.queryByText('セッションはまだありません')).toBeNull();
  });
  it('全件表示で空なら「セッションはまだありません」のまま', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} shown={0} total={0} loading={false} loadingMore={false} mode="all" /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
  it('検索中は空の文言を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} shown={0} total={0} loading loadingMore={false} mode="search" /></IntentRoot>);
    expect(screen.queryByText('一致するセッションはありません')).toBeNull();
  });
});

const settingsProps = (over: Partial<SettingsProps> = {}): SettingsProps => ({
  workspaceRoot: '/w', claudeDir: '/c', device: { id: 'd', name: 'mac' }, version: '0.3.0', index: { phase: 'idle', done: 0, total: 0 }, indexLabel: '3 セッション、2 プロジェクト', sessionCount: 3, projectCount: 2,
  tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null, mcpInstallCommand: 'npm run hangar -- mcp install',
  lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false,
  summarizerModels: ['gemma', 'qwen'], summarizerTest: null,
  statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: false },
  statuslineCommand: 'npm run hangar -- statusline install',
  usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 1200, outputTokens: 340, sessions: 2 }], projects: [{ projectId: 'p1', name: 'alpha', inputTokens: 1200, outputTokens: 340, costUsd: 1.5, sessions: 2 }] },
  cloud: { configured: false, url: null, state: 'off', stateLabel: '同期していません', paused: false, lastPullAt: '不明', pending: 0, sweepPending: null, skipped: [], devices: [], joinToken: null, syncClaudeConfig: false, configConfirmed: false },
  shell: { state: 'off', zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install', uninstallCommand: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell uninstall', devices: [] },
  nodePath: '',
  claudePath: null,
  retention: null,
  notify: { available: true, on: false },
  ...over,
});

const cloudProps = (over: Partial<CloudSettingsProps> = {}): CloudSettingsProps => ({
  configured: true, url: 'https://h.workers.dev', state: 'idle', stateLabel: '同期済み', paused: false, lastPullAt: '1 分前', pending: 2, sweepPending: null, skipped: [],
  devices: [{ id: 'dev-a', name: 'mac', platform: 'darwin', lastSeen: '今', self: true }, { id: 'dev-b', name: 'mini', platform: 'darwin', lastSeen: '3 分前', self: false }],
  joinToken: null, syncClaudeConfig: false, configConfirmed: false,
  ...over,
});

describe('SettingsScreen の通知', () => {
  it('「通知を受け取る」のスイッチで切り替える', () => {
    const onIntent = vi.fn();
    const { unmount } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: '通知を受け取る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'notify.set', on: true });
    unmount();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ notify: { available: true, on: true } })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: '通知を受け取る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'notify.set', on: false });
  });
  it('通知を出せない環境では、スイッチを押せなくして理由を添える', () => {
    render(<IntentRoot onIntent={vi.fn()}><SettingsScreen {...settingsProps({ notify: { available: false, on: false } })} /></IntentRoot>);
    expect(screen.getByRole('switch', { name: '通知を受け取る' })).toBeDisabled();
    expect(screen.getByText(/通知を出せません/)).toBeInTheDocument();
  });
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
    expect(screen.getByRole('heading', { name: 'この PC' })).toBeInTheDocument();
    expect(screen.getByText(/再起動後に反映されます/)).toBeInTheDocument();
    // 索引の文は presenter がヘッダーと同じ関数で作ったものをそのまま出す。
    expect(screen.getByText('3 セッション、2 プロジェクト')).toBeInTheDocument();
  });
  it('Node のパスを保存でき、空なら null を送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ nodePath: '/opt/homebrew/bin/node' })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('Node のパス'), { target: { value: '/opt/node22/bin/node' } });
    fireEvent.click(screen.getByText('Node のパスを保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { nodePath: '/opt/node22/bin/node' } });
    // 空白だけにするのは「指定を消す」なので、指定が入っていた端末では変更である。
    fireEvent.change(screen.getByLabelText('Node のパス'), { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Node のパスを保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { nodePath: null } });
  });
  it('4 つの保存ボタンは、どれも変えたときだけ押せる', () => {
    // 何も変えずに押せると、patch が飛んで「設定を保存しました」のトーストが出る。
    // workspaceRoot に至っては、同じ値でもプロジェクトの登録し直しが走る。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ nodePath: '/opt/homebrew/bin/node' })} /></IntentRoot>);
    const buttons = ['保存', 'ツールの設定を保存', '要約器の設定を保存', 'Node のパスを保存'].map((t) => screen.getByText(t));
    for (const b of buttons) { expect(b).toBeDisabled(); fireEvent.click(b); }
    expect(onIntent).not.toHaveBeenCalled();
    const changes: [string, string][] = [['ワークスペースのルート', '/w2'], ['code のパス', '/usr/local/bin/code'], ['LM Studio の URL', 'http://127.0.0.1:2345'], ['Node のパス', '/opt/node22/bin/node']];
    for (const [i, [label, value]] of changes.entries()) {
      const field = screen.getByLabelText(label);
      const before = (field as HTMLInputElement).value;
      fireEvent.change(field, { target: { value } });
      expect(buttons[i]).toBeEnabled();
      // 元に戻せばまた押せなくなる。
      fireEvent.change(field, { target: { value: before } });
      expect(buttons[i]).toBeDisabled();
    }
    // パスの欄は送る前に前後の空白を落とすので、空白を足しただけでは変更にならない。
    for (const [label, i] of [['code のパス', 1], ['Node のパス', 3]] as const) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(field, { target: { value: ` ${field.value} ` } });
      expect(buttons[i]).toBeDisabled();
    }
  });
  it('要約器の 2 欄も、サーバが整えた後の値で見比べる', () => {
    // サーバは URL の前後の空白と末尾の / を落とし、モデル名も trim する。
    // 整える前の値で見比べると、落とされた結果が元と同じでも props が動かず、
    // 欄には整える前の文字列が残り、ボタンは押せたままになる（実測で何度でも押せた）。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const url = screen.getByLabelText('LM Studio の URL');
    const save = screen.getByText('要約器の設定を保存');
    for (const same of ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234///', '  http://127.0.0.1:1234  ']) {
      fireEvent.change(url, { target: { value: same } });
      expect(save).toBeDisabled();
    }
    // 本物の変更は今までどおり送れる。送る値はサーバが保存する形にそろえる。
    fireEvent.change(url, { target: { value: '  http://127.0.0.1:2345/  ' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 } });
    // 欄も整えた形に直しておく。整える前の文字列が残ると、押せない理由が読めない。
    expect(url).toHaveValue('http://127.0.0.1:2345');
  });
  it('上限だけを変えても要約器の保存は押せる。スイッチは保存の対象に入らない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const save = screen.getByText('要約器の設定を保存');
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'LM Studio が使えないとき Claude へ切り替える' }));
    expect(save).toBeDisabled();
    // 読めない上限も「変えた」に入れる。押せないと案内を出す道が無くなる。
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '' } });
    expect(save).toBeEnabled();
  });
  it('スイッチは切り替えた時点で、その 1 項目だけを保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: 'LM Studio が使えないとき Claude へ切り替える' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { summaryFallback: false } });
  });
  it('1 時間の上限は − と ＋ でも変えられる', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '1 時間の上限を増やす' }));
    expect(screen.getByLabelText('1 時間の上限')).toHaveValue(21);
  });
  it('サーバが正規化した Node のパスを入力欄に反映する', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ nodePath: '/opt/homebrew/bin/node' })} /></IntentRoot>);
    expect(screen.getByLabelText('Node のパス')).toHaveValue('/opt/homebrew/bin/node');
  });
  it('claude のパスを保存する', () => {
    // .app から起こすと PATH で claude を引けない。欄が無いと、起動が 400 で断られたまま直せない。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('claude のパス'), { target: { value: ' /Users/x/.local/bin/claude ' } });
    fireEvent.click(screen.getByText('ツールの設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { claudePath: '/Users/x/.local/bin/claude' } });
  });
  it('サーバが正規化した claude のパスを入力欄に反映する', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ claudePath: '/Users/x/.local/bin/claude' })} /></IntentRoot>);
    expect(screen.getByLabelText('claude のパス')).toHaveValue('/Users/x/.local/bin/claude');
  });
  it('ターミナルアプリは切り替えた時点で保存し、ツールの保存はパスだけを送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ version: '0.2.0', index: { phase: 'idle', done: 3, total: 3 }, projectCount: 1 })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: 'iTerm2' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { terminalApp: 'iterm' } });
    expect(screen.getByText('ツールの設定を保存')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('code のパス'), { target: { value: '/usr/local/bin/code' } });
    fireEvent.click(screen.getByText('ツールの設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { codePath: '/usr/local/bin/code' } });
    expect(screen.getByText('npm run hangar -- mcp install')).toBeInTheDocument();
  });
  it('サーバが正規化した値に入力欄が追従する', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ tmuxPath: 'tmux', device: null, version: '0.2.0', sessionCount: 0, projectCount: 0 })} /></IntentRoot>);
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('tmux');
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ workspaceRoot: '/w2', terminalApp: 'iterm', codePath: '/usr/local/bin/code', device: null, version: '0.2.0', sessionCount: 0, projectCount: 0 })} /></IntentRoot>);
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('/opt/homebrew/bin/tmux');
    expect(screen.getByLabelText('ワークスペースのルート')).toHaveValue('/w2');
    expect(screen.getByRole('radio', { name: 'iTerm2' })).toHaveAttribute('aria-checked', 'true');
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
    // ヘッダーのゲージは使用率で、追記はターミナルで行う。
    expect(screen.getByText('ヘッダーの使用率のゲージは、この追記からだけ届きます。追記はターミナルで行い、この画面からは書き換えません。')).toBeTruthy();
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
    expect(screen.getByText('statusline の設定が見つかりません')).toBeTruthy();
  });
  it('statusline がまだ届いていなければ読み込み中を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ statusline: null, summarizerModels: [] })} /></IntentRoot>);
    expect(screen.getByText('読み込んでいます')).toBeTruthy();
  });
  it('要約器の URL とモデルと上限を保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerModels: ['qwen', 'gemma'] })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'http://127.0.0.1:2345' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 } });
    pick('モデル', 'qwen');
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: 'qwen', summaryHourlyCap: 5 } });
  });
  it('外部の要約器をオンにするときは、保存済みの宛先を示して確かめる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ lmStudioUrl: 'https://summarizer.example.com' })} /></IntentRoot>);
    const sw = screen.getByRole('switch', { name: '外部の要約器を許す' });
    // 見える文も読み上げと同じにし、何が起きるかを淡い 1 行で添える。
    expect(sw.closest('.settings-row')).toHaveTextContent(/^外部の要約器を許す/);
    expect(screen.getByText('127.0.0.1 と localhost 以外の宛先へ本文を送れるようにします。')).toBeInTheDocument();
    fireEvent.click(sw);
    // まだ保存しない。スイッチもオフのまま。
    expect(onIntent).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/https:\/\/summarizer\.example\.com へ送られます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByText(/へ送られます/)).toBeNull();
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: '許す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { allowExternalSummarizer: true } });
  });
  it('確かめの帯が開くと、やめるへフォーカスが移り、閉じるとスイッチへ戻る', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const sw = screen.getByRole('switch', { name: '外部の要約器を許す' });
    fireEvent.click(sw);
    expect(screen.getByRole('button', { name: 'やめる' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(sw).toHaveFocus();
  });
  it('許すで閉じたときも、フォーカスはスイッチへ戻る', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約器を許す' }));
    fireEvent.click(screen.getByRole('button', { name: '許す' }));
    expect(screen.getByRole('switch', { name: '外部の要約器を許す' })).toHaveFocus();
  });
  it('保存済みのモデルが一覧に無くても、顔にその名前を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ lmStudioModel: 'qwen', summarizerModels: [] })} /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'モデル' })).toHaveTextContent('qwen');
  });
  it('確かめの宛先は、書きかけの URL ではなく保存済みの URL', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ lmStudioUrl: 'http://127.0.0.1:1234' })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'https://other.example.com' } });
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約器を許す' }));
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:1234 へ送られます/)).toBeInTheDocument();
  });
  it('外部の要約器をオフにするときは確かめずに保存し、オンの間は警告を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ allowExternalSummarizer: true, lmStudioUrl: 'https://summarizer.example.com' })} /></IntentRoot>);
    expect(screen.getByRole('switch', { name: '外部の要約器を許す' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('会話の本文');
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約器を許す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { allowExternalSummarizer: false } });
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
    // 上限の案内は、ヘッダーのゲージの見出しと同じ「週」で言う。
    expect(screen.getByText('件。1 から 200 まで。週の使用率が 80% を超えたら切り替えません。')).toBeTruthy();
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
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryHourlyCap: 12 } });
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
    expect(screen.getByText('LM Studio で成功しました（820 ミリ秒）')).toBeTruthy();
    expect(screen.getByText('1 文')).toBeTruthy();
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerTest: { ok: false, tried: [{ id: 'lmstudio', message: 'ECONNREFUSED' }, { id: 'claude-headless', message: '上限に達しています' }] } })} /></IntentRoot>);
    expect(screen.getByText('LM Studio: ECONNREFUSED')).toBeTruthy();
    expect(screen.getByText('claude: 上限に達しています')).toBeTruthy();
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

describe('SettingsScreen の外のターミナル', () => {
  const shell = (over: Partial<SettingsProps['shell']>) => ({ ...settingsProps().shell, ...over });
  it('PC ごとの状態を並べ、入っていない PC には貼るコマンドを出す。書き換えるボタンは持たない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ shell: shell({ devices: [{ id: 'd', name: 'mac', self: true, label: 'まだです' }, { id: 'd2', name: 'mini', self: false, label: '入っています' }] }) })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: '外のターミナル' }).closest('section')!;
    expect(within(section).getByText('mini')).toBeInTheDocument();
    expect(within(section).getByText('入っています')).toBeInTheDocument();
    expect(within(section).getByText('まだです')).toBeInTheDocument();
    expect(within(section).getByText('この PC')).toBeInTheDocument();
    expect(within(section).getByText('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).toBeNull();
    expect(within(section).queryByRole('checkbox')).toBeNull();
  });
  it('入っている PC では外し方を、使えない PC では直し方を出す', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ shell: shell({ state: 'on' }) })} /></IntentRoot>);
    expect(screen.getByText(/shell uninstall/)).toBeInTheDocument();
    expect(screen.queryByText(/shell install$/)).toBeNull();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ shell: shell({ state: 'unsupported' }) })} /></IntentRoot>);
    expect(screen.getByText(/claude update/)).toBeInTheDocument();
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
  it('クラウドの節に取り残しの件数と送れなかった本文の一覧を出す', () => {
    const skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }];
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ sweepPending: 1500, skipped }) })} /></IntentRoot>);
    expect(screen.getByText('未送信の本文 1500 件')).toBeInTheDocument();
    expect(screen.getByText('送れなかった本文 1 件。30 分ごとに送り直します。')).toBeInTheDocument();
    expect(screen.getByText('transcripts/mini/u1.jsonl.gz: 復号できません（3 回）')).toBeInTheDocument();
    // 追いついた端末は 0 件と描く。数えられない端末は何も描かない。
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ sweepPending: 0, skipped: [] }) })} /></IntentRoot>);
    expect(screen.getByText('未送信の本文 0 件')).toBeInTheDocument();
    expect(screen.queryByText('送れなかった本文 0 件。30 分ごとに送り直します。')).toBeNull();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    expect(screen.queryByText(/未送信の本文/)).toBeNull();
  });
  it('同期が未設定なら参加の案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ configured: false, url: null, state: 'off', lastPullAt: '不明', pending: 0, devices: [] }) })} /></IntentRoot>);
    expect(screen.getByText('hangar setup cloud か hangar join <token> で始められます')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
  });
  it('今すぐ同期と一時停止の Intent', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    // 状態はヘッダーと同じ語で、受信の時刻は「最後の受信」と書く。
    expect(screen.getByText('状態 同期済み')).toBeInTheDocument();
    expect(screen.getByText('最後の受信 1 分前')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.now' });
    fireEvent.click(screen.getByRole('button', { name: '同期を一時停止' }));
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
    expect(screen.getByText('CLAUDE.md、settings.json、statusline のスクリプト、skills、memory、projects の memory を PC の間で合わせます。')).toBeInTheDocument();
    // 同期している PC の一覧で、自分の PC に印を付ける。
    expect(screen.getByText('この PC', { selector: '.list .faint' })).toBeInTheDocument();
    expect(screen.getByText(/~\/\.agent-hangar\/backups\/claude-config\//)).toBeInTheDocument();
    expect(screen.getByText('まだ取り込みを確認していません。確認するまで ~/.claude には書き込みません。')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ syncClaudeConfig: true, configConfirmed: true }) })} /></IntentRoot>);
    expect(screen.queryByText(/まだ取り込みを確認していません/)).toBeNull();
    expect(screen.getByText('取り込みを確認済みです。')).toBeInTheDocument();
  });
  it('同じ名前の端末が並んでも React の key が重ならない', () => {
    // 1 台の Mac で 2 端末を模すと、名前も最終確認も揃う（final-review の中 5）。
    // 一意なのは端末 ID だけなので、key はそこから取る。
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const devices = [
      { id: 'dev-a', name: 'MacBook-Pro.local', platform: 'darwin', lastSeen: '6 分前', self: true },
      { id: 'dev-b', name: 'MacBook-Pro.local', platform: 'darwin', lastSeen: '6 分前', self: false },
    ];
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ devices }) })} /></IntentRoot>);
    expect(screen.getAllByText('darwin')).toHaveLength(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    warn.mockRestore();
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
    render(<IntentRoot onIntent={onIntent}><Header newSession={{}} searchText="" indexLabel={null} usage={{ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }} sync={{ visible: false, state: 'off', label: '', pending: 0, sweepPending: 0, skipped: 0, paused: false }} /></IntentRoot>);
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
    // 一覧から削除は取り消せないので危険色にし、押しても Mediator が先に確認を出す。
    const remove = screen.getByRole('button', { name: '一覧から削除' });
    expect(remove).toHaveClass('btn-danger');
    fireEvent.click(remove);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } });
    fireEvent.click(screen.getByText('あとで'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ResolveProjectDialog のフォーカス', () => {
  it('開いたら中の最初の操作にフォーカスを入れる', () => {
    render(<IntentRoot onIntent={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: 'プロジェクトの場所を確認' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('新しいパス'));
  });
});


describe('SessionRows（空のとき）', () => {
  it('emptyText を渡すとその文言、渡さなければ既定の文言', () => {
    const { unmount } = render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} variant="search" emptyText="何もない" /></IntentRoot>);
    expect(screen.getByText('何もない')).toBeInTheDocument();
    unmount();
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} variant="search" /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
});

describe('ResolveProjectDialog のアイコン', () => {
  it('三つの解決はそれぞれのアイコンを持つ', () => {
    render(<IntentRoot onIntent={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    const iconOf = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon') ?? null;
    expect(iconOf('この場所にする')).toBe('repoint');
    expect(iconOf('アーカイブにする')).toBe('archive');
    expect(iconOf('一覧から削除')).toBe('unlink');
  });
});

describe('SettingsScreen の読む面', () => {
  // settings.css の .settings-screen > section が白い面を敷く。節が直下から外れると、面が消える。
  it('どの節も画面の直下に並ぶ', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><SettingsScreen {...settingsProps({})} /></IntentRoot>);
    const root = container.querySelector('.settings-screen');
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll(':scope > section').length).toBe(root!.querySelectorAll('section').length);
    expect(root!.querySelectorAll(':scope > section').length).toBeGreaterThan(5);
  });
});

describe('SettingsScreen の会話の保持', () => {
  const bar = { nowLabel: 'いま 1.5 GB', projLabel: '10 年たつと約 178 GB', freeLabel: '空き 400 GB', nowPct: 0.4, projPct: 44, warn: false };
  const retention = { days: 3650, options: [{ value: '30', label: '30 日' }, { value: '90', label: '90 日' }, { value: '365', label: '1 年' }, { value: '3650', label: '10 年' }], writable: true, reason: null, valueLabel: '10 年', bar, syncNote: true };
  it('切り替えの帯で選ぶと確認を開き、今の値を押しても何も出さない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ retention })} /></IntentRoot>);
    expect(screen.getByRole('heading', { name: '会話の保持' })).toBeInTheDocument();
    expect(screen.getByText('10 年たつと約 178 GB')).toBeInTheDocument();
    expect(screen.getByText(/値は設定の同期で他の PC にも届きます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '1 年' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'retention.edit', days: 365, from: 'settings' });
    onIntent.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: '10 年' }));
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'retention.edit' }));
  });
  it('書けないときは帯を出さず、値と理由を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ retention: { ...retention, days: 14, writable: false, reason: '組織の設定で決まっています', valueLabel: '14 日' } })} /></IntentRoot>);
    expect(screen.queryByRole('radio', { name: '1 年' })).toBeNull();
    expect(screen.getByText(/組織の設定で決まっています/)).toBeInTheDocument();
  });
});
