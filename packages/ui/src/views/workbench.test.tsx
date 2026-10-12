import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ActionRoot } from '../action/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { Header } from './Header.tsx';
import { fakeMotionTokens } from '../test/motion.ts';
import { syncFixture } from '../test/syncProps.ts';
import { RollingNumber } from './primitives/RollingNumber.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';

const art = (id: string, over: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: '題名 ' + id, description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/' + id, lastPublished: '1 分前', versionCount: 2, canOpenEditor: false, ...over });
const wrap = (node: ReactNode, onAction = vi.fn()) => { render(<ActionRoot onAction={onAction}>{node}</ActionRoot>); return onAction; };

describe('UsageGauge', () => {
  it('値があれば百分率、無ければ未取得', () => {
    render(<UsageGauge label="5h" percent={84} />);
    expect(screen.getByLabelText('5h').getAttribute('aria-valuenow')).toBe('84');
    expect(screen.getByText('84%')).toBeTruthy();
    render(<UsageGauge label="7d" percent={null} />);
    expect(screen.getAllByText('未取得').length).toBeGreaterThan(0);
  });
  it('80% 以上は警告色の印を付ける', () => {
    const { container } = render(<UsageGauge label="5h" percent={91} />);
    expect(container.querySelector('.gauge-fill')?.getAttribute('data-high')).toBe('true');
    expect((container.querySelector('.gauge-fill') as HTMLElement).style.width).toBe('91%');
  });
});

describe('RollingNumber', () => {
  it('値が変わると古い値を添えて回し、--dur の長さで片付ける', () => {
    vi.useFakeTimers();
    const restore = fakeMotionTokens();
    try {
      const { container, rerender } = render(<RollingNumber value={10} suffix="%" />);
      expect(container.querySelector('.roll-old')).toBeNull();
      rerender(<RollingNumber value={20} suffix="%" />);
      expect(container.querySelector('.roll')?.getAttribute('data-rolling')).toBe('true');
      expect(container.querySelector('.roll-old')?.textContent).toBe('10%');
      expect(container.querySelector('.roll-new')?.textContent).toBe('20%');
      act(() => { vi.advanceTimersByTime(420); });
      expect(container.querySelector('.roll-old')).toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });
  it('動かない環境（長さ 0）では回さず、すぐ新しい値だけにする', () => {
    const { container, rerender } = render(<RollingNumber value={10} suffix="%" />);
    rerender(<RollingNumber value={20} suffix="%" />);
    expect(container.querySelector('.roll-old')).toBeNull();
    expect(container.querySelector('.roll-new')?.textContent).toBe('20%');
  });
});

// 同期を設定していない端末のヘッダー。フェーズ 3 のゲージの検査はこの形のままである。
const noSync = syncFixture({ visible: false, state: 'off', label: '' });

describe('Header', () => {
  it('2 つのゲージと最終更新を出す', () => {
    render(<ActionRoot onAction={() => {}}><Header account={null} notices={{ rows: [], unread: 0, keys: [], label: '通知' }} newSession={{}} indexLabel={null} usage={{ fiveHour: 47, sevenDay: 7, fiveHourResets: '18:00', sevenDayResets: '10/4 09:00', updatedLabel: '10 分前' }} sync={noSync} /></ActionRoot>);
    expect(screen.getByRole('meter', { name: '5 時間の使用率' })).toBeTruthy();
    expect(screen.getByRole('meter', { name: '週の使用率' })).toBeTruthy();
    // 何の割合かが画面から読めるよう、見出しを常に出す。
    expect(screen.getByText('5 時間')).toBeTruthy();
    expect(screen.getByText('週')).toBeTruthy();
    // ホバーで、枠が戻る時刻と最終更新を読める。最終更新は狭いヘッダで畳むので、title にも添える。
    expect(screen.getByText('5 時間').closest('.gauge')).toHaveAttribute('title', '5 時間の使用率 47%、18:00 にリセットされます、最終更新 10 分前');
    expect(screen.getByText('週').closest('.gauge')).toHaveAttribute('title', '週の使用率 7%、10/4 09:00 にリセットされます、最終更新 10 分前');
    expect(screen.getByText('最終更新 10 分前')).toBeTruthy();
  });
  // 幅が狭いと、同期のボタンと錠剤の文字と新規セッションの文字を畳む（headerFold.ts が測って畳む）。畳んでも同じ操作ができる。
  it('畳んだときの逃げ道。同期の文は設定へ、虫眼鏡はパレットへ、新規セッションは名前を残す', () => {
    const onAction = vi.fn();
    const sync = syncFixture({ label: '同期済み · 3 分前', pending: '未送信の変更 2' });
    render(<ActionRoot onAction={onAction}><Header account={null} notices={{ rows: [], unread: 0, keys: [], label: '通知' }} newSession={{}} indexLabel={null} usage={{ fiveHour: 42, sevenDay: 18, fiveHourResets: null, sevenDayResets: null, updatedLabel: '3 分前' }} sync={sync} /></ActionRoot>);
    fireEvent.click(screen.getByRole('link', { name: '同期済み · 3 分前' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
    fireEvent.click(screen.getByRole('button', { name: '移動・操作' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.open' });
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  // 注意（もとのベル）は、中身があるときだけ区切りの線ごと描く（2026-10-13 の決定、9a）。
  it('注意は、中身が無ければ区切りごと描かず、あれば使用率の後ろに置く', () => {
    const usage = { fiveHour: 10, sevenDay: 5, fiveHourResets: null, sevenDayResets: null, updatedLabel: null };
    const { unmount } = render(<ActionRoot onAction={vi.fn()}><Header account={null} notices={{ rows: [], unread: 0, keys: [], label: '注意' }} newSession={{}} indexLabel={null} usage={usage} sync={noSync} /></ActionRoot>);
    expect(document.querySelector('.header-bell')).toBeNull();
    unmount();
    const row = { key: 'sync|error|x', kind: 'sync' as const, tone: 'err' as const, icon: 'sync' as const, kindLabel: '同期', title: '同期エラー', detail: null, when: null, unread: true, action: { label: '同期の設定を開く', send: { type: 'nav.go' as const, to: { name: 'settings' as const, at: 'sync' as const } } } };
    render(<ActionRoot onAction={vi.fn()}><Header account={null} notices={{ rows: [row], unread: 1, keys: [row.key], label: '注意、未読 1 件' }} newSession={{}} indexLabel={null} usage={usage} sync={noSync} /></ActionRoot>);
    expect(document.querySelector('.header-bell .bell')).not.toBeNull();
    expect(screen.getByRole('button', { name: '注意、未読 1 件' })).toBeTruthy();
  });
  // 「停止 N」の錠剤は外した（2026-10-13 の決定、9b）。止まっている会話はホームの帯の実行中の行で見る。
  it('使用制限で止まっている枠は、砂時計の色にして % の代わりにリセットの時刻を出す。「停止 N」の錠剤は置かない', () => {
    render(<ActionRoot onAction={vi.fn()}><Header account={null} notices={{ rows: [], unread: 0, keys: [], label: '注意' }} newSession={{}} indexLabel={null} usage={{ fiveHour: 100, sevenDay: 41, fiveHourResets: '16:50', sevenDayResets: null, updatedLabel: null, fiveHourLimit: '16:50' }} sync={noSync} /></ActionRoot>);
    const five = screen.getByText('5 時間').closest('.gauge')!;
    expect(five).toHaveAttribute('data-limit', 'true');
    expect(five.querySelector('.reason-glyph')).not.toBeNull();
    expect(five.querySelector('.gauge-num')).toHaveTextContent('16:50');
    expect(five).toHaveAttribute('title', '5 時間の使用率：使用制限 · 16:50 にリセット');
    expect(screen.getByText('週').closest('.gauge')).not.toHaveAttribute('data-limit');
    expect(document.querySelector('.stopped-chip')).toBeNull();
  });
  it('最終更新が無ければ添えない', () => {
    render(<ActionRoot onAction={() => {}}><Header account={null} notices={{ rows: [], unread: 0, keys: [], label: '通知' }} newSession={{}} indexLabel={null} usage={{ fiveHour: null, sevenDay: 18, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }} sync={noSync} /></ActionRoot>);
    expect(screen.queryByText(/最終更新/)).toBeNull();
    expect(screen.getAllByText('未取得')).toHaveLength(1);
    // 戻る時刻が届いていなければ、title に時刻を添えない。
    expect(screen.getByText('5 時間').closest('.gauge')).toHaveAttribute('title', '5 時間の使用率 未取得');
  });
  it('使用率が一度も届いていない間は、空の棒を並べず 1 語にまとめ、押すと設定へ行く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><Header account={null} notices={{ rows: [], unread: 0, keys: [], label: '通知' }} newSession={{}} indexLabel={null} usage={{ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }} sync={noSync} /></ActionRoot>);
    expect(screen.queryByRole('meter')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '使用率 未取得' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
  });
});

describe('ArtifactCards', () => {
  it('クリックで開き、編集ボタンは元ファイルがあるときだけ出す', () => {
    const onAction = wrap(<ArtifactCards projectId="p1" artifacts={[art('a1'), art('a2', { canOpenEditor: true })]} canAdd />);
    fireEvent.click(screen.getByText('題名 a1'));
    expect(onAction).toHaveBeenCalledWith({ type: 'artifact.open', id: 'a1' });
    expect(screen.getAllByText('VS Code で開く')).toHaveLength(1);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onAction).toHaveBeenCalledWith({ type: 'artifact.openEditor', id: 'a2' });
    const url = screen.getByLabelText('アーティファクトの URL');
    fireEvent.change(url, { target: { value: 'https://claude.ai/code/artifact/x' } });
    fireEvent.click(screen.getByText('追加'));
    expect(onAction).toHaveBeenCalledWith({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' });
  });
  it('追加が断られたら、理由を欄の下に出し、消えた URL を欄へ戻す。成功したときは空のまま', () => {
    const onAction = vi.fn();
    const ui = (addError: { url: string; message: string } | null) => (
      <ActionRoot onAction={onAction}><ArtifactCards projectId="p1" artifacts={[]} canAdd addError={addError} /></ActionRoot>
    );
    const { rerender } = render(ui(null));
    const url = 'https://claude.ai/code/artifact/x';
    const input = screen.getByLabelText('アーティファクトの URL') as HTMLInputElement;
    fireEvent.change(input, { target: { value: url } });
    fireEvent.click(screen.getByText('追加'));
    // 送った直後は空にする。成功ならそのまま空である。
    expect(input.value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    // 断られた。理由が出て、URL が戻る。
    rerender(ui({ url, message: 'すでにプロジェクト「alpha」に付いています' }));
    expect(screen.getByRole('alert')).toHaveTextContent('すでにプロジェクト「alpha」に付いています');
    expect((screen.getByLabelText('アーティファクトの URL') as HTMLInputElement).value).toBe(url);
  });
  it('断られたあとに、利用者がもう別の URL を打っていたら、それを上書きしない', () => {
    const onAction = vi.fn();
    const ui = (addError: { url: string; message: string } | null) => (
      <ActionRoot onAction={onAction}><ArtifactCards projectId="p1" artifacts={[]} canAdd addError={addError} /></ActionRoot>
    );
    const { rerender } = render(ui(null));
    const input = screen.getByLabelText('アーティファクトの URL') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://claude.ai/code/artifact/x' } });
    fireEvent.click(screen.getByText('追加'));
    fireEvent.change(input, { target: { value: 'https://claude.ai/code/artifact/y' } });
    rerender(ui({ url: 'https://claude.ai/code/artifact/x', message: 'だめ' }));
    expect((screen.getByLabelText('アーティファクトの URL') as HTMLInputElement).value).toBe('https://claude.ai/code/artifact/y');
  });
  it('canAdd が偽なら追加欄を出さない', () => {
    wrap(<ArtifactCards projectId={null} artifacts={[]} canAdd={false} />);
    expect(screen.queryByLabelText('アーティファクトの URL')).toBeNull();
    expect(screen.getByText('アーティファクトはまだありません')).toBeTruthy();
  });
});
