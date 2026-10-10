import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ActionRoot } from '../action/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { Header } from './Header.tsx';
import { TodoList } from './TodoList.tsx';
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

describe('TodoList', () => {
  it('追加、反転、削除の UiAction を出す', () => {
    const onAction = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false, candidate: null }, { id: 't2', text: '済んだ', done: true, candidate: null }]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: '書く' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.add', projectId: 'p1', text: '書く' });
    fireEvent.click(screen.getByLabelText('買う（1 件目）'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByLabelText('済んだ（2 件目）を削除'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.remove', id: 't2' });
    expect(input.getAttribute('id')).toBe('todo-input');
  });
  it('候補の行は根拠とセッションと確定と却下を出し、欄を押すと反転の UiAction を出す', () => {
    const cand = { note: '直して確かめた', sessionId: 's1', sessionName: '起動画面の作り直し', ago: '12 分前' };
    const onAction = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '窓を掴める', done: false, candidate: cand }, { id: 't2', text: '影の値', done: false, candidate: { ...cand, sessionId: null, sessionName: '不明なセッション' } }]} />);
    expect(screen.getByText('直して確かめた', { selector: '#todo-why-t1' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目、完了の候補）'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByRole('button', { name: '起動画面の作り直し' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目）を確定'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目）を却下'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.reject', id: 't1' });
    // 開けないセッションは押せる形にしない。
    expect(screen.queryByRole('button', { name: '不明なセッション' })).toBeNull();
    expect(screen.getByText('不明なセッション')).toBeTruthy();
    // 候補でない行には確定も根拠も出さない。
    const plain = wrap(<TodoList projectId="p1" todos={[{ id: 't3', text: '普通', done: false, candidate: null }]} />);
    expect(plain).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('普通（1 件目）を確定')).toBeNull();
  });
  it('済みの印は checkbox の役割で、状態を aria-checked に出す', () => {
    wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false, candidate: null }, { id: 't2', text: '済んだ', done: true, candidate: null }]} />);
    expect(screen.getByRole('checkbox', { name: '買う（1 件目）' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: '済んだ（2 件目）' })).toHaveAttribute('aria-checked', 'true');
  });
  it('空の入力では何も出さない', () => {
    const onAction = wrap(<TodoList projectId="p1" todos={[]} />);
    fireEvent.keyDown(screen.getByLabelText('TODO を追加'), { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    // 足す欄があるときは、空であることを欄の薄い字が言う。別の行では言わない。
    expect(screen.getByPlaceholderText('TODO はまだありません')).toBeTruthy();
    expect(screen.queryByText('TODO はまだありません')).toBeNull();
  });
  it('足す欄の無い場所では、空であることを行で書く', () => {
    wrap(<TodoList projectId="p1" todos={[]} canAdd={false} />);
    expect(screen.getByText('TODO はまだありません')).toBeTruthy();
  });
  it('同じ文言の TODO が並んでもラベルが重ならない', () => {
    const onAction = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false, candidate: null }, { id: 't2', text: '買う', done: true, candidate: null }]} />);
    fireEvent.click(screen.getByLabelText('買う（2 件目）'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't2' });
    fireEvent.click(screen.getByLabelText('買う（1 件目）を削除'));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.remove', id: 't1' });
  });
  it('日本語の変換中の Enter では追加しない', () => {
    const onAction = wrap(<TodoList projectId="p1" todos={[]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: 'かう' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAction).not.toHaveBeenCalled();
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
  it('canAdd が偽なら追加欄を出さない', () => {
    wrap(<ArtifactCards projectId={null} artifacts={[]} canAdd={false} />);
    expect(screen.queryByLabelText('アーティファクトの URL')).toBeNull();
    expect(screen.getByText('アーティファクトはまだありません')).toBeTruthy();
  });
});
