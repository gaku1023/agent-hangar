import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator, type EventBindingDto, type EventRepoHookDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentSchedules } from '../presenters/schedules.ts';
import { initialStore } from '../store/store.ts';
import { EventHookApiContext, type EventHookApi } from './eventHookApi.ts';
import { CopiedContext } from './primitives/CommandLine.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { SchedulesScreen } from './SchedulesScreen.tsx';

/** 外の webhook の URL のカード（D1）、GitHub の repo の札（D3）、最初の結び付けの手順（D4）。 */
const t = translator('ja');
const NOW = new Date(2026, 10, 10, 9, 0).getTime();
const SYNC = { state: 'ok', revoked: false, workerCompat: 12 } as never;
const URL1 = 'https://hook.example/hooks/aaa111';
const URL2 = 'https://hook.example/hooks/bbb222';

const bind = (o: Partial<EventBindingDto> = {}): EventBindingDto => ({
  id: 'g1', source: { kind: 'github', repo: 'o/r', when: ['ci_failed'] }, action: { kind: 'new', projectId: 'p' }, prompt: '落ちた CI を直す',
  passBody: false, allowAuthors: [], state: 'active', hookUrl: null, createdAt: 1, expiresAt: null, runs: [], ...o,
});
const hook = (o: Partial<EventBindingDto> = {}) => bind({ id: 'h1', source: { kind: 'hook' }, prompt: 'デプロイ通知を見る', ...o });

const fakeHookApi = (o: Partial<EventHookApi> = {}): EventHookApi => ({
  hookUrl: vi.fn(async () => URL1),
  rotateUrl: vi.fn(async () => null),
  repoHook: vi.fn(async (): Promise<EventRepoHookDto> => ({ status: 'registered' })),
  ...o,
});

