import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pick } from '../test/pick.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import { presentAccounts } from '../presenters/accounts.ts';
import { ACCOUNT_COLORS, type CloudSettingsProps, type SettingsProps } from '../presenters/settings.ts';
import type { CompatDto } from '@agent-hangar/shared';
import { presentCompat } from '../presenters/compat.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Header } from './Header.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { CloudUsage } from './CloudUsage.tsx';
import type { CloudUsageProps } from '../presenters/cloudUsage.ts';

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null });
// SessionsProps に増えた分。この節が見るのはタブとチップ以外なので、空にして平らな一覧を描かせる。
const extra = { tabs: [], tab: 'all' as const, sections: null, tokens: [], hints: [], pager: null, statusColumn: true };

describe('SessionsScreen', () => {
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    pick('プロジェクト', 'alpha');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    expect(screen.queryByRole('radiogroup', { name: '状態' })).toBeNull();
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y', filter: {} });
  });
  it('絞り込みは、何で絞っているかを帯と札で見せる', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ projectId: 'p1', live: 'ended' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('alpha');
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).getByRole('radio', { name: '全期間' })).toHaveAttribute('aria-checked', 'true');
  });
  it('すべてのプロジェクトに戻すと projectId を外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{ projectId: 'p1' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    pick('プロジェクト', 'すべてのプロジェクト');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: undefined } });
  });
  it('日本語入力の確定の Enter では検索しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: '動画' } });
    fireEvent.keyDown(kw, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(kw, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画', filter: {} });
    const file = screen.getByLabelText('ファイル');
    fireEvent.change(file, { target: { value: 'a.md' } });
    onIntent.mockClear();
    fireEvent.keyDown(file, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
  });
  // 期間は相対の日数で持つ。絶対の時刻で持つと、時間が経つにつれて表示の日数がずれ、半日ほどで「全期間」に見えていた。
  it('期間は日数で持ち、時間が経っても選んだ帯のまま見える', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: '7 日' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { days: 7 } });
    rerender(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{ days: 7 }} projects={[]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: '全期間' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { days: undefined } });
  });
  it('選んだ期間の帯に印が付く', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ days: 1 }} projects={[]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    const period = () => within(screen.getByRole('radiogroup', { name: '期間' }));
    expect(period().getByRole('radio', { name: '今日' })).toHaveAttribute('aria-checked', 'true');
    rerender(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ days: 30 }} projects={[]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    expect(period().getByRole('radio', { name: '30 日' })).toHaveAttribute('aria-checked', 'true');
  });
  // 件数は見出しの行に並べるが、見出しの名前には含めない。読み上げでは「セッション」の見出しとして見つかる。
  it('画面の頭に見出しを置き、全件の数を添える', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={1196} loading={false} mode="all" allCount={1196} conditions={[]} {...extra} /></IntentRoot>);
    const h = screen.getByRole('heading', { level: 1, name: 'セッション' });
    expect(within(h.closest('.page-title-row') as HTMLElement).getByText('1,196 件')).toBeInTheDocument();
  });
  it('件数は桁を区切って出す（見出し、条件の行）', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[row('s1')]} total={1320} loading={false} mode="search" allCount={1206} conditions={['『q』']} {...extra} /></IntentRoot>);
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('1,320 件');
  });
  // 「さらに読み込む」の代わりに、一覧の下のページ送りの帯（A4）で移る。件数は条件の行が全件を言い、範囲は帯が言う。
  it('ページ送りの帯で移り、件数を変える', () => {
    const onIntent = vi.fn();
    const pager = { page: 2, pageCount: 3, size: 50, sizes: [25, 50, 100, 200], from: 51, to: 100, total: 132 };
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="q" filter={{}} projects={[]} rows={[row('s1'), row('s2')]} total={132} loading={false} mode="search" allCount={1206} conditions={['『q』']} {...extra} pager={pager} /></IntentRoot>);
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('132 件');
    const nav = screen.getByRole('navigation', { name: 'セッションのページ' });
    expect(nav).toHaveTextContent('51–100 / 132 件');
    fireEvent.click(within(nav).getByRole('button', { name: '次のページ' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.page', page: 3 });
    fireEvent.click(within(nav).getByRole('button', { name: '1 ページの件数' }));
    fireEvent.click(screen.getByRole('option', { name: '100 件ずつ' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'list.pageSize', size: 100 });
  });
  it('ページ送りが無ければ帯を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[row('s1')]} total={1} loading={false} mode="search" allCount={1} conditions={['『q』']} {...extra} /></IntentRoot>);
    expect(screen.queryByRole('navigation', { name: 'セッションのページ' })).toBeNull();
  });
  it('条件が 1 つも効いていなければ条件の行を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{}} projects={[]} rows={[row('s1')]} total={1} loading={false} mode="all" allCount={1} conditions={[]} {...extra} /></IntentRoot>);
    expect(screen.queryByRole('status', { name: '絞り込みの条件' })).toBeNull();
    expect(screen.queryByRole('button', { name: '条件をクリア' })).toBeNull();
  });
  it('条件の行は効いている条件を並べ、「条件をクリア」で全部外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="索引" filter={{ projectId: 'p1', days: 7 }} projects={[{ id: 'p1', name: 'orbit-notes' }]} rows={[row('s1')]} total={1} loading={false} mode="search" allCount={1206} conditions={['『索引』', 'orbit-notes', '7 日']} {...extra} /></IntentRoot>);
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('『索引』 · orbit-notes · 7 日 で絞り込み中');
    fireEvent.click(screen.getByRole('button', { name: '条件をクリア' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.clear' });
  });
  // 上の欄が全文検索の本体である（D1）。本文を探すことを札で言い、打った語は × で消せる。
  it('上の欄は本文を探す欄で、語を × で消せる', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><SessionsScreen text="索引" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="search" allCount={3} conditions={['『索引』']} {...extra} /></IntentRoot>);
    const box = container.querySelector('.sessions-keyword')!;
    expect(box.querySelector('svg')).toHaveAttribute('data-icon', 'fullText');
    expect(box).toHaveTextContent('本文');
    fireEvent.click(within(box as HTMLElement).getByRole('button', { name: 'キーワードを消す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '' });
  });
  it('検索中は条件の行の件数の代わりにそう言う', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" allCount={0} conditions={['『q』']} {...extra} /></IntentRoot>);
    expect(screen.getByText('検索しています')).toBeInTheDocument();
  });
  it('検索で何も当たらなければ「一致するセッションはありません」', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="search" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
    expect(screen.queryByText('セッションはまだありません')).toBeNull();
  });
  it('全件表示で空なら「セッションはまだありません」のまま', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
  it('検索中は空の文言を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" allCount={0} conditions={[]} {...extra} /></IntentRoot>);
    expect(screen.queryByText('一致するセッションはありません')).toBeNull();
  });
});

