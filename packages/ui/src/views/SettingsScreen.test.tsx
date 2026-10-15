import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type CompatDto, type UiAction, type SettingsSection } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentAccounts } from '../presenters/accounts.ts';
import { presentCompat } from '../presenters/compat.ts';
import { presentInjection } from '../presenters/injection.ts';
import { ACCOUNT_COLORS, presentSettings, type CloudSettingsProps, type SettingsProps } from '../presenters/settings.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { pick } from '../test/pick.ts';
import { SettingsScreen } from './SettingsScreen.tsx';
import { CopiedContext } from './primitives/CommandLine.tsx';
import { setClientUserAgent, WINDOWS_UA } from '../test/client.ts';

const TITLES: Record<SettingsSection, string> = { general: '一般', tools: 'ツール', integrations: '連携', summary: '要約エンジン', update: '更新', cloud: 'クラウド同期', info: '情報' };
const IDS = Object.keys(TITLES) as SettingsSection[];

/** 目次の 7 行（殻の中の形）。状態の文は presenter の試験（settingsToc.test.ts）が見るので、ここでは決まった文を置く。 */
const tocOf = (): SettingsProps['toc'] => IDS.map((id) => ({ id, title: TITLES[id], state: id === 'cloud' ? '同期オフ' : id === 'integrations' ? '要修正 2' : '確認中', tone: id === 'integrations' ? 'warn' : 'default', label: `${TITLES[id]}、${id === 'cloud' ? '同期オフ' : id === 'integrations' ? '要修正 2' : '確認中'}`, ...(id === 'cloud' ? { beta: true } : {}) }));

/** 設定の同期（作り直した実装）の節の既定。クラウドに参加していない形で、使う試験が必要な分だけ上書きする。節の中身の試験は ConfigSyncSection.test.tsx が見る。 */
const configSyncProps = (over: Partial<SettingsProps['configSync']> = {}): SettingsProps['configSync'] => ({
  needsCloud: true, enabled: false, workerPending: false, lastSent: null, approval: 'each', native: true, order: null,
  incoming: { count: 0, held: 0, from: null }, awaiting: 0, conflicts: 0, unsent: { count: 0, rows: [] }, backups: { count: 0, rows: [] }, focusUnsent: false,
  ...over,
});

/** 更新の節の既定。最新の形で、使う試験が必要な分だけ上書きする。 */
const updateProps = (over: Partial<SettingsProps['update']> = {}): SettingsProps['update'] => ({
  supported: true, unsupported: '更新の確認はデスクトップアプリで行います。', badge: { text: '最新', tone: 'ok' },
  version: { title: 'バージョン 1.4.2', sub: '最終確認：5 分前', checkLabel: '更新を確認', checkDisabled: false },
  pending: null, notify: { on: true, desc: '新しいバージョンが出たら通知します。自動ではインストールしません。' }, tocState: '最新',
  ...over,
});

/** 連携の 3 枚の札の書き込み。既定はブラウザ（殻が無い）の形。 */
const integrationsProps = (over: Partial<SettingsProps['integrations']> = {}): SettingsProps['integrations'] => ({
  desktop: false,
  mcp: { file: '/h/.claude.json', action: { target: 'mcp-install', label: '登録…', primary: true, disabled: false, running: false }, command: 'hangar mcp install' },
  statusline: { file: '/h/.claude/statusline.sh', action: { target: 'statusline-install', label: '設定…', primary: true, disabled: false, running: false }, command: 'hangar statusline install' },
  shell: { file: '/Users/me/.zshrc', action: { target: 'shell-install', label: 'インストール…', primary: true, disabled: false, running: false }, command: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install' },
  ...over,
});

/** エディタの欄。VS Code を選び、候補はまだ届いていない。 */
const editorProps = (over: Partial<SettingsProps['editor']> = {}): SettingsProps['editor'] => ({
  setting: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, name: 'VS Code', loading: false, test: { running: false, result: null },
  choices: [
    { id: 'vscode', name: 'VS Code', tile: 'VS', state: 'found', path: '/usr/local/bin/code', version: '1.105.1', selected: true, badge: { text: '検出済み', tone: 'ok' } },
    { id: 'cursor', name: 'Cursor', tile: 'Cu', state: 'none', path: null, version: null, selected: false, badge: { text: '見つかりません', tone: 'mute' } },
    { id: 'custom', name: '任意のコマンド', tile: '{ }', state: null, path: null, version: null, selected: false, badge: null },
  ],
  ...over,
});

const settingsProps = (over: Partial<SettingsProps> = {}): SettingsProps => ({
  workspaceRoot: '/w', claudeDir: '/c', device: { id: 'd', name: 'mac' }, version: '0.3.0', index: { phase: 'idle', done: 0, total: 0 }, indexLabel: '3 セッション、2 プロジェクト', sessionCount: 3, projectCount: 2,
  tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', terminalOptions: [{ value: 'terminal', label: 'Terminal.app' }, { value: 'iterm', label: 'iTerm2' }], terminalDesc: '「ターミナルで開く」で使うアプリ。', editor: editorProps(), commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', join: '/A/hangar join <token>', setupCloud: 'npm run hangar -- setup cloud' },
  summaryEngine: 'openai', summaryClaudeModel: 'haiku', summaryApiKeySet: false,
  lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false,
  injection: { askStatusAtEnd: true, liveHints: true, defaultModel: null, full: presentInjection(translator('ja'), { askStatusAtEnd: true, liveHints: true }) },
  summarizerModels: ['gemma', 'qwen'], summarizerTest: null,
  statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: false },
  usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 1200, outputTokens: 340, sessions: 2 }], projects: [{ projectId: 'p1', name: 'alpha', inputTokens: 1200, outputTokens: 340, costUsd: 1.5, sessions: 2 }] },
  cloud: { configured: false, url: null, state: 'off', stateLabel: '同期オフ', badge: { text: '同期オフ', tone: 'off' }, paused: false, limited: false, lastPullAt: '不明', pending: 0, sweepPending: null, skipped: [], devices: [], joinToken: null, joinTokenExpiresAt: null, usage: null },
  configSync: configSyncProps(),
  shell: { state: 'off', zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install', uninstallCommand: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell uninstall', available: true, devices: [] },
  nodePath: '',
  claudePath: null,
  retention: null,
  notify: { available: true, on: false, blocked: false },
  verify: { workspace: null, tmux: null, claude: null, node: null, git: null },
  mcpRegistered: null,
  integrations: integrationsProps(),
  save: {},
  todo: { must: 0, link: 0 },
  accounts: { list: presentAccounts({ ...initialStore(), accounts: accountsFixture }, Date.parse('2026-10-06T12:00:00+09:00')), colors: ACCOUNT_COLORS },
  section: 'general',
  toc: tocOf(),
  language: { value: 'ja' },
  focus: null,
  compat: null,
  update: updateProps(),
  self: { autoDone: true, autoDoneIdleDays: 7, autoPark: true },
  setupGuide: null,
  ...over,
});

/** 節を開いた形の props。目次の灯りも、その節に合わせる。 */
const at = (section: SettingsSection, over: Partial<SettingsProps> = {}): SettingsProps => settingsProps({ section, ...over });

const cloudProps = (over: Partial<CloudSettingsProps> = {}): CloudSettingsProps => ({
  configured: true, url: 'https://h.workers.dev', state: 'idle', stateLabel: '同期済み', badge: { text: '同期済み', tone: 'ok' }, paused: false, limited: false, lastPullAt: '1 分前', pending: 2, sweepPending: null, skipped: [],
  devices: [{ id: 'dev-a', name: 'mac', platform: 'darwin', lastSeen: '今', self: true }, { id: 'dev-b', name: 'mini', platform: 'darwin', lastSeen: '3 分前', self: false }],
  joinToken: null, joinTokenExpiresAt: null, usage: null,
  ...over,
});

