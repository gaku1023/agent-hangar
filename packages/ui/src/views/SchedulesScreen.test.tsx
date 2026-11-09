import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type CodexOptionsDto, type EventBindingDto, type PrClaimDto, type ScheduleDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { LaunchChoiceData } from '../presenters/newSession.ts';
import { eventMarker, nextLabel, presentSchedules, whenLabel, type SchedulesProps } from '../presenters/schedules.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture, codexAccountsFixture } from '../test/accounts.ts';
import { pick } from '../test/pick.ts';
import { SchedulesScreen } from './SchedulesScreen.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const t = translator('ja');
const NOW = new Date(2026, 10, 2, 8, 0).getTime();
const dto = (o: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: 'a', prompt: '依存を点検して', spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, target: { kind: 'new', projectId: 'p' },
  projectId: 'p', projectName: 'alpha', accountName: null, sessionTitle: null, enabled: true, nextAt: new Date(2026, 10, 2, 9, 0).getTime(),
  runs: [
    { id: 'r2', plannedAt: 2, startedAt: NOW - 60_000, endedAt: null, result: 'running', sessionId: 's2', sessionTitle: '点検 2', error: null },
    { id: 'r1', plannedAt: 1, startedAt: NOW - 3_600_000, endedAt: NOW - 3_600_000, result: 'skipped', sessionId: null, sessionTitle: null, error: null },
  ], ...o,
});
const proj = (id: string, name: string) => ({ id, name, status: 'active', isScratch: false, resolved: true, path: `/w/${name}`, lastActivityAt: null });
const CODEX: CodexOptionsDto = { version: '0.164.0', verified: true, fetchedAt: 1, models: [{ id: 'gpt-full', label: 'GPT Full', description: '何でも向き', efforts: [{ id: 'low', description: '' }, { id: 'medium', description: '' }, { id: 'high', description: '' }], defaultEffort: 'medium' }] };
/** 予定の画面を描く。launch で札の中身（Codex の有効、一覧、フォルダの問い合わせなど）を差し替える。 */
const mount = (list: ScheduleDto[], over: { launch?: Partial<LaunchChoiceData>; store?: Partial<ReturnType<typeof initialStore>> } = {}) => {
  const onAction = vi.fn();
  const store = { ...initialStore(), schedules: list, projects: { p: proj('p', 'alpha'), q: proj('q', 'beta') } as never, sessions: { s: { id: 's', projectId: 'p', name: '既存の会話A', lastTurnAt: 1 } } as never, ...over.store };
  const base = presentSchedules(store, t, NOW);
  const props: SchedulesProps = { ...base, launch: { ...base.launch, ...over.launch } };
  render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><SchedulesScreen {...props} /></ActionRoot></LanguageRoot>);
  return onAction;
};
const codexOn = { codex: { options: { status: 'ready' as const, data: CODEX } } };
const group = () => screen.getByRole('group', { name: '起動の設定' });
const chip = (name: string | RegExp) => within(group()).getByRole('button', { name });
const choose = (chipName: string, option: string | RegExp) => { fireEvent.click(chip(chipName)); fireEvent.click(screen.getByRole('option', { name: option })); };
const openNew = () => fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
const typePrompt = () => fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
const lastInput = (onAction: ReturnType<typeof vi.fn>) => (onAction.mock.calls.map((c) => c[0]).filter((a) => a.type === 'schedule.create' || a.type === 'schedule.update').at(-1) ?? null);
const FULL: ScheduleDto['target'] = { kind: 'new', projectId: 'p', name: '夜の点検', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', worktree: 'nightly', addDirs: ['/a', '/b'] };

describe('予定の言い方', () => {
  it('繰り返しと次の時刻', () => {
    expect(whenLabel(t, { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })).toBe('平日 9:00');
    expect(whenLabel(t, { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '18:30' })).toBe('毎日 18:30');
    expect(whenLabel(t, { kind: 'weekly', days: [0, 1], time: '08:00' })).toBe('月・日 8:00');
    expect(whenLabel(t, { kind: 'every', minutes: 30 })).toBe('30 分おき');
    expect(nextLabel(t, new Date(2026, 10, 2, 9, 5).getTime(), NOW)).toBe('今日 9:05');
    expect(nextLabel(t, new Date(2026, 10, 3, 9, 5).getTime(), NOW)).toBe('明日 9:05');
    expect(nextLabel(t, null, NOW)).toBe('');
  });
});

describe('予定の画面', () => {
  it('行に指示、繰り返し、次の時刻、直近の丸を出す', () => {
    mount([dto()]);
    expect(screen.getByRole('button', { name: '依存を点検して' })).toBeInTheDocument();
    expect(screen.getByText('平日 9:00')).toBeInTheDocument();
    expect(screen.getByText('今日 9:00')).toBeInTheDocument();
    expect(document.querySelectorAll('.sch-dots .sch-dot')).toHaveLength(2);
  });

  it('予定が無ければ空の案内を出す', () => {
    mount([]);
    expect(screen.getByText(t('schedules.list.empty'))).toBeInTheDocument();
  });

  it('スイッチで止める。行は開かない', () => {
    const onAction = mount([dto()]);
    fireEvent.click(screen.getByRole('switch'));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.update', id: 'a', patch: { enabled: false } }));
    expect(screen.queryByRole('button', { name: t('schedules.action.run') })).toBeNull();
  });

  it('行を開くと履歴と操作が出て、今すぐ実行を送る', () => {
    const onAction = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    expect(screen.getByRole('link', { name: '点検 2' })).toBeInTheDocument();
    expect(screen.getByText(t('schedules.result.skipped'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.run') }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.run', id: 'a' }));
  });

  it('削除はもう一度押して確かめる', async () => {
    const onAction = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.delete') }));
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.delete' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.deleteConfirm') }));
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.delete', id: 'a' })));
  });

  it('作成は指示が無いと押せず、入れれば送る', () => {
    const onAction = mount([]);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
    const create = screen.getByRole('button', { name: t('schedules.form.create') });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
    fireEvent.click(create);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'schedule.create',
      input: { prompt: '見て', spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, target: { kind: 'new', projectId: 'p' } },
    }));
  });

  it('既存の会話へ、N 分おきで作れる。下限より短いと押せない', () => {
    const onAction = mount([]);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.form.kind.every') }));
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.form.dest.session') }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: t('schedules.form.create') })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ input: { prompt: '見て', spec: { kind: 'every', minutes: 45 }, target: { kind: 'session', sessionId: 's' } } }));
  });

  it('流れ終わった 1 回だけの予定は再開できない', () => {
    mount([dto({ spec: { kind: 'once', at: NOW - 1 }, enabled: false, nextAt: null, runs: [] })]);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

describe('予定の起動設定（新しいセッションと同じ札）', () => {
  it('「新しい会話」でプロジェクト、モデル、effort、権限、worktree の札が出る。select は出ない', () => {
    mount([]);
    openNew();
    const names = within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title'));
    expect(names).toEqual(['プロジェクト', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
    expect(screen.queryByRole('combobox', { name: t('schedules.form.project') })).toBeNull();
  });

  it('Codex を有効にするとエージェントの札が出て、アカウントが 2 件あればアカウントの札が出る', () => {
    mount([], { launch: codexOn, store: { accounts: accountsFixture } });
    openNew();
    expect(chip('エージェント、Claude Code')).toBeInTheDocument();
    expect(chip('アカウント、会社')).toBeInTheDocument();
  });

  it('札でモデル、effort、権限、worktree を選んで作ると、その値が target に入る', () => {
    const onAction = mount([]);
    openNew();
    typePrompt();
    choose('モデル、デフォルト', 'sonnet');
    choose('effort レベル、デフォルト', 'high');
    choose('権限モード、デフォルト', 'Accept edits');
    fireEvent.click(chip('worktree、なし'));
    fireEvent.change(screen.getByRole('textbox', { name: 'worktree' }), { target: { value: 'nightly' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'worktree' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'p', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', worktree: 'nightly' });
  });

  it('worktree の札には、回ごとに日時が付くことを示す淡い添えが出る', () => {
    mount([]);
    openNew();
    expect(group().querySelector('.wt-suffix')).toBeNull();
    fireEvent.click(chip('worktree、なし'));
    fireEvent.change(screen.getByRole('textbox', { name: 'worktree' }), { target: { value: 'nightly' } });
    expect(group().querySelector('.wt-suffix')?.textContent).toBe(t('schedules.worktree.suffix'));
  });

  it('アカウントの札のある画面で作ると、選んだアカウントの id が target に入る', () => {
    const onAction = mount([], { store: { accounts: accountsFixture } });
    openNew();
    typePrompt();
    choose('アカウント、会社', '大学');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'p', account: 'a1' });
  });

  describe('既存の予定の編集で、アカウントは札に触れない限り元のまま', () => {
    const openEdit = () => {
      fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
      fireEvent.click(screen.getByRole('button', { name: t('schedules.action.edit') }));
    };
    const save = () => fireEvent.click(screen.getByRole('button', { name: t('schedules.form.save') }));

    it('アカウントの無い古い形の予定を、何も触らず保存しても、target にアカウントは付かない', () => {
      const onAction = mount([dto({ target: { kind: 'new', projectId: 'p', model: 'sonnet' } })], { store: { accounts: accountsFixture } });
      openEdit();
      save();
      expect(lastInput(onAction).patch.target).toEqual({ kind: 'new', projectId: 'p', model: 'sonnet' });
    });

    it('一覧から消えたアカウントの id の予定を、何も触らず保存しても、元の id のまま', () => {
      const onAction = mount([dto({ target: { kind: 'new', projectId: 'p', account: 'gone' } as ScheduleDto['target'] })], { store: { accounts: accountsFixture } });
      openEdit();
      save();
      expect(lastInput(onAction).patch.target).toEqual({ kind: 'new', projectId: 'p', account: 'gone' });
    });

    it('札でアカウントを選び直したら、選んだ id になる', () => {
      const onAction = mount([dto({ target: { kind: 'new', projectId: 'p', account: 'gone' } as ScheduleDto['target'] })], { store: { accounts: accountsFixture } });
      openEdit();
      choose('アカウント、会社', '大学');
      save();
      expect(lastInput(onAction).patch.target).toEqual({ kind: 'new', projectId: 'p', account: 'a1' });
    });
  });

  it('エージェントを Codex に替えて作ると、Claude Code だけの値は target に入らない', async () => {
    const onAction = mount([], { launch: codexOn });
    openNew();
    typePrompt();
    choose('モデル、デフォルト', 'sonnet');
    fireEvent.click(chip('worktree、なし'));
    fireEvent.change(screen.getByRole('textbox', { name: 'worktree' }), { target: { value: 'nightly' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'worktree' }), { key: 'Enter' });
    fireEvent.click(chip('エージェント、Claude Code'));
    fireEvent.click(await screen.findByRole('option', { name: /Codex/ }));
    await screen.findByRole('button', { name: 'エージェント、Codex' });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'p', agent: 'codex' });
  });

  it('Codex の権限をフルアクセスにすると、決めた値だけが入る', async () => {
    const onAction = mount([], { launch: codexOn });
    openNew();
    typePrompt();
    fireEvent.click(chip('エージェント、Claude Code'));
    fireEvent.click(await screen.findByRole('option', { name: /Codex/ }));
    await screen.findByRole('button', { name: 'エージェント、Codex' });
    choose('権限、自動', /フルアクセス/);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'p', agent: 'codex', permissionMode: 'full-access' });
  });

  it('権限が Bypass permissions のときは、作成のボタンが赤くなり、文言が替わる', () => {
    mount([]);
    openNew();
    expect(screen.getByRole('button', { name: t('schedules.form.create') })).toHaveClass('btn-primary');
    choose('権限モード、デフォルト', 'Bypass permissions');
    expect(screen.getByRole('button', { name: t('schedules.form.createBypass') })).toHaveClass('btn-danger-fill');
  });

  it('プロジェクトの札でクイックセッションを選ぶと、target は projectId なしの scratch になる', () => {
    const onAction = mount([]);
    openNew();
    typePrompt();
    pick('プロジェクト', 'クイックセッション');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: null, scratch: true });
  });

  it('プロジェクトの札は新しいセッションと同じ。別のプロジェクトも、検索で出る未登録のフォルダも選べ、フォルダは保存で登録する', () => {
    const onAction = mount([], { launch: { dirs: [{ name: 'url-short', path: '/w/url-short' }] } });
    openNew();
    typePrompt();
    pick('プロジェクト', 'beta');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'q' });
    onAction.mockClear();
    openNew();
    typePrompt();
    fireEvent.click(chip('プロジェクト'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'url' } });
    fireEvent.click(screen.getByRole('option', { name: 'url-short' }));
    expect(screen.getByText(t('schedules.dir.unregistered', { path: '/w/url-short' }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction)).toEqual({ type: 'schedule.create', input: { prompt: '見て', spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, target: { kind: 'new', projectId: '' } }, place: { kind: 'dir', path: '/w/url-short' } });
  });

  it('登録済みのプロジェクトの下のフォルダは、そのプロジェクトのまま cwd に入る（登録しない）', () => {
    const inspect = { path: '/w/alpha/sub', name: null, status: 'ready' as const, data: { path: '/w/alpha/sub', git: false, worktree: false, remote: null, registered: null, enclosing: { projectId: 'p', name: 'alpha', path: '/w/alpha', relative: 'sub' }, link: null } };
    const onAction = mount([], { launch: { inspect, dirs: [{ name: 'sub', path: '/w/alpha/sub' }] } });
    openNew();
    typePrompt();
    fireEvent.click(chip('プロジェクト'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sub' } });
    fireEvent.click(screen.getByRole('option', { name: 'sub' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'p', cwd: '/w/alpha/sub' });
    expect(lastInput(onAction).place).toBeUndefined();
  });

  it('既存の予定（全項目付き）を編集で開くと札に値が戻り、何も触らず保存した patch の target が元と同じ', () => {
    const onAction = mount([dto({ target: FULL })]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.edit') }));
    expect(chip('モデル、sonnet')).toBeInTheDocument();
    expect(chip('effort レベル、high')).toBeInTheDocument();
    expect(chip('権限モード、Accept edits')).toBeInTheDocument();
    expect(chip('worktree、nightly')).toBeInTheDocument();
    expect(chip('名前、夜の点検')).toBeInTheDocument();
    expect(chip('追加ディレクトリ、2 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.save') }));
    expect(lastInput(onAction)).toEqual({ type: 'schedule.update', id: 'a', patch: { prompt: '依存を点検して', spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, target: FULL } });
  });

  it.each([
    ['プロジェクトだけ', { kind: 'new', projectId: 'p' }],
    ['opencode の古い形', { kind: 'new', projectId: 'p', agent: 'opencode' }],
    ['Codex の古い形', { kind: 'new', projectId: 'p', agent: 'codex' }],
    ['クイックセッション', { kind: 'new', projectId: null, scratch: true }],
  ] as const)('古い形の予定（%s）を開いて保存し直しても、値が増えない', (_n, target) => {
    const onAction = mount([dto({ target: target as ScheduleDto['target'], projectId: target.projectId ?? null })], { launch: { ...codexOn, opencode: { options: null } } });
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.save') }));
    expect(lastInput(onAction).patch.target).toEqual(target);
  });

  it('Codex の予定を Claude Code に替えて保存すると、Codex の値は残らない', async () => {
    const onAction = mount([dto({ target: { kind: 'new', projectId: 'p', agent: 'codex', effort: 'high', permissionMode: 'read-only' } })], { launch: codexOn });
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.edit') }));
    expect(chip('権限、読み取りのみ')).toBeInTheDocument();
    fireEvent.click(chip('エージェント、Codex'));
    fireEvent.click(await screen.findByRole('option', { name: /Claude Code/ }));
    await screen.findByRole('button', { name: 'エージェント、Claude Code' });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.save') }));
    expect(lastInput(onAction).patch.target).toEqual({ kind: 'new', projectId: 'p' });
  });

  it('予定の詳細に、保存した起動設定を読み取り専用の札で並べる。未指定の項目は出さない。アカウントは表示名', () => {
    mount([dto({ target: { ...FULL, account: 'a1' } as ScheduleDto['target'], accountName: '大学' })]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    const chips = [...document.querySelectorAll('.sch-chips .sch-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['アカウント大学', 'モデルsonnet', 'effort レベルhigh', '権限モードAccept edits', `worktreenightly${t('schedules.worktree.suffix')}`, '追加ディレクトリ2 件', '名前夜の点検']);
    expect(document.querySelectorAll('.sch-chip button')).toHaveLength(0);
  });

  it('起動設定の無い予定の詳細には札の列を出さない。クイックセッションの予定は、プロジェクト名の代わりにその名前を出す', () => {
    mount([dto({ target: { kind: 'new', projectId: null, scratch: true }, projectId: null, projectName: null })]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    expect(document.querySelector('.sch-chips')).toBeNull();
    expect(screen.getByText(t('schedules.list.quick'))).toBeInTheDocument();
  });

  it('Bypass permissions の予定を編集すると、保存のボタンが赤い文言になる', () => {
    mount([dto({ target: { kind: 'new', projectId: 'p', permissionMode: 'bypassPermissions' } })]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.edit') }));
    expect(screen.getByRole('button', { name: t('schedules.form.saveBypass') })).toHaveClass('btn-danger-fill');
  });

  it('送り先を既存の会話に替えてから戻しても、札の値が残っている', () => {
    const onAction = mount([]);
    openNew();
    typePrompt();
    choose('モデル、デフォルト', 'opus');
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.form.dest.session') }));
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.form.dest.new') }));
    expect(chip('モデル、opus')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(lastInput(onAction).input.target).toEqual({ kind: 'new', projectId: 'p', model: 'opus' });
  });
});

describe('イベントの節（#563）', () => {
  const SYNC = { state: 'ok', revoked: false, workerCompat: 12 } as never;
  const bind = (o: Partial<EventBindingDto> = {}): EventBindingDto => ({
    id: 'e1', source: { kind: 'github', repo: 'o/r', when: ['ci_failed', 'merged'], labels: ['ci-fix'] }, action: { kind: 'new', projectId: 'p' }, prompt: '落ちた CI を直す',
    passBody: false, allowAuthors: [], state: 'active', hookUrl: null, createdAt: 1, expiresAt: null, runs: [], ...o,
  });
  const claim: PrClaimDto = { sessionId: 's', repo: 'o/r', pr: 9, claimedAt: 1, sessionTitle: '移植の会話' };
  type Form = ReturnType<typeof initialStore>['eventTrigger']['form'];
  const mountEvents = (bindings: EventBindingDto[] = [], claims: PrClaimDto[] = [], over: { sync?: unknown; form?: Partial<Form>; error?: { kind: 'no_admin' } | { kind: 'hook_failed' } | { kind: 'text'; text: string }; store?: Partial<ReturnType<typeof initialStore>> } = {}) => {
    const base = initialStore().eventTrigger;
    return mount([dto()], { store: { sync: ('sync' in over ? over.sync : SYNC) as never, eventTrigger: { ...base, ready: true, bindings, claims, error: over.error ?? null, form: { ...base.form, ...over.form } }, ...over.store } });
  };
  const events = () => screen.getByRole('region', { name: t('schedules.section.event') });
  const items = () => within(events()).getAllByRole('listitem');

  it('時刻とイベントを 2 つの見出しで分け、開いたときにイベントを読みに行く', () => {
    const onAction = mountEvents([bind()]);
    expect(screen.getByRole('heading', { name: t('schedules.section.time') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: t('schedules.section.event') })).toBeInTheDocument();
    expect(within(events()).getByRole('button', { name: '落ちた CI を直す' })).toBeInTheDocument();
    expect(within(events()).queryByRole('button', { name: '依存を点検して' })).toBeNull();
    expect(screen.getByRole('button', { name: '依存を点検して' })).toBeInTheDocument();
    expect(onAction.mock.calls.map((c) => c[0])).toContainEqual({ type: 'events.load' });
  });

  it('Worker の版が 12 に届かない、または同期を設定していないときは、節も種類のカードも出さず、読みにも行かない', () => {
    for (const sync of [{ state: 'ok', revoked: false, workerCompat: 11 }, { state: 'off', revoked: false, workerCompat: 12 }, null]) {
      const onAction = mountEvents([bind()], [], { sync });
      expect(screen.queryByRole('heading', { name: t('schedules.section.event') })).toBeNull();
      expect(screen.queryByRole('heading', { name: t('schedules.section.time') })).toBeNull();
      expect(onAction.mock.calls.map((c) => c[0]).some((a) => a.type === 'events.load')).toBe(false);
      openNew();
      expect(screen.queryByRole('radio', { name: t('schedules.event.kind.github') })).toBeNull();
      expect(screen.getByRole('textbox', { name: t('schedules.form.prompt') })).toBeInTheDocument();
      cleanup();
    }
  });

  it('承認待ちの下書きをイベントの頭に置き、承認で state を active にする依頼を出す', () => {
    const onAction = mountEvents([bind(), bind({ id: 'd1', state: 'draft', prompt: '下書きの指示' })]);
    const rows = items();
    expect(rows[0]).toHaveTextContent('下書きの指示');
    expect(within(rows[0]!).getByText(t('schedules.event.state.pending'))).toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: t('schedules.event.approve') }));
    expect(onAction).toHaveBeenCalledWith({ type: 'events.approve', id: 'd1' });
    fireEvent.click(within(rows[0]!).getByRole('button', { name: t('schedules.event.reject') }));
    expect(onAction).toHaveBeenCalledWith({ type: 'events.remove', id: 'd1' });
  });

  it('新しい会話の下書きは、承認の前に自動承認と権限モードを閉じたままで見せる', () => {
    mountEvents([bind({ id: 'd1', state: 'draft', action: { kind: 'new', projectId: 'p', autoApprove: true, permissionMode: 'bypassPermissions' } })]);
    const row = items()[0]!;
    expect(within(row).getByText(t('launch.chip.autoApprove'))).toBeInTheDocument();
    expect(within(row).getByText(t('launch.permission.label'))).toBeInTheDocument();
    expect(row.querySelector('.sch-chip[data-tone="danger"]')).not.toBeNull();
  });

  it('担当する PR の下書きは文と承認、却下を出し、押すと repo と PR を添えて答える', () => {
    const onAction = mountEvents([], [claim]);
    const row = items()[0]!;
    expect(row).toHaveTextContent('「移植の会話」が o/r の PR #9 を担当');
    fireEvent.click(within(row).getByRole('button', { name: t('schedules.event.approve') }));
    expect(onAction).toHaveBeenCalledWith({ type: 'events.claim', op: 'approve', sessionId: 's', repo: 'o/r', pr: 9 });
    fireEvent.click(within(row).getByRole('button', { name: t('schedules.event.reject') }));
    expect(onAction).toHaveBeenCalledWith({ type: 'events.claim', op: 'reject', sessionId: 's', repo: 'o/r', pr: 9 });
  });

  it('承認待ちの新しい会話は、プロジェクトとエージェントとアカウントの名前を承認の前に見せる', () => {
    mountEvents([bind({ id: 'd1', state: 'draft', action: { kind: 'new', projectId: 'p', agent: 'codex', account: 'cw' } }), bind({ id: 'd2', state: 'draft', action: { kind: 'new', projectId: null, scratch: true, account: 'a1' } }), bind({ id: 'd3', state: 'draft', action: { kind: 'new', projectId: 'p', account: 'gone' } })], [], { store: { accounts: codexAccountsFixture } });
    const [codex, quick, gone] = items();
    expect(codex).toHaveTextContent('プロジェクトalpha');
    expect(codex).toHaveTextContent('Codex');
    expect(codex).toHaveTextContent('会社用');
    expect(quick).toHaveTextContent(t('schedules.list.quick'));
    expect(quick).toHaveTextContent('Claude Code');
    expect(quick).toHaveTextContent('大学');
    expect(gone).toHaveTextContent('gone');
  });

  it('担当する PR の会話の題が無いときは、会話の id で言う', () => {
    mountEvents([], [{ ...claim, sessionTitle: null }]);
    expect(items()[0]).toHaveTextContent('「s」が o/r の PR #9 を担当');
  });

  it('webhook を付けられず理由の文も無いときは、決めた一文を出す', () => {
    mountEvents([], [], { form: { error: { kind: 'hook_failed' } as never } });
    openNew();
    pickKind('GitHub');
    typePrompt();
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.repo') }), { target: { value: 'o/r' } });
    fireEvent.click(within(whenGroup()).getByRole('button', { name: t('schedules.event.when.review') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(screen.getByRole('alert')).toHaveTextContent('webhook を登録できませんでした');
  });

  it('行が無くても、承認や削除の失敗の一文は節の頭に出す。時刻の見出しはイベントの節と並ぶときだけ', () => {
    mountEvents([], [], { error: { kind: 'text', text: 'イベントの設定が見つかりません' } });
    expect(events()).toHaveTextContent('イベントの設定が見つかりません');
    expect(screen.getByRole('heading', { name: t('schedules.section.time') })).toBeInTheDocument();
    cleanup();
    mountEvents([]);
    expect(screen.queryByRole('heading', { name: t('schedules.section.event') })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('schedules.section.time') })).toBeNull();
  });

  it('行を開くと動き、できごと、絞り込み、履歴を出し、削除は確かめてから頼む', async () => {
    const run = { id: 'x', plannedAt: 1, startedAt: NOW, endedAt: NOW, result: 'skipped' as const, sessionId: null, sessionTitle: null, error: 'held:hourly' };
    const onAction = mountEvents([bind({ state: 'held', runs: [run] })]);
    const row = items()[0]!;
    expect(within(row).getByText(t('schedules.event.state.held'))).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '落ちた CI を直す' }));
    expect(row).toHaveTextContent('GitHub · o/r');
    expect(row).toHaveTextContent(`${t('schedules.event.when.ciFailed')}、${t('schedules.event.when.merged')}`);
    expect(row).toHaveTextContent('ci-fix');
    expect(row).toHaveTextContent(t('schedules.event.action.new'));
    expect(row).toHaveTextContent(t('schedules.event.heldHourly', { max: 12 }));
    fireEvent.click(within(row).getByRole('button', { name: t('schedules.action.delete') }));
    expect(onAction.mock.calls.map((c) => c[0]).some((a) => a.type === 'events.remove')).toBe(false);
    fireEvent.click(within(row).getByRole('button', { name: t('schedules.action.deleteConfirm') }));
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'events.remove', id: 'e1' }));
  });

  it('止めた理由の文は、履歴の行にあるときは 1 度だけ出し、履歴に無いときは一文で伝える', () => {
    const run = { id: 'x', plannedAt: 1, startedAt: NOW, endedAt: NOW, result: 'skipped' as const, sessionId: null, sessionTitle: null, error: 'held:hourly' };
    const text = t('schedules.event.heldHourly', { max: 12 });
    const count = (el: HTMLElement) => (el.textContent ?? '').split(text).length - 1;
    mountEvents([bind({ state: 'held', runs: [run] })]);
    fireEvent.click(within(items()[0]!).getByRole('button', { name: '落ちた CI を直す' }));
    expect(count(items()[0]!)).toBe(1);
    cleanup();
    mountEvents([bind({ state: 'held', runs: [] })]);
    fireEvent.click(within(items()[0]!).getByRole('button', { name: '落ちた CI を直す' }));
    expect(count(items()[0]!)).toBe(1);
  });

  it('履歴の印を決めた言い方にする', () => {
    expect(eventMarker(t, 'rejected:signature x3')).toBe('署名エラー 3 件');
    expect(eventMarker(t, 'rejected:unparsable x2')).toBe('解析エラー 2 件');
    expect(eventMarker(t, 'dropped:5')).toBe('上限超過 5 件');
    expect(eventMarker(t, 'no_destination')).toBe('宛先なし');
    expect(eventMarker(t, 'held:hourly')).toBe('1 時間の上限（12 回）を超えたので止めました');
    expect(eventMarker(t, 'boom')).toBeNull();
    expect(eventMarker(t, null)).toBeNull();
  });

  it('作るときは先に種類のカードを選ぶ。時刻は今までの予定のフォームを開く', () => {
    mountEvents();
    openNew();
    const group = screen.getByRole('radiogroup', { name: t('schedules.action.new') });
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((c) => c.textContent)).toEqual(['時刻', 'GitHub', 'webhook']);
    expect(cards[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radiogroup', { name: t('schedules.form.kind') })).toBeInTheDocument();
  });

  const pickKind = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const createdEvent = (onAction: ReturnType<typeof vi.fn>) => onAction.mock.calls.map((c) => c[0]).filter((a) => a.type === 'events.create').at(-1);
  const whenGroup = () => screen.getByRole('group', { name: t('schedules.event.form.when') });

  it('GitHub: repo の形が正しく、できごとを選び、指示があるときだけ作れる。送る形は結び付けの入力になる', () => {
    const onAction = mountEvents();
    openNew();
    pickKind('GitHub');
    const create = screen.getByRole('button', { name: t('schedules.form.create') });
    typePrompt();
    expect(create).toBeDisabled();
    const repo = screen.getByRole('textbox', { name: t('schedules.event.form.repo') });
    fireEvent.change(repo, { target: { value: 'not a repo' } });
    expect(repo).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(repo, { target: { value: 'o/r' } });
    expect(repo).not.toHaveAttribute('aria-invalid', 'true');
    expect(create).toBeDisabled();
    fireEvent.click(within(whenGroup()).getByRole('button', { name: t('schedules.event.when.ciFailed') }));
    fireEvent.click(within(whenGroup()).getByRole('button', { name: t('schedules.event.when.merged') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.pr') }), { target: { value: '12' } });
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.labels') }), { target: { value: 'ci-fix, bug' } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(createdEvent(onAction).input).toEqual({
      source: { kind: 'github', repo: 'o/r', when: ['ci_failed', 'merged'], pr: 12, labels: ['ci-fix', 'bug'] },
      action: { kind: 'new', projectId: 'p' }, prompt: '見て', passBody: false, allowAuthors: [],
    });
  });

  it('GitHub: PR の番号と札は、正しくない綴りを絞り込み無しにせず、作れない入力にする', () => {
    mountEvents();
    openNew();
    pickKind('GitHub');
    typePrompt();
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.repo') }), { target: { value: 'o/r' } });
    fireEvent.click(within(whenGroup()).getByRole('button', { name: t('schedules.event.when.review') }));
    const create = screen.getByRole('button', { name: t('schedules.form.create') });
    const pr = screen.getByRole('textbox', { name: t('schedules.event.form.pr') });
    const labels = screen.getByRole('textbox', { name: t('schedules.event.form.labels') });
    expect(create).toBeEnabled();
    for (const bad of ['12a', '0', '012', '1 2', '12345678901']) {
      fireEvent.change(pr, { target: { value: bad } });
      expect(pr).toHaveAttribute('aria-invalid', 'true');
      expect(create).toBeDisabled();
    }
    fireEvent.change(pr, { target: { value: '' } });
    expect(pr).not.toHaveAttribute('aria-invalid', 'true');
    for (const bad of ['a,,b', 'a,', 'x'.repeat(51)]) {
      fireEvent.change(labels, { target: { value: bad } });
      expect(labels).toHaveAttribute('aria-invalid', 'true');
      expect(create).toBeDisabled();
    }
    fireEvent.change(labels, { target: { value: 'x'.repeat(50) } });
    expect(labels).not.toHaveAttribute('aria-invalid', 'true');
    expect(create).toBeEnabled();
  });

  it('GitHub: 動きは 3 つ（Paused を起こすは無い）。PR を出した会話と、会話に送る', () => {
    const onAction = mountEvents();
    openNew();
    pickKind('GitHub');
    const dest = screen.getByRole('radiogroup', { name: t('schedules.form.dest') });
    expect(within(dest).getAllByRole('radio').map((r) => r.textContent)).toEqual(['会話に送る', 'PR を出した会話', '新しい会話']);
    typePrompt();
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.repo') }), { target: { value: 'o/r' } });
    fireEvent.click(within(whenGroup()).getByRole('button', { name: t('schedules.event.when.review') }));
    fireEvent.click(within(dest).getByRole('radio', { name: t('schedules.event.action.sendPrOwner') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(createdEvent(onAction).input.action).toEqual({ kind: 'send_pr_owner' });
    fireEvent.click(within(dest).getByRole('radio', { name: t('schedules.event.action.send') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(createdEvent(onAction).input.action).toEqual({ kind: 'send', sessionId: 's' });
  });

  it('GitHub: 本文を含めると、ほかに含める人の欄が出て、入力が送る形に入る', () => {
    const onAction = mountEvents();
    openNew();
    pickKind('GitHub');
    expect(screen.queryByRole('textbox', { name: t('schedules.event.allowAuthors') })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: t('schedules.event.passBody') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.allowAuthors') }), { target: { value: 'alice, bob' } });
    typePrompt();
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.repo') }), { target: { value: 'o/r' } });
    fireEvent.click(within(whenGroup()).getByRole('button', { name: t('schedules.event.when.comment') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(createdEvent(onAction).input).toMatchObject({ passBody: true, allowAuthors: ['alice', 'bob'] });
  });

  it('webhook: できごとの欄は無く、指示と動きと本文だけで作れる。動きに PR を出した会話は無い', () => {
    const onAction = mountEvents();
    openNew();
    pickKind('webhook');
    expect(screen.queryByRole('textbox', { name: t('schedules.event.form.repo') })).toBeNull();
    const dest = screen.getByRole('radiogroup', { name: t('schedules.form.dest') });
    expect(within(dest).getAllByRole('radio').map((r) => r.textContent)).toEqual(['会話に送る', '新しい会話']);
    expect(screen.queryByRole('textbox', { name: t('schedules.event.allowAuthors') })).toBeNull();
    typePrompt();
    fireEvent.click(screen.getByRole('switch', { name: t('schedules.event.passBody') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(createdEvent(onAction).input).toEqual({ source: { kind: 'hook' }, action: { kind: 'new', projectId: 'p' }, prompt: '見て', passBody: true, allowAuthors: [] });
  });

  it('作れなかった理由はフォームの中に出し、権限なしは決めた一文、失敗はサーバの文にする。送る間は押せない', () => {
    mountEvents([], [], { form: { error: null, busy: true } });
    openNew();
    pickKind('webhook');
    typePrompt();
    expect(screen.getByRole('button', { name: t('schedules.form.create') })).toBeDisabled();
    cleanup();
    // 前に失敗して閉じたフォームを開き直したとき、古い理由は出さない。送ったあとの理由だけを出す。
    mountEvents([], [], { form: { error: { kind: 'no_admin' } } });
    openNew();
    pickKind('webhook');
    expect(screen.queryByRole('alert')).toBeNull();
    typePrompt();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(screen.getByRole('alert')).toHaveTextContent(t('schedules.event.noAdmin'));
    cleanup();
    mountEvents([], [], { form: { error: { kind: 'text', text: 'gh が見つかりません' } } });
    openNew();
    pickKind('webhook');
    typePrompt();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(screen.getByRole('alert')).toHaveTextContent('gh が見つかりません');
  });

  it('開いている間は一定の間隔でイベントを読み直し、閉じたら止める', () => {
    vi.useFakeTimers();
    try {
      const onAction = mountEvents([bind()]);
      const loads = () => onAction.mock.calls.filter((c) => c[0].type === 'events.load').length;
      expect(loads()).toBe(1);
      vi.advanceTimersByTime(15_000);
      expect(loads()).toBe(2);
      cleanup();
      vi.advanceTimersByTime(60_000);
      expect(loads()).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('作れた回数が増えたらフォームを閉じる。前に作った分では閉じない', () => {
    const onAction = vi.fn();
    const base = initialStore().eventTrigger;
    const props = (done: number): SchedulesProps => presentSchedules({ ...initialStore(), sync: SYNC, schedules: [dto()], projects: { p: proj('p', 'alpha') } as never, eventTrigger: { ...base, ready: true, form: { ...base.form, done } } }, t, NOW);
    const ui = (done: number) => <LanguageRoot language="ja"><ActionRoot onAction={onAction}><SchedulesScreen {...props(done)} /></ActionRoot></LanguageRoot>;
    const { rerender } = render(ui(3));
    openNew();
    pickKind('webhook');
    rerender(ui(3));
    expect(screen.getByRole('textbox', { name: t('schedules.form.prompt') })).toBeInTheDocument();
    rerender(ui(4));
    return vi.waitFor(() => expect(screen.queryByRole('textbox', { name: t('schedules.form.prompt') })).toBeNull());
  });
});

describe('予定もイベントも無いときの読み込みの失敗（9a の見直し）', () => {
  const SYNC = { state: 'ok', revoked: false, workerCompat: 12 } as never;
  const withError = (error: { kind: 'text'; text: string } | null) => {
    const base = initialStore().eventTrigger;
    mount([], { store: { sync: SYNC, eventTrigger: { ...base, ready: true, error } } });
  };

  it('予定もイベントも無く、失敗の一文があるときは、空の案内で隠さずに一文を出す', () => {
    withError({ kind: 'text', text: '読み込めませんでした' });
    expect(screen.getByRole('alert')).toHaveTextContent('読み込めませんでした');
    expect(screen.queryByText(t('schedules.list.empty'))).toBeNull();
  });

  it('失敗が無ければ、これまでどおり空の案内を出す', () => {
    withError(null);
    expect(screen.getByText(t('schedules.list.empty'))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