const settingsProps = (over: Partial<SettingsProps> = {}): SettingsProps => ({
  workspaceRoot: '/w', claudeDir: '/c', device: { id: 'd', name: 'mac' }, version: '0.3.0', index: { phase: 'idle', done: 0, total: 0 }, indexLabel: '3 セッション、2 プロジェクト', sessionCount: 3, projectCount: 2,
  tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null, commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install' },
  lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false,
  summarizerModels: ['gemma', 'qwen'], summarizerTest: null,
  statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: false },
  usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 1200, outputTokens: 340, sessions: 2 }], projects: [{ projectId: 'p1', name: 'alpha', inputTokens: 1200, outputTokens: 340, costUsd: 1.5, sessions: 2 }] },
  cloud: { configured: false, url: null, state: 'off', stateLabel: '同期していません', paused: false, lastPullAt: '不明', pending: 0, sweepPending: null, skipped: [], devices: [], joinToken: null, joinTokenExpiresAt: null, syncClaudeConfig: false, configConfirmed: false, usage: null },
  shell: { state: 'off', zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install', uninstallCommand: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell uninstall', devices: [] },
  nodePath: '',
  claudePath: null,
  retention: null,
  notify: { available: true, on: false, blocked: false },
  verify: { workspace: null, tmux: null, claude: null, code: null, node: null },
  mcpRegistered: null,
  save: {},
  todo: { must: 0, link: 0 },
  accounts: { list: presentAccounts({ ...initialStore(), accounts: accountsFixture }, Date.parse('2026-10-06T12:00:00+09:00')), colors: ACCOUNT_COLORS },
  focus: null,
  compat: null,
  ...over,
});