const ui = (props: SettingsProps, onAction: (i: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}><SettingsScreen {...props} /></ActionRoot>;
const toc = () => within(screen.getByRole('navigation', { name: '設定のナビゲーション' }));

/** 欄に書いて、欄を出る。パスの欄は欄を出たときに保存する。 */
const typeAndLeave = (label: string, value: string) => {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe('設定の目次（S1）', () => {
  it('左の目次に節を並べ（殻の中は更新を含む 7 つ）、各行に今の状態を 1 行添える', () => {
    render(ui(settingsProps()));
    expect(toc().getAllByRole('button').map((b) => b.querySelector('.settings-toc-t')!.textContent)).toEqual(['一般', 'ツール', '連携', '要約エンジン', '更新', 'クラウド同期ベータ', '情報']);
    expect(toc().getAllByRole('button').map((b) => b.querySelector('.settings-toc-s')!.textContent)).toEqual(['確認中', '確認中', '要修正 2', '確認中', '確認中', '同期オフ', '確認中']);
    // ベータの小札はクラウド同期の名前の横だけで、状態の段は潰さない。
    expect(toc().getAllByRole('button').map((b) => b.querySelector('.tag-beta')?.textContent ?? null)).toEqual([null, null, null, null, null, 'ベータ', null]);
    // 要修正は注意の色で言う。
    expect(toc().getByRole('button', { name: '連携、要修正 2' }).querySelector('.settings-toc-s')).toHaveAttribute('data-tone', 'warn');
  });
  it('読み上げの名前は、節の名前と状態を含む', () => {
    render(ui(settingsProps()));
    expect(toc().getByRole('button', { name: 'クラウド同期、同期オフ' })).toBeInTheDocument();
  });
  it('右は選んだ節だけを出す。開いている節が灯り、見出しは節の名前', () => {
    render(ui(at('tools')));
    expect(toc().getByRole('button', { name: /^ツール/ })).toHaveAttribute('aria-current', 'page');
    expect(toc().getByRole('button', { name: /^一般/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('group', { name: /^ツール/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^ツール/ })).toBeInTheDocument();
    // ほかの節の中身は描かない。
    expect(screen.queryByRole('switch', { name: '通知を有効にする' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'MCP サーバー' })).toBeNull();
    expect(screen.queryByLabelText('LM Studio の URL')).toBeNull();
  });
  it('別の節の行を押すと、その節の URL（at）へ移る。いま開いている節の行は押しても動かない', () => {
    const onAction = vi.fn();
    render(ui(at('general'), onAction));
    fireEvent.click(toc().getByRole('button', { name: /^クラウド同期/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'cloud' } });
    onAction.mockClear();
    fireEvent.click(toc().getByRole('button', { name: /^一般/ }));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('URL が変わった直後も、目次の灯りと右の節は同じに移る（前の節のまま残らない）', () => {
    const { rerender } = render(ui(at('general')));
    expect(toc().getByRole('button', { name: /^一般/ })).toHaveAttribute('aria-current', 'page');
    rerender(ui(at('cloud')));
    expect(toc().getByRole('button', { name: /^クラウド同期/ })).toHaveAttribute('aria-current', 'page');
    expect(toc().getByRole('button', { name: /^一般/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { level: 2, name: /^クラウド同期/ })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: '通知を有効にする' })).toBeNull();
    // 同じ節を指す別名（ヘッダーの at=sync）でも、presenter が選ぶ節は変わらない。
    const p = presentSettings({ ...initialState(), screen: { name: 'settings', at: 'sync' } }, initialStore());
    rerender(ui({ ...settingsProps(), ...p }));
    expect(toc().getByRole('button', { name: /^クラウド同期/ })).toHaveAttribute('aria-current', 'page');
  });
  it('ヘッダーの同期の語から来たとき（at=sync）、クラウド同期の節が開く', () => {
    const p = presentSettings({ ...initialState(), screen: { name: 'settings', at: 'sync' } }, initialStore());
    render(ui(p));
    expect(screen.getByRole('heading', { level: 2, name: /^クラウド同期/ })).toBeInTheDocument();
    expect(toc().getByRole('button', { name: /^クラウド同期/ })).toHaveAttribute('aria-current', 'page');
  });
  it('目次は上下の矢印で行を移り、開いている行だけが Tab の道に入る', () => {
    render(ui(at('tools')));
    const rows = toc().getAllByRole('button');
    expect(rows.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1', '-1', '-1', '-1']);
    rows[1]!.focus();
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2]!, { key: 'ArrowUp' });
    fireEvent.keyDown(rows[1]!, { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();
    // 端で止まる。
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0]!, { key: 'End' });
    expect(rows[6]).toHaveFocus();
  });
  it('節を切り替えたら、頁をスクロールする枠の先頭へ戻す', () => {
    const scrollTo = vi.fn();
    const main = document.createElement('div');
    main.className = 'main';
    main.scrollTo = scrollTo as never;
    document.body.append(main);
    try {
      const { rerender } = render(ui(at('general')), { container: main.appendChild(document.createElement('div')) });
      expect(scrollTo).not.toHaveBeenCalled();
      rerender(ui(at('info')));
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    } finally {
      main.remove();
    }
  });
  it('連携とツールの見出しに、直すものがあれば「要修正 N」の札を付ける', () => {
    const { rerender } = render(ui(at('integrations', { todo: { must: 0, link: 2 } })));
    expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).toHaveTextContent('要修正 2');
    rerender(ui(at('tools', { todo: { must: 1, link: 0 } })));
    expect(screen.getByRole('heading', { level: 2, name: /^ツール/ })).toHaveTextContent('要修正 1');
    rerender(ui(at('tools', { todo: { must: 0, link: 2 } })));
    expect(screen.getByRole('heading', { level: 2, name: /^ツール/ })).not.toHaveTextContent('要修正');
  });
});

describe('設定の一般', () => {
  it('言語の行は先頭に置き、押した瞬間に保存する（保存のボタンは無い）', () => {
    const onAction = vi.fn();
    render(ui(at('general'), onAction));
    const rows = [...document.querySelectorAll('.set-row-t')].map((e) => e.textContent);
    expect(rows[0]).toBe('言語');
    expect(screen.getByRole('radio', { name: '日本語' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { language: 'en' } });
  });
  it('一般には、通知、ターミナルアプリ、エディタ、トランスクリプトの保持、hangar が自分で行うことを置く', () => {
    render(ui(at('general', { retention: { days: 365, options: [{ value: '365', label: '1 年' }], writable: true, reason: null, valueLabel: '1 年', bar: null, syncNote: false } })));
    expect([...document.querySelectorAll('.set-row-t')].map((e) => e.textContent)).toEqual(['言語', '通知を有効にする', 'ターミナルアプリ', 'エディタ', 'トランスクリプトの保持', '停止したセッションを自動で Done にする', '長期間アクティビティの無いセッションも Done にする', 'Done と Archived にしたセッションを停止する']);
  });
  it('一般の末尾に「hangar が自分で行うこと」の 1 枚を置き、自動の Done と自動の停止をスイッチで切り替える', () => {
    const onAction = vi.fn();
    render(ui(at('general', { self: { autoDone: true, autoDoneIdleDays: 7, autoPark: false } }), onAction));
    const card = screen.getByRole('heading', { level: 3, name: 'hangar の自動処理' }).closest('section')!;
    expect([...card.querySelectorAll('.set-row-t')].map((e) => e.textContent)).toEqual(['停止したセッションを自動で Done にする', '長期間アクティビティの無いセッションも Done にする', 'Done と Archived にしたセッションを停止する']);
    expect(within(card).getByText('停止して 1 分たったセッションのうち、3 ターン以下のものと、要約が「完了」か「中止」のものを、自動で Done にします。一覧では ✦ のマークで見分けられます。再開して発言すると解除されます。')).toBeInTheDocument();
    expect(within(card).getByText('Done か Archived にしてアイドルになった Claude Code を、10 秒後に停止します。Paused は停止しません。停止したセッションは「再開」で続けられます。')).toBeInTheDocument();
    const done = screen.getByRole('switch', { name: '停止したセッションを自動で Done にする' });
    const park = screen.getByRole('switch', { name: 'Done と Archived にしたセッションを停止する' });
    expect(done).toHaveAttribute('aria-checked', 'true');
    expect(park).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(done);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { autoDone: false } });
    fireEvent.click(park);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { autoPark: true } });
  });
  it('長く動いていない会話の日数を 3・7・14・30 日としないから選び、自動の Done を切っている間は選べない', () => {
    const onAction = vi.fn();
    const { unmount } = render(ui(at('general', { self: { autoDone: true, autoDoneIdleDays: 7, autoPark: true } }), onAction));
    const group = screen.getByRole('radiogroup', { name: '長期間アクティビティの無いセッションも Done にする' });
    expect(within(group).getAllByRole('radio').map((e) => e.textContent)).toEqual(['3 日', '7 日', '14 日', '30 日', 'しない']);
    expect(within(group).getByRole('radio', { name: '7 日' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('停止してから選んだ日数のあいだ、アクティビティの無いセッションを Done にします。ターン数や要約は関係しません。')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: '14 日' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { autoDoneIdleDays: 14 } });
    fireEvent.click(within(group).getByRole('radio', { name: 'しない' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { autoDoneIdleDays: 0 } });
    unmount();
    render(ui(at('general', { self: { autoDone: false, autoDoneIdleDays: 7, autoPark: true } }), onAction));
    for (const r of within(screen.getByRole('radiogroup', { name: '長期間アクティビティの無いセッションも Done にする' })).getAllByRole('radio')) expect(r).toBeDisabled();
  });
  it('「通知を有効にする」のスイッチで切り替える', () => {
    const onAction = vi.fn();
    const { unmount } = render(ui(at('general'), onAction));
    fireEvent.click(screen.getByRole('switch', { name: '通知を有効にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'notify.set', on: true });
    unmount();
    render(ui(at('general', { notify: { available: true, on: true, blocked: false } }), onAction));
    fireEvent.click(screen.getByRole('switch', { name: '通知を有効にする' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'notify.set', on: false });
  });
  // まだ OS に尋ねていない間は、その旨と［許可する］を添える。押せば始める前の確認の行と同じ道で尋ねる（2026-10-13、9c）。
  it('まだ OS に許可を尋ねていなければ「まだ許可していません」と添え、［許可する］で尋ねる', () => {
    const onAction = vi.fn();
    render(ui(at('general', { notify: { available: true, on: true, blocked: false, ask: true } }), onAction));
    expect(screen.getByText(/まだ許可していません/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '許可する' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'notify.set', on: true });
  });
  it('尋ね終えていれば、その添え書きは出さない', () => {
    render(ui(at('general', { notify: { available: true, on: true, blocked: false } })));
    expect(screen.queryByText(/まだ許可していません/)).toBeNull();
    expect(screen.queryByRole('button', { name: '許可する' })).toBeNull();
  });
  it('OS で通知が切られていれば、システム設定で許可するよう添える。スイッチは入れ直せる', () => {
    render(ui(at('general', { notify: { available: true, on: false, blocked: true } })));
    expect(screen.getByRole('switch', { name: '通知を有効にする' })).not.toBeDisabled();
    expect(screen.getByText(/システム設定の「通知」で Hangar を許可してください/)).toBeInTheDocument();
    expect(screen.getByText(/通知がオフになっています/)).toBeInTheDocument();
  });
  it('Windows では、Windows の設定の「通知」で許可するよう添える', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    try {
      render(ui(at('general', { notify: { available: true, on: false, blocked: true } })));
      expect(screen.getByText(/Windows の設定の「通知」で Hangar を許可してください/)).toBeInTheDocument();
      expect(screen.queryByText(/システム設定/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('通知を出せない環境では、スイッチを押せなくして理由を添える', () => {
    render(ui(at('general', { notify: { available: false, on: false, blocked: false } })));
    expect(screen.getByRole('switch', { name: '通知を有効にする' })).toBeDisabled();
    expect(screen.getByText(/通知を表示できません/)).toBeInTheDocument();
  });
  it('ターミナルアプリは切り替えた時点で保存する', () => {
    const onAction = vi.fn();
    render(ui(at('general'), onAction));
    fireEvent.click(screen.getByRole('radio', { name: 'iTerm2' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { terminalApp: 'iterm' } });
  });
  it('ターミナルアプリの選択肢は presenter が渡したものだけを、同じ部品で出す', () => {
    const onAction = vi.fn();
    render(ui(at('general', { terminalApp: 'windowsTerminal', terminalOptions: [{ value: 'windowsTerminal', label: 'Windows Terminal' }, { value: 'windowsDefault', label: 'デフォルトのターミナル' }], terminalDesc: 'Windows Terminal が無いときはデフォルトのターミナルで開きます。' }), onAction));
    const group = screen.getByRole('radiogroup', { name: 'ターミナルアプリ' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Windows Terminal', 'デフォルトのターミナル']);
    expect(within(group).getByRole('radio', { name: 'Windows Terminal' })).toBeChecked();
    expect(screen.getByText('Windows Terminal が無いときはデフォルトのターミナルで開きます。')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: 'デフォルトのターミナル' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { terminalApp: 'windowsDefault' } });
  });
  describe('トランスクリプトの保持', () => {
    const bar = { nowLabel: 'いま 1.5 GB', projLabel: '10 年後に約 178 GB', freeLabel: '空き 400 GB', nowPct: 0.4, projPct: 44, warn: false };
    const retention = { days: 3650, options: [{ value: '30', label: '30 日' }, { value: '90', label: '90 日' }, { value: '365', label: '1 年' }, { value: '3650', label: '10 年' }], writable: true, reason: null, valueLabel: '10 年', bar, syncNote: true };
    it('切り替えの帯で選ぶと確認を開き、今の値を押しても何も出さない', () => {
      const onAction = vi.fn();
      render(ui(at('general', { retention }), onAction));
      expect(screen.getByText('トランスクリプトの保持')).toBeInTheDocument();
      expect(screen.getByText('10 年後に約 178 GB')).toBeInTheDocument();
      expect(screen.getByText(/値は設定の同期で他の PC にも反映されます/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: '1 年' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'retention.edit', days: 365, from: 'settings' });
      onAction.mockClear();
      fireEvent.click(screen.getByRole('radio', { name: '10 年' }));
      expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'retention.edit' }));
    });
    it('書けないときは帯を出さず、値と理由を出す', () => {
      render(ui(at('general', { retention: { ...retention, days: 14, writable: false, reason: '組織の設定で管理されています', valueLabel: '14 日' } })));
      expect(screen.queryByRole('radio', { name: '1 年' })).toBeNull();
      expect(screen.getByText(/組織の設定で管理されています/)).toBeInTheDocument();
    });
  });
});

describe('設定のクラウド同期', () => {
  it('節の頭に、上級者向けのベータであることと、始めるのに要るものを 1 文で置く（同期していてもいなくても）', () => {
    const lead = '上級者向けのベータ機能です。始めるには、リポジトリのクローン、ターミナルでの CLI の操作、自分の Cloudflare アカウントが必要です。';
    const { unmount } = render(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.getByText(lead)).toBeInTheDocument();
    unmount();
    render(ui(at('cloud')));
    expect(screen.getByText(lead)).toBeInTheDocument();
  });
  it('同期している人には、状態の札と、状態、操作、PC の一覧、設定の同期、使用量を上から並べる', () => {
    render(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.getByRole('heading', { level: 2, name: /^クラウド同期/ })).toHaveTextContent('同期済み');
    expect(screen.getByRole('heading', { level: 3, name: 'Claude Code の設定を同期' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'クラウドを作成して開始' })).toBeNull();
  });
  it('同期していない人には、1 文の説明と 2 つのボタンと、押せないスイッチの 1 行だけを出す', () => {
    render(ui(at('cloud', { cloud: cloudProps({ configured: false, url: null, state: 'off', stateLabel: '同期オフ', badge: { text: '同期オフ', tone: 'off' }, devices: [] }) })));
    expect(screen.getByRole('heading', { level: 2, name: /^クラウド同期/ })).toHaveTextContent('同期オフ');
    expect(screen.getByText(/この PC だけで使用しています/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'クラウドを作成して開始' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '参加トークンで参加' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'この PC で有効にする' })).toBeDisabled();
    expect(screen.getByText('クラウド同期を開始すると使えます')).toBeInTheDocument();
    // 同期の操作と使用量は出さない。
    for (const name of ['今すぐ同期', '同期を一時停止', '参加トークンを表示', '適用内容を確認']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('region', { name: 'クラウドの使用量と料金' })).toBeNull();
  });
  it('2 つのボタンは、押すとターミナルで打つコマンドを出す（クラウドの用意はアプリからはまだ行わない）', () => {
    render(ui(at('cloud', { cloud: cloudProps({ configured: false, url: null, state: 'off', devices: [] }) })));
    expect(screen.queryByText('npm run hangar -- setup cloud')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'クラウドを作成して開始' }));
    // クラウドの用意は wrangler が要るので、clone した場所で打つと添える。
    expect(screen.getByText('npm run hangar -- setup cloud')).toBeInTheDocument();
    expect(screen.getByText(/リポジトリをクローンして npm install したディレクトリで/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークンで参加' }));
    // 参加は入れた版の CLI でできる。
    expect(screen.getByText('/A/hangar join <token>')).toBeInTheDocument();
    expect(screen.queryByText('npm run hangar -- setup cloud')).toBeNull();
    expect(screen.queryByText(/clone して npm install した場所で/)).toBeNull();
  });
  it('クラウドの節: 参加トークンと、設定の同期のスイッチ（入れるときは送るものの一覧を開く）', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('cloud', { cloud: cloudProps(), configSync: configSyncProps({ needsCloud: false }) }), onAction));
    expect(screen.getByText('https://h.workers.dev')).toBeInTheDocument();
    expect(screen.getByText('未送信の変更 2 件')).toBeInTheDocument();
    expect(screen.getByText('mini')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークンを表示' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'sync.joinToken.show' });
    fireEvent.click(screen.getByRole('switch', { name: 'この PC で有効にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.open', part: 'send' });
    rerender(ui(at('cloud', { cloud: cloudProps({ joinToken: 'tok-abc' }), configSync: configSyncProps({ needsCloud: false, enabled: true }) }), onAction));
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.getByText(/全セッションを読み書きできます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークン をコピー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'tok-abc' });
    // 入っているスイッチを切るのは、その場で保存する。
    fireEvent.click(screen.getByRole('switch', { name: 'この PC で有効にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configBundleSync: false } });
  });
  it('状態の行は用語集の語で言い、未送信のトランスクリプトと、送信に失敗したトランスクリプトの一覧を出す', () => {
    const skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }];
    const { rerender } = render(ui(at('cloud', { cloud: cloudProps({ sweepPending: 1500, skipped }) })));
    expect(screen.getByText('状態 同期済み')).toBeInTheDocument();
    expect(screen.getByText('最終受信 1 分前')).toBeInTheDocument();
    expect(screen.getByText('未送信のトランスクリプト 1500 件')).toBeInTheDocument();
    expect(screen.getByText('送信に失敗したトランスクリプト 1 件。30 分ごとに再送します。')).toBeInTheDocument();
    expect(screen.getByText('transcripts/mini/u1.jsonl.gz: 復号できません（3 回）')).toBeInTheDocument();
    expect(screen.queryByText(/送れなかった本文/)).toBeNull();
    // 追いついた端末は 0 件と描く。数えられない端末は何も描かない。
    rerender(ui(at('cloud', { cloud: cloudProps({ sweepPending: 0, skipped: [] }) })));
    expect(screen.getByText('未送信のトランスクリプト 0 件')).toBeInTheDocument();
    expect(screen.queryByText(/送信に失敗したトランスクリプト/)).toBeNull();
    rerender(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.queryByText(/未送信のトランスクリプト/)).toBeNull();
  });
  it('今すぐ同期と一時停止の UiAction', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('cloud', { cloud: cloudProps() }), onAction));
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'sync.now' });
    fireEvent.click(screen.getByRole('button', { name: '同期を一時停止' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'sync.pause', paused: true });
    // 一時停止中は、同じボタンが再開になる。
    rerender(ui(at('cloud', { cloud: cloudProps({ state: 'paused', paused: true }) }), onAction));
    fireEvent.click(screen.getByRole('button', { name: '同期を再開' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'sync.pause', paused: false });
  });
  it('上限で退いている間は、状態の札を止まった色で言い、今すぐ同期だけを出す', () => {
    const onAction = vi.fn();
    render(ui(at('cloud', { cloud: cloudProps({ state: 'paused', paused: false, limited: true, stateLabel: '無料枠で停止 · 9:00 にリセット', badge: { text: '無料枠で停止', tone: 'stop' } }) }), onAction));
    expect(screen.getByText('状態 無料枠で停止 · 9:00 にリセット')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^クラウド同期/ }).querySelector('.badge')).toHaveAttribute('data-tone', 'stop');
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'sync.now' });
    expect(screen.queryByRole('button', { name: '同期を一時停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同期を再開' })).toBeNull();
  });
  it('一時停止中に版で止まっている間は、切り替えを出さず、今すぐ同期だけを出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('cloud', { cloud: cloudProps({ state: 'error', paused: true, stateLabel: '一時停止中 · 同期エラー' }) }), onAction));
    expect(screen.getByText('状態 一時停止中 · 同期エラー')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'sync.now' });
    expect(screen.queryByRole('button', { name: '同期を一時停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同期を再開' })).toBeNull();
    // 一時停止していない版のエラーは、今までどおり切り替えを出す。
    rerender(ui(at('cloud', { cloud: cloudProps({ state: 'error', paused: false, stateLabel: '同期エラー' }) }), onAction));
    expect(screen.getByRole('button', { name: '同期を一時停止' })).toBeInTheDocument();
  });
  it('1 回だけ同期している最中は、今すぐ同期を押せない姿にする', () => {
    render(ui(at('cloud', { cloud: cloudProps({ state: 'paused', paused: true, once: true, stateLabel: '1 回だけ同期中…' }) })));
    expect(screen.getByText('状態 1 回だけ同期中…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
    expect(screen.getByRole('button', { name: '同期中…' })).toBeDisabled();
  });
  it('参加トークンは押すまで出さず、消えたら表示のボタンに戻る', () => {
    // 全セッションの読み書き権を持つ秘密なので、画面に出したままにしない。
    // ランタイムが 120 秒で store から消すので、props が null に戻ったらボタンの姿に戻る。
    const { rerender } = render(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.queryByText('tok-abc')).toBeNull();
    rerender(ui(at('cloud', { cloud: cloudProps({ joinToken: 'tok-abc' }) })));
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '参加トークンを表示' })).toBeNull();
    expect(screen.getByText(/1Password などに保存してください/)).toBeInTheDocument();
    rerender(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.queryByText('tok-abc')).toBeNull();
    expect(screen.getByRole('button', { name: '参加トークンを表示' })).toBeInTheDocument();
  });
  it('参加トークンの下に、減る棒と「あと N 秒で消えます」を出す（設定の E2）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      render(ui(at('cloud', { cloud: cloudProps({ joinToken: 'tok-abc', joinTokenExpiresAt: 1_000_000 + 30_000 }) })));
      expect(screen.getByText(/^あと 30 秒で非表示になります/)).toBeInTheDocument();
      const bar = screen.getByRole('progressbar', { name: '参加トークンの表示の残り時間' });
      expect(bar).toHaveAttribute('aria-valuenow', '30');
      expect(bar).not.toHaveAttribute('data-low');
      act(() => { vi.advanceTimersByTime(21_000); });
      expect(screen.getByText(/^あと 9 秒で非表示になります/)).toBeInTheDocument();
      expect(bar).toHaveAttribute('data-low', 'true');
    } finally {
      vi.useRealTimers();
    }
  });
  it('同期している PC の一覧で、自分の PC に印を付ける', () => {
    render(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.getByText('この PC', { selector: '.list .faint' })).toBeInTheDocument();
  });
  it('同じ名前の端末が並んでも React の key が重ならない', () => {
    // 1 台の Mac で 2 端末を模すと、名前も最終確認も揃う（final-review の中 5）。
    // 一意なのは端末 ID だけなので、key はそこから取る。
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const devices = [
      { id: 'dev-a', name: 'MacBook-Pro.local', platform: 'darwin', lastSeen: '6 分前', self: true },
      { id: 'dev-b', name: 'MacBook-Pro.local', platform: 'darwin', lastSeen: '6 分前', self: false },
    ];
    render(ui(at('cloud', { cloud: cloudProps({ devices }) })));
    expect(screen.getAllByText('darwin')).toHaveLength(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    warn.mockRestore();
  });
  it('月の予算の行は置かない', () => {
    render(ui(at('cloud', { cloud: cloudProps() })));
    expect(screen.queryByText(/月の予算/)).toBeNull();
  });
});

