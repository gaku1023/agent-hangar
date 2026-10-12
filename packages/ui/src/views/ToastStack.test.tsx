import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { fakeMotionTokens } from '../test/motion.ts';
import type { Toast } from '../mediator/types.ts';
import type { ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import type { UpdateCardProps } from '../presenters/update.ts';
import { INFO_TOAST_MS, ToastStack } from './ToastStack.tsx';

const card = (id: string, over: Partial<WaitingCardProps> = {}): WaitingCardProps => ({ sessionId: id, name: `名前 ${id}`, waited: '2 分', question: `問い ${id}`, reason: null, ask: null, ...over });
const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], more: 0, blocked: false, arrived: null, update: null, ...over });
function mount(p: ToastsProps) {
  const onAction = vi.fn();
  const r = render(<ActionRoot onAction={onAction}><ToastStack {...p} /></ActionRoot>);
  return { onAction, rerender: (q: ToastsProps) => r.rerender(<ActionRoot onAction={onAction}><ToastStack {...q} /></ActionRoot>) };
}

describe('入力待ちのカード', () => {
  it('見出しにラベル、名前、待っている時間を、その下に問いを出し、押すとそのセッションを開く', () => {
    const { onAction } = mount(props({ waiting: [card('s1')] }));
    const c = screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' });
    const head = within(c.querySelector<HTMLElement>('.notice-head')!);
    expect(head.getByText('入力待ち')).toBeInTheDocument();
    expect(head.getByText('名前 s1')).toBeInTheDocument();
    expect(head.getByText('2 分')).toBeInTheDocument();
    expect(c.querySelector('.notice-title')).toHaveTextContent('問い s1');
    fireEvent.click(c);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });
  it('カードのどこを押しても開く', () => {
    const { onAction } = mount(props({ waiting: [card('s1')] }));
    fireEvent.click(screen.getByText('問い s1'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });
  // 問いが取れない入力待ち（許可待ちなど）は、決まり文句で段を埋めず、名前を主役の段へ上げる。
  it('問いがなければ、見出しはラベルと時間だけにして、名前を問いの段に出す', () => {
    mount(props({ waiting: [card('s1', { question: null })] }));
    const c = screen.getByRole('button', { name: '名前 s1 が入力待ちです' });
    expect(within(c).getAllByText('名前 s1')).toHaveLength(1);
    expect(c.querySelector('.notice-title')).toHaveTextContent('名前 s1');
    expect(within(c.querySelector<HTMLElement>('.notice-head')!).getByText('2 分')).toBeInTheDocument();
  });
  it('許可待ちは見出しを「許可待ち」と盾にし、問いの場所に道具と命令を出す（試作の K1）', () => {
    mount(props({ waiting: [card('s1', { question: null, reason: 'permission', ask: { tool: 'Bash', input: 'rm -rf ./build/cache' } })] }));
    const c = screen.getByRole('button', { name: '名前 s1 が許可待ちです：Bash rm -rf ./build/cache' });
    const head = within(c.querySelector<HTMLElement>('.notice-head')!);
    expect(head.getByText('許可待ち')).toBeInTheDocument();
    expect(head.getByText('名前 s1')).toBeInTheDocument();
    expect(c.querySelector('.notice-head .reason-glyph')).not.toBeNull();
    expect(c.querySelector('.notice-tool')).toHaveTextContent('Bash');
    expect(c.querySelector('.notice-cmd')).toHaveTextContent('rm -rf ./build/cache');
  });
  it('許可の中身が無ければ、名前を問いの段に出す', () => {
    mount(props({ waiting: [card('s1', { question: null, reason: 'permission' })] }));
    const c = screen.getByRole('button', { name: '名前 s1 が許可待ちです' });
    expect(c.querySelector('.notice-title')).toHaveTextContent('名前 s1');
  });
  it('リセット済みは見出しを替え、続きを指示するよう言う', () => {
    mount(props({ waiting: [card('s1', { question: '使用制限がリセットされました。続きを指示してください', reason: 'reset' })] }));
    const c = screen.getByRole('button', { name: '名前 s1：使用制限がリセットされました。続きを指示してください' });
    expect(within(c.querySelector<HTMLElement>('.notice-head')!).getByText('リセット済み')).toBeInTheDocument();
  });
  it('ボタンの段と「答えるまで残ります」の注記は持たない', () => {
    mount(props({ waiting: [card('s1')] }));
    expect(screen.queryByRole('button', { name: 'ターミナルで答える' })).toBeNull();
    expect(screen.queryByText('答えるまで残ります')).toBeNull();
  });
  it('時間では消えない', () => {
    vi.useFakeTimers();
    try {
      const { onAction } = mount(props({ waiting: [card('s1')] }));
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(onAction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('並べきれない分は「ほか N 件をホームで見る」にまとめ、押すとホームへ移る', () => {
    const { onAction } = mount(props({ waiting: [card('s3'), card('s4'), card('s5')], more: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  // 通知の誘いはベルの一覧の行になった（PR 29）。右下には積まない。
  it('通知の誘いも戻る時刻の札も積まない', () => {
    mount(props({ waiting: [card('s1'), card('s2')] }));
    expect(screen.queryByRole('button', { name: '通知を受け取る' })).toBeNull();
    expect(document.querySelector('.notice[data-kind="return"]')).toBeNull();
  });
  it('ダイアログが開いている間は、カードも「ほか N 件」も押せず、理由は乗せたときの説明に出す', () => {
    const { onAction } = mount(props({ waiting: [card('s1')], more: 2, blocked: true }));
    const c = screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' });
    expect(c).toBeDisabled();
    expect(c).toHaveAttribute('title', 'ダイアログを閉じると開けます');
    expect(screen.queryByText('ダイアログを閉じると開けます')).toBeNull();
    expect(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' })).toBeDisabled();
    fireEvent.click(screen.getByText('問い s1'));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('押せる間は、乗せたときの説明を付けない', () => {
    mount(props({ waiting: [card('s1')] }));
    expect(screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' })).not.toHaveAttribute('title');
  });
});

describe('info と error のトースト', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const info = (id: string, message = `知らせ ${id}`): Toast => ({ id, level: 'info', message });
  const error = (id: string, message = `失敗 ${id}`): Toast => ({ id, level: 'error', message });

  it('info は「お知らせ」、error は「エラー」の見出しを持つ', () => {
    mount(props({ toasts: [info('1'), error('2')] }));
    expect(within(screen.getByRole('status').querySelector<HTMLElement>('.notice-head')!).getByText('お知らせ')).toBeInTheDocument();
    expect(within(screen.getByRole('alert').querySelector<HTMLElement>('.notice-head')!).getByText('エラー')).toBeInTheDocument();
  });
  it('info は role="status" で、時間が来たら消す', () => {
    const { onAction } = mount(props({ toasts: [info('1')] }));
    expect(screen.getByRole('status')).toHaveTextContent('知らせ 1');
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1); });
    expect(onAction).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('holdMs を持つ info は、その長さまで残し、持たないものは既定の長さで消す', () => {
    const { onAction } = mount(props({ toasts: [{ id: '1', level: 'info', message: '長い', holdMs: INFO_TOAST_MS * 2 }, info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS); });
    expect(onAction.mock.calls).toEqual([[{ type: 'toast.dismiss', id: '2' }]]);
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1); });
    expect(onAction).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('時間切れはトーストごとに数える', () => {
    const { onAction, rerender } = mount(props({ toasts: [info('1')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    rerender(props({ toasts: [info('1'), info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    expect(onAction.mock.calls).toEqual([[{ type: 'toast.dismiss', id: '1' }]]);
    rerender(props({ toasts: [info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'toast.dismiss', id: '2' });
  });
  it('マウスを乗せている間は止め、離したら残りの時間で消す', () => {
    const { onAction } = mount(props({ toasts: [info('1')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1000); });
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS * 3); });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(999); });
    expect(onAction).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('info は押しても消せる', () => {
    const { onAction } = mount(props({ toasts: [info('1')] }));
    fireEvent.click(screen.getByText('知らせ 1'));
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('error は role="alert" で、時間では消えず、閉じるで消す', () => {
    const { onAction } = mount(props({ toasts: [error('1')] }));
    const alert = screen.getByRole('alert');
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.click(within(alert).getByText('失敗 1'));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('holdMs を持つ error は、その長さで消える。乗せている間は止める', () => {
    const { onAction } = mount(props({ toasts: [{ id: '1', level: 'error', message: '見つかりません', holdMs: 8000 }] }));
    act(() => { vi.advanceTimersByTime(7000); });
    fireEvent.mouseEnter(screen.getByRole('alert'));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.mouseLeave(screen.getByRole('alert'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('error の本文が 2 行に収まらないときは「詳しく」で開く', () => {
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
    const box = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    try {
      mount(props({ toasts: [error('1', '長い失敗の文')] }));
      const more = screen.getByRole('button', { name: '詳しく' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('alert')).toHaveAttribute('data-open', 'true');
    } finally { tall.mockRestore(); box.mockRestore(); }
  });
  it('2 行に収まる error には「詳しく」を出さない', () => {
    mount(props({ toasts: [error('1')] }));
    expect(screen.queryByRole('button', { name: '詳しく' })).toBeNull();
  });
});

describe('更新の札', () => {
  const upd = (over: Partial<UpdateCardProps> = {}): UpdateCardProps => ({
    kind: 'available', tone: 'info', head: '更新あり', title: 'Hangar 1.5.0 を利用できます', detail: '現在は 1.4.2 です。', progress: null,
    actions: [{ label: 'ダウンロードしてインストール', action: { type: 'update.download' }, primary: true }, { label: 'あとで', action: { type: 'update.dismiss' }, primary: false }],
    ...over,
  });
  it('見出し、題、説明と操作を出し、押すとその操作を送る', () => {
    const { onAction } = mount(props({ update: upd() }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="update"]')!;
    expect(c).toHaveAttribute('data-tone', 'info');
    expect(within(c).getByText('更新あり')).toBeInTheDocument();
    expect(within(c).getByText('Hangar 1.5.0 を利用できます')).toBeInTheDocument();
    expect(within(c).getByText('現在は 1.4.2 です。')).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: 'ダウンロードしてインストール' }));
    fireEvent.click(within(c).getByRole('button', { name: 'あとで' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'update.download' }], [{ type: 'update.dismiss' }]]);
  });
  it('取得中は進みの棒と割合を出す', () => {
    mount(props({ update: upd({ kind: 'downloading', head: 'ダウンロード中', title: 'Hangar 1.5.0', detail: null, progress: { percent: 62, label: '62%' }, actions: [] }) }));
    const bar = screen.getByRole('progressbar', { name: 'ダウンロードの進み具合' });
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(screen.getByText('62%')).toBeInTheDocument();
  });
  it('大きさが分からないときの棒は値を持たない', () => {
    mount(props({ update: upd({ kind: 'downloading', head: 'ダウンロード中', title: 'Hangar 1.5.0', detail: null, progress: { percent: null, label: 'ダウンロードしています…' }, actions: [] }) }));
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
  it('入力待ちのカードより上（窓の角から遠い側）に積む', () => {
    mount(props({ update: upd(), waiting: [card('s1')] }));
    const kinds = [...document.querySelectorAll<HTMLElement>('.toasts .notice')].map((n) => n.dataset.kind);
    expect(kinds).toEqual(['update', 'waiting']);
  });
});

describe('知らせの出る動き（⑨ の b）', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; resolve: () => void }[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    animations = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      let resolve!: () => void;
      const finished = new Promise<void>((r) => { resolve = r; });
      animations.push({ el: this, frames, opts, resolve });
      return { finished, cancel: vi.fn() };
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  });
  const info: Toast = { id: 't1', level: 'info', message: '要約を作り直しました' };
  const step = async (i: number) => { await act(async () => { animations[i]!.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

  it('出る札は右へ 28px 抜けて薄れ、そのあと高さだけを畳み、終わったら外れる。最後の 1 枚でも同じ', async () => {
    const m = mount(props({ toasts: [info] }));
    // 入りは今のまま（CSS の slide）で、JS では動かさない。
    expect(animations).toHaveLength(0);
    m.rerender(props({ toasts: [] }));
    const el = document.querySelector<HTMLElement>('.notice[data-kind="info"]')!;
    expect(el).not.toBeNull();
    // 出ている間は、役も焦点も持たない見た目だけにする。
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveAttribute('inert');
    expect(animations.map((a) => [a.el, a.frames.at(-1), a.opts.duration])).toEqual([[el, { opacity: 0, transform: 'translateX(28px)' }, 250]]);
    await step(0);
    expect(animations).toHaveLength(2);
    expect(animations[1]!.el).toBe(el);
    for (const f of animations[1]!.frames) expect(f).not.toHaveProperty('opacity');
    expect(animations[1]!.frames.at(-1)).toMatchObject({ height: '0px' });
    await step(1);
    expect(document.querySelector('.notice[data-kind="info"]')).toBeNull();
  });

  it('入力待ちのカードも、解けたら同じ形で出る。残りのカードは押されて詰まる（並びの滑りは付けない）', async () => {
    const m = mount(props({ waiting: [card('s1'), card('s2')] }));
    m.rerender(props({ waiting: [card('s2')] }));
    const gone = screen.getByText('問い s1').closest('.notice')!;
    expect(animations.map((a) => a.el)).toEqual([gone]);
    await step(0);
    await step(1);
    expect(screen.queryByText('問い s1')).toBeNull();
    expect(screen.getByText('問い s2')).toBeInTheDocument();
  });

  it('動きが無いとき（reduced motion）は、すぐ外す', () => {
    restore?.();
    restore = fakeMotionTokens({ '--dur': '0ms', '--dur-fast': '0ms', '--dur-exit': '0ms' }, { everywhere: true });
    const m = mount(props({ toasts: [info], waiting: [card('s1')] }));
    m.rerender(props({ toasts: [], waiting: [] }));
    expect(document.querySelector('.toasts .notice')).toBeNull();
    expect(animations).toHaveLength(0);
  });
});