const cloudProps = (over: Partial<CloudSettingsProps> = {}): CloudSettingsProps => ({
  configured: true, url: 'https://h.workers.dev', state: 'idle', stateLabel: '同期済み', paused: false, lastPullAt: '1 分前', pending: 2, sweepPending: null, skipped: [],
  devices: [{ id: 'dev-a', name: 'mac', platform: 'darwin', lastSeen: '今', self: true }, { id: 'dev-b', name: 'mini', platform: 'darwin', lastSeen: '3 分前', self: false }],
  joinToken: null, joinTokenExpiresAt: null, syncClaudeConfig: false, configConfirmed: false, usage: null,
  ...over,
});

describe('SettingsScreen の通知', () => {
  it('「通知を受け取る」のスイッチで切り替える', () => {
    const onIntent = vi.fn();
    const { unmount } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: '通知を受け取る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'notify.set', on: true });
    unmount();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ notify: { available: true, on: true, blocked: false } })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: '通知を受け取る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'notify.set', on: false });
  });
  it('OS で通知が切られていれば、システム設定で許可するよう添える。スイッチは入れ直せる', () => {
    render(<IntentRoot onIntent={vi.fn()}><SettingsScreen {...settingsProps({ notify: { available: true, on: false, blocked: true } })} /></IntentRoot>);
    expect(screen.getByRole('switch', { name: '通知を受け取る' })).not.toBeDisabled();
    expect(screen.getByText(/システム設定の「通知」で Hangar を許可してください/)).toBeInTheDocument();
  });
  it('通知を出せない環境では、スイッチを押せなくして理由を添える', () => {
    render(<IntentRoot onIntent={vi.fn()}><SettingsScreen {...settingsProps({ notify: { available: false, on: false, blocked: false } })} /></IntentRoot>);
    expect(screen.getByRole('switch', { name: '通知を受け取る' })).toBeDisabled();
    expect(screen.getByText(/通知を出せません/)).toBeInTheDocument();
  });
});