type Over = { hookApi?: EventHookApi | null; busy?: boolean; done?: number; rev?: number; copied?: { text: string; n: number } | null };
/** 画面を描く。rerender で busy や done を変えて、送信中や成功のあとの形を作る。 */
function mount(bindings: EventBindingDto[], first: Over = {}) {
  const onAction = vi.fn();
  const api = first.hookApi === undefined ? fakeHookApi() : first.hookApi;
  const tree = (o: Over) => {
    const base = initialStore().eventTrigger;
    const store = {
      ...initialStore(), sync: SYNC, schedules: [],
      projects: { p: { id: 'p', name: 'alpha', status: 'active', isScratch: false, resolved: true, path: '/w/alpha', lastActivityAt: null } } as never,
      eventTrigger: { ...base, ready: true, bindings, rev: o.rev ?? 0, form: { ...base.form, busy: o.busy ?? false, done: o.done ?? 0 } },
    };
    return (
      <LanguageRoot language="ja">
        <ActionRoot onAction={onAction}>
          <EventHookApiContext.Provider value={api}>
            <CopiedContext.Provider value={o.copied ?? null}>
              <SchedulesScreen {...presentSchedules(store, t, NOW)} />
            </CopiedContext.Provider>
          </EventHookApiContext.Provider>
        </ActionRoot>
      </LanguageRoot>
    );
  };
  const r = render(tree(first));
  return { onAction, api, rerender: (o: Over) => r.rerender(tree({ ...first, ...o })) };
}
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const urlBox = () => document.querySelector('.sch-url');
const actions = (onAction: ReturnType<typeof vi.fn>) => onAction.mock.calls.map((c) => c[0] as { type: string });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('外の webhook の URL のカード（D1）', () => {
  it('開いても URL は出さず、読みにも行かない。表示を押すと読んで出す', async () => {
    const { api } = mount([hook()]);
    open('デプロイ通知を見る');
    expect(urlBox()).not.toBeNull();
    expect(urlBox()!.textContent).not.toContain('hook.example');
    expect(api!.hookUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.show') }));
    expect(await screen.findByText(URL1)).toBeInTheDocument();
    expect(api!.hookUrl).toHaveBeenCalledWith('h1');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.hide') }));
    expect(screen.queryByText(URL1)).toBeNull();
  });

  it('行を閉じると URL を捨てる。開き直しても、表示を押すまで出ない', async () => {
    mount([hook()]);
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.show') }));
    await screen.findByText(URL1);
    fireEvent.click(screen.getByRole('button', { name: 'デプロイ通知を見る', expanded: true }));
    await waitFor(() => expect(urlBox()).toBeNull());
    expect(document.body.textContent).not.toContain(URL1);
    open('デプロイ通知を見る');
    expect(urlBox()!.textContent).not.toContain(URL1);
  });

  it('コピーは URL をクリップボードの道に渡す。トーストの文は付けない', async () => {
    const { onAction } = mount([hook()]);
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.show') }));
    await screen.findByText(URL1);
    fireEvent.click(screen.getByRole('button', { name: t('common.button.copy') }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: URL1 });
  });

  it('隠したままコピーしても、読んで写し、画面には出さない', async () => {
    const { onAction, api } = mount([hook()]);
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('common.button.copy') }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: URL1 }));
    expect(api!.hookUrl).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(URL1)).toBeNull();
  });

  it('写せたら「コピーしました」に替わる', async () => {
    const m = mount([hook()]);
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.show') }));
    await screen.findByText(URL1);
    fireEvent.click(screen.getByRole('button', { name: t('common.button.copy') }));
    m.rerender({ copied: { text: URL1, n: 1 } });
    expect(await screen.findByText(t('common.button.copied'))).toBeInTheDocument();
  });

  it('作り直すは先に確かめる。やめると何も呼ばない', async () => {
    const { api } = mount([hook()]);
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.rotate') }));
    expect(screen.getByText(t('schedules.event.url.rotateAsk'))).toBeInTheDocument();
    expect(api!.rotateUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('common.button.cancel') }));
    expect(screen.queryByText(t('schedules.event.url.rotateAsk'))).toBeNull();
    expect(api!.rotateUrl).not.toHaveBeenCalled();
  });

  it('はいで作り直し、新しい URL を出して光らせる', async () => {
    const hookUrl = vi.fn<EventHookApi['hookUrl']>().mockResolvedValueOnce(URL1).mockResolvedValue(URL2);
    const { api } = mount([hook()], { hookApi: fakeHookApi({ hookUrl }) });
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.show') }));
    await screen.findByText(URL1);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.rotate') }));
    fireEvent.click(within(screen.getByText(t('schedules.event.url.rotateAsk')).parentElement!).getByRole('button', { name: t('schedules.event.url.rotate') }));
    expect(api!.rotateUrl).toHaveBeenCalledWith('h1');
    expect(await screen.findByText(URL2)).toBeInTheDocument();
    expect(screen.queryByText(URL1)).toBeNull();
    expect(urlBox()).toHaveAttribute('data-fresh', 'true');
    expect(screen.queryByText(t('schedules.event.url.rotateAsk'))).toBeNull();
  });

  it('作り直せなかったときは、サーバの文か決めた一文を出し、古い URL のままにする', async () => {
    const rotateUrl = vi.fn<EventHookApi['rotateUrl']>().mockResolvedValueOnce({ message: 'inbox unavailable' }).mockResolvedValueOnce({ message: '' });
    mount([hook()], { hookApi: fakeHookApi({ rotateUrl }) });
    open('デプロイ通知を見る');
    const rotate = async () => {
      fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.rotate') }));
      fireEvent.click(within(screen.getByText(t('schedules.event.url.rotateAsk')).parentElement!).getByRole('button', { name: t('schedules.event.url.rotate') }));
    };
    await rotate();
    expect(await screen.findByRole('alert')).toHaveTextContent('inbox unavailable');
    await rotate();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('schedules.event.hookFailed')));
  });

  it('URL は UiAction に載せない（コピーの道だけ）', async () => {
    const { onAction } = mount([hook()]);
    open('デプロイ通知を見る');
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.url.show') }));
    await screen.findByText(URL1);
    expect(actions(onAction).filter((a) => JSON.stringify(a).includes('aaa111'))).toEqual([]);
  });

  it('webhook の Context が無い場所と、GitHub の行にはカードを出さない', () => {
    mount([hook()], { hookApi: null });
    open('デプロイ通知を見る');
    expect(urlBox()).toBeNull();
    cleanup();
    mount([bind()]);
    open('落ちた CI を直す');
    expect(urlBox()).toBeNull();
  });
});

