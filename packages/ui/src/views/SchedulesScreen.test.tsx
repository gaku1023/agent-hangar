import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type CodexOptionsDto, type ScheduleDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { LaunchChoiceData } from '../presenters/newSession.ts';
import { nextLabel, presentSchedules, whenLabel, type SchedulesProps } from '../presenters/schedules.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
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