/** 欄に書いて、欄を出る。パスの欄は欄を出たときに保存する。 */
const typeAndLeave = (label: string, value: string) => {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe('SettingsScreen', () => {
  it('ワークスペースは欄を出たら保存し、欄の名前を添える。作り直しと、この PC', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ version: '0.1.0', index: { phase: 'idle', done: 3, total: 3 }, projectCount: 1 })} /></IntentRoot>);
    typeAndLeave('ワークスペースのルート', '/w2');
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { workspaceRoot: '/w2' }, field: 'workspaceRoot' });
    fireEvent.click(screen.getByText('索引を作り直す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'index.rebuild' });
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'この PC' })).toBeInTheDocument();
    expect(screen.getByText(/再起動後に反映されます/)).toBeInTheDocument();
    // 索引の文は presenter がヘッダーと同じ関数で作ったものをそのまま出す。
    expect(screen.getByText('3 セッション、2 プロジェクト')).toBeInTheDocument();
  });
  it('パスの欄には保存のボタンが無い。要約器だけは 3 項目をまとめて保存する', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    for (const t of ['保存', 'ツールの設定を保存', 'Node のパスを保存']) expect(screen.queryByRole('button', { name: t })).toBeNull();
    expect(screen.getByRole('button', { name: '要約器の設定を保存' })).toBeInTheDocument();
  });
  it('Node のパスを保存でき、空なら null を送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ nodePath: '/opt/homebrew/bin/node' })} /></IntentRoot>);
    typeAndLeave('Node のパス', '/opt/node22/bin/node');
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { nodePath: '/opt/node22/bin/node' }, field: 'nodePath' });
    // 空白だけにするのは「指定を消す」なので、指定が入っていた PC では変更である。
    typeAndLeave('Node のパス', '  ');
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { nodePath: null }, field: 'nodePath' });
  });
  it('変えずに欄を出ても送らない。前後の空白だけの違いも変更にしない', () => {
    // 同じ値でも送ると、workspaceRoot ではプロジェクトの登録し直しが走る。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ nodePath: '/opt/homebrew/bin/node', codePath: '/usr/local/bin/code' })} /></IntentRoot>);
    for (const label of ['ワークスペースのルート', 'tmux のパス', 'claude のパス', 'code のパス', 'Node のパス']) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.blur(field);
      typeAndLeave(label, ` ${field.value} `);
    }
    expect(onIntent).not.toHaveBeenCalled();
    // 空白を足しただけの欄は、保存済みの値に戻す。
    expect(screen.getByLabelText('code のパス')).toHaveValue('/usr/local/bin/code');
  });
  it('Enter でも保存し、日本語入力の確定の Enter では保存しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const field = screen.getByLabelText('code のパス');
    fireEvent.change(field, { target: { value: '/usr/local/bin/code' } });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { codePath: '/usr/local/bin/code' }, field: 'codePath' });
  });
  it('保存できたら欄の横に「✓ 保存しました」を 2 秒出し、保存し直すたびに出し直す', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
      const tick = () => within(screen.getByLabelText('tmux のパス').closest('.inrow') as HTMLElement).queryByText('保存しました');
      expect(tick()).toBeNull();
      rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ save: { tmuxPath: { kind: 'saved', n: 1 } } })} /></IntentRoot>);
      expect(tick()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(tick()).toBeNull();
      rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ save: { tmuxPath: { kind: 'saved', n: 2 } } })} /></IntentRoot>);
      expect(tick()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('保存を断られたら、欄の下に理由を出し、書いた値は欄に残す', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    typeAndLeave('tmux のパス', '/nope/tmux');
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ save: { tmuxPath: { kind: 'error', message: '「tmux のパス」に /nope/tmux が見つかりません' } } })} /></IntentRoot>);
    expect(screen.getByRole('alert')).toHaveTextContent('「tmux のパス」に /nope/tmux が見つかりません');
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('/nope/tmux');
  });
  it('欄の下に、見つかったパスと版、または直し方を出す（B1）', () => {
    const verify = {
      workspace: { ok: true, soft: false, text: '/w', note: 'プロジェクト 12 件', fix: null, fixCommand: null },
      tmux: { ok: false, soft: false, text: '見つかりません', note: null, fix: null, fixCommand: 'brew install tmux' },
      claude: { ok: true, soft: false, text: '/Users/me/.local/bin/claude', note: '2.3.1', fix: null, fixCommand: null },
      code: { ok: false, soft: true, text: '見つかりません', note: '無くても動きます', fix: 'VS Code から code コマンドを入れてください', fixCommand: null },
      node: null,
    };
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ verify })} /></IntentRoot>);
    const under = (label: string) => screen.getByLabelText(label).closest('.path-field')!.querySelector('.verify')!;
    expect(under('ワークスペースのルート')).toHaveTextContent('/w（プロジェクト 12 件）');
    expect(under('claude のパス')).toHaveTextContent('/Users/me/.local/bin/claude（2.3.1）');
    expect(under('tmux のパス')).toHaveTextContent('見つかりません');
    expect(under('tmux のパス')).toHaveAttribute('data-tone', 'ng');
    expect(under('code のパス')).toHaveAttribute('data-tone', 'soft');
    expect(under('code のパス')).toHaveTextContent('無くても動きます');
    expect(under('Node のパス')).toHaveTextContent('確かめています');
    fireEvent.click(screen.getByRole('button', { name: 'brew install tmux をコピー' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'brew install tmux' });
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
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 }, field: 'summarizer' });
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
    typeAndLeave('claude のパス', ' /Users/x/.local/bin/claude ');
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { claudePath: '/Users/x/.local/bin/claude' }, field: 'claudePath' });
  });
  it('サーバが正規化した claude のパスを入力欄に反映する', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ claudePath: '/Users/x/.local/bin/claude' })} /></IntentRoot>);
    expect(screen.getByLabelText('claude のパス')).toHaveValue('/Users/x/.local/bin/claude');
  });
  it('ターミナルアプリは切り替えた時点で保存し、パスの欄はその 1 項目だけを送る。コマンドは hangar でそろえる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ version: '0.2.0', index: { phase: 'idle', done: 3, total: 3 }, projectCount: 1 })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: 'iTerm2' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { terminalApp: 'iterm' } });
    typeAndLeave('code のパス', '/usr/local/bin/code');
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { codePath: '/usr/local/bin/code' }, field: 'codePath' });
    expect(screen.getByText('hangar mcp install')).toBeInTheDocument();
    expect(screen.getByText('hangar statusline install')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'hangar mcp install をコピー' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'clipboard.copy', text: 'hangar mcp install' });
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
  it('MCP の登録を札で出す', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ mcpRegistered: true })} /></IntentRoot>);
    const mcp = () => within(screen.getByRole('heading', { name: /^MCP/ }).closest('section')!);
    expect(mcp().getByText('登録済み')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ mcpRegistered: false })} /></IntentRoot>);
    expect(mcp().getByText('まだ登録されていません')).toBeInTheDocument();
  });
});

