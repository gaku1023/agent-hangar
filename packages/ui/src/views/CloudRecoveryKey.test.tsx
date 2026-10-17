import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRecoveryKey, recoverySecretTail, type SyncStatusBody, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentCloudMember, type CloudMemberProps } from '../presenters/cloudMember.ts';
import { presentSettings } from '../presenters/settings.ts';
import { initialCloudMember, RECOVERY_SHOW_MS, type RecoveryStage } from '../store/cloudMember.ts';
import { initialStore, type Store } from '../store/store.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { CloudRecoveryButton, CloudRecoveryKey } from './CloudRecoveryKey.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';

const NOW = Date.parse('2026-10-17T03:00:00Z');
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
/** 作り物の秘密鍵（32 バイト）で作ったリカバリーキー。 */
const TEXT = formatRecoveryKey({ priv: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), url: 'https://h.example', createdAt: NOW });
const SECRET = TEXT.split('\n').find((l) => l.startsWith('暗号鍵'))!.replace(/^暗号鍵:\s*/, '');
const TAIL = recoverySecretTail(TEXT);
const shown = (over: Partial<Extract<RecoveryStage, { kind: 'shown' }>> = {}): RecoveryStage => ({ kind: 'shown', text: TEXT, draftId: 'd1', hideAt: NOW + RECOVERY_SHOW_MS, entering: false, busy: false, sentTail: null, error: null, ...over });

function props(recovery: RecoveryStage = { kind: 'idle' }, over: Partial<Store> = {}): CloudMemberProps {
  return presentCloudMember({ ...initialStore(), sync: SYNC, desktop: true, device: { id: 'studio', name: 'studio' }, cloudMember: { ...initialCloudMember(), recovery }, ...over }, NOW);
}

