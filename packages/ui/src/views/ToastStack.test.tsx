import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { fakeMotionTokens } from '../test/motion.ts';
import type { Toast } from '../mediator/types.ts';
import type { PhoneLaunchCardProps, ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import type { UpdateCardProps } from '../presenters/update.ts';
import { INFO_TOAST_MS, PHONE_LAUNCH_TOAST_MS, ToastStack } from './ToastStack.tsx';

const card = (id: string, over: Partial<WaitingCardProps> = {}): WaitingCardProps => ({ sessionId: id, name: `名前 ${id}`, waited: '2 分', question: `問い ${id}`, reason: null, ask: null, ...over });
const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], more: 0, blocked: false, arrived: null, update: null, whatsNew: null, join: null, phoneUndo: null, phoneLaunches: [], ...over });
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
    expect(c).toHaveAttribute('title', 'ダイアログを閉じてから操作してください');
    expect(screen.queryByText('ダイアログを閉じてから操作してください')).toBeNull();
    expect(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' })).toBeDisabled();
    fireEvent.click(screen.getByText('問い s1'));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('押せる間は、乗せたときの説明を付けない', () => {
    mount(props({ waiting: [card('s1')] }));
    expect(screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' })).not.toHaveAttribute('title');
  });
});

describe('参加リクエストの通知（試作 C1）', () => {
  it('右下の通知に名前、OS、確認コードと「確認して承認」があり、押すと設定のクラウド同期（A1）に移る', () => {
    const { onAction } = mount(props({ join: { name: 'pc-b', os: 'Windows', sas: '418 207' } }));
    const c = screen.getByRole('status', { name: '参加リクエスト' });
    expect(c).toHaveTextContent('pc-b から参加リクエストを受信しました');
    expect(c).toHaveTextContent('Windows');
    expect(c).toHaveTextContent('418 207');
    // 照らし合わせ方の文は設定の承認の段で言うので、通知には「確認コード」の名前だけを添える。
    expect(c).toHaveTextContent('確認コード418 207');
    fireEvent.click(within(c).getByRole('button', { name: '確認して承認' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'cloud' } });
  });
  it('確認や入力のあるダイアログが開いている間は、画面を移せないので押せない', () => {
    mount(props({ join: { name: 'pc-b', os: 'Windows', sas: '418 207' }, blocked: true }));
    expect(screen.getByRole('button', { name: '確認して承認' })).toBeDisabled();
  });
});

describe('スマホの解除の「元に戻す」（試作 E2）', () => {
  it('右下の通知に解除したスマホの名前と「元に戻す」があり、押すと元に戻す。時間では消さない（5 秒は Runtime が数える）', () => {
    vi.useFakeTimers();
    const { onAction } = mount(props({ phoneUndo: { name: 'iPhone' } }));
    const c = screen.getByRole('status', { name: 'スマホ' });
    // 5 秒の間はまだ送っていないので、もうすぐ起きることの形で書く。秒数は PHONE_UNDO_MS と二重に持たないので入れない。
    expect(c).toHaveTextContent('iPhone を解除します');
    expect(c).toHaveTextContent('このあと iPhone からセッションを起動できなくなります。');
    expect(c).not.toHaveTextContent('解除しました');
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS * 3); });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(within(c).getByRole('button', { name: '元に戻す' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.phone.undo' });
    vi.useRealTimers();
  });
  it('確認や入力のあるダイアログが開いていても押せる（画面を移さない）', () => {
    mount(props({ phoneUndo: { name: 'iPhone' }, blocked: true }));
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeEnabled();
  });
});