describe('SettingsScreen の目次（設定の A1）', () => {
  it('左の目次に 5 つの群を並べ、群の中の節の名前も添える', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const toc = within(screen.getByRole('navigation', { name: '設定の目次' }));
    expect(toc.getAllByRole('button').map((b) => b.textContent)).toEqual(['必須', '連携', '要約器', '同期', '情報']);
    expect(toc.getByText('外のターミナル')).toBeInTheDocument();
    for (const name of ['必須', '連携', '要約器', '同期', '情報']) expect(screen.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) })).toBeInTheDocument();
  });
  it('目次の「連携」に、小見出しとして「アカウント」を足す（群は増やさない）', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const toc = within(screen.getByRole('navigation', { name: '設定の目次' }));
    expect(toc.getByText('アカウント')).toHaveClass('settings-toc-sub');
    expect(toc.getAllByRole('button')).toHaveLength(5);
  });
  it('アカウントの節は「連携」の群の中に出し、1 件でも出す', () => {
    const one = presentAccounts({ ...initialStore(), accounts: { ...accountsFixture, accounts: accountsFixture.accounts.slice(0, 1) } }, 0);
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ accounts: { list: one, colors: ACCOUNT_COLORS } })} /></IntentRoot>);
    const link = screen.getByRole('group', { name: /^連携/ });
    expect(within(link).getByRole('heading', { level: 3, name: 'アカウント' })).toBeInTheDocument();
    expect(within(link).getAllByRole('listitem')).toHaveLength(1);
  });
  it('アカウントがまだ届いていなければ、節を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ accounts: { list: [], colors: ACCOUNT_COLORS } })} /></IntentRoot>);
    expect(screen.queryByRole('heading', { level: 3, name: 'アカウント' })).toBeNull();
  });
  it('アカウントの設定から来たとき（focus が accounts）、節が見える位置へ滑り、連携の群が灯る', () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ focus: 'accounts' })} /></IntentRoot>);
      expect(scrolled).toEqual(['settings-accounts']);
      expect(within(screen.getByRole('navigation', { name: '設定の目次' })).getByRole('button', { name: '連携' })).toHaveAttribute('aria-current', 'true');
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
  it('focus が無ければ、開いても滑らない', () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
  it('最初は必須が灯り、押した群へ滑って灯る', () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
      const toc = within(screen.getByRole('navigation', { name: '設定の目次' }));
      expect(toc.getByRole('button', { name: '必須' })).toHaveAttribute('aria-current', 'true');
      fireEvent.click(toc.getByRole('button', { name: '同期' }));
      expect(scrolled).toEqual(['settings-sync']);
      expect(toc.getByRole('button', { name: '同期' })).toHaveAttribute('aria-current', 'true');
      expect(toc.getByRole('button', { name: '必須' })).not.toHaveAttribute('aria-current');
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
  it('直すものがある群には、目次と見出しに印を付ける', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ todo: { must: 0, link: 2 } })} /></IntentRoot>);
    const toc = within(screen.getByRole('navigation', { name: '設定の目次' }));
    expect(toc.getByRole('img', { name: '直すもの 2 件' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).toHaveTextContent('直すもの 2 件');
  });
});