describe('設定の連携', () => {
  it('互換、MCP サーバー、ステータスライン、シェル連携、アカウントの順に並べ、通知は置かない', () => {
    render(ui(at('integrations')));
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.replace(/(登録済み|未登録|設定済み|未設定|インストール済み|この PC は.*|確認中…|問題なし)$/, ''))).toEqual(['Claude Code との互換性', 'hangar が起動する Claude Code に追加する設定', 'MCP サーバー', 'ステータスライン', 'シェル連携', 'アカウント']);
    expect(screen.queryByRole('switch', { name: '通知を有効にする' })).toBeNull();
  });
  it('アカウントの節は「連携」の中に出し、1 件でも出す', () => {
    const one = presentAccounts({ ...initialStore(), accounts: { ...accountsFixture, accounts: accountsFixture.accounts.slice(0, 1) } }, 0);
    render(ui(at('integrations', { accounts: { list: one, colors: ACCOUNT_COLORS } })));
    const link = screen.getByRole('group', { name: /^連携/ });
    expect(within(link).getByRole('heading', { level: 3, name: 'アカウント' })).toBeInTheDocument();
    expect(within(document.getElementById('settings-accounts')!).getAllByRole('listitem')).toHaveLength(1);
  });
  it('アカウントがまだ届いていなければ、節を出さない', () => {
    render(ui(at('integrations', { accounts: { list: [], colors: ACCOUNT_COLORS } })));
    expect(screen.queryByRole('heading', { level: 3, name: 'アカウント' })).toBeNull();
  });
  it('アカウントの設定から来たとき（focus が accounts）、アカウントが見える位置へ滑る', () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      render(ui(at('integrations', { focus: 'accounts' })));
      expect(scrolled).toEqual(['settings-accounts']);
      expect(toc().getByRole('button', { name: /^連携/ })).toHaveAttribute('aria-current', 'page');
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
  it('帯から来たとき（focus が tmux など）、その欄を淡い黄で目立たせて、入力欄へフォーカスを置く', () => {
    for (const [focus, label] of [['tmux', 'tmux のパス'], ['claude', 'claude のパス'], ['workspace', '新しいディレクトリの作成先（任意）']] as const) {
      const { unmount } = render(ui(at('tools', { focus })));
      const input = screen.getByLabelText(label);
      expect(input.closest('.field')).toHaveAttribute('data-hit');
      expect(input).toHaveFocus();
      expect(document.querySelectorAll('[data-hit]')).toHaveLength(1);
      unmount();
    }
  });
  it('互換の節を指して来たとき（focus が compat）は、その節を目立たせる（入力欄が無いのでフォーカスは動かさない）', () => {
    render(ui(at('integrations', { focus: 'compat' })));
    expect(document.getElementById('settings-compat')).toHaveAttribute('data-hit');
    expect(document.body).toHaveFocus();
  });
  it('欄を指さずに開いたツールの節は、どの欄も目立たせない', () => {
    render(ui(at('tools')));
    expect(document.querySelector('[data-hit]')).toBeNull();
  });
  it('focus が無ければ、開いても滑らない', () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      render(ui(at('integrations')));
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
  it('MCP の登録を札で出す', () => {
    const { rerender } = render(ui(at('integrations', { mcpRegistered: true })));
    const mcp = () => within(screen.getByRole('heading', { name: /^MCP/ }).closest('section')!);
    expect(mcp().getByText('登録済み')).toBeInTheDocument();
    rerender(ui(at('integrations', { mcpRegistered: false })));
    expect(mcp().getByText('未登録')).toBeInTheDocument();
  });
  it('MCP の登録のコマンドは hangar の呼び方でそろえ、押せばコピーする', () => {
    const onAction = vi.fn();
    render(ui(at('integrations'), onAction));
    expect(screen.getByText('hangar mcp install')).toBeInTheDocument();
    expect(screen.getByText('hangar statusline install')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'hangar mcp install をコピー' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'clipboard.copy', text: 'hangar mcp install' });
  });
  describe('ステータスライン', () => {
    it('状態と設定のコマンドを出す', () => {
      render(ui(at('integrations')));
      // スクリプトはあるが hangar の数行が無い、と言う。「設定されていません」だけだと、ステータスライン自体が無いと読める（0.4.0-rc.1 の Windows の実機）。
      expect(screen.getByText('ステータスラインのスクリプトはありますが、hangar へ値を渡す数行がまだ追加されていません。')).toBeTruthy();
      expect(screen.queryByText('まだ設定されていません')).toBeNull();
      expect(screen.getByText('hangar statusline install')).toBeTruthy();
      expect(screen.getByText('/h/.claude/statusline.sh')).toBeTruthy();
      // ヘッダーのゲージは使用率で、追記はターミナルで行う。
      expect(screen.getByText('ヘッダーの使用率のゲージには、ステータスラインのスクリプトに追加する数行が必要です。')).toBeTruthy();
      // ブラウザでは書き込まず、その旨とコマンドを出す（D9）。
      expect(screen.getAllByText(/ブラウザで開いた画面からは変更できません/).length).toBeGreaterThan(0);
    });
    it('案内にポートの指定を添える', () => {
      // 4177 以外で動いているサーバに、4177 宛てのスニペットを追記させない。
      render(ui(at('integrations')));
      expect(screen.getByText('サーバが 4177 以外のポートで実行中の場合は、--port <番号> を付けてください。')).toBeTruthy();
    });
    it('設定済みならそう出す', () => {
      render(ui(at('integrations', { statusline: { command: 'bash x', scriptPath: '/h/x', installed: true } })));
      expect(screen.getByText('設定済みです')).toBeTruthy();
    });
    it('設定が無いときは案内を出す', () => {
      render(ui(at('integrations', { statusline: { command: null, scriptPath: null, installed: false } })));
      expect(screen.getByText('ステータスラインの設定が見つかりません')).toBeTruthy();
    });
    it('まだ届いていなければ読み込み中を出す', () => {
      render(ui(at('integrations', { statusline: null })));
      expect(screen.getByText('読み込み中…')).toBeTruthy();
    });
  });
  describe('シェル連携', () => {
    const shell = (over: Partial<SettingsProps['shell']>) => ({ ...settingsProps().shell, ...over });
    it('PC ごとの状態を並べ、入っていない PC には貼るコマンドを出す。書き換えるボタンは持たない', () => {
      render(ui(at('integrations', { shell: shell({ devices: [{ id: 'd', name: 'mac', self: true, state: 'off', label: '未インストール' }, { id: 'd2', name: 'mini', self: false, state: 'on', label: 'インストール済み' }] }) })));
      const section = screen.getByRole('heading', { name: /^シェル連携/ }).closest('section')!;
      expect(within(section).getByText('mini')).toBeInTheDocument();
      expect(within(section).getByText('インストール済み')).toBeInTheDocument();
      expect(within(section).getByText('未インストール')).toBeInTheDocument();
      expect(within(section).getByText('この PC')).toBeInTheDocument();
      expect(within(section).getByText('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install')).toBeInTheDocument();
      // 押せるのはコマンドのコピーだけで、~/.zshrc を書き換えるボタンは持たない。
      expect(within(section).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install をコピー']);
      expect(within(section).queryByRole('checkbox')).toBeNull();
    });
    it('入っている PC では外し方を、使えない PC では直し方を出す', () => {
      const { rerender } = render(ui(at('integrations', { shell: shell({ state: 'on' }) })));
      expect(screen.getByText(/shell uninstall/)).toBeInTheDocument();
      expect(screen.queryByText(/shell install$/)).toBeNull();
      rerender(ui(at('integrations', { shell: shell({ state: 'unsupported' }) })));
      expect(screen.getByText(/brew install tmux/)).toBeInTheDocument();
    });
    it('この OS で包みを使えないとき（Windows）は、節ごと出さない', () => {
      render(ui(at('integrations', { shell: shell({ state: 'unsupported', available: false }) })));
      expect(screen.queryByRole('heading', { name: /^シェル連携/ })).toBeNull();
      expect(screen.queryByText(/shell install/)).toBeNull();
      expect(screen.getByRole('heading', { name: /^ステータスライン/ })).toBeInTheDocument();
    });
  });
  describe('殻の中の連携（ボタンで殻に頼む）', () => {
    const desktop = (over: Partial<SettingsProps['integrations']> = {}) => at('integrations', { integrations: integrationsProps({ desktop: true, ...over }) });
    const card = (name: RegExp) => within(screen.getByRole('heading', { name }).closest('section')!);
    it('書き込む先とバックアップの添え書きをボタンの横に出し、押すと殻に頼む。コマンドは「ターミナルで行うとき」に畳む', () => {
      const onAction = vi.fn();
      render(ui(desktop(), onAction));
      const mcp = card(/^MCP/);
      expect(mcp.getByText('書き込み先：/h/.claude.json')).toBeInTheDocument();
      expect(mcp.getByText('変更前にバックアップを作成します')).toBeInTheDocument();
      fireEvent.click(mcp.getByRole('button', { name: '登録…' }));
      expect(onAction).toHaveBeenLastCalledWith({ type: 'setup.run', target: 'mcp-install' });
      expect(mcp.getByText('ターミナルで実行する場合').closest('details')).not.toBeNull();
      expect(mcp.getByText('hangar mcp install').closest('details')).not.toBeNull();
      expect(mcp.queryByText(/ブラウザで開いた画面/)).toBeNull();
      fireEvent.click(card(/^ステータスライン/).getByRole('button', { name: '設定…' }));
      expect(onAction).toHaveBeenLastCalledWith({ type: 'setup.run', target: 'statusline-install' });
      fireEvent.click(card(/^シェル連携/).getByRole('button', { name: 'インストール…' }));
      expect(onAction).toHaveBeenLastCalledWith({ type: 'setup.run', target: 'shell-install' });
    });
    it('返事を待つあいだは「確認中…」にして押せなくし、スクリプトが無ければ押せない', () => {
      render(ui(desktop({
        mcp: { file: '/h/.claude.json', action: { target: 'mcp-install', label: '確認中…', primary: true, disabled: true, running: true }, command: 'hangar mcp install' },
        statusline: { file: null, action: { target: 'statusline-install', label: '設定…', primary: true, disabled: true, running: false }, command: 'hangar statusline install' },
      })));
      expect(card(/^MCP/).getByRole('button', { name: '確認中…' })).toBeDisabled();
      expect(card(/^ステータスライン/).getByRole('button', { name: '設定…' })).toBeDisabled();
      expect(card(/^ステータスライン/).queryByText(/書き込む先/)).toBeNull();
    });
    it('入っていれば解除のボタンを出し、tmux が無ければボタンを出さない', () => {
      const { rerender } = render(ui(desktop({ shell: { file: '/Users/me/.zshrc', action: { target: 'shell-uninstall', label: 'アンインストール…', primary: false, disabled: false, running: false }, command: 'x shell uninstall' } })));
      expect(card(/^シェル連携/).getByRole('button', { name: 'アンインストール…' })).toBeInTheDocument();
      rerender(ui({ ...desktop(), shell: { ...settingsProps().shell, state: 'unsupported' } }));
      expect(card(/^シェル連携/).queryByRole('button', { name: /インストール/ })).toBeNull();
      expect(screen.getByText(/brew install tmux/)).toBeInTheDocument();
    });
  });
  describe('Claude Code との互換（C2）', () => {
    const when = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
    const DETAIL: CompatDto = {
      verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
        { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: when(7, 14, 2), lastSeenAt: when(7, 14, 9) },
        { contract: 'registry', value: 'status=compacting', version: '2.1.300', count: 5, firstSeenAt: when(7, 13, 40), lastSeenAt: when(7, 14, 5) },
        { contract: 'transcript', value: 'system.subtype=turn_summary', version: '2.1.298', count: 9, firstSeenAt: when(6, 22, 15), lastSeenAt: when(7, 14, 1) },
      ],
    };
    const DRIFT = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
    /** 互換の節。見出しの名前には右端の札の文も入る。 */
    const section = () => screen.getByRole('heading', { level: 3, name: /^Claude Code との互換/ }).closest('section')!;
    it('連携の先頭に節を置く', () => {
      render(ui(at('integrations')));
      const link = screen.getByRole('group', { name: /^連携/ });
      expect(within(link).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(/^Claude Code との互換/);
    });
    it('準備の確かめが届く前は、本文の下に「確かめています」と出し、札は出さない', () => {
      render(ui(at('integrations', { compat: null })));
      expect(within(section()).getByText('確認中…')).toBeInTheDocument();
      expect(section()).toHaveTextContent('hangar は Claude Code のトランスクリプト、状態のファイル、ステータスライン、~/.claude の内容、CLI の出力、画面出力を読み取ります。未知の形式を検出すると、ここに表示します。');
    });
    it('問題なしは緑の札で、手元の版と確かめた版を出す', () => {
      render(ui(at('integrations', { compat: presentCompat(translator('ja'), { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 }, null, '') })));
      expect(within(section()).getByText('問題なし')).toHaveAttribute('data-tone', 'ok');
      expect(section()).toHaveTextContent('インストール済みのバージョン 2.1.292');
      expect(section()).toHaveTextContent('検証済みのバージョン 2.1.292');
      expect(within(section()).queryByRole('list', { name: '無効にした機能' })).toBeNull();
    });
    it('未確認の版は灰色の札で、版の並びに止めていないことを添える', () => {
      render(ui(at('integrations', { compat: presentCompat(translator('ja'), { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 }, null, '') })));
      expect(within(section()).getByText('未検証のバージョン')).toHaveAttribute('data-tone', 'info');
      expect(section()).toHaveTextContent('インストール済みのバージョン 2.1.300');
      expect(within(section()).getByText('未検証のバージョンです。無効にした機能はありません')).toBeInTheDocument();
    });
    it('ずれは注意の札で、止めた機能の一覧を常に出し、細目は畳む。表の下に置き場と報告用に写す', () => {
      const onAction = vi.fn();
      const c = presentCompat(translator('ja'), DRIFT, DETAIL, '0.3.0');
      render(ui(at('integrations', { compat: c }), onAction));
      const sec = within(section());
      expect(sec.getByText('変更点 3 件')).toHaveAttribute('data-tone', 'warn');
      expect(sec.getByText('未知の形式に依存する機能だけを無効にしています。その他の機能は使えます。')).toBeInTheDocument();
      expect(within(sec.getByRole('list', { name: '無効にした機能' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ターンの目次からターミナルの指示へのジャンプを無効にしています', 'アイドルのセッションの自動停止を無効にしています']);
      const more = sec.getByText('変更点 3 件の詳細').closest('details')!;
      expect(more).not.toHaveAttribute('open');
      expect(within(more).getAllByRole('row')).toHaveLength(4);
      expect(within(more).getByText('~/.agent-hangar/compat.json')).toBeInTheDocument();
      fireEvent.click(within(more).getByRole('button', { name: 'レポートをコピー' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: c.report });
    });
    it('ずれはあっても止めた機能が無ければ、一覧を出さず、記録だけだと言う', () => {
      const only: CompatDto = { ...DETAIL, drifts: [{ contract: 'cli', value: 'subcommand.added=newcmd', version: null, count: 1, firstSeenAt: when(7, 9, 0), lastSeenAt: when(7, 9, 0) }] };
      render(ui(at('integrations', { compat: presentCompat(translator('ja'), { ...DRIFT, driftCount: 1 }, only, '') })));
      expect(within(section()).getByText('変更点 1 件')).toHaveAttribute('data-tone', 'warn');
      expect(within(section()).getByText('未知の形式を記録しました。無効にした機能はありません。')).toBeInTheDocument();
      expect(within(section()).queryByRole('list', { name: '無効にした機能' })).toBeNull();
      expect(within(section()).getByText('変更点 1 件の詳細')).toBeInTheDocument();
    });
    it('ずれがあっても、見出しの「要修正」は灯さない', () => {
      render(ui(at('integrations', { compat: presentCompat(translator('ja'), DRIFT, DETAIL, ''), todo: { must: 0, link: 0 } })));
      expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).not.toHaveTextContent('要修正');
    });
  });
});

describe('設定の連携の末尾の「Claude Code に環境を見てもらう」の札', () => {
  const guide = { prompt: '~/.agent-hangar/setup-guide.md（v0.7.0 sha256:3f9a1c2e）を読んで、私の環境を診断して。書き換えは私が承諾してから', version: '0.7.0' };
  const card = () => screen.getByRole('heading', { name: /Claude Code で環境を診断/ }).closest('section') as HTMLElement;

  it('連携の節の最後の札に、題、版の札、説明、貼る一言をそのまま見せる', () => {
    const { container } = render(ui(at('integrations', { setupGuide: guide })));
    const c = card();
    const sections = container.querySelectorAll('.settings-group > section');
    expect(sections[sections.length - 1]).toBe(c);
    expect(within(c).getByText('v0.7.0')).toBeInTheDocument();
    expect(within(c).getByText('このプロンプトを Claude Code に貼り付けると、環境を読み取り専用で診断し、散らばったセッションのディレクトリの登録や連携を提案します。変更は承諾を得てから行います。')).toBeInTheDocument();
    expect(within(c).getByText(guide.prompt).tagName).toBe('CODE');
    expect(within(c).getByText(/ディレクトリの移動や削除はしません。CLAUDE\.md も変更しません。/)).toBeInTheDocument();
  });

  it('「コピー」は一言を clipboard.copy で渡し、写せたら「コピーしました」に替わる（ブラウザでも押せる）', () => {
    const onAction = vi.fn();
    const props = at('integrations', { setupGuide: guide });
    const view = render(<ActionRoot onAction={onAction}><CopiedContext.Provider value={null}><SettingsScreen {...props} /></CopiedContext.Provider></ActionRoot>);
    const button = within(card()).getByRole('button', { name: 'コピー' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: guide.prompt });
    act(() => view.rerender(<ActionRoot onAction={onAction}><CopiedContext.Provider value={{ text: guide.prompt, n: 1 }}><SettingsScreen {...props} /></CopiedContext.Provider></ActionRoot>));
    expect(within(card()).getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
  });

  it('「手引きの中身を見る」は写した md をエディタで開く', () => {
    const onAction = vi.fn();
    render(ui(at('integrations', { setupGuide: guide }), onAction));
    fireEvent.click(within(card()).getByRole('button', { name: 'セットアップのすゝめを表示' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'setupGuide.openEditor' });
  });

  it('写しが取れていなければ札を出さない', () => {
    render(ui(at('integrations', { setupGuide: null })));
    expect(screen.queryByRole('heading', { name: /Claude Code で環境を診断/ })).toBeNull();
  });
});

describe('設定の連携の「足すもの」（1e）', () => {
  it('3 つを行にし、切れない 2 つに「常に」を添え、2 つのスイッチは追記の行の中に置く', () => {
    render(ui(at('integrations')));
    const box = screen.getByRole('region', { name: 'hangar が起動する Claude Code に追加する設定' });
    expect(within(box).getByText('hangar から起動・再開した Claude Code にだけ追加します。ターミナルから直接 Claude Code を起動した場合は追加しません。')).toBeInTheDocument();
    const items = within(box).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.add-t')?.textContent)).toEqual(['MCP の設定', '入力待ちと許可を受け取る hook', 'システムプロンプトの追記']);
    expect(within(items[0]!).getByText('常に')).toBeInTheDocument();
    expect(within(items[1]!).getByText('常に')).toBeInTheDocument();
    expect(within(items[2]!).queryByText('常に')).toBeNull();
    expect(within(items[2]!).getByRole('switch', { name: '作業の区切りで Done／Paused を確認する' })).toHaveAttribute('aria-checked', 'true');
    expect(within(items[2]!).getByRole('switch', { name: 'ターンの意図と操作の短い説明を送る' })).toHaveAttribute('aria-checked', 'true');
    expect(within(box).getByText('変更した設定は、次に起動・再開したセッションから有効になります。')).toBeInTheDocument();
  });
  it('スイッチは切り替えた時点で、その 1 項目だけを保存する', () => {
    const onAction = vi.fn();
    render(ui(at('integrations'), onAction));
    fireEvent.click(screen.getByRole('switch', { name: '作業の区切りで Done／Paused を確認する' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { askStatusAtEnd: false } });
    fireEvent.click(screen.getByRole('switch', { name: 'ターンの意図と操作の短い説明を送る' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { liveHints: false } });
  });
  it('既定のモデルは一覧から選んで保存し、「Claude Code の既定」は null を送る。一覧に無い名前も打って使える', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('integrations'), onAction));
    expect(screen.getByRole('button', { name: 'デフォルトのモデル' })).toHaveTextContent('Claude Code のデフォルト');
    pick('デフォルトのモデル', 'sonnet');
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { defaultModel: 'sonnet' } });
    rerender(ui(at('integrations', { injection: { ...settingsProps().injection, defaultModel: 'sonnet' } }), onAction));
    expect(screen.getByRole('button', { name: 'デフォルトのモデル' })).toHaveTextContent('sonnet');
    pick('デフォルトのモデル', 'Claude Code のデフォルト');
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { defaultModel: null } });
    fireEvent.click(screen.getByRole('button', { name: 'デフォルトのモデル' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-opus-4-1' } });
    fireEvent.click(screen.getByRole('option', { name: '「claude-opus-4-1」を使う' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { defaultModel: 'claude-opus-4-1' } });
  });
  it('全文の畳みは、段落の名前を添え、切った段落は打ち消し線で残し、差し込む値は印にする', () => {
    const full = presentInjection(translator('ja'), { askStatusAtEnd: true, liveHints: false });
    render(ui(at('integrations', { injection: { askStatusAtEnd: true, liveHints: false, defaultModel: null, full } })));
    const details = screen.getByText('追加する指示の全文を表示').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('追加する指示の全文を表示'));
    expect(within(details).getByText('基本（常に）')).toBeInTheDocument();
    expect(within(details).getByText('作業の区切りで Done／Paused を確認する（オン）')).toBeInTheDocument();
    expect(within(details).getByText('ターンの意図と操作の短い説明を送る（オフ・追加しません）')).toBeInTheDocument();
    expect(details.querySelectorAll('.inject-off')).toHaveLength(1);
    expect(details.querySelector('.inject-off')).toHaveTextContent('set_turn_intent');
    expect([...details.querySelectorAll('.inject-part')[0]!.querySelectorAll('.inject-token')].map((e) => e.textContent)).toEqual(['プロジェクト名', 'パス', 'TODO の一覧']);
    // PC をまたぐ 2 段は、同期を使っているときだけ足すことを名前の横の印で言う。
    expect(within(details).getByText('他の PC で進めたセッションを再開したとき')).toBeInTheDocument();
    expect([...details.querySelectorAll('.inject-mark')].map((e) => e.textContent)).toEqual(['同期を使っているときだけ', '同期を使っているときだけ']);
  });
});

describe('設定の要約エンジンの選択（2a）', () => {
  it('使わない、Claude、OpenAI 互換の URL の 3 つのラジオを並べ、選んだ時点で保存する', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { summaryEngine: 'off' }), onAction));
    const group = screen.getByRole('radiogroup', { name: '要約エンジン' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.querySelector('.editor-choice-name')?.textContent)).toEqual(['使わない', 'Claude', 'OpenAI 互換の URL']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    // 大事な違い（使用枠を使う、宛先へ送る）は、選ぶ前に各行の説明で読める。
    expect(radios[1]).toHaveTextContent('Claude の使用量を消費します。');
    expect(radios[2]).toHaveTextContent('トランスクリプトをこの宛先へ送ります。');
    fireEvent.click(radios[1]!);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { summaryEngine: 'claude' } });
  });
  it('使わないときは、欄も保存も接続テストも出さない', () => {
    render(ui(at('summary', { summaryEngine: 'off' })));
    expect(screen.queryByLabelText('URL')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: '接続テスト' })).toBeNull();
    expect(screen.getByText('終了したセッションの要約を作成するエンジンです。セッションの中で Claude が書く要約は、どれを選んでも表示されます。')).toBeInTheDocument();
  });
  it('Claude を選んだら、モデルと 1 時間の上限を出し、保存はその 2 つを送る。URL の欄は出さない', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { summaryEngine: 'claude' }), onAction));
    expect(screen.queryByLabelText('URL')).toBeNull();
    expect(screen.getByRole('button', { name: '要約に使う Claude のモデル' })).toHaveTextContent('haiku');
    expect(screen.getByText('要約には、そのセッションのアカウントを使います。')).toBeInTheDocument();
    pick('要約に使う Claude のモデル', 'sonnet');
    fireEvent.change(screen.getByLabelText('Claude での要約の 1 時間あたりの上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { summaryClaudeModel: 'sonnet', summaryHourlyCap: 5 }, field: 'summarizer' });
  });
  it('OpenAI 互換は、選んだ行に接続の札を出し、API キーは書いたときだけ送る', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { summarizerModels: ['gemma'] }), onAction));
    const openai = screen.getAllByRole('radio')[2]!;
    expect(openai).toHaveTextContent('接続済み');
    const key = screen.getByLabelText('API キー（任意）') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.placeholder).toBe('必要なサーバのみ');
    fireEvent.change(key, { target: { value: ' sk-local ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryHourlyCap: 20, summaryApiKey: 'sk-local' }, field: 'summarizer' });
    // 書いたキーは欄に残さない。
    expect(key).toHaveValue('');
  });
  it('保存済みの API キーは中身を出さず、消すボタンで null を送る', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { summaryApiKeySet: true }), onAction));
    expect((screen.getByLabelText('API キー（任意）') as HTMLInputElement).placeholder).toBe('保存済み。変更する場合だけ入力します');
    fireEvent.click(screen.getByRole('button', { name: 'キーを削除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { summaryApiKey: null } });
  });
  it('OpenAI 互換で切り替えを切っているときは、1 時間の上限を出さない', () => {
    render(ui(at('summary', { summaryFallback: false })));
    expect(screen.queryByLabelText('Claude での要約の 1 時間あたりの上限')).toBeNull();
    expect(screen.getByRole('switch', { name: '接続できないときは Claude を使う' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('設定の要約エンジン', () => {
  it('要約エンジンの URL とモデルと上限を保存する', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { summarizerModels: ['qwen', 'gemma'] }), onAction));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://127.0.0.1:2345' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 }, field: 'summarizer' });
    pick('モデル', 'qwen');
    fireEvent.change(screen.getByLabelText('Claude での要約の 1 時間あたりの上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: 'qwen', summaryHourlyCap: 5 }, field: 'summarizer' });
  });
  it('2 欄も、サーバが整えた後の値で見比べる', () => {
    // サーバは URL の前後の空白と末尾の / を落とし、モデル名も trim する。
    // 整える前の値で見比べると、落とされた結果が元と同じでも props が動かず、
    // 欄には整える前の文字列が残り、ボタンは押せたままになる（実測で何度でも押せた）。
    const onAction = vi.fn();
    render(ui(at('summary'), onAction));
    const url = screen.getByLabelText('URL');
    const save = screen.getByRole('button', { name: '保存' });
    for (const same of ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234///', '  http://127.0.0.1:1234  ']) {
      fireEvent.change(url, { target: { value: same } });
      expect(save).toBeDisabled();
    }
    // 本物の変更は今までどおり送れる。送る値はサーバが保存する形にそろえる。
    fireEvent.change(url, { target: { value: '  http://127.0.0.1:2345/  ' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 }, field: 'summarizer' });
    // 欄も整えた形に直しておく。整える前の文字列が残ると、押せない理由が読めない。
    expect(url).toHaveValue('http://127.0.0.1:2345');
  });
  it('上限だけを変えても保存は押せる。スイッチは保存の対象に入らない', () => {
    render(ui(at('summary')));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: '接続できないときは Claude を使う' }));
    expect(save).toBeDisabled();
    // 読めない上限も「変えた」に入れる。押せないと案内を出す道が無くなる。
    fireEvent.change(screen.getByLabelText('Claude での要約の 1 時間あたりの上限'), { target: { value: '' } });
    expect(save).toBeEnabled();
  });
  it('スイッチは切り替えた時点で、その 1 項目だけを保存する', () => {
    const onAction = vi.fn();
    render(ui(at('summary'), onAction));
    fireEvent.click(screen.getByRole('switch', { name: '接続できないときは Claude を使う' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { summaryFallback: false } });
  });
  it('1 時間あたりの上限は − と ＋ でも変えられる', () => {
    render(ui(at('summary')));
    fireEvent.click(screen.getByRole('button', { name: 'Claude での要約の 1 時間あたりの上限を増やす' }));
    expect(screen.getByLabelText('Claude での要約の 1 時間あたりの上限')).toHaveValue(21);
  });
  it('外部の要約エンジンを許可するときは、保存済みの宛先を示して確かめる', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { lmStudioUrl: 'https://summarizer.example.com' }), onAction));
    const sw = screen.getByRole('switch', { name: '外部の要約エンジンを許可' });
    // 見える文も読み上げと同じにし、何が起きるかを淡い 1 行で添える。
    expect(sw.closest('.set-row')).toHaveTextContent(/^外部の要約エンジンを許可/);
    expect(screen.getByText('127.0.0.1 と localhost 以外の宛先へトランスクリプトを送信できるようにします。')).toBeInTheDocument();
    fireEvent.click(sw);
    // まだ保存しない。スイッチもオフのまま。
    expect(onAction).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/https:\/\/summarizer\.example\.com へ送信されます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByText(/へ送られます/)).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: '許可' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { allowExternalSummarizer: true } });
  });
  it('確かめの帯が開くと、キャンセルへフォーカスが移り、閉じるとスイッチへ戻る', () => {
    render(ui(at('summary')));
    const sw = screen.getByRole('switch', { name: '外部の要約エンジンを許可' });
    fireEvent.click(sw);
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(sw).toHaveFocus();
  });
  it('許可で閉じたときも、フォーカスはスイッチへ戻る', () => {
    render(ui(at('summary')));
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約エンジンを許可' }));
    fireEvent.click(screen.getByRole('button', { name: '許可' }));
    expect(screen.getByRole('switch', { name: '外部の要約エンジンを許可' })).toHaveFocus();
  });
  it('保存済みのモデルが一覧に無くても、顔にその名前を出す', () => {
    render(ui(at('summary', { lmStudioModel: 'qwen', summarizerModels: [] })));
    expect(screen.getByRole('button', { name: 'モデル' })).toHaveTextContent('qwen');
  });
  it('確かめの宛先は、書きかけの URL ではなく保存済みの URL', () => {
    render(ui(at('summary', { lmStudioUrl: 'http://127.0.0.1:1234' })));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://other.example.com' } });
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約エンジンを許可' }));
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:1234 へ送信されます/)).toBeInTheDocument();
  });
  it('外部の要約エンジンを不許可にするときは確かめずに保存し、許可の間は警告を出す', () => {
    const onAction = vi.fn();
    render(ui(at('summary', { allowExternalSummarizer: true, lmStudioUrl: 'https://summarizer.example.com' }), onAction));
    expect(screen.getByRole('switch', { name: '外部の要約エンジンを許可' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('トランスクリプト');
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約エンジンを許可' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { allowExternalSummarizer: false } });
  });
  it('1 時間あたりの上限は 1 以上 200 以下の整数の入力欄である', () => {
    render(ui(at('summary')));
    const cap = screen.getByLabelText('Claude での要約の 1 時間あたりの上限') as HTMLInputElement;
    expect(cap.type).toBe('number');
    expect(cap.min).toBe('1');
    expect(cap.max).toBe('200');
    expect(cap.step).toBe('1');
  });
  it('上限が整数でなければ保存せず案内を出す', () => {
    const onAction = vi.fn();
    render(ui(at('summary'), onAction));
    const cap = screen.getByLabelText('Claude での要約の 1 時間あたりの上限');
    // 上限の案内は、ヘッダーのゲージの見出しと同じ「週」で言う。
    expect(screen.getByText('1 から 200 まで。週の使用率が 80% を超えた場合は作成しません。')).toBeTruthy();
    // 空は 0 に、文字は NaN になってしまうので、送る前に弾く。
    for (const bad of ['', '0', '-3', '1.5', '201']) {
      fireEvent.change(cap, { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      expect(onAction).not.toHaveBeenCalled();
      expect(screen.getByText('1 から 200 までの整数を入力してください')).toBeTruthy();
    }
    fireEvent.change(cap, { target: { value: '12' } });
    expect(screen.queryByText('1 から 200 までの整数を入力してください')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryHourlyCap: 12 }, field: 'summarizer' });
  });
  it('モデルの一覧の状態を出し分ける', () => {
    const { rerender } = render(ui(at('summary', { summarizerModels: null })));
    expect(screen.getByText('読み込み中…')).toBeTruthy();
    rerender(ui(at('summary', { summarizerModels: [] })));
    // 欄の下の 1 行と、選んだ行の札の両方で言う。
    expect(screen.getAllByText('接続できません')).toHaveLength(2);
    rerender(ui(at('summary', { summarizerModels: ['a', 'b'] })));
    expect(screen.getAllByText('接続済み')).toHaveLength(2);
    expect(screen.getByText('（モデル 2 個）')).toBeTruthy();
  });
  it('接続テストをすると summarizer.test を出し、結果を出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('summary'), onAction));
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'summarizer.test' });
    rerender(ui(at('summary', { summarizerTest: { ok: true, id: 'lmstudio', ms: 820, summary: { title: '題', oneLiner: '1 文', body: '本文', state: 'done', nextSteps: [], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: 'gemma', basedOnTurns: 3 } } }), onAction));
    expect(screen.getByText('OpenAI 互換の URL で成功しました（820 ミリ秒）')).toBeTruthy();
    expect(screen.getByText('1 文')).toBeTruthy();
    rerender(ui(at('summary', { summarizerTest: { ok: false, tried: [{ id: 'lmstudio', message: 'ECONNREFUSED' }, { id: 'claude-headless', message: '上限に達しています' }] } }), onAction));
    expect(screen.getByText('OpenAI 互換の URL: ECONNREFUSED')).toBeTruthy();
    expect(screen.getByText('Claude: 上限に達しています')).toBeTruthy();
  });
});