const ui = (node: React.ReactNode, onAction: (a: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}>{node}</ActionRoot>;
/** 設定の節と同じく、ボタンの段と欄を並べる。 */
const Page = (p: { m: CloudMemberProps }) => <><div className="btns"><CloudRecoveryButton m={p.m} /></div><CloudRecoveryKey m={p.m} /></>;

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('リカバリーキーの再発行（試作 D2）', () => {
  it('再発行の確認の後、見出し、作成日、URL、暗号鍵が出て、コピーとファイルへの保存がある', async () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    const { rerender } = render(ui(<Page m={props()} />, onAction));
    fireEvent.click(screen.getByRole('button', { name: 'リカバリーキーを再発行' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.ask' });
    rerender(ui(<Page m={props({ kind: 'asking' })} />, onAction));
    const panel = screen.getByRole('region', { name: 'リカバリーキー' });
    expect(panel).toHaveTextContent('今のリカバリーキーは使えなくなります');
    expect(screen.getByRole('button', { name: 'リカバリーキーを再発行' })).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: '再発行' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.reissue' });
    rerender(ui(<Page m={props(shown())} />, onAction));
    expect(panel).toHaveTextContent('hangar リカバリーキー');
    expect(panel).toHaveTextContent('作成日');
    expect(panel).toHaveTextContent('2026-10-17');
    expect(panel).toHaveTextContent('https://h.example');
    expect(within(panel).getByText(SECRET)).toBeInTheDocument();
    expect(SECRET).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(within(panel).getByRole('button', { name: 'リカバリーキーをコピー' })).toBeInTheDocument();
    // 殻の外（ブラウザ）では、ファイルに保存は 4 行の文字列をそのままダウンロードさせる。
    let blob: Blob | null = null;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn((b: Blob) => { blob = b; return 'blob:x'; }) });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ download: this.download, href: this.href }); });
    fireEvent.click(within(panel).getByRole('button', { name: 'ファイルに保存' }));
    expect(clicked).toEqual([{ download: 'hangar-recovery-key.txt', href: 'blob:x' }]);
    expect(await blob!.text()).toBe(`${TEXT}\n`);
  });

  it('120 秒の進捗バーが尽きると暗号鍵を伏せる。もう一度表示できる', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    render(ui(<Page m={props(shown())} />, onAction));
    const panel = screen.getByRole('region', { name: 'リカバリーキー' });
    const bar = within(panel).getByRole('progressbar', { name: '暗号鍵を表示する残り時間' });
    expect(bar).toHaveAttribute('aria-valuemax', '120');
    expect(panel).toHaveTextContent('あと 2:00 で暗号鍵を非表示にします');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(within(panel).getByText(SECRET)).toBeInTheDocument();
    expect(panel).toHaveTextContent('あと 1:00');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(panel).not.toHaveTextContent(SECRET);
    expect(within(panel).queryByRole('progressbar')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'リカバリーキーをコピー' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'ファイルに保存' })).toBeNull();
    expect(panel).toHaveTextContent('時間が経過したため暗号鍵を非表示にしました');
    fireEvent.click(within(panel).getByRole('button', { name: 'もう一度表示' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.reveal' });
  });

  it('入力のステップに進むと暗号鍵を伏せ字にする', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    const { rerender } = render(ui(<Page m={props(shown())} />, onAction));
    const panel = screen.getByRole('region', { name: 'リカバリーキー' });
    expect(within(panel).queryByLabelText('保存した暗号鍵の末尾 4 文字')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: '保存しました' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.saved' });
    rerender(ui(<Page m={props(shown({ entering: true }))} />, onAction));
    expect(panel).not.toHaveTextContent(SECRET);
    expect(panel).not.toHaveTextContent(TAIL);
    expect(within(panel).getByLabelText('暗号鍵（非表示）')).toHaveTextContent(/^[●-]+$/);
    expect(within(panel).getByLabelText('保存した暗号鍵の末尾 4 文字')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: '保存しました' })).toBeNull();
  });

  // 保存先を開いて読み返させるため、入力の段ではコピーで末尾を確かめられないようにする。
  it('入力の段では、進捗バー、コピー、ファイルに保存、残り時間の文を出さず、小さな「もう一度表示」だけを残す', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    render(ui(<Page m={props(shown({ entering: true }))} />, onAction));
    const panel = screen.getByRole('region', { name: 'リカバリーキー' });
    expect(within(panel).queryByRole('progressbar')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'リカバリーキーをコピー' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'ファイルに保存' })).toBeNull();
    expect(panel).not.toHaveTextContent('で暗号鍵を非表示にします');
    expect(within(panel).getByLabelText('暗号鍵（非表示）')).toHaveTextContent(/^[●-]+$/);
    const again = within(panel).getByRole('button', { name: 'もう一度表示' });
    expect(again).toHaveClass('linkish');
    fireEvent.click(again);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.reveal' });
  });

  it('入力の段で時間が尽きても、時間切れの帯を出さず、入力の欄だけを残す', () => {
    vi.useFakeTimers({ now: NOW });
    render(ui(<Page m={props(shown({ entering: true, hideAt: NOW + 1000 }))} />));
    const panel = screen.getByRole('region', { name: 'リカバリーキー' });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(panel).not.toHaveTextContent('時間が経過したため暗号鍵を非表示にしました');
    expect(within(panel).getAllByRole('button', { name: 'もう一度表示' })).toHaveLength(1);
    expect(within(panel).getByLabelText('保存した暗号鍵の末尾 4 文字')).toBeInTheDocument();
  });

  it('殻の中では、ファイルに保存を殻の保存のダイアログに頼み、ブラウザのダウンロードを使わない', async () => {
    vi.useFakeTimers({ now: NOW });
    const invoke = vi.fn(async () => true);
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(ui(<Page m={props(shown())} />));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ファイルに保存' })); await Promise.resolve(); });
      expect(invoke).toHaveBeenCalledWith('save_recovery_key', { text: TEXT });
      expect(click).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
      // 取り消し（false）は失敗にしない。
      invoke.mockResolvedValueOnce(false);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ファイルに保存' })); await Promise.resolve(); });
      expect(screen.queryByRole('alert')).toBeNull();
      // 書けなかったときは、欄の中に理由を出す。
      invoke.mockRejectedValueOnce('denied');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ファイルに保存' })); await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getByRole('alert')).toHaveTextContent('ファイルに保存できませんでした');
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('コピーの後にクリップボードを読みに行かない（WKWebView では操作の外の読み取りが「ペースト」の吹き出しを出す）', async () => {
    vi.useFakeTimers({ now: NOW });
    const writeText = vi.fn(async () => {});
    const readText = vi.fn(async () => TEXT);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText, writeText } });
    try {
      const onAction = vi.fn();
      render(ui(<Page m={props(shown({ hideAt: NOW + 10 * 60_000 }))} />, onAction));
      fireEvent.click(screen.getByRole('button', { name: 'リカバリーキーをコピー' }));
      expect(onAction).toHaveBeenLastCalledWith({ type: 'clipboard.copy', text: TEXT });
      await act(async () => { vi.advanceTimersByTime(5 * 60_000); await Promise.resolve(); });
      expect(readText).not.toHaveBeenCalled();
    } finally {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it('末尾 4 文字が合うまで「完了」が押せない。小文字、全角、区切りの混じった入力も通す', () => {
    const onAction = vi.fn();
    render(ui(<Page m={props(shown({ entering: true }))} />, onAction));
    const field = screen.getByLabelText('保存した暗号鍵の末尾 4 文字');
    const done = screen.getByRole('button', { name: '完了' });
    expect(done).toBeDisabled();
    fireEvent.change(field, { target: { value: TAIL.slice(0, 3) } });
    expect(done).toBeDisabled();
    fireEvent.change(field, { target: { value: TAIL === 'AAAA' ? 'BBBB' : 'AAAA' } });
    expect(done).toBeDisabled();
    fireEvent.click(done);
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cloud.recovery.confirm' }));
    // 全角の小文字に、区切りと空白を混ぜる。
    const wide = [...TAIL.toLowerCase()].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    fireEvent.change(field, { target: { value: ` ${wide.slice(0, 2)}-${wide.slice(2)} ` } });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.confirm', tail: TAIL });
  });

  it('確認の失敗はサーバーの文を出す。Worker の失敗はもう一度試せる。下書きが無いときは再発行し直す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<Page m={props(shown({ entering: true, sentTail: TAIL, error: { message: 'Worker に接続できません', retry: true } }))} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('Worker に接続できません');
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.retry' });
    rerender(ui(<Page m={props(shown({ entering: true, error: { message: '暗号鍵の末尾 4 文字が一致しません', retry: false } }))} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('暗号鍵の末尾 4 文字が一致しません');
    expect(screen.queryByRole('button', { name: 'もう一度試す' })).toBeNull();
    rerender(ui(<Page m={props({ kind: 'failed', message: '確認できる新しいリカバリーキーがありません。もう一度再発行してください' })} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('もう一度再発行してください');
    fireEvent.click(screen.getByRole('button', { name: 'もう一度再発行' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.reissue' });
  });

  it('確認している間は「完了」を押せず、済んだら切り替えた旨を出す。閉じると暗号鍵を捨てる', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<Page m={props(shown({ entering: true, busy: true, sentTail: TAIL }))} />, onAction));
    expect(screen.getByRole('status')).toHaveTextContent('新しいリカバリーキーに切り替えています');
    expect(screen.getByRole('button', { name: '完了' })).toBeDisabled();
    rerender(ui(<Page m={props({ kind: 'done' })} />, onAction));
    const panel = screen.getByRole('region', { name: 'リカバリーキー' });
    expect(panel).toHaveTextContent('新しいリカバリーキーに切り替えました');
    fireEvent.click(within(panel).getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.close' });
  });

  it('節が外れたら（設定の画面を離れたなど）暗号鍵を捨てる', () => {
    const onAction = vi.fn();
    const { unmount } = render(ui(<Page m={props(shown())} />, onAction));
    unmount();
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.close' });
  });
});

describe('リカバリーキーの動き', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[] }[] = [];
  let finish: (() => void)[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    animations = []; finish = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      animations.push({ el: this, frames });
      return { finished: new Promise<void>((r) => finish.push(r)), cancel: vi.fn() };
    };
    // jsdom は高さを測らないので、中身の文字数を高さとみなす。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return (this.textContent ?? '').length; } });
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
  });
  const on = (el: Element | null) => animations.filter((a) => a.el === el);
  const done = async () => { await act(async () => { finish.forEach((f) => f()); await Promise.resolve(); }); };

  it('欄は growIn で開き、段の切り替えは resizeFrom＋fadeIn、入力の欄は growIn、閉じると collapseOut', async () => {
    const { rerender, container } = render(ui(<Page m={props()} />));
    expect(animations).toHaveLength(0);
    rerender(ui(<Page m={props({ kind: 'asking' })} />));
    const panel = container.querySelector('.cm-rk')!;
    expect(on(panel)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    animations = [];
    rerender(ui(<Page m={props(shown())} />));
    expect(container.querySelector('.cm-rk')).toBe(panel);
    expect(on(panel)[0]!.frames).toEqual([{ height: expect.stringMatching(/px$/) }, { height: expect.stringMatching(/px$/) }]);
    expect(on(container.querySelector('.cm-rk-body'))[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    animations = [];
    rerender(ui(<Page m={props(shown({ entering: true }))} />));
    expect(on(container.querySelector('.cm-rk-enter'))[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    expect(on(panel)).toHaveLength(0);
    animations = [];
    rerender(ui(<Page m={props()} />));
    expect(on(panel).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
    await done();
    expect(container.querySelector('.cm-rk')).toBeNull();
  });

  it('はじめから入力の段で描いたときは、入力の欄を動かさない', () => {
    const { container } = render(ui(<Page m={props(shown({ entering: true }))} />));
    expect(on(container.querySelector('.cm-rk-enter'))).toHaveLength(0);
  });
});

describe('設定のクラウド同期の節のリカバリーキー', () => {
  const SETTINGS = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
  const page = (over: Partial<Store>) => presentSettings({ ...initialState(), screen: { name: 'settings', at: 'cloud' } }, { ...initialStore(), settings: SETTINGS, device: { id: 'studio', name: 'studio' }, ...over }, NOW, 'darwin');

  it('同期していれば、今すぐ同期の段に「リカバリーキーを再発行」を置き、押すと確認を開く', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<SettingsScreen {...page({ desktop: true, sync: SYNC })} />, onAction));
    fireEvent.click(screen.getByRole('button', { name: 'リカバリーキーを再発行' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.recovery.ask' });
    rerender(ui(<SettingsScreen {...page({ desktop: true, sync: SYNC, cloudMember: { ...initialCloudMember(), recovery: { kind: 'asking' } } })} />, onAction));
    expect(screen.getByRole('region', { name: 'リカバリーキー' })).toHaveTextContent('リカバリーキーを再発行しますか');
  });

  it('同期していないときと、この PC が解除されているときは出さない', () => {
    render(ui(<SettingsScreen {...page({ desktop: true })} />));
    expect(screen.queryByRole('button', { name: 'リカバリーキーを再発行' })).toBeNull();
    cleanup();
    render(ui(<SettingsScreen {...page({ desktop: true, sync: { ...SYNC, state: 'error', revoked: true } })} />));
    expect(screen.queryByRole('button', { name: 'リカバリーキーを再発行' })).toBeNull();
  });
});