describe('SettingsScreen の Claude Code との互換（C2）', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const DETAIL: CompatDto = {
    verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
      { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9) },
      { contract: 'registry', value: 'status=compacting', version: '2.1.300', count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) },
      { contract: 'transcript', value: 'system.subtype=turn_summary', version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) },
    ],
  };
  const DRIFT = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
  /** 互換の節。見出しの名前には右端の札の文も入る。 */
  const section = () => screen.getByRole('heading', { level: 3, name: /^Claude Code との互換/ }).closest('section')!;
  it('連携の群の先頭に節を置き、群の見出しと目次の小見出しにも添える', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const link = screen.getByRole('group', { name: /^連携/ });
    expect(within(link).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(/^Claude Code との互換/);
    expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).toHaveTextContent('連携Claude Code との互換、MCP、statusline、外のターミナル、通知、アカウント');
    expect(within(screen.getByRole('navigation', { name: '設定の目次' })).getByText('Claude Code との互換')).toBeInTheDocument();
  });
  it('準備の確かめが届く前は、本文の下に「確かめています」と出し、札は出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: null })} /></IntentRoot>);
    expect(within(section()).getByText('確かめています')).toBeInTheDocument();
    expect(section()).toHaveTextContent('hangar は Claude Code の会話の記録、状態のファイル、statusline、~/.claude の項目、CLI の出力、画面の文字を読んでいます。知らない形に出会ったら、ここに出します。');
  });
  it('問題なしは緑の札で、手元の版と確かめた版を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 }, null, '') })} /></IntentRoot>);
    expect(within(section()).getByText('問題なし')).toHaveAttribute('data-tone', 'ok');
    expect(section()).toHaveTextContent('手元の版 2.1.292');
    expect(section()).toHaveTextContent('確かめた版 2.1.292');
    expect(within(section()).queryByRole('list', { name: '止めた機能' })).toBeNull();
  });
  it('未確認の版は灰色の札で、版の並びに止めていないことを添える', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 }, null, '') })} /></IntentRoot>);
    expect(within(section()).getByText('未確認の版')).toHaveAttribute('data-tone', 'info');
    expect(section()).toHaveTextContent('手元の版 2.1.300');
    expect(within(section()).getByText('まだ確かめていない版です。動きは止めていません')).toBeInTheDocument();
  });
  it('ずれは注意の札で、止めた機能の一覧を常に出し、細目は畳む。表の下に置き場と報告用に写す', () => {
    const onIntent = vi.fn();
    const c = presentCompat(DRIFT, DETAIL, '0.3.0');
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ compat: c })} /></IntentRoot>);
    const sec = within(section());
    expect(sec.getByText('ずれ 3 件')).toHaveAttribute('data-tone', 'warn');
    expect(sec.getByText('知らない形に頼る機能だけを止め、ほかは動かしています。')).toBeInTheDocument();
    expect(within(sec.getByRole('list', { name: '止めた機能' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ターンの目次から端末の指示へ跳ぶのを止めています', '休んでいるセッションを自動で止めるのを控えています']);
    const more = sec.getByText('ずれ 3 件の中身').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    expect(within(more).getAllByRole('row')).toHaveLength(4);
    expect(within(more).getByText('~/.agent-hangar/compat.json')).toBeInTheDocument();
    fireEvent.click(within(more).getByRole('button', { name: '報告用に写す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: c.report });
  });
  it('ずれはあっても止めた機能が無ければ、一覧を出さず、記録だけだと言う', () => {
    const only: CompatDto = { ...DETAIL, drifts: [{ contract: 'cli', value: 'subcommand.added=newcmd', version: null, count: 1, firstSeenAt: at(7, 9, 0), lastSeenAt: at(7, 9, 0) }] };
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat({ ...DRIFT, driftCount: 1 }, only, '') })} /></IntentRoot>);
    expect(within(section()).getByText('ずれ 1 件')).toHaveAttribute('data-tone', 'warn');
    expect(within(section()).getByText('知らない形を記録しましたが、止めた機能はありません。')).toBeInTheDocument();
    expect(within(section()).queryByRole('list', { name: '止めた機能' })).toBeNull();
    expect(within(section()).getByText('ずれ 1 件の中身')).toBeInTheDocument();
  });
  it('ずれがあっても、目次の点と群の見出しの「直すもの」は灯さない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat(DRIFT, DETAIL, ''), todo: { must: 0, link: 0 } })} /></IntentRoot>);
    expect(within(screen.getByRole('navigation', { name: '設定の目次' })).queryByRole('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).not.toHaveTextContent('直すもの');
  });
});