describe('設定のツール', () => {
  it('新しいフォルダの作成場所は欄を出たら保存し、欄の名前を添える', () => {
    const onAction = vi.fn();
    render(ui(at('tools'), onAction));
    expect(screen.getByRole('heading', { level: 3, name: '新しいディレクトリの作成先（任意）' })).toBeInTheDocument();
    typeAndLeave('新しいディレクトリの作成先（任意）', '/w2');
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { workspaceRoot: '/w2' }, field: 'workspaceRoot' });
  });
  // 作成場所は任意（2026-10-13、試作の 4 節 3a の案 A）。空なら検証の行を出さず、欄の中の薄い文で振る舞いを言う。
  it('作成場所は空にでき、空なら検証の行を出さず、作るたびに場所を選ぶと欄の中で言う', () => {
    const onAction = vi.fn();
    render(ui(at('tools', { workspaceRoot: '', verify: { workspace: null, tmux: null, claude: null, node: null, git: null } }), onAction));
    const field = screen.getByLabelText('新しいディレクトリの作成先（任意）');
    expect(field).toHaveAttribute('placeholder', '空の場合は、作成するたびにディレクトリを選択します');
    expect(field.closest('.path-field')!.querySelector('.verify')).toBeNull();
    expect(screen.getByText('「新しいプロジェクト」でディレクトリを作成する親ディレクトリです。直下にある、Claude Code を使ったことのあるディレクトリは、自動でプロジェクトに登録します。')).toBeInTheDocument();
  });
  it('作成場所を空にすると、空の文字を送る', () => {
    const onAction = vi.fn();
    render(ui(at('tools'), onAction));
    typeAndLeave('新しいディレクトリの作成先（任意）', '');
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { workspaceRoot: '' }, field: 'workspaceRoot' });
  });
  it('「プロジェクトの登録」から、まとめて登録のダイアログを 2 つの見方で開く', () => {
    const onAction = vi.fn();
    render(ui(at('tools'), onAction));
    expect(screen.getByText('プロジェクトの登録')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code を使ったディレクトリから…' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.candidates.open' });
    fireEvent.click(screen.getByRole('button', { name: 'ディレクトリの中から…' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.candidates.open', source: 'folder' });
  });
  it('デスクトップでは作成場所の「選ぶ…」で Finder を開き、選んだ場所を保存する。ブラウザでは出さない', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('tools', { workspacePick: { desktop: true, picked: { path: '/old', n: 3 } } }), onAction));
    fireEvent.click(screen.getByRole('button', { name: '選択…、新しいディレクトリの作成先（任意）' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'folder.pick' });
    rerender(ui(at('tools', { workspacePick: { desktop: true, picked: { path: '/Users/me/src', n: 4 } } }), onAction));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { workspaceRoot: '/Users/me/src' }, field: 'workspaceRoot' });
    rerender(ui(at('tools', { workspacePick: { desktop: false, picked: null } }), onAction));
    expect(screen.queryByRole('button', { name: '選択…、新しいディレクトリの作成先（任意）' })).toBeNull();
  });
  it('パスの欄には保存のボタンが無い', () => {
    render(ui(at('tools')));
    for (const name of ['保存', 'ツールの設定を保存', 'Node のパスを保存']) expect(screen.queryByRole('button', { name })).toBeNull();
  });
  it('ツールには、親フォルダと 3 つのパスと git の読むだけの行を置く（ターミナルアプリとエディタは一般にある）', () => {
    render(ui(at('tools')));
    expect(screen.getAllByRole('textbox').map((e) => e.getAttribute('aria-label'))).toEqual(['新しいディレクトリの作成先（任意）', 'tmux のパス', 'claude のパス', 'Node のパス']);
    expect(document.getElementById('settings-field-git')).not.toBeNull();
    expect(screen.queryByRole('radio', { name: 'iTerm2' })).toBeNull();
  });
  it('Node のパスの例と探す順の説明は、画面の OS の形で出す', () => {
    const { unmount } = render(ui(at('tools')));
    expect(screen.getByRole('textbox', { name: 'Node のパス' })).toHaveAttribute('placeholder', '/opt/homebrew/bin/node');
    expect(screen.getByText(/空の場合は \/opt\/homebrew\/bin\/node/)).toBeInTheDocument();
    unmount();
    setClientUserAgent(WINDOWS_UA);
    render(ui(at('tools')));
    expect(screen.getByRole('textbox', { name: 'Node のパス' })).toHaveAttribute('placeholder', 'C:\\Program Files\\nodejs\\node.exe');
    expect(screen.getByText(/空の場合は C:\\Program Files\\nodejs\\node\.exe/)).toBeInTheDocument();
    expect(screen.queryByText(/homebrew/)).toBeNull();
  });
  it('Node のパスを保存でき、空なら null を送る', () => {
    const onAction = vi.fn();
    render(ui(at('tools', { nodePath: '/opt/homebrew/bin/node' }), onAction));
    typeAndLeave('Node のパス', '/opt/node22/bin/node');
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { nodePath: '/opt/node22/bin/node' }, field: 'nodePath' });
    // 空白だけにするのは「指定を消す」なので、指定が入っていた PC では変更である。
    typeAndLeave('Node のパス', '  ');
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { nodePath: null }, field: 'nodePath' });
  });
  it('変えずに欄を出ても送らない。前後の空白だけの違いも変更にしない', () => {
    // 同じ値でも送ると、workspaceRoot ではプロジェクトの登録し直しが走る。
    const onAction = vi.fn();
    render(ui(at('tools', { nodePath: '/opt/homebrew/bin/node', claudePath: '/usr/local/bin/claude' }), onAction));
    for (const label of ['新しいディレクトリの作成先（任意）', 'tmux のパス', 'claude のパス', 'Node のパス']) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.blur(field);
      typeAndLeave(label, ` ${field.value} `);
    }
    expect(onAction).not.toHaveBeenCalled();
    // 空白を足しただけの欄は、保存済みの値に戻す。
    expect(screen.getByLabelText('claude のパス')).toHaveValue('/usr/local/bin/claude');
  });
  it('Enter でも保存し、日本語入力の確定の Enter では保存しない', () => {
    const onAction = vi.fn();
    render(ui(at('tools'), onAction));
    const field = screen.getByLabelText('claude のパス');
    fireEvent.change(field, { target: { value: '/usr/local/bin/claude' } });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { claudePath: '/usr/local/bin/claude' }, field: 'claudePath' });
  });
  it('保存できたら欄の横に「✓ 保存しました」を 2 秒出し、保存し直すたびに出し直す', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(ui(at('tools')));
      const tick = () => within(screen.getByLabelText('tmux のパス').closest('.inrow') as HTMLElement).queryByText('保存しました');
      expect(tick()).toBeNull();
      rerender(ui(at('tools', { save: { tmuxPath: { kind: 'saved', n: 1 } } })));
      expect(tick()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(tick()).toBeNull();
      rerender(ui(at('tools', { save: { tmuxPath: { kind: 'saved', n: 2 } } })));
      expect(tick()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('保存を断られたら、欄の下に理由を出し、書いた値は欄に残す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(at('tools'), onAction));
    typeAndLeave('tmux のパス', '/nope/tmux');
    rerender(ui(at('tools', { save: { tmuxPath: { kind: 'error', message: '「tmux のパス」に /nope/tmux が見つかりません' } } }), onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('「tmux のパス」に /nope/tmux が見つかりません');
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('/nope/tmux');
  });
  it('欄の下に、見つかったパスと版、または直し方を出す（B1）', () => {
    const verify = {
      workspace: { ok: true, soft: false, text: '/w', note: 'プロジェクト 12 件', fix: null, fixCommand: null },
      tmux: { ok: false, soft: false, text: '見つかりません', note: null, fix: null, fixCommand: 'brew install tmux' },
      claude: { ok: true, soft: false, text: '/Users/me/.local/bin/claude', note: '2.3.1', fix: null, fixCommand: null },
      node: null,
      git: { ok: false, soft: true, text: '見つかりません', note: 'なくても動作します', fix: 'git をインストールしてください。git がなくても動作しますが、ブランチと未コミットの件数は表示されません', fixCommand: 'xcode-select --install' },
    };
    const onAction = vi.fn();
    render(ui(at('tools', { verify }), onAction));
    const under = (label: string) => screen.getByLabelText(label).closest('.path-field')!.querySelector('.verify')!;
    expect(under('新しいディレクトリの作成先（任意）')).toHaveTextContent('/w（プロジェクト 12 件）');
    expect(under('claude のパス')).toHaveTextContent('/Users/me/.local/bin/claude（2.3.1）');
    expect(under('tmux のパス')).toHaveTextContent('見つかりません');
    expect(under('tmux のパス')).toHaveAttribute('data-tone', 'ng');
    // git は設定の欄が無いので、読むだけの行に出す。
    const git = document.getElementById('settings-field-git')!.querySelector('.verify')!;
    expect(git).toHaveAttribute('data-tone', 'soft');
    expect(git).toHaveTextContent('なくても動作します');
    expect(git).toHaveTextContent('xcode-select --install');
    expect(under('Node のパス')).toHaveTextContent('確認中…');
    fireEvent.click(screen.getByRole('button', { name: 'brew install tmux をコピー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'brew install tmux' });
  });
  it('サーバが正規化した値に入力欄が追従する', () => {
    const { rerender } = render(ui(at('tools', { tmuxPath: 'tmux', claudePath: null, nodePath: '' })));
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('tmux');
    rerender(ui(at('tools', { workspaceRoot: '/w2', claudePath: '/Users/x/.local/bin/claude', nodePath: '/opt/homebrew/bin/node' })));
    expect(screen.getByLabelText('tmux のパス')).toHaveValue('/opt/homebrew/bin/tmux');
    expect(screen.getByLabelText('新しいディレクトリの作成先（任意）')).toHaveValue('/w2');
    expect(screen.getByLabelText('claude のパス')).toHaveValue('/Users/x/.local/bin/claude');
    expect(screen.getByLabelText('Node のパス')).toHaveValue('/opt/homebrew/bin/node');
  });
  it('claude のパスを保存する', () => {
    // .app から起こすと PATH で claude を引けない。欄が無いと、起動が 400 で断られたまま直せない。
    const onAction = vi.fn();
    render(ui(at('tools'), onAction));
    typeAndLeave('claude のパス', ' /Users/x/.local/bin/claude ');
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { claudePath: '/Users/x/.local/bin/claude' }, field: 'claudePath' });
  });
});

describe('設定の情報', () => {
  it('使用量の 2 つの表を出す', () => {
    render(ui(at('info')));
    expect(screen.getByText('2026-09-18')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
  });
  it('トークンは期間のとおりでコストは走り全体の累計だと添える', () => {
    render(ui(at('info')));
    expect(screen.getByText('トークン数は指定の期間の値ですが、推定コストはそのセッション全体の累計です。')).toBeTruthy();
  });
  it('集計がまだ無ければ読み込み中を出す', () => {
    render(ui(at('info', { usageAggregate: null })));
    expect(screen.getByText('使用量を読み込み中…')).toBeTruthy();
  });
  it('索引の再構築と、この PC', () => {
    const onAction = vi.fn();
    render(ui(at('info', { version: '0.1.0' }), onAction));
    fireEvent.click(screen.getByRole('button', { name: 'インデックスを再構築' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'index.rebuild' });
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'この PC' })).toBeInTheDocument();
    expect(screen.getByText(/再起動後に反映されます/)).toBeInTheDocument();
    // 索引の文は presenter がヘッダーと同じ関数で作ったものをそのまま出す。
    expect(screen.getByText('3 セッション、2 プロジェクト')).toBeInTheDocument();
  });
});

describe('設定の読む面', () => {
  // settings.css の .settings-group > section が白い面を敷く。節が直下から外れると、面が消える。
  it('どの節の中身も、右の節の直下に並ぶ', () => {
    for (const id of IDS) {
      const { container, unmount } = render(ui(at(id, { cloud: cloudProps() })));
      const root = container.querySelector('.settings-screen')!;
      expect(root.querySelectorAll('.settings-group > section').length, id).toBe(root.querySelectorAll('section').length);
      expect(root.querySelectorAll('.settings-group > section').length, id).toBeGreaterThan(0);
      unmount();
    }
  });
});

// 段 6 の B3。ツールの節の先頭に、psmux（tmux）の状態の行を置く。
describe('設定のツールの psmux と tmux の行', () => {
  const missing = { name: 'psmux', windows: true, installed: false, version: null, path: null, command: 'winget install marlocarlo.psmux', checking: false, stillMissing: false, outdated: null };
  it('未インストールなら札と入れるコマンドと再確認を出す', () => {
    const onAction = vi.fn();
    render(ui(at('tools', { mux: missing }), onAction));
    const sec = within(screen.getByRole('region', { name: 'psmux' }));
    expect(sec.getByText('未インストール')).toBeInTheDocument();
    expect(sec.getByText('winget install marlocarlo.psmux')).toBeInTheDocument();
    fireEvent.click(sec.getByRole('button', { name: '再確認' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'mux.recheck' });
  });
  it('再確認しても無ければ一言添え、確かめている間は押せない', () => {
    const { unmount } = render(ui(at('tools', { mux: { ...missing, stillMissing: true } })));
    expect(screen.getByText('psmux がまだ見つかりません。インストール後に hangar の再起動が必要な場合があります')).toBeInTheDocument();
    unmount();
    render(ui(at('tools', { mux: { ...missing, checking: true } })));
    expect(screen.getByRole('button', { name: '確認中…' })).toBeDisabled();
  });
  it('インストール済みなら札と版とパスを出し、コマンドは出さない', () => {
    render(ui(at('tools', { mux: { ...missing, name: 'tmux', windows: false, installed: true, version: '3.4', path: '/opt/homebrew/bin/tmux', command: 'brew install tmux' } })));
    const sec = within(screen.getByRole('region', { name: 'tmux' }));
    expect(sec.getByText('インストール済み')).toBeInTheDocument();
    expect(sec.getByText('バージョン 3.4')).toBeInTheDocument();
    expect(sec.queryByText('brew install tmux')).toBeNull();
    expect(sec.getByRole('button', { name: '再確認' })).toBeEnabled();
  });
  // psmux 3.4.0 未満（issue #245）。上げ方の注意 2 点とコマンドを本文に出す（設定 A）。
  it('古い psmux なら「更新が必要」の札と、止まることと外の PowerShell の注意、上げるコマンド、再確認を出す', () => {
    const command = 'Get-Process psmux -ErrorAction SilentlyContinue | Stop-Process -Force; winget upgrade marlocarlo.psmux; tmux -V';
    const onAction = vi.fn();
    render(ui(at('tools', { mux: { ...missing, installed: true, version: '3.3.8', path: 'C:\\x\\psmux.exe', outdated: { min: '3.4.0', command } } }), onAction));
    const sec = within(screen.getByRole('region', { name: 'psmux' }));
    expect(sec.getByText('更新が必要')).toBeInTheDocument();
    expect(sec.queryByText('インストール済み')).toBeNull();
    expect(sec.getByText('バージョン 3.3.8（3.4.0 以上が必要です）')).toBeInTheDocument();
    expect(sec.getByText(/実行中のセッションはすべて停止します/)).toBeInTheDocument();
    expect(sec.getByText(/外部の PowerShell/)).toBeInTheDocument();
    expect(sec.getByText(command)).toBeInTheDocument();
    fireEvent.click(sec.getByRole('button', { name: '再確認' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'mux.recheck' });
  });
  it('準備の確かめが届く前は行を出さない', () => {
    render(ui(at('tools', { mux: null })));
    expect(screen.queryByRole('region', { name: 'psmux' })).toBeNull();
  });
});

describe('更新の節', () => {
  function mountAt(p: SettingsProps) {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SettingsScreen {...p} /></ActionRoot>);
    return onAction;
  }
  it('版と最終確認、見出しの札、更新を確認、知らせのスイッチを出す', () => {
    const onAction = mountAt(at('update'));
    const group = screen.getByRole('group', { name: /更新/ });
    expect(within(group).getByText('最新')).toBeInTheDocument();
    expect(within(group).getByText('バージョン 1.4.2')).toBeInTheDocument();
    expect(within(group).getByText('最終確認：5 分前')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: '更新を確認' }));
    fireEvent.click(within(group).getByRole('switch', { name: '更新を通知する' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'update.check' }], [{ type: 'update.notify', on: false }]]);
  });
  it('確認中はボタンを押せない', () => {
    mountAt(at('update', { update: updateProps({ version: { title: 'バージョン 1.4.2', sub: '確認中…', checkLabel: '確認中…', checkDisabled: true } }) }));
    expect(screen.getByRole('button', { name: '確認中…' })).toBeDisabled();
  });
  it('見つけた版の行に、題と説明と進みと操作を出す', () => {
    const onAction = mountAt(at('update', { update: updateProps({ pending: { title: 'Hangar 1.5.0 を利用できます', detail: '現在のバージョンは 1.4.2 です。', progress: null, actions: [{ label: 'ダウンロードしてインストール', action: { type: 'update.download' }, primary: true }] } }) }));
    expect(screen.getByText('Hangar 1.5.0 を利用できます')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ダウンロードしてインストール' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'update.download' });
  });
  it('取得中は進みの棒を出す', () => {
    mountAt(at('update', { update: updateProps({ pending: { title: 'Hangar 1.5.0', detail: null, progress: { percent: 40, label: '40%' }, actions: [] } }) }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });
  it('殻が updater を持たないときは、1 文だけを出す', () => {
    mountAt(at('update', { update: updateProps({ supported: false }) }));
    expect(screen.getByText('更新の確認はデスクトップアプリで行います。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更新を確認' })).toBeNull();
  });
});