describe('スマホから起動したセッションの通知（試作 F1）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const stop = { runId: 'r1', working: true, aside: false, shellTabs: 0 };
  const launch = (over: Partial<PhoneLaunchCardProps> = {}): PhoneLaunchCardProps => ({ sessionId: 's1', title: 'iPhone から起動：project-a（Auto）', name: 'ログの出力を減らす', bypass: false, stop, ...over });

  it('右下に「〈スマホの名前〉から起動：〈プロジェクト〉（〈権限モード〉）」と会話の名前と「開く」を出し、押すとその会話を開く', () => {
    const { onAction } = mount(props({ phoneLaunches: [launch()] }));
    const c = screen.getByRole('status', { name: 'スマホから起動' });
    expect(c).toHaveAttribute('data-kind', 'phone-launch');
    expect(c).not.toHaveAttribute('data-tone');
    expect(within(c.querySelector<HTMLElement>('.notice-head')!).getByText('スマホから起動')).toBeInTheDocument();
    expect(c.querySelector('.notice-title')).toHaveTextContent('iPhone から起動：project-a（Auto）');
    expect(c.querySelector('.notice-sub')).toHaveTextContent('ログの出力を減らす');
    expect(within(c).queryByRole('button', { name: '停止' })).toBeNull();
    fireEvent.click(within(c).getByRole('button', { name: '開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'phoneLaunch.open', sessionId: 's1' });
  });

  it('通常の通知は時間で消え（乗せている間は止める）、Bypass permissions の通知は時間では消さない', () => {
    const { onAction } = mount(props({ phoneLaunches: [launch(), launch({ sessionId: 's2', bypass: true })] }));
    act(() => { vi.advanceTimersByTime(PHONE_LAUNCH_TOAST_MS); });
    expect(onAction.mock.calls).toEqual([[{ type: 'phoneLaunch.dismiss', sessionId: 's1' }]]);
    act(() => { vi.advanceTimersByTime(PHONE_LAUNCH_TOAST_MS * 5); });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('Bypass permissions は赤い通知（data-tone="err"）で、見出しに Bypass permissions、注意の文、「停止」と「開く」を置く。「停止」は停止の流れに渡す', () => {
    const { onAction } = mount(props({ phoneLaunches: [launch({ title: 'iPhone から起動：project-b（Bypass permissions）', bypass: true })] }));
    const c = screen.getByRole('alert', { name: 'スマホから起動 · Bypass permissions' });
    expect(c).toHaveAttribute('data-kind', 'phone-launch');
    expect(c).toHaveAttribute('data-tone', 'err');
    expect(c.querySelector('.notice-title')).toHaveTextContent('iPhone から起動：project-b（Bypass permissions）');
    expect(c).toHaveTextContent('Claude はツールを使用する前に確認しません。心当たりがない場合は停止してください。');
    expect(within(c.querySelector<HTMLElement>('.notice-acts')!).getAllByRole('button').map((b) => b.textContent)).toEqual(['停止', '開く']);
    fireEvent.click(within(c).getByRole('button', { name: '停止' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'phoneLaunch.stop', sessionId: 's1', stop });
  });

  it('止める run が無ければ「停止」を出さない。確認や入力のあるダイアログが開いている間は押せない', () => {
    mount(props({ phoneLaunches: [launch({ bypass: true, stop: null })], blocked: true }));
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.getByRole('button', { name: '開く' })).toBeDisabled();
  });

  it('Bypass permissions の通知は見出しの「閉じる」で下げられる（run が終わって「停止」が消えても）。画面を移さないのでダイアログの間も押せる', () => {
    const { onAction } = mount(props({ phoneLaunches: [launch({ bypass: true, stop: null })], blocked: true }));
    const c = screen.getByRole('alert', { name: 'スマホから起動 · Bypass permissions' });
    const close = within(c.querySelector<HTMLElement>('.notice-head')!).getByRole('button', { name: '閉じる' });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(onAction).toHaveBeenCalledWith({ type: 'phoneLaunch.dismiss', sessionId: 's1' });
    // 通常の通知は時間で消えるので「閉じる」を持たない。
    mount(props({ phoneLaunches: [launch({ sessionId: 's2' })] }));
    expect(within(screen.getByRole('status', { name: 'スマホから起動' })).queryByRole('button', { name: '閉じる' })).toBeNull();
  });

  it('並べきれない通知は、通知の上に「スマホから起動した他 n 件」の 1 行で数だけを出す', () => {
    const { rerender } = mount(props({ phoneLaunches: [launch()], phoneLaunchMore: 2 }));
    const more = screen.getByText('スマホから起動した他 2 件');
    expect(more).toHaveClass('toast-pill');
    const cards = [...document.querySelectorAll('.toast')];
    expect(cards.indexOf(more)).toBeLessThan(cards.findIndex((el) => el.getAttribute('data-kind') === 'phone-launch'));
    rerender(props({ phoneLaunches: [launch()], phoneLaunchMore: 0 }));
    expect(screen.queryByText(/スマホから起動した他/)).toBeNull();
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
  it('action を持つ error は、本文の下にボタンを出し、押すとその操作を送ってトーストを閉じる', () => {
    const { onAction } = mount(props({ toasts: [{ id: '1', level: 'error', message: '外れています', action: { label: '修復…', send: { type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' } } }] }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '修復…' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' }, { type: 'toast.dismiss', id: '1' }]);
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
      const more = screen.getByRole('button', { name: '詳細' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('alert')).toHaveAttribute('data-open', 'true');
    } finally { tall.mockRestore(); box.mockRestore(); }
  });
  it('2 行に収まる error には「詳しく」を出さない', () => {
    mount(props({ toasts: [error('1')] }));
    expect(screen.queryByRole('button', { name: '詳細' })).toBeNull();
  });
});

describe('更新の札', () => {
  const upd = (over: Partial<UpdateCardProps> = {}): UpdateCardProps => ({
    kind: 'available', tone: 'info', head: '更新あり', title: 'Hangar 1.5.0 を利用できます', detail: '現在は 1.4.2 です。', progress: null,
    beforeLabel: '更新の前に', before: null, points: [],
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
    const bar = screen.getByRole('progressbar', { name: 'ダウンロードの進行状況' });
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(screen.getByText('62%')).toBeInTheDocument();
  });
  it('大きさが分からないときの棒は値を持たない', () => {
    mount(props({ update: upd({ kind: 'downloading', head: 'ダウンロード中', title: 'Hangar 1.5.0', detail: null, progress: { percent: null, label: 'ダウンロードしています…' }, actions: [] }) }));
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
  it('ノートがあれば、注意を先頭に、要点を箇条書きで載せ、ノートを読むを文字だけのボタンにする', () => {
    const { onAction } = mount(props({ update: upd({ before: 'すべての PC を上げてください。', points: ['一つ目', '二つ目'], actions: [{ label: 'ノートを読む', action: { type: 'nav.go', to: { name: 'settings', at: 'update' } }, primary: false, link: true }] }) }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="update"]')!;
    expect(within(c).getByText('更新の前に')).toBeInTheDocument();
    expect(within(c).getByText('すべての PC を上げてください。')).toBeInTheDocument();
    expect(within(c).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['一つ目', '二つ目']);
    const read = within(c).getByRole('button', { name: 'ノートを読む' });
    expect(read).toHaveClass('btn-link');
    fireEvent.click(read);
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'update' } });
  });
  it('更新したあとの札は、要点と含む版を出し、閉じるとすべて読むを置く', () => {
    const { onAction } = mount(props({ whatsNew: { head: '更新しました', title: 'Hangar 1.4.2 になりました', beforeLabel: '更新の前に', before: null, points: ['直した。'], sub: '1.4.1 の分も含みます', actions: [{ label: '閉じる', action: { type: 'update.notesClose' }, primary: false }, { label: 'すべて読む', action: { type: 'update.notesRead' }, primary: true }] } }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="whats-new"]')!;
    expect(c).toHaveAttribute('data-tone', 'ok');
    expect(within(c).getByText('Hangar 1.4.2 になりました')).toBeInTheDocument();
    expect(within(c).getByText('1.4.1 の分も含みます')).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: 'すべて読む' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'update.notesRead' });
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

describe('未検証の Codex の版の札（C4）', () => {
  const cx = { version: '0.170.0', head: '未検証のバージョン', who: 'codex 0.170.0', title: 'codex 0.170.0 は未検証のバージョンです', body: '検証済み：0.164.x。app-server の変更により、状態や権限確認が正しく表示されない可能性があります。', settings: '設定を開く', proceed: 'このまま続行' };
  it('opencode の札と同じ形で、codex の操作を送る', () => {
    const { onAction } = mount(props({ codexVersion: cx }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="codex-version"]')!;
    expect(c.querySelector('.notice-title')).toHaveTextContent('codex 0.170.0 は未検証のバージョンです');
    fireEvent.click(within(c).getByRole('button', { name: 'このまま続行' }));
    fireEvent.click(within(c).getByRole('button', { name: '設定を開く' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'codex.version.continue', version: '0.170.0' }], [{ type: 'codex.version.settings', version: '0.170.0' }]]);
  });
});

describe('未検証の opencode の版の札（C7、試作の N1）', () => {
  const oc = { version: '2.2.0', head: '未検証のバージョン', who: 'opencode 2.2.0', title: 'opencode 2.2.0 は未検証のバージョンです', body: '検証済み：2.1.x。API の変更により、状態や権限確認が正しく表示されない可能性があります。', settings: '設定を開く', proceed: 'このまま続行' };
  it('見出しに種類と版、その下に題と本文、ボタンと文字だけの操作を並べる', () => {
    mount(props({ opencodeVersion: oc }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="opencode-version"]')!;
    expect(c).toHaveAttribute('role', 'status');
    const head = within(c.querySelector<HTMLElement>('.notice-head')!);
    expect(head.getByText('未検証のバージョン')).toBeInTheDocument();
    expect(head.getByText('opencode 2.2.0')).toBeInTheDocument();
    expect(c.querySelector('.notice-title')).toHaveTextContent('opencode 2.2.0 は未検証のバージョンです');
    expect(c.querySelector('.notice-sub')).toHaveTextContent('検証済み：2.1.x。');
    expect(within(c).getByRole('button', { name: '設定を開く' })).toHaveClass('btn', 'btn-sm');
    expect(within(c).getByRole('button', { name: 'このまま続行' })).toHaveClass('btn-link');
  });
  it('「このまま続行」と閉じるはその版を知らせ終え、「設定を開く」は設定の opencode の面へ移る', () => {
    const { onAction } = mount(props({ opencodeVersion: oc }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="opencode-version"]')!;
    fireEvent.click(within(c).getByRole('button', { name: 'このまま続行' }));
    fireEvent.click(within(c).getByRole('button', { name: '閉じる' }));
    fireEvent.click(within(c).getByRole('button', { name: '設定を開く' }));
    expect(onAction.mock.calls).toEqual([
      [{ type: 'opencode.version.continue', version: '2.2.0' }],
      [{ type: 'opencode.version.continue', version: '2.2.0' }],
      [{ type: 'opencode.version.settings', version: '2.2.0' }],
    ]);
  });
  it('確認や入力のあるダイアログの間は、画面を移す「設定を開く」だけを押せなくする', () => {
    mount(props({ opencodeVersion: oc, blocked: true }));
    const c = document.querySelector<HTMLElement>('.notice[data-kind="opencode-version"]')!;
    expect(within(c).getByRole('button', { name: '設定を開く' })).toBeDisabled();
    expect(within(c).getByRole('button', { name: 'このまま続行' })).not.toBeDisabled();
  });
  it('更新の札の下、入力待ちのカードより上に積む', () => {
    mount(props({ opencodeVersion: oc, waiting: [card('s1')], update: { kind: 'available', tone: 'info', head: '更新あり', title: 'Hangar 1.5.0', detail: null, progress: null, beforeLabel: '更新の前に', before: null, points: [], actions: [] } }));
    const kinds = [...document.querySelectorAll<HTMLElement>('.toasts .notice')].map((n) => n.dataset.kind);
    expect(kinds).toEqual(['update', 'opencode-version', 'waiting']);
  });
});

describe('閉じた後に走り続ける起動前の準備の札', () => {
  it('今の段の 1 行と経過時間を出し、「準備を中止」で鍵を添えて止める', () => {
    vi.useFakeTimers({ now: 100_000 });
    try {
      const { onAction } = mount(props({ prepProgress: { key: 'key-12345678', line: 'qwen をロード中…（64K）', startedAt: 91_000 } }));
      const c = document.querySelector<HTMLElement>('[data-kind="prep-progress"]')!;
      expect(within(c).getByText('qwen をロード中…（64K）')).toBeInTheDocument();
      expect(within(c).getByText('0:09')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(within(c).getByText('0:11')).toBeInTheDocument();
      fireEvent.click(within(c).getByRole('button', { name: '準備を中止' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'launchPrep.cancel', key: 'key-12345678' });
    } finally { vi.useRealTimers(); }
  });
});

describe('起動後にコンテキストが足りなかった札', () => {
  const short = (over: Partial<NonNullable<ToastsProps['contextShorts']>[number]> = {}) => ({ sessionId: 's1', fix: null, done: false, ...over });
  it('見出しと本文と、「再ロードして再開」「閉じる」を出す。「再ロードして再開」は鍵を作って頼む', () => {
    const { onAction } = mount(props({ contextShorts: [short()] }));
    const c = document.querySelector<HTMLElement>('[data-kind="context-short"]')!;
    expect(within(c).getByText('コンテキスト長が足りません')).toBeInTheDocument();
    expect(within(c).getByText(/opencode の指示を処理できませんでした/)).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: '再ロードして再開' }));
    const sent = onAction.mock.calls[0]![0] as { type: string; sessionId: string; prepKey: string };
    expect(sent).toMatchObject({ type: 'launchPrep.short.fix', sessionId: 's1' });
    expect(sent.prepKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    fireEvent.click(within(c).getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'launchPrep.short.dismiss', sessionId: 's1' });
  });
  it('整え直しの最中は、進みを札の中に 1 行で出し、ボタンは外す', () => {
    mount(props({ contextShorts: [short({ fix: { text: 'qwen を再ロード中…（64K）', startedAt: Date.now() - 4_000 } })] }));
    const c = document.querySelector<HTMLElement>('[data-kind="context-short"]')!;
    expect(within(c).getByText('qwen を再ロード中…（64K）')).toBeInTheDocument();
    expect(within(c).getByText(/^0:0\d$/)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: '再ロードして再開' })).toBeNull();
  });
  it('済んだら「再ロードしました」の知らせに替え、閉じるボタンを残し、時間で下げる', () => {
    vi.useFakeTimers();
    try {
      const { onAction } = mount(props({ contextShorts: [short({ done: true })] }));
      const c = document.querySelector<HTMLElement>('[data-kind="context-short"]')!;
      expect(within(c).getByText(/モデルを再ロードしました/)).toBeInTheDocument();
      expect(within(c).queryByRole('button', { name: '再ロードして再開' })).toBeNull();
      act(() => { vi.advanceTimersByTime(PHONE_LAUNCH_TOAST_MS); });
      expect(onAction).toHaveBeenCalledWith({ type: 'launchPrep.short.dismiss', sessionId: 's1' });
    } finally { vi.useRealTimers(); }
  });
  it('同じ会話の札は 1 枚、別の会話は別の札', () => {
    mount(props({ contextShorts: [short(), short({ sessionId: 's2' })] }));
    expect(document.querySelectorAll('[data-kind="context-short"]')).toHaveLength(2);
  });
});

describe('起動後にモデルが見つからなかった札', () => {
  const card = (over: Partial<NonNullable<ToastsProps['modelMissings']>[number]> = {}) => ({ sessionId: 's1', model: 'lmstudio/qwen3.6-35b-a3b', name: 'LM Studio', projectId: 'p1', ...over });
  it('見出しと本文と、「別のモデルでやり直す」「閉じる」を出す', () => {
    const { onAction } = mount(props({ modelMissings: [card()] }));
    const c = document.querySelector<HTMLElement>('[data-kind="model-missing"]')!;
    expect(within(c).getByText('モデルが見つかりません')).toBeInTheDocument();
    expect(within(c).getByText('LM Studio に lmstudio/qwen3.6-35b-a3b がないため、会話を開始できませんでした。')).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: '別のモデルでやり直す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'launchPrep.missing.retry', sessionId: 's1', projectId: 'p1' });
    fireEvent.click(within(c).getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'launchPrep.missing.dismiss', sessionId: 's1' });
  });
  it('会話ごとに 1 枚ずつ出す', () => {
    mount(props({ modelMissings: [card(), card({ sessionId: 's2' })] }));
    expect(document.querySelectorAll('[data-kind="model-missing"]')).toHaveLength(2);
  });
});