describe('SettingsScreen のフェーズ 3', () => {
  it('statusline の状態と追記のコマンドを出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    expect(screen.getByText('まだ追記されていません')).toBeTruthy();
    expect(screen.getByText('hangar statusline install')).toBeTruthy();
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
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 }, field: 'summarizer' });
    pick('モデル', 'qwen');
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: 'qwen', summaryHourlyCap: 5 }, field: 'summarizer' });
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
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryHourlyCap: 12 }, field: 'summarizer' });
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
    const section = screen.getByRole('heading', { name: /^外のターミナル/ }).closest('section')!;
    expect(within(section).getByText('mini')).toBeInTheDocument();
    expect(within(section).getByText('入っています')).toBeInTheDocument();
    expect(within(section).getByText('まだです')).toBeInTheDocument();
    expect(within(section).getByText('この PC')).toBeInTheDocument();
    expect(within(section).getByText('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install')).toBeInTheDocument();
    // 押せるのはコマンドのコピーだけで、~/.zshrc を書き換えるボタンは持たない。
    expect(within(section).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install をコピー']);
    expect(within(section).queryByRole('checkbox')).toBeNull();
  });
  it('入っている PC では外し方を、使えない PC では直し方を出す', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ shell: shell({ state: 'on' }) })} /></IntentRoot>);
    expect(screen.getByText(/shell uninstall/)).toBeInTheDocument();
    expect(screen.queryByText(/shell install$/)).toBeNull();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ shell: shell({ state: 'unsupported' }) })} /></IntentRoot>);
    expect(screen.getByText(/brew install tmux/)).toBeInTheDocument();
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
    expect(screen.getByText(/持つ人は全セッションを読み書きできます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークン をコピー' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'tok-abc' });
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
  it('1 回だけ同期している最中は、今すぐ同期を押せない姿にする', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud: cloudProps({ state: 'paused', paused: true, once: true, stateLabel: '1 回だけ同期中…' }) })} /></IntentRoot>);
    expect(screen.getByText('状態 1 回だけ同期中…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
    expect(screen.getByRole('button', { name: '同期中…' })).toBeDisabled();
  });
  it('参加トークンは押すまで出さず、消えたら表示のボタンに戻る', () => {
    // 全セッションの読み書き権を持つ秘密なので、画面に出したままにしない。
    // ランタイムが 120 秒で store から消すので、props が null に戻ったらボタンの姿に戻る。
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    expect(screen.queryByText('tok-abc')).toBeNull();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ joinToken: 'tok-abc' }) })} /></IntentRoot>);
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '参加トークンを表示' })).toBeNull();
    expect(screen.getByText(/1Password などに写してください/)).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps() })} /></IntentRoot>);
    expect(screen.queryByText('tok-abc')).toBeNull();
    expect(screen.getByRole('button', { name: '参加トークンを表示' })).toBeInTheDocument();
  });
  it('参加トークンの下に、減る棒と「あと N 秒で消えます」を出す（設定の E2）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ cloud: cloudProps({ joinToken: 'tok-abc', joinTokenExpiresAt: 1_000_000 + 30_000 }) })} /></IntentRoot>);
      expect(screen.getByText(/^あと 30 秒で消えます/)).toBeInTheDocument();
      const bar = screen.getByRole('progressbar', { name: '参加トークンが消えるまで' });
      expect(bar).toHaveAttribute('aria-valuenow', '30');
      expect(bar).not.toHaveAttribute('data-low');
      act(() => { vi.advanceTimersByTime(21_000); });
      expect(screen.getByText(/^あと 9 秒で消えます/)).toBeInTheDocument();
      expect(bar).toHaveAttribute('data-low', 'true');
    } finally {
      vi.useRealTimers();
    }
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
  it('探す・移動の錠剤を押すとパレットを開く', () => {
    const onIntent = vi.fn();
    // sync は Task 23 が Header に足した props である。この節が見るのは錠剤だけなので、出さない形で渡す。
    render(<IntentRoot onIntent={onIntent}><Header account={null} newSession={{}} indexLabel={null} usage={{ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }} sync={{ visible: false, state: 'off', label: '', pending: 0, sweepPending: 0, skipped: 0, paused: false, reason: null, quotaBack: false }} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '探す・移動' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
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
    const dialog = screen.getByRole('dialog', { name: 'alpha のディレクトリが見つかりません' });
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
  it('どの節もいずれかの群の直下に並ぶ', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><SettingsScreen {...settingsProps({})} /></IntentRoot>);
    const root = container.querySelector('.settings-screen');
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll('.settings-group > section').length).toBe(root!.querySelectorAll('section').length);
    expect(root!.querySelectorAll('.settings-group > section').length).toBeGreaterThan(5);
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

const USAGE: CloudUsageProps = {
  tiles: [
    { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
    { key: 'd1', label: 'D1 の書き込み（今日）', value: '68%', sub: '68,120 行', tone: 'warn' },
    { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
  ],
  bars: [
    { label: 'D1 の書き込み', when: '今日', pct: 68.12, value: '68,120 / 100,000 行', tone: 'warn' },
    { label: 'R2 の保存', when: '今月', pct: 1.65, value: '0.17 / 10 GB-月', tone: 'ok' },
    { label: 'R2 Infrequent Access Data Retrieval', when: '今月', pct: null, value: '3 GB', tone: 'ok' },
  ],
  splitAfter: 1, legend: ['あと 13,880 行で無料枠の上限です · 9:00 に戻る'], source: 'Cloudflare の数 · 2 分前', strip: null, command: null,
};

describe('CloudUsage', () => {
  it('札と棒と添え書きを描く', () => {
    render(<CloudUsage {...USAGE} />);
    const sec = screen.getByRole('region', { name: '使用量と費用' });
    expect(within(sec).getByText('$0.00')).toBeTruthy();
    expect(within(sec).getByText('68%').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warn');
    const meters = within(sec).getAllByRole('meter');
    expect(meters).toHaveLength(2);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('68.12');
    expect(within(sec).getByText('3 GB')).toBeTruthy();
    expect(within(sec).getByText('Cloudflare の数 · 2 分前')).toBeTruthy();
  });
  it('停止の帯は alert、案内のコマンドは等幅で出す', () => {
    render(<CloudUsage {...USAGE} strip={{ tone: 'stop', text: 'Cloudflare の無料枠の上限に達したので、同期を止めています。9:00 に枠が戻ると、自動で再開します。' }} command="npm run hangar -- setup cloud --usage-token" />);
    expect(screen.getByRole('alert').textContent).toContain('同期を止めています');
    expect(screen.getByText('npm run hangar -- setup cloud --usage-token').className).toContain('mono');
  });
  it('凡例が空でも崩れず、出典だけ描く', () => {
    render(<CloudUsage {...USAGE} legend={[]} />);
    expect(screen.getByText('Cloudflare の数 · 2 分前')).toBeTruthy();
  });
});