describe('GitHub の repo の札（D3）', () => {
  const chip = () => document.querySelector('.sch-hook-chip');
  const state = (s: EventRepoHookDto) => fakeHookApi({ repoHook: vi.fn(async () => s) });

  it('登録済みは札だけで、操作は無い', async () => {
    const { api } = mount([bind()], { hookApi: state({ status: 'registered' }) });
    open('落ちた CI を直す');
    expect(await screen.findByText(t('schedules.event.hook.registered'))).toBeInTheDocument();
    expect(api!.repoHook).toHaveBeenCalledWith('o/r');
    expect(chip()).toHaveAttribute('data-state', 'registered');
    expect(screen.queryByRole('button', { name: t('schedules.event.hook.retry') })).toBeNull();
  });

  it('権限なしは札と説明の吹き出しで、再試行は出さない', async () => {
    mount([bind()], { hookApi: state({ status: 'no_admin' }) });
    open('落ちた CI を直す');
    const el = await screen.findByText(t('schedules.event.hook.noAccess'));
    expect(chip()).toHaveAttribute('data-state', 'no_admin');
    expect(chip()).toHaveAttribute('title', t('schedules.event.noAdmin'));
    expect(el).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('schedules.event.hook.retry') })).toBeNull();
  });

  it('失敗は札と、決めた一文。承認待ちの下書きだけが再試行を持ち、承認の依頼を出し直す', async () => {
    const { onAction } = mount([bind({ id: 'd1', state: 'draft', prompt: '下書き' })], { hookApi: state({ status: 'failed', message: 'gh failed (HTTP 500)' }) });
    expect(await screen.findByText(t('schedules.event.hook.failed'))).toBeInTheDocument();
    expect(chip()).toHaveAttribute('data-state', 'failed');
    expect(screen.getByText(t('schedules.event.hookFailed'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.hook.retry') }));
    expect(onAction).toHaveBeenCalledWith({ type: 'events.approve', id: 'd1' });
  });

  it('有効な行の失敗には再試行を出さない（サーバに付け直す道が無い）', async () => {
    mount([bind()], { hookApi: state({ status: 'failed' }) });
    open('落ちた CI を直す');
    expect(await screen.findByText(t('schedules.event.hook.failed'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('schedules.event.hook.retry') })).toBeNull();
  });

  it('none と読めなかったときは何も出さない', async () => {
    const api = fakeHookApi({ repoHook: vi.fn().mockResolvedValueOnce({ status: 'none' }).mockRejectedValue(new Error('x')) });
    const m = mount([bind()], { hookApi: api });
    open('落ちた CI を直す');
    await waitFor(() => expect(api.repoHook).toHaveBeenCalledTimes(1));
    expect(chip()).toBeNull();
    m.rerender({ rev: 1 });
    await waitFor(() => expect(api.repoHook).toHaveBeenCalledTimes(2));
    expect(chip()).toBeNull();
  });

  it('rev が進んだら状態を取り直す', async () => {
    const repoHook = vi.fn<EventHookApi['repoHook']>().mockResolvedValueOnce({ status: 'failed' }).mockResolvedValue({ status: 'registered' });
    const m = mount([bind({ id: 'd1', state: 'draft' })], { hookApi: fakeHookApi({ repoHook }) });
    expect(await screen.findByText(t('schedules.event.hook.failed'))).toBeInTheDocument();
    m.rerender({ rev: 1 });
    expect(await screen.findByText(t('schedules.event.hook.registered'))).toBeInTheDocument();
  });

  it('rev が変わらない描き直し（一覧が同じままの読み直し）では取り直さない', async () => {
    const { api, rerender } = mount([bind()]);
    open('落ちた CI を直す');
    await screen.findByText(t('schedules.event.hook.registered'));
    expect(api!.repoHook).toHaveBeenCalledTimes(1);
    rerender({ rev: 0 });
    rerender({ rev: 0, busy: false });
    await Promise.resolve();
    expect(api!.repoHook).toHaveBeenCalledTimes(1);
  });

  it('外の webhook の行には repo の札を出さない', async () => {
    const { api } = mount([hook()]);
    open('デプロイ通知を見る');
    expect(chip()).toBeNull();
    expect(api!.repoHook).not.toHaveBeenCalled();
  });
});

describe('最初の結び付けの手順（D4）', () => {
  const fill = async (repo: string) => {
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.event.kind.github') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.event.form.repo') }), { target: { value: repo } });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.event.when.ciFailed') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
  };
  const steps = () => document.querySelector('.sch-steps');
  const step = (name: string) => within(steps() as HTMLElement).getByText(name).closest('.sch-step')!;

  beforeEach(() => { vi.useFakeTimers(); });

  it('初めての repo は、送っている間だけ 設定、webhook、待機 を出し、webhook に進む', async () => {
    const m = mount([bind({ id: 'x', source: { kind: 'github', repo: 'a/b', when: ['merged'] } })]);
    await fill('new/repo');
    expect(steps()).toBeNull();
    m.rerender({ busy: true });
    expect(steps()).not.toBeNull();
    expect(step(t('schedules.event.steps.setup'))).toHaveAttribute('data-state', 'active');
    expect(step(t('schedules.event.steps.webhook'))).toHaveAttribute('data-state', 'todo');
    expect(step(t('schedules.event.steps.waiting'))).toHaveAttribute('data-state', 'todo');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(step(t('schedules.event.steps.setup'))).toHaveAttribute('data-state', 'done');
    expect(step(t('schedules.event.steps.webhook'))).toHaveAttribute('data-state', 'active');
  });

  it('済んだら全部が済みになり、登録済みの札を出して、少ししてから閉じる', async () => {
    const m = mount([]);
    await fill('new/repo');
    m.rerender({ busy: true });
    m.rerender({ busy: false, done: 1 });
    expect(step(t('schedules.event.steps.webhook'))).toHaveAttribute('data-state', 'done');
    expect(step(t('schedules.event.steps.waiting'))).toHaveAttribute('data-state', 'active');
    expect(within(steps()!.parentElement as HTMLElement).getByText(t('schedules.event.hook.registered'))).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: t('schedules.event.form.repo') })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole('textbox', { name: t('schedules.event.form.repo') })).toBeNull();
  });

  it('すでに結び付けがある repo と、大文字小文字だけが違う repo では出さない', async () => {
    for (const repo of ['o/r', 'O/R']) {
      const m = mount([bind()]);
      await fill(repo);
      m.rerender({ busy: true });
      expect(steps()).toBeNull();
      cleanup();
    }
  });

  it('失敗したときは手順を消し、閉じない', async () => {
    const m = mount([]);
    await fill('new/repo');
    m.rerender({ busy: true });
    m.rerender({ busy: false, done: 0 });
    expect(steps()).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('textbox', { name: t('schedules.event.form.repo') })).toBeInTheDocument();
  });

  it('外の webhook の作成では出さない', async () => {
    const m = mount([]);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.event.kind.hook') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    m.rerender({ busy: true });
    expect(steps()).toBeNull();
  });
});
